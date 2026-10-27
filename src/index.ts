#!/usr/bin/env bun
/**
 * neo —— Matrix 风格的终端编程助手。
 *
 * 交互模式：直接输入自然语言或 /命令；! 开头的行直接走 shell。
 * 单次模式：-p "问题" 执行一轮后退出，适合脚本化。
 */
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

import {
  loadConfig,
  maskKey,
  switchProvider,
  switchTier,
  applyTier,
  describeRoute,
  isImplemented,
  IMPLEMENTED_PROVIDER_TYPES,
  ConfigError,
  isModelTier,
  MODEL_TIERS,
  normalizeTierName,
  tierDisplayName,
  tierChoiceLabel,
  type Config,
} from "./config.ts";
import { Classifier, CLASSIFIER_NAMES, isClassifierName, type ClassifierName } from "./classifier/index.ts";
import { Agent, type PermissionMode } from "./agent.ts";
import { HotkeyRouter, doubleStrike } from "./hotkeys.ts";
import { PasteCollector, shouldFold, assemblePaste } from "./paste.ts";
import { makeTextAttachment, makeImageAttachment, bindAttachments, resolveLine, type Attachment, type QueuedLine } from "./attachments.ts";
import { clipboardImagePlatform, readClipboardImage } from "./clipboard.ts";
import { select, type SelectDeps } from "./ui/select.ts";
import { Console } from "./ui/console.ts";
import { Composer, type ComposerStatus } from "./tui/composer.ts";
import { TranscriptDock, type DockHost } from "./tui/dock.ts";
import { formatTokens } from "./tui/status.ts";
import { getBranch } from "./git.ts";
import { chooseSessionName } from "./sessionName.ts";
import { TitleAnimator } from "./tui/title.ts";
import { formatToolCall } from "./ui/toolLog.ts";
import { transcriptLines } from "./ui/transcript.ts";
import { banner, c, rule, truncate } from "./ui/theme.ts";
import { renderMarkdown } from "./ui/render.ts";
import {
  applyMatch,
  completeLine,
  formatCandidateHint,
  triggerAt,
} from "./input/completion.ts";
import { COMMANDS } from "./input/commands.ts";
import { FileIndex } from "./input/fileIndex.ts";
import { expandReferences } from "./input/references.ts";
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
import { buildMemoryFile, buildSystemPrompt } from "./system-prompt.ts";
import { initProjectLevel as initProjectLevelImpl } from "./memory/init.ts";
import { createMemoryBridge, type MemoryBridge } from "./memory/bridge.ts";
import { makeRememberTool } from "./tools/memory.ts";
import { listModels, contentText, type Message } from "./llm.ts";
import { toolNames, registerTool } from "./tools/index.ts";
import { makeTaskTool, runSubagent } from "./tools/task.ts";
import { makeAskUserTool } from "./tools/askUser.ts";
import { registerWikiTools } from "./tools/wiki.ts";
import { lintWiki, formatLintReport, resolveWikiDir } from "./wiki/lint.ts";
import {
  planIngest,
  buildIngestPrompt,
  loadIngestTemplate,
  finishIngest,
  listRawFiles,
} from "./wiki/ingest.ts";
import { resolveWikiLayout } from "./wiki/paths.ts";
import { describeShell, getShell, prepareShellInvocation, shellErrorHint } from "./shell.ts";
import { loadEnv } from "./env/probe.ts";
import {
  detectAndRecordModelWindow,
  formatModelWindowLines,
  recordModelContext,
  resolveAndApplyModelWindow,
} from "./env/modelWindows.ts";
import { formatEnvForCli } from "./env/render.ts";
import { syncEnvPage } from "./env/wiki.ts";
import { ensureScopeLayout } from "./memory/layout.ts";
import { appendLog } from "./wiki/write.ts";
import { discoverSkills, isValidSkillName, formatSkillLine, normalizeDescription } from "./skills.ts";
import { adoptSession, applyRestored, createSession, listSessions, loadSession, saveSession, type SessionMeta } from "./session.ts";
import { renderSessionMarkdown } from "./sessionExport.ts";
import { Mailbox } from "./mailbox/store.ts";
import {
  createIdentity,
  readProfile,
  releaseAlive,
  renameSession,
  sessionLiveness,
  sweepSessions,
  takenAliveNames,
} from "./mailbox/identity.ts";
import * as mailboxState from "./mailbox/state.ts";
import { decideInbound, formatIncomingFrame, formatNotice, formatNoticePreview, formatPreview } from "./mailbox/inbound.ts";
import { makeListPeersTool, makeSendMessageTool } from "./tools/mailbox.ts";
import { mailboxRoot, type Envelope } from "./mailbox/types.ts";
import { cleanupRuntime } from "./maintenance.ts";
import { CheckpointStore } from "./checkpoint.ts";
import { formatResumeWarning, outcomeOf, type LastTurnMeta } from "./turnDiagnostics.ts";
import type { ToolCtx } from "./tools/types.ts";

const VERSION = "0.4.3";

/** /auto 列表里各实现的说明。 */
const DESC: Record<string, string> = {
  off: "关闭自动分类，始终用手动选的档位",
  rule: "规则分类器，零延迟零成本（默认）",
  llm: "用 classifier_model_name 判定，多一次调用",
};

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

const HELP = `
${c.accent("neo")} ${c.dim(`v${VERSION}`)} — Matrix 风格的终端编程助手

${c.bold("用法")}
  bun run src/index.ts                 进入交互模式
  bun run src/index.ts -p "问题"        单次执行一轮后退出
  bun run src/index.ts -P <provider>   指定 provider
  bun run src/index.ts -t <tier>       指定模型档位
  bun run src/index.ts -C <dir>        指定工作目录
  bun run src/index.ts --resume        恢复上一次会话
  bun run src/index.ts --sessions      列出会话

${c.bold("选项")}
  -p, --print <text>    单次模式
      --output-format <fmt>  -p 输出格式：text（默认）| json（CI 可解析，stdout 单行）
  -m, --model <id>      直接指定模型 ID（绕过档位）
  -P, --provider <name> 切换 provider
  -t, --tier <name>     模型档位：${MODEL_TIERS.join(" / ")}
  -C, --cwd <dir>       切换工作目录
  -y, --yes             自动批准所有操作（慎用）
      --edit            自动批准文件写入，shell 仍需批准
      --plan            只读模式，禁止一切写操作
  -c, --continue        继续上一次会话
      --resume [id]     恢复会话（默认 last）
      --sessions        列出历史会话
      --no-reasoning    不显示思维链
      --name <n>        设置本会话名字（跨会话寻址用）
  -h, --help            显示帮助
  -v, --version         显示版本

${c.bold("交互命令")}
  /help            帮助            /clear       清空上下文
  /compact         压缩上下文      /cost        token 统计
  /context         上下文窗口/用量 /env         环境快照
  /export [id]     导出会话 Markdown
  /provider        切换 provider   /model       查看/切模型
  /tools           工具列表        /mode        权限模式
  /env [refresh]   环境快照（平台/shell/资源/工具链）；refresh 重采并写 wiki 页
  /peers [name]    跨会话状态：列出存活会话 / 查单个
  /inbox           查看 held 消息；/inbox release <id> 放行一条
  /rename <name>   设置本会话名字（跨会话寻址；撞名自动加后缀）
  /skills          列出可用技能    /skills <名>  查看技能详情
  /wiki-lint       wiki 体检：断链/orphan/摘要/日期戳/链接密度
  /ingest [f|i]    编译 raw → wiki（无参按 log 判定：超 1 周全量并告知，否则增量）
  /init            生成 AGENTS.md  /history     历史统计
  /memory ...      记忆：status / list / recall / why / flush / forget / migrate / lint / on|off
  /remember <文本> 显式记忆（--user 写用户级；-p 模式仅项目级）
  /save [path]     导出会话        /sessions    历史会话
  /resume [id]     恢复会话（无参进入选择；last = 最近一次）
  /last [n]        回看最近 n 次工具调用（默认 1；紧凑模式的信息找回入口）
  /undo [n]        撤销最近 n 次 write/edit（默认 1；仅工具写，不含 shell）
  /checkpoints [n] 列出最近的写文件检查点（默认 10）
  /tier [name]     查看/切档位      /auto [name] 切换分类器（off/rule/llm）
  /fast /balanced /deep            档位快捷方式（等价 /tier）
  /why             上次分类判定与理由
  /exit            退出（别名 /quit）
  !<cmd>           直接执行 shell（受权限模式约束）
  ESC              运行中取消本轮（不回滚历史）；空闲时清空输入
  Ctrl+C           双击退出（运行中第一次 = 取消本轮）
  Ctrl+O           transcript 视图（v0.3.1 提供；当前按下一行提示）

${c.bold("输入")}
  输入框           底部常驻（上下横线 + 状态行）：Enter 提交；Ctrl+J / Shift+Enter /
                   Alt+Enter 换行；多行超过可视高度时滚动窗口
  Tab              补全：@ 文件路径（模糊匹配，多个候选连按 Tab 循环）/ 命令名
  @path            引用文件内容随消息发送（≤5 个文件，单文件 ≤400 行，总 ≤60KB）
  ← → ↑ ↓          行内移动；↑↓ 在首/末行翻历史（前缀搜索）；Home/End 行首尾
  Ctrl+A/E/K/U/W   Home / End / 删到行尾 / 删到行首 / 删前一个词
  Ctrl+V           粘贴剪贴板图片（以 chip 形式进输入框）
  粘贴             小段多行直接进输入框；大段/超长折叠为 [Pasted text #N]
  行尾 \          多行的等价触发（不支持 Ctrl+J 的终端用这个）
  鼠标/全屏        不使用 alt-screen：历史始终留在终端 scrollback，Cmd+F/tmux 可用

${c.bold("环境变量")}
  NEO_PROVIDER / NEO_TIER / NEO_MODEL / NEO_BASE_URL / NEO_API_KEY  覆盖 settings.json
  NEO_CLASSIFIER_PROVIDER / NEO_CLASSIFIER_MODEL                    指定分类器用的 provider 与模型
`;

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

  // A2：交互模式下异步探测当前模型窗口（/models 元数据）；失败静默。
  // 探测成功会写入 env 事实文件，后续启动/切模型直接命中。
  if (interactiveTTY) {
    void detectAndRecordModelWindow(cfg)
      .then((info) => {
        if (!info?.contextWindow) return;
        const r = resolveAndApplyModelWindow(cfg);
        if (r.source !== "config") {
          ui.info(`模型上下文窗口：${r.tokens.toLocaleString()} tokens（${r.source}）`);
        }
      })
      .catch(() => {
        /* 探测失败不影响会话 */
      });

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

  const agent = new Agent({
    cfg,
    console: ui,
    mode: args.mode,
    systemPrompt: buildSystemPrompt(cfg, { mailbox: mailboxEnabled, askUser: interactiveTTY }),
    classifier,
    memory,
    checkpoint: checkpoints,
    sessionId: sess.meta.id,
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
    },
    askUser: interactiveTTY
      ? (req) => {
          const c = composerRef;
          return c ? c.askUser(req) : Promise.resolve({ status: "canceled" as const });
        }
      : undefined,
    cancelAskUser: () => composerRef?.cancelAskUser(),
    // -p 单次模式：即使终端是 TTY 也按非交互块级渲染，避免 spinner/ANSI 污染输出
    nonInteractive: args.print !== null,
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

  // task 工具：派生子代理。必须在首次 send 前注册 —— toolSpecs() 每轮现取，注册后即刻生效。
  registerTool(
    makeTaskTool({
      run: (prompt, tier, ctx) => runSubagent(agent, prompt, tier, ctx),
    }),
  );

  // wiki 工具：检索 + 回填唯一路径（raw 不可改拦截在 write_file/edit_file 内）。
  registerWikiTools(registerTool);

  // 记忆工具：模型显式写入（与自动归纳共用同一合并管线；子代理不可见）。
  registerTool(makeRememberTool({ remember: (body, scope) => memory.remember(body, scope) }));

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

  // 运行时工具注册完成后再刷新系统提示：`可用工具` 行由 toolNames() 现取，
  // 首次构造时运行时工具（task/wiki/remember/send_message/list_peers）尚未注册。
  {
    const sys0 = agent.messages[0];
    if (sys0) sys0.content = buildSystemPrompt(cfg, { mailbox: mailboxEnabled, askUser: interactiveTTY });
  }

  if (restored && restored.length > 0) {
    agent.messages = applyRestored(agent.messages[0], restored);
    ui.info(`已恢复会话 ${meta?.id ?? ""}（${restored.length} 条消息）`);
    // 用户裁决：恢复对话/名字/信箱，但不偷偷切换工作目录。
    if (meta?.cwd && meta.cwd !== cfg.cwd) {
      ui.info(`会话原目录 ${meta.cwd}，本次按 ${cfg.cwd} 运行`);
    }
    // v0.4.1 A1：上次会话最后一轮失败/空转 → 明确告警，避免用户以为上下文正常。
    const resumeWarn = formatResumeWarning(meta);
    if (resumeWarn) {
      ui.warn(resumeWarn);
      ui.line(c.dim("  诊断日志：~/.neo/logs/turns/（可用 NEO_LOG_DIR 覆盖）"));
    }
  }

  // 覆盖系统提示：注入项目记忆文件（若存在）
  const memoryFile = ["AGENTS.md", "NEO.md", ".neo.md"]
    .map((f) => join(cfg.cwd, f))
    .find((p) => existsSync(p));
  if (memoryFile) {
    const extra = readFileSync(memoryFile, "utf8");
    const sysMsg = agent.messages[0];
    if (sysMsg) sysMsg.content = `${sysMsg.content}\n\n## 项目记忆（来自 ${memoryFile}）\n\n${extra}`;
    ui.info(`已加载项目记忆 ${memoryFile}`);
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
      return 2;
    }
    // json 模式把 SIGINT 转成 aborted 统计：Ctrl+C 后仍能输出一行 JSON（exit 130），
    // 而不是被信号直接杀掉、编排器拿到空 stdout。
    const onSigint = (): void => agent.cancel();
    if (jsonMode) process.on("SIGINT", onSigint);
    let stats: Awaited<ReturnType<typeof agent.send>>;
    try {
      stats = await agent.send(prompt);
    } finally {
      if (jsonMode) process.off("SIGINT", onSigint);
    }
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
    await agent.send(args.rest.join(" "));
    persist(agent.messages, sess.meta);
    await memory.flush();
    return 0;
  }

  // ---- 交互模式 ----
  if (process.stdin.isTTY) {
    ui.line(banner(cfg.model, cfg.baseUrl, cfg.providerName, tierDisplayName(cfg.modelTier), toolNames().join(" ")));
    // v0.4.0 平台适配层：一眼可见实际使用的 shell，解析告警不静默。
    const bootShell = getShell(cfg);
    ui.line(c.dim(`  shell ${describeShell(bootShell)}`));
    for (const w of bootShell.warnings) ui.warn(w);
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

  /** 退出：两类输入源都收敛到 closeInput()。 */
  async function shutdown(): Promise<void> {
    try {
      await memory.flush();
    } catch {
      // 记忆失败不阻止退出
    }
    closeMailbox();
    persist(agent.messages, sess.meta);
    ui.blank();
    ui.line(c.dim("再见。"));
    closeInput();
    process.exit(0);
  }

  /** `!cmd`：TTY 下先让出终端（cooked + 显示光标 + 擦帧），命令跑完再恢复自绘帧。 */
  async function runShellWithTui(cmd: string): Promise<void> {
    if (!composer || composer.isSuspended) {
      await runShell(cmd, cfg, ui, agent.mode);
      return;
    }
    externalShellActive = true;
    composer.suspend();
    try {
      await runShell(cmd, cfg, ui, agent.mode);
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
        if (line.startsWith("!")) {
          await runShellWithTui(line.slice(1));
          continue;
        }
        if (line.startsWith("/")) {
          await handleCommand(
            line,
            agent,
            ui,
            cfg,
            memory,
            classifier,
            sess.meta,
            shutdown,
            selectDeps,
            mailbox,
            checkpoints,
            (env) => {
              ui.line(c.dim(formatPreview(env)));
              queue.push({ text: formatIncomingFrame(env), attachments: [], origin: "mailbox", from: env.from.session });
            },
            () => inboundRefs.clear(),
            (name) => {
              sessionLabel = name;
              titleAnimator?.setName(name);
            },
            memoryMode,
          );
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
        model: cfg.model,
        tier: tierDisplayName(cfg.modelTier),
        mode:
          args.mode === "auto-edit" ? "edit" : args.mode === "auto-all" ? "yolo" : args.mode,
        branch: getBranch(cfg.cwd),
        ctxUsage: ctxUsage(),
        elapsedMs: turnActive ? Math.max(0, Date.now() - turnStartedAt) : lastTurnMs,
        active: turnActive,
        tokensTotal: agent.cumulative.prompt + agent.cumulative.completion,
      }),
      commands: COMMANDS,
      files: () => fileIndex.list(),
      onSubmit: (text, attachments) => submitUserLine(text, attachments as Attachment[]),
      onExit: () => {
        void shutdown();
      },
      onCancelTurn: () => agent.cancel(),
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
      console.error(c.err(`✖ 未捕获异常，终端已还原：${(e as Error)?.message ?? String(e)}`));
      process.exit(1);
    };
    const onTerm = (): void => {
      try { composer?.stop(); } catch { /* 尽力还原 */ }
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
  // 终端关闭（Ctrl+D 等）同样冲刷记忆写队列
  try {
    await memory.flush(2000);
  } catch {
    // 记忆失败不阻止退出
  }
  return 0;
}
function persist(messages: Message[], meta: SessionMeta): void {
  try {
    const copy = messages.filter((m) => m.role !== "system");
    meta.turns = copy.filter((m) => m.role === "user").length;
    saveSession(copy, meta);
  } catch {
    // 落盘失败不打断交互
  }
}

/* ------------------------------------------------------------------ */
/* 会话回放                                                            */
/* ------------------------------------------------------------------ */

/**
 * 回放最近几轮对话（v0.2.3 D4）。
 * 只在交互 TTY 下打印 —— `-p` / 管道场景回放会污染 stdout 的可解析性。
 */
function replayTranscript(ui: Console, messages: Message[], turns = 3): void {
  if (process.stdout.isTTY !== true) return;
  const lines = transcriptLines(messages, { turns, width: ui.width });
  if (lines.length === 0) return;
  ui.blank();
  ui.info("以下为最近几轮对话回放（只读，不重新发送）：");
  for (const l of lines) ui.line(l);
  ui.blank();
}

/* ------------------------------------------------------------------ */
/* 统计栏                                                              */
/* ------------------------------------------------------------------ */

function showStats(ui: Console, agent: Agent, cfg: Config, stats: {
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  finishReason: string | null;
  aborted: boolean;
  tierSwitch: { from: string; to: string; reason: string; degraded?: string } | null;
}): void {
  const cum = agent.cumulative;
  const usage = agent.contextUsage();
  // v0.3.0：TTY 已有常驻状态条，轮末只补一行「本轮摘要」，不再打印三行状态栏。
  if (ui.hasLiveDock) {
    ui.line(
      c.dim(
        `· 本轮 ${(stats.durationMs / 1000).toFixed(1)}s · ` +
          `${formatTokens(stats.promptTokens)}↑ ${formatTokens(stats.completionTokens)}↓ · ` +
          `${stats.toolCalls} tools · ctx ${(usage * 100).toFixed(0)}% · ` +
          `total ${formatTokens(cum.prompt)}↑ ${formatTokens(cum.completion)}↓`,
      ),
    );
    return;
  }
  ui.statusBar([
    ["model", `${cfg.providerName}/${cfg.model}`],
    ["tier", tierDisplayName(cfg.modelTier)],
    ["stop", String(stats.finishReason ?? "stop")],
    ["tok", `${stats.promptTokens}↑ ${stats.completionTokens}↓`],
    ["think", String(stats.reasoningTokens)],
    ["tools", String(stats.toolCalls)],
    ["ctx", `${(usage * 100).toFixed(1)}%`],
    ["msgs", String(agent.historyLength)],
    ["$", (stats.durationMs / 1000).toFixed(2) + "s"],
    ["total", `${cum.prompt}↑ ${cum.completion}↓`],
  ]);
}

/* ------------------------------------------------------------------ */
/* 斜杠命令                                                            */
/* ------------------------------------------------------------------ */

async function handleCommand(
  line: string,
  agent: Agent,
  ui: Console,
  cfg: Config,
  memory: MemoryBridge,
  classifier: Classifier,
  meta: SessionMeta,
  shutdown: () => void | Promise<void>,
  selectDeps: SelectDeps,
  mailbox: Mailbox | null,
  checkpoints: CheckpointStore | null,
  injectMailbox?: (env: Envelope) => void,
  onMailboxRekey?: () => void,
  onNameChange?: (name: string) => void,
  memoryMode: "interactive" | "oneshot" = "interactive",
): Promise<void> {
  const [cmdRaw, ...rest] = line.slice(1).split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help":
    case "?":
      ui.line(HELP);
      break;

    case "clear":
      agent.reset();
      ui.success("上下文已清空。");
      break;

    case "compact": {
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
      ui.kv("max_tokens", String(cfg.maxTokens));
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
              `${c.dim(x.type)} ${c.dim("→")} ${c.muted(x.baseUrl)}${tag}`,
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
      ui.success(`模型已切到 ${arg}（本次会话内生效，已绕过档位）。`);
      break;
    }

    case "tools":
      ui.blank();
      ui.kv("可用工具", String(toolNames().length));
      for (const t of toolNames()) ui.line(`  ${c.tool("⚡")} ${c.text(t)}`);
      ui.blank();
      break;

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
        ui.line(c.dim("模型上下文窗口（env 事实）："));
        for (const line of windowLines) ui.line(`  ${line}`);
      }
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
        ui.info("完整正文请让模型调用 use_skill。");
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
      ui.info("用 /skills <名称> 查看详情，或让模型按需 use_skill。");
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
        ["4", "plan — 只读，禁止一切写操作"],
      ];
      if (!arg) {
        ui.blank();
        ui.kv("当前模式", c.accent(agent.mode));
        // TTY：选择器接入（与 /model 同款）；hint = 模式说明，initial 定位当前模式
        if (process.stdin.isTTY) {
          ui.stopSpinner(); // C1
          ui.blank();
          const modeList: Array<{ name: PermissionMode; desc: string }> = [
            { name: "ask", desc: "写文件/执行命令都需批准" },
            { name: "auto-edit", desc: "自动批准写文件，命令仍需批准" },
            { name: "auto-all", desc: "全部自动批准（慎用）" },
            { name: "plan", desc: "只读，禁止一切写操作" },
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

/* ------------------------------------------------------------------ */
/* shell 直通                                                          */
/* ------------------------------------------------------------------ */

/**
 * `!cmd` 直通 shell。
 *
 * 权限必须与工具层的 approve 保持一致 —— 否则 `--plan` 只读模式下
 * `!rm -rf` 照样执行，「只读模式」就名存实亡了。
 * 规则：plan 一律拒；auto-all 直接放行；auto-edit 与 ask 都要审批。
 */
async function runShell(
  cmdline: string,
  cfg: Config,
  ui: Console,
  mode: PermissionMode,
): Promise<void> {
  const cmd = cmdline.trim();
  if (!cmd) return;

  if (mode === "plan") {
    ui.warn(`plan 模式禁止执行 shell：${cmd}`);
    return;
  }
  if (mode !== "auto-all") {
    const ok = await ui.confirm(`shell — 执行: ${cmd}`);
    if (!ok) {
      ui.info("已拒绝。");
      return;
    }
  }

  ui.blank();
  ui.line(`${c.dim("$")} ${c.text(cmd)}`);
  try {
    // v0.4.0 平台适配层：与 shell 工具共用同一解析器（含 PATH 保真）。
    const spec = getShell(cfg);
    const invocation = prepareShellInvocation(spec, cmd);
    const proc = Bun.spawn(invocation.argv, {
      cwd: cfg.cwd,
      stdout: "inherit",
      stderr: "inherit",
      env: invocation.env,
    });
    const code = await proc.exited;
    if (code !== 0) ui.line(c.dim(`exit ${code}`));
  } catch (e) {
    ui.error(`执行失败: ${shellErrorHint(e, getShell(cfg))}`);
  }
  ui.blank();
}

interface PrintSessionsOpts {
  root?: string;
  deadAfterMs?: number;
  currentId?: string;
}

function printSessions(ui: Console, opts: PrintSessionsOpts = {}): void {
  const all = listSessions(50);
  const root = opts.root ?? mailboxRoot();
  const running = all.filter(
    (x) => sessionLiveness(root, x.id, { deadAfterMs: opts.deadAfterMs }) === "running",
  );
  const runningOther = running.filter((r) => r.id !== opts.currentId);
  const runningIds = new Set(runningOther.map((r) => r.id));
  const available = all.filter((x) => x.id !== opts.currentId && !runningIds.has(x.id));
  const list = available.slice(0, 15);
  ui.blank();
  if (list.length === 0) {
    if (runningOther.length > 0) ui.info("没有可恢复的会话（运行中的会话不列出）。");
    else ui.info("还没有历史会话。");
  } else {
    ui.kv("历史会话", String(list.length));
    for (const s of list) {
      const failed = s.lastTurn && s.lastTurn.outcome !== "ok" ? c.warn(" ⚠") : "";
      ui.line(
        `  ${c.accent(s.id)} ${c.dim(s.updatedAt.slice(0, 16).replace("T", " "))} ` +
          `${c.muted(`${s.turns} 轮`)} ${c.dim(s.model)}${failed}`,
      );
    }
    ui.line(c.dim("  用 /resume <id> 或 neo --resume <id> 恢复"));
  }
  if (runningOther.length > 0) {
    ui.line(c.dim(`  另有 ${runningOther.length} 个运行中会话未列出（/peers 查看）`));
  }
  ui.blank();
}

/* ------------------------------------------------------------------ */

const code = await main();
void homedir;
void rule;
process.exit(code);
