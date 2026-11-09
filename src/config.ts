/**
 * 配置加载。
 *
 * 结构（settings.json）：
 *   default_provider     使用哪个 provider（对应 providers[].provider_name）
 *   default_model_tier   使用哪个模型档位
 *   providers[]          每个 provider 一段独立配置
 *   其余全局字段         与 provider 无关的运行时参数
 *
 * 优先级（从低到高）：settings.example.json → ./settings.json → 环境变量 → CLI 覆盖。
 * 环境变量：NEO_PROVIDER / NEO_TIER / NEO_API_KEY / NEO_BASE_URL / NEO_MODEL。
 *
 * 兼容性：仍能读旧版扁平格式（api-key / OpenAI / model_name 位于顶层），
 * 自动折算成一个名为 legacy 的 provider 并给出警告。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type { EnvConfig } from "./env/types.ts";
import type { ShellConfig } from "./shell.ts";
import { parseHooksConfig, type HooksConfig } from "./hooks/types.ts";
import { DEFAULT_SELECTION_CONFIG, TIER_ORDER, type PromptSelectionConfig } from "./prompt/select.ts";

import {
  DEFAULT_MAILBOX_CONFIG,
  resolveMailboxConfig,
  type InboundPolicy,
  type MailboxConfig,
} from "./mailbox/types.ts";

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

const TIER_FIELD: Record<ModelTier, string> = {
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
   * 运行时会话的记忆作用域（不落配置文件）。
   * -p 单次模式由组合根置为 "project"：只读写项目级记忆，
   * 避免服务器脚本场景混入操作员个人记忆。
   */
  scopeMode?: "both" | "project";
}

type Raw = Record<string, unknown>;

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

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

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

/** paste.* 解析：settings.json > 内置默认（3 行 / 300 字符 / 8MB）。 */
/**
 * 解析 settings.shell（v0.4.0 平台适配层）。
 *
 * 只做形状校验：路径是否可执行由 shell.ts 在运行时探测（配置写错不崩，
 * 回退到自动探测并给出 warnings）。全缺省 = undefined（纯自动探测）。
 */
function resolveShellConfig(raw: unknown): ShellConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Raw;
  const out: ShellConfig = {};
  const path = r["path"];
  if (typeof path === "string" && path.trim() !== "") out.path = path.trim();
  if (typeof r["login"] === "boolean") out.login = r["login"];
  const args = r["args"];
  if (Array.isArray(args)) {
    const clean = args.filter((a): a is string => typeof a === "string");
    if (clean.length > 0) out.args = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 解析 settings.system_prompt（issue #20）。非法值一律回落默认，不报错：
 * 这是优化项，配置写错不能拖垮启动。比例夹在 0.05–0.3，避免 0 或 1 让预算失去意义。
 */
function resolveSystemPromptConfig(raw: unknown): PromptSelectionConfig {
  const out: PromptSelectionConfig = { ...DEFAULT_SELECTION_CONFIG };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Raw;
  const mode = r["selection_mode"];
  if (mode === "budget-first" || mode === "context-gated") out.selectionMode = mode;
  const ratio = r["system_budget_ratio"];
  if (typeof ratio === "number" && Number.isFinite(ratio)) {
    out.systemBudgetRatio = Math.min(0.3, Math.max(0.05, ratio));
  }
  const maxTier = r["max_tier"];
  if (typeof maxTier === "string" && (TIER_ORDER as readonly string[]).includes(maxTier)) {
    out.maxTier = maxTier as PromptSelectionConfig["maxTier"];
  }
  const unknown = r["unknown_window_budget"];
  if (typeof unknown === "number" && Number.isFinite(unknown) && unknown > 0) {
    out.unknownWindowBudget = Math.floor(unknown);
  }
  if (typeof r["trust_known_window"] === "boolean") out.trustKnownWindow = r["trust_known_window"];
  return out;
}

/**
 * 解析 settings.env（v0.4.0 平台适配层）。
 *
 * 默认全开：enabled=true、TTL 12h、注入提示词、写用户级 wiki 页。
 * -p/非交互模式是否落盘由组合根决定，不在此处。
 */
function resolveEnvConfig(raw: unknown): EnvConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Raw;
  const out: EnvConfig = {};
  if (typeof r["enabled"] === "boolean") out.enabled = r["enabled"];
  if (typeof r["probe_ttl_hours"] === "number" && Number.isFinite(r["probe_ttl_hours"])) {
    out.probeTtlHours = Math.max(0, r["probe_ttl_hours"]);
  }
  if (typeof r["prompt"] === "boolean") out.prompt = r["prompt"];
  if (typeof r["wiki_page"] === "boolean") out.wikiPage = r["wiki_page"];
  const dir = r["dir"];
  if (typeof dir === "string" && dir.trim() !== "") out.dir = dir.trim();
  if (typeof r["models_probe_timeout_ms"] === "number" && Number.isFinite(r["models_probe_timeout_ms"])) {
    // 与 modelWindows.modelsProbeTimeoutMs 同一夹取范围：过小会假阴性，过大拖住后台探测。
    out.modelsProbeTimeoutMs = Math.min(60_000, Math.max(250, Math.floor(r["models_probe_timeout_ms"])));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 解析 settings.mcpServers（issue #2）。
 *
 * 两种写法都接受，因为用户手上多半已经有一份 Claude Desktop / Cursor 的配置：
 *  1. 对象：{ "fs": { "command": "npx", "args": [...] } } —— 键即 server 名；
 *  2. 数组：[{ "name": "fs", "command": "npx", ... }] —— 与 providers 一致的风格。
 *
 * 容错原则：**单个 server 写错只丢这一个，不让整个 CLI 起不来**。
 * 缺 command / 名字非法 / 名字重复 → 跳过该条并记一条 warning（由调用方打印）。
 * 这不是「静默忽略」：warnings 会经 /mcp 与启动提示暴露出来。
 */
export function parseMcpServers(raw: unknown): { servers: McpServerConfig[]; warnings: string[] } {
  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const entries: Array<[string | null, unknown]> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) entries.push([null, item]);
  } else if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw as Raw)) entries.push([k, v]);
  } else if (raw !== undefined && raw !== null) {
    warnings.push("mcpServers 必须是对象或数组，已忽略该段。");
    return { servers, warnings };
  }

  for (const [keyName, item] of entries) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      warnings.push(`mcpServers${keyName ? `.${keyName}` : ""} 不是对象，已跳过。`);
      continue;
    }
    const r = item as Raw;
    const name = str(r["name"], keyName ?? "").trim();
    if (!name) {
      warnings.push("mcpServers 有一条缺少 name，已跳过。");
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      // 名字会进工具名（mcp__<server>__<tool>），带点/斜杠会让模型与日志都难认。
      warnings.push(`mcpServers.${name} 名字非法（只允许字母/数字/_/-），已跳过。`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`mcpServers.${name} 重名，已跳过后面那条。`);
      continue;
    }
    // issue #29：传输层先看 `transport`，兼容 `type` 别名（Claude Code 的写法）。
    // issue #29：先判传输再看 command —— http 条目没有 command，顺序反了会误报「缺少 command」。
    const transport = str(r["transport"], str(r["type"], "stdio")).trim().toLowerCase();
    if (transport === "http") {
      const url = str(r["url"], "").trim();
      if (!url) {
        warnings.push(`mcpServers.${name} 的 transport="http" 缺少 url，已跳过。`);
        continue;
      }
      if (!/^https?:\/\//i.test(url)) {
        warnings.push(`mcpServers.${name} 的 url 必须是 http(s) 绝对地址（得到 "${url}"），已跳过。`);
        continue;
      }
      const headersRaw = r["headers"];
      const headers: Record<string, string> = {};
      if (typeof headersRaw === "object" && headersRaw !== null && !Array.isArray(headersRaw)) {
        for (const [k, v] of Object.entries(headersRaw as Raw)) {
          if (v === null || v === undefined) continue;
          headers[k] = String(v);
        }
      }
      seen.add(name);
      servers.push({ name, transport: "http", url, headers, enabled: bool(r["enabled"], true) });
      continue;
    }
    if (transport !== "stdio") {
      // sse 尚未支持：给一句明确的话，而不是「连不上」。
      warnings.push(
        `mcpServers.${name} 的 transport="${transport}" 暂不支持（支持 stdio / http；SSE 见 docs/mcp-http-prd.md 非目标），已跳过。`,
      );
      continue;
    }
    const command = str(r["command"], "").trim();
    if (!command) {
      warnings.push(`mcpServers.${name} 缺少 command，已跳过。`);
      continue;
    }
    const argsRaw = r["args"];
    const args = Array.isArray(argsRaw) ? argsRaw.map((a) => String(a)) : [];
    const envRaw = r["env"];
    const env: Record<string, string> = {};
    if (typeof envRaw === "object" && envRaw !== null && !Array.isArray(envRaw)) {
      for (const [k, v] of Object.entries(envRaw as Raw)) {
        if (v === null || v === undefined) continue;
        env[k] = String(v);
      }
    }
    const cwdRaw = str(r["cwd"], "").trim();
    seen.add(name);
    servers.push({
      name,
      transport: "stdio",
      command,
      args,
      env,
      cwd: cwdRaw === "" ? undefined : cwdRaw,
      enabled: bool(r["enabled"], true),
    });
  }
  return { servers, warnings };
}

function resolvePasteConfig(raw: Raw | undefined): PasteConfig {
  const r = raw ?? {};
  return {
    foldLines: num(r["fold_lines"], 3),
    foldChars: num(r["fold_chars"], 300),
    imageMaxBytes: num(r["image_max_bytes"], 8_388_608),
  };
}

/**
 * 跨会话消息配置（PRD v1.2 §4.6）。settings.json 顶层 snake_case 键；
 * 未配置项取 PRD 裁决默认值（watchdog 120s / 心跳 120s 判死 / 自动 turn 20）。
 */
function resolveMailboxSettings(raw: Raw): MailboxConfig {
  return resolveMailboxConfig({
    autoTurnLimit: num(raw["cross_session_auto_turn_limit"], DEFAULT_MAILBOX_CONFIG.autoTurnLimit),
    heartbeatMs: num(raw["cross_session_heartbeat_ms"], DEFAULT_MAILBOX_CONFIG.heartbeatMs),
    deadAfterMs: num(raw["cross_session_dead_after_ms"], DEFAULT_MAILBOX_CONFIG.deadAfterMs),
    progressTimeoutMs: num(raw["cross_session_progress_timeout_ms"], DEFAULT_MAILBOX_CONFIG.progressTimeoutMs),
    watchdogIntervalS: num(raw["cross_session_watchdog_interval_s"], DEFAULT_MAILBOX_CONFIG.watchdogIntervalS),
  });
}

function resolveInboundPolicy(raw: unknown): InboundPolicy | "auto" {
  return raw === "accept" || raw === "hold" || raw === "refuse" ? raw : "auto";
}

/**
 * 额外技能目录（v0.4.1 B3）：settings.skills_extra_paths + NEO_SKILLS_PATHS。
 * 只做去空白/去重；路径展开由 skills.ts 负责（需要 cfg.cwd 解析相对路径）。
 */
export function parseSkillsExtraPaths(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
    }
  }
  const envRaw = env["NEO_SKILLS_PATHS"];
  if (envRaw) {
    const sep = process.platform === "win32" ? ";" : ":";
    for (const p of envRaw.split(sep)) {
      if (p.trim() !== "") out.push(p.trim());
    }
  }
  return [...new Set(out)];
}

/**
 * LLM 重试/超时配置（P0-1）。settings.json `retry` 段，snake_case 键。
 *
 * 下限保护：max_attempts ≥1，超时 ≥1000ms —— 配成 0 会让所有请求立刻失败，
 * 这不是一个可以用配置表达的意图，直接兜底到合理值。
 */
export function resolveRetryConfig(raw: unknown): RetryConfig {
  const r = (raw ?? {}) as Raw;
  const d = DEFAULT_RETRY_CONFIG;
  return {
    maxAttempts: Math.max(1, Math.floor(num(r["max_attempts"], d.maxAttempts))),
    baseDelayMs: Math.max(0, Math.floor(num(r["base_delay_ms"], d.baseDelayMs))),
    connectTimeoutMs: Math.max(1000, Math.floor(num(r["connect_timeout_ms"], d.connectTimeoutMs))),
    streamIdleTimeoutMs: Math.max(1000, Math.floor(num(r["stream_idle_timeout_ms"], d.streamIdleTimeoutMs))),
  };
}


class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export { ConfigError };

function readJson(path: string): Raw | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Raw;
  } catch (e) {
    throw new ConfigError(`配置文件解析失败 ${path}: ${(e as Error).message}`);
  }
}

/** provider 显式写了窗口 = config；回落到全局默认时只有顶层显式配置才算 config，否则是兜底 default。 */
function windowSourceFor(cfg: Config, providerWindow: number | null | undefined): "config" | "default" {
  if (providerWindow != null) return "config";
  return cfg.globalWindowExplicit ? "config" : "default";
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
/** 三态布尔：只认 true/false，其余（含缺失、"true" 字符串）一律 undefined = 未填。 */
function boolOrUndef(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function str(v: unknown, d: string): string {
  return typeof v === "string" && v.length > 0 ? v : d;
}

export function normalizeBaseUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* provider 解析                                                       */
/* ------------------------------------------------------------------ */

/**
 * 解析 provider 声明的协议：`api_type`（字符串或数组）优先，缺省回落旧字段 `provider_type`。
 * 结果去重并按 API_TYPE_PREFERENCE 排序 —— 声明了两种就是「两种都可用，优先 anthropic」，
 * 与数组里写的先后无关。
 */
function parseApiTypes(apiType: unknown, providerType: unknown, where: string): ProviderType[] {
  const rawList: unknown[] =
    apiType === undefined || apiType === null ? [] : Array.isArray(apiType) ? apiType : [apiType];
  if (rawList.length === 0) {
    const legacy = str(providerType, "");
    if (!legacy) throw new ConfigError(`${where} 缺少 api_type（可填 "anthropic"、"openai" 或两者的数组）。`);
    rawList.push(legacy);
  }
  const seen = new Set<ProviderType>();
  for (const v of rawList) {
    if (v !== "openai" && v !== "anthropic") {
      throw new ConfigError(
        `${where} 的 api_type 含 ${JSON.stringify(v)}，不是已知协议。可用：openai、anthropic。`,
      );
    }
    seen.add(v);
  }
  return API_TYPE_PREFERENCE.filter((t) => seen.has(t));
}

/** 某 provider 在指定协议下的 base_url。 */
export function providerBaseUrl(p: ProviderConfig, type: ProviderType): string {
  return p.baseUrls?.[type] ?? p.baseUrl;
}

/** 解析 providers 数组。字段缺失时抛出可定位的错误，而不是静默用空值。 */
function parseProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError("settings.json 缺少 providers 数组，或它不是数组。");
  }
  if (raw.length === 0) {
    throw new ConfigError("providers 数组为空，至少需要一个 provider。");
  }

  return raw.map((entry, i): ProviderConfig => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`providers[${i}] 不是对象。`);
    }
    const p = entry as Raw;
    const where = `providers[${i}]`;

    const name = str(p["provider_name"], "");
    if (!name) throw new ConfigError(`${where} 缺少 provider_name。`);

    const apiTypes = parseApiTypes(p["api_type"], p["provider_type"], `${where}（${name}）`);
    const type = apiTypes[0]!;

    const sharedUrl = normalizeBaseUrl(str(p["base_url"], str(p["OpenAI"], "")));
    const baseUrls: Partial<Record<ProviderType, string>> = {};
    for (const t of apiTypes) {
      const own = normalizeBaseUrl(str(p[`${t}_base_url`], ""));
      const url = own || sharedUrl;
      if (!url) {
        throw new ConfigError(
          `${where}（${name}）缺少 base_url（或 ${t}_base_url）：api_type 含 ${t}，需要它的端点地址。`,
        );
      }
      baseUrls[t] = url;
    }
    const baseUrl = baseUrls[type]!;

    const apiKey = str(p["api_key"], str(p["api-key"], ""));

    // 四个档位：缺失的档位回落到 default_model_name，再回落到任意已填档位
    const fallbackModel =
      str(p["default_model_name"], "") ||
      str(p["deep_reasoning_model_name"], "") ||
      str(p["balanced_model_name"], "") ||
      str(p["fast_model_name"], "");
    const models = {} as Record<ModelTier, string>;
    for (const tier of MODEL_TIERS) {
      models[tier] = str(p[TIER_FIELD[tier]], fallbackModel);
    }
    if (!fallbackModel) {
      throw new ConfigError(`${where}（${name}）的四个模型档位全部为空，至少要填 default_model_name。`);
    }

    return {
      name,
      type,
      apiTypes,
      baseUrl,
      baseUrls,
      apiKey,
      models,
      maxTokens: numOrNull(p["max_tokens"]),
      temperature: numOrNull(p["temperature"]),
      contextWindow: numOrNull(p["context_window"]),
      vision: boolOrUndef(p["vision"]),
      tools: boolOrUndef(p["tools"]),
      reasoning: boolOrUndef(p["reasoning"]),
      maxOutputTokens: numOrNull(p["max_output_tokens"]),
      outputProbe: resolveOutputProbe(p["probe_max_output_tokens"]),
    };
  });
}

/**
 * 旧版扁平格式 → ProviderConfig。
 * 旧字段：api-key / OpenAI / model_name。折算后四个档位共用同一模型。
 */
function providerFromLegacy(raw: Raw): ProviderConfig | null {
  const baseUrl = normalizeBaseUrl(str(raw["OpenAI"], ""));
  const model = str(raw["model_name"], "");
  if (!baseUrl && !model) return null;

  return {
    name: "legacy",
    type: "openai",
    baseUrl: baseUrl || "https://api.openai.com/v1",
    apiKey: str(raw["api-key"], ""),
    models: {
      default: model,
      deep_reasoning: model,
      balanced: model,
      fast: model,
    },
    maxTokens: numOrNull(raw["max_tokens"]),
    temperature: numOrNull(raw["temperature"]),
    contextWindow: numOrNull(raw["context_window"]),
    vision: boolOrUndef(raw["vision"]),
    tools: boolOrUndef(raw["tools"]),
    reasoning: boolOrUndef(raw["reasoning"]),
    maxOutputTokens: numOrNull(raw["max_output_tokens"]),
    outputProbe: resolveOutputProbe(raw["probe_max_output_tokens"]),
  };
}

/* ------------------------------------------------------------------ */
/* 载入                                                                */
/* ------------------------------------------------------------------ */

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const here = process.cwd();
  // v0.4.0：Windows 上 URL.pathname 是 /C:/... 形态，必须用 fileURLToPath 还原盘符路径。
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  const candidates = [
    join(here, "settings.json"),
    join(pkgRoot, "settings.json"),
    join(homedir(), ".neo", "settings.json"),
  ];
  const found = candidates.find((p) => existsSync(p)) ?? null;
  const raw = found ? (readJson(found) ?? {}) : {};
  const dflt = readJson(join(pkgRoot, "settings.example.json")) ?? {};

  // providers 是数组，无法用 {...a, ...b} 浅合并，必须按「本地优先」逐级判定。
  // 关键顺序：本地 settings.json 的旧版字段必须优先于模板的 providers。
  // 否则用户拿着旧配置会静默套用 settings.example.json 的示例密钥与地址 ——
  // 不报错，但请求全打到别人的网关上，这种失败极难排查。
  let providers: ProviderConfig[];
  let legacyFormat = false;
  const localList = raw["providers"];
  const localLegacy = providerFromLegacy(raw);
  const tplList = dflt["providers"];
  const tplLegacy = providerFromLegacy(dflt);

  if (localList !== undefined) {
    providers = parseProviders(localList);
  } else if (localLegacy) {
    providers = [localLegacy];
    legacyFormat = true;
  } else if (tplList !== undefined) {
    providers = parseProviders(tplList);
  } else if (tplLegacy) {
    providers = [tplLegacy];
    legacyFormat = true;
  } else {
    throw new ConfigError(
      `未在 ${found ?? "任何搜索路径"} 找到可用的 provider 配置。` +
        `请参考 settings.example.json 写一份 settings.json。`,
    );
  }

  // 默认 provider：环境变量 > settings.json > 列表第一项。
  // 不从模板回落 —— 模板的 "example" 是示例名，本地 providers 里通常没有这个名字，
  // 回落它会让 picked 静默退化成列表第一项，掩盖配置错误。
  const defProviderName = str(
    process.env["NEO_PROVIDER"],
    str(raw["default_provider"], providers[0]?.name ?? ""),
  );
  const picked =
    providers.find((p) => p.name === defProviderName) ?? providers[0];
  if (!picked) throw new ConfigError("没有可用的 provider。");

  // 默认档位
  const tierRaw = str(
    process.env["NEO_TIER"],
    str(raw["default_model_tier"], str(dflt["default_model_tier"], "default")),
  );
  const tier: ModelTier = isModelTier(tierRaw) ? tierRaw : "default";

  // 全局默认（provider 未覆盖时使用）
  const gMax = num(raw["max_tokens"], num(dflt["max_tokens"], 8192));
  const gTemp = num(raw["temperature"], num(dflt["temperature"], 0.6));
  const gCtx = num(raw["context_window"], num(dflt["context_window"], 200_000));
  // 窗口值是否由用户显式写过：provider 级或 settings 顶层。都没写时 gCtx 来自模板/内置 200,000，
  // 只是兜底，不是事实——选系统提示词档位时不能当成已证实窗口（issue #20）。
  const ctxExplicit = picked.contextWindow != null || typeof raw["context_window"] === "number";

  // ---- 档位路由 ----
  // 未显式配置时，每个档位都指向当前 provider 的对应模型（即旧的单provider 行为）。
  // 同样不从模板回落 model_routes：模板里的 provider 名（"example"）与本地无关，
  // 混进来会凭空造出一条指向不存在 provider 的路由，或直接抛错。
  const rawRoutes = raw["model_routes"] as Raw | undefined;
  const routes = {} as Record<ModelTier, RouteConfig>;
  for (const t of MODEL_TIERS) {
    const entry = rawRoutes?.[t];
    if (entry !== undefined && typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const r = entry as Raw;
      const rProvider = str(r["provider"], "");
      if (!rProvider) {
        throw new ConfigError(`model_routes.${t} 缺少 provider 字段。`);
      }
      if (!providers.some((p) => p.name === rProvider)) {
        throw new ConfigError(
          `model_routes.${t}.provider = "${rProvider}" 不在 providers 列表中。` +
            `已配置：${providers.map((p) => p.name).join(", ")}`,
        );
      }
      routes[t] = {
        provider: rProvider,
        model: str(r["model"], ""),
        fallbackAllowed: bool(r["fallback_allowed"], true),
      };
    } else if (entry !== undefined && typeof entry === "string") {
      // 简写形式："fast": "ipsa" 等价于 {provider:"ipsa", model:null}
      const name = entry as string;
      if (!providers.some((p) => p.name === name)) {
        throw new ConfigError(`model_routes.${t} = "${name}" 不在 providers 列表中。`);
      }
      routes[t] = { provider: name, model: null, fallbackAllowed: true };
    } else {
      routes[t] = { provider: picked.name, model: null, fallbackAllowed: true };
    }
  }

  // 分类器固定绑在外部指定的 provider 上 —— 不能让它用自己的分类结果选自己
  //
  // 注意：classifier_provider 是「身份」字段，不能从模板回落。
  // 模板里写的是示例值 "example"，本地配置若没写这一项就回落模板，
  // 会得到一个不在本地 providers 列表里的名字，直接把启动卡死。
  // 这与 providers 的处理是同一个道理：身份字段只认本地，模板只提供可调参数。
  const classifierProvider = str(
    process.env["NEO_CLASSIFIER_PROVIDER"],
    str(raw["classifier_provider"], str(raw["default_provider"], picked.name)),
  );
  const clsProv = providers.find((p) => p.name === classifierProvider);
  if (!clsProv) {
    throw new ConfigError(
      `classifier_provider = "${classifierProvider}" 不在 providers 列表中。` +
        `已配置：${providers.map((p) => p.name).join(", ")}`,
    );
  }
  // 同理，模型名也不从模板取 —— 模板值是 "your-fast-model-id" 这种占位符，
  // 落到真实请求里就是一次必然失败的调用。缺省用该 provider 的 fast 模型。
  const classifierModel = str(
    process.env["NEO_CLASSIFIER_MODEL"],
    str(raw["classifier_model_name"], clsProv.models["fast"]),
  );

  const cfg: Config = {
    providerName: picked.name,
    providerType: picked.type,
    // 环境变量优先级最高
    apiKey: str(process.env["NEO_API_KEY"], picked.apiKey),
    baseUrl: normalizeBaseUrl(str(process.env["NEO_BASE_URL"], picked.baseUrl)),
    modelTier: tier,
    model: str(process.env["NEO_MODEL"], routeModel(routes[tier], providers, tier)),
    providers,
    routes,
    classifierModel,
    classifierProvider,
    legacyFormat,
    /** max_tokens 配置体检结果（issue #21 A）；启动块逐条 ui.warn，空数组 = 无告警。 */
    maxTokensWarnings: auditMaxTokens(providers),

    maxTokens: picked.maxTokens ?? gMax,
    temperature: picked.temperature ?? gTemp,
    contextWindow: picked.contextWindow ?? gCtx,
    configuredContextWindow: picked.contextWindow ?? gCtx,
    contextWindowSource: ctxExplicit ? "config" : "default",
    configuredContextWindowExplicit: ctxExplicit,
    globalWindowExplicit: typeof raw["context_window"] === "number",
    globalDefaults: { maxTokens: gMax, temperature: gTemp, contextWindow: gCtx },
    compactThreshold: num(raw["compact_threshold"], num(dflt["compact_threshold"], 0.75)),
    maxToolIterations: num(raw["max_tool_iterations"], num(dflt["max_tool_iterations"], 80)),
    toolOutputLimit: num(raw["tool_output_limit"], num(dflt["tool_output_limit"], 30_000)),
    retry: resolveRetryConfig(raw["retry"]),
    parallelToolCalls: resolveParallelToolCalls(raw["parallel_tool_calls"]),
    theme: str(raw["theme"], str(dflt["theme"], "matrix")),
    showReasoning: bool(raw["show_reasoning"], bool(dflt["show_reasoning"], true)),
    // 兼容用户手写的连字符键名；项目惯例仍是 snake_case。
    toolcallInfoDetails: bool(
      raw["toolcall_info_details"],
      bool(raw["toolcall-info-details"], false),
    ),
    cwd: here,
    settingsPath: found,
    skillsStore: str(raw["skills_store"], join(homedir(), ".neo", "skills")),
    skillsExtraPaths: parseSkillsExtraPaths(raw["skills_extra_paths"]),
    memory: resolveMemoryConfig(raw["memory"] as Raw | undefined),
    shell: resolveShellConfig(raw["shell"]),
    // MCP 只认本地 settings.json：模板里的示例 server 不该在用户机器上被启动。
    mcpServers: parseMcpServers(raw["mcpServers"]).servers,
    // hooks 同理只认本地：模板里的示例 hook 不该在用户机器上被执行。
    hooks: parseHooksConfig(raw["hooks"]),
    env: resolveEnvConfig(raw["env"]),
    systemPrompt: resolveSystemPromptConfig(raw["system_prompt"]),
    paste: resolvePasteConfig(raw["paste"] as Raw | undefined),
    mailbox: resolveMailboxSettings(raw),
    crossSessionInbound: resolveInboundPolicy(raw["cross_session_inbound"]),
    ...overrides,
  };

  if (overrides.cwd && !isAbsolute(overrides.cwd)) cfg.cwd = resolve(here, overrides.cwd);
  return cfg;
}

/**
 * 解析 settings.memory.* 段（v0.2 记忆激活；规格 §7.9）。
 *
 * 优先级：环境变量 > settings.json > 内置默认。
 *  - NEO_MEMORY_DISABLE=1 → enabled=false
 *  - NEO_MEMORY_DIR=<路径> → userLevelDir（旧目录，仅供 /memory migrate 与 profile 兼容读取）
 *  - NEO_USER_WIKI_DIR=<路径> → userWikiDir
 *  - NEO_MEMORY_JOURNAL_DIR=<路径> → journalDir
 *
 * v0.1.12 清理：旧字段解析全部移除；settings.json 里的未知 memory 键静默忽略。
 */
function resolveMemoryConfig(raw: Raw | undefined): MemoryConfig {
  const r = raw ?? {};
  const envDisable = process.env["NEO_MEMORY_DISABLE"] === "1";
  const envDir = process.env["NEO_MEMORY_DIR"];
  const envUserWiki = process.env["NEO_USER_WIKI_DIR"];
  const envJournal = process.env["NEO_MEMORY_JOURNAL_DIR"];

  // 旧用户级目录：只用于 /memory migrate 与旧 profile.md 兼容读取
  const userLevelDirRaw = envDir ?? str(r["user_level_dir"], join(homedir(), ".neo", "memorys"));
  const userLevelDir = isAbsolute(userLevelDirRaw) ? userLevelDirRaw : resolve(userLevelDirRaw);

  const userWikiRaw = envUserWiki ?? str(r["user_wiki_dir"], join(homedir(), ".neo", "wiki"));
  const userWikiDir = isAbsolute(userWikiRaw) ? userWikiRaw : resolve(userWikiRaw);
  const memJournalRaw = envJournal ?? str(r["journal_dir"], join(homedir(), ".neo", "memory", "journal"));
  const journalDir = isAbsolute(memJournalRaw) ? memJournalRaw : resolve(memJournalRaw);

  const recallRaw = (r["auto_recall"] ?? {}) as Raw;
  const autoRecall = {
    enabled: bool(recallRaw["enabled"], true),
    maxTokens: num(recallRaw["max_tokens"], 900),
    projectPages: num(recallRaw["project_pages"], 2),
    userPages: num(recallRaw["user_pages"], 1),
  };

  const captureRaw = (r["auto_capture"] ?? {}) as Raw;
  const modeRaw = str(captureRaw["mode"], "boundary");
  const mode: "off" | "boundary" | "every_turn" =
    modeRaw === "off" || modeRaw === "every_turn" ? modeRaw : "boundary";
  const autoCapture = {
    enabled: bool(captureRaw["enabled"], true),
    mode,
    modelTier: str(captureRaw["model_tier"], "fast"),
    maxOpsPerTurn: num(captureRaw["max_ops_per_turn"], 2),
    maxPagesPerSession: num(captureRaw["max_pages_per_session"], 8),
    minConfidence: num(captureRaw["min_confidence"], 0.65),
    minInferredConfidence: num(captureRaw["min_inferred_confidence"], 0.75),
    journalRetentionDays: num(captureRaw["journal_retention_days"], 7),
    flushTimeoutMs: num(captureRaw["flush_timeout_ms"], 3000),
  };

  return {
    enabled: !envDisable && bool(r["enabled"], true),
    userLevelDir,
    userWikiDir,
    journalDir,
    autoRecall,
    autoCapture,
    quiet: bool(r["quiet"], false),
  };
}

/* ------------------------------------------------------------------ */
/* max_tokens 配置体检（issue #21 A）                                    */
/* ------------------------------------------------------------------ */

/**
 * 逐 provider 体检 max_tokens 是否明显不合理，返回人类可读的告警文案。
 *
 * 两条判据（都要求比较双方非 null —— 瘦网关没声明就不猜）：
 *  1. max_tokens ≥ context_window：输出预算 ≥ 上下文窗口，网关/模型几乎必然拒绝
 *     （issue #21 的原始事故：512000/512000）；
 *  2. max_tokens > max_output_tokens：超过已声明的模型单次输出上限。
 *
 * 只告警不改配置：用户配的是意图，neo 不替用户改文件；网关的真实上限是运行时事实，
 * 由 llm.ts 的上限学习（v0.4.75）与不透明 400 降级（本版 B）兜底。
 * 正常配置不误报：模板默认 8192 / 200000 两条都不命中。
 */
export function auditMaxTokens(providers: ProviderConfig[]): string[] {
  const out: string[] = [];
  for (const p of providers) {
    if (p.maxTokens == null) continue;
    if (p.contextWindow != null && p.maxTokens >= p.contextWindow) {
      out.push(
        `max_tokens 配置告警：provider "${p.name}" 的 max_tokens=${p.maxTokens.toLocaleString()} ≥ context_window=${p.contextWindow.toLocaleString()}。` +
          `max_tokens 是本次请求的输出预算，不是上下文窗口；这个值几乎必然被网关/模型拒绝，建议改小（如 8192）。`,
      );
      continue; // 同一 provider 只报最直接的一条，第二条是重复信号
    }
    if (p.maxOutputTokens != null && p.maxTokens > p.maxOutputTokens) {
      out.push(
        `max_tokens 配置告警：provider "${p.name}" 的 max_tokens=${p.maxTokens.toLocaleString()} > max_output_tokens=${p.maxOutputTokens.toLocaleString()}（已声明的模型单次输出上限）。` +
          `这个值会被网关/模型拒绝，建议改到上限以内。`,
      );
    }
  }
  return out;
}

/** 解析某档位在路由表下的实际模型名。route.model 为空则取该 provider 的同名档位。 */
function routeModel(
  route: RouteConfig,
  providers: ProviderConfig[],
  tier: ModelTier,
): string {
  if (route.model) return route.model;
  const p = providers.find((x) => x.name === route.provider);
  return p?.models[tier] ?? "unknown";
}

/**
 * 把当前配置切到指定档位对应的目标 {provider, model}。
 *
 * 这是跨供应商调度的关键：档位不是「当前 provider 下的模型名」，
 * 而是「provider + model」的绑定。切档可能连带换供应商。
 *
 * 降级策略：目标 provider 的协议若未接入，按 fallbackAllowed 决定
 * 是静默回落 default 档还是报错。默认允许回落 —— 整个设计的地基是
 * 「default 永远能调通」，所以它必须承担兜底职责。
 */
export function applyTier(
  cfg: Config,
  tier: ModelTier,
): { ok: true; degraded: boolean; note?: string } | { ok: false; error: string } {
  const route = cfg.routes[tier];
  if (!route) return { ok: false, error: `未知档位 ${tier}` };

  const target = cfg.providers.find((p) => p.name === route.provider);
  if (!target) return { ok: false, error: `档位 ${tier} 指向不存在的 provider "${route.provider}"` };

  if (!isImplemented(target.type)) {
    if (!route.fallbackAllowed) {
      return {
        ok: false,
        error:
          `档位 ${tier} → ${target.name}（${target.type} 协议未接入），` +
          `且该路由设置了 fallback_allowed: false。`,
      };
    }
    if (tier === "default") {
      return {
        ok: false,
        error: `default 档位指向未接入的 ${target.name}，无更低档可降。`,
      };
    }
    // 降级到 default
    const defRoute = cfg.routes["default"];
    const defProv = cfg.providers.find((p) => p.name === defRoute.provider);
    if (!defProv || !isImplemented(defProv.type)) {
      return {
        ok: false,
        error: `档位 ${tier} 不可用，且 default 档位也不可用，无法降级。`,
      };
    }
    cfg.modelTier = "default";
    cfg.providerName = defProv.name;
    cfg.providerType = defProv.type;
    cfg.apiKey = defProv.apiKey;
    cfg.baseUrl = defProv.baseUrl;
    cfg.model = routeModel(defRoute, cfg.providers, "default");
    cfg.maxTokens = defProv.maxTokens ?? cfg.globalDefaults.maxTokens;
    cfg.temperature = defProv.temperature ?? cfg.globalDefaults.temperature;
    cfg.contextWindow = defProv.contextWindow ?? cfg.globalDefaults.contextWindow;
    cfg.configuredContextWindow = cfg.contextWindow;
    cfg.contextWindowSource = windowSourceFor(cfg, defProv.contextWindow);
    cfg.configuredContextWindowExplicit = cfg.contextWindowSource === "config";
    return {
      ok: true,
      degraded: true,
      note: `档位 ${tier} 指向 ${target.name}（${target.type} 未接入），已降级到 default / ${defProv.name}`,
    };
  }

  cfg.modelTier = tier;
  cfg.providerName = target.name;
  cfg.providerType = target.type;
  cfg.apiKey = target.apiKey;
  cfg.baseUrl = target.baseUrl;
  cfg.model = routeModel(route, cfg.providers, tier);
  cfg.maxTokens = target.maxTokens ?? cfg.globalDefaults.maxTokens;
  cfg.temperature = target.temperature ?? cfg.globalDefaults.temperature;
  cfg.contextWindow = target.contextWindow ?? cfg.globalDefaults.contextWindow;
  cfg.configuredContextWindow = cfg.contextWindow;
  cfg.contextWindowSource = windowSourceFor(cfg, target.contextWindow);
  cfg.configuredContextWindowExplicit = cfg.contextWindowSource === "config";
  return { ok: true, degraded: false };
}

/** 某档位当前是否可用（目标 provider 已接入）。分类器据此避免推荐不可用的档。 */
export function tierAvailable(cfg: Config, tier: ModelTier): boolean {
  const route = cfg.routes[tier];
  if (!route) return false;
  const p = cfg.providers.find((x) => x.name === route.provider);
  return p !== undefined && isImplemented(p.type);
}

/** 某档位的路由描述，供 /tier 展示。 */
export function describeRoute(cfg: Config, tier: ModelTier): string {
  const route = cfg.routes[tier];
  if (!route) return "未配置";
  const p = cfg.providers.find((x) => x.name === route.provider);
  const model = routeModel(route, cfg.providers, tier);
  const okTag = p && isImplemented(p.type) ? "" : " (未接入)";
  return `${route.provider} / ${model}${okTag}`;
}

/**
 * 切换 provider。会重算 model / baseUrl / apiKey 及该 provider 覆盖的运行时参数。
 *
 * 档位保持不变，但 model 改为「该 provider 在当前档位下的模型」。
 * 注意这与 applyTier 不同：applyTier 是「档位决定 provider」，
 * 这里是「provider 决定模型」—— 手动指定供应商时应当听用户的，不走路由表。
 */
export function switchProvider(cfg: Config, name: string): { ok: true } | { ok: false; error: string } {
  const target = cfg.providers.find((p) => p.name === name);
  if (!target) {
    const names = cfg.providers.map((p) => p.name).join(", ");
    return { ok: false, error: `未找到 provider "${name}"。可用：${names || "（无）"}` };
  }

  // 先校验再赋值：未接入的协议必须原样留在当前 provider 上，不能先切过去再报错
  if (!isImplemented(target.type)) {
    return {
      ok: false,
      error:
        `provider "${target.name}" 声明为 ${target.type} 协议，但请求层尚未接入。` +
        `已实现的协议：${IMPLEMENTED_PROVIDER_TYPES.join(", ")}。` +
        `切换已取消，仍在使用 ${cfg.providerName}。`,
    };
  }

  const g = cfg.globalDefaults;
  cfg.providerName = target.name;
  cfg.providerType = target.type;
  cfg.apiKey = target.apiKey;
  cfg.baseUrl = target.baseUrl;
  cfg.model = target.models[cfg.modelTier];
  // provider 没覆盖的项回落到全局默认，而不是沿用上一个 provider 的值
  cfg.maxTokens = target.maxTokens ?? g.maxTokens;
  cfg.temperature = target.temperature ?? g.temperature;
  cfg.contextWindow = target.contextWindow ?? g.contextWindow;
  cfg.configuredContextWindow = cfg.contextWindow;
  cfg.contextWindowSource = windowSourceFor(cfg, target.contextWindow);
  cfg.configuredContextWindowExplicit = cfg.contextWindowSource === "config";

  return { ok: true };
}

/**
 * 切换模型档位。走路由表，可能连带换供应商。
 * 返回降级信息供调用方提示。
 */
export function switchTier(
  cfg: Config,
  tier: ModelTier,
): { ok: true; degraded: boolean; note?: string } | { ok: false; error: string } {
  return applyTier(cfg, tier);
}

/** 脱敏展示 key，只保留头尾。 */
export function maskKey(k: string): string {
  if (!k) return "<未设置>";
  if (k.length <= 12) return "*".repeat(k.length);
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
