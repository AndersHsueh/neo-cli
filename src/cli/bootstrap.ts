import { resolve } from "node:path";
import { loadConfig, switchProvider, applyTier, isImplemented, IMPLEMENTED_PROVIDER_TYPES, ConfigError, parseFallbackTarget, MAX_MODEL_FALLBACKS, normalizeTierName, type Config, type ModelTarget } from "../config.ts";
import { Classifier, CLASSIFIER_NAMES, isClassifierName, type ClassifierName } from "../classifier/index.ts";
import { ModelFallbackController } from "../modelFallback.ts";
import { JsonlWriter, clipFallbackReason } from "../streamJson.ts";
import { printSessions } from "./sessions.ts";
import { VERSION } from "./version.ts";
import { detectRepo, ensureWorktree } from "../worktree.ts";
import { Console } from "../ui/console.ts";
import { TranscriptDock, type DockHost } from "../tui/dock.ts";
import {
  chooseSessionName,
  DefaultNameReservationError,
  openMailboxIdentity,
  type ChosenName,
} from "../sessionName.ts";
import { c } from "../ui/theme.ts";
import { discoverProjectRules } from "../rules/index.ts";
import { PromptManager } from "../prompt/manager.ts";
import { createMemoryBridge, type MemoryBridge } from "../memory/bridge.ts";
import { setMaxTokensLimitLearnedHandler, type Message } from "../llm.ts";
import { detectAndRecordModelWindow, formatCapabilityGapHint, resolveAndApplyModelWindow } from "../env/modelWindows.ts";
import { currentProviderConfig, probeCapabilitiesOnFirstUse, undeclaredCapabilityFields } from "../env/modelCaps.ts";
import { describeProbeOutcome, persistLearnedOutputLimit, probeOutputLimitForConfig, readOutputProbeMemo, shouldRunOutputProbe } from "../env/outputProbe.ts";
import { adoptSession, createSession, listSessions, loadSession, type SessionMeta } from "../session.ts";
import { Mailbox } from "../mailbox/store.ts";
import { readProfile, releaseAlive, sessionLiveness, sweepSessions } from "../mailbox/identity.ts";
import * as mailboxState from "../mailbox/state.ts";
import { decideInbound, formatPreview } from "../mailbox/inbound.ts";
import { mailboxRoot, type Envelope } from "../mailbox/types.ts";
import { cleanupRuntime } from "../maintenance.ts";
import { RewindLog } from "../rewind.ts";
import { lspServers } from "../lsp/index.ts";
import { CheckpointStore } from "../checkpoint.ts";
import { formatGapLogLine, formatProbeIntent, makeOverBudgetReporter, formatWindowNotice, formatWritebackNotice, logBootDiagnostic } from "../bootDiagnostics.ts";
import type { PromptSelection } from "../prompt/select.ts";
import { parseArgs, HELP, streamJsonUsageError } from "./args.ts";
import { findSettingsPath } from "../config/settingsPath.ts";
import {
  MISSING_SETTINGS_MESSAGE,
  runFirstUseOnboard,
  shouldEnterFirstUseOnboard,
  shouldFailForMissingSettings,
} from "./firstUseOnboard.ts";
import { loadJsonSchema, type CompiledSchema } from "../structuredOutput.ts";
import { acpUsageError, reportAcpUsageError } from "../acp/entry.ts";
import type { SharedMut } from "./session.ts";

/**
 * 参数校验、worktree、配置、UI、会话恢复、信箱与提示装配。
 * 成功返回会话袋；用法/帮助/版本等早退返回退出码。
 */
export async function bootstrap() {
  const s: SharedMut = {
    composerRef: null,
    sessionLabel: null,
    stdoutClosed: false,
    turnNo: 0,
    mailboxTick: null,
    heartbeatTick: null,
    mailboxClosed: false,
    // 占位：watchdog 计时起点在下方信箱装配处才落定（见 s.lastWatchdogAt = Date.now()）。
    lastWatchdogAt: 0,
    lastStreamProgressAt: 0,
    bootBlockPrinted: false,
    backgroundTasks: null,
    activeTurnFrom: null,
    agent: null,
  };
  const args = parseArgs(process.argv.slice(2));
  if (args.badArgs) return 2;
  // issue #60：`neo acp` 是独立入口（stdin/stdout 整条让给 ACP 协议）。
  // 互斥判定必须早于下面的 stream-json 校验，否则 `neo acp --output-format stream-json`
  // 会先撞上「stream-json 需要 -p」，报出与 ACP 无关的错误。
  const acpError = acpUsageError(args);
  if (acpError !== null) return reportAcpUsageError(acpError);
  // #77：`--json-schema` 与 `acp` 互斥。不能改 src/acp/*，必须在启动服务端之前拦下。
  // 与 `acp -p` 同口径：互斥判定优先于 `acp --help` / `-v`。
  if (args.rest[0] === "acp" && args.jsonSchema !== null) {
    console.error(c.err("✖ --json-schema 只能与 -p/--print 同用，不能与 acp 同时使用"));
    return 2;
  }
  // `neo acp --help` / `-v` 是元请求：打印既有文本后退出 0，绝不启动服务端。
  // 位置必须在互斥判定之后（`acp -p x --help` 仍是用法错误 2），
  // 又必须早于 stream-json 校验（否则 `acp --output-format stream-json --help` 会先撞 -p 规则）。
  if (args.rest[0] === "acp" && (args.help || args.version)) {
    if (args.help) console.log(HELP);
    else console.log(c.accent(`neo v${VERSION}`));
    return 0;
  }
  if (args.rest[0] === "acp") {
    // #88：没有候选 settings.json 时不进入向导、不启动服务端（避免随后发模型请求）。
    // 不改 src/acp/*：缺文件判定放在拉起服务端之前。
    if (findSettingsPath() == null) {
      console.error(c.err(`✖ ${MISSING_SETTINGS_MESSAGE}`));
      return 2;
    }
    // 动态 import：TUI / -p 路径不加载 ACP 服务端与 SDK。
    const { runAcpServer } = await import("../acp/server.ts");
    return await runAcpServer();
  }
  // #37：stream-json 只在 -p/--print 下合法。缺 -p（交互模式或
  // `neo <prompt>` 非 -p 形式）在会话创建前按 JSONL 收口为用法错误 2，
  // 此时还没有 SessionMeta.id，信封的 session_id 必须为 null。
  // --help/--version 是元请求，仍按原语义返回文本与 0，不受此约束。
  if (
    args.outputFormat === "stream-json" &&
    args.print === null &&
    !args.help &&
    !args.version
  ) {
    return await streamJsonUsageError(
      "--output-format stream-json 只能与 -p/--print 同用（交互模式与 neo <prompt> 非 -p 形式均不支持）",
    );
  }
  // #77：`--json-schema` 只服务 `-p` 的最终答案。无 -p（含 `neo acp …`，ACP 走上面
  // 更早的互斥判定）一律用法错误 2，且一次模型请求都不发。
  if (args.jsonSchema !== null && args.print === null && !args.help && !args.version) {
    const message = "--json-schema 只能与 -p/--print 同用（交互模式与 neo <prompt> 非 -p 形式均不支持）";
    if (args.outputFormat === "stream-json") return await streamJsonUsageError(message);
    console.error(c.err(`✖ ${message}`));
    return 2;
  }
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

  // #77：schema 在发任何模型请求之前读入并编译。缺值 / 读不到 / 不是合法 JSON /
  // 不是可编译的 schema 都是用法错误 2；stream-json 走既有 error+result 收口。
  let jsonSchema: CompiledSchema | null = null;
  if (args.jsonSchema !== null) {
    const loaded = loadJsonSchema(args.jsonSchema, args.cwd);
    if (!loaded.ok) {
      if (args.outputFormat === "stream-json") return await streamJsonUsageError(loaded.error);
      console.error(c.err(`✖ ${loaded.error}`));
      return 2;
    }
    jsonSchema = loaded.schema;
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
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(c.err(`✖ 配置错误：${e.message}`));
      return 2;
    }
    throw e;
  }

  // #88：候选路径都没有 settings.json 时，仅交互 TTY 进入初次配置向导；
  // -p / 非 TTY 说明需要先跑交互 neo，exit 2，不发模型请求。
  // 环境变量（如 NEO_API_KEY）不能跳过本向导。
  const missingSettingsFlags = {
    settingsPath: cfg.settingsPath,
    print: args.print,
    isAcp: false,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
  };
  if (shouldEnterFirstUseOnboard(missingSettingsFlags)) {
    const onboard = await runFirstUseOnboard();
    if (!onboard.ok) return onboard.exitCode;
    try {
      cfg = loadConfig(overrides);
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(c.err(`✖ 配置错误：${e.message}`));
        return 2;
      }
      throw e;
    }
  } else if (shouldFailForMissingSettings(missingSettingsFlags)) {
    console.error(c.err(`✖ ${MISSING_SETTINGS_MESSAGE}`));
    return 2;
  }

  try {
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

  // #59：CLI 备用链在发任何模型请求之前解析校验；非法配置退出 2，零模型请求。
  let effectiveFallbacks: ModelTarget[] = cfg.modelFallback;
  if (args.noFallback && args.fallbackArgs.length > 0) {
    console.error(c.err("✖ --no-fallback 与 --fallback 不能同时使用"));
    return 2;
  }
  if (args.noFallback) {
    effectiveFallbacks = [];
  } else if (args.fallbackArgs.length > 0) {
    if (args.fallbackArgs.length > MAX_MODEL_FALLBACKS) {
      console.error(
        c.err(`✖ --fallback 最多 ${MAX_MODEL_FALLBACKS} 项（收到 ${args.fallbackArgs.length} 项）`),
      );
      return 2;
    }
    try {
      const parsed = args.fallbackArgs.map((s) => parseFallbackTarget(s, cfg.providers));
      const seen = new Set<string>();
      for (const t of parsed) {
        const key = `${t.provider}\u0000${t.model}`;
        if (seen.has(key)) {
          throw new ConfigError(`--fallback 重复项：${t.provider}:${t.model}`);
        }
        seen.add(key);
      }
      effectiveFallbacks = parsed; // CLI 完整替换 settings 链，不 append / merge
    } catch (e) {
      console.error(c.err(`✖ ${(e as Error).message}`));
      return 2;
    }
  }

  // ---- v0.3.0 底部 live 帧：TTY 才启用 composer/dock，非 TTY 走 v0.2.4 readline 路径 ----
  // -p 是单次模式：即使 stdout 是 TTY 也不要起 composer/dock ——
  // dock 的 preComposerRows 只有 composer 启动时才会 flush，-p 下永不启动，
  // 会导致「真终端里 neo -p 零输出」。这里直接走 no-dock 的直写路径。
  const interactiveTTY =
    args.print === null && process.stdin.isTTY === true && process.stdout.isTTY === true;
  /** composer 启动前的输出（banner / 记忆提示 / --resume 回放）先缓存，启动后一次性落到上方。 */
  const preComposerRows: string[] = [];
  const dockHost: DockHost = {
    width: () => {
      const w = s.composerRef?.width() ?? process.stdout.columns;
      return typeof w === "number" && w > 20 ? w : 80;
    },
    commitAbove: (rows) => {
      if (s.composerRef) s.composerRef.commitAbove(rows);
      else preComposerRows.push(...rows);
    },
    setPending: (rows) => s.composerRef?.setPending(rows),
    setActivity: (text, persist) => s.composerRef?.setActivity(text, persist),
    commitActivity: () => s.composerRef?.commitActivity(),
    clearActivity: () => s.composerRef?.clearActivity(),
    notice: (text, ms) => s.composerRef?.notice(text, ms),
    rerender: () => s.composerRef?.rerender(),
  };
  const dock = interactiveTTY ? new TranscriptDock(dockHost) : null;
  /**
   * -p --output-format json：stdout 只留一行 JSON，所有 UI/工具/流式输出改走 stderr。
   * 这是 P0-6 的关键约束 —— 否则 stdout 不可解析，CI 无法消费。
   * #37：stream-json 同属结构化模式；Console/重试通知/fallback 人类提示/
   * drive [drive] 摘要/警告一律走 stderr，stdout 只归 JsonlWriter。
   */
  const jsonMode = args.print !== null && args.outputFormat === "json";
  const streamJsonMode = args.print !== null && args.outputFormat === "stream-json";
  // #77：带 --json-schema 的 text 模式同样要把进度/工具挤到 stderr ——
  // stdout 只留那份校验通过的紧凑 JSON，否则 jq 消费不了。
  const structuredMode = jsonMode || streamJsonMode || jsonSchema !== null;
  const ui = new Console(
    cfg.theme === "matrix",
    cfg.toolcallInfoDetails,
    dock
      ? { dock, getTier: () => cfg.modelTier }
      : structuredMode
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

  // #37 stream-json：唯一 writer 只在 streamJsonMode 下创建，session_id 取 sess.meta.id。
  // （s.stdoutClosed / s.turnNo 的语义见 SharedMut。）
  let streamWriter: JsonlWriter | null = null;
  if (streamJsonMode) {
    streamWriter = new JsonlWriter({ sessionId: sess.meta.id, cwd: cfg.cwd });
  }

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
      // 名字装配走真实 wiring（openMailboxIdentity）：
      //  - --name 撞名加后缀（Jacky-2），记 suffixFrom 供 toast；
      //  - resume 保留旧名；
      //  - 默认名由计数器发号，撞名再分配下一个号（绝不给 Neo#N 加后缀）。
      const opened = openMailboxIdentity({
        root: mailbox.root,
        sessionId: sess.meta.id,
        cwd: cfg.cwd,
        mode: args.mode,
        explicit: args.name,
        previous: resumePreviousName,
        deadAfterMs: cfg.mailbox.deadAfterMs,
      });
      s.sessionLabel = opened.identity.profile.name;
      // 只有 --name 会走唯一后缀；默认名撞名是再分配，不会出现后缀。
      if (opened.suffixFrom && s.sessionLabel) {
        ui.info(`代号 ${opened.suffixFrom} 已被占用，本会话使用 ${s.sessionLabel}`);
      }
      sweepSessions(mailbox.root, { ttlMs: cfg.mailbox.sessionTtlMs });
    } catch (e) {
      // 默认名预留失败（计数器写不进去）= 没有拿到号，绝不能静默换个名字继续：
      // 那样下一个进程会发出同一个 Neo#N。必须致命退出。
      if (e instanceof DefaultNameReservationError) {
        console.error(c.err(`✖ ${e.message}`));
        return 2;
      }
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

  // 信箱不可用：本地仍选一个默认名，仅用于标题显示（不落盘、不参与寻址）。
  // 默认编号要读信箱根目录的计数器，所以包在 try/catch 里 —— 但预留失败
  // （DefaultNameReservationError）不是「读不到」，必须致命退出，不能兜底成 neo。
  if (mailboxEnabled && s.sessionLabel === null) {
    let local: ChosenName | null = null;
    try {
      local = chooseSessionName({
        explicit: args.name,
        previous: resumePreviousName,
        root: mailboxRoot(),
      });
    } catch (e) {
      if (e instanceof DefaultNameReservationError) {
        console.error(c.err(`✖ ${e.message}`));
        return 2;
      }
      local = null;
    }
    s.sessionLabel = local?.name ?? "neo";
  }

  /** 最近一次入站：对端 session → 消息 id；send_message 缺省 reply_to 时自动补任务号。 */
  const inboundRefs = new Map<string, string>();

  // watchdog 计时起点 = 信箱装配完成（与拆分前 `let lastWatchdogAt = Date.now()` 同位置）。
  // 读方：sessionStart 的 P1 检查与 repl 的空闲 tick，均按 now - lastWatchdogAt >=
  // watchdogIntervalS 判定首次检查时机；若改用 bootstrap 开头的时刻，首检会提前
  // 「配置 / worktree / 会话恢复」这段耗时，所以这一行不是重复初值，必须保留。
  s.lastWatchdogAt = Date.now();
  /** 清理信箱资源（幂等）：停 tick、删 .alive。 */
  function closeMailbox(): void {
    if (s.mailboxClosed) return;
    s.mailboxClosed = true;
    if (s.mailboxTick) {
      clearInterval(s.mailboxTick);
      s.mailboxTick = null;
    }
    if (s.heartbeatTick) {
      clearInterval(s.heartbeatTick);
      s.heartbeatTick = null;
    }
    if (mailbox) releaseAlive(mailbox.root, mailbox.sessionId);
  }

  // 心跳必须独立于空闲 tick：turn 进行中（长 LLM 调用）也要每 15s 刷新，
  // 否则别的会话的 watchdog 会看到心跳停 120s+，把正在干活的活进程误报成 dead。
  if (mailbox) {
    const hb = mailbox;
    s.heartbeatTick = setInterval(() => {
      try {
        mailboxState.touchHeartbeat(hb.root, hb.sessionId);
      } catch {
        // 心跳写失败不阻塞主流程
      }
    }, cfg.mailbox.heartbeatMs);
    (s.heartbeatTick as unknown as { unref?: () => void }).unref?.();
  }

  /** 轮询 inbox、按入站三态裁决，返回 accept 的消息并打印预览。limit 留空=不限。 */
  function collectInbound(limit?: number): Envelope[] {
    if (!mailbox) return [];
    const mb = mailbox;
    const envs = mb.poll((env) => decideInbound(cfg.crossSessionInbound, s.agent!.mode, env.from.mode), limit);
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
  const overBudget = makeOverBudgetReporter({
    interactive: interactiveTTY,
    current: () => ({ provider: cfg.providerName, model: cfg.model }),
    log: (message) => logBootDiagnostic({ kind: "prompt-budget", message }),
    warn: (message) => ui.warn(message),
    bootBlockPrinted: () => s.bootBlockPrinted,
  });
  const onPromptSelection = (sel: PromptSelection): void => overBudget.report(sel);
  const promptManager = new PromptManager({
    mailbox: mailboxEnabled,
    askUser: interactiveTTY,
    // issue #71：Code Mode 只开交互 TUI —— -p 的提示词里不能出现 run_js。
    nonInteractive: args.print !== null,
    sessionName: s.sessionLabel,
    onSelection: onPromptSelection,
  });
  // issue #17：路径作用域规则（.neo/rules + .claude/rules）。无规则时零额外上下文。
  const projectRules = discoverProjectRules(cfg.cwd);
  const scopedRuleList = projectRules.filter((r) => r.paths.length > 0);
  const alwaysOnRules = projectRules.filter((r) => r.paths.length === 0);

  // #59：会话级备用链只接主 Agent 请求；交互与 -p（含 --drive）共用同一 controller。
  const fallbackController =
    effectiveFallbacks.length > 0
      ? new ModelFallbackController({
          cfg,
          fallbacks: effectiveFallbacks,
          onNotice: (m) => ui.warn(m),
          onFallback: (e) => {
            // #37：备用目标完整响应成功并提交后触发（controller 在 commit(i,target) 之后、
            // return res 之前调用），因此早于本轮 assistant_message。data 逐字段投影：
            // FallbackFailure = {target: ModelTarget, code, message} → 展平为 provider/model。
            if (streamWriter && !s.stdoutClosed) {
              streamWriter.emitModelFallback({
                from: { provider: e.from.provider, model: e.from.model },
                to: { provider: e.to.provider, model: e.to.model },
                reason: {
                  code: e.reason.code,
                  message: clipFallbackReason(e.reason.message),
                },
                attempts: e.attempts.map((a) => ({
                  provider: a.target.provider,
                  model: a.target.model,
                  code: a.code,
                  message: clipFallbackReason(a.message),
                })),
              });
            }
            ui.warn(
              `[fallback] ${e.from.provider}:${e.from.model} → ${e.to.provider}:${e.to.model}` +
                `（${e.reason.code}：${e.reason.message}）`,
            );
          },
        })
      : null;


  return Object.assign(s, {
    args,
    requestedTier,
    overrides,
    worktreeInfo,
    cfg,
    effectiveFallbacks,
    interactiveTTY,
    preComposerRows,
    dockHost,
    dock,
    jsonMode,
    streamJsonMode,
    structuredMode,
    jsonSchema,
    ui,
    maybeProbeOutputLimit,
    announcedCapabilityGap,
    announceCapabilityGap,
    restored,
    meta,
    resumeRoot,
    isRunningSession,
    resumePreviousName,
    classifier,
    sess,
    streamWriter,
    checkpoints,
    rewindLog,
    memoryMode,
    memory,
    mailboxEnabled,
    mailbox,
    inboundRefs,
    closeMailbox,
    collectInbound,
    overBudget,
    onPromptSelection,
    promptManager,
    projectRules,
    scopedRuleList,
    alwaysOnRules,
    fallbackController,
  });
}
