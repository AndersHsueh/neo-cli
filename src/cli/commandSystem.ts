/**
 * 工具、协作、目标与任务命令
 */
import {
  detectAndRecordModelWindow,
  formatCapabilityGapHint,
  formatModelWindowLines,
  resolveAndApplyModelWindow,
} from "../env/modelWindows.ts";
import { loadEnv } from "../env/probe.ts";
import { formatEnvForCli } from "../env/render.ts";
import { syncEnvPage } from "../env/wiki.ts";
import type { RewindMode } from "../rewind.ts";
import type { DriveSpec } from "../drive.ts";
import { formatInterval, parseLoopCommand } from "../loop.ts";
import { formatShellJobs } from "../tools/backgroundShell.ts";
import { ensureScopeLayout } from "../memory/layout.ts";
import { renameSession } from "../mailbox/identity.ts";
import * as mailboxState from "../mailbox/state.ts";
import { HOOK_EVENTS, describeHook } from "../hooks/index.ts";
import { renderMarkdown } from "../ui/render.ts";
import { makeListPeersTool } from "../tools/mailbox.ts";
import { mainToolNames, toolNames } from "../tools/index.ts";
import { CODE_MODE_TOOL_NAME, codeModeExposed } from "../tools/codeMode.ts";
import { formatTodos } from "../tools/todo.ts";
import type { ToolCtx } from "../tools/types.ts";
import { c } from "../ui/theme.ts";

import type { CommandContext } from "./commandContext.ts";

export async function handleSystemCommands(cmd: string, arg: string, rest: string[], ctx: CommandContext): Promise<boolean> {
  const {
    agent, ui, cfg, meta, mailbox,
    injectMailbox, onNameChange, loop, tasks, shells, rewind, drive,
  } = ctx;
  const memoryMode = ctx.memoryMode ?? "interactive";
  switch (cmd) {
    case "tools": {
      // 规划态控制工具只在规划态可见（issue #14），平时不列出来 ——
      // 否则用户会以为现在就能调 submit_plan。
      const baseNames = agent.planning ? toolNames(cfg) : mainToolNames(cfg);
      // issue #71：Code Mode 只在交互 TUI 且实验开关打开时暴露。
      // 不能只靠 CONDITIONAL_TOOL_NAMES —— mainToolNames 会把它滤掉。
      const codeModeOn = codeModeExposed(cfg, {
        nonInteractive: agent.opt.nonInteractive === true,
        isSubagent: agent.opt.isSubagent === true,
        planning: agent.planning,
      });
      const names = codeModeOn
        ? (baseNames.includes(CODE_MODE_TOOL_NAME) ? baseNames : [...baseNames, CODE_MODE_TOOL_NAME])
        : baseNames.filter((n) => n !== CODE_MODE_TOOL_NAME);
      // issue #68：MCP 延迟加载下，注册表里的 MCP 工具分两种命运 ——
      // 带完整 schema 进请求（已装入 / alwaysLoad），或只出现在系统提示的目录短节里。
      // 混在一行里列出来会让人以为「列了就能调」，所以分两段显示。
      const inCtx = new Set(agent.toolSpecsFor().map((s) => s.function.name));
      const loadedMcp = names.filter((n) => n.startsWith("mcp__") && inCtx.has(n));
      const catalogOnly = names.filter((n) => n.startsWith("mcp__") && !inCtx.has(n));
      const plain = names.filter((n) => !n.startsWith("mcp__"));
      ui.blank();
      ui.kv("可用工具", String(names.length));
      for (const t of plain) ui.line(`  ${c.tool("⚡")} ${c.text(t)}`);
      if (loadedMcp.length > 0) {
        ui.line(
          `  ${c.tool("⚡")} ${c.text("MCP")} ${c.dim(`已装入上下文 ${loadedMcp.length} 个（带完整 schema）`)}`,
        );
        for (const t of loadedMcp) ui.line(`    ${c.text(t)}`);
      }
      if (catalogOnly.length > 0) {
        ui.line(
          `  ${c.dim("◇")} ${c.text("MCP")} ${c.dim(`仅目录 ${catalogOnly.length} 个（只有名字与简述，没有 schema）`)}`,
        );
        for (const t of catalogOnly) ui.line(`    ${c.dim(t)}`);
        ui.line(c.dim(`  未装入的工具用 tool_search 搜索装入，或直接点名调用（照走审批并自动装入）。`));
      }
      if (agent.planning) {
        ui.line(c.dim("  当前在规划态：只读工具 + submit_plan / exit_plan_mode"));
      } else {
        ui.line(c.dim("  规划态（/plan）会额外出现 submit_plan / exit_plan_mode"));
      }
      ui.blank();
      return true;
    }

    case "hooks": {
      // issue #3：一眼看清「配了哪些生命周期 hook、哪条写错了被丢弃」。
      // hooks 不是权限系统 —— 这里刻意不展示任何「放行/拒绝」策略，
      // 免得用户误以为它是 #4 那种 allow/deny 规则表。
      const h = cfg.hooks;
      const total = HOOK_EVENTS.reduce((n, ev) => n + h.hooks[ev].length, 0);
      ui.blank();
      ui.kv("hooks", h.enabled ? c.ok("已启用") : c.dim("未启用"));
      ui.kv("来源", "settings.json 顶层 hooks 段（会话启动时加载，改配置需重启）");
      if (total === 0) {
        ui.info("没有配置任何 hook。");
      } else {
        for (const ev of HOOK_EVENTS) {
          const list = h.hooks[ev];
          if (list.length === 0) continue;
          ui.line(`  ${c.accent(ev)} ${c.dim(`${list.length} 条`)}`);
          for (const hook of list) {
            ui.line(`    ${c.dim("·")} ${hook.command}`);
            ui.line(`      ${c.dim(describeHook(hook))}`);
          }
        }
      }
      if (h.warnings.length > 0) {
        ui.blank();
        ui.warn(`配置告警 ${h.warnings.length} 条（写错的条目已丢弃，不影响启动）：`);
        for (const w of h.warnings) ui.line(`  ${c.dim("·")} ${w}`);
      }
      ui.blank();
      ui.line(
        c.dim(
          "  plan 模式下 hook 一律不执行（只读承诺优先）；子代理的工具调用同样触发 Pre/PostToolUse，" +
            "TurnEnd 只在主代理回合结束触发。Notification 按 reason 过滤（permission_prompt / turn_end），" +
            "在弹审批框之前与轮末触发，恒不阻断。" +
            "SessionStart 在会话开始（new / resume / clear）触发一次，失败只诊断；" +
            "UserPromptSubmit 只对真实用户输入触发（-p 一次 / ACP 每次 prompt / 交互每条输入），exit 2 阻断该输入；" +
            "Stop 在模型正常终止后触发，只有 JSON decision:block + 非空 reason 才续跑，每条用户输入最多一次；" +
            "PreCompact 在任何破坏历史的动作之前触发（matcher 匹配 trigger=manual/auto），exit 2 拒绝本次压缩。" +
            "SubagentStart / SubagentStop 在父会话上下文于子代理真正派出后与结束时触发（matcher 只认 agent_type=task）；" +
            "Start 不可阻断、失败只诊断，本切不向子代理注入 additionalContext；" +
            "Stop 的 reason 为 completed / error / cancelled，不续跑、不做 prevent-stop；" +
            "/tasks chat 续跑不打第二次 Start，该次结束仍打 Stop（这次 Stop 可能没有成对的 Start）。",
        ),
      );
      ui.blank();
      return true;
    }

    case "mcp": {
      // issue #2：一眼看清「接了哪些外部 server、连上没有、各贡献几个工具、错在哪」。
      const states = ctx.mcp?.();
      if (!states) {
        ui.warn("当前进程没有接入 MCP（未配置 mcpServers，或不在主循环里）。");
        ui.info("在 settings.json 顶层加 mcpServers 段后重启 neo；/help 里有示例。");
        return true;
      }
      if (states.length === 0) {
        ui.info("没有配置 MCP server。在 settings.json 顶层加 mcpServers 段（stdio）后重启。");
        return true;
      }
      ui.blank();
      const connected = states.filter((s) => s.status === "connected");
      const tools = connected.reduce((n, s) => n + s.tools.length, 0);
      const rejected = states.reduce((n, s) => n + (s.rejected?.length ?? 0), 0);
      ui.kv(
        "MCP server",
        `${states.length} 个（已连接 ${connected.length}，工具 ${tools} 个` +
          (rejected > 0 ? `，注册失败 ${rejected} 个）` : "）"),
      );
      for (const s of states) {
        const tag =
          s.status === "connected"
            ? c.ok("已连接")
            : s.status === "error"
              ? c.err("失败")
              : s.status === "disabled"
                ? c.dim("已禁用")
                : c.warn("未连接");
        const meta = s.status === "connected" ? `${s.tools.length} 个工具` : "";
        // issue #29：传输类型一眼可见（stdio 本地进程 / http 远程端点）。
        const transport = s.transport ? c.dim(`  [${s.transport}]`) : "";
        ui.line(`  ${c.tool("⚡")} ${c.text(s.name)}${transport}  ${tag}${meta ? c.dim(`  ${meta}`) : ""}`);
        if (s.status === "connected") {
          // 只列**注册成功**的工具：注册失败的既不在模型工具清单里，也不该在这里
          // 显示成可用 —— 否则用户会以为能调，模型却根本看不见。
          for (const t of s.tools) {
            const remote = s.toolEntries?.find((e) => e.name === t)?.remote;
            ui.line(`      ${c.dim(t)}${remote && remote !== t ? c.dim(`  ← ${remote}`) : ""}`);
          }
          for (const r of s.rejected ?? []) {
            ui.line(
              `      ${c.warn("✖")} ${c.warn(r.name)} ${c.dim(`← ${r.remote}`)}  ${c.warn("不可用")}` +
                `  ${c.dim(r.reason)}`,
            );
          }
        } else if (s.error) {
          ui.line(`      ${c.warn(s.error)}`);
        }
      }
      ui.line(c.dim("  MCP 工具名形如 mcp__<server>__<tool>，调用前需审批，plan 模式下不可执行。"));
      if (rejected > 0) {
        ui.line(c.dim("  标 ✖ 的工具注册失败（重名等），模型看不到也调不到；改名或停用冲突的 server 后重启。"));
      }
      ui.blank();
      return true;
    }

    case "env": {
      const refresh = arg === "refresh";
      const loaded = loadEnv({ cfg, persist: memoryMode === "interactive", force: refresh });
      if (!loaded) {
        ui.warn("环境探测已关闭（settings.env.enabled=false 或 NEO_ENV_DISABLE=1）");
        return true;
      }
      ui.blank();
      ui.line(
        formatEnvForCli(loaded.snapshot, {
          snapshotPath: loaded.snapshotPath,
          fromCache: loaded.fromCache,
          probeMs: loaded.probeMs,
          persisted: loaded.persisted,
        }),
      );
      // A2：refresh 时顺带探测当前模型窗口；平时展示 env 里已有的事实。
      if (refresh) {
        const info = await detectAndRecordModelWindow(cfg);
        resolveAndApplyModelWindow(cfg);
        if (info?.contextWindow) {
          ui.info(`已探测 ${cfg.model} 上下文窗口：${info.contextWindow.toLocaleString()} tokens`);
        } else {
          ui.info("未能从 /models 探测到窗口元数据（不影响会话，溢出错误会自动学习）。");
        }
      }
      const windowLines = formatModelWindowLines(cfg);
      if (windowLines.length > 0) {
        ui.line(c.dim("模型能力（env 事实 + settings 手写）："));
        for (const line of windowLines) ui.line(`  ${line}`);
      }
      const gap = formatCapabilityGapHint(cfg);
      if (gap) ui.info(gap);
      if (memoryMode === "interactive" && cfg.env?.wikiPage !== false) {
        try {
          const layout = ensureScopeLayout("user", cfg.cwd, cfg.memory.userWikiDir);
          const r = syncEnvPage(layout, loaded.snapshot);
          ui.info(
            r.action === "unchanged"
              ? `环境页已是最新 ${r.pagePath}`
              : `环境页已${r.action === "created" ? "创建" : "更新"} ${r.pagePath}${r.logged ? "（已记 log）" : ""}`,
          );
        } catch (e) {
          ui.warn(`环境页写入失败：${(e as Error).message}`);
        }
      }
      ui.blank();
      return true;
    }

    case "peers": {
      if (!mailbox) {
        ui.warn("跨会话信箱未启用（-p / 非交互模式不参与协作）");
        return true;
      }
      const out = await makeListPeersTool({ mailbox }).execute(arg ? { target: arg } : {}, {} as ToolCtx);
      ui.line(out);
      return true;
    }

    case "inbox": {
      if (!mailbox) {
        ui.warn("跨会话信箱未启用（-p / 非交互模式不参与协作）");
        return true;
      }
      const [subRaw, ...subRest] = arg.split(/\s+/).filter(Boolean);
      const sub = (subRaw ?? "").toLowerCase();
      if (sub === "release") {
        const id = subRest.join(" ").trim();
        if (!id) {
          ui.warn("用法：/inbox release <消息 id>");
          return true;
        }
        const env = mailbox.release(id);
        if (!env) {
          ui.warn(`未找到 held 消息 ${id}`);
          return true;
        }
        ui.success(`已放行 ${id}`);
        // 放行等价于一次正常投递：补记回执 / last_inbound / 消账，保证回信 exec 与状态机一致
        try {
          mailboxState.recordReceipt(
            mailbox.root,
            mailbox.sessionId,
            { message_id: env.id, from: env.from.session, received_at: new Date().toISOString() },
            cfg.mailbox.receiptMax,
          );
          mailboxState.noteInbound(mailbox.root, mailbox.sessionId, {
            from: env.from.session,
            message_id: env.id,
          });
          mailboxState.resolveDelegation(mailbox.root, mailbox.sessionId, {
            reply_to: env.reply_to ?? null,
            from: env.from.session,
          });
        } catch {
          // 状态记录失败不影响放行
        }
        injectMailbox?.(env);
        return true;
      }
      const held = mailbox.heldIds();
      ui.blank();
      if (held.length === 0) {
        ui.info("没有 held 消息。");
        ui.blank();
        return true;
      }
      ui.kv("held 消息", String(held.length));
      for (const id of held) ui.line(`  ${c.accent(id)} ${c.dim(`（/inbox release ${id}）`)}`);
      ui.blank();
      return true;
    }

    // 目标锚（2026-10-26）：只由人写，模型只读。
    // 无参数 = 查看当前目标；/goal clear = 清除。
    case "goal": {
      if (!mailbox) {
        ui.warn("跨会话信箱未启用（-p / 非交互模式不参与协作）");
        return true;
      }
      const text = arg.trim();
      try {
        if (!text) {
          const g = mailboxState.readGoal(mailbox.root, mailbox.sessionId);
          if (!g) {
            ui.info("本会话尚未设置目标锚。用法：/goal <一句话目标>");
          } else {
            ui.kv("目标", g.text);
            ui.kv("设定", `${g.set_at}（${g.set_by}）`);
          }
          ui.blank();
          return true;
        }
        if (text === "clear") {
          mailboxState.setGoal(mailbox.root, mailbox.sessionId, "");
          ui.success("目标锚已清除。");
          return true;
        }
        const s = mailboxState.setGoal(mailbox.root, mailbox.sessionId, text, { by: "user" });
        ui.success(`目标锚已设置：${s.goal?.text ?? ""}`);
        ui.line(c.dim("每轮请求前会把它连同工具预算一起告诉模型；模型不能改写它。"));
        ui.blank();
      } catch (e) {
        ui.warn(`设置目标失败：${(e as Error).message}`);
      }
      return true;
    }

    // 定时 / 自节奏循环提示（issue #25）：时钟驱动，与 /goal（条件驱动）正交。
    case "loop": {
      if (!loop) {
        ui.warn("循环提示仅在交互会话可用（-p / 非交互模式不支持）。");
        return true;
      }
      const parsed = parseLoopCommand(arg);
      if (parsed.kind === "error") {
        ui.warn(parsed.message);
        return true;
      }
      if (parsed.kind === "stop") {
        loop.stop();
        ui.success("已停止循环。");
        return true;
      }
      if (parsed.kind === "start") {
        if (parsed.warning) ui.warn(parsed.warning);
        loop.start(parsed.spec);
        const modeText =
          parsed.spec.mode === "self" ? "自节奏（上一轮结束后）" : `每 ${formatInterval(parsed.spec.intervalMs)}`;
        ui.success(`已启动循环：${modeText}`);
        for (const line of loop.status()) ui.line(c.dim(`  ${line}`));
        ui.line(c.dim("  /loop 看状态 · /loop stop 停止 · 忙碌时该拍会被丢弃"));
        return true;
      }
      // status
      for (const line of loop.status()) ui.line(line);
      return true;
    }

    // 目标驱动自动续跑（issue #24 / #50）：检查命令 exit 0 = 已验证；--judge 走模型判断。
    case "drive": {
      if (!drive) {
        ui.warn("当前会话不支持自动续跑（未接线；-p 单次模式不可用）。");
        return true;
      }
      const text = arg.trim();
      if (text === "" || text === "status") {
        for (const line of drive.status()) ui.line(line);
        ui.line(
          c.dim(
            "用法：/drive <检查命令> -- <提示> [--max N] · /drive --judge \"<完成标准>\" -- <提示> · /drive stop。" +
              "例：/drive bun test -- 把测试修到全绿（检查命令 exit 0 = 已验证）；" +
              "/drive --judge \"README 可读性已改好\" -- 改 README（模型判断，来源标注为模型判断）",
          ),
        );
        return true;
      }
      if (text === "stop") {
        drive.stop();
        ui.success("已停止自动续跑。");
        return true;
      }
      // 语法：/drive [--max N] [--judge "<标准>"] [<检查命令>] -- <提示>
      // 分隔符允许出现在行首（`-- 提示`，此时完成条件为空 → 走「两者都缺」的用法错误）。
      const sep = text.startsWith("-- ") ? 0 : text.indexOf(" -- ");
      if (sep === -1) {
        ui.warn("缺少 `--` 分隔符。用法：/drive [--max N] [--judge \"<标准>\"] [<检查命令>] -- <提示>");
        return true;
      }
      let left = text.slice(0, sep).trim();
      const right = text.slice(sep + 4).trim();
      // 完成条件在 `--` 之前：空着就是两者都缺。
      if (left === "") {
        ui.warn("缺少完成条件：给检查命令（exit 0 = 已验证）或 --judge \"<标准>\"（模型判断）。");
        return true;
      }
      const maxMatch = /^--max\s+(\d+)\s+(.*)$/.exec(left);
      if (maxMatch) left = (maxMatch[2] ?? "").trim();
      // --judge "<标准>"：可出现在检查命令前后；引号可省（取到行尾），标准里允许空格。
      let criteria = "";
      const judgeQuoted = /--judge\s+"([^"]*)"\s*/.exec(left);
      if (judgeQuoted) {
        criteria = (judgeQuoted[1] ?? "").trim();
        left = `${left.slice(0, judgeQuoted.index)} ${left.slice(judgeQuoted.index + judgeQuoted[0].length)}`.trim();
      } else {
        const judgeBare = /--judge\s+(.+)$/.exec(left);
        if (judgeBare) {
          criteria = (judgeBare[1] ?? "").trim();
          left = left.slice(0, judgeBare.index).trim();
        }
      }
      const check = left.trim();
      if (check === "" && criteria === "") {
        ui.warn("缺少完成条件：给检查命令（exit 0 = 已验证）或 --judge \"<标准>\"（模型判断）。");
        return true;
      }
      const spec: DriveSpec = {
        check,
        ...(criteria !== "" ? { judge: { criteria } } : {}),
        prompt: right,
        maxRounds: maxMatch ? Number(maxMatch[1]) : 5,
      };
      const r = drive.start(spec);
      if (!r.ok) {
        ui.warn(r.error);
        return true;
      }
      const parts: string[] = [];
      if (spec.check !== "") parts.push(`检查命令 \`${spec.check}\`（exit 0 = 已验证）`);
      if (spec.judge) parts.push(`模型判断（标准：${spec.judge.criteria}）`);
      ui.success(`已启动自动续跑：${parts.join(" + ")}，最多 ${spec.maxRounds} 轮`);
      for (const line of drive.status()) ui.line(c.dim(`  ${line}`));
      ui.line(c.dim("  每轮结束先跑检查（有的话），未过再问模型判断；通过/到上限/连续空转/`/drive stop` 时停"));
      return true;
    }

    // 按轮次回滚（issue #27）：/rewind（列表）· /rewind <n|last> [code|conversation|both]
    case "rewind": {
      if (!rewind) {
        ui.warn("当前会话不支持按轮次回滚（未接线）。");
        return true;
      }
      const parts = arg.split(/\s+/).filter((x) => x !== "");
      const sub = parts[0] ?? "";
      if (sub === "" || sub === "list") {
        const turns = rewind.list();
        if (turns.length === 0) {
          ui.info("还没有可回滚的轮次（每个用户轮次会自动记一个检查点，含当轮写过的文件）。");
        } else {
          ui.blank();
          for (const t of turns) {
            const time = t.at.slice(11, 19);
            const prompt = t.prompt.length > 50 ? `${t.prompt.slice(0, 50)}…` : t.prompt;
            const files = t.checkpointSeqs.length > 0 ? ` · ${t.checkpointSeqs.length} 个文件检查点` : "";
            ui.line(`  [${t.index}] ${c.dim(time)}  ${c.text(prompt)}${c.dim(files)}`);
          }
          ui.line(
            c.dim(
              "  /rewind <n|last> [code|conversation|both] 回到该轮之前；默认 both（代码+对话）；" +
                "只覆盖 write_file/edit_file 写过的文件，shell 改的不跟踪",
            ),
          );
        }
        return true;
      }
      const target = sub === "last" ? ("last" as const) : Number(sub);
      if (target !== "last" && (!Number.isInteger(target) || target < 0)) {
        ui.warn(`轮次写法不对："${sub}"（用数字或 last）`);
        return true;
      }
      const modeRaw = parts[1] ?? "both";
      const mode: RewindMode = modeRaw === "code" || modeRaw === "conversation" ? modeRaw : "both";
      if (modeRaw !== mode && modeRaw !== "both") {
        ui.warn(`模式 "${modeRaw}" 不认识，按 both 处理（可选 code / conversation / both）`);
      }
      const r = rewind.apply(target, mode);
      if (r.turnsRemoved === 0) {
        for (const note of r.notes) ui.warn(note);
        return true;
      }
      ui.success(
        `已回滚 ${r.turnsRemoved} 轮（code+conversation=${mode}）：` +
          `对话 -${r.messagesRemoved} 条，文件恢复 ${r.filesRestored} 处` +
          (r.filesSkipped > 0 ? `，跳过 ${r.filesSkipped} 处（快照缺失/过大）` : ""),
      );
      for (const note of r.notes) ui.line(c.dim(`  ${note}`));
      return true;
    }

    // 后台长驻 shell（issue #28）：列表 / 停止。发起权在模型的 shell 工具（background: true）。
    case "ps": {
      if (!shells) {
        ui.warn("当前会话不支持后台 shell（未接线）。");
        return true;
      }
      const sub = arg.split(/\s+/).filter((x) => x !== "")[0] ?? "";
      if (sub === "kill") {
        const target = arg.split(/\s+/).filter((x) => x !== "")[1] ?? "all";
        const n = shells.kill(target);
        if (n > 0) ui.success(`已停止 ${n} 个后台命令。`);
        else ui.info("没有可停止的运行中命令。");
        return true;
      }
      for (const line of formatShellJobs(shells.list())) ui.line(line);
      return true;
    }

    // 旁支提问（issue #61）：基于当前上下文回答一个独立问题，**不入历史、不调工具**。
    case "btw": {
      const question = arg.trim();
      if (!question) {
        ui.warn("用法：/btw <问题>（基于当前上下文回答，不写入对话历史）");
        return true;
      }
      // -p 一次性模式没有「当前会话上下文」可言，也不该在无人值守时发旁支请求。
      if (memoryMode === "oneshot") {
        ui.warn("/btw 仅交互会话可用（-p 单次模式没有可持续的会话上下文）。");
        return true;
      }
      const r = await agent.askSide(question);
      if (!r.ok) {
        ui.warn(`/btw 失败：${r.error}`);
        return true;
      }
      ui.blank();
      ui.line(renderMarkdown(r.answer, Number.isFinite(ui.width) ? ui.width : 100));
      ui.blank();
      return true;
    }

    // 后台子代理任务（issue #16）：列表 / 取消。发起权在模型的 task 工具（background: true）。
    case "tasks": {
      if (!tasks) {
        ui.warn("当前会话不支持后台子代理（未接线）。");
        return true;
      }
      const sub = arg.split(/\s+/).filter((x) => x !== "")[0] ?? "";
      if (sub === "cancel") {
        const target = arg.split(/\s+/).filter((x) => x !== "")[1] ?? "all";
        const n = tasks.cancel(target);
        if (n > 0) ui.success(`已取消 ${n} 个后台任务。`);
        else ui.info("没有可取消的运行中任务。");
        return true;
      }
      // issue #48：/tasks chat <id> <消息> —— 给已完成的任务追加一条消息并继续该子代理。
      if (sub === "chat") {
        const parts = arg.split(/\s+/).filter((x) => x !== "");
        const id = parts[1] ?? "";
        const text = parts.slice(2).join(" ").trim();
        if (!id || !text) {
          ui.warn("用法：/tasks chat <id> <消息>（先 /tasks 看 id）");
          return true;
        }
        if (!tasks.chat) {
          ui.warn("当前会话不支持续聊（未接线）。");
          return true;
        }
        ui.info(`继续子代理 ${id}…`);
        const r = await tasks.chat(id, text);
        if (!r.ok) {
          ui.warn(r.error);
          return true;
        }
        ui.blank();
        ui.line(r.reply);
        ui.blank();
        return true;
      }
      const list = tasks.list();
      if (list.length === 0) {
        ui.info("没有后台任务。模型可用 task（background: true）发起，命令跑完会自动把结果注入会话。");
        return true;
      }
      ui.blank();
      for (const t of list) {
        const status =
          t.status === "running"
            ? c.warn("运行中")
            : t.status === "done"
              ? c.ok("已完成")
              : t.status === "error"
                ? c.err("失败")
                : t.status === "interrupted"
                  ? c.warn("中断")
                  : c.dim("已取消");
        const secs = Math.max(0, Math.round(t.elapsedMs / 1000));
        const prompt = t.prompt.length > 50 ? `${t.prompt.slice(0, 50)}…` : t.prompt;
        // issue #53：后台 wiki 维护在任务表里可见，但用 [wiki] 标出它不是用户发起的子代理。
        const tag = t.kind === "wiki" ? `  ${c.dim("[wiki]")}` : "";
        ui.line(`  ${c.text(t.id)}${tag}  ${status}  ${c.dim(`${secs}s`)}  ${c.dim(prompt)}`);
        if (t.error) ui.line(`      ${c.warn(t.error)}`);
      }
      ui.line(c.dim("  /tasks cancel 取消全部 · /tasks cancel <id> 取消单个 · /tasks chat <id> <消息> 继续该子代理"));
      ui.blank();
      return true;
    }

    // 结构化待办（issue #10）：只读查看。写入只走 todo_write 工具（模型侧整表替换）。
    case "todos": {
      const items = ctx.todos?.() ?? meta.todos ?? [];
      const body = formatTodos(items);
      if (body === "") {
        ui.info("暂无待办。长任务里模型会用 todo_write 建清单。");
        return true;
      }
      for (const l of body.split("\n")) ui.line(l);
      ui.blank();
      return true;
    }

    case "rename": {
      if (!mailbox) {
        ui.warn("跨会话信箱未启用（-p / 非交互模式不参与协作）");
        return true;
      }
      const name = arg.trim();
      if (!name) {
        ui.warn("用法：/rename <name>");
        return true;
      }
      try {
        const p = renameSession(mailbox.root, mailbox.sessionId, name, {
          deadAfterMs: cfg.mailbox.deadAfterMs,
        });
        onNameChange?.(p.name ?? "");
        ui.success(`本会话名字 → ${p.name}`);
      } catch (e) {
        ui.warn(`改名字失败：${(e as Error).message}`);
      }
      return true;
    }

    default:
      return false;
  }
}
