#!/usr/bin/env bun
/**
 * neo 组合根：解析参数、组装会话、跑 REPL。
 *
 * 斜杠命令在 cli/commands.ts，shell 直通在 cli/shell.ts，
 * 会话落盘在 cli/sessions.ts，Agent 循环在 agent/loop.ts。
 * 这里只负责把它们接起来。新增命令不要改本文件。
 */
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import {
  loadConfig,
  switchProvider,
  applyTier,
  isImplemented,
  IMPLEMENTED_PROVIDER_TYPES,
  ConfigError,
  normalizeTierName,
  tierDisplayName,
  tierChoiceLabel,
  type Config,
} from "./config.ts";
import { Classifier, CLASSIFIER_NAMES, isClassifierName, type ClassifierName } from "./classifier/index.ts";
import { Agent, type PermissionMode } from "./agent.ts";
import { dispatchCommand } from "./cli/commands.ts";
import { helpText } from "./cli/help.ts";
import { persist, printSessions, replayTranscript, showStats } from "./cli/sessions.ts";
import { authorizeShell, executeShell, runShell } from "./cli/shell.ts";
import { VERSION } from "./cli/version.ts";
import { detectRepo, ensureWorktree } from "./worktree.ts";
import { HotkeyRouter, doubleStrike } from "./hotkeys.ts";
import { PasteCollector, shouldFold, assemblePaste } from "./paste.ts";
import { makeTextAttachment, makeImageAttachment, bindAttachments, resolveLine, type Attachment, type QueuedLine } from "./attachments.ts";
import { clipboardImagePlatform, readClipboardImage } from "./clipboard.ts";
import { select, type SelectDeps } from "./ui/select.ts";
import { Console } from "./ui/console.ts";
import { Composer, type ComposerStatus } from "./tui/composer.ts";
import { TranscriptDock, type DockHost } from "./tui/dock.ts";
import { getBranch } from "./git.ts";
import { chooseSessionName } from "./sessionName.ts";
import { TitleAnimator } from "./tui/title.ts";
import { banner, c, rule } from "./ui/theme.ts";
import {
  applyMatch,
  completeLine,
  formatCandidateHint,
  triggerAt,
} from "./input/completion.ts";
import { COMMANDS, knownSlashCommand } from "./input/commands.ts";
import { FileIndex } from "./input/fileIndex.ts";
import { expandReferences } from "./input/references.ts";
import {
  discoverProjectRules,
  extractTouchedPaths,
  formatAlwaysOnRules,
  formatScopedRulesBlock,
  normalizeRelPath,
  selectScopedRules,
} from "./rules/index.ts";
import {
  appendContinuation,
  continuationPrompt,
  emptyContinuation,
  finishContinuation,
  isActiveContinuation,
  newlineKindsFromBytes,
  stripContinuationMarker,
  type Continuation,
} from "./input/multiline.ts";
import { PromptManager } from "./prompt/manager.ts";
import { createMemoryBridge, type MemoryBridge } from "./memory/bridge.ts";
import { makeRememberTool } from "./tools/memory.ts";
import { makeTodoWriteTool, todosSummary, type TodoItem } from "./tools/todo.ts";
import { chatStream, contentText, setMaxTokensLimitLearnedHandler, type Message } from "./llm.ts";
import { toolNames, registerTool } from "./tools/index.ts";
import { McpManager, type McpServerState } from "./mcp/index.ts";
import { makeTaskTool, runSubagent } from "./tools/task.ts";
import { BackgroundTasks, serializeJobs, restoreJobs } from "./tools/background.ts";
import { saveSubagentTranscript, loadSubagentTranscript } from "./tools/transcript.ts";
import type { ToolCtx } from "./tools/types.ts";
import { backgroundShells } from "./tools/backgroundShell.ts";
import { cleanupEphemeral } from "./cleanup.ts";
import { makeAskUserTool } from "./tools/askUser.ts";
import { registerWikiTools } from "./tools/wiki.ts";
import { describeShell, getShell, prepareShellInvocation } from "./shell.ts";
import { loadEnv } from "./env/probe.ts";
import {
  detectAndRecordModelWindow,
  formatCapabilityGapHint,
  recordModelContext,
  resolveAndApplyModelWindow,
} from "./env/modelWindows.ts";
import {
  currentProviderConfig,
  probeCapabilitiesOnFirstUse,
  undeclaredCapabilityFields,
  writeBackContextLimit,
  writeBackOutputLimit,
} from "./env/modelCaps.ts";
import {
  describeProbeOutcome,
  persistLearnedOutputLimit,
  probeOutputLimitForConfig,
  readOutputProbeMemo,
  shouldRunOutputProbe,
} from "./env/outputProbe.ts";
import { syncEnvPage } from "./env/wiki.ts";
import { ensureScopeLayout } from "./memory/layout.ts";
import { adoptSession, applyRestored, createSession, listSessions, loadSession, type SessionMeta } from "./session.ts";
import { Mailbox } from "./mailbox/store.ts";
import {
  createIdentity,
  readProfile,
  releaseAlive,
  sessionLiveness,
  sweepSessions,
  takenAliveNames,
} from "./mailbox/identity.ts";
import * as mailboxState from "./mailbox/state.ts";
import { decideInbound, formatIncomingFrame, formatNotice, formatNoticePreview, formatPreview } from "./mailbox/inbound.ts";
import { makeListPeersTool, makeSendMessageTool } from "./tools/mailbox.ts";
import { mailboxRoot, type Envelope } from "./mailbox/types.ts";
import { cleanupRuntime } from "./maintenance.ts";
import { LoopScheduler, formatLoopStatus } from "./loop.ts";
import { RewindLog, type RewindMode } from "./rewind.ts";
import { DriveManager, formatDriveState } from "./drive.ts";
import { lspServers } from "./lsp/index.ts";
import { CheckpointStore } from "./checkpoint.ts";
import { formatResumeWarning, outcomeOf, type LastTurnMeta } from "./turnDiagnostics.ts";
import {
  bootLines,
  formatGapLogLine,
  formatOverBudgetNotice,
  formatProbeIntent,
  makeOverBudgetReporter,
  formatWindowNotice,
  formatWritebackNotice,
  logBootDiagnostic,
} from "./bootDiagnostics.ts";
import type { PromptSelection } from "./prompt/select.ts";

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

interface Args {
  print: string | null;
  model: string | null;
  provider: string | null;
  tier: string | null;
  auto: string | null;
  cwd: string | null;
  mode: PermissionMode;
  resume: string | null;
  name: string | null;
  listSessions: boolean;
  noReasoning: boolean;
  continueLast: boolean;
  help: boolean;
  version: boolean;
  /** -p 输出格式：text（默认）| json（P0-6，供 CI/编排器消费）。 */
  outputFormat: "text" | "json";
  /** --worktree <name>：在托管 worktree 里开会话（issue #9）。 */
  worktree: string | null;
  /** 参数值非法（如 --output-format bogus）：main 直接返回 2。 */
  badArgs: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    print: null,
    model: null,
    provider: null,
    tier: null,
    auto: null,
    cwd: null,
    mode: "ask",
    resume: null,
    name: null,
    listSessions: false,
    noReasoning: false,
    continueLast: false,
    help: false,
    version: false,
    outputFormat: "text",
    worktree: null,
    badArgs: false,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] ?? "";
    // 等号形式（--output-format=json）也要认，否则编排器写 `--flag=value` 会被静默忽略。
    if (v.startsWith("--output-format=")) {
      const val = v.slice("--output-format=".length).trim();
      if (val !== "text" && val !== "json") {
        console.error(`✖ --output-format 只支持 text | json（收到 "${val}"）`);
        a.badArgs = true;
      } else {
        a.outputFormat = val;
      }
      continue;
    }
    switch (v) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-v":
      case "--version":
        a.version = true;
        break;
      case "-p":
      case "--print":
        a.print = argv[++i] ?? "";
        break;
      case "-m":
      case "--model":
        a.model = argv[++i] ?? null;
        break;
      case "-P":
      case "--provider":
        a.provider = argv[++i] ?? null;
        break;
      case "-t":
      case "--tier":
        a.tier = argv[++i] ?? null;
        break;
      case "--auto":
        a.auto = argv[++i] ?? null;
        break;
      case "-C":
      case "--cwd":
        a.cwd = argv[++i] ?? null;
        break;
      // issue #9：整会话进托管 worktree。-w 在 neo 里没有别的主人（-y/-c/-p/-m/-P/-t/-C 都占了）。
      case "-w":
      case "--worktree":
        a.worktree = argv[++i] ?? "";
        break;
      case "-y":
      case "--yes":
        a.mode = "auto-all";
        break;
      case "--edit":
        a.mode = "auto-edit";
        break;
      case "--plan":
        a.mode = "plan";
        break;
      case "--resume": {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-") && next.trim() !== "") {
          a.resume = next;
          i += 1;
        } else {
          a.resume = "last"; // --resume 后面直接跟 flag/结束 → 取最近可恢复
        }
        break;
      }
      case "--name":
        a.name = argv[++i] ?? "";
        break;
      case "-c":
      case "--continue":
        a.continueLast = true;
        break;
      case "--sessions":
        a.listSessions = true;
        break;
      case "--no-reasoning":
        a.noReasoning = true;
        break;
      case "--output-format": {
        const v = (argv[++i] ?? "").trim();
        if (v !== "text" && v !== "json") {
          console.error(`✖ --output-format 只支持 text | json（收到 "${v}"）`);
          a.badArgs = true;
        } else {
          a.outputFormat = v;
        }
        break;
      }
      default:
        a.rest.push(v);
    }
  }
  return a;
}

const HELP = helpText();
/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.badArgs) return 2;
  if (args.name !== null && (args.name.trim() === "" || args.name.startsWith("-"))) {
    console.error(c.err("✖ --name 需要一个名字（不能为空或以 - 开头）"));
    return 2;
  }
  // --worktree 的取值校验放在这里：早于配置载入，也早于任何目录副作用。
  if (args.worktree !== null && (args.worktree.trim() === "" || args.worktree.startsWith("-"))) {
    console.error(c.err("✖ --worktree 需要一个名字（不能为空或以 - 开头）"));
    return 2;
  }

  // 参数合法性先于 --help/--version 校验。
  // 否则 `--auto bogus --version` 会打印版本后返回 0，
  // 把一个拼写错误静默放过 —— 下次真正跑起来才报错，更难查。
  if (args.auto && !isClassifierName(args.auto)) {
    console.error(c.err(`✖ 未知分类器 "${args.auto}"。可选：${CLASSIFIER_NAMES.join(", ")}`));
    return 2;
  }
  // --tier 接受简写（deep/bal/fast/auto），内部仍落到规范 ModelTier。
  const requestedTier = args.tier ? normalizeTierName(args.tier) : null;
  if (args.tier && !requestedTier) {
    console.error(
      c.err(
        `✖ 未知档位 "${args.tier}"。可选：deep (deep_reasoning) / balanced / fast / default；` +
          `简写 deep / d / bal / b / f / auto 也可`,
      ),
    );
    return 2;
  }

  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.version) {
    console.log(c.accent(`neo v${VERSION}`));
    return 0;
  }

  const overrides: Partial<Config> = {};
  if (args.model) overrides.model = args.model;
  if (args.cwd) overrides.cwd = args.cwd;
  if (args.noReasoning) overrides.showReasoning = false;

  // ---- issue #9：整会话进托管 worktree ----
  // 必须在 loadConfig 之前把 cwd 换成 worktree 目录：配置、会话/记忆/信箱路径、
  // 检查点、工具沙箱全部以 cfg.cwd 为根，晚一步就会有一半逻辑指着主仓库。
  // 与 --resume 的兼容：会话仍按 id 恢复（会话文件在 ~/.neo 下，与 cwd 无关），
  // 恢复后只提示「原目录 ≠ 本次目录」，不偷偷切回去（沿用既有裁决）。
  let worktreeInfo: { name: string; path: string; branch: string; created: boolean; repoRoot: string } | null =
    null;
  if (args.worktree !== null) {
    const name = args.worktree.trim();
    const probeFrom = args.cwd ? resolve(process.cwd(), args.cwd) : process.cwd();
    const repo = detectRepo(probeFrom);
    if (!repo.ok) {
      console.error(c.err(`✖ ${repo.message}`));
      return 2;
    }
    const ensured = ensureWorktree(repo.mainRoot, name);
    if (!ensured.ok) {
      console.error(c.err(`✖ ${ensured.message}`));
      return 2;
    }
    worktreeInfo = {
      name,
      path: ensured.path,
      branch: ensured.branch,
      created: ensured.created,
      repoRoot: ensured.repoRoot,
    };
    // 显式 -C 与 --worktree 同时给：worktree 是更具体的意图，以它为准并说明。
    if (args.cwd) {
      console.error(
        c.dim(`  --worktree 覆盖 -C：工作目录改为 ${ensured.path}`),
      );
    }
    overrides.cwd = ensured.path;
  }

  // provider 与档位要在配置载入后处理：它们决定 model 的解析方式
  let cfg: Config;
  try {
    cfg = loadConfig(overrides);

    if (requestedTier) {
      const r = applyTier(cfg, requestedTier);
      if (!r.ok) {
        console.error(c.err(`✖ ${r.error}`));
        return 2;
      }
    }
    if (args.provider) {
      const r = switchProvider(cfg, args.provider);
      if (!r.ok) {
        console.error(c.err(`✖ ${r.error}`));
        return 2;
      }
    }
    // A2：启动时用 env 事实校正窗口（配置可能配错，/model、/tier 也可能换模型）。
    resolveAndApplyModelWindow(cfg);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(c.err(`✖ 配置错误：${e.message}`));
      return 2;
    }
    throw e;
  }

  if (!cfg.apiKey) {
    console.error(
      c.err(`✖ provider "${cfg.providerName}" 没有配置 api_key。`) +
        c.dim("\n  请在 settings.json 的 providers 中填写，或设置环境变量 NEO_API_KEY。"),
    );
    return 2;
  }

  // ---- v0.3.0 底部 live 帧：TTY 才启用 composer/dock，非 TTY 走 v0.2.4 readline 路径 ----
  // -p 是单次模式：即使 stdout 是 TTY 也不要起 composer/dock ——
  // dock 的 preComposerRows 只有 composer 启动时才会 flush，-p 下永不启动，
  // 会导致「真终端里 neo -p 零输出」。这里直接走 no-dock 的直写路径。
  const interactiveTTY =
    args.print === null && process.stdin.isTTY === true && process.stdout.isTTY === true;
  let composerRef: Composer | null = null;
  /** composer 启动前的输出（banner / 记忆提示 / --resume 回放）先缓存，启动后一次性落到上方。 */
  const preComposerRows: string[] = [];
  const dockHost: DockHost = {
    width: () => {
      const w = composerRef?.width() ?? process.stdout.columns;
      return typeof w === "number" && w > 20 ? w : 80;
    },
    commitAbove: (rows) => {
      if (composerRef) composerRef.commitAbove(rows);
      else preComposerRows.push(...rows);
    },
    setPending: (rows) => composerRef?.setPending(rows),
    setActivity: (text, persist) => composerRef?.setActivity(text, persist),
    commitActivity: () => composerRef?.commitActivity(),
    clearActivity: () => composerRef?.clearActivity(),
    notice: (text, ms) => composerRef?.notice(text, ms),
    rerender: () => composerRef?.rerender(),
  };
  const dock = interactiveTTY ? new TranscriptDock(dockHost) : null;
  /**
   * -p --output-format json：stdout 只留一行 JSON，所有 UI/工具/流式输出改走 stderr。
   * 这是 P0-6 的关键约束 —— 否则 stdout 不可解析，CI 无法消费。
   */
  const jsonMode = args.print !== null && args.outputFormat === "json";
  const ui = new Console(
    cfg.theme === "matrix",
    cfg.toolcallInfoDetails,
    dock
      ? { dock, getTier: () => cfg.modelTier }
      : jsonMode
        ? {
            stdoutIsTTY: false,
            stdinIsTTY: false,
            getTier: () => cfg.modelTier,
            write: (s: string) => {
              process.stderr.write(s);
            },
          }
        : { getTier: () => cfg.modelTier },
  );

  /**
   * issue #8 B：输出上限的**受控主动探测**（默认关，见 settings 的
   * `probe_max_output_tokens`）。只在「交互 + 开关开 + 手写为空 + `/models` 没给 +
   * 7 天内没探过」时才会真的发请求；结论见 `src/env/outputProbe.ts`。
   */
  const maybeProbeOutputLimit = (): void => {
    const settings = currentProviderConfig(cfg)?.outputProbe;
    if (!settings) return;
    const declared = !undeclaredCapabilityFields(cfg).includes("max_output_tokens");
    const decision = shouldRunOutputProbe({
      settings,
      outputLimitDeclared: declared,
      memo: readOutputProbeMemo(cfg),
    });
    logBootDiagnostic({
      kind: "output-probe",
      message: `输出上限探测决策：${decision.run ? "将探测" : `跳过（${decision.reason}）`}`,
    });
    if (!decision.run) return;
    void probeOutputLimitForConfig(cfg, settings)
      .then(({ outcome, written }) => {
        if (written.length > 0) {
          // TUI 只留「改了什么」（#18 口径）；诊断进日志。
          const line = formatWritebackNotice(written);
          ui.info(line);
          logBootDiagnostic({ kind: "output-probe", message: line });
        }
        logBootDiagnostic({ kind: "output-probe", message: describeProbeOutcome(outcome) });
      })
      .catch(() => {
        /* 探测失败不影响会话 */
      });
  };

  // issue #8 A：请求层从 400/422 文案学到精确输出上限时，把这份「免费证据」入账 ——
  // 只填空字段（手写优先）、永远不改 max_tokens；证据写进 env 事实。
  setMaxTokensLimitLearnedHandler((ev) => {
    const r = persistLearnedOutputLimit(ev.cfg, ev.limit, ev.evidence);
    if (r.written.length === 0) return;
    const line = formatWritebackNotice(r.written);
    ui.info(line);
    logBootDiagnostic({ kind: "output-limit-learned", message: line });
  });

  // A2：交互模式下异步探测当前模型窗口（/models 元数据）；失败静默。
  // 探测成功会写入 env 事实文件，后续启动/切模型直接命中。
  // 同一 provider|model 的「网关没给能力」提示只说一次，避免每轮撞墙都刷屏；
  // /context 与 /env 仍每次都展示。
  // issue #18：能力诊断只写日志，不进 TUI。TUI 只留「改了什么」（写回字段、生效窗口）。
  const announcedCapabilityGap = new Set<string>();
  const announceCapabilityGap = (): void => {
    const key = `${cfg.providerName}|${cfg.model}`;
    if (announcedCapabilityGap.has(key)) return;
    const hint = formatCapabilityGapHint(cfg);
    if (!hint) return;
    announcedCapabilityGap.add(key);
    logBootDiagnostic({ kind: "capability-gap", message: formatGapLogLine(hint) });
  };
  if (interactiveTTY) {
    // #6：按字段补空缺。五项全空才说「首次使用」；只填了窗口时也要探测其余项。
    // 判定必须在探测之前做 —— 探测会写 env 事实，但手写值（含 false）不会被改掉。
    const missingCaps = undeclaredCapabilityFields(cfg);
    if (missingCaps.length > 0) {
      logBootDiagnostic({
        kind: "probe-intent",
        message: formatProbeIntent(cfg.providerName, cfg.model, missingCaps),
      });
      void probeCapabilitiesOnFirstUse(cfg)
        .then((r) => {
          if (r.written.length > 0) {
            ui.info(formatWritebackNotice(r.written));
            logBootDiagnostic({ kind: "probe-writeback", message: formatWritebackNotice(r.written) });
          }
          // 瘦网关补不出上限时说清楚，避免「探测跑过了」被当成已经学会。
          // issue #18：这句是诊断，只进日志（异步回调里也绝不回流 TUI）。
          announceCapabilityGap();
          if (r.contextWindow) {
            const applied = resolveAndApplyModelWindow(cfg);
            if (applied.source !== "config") {
              ui.info(formatWindowNotice(applied.tokens, applied.source));
              logBootDiagnostic({
                kind: "model-window",
                message: formatWindowNotice(applied.tokens, applied.source),
              });
            }
          }
          // issue #8：/models 给不出上限时，才轮到主动探测（显式开启时才跑）。
          maybeProbeOutputLimit();
        })
        .catch(() => {
          /* 探测失败不影响会话 */
        });
    } else {
      void detectAndRecordModelWindow(cfg)
        .then((info) => {
          if (!info?.contextWindow) return;
          const r = resolveAndApplyModelWindow(cfg);
          if (r.source !== "config") {
            ui.info(formatWindowNotice(r.tokens, r.source));
          }
        })
        .catch(() => {
          /* 探测失败不影响会话 */
        });
    }

    // B5：清理过期工具输出与已死 mailbox 会话目录（默认 7 天）。
    try {
      const cleaned = cleanupRuntime(cfg.cwd, mailboxRoot());
      if (cleaned.removedTmpFiles + cleaned.removedMailboxDirs.length > 0) {
        ui.info(
          `已清理过期文件：tmp ${cleaned.removedTmpFiles} 个、mailbox ${cleaned.removedMailboxDirs.length} 个` +
            `（释放 ${Math.round(cleaned.freedBytes / 1024)} KB）`,
        );
      }
    } catch {
      /* 清理失败不影响启动 */
    }
  }

  // default_provider 指向未接入的协议时，必须在启动就拦下。
  // 放过的话会一路走到 fetch，得到的错误跟配置问题无关，排查方向完全被带偏。
  if (!isImplemented(cfg.providerType)) {
    const pending = cfg.providers.filter((p) => !isImplemented(p.type)).map((p) => p.name);
    console.error(
      c.err(`✖ default_provider "${cfg.providerName}" 使用 ${cfg.providerType} 协议，请求层尚未接入。`) +
        c.dim(`\n  已实现的协议：${IMPLEMENTED_PROVIDER_TYPES.join(", ")}。`) +
        c.dim("\n  可用 -P 指定其他 provider，或改 settings.json 的 default_provider。") +
        c.dim(`\n  已配置但未接入：${pending.join(", ") || "无"}`),
    );
    return 2;
  }

  if (cfg.legacyFormat) {
    ui.warn("检测到旧版扁平配置（api-key / OpenAI / model_name），已自动折算为 provider \"legacy\"。");
    ui.line(c.dim("  新格式见 settings.example.json。"));
  }

  // issue #21 A：max_tokens 配置体检。加载时已逐 provider 判定，这里逐条摆出来 ——
  // 输出预算 ≥ 上下文窗口这类配置几乎必然 400，启动时说清楚，别让用户对着不透明报错猜。
  for (const w of cfg.maxTokensWarnings) ui.warn(w);
  for (const w of cfg.lspWarnings) ui.warn(w);

  // issue #9：让用户一眼看出「这次会话在 worktree 里」，而不是在主仓库里改文件。
  if (worktreeInfo) {
    ui.info(
      `${worktreeInfo.created ? "已创建" : "已复用"} worktree ${worktreeInfo.name} ` +
        `→ ${worktreeInfo.path}（分支 ${worktreeInfo.branch}）`,
    );
    ui.line(
      c.dim(
        `  隔离的是文件，不是权限：/mode 与审批照旧。退出后可用 /worktree list 查看、` +
          `/worktree remove ${worktreeInfo.name} 清理。`,
      ),
    );
  }

  if (args.listSessions) {
    printSessions(ui, { root: mailboxRoot(), deadAfterMs: cfg.mailbox.deadAfterMs });
    return 0;
  }

  // ---- 恢复会话（真续接：沿用原 session-id / 文件 / 信箱身份）----
  // 活/死判定（2026-10-26 用户裁决）：running = .alive + pid 存活 + 心跳 <= deadAfterMs；
  // pid 已死或心跳超时（事件循环卡死/休眠）→ 视为已死，允许恢复并回收残留锁。
  let restored: Message[] | null = null;
  let meta: SessionMeta | null = null;
  const resumeRoot = mailboxRoot();
  let sessionLabel: string | null = null;
  const isRunningSession = (id: string): boolean =>
    sessionLiveness(resumeRoot, id, { deadAfterMs: cfg.mailbox.deadAfterMs }) === "running";
  if (args.resume !== null || args.continueLast) {
    const target = args.resume ?? "last";
    if (target === "last") {
      // 跳过运行中的会话：取最近一个「可恢复」的，而不是先取最近再报错。
      const available = listSessions(50).find((x) => !isRunningSession(x.id));
      if (!available) {
        console.error(c.err("✖ 没有可恢复的会话（运行中的会话不列出）。"));
        return 2;
      }
      const full = loadSession(available.id);
      if (!full) {
        console.error(c.err(`✖ 会话 ${available.id} 读取失败，无法恢复。`));
        return 2;
      }
      restored = full.messages;
      meta = full.meta;
    } else {
      const full = loadSession(target);
      if (!full) {
        console.error(c.err(`✖ 未找到会话 ${target}`));
        return 2;
      }
      if (isRunningSession(full.meta.id)) {
        console.error(
          c.err(`✖ 会话 ${full.meta.id} 正在另一个进程中运行，不能恢复。`) +
            c.dim("\n  请先退出那个进程；/peers 可查看存活会话（v0.3.x 才会提供 attach）。"),
        );
        return 2;
      }
      restored = full.messages;
      meta = full.meta;
    }
  }

  // resume 命中时：读旧信箱 profile 的名字（真续接保证 id 一致；读不到则当无旧名）。
  let resumePreviousName: string | null = null;
  if (meta) {
    try {
      resumePreviousName = readProfile(resumeRoot, meta.id)?.name ?? null;
    } catch {
      resumePreviousName = null;
    }
  }

  // 分类器。默认规则版；用 --auto 可换成 off 或 llm。
  const classifier = new Classifier(cfg, (args.auto ?? "rule") as ClassifierName);

  // 会话文件先建：记忆桥需要 sessionId 作为审计键，必须在 Agent 构造前就位。
  // --resume：沿用被恢复会话的 id/path（真续接），而不是新开一个 fork。
  const sess = meta ? adoptSession(meta, cfg.model) : createSession(cfg.model, cfg.cwd);

  // 写文件检查点（P0-4）：会话级目录，/undo 用它在写盘后恢复本会话的 write/edit。
  // 只覆盖工具写路径（shell 改动不追），只快照工作目录内文件。
  const checkpoints = new CheckpointStore({ cwd: cfg.cwd, sessionId: sess.meta.id });
  /** 按轮次回滚（issue #27）：轮次表从 session meta 恢复，回滚后写回。 */
  const rewindLog = new RewindLog({ records: sess.meta.rewind });

  // issue #23：语言服务器（编辑后诊断 + 只读符号导航）。零配置 = 不 spawn。
  void lspServers
    .configure(cfg)
    .then((problems) => {
      if (!interactiveTTY) return;
      for (const p of problems) ui.warn(`LSP: ${p}`);
      const st = lspServers.states();
      if (st.length > 0) {
        const ok = st.filter((x) => x.status === "connected").map((x) => x.name).join(", ");
        ui.line(
          c.dim(
            `LSP：${st.length} 个 server（已连接 ${st.filter((x) => x.status === "connected").length}${ok ? `: ${ok}` : ""}）`,
          ),
        );
      }
    })
    .catch(() => {
      /* 语言服务器是增强项，失败不影响会话 */
    });

  // 记忆桥（v0.2 记忆激活）：
  //  - -p / 非交互 = oneshot：只用项目级记忆（服务器脚本场景，不混入操作员个人记忆）；
  //  - plan 模式禁写（captureEnabled=false），召回仍可用。
  const memoryMode: "interactive" | "oneshot" =
    args.print !== null || (args.rest.length > 0 && !process.stdin.isTTY) ? "oneshot" : "interactive";
  // -p / 非交互：全局作用域降为 project（工具、系统提示、捕获都遵守）
  if (memoryMode === "oneshot") cfg.memory.scopeMode = "project";
  const memory: MemoryBridge = createMemoryBridge({
    cfg,
    cwd: cfg.cwd,
    sessionId: sess.meta.id,
    mode: memoryMode,
    captureEnabled: args.mode !== "plan",
    onNotice: (m) => ui.info(m),
  });

  // ---- 跨会话信箱（PRD v1.2）----
  // -p / 非交互模式不启用（D7 裁决）：不建目录、不注册工具、不跑 tick / watchdog。
  const mailboxEnabled = memoryMode === "interactive";
  let mailbox: Mailbox | null = null;
  if (mailboxEnabled) {
    try {
      mailbox = new Mailbox({ sessionId: sess.meta.id, config: cfg.mailbox });
      const chosen = chooseSessionName({
        explicit: args.name,
        previous: resumePreviousName,
        taken: takenAliveNames(mailbox.root, { deadAfterMs: cfg.mailbox.deadAfterMs }),
      });
      const ident = createIdentity({
        root: mailbox.root,
        sessionId: sess.meta.id,
        cwd: cfg.cwd,
        mode: args.mode,
        name: chosen?.name ?? null,
        deadAfterMs: cfg.mailbox.deadAfterMs,
      });
      sessionLabel = ident.profile.name;
      if (chosen && ident.profile.name && chosen.name !== ident.profile.name) {
        ui.info(`代号 ${chosen.name} 已被占用，本会话使用 ${ident.profile.name}`);
      }
      sweepSessions(mailbox.root, { ttlMs: cfg.mailbox.sessionTtlMs });
    } catch (e) {
      // resume 命中时失败 = 不能安全接手该会话（通常另一个进程刚抢到锁）：
      // sess 已 adopt 原 session-id，继续跑会双写同一会话文件，必须致命退出。
      if (meta) {
        console.error(
          c.err(`✖ 无法恢复会话 ${sess.meta.id}：${(e as Error).message}`) +
            c.dim("\n  另一个进程可能正在恢复/运行该会话；请稍后重试或先退出那个进程。"),
        );
        return 2;
      }
      // 新建会话：信箱是增强项，初始化失败只降级，不阻塞启动
      ui.warn(`跨会话信箱未启用：${(e as Error).message}`);
      mailbox = null;
    }
  }

  // 信箱不可用：本地仍选一个池内名，仅用于标题显示（不落盘、不参与寻址）。
  if (mailboxEnabled && sessionLabel === null) {
    const local = chooseSessionName({
      explicit: args.name,
      previous: resumePreviousName,
      taken: new Set(),
    });
    sessionLabel = local?.name ?? "neo";
  }

  /** 最近一次入站：对端 session → 消息 id；send_message 缺省 reply_to 时自动补任务号。 */
  const inboundRefs = new Map<string, string>();

  let mailboxTick: ReturnType<typeof setInterval> | null = null;
  let heartbeatTick: ReturnType<typeof setInterval> | null = null;
  let mailboxClosed = false;
  /** 上次 watchdog 检查时间（P1 与 idle tick 共用）。 */
  let lastWatchdogAt = Date.now();
  /** 上次因流式输出刷新 last_progress_at 的时间（节流，避免每个 chunk 写盘）。 */
  let lastStreamProgressAt = 0;
  /** 清理信箱资源（幂等）：停 tick、删 .alive。 */
  function closeMailbox(): void {
    if (mailboxClosed) return;
    mailboxClosed = true;
    if (mailboxTick) {
      clearInterval(mailboxTick);
      mailboxTick = null;
    }
    if (heartbeatTick) {
      clearInterval(heartbeatTick);
      heartbeatTick = null;
    }
    if (mailbox) releaseAlive(mailbox.root, mailbox.sessionId);
  }

  // 心跳必须独立于空闲 tick：turn 进行中（长 LLM 调用）也要每 15s 刷新，
  // 否则别的会话的 watchdog 会看到心跳停 120s+，把正在干活的活进程误报成 dead。
  if (mailbox) {
    const hb = mailbox;
    heartbeatTick = setInterval(() => {
      try {
        mailboxState.touchHeartbeat(hb.root, hb.sessionId);
      } catch {
        // 心跳写失败不阻塞主流程
      }
    }, cfg.mailbox.heartbeatMs);
    (heartbeatTick as unknown as { unref?: () => void }).unref?.();
  }

  /** 轮询 inbox、按入站三态裁决，返回 accept 的消息并打印预览。limit 留空=不限。 */
  function collectInbound(limit?: number): Envelope[] {
    if (!mailbox) return [];
    const mb = mailbox;
    const envs = mb.poll((env) => decideInbound(cfg.crossSessionInbound, agent.mode, env.from.mode), limit);
    for (const env of envs) {
      inboundRefs.set(env.from.session, env.id);
      ui.line(c.dim(formatPreview(env)));
    }
    return envs;
  }

  // 系统提示词唯一渲染入口（issue #20）：档位选择、会话名、项目记忆都由它持有，
  // 探针完成/切模型/rename/超限校正只需让 agent 在下一个请求边界重渲染。
  //
  // issue #20 收尾：系统提示词放不下预算时给**一次性**提示。
  // 归类：不是 #18 所指的「网关缺字段」那类无当下动作的诊断，而是当前配置的直接
  // 后果（提示词塞不进预算 → 模型可用上下文被吃掉一大块），用户当下就能补救。
  // 去重按 provider|model|窗口：同一状态只说一次，窗口变了算新事实。
  let bootBlockPrinted = false;
  const overBudget = makeOverBudgetReporter({
    interactive: interactiveTTY,
    current: () => ({ provider: cfg.providerName, model: cfg.model }),
    log: (message) => logBootDiagnostic({ kind: "prompt-budget", message }),
    warn: (message) => ui.warn(message),
    bootBlockPrinted: () => bootBlockPrinted,
  });
  const onPromptSelection = (sel: PromptSelection): void => overBudget.report(sel);
  const promptManager = new PromptManager({
    mailbox: mailboxEnabled,
    askUser: interactiveTTY,
    sessionName: sessionLabel,
    onSelection: onPromptSelection,
  });
  // issue #17：路径作用域规则（.neo/rules + .claude/rules）。无规则时零额外上下文。
  const projectRules = discoverProjectRules(cfg.cwd);
  const scopedRuleList = projectRules.filter((r) => r.paths.length > 0);
  const alwaysOnRules = projectRules.filter((r) => r.paths.length === 0);

  /** 后台子代理任务表（issue #16）：Agent 构造时要注入轮询闭包，实例在 Agent 之后创建。 */
  let backgroundTasks: BackgroundTasks | null = null;

  const agent = new Agent({
    cfg,
    console: ui,
    mode: args.mode,
    systemPrompt: promptManager.render(cfg).text,
    renderSystemPrompt: () => promptManager.render(cfg).text,
    getSessionName: () => sessionLabel,
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
          const c = composerRef;
          return c ? c.askUser(req) : Promise.resolve({ status: "canceled" as const });
        }
      : undefined,
    cancelAskUser: () => composerRef?.cancelAskUser(),
    // 交互式规划工作流（issue #14）：模型提交方案（exit_plan_mode）后把「待确认」
    // 摆到用户眼前。绝不在这里自动批准 —— 批准是用户的动作。
    requestPlanApproval: () => {
      if (jsonMode) return;
      ui.blank();
      ui.line(`${c.warn("◆")} 方案待确认：${c.dim("/plan approve 开始实施 · /plan revise 修改 · /plan cancel 放弃")}`);
      composerRef?.rerender();
    },
    // -p 单次模式：即使终端是 TTY 也按非交互块级渲染，避免 spinner/ANSI 污染输出
    nonInteractive: args.print !== null,
    // issue #16：后台子代理结果（取走即清）在每次请求前注入。
    pollBackground: () => {
      // issue #45：每次取结果前同步落盘快照（只在变化时写，见 syncBackgroundJobs）。
      syncBackgroundJobs();
      return backgroundTasks?.collectFinished() ?? [];
    },
    pollInbox: mailbox
      ? () => {
          const mb = mailbox;
          if (!mb) return [];
          const frames = collectInbound().map(formatIncomingFrame);
          // P1 也按 watchdog 周期检查委派台账（长时间忙碌时不必等回 idle）。
          const now = Date.now();
          if (now - lastWatchdogAt >= cfg.mailbox.watchdogIntervalS * 1000) {
            lastWatchdogAt = now;
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
      // v0.4.2：分类切档发生在请求之前，提示也必须在请求之前出现（不再等 turn 结束）。
      if (e.type === "tier_switch") {
        if (!jsonMode) {
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
          composerRef?.rerender();
        }
        return;
      }
      if (!mailbox) return;
      const mb = mailbox;
      try {
        if (e.type === "tool_end") {
          // 工具结果回填 = 有进展：watchdog 的 stuck 判定依据（PRD §4.10.3）
          lastStreamProgressAt = Date.now();
          mailboxState.touchProgress(mb.root, mb.sessionId);
        } else if (e.type === "text" || e.type === "reasoning") {
          // 长 LLM 流式输出也是进展：节流 30s 刷一次，避免每个 chunk 写盘。
          const now = Date.now();
          if (now - lastStreamProgressAt >= 30_000) {
            lastStreamProgressAt = now;
            mailboxState.touchProgress(mb.root, mb.sessionId);
          }
        }
      } catch {
        // 状态写入失败不影响主流程
      }
    },
  });

  // 后台子代理任务表（issue #16）：每个任务一个 AbortController；取消走 /tasks cancel
  // 或会话退出，主 turn 的 ESC 不误伤后台任务（见 onCancelTurn 的提示）。
  backgroundTasks = new BackgroundTasks({
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
    if (!backgroundTasks) return;
    sess.meta.backgroundTasks = serializeJobs(backgroundTasks.rawJobs());
    persist(agent.messages, sess.meta);
  };
  // 恢复（issue #45）：旧会话没有该字段 = 空清单；running 一律映射成 interrupted。
  const restoredJobs = restoreJobs(sess.meta.backgroundTasks);
  // 任务结束（done / error / cancelled）时落盘。BackgroundTasks 没有完成回调，
  // 这里用主循环已有的 pollBackground 钩子顺带刷新：每次取结果前先同步快照。
  const syncBackgroundJobs = (): void => {
    if (!backgroundTasks) return;
    const next = serializeJobs(backgroundTasks.rawJobs());
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
          const r = backgroundTasks!.launch(job);
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
          const c = composerRef;
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
          if (!activeTurnFrom) return undefined; // 人类输入的 turn 不自动补 reply_to
          try {
            const p = mb.resolvePeer(target, { requireAlive: true });
            if (p.session !== activeTurnFrom) return undefined;
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
    const n =
      cfg.hooks.hooks.PreToolUse.length +
      cfg.hooks.hooks.PostToolUse.length +
      cfg.hooks.hooks.TurnEnd.length;
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

  // ---- 单次模式 ----
  if (args.print !== null) {
    const prompt = args.print || args.rest.join(" ");
    if (!prompt.trim()) {
      console.error(c.err("✖ -p 需要提供内容"));
      // 此时 MCP server 可能已经连上（连接发生在 -p 分支之前），必须收掉。
      cleanupEphemeralResources();
      return 2;
    }
    // issue #41：斜杠命令是交互模式的能力。这里必须明确提示，而不是把整串当 prompt
    // 静默发给模型（PRD 写的是「命令会明确提示不可用」）。
    const slashCommand = knownSlashCommand(prompt);
    if (slashCommand) {
      console.error(
        c.err(`✖ -p 不解析斜杠命令：/${slashCommand} 只能在交互模式使用（-p 会把内容当成一次任务）`),
      );
      cleanupEphemeralResources();
      return 2;
    }
    // json 模式把 SIGINT 转成 aborted 统计：Ctrl+C 后仍能输出一行 JSON（exit 130），
    // 而不是被信号直接杀掉、编排器拿到空 stdout。
    const onSigint = (): void => agent.cancel();
    if (jsonMode) process.on("SIGINT", onSigint);
    let stats: Awaited<ReturnType<typeof agent.send>>;
    try {
      stats = await agent.send(prompt);
    } catch (e) {
      // 异常退出路径：agent.send 抛错时不能把 MCP 子进程留在后面当孤儿。
      // 收完再原样抛出，让外层（main 的 catch / 进程退出）按原语义处理。
      cleanupEphemeralResources();
      throw e;
    } finally {
      if (jsonMode) process.off("SIGINT", onSigint);
    }
    // 正常结束（含 hadError / aborted）：先收子进程再落盘退出。
    // -p 是「跑完就退」的一次性进程，子进程没有第二次机会被回收。
    // 顺序执行而非 finally：json 输出分支与 return 都在其后，清理必须在
    // persist 之前完成（persist 之后还有 await memory.flush，进程仍活着）。
    // issue #40：清理清单与 shutdown() 共用 cleanupEphemeral —— 旧实现只收 MCP，
    // 于是模型在 -p 里起的后台 shell / 后台子代理 / 语言服务器全成了孤儿。
    cleanupEphemeralResources();
    persist(agent.messages, sess.meta);
    // 单次模式：把记忆写队列在退出前冲刷掉（仅项目级；带超时，不阻塞关闭）
    await memory.flush();

    // 退出码约定（P0-6）：0 成功 / 1 LLM 或 agent 失败 / 2 用法错误 / 130 用户中断
    const exitCode = stats.aborted ? 130 : stats.hadError ? 1 : 0;

    if (jsonMode) {
      // 失败/中断时不要回填历史里的旧 assistant（--resume 场景会误导编排器）。
      const answer =
        stats.hadError || stats.aborted
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
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return exitCode;
    }

    return exitCode;
  }

  // 也允许 `neo 你的问题` 直接作为首轮输入（非交互）
  if (args.rest.length > 0 && !process.stdin.isTTY) {
    const restPrompt = args.rest.join(" ");
    // issue #41：与 -p 同口径，斜杠命令在非交互模式下必须明确拦下。
    const restSlashCommand = knownSlashCommand(restPrompt);
    if (restSlashCommand) {
      console.error(c.err(`✖ 非交互模式不解析斜杠命令：/${restSlashCommand} 只能在交互模式使用`));
      cleanupEphemeralResources();
      return 2;
    }
    try {
      await agent.send(restPrompt);
    } finally {
      // 与 -p 同一条一次性进程路径（issue #40）：子进程必须显式收掉，否则留下孤儿。
      cleanupEphemeralResources();
    }
    persist(agent.messages, sess.meta);
    await memory.flush();
    return 0;
  }

  // ---- 交互模式 ----
  if (process.stdin.isTTY) {
    // 启动输出顺序（issue #18）：banner → shell 行 → 项目记忆提示 → shell 解析告警 → --resume 回放。
    // 记忆提示必须**紧邻**真实 shell 状态行的下一行（用户先看到「在哪跑、用什么 shell」，
    // 再看到「带了哪份项目记忆」），所以注入留在上面、提示行挪到这里，且只打一次。
    // shell 解析告警（如 settings shell.path 不可执行而回退）仍然可见，但排在记忆提示之后：
    // 它插在中间会打断「shell 行 → 记忆提示」的紧邻关系（#18 独立验收 MUST FIX 1）。
    ui.line(banner(cfg.model, cfg.baseUrl, cfg.providerName, tierDisplayName(cfg.modelTier), toolNames().join(" ")));
    // v0.4.0 平台适配层：一眼可见实际使用的 shell，解析告警不静默。
    const bootShell = getShell(cfg);
    const overBudgetNotice = overBudget.takePending();
    for (const row of bootLines({
      shell: c.dim(`  shell ${describeShell(bootShell)}`),
      memory: memoryFile ? `已加载项目记忆 ${memoryFile}` : null,
      // issue #20 收尾：超预算提示排在启动块里（banner 之后），别插到 banner 前面。
      warnings: [
        ...bootShell.warnings,
        ...(overBudgetNotice ? [overBudgetNotice] : []),
      ],
    })) {
      if (row.kind === "shell") ui.line(row.text);
      else if (row.kind === "memory") ui.info(row.text);
      else ui.warn(row.text);
    }
    bootBlockPrinted = true;
    // v0.2.3 D4：--resume 之后屏幕不能是空的 —— 回放最近几轮，人和上下文对齐
    if (restored && restored.length > 0) replayTranscript(ui, agent.messages);
  }

  // ---- 共享：队列 / drain / 输入源抽象（TTY composer 与 readline 共用）----
  let composer: Composer | null = null;
  let titleAnimator: TitleAnimator | null = null;
  let externalShellActive = false;
  let promptInput: () => void = () => {};
  let closeInput: () => void = () => {};
  let selectDeps: SelectDeps = {
    router: { on: ((_k, _fn) => () => {}) as SelectDeps["router"]["on"] },
    isTTY: false,
  };
  // 空闲 tick 的互斥条件（select / 审批问句期间不塞 mailbox 自动 turn）
  let selectActive = false;
  let selectCancel: (() => void) | undefined;
  let questionPending = false;
  let clipboardUnsupportedNotified = false;

  // 输入串行化：粘贴多行或快速回车时，readline 的 line 事件会并发触发。
  // 用队列 + 单 worker 保证处理顺序与输出不交错。
  // M1 粘贴增强（PRD §5.4）：queue 元素升级为 QueuedLine（行文本 + 绑定附件）。
  // 跨会话消息（PRD v1.2 §4.4 P2）：合成行带 origin，与用户行共享同一队列。
  type QueueOrigin = "user" | "mailbox" | "notice";
  interface QueueItem extends QueuedLine {
    origin: QueueOrigin;
    /** mailbox/notice 的来源 session（状态机 turn.from）。 */
    from?: string;
    /** 由 `/loop` 注入的拍（issue #25）：需要像用户输入一样在 scrollback 回显一行。 */
    loop?: boolean;
    /**
     * shell 输入模式（issue #30）提交的命令：text 是命令原文（不含 `!`），
     * 由 drain 直接交给 runShellWithTui —— 不再走「整行 startsWith !」那条，避免双重剥前缀。
     */
    shell?: boolean;
  }
  const queue: QueueItem[] = [];
  let draining = false;
  /** 会话内 turn 序号（状态机审计用）。 */
  let turnSeq = 0;
  /** 连续自动 turn 计数（PRD §4.4 链条上限）；用户输入重置。 */
  let autoTurnChain = 0;
  /** 当前 turn 的 mailbox 触发者；只有它才允许 send_message 自动补 reply_to。 */
  let activeTurnFrom: string | null = null;

  let turnStartedAt = 0;
  let lastTurnMs = 0;
  /** 真正在跑 agent turn（不含斜杠命令/选择菜单）；状态行的时长只认它。 */
  let turnActive = false;
  /**
   * 定时 / 自节奏循环提示（issue #25）。
   *
   * 丢弃条件用 `turnActive`（turn 正在跑）而不是 `draining`：`draining` 在「正在处理
   * /loop 命令」时也为 true，用它会把启动瞬间的第一拍误丢。命令本身不占 turn，
   * 此时把拍入队后 drain 的 while 会自然接上。
   */
  /**
   * 目标驱动自动续跑（issue #24 / #50）。
   *  - 检查命令：用户显式配置（与 hooks 同口径：不经审批、按配置自动跑）；
   *  - 模型判断：只在用户显式 `--judge` 时启用，一次独立小请求，结果标注为「模型判断」。
   */
  const runDriveCheck = async (
    cmd: string,
  ): Promise<{ ok: boolean; code: number | null; output: string }> => {
    const shellSpec = getShell(cfg);
    const inv = prepareShellInvocation(shellSpec, cmd, {
      ...process.env,
      NO_COLOR: process.env.NO_COLOR ?? "1",
    });
    const proc = Bun.spawn(inv.argv, { cwd: cfg.cwd, stdout: "pipe", stderr: "pipe", env: inv.env });
    const timer = setTimeout(() => proc.kill(9), 60_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { ok: code === 0, code, output: `${out}\n${err}`.trim().slice(-800) };
  };
  const drive = new DriveManager({
    runCheck: async (cmd) => {
      try {
        return await runDriveCheck(cmd);
      } catch (e) {
        return { ok: false, code: null, output: `检查命令执行失败：${(e as Error).message}` };
      }
    },
    enqueue: (prompt) => {
      if (turnActive || queue.length > 0) return false;
      // 与 /loop 同款：注入的拍回显一行，用户要知道自动发了什么。
      queue.push({ text: prompt, attachments: [], origin: "user", loop: true });
      composerRef?.setQueueCount(queue.length);
      runDrainSafely();
      return true;
    },
    // issue #50：模型判断 —— 一次独立小请求（与 compactNow 同模式），要求 JSON 输出。
    evaluate: async (input) => {
      const stream = agent.injectedStreamFn ?? chatStream;
      const budget = Math.min(2_000, Math.floor(cfg.contextWindow * 0.05));
      const checkLine = input.lastCheck
        ? `检查命令结果：exit ${input.lastCheck.code ?? "?"}（未通过）\n输出尾部：${input.lastCheck.output.slice(-600)}`
        : "没有配置检查命令。";
      const res = await stream(
        { ...cfg, maxTokens: budget, temperature: 0 },
        [
          {
            role: "system",
            content:
              "你是完成条件判定器。只根据给出的工具输出判断目标是否达成。" +
              "不要臆测没有出现在输出里的结果；不确定就判 false。" +
              '只输出一行 JSON：{"done": true|false, "reason": "一句话理由"}。',
          },
          {
            role: "user",
            content:
              `【目标提示】\n${input.prompt}\n\n` +
              `【完成标准】\n${input.criteria}\n\n` +
              `【${checkLine}】\n\n` +
              `【最近一轮工具输出（可能已截断）】\n${input.recentOutput || "（无）"}`,
          },
        ],
        [],
        {},
      );
      const text = res.content.trim();
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      if (!json) return { done: false, invalid: true };
      try {
        const parsed = JSON.parse(json) as { done?: unknown; reason?: unknown };
        if (typeof parsed.done !== "boolean") return { done: false, invalid: true };
        return {
          done: parsed.done,
          ...(typeof parsed.reason === "string" && parsed.reason.trim() !== ""
            ? { reason: parsed.reason.trim() }
            : {}),
        };
      } catch {
        return { done: false, invalid: true };
      }
    },
    onEnd: (state, action) => {
      if (action === "continue") {
        ui.info(`自动续跑（第 ${state.rounds}/${state.spec.maxRounds} 轮）：条件未达成，已再排一轮`);
      } else if (action === "done") {
        // issue #50：来源决定文案 —— verified 才能说「已验证」，model 只能说「模型判断」。
        if (state.source === "verified") ui.success(state.reason ?? "目标达成（已验证）");
        else ui.success(state.reason ?? "目标达成（模型判断）");
      } else {
        ui.warn(state.reason ?? "自动续跑已暂停");
      }
    },
  });

  const loopScheduler = new LoopScheduler({
    enqueue: (prompt) => {
      if (turnActive || queue.length > 0) return false;
      queue.push({ text: prompt, attachments: [], origin: "user", loop: true });
      composerRef?.setQueueCount(queue.length);
      runDrainSafely();
      return true;
    },
  });
  let pasteTextCounter = 0; // chip 编号会话内递增（PRD §3），图片/文本各自独立
  let pasteImageCounter = 0;

  // 文件索引：@ 补全的唯一来源。启动预热一次（2 万文件 ~75ms），按键路径只读缓存。
  const fileIndex = new FileIndex({ cwd: cfg.cwd });
  // 不阻塞首帧：composer 先起来，索引在后台刷新（Tab 路径有 in-flight 去重）。
  const fileIndexPreheat = process.stdin.isTTY
    ? fileIndex.refresh().catch(() => {
        // 索引失败不影响会话：后续 Tab 会再踢一次刷新
      })
    : Promise.resolve();

  /** 人类输入统一入口（readline 的 line 事件与 composer 的 onSubmit 都走这里）。 */
  function submitUserLine(raw: string, attachments: Attachment[]): void {
    const line = raw.trim();
    if (!line) return;
    const bound = bindAttachments(line, attachments);
    queue.push({ text: line, attachments: bound, origin: "user" });
    composerRef?.setQueueCount(queue.length);
    runDrainSafely();
  }

  /**
   * 取一个可能还在 TDZ 里的 `const` 绑定：未初始化时返回 null 而不是抛错。
   *
   * `typeof x` 对 `let`/`const` 的 TDZ **不安全**（实测 Bun 1.3.13 仍抛
   * ReferenceError），所以只能靠 try/catch。
   */
  function tdzSafe<T>(read: () => T): T | null {
    try {
      return read();
    } catch {
      return null;
    }
  }

  /**
   * 本会话所有临时资源的清理入口（issue #40）：`shutdown()` / `-p` / 非交互路径共用。
   *
   * 清单与顺序在 `src/cleanup.ts`（唯一真源），这里只做依赖绑定。
   * 同步、幂等、逐项容错 —— 所以 `-p` 的异常路径也能在 `throw` 之前安全调用。
   *
   * 注意 `loopScheduler` / `drive` 是 `const`，声明在 `-p` 分支**之后**（index.ts 的
   * 组合顺序），在 `-p` 路径上访问会命中 TDZ 抛 ReferenceError。
   * `typeof` 挡不住 TDZ（它只对「未声明」安全，对「已声明未初始化」照样抛），
   * 所以用 try/catch 取值：`-p` 分支跑的时候它们根本还没创建，本来也不需要清理。
   */
  function cleanupEphemeralResources(): void {
    cleanupEphemeral({
      loop: tdzSafe(() => loopScheduler),
      drive: tdzSafe(() => drive),
      tasks: backgroundTasks,
      shells: backgroundShells,
      lsp: lspServers,
      mcp: mcpManager,
      closeMailbox,
    });
  }

  /** 退出：两类输入源都收敛到 closeInput()。 */
  async function shutdown(): Promise<void> {
    // issue #45：退出前把后台任务表的最新状态同步进 session（任务可能在上一次请求之后才完成）。
    syncBackgroundJobs();
    // issue #40：资源清理统一走 cleanupEphemeral（与 -p / 非交互路径同一份清单）。
    cleanupEphemeralResources();
    try {
      await memory.flush();
    } catch {
      // 记忆失败不阻止退出
    }
    persist(agent.messages, sess.meta);
    ui.blank();
    ui.line(c.dim("再见。"));
    closeInput();
    process.exit(0);
  }

  /** `!cmd`：TTY 下先让出终端（cooked + 显示光标 + 擦帧），命令跑完再恢复自绘帧。 */
  async function runShellWithTui(cmd: string): Promise<void> {
    const command = cmd.trim();
    if (!command) return;
    if (!composer || composer.isSuspended) {
      await runShell(command, cfg, ui, agent.mode);
      return;
    }
    // issue #34：授权（ask 模式下会弹 y/N 确认框）必须在挂起输入框**之前**。
    // 旧顺序是先 suspend 再 runShell，而确认框要靠 composer 渲染 —— 挂起后 composer
    // 既不渲染也不收键，确认框永远不出现，shell 永远不执行（表面像「输入失效」的死锁）。
    const verdict = await authorizeShell(command, ui, agent.mode);
    if (verdict === "plan") {
      ui.warn(`plan 模式禁止执行 shell：${command}`);
      return;
    }
    if (verdict === "deny") {
      ui.info("已拒绝。");
      return;
    }
    externalShellActive = true;
    composer.suspend();
    try {
      await executeShell(command, cfg, ui);
    } finally {
      externalShellActive = false;
      composer.resume();
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
    while (queue.length > 0) {
      const q = queue.shift();
      if (!q) continue;
      try {
      composerRef?.setQueueCount(queue.length);
      const line = q.text;
      if (!line) continue;
      const origin = q.origin;

      if (origin === "user") {
        // issue #25：循环注入的拍不是用户亲手敲的，必须回显一行，否则用户不知道自动发了什么。
        if (q.loop) ui.line(`${c.accent("❯ ")}${c.text(line)}`);
        // issue #30：输入态 shell 模式提交的命令（原文，无 `!`）直接执行。
        if (q.shell) {
          await runShellWithTui(line);
          continue;
        }
        if (line.startsWith("!")) {
          await runShellWithTui(line.slice(1));
          continue;
        }
        if (line.startsWith("/")) {
          await dispatchCommand(line, {
            agent,
            ui,
            cfg,
            memory,
            classifier,
            meta: sess.meta,
            shutdown,
            selectDeps,
            mailbox,
            checkpoints,
            injectMailbox: (env) => {
              ui.line(c.dim(formatPreview(env)));
              queue.push({ text: formatIncomingFrame(env), attachments: [], origin: "mailbox", from: env.from.session });
            },
            onMailboxRekey: () => inboundRefs.clear(),
            // /context 要展示「当前 cfg 下会选哪一档」：探针回写窗口后到下一轮边界之间，
            // lastSelection 还是探针前的旧档，会和同一命令里的 window 行（读 cfg，已是新值）
            // 自相矛盾。currentSelection 只算不写 —— 不碰 messages[0]，提示词何时生效不受影响。
            promptSelection: () => promptManager.currentSelection(cfg),
            // issue #17：规则条数与命中原因（/context 展示）。
            rules: () => ({ alwaysOn: alwaysOnRules, loaded: agent.activeRules, total: projectRules.length }),
            // issue #20 收尾：工具可见集 dry-run（只算不生效，运行时工具集不变）。
            toolVisibility: () => promptManager.currentVisibility(cfg),
            onNameChange: (name) => {
              sessionLabel = name;
              titleAnimator?.setName(name);
              // issue #19：名字进了系统提示词身份句，rename 后必须重建，否则模型仍自称旧名。
              promptManager.setSessionName(name);
              agent.refreshSystemPrompt();
            },
            // issue #13：/技能名 把合成消息排进队列，由 drain 的 while 在下一轮取出。
            // 不在这里直接 agent.send —— drain 正在跑，重入会打乱 draining 状态机。
            enqueueUserTurn: (text) => {
              queue.push({ text, attachments: [], origin: "user" });
              composerRef?.setQueueCount(queue.length);
            },
            memoryMode,
            todos: () => sessionTodos,
            mcp: () => mcpManager.statuses(),
            // issue #25：定时/自节奏循环（仅交互会话；-p 不传 → 命令提示不可用）
            loop: {
              start: (spec) => loopScheduler.start(spec),
              stop: () => loopScheduler.stop(),
              status: () => formatLoopStatus(loopScheduler.state, Date.now()),
            },
            // issue #24：目标驱动自动续跑（完成条件 = 检查命令 exit 0）
            drive: {
              start: (spec) => drive.start(spec),
              stop: () => drive.stop(),
              status: () => formatDriveState(drive.state),
            },
            // issue #27：按轮次回滚（代码 / 对话 / 两者）
            rewind: {
              list: () => rewindLog.list(),
              apply: (target, mode) => {
                const r = rewindLog.rewind({
                  target,
                  mode: mode as RewindMode,
                  store: { undoSeqs: (seqs) => checkpoints.undoSeqs(seqs) },
                  conversation: {
                    length: () => agent.messages.length,
                    truncate: (n) => {
                      agent.messages.length = Math.max(1, n); // 永远保住 messages[0] 系统提示
                    },
                  },
                });
                sess.meta.rewind = rewindLog.serialize();
                persist(agent.messages, sess.meta);
                return r;
              },
              // issue #46：用户轮次 → 该轮起点的消息下标（定点 compact 的锚点）。
              turnStart: (target) => {
                const turns = rewindLog.list();
                if (turns.length === 0) return null;
                const idx = target === "last" ? turns.length - 1 : target;
                return turns[idx]?.messagesBefore ?? null;
              },
            },
            // issue #28：后台长驻 shell（列表 / 停止）
            shells: {
              list: () => backgroundShells.list(),
              kill: (target) => backgroundShells.kill(target),
            },
            // issue #16：后台子代理任务（列表 / 取消）
            // issue #45：本进程没有任务时，回落到 resume 载入的只读历史（running 已映射成 interrupted）。
            tasks: {
              list: () => {
                const live = backgroundTasks?.list() ?? [];
                return live.length > 0 ? live : restoredJobs;
              },
              cancel: (target) => backgroundTasks?.cancel(target) ?? 0,
              // issue #48：续聊 —— 读回该任务的子代理对话，追加用户消息后继续跑。
              // 恢复后的任务没有活 Agent，这里重建一个（AbortController 也重新建）。
              chat: async (id, text) => {
                const messages = loadSubagentTranscript(sess.meta.id, id);
                if (!messages || messages.length === 0) {
                  return {
                    ok: false as const,
                    error: `任务 ${id} 没有可续聊的对话记录（可能未落盘或已被清理）。`,
                  };
                }
                const ctrl = new AbortController();
                const ctx: ToolCtx = {
                  cfg,
                  approve: (_tool, detail) => ui.confirm(detail),
                  checkpoint: checkpoints,
                  signal: ctrl.signal,
                };
                try {
                  const reply = await runSubagent(agent, text, undefined, ctx, undefined, {
                    messages,
                    onMessages: (msgs) => saveSubagentTranscript(sess.meta.id, id, msgs),
                  });
                  return { ok: true as const, reply };
                } catch (e) {
                  return { ok: false as const, error: `续聊失败：${(e as Error).message}` };
                }
              },
            },
          });
          continue;
        }
        autoTurnChain = 0;
        if (mailbox) {
          try {
            mailboxState.noteHumanInput(mailbox.root, mailbox.sessionId);
          } catch {
            // 状态写入失败不阻塞交互
          }
        }
      } else {
        autoTurnChain++;
      }

      // 合成行（mailbox/notice）文本已经是 frame 后的内容，不经命令分发、不做 chip 还原。
      // v0.2.4 C3：先展开 @ 引用，再做 chip 还原 ——
      // 反过来会把「粘贴内容里恰好出现的 @foo」也当成引用展开（用户并没有这个意图）。
      const expanded =
        origin === "user"
          ? expandReferences(line, { cwd: cfg.cwd })
          : { text: line, refs: [], errors: [] as string[] };
      const resolved =
        origin === "user"
          ? resolveLine(expanded.text, q.attachments)
          : { text: line, images: [] as string[] };
      if (expanded.refs.length > 0) {
        // issue #17：用户 @ 引用算触达（规则只看路径，不看被引用内容）。
        agent.noteTouchedPaths(
          expanded.refs
            .map((r) => normalizeRelPath(cfg.cwd, r.path))
            .filter((p): p is string => p !== null && p !== "."),
        );
        const lines = expanded.refs.reduce((n, r) => n + r.lines, 0);
        ui.line(c.dim(`· 已引用 ${expanded.refs.length} 个文件（+${lines} 行）`));
      }
      for (const e of expanded.errors) ui.line(c.dim(`· ${e}`));
      if (resolved.images.length > 0) {
        // PRD §5.8：用户对「发出去了什么」有知情权（图片可能含敏感信息）
        ui.line(c.dim(`· 已发送图片 ×${resolved.images.length}`));
      }
      ui.blank();
      turnStartedAt = Date.now();
      turnActive = true;
      composerRef?.setBusy(true);
      let outcome: "ok" | "aborted" | "error" = "ok";
      activeTurnFrom = origin === "user" ? null : (q.from ?? null);
      if (mailbox) {
        try {
          mailboxState.beginTurn(mailbox.root, mailbox.sessionId, {
            seq: ++turnSeq,
            source: origin === "user" ? "user" : "mailbox",
            from: origin === "user" ? null : (q.from ?? null),
          });
        } catch {
          // 状态机失败不阻塞 turn
        }
      }
      // issue #27：轮次记账（回到「发这句话之前」的锚点）。begin 必须在 send 之前 ——
      // agent.send 会把 user 消息压进 messages，之后就拿不到精确边界了。
      const rewindPending = rewindLog.beginTurn({
        prompt: resolved.text,
        messagesLength: agent.messages.length,
        checkpointSeqBefore: checkpoints.list(1)[0]?.seq ?? 0,
        // issue #42：只有用户亲自发的轮次才是 /rewind 目标；跨会话 / 通知 / loop·drive 注入记为自动轮
        // （仍要记账，回滚用户轮次时它们的文件检查点也要一起恢复）。
        source: origin === "user" && !q.loop ? "human" : "auto",
      });
      let turnStats: Awaited<ReturnType<typeof agent.send>> | null = null;
      try {
        // ESC 回滚语义（PRD §4.11 裁决 A）：人类输入的 turn 保留回滚；
        // 由 mailbox / 状态通知触发的自动 turn 只停不删（否则会连任务消息与已完成结果一起抹掉）。
        turnStats = await agent.send(
          resolved.images.length > 0 ? { text: resolved.text, images: resolved.images } : resolved.text,
          { rollbackOnAbort: origin === "user" },
        );
        outcome = outcomeOf(turnStats);
        if (turnStats.hadError || turnStats.emptyResponse) {
          ui.error(`本轮未完成：${turnStats.errorMessage ?? "模型未产出正文"}`);
          ui.line(c.dim("  诊断日志：~/.neo/logs/turns/（可用 NEO_LOG_DIR 覆盖）"));
        }
        ui.blank();
        ui.blank();
        showStats(ui, agent, cfg, turnStats);
        const last: LastTurnMeta = {
          at: new Date().toISOString(),
          outcome,
          finishReason: turnStats.finishReason,
          errorMessage: turnStats.errorMessage,
          durationMs: turnStats.durationMs,
          promptTokens: turnStats.promptTokens,
          completionTokens: turnStats.completionTokens,
        };
        sess.meta.lastTurn = last;
      } catch (e) {
        outcome = "error";
        ui.error(`未捕获异常: ${(e as Error).message}`);
        sess.meta.lastTurn = {
          at: new Date().toISOString(),
          outcome: "error",
          finishReason: null,
          errorMessage: (e as Error).message,
        };
        // C9：本轮带图且请求失败 → 追加一行软提示（无法可靠区分「服务端拒绝图片」
        // 与其他 4xx，用软提示近似 PRD 要求，不误导为确定结论）
        if (resolved.images.length > 0) ui.line(c.dim("  当前 provider 可能不支持图片输入"));
        if (process.env["NEO_DEBUG"]) console.error(e);
      } finally {
        turnActive = false;
        composerRef?.setBusy(false);
        // issue #25：self 节奏循环在「每轮结束」后排下一拍（interval 模式自己在定时器里排）。
        loopScheduler.onTurnEnd();
        // issue #24：目标驱动续跑 —— 每轮结束跑检查命令，未通过则自动再排一轮。
        // issue #50：把最近一轮的工具输出摘要交给 judge（截断并标注，PRD §2.3）。
        const recentToolOutput = agent.messages
          .filter((m) => m.role === "tool")
          .slice(-4)
          .map((m) => `tool(${m.name ?? ""}): ${contentText(m.content) ?? ""}`)
          .join("\n");
        const clipped =
          recentToolOutput.length > 2_000
            ? `${recentToolOutput.slice(-2_000)}\n…[已截断，只保留最近 2000 字符]`
            : recentToolOutput;
        void drive
          .onTurnEnd({ toolCalls: turnStats?.toolCalls ?? 0, recentOutput: clipped })
          .catch((e: unknown) => {
            ui.warn(`自动续跑检查失败：${(e as Error).message}`);
          });
        // issue #27：把本轮新产生的检查点归到这一轮，并写回 session meta。
        try {
          const newSeqs = checkpoints
            .list(1_000)
            .filter((e) => e.seq > rewindPending.checkpointSeqBefore)
            .map((e) => e.seq);
          rewindLog.endTurn(rewindPending, newSeqs);
          sess.meta.rewind = rewindLog.serialize();
        } catch {
          /* 轮次记账失败不影响主流程 */
        }
        lastTurnMs = turnStartedAt > 0 ? Date.now() - turnStartedAt : 0;
        activeTurnFrom = null;
        if (mailbox) {
          try {
            mailboxState.endTurn(mailbox.root, mailbox.sessionId, {
              outcome,
              abortSource: outcome === "aborted" ? "human" : outcome === "error" ? "error" : null,
            });
          } catch {
            // 状态机失败不阻塞交互
          }
        }
      }
      persist(agent.messages, sess.meta);
      } catch (e) {
        // 单条输入失败只丢这一条：命令/工具抛错不能让 draining 永久卡死。
        ui.error(`处理输入失败: ${(e as Error).message}`);
      }
    }
    } finally {
      draining = false;
      composerRef?.setQueueCount(queue.length);
      promptInput();
    }
  }

  /** 所有触发点统一走安全包装：drain 异常时复位 draining 并恢复提示符。 */
  function runDrainSafely(): void {
    void drain().catch((e: unknown) => {
      draining = false;
      ui.error(`队列处理异常: ${(e as Error).message}`);
      promptInput();
    });
  }

  /**
   * P2 空闲 tick（PRD §4.4）：
   *  - 只在 draining=false && queue 空 && !questionPending && !selectActive 时工作；
   *  - inbox 每 1s 检查一次（消息落盘后静坐也能收到）；
   *  - 委派 watchdog 每 cross_session_watchdog_interval_s（默认 120s）检查一次；
   *  - 自动 turn 链超过上限时暂停拉取（用户输入会重置）。
   */
  const runIdleTick = (): void => {
    if (!mailbox) return;
    if (draining || queue.length > 0 || selectActive || questionPending) return;
    if (autoTurnChain >= cfg.mailbox.autoTurnLimit) return;

    const now = Date.now();
    const remaining = cfg.mailbox.autoTurnLimit - autoTurnChain;
    if (remaining <= 0) return;
    if (now - lastWatchdogAt >= cfg.mailbox.watchdogIntervalS * 1000) {
      lastWatchdogAt = now;
      try {
        for (const n of mailbox.watchdog()) {
          if (queue.length >= remaining) break;
          ui.line(c.dim(formatNoticePreview(n)));
          queue.push({ text: formatNotice(n), attachments: [], origin: "notice", from: n.target_id });
        }
      } catch {
        // watchdog 失败不阻塞交互
      }
    }
    if (queue.length === 0) {
      for (const env of collectInbound(remaining)) {
        queue.push({ text: formatIncomingFrame(env), attachments: [], origin: "mailbox", from: env.from.session });
      }
    }
    if (queue.length > 0) runDrainSafely();
  };

  if (mailbox) {
    mailboxTick = setInterval(runIdleTick, 1000);
    // 不让 tick 阻止进程退出（Bun 定时器都有 unref）
    (mailboxTick as unknown as { unref?: () => void }).unref?.();
  }

  // 状态条每帧都会问 ctx；contextUsage() 会遍历全部 messages + stringify tools，
  // 500ms 节流一次即可（两位有效数字，人眼分辨不出）。
  let ctxCacheValue = 0;
  let ctxCacheAt = 0;
  const ctxUsage = (): number => {
    const now = Date.now();
    if (now - ctxCacheAt >= 500) {
      ctxCacheValue = agent.contextUsage();
      ctxCacheAt = now;
    }
    return ctxCacheValue;
  };

  // ---- 输入源二选一：TTY 用 composer（底部 live 帧）；非 TTY 保留 v0.2.4 readline ----
  if (interactiveTTY) {
    composer = new Composer({
      stdin: process.stdin as unknown as NodeJS.ReadStream,
      stdout: process.stdout,
      getStatus: (): ComposerStatus => ({
        version: VERSION,
        model: cfg.model,
        tier: tierDisplayName(cfg.modelTier),
        mode:
          args.mode === "auto-edit" ? "edit" : args.mode === "auto-all" ? "yolo" : args.mode,
        // 规划态（issue #14）单独显示，避免与 /mode plan 的只读闸门混淆。
        planning: agent.planning,
        branch: getBranch(cfg.cwd),
        ctxUsage: ctxUsage(),
        elapsedMs: turnActive ? Math.max(0, Date.now() - turnStartedAt) : lastTurnMs,
        active: turnActive,
        tokensTotal: agent.cumulative.prompt + agent.cumulative.completion,
        todosSummary: todosSummary(sessionTodos),
      }),
      commands: COMMANDS,
      files: () => fileIndex.list(),
      onSubmit: (text, attachments) => submitUserLine(text, attachments as Attachment[]),
      // issue #30：输入态 shell 模式 → 入队标记 shell，由 drain 直接跑 shell（与 `?` 悬浮态解耦）
      onShellCommand: (command) => {
        queue.push({ text: command, attachments: [], origin: "user", shell: true });
        composerRef?.setQueueCount(queue.length);
        runDrainSafely();
      },
      onExit: () => {
        void shutdown();
      },
      onCancelTurn: () => {
        agent.cancel();
        // issue #16：ESC 只取消当前 turn —— 后台任务是独立的，误杀会让用户白等。
        // 有在跑的就把出口指出来，别让人以为 ESC 也把后台一起停了。
        const running = backgroundTasks?.runningCount ?? 0;
        if (running > 0) ui.line(c.dim(`· ${running} 个后台子代理仍在运行（/tasks cancel 可取消）`));
      },
      pasteText: (text) => {
        pasteTextCounter += 1;
        const att = makeTextAttachment(pasteTextCounter, text);
        return { chip: att.chip, attachment: att };
      },
      pasteImage: async () => {
        // v0.4.0：Linux 暂无剪贴板图片实现（PD-2），直接当作无图。
        if (clipboardImagePlatform() === "unsupported") return null;
        const img = await readClipboardImage();
        if (!img) return null;
        if (img.data.length > cfg.paste.imageMaxBytes) {
          throw new Error(
            `图片超过 ${(cfg.paste.imageMaxBytes / 1024 / 1024).toFixed(0)}MB 上限`,
          );
        }
        pasteImageCounter += 1;
        const att = makeImageAttachment(pasteImageCounter, img.data);
        return { chip: att.chip, attachment: att };
      },
      paste: { foldLines: cfg.paste.foldLines, foldChars: cfg.paste.foldChars },
      beforeUserCommit: () => dock?.flushPending(),
      onResize: () => dock?.resize(),
      // issue #47：交互式 rewind 菜单（空闲连按两次 Esc）。与 /rewind 命令同一份 apply 逻辑。
      rewind: {
        list: () => rewindLog.list(),
        apply: (target, mode) => {
          const r = rewindLog.rewind({
            target,
            mode,
            store: { undoSeqs: (seqs) => checkpoints.undoSeqs(seqs) },
            conversation: {
              length: () => agent.messages.length,
              truncate: (n) => {
                agent.messages.length = Math.max(1, n);
              },
            },
          });
          sess.meta.rewind = rewindLog.serialize();
          persist(agent.messages, sess.meta);
          return r;
        },
      },
    });
    composerRef = composer;
    titleAnimator = new TitleAnimator({});
    titleAnimator.setName(sessionLabel ?? "neo");
    composer.setTitleAnimator(titleAnimator);
    ui.setAsker((q: string) => composer!.ask(q));
    selectDeps = {
      isTTY: true,
      router: { on: ((_k, _fn) => () => {}) as SelectDeps["router"]["on"] },
      asker: (q: string) => composer!.ask(q),
      clearLine: () => {},
      onActiveChange: () => {},
      present: (question, options, initial) => {
        selectActive = true;
        return composer!.choose(question, options, initial).finally(() => {
          selectActive = false;
        });
      },
    };
    closeInput = () => composer!.stop();
    promptInput = () => composer!.rerender();
    const onSigintTui = (): void => {
      // !cmd 在跑时把 Ctrl+C 让给子进程（父进程别退出/别取消 turn）。
      if (externalShellActive) return;
      void shutdown();
    };
    const onCrash = (e: unknown): void => {
      try { composer?.stop(); } catch { /* 尽力还原 */ }
      // MCP 子进程不能留在崩溃路径上：否则用户重开 neo 会看到一堆孤儿 node。
      try { mcpManager.closeAll(); } catch { /* 清理失败不掩盖原异常 */ }
      console.error(c.err(`✖ 未捕获异常，终端已还原：${(e as Error)?.message ?? String(e)}`));
      process.exit(1);
    };
    const onTerm = (): void => {
      try { composer?.stop(); } catch { /* 尽力还原 */ }
      try { mcpManager.closeAll(); } catch { /* 同上 */ }
      process.exit(143);
    };
    process.on("SIGINT", onSigintTui);
    process.once("uncaughtException", onCrash);
    process.once("unhandledRejection", onCrash);
    process.once("SIGTERM", onTerm);
    process.once("SIGHUP", onTerm);
    try {
      composer.start();
      // 启动前的 banner / 记忆提示 / --resume 回放：补写到帧上方（顺序不变）
      if (preComposerRows.length > 0) {
        composer.commitAbove([...preComposerRows]);
        preComposerRows.length = 0;
      }
      await fileIndexPreheat;
      await composer.closed;
    } finally {
      composer.stop();
      process.off("SIGINT", onSigintTui);
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onTerm);
    }
  } else {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.accent("❯")} `,
    historySize: 200,
    // M0 探针（docs/v0.2.4-m0-probes[done].md P1/P3）：真 PTY 下 bun 原生 completer **可用**，
    // 但不传它时 Tab 会被当字面量 `\t` 插进行缓冲。这里注册一个返回空候选的 no-op：
    // 让 readline 不插字符、也不做自己的补全，Tab 的语义统一交给 HotkeyRouter
    // （我们需要 @ 与 / 同一套排序 + token 精确替换；原生 completer 没有 cursor 入参）。
    // 将来若想迁回原生 completer，删掉这个 no-op 并改 onTab 即可 —— 路线是通的。
    completer: (line: string) => [[], line] as [string[], string],
  });
    const rlC = rl;
  const prompt = (): void => {
    rl.prompt();
  };

  // v0.2.3 D5：把「重绘提示符」交回 readline（保留行缓冲与已敲入的字符）。
  // flashNotice 只负责清行 + 写提示 + 换行，绝不自己画 ❯。
  ui.setPromptRestorer(() => {
    (rl as unknown as { _refreshLine?: () => void })._refreshLine?.();
  });

  // v0.2.3 D2：宽度变化时不再用失效坐标去覆盖行（否则会吃掉用户正在输入的行）。
  const onResize = (): void => {
    ui.handleResize();
  };
  if (process.stdout.isTTY) process.stdout.on("resize", onResize);

  // ---- v0.2.4 输入层 ----
  // Tab 由我们自己接管（readline 只挂 no-op completer）：摘掉可能被插入的 `\t`
  // → 计算候选 → 改写 rl.line/cursor → 重绘。
  // 为什么不用原生 completer：它只给整行、不给光标位置，且候选样式/排序不可控；
  // 而 `@` 需要「光标前 token 精确替换」。M0 文档 P1/P2 记录了这些限制。
  type RlInternal = { line: string; cursor: number; _refreshLine?: () => void; history?: string[] };
  const rlInternal = (): RlInternal => rl as unknown as RlInternal;
  /**
   * 连续 Tab 的候选循环状态。
   *
   * 关键：第二按 Tab 时行内容已经变成「上一次插入的候选」，此时 triggerAt 的 token
   * 也变成了候选本身 —— 不能拿 token 当循环身份（旧实现因此第二按就重新搜索、
   * 候选集缩小，首轮候选永远轮不到）。正确做法是记住「上次应用后的整行 + 插入区间」，
   * 只有当当前行与它完全一致（用户没编辑过）时才继续在**同一批候选**里推进。
   */
  interface TabCycle {
    start: number;
    matches: string[];
    index: number;
    /** 上次应用后的整行，用于判断用户是否改过。 */
    applied: string;
    /** 上次应用后的光标位置。 */
    cursorAfter: number;
  }
  let tabCycle: TabCycle | null = null;

  /**
   * 把整行写回 readline 并重绘（Tab 补全 / 续行清空共用）。
   *
   * 实测（PTY，bun 1.3.13）：无参 `rl.prompt()` 会把 rl.cursor **归零**
   * （line="ABC"/cursor=3 调用后 cursor=0，再输入 X 得到 "XABC"）；
   * `_refreshLine()` 保留 cursor。两个都调会画两遍提示符（`❯ ❯ ...`）。
   * 所以固定用 _refreshLine，prompt() 只作缺失时的兜底。
   */
  const applyLine = (line: string, cursor: number): void => {
    const r = rlInternal();
    r.line = line;
    r.cursor = cursor;
    process.stdout.write("\r\x1b[2K"); // 清掉 readline 已经画出的旧行
    if (r._refreshLine) r._refreshLine();
    else rl.prompt();
  };

  /** 同一次触发里取第 index 个候选替换进整行（首次补全与连按循环共用）。 */
  const applyLineMatches = (
    line: string,
    cursor: number,
    start: number,
    matches: string[],
    index: number,
  ): { line: string; cursor: number } => {
    const match = matches[index];
    return match === undefined ? { line, cursor } : applyMatch(line, cursor, start, match);
  };

  const formatCandidates = (kind: "file" | "command", matches: string[]): string =>
    `· ${formatCandidateHint(kind, matches)}`;

  const onTab = (): void => {
    const r = rlInternal();
    const buf = r.line ?? "";
    let cursor = typeof r.cursor === "number" ? r.cursor : buf.length;
    // 兜底：若 readline 仍把 Tab 当普通字符插进缓冲，先摘掉（守卫提前返回时也不要留脏字符）
    let line = buf;
    if (cursor > 0 && buf[cursor - 1] === "\t") {
      line = buf.slice(0, cursor - 1) + buf.slice(cursor);
      cursor -= 1;
    }
    // 该不该接管：draining 期间写 stdout/清行会和流式输出抢同一行
    if (draining || selectActive || questionPending) {
      if (line !== buf) applyLine(line, cursor);
      return;
    }

    // 连按 Tab：与上次应用结果完全一致（用户没编辑）→ 在同一批候选里推进
    if (tabCycle && line === tabCycle.applied && cursor === tabCycle.cursorAfter) {
      const index = (tabCycle.index + 1) % tabCycle.matches.length;
      const applied = applyLineMatches(line, cursor, tabCycle.start, tabCycle.matches, index);
      tabCycle = { ...tabCycle, index, applied: applied.line, cursorAfter: applied.cursor };
      applyLine(applied.line, applied.cursor);
      return;
    }

    // 命令行走 / 分支，不提供 @ 引用补全（否则用户补出来的 @x 在提交时会被静默忽略）
    const ctx = triggerAt(line, cursor);
    if (!ctx || (ctx.kind === "file" && line.trimStart().startsWith("/"))) {
      if (line !== buf) applyLine(line, cursor);
      tabCycle = null;
      return;
    }

    const result = completeLine(line, {
      files: ctx.kind === "file" ? fileIndex.list() : [],
      commands: COMMANDS,
      cursor,
    });
    if (!result || result.matches.length === 0) {
      if (line !== buf) applyLine(line, cursor);
      tabCycle = null;
      return;
    }
    const applied = applyLineMatches(line, cursor, result.start, result.matches, 0);
    tabCycle = {
      start: result.start,
      matches: result.matches,
      index: 0,
      applied: applied.line,
      cursorAfter: applied.cursor,
    };
    // 多候选第一次给出提示：列出候选名（命令带说明），让用户知道有什么可选
    if (result.matches.length > 1 && queue.length === 0) {
      // 提示必须自己以换行结尾：applyLine 的第一步是 `\r\x1b[2K`，
      // 如果光标还停在提示行尾，提示会被同一行清掉（PTY 实测：屏幕上永远看不到）。
      process.stdout.write(`\n${c.dim(formatCandidates(ctx.kind, result.matches))}\n`);
    }
    applyLine(applied.line, applied.cursor);
  };

  // ---- v0.2.4 C4 多行：continuation 状态机 ----
  // Ctrl+J(0x0A) 与 Enter(0x0D) 在 keypress 上可区分，但 keypress 与 line 事件的先后
  // 实测不可靠（同一次回车顺序随分块变化）；stdin 的 data 比 readline 处理更早，
  // 用 prependListener 记下换行字节，在 line 事件里读 —— 这是唯一稳定的判定方式。
  let continuation: Continuation = emptyContinuation();
  /** 换行种类队列：一个 stdin 数据块可能产生多个 line 事件，按序消费；队空按 Enter。 */
  const newlineQueue: Array<"lf" | "cr"> = [];
  if (process.stdin.isTTY) {
    process.stdin.prependListener("data", (buf: Buffer) => {
      newlineQueue.push(...newlineKindsFromBytes(buf));
    });
  }
  const promptForContinuation = (): void => {
    rl.setPrompt(c.accent(continuationPrompt(continuation)));
  };

  /**
   * readline 只把「非空且非纯空白」的行走进 history（PTY 实测）。
   * 续行的半行不该进历史，但空行/纯空白行本来就没进 —— 无条件 splice 会误删上一条真实历史。
   */
  const dropHistory = (entry: string): void => {
    if (entry.trim() === "") return;
    const h = rlInternal().history;
    if (Array.isArray(h) && h[0] === entry) h.splice(0, 1);
  };

  /**
   * 审批问句统一走 readline.question。
   * 关键：不要另开 raw-mode stdin 监听，否则 readline 会重复回显输入。
   * question 会自动挂起/恢复 line 事件，因此外层队列不会被问句污染。
   * questionPending 供粘贴热键 C1 判定：问句中 rl.write(chip) 会污染问句缓冲。
   */
  ui.setAsker((q: string) => new Promise<string>((resolve) => {
    questionPending = true;
    rl.question(q, (a) => {
      questionPending = false;
      resolve(a);
    });
  }));

  // Ctrl+C 双击退出（模仿 Claude Code）：第一次按下闪现橙色提示，
  // 2 秒内再按才真正退出。挂在 SIGINT 路径而非 keypress ——
  // 否则运行中一次 Ctrl+C 会同时触发信号与 keypress 两路，提示错乱。
  // 职责划分：Ctrl+C = 信号语义，其余按键 = HotkeyRouter（keypress 语义）。
  const exitStrike = doubleStrike(
    () => {
      void shutdown();
    },
    {
      windowMs: 2000,
      notice: "Press Ctrl+C again to exit",
      flash: (t, ms) => ui.flashNotice(t, ms),
    },
  );

  const onSigint = (): void => {
    // C9：select 存续期间 Ctrl+C = 取消选择，不武装双击退出
    if (selectActive && selectCancel) {
      selectCancel();
      return;
    }
    if (queue.length > 0 || draining) {
      agent.cancel();
      // 中断不回滚：跑了几十轮工具的进展不该被一次误按丢掉。
      // 回滚是 ESC 的语义（输入错了重来）。
      exitStrike();
      return;
    }
    exitStrike();
  };
  process.on("SIGINT", onSigint);

  // ---- 粘贴拦截（PRD §5.3 + §7 探针结论）----
  // readline 不自带 bracketed paste：启用 \x1b[?2004h 后终端才会在粘贴前后
  // 包裹 200~/201~ 标记，readline 才会发 paste-start/paste-end keypress。
  // 不支持的终端无标记，行为退化为现状（逐行提交），非回归。
  if (process.stdin.isTTY) process.stdout.write("\x1b[?2004h");
  const pasteCollector = new PasteCollector();
  /** 待绑定附件：chip 已写入缓冲、随下一次 line 提交绑定入队（PRD §5.4）。 */
  let pendingAttachments: Attachment[] = [];

  // 粘贴期间的 line 一律收集不提交（C11 同款模式）。
  // 收集态由 paste-end 的 collector.end() 撤销（探针 §7.2：此刻最后一段仍在缓冲，
  // 由 paste-end 处理器取出组装，之后无 flush）。
  const origLineHandler = (raw: string): void => {
    // 每种换行事件只消费一个；队空（例如脚本注入）按 Enter 处理
    const newline = newlineQueue.shift() ?? "cr";
    if (selectActive) return; // C11：select 存续期间的 line 一律丢弃（残留提交）
    if (pasteCollector.consume(raw)) return; // 粘贴期间：收集，不入队

    // ---- v0.2.4 C4：续行判定（Ctrl+J 或行尾反斜杠）----
    const marker = stripContinuationMarker(raw);
    // 只在真 TTY 下把 LF(0x0A) 当 Ctrl+J：管道/脚本里 \n 就是普通行终止符，
    // 若也按续行处理，`printf '/help\n' | neo` 之类会用不了（v0.2.4 回归实测）。
    const lfIsCtrlJ = process.stdin.isTTY === true && newline === "lf";
    const wantsContinue = marker.cont || (lfIsCtrlJ && !marker.cont);
    if (wantsContinue) {
      continuation = appendContinuation(continuation, marker.cont ? marker.text : raw);
      dropHistory(raw); // 半行进 history 会让 ↑ 把未完成的多行塞回单行缓冲
      promptForContinuation();
      applyLine("", 0);
      return;
    }
    const composed = isActiveContinuation(continuation) ? finishContinuation(continuation, raw) : raw;
    if (isActiveContinuation(continuation)) {
      continuation = emptyContinuation();
      promptForContinuation();
    }

    const line = composed.trim();
    if (!line) return;
    const bound = bindAttachments(line, pendingAttachments);
    // 绑定即消费：chip 只对本次提交生效，防止后续消息引用同款字样被二次还原
    if (bound.length > 0) pendingAttachments = pendingAttachments.filter((a) => !bound.includes(a));
    autoTurnChain = 0; // 人类输入重置自动 turn 链
    tabCycle = null;
    queue.push({ text: line, attachments: bound, origin: "user" });
    runDrainSafely();
  };
  rl.on("line", origLineHandler);

  // ESC 等按键走 keypress 语义。仅运行中响应：取消当前轮并回滚历史。
  const hotkeys = new HotkeyRouter();
  hotkeys.attach(rl, process.stdin);
  hotkeys.on("escape", () => {
    // v0.2.4：续行中 ESC = 放弃多行输入（不触发 agent 取消）
    if (isActiveContinuation(continuation)) {
      continuation = emptyContinuation();
      promptForContinuation();
      applyLine("", 0);
      return;
    }
    if (draining) agent.cancel();
    // 空闲时无操作，留给将来的热键语义
  });

  // v0.2.4 C1/C2：Tab 补全（bun 的 readline 不处理 Tab，只能自己接管）
  hotkeys.on("tab", onTab);

  // ---- 粘贴边界接线（PRD §5.3 + §7 探针结论）----
  // paste-start：进入收集态。用户先打到一半的字随首行 line 提交天然带上，无需特殊处理。
  hotkeys.on("paste-start", () => pasteCollector.start());

  // ---- 图片粘贴热键（PRD §5.1 D1 + §5.2 D2）----
  // C1：仅在输入空闲时响应——readline 问句中 rl.write 会污染问句缓冲（console.ts 同源结论）。
  // C3：Ctrl+V（macOS 主键位）与 Alt+V（Win/WSL）同时绑定。
  // C4：异步读取，等待期间输入框可用；结果到达后 chip 追加到当前缓冲尾部。
  // C5：无图 → info 一行，不报错（用户可能只是想贴文本）。C6：8MB 上限。
  const onPasteImage = (): void => {
    if (draining || queue.length > 0 || selectActive || questionPending) return; // C1
    // v0.4.0 平台适配层：Linux 无剪贴板图片后端（PD-2），给一次性说明而不是伪装「无图」。
    if (clipboardImagePlatform() === "unsupported") {
      if (!clipboardUnsupportedNotified) {
        clipboardUnsupportedNotified = true;
        ui.info("当前平台暂不支持剪贴板贴图（Linux 记入 PD-2：wl-paste / xclip）");
      }
      return;
    }
    void (async (): Promise<void> => {
      let img: Awaited<ReturnType<typeof readClipboardImage>> = null;
      let err: string | null = null;
      try {
        img = await readClipboardImage();
      } catch (e) {
        err = (e as Error).message;
      }
      if (err) {
        ui.warn(err); // C9 关联：读取失败一行说明原因
        return;
      }
      if (!img) {
        ui.line(c.dim("· 剪贴板里没有图片")); // C5
        return;
      }
      if (img.data.length > cfg.paste.imageMaxBytes) {
        ui.warn(`图片超过 ${(cfg.paste.imageMaxBytes / 1024 / 1024).toFixed(0)}MB 上限（${(img.data.length / 1024 / 1024).toFixed(1)}MB），已放弃`); // C6
        return;
      }
      pasteImageCounter += 1;
      const att = makeImageAttachment(pasteImageCounter, img.data);
      pendingAttachments.push(att);
      (rl as unknown as { write(b: string): void }).write(att.chip); // C2：只走 rl.write
      ui.line(c.dim(`· 已附加 ${att.chip} (${(att.bytes / 1024).toFixed(0)}KB)`));
    })();
  };
  hotkeys.on("paste-image", onPasteImage);

  // paste-end：组装全文。此刻最后一段仍在 rl.line 缓冲（探针 §7.2），取出参与组装；
  // 取走后立即清空重绘，防止用户随后的回车把残留再提交一次。
  hotkeys.on("paste-end", () => {
    const rlAny = rl as unknown as { line: string; _refreshLine?: () => void; history: string[] };
    const buf = rlAny.line;
    rlAny.line = "";
    rlAny._refreshLine?.();
    const r = pasteCollector.end(buf);
    if (!r) return; // 纯空粘贴，缓冲未被拦截过，无需动作
    const full = assemblePaste(r.lines, r.tail);
    // history 定向回滚：粘贴期间提交的行已进 rl.history（探针 §7.5，新条目在 index 0）
    if (r.lines.length > 0 && Array.isArray(rlAny.history)) rlAny.history.splice(0, r.lines.length);
    // 折叠判定：含 \n 必折叠（readline 行缓冲装不下换行，写回会再次逐行提交）；
    // 单行超长按 fold_chars 折叠。不折叠 → 原样回填缓冲，用户无感。
    if (!shouldFold(full, { foldLines: cfg.paste.foldLines, foldChars: cfg.paste.foldChars })) {
      rlAny.line = full;
      rlAny._refreshLine?.();
      return;
    }
    pasteTextCounter += 1;
    const att = makeTextAttachment(pasteTextCounter, full);
    pendingAttachments.push(att);
    // chip 走 readline 自己的行缓冲与回显（PRD C2：绝不另开 raw-mode 监听）
    rlAny.line = att.chip;
    rlAny._refreshLine?.();
  });

  // select 组件的依赖（PRD D1 注入惯例）。clearLine 是 M0 §2 手段B：
  // select 结束时清掉行缓冲残留（↑ 历史召回 / 误触数字），防止污染下一提示符。
  // C11（M0 §3 实证）：select 存续期间 readline 仍会发 line 事件——
  // 回车提交的是当时缓冲里的残留（↑ 历史召回 / 误触字符），可能非空。
  // 置标志让 line 处理器丢弃这些事件，防止残留被当成命令/聊天消息入队。
  selectDeps = {
    router: hotkeys,
    asker: (q: string): Promise<string> =>
      new Promise<string>((resolve) => rl.question(q, (a) => resolve(a))),
    clearLine: (): void => {
      (rl as unknown as { line: string }).line = "";
      (rl as unknown as { _refreshLine?: () => void })._refreshLine?.();
    },
    onActiveChange: (active, cancel): void => {
      selectActive = active;
      selectCancel = cancel; // C9：select 期间 Ctrl+C 路由为取消选择
    },
  };

  rl.on("close", () => {
    process.off("SIGINT", onSigint);
    if (process.stdout.isTTY) process.stdout.off("resize", onResize);
    ui.setPromptRestorer(null);
    // MCP 子进程随输入源关闭一并收掉（readline 路径没有统一的 shutdown 出口）。
    try { mcpManager.closeAll(); } catch { /* 清理失败不阻止退出 */ }
    closeMailbox();
    if (process.stdin.isTTY) process.stdout.write("\x1b[?2004l"); // 退出还原终端 bracketed paste 模式
  });

    closeInput = () => rlC.close();
    promptInput = () => rlC.prompt();
    await fileIndexPreheat;
    prompt();
    await new Promise<void>((resolve) => rlC.on("close", () => resolve()));
  }

  closeMailbox();
  // MCP 子进程：正常退出路径（readline close）已收，这里兜底再调一次（幂等）。
  try {
    mcpManager.closeAll();
  } catch {
    // 清理失败不阻止退出
  }
  // 终端关闭（Ctrl+D 等）同样冲刷记忆写队列
  try {
    await memory.flush(2000);
  } catch {
    // 记忆失败不阻止退出
  }
  return 0;
}
/* ------------------------------------------------------------------ */

const code = await main();
void homedir;
void rule;
process.exit(code);
