/**
 * 配置类型、档位/协议常量和与加载过程无关的解析函数。
 *
 * 结构说明见 ../config.ts 文件头。本模块是叶子：不依赖 loadConfig。
 */
import type { EnvConfig } from "../env/types.ts";
import type { ShellConfig } from "../shell.ts";
import type { HooksConfig } from "../hooks/types.ts";
import type { PromptSelectionConfig } from "../prompt/select.ts";
import type {
  InboundPolicy,
  MailboxConfig,
} from "../mailbox/types.ts";

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export { ConfigError };

export function windowSourceFor(cfg: Config, providerWindow: number | null | undefined): "config" | "default" {
  if (providerWindow != null) return "config";
  return cfg.globalWindowExplicit ? "config" : "default";
}

export function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
/** 三态布尔：只认 true/false，其余（含缺失、"true" 字符串）一律 undefined = 未填。 */
export function boolOrUndef(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
export function str(v: unknown, d: string): string {
  return typeof v === "string" && v.length > 0 ? v : d;
}

export function normalizeBaseUrl(u: string): string {
  return u.replace(/\/+$/, "");
}


/**
 * provider 的 API 协议。
 *
 * openai = OpenAI 兼容 /chat/completions；anthropic = Anthropic Messages /v1/messages。
 * 两者鉴权头与响应结构都不兼容，必须按声明的协议发请求，不能静默互相替代
 * （声明了多个协议时的回退见 llm.ts 的 endpointPlan）。
 */
export type ProviderType = "openai" | "anthropic";

/** 真正实现了请求层适配的类型。其余为「已声明但未接入」（未来新增协议时用）。 */
export const IMPLEMENTED_PROVIDER_TYPES: readonly ProviderType[] = ["openai", "anthropic"];

/** 协议优先级：两种都能通时优先 anthropic。 */
export const API_TYPE_PREFERENCE: readonly ProviderType[] = ["anthropic", "openai"];

export function isImplemented(type: ProviderType): boolean {
  return IMPLEMENTED_PROVIDER_TYPES.includes(type);
}

/** 模型档位。取值决定用 provider 下的哪个 *_model_name 字段。 */
export type ModelTier = "default" | "deep_reasoning" | "balanced" | "fast";

export const MODEL_TIERS: readonly ModelTier[] = [
  "default",
  "deep_reasoning",
  "balanced",
  "fast",
];

export const TIER_FIELD: Record<ModelTier, string> = {
  default: "default_model_name",
  deep_reasoning: "deep_reasoning_model_name",
  balanced: "balanced_model_name",
  fast: "fast_model_name",
};

export function isModelTier(v: string): v is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(v);
}

/**
 * 用户输入 → 规范档位名（v0.4.2）。内部/配置/路由仍用 `deep_reasoning`，
 * 这里只服务 `/tier`、`--tier`、task 等人类输入入口；大小写/空白不敏感。
 *
 * 为什么不在内部改名：`deep_reasoning_model_name` / `model_routes.deep_reasoning` /
 * 会话/测试/文档已按规范名落盘，改名需要 schema 迁移且会破坏旧 settings。
 */
export function normalizeTierName(input: string): ModelTier | null {
  const v = input.trim().toLowerCase();
  switch (v) {
    case "default":
    case "auto":
    case "dflt":
      return "default";
    case "deep_reasoning":
    case "deep-reasoning":
    case "deep":
    case "d":
    case "reasoning":
      return "deep_reasoning";
    case "balanced":
    case "balance":
    case "bal":
    case "b":
      return "balanced";
    case "fast":
    case "f":
      return "fast";
    default:
      return null;
  }
}

/** 展示用短名：内部 `deep_reasoning` → UI/命令里显示 `deep`；其余同名。 */
export function tierDisplayName(tier: ModelTier | string): string {
  return tier === "deep_reasoning" ? "deep" : tier;
}

/** 展示名 + 规范名（需区分时）：`deep (deep_reasoning)`；fast/balanced/default 只显示短名。 */
export function tierChoiceLabel(tier: ModelTier | string): string {
  const short = tierDisplayName(tier);
  return short === tier ? short : `${short} (${tier})`;
}

export interface ProviderConfig {
  name: string;
  /** 首选协议（= apiTypes[0]）。 */
  type: ProviderType;
  /**
   * 声明的全部协议，已按 API_TYPE_PREFERENCE 排序（anthropic 在前）。
   * 缺省 = [type]。多于一个时，请求层先用首选协议，遇到「该协议端点不存在」再回退下一个。
   */
  apiTypes?: ProviderType[];
  /** 首选协议对应的 base_url。 */
  baseUrl: string;
  /** 各协议各自的 base_url（未单独覆盖的回落到 base_url）。 */
  baseUrls?: Partial<Record<ProviderType, string>>;
  apiKey: string;
  /** 四个档位各自对应的模型 ID。 */
  models: Record<ModelTier, string>;
  /** 该 provider 的运行时参数；缺省时回落到全局值。 */
  maxTokens: number | null;
  temperature: number | null;
  contextWindow: number | null;
  /**
   * 模型能力的手写声明（P1）。undefined = 未填，交给 /models 探测补；
   * 填了就权威，探测结果不得覆盖。注意 maxTokens 是「请求输出预算」，不是能力上限。
   */
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  /**
   * 模型单次输出上限（P3）。与 `maxTokens` 语义不同：后者是「本次请求要多少输出」，
   * 这里是「模型最多能给多少」。由探测写回填充，也可手写；null/undefined = 未填。
   * 展示口径仍遵循 P2：能力上限 ≠ cfg.maxTokens（见 buildModelCapabilityView）。
   */
  maxOutputTokens?: number | null;
  /**
   * 输出上限的**主动探测**配置（issue #8）。undefined = 未配置 = 关闭。
   * 只在交互启动、上限仍为空、`/models` 没给、7 天内没探过时才会真的发请求。
   */
  outputProbe?: OutputProbeSettings;
}

/** 档位 → 目标 {provider, model} 的绑定。跨供应商调度靠这个。 */
export interface RouteConfig {
  provider: string;
  model: string | null;
  /** 目标 provider 的协议未接入时，是否允许静默降级。 */
  fallbackAllowed: boolean;
}

/**
 * LLM 请求重试与超时策略（P0-1）。
 *
 * 只重试「尚未向用户输出任何增量」的失败；时间单位毫秒。
 * settings.json 的 `retry` 段可覆盖，缺省值见 DEFAULT_RETRY_CONFIG。
 */
export interface RetryConfig {
  /** 总尝试次数（含首次）。1 = 不重试。 */
  maxAttempts: number;
  /** 指数退避基数（毫秒）。 */
  baseDelayMs: number;
  /** 连接 + 首字节超时（毫秒）。 */
  connectTimeoutMs: number;
  /** 流式空闲超时（毫秒），每收到一个 chunk 重置。 */
  streamIdleTimeoutMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  connectTimeoutMs: 30_000,
  streamIdleTimeoutMs: 120_000,
};

/**
 * 工具并行策略（issue #11）。
 *
 * 刻意不做成 boolean：boolean 只有「全串行 / 全并行」两档，而全并行会让
 * write_file / edit_file / shell 之间失去顺序保证 —— 那不是我们要的。
 *  - "off"：请求体 parallel_tool_calls=false，本地一律串行（瘦网关兜底/排障用）；
 *  - "readonly"（默认）：请求体 true，本地只并行连续的可并行只读工具。
 */
export type ParallelToolCallsMode = "off" | "readonly";

export const DEFAULT_PARALLEL_TOOL_CALLS: ParallelToolCallsMode = "readonly";

/**
 * 解析 settings.parallel_tool_calls。接受 "off"/"readonly"（大小写不敏感），
 * 也接受布尔（true → readonly，false → off）方便手写；其余值一律回落到默认，
 * 不抛错 —— 一个拼错的开关不值得让整个 CLI 起不来。
 */
export function resolveParallelToolCalls(raw: unknown): ParallelToolCallsMode {
  if (typeof raw === "boolean") return raw ? "readonly" : "off";
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "off" || v === "false" || v === "none" || v === "serial") return "off";
    if (v === "readonly" || v === "read_only" || v === "true" || v === "on") return "readonly";
  }
  return DEFAULT_PARALLEL_TOOL_CALLS;
}

/**
 * 输出上限（`max_output_tokens`）主动探测的配置（issue #8）。
 *
 * 语义：只在「网关不给上限」时才会用请求去试边界，**默认关闭** —— 探测会真的花
 * 请求配额，必须是用户显式开启的能力，不能偷偷替所有人跑。
 */
export interface OutputProbeSettings {
  enabled: boolean;
  /** 一次探测最多发几个请求（1–8）。 */
  maxAttempts: number;
  /** 第一个候选预算；之后每档翻倍。 */
  start: number;
  /** 候选上限，防止为探极端值多花请求。 */
  cap: number;
}

export const DEFAULT_OUTPUT_PROBE: OutputProbeSettings = {
  enabled: false,
  maxAttempts: 3,
  start: 8_192,
  cap: 131_072,
};

function clampInt(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/**
 * 解析 settings 里的 `probe_max_output_tokens`：
 *  - 未配置（undefined）→ undefined，表示「用户没表达意图」，行为与今天完全一致；
 *  - 布尔简写 true/false → 只改 enabled；
 *  - 对象 → `{ enabled?: boolean, max_attempts?, start?, cap? }`，缺 enabled 视为开启；
 *  - 其它形状（字符串/数组/数字/null）→ undefined，不抛错 —— 拼错的开关不该让 CLI 起不来。
 *
 * 越界值夹紧：max_attempts 1–8、start ≥256、cap < start 时以 start 为准。
 */
export function resolveOutputProbe(raw: unknown): OutputProbeSettings | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return { ...DEFAULT_OUTPUT_PROBE, enabled: raw };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const enabled = typeof rec["enabled"] === "boolean" ? rec["enabled"] : true;
  const maxAttempts = clampInt(rec["max_attempts"], 1, 8) ?? DEFAULT_OUTPUT_PROBE.maxAttempts;
  const start = clampInt(rec["start"], 256, Number.MAX_SAFE_INTEGER) ?? DEFAULT_OUTPUT_PROBE.start;
  const capRaw = clampInt(rec["cap"], 256, Number.MAX_SAFE_INTEGER) ?? DEFAULT_OUTPUT_PROBE.cap;
  return { enabled, maxAttempts, start, cap: Math.max(capRaw, start) };
}

/* ------------------------------------------------------------------ */
/* #59 有序模型备用链                                                  */
/* ------------------------------------------------------------------ */

/**
 * 备用链单项：明确的 provider + model。
 *
 * 与 `model_routes.<tier>.fallback_allowed`（档位目标协议不可用时向 default 降级）
 * 不是一回事：那是路由降级，这里是主模型请求失败后的有序备用链。
 */
export interface ModelTarget {
  provider: string;
  model: string;
}

/** 备用项上限：把「有界」变成可测试的配置约束，不是运行时自动截断。 */
export const MAX_MODEL_FALLBACKS = 8;

/** 校验一个 target：provider 必须存在且协议已接入，model 非空。 */
function assertModelTarget(target: ModelTarget, providers: ProviderConfig[], where: string): void {
  if (!target.provider || !target.model) {
    throw new ConfigError(`${where} 需要非空的 provider 与 model。`);
  }
  const p = providers.find((x) => x.name === target.provider);
  if (!p) {
    throw new ConfigError(
      `${where} 的 provider "${target.provider}" 不在 providers 列表中。` +
        `已配置：${providers.map((x) => x.name).join(", ") || "（无）"}`,
    );
  }
  if (!isImplemented(p.type)) {
    throw new ConfigError(
      `${where} 的 provider "${target.provider}" 声明为 ${p.type} 协议，但请求层尚未接入。` +
        `已实现：${IMPLEMENTED_PROVIDER_TYPES.join(", ")}。`,
    );
  }
}

/**
 * 严格解析 settings.model_fallback：只接受对象数组，不接受字符串简写、对象 map 或旧字段别名。
 * 缺省 / [] = 禁用；任何非法形状、未知 provider、空字段、重复项或超过 8 项都在模型请求前报错。
 */
export function resolveModelFallback(raw: unknown, providers: ProviderConfig[]): ModelTarget[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError("settings.model_fallback 必须是对象数组（[{provider, model}, ...]）。");
  }
  if (raw.length > MAX_MODEL_FALLBACKS) {
    throw new ConfigError(`settings.model_fallback 最多 ${MAX_MODEL_FALLBACKS} 项（收到 ${raw.length} 项）。`);
  }
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = `model_fallback[${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ConfigError(`${where} 必须是 {provider, model} 对象。`);
    }
    const rec = item as Record<string, unknown>;
    const target: ModelTarget = {
      provider: typeof rec["provider"] === "string" ? rec["provider"].trim() : "",
      model: typeof rec["model"] === "string" ? rec["model"].trim() : "",
    };
    assertModelTarget(target, providers, where);
    const key = `${target.provider}\u0000${target.model}`;
    if (seen.has(key)) {
      throw new ConfigError(`${where} 与前面的备用项重复：${target.provider}:${target.model}。`);
    }
    seen.add(key);
    return target;
  });
}

/**
 * 解析 CLI --fallback <provider>:<model>：在第一个冒号分割，两侧 trim 后必须非空。
 * provider 名本身含冒号不支持，避免二义。
 */
export function parseFallbackTarget(text: string, providers: ProviderConfig[]): ModelTarget {
  const at = text.indexOf(":");
  if (at <= 0 || at === text.length - 1) {
    throw new ConfigError(`--fallback 需要 <provider>:<model>（收到 "${text}"）。`);
  }
  const target: ModelTarget = {
    provider: text.slice(0, at).trim(),
    model: text.slice(at + 1).trim(),
  };
  assertModelTarget(target, providers, "--fallback");
  return target;
}

/**
 * 把会话共享 cfg 切到目标 provider+model（#59）。
 *
 * 重新赋 provider/协议/key/baseUrl/model、输出预算、温度与窗口事实；
 * 不复制来源模型的 maxTokens / 窗口 / baseUrl / key / 协议，也不写 settings。
 * modelTier 保留当前展示档位，但 fallback 身份优先于档位路由。
 */
export function applyModelTarget(cfg: Config, target: ModelTarget): void {
  const p = cfg.providers.find((x) => x.name === target.provider);
  if (!p) throw new ConfigError(`备用目标 provider "${target.provider}" 不存在。`);
  if (!isImplemented(p.type)) {
    throw new ConfigError(`备用目标 provider "${target.provider}" 的 ${p.type} 协议未接入。`);
  }
  const g = cfg.globalDefaults;
  cfg.providerName = p.name;
  cfg.providerType = p.type;
  cfg.apiKey = p.apiKey;
  cfg.baseUrl = p.baseUrl;
  cfg.model = target.model;
  cfg.maxTokens = p.maxTokens ?? g.maxTokens;
  cfg.temperature = p.temperature ?? g.temperature;
  cfg.contextWindow = p.contextWindow ?? g.contextWindow;
  cfg.configuredContextWindow = cfg.contextWindow;
  cfg.contextWindowSource = windowSourceFor(cfg, p.contextWindow);
  cfg.configuredContextWindowExplicit = cfg.contextWindowSource === "config";
}

export interface Config {
  /** 当前选中的 provider（已解析为具体值）。 */
  providerName: string;
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  /** 当前档位。 */
  modelTier: ModelTier;
  /** 由档位解析出的实际模型 ID。 */
  model: string;
  /** 全部 provider，供 /provider 展示与切换。 */
  providers: ProviderConfig[];
  /**
   * 档位路由表：tier → {provider, model}。
   * 与 provider 内的 models 正交 —— 档位可以指向任意 provider 的任意模型。
   */
  routes: Record<ModelTier, RouteConfig>;
  /** 分类器自己用的模型与 provider（固定外部指定，避免循环依赖）。 */
  classifierModel: string;
  classifierProvider: string;
  /** 本次启动是否使用了旧版扁平配置。 */
  legacyFormat: boolean;
  /**
   * max_tokens 配置体检结果（issue #21 A）。加载时逐 provider 判定：
   * 输出预算 ≥ 上下文窗口 / 超过已声明的单次输出上限。空数组 = 无告警。
   * 只告警不改配置；由启动块逐条打印（交互与 -p 共用）。
   */
  maxTokensWarnings: string[];

  maxTokens: number;
  temperature: number;
  contextWindow: number;
  /** settings/provider/globalDefaults 当时的原始窗口值（不被探测结果覆盖，B2 用）。 */
  configuredContextWindow?: number;
  /**
   * contextWindow 的来源（v0.4.1 A2）：
   *  - config = settings 值；models_api/overflow_error = 自动探测；known = 兜底表；
   *    default = 无任何依据的 200,000 兜底（不是事实）。
   *  只用于 /context 展示与排障，不参与序列化。
   */
  contextWindowSource?: "config" | "models_api" | "overflow_error" | "known" | "default";
  /** configuredContextWindow 是否为用户显式配置（false = 模板/内置兜底，来源应记为 default）。 */
  configuredContextWindowExplicit?: boolean;
  /** settings 顶层是否显式写了 context_window（决定回落到全局默认时算 config 还是 default）。 */
  globalWindowExplicit?: boolean;
  /** 顶层全局默认。provider 未覆盖某项时用它，切换 provider 时据此回滚。 */
  globalDefaults: { maxTokens: number; temperature: number; contextWindow: number };
  compactThreshold: number;
  maxToolIterations: number;
  toolOutputLimit: number;
  /**
   * LLM 重试/超时策略。所有字段都有默认值；测试可直接注入缩小的超时。
   * 缺省时 llm.ts 回落到 DEFAULT_RETRY_CONFIG。
   */
  retry?: RetryConfig;
  theme: string;
  showReasoning: boolean;
  /**
   * 工具调用详情显示。false（默认）= 交互模式下紧凑单行（. / .. / ... 动画，下一个调用覆盖）；
   * true = 旧版 header + 缩进结果块。
   */
  toolcallInfoDetails: boolean;
  /** 粘贴增强配置（PRD docs/paste-enhancement-prd[done].md §5.7）。 */
  paste: PasteConfig;
  /** 跨会话消息配置（docs/cross-session-messaging-prd[done].md v1.2 §4.6 / §4.10）。 */
  mailbox: MailboxConfig;
  /** 入站策略；"auto" = 按接收方权限档自动判定。 */
  crossSessionInbound: InboundPolicy | "auto";
  /** 透传给服务端的思考开关；不设则不下发该字段，由服务端自行决定。 */
  thinking?: { type: "enabled" | "disabled" };
  /**
   * 工具并行策略（issue #11）。默认 "readonly"。
   *  - "off"：请求体 parallel_tool_calls=false，本地一律串行；
   *  - "readonly"：请求体 parallel_tool_calls=true，本地只把**连续的可并行只读工具**
   *    并行执行，写工具/有副作用的工具仍是串行屏障。
   * 不要把它做成「全并行」：写工具之间、写与其前后依赖必须保持顺序。
   */
  parallelToolCalls: ParallelToolCallsMode;
  cwd: string;
  settingsPath: string | null;
  /**
   * 全局技能库路径。默认 ~/.neo/skills。
   * 独立字段而非在 skills.ts 里硬编码 homedir()：测试必须能注入沙箱路径，
   * 否则会读写用户真实的技能库。
   */
  skillsStore: string;
  /** 额外技能目录（v0.4.1 B3）：按顺序只读扫描，用于外部技能包/团队共享目录。 */
  skillsExtraPaths?: string[];
  /**
   * 记忆系统配置。PRD docs/memory-prd.md §6.3 + §A 配套。
   * 实现层用 `cfg.memory.userLevelDir ?? homedir()/.neo/memorys`（§7.3）：
   * 测试场景下 cfg.memory 总有值；真启动路径下 loadConfig 必填默认。
   */
  memory: MemoryConfig;
  /** 跨平台 shell 覆盖（v0.4.0 平台适配层；不填=自动探测）。 */
  shell?: ShellConfig;
  /**
   * MCP 外部工具服务器（issue #2）。settings.json 顶层 `mcpServers` 段，
   * 形状对齐 Claude Desktop / Cursor 的约定。缺省 = 不接任何外部工具。
   */
  mcpServers?: McpServerConfig[];
  /**
   * 生命周期 hooks（issue #3）。settings.json 顶层 `hooks` 段。
   *
   * 定位：用户自配的生命周期脚本，**不是权限系统**。它只能阻断或放行到既有
   * 审批流程，不能把调用升级为免审批，也不能绕过 plan 拒绝。
   * 会话启动时加载一次 —— 改配置需重启（与 mcpServers 同口径）。
   */
  hooks: HooksConfig;
  /** 环境探测/注入配置（v0.4.0；不填=默认开启、TTL 12h、注入+写 wiki 页）。 */
  env?: EnvConfig;
  /** 系统提示词三档选择（issue #20）。settings.json 顶层 `system_prompt` 段；缺省按 DEFAULT_SELECTION_CONFIG。 */
  systemPrompt: PromptSelectionConfig;
  /** 仓库地图（issue #15）：符号级地图注入系统提示词；`repo_map` 段可关/调预算。 */
  repoMap: RepoMapConfig;
  /** 语言服务器（issue #23）：编辑后诊断 + 只读符号导航；未配置 = 零开销。 */
  lsp: LspConfig;
  /** lsp 配置告警（启动时打印一次）。 */
  lspWarnings: string[];
  /** #59 有序模型备用链；缺省空数组 = 禁用。与 model_routes.*.fallback_allowed 无关。 */
  modelFallback: ModelTarget[];
}

/**
 * 记忆系统配置（v0.2 记忆激活；规格 docs/001-memory-system-design[done].md §7.9）。
 *
 * v0.1.12 清理：随 deprecated 实现删除了一批从未被消费的字段
 * （cwdRelativeMode / worktreeIsolation / maxProfileChars / profileTokensLimit /
 * ingest / autoWriteIndex / noProfileInOneShot / platform / piiFilter / ingestJournal）。
 * 旧 settings.json 里的这些键会被静默忽略，不报错。
 */
export interface MemoryConfig {
  /** 总开关；false 时记忆读写全部 no-op。 */
  enabled: boolean;
  /**
   * 旧用户级目录（~/.neo/memorys）。只服务于 `/memory migrate` 与旧 profile.md 兼容读取；
   * v0.1.11 起记忆不再写这里。NEO_MEMORY_DIR 可覆盖。
   */
  userLevelDir: string;
  /** 用户级 wiki 根目录（NEO_USER_WIKI_DIR 可覆盖）。 */
  userWikiDir: string;
  /** 运行 journal 目录（NEO_MEMORY_JOURNAL_DIR 可覆盖）。 */
  journalDir: string;
  /** 每轮开始前的自动召回（R1）。 */
  autoRecall: {
    enabled: boolean;
    maxTokens: number;
    projectPages: number;
    userPages: number;
  };
  /** 轮末自动捕获（T1/T2）。 */
  autoCapture: {
    enabled: boolean;
    mode: "off" | "boundary" | "every_turn";
    modelTier: string;
    maxOpsPerTurn: number;
    maxPagesPerSession: number;
    minConfidence: number;
    minInferredConfidence: number;
    journalRetentionDays: number;
    flushTimeoutMs: number;
  };
  /** 静默模式：不打印「记忆 +N」提示。 */
  quiet: boolean;
  /**
   * 交互会话轮末按需后台 wiki 维护（issue #53，settings `memory.auto_maintain`，默认 true）。
   * false = 完全关闭自动增量编译与自动体检收口（手动 /ingest 不受影响）。
   */
  autoMaintain: boolean;
  /**
   * 运行时会话的记忆作用域（不落配置文件）。
   * -p 单次模式由组合根置为 "project"：只读写项目级记忆，
   * 避免服务器脚本场景混入操作员个人记忆。
   */
  scopeMode?: "both" | "project";
}

export type Raw = Record<string, unknown>;

/**
 * 一个 MCP stdio server 的配置（issue #2）。
 *
 * 形状对齐 Claude Desktop / Cursor 的 `mcpServers` 写法，用户不必为 neo 另学一套：
 *   "mcpServers": {
 *     "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
 *   }
 * 对象形态（键即 server 名）与数组形态（每项带 name）都接受，见 parseMcpServers。
 */
export interface McpServerBase {
  /** server 名。工具名会拼成 `mcp__<name>__<tool>`，因此只允许 [A-Za-z0-9_-]。 */
  name: string;
  /** false = 跳过连接（保留配置但不启动）。 */
  enabled: boolean;
}

/** 本地进程传输（issue #2）。 */
export interface McpStdioServerConfig extends McpServerBase {
  transport: "stdio";
  /** 可执行文件（npx / bunx / node / 绝对路径）。 */
  command: string;
  args: string[];
  /** 追加到子进程环境变量（在 process.env 之上覆盖）。 */
  env: Record<string, string>;
  /** 子进程工作目录；缺省 = neo 的 cwd。 */
  cwd?: string;
}

/**
 * 远程 HTTP 传输（issue #29，streamable HTTP）。
 *
 * 形状对齐主流 CLI：`{ "type": "http", "url": "https://…", "headers": { "Authorization": "Bearer …" } }`。
 * 首期只做静态 `headers`，不做 OAuth 浏览器登录（见 docs/mcp-http-prd.md 非目标）。
 */
export interface McpHttpServerConfig extends McpServerBase {
  transport: "http";
  /** 完整端点 URL（streamable HTTP 入口）。 */
  url: string;
  /** 额外请求头（鉴权等）。 */
  headers: Record<string, string>;
}

/**
 * 旧式 SSE 传输（issue #44，来源 #29 非目标）。
 *
 * `url` 是 **GET 长连接**地址；POST 目标由服务端首事件 `event: endpoint` 给出。
 * 与 `McpHttpServerConfig` 字段相同，但协议形态完全不同（见 `src/mcp/sseRpc.ts` 文件头）。
 */
export interface McpSseServerConfig extends McpServerBase {
  transport: "sse";
  url: string;
  headers: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

/**
 * 语言服务器配置（issue #23）。
 *
 * 设计：**不捆绑语言服务器**，只按配置启动用户本机已安装的命令（如
 * `typescript-language-server --stdio`）。没配 servers = 零开销（不 spawn、不扫盘）。
 */
export interface LspServerConfig {
  name: string;
  command: string;
  args: string[];
  /** 归这个 server 处理的后缀（含点，小写）。 */
  extensions: string[];
}

export interface LspConfig {
  enabled: boolean;
  servers: LspServerConfig[];
  /** 等编辑后诊断的超时（毫秒，默认 1500）。 */
  diagnosticsTimeoutMs: number;
}

export const DEFAULT_LSP: LspConfig = { enabled: false, servers: [], diagnosticsTimeoutMs: 1_500 };

/** 常见 server 的扩展名推断（用户没写 extensions 时兜底）。 */
function inferLspExtensions(name: string, command: string): string[] {
  const id = `${name} ${command}`.toLowerCase();
  if (id.includes("typescript") || id.includes("ts-ls") || id.includes("vtsls")) {
    return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  }
  if (id.includes("pyright") || id.includes("pylsp") || id.includes("python")) return [".py"];
  if (id.includes("gopls") || id.includes("go-")) return [".go"];
  if (id.includes("rust-analyzer") || id.includes("rust")) return [".rs"];
  return [];
}

/**
 * 解析 settings 顶层 `lsp`：
 *   "lsp": { "enabled": true, "servers": [ { "command": "typescript-language-server", "args": ["--stdio"] } ],
 *            "diagnostics_timeout_ms": 1500 }
 * 非法条目只跳过并给 warning（不让整个 CLI 起不来）。
 */
export function resolveLspConfig(raw: unknown): { config: LspConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined) return { config: { ...DEFAULT_LSP, servers: [] }, warnings };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: { ...DEFAULT_LSP, servers: [] }, warnings: ["lsp 段必须是对象，已忽略。"] };
  }
  const r = raw as Raw;
  const enabled = typeof r["enabled"] === "boolean" ? r["enabled"] : DEFAULT_LSP.enabled;
  const timeoutRaw = numOrNull(r["diagnostics_timeout_ms"]);
  const diagnosticsTimeoutMs =
    timeoutRaw !== null && timeoutRaw >= 200 ? Math.min(10_000, Math.floor(timeoutRaw)) : DEFAULT_LSP.diagnosticsTimeoutMs;
  const servers: LspServerConfig[] = [];
  const list = r["servers"];
  if (Array.isArray(list)) {
    for (const [i, item] of list.entries()) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        warnings.push(`lsp.servers[${i}] 不是对象，已跳过。`);
        continue;
      }
      const s = item as Raw;
      const command = str(s["command"], "").trim();
      const name = str(s["name"], command.split(/[\\/]/).pop() ?? `lsp-${i}`).trim() || `lsp-${i}`;
      if (command === "") {
        warnings.push(`lsp.servers[${i}]（${name}）缺少 command，已跳过。`);
        continue;
      }
      const argsRaw = s["args"];
      const args = Array.isArray(argsRaw) ? argsRaw.map((a) => String(a)) : [];
      const extRaw = s["extensions"];
      const extensions = Array.isArray(extRaw)
        ? extRaw.map((x) => String(x).trim().toLowerCase()).filter((x) => x.startsWith("."))
        : inferLspExtensions(name, command);
      if (extensions.length === 0) {
        warnings.push(`lsp.servers[${i}]（${name}）没有可用的 extensions（推断不出语言），已跳过。`);
        continue;
      }
      servers.push({ name, command, args, extensions });
    }
  } else if (list !== undefined) {
    warnings.push("lsp.servers 必须是数组，已忽略。");
  }
  return { config: { enabled, servers, diagnosticsTimeoutMs }, warnings };
}

/**
 * 仓库地图配置（issue #15）。settings.json 顶层 `repo_map` 段。
 *
 * 定位：给系统提示词注入一份**受预算限制的符号地图**（文件 → 主要导出/定义），
 * 让模型在大仓里先看见结构再 grep。默认开启、预算保守（800 tokens 估算）。
 */
export interface RepoMapConfig {
  enabled: boolean;
  /** 地图预算（按 4 字符 ≈ 1 token 估算成字符上限）。 */
  budgetTokens: number;
  /** 一次扫描最多读多少个源文件（防超大仓把启动拖慢）。 */
  maxFiles: number;
}

export const DEFAULT_REPO_MAP: RepoMapConfig = {
  enabled: false,
  budgetTokens: 800,
  maxFiles: 1_200,
};

/** 解析 `repo_map` 段：非法值回落默认；显式 enabled:false 才关闭。 */
export function resolveRepoMapConfig(raw: unknown): RepoMapConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_REPO_MAP };
  const r = raw as Raw;
  const enabled = typeof r["enabled"] === "boolean" ? r["enabled"] : DEFAULT_REPO_MAP.enabled;
  const budget = numOrNull(r["budget_tokens"]);
  const maxFiles = numOrNull(r["max_files"]);
  return {
    enabled,
    budgetTokens: budget !== null && budget >= 100 ? Math.min(8_000, Math.floor(budget)) : DEFAULT_REPO_MAP.budgetTokens,
    maxFiles: maxFiles !== null && maxFiles >= 10 ? Math.min(20_000, Math.floor(maxFiles)) : DEFAULT_REPO_MAP.maxFiles,
  };
}

/**
 * 粘贴增强配置（PRD docs/paste-enhancement-prd[done].md §5.7）。
 * settings.json 的 paste.* 段；整块缺省 = 功能开启（不做总开关，chip 语义上线后关闭会造成认知分裂）。
 */
export interface PasteConfig {
  /** 行数阈值。M1 结构性不生效（readline 行缓冲装不下 \n，含换行必折叠），为 M2+ 预留。 */
  foldLines: number;
  /** 单行字符数阈值：≥ 此值折叠为 chip。 */
  foldChars: number;
  /** 图片大小上限（字节），超限拒绝（PRD C6）。默认 8MB。 */
  imageMaxBytes: number;
}
