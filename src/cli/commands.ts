/**
 * 斜杠命令实现。
 *
 * 每个 case 仍是一条命令的实现。分发走注册表，新增命令不用再改入口的 switch。
 * 命令名必须同时出现在 input/commands.ts，漂移守卫会对照两边。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Agent, PermissionMode } from "../agent.ts";
import { renderPlan } from "../agent.ts";
import {
  CLASSIFIER_NAMES,
  isClassifierName,
  type Classifier,
} from "../classifier/index.ts";
import type { CheckpointStore } from "../checkpoint.ts";
import {
  describeRoute,
  isImplemented,
  maskKey,
  MODEL_TIERS,
  normalizeTierName,
  switchProvider,
  applyTier,
  tierChoiceLabel,
  tierDisplayName,
  type Config,
} from "../config.ts";
import {
  currentModelCapabilityView,
  detectAndRecordModelWindow,
  formatCapabilityGapHint,
  formatModelWindowLines,
  refreshCapabilitiesAfterModelSwitch,
  resolveAndApplyModelWindow,
} from "../env/modelWindows.ts";
import { loadEnv } from "../env/probe.ts";
import { formatEnvForCli } from "../env/render.ts";
import { syncEnvPage } from "../env/wiki.ts";
import { rulesReport } from "../rules/index.ts";
import { repoMapSummary } from "../prompt/repoMap.ts";
import type { BackgroundView } from "../tools/background.ts";
import type { ShellJobView } from "../tools/backgroundShell.ts";
import type { RewindMode, RewindResult, RewindTurn } from "../rewind.ts";
import type { DriveSpec } from "../drive.ts";
import { formatInterval, parseLoopCommand, type LoopSpec } from "../loop.ts";
import { formatShellJobs } from "../tools/backgroundShell.ts";
import type { ProjectRule, RuleMatch } from "../rules/index.ts";
import { contentText } from "../llm.ts";
import { listModels } from "../llm.ts";
import type { MemoryBridge } from "../memory/bridge.ts";
import type { McpServerState } from "../mcp/client.ts";
import type { PromptSelection } from "../prompt/select.ts";
import type { ToolVisibility } from "../prompt/visibility.ts";
import { ensureScopeLayout } from "../memory/layout.ts";
import { initProjectLevel as initProjectLevelImpl } from "../memory/init.ts";
import { sessionLiveness, renameSession, takenAliveNames } from "../mailbox/identity.ts";
import { readProfile } from "../mailbox/identity.ts";
import * as mailboxState from "../mailbox/state.ts";
import { mailboxRoot, type Envelope } from "../mailbox/types.ts";
import type { Mailbox } from "../mailbox/store.ts";
import { chooseSessionName } from "../sessionName.ts";
import { HOOK_EVENTS } from "../hooks/index.ts";
import {
  buildReviewPrompt,
  collectReviewDiff,
  REVIEW_DIFF_LIMIT,
  summarizePatch,
} from "../review.ts";
import {
  detectRepo,
  listManaged,
  removeWorktree,
  WORKTREE_BRANCH_PREFIX,
  worktreeBranch,
  worktreeRoot,
} from "../worktree.ts";
import {
  applyRestored,
  listSessions,
  loadSession,
  type SessionMeta,
} from "../session.ts";
import { renderSessionMarkdown } from "../sessionExport.ts";
import {
  buildSkillSlashPrompt,
  describeSource,
  discoverSkills,
  formatSkillLine,
  isValidSkillName,
  normalizeDescription,
  tryLoadSkillForSlash,
} from "../skills.ts";
import { makeListPeersTool } from "../tools/mailbox.ts";
import { runSubagent } from "../tools/task.ts";
import { mainToolNames, toolNames } from "../tools/index.ts";
import { formatTodos, type TodoItem } from "../tools/todo.ts";
import type { ToolCtx } from "../tools/types.ts";
import { select, type SelectDeps } from "../ui/select.ts";
import type { Console } from "../ui/console.ts";
import { formatToolCall } from "../ui/toolLog.ts";
import { c, truncate } from "../ui/theme.ts";
import { buildMemoryFile } from "../system-prompt.ts";
import {
  buildIngestPrompt,
  finishIngest,
  loadIngestTemplate,
  planIngest,
} from "../wiki/ingest.ts";
import { formatLintReport, lintWiki, resolveWikiDir } from "../wiki/lint.ts";
import { resolveWikiLayout } from "../wiki/paths.ts";
import { appendLog } from "../wiki/write.ts";
import { commandHandler, registerCommand } from "./command-registry.ts";
import { helpText } from "./help.ts";
import { printSessions, replayTranscript } from "./sessions.ts";

/** /auto 列表里各实现的说明。 */
const DESC: Record<string, string> = {
  off: "关闭自动分类，始终用手动选的档位",
  rule: "规则分类器，零延迟零成本（默认）",
  llm: "用 classifier_model_name 判定，多一次调用",
};

export interface CommandContext {
  agent: Agent;
  ui: Console;
  cfg: Config;
  memory: MemoryBridge;
  classifier: Classifier;
  meta: SessionMeta;
  shutdown: () => void | Promise<void>;
  selectDeps: SelectDeps;
  mailbox: Mailbox | null;
  checkpoints: CheckpointStore | null;
  injectMailbox?: (env: Envelope) => void;
  onMailboxRekey?: () => void;
  onNameChange?: (name: string) => void;
  /**
   * 当前 cfg 下的系统提示词选档诊断（issue #20）；/context 展示用，取不到时为 null。
   *
   * 实现方只算不写：不得改写 messages[0]（提示词何时生效由请求边界决定）。
   */
  promptSelection?: () => PromptSelection | null;
  /**
   * 小窗口下的工具可见集方案（issue #20 收尾，**dry-run**：只算不生效）。
   *
   * /context 展示「按当前预算最多能暴露几个工具」；运行时暴露的工具集不变。
   */
  toolVisibility?: () => ToolVisibility | null;
  /**
   * 路径作用域规则（issue #17）：每会话条数、本轮已加载 scoped 条数与命中原因。
   * 不传 = 不展示（子代理/测试场景）。
   */
  rules?: () => { alwaysOn: ProjectRule[]; loaded: RuleMatch[]; total: number };
  /** 目标驱动自动续跑（issue #24）：/drive 列表 / 启动 / 停止。不传 = 不支持。 */
  drive?: {
    start: (spec: DriveSpec) => { ok: true } | { ok: false; error: string };
    stop: () => void;
    status: () => string[];
  };
  /** 按轮次回滚（issue #27）：列出轮次 / 回滚到某轮之前。不传 = 不支持。 */
  rewind?: {
    list: () => RewindTurn[];
    apply: (target: number | "last", mode: RewindMode) => RewindResult;
    /**
     * 用户轮次 → 该轮起点的消息下标（issue #46 定点 compact 用）。
     * 返回 null = 轮次不存在。
     */
    turnStart?: (target: number | "last") => number | null;
  };
  /** 后台长驻 shell（issue #28）：列表 / 停止。不传 = 不支持（/ps 会明说）。 */
  shells?: {
    list: () => ShellJobView[];
    kill: (target: string) => number;
  };
  /** 后台子代理任务（issue #16）：列表 / 取消。不传 = 不支持（/tasks 会明说）。 */
  tasks?: {
    list: () => BackgroundView[];
    cancel: (target: string) => number;
    /**
     * 续聊（issue #48）：给指定任务追加一条用户消息并继续该子代理。
     * 不传 = 不支持续聊（`/tasks chat` 会明说）。
     */
    chat?: (id: string, text: string) => Promise<{ ok: true; reply: string } | { ok: false; error: string }>;
  };
  /**
   * 定时 / 自节奏循环提示（issue #25）。仅交互会话注入；`-p` 下为 undefined，
   * `/loop` 会直接提示「不可用」而不启动任何定时器。
   */
  loop?: {
    start: (spec: LoopSpec) => void;
    stop: () => void;
    status: () => string[];
  };
  memoryMode?: "interactive" | "oneshot";
  /**
   * 把合成的用户消息排进主循环队列，作为下一轮发给模型（issue #13）。
   *
   * `/技能名` 命中后走这里而不是直接 agent.send：drain 正在跑，直接 send 会重入
   * 并打乱 draining 状态机。入队后 dispatchCommand 正常返回，drain 的 while
   * 会在下一轮取出该消息（文本不以 `/` 开头，自然走 agent.send 路径）。
   */
  enqueueUserTurn?: (text: string) => void;
  /**
   * 读本会话的结构化待办（issue #10）。组合根持有内存态（resume 后来自 meta.todos），
   * 优先于 meta.todos 读 —— 工具刚写完还没落盘时 meta 是旧的。
   */
  todos?: () => TodoItem[];
  /**
   * MCP server 状态快照（issue #2）。`/mcp` 用它列出 server / 连接状态 / 工具数 / 错误。
   * 不传 = 本进程没有接 MCP（单测裸 ctx），`/mcp` 会明确说明而不是显示空表。
   */
  mcp?: () => McpServerState[];
}

export async function handleCommand(line: string, ctx: CommandContext): Promise<void> {
  const {
    agent, ui, cfg, memory, classifier, meta, shutdown, selectDeps, mailbox, checkpoints,
    injectMailbox, onMailboxRekey, onNameChange, promptSelection, toolVisibility, rules, loop, tasks, shells, rewind, drive,
  } = ctx;
  const memoryMode = ctx.memoryMode ?? "interactive";
  const [cmdRaw, ...rest] = line.slice(1).split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
    case "?":
      ui.line(helpText());
      break;

    case "clear":
      agent.reset();
      ui.success("上下文已清空。");
      break;

    case "compact": {
      // issue #46：`/compact --from <轮次>` 定点压缩 —— 以用户轮次为锚点，只压该轮往后那段。
      const fromArg = /^--from\s+(\S+)\s*$/.exec(arg.trim());
      if (arg.trim() !== "" && !fromArg) {
        ui.warn("用法：/compact（整体压缩）· /compact --from <轮次|last>（只压该轮往后）");
        break;
      }
      if (fromArg) {
        const raw = fromArg[1]!;
        const target = raw === "last" ? ("last" as const) : Number(raw);
        if (target !== "last" && (!Number.isInteger(target) || target < 0)) {
          ui.warn(`轮次写法不对："${raw}"（用数字或 last）`);
          break;
        }
        if (!rewind?.turnStart) {
          ui.warn("当前会话不支持定点压缩（未接线轮次表）。");
          break;
        }
        const from = rewind.turnStart(target);
        if (from === null) {
          ui.warn(`用户轮次 ${raw} 不存在（先用 /rewind 看可用范围）。`);
          break;
        }
        ui.line(`定点压缩：从第 ${raw} 轮往后…`);
        const ok = await agent.compact({ from });
        if (ok) ui.success(`压缩完成。上下文使用率 ${(agent.contextUsage() * 100).toFixed(1)}%`);
        else ui.warn("该轮之后的消息太少或压缩失败，未做处理。");
        break;
      }
      ui.line("压缩上下文中…");
      const ok = await agent.compact();
      if (ok) ui.success(`压缩完成。上下文使用率 ${(agent.contextUsage() * 100).toFixed(1)}%`);
      else ui.warn("对话太短或压缩失败，未做处理。");
      break;
    }

    case "undo": {
      const n = Math.max(1, Number(arg) || 1);
      if (!checkpoints) {
        ui.warn("当前没有启用写文件检查点。");
        break;
      }
      const results = checkpoints.undo(n);
      if (results.length === 0) {
        ui.info("没有可撤销的写操作。");
        break;
      }
      for (const r of results) {
        if (r.restored === "content") {
          ui.line(`${c.accent("↩")} 已还原 ${r.entry.rel}（${r.entry.op}）`);
        } else if (r.restored === "deleted") {
          ui.line(`${c.accent("↩")} 已删除 ${r.entry.rel}（恢复为写前不存在）`);
        } else {
          ui.warn(`未能恢复 ${r.entry.rel}：${r.reason ?? "未知原因"}`);
        }
      }
      break;
    }

    case "checkpoints": {
      if (!checkpoints) {
        ui.warn("当前没有启用写文件检查点。");
        break;
      }
      const n = Math.max(1, Number(arg) || 10);
      const list = checkpoints.list(n);
      if (list.length === 0) {
        ui.info("还没有写文件检查点。");
        break;
      }
      ui.line(c.dim(`最近 ${list.length} 条写文件检查点（${checkpoints.dir}）：`));
      for (const e of list.slice().reverse()) {
        const meta = `${e.op} · ${e.existed ? `${e.size}B` : "新建"} · ${e.at}`;
        ui.line(`  #${e.seq} ${e.rel}  ${c.dim(meta)}${e.note ? `  ${c.warn(e.note)}` : ""}`);
      }
      break;
    }

    case "context": {
      // A2：一眼看清「配置窗口 vs 估算用量 vs 最近压缩」，用于排查长会话/窗口配错。
      const resolved = resolveAndApplyModelWindow(cfg);
      const usage = agent.contextUsage();
      const est = Math.round(usage * cfg.contextWindow);
      const last = agent.lastCompactionInfo;
      ui.blank();
      ui.kv("model", `${cfg.providerName}/${cfg.model}`);
      ui.kv(
        "window",
        `${cfg.contextWindow.toLocaleString()} tokens ${c.dim(`(${cfg.contextWindowSource ?? resolved.source})`)}`,
      );
      // P2：当前模型的五项能力（context / max_output / vision / tools / reasoning）。
      // 未填与 unknown 一律「未知」；手写 settings 优先，env 探测补空缺。
      const caps = currentModelCapabilityView(cfg);
      ui.kv("context", caps.contextWindow);
      // 请求预算 ≠ 能力上限。两行都打出来，避免把 max_tokens 当成模型硬顶。
      ui.kv("max_tokens", `${cfg.maxTokens.toLocaleString()} ${c.dim("(请求预算)")}`);
      ui.kv("max_output_tokens", `${caps.maxOutputTokens} ${c.dim("(能力上限)")}`);
      ui.kv("vision", caps.vision);
      ui.kv("tools", caps.tools);
      ui.kv("reasoning", caps.reasoning);
      const gap = formatCapabilityGapHint(cfg);
      if (gap) ui.info(gap);
      // issue #20：系统提示词选了哪一档、为什么。只展示数字与原因，不打印提示词或记忆原文。
      // 取档要读目录树/技能/wiki 索引，可能抛错（cwd 权限、技能目录竞态）：
      // 失败就省略这一行，不让整条命令崩 —— 诊断是增强项，不是命令的依赖项。
      let psel: PromptSelection | null = null;
      try {
        psel = promptSelection?.() ?? null;
      } catch {
        psel = null;
      }
      if (psel) {
        ui.kv(
          "prompt",
          `${psel.tier} ${c.dim(`(${psel.fits ? "预算内" : "超预算"} · ${psel.estimatedSystemTokens ?? "?"}/${psel.budget} tokens 估计)`)}`,
        );
        ui.line(c.dim(`  ${psel.reason}`));
      }
      // issue #20 收尾：小窗口下的工具可见集方案（**dry-run：只算不生效**）。
      // 算档要读目录树/技能/wiki 索引并按候选集反复计数，可能抛错 —— 失败就省略这两行。
      let vis: ToolVisibility | null = null;
      try {
        vis = toolVisibility?.() ?? null;
      } catch {
        vis = null;
      }
      if (vis) {
        ui.kv(
          "可见工具",
          vis.fits
            ? `${vis.names.length}/${vis.total} 个 ${c.dim(`(预算内 · ${vis.cost}/${vis.budget} tokens 估计，dry-run 未启用)`)}`
            : `预算内放不下 ${c.dim("(dry-run 未启用)")}`,
        );
        ui.line(
          c.dim(
            vis.fits
              ? `  按当前预算最多可暴露 ${vis.names.length} 个工具${vis.trimmed ? "（需同时裁技能/wiki/目录树索引）" : ""}；` +
                  `收窄尚未启用，当前仍暴露全部 ${vis.total} 个。`
              : `  当前预算连 0 个工具都容不下；收窄尚未启用，当前仍暴露全部 ${vis.total} 个工具。`,
          ),
        );
      }
      // issue #15：仓库地图状态（命中缓存，不重复扫描）。
      try {
        ui.kv("repo map", repoMapSummary(cfg));
      } catch {
        /* 诊断是增强项 */
      }
      // issue #17：路径作用域规则 —— 每会话几条、本轮命中了哪几条、为什么。
      // 规则发现/匹配都可能抛错（cwd 权限、并发删除），失败就省略，不让 /context 崩。
      if (rules) {
        try {
          const r = rules();
          const report = rulesReport(r.alwaysOn, r.loaded, r.total);
          ui.kv("规则", report[0] ?? "");
          for (const line of report.slice(1)) ui.line(c.dim(line));
        } catch {
          /* 诊断是增强项 */
        }
      }
      ui.kv("threshold", `${(cfg.compactThreshold * 100).toFixed(0)}% · ${Math.round(
        cfg.compactThreshold * cfg.contextWindow,
      ).toLocaleString()} tokens`);
      ui.kv("estimate", `${est.toLocaleString()} tokens ${c.dim(`(${(usage * 100).toFixed(1)}%)`)}`);
      ui.kv("messages", String(agent.messages.length));
      if (last) {
        ui.kv(
          "last compact",
          `${last.beforeTokens.toLocaleString()} → ${last.afterTokens.toLocaleString()} tokens`,
        );
      } else {
        ui.kv("last compact", c.dim("无"));
      }
      ui.line(c.dim("  window 来源：config=settings；models_api=网关元数据；overflow_error=服务端错误校正"));
      ui.blank();
      break;
    }

    case "cost": {
      const cum = agent.cumulative;
      ui.blank();
      ui.kv("provider", `${c.accent(cfg.providerName)} ${c.dim(`(${cfg.providerType})`)}`);
      ui.kv("tier", c.muted(tierDisplayName(cfg.modelTier)));
      ui.kv("model", c.accent(cfg.model));
      ui.kv("endpoint", c.muted(cfg.baseUrl));
      ui.kv("api key", c.muted(maskKey(cfg.apiKey)));
      ui.kv("max_tokens", `${cfg.maxTokens.toLocaleString()} ${c.dim("(请求预算)")}`);
      ui.kv("temperature", String(cfg.temperature));
      ui.kv("prompt", `${cum.prompt} tokens`);
      ui.kv("completion", `${cum.completion} tokens`);
      ui.kv("thinking", `${cum.reasoning} tokens`);
      ui.kv("context", `${(agent.contextUsage() * 100).toFixed(1)}% of ${cfg.contextWindow}`);
      ui.kv("messages", String(agent.messages.length));
      ui.blank();
      break;
    }

    case "provider": {
      const p = cfg.providers.find((x) => x.name === cfg.providerName);
      if (!arg) {
        ui.blank();
        ui.kv("当前", `${c.accent(cfg.providerName)} ${c.dim(`(${cfg.providerType})`)}`);
        ui.blank();
        // TTY：选择器接入（与 /model 同款）。含全部 provider——未接入的标注在 hint，
        // 选中后由 switchProvider 给出与显式 /provider <name> 相同的错误，不另设禁用态
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const options = cfg.providers.map((x) => ({
            label: x.name,
            hint:
              x.name === cfg.providerName
                ? `当前 · ${x.type}`
                : isImplemented(x.type)
                  ? x.type
                  : `${x.type} · 未接入`,
            value: x.name,
          }));
          const picked = await select("切换到哪个 provider？", options, {
            ...selectDeps,
            initial: Math.max(0, cfg.providers.findIndex((x) => x.name === cfg.providerName)),
          });
          if (!picked) {
            ui.info("已取消。");
            break;
          }
          const r = switchProvider(cfg, picked);
          if (!r.ok) {
            ui.warn(r.error);
            break;
          }
          agent.noteModelChange(cfg);
          refreshCapabilitiesAfterModelSwitch(cfg);
          ui.success(`provider → ${cfg.providerName}（${cfg.providerType}）`);
          ui.kv("model", `${cfg.model} ${c.dim(`[${tierDisplayName(cfg.modelTier)}]`)}`);
          ui.kv("endpoint", cfg.baseUrl);
          break;
        }
        // 非 TTY：维持纯列表（C8）
        for (const x of cfg.providers) {
          const on = x.name === cfg.providerName;
          const usable = isImplemented(x.type);
          const tag = usable ? "" : c.warn(" [未接入]");
          ui.line(
            `${on ? c.accent("●") : c.dim("○")} ${on ? c.bright(x.name) : c.muted(x.name)} ` +
              `${c.dim((x.apiTypes ?? [x.type]).join("+"))} ${c.dim("→")} ${c.muted(x.baseUrl)}${tag}`,
          );
          if (on) {
            for (const tier of MODEL_TIERS) {
              const mark = tier === cfg.modelTier ? c.accent("▸") : " ";
              ui.line(`    ${mark} ${c.dim(tier.padEnd(15))} ${c.muted(x.models[tier])}`);
            }
          }
        }
        ui.line(c.dim("  用 /provider <name> 切换"));
        ui.blank();
        break;
      }
      const r = switchProvider(cfg, arg);
      if (!r.ok) {
        ui.warn(r.error);
        break;
      }
      agent.noteModelChange(cfg);
      refreshCapabilitiesAfterModelSwitch(cfg);
      ui.success(`provider → ${cfg.providerName}（${cfg.providerType}）`);
      ui.kv("model", `${cfg.model} ${c.dim(`[${tierDisplayName(cfg.modelTier)}]`)}`);
      ui.kv("endpoint", cfg.baseUrl);
      break;
    }

    case "tier":
    // 档位快捷方式。存在的理由：规则分类器的 override 规则（/deep、/fast…）
    // 匹配的是用户输入，若没有对应分支，输入会在到达分类器之前
    // 就被 handleCommand 当成未知命令吃掉 —— 规则永远等不到它的输入。
    case "fast":
    case "balanced":
    case "deep":
    case "deep_reasoning":
    case "default": {
      // /deep 等价于 /tier deep_reasoning；带参数时（如 `/deep 分析这段代码`）
      // 前半段是档位指令，其余作为普通输入继续走 agent。
      // /tier 的档位名来自**参数**（rest[0]），不是命令名 —— 旧代码永远取 cmd，
      // 导致 `/tier default` 被解析成档位 "tier"，任何参数都报「未知档位」。
      // 快捷命令（/fast /balanced /deep…）没有参数概念，档位名就是命令名本身。
      const rawTarget = cmd === "tier" ? (rest[0] ?? "") : cmd;
      // 人类输入接受简写（deep/bal/fast/auto），内部仍落到规范 ModelTier。
      const target = normalizeTierName(rawTarget);
      // /tier 不带参数时是查询操作：列出全部档位的生效路由。
      // 用 target === "" 判断而非 rest.length === 0："/tier "（尾随空格）
      // split 后 rest = [""]，length 为 1，但语义上仍是查询。
      if (cmd === "tier" && rawTarget === "") {
        ui.blank();
        ui.kv("当前档位", c.accent(tierChoiceLabel(cfg.modelTier)));
        ui.kv("生效路由", `${c.accent(describeRoute(cfg, cfg.modelTier))}`);
        ui.blank();
        // TTY：选择器接入（与 /model 同款）；hint = 该档位生效路由，initial 定位当前档位
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const options = MODEL_TIERS.map((t) => ({
            label: tierDisplayName(t),
            hint: t === cfg.modelTier ? `当前 · ${describeRoute(cfg, t)}` : describeRoute(cfg, t),
            value: t,
          }));
          const picked = await select("切换到哪个档位？", options, {
            ...selectDeps,
            initial: Math.max(0, MODEL_TIERS.indexOf(cfg.modelTier)),
          });
          if (picked) {
            const r = applyTier(cfg, picked);
            if (r.ok) {
              agent.noteModelChange(cfg);
              refreshCapabilitiesAfterModelSwitch(cfg);
              if (r.degraded && r.note) ui.warn(r.note);
              ui.success(
                `档位 → ${tierChoiceLabel(cfg.modelTier)}（${cfg.providerName} / ${cfg.model}）`,
              );
            } else {
              ui.warn(r.error);
            }
          } else {
            ui.info("已取消。");
          }
          break;
        }
        // 非 TTY：维持纯列表（C8）
        for (const tier of MODEL_TIERS) {
          const on = tier === cfg.modelTier;
          const label = tierChoiceLabel(tier);
          ui.line(
            `${on ? c.accent("●") : c.dim("○")} ${on ? c.bright(label.padEnd(20)) : c.muted(label.padEnd(20))} ` +
              `${c.dim("→")} ${c.muted(describeRoute(cfg, tier))}`,
          );
        }
        ui.line(c.dim("  用 /tier <name> 切换"));
        ui.blank();
        break;
      }
      if (!target) {
        ui.warn(
          `未知档位 "${rawTarget}"。可选：${MODEL_TIERS.join(", ")}` +
            `（简写 deep / d / bal / b / f / auto）`,
        );
        break;
      }
      const r = applyTier(cfg, target);
      if (!r.ok) {
        ui.warn(r.error);
        break;
      }
      agent.noteModelChange(cfg);
      refreshCapabilitiesAfterModelSwitch(cfg);
      if (r.degraded && r.note) ui.warn(r.note);
      ui.success(
        `档位 → ${tierChoiceLabel(cfg.modelTier)}（${cfg.providerName} / ${cfg.model}）`,
      );
      // 剩余文本当作下一轮用户输入，不丢内容。
      // /tier 的 rest[0] 是档位名，已消费掉；快捷命令的 rest 全是剩余文本。
      const leftover = cmd === "tier" ? rest.slice(1) : rest;
      if (leftover.length > 0) await agent.send(leftover.join(" "));
      break;
    }

    case "auto": {
      if (!arg) {
        ui.blank();
        ui.kv("自动分类", `${c.accent(classifier.name)}`);
        ui.kv("分类器模型", `${c.muted(cfg.classifierProvider)} / ${c.muted(cfg.classifierModel)}`);
        ui.kv("连续工具失败", String(agent.toolFailureStreak));
        ui.blank();
        for (const n of CLASSIFIER_NAMES) {
          ui.line(
            `${n === classifier.name ? c.accent("●") : c.dim("○")} ` +
              `${n === classifier.name ? c.bright(n) : c.muted(n)} ${c.dim(DESC[n] ?? "")}`,
          );
        }
        ui.line(c.dim("  用 /auto <off|rule|llm> 切换"));
        ui.blank();
        break;
      }
      if (!isClassifierName(arg)) {
        ui.warn(`未知分类器 "${arg}"。可选：${CLASSIFIER_NAMES.join(", ")}`);
        break;
      }
      try {
        classifier.use(arg, cfg);
        ui.success(`自动分类 → ${arg}`);
      } catch (e) {
        ui.warn((e as Error).message);
      }
      break;
    }

    case "why": {
      ui.blank();
      ui.kv("分类器", c.accent(classifier.name));
      const last = classifier.lastResult;
      if (!last) {
        ui.info("还没有产生过判定。发一条消息后用 /why 查看。");
      } else {
        ui.kv("判定档位", c.accent(last.tier));
        ui.kv("来源", c.muted(last.source));
        ui.kv("理由", c.text(last.reason));
      }
      const fail = classifier.lastFailure;
      if (fail) ui.kv("上次失败", c.err(fail));
      ui.kv("当前生效", `${cfg.modelTier} → ${cfg.providerName} / ${cfg.model}`);
      ui.blank();
      break;
    }

    case "model": {
      if (!arg) {
        ui.blank();
        ui.kv("当前模型", `${c.accent(cfg.model)} ${c.dim(`(${cfg.modelTier})`)}`);
        // D8：先取列表——失败维持现有错误输出，不进选择器
        let models: string[] | null = null;
        try {
          models = await listModels(cfg);
        } catch (e) {
          ui.error(`获取模型列表失败: ${(e as Error).message}`);
        }
        if (models && models.length > 0 && process.stdin.isTTY) {
          // TTY：可选。当前模型 hint「当前」+ initial 定位（D8）
          ui.stopSpinner(); // C1：进入前收尾 spinner
          ui.blank();
          const options = models.map((m) => ({
            label: m,
            hint: m === cfg.model ? "当前" : undefined,
            value: m,
          }));
          const picked = await select("切换到哪个模型？", options, {
            ...selectDeps,
            initial: Math.max(0, models.indexOf(cfg.model)),
          });
          if (picked) {
            // 与显式 /model <id> 同一收尾（F2 缺口补齐）
            cfg.model = picked;
            agent.noteModelChange(cfg);
            refreshCapabilitiesAfterModelSwitch(cfg);
            ui.success(`模型已切到 ${picked}（本次会话内生效，已绕过档位）。`);
          } else {
            ui.info("已取消。");
          }
        } else if (models) {
          // 非 TTY / 空列表：维持现有纯列表展示（C8）
          ui.line(c.dim("  用 /model <id> 直接指定模型，或 /tier <档位> 切换档位"));
          ui.line(c.dim("  服务端可用模型："));
          for (const m of models) {
            ui.line(m === cfg.model ? `  ${c.accent("●")} ${c.bright(m)}` : `  ${c.dim("○")} ${c.muted(m)}`);
          }
        }
        ui.blank();
        break;
      }
      cfg.model = arg;
      agent.noteModelChange(cfg);
      refreshCapabilitiesAfterModelSwitch(cfg);
      ui.success(`模型已切到 ${arg}（本次会话内生效，已绕过档位）。`);
      break;
    }

    case "tools": {
      // 规划态控制工具只在规划态可见（issue #14），平时不列出来 ——
      // 否则用户会以为现在就能调 submit_plan。
      const names = agent.planning ? toolNames() : mainToolNames();
      ui.blank();
      ui.kv("可用工具", String(names.length));
      for (const t of names) ui.line(`  ${c.tool("⚡")} ${c.text(t)}`);
      if (agent.planning) {
        ui.line(c.dim("  当前在规划态：只读工具 + submit_plan / exit_plan_mode"));
      } else {
        ui.line(c.dim("  规划态（/plan）会额外出现 submit_plan / exit_plan_mode"));
      }
      ui.blank();
      break;
    }

    case "hooks": {
      // issue #3：一眼看清「配了哪些生命周期 hook、哪条写错了被丢弃」。
      // hooks 不是权限系统 —— 这里刻意不展示任何「放行/拒绝」策略，
      // 免得用户误以为它是 #4 那种 allow/deny 规则表。
      const h = cfg.hooks;
      const total = h.hooks.PreToolUse.length + h.hooks.PostToolUse.length + h.hooks.TurnEnd.length;
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
            ui.line(
              `      ${c.dim(
                `matcher=${hook.matcher ?? "*"} · timeout=${hook.timeout}s` +
                  (ev === "PreToolUse" ? "" : ` · onFailure=${hook.onFailure}`),
              )}`,
            );
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
            "TurnEnd 只在主代理回合结束触发。",
        ),
      );
      ui.blank();
      break;
    }

    case "mcp": {
      // issue #2：一眼看清「接了哪些外部 server、连上没有、各贡献几个工具、错在哪」。
      const states = ctx.mcp?.();
      if (!states) {
        ui.warn("当前进程没有接入 MCP（未配置 mcpServers，或不在主循环里）。");
        ui.info("在 settings.json 顶层加 mcpServers 段后重启 neo；/help 里有示例。");
        break;
      }
      if (states.length === 0) {
        ui.info("没有配置 MCP server。在 settings.json 顶层加 mcpServers 段（stdio）后重启。");
        break;
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
      break;
    }

    case "env": {
      const refresh = arg === "refresh";
      const loaded = loadEnv({ cfg, persist: memoryMode === "interactive", force: refresh });
      if (!loaded) {
        ui.warn("环境探测已关闭（settings.env.enabled=false 或 NEO_ENV_DISABLE=1）");
        break;
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
      break;
    }

    case "peers": {
      if (!mailbox) {
        ui.warn("跨会话信箱未启用（-p / 非交互模式不参与协作）");
        break;
      }
      const out = await makeListPeersTool({ mailbox }).execute(arg ? { target: arg } : {}, {} as ToolCtx);
      ui.line(out);
      break;
    }

    case "inbox": {
      if (!mailbox) {
        ui.warn("跨会话信箱未启用（-p / 非交互模式不参与协作）");
        break;
      }
      const [subRaw, ...subRest] = arg.split(/\s+/).filter(Boolean);
      const sub = (subRaw ?? "").toLowerCase();
      if (sub === "release") {
        const id = subRest.join(" ").trim();
        if (!id) {
          ui.warn("用法：/inbox release <消息 id>");
          break;
        }
        const env = mailbox.release(id);
        if (!env) {
          ui.warn(`未找到 held 消息 ${id}`);
          break;
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
        break;
      }
      const held = mailbox.heldIds();
      ui.blank();
      if (held.length === 0) {
        ui.info("没有 held 消息。");
        ui.blank();
        break;
      }
      ui.kv("held 消息", String(held.length));
      for (const id of held) ui.line(`  ${c.accent(id)} ${c.dim(`（/inbox release ${id}）`)}`);
      ui.blank();
      break;
    }

    // 目标锚（2026-10-26）：只由人写，模型只读。
    // 无参数 = 查看当前目标；/goal clear = 清除。
    case "goal": {
      if (!mailbox) {
        ui.warn("跨会话信箱未启用（-p / 非交互模式不参与协作）");
        break;
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
          break;
        }
        if (text === "clear") {
          mailboxState.setGoal(mailbox.root, mailbox.sessionId, "");
          ui.success("目标锚已清除。");
          break;
        }
        const s = mailboxState.setGoal(mailbox.root, mailbox.sessionId, text, { by: "user" });
        ui.success(`目标锚已设置：${s.goal?.text ?? ""}`);
        ui.line(c.dim("每轮请求前会把它连同工具预算一起告诉模型；模型不能改写它。"));
        ui.blank();
      } catch (e) {
        ui.warn(`设置目标失败：${(e as Error).message}`);
      }
      break;
    }

    // 定时 / 自节奏循环提示（issue #25）：时钟驱动，与 /goal（条件驱动）正交。
    case "loop": {
      if (!loop) {
        ui.warn("循环提示仅在交互会话可用（-p / 非交互模式不支持）。");
        break;
      }
      const parsed = parseLoopCommand(arg);
      if (parsed.kind === "error") {
        ui.warn(parsed.message);
        break;
      }
      if (parsed.kind === "stop") {
        loop.stop();
        ui.success("已停止循环。");
        break;
      }
      if (parsed.kind === "start") {
        if (parsed.warning) ui.warn(parsed.warning);
        loop.start(parsed.spec);
        const modeText =
          parsed.spec.mode === "self" ? "自节奏（上一轮结束后）" : `每 ${formatInterval(parsed.spec.intervalMs)}`;
        ui.success(`已启动循环：${modeText}`);
        for (const line of loop.status()) ui.line(c.dim(`  ${line}`));
        ui.line(c.dim("  /loop 看状态 · /loop stop 停止 · 忙碌时该拍会被丢弃"));
        break;
      }
      // status
      for (const line of loop.status()) ui.line(line);
      break;
    }

    // 目标驱动自动续跑（issue #24 / #50）：检查命令 exit 0 = 已验证；--judge 走模型判断。
    case "drive": {
      if (!drive) {
        ui.warn("当前会话不支持自动续跑（未接线；-p 单次模式不可用）。");
        break;
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
        break;
      }
      if (text === "stop") {
        drive.stop();
        ui.success("已停止自动续跑。");
        break;
      }
      // 语法：/drive [--max N] [--judge "<标准>"] [<检查命令>] -- <提示>
      // 分隔符允许出现在行首（`-- 提示`，此时完成条件为空 → 走「两者都缺」的用法错误）。
      const sep = text.startsWith("-- ") ? 0 : text.indexOf(" -- ");
      if (sep === -1) {
        ui.warn("缺少 `--` 分隔符。用法：/drive [--max N] [--judge \"<标准>\"] [<检查命令>] -- <提示>");
        break;
      }
      let left = text.slice(0, sep).trim();
      const right = text.slice(sep + 4).trim();
      // 完成条件在 `--` 之前：空着就是两者都缺。
      if (left === "") {
        ui.warn("缺少完成条件：给检查命令（exit 0 = 已验证）或 --judge \"<标准>\"（模型判断）。");
        break;
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
        break;
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
        break;
      }
      const parts: string[] = [];
      if (spec.check !== "") parts.push(`检查命令 \`${spec.check}\`（exit 0 = 已验证）`);
      if (spec.judge) parts.push(`模型判断（标准：${spec.judge.criteria}）`);
      ui.success(`已启动自动续跑：${parts.join(" + ")}，最多 ${spec.maxRounds} 轮`);
      for (const line of drive.status()) ui.line(c.dim(`  ${line}`));
      ui.line(c.dim("  每轮结束先跑检查（有的话），未过再问模型判断；通过/到上限/连续空转/`/drive stop` 时停"));
      break;
    }

    // 按轮次回滚（issue #27）：/rewind（列表）· /rewind <n|last> [code|conversation|both]
    case "rewind": {
      if (!rewind) {
        ui.warn("当前会话不支持按轮次回滚（未接线）。");
        break;
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
        break;
      }
      const target = sub === "last" ? ("last" as const) : Number(sub);
      if (target !== "last" && (!Number.isInteger(target) || target < 0)) {
        ui.warn(`轮次写法不对："${sub}"（用数字或 last）`);
        break;
      }
      const modeRaw = parts[1] ?? "both";
      const mode: RewindMode = modeRaw === "code" || modeRaw === "conversation" ? modeRaw : "both";
      if (modeRaw !== mode && modeRaw !== "both") {
        ui.warn(`模式 "${modeRaw}" 不认识，按 both 处理（可选 code / conversation / both）`);
      }
      const r = rewind.apply(target, mode);
      if (r.turnsRemoved === 0) {
        for (const note of r.notes) ui.warn(note);
        break;
      }
      ui.success(
        `已回滚 ${r.turnsRemoved} 轮（code+conversation=${mode}）：` +
          `对话 -${r.messagesRemoved} 条，文件恢复 ${r.filesRestored} 处` +
          (r.filesSkipped > 0 ? `，跳过 ${r.filesSkipped} 处（快照缺失/过大）` : ""),
      );
      for (const note of r.notes) ui.line(c.dim(`  ${note}`));
      break;
    }

    // 后台长驻 shell（issue #28）：列表 / 停止。发起权在模型的 shell 工具（background: true）。
    case "ps": {
      if (!shells) {
        ui.warn("当前会话不支持后台 shell（未接线）。");
        break;
      }
      const sub = arg.split(/\s+/).filter((x) => x !== "")[0] ?? "";
      if (sub === "kill") {
        const target = arg.split(/\s+/).filter((x) => x !== "")[1] ?? "all";
        const n = shells.kill(target);
        if (n > 0) ui.success(`已停止 ${n} 个后台命令。`);
        else ui.info("没有可停止的运行中命令。");
        break;
      }
      for (const line of formatShellJobs(shells.list())) ui.line(line);
      break;
    }

    // 后台子代理任务（issue #16）：列表 / 取消。发起权在模型的 task 工具（background: true）。
    case "tasks": {
      if (!tasks) {
        ui.warn("当前会话不支持后台子代理（未接线）。");
        break;
      }
      const sub = arg.split(/\s+/).filter((x) => x !== "")[0] ?? "";
      if (sub === "cancel") {
        const target = arg.split(/\s+/).filter((x) => x !== "")[1] ?? "all";
        const n = tasks.cancel(target);
        if (n > 0) ui.success(`已取消 ${n} 个后台任务。`);
        else ui.info("没有可取消的运行中任务。");
        break;
      }
      // issue #48：/tasks chat <id> <消息> —— 给已完成的任务追加一条消息并继续该子代理。
      if (sub === "chat") {
        const parts = arg.split(/\s+/).filter((x) => x !== "");
        const id = parts[1] ?? "";
        const text = parts.slice(2).join(" ").trim();
        if (!id || !text) {
          ui.warn("用法：/tasks chat <id> <消息>（先 /tasks 看 id）");
          break;
        }
        if (!tasks.chat) {
          ui.warn("当前会话不支持续聊（未接线）。");
          break;
        }
        ui.info(`继续子代理 ${id}…`);
        const r = await tasks.chat(id, text);
        if (!r.ok) {
          ui.warn(r.error);
          break;
        }
        ui.blank();
        ui.line(r.reply);
        ui.blank();
        break;
      }
      const list = tasks.list();
      if (list.length === 0) {
        ui.info("没有后台任务。模型可用 task（background: true）发起，命令跑完会自动把结果注入会话。");
        break;
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
        ui.line(`  ${c.text(t.id)}  ${status}  ${c.dim(`${secs}s`)}  ${c.dim(prompt)}`);
        if (t.error) ui.line(`      ${c.warn(t.error)}`);
      }
      ui.line(c.dim("  /tasks cancel 取消全部 · /tasks cancel <id> 取消单个 · /tasks chat <id> <消息> 继续该子代理"));
      ui.blank();
      break;
    }

    // 结构化待办（issue #10）：只读查看。写入只走 todo_write 工具（模型侧整表替换）。
    case "todos": {
      const items = ctx.todos?.() ?? meta.todos ?? [];
      const body = formatTodos(items);
      if (body === "") {
        ui.info("暂无待办。长任务里模型会用 todo_write 建清单。");
        break;
      }
      for (const l of body.split("\n")) ui.line(l);
      ui.blank();
      break;
    }

    case "rename": {
      if (!mailbox) {
        ui.warn("跨会话信箱未启用（-p / 非交互模式不参与协作）");
        break;
      }
      const name = arg.trim();
      if (!name) {
        ui.warn("用法：/rename <name>");
        break;
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
      break;
    }

    case "skills": {
      const skills = discoverSkills(cfg);
      if (arg) {
        // 约束 16：这是给**人**看的只读诊断入口 —— 不加载全文，也不建软链。
        // 软链只由 use_skill 创建（那是模型行为，且会在输出里告知）。
        // 所以这里只从已发现的索引里查，不能走 resolveSkill —— 它会建软链，
        // 让一条纯查看命令悄悄改动了用户的项目目录。
        //
        // 但名称白名单仍要先过：arg 来自用户输入，`../etc` 这类必须报「非法」而非
        // 混入下面的 find() 变成一句语义错误的「不存在」—— 否则路径穿越的形态被掩盖了。
        if (!isValidSkillName(arg)) {
          ui.error(`技能名非法: ${arg}`);
          if (skills.length > 0) ui.info(`可用技能：${skills.map((s) => s.name).join(", ")}`);
          break;
        }
        const hit = skills.find((s) => s.name === arg);
        if (!hit) {
          ui.error(`技能不存在: ${arg}`);
          if (skills.length > 0) ui.info(`可用技能：${skills.map((s) => s.name).join(", ")}`);
          break;
        }
        ui.blank();
        ui.kv("名称", hit.name);
        // 用与索引/list 完全相同的规范化函数，保证三处 description 逐字一致
        ui.kv("说明", normalizeDescription(hit.description, hit.name));
        ui.kv("来源", hit.source === "project" ? "项目" : "全局");
        ui.kv("路径", hit.absPath);
        let first = "";
        try {
          first = (readFileSync(join(hit.absPath, "SKILL.md"), "utf8").split("\n") ?? [])
            .find((l) => l.trim().startsWith("# "))
            ?.trim() ?? "";
        } catch {
          /* ignore */
        }
        if (first) ui.kv("标题", first);
        ui.blank();
        // 约束 16：这里仍不打印正文。正文的两条入口都写明 —— 人直接 /名称，模型 use_skill。
        ui.info(`完整正文：直接输入 /${hit.name} [参数] 调用，或让模型 use_skill 加载。`);
        break;
      }

      ui.blank();
      if (skills.length === 0) {
        ui.info(`没有可用技能。把技能目录放到 ${join(cfg.cwd, "skills")} 或全局技能库。`);
        ui.blank();
        break;
      }
      ui.kv("可用技能", String(skills.length));
      for (const s of skills) {
        const dot = c.tool("●");
        // 形态与 system prompt 索引一致（formatSkillLine 保证 description 截断口径统一），
        // 但**保留来源与软链标注** —— 它们是 name/description 之外的信息，
        // 去掉会让用户看不出某技能是项目私有还是全局、是否为软链产物。
        // 统一的是「技能行里name:description 的写法」，不是「只能有这两项」。
        const origin = `${s.source === "project" ? "项目" : "全局"}${s.linked ? " · 软链" : ""}`;
        ui.line(`  ${dot} ${formatSkillLine(s.name, s.description)}${origin ? `　[${origin}]` : ""}`);
      }
      ui.blank();
      ui.info("直接输入 /名称 [参数] 调用技能，或让模型按需 use_skill；/skills <名称> 看详情。");
      ui.blank();
      break;
    }

    case "wiki-lint": {
      const dir = resolveWikiDir(cfg.cwd);
      if (!dir) {
        ui.warn(
          `未找到 wiki 目录（${join(cfg.cwd, ".neo", "wiki", "wiki")} 或 ${join(cfg.cwd, "wiki")}）。` +
            `先跑 /init 创建骨架，或确认目录位置。`,
        );
        break;
      }
      const result = lintWiki(dir);
      ui.line(formatLintReport(result));
      const s = result.summary;
      const total = s.broken + s.orphans + s.lowlinks + s.nosummary + s.nostamp;
      if (total === 0) ui.success("wiki 体检通过。");
      else {
        ui.warn(
          `共 ${total} 项待处理（断链 ${s.broken} / 孤儿 ${s.orphans} / 密度 ${s.lowlinks}` +
            ` / 摘要 ${s.nosummary} / 日期戳 ${s.nostamp}）`,
        );
      }
      break;
    }

    case "ingest": {
      const layout = resolveWikiLayout(cfg.cwd);
      if (!layout) {
        ui.warn(`未找到 wiki 骨架（${join(cfg.cwd, ".neo", "wiki")}）。先跑 /init。`);
        break;
      }
      let plan;
      try {
        plan = planIngest(layout, arg);
      } catch (e) {
        ui.warn((e as Error).message);
        break;
      }
      if (plan.files.length === 0 && plan.removed.length === 0) {
        ui.info(`raw/ 无变更，无需编译。`);
        finishIngest(layout);
        break;
      }
      if (plan.needsAnnounce) {
        ui.warn(`本次将做全量编译（${plan.reason}），处理 ${plan.files.length} 份 raw。`);
      } else {
        ui.info(`${plan.reason}；新增 ${plan.files.length} 份，删除 ${plan.removed.length} 份。`);
      }

      // 编译交给 fast 档子代理（机械编译活）；派发前主代理切回当前档，互不影响
      const prompt = buildIngestPrompt(layout, plan, loadIngestTemplate());
      ui.startSpinner(`子代理编译中（${plan.mode}）…`);
      const report = await runSubagent(agent, prompt, "fast", {
        cfg,
        approve: async () => true,
      });
      ui.stopSpinner();
      ui.line(report);

      finishIngest(layout);
      const hadChanges = plan.mode === "full" || plan.files.length > 0;
      if (hadChanges) {
        appendLog(layout, "ingest", `${plan.mode} 编译 ${plan.files.length} 份 raw`);
      }
      ui.success(`ingest 完成（${plan.mode}）。`);
      break;
    }

    case "mode": {
      const modes: Array<[string, string]> = [
        ["1", "ask — 写文件/执行命令都需批准"],
        ["2", "auto-edit — 自动批准写文件，命令仍需批准"],
        ["3", "auto-all — 全部自动批准（慎用）"],
        ["4", "plan — 只读，禁止一切写操作（要先出方案再动手请用 /plan）"],
      ];
      if (!arg) {
        ui.blank();
        ui.kv("当前模式", c.accent(agent.mode));
        if (agent.planning) {
          ui.kv("规划态", c.warn("进行中（生效模式恒为 plan）"));
        }
        // TTY：选择器接入（与 /model 同款）；hint = 模式说明，initial 定位当前模式
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const modeList: Array<{ name: PermissionMode; desc: string }> = [
            { name: "ask", desc: "写文件/执行命令都需批准" },
            { name: "auto-edit", desc: "自动批准写文件，命令仍需批准" },
            { name: "auto-all", desc: "全部自动批准（慎用）" },
            { name: "plan", desc: "只读，禁止一切写操作；要先出方案再动手请用 /plan" },
          ];
          const options = modeList.map((m) => ({
            label: m.name,
            hint: m.name === agent.mode ? `当前 · ${m.desc}` : m.desc,
            value: m.name,
          }));
          const picked = await select("切换到哪个权限模式？", options, {
            ...selectDeps,
            initial: Math.max(0, modeList.findIndex((m) => m.name === agent.mode)),
          });
          if (picked) {
            agent.mode = picked;
            try {
              mailbox?.setMode(picked);
            } catch {
              // 状态同步失败不影响模式切换
            }
            ui.success(`权限模式 → ${picked}`);
          } else {
            ui.info("已取消。");
          }
          break;
        }
        // 非 TTY：维持编号列表（C8）
        for (const [k, d] of modes) ui.line(`  ${c.accent(k)}) ${d}`);
        ui.line(c.dim("  用 /mode <1-4> 切换"));
        ui.blank();
        break;
      }
      const map: Record<string, PermissionMode> = {
        "1": "ask", ask: "ask", "2": "auto-edit", "3": "auto-all", "4": "plan", plan: "plan",
      };
      const m = map[arg];
      if (!m) {
        ui.warn(`未知模式 ${arg}`);
        break;
      }
      agent.mode = m;
      try {
        mailbox?.setMode(m);
      } catch {
        // 状态同步失败不影响模式切换
      }
      ui.success(`权限模式 → ${m}`);
      // 两套概念别混（issue #14）：/mode plan 只是只读闸门，不会进入交互规划工作流。
      if (m === "plan") {
        ui.info("这是只读闸门：禁止一切写操作，没有「确认后放开」这一步。");
        ui.info("要「先澄清 → 出方案 → 用户确认 → 开始实施」，用 /plan。");
      }
      break;
    }

    case "plan": {
      // 交互式规划工作流（issue #14）。与 /mode plan（只读闸门）是两套概念：
      // 这里进入的是会话态，规划期借用只读闸门，用户确认后切回进入前的权限模式。
      const sub = (rest[0] ?? "").toLowerCase();
      const snap = agent.plan;

      if (sub === "" || sub === "start") {
        if (agent.planning) {
          // 重复进入不重置已提交的方案，只把当前状态摆出来。
          ui.info("已在规划态。");
        } else {
          const base = agent.mode;
          agent.enterPlan(base);
          ui.success(`已进入规划态（规划期间生效模式 plan，确认后切回 ${base}）。`);
          ui.info("默认不写盘：先澄清范围/约束/取舍，再产出分步方案。");
        }
        const cur = agent.plan;
        if (cur?.draft) {
          ui.blank();
          ui.line(renderPlan(cur.draft));
          ui.blank();
          ui.line(c.dim("  方案待确认：/plan approve 开始实施 · /plan revise 修改 · /plan cancel 放弃"));
        } else {
          ui.line(c.dim("  直接说需求即可；模型会先澄清再提交方案，确认用 /plan approve。"));
        }
        break;
      }

      if (sub === "approve" || sub === "go") {
        if (!agent.planning) {
          ui.warn("当前不在规划态。用 /plan 进入。");
          break;
        }
        if (!snap?.draft) {
          ui.warn("还没有已提交的方案。先让模型提交方案（submit_plan），或 /plan cancel 放弃规划。");
          break;
        }
        const done = agent.approvePlan();
        const base = done?.baseMode ?? agent.mode;
        ui.success(`方案已确认，开始实施（权限模式 → ${base}，写盘/执行已恢复）。`);
        ui.info("已确认的方案已钉进上下文，模型按它动手。");
        break;
      }

      if (sub === "revise") {
        if (!agent.planning) {
          ui.warn("当前不在规划态。用 /plan 进入。");
          break;
        }
        agent.revisePlan();
        ui.success("已回到澄清态：告诉模型要改哪几步，它会提交修订版方案。");
        if (snap?.draft) {
          ui.blank();
          ui.line(renderPlan(snap.draft));
          ui.blank();
          ui.line(c.dim("  上一版方案保留在上下文里，供模型参考。"));
        }
        break;
      }

      if (sub === "cancel") {
        if (!agent.planning) {
          ui.warn("当前不在规划态。");
          break;
        }
        const base = snap?.baseMode ?? agent.mode;
        agent.cancelPlan();
        ui.success(`已退出规划态（权限模式 → ${base}），未确认的方案不生效。`);
        break;
      }

      // /plan 带其它参数：当作「进入规划态 + 这条需求」一起发出去。
      // 用户不用先 /plan 再打一遍需求，两步合成一步。
      if (!agent.planning) {
        const base = agent.mode;
        agent.enterPlan(base);
        ui.success(`已进入规划态（确认后切回 ${base}）。`);
      }
      await agent.send(arg);
      break;
    }

    case "review": {
      // 一等公民代码审查（issue #12）。与 /plan 的分工：
      // /plan 是「先出方案再动手」的会话态；/review 是「对着已有 diff 只读挑毛病」。
      // 采集在 CLI 侧用 git 完成 —— 「工作区干净」必须是确定性结论，不能交给模型判断。
      const collected = collectReviewDiff(cfg.cwd, arg);
      if (!collected.ok) {
        ui.warn(collected.message);
        break;
      }
      if (!collected.hasChanges) {
        // 干净：只打结论，不发请求。省一次模型调用，也不会让模型凭空编出 findings。
        ui.success(
          arg ? `相对 ${arg} 无差异，工作区干净。` : "工作区干净（相对 HEAD 无差异，也没有未跟踪文件）。",
        );
        break;
      }

      const stat = summarizePatch(collected.patch);
      ui.line(
        `${c.accent("◆")} 审查范围：${c.bright(collected.label)}` +
          ` ${c.dim(
            `· ${stat.files} 个文件 +${stat.added} −${stat.removed}` +
              (collected.untracked.length > 0 ? ` · ${collected.untracked.length} 个未跟踪文件` : ""),
          )}`,
      );
      if (collected.truncated) {
        ui.warn(
          `diff 过大（${collected.patchLength} 字符），已截断到 ${REVIEW_DIFF_LIMIT} 字符；未覆盖部分不会被审查。`,
        );
      }

      // 本轮禁写：临时借用只读闸门（decidePermission 的 plan 分支拒绝一切写操作），
      // 结束后在 finally 里恢复原模式。刻意不走 enterPlan —— 那会把会话拖进
      // #14 的交互规划态，状态栏变成「planning · 规划中」，用户只是想看个审查。
      const prevMode = agent.mode;
      agent.mode = "plan";
      try {
        await agent.send(buildReviewPrompt(collected));
      } finally {
        agent.mode = prevMode;
      }
      break;
    }

    case "worktree": {
      // issue #9：托管 worktree 的查看与清理。创建走命令行 `--worktree <name>`，
      // 因为「会话 cwd」必须在启动时就定好 —— 中途切 cwd 会让记忆/检查点/工具沙箱
      // 一半指着旧目录。
      const [subRaw, ...subRest] = arg.split(/\s+/).filter(Boolean);
      const sub = (subRaw ?? "list").toLowerCase();
      const repo = detectRepo(cfg.cwd);
      if (!repo.ok) {
        ui.warn(repo.message);
        break;
      }
      if (sub === "list" || sub === "ls") {
        const items = listManaged(repo.mainRoot, {}, cfg.cwd);
        ui.blank();
        if (items.length === 0) {
          ui.info(`没有 neo 托管的 worktree（目录 ${worktreeRoot(repo.mainRoot)}）。`);
          ui.line(c.dim("  新建：neo --worktree <name>（整会话在隔离检出里跑）"));
          break;
        }
        ui.line(
          c.dim(`neo 托管的 worktree（${worktreeRoot(repo.mainRoot)}；分支前缀 ${WORKTREE_BRANCH_PREFIX}）`),
        );
        for (const w of items) {
          const marks = [
            w.current ? c.accent("← 当前") : "",
            w.dirty ? c.warn("改动未提交") : c.dim("干净"),
          ]
            .filter(Boolean)
            .join(" ");
          ui.line(`  ${c.bright(w.name)} ${c.dim(w.branch ?? "(detached)")} ${marks}`);
          ui.line(`    ${c.dim(w.path)}`);
        }
        ui.line(
          c.dim(
            "  只列 .neo/worktrees/ 下由 neo 创建的；你自己的其它 worktree 不在此列、也不会被这里删除。",
          ),
        );
        break;
      }
      if (sub === "remove" || sub === "rm") {
        const name = subRest[0] ?? "";
        const force = subRest.slice(1).includes("--force");
        if (!name) {
          ui.warn("用法：/worktree remove <name> [--force]");
          break;
        }
        // 关键：先按 force=false 探测，**不**把 --force 直接透传下去。
        // 透传会让脏工作区在第一次调用就删掉，审批那一步被静默跳过 ——
        // 而「丢弃未提交改动」恰恰是最需要人看一眼再点头的动作。
        const probe = removeWorktree(repo.mainRoot, name, { force: false, cwd: cfg.cwd });
        if (probe.ok) {
          ui.success(
            `已删除 worktree ${probe.name}（${probe.path}）${probe.pruned ? "，已 prune" : ""}`,
          );
          ui.line(c.dim(`  分支 ${worktreeBranch(probe.name)} 保留，方便复查或重新挂载。`));
          break;
        }
        if (!probe.needsForce) {
          // 名字不存在 / 是当前会话 / 不是托管 worktree：都不是 --force 能解决的。
          ui.warn(probe.message);
          break;
        }
        // 脏工作区。--force 只代表「用户已经表达了丢弃意图」，不代表免审批：
        // 仍要把将被丢弃的改动摆到眼前，点一次头。
        // 措辞分两套：无 --force 时说「拒绝删除 + 怎么强制」；有 --force 时
        // 再说「拒绝删除」就是误导（用户已经要求删了），改成「将丢弃以下改动」。
        if (!force) {
          ui.warn(probe.message);
          ui.line(c.dim(`  确认要丢弃这些改动就再执行一次：/worktree remove ${name} --force`));
          break;
        }
        ui.warn(`"${name}" 有未提交改动或未跟踪文件，--force 将丢弃它们：`);
        for (const line of probe.message.split("\n")) {
          // 只取改动清单那几行（缩进两格的 status 行），跳过解释性文字。
          if (/^ {2}\S/.test(line)) ui.line(c.dim(line));
        }
        const ok = await ui.confirm(`worktree_remove — 删除 ${name} 并丢弃其未提交改动 / 未跟踪文件`);
        if (!ok) {
          ui.info("已取消，未删除任何东西。");
          break;
        }
        const forced = removeWorktree(repo.mainRoot, name, { force: true, cwd: cfg.cwd });
        if (forced.ok) {
          ui.success(`已强制删除 worktree ${forced.name}（未提交改动已丢弃）`);
        } else {
          ui.warn(forced.message);
        }
        break;
      }
      ui.warn(`未知子命令 /worktree ${sub}。可用：list | remove <name> [--force]`);
      break;
    }

    case "init": {
      const target = join(cfg.cwd, arg || "AGENTS.md");
      if (existsSync(target)) {
        const ok = await ui.confirm(`${target} 已存在，覆盖？`);
        if (!ok) {
          ui.info("已取消。");
          break;
        }
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buildMemoryFile(cfg), "utf8");
      ui.success(`已生成 ${target}`);
      // PRD §约束 14a / §约束 16 / §约束 17：额外初始化项目级 wiki 骨架 + 写 AGENTS.md 工作流段。
      // 失败按约束 17 不抛 — catch + stderr WARN。
      try {
        await initProjectLevelImpl(cfg, cfg.cwd);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error(`项目级 wiki 骨架创建失败（${reason}），本次会话不写索引`);
      }
      break;
    }

    case "memory": {
      // v0.2 记忆激活：完整子命令族（规格 §7.10）。
      const [subRaw, ...subRest] = arg.split(/\s+/).filter(Boolean);
      const sub = (subRaw ?? "").toLowerCase();
      const subArg = subRest.join(" ").trim();
      switch (sub) {
        case "":
        case "status":
          ui.line(memory.status());
          break;
        case "list": {
          const scope = subArg === "user" || subArg === "project" ? subArg : "all";
          ui.line(memory.list(scope));
          break;
        }
        case "recall":
          if (!subArg) {
            ui.warn("用法：/memory recall <关键词>");
            break;
          }
          ui.line(memory.recallForHuman(subArg));
          break;
        case "why":
          ui.line(memory.why());
          break;
        case "flush":
          ui.info("冲刷记忆写队列…");
          await memory.flush(10_000);
          ui.success("记忆写队列已处理。");
          break;
        case "forget": {
          const m = /^(project|user)[/:](.+\.md)$/.exec(subArg);
          if (!m) {
            ui.warn("用法：/memory forget <project|user>/<页面.md>");
            break;
          }
          const ok = await ui.confirm(`确定删除 ${m[1]}/${m[2]}？此操作不可撤销。`);
          if (!ok) {
            ui.info("已取消。");
            break;
          }
          ui.line(memory.forget(m[1] as "project" | "user", m[2] ?? ""));
          break;
        }
        case "migrate":
          ui.line(memory.migrate());
          break;
        case "lint":
          ui.line(memory.lint());
          break;
        case "on":
        case "off":
          cfg.memory.enabled = sub === "on";
          ui.success(`记忆已${sub === "on" ? "开启" : "关闭"}（仅本会话，不改配置文件）`);
          break;
        default:
          ui.warn(
            `未知 /memory 子命令：${subRaw}。可用：status / list [project|user] / recall <q> / why / flush / forget <scope>/<page> / migrate / lint / on|off`,
          );
      }
      break;
    }

    case "remember": {
      // 显式记忆：/remember <内容> [--user|--project]
      const flag = /\s*--(user|project)\s*$/.exec(arg);
      const body = (flag ? arg.slice(0, flag.index) : arg).trim();
      if (!body) {
        ui.warn("用法：/remember <要记住的内容> [--user|--project]");
        break;
      }
      const scope = flag?.[1] as "user" | "project" | undefined;
      ui.line(await memory.remember(body, scope));
      await memory.flush(10_000);
      ui.success("记忆已处理。");
      break;
    }

    case "history": {
      const msgs = agent.messages;
      ui.blank();
      ui.kv("消息总数", String(msgs.length));
      ui.kv("用户消息", String(msgs.filter((m) => m.role === "user").length));
      ui.kv("助手消息", String(msgs.filter((m) => m.role === "assistant").length));
      ui.kv("工具结果", String(msgs.filter((m) => m.role === "tool").length));
      ui.kv("工具调用", String(msgs.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0)));
      ui.blank();
      break;
    }

    case "save": {
      const target = arg ? resolve(cfg.cwd, arg) : join(cfg.cwd, "neo-session.json");
      writeFileSync(target, JSON.stringify({ meta, messages: agent.messages }, null, 2), "utf8");
      ui.success(`会话已保存到 ${target}`);
      break;
    }

    case "export": {
      const id = arg.trim();
      const loaded = id ? loadSession(id) : null;
      if (id && !loaded) {
        ui.warn(`会话不存在: ${id}（用 /sessions 查看）`);
        break;
      }
      const targetMeta = loaded?.meta ?? meta;
      const targetMessages = loaded?.messages ?? agent.messages;
      const dir = join(cfg.cwd, ".neo", "exports");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${targetMeta.id}.md`);
      writeFileSync(file, renderSessionMarkdown(targetMeta, targetMessages), "utf8");
      ui.success(`已导出会话 ${targetMeta.id} → ${file}（${targetMessages.length} 条消息）`);
      break;
    }

    case "resume": {
      // /resume [id] —— 交互中恢复历史会话（真续接：沿用目标 session-id/文件/信箱身份）。
      // 运行中的会话不列出、也不允许恢复（2026-10-26 裁决）。
      const resumeRoot = mailbox?.root ?? mailboxRoot();
      const isRunning = (id: string): boolean =>
        sessionLiveness(resumeRoot, id, { deadAfterMs: cfg.mailbox.deadAfterMs }) === "running";
      let targetId = arg;
      if (targetId === "last") {
        const available = listSessions(50).find((x) => x.id !== meta.id && !isRunning(x.id));
        if (!available) {
          ui.info("没有可恢复的会话（运行中的会话不列出）。");
          break;
        }
        targetId = available.id;
      }
      if (!targetId) {
        const list = listSessions(50)
          .filter((x) => x.id !== meta.id && !isRunning(x.id))
          .slice(0, 8);
        if (list.length === 0) {
          ui.info("没有可恢复的会话（运行中的会话不列出）。");
          break;
        }
        // 预览取该会话首条用户消息 —— id 是时间戳，辨识度全靠它
        const options = list.map((s) => {
          const f = loadSession(s.id);
          const firstUser = f?.messages.find((m) => m.role === "user" && (contentText(m.content) ?? "").trim());
          const preview = firstUser?.content
            ? truncate((contentText(firstUser.content) ?? "").replace(/\s+/g, " ").trim(), 46)
            : "（无文本预览）";
          return { label: `${s.id}  ${preview}`, hint: `${s.turns}轮 ${s.model}`, value: s.id };
        });
        // C1：进入前收尾 spinner；select 存续期间不得有其他输出写入
        ui.stopSpinner();
        ui.blank();
        const picked = await select("恢复哪个会话？", options, selectDeps);
        if (!picked) {
          ui.info("已取消。");
          break;
        }
        targetId = picked;
      }
      const full = loadSession(targetId);
      if (!full) {
        ui.warn(`未找到会话 ${targetId}`);
        break;
      }
      if (full.messages.length === 0) {
        ui.warn("该会话没有任何消息，无法恢复。");
        break;
      }
      if (isRunning(full.meta.id)) {
        ui.warn(`会话 ${full.meta.id} 正在另一个进程中运行，不能恢复（/peers 可查看存活会话）。`);
        break;
      }
      // 先接管信箱身份；失败则不改对话/持久化，避免身份与会话不一致。
      if (mailbox) {
        const beforeName = readProfile(mailbox.root, full.meta.id)?.name ?? null;
        try {
          const p = mailbox.adopt(full.meta.id);
          if (beforeName && p.name && beforeName !== p.name) {
            ui.info(`目标代号 ${beforeName} 已被占用，恢复为 ${p.name}`);
          }
          onMailboxRekey?.();
          if (p.name) {
            onNameChange?.(p.name);
          } else {
            // 目标 profile 无名字：按 A2 随机一个池内名并写回（不随机覆盖已有名字）。
            const chosen = chooseSessionName({
              taken: takenAliveNames(mailbox.root, { deadAfterMs: cfg.mailbox.deadAfterMs }),
            });
            if (chosen) {
              const renamed = renameSession(mailbox.root, mailbox.sessionId, chosen.name, {
                deadAfterMs: cfg.mailbox.deadAfterMs,
              });
              onNameChange?.(renamed.name ?? "");
            }
          }
          ui.info(`跨会话信箱身份已切换到 ${full.meta.id}${p.name ? `（${p.name}）` : ""}`);
        } catch (e) {
          ui.warn(`无法恢复 ${full.meta.id}：${(e as Error).message}`);
          break;
        }
      }
      agent.messages = applyRestored(agent.messages[0], full.messages);
      Object.assign(meta, full.meta, { model: cfg.model });
      if (full.meta.cwd && full.meta.cwd !== cfg.cwd) {
        ui.info(`会话原目录 ${full.meta.cwd}，本次按 ${cfg.cwd} 运行`);
      }
      ui.success(`已恢复会话 ${full.meta.id}（${full.messages.length} 条消息）`);
      // v0.2.3 D4：恢复后回放，避免「上下文都在、屏幕上什么都没有」
      replayTranscript(ui, full.messages);
      const lastUser = [...full.messages]
        .reverse()
        .find((m) => m.role === "user" && (contentText(m.content) ?? "").trim());
      if (lastUser?.content) {
        ui.line(c.dim(`  上次输入：${truncate((contentText(lastUser.content) ?? "").replace(/\s+/g, " ").trim(), 60)}`));
      }
      break;
    }

    case "last": {
      // v0.2.3 D3：紧凑模式不打印工具正文，这里用内存缓存把最近 n 次找回来。
      // 范围夹取在 recentToolCalls 内部完成，这里不做第二遍。
      const recs = ui.recentToolCalls(arg ? Number(arg) || 1 : 1).reverse(); // 时间顺序：旧 → 新
      if (recs.length === 0) {
        ui.info("本次会话还没有工具调用记录。");
        break;
      }
      for (const r of recs) {
        for (const l of formatToolCall(r, ui.width)) ui.line(l);
        ui.blank();
      }
      break;
    }

    case "sessions":
      printSessions(ui, {
        root: mailbox?.root ?? mailboxRoot(),
        deadAfterMs: cfg.mailbox.deadAfterMs,
        currentId: meta.id,
      });
      break;

    case "exit":
    case "quit":
      void shutdown();
      break;

    default:
      ui.warn(`未知命令 /${cmd}。用 /help 查看全部命令。`);
  }
}

/**
 * 把本文件实现的命令登记进注册表。
 *
 * 名字从 switch 的顶层 case 现取，不手抄第二份清单。
 * 每个名字都指向同一个 handleCommand：新增 case 即自动可分发，
 * 不必再在入口写一遍 switch。重复调用是幂等的。
 */
let wired = false;

export function wireCommands(): void {
  if (wired) return;
  wired = true;
  for (const name of implementedCommandNames()) {
    registerCommand(name, handleCommand);
  }
}

export async function dispatchCommand(line: string, ctx: CommandContext): Promise<void> {
  wireCommands();
  const [nameRaw, ...rest] = line.slice(1).split(/\s+/);
  const name = (nameRaw ?? "").toLowerCase();
  const args = rest.join(" ").trim();
  const handler = commandHandler(name);

  if (handler) {
    // 内置优先（issue #13 验收 3）：同名技能被遮挡时必须说一句，
    // 否则用户会以为技能正文已经加载了，而模型那边什么也没收到。
    if (isValidSkillName(name) && discoverSkills(ctx.cfg).some((s) => s.name === name)) {
      ctx.ui.info(
        `/${name} 是内置命令，同名技能未触发；要用这个技能请改名，或让模型 use_skill 加载。`,
      );
    }
    await handler(line, ctx);
    return;
  }

  // 未命中内置命令 → 尝试当作技能名（技能是动态发现的，不登记进补全表）
  if (!isValidSkillName(name)) {
    ctx.ui.warn(`未知命令 /${name}。用 /help 查看全部命令。`);
    return;
  }

  const loaded = tryLoadSkillForSlash(ctx.cfg, name);
  if (!loaded.ok) {
    const avail = loaded.available.length > 0 ? `\n可用技能：${loaded.available.join(", ")}` : "";
    ctx.ui.warn(`未知命令 /${name}：无此技能。${loaded.message}${avail}`);
    ctx.ui.info("用 /help 查看内置命令，/skills 列出全部技能。");
    return;
  }

  if (!ctx.enqueueUserTurn) {
    // 单次模式（-p）等没有主循环队列的入口：明确告知，不静默吞掉
    ctx.ui.warn(`当前模式无法通过 /${name} 启动一轮，请让模型 use_skill 加载。`);
    return;
  }

  const text = buildSkillSlashPrompt({
    name: loaded.meta.name,
    body: loaded.body,
    args,
    files: loaded.files,
    sourceLine: describeSource(ctx.cfg, loaded.meta, loaded.createdLink),
  });
  ctx.enqueueUserTurn(text);
  ctx.ui.success(`已调用技能 ${loaded.meta.name}${args ? `（参数：${args}）` : ""}，下一轮发送给模型。`);
  ctx.ui.info(`${describeSource(ctx.cfg, loaded.meta, loaded.createdLink)} · ${loaded.meta.absPath}`);
}

/** 顶层 case 名。嵌套 switch（/memory）缩进更深，不会被算进来。 */
export function implementedCommandNames(source = readFileSync(new URL("./commands.ts", import.meta.url), "utf8")): string[] {
  const start = source.indexOf("export async function handleCommand(");
  const body = start === -1 ? source : source.slice(start);
  return [...body.matchAll(/^ {4}case "([^"]+)":/gm)].map((m) => m[1]!);
}

