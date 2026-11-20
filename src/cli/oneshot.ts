import { clipReason, type StreamResultExitCode, type StreamResultStatus } from "../streamJson.ts";
import { persist } from "./sessions.ts";
import { c } from "../ui/theme.ts";
import { knownSlashCommand } from "../input/commands.ts";
import { handleOutputStyleCommand } from "../outputStyle/command.ts";
import type { CommandContext } from "./commandContext.ts";
import { chatStream, contentText } from "../llm.ts";
import { runDriveCheck } from "../driveCheck.ts";
import { DriveManager } from "../drive.ts";
import { makeDriveJudge } from "../driveJudge.ts";
import { parseDriveArgs, driveExitCode, formatDriveSummary, type DriveRunResult } from "../oneshotDrive.ts";
import type { AppSession } from "./sessionStart.ts";
import { installFatalSignalHandlers } from "../signals.ts";
import {
  MAX_SCHEMA_FEEDBACK,
  checkAgainstSchema,
  feedbackMessage,
  type CompiledSchema,
} from "../structuredOutput.ts";

/** issue #73：-p 下 `/output-style <name>` 带参数切换同样生效（只改本会话）。 */
async function runOneshotOutputStyle(s: AppSession, line: string): Promise<number> {
  const arg = line.trim().replace(/^\/output-style\b/i, "").trim();
  const ok = await handleOutputStyleCommand(arg, {
    agent: s.agent,
    ui: s.ui,
    cfg: s.cfg,
    memory: s.memory,
    classifier: s.classifier,
    meta: s.sess.meta,
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: s.mailbox ?? null,
    checkpoints: s.checkpoints ?? null,
    promptManager: s.promptManager,
  });
  s.cleanupEphemeralResources();
  return ok ? 0 : 2;
}

/**
 * -p / 非交互 `neo <prompt>` 路径。若不是这些模式，返回 null，交给交互 REPL。
 */
export async function runOneshotOrPiped(s: AppSession): Promise<number | null> {
  const {
    args,
    cfg,
    jsonMode,
    streamJsonMode,
    structuredMode,
    jsonSchema,
    sess,
    streamWriter,
    memory,
    agent
  } = s;
  // ---- 单次模式 ----
  if (args.print !== null) {
    const prompt = args.print || args.rest.join(" ");
    if (!prompt.trim()) {
      console.error(c.err("✖ -p 需要提供内容"));
      // 此时 MCP server 可能已经连上（连接发生在 -p 分支之前），必须收掉。
      s.cleanupEphemeralResources();
      return 2;
    }
    // issue #41：斜杠命令是交互模式的能力。这里必须明确提示，而不是把整串当 prompt
    // 静默发给模型（PRD 写的是「命令会明确提示不可用」）。
    const slashCommand = knownSlashCommand(prompt);
    if (slashCommand === "output-style") {
      // issue #73：带参数切换在 -p 下同样生效；无参则非 TTY 列出当前项。
      return await runOneshotOutputStyle(s, prompt);
    }
    if (slashCommand) {
      console.error(
        c.err(`✖ -p 不解析斜杠命令：/${slashCommand} 只能在交互模式使用（-p 会把内容当成一次任务）`),
      );
      s.cleanupEphemeralResources();
      return 2;
    }
    // issue #51：`-p --drive` 无人值守长跑。参数在进入单次模式前就解析好，
    // 用法错误在这里直接 exit 2（一次模型请求都不发）。
    const driveArgs = parseDriveArgs(process.argv.slice(2));
    if (driveArgs !== null && !driveArgs.ok) {
      console.error(c.err(`✖ ${driveArgs.error}`));
      s.cleanupEphemeralResources();
      return 2;
    }
    const oneShotDrive = driveArgs?.ok ? driveArgs.spec : null;
    if (oneShotDrive) {
      // PRD §5：-y 全自动在 CI 上可能执行危险命令，这是用户显式选择 —— 但必须让日志看得见。
      console.error(c.warn("无人值守：-y 会自动批准所有操作"));
    }

    // #37 init：oneShotDrive 确定后、首次 agent.send() 前恰好一次。
    // 采用「惰性发出」：由 streamBeginTurn 在首次 send 前触发。这样 dm.start() 等
    // 用法错误提前 return 2 时不会留下「有 init 无 result」的悬空 JSONL
    // （§3.7 usage error 允许没有先前 init；#17c 会为这些路径补 error+result）。
    let initEmitted = false;
    const emitInitOnce = (): void => {
      if (initEmitted || !streamJsonMode || !streamWriter || s.stdoutClosed) return;
      initEmitted = true;
      streamWriter.emitInit({
        provider: cfg.providerName,
        model: cfg.model,
        model_tier: cfg.modelTier,
        output_format: "stream-json",
        drive: oneShotDrive !== null,
      });
    };

    // #37 turn_started：每次 agent.send() 前调用一次，drive 循环内每轮自动续跑各算新 turn。
    // turnNo 是 onEvent 映射与 turn_started 共用的共享计数器；递增放在守卫之外，
    // 保证语义上始终是「第几次 send」，emit 只在 stream-json 且 stdout 未关闭时进行。
    const streamBeginTurn = (): void => {
      emitInitOnce();
      s.turnNo += 1;
      if (streamJsonMode && streamWriter && !s.stdoutClosed) {
        streamWriter.emitTurnStarted({
          turn: s.turnNo,
          provider: cfg.providerName,
          model: cfg.model,
        });
      }
    };

    // 结构化模式（json / stream-json）把 SIGINT 转成 aborted 统计：Ctrl+C 后
    // 仍能输出一行 JSON / 收口 result（exit 130），而不是被信号直接杀掉、
    // 编排器拿到空 stdout。
    // issue #75：shell 已 setsid 脱组，普通 -p 也必须处理 SIGINT / SIGHUP / SIGTERM，
    // 先 cleanupEphemeral 再按 130/129/143 退出，否则前台 shell 与孙进程会继续写盘。
    // 结构化模式的 SIGINT 仍只 cancel，走原有 aborted 收口（先输出 JSON 再 130）。
    const uninstallSignals = installFatalSignalHandlers({
      cleanup: () => s.cleanupEphemeralResources(),
      onSignal: (sig) => {
        if (structuredMode && sig === "SIGINT") {
          agent.cancel();
          return "continue";
        }
        return "exit";
      },
    });
    let stats: Awaited<ReturnType<typeof agent.send>>;
    // issue #51：驱动终态（普通 -p 为 null）。
    let driveResult: DriveRunResult | null = null;
    // #77：进程级最终答案的校验结果。回喂必须在卸载信号、清理子进程之前做完。
    let structuredOutput: unknown;
    let structuredDiagnostic: string | null = null;
    // #64：--drive 的一次输入跨多轮内部 send —— 宿主持有同一条用户输入的 boundary，
    // 最终 endUserTurn() 收口（含 UPS 临时上下文）。默认 agent.send 会为每条真实输入
    // 自动建/结束 boundary；这里显式持有，内部轮沿用同一份额度（UPS 一次、Stop 一次）。
    if (oneShotDrive) agent.beginUserTurn(prompt);
    try {
      if (!oneShotDrive) {
        streamBeginTurn();
        stats = await agent.send(prompt);
      } else {
        // 本地 while 循环消费 DriveManager 的 action（不排交互队列）。
        const dm = new DriveManager({
          runCheck: async (cmd) => {
            try {
              return await runDriveCheck(cmd, cfg);
            } catch (e) {
              return { ok: false, code: null, output: `检查命令执行失败：${(e as Error).message}` };
            }
          },
          // -p 没有交互队列：这里恒返回 true，由下面的 while 直接再 send。
          enqueue: () => true,
          evaluate: makeDriveJudge({
            cfg,
            stream: (c2, messages, tools, opts) =>
              (agent.injectedStreamFn ?? chatStream)(
                c2,
                messages as Parameters<typeof chatStream>[1],
                tools as Parameters<typeof chatStream>[2],
                opts,
              ),
            recordUsage: (usage) => agent.recordUsage(usage),
          }),
        });
        const started = dm.start({
          check: oneShotDrive.check,
          ...(oneShotDrive.judge ? { judge: oneShotDrive.judge } : {}),
          prompt,
          maxRounds: oneShotDrive.maxRounds,
        });
        if (!started.ok) {
          console.error(c.err(`✖ ${started.error}`));
          s.cleanupEphemeralResources();
          return 2;
        }
        const maxMs = oneShotDrive.maxMinutes * 60_000;
        const t0 = Date.now();
        let round = 0;
        let final: DriveRunResult;
        for (;;) {
          streamBeginTurn();
          stats = await agent.send(prompt);
          round += 1;
          // #64：hook 阻断 / 用户中断时不得继续花模型
          // （不跑检查命令、不问 judge、不再排下一轮）。终态按「未达成」收口，
          // 退出码由下面的 abort > hadError > drive 优先级决定。
          if (stats.blocked === true || stats.compactBlocked === true || stats.aborted) {
            final = {
              status: "idle-stop",
              source: null,
              rounds: dm.state?.rounds ?? 0,
              elapsedMs: Date.now() - t0,
              reason:
                stats.blocked === true
                  ? `UserPromptSubmit hook 阻断了本次输入：${stats.errorMessage ?? ""}`
                  : stats.aborted
                    ? "本轮被中断，自动续跑已停止"
                    : `本轮失败，自动续跑已停止：${stats.errorMessage ?? "未知原因"}`,
            };
            break;
          }
          const thisTurnToolCalls = stats.toolCalls;
          const recentToolOutput =
            thisTurnToolCalls > 0
              ? agent.messages
                  .filter((m) => m.role === "tool")
                  .slice(-thisTurnToolCalls)
                  .map((m) => `tool(${m.name ?? ""}): ${contentText(m.content) ?? ""}`)
                  .join("\n")
              : "";
          const clipped =
            recentToolOutput.length > 2_000
              ? `${recentToolOutput.slice(-2_000)}\n…[已截断，只保留最近 2000 字符]`
              : recentToolOutput;
          const outcome = await dm.onTurnEnd({ toolCalls: thisTurnToolCalls, recentOutput: clipped });
          const st = outcome.state;
          if (outcome.action === "done") {
            final = {
              status: "done",
              source: st?.source ?? null,
              rounds: st?.rounds ?? 0,
              elapsedMs: Date.now() - t0,
              reason: st?.reason ?? null,
            };
            break;
          }
          // 终态：done 已在上方处理；exhausted / idle-stop 都是「未达成」的停止点（PRD §2.2）。
          // -p 下没有「停下来问人」这回事，所以直接停、由退出码 1 交给 CI。
          if (outcome.action === "exhausted" || outcome.action === "idle-stop") {
            final = {
              status: outcome.action === "idle-stop" ? "idle-stop" : "exhausted",
              source: null,
              rounds: st?.rounds ?? 0,
              elapsedMs: Date.now() - t0,
              reason: st?.reason ?? null,
            };
            break;
          }
          // 墙钟只在轮间检查（PRD §2.5）：到点就停，不硬杀正在跑的一轮。
          if (dm.expired(maxMs)) {
            dm.timeout(`已达墙钟上限 ${oneShotDrive.maxMinutes} 分钟，条件仍未达成`);
            final = {
              status: "timeout",
              source: null,
              rounds: st?.rounds ?? 0,
              elapsedMs: Date.now() - t0,
              reason: `已达墙钟上限 ${oneShotDrive.maxMinutes} 分钟`,
            };
            break;
          }
          // 防御：action=skipped/none 在 -p 下不该出现（enqueue 恒 true）；出现即停，避免死循环。
          if (outcome.action !== "continue") {
            final = {
              status: "idle-stop",
              source: null,
              rounds: st?.rounds ?? 0,
              elapsedMs: Date.now() - t0,
              reason: st?.reason ?? `驱动未推进（action=${outcome.action}）`,
            };
            break;
          }
        }
        driveResult = final;
      }

      // #77：只校验进程级最终答案。失败把诊断回喂再跑，最多 MAX_SCHEMA_FEEDBACK 次。
      // 回喂在 DriveManager 之外：不计入 --max、不重跑检查命令；可能再调工具，
      // 因此必须在 cleanup / uninstallSignals 之前完成。SIGINT 中止回喂按 130 收口。
      if (jsonSchema) {
        const outcome = await validateFinalAnswer(agent, stats, jsonSchema, streamBeginTurn);
        if (outcome.aborted) {
          stats = { ...stats, aborted: true };
        } else {
          structuredOutput = outcome.value;
          structuredDiagnostic = outcome.diagnostic;
        }
      }
    } catch (e) {
      // 异常退出路径：agent.send 抛错时不能把 MCP 子进程留在后面当孤儿。
      // 收完再原样抛出，让外层（main 的 catch / 进程退出）按原语义处理。
      s.cleanupEphemeralResources();
      throw e;
    } finally {
      uninstallSignals();
      // #64：--drive 的 boundary 与 --drive 同寿 —— 成功/失败/中断都在这里收口。
      if (oneShotDrive) agent.endUserTurn();
    }
    // 正常结束（含 hadError / aborted）：先收子进程再落盘退出。
    // -p 是「跑完就退」的一次性进程，子进程没有第二次机会被回收。
    // 顺序执行而非 finally：json 输出分支与 return 都在其后，清理必须在
    // persist 之前完成（persist 之后还有 await memory.flush，进程仍活着）。
    // issue #40：清理清单与 shutdown() 共用 cleanupEphemeral —— 旧实现只收 MCP，
    // 于是模型在 -p 里起的后台 shell / 后台子代理 / 语言服务器全成了孤儿。
    s.cleanupEphemeralResources();
    persist(agent.messages, sess.meta);
    // 单次模式：把记忆写队列在退出前冲刷掉（仅项目级；带超时，不阻塞关闭）
    await memory.flush();

    // 退出码约定（P0-6）：0 成功 / 1 LLM 或 agent 失败 / 2 用法错误 / 130 用户中断
    // issue #51：`-p --drive` 时退出码由驱动终态决定（达成 0 / 未达成 1），
    // 但 SIGINT 仍优先 130、LLM 硬错误仍 1（驱动跑完但模型报错不能报成功）。
    // #64：UserPromptSubmit 阻断按「被拒绝」收口为 1（不是成功，也不是用法错误）。
    let exitCode = stats.aborted ? 130 : stats.hadError || stats.blocked === true ? 1 : 0;
    if (driveResult) {
      // #52 固定优先级：abort > hadError > drive。检查碰巧通过也不能覆盖 LLM/Agent 硬错误。
      if (stats.aborted) exitCode = 130;
      else if (stats.hadError || stats.blocked === true) exitCode = 1;
      else exitCode = driveExitCode(driveResult);
      // PRD §2.4：结束摘要走 stderr（stdout 保持 -p 现有风格）。
      console.error(formatDriveSummary(driveResult));
      if (driveResult.reason) console.error(c.dim(`[drive] ${driveResult.reason}`));
    }

    // #37 H：EPIPE / stdout 写失败。writer 的 onClosed 已调 agent.cancel() 使
    // stats.aborted=true，会让上面的两处 exitCode 计算把它抬成 130；契约规定此
    // 物理例外强制退出 1，并跳过 result（writer 已 closed，不再写 stdout）。
    // 故覆盖必须放在所有 exitCode 计算之后（否则会被 `let exitCode = ...` 覆写）。
    // stderr 诊断只由 writer 发一条，组合根不补发第二条；这里仅移除常驻监听。
    if (s.stdoutClosed) {
      exitCode = 1;
      streamWriter?.dispose();
    }

    // #77：字段仍缺失且原本会是 0 → 改 1（不借用 2 与 3）。回喂已在 cleanup 前完成。
    if (jsonSchema && structuredOutput === undefined && exitCode === 0) exitCode = 1;

    if (jsonMode) {
      // 失败/中断/阻断时不要回填历史里的旧 assistant（--resume 场景会误导编排器）。
      const answer =
        stats.hadError || stats.aborted || stats.blocked === true
          ? null
          : [...agent.messages]
              .reverse()
              .find(
                (m) =>
                  m.role === "assistant" &&
                  !m.tool_calls &&
                  (contentText(m.content) ?? "").trim() !== "",
              ) ?? null;
      const payload = {
        v: 1,
        ok: exitCode === 0,
        exit_code: exitCode,
        answer: answer ? contentText(answer.content) : null,
        error: stats.errorMessage,
        finish_reason: stats.finishReason,
        aborted: stats.aborted,
        duration_ms: stats.durationMs,
        usage: {
          prompt: stats.promptTokens,
          completion: stats.completionTokens,
          reasoning: stats.reasoningTokens,
        },
        tool_calls: stats.toolCalls,
        iterations: stats.iterations,
        model: cfg.model,
        provider: cfg.providerName,
        session_id: sess.meta.id,
        tier_switch: stats.tierSwitch,
        // #77：只有校验通过才出现该键；answer 保留原文（不套 hadError 置 null 的规则）。
        ...(structuredOutput === undefined ? {} : { structured_output: structuredOutput }),
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return exitCode;
    }

    // ---- #37 stream-json 收口：drive_finished + 恰好一个 result ----
    if (streamJsonMode && streamWriter && !s.stdoutClosed) {
      // F：drive_finished 恰好一次（仅 --drive 且终态已确定），排在 result 之前。
      if (driveResult) {
        streamWriter.emitDriveFinished({
          status: driveResult.status,
          source: driveResult.source,
          rounds: driveResult.rounds,
          // DriveRunResult 用的是 elapsedMs，公开契约字段名是 elapsed_ms。
          elapsed_ms: driveResult.elapsedMs,
          reason: driveResult.reason ? clipReason(driveResult.reason) : null,
        });
      }

      // G：status 按契约优先级；exit_code 直接复用上面算出的 exitCode 变量
      // （#52 优先级 abort > hadError > drive 是唯一来源），writer 内不重算。
      const resultStatus: StreamResultStatus = stats.aborted
        ? "aborted"
        : stats.hadError || stats.blocked === true
          ? "failed"
          : driveResult && driveResult.source === "model"
            ? "model_done"
            : driveResult && driveExitCode(driveResult) !== 0
              ? "failed"
              : // #77：因 schema 把 0 改成 1 时不能报 completed（避免 completed 配 exit_code=1）。
                exitCode !== 0
                ? "failed"
                : "completed";
      streamWriter.emitResult({
        status: resultStatus,
        exit_code: exitCode as StreamResultExitCode,
        provider: cfg.providerName,
        model: cfg.model,
        // 整个进程会话累计（含 drive 多轮、辅助请求），而非最后一轮 stats。
        usage: {
          prompt: agent.cumulative.prompt,
          completion: agent.cumulative.completion,
          reasoning: agent.cumulative.reasoning,
          by_model: agent.usageByModel(),
        },
        drive: driveResult
          ? {
              status: driveResult.status,
              source: driveResult.source,
              rounds: driveResult.rounds,
              elapsed_ms: driveResult.elapsedMs,
            }
          : null,
        error: stats.errorMessage,
        // #77：只在校验通过时出现该键；无旗标时保持既有 7 键形状。
        ...(structuredOutput === undefined ? {} : { structured_output: structuredOutput }),
      });
      // 等有界 flush 再从 main() 返回，不用 process.exit() 截断缓冲。
      await streamWriter.flush();
      streamWriter.dispose();
    }

    // #37 H 补充：EPIPE 也可能恰好在最终 result 写入时才到达（下游在收口前关闭）。
    // 上面的 stdoutClosed override 早于 result 写入，无法覆盖这一物理例外；
    // 此处再校正一次，保证「stdout 写失败 → 强制 exit 1」对所有写入时点成立。
    // writer 已 closed，不再写 stdout，也不会产生第二个 result。
    if (s.stdoutClosed) exitCode = 1;

    // #77 text（默认格式）+ --json-schema：stdout 只打校验通过的紧凑单行 JSON。
    // 不合规时 stdout 什么都不打（不把原始叙述或半段 JSON 漏出去），靠非 0 退出码 +
    // stderr 诊断。无旗标时这条分支不生效，text 形状完全不变。
    if (jsonSchema && !streamJsonMode && !s.stdoutClosed) {
      if (structuredOutput !== undefined) {
        process.stdout.write(`${JSON.stringify(structuredOutput)}\n`);
      } else if (structuredDiagnostic) {
        console.error(c.err(`✖ ${structuredDiagnostic}`));
      }
    }

    return exitCode;
  }

  // 也允许 `neo 你的问题` 直接作为首轮输入（非交互）
  if (args.rest.length > 0 && !process.stdin.isTTY) {
    const restPrompt = args.rest.join(" ");
    // issue #41：与 -p 同口径，斜杠命令在非交互模式下必须明确拦下。
    const restSlashCommand = knownSlashCommand(restPrompt);
    if (restSlashCommand === "output-style") {
      return await runOneshotOutputStyle(s, restPrompt);
    }
    if (restSlashCommand) {
      console.error(c.err(`✖ 非交互模式不解析斜杠命令：/${restSlashCommand} 只能在交互模式使用`));
      s.cleanupEphemeralResources();
      return 2;
    }
    try {
      await agent.send(restPrompt);
    } finally {
      // 与 -p 同一条一次性进程路径（issue #40）：子进程必须显式收掉，否则留下孤儿。
      s.cleanupEphemeralResources();
    }
    persist(agent.messages, sess.meta);
    await memory.flush();
    return 0;
  }


  return null;
}

/**
 * #77：取进程级最终答案（最后一条无 tool_calls 的非空助手文本）并校验。
 *
 * 不合规就把诊断作为一条后续用户消息回喂再跑，最多 MAX_SCHEMA_FEEDBACK 次。
 * 回喂在 DriveManager 之外：不计入 --max、不重跑检查命令；若回喂又调工具，
 * 仍走既有权限 / -y。SIGINT 中止回喂时返回 aborted（调用方按 130 收口）。
 */
async function validateFinalAnswer(
  agent: AppSession["agent"],
  stats: Awaited<ReturnType<AppSession["agent"]["send"]>>,
  schema: CompiledSchema,
  beginTurn: () => void,
): Promise<{ value?: unknown; diagnostic: string | null; aborted: boolean }> {
  // 硬错误 / 中断 / 阻断时没有可信的最终答案，不校验也不回喂。
  if (stats.aborted || stats.hadError || stats.blocked === true) {
    return { diagnostic: null, aborted: false };
  }
  const finalAnswer = (): string => {
    const last = [...agent.messages]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" &&
          !m.tool_calls &&
          (contentText(m.content) ?? "").trim() !== "",
      );
    return last ? (contentText(last.content) ?? "") : "";
  };
  let check = checkAgainstSchema(schema, finalAnswer());
  for (let round = 0; !check.ok && round < MAX_SCHEMA_FEEDBACK; round++) {
    beginTurn();
    let next: Awaited<ReturnType<AppSession["agent"]["send"]>>;
    try {
      next = await agent.send(feedbackMessage(check.diagnostic));
    } catch {
      // 回喂请求本身失败：保留已有诊断，不再重试（退出码仍由原 stats 决定）。
      return { diagnostic: check.diagnostic, aborted: false };
    }
    if (next.aborted) return { diagnostic: null, aborted: true };
    if (next.hadError || next.blocked === true) return { diagnostic: check.diagnostic, aborted: false };
    check = checkAgainstSchema(schema, finalAnswer());
  }
  return check.ok
    ? { value: check.value, diagnostic: null, aborted: false }
    : { diagnostic: check.diagnostic, aborted: false };
}
