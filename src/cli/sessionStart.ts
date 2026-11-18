import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tierDisplayName, tierChoiceLabel, type Config } from "../config.ts";
import { Agent } from "../agent.ts";
import { clipPaths, clipReason, clipToolArguments, clipToolOutput } from "../streamJson.ts";
import type { AssistantMessageEventData, ToolEndEventData, ToolStartEventData } from "../agent/loop.ts";
import { persist } from "./sessions.ts";
import { c } from "../ui/theme.ts";
import { extractTouchedPaths, formatAlwaysOnRules, formatScopedRulesBlock, selectScopedRules } from "../rules/index.ts";
import { makeRememberTool } from "../tools/memory.ts";
import { makeTodoWriteTool, type TodoItem } from "../tools/todo.ts";
import { chatStream } from "../llm.ts";
import { registerTool } from "../tools/index.ts";
import { McpManager } from "../mcp/index.ts";
import { makeTaskTool, runSubagent } from "../tools/task.ts";
import { BackgroundTasks, serializeJobs, restoreJobs } from "../tools/background.ts";
import { saveSubagentTranscript } from "../tools/transcript.ts";
import { backgroundShells } from "../tools/backgroundShell.ts";
import { cleanupEphemeral } from "../cleanup.ts";
import { makeAskUserTool } from "../tools/askUser.ts";
import { registerWikiTools } from "../tools/wiki.ts";
import { loadEnv } from "../env/probe.ts";
import { recordModelContext, resolveAndApplyModelWindow } from "../env/modelWindows.ts";
import { writeBackContextLimit, writeBackOutputLimit } from "../env/modelCaps.ts";
import { syncEnvPage } from "../env/wiki.ts";
import { ensureScopeLayout } from "../memory/layout.ts";
import {
  WIKI_WORKER_LOCK_TIMEOUT_MS,
  WIKI_WORKER_TOOLS,
  WikiMaintainer,
  wikiWorkerLockDir,
} from "../memory/wikiMaintainer.ts";
import { WikiLockBusyError } from "../memory/locks.ts";
import { applyRestored } from "../session.ts";
import * as mailboxState from "../mailbox/state.ts";
import { formatIncomingFrame, formatNotice, formatNoticePreview } from "../mailbox/inbound.ts";
import { makeListPeersTool, makeSendMessageTool } from "../tools/mailbox.ts";
import { lspServers } from "../lsp/index.ts";
import { formatResumeWarning } from "../turnDiagnostics.ts";
import { bootstrap } from "./bootstrap.ts";

/**
 * 后台 wiki 维护 worker 的生产实现（issue #53）：fast 档子代理 + 白名单 + 写锁。
 *
 * 锁忙（CaptureEngine 正持 journalDir/.write.lock）时 wiki_write 会调 onTimeout 并中止
 * 子代理；这里把那次失败换成 WikiLockBusyError —— 维护器据此静默放弃本轮，下一轮再判。
 */
async function runWikiWorker(
  agent: Agent,
  cfg: Config,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  let lockBusy = false;
  try {
    return await runSubagent(
      agent,
      prompt,
      "fast",
      { cfg, approve: async () => false, signal: ctrl.signal },
      undefined,
      undefined,
      {
        toolAllowlist: WIKI_WORKER_TOOLS,
        approve: async () => false,
        wikiWriteLock: {
          dir: wikiWorkerLockDir(cfg),
          timeoutMs: WIKI_WORKER_LOCK_TIMEOUT_MS,
          onTimeout: () => {
            lockBusy = true;
            ctrl.abort();
          },
        },
        failOnError: true,
      },
    );
  } catch (e) {
    if (lockBusy) throw new WikiLockBusyError(`记忆写锁被占用（${wikiWorkerLockDir(cfg)}）`);
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * 构造 Agent、后台任务、MCP、项目记忆与环境快照。
 */
type BootstrapSession = Exclude<Awaited<ReturnType<typeof bootstrap>>, number>;

export async function startSession(s: BootstrapSession) {
  const {
    args,
    cfg,
    interactiveTTY,
    streamJsonMode,
    structuredMode,
    ui,
    announceCapabilityGap,
    restored,
    meta,
    classifier,
    sess,
    streamWriter,
    checkpoints,
    rewindLog,
    memoryMode,
    memory,
    mailbox,
    inboundRefs,
    closeMailbox,
    collectInbound,
    promptManager,
    projectRules,
    scopedRuleList,
    fallbackController,
  } = s;
  const agent = new Agent({
    cfg,
    console: ui,
    mode: args.mode,
    // #59：只有主 Agent 请求经过备用链；compact / judge / classifier / subagent 走既有路径。
    ...(fallbackController
      ? {
          mainChatStream: (
            c2: Config,
            m: Parameters<typeof chatStream>[1],
            t: Parameters<typeof chatStream>[2],
            h?: Parameters<typeof chatStream>[3],
            s?: AbortSignal,
          ) => fallbackController.stream(c2, m, t, h, s),
          isFallbackActive: () => fallbackController.isActive,
        }
      : {}),
    systemPrompt: promptManager.render(cfg).text,
    renderSystemPrompt: () => promptManager.render(cfg, { mcpLoaded: agent.mcpLoadedNames() }).text,
    getSessionName: () => s.sessionLabel,
    classifier,
    // issue #17：路径作用域规则。loop 只拿回调，不 import rules 模块。
    toolPathsOf: (name, argsJson) => extractTouchedPaths(name, argsJson, cfg.cwd),
    scopedRulesPrompt: (touched) => {
      if (scopedRuleList.length === 0) return null;
      const matches = selectScopedRules(scopedRuleList, touched, { cwd: cfg.cwd });
      const text = formatScopedRulesBlock(matches);
      return text === "" ? null : { text, matches };
    },
    memory,
    checkpoint: checkpoints,
    sessionId: sess.meta.id,
    // 生命周期 hooks（issue #3）：会话启动时已由 loadConfig 解析一次，
    // 这里直接挂上 —— 改 settings.hooks 需重启（与 mcpServers 同口径）。
    hooks: cfg.hooks,
    // 目标锚（2026-10-26）：每轮现取，/goal 中途改写能立刻生效。
    // 读失败按「无目标」降级 —— 目标锚是增强项，不得阻塞主流程。
    readGoal: () => {
      if (!mailbox) return null;
      try {
        return mailboxState.readGoal(mailbox.root, mailbox.sessionId)?.text ?? null;
      } catch {
        return null;
      }
    },
    // A2：每轮前按当前模型刷新窗口；溢出时把服务端解析出的上限记到 env 事实文件。
    refreshContextWindow: () => resolveAndApplyModelWindow(cfg),
    onContextLimit: (tokens) => {
      recordModelContext(cfg, {
        contextWindow: tokens,
        source: "overflow_error",
        evidence: "服务端上下文溢出错误",
      });
      // P3 撞墙写回：settings 里 context_window 为空才补，已填的保持用户值。
      writeBackContextLimit(cfg, tokens);
    },
    // #6 输出撞墙：finish_reason=length（含截断正文与工具轮）时探测输出上限。
    // 只补空的 max_output_tokens。网关没给就提示手写，绝不把本次 completion_tokens
    // 或请求预算 max_tokens 记成能力上限。
    onOutputLimit: () => {
      void writeBackOutputLimit(cfg)
        .then((r) => {
          if (r.written.length > 0) {
            ui.info(`已从网关 /models 补上：${r.written.join("、")}（只写空字段）。`);
          }
          announceCapabilityGap();
        })
        .catch(() => {
          /* 探测/写回失败不影响重试 */
        });
    },
    // issue #39：压缩生效后平移轮次下标，否则 `/rewind` 的对话回滚会截错位置。
    onCompacted: (rec) => {
      rewindLog.noteCompaction(rec);
      sess.meta.rewind = rewindLog.serialize();
    },
    askUser: interactiveTTY
      ? (req) => {
          const c = s.composerRef;
          return c ? c.askUser(req) : Promise.resolve({ status: "canceled" as const });
        }
      : undefined,
    cancelAskUser: () => s.composerRef?.cancelAskUser(),
    // 交互式规划工作流（issue #14）：模型提交方案（exit_plan_mode）后把「待确认」
    // 摆到用户眼前。绝不在这里自动批准 —— 批准是用户的动作。
    requestPlanApproval: () => {
      if (structuredMode) return;
      ui.blank();
      ui.line(`${c.warn("◆")} 方案待确认：${c.dim("/plan approve 开始实施 · /plan revise 修改 · /plan cancel 放弃")}`);
      s.composerRef?.rerender();
    },
    // -p 单次模式：即使终端是 TTY 也按非交互块级渲染，避免 spinner/ANSI 污染输出
    nonInteractive: args.print !== null,
    // issue #16：后台子代理结果（取走即清）在每次请求前注入。
    pollBackground: () => {
      // issue #45：每次取结果前同步落盘快照（只在变化时写，见 syncBackgroundJobs）。
      syncBackgroundJobs();
      return s.backgroundTasks?.collectFinished() ?? [];
    },
    pollInbox: mailbox
      ? () => {
          const mb = mailbox;
          if (!mb) return [];
          const frames = collectInbound().map(formatIncomingFrame);
          // P1 也按 watchdog 周期检查委派台账（长时间忙碌时不必等回 idle）。
          const now = Date.now();
          if (now - s.lastWatchdogAt >= cfg.mailbox.watchdogIntervalS * 1000) {
            s.lastWatchdogAt = now;
            try {
              for (const n of mb.watchdog()) {
                ui.line(c.dim(formatNoticePreview(n)));
                frames.push(formatNotice(n));
              }
            } catch {
              // watchdog 失败不影响主循环
            }
          }
          return frames;
        }
      : undefined,
    onEvent: (e) => {
      // #37 stream-json：把 Agent 内部事件投影为公开 JSONL 事件（仅 streamJsonMode）。
      // 必须置于 tier_switch 早退与 `!mailbox` 早退之前，否则事件会被吞掉。
      // writer 内部还会做一次白名单投影/限长兜底；这里传入 ClippedText 与 clipPaths 结果
      // 是为了让公开载荷在组合根这一层就完成脱敏与限长，不把原始值透传到 stdout。
      if (streamJsonMode && streamWriter && !s.stdoutClosed) {
        switch (e.type) {
          case "assistant_message": {
            const d = e.data as AssistantMessageEventData;
            streamWriter.emitAssistantMessage({
              turn: s.turnNo,
              provider: cfg.providerName,
              model: cfg.model,
              content: d.content,
              tool_calls: d.tool_calls.map((call) => ({
                call_id: call.call_id,
                name: call.name,
                arguments: clipToolArguments(call.arguments),
              })),
              finish_reason: d.finish_reason,
              // writer 会按 finish_reason === "length" 强制覆盖 truncated。
              truncated: false,
            });
            break;
          }
          case "tool_start": {
            const d = e.data as ToolStartEventData;
            streamWriter.emitToolStarted({
              turn: s.turnNo,
              call_id: d.call_id,
              name: d.name,
              arguments: clipToolArguments(d.args),
              paths: clipPaths(d.paths, cfg.cwd),
            });
            break;
          }
          case "tool_end": {
            const d = e.data as ToolEndEventData;
            streamWriter.emitToolFinished({
              turn: s.turnNo,
              call_id: d.call_id,
              name: d.name,
              status: d.status,
              output: clipToolOutput(d.output, d.truncated),
              paths: clipPaths(d.paths, cfg.cwd),
            });
            break;
          }
          case "error": {
            streamWriter.emitError({
              // 内部 error 事件只带一个消息字符串、无 code 判别器，故统一取一个编码。
              // 取 model_error：架构组合真值表唯一带 error 的失败行是「所有模型候选失败」，
              // 该路径经 loop.ts:1104 的 `LLM 请求失败` 到达；且 3 个发点中 :869 空正文、
              // :1104 LLM 请求失败两处都是模型侧。:1126 迭代上限实为 agent 侧，属已知粗映射。
              code: "model_error",
              // clipReason 做尽力脱敏（URL/Bearer/sk-/键值）+ 500 code point 限长，
              // 对应 §3.8「不记录 LLM error body / API key」。
              message: clipReason(String(e.data ?? "")),
              provider: cfg.providerName,
              model: cfg.model,
            });
            break;
          }
          // aborted / text / reasoning / turn_end / compact / plan / tier_switch
          // 均为内部事件，不产生公开 JSONL 事件（aborted 由 result.status 体现）。
          default:
            break;
        }
      }

      // v0.4.2：分类切档发生在请求之前，提示也必须在请求之前出现（不再等 turn 结束）。
      if (e.type === "tier_switch") {
        if (!structuredMode) {
          const ts = e.data as {
            from: string;
            to: string;
            reason: string;
            degraded?: string;
          };
          ui.blank();
          ui.line(
            `${c.tier(ts.to, "⇅")} 档位 ${c.dim(tierDisplayName(ts.from))} → ${c.tier(ts.to, tierChoiceLabel(ts.to))} ` +
              `${c.dim(`(${cfg.providerName}/${cfg.model})`)}`,
          );
          ui.line(`  ${c.dim("理由:")} ${c.muted(ts.reason)}`);
          if (ts.degraded) ui.line(`  ${c.warn("降级:")} ${c.warn(ts.degraded)}`);
          ui.blank();
          s.composerRef?.rerender();
        }
        return;
      }
      if (!mailbox) return;
      const mb = mailbox;
      try {
        if (e.type === "tool_end") {
          // 工具结果回填 = 有进展：watchdog 的 stuck 判定依据（PRD §4.10.3）
          s.lastStreamProgressAt = Date.now();
          mailboxState.touchProgress(mb.root, mb.sessionId);
        } else if (e.type === "text" || e.type === "reasoning") {
          // 长 LLM 流式输出也是进展：节流 30s 刷一次，避免每个 chunk 写盘。
          const now = Date.now();
          if (now - s.lastStreamProgressAt >= 30_000) {
            s.lastStreamProgressAt = now;
            mailboxState.touchProgress(mb.root, mb.sessionId);
          }
        }
      } catch {
        // 状态写入失败不影响主流程
      }
    },
  });

  // #37：writer 的 stdout 关闭钩子必须在 agent 构造完成后才能接（要调 agent.cancel()）。
  // EPIPE/写失败时：置 stdoutClosed 让组合根跳过 result 并强制退出 1，同时取消在跑的 Agent；
  // stderr 诊断只由 writer 发一条，组合根不再补发。
  if (streamWriter) {
    streamWriter.onClosed = () => {
      s.stdoutClosed = true;
      agent.cancel();
    };
  }

  // 后台子代理任务表（issue #16）：每个任务一个 AbortController；取消走 /tasks cancel
  // 或会话退出，主 turn 的 ESC 不误伤后台任务（见 onCancelTurn 的提示）。
  s.backgroundTasks = new BackgroundTasks({
    run: (job, signal) =>
      runSubagent(
        agent,
        job.prompt,
        job.tier,
        // 用自己的 signal：后台任务的生命周期独立于发起它的那一轮。
        { ...job.ctx, signal, onProgress: undefined },
        job.promptTier,
        // issue #48：把子代理的最终 messages 交出来，任务结束即落盘（续聊要用它重建上下文）。
        // 放在这里而不是 runSubagent 内部：runSubagent 不知道自己的 jobId。
        { onMessages: (msgs) => saveSubagentTranscript(sess.meta.id, job.id, msgs) },
      ),
  });

  // issue #45：后台任务落盘。只存纯数据快照（无 ctx / signal），
  // 位置选 session meta 而不是独立文件 —— 理由：
  //  1. 与 todos / rewind 同一先例，`--resume` 走同一条恢复路径，不需要新增目录与清理逻辑；
  //  2. 任务表本身很小（上限 20 条 + 结果截断 2k 字符），不会让 session 文件显著膨胀；
  //  3. 独立 JSONL 需要额外的「会话删除时同步删」与「并发追加」两套机制，收益不抵成本。
  // 写盘时机与 todos 一致：任务状态变化后立刻落盘（persist 内部已吞异常）。
  const persistBackgroundJobs = (): void => {
    if (!s.backgroundTasks) return;
    sess.meta.backgroundTasks = serializeJobs(s.backgroundTasks.rawJobs());
    persist(agent.messages, sess.meta);
  };
  // 恢复（issue #45）：旧会话没有该字段 = 空清单；running 一律映射成 interrupted。
  const restoredJobs = restoreJobs(sess.meta.backgroundTasks);
  // 任务结束（done / error / cancelled）时落盘。BackgroundTasks 没有完成回调，
  // 这里用主循环已有的 pollBackground 钩子顺带刷新：每次取结果前先同步快照。
  const syncBackgroundJobs = (): void => {
    if (!s.backgroundTasks) return;
    const next = serializeJobs(s.backgroundTasks.rawJobs());
    // 整表比对（上限 20 条 + 单条结果 2k 字符，成本可忽略）：只比「条数或末条」会漏掉
    // 非末条任务的完成状态（任务可以乱序完成），导致 resume 后看到过期的 running。
    if (JSON.stringify(next) === JSON.stringify(sess.meta.backgroundTasks ?? [])) return;
    sess.meta.backgroundTasks = next;
    persist(agent.messages, sess.meta);
  };

  // task 工具：派生子代理。必须在首次 send 前注册 —— toolSpecs() 每轮现取，注册后即刻生效。
  registerTool(
    makeTaskTool({
      run: (prompt, tier, ctx, promptTier) => runSubagent(agent, prompt, tier, ctx, promptTier),
      background: {
        launch: (job) => {
          const r = s.backgroundTasks!.launch(job);
          // issue #45：发起即落盘（状态 running 也写，重启后会被映射成 interrupted）。
          if (r.ok) persistBackgroundJobs();
          return r.ok ? { ok: true, id: r.job.id } : { ok: false, error: r.error };
        },
      },
    }),
  );

  // wiki 工具：检索 + 回填唯一路径（raw 不可改拦截在 write_file/edit_file 内）。
  registerWikiTools(registerTool);

  // 记忆工具：模型显式写入（与自动归纳共用同一合并管线；子代理不可见）。
  registerTool(makeRememberTool({ remember: (body, scope) => memory.remember(body, scope) }));

  // 结构化待办（issue #10）：会话级 checklist，整表替换。
  // 状态存 sess.meta.todos（与 messages 并列），压缩只换 messages，清单因此不受影响。
  // 子代理不可见（TOOL_NAMES_EXCLUDED_FOR_SUBAGENT）：子代理不该改主会话的清单。
  let sessionTodos: TodoItem[] = Array.isArray(sess.meta.todos) ? sess.meta.todos : [];
  registerTool(
    makeTodoWriteTool({
      get: () => sessionTodos,
      set: (items) => {
        sessionTodos = items;
        sess.meta.todos = items;
      },
      // 写完立刻落盘：长任务中途进程被杀时清单不丢（persist 内部已吞异常）。
      persist: () => persist(agent.messages, sess.meta),
    }),
  );

  // ask_user（v0.4.1 B2）：只在交互 TUI 注册；-p / 管道里模型看不到该工具。
  if (interactiveTTY) {
    registerTool(
      makeAskUserTool({
        ask: (req) => {
          const c = s.composerRef;
          return c ? c.askUser(req) : Promise.resolve({ status: "canceled" as const });
        },
      }),
    );
  }

  // 跨会话工具：send_message / list_peers（只有启用信箱的交互式会话注册）。
  if (mailbox) {
    const mb = mailbox;
    registerTool(
      makeSendMessageTool({
        mailbox: mb,
        replyHint: (target) => {
          if (!s.activeTurnFrom) return undefined; // 人类输入的 turn 不自动补 reply_to
          try {
            const p = mb.resolvePeer(target, { requireAlive: true });
            if (p.session !== s.activeTurnFrom) return undefined;
            return inboundRefs.get(p.session);
          } catch {
            return undefined;
          }
        },
        onSent: (env, replyTo) => {
          // 回信成功后消费 hint，防止下一条消息误引用同一任务号
          if (replyTo && inboundRefs.get(env.to) === replyTo) inboundRefs.delete(env.to);
        },
      }),
    );
    registerTool(makeListPeersTool({ mailbox: mb }));
  }

  // MCP 外部工具（issue #2）：连接已配置的 stdio server 并动态注册工具。
  // 必须在系统提示刷新之前完成 —— `可用工具` 行由 toolNames() 现取，
  // 连完再刷新，模型第一轮就能看见 mcp__* 工具。
  // 单个 server 失败只记状态（/mcp 可查），不抛错、不阻塞启动。
  const mcpManager = new McpManager(cfg.mcpServers ?? [], {
    onStderr: (server, line) => {
      // server 的 stderr 默认很吵（npx 进度、日志），只在失败时由 /mcp 展示尾巴。
      void server;
      void line;
    },
  });
  if ((cfg.mcpServers ?? []).length > 0) {
    const n = await mcpManager.connectAll();
    const states = mcpManager.statuses();
    if (n > 0) ui.info(`MCP：已接入 ${n} 个外部工具（/mcp 查看）`);
    for (const s of states.filter((x) => x.status === "error")) {
      ui.warn(s.error ?? `MCP server "${s.name}" 连接失败`);
    }
    // 注册失败的工具既不在模型工具清单里，也不该让用户以为可用 —— 启动时就说清楚。
    for (const s of states) {
      for (const r of s.rejected ?? []) {
        ui.warn(`MCP 工具 ${r.name}（${s.name}/${r.remote}）注册失败，不可用：${r.reason}`);
      }
    }
  }

  // 生命周期 hooks（issue #3）：启动时把加载结果与配置告警摆出来。
  // 写错的条目已在解析期丢弃 —— 这里必须说清楚，不能让用户以为 hook 生效了。
  if (cfg.hooks.enabled) {
    const n = Object.values(cfg.hooks.hooks).reduce((total, hooks) => total + hooks.length, 0);
    if (n > 0) ui.info(`hooks：已加载 ${n} 条生命周期 hook（/hooks 查看）`);
  }
  for (const w of cfg.hooks.warnings) ui.warn(`hooks 配置：${w}`);

  // 运行时工具注册完成后再刷新系统提示：`可用工具` 行由 toolNames() 现取，
  // 首次构造时运行时工具（task/wiki/remember/send_message/list_peers）尚未注册。
  promptManager.invalidate();
  agent.refreshSystemPrompt();

  if (restored && restored.length > 0) {
    agent.messages = applyRestored(agent.messages[0], restored);
    ui.info(`已恢复会话 ${meta?.id ?? ""}（${restored.length} 条消息）`);
    // 用户裁决：恢复对话/名字/信箱，但不偷偷切换工作目录。
    if (meta?.cwd && meta.cwd !== cfg.cwd) {
      ui.info(`会话原目录 ${meta.cwd}，本次按 ${cfg.cwd} 运行`);
    }
    // issue #10：待办随会话恢复（存在 meta 里，与对话摘要无关）。
    if (sessionTodos.length > 0) {
      ui.info(`已恢复待办 ${sessionTodos.length} 项（/todos 查看）`);
    }
    // v0.4.1 A1：上次会话最后一轮失败/空转 → 明确告警，避免用户以为上下文正常。
    const resumeWarn = formatResumeWarning(meta);
    if (resumeWarn) {
      ui.warn(resumeWarn);
      ui.line(c.dim("  诊断日志：~/.neo/logs/turns/（可用 NEO_LOG_DIR 覆盖）"));
    }
  }

  // 覆盖系统提示：注入项目记忆文件（若存在）
  // issue #18：注入仍在这里（系统提示必须早于首轮），但**提示行**延后到
  // banner + shell 行之后输出（见下方「启动输出顺序」），避免记忆提示跑到 banner 前面。
  const memoryFile = ["AGENTS.md", "NEO.md", ".neo.md"]
    .map((f) => join(cfg.cwd, f))
    .find((p) => existsSync(p));
  // issue #17：无 paths 的规则按「每会话」并入项目记忆段（独立小节，便于 /context 区分）。
  const alwaysOnText = formatAlwaysOnRules(projectRules);
  if (memoryFile || alwaysOnText !== "") {
    const base = memoryFile ? readFileSync(memoryFile, "utf8") : "";
    promptManager.setProjectMemory({
      path: memoryFile ?? join(cfg.cwd, ".neo/rules"),
      text: `${base}${alwaysOnText}`,
    });
    agent.refreshSystemPrompt();
  }

  // v0.2 记忆激活 §7.7.1 R0：用户画像摘要注入 messages[1]（不追加到 messages[0]）。
  // -p 单次模式启动注入恒为 null（只用项目级记忆）；失败不阻塞会话。
  try {
    const slice = await memory.startup();
    if (slice) {
      agent.messages.splice(1, 0, slice.message);
      ui.info(`已注入用户画像（${slice.tokens} tokens）`);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`用户画像注入失败 ${reason}（session 不阻塞）`);
  }
  // 上次进程遗留的 journal：启动时有界恢复（不阻塞主流程）
  memory.recoverPending();

  // #64 SessionStart：历史恢复与 memory.startup 之后、任何真实输入之前触发一次。
  //  - new：本进程新开会话（-p 同样算 new —— 它是一次真实会话开始）；
  //  - resume：--resume / --continue 命中了历史。
  // 历史回放**不算**用户提交，所以这里只发 SessionStart，不发 UserPromptSubmit。
  // 失败只诊断：会话已经开始，把 SessionStart 的失败当阻断等于让用户开不了工。
  // 诊断走 stderr：-p 下 stdout 是结果通道，不能混进 hook 文本。
  await agent.runSessionStart(restored !== null ? "resume" : "new");



  // v0.4.0 平台适配层：环境快照落用户级 wiki。
  // -p / 非交互模式只注入不落盘（用户裁决）；失败非致命，不阻塞会话。
  if (
    memoryMode === "interactive" &&
    cfg.memory.enabled &&
    cfg.memory.scopeMode !== "project" &&
    cfg.env?.enabled !== false &&
    cfg.env?.wikiPage !== false
  ) {
    try {
      const loaded = loadEnv({ cfg, persist: true });
      if (loaded) {
        const layout = ensureScopeLayout("user", cfg.cwd, cfg.memory.userWikiDir);
        const r = syncEnvPage(layout, loaded.snapshot);
        if (r.action === "created") ui.info(`已生成环境快照 ${r.pagePath}`);
      }
    } catch (e) {
      console.error(`环境快照落盘失败 ${(e as Error).message}（session 不阻塞）`);
    }
  }



  // issue #53：轮末后台 wiki 维护。只有交互会话构造 —— `-p` 与 ACP 不接 worker
  // （issue 明确以交互模式为主，-p 继续只做 memory.flush）。
  if (args.print === null) {
    s.wikiMaintainer = new WikiMaintainer({
      cfg,
      memory,
      launch: (job) => {
        const r = s.backgroundTasks!.launch({
          kind: "wiki",
          prompt: job.label,
          run: job.run,
          ctx: { cfg, approve: async () => false },
        });
        return r.ok ? { ok: true, id: r.job.id } : { ok: false, error: r.error };
      },
      runWorker: (prompt, signal) => runWikiWorker(agent, cfg, prompt, signal),
      notice: (msg) => ui.info(msg),
    });
  }

  const cleanupEphemeralResources = function cleanupEphemeralResources(): void {
    cleanupEphemeral({
      loop: s.loopScheduler ?? null,
      drive: s.drive ?? null,
      tasks: s.backgroundTasks,
      shells: backgroundShells,
      lsp: lspServers,
      mcp: mcpManager,
      closeMailbox,
    });
  };
  s.cleanupEphemeralResources = cleanupEphemeralResources;

  return Object.assign(s, {
    agent,
    persistBackgroundJobs,
    restoredJobs,
    syncBackgroundJobs,
    sessionTodos,
    mcpManager,
    memoryFile,
    alwaysOnText,
    cleanupEphemeralResources,
  });
}

export type AppSession = Awaited<ReturnType<typeof startSession>>;
