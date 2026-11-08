/**
 * LLM 客户端：OpenAI 兼容 /chat/completions 与 Anthropic Messages /v1/messages 两种协议。
 * 内部消息模型保持 OpenAI 形态，Anthropic 的转换在 anthropicWire.ts。
 *
 * 以下三点是 OpenAI 路径针对本项目实测服务端特性做的适配：
 *
 *  1. 推理模型会额外返回 reasoning_content，与 content 分开流式下发；
 *     两者都要累积，但只有 content 进对话历史，reasoning 只做展示。
 *  2. tool_calls 以增量形式下发（delta.tool_calls 带 index），需按 index 拼接。
 *  3. SSE 以空行分隔事件，末条为 data: [DONE]。
 */
import {
  DEFAULT_PARALLEL_TOOL_CALLS,
  DEFAULT_RETRY_CONFIG,
  providerBaseUrl,
  type Config,
  type ProviderType,
  type RetryConfig,
} from "./config.ts";
import {
  AnthropicStreamAccumulator,
  buildAnthropicBody,
  isRetryableAnthropicError,
  parseAnthropicMessage,
} from "./anthropicWire.ts";

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * 多模态 content part（PRD docs/paste-enhancement-prd[done].md §5.5）。
 * OpenAI 兼容 /chat/completions 的 user 消息标准形态；仅 user 消息可能携带数组，
 * system/assistant/tool 恒为 string（结构性约束，发送层不做转换）。
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Anthropic 的思考块（含签名），原样保存以便下一轮回带。
 * 带工具调用的多轮对话里，服务端要求把完整的 assistant 内容（thinking / tool_use）原样回传，
 * 否则思维链不连续（MiniMax 文档第 4 点明确要求）；缺了签名的 thinking 块不能自己造。
 * 只在 Anthropic 协议路径下使用：OpenAI 路径、压缩、token 估算都忽略它。
 */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** assistant 专用：上一轮 Anthropic 响应里的思考块，回带时排在 text/tool_use 之前。 */
  thinking_blocks?: ThinkingBlock[];
}

/**
 * 取消息的纯文本视图（C8 适配收口）。
 * string 原样；数组拼 text parts（image part 不贡献文本）；null → null。
 * 所有「只关心文本」的消费点（compact/预览/子代理/分类器）一律走这里，
 * 不许各自 instanceof —— 收口一处，类型扩展时只改这里。
 */
export function contentText(content: Message["content"]): string | null {
  if (content === null) return null;
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage | null;
  raw: unknown;
  /** Anthropic 协议下的思考块（含签名）；agent 写进 assistant 消息以便回带。 */
  thinkingBlocks?: ThinkingBlock[];
}

export class LLMError extends Error {
  /** 是否值得重试。4xx（408/409/425/429 除外）与「已输出后的中断」置 false。 */
  retryable = true;
  /** 服务端 Retry-After 给出的等待时长（毫秒）。 */
  retryAfterMs?: number;
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/** 连接/首字节或流式空闲超时（P0-1）。 */
export class LLMTimeoutError extends LLMError {
  constructor(
    readonly kind: "connect" | "idle",
    timeoutMs: number,
  ) {
    super(kind === "connect" ? `连接/首字节超时（${timeoutMs}ms）` : `流式响应空闲超时（${timeoutMs}ms）`);
    this.name = "LLMTimeoutError";
  }
}

/* ------------------------------------------------------------------ */
/* 非流式                                                              */
/* ------------------------------------------------------------------ */

/** OpenAI 协议不认 thinking_blocks（Anthropic 专用的签名思考块），发出前剥掉，避免严格网关 400。 */
function stripThinkingBlocks(messages: Message[]): Message[] {
  if (!messages.some((m) => m.thinking_blocks !== undefined)) return messages;
  return messages.map((m) => {
    if (m.thinking_blocks === undefined) return m;
    const { thinking_blocks: _drop, ...rest } = m;
    return rest;
  });
}

function buildBody(cfg: Config, messages: Message[], tools: ToolSpec[], stream: boolean) {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: stripThinkingBlocks(messages),
    stream,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
    // issue #11：并行策略由配置决定，默认 "readonly"（只读工具可并行）。
    // 缺省（旧测试/旧调用方没填该字段）按 "readonly" 处理，与 loadConfig 的默认一致；
    // 显式 "off" 才下发 false —— 瘦网关不认这个字段时由 chatStream 的同轮降级兜底。
    body.parallel_tool_calls = (cfg.parallelToolCalls ?? DEFAULT_PARALLEL_TOOL_CALLS) !== "off";
  }
  if (cfg.thinking !== undefined) body.thinking = cfg.thinking;
  return body;
}

/**
 * 服务端是否在抱怨 parallel_tool_calls 这个字段（瘦网关常见：400 unknown field）。
 *
 * 只在 4xx 且错误文本里同时出现字段名与「不认识/不支持」语义时才认，
 * 避免把普通的参数错误误判成降级信号。
 */
export function isParallelToolCallsRejection(err: unknown): boolean {
  if (!(err instanceof LLMError)) return false;
  const status = err.status;
  if (status === undefined || status < 400 || status >= 500) return false;
  const text = `${err.message}\n${err.body ?? ""}`.toLowerCase();
  if (!text.includes("parallel_tool_calls")) return false;
  return /(unknown|unsupported|not supported|unrecognized|invalid|not allowed|unexpected|不支持|未知)/.test(text);
}

/* ------------------------------------------------------------------ */
/* 协议选择                                                            */
/* ------------------------------------------------------------------ */

export interface Endpoint {
  proto: ProviderType;
  baseUrl: string;
}

/**
 * 本次请求的协议候选（已按优先级排序，首项最先尝试）。
 *
 * provider 声明了多个协议（api_type: ["anthropic","openai"]）时，anthropic 在前；
 * 回退只发生在「该协议的端点不存在」（见 isEndpointAbsent），且结果会被记住。
 *
 * 只有 cfg.baseUrl 仍是 provider 的原始地址才展开多协议：NEO_BASE_URL 等覆盖把请求指向了
 * 别处，原 provider 的协议/地址清单就不再适用，此时只按 cfg.providerType 走单一协议。
 */
export function endpointPlan(cfg: Config): Endpoint[] {
  const single: Endpoint[] = [{ proto: cfg.providerType ?? "openai", baseUrl: cfg.baseUrl }];
  const p = cfg.providers?.find((x) => x.name === cfg.providerName);
  if (!p?.apiTypes || p.apiTypes.length === 0) return single;
  if (providerBaseUrl(p, p.type) !== cfg.baseUrl) return single;
  return p.apiTypes.map((proto) => ({ proto, baseUrl: providerBaseUrl(p, proto) }));
}

/* ------------------------------------------------------------------ */
/* 输出上限（max_tokens）学习                                           */
/* ------------------------------------------------------------------ */

/**
 * 服务端因 max_tokens 超过**该模型**的上限而拒绝时，从错误文案里取出上限。
 *
 * 为什么需要：上限因模型而异（MiniMax 实测：M3 系 524,288，M2.7 系 196,608），而 provider 级
 * 的 `max_tokens` 对四个档位共用 —— 配成 M3 能接受的值，切到 fast 档的 M2.7 就必然 400。
 * 不可能让用户逐模型手工调配置，所以按报错学习、夹紧、重发。
 *
 * 只在 400/422 且文案同时出现 max tokens 语义与「>/超过/exceed」时才认，并且要求
 * 解析出的上限小于本次发送的值（否则夹紧没有意义，不能死循环）。
 */
/**
 * 上下文窗口类错误文案（context length / prompt too long）。
 * 由 agent 的 overflow 恢复处理，max_tokens 的学习与降级都不碰。
 */
export function isContextLengthErrorText(text: string): boolean {
  return /context[\s_-]*(length|window)|prompt[\s_-]*(is\s+)?too\s+long/i.test(text);
}

/** 文案是否提及 max tokens（语义层面，无论能否解析出具体数字）。 */
export function isMaxTokensErrorText(text: string): boolean {
  return /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?|最大.{0,4}token/i.test(text);
}

/** 鉴权类错误文案（401/403，及少数网关用 400 表达的 key 错误）。 */
export function isAuthErrorText(text: string): boolean {
  return /unauthorized|forbidden|authentication|invalid[\s_-]*api[\s_-]*key|api[\s_-]*key|missing[\s_-]*key/i.test(
    text,
  );
}

export function parseMaxTokensLimit(err: unknown, sent: number): number | null {
  if (!(err instanceof LLMError)) return null;
  if (err.status !== 400 && err.status !== 422) return null;
  const text = `${err.message}\n${err.body ?? ""}`;
  // 上下文窗口类错误不是这里的事（由 agent 的 overflow 恢复处理）。
  if (isContextLengthErrorText(text)) return null;
  // 形态 1（MiniMax）：max tokens > 196608
  // 形态 2（Anthropic 官方）：max_tokens: 100000 > 64000, which is the maximum allowed …
  // 形态 3（OpenAI 风格）：supports at most 4096 completion tokens / maximum is 4096
  const patterns = [
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?\s*(?:>|greater than|exceeds?|more than|above)\s*([\d,_]+)/i,
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?\s*[:=]?\s*[\d,_]+\s*>\s*([\d,_]+)/i,
    /(?:at most|up to|no more than|limited to|maximum (?:is|of|allowed)|不超过|上限为?)\s*([\d,_]+)\s*(?:completion |output )?tokens?/i,
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?[^\n]{0,60}?(?:is|of|:|=|limit(?:ed)?(?: to)?|at most|up to|不超过|上限为?)\s*([\d,_]+)/i,
  ];
  if (!isMaxTokensErrorText(text)) return null;
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number((m[1] ?? "").replace(/[,_]/g, ""));
    if (Number.isFinite(n) && n >= 256 && n < sent) return Math.floor(n);
  }
  return null;
}

/** 已学到的输出上限（key = provider|baseUrl|model）。 */
const learnedMaxTokens = new Map<string, number>();

/**
 * 不透明 400 的安全降级地板（issue #21）。
 *
 * 取 8192 = settings.example.json 的默认 max_tokens：本项目对「保守但可用的输出预算」
 * 的既有默认，不引入第三个魔数。issue 实测网关对 16384 都返回 200，8192 远低于典型上限。
 * 刻意不用 contextWindow 的比例 —— 探测兜底的 200,000 不是事实，拿猜测当基数只会放大猜测。
 */
export const OPAQUE_400_DOWNGRADE_FLOOR = 8192;

/**
 * 不透明 400 的安全降级判定（issue #21）。
 *
 * 背景：v0.4.75 的 parseMaxTokensLimit 只认「网关明说上限」的文案；有些网关对过大的
 * max_tokens 回完全不透明 400（如 "request was rejected by an internal MaaS component"），
 * 文案里既没有 max tokens 语义也没有数字，400 又不在重试列表里 → 整个会话发不出请求。
 *
 * 触发条件（全部满足才降级）：
 *  1. status === 400（401/403/404/5xx 各走各的路径，不掺和）；
 *  2. parseMaxTokensLimit 返回 null（文案解析不出上限 —— 能解析的走 v0.4.75 学习机制）；
 *  3. 不是上下文超长文案（那是 agent 的 overflow 恢复管的）；
 *  4. 不是鉴权类文案（少数网关用 400 表达 key 错误，降级重发没有意义）；
 *  5. 当前生效值 > OPAQUE_400_DOWNGRADE_FLOOR（只降不升：≤8192 时降级没有意义）。
 *
 * 作用域由调用方决定：**仅本次请求内降级一次，不记忆**。learnedMaxTokens 记的是网关
 * 明说的上限（稳定陈述，可记忆）；不透明 400 学到的「8192 能通」只是单次观察 ——
 * 可能是限流、网关抖动或请求体其它字段的问题，固化会永久污染该 provider+model。
 */
export function shouldDowngradeForOpaque400(err: unknown, sent: number): boolean {
  if (!(err instanceof LLMError)) return false;
  if (err.status !== 400) return false;
  // parallel_tool_calls 被拒是另一条降级路径（issue #11），不能被这里抢走。
  if (isParallelToolCallsRejection(err)) return false;
  const text = `${err.message}\n${err.body ?? ""}`;
  if (isContextLengthErrorText(text)) return false;
  if (isAuthErrorText(text)) return false;
  if (parseMaxTokensLimit(err, sent) !== null) return false;
  return sent > OPAQUE_400_DOWNGRADE_FLOOR;
}

/**
 * 400/422 报错文案的 max_tokens 提示行（issue #21 C）。
 * 不改写原始文案，只追加一行；鉴权类错误不加（与 max_tokens 无关，加了误导）。
 */
export function appendMaxTokensHint(err: LLMError): void {
  if (err.status !== 400 && err.status !== 422) return;
  if (isParallelToolCallsRejection(err)) return;
  const text = `${err.message}\n${err.body ?? ""}`;
  if (isAuthErrorText(text)) return;
  if (isMaxTokensErrorText(text)) return;
  err.message = `${err.message}\n（提示：部分网关对过大的 max_tokens 会回不透明的 400；若持续失败请检查 settings.json 里该 provider 的 max_tokens 配置。）`;
}

function maxTokensKey(cfg: Config): string {
  return `${cfg.providerName}|${cfg.baseUrl}|${cfg.model}`;
}

/** 本次请求实际使用的 max_tokens：已学到上限的，夹到上限以内。 */
function effectiveMaxTokens(cfg: Config): number {
  const learned = learnedMaxTokens.get(maxTokensKey(cfg));
  return learned !== undefined ? Math.min(cfg.maxTokens, learned) : cfg.maxTokens;
}

/** 测试用：清空已学到的输出上限。 */
export function resetLearnedMaxTokens(): void {
  learnedMaxTokens.clear();
}

/** 已确认可用的协议（key = provider|baseUrl）。同一 provider 后续请求直接走它，不再反复试错。 */
const workingProto = new Map<string, ProviderType>();

function planKey(cfg: Config): string {
  return `${cfg.providerName}|${cfg.baseUrl}`;
}

/** 测试用：清空协议回退记忆。 */
export function resetEndpointMemo(): void {
  workingProto.clear();
}

/** 把已记住的可用协议提到队首。 */
function orderedPlan(cfg: Config): Endpoint[] {
  const plan = endpointPlan(cfg);
  const known = workingProto.get(planKey(cfg));
  if (!known) return plan;
  const hit = plan.find((e) => e.proto === known);
  return hit ? [hit, ...plan.filter((e) => e !== hit)] : plan;
}

/**
 * 服务端是否根本没有这个协议的端点（404/405/501）。
 * 只有这类错误才触发协议回退；鉴权失败、参数错误、限流、5xx 换协议都没有意义。
 */
export function isEndpointAbsent(err: unknown): boolean {
  if (!(err instanceof LLMError)) return false;
  return err.status === 404 || err.status === 405 || err.status === 501;
}

/** 拼 Anthropic 端点：base 以 /v1 结尾时不再重复。 */
function anthropicUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(base) ? `${base}${path}` : `${base}/v1${path}`;
}

function endpointUrl(ep: Endpoint, kind: "chat" | "models"): string {
  if (ep.proto === "anthropic") return anthropicUrl(ep.baseUrl, kind === "chat" ? "/messages" : "/models");
  return `${ep.baseUrl}${kind === "chat" ? "/chat/completions" : "/models"}`;
}

function protoHeaders(cfg: Config, proto: ProviderType): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (proto === "anthropic") {
    h["anthropic-version"] = "2023-06-01";
    // 官方端点认 x-api-key，部分 Anthropic 兼容网关只认 Bearer：两个都带，互不冲突。
    if (cfg.apiKey) {
      h["x-api-key"] = cfg.apiKey;
      h.Authorization = `Bearer ${cfg.apiKey}`;
    }
  } else if (cfg.apiKey) {
    h.Authorization = `Bearer ${cfg.apiKey}`;
  }
  return h;
}

/** 单一协议的请求体。 */
function bodyFor(proto: ProviderType, cfg0: Config, messages: Message[], tools: ToolSpec[], stream: boolean) {
  const maxTokens = effectiveMaxTokens(cfg0);
  const cfg = maxTokens === cfg0.maxTokens ? cfg0 : { ...cfg0, maxTokens };
  if (proto === "anthropic") {
    return buildAnthropicBody(
      {
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        temperature: cfg.temperature,
        thinking: cfg.thinking,
        parallel: (cfg.parallelToolCalls ?? DEFAULT_PARALLEL_TOOL_CALLS) !== "off",
      },
      messages,
      tools,
      stream,
    );
  }
  return buildBody(cfg, messages, tools, stream);
}

async function describeError(res: Response): Promise<LLMError> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  let msg = `HTTP ${res.status} ${res.statusText}`;
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof j.error === "string") msg = j.error;
    else if (j.error?.message) msg = j.error.message;
  } catch {
    if (body) msg = `${msg} — ${body.slice(0, 300)}`;
  }
  return new LLMError(msg, res.status, body);
}

export async function chat(
  cfg: Config,
  messages: Message[],
  tools: ToolSpec[] = [],
): Promise<StreamResult> {
  const plan = orderedPlan(cfg);
  let lastErr: unknown;
  let clamped = false;
  /**
   * 不透明 400 降级只做一次（issue #21）。降级值通过 activeCfg 覆盖 —— 刻意不写
   * learnedMaxTokens：单次观察不该固化成该 provider+model 的永久上限。
   */
  let opaqueDowngraded = false;
  let activeCfg = cfg;
  for (let i = 0; i < plan.length; i++) {
    const ep = plan[i]!;
    try {
      const r = await chatOnce(activeCfg, ep, messages, tools);
      if (plan.length > 1) workingProto.set(planKey(cfg), ep.proto);
      return r;
    } catch (e) {
      lastErr = e;
      const limit = clamped ? null : parseMaxTokensLimit(e, effectiveMaxTokens(activeCfg));
      if (limit !== null) {
        clamped = true;
        learnedMaxTokens.set(maxTokensKey(cfg), limit);
        i -= 1;
        continue;
      }
      // 不透明 400：夹到安全值重发一次（不记忆、不占协议回退）。与 chatStream 同口径。
      if (!opaqueDowngraded && shouldDowngradeForOpaque400(e, effectiveMaxTokens(activeCfg))) {
        opaqueDowngraded = true;
        activeCfg = { ...activeCfg, maxTokens: OPAQUE_400_DOWNGRADE_FLOOR };
        i -= 1;
        continue;
      }
      if (i < plan.length - 1 && isEndpointAbsent(e)) continue;
      if (e instanceof LLMError) appendMaxTokensHint(e);
      throw e;
    }
  }
  if (lastErr instanceof LLMError) appendMaxTokensHint(lastErr);
  throw lastErr;
}

async function chatOnce(
  cfg: Config,
  ep: Endpoint,
  messages: Message[],
  tools: ToolSpec[],
): Promise<StreamResult> {
  const res = await fetch(endpointUrl(ep, "chat"), {
    method: "POST",
    headers: protoHeaders(cfg, ep.proto),
    body: JSON.stringify(bodyFor(ep.proto, cfg, messages, tools, false)),
  });
  if (!res.ok) throw await describeError(res);

  if (ep.proto === "anthropic") {
    return parseAnthropicMessage((await res.json()) as Record<string, unknown>);
  }

  const json = (await res.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: ToolCall[];
      };
    }>;
    usage?: Usage;
  };

  const choice = json.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    reasoning: choice?.message?.reasoning_content ?? "",
    toolCalls: choice?.message?.tool_calls ?? [],
    finishReason: choice?.finish_reason ?? null,
    usage: json.usage ?? null,
    raw: json,
  };
}

/* ------------------------------------------------------------------ */
/* 流式                                                                */
/* ------------------------------------------------------------------ */

/** 除 5xx 外，按 HTTP 语义明确值得重试的状态码。 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429]);
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

function isRetryableStatus(status?: number): boolean {
  return status === undefined || status >= 500 || RETRYABLE_STATUS.has(status);
}

export interface StreamHandlers {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
  onToolCallDelta?: (index: number, name: string | null, argsDelta: string) => void;
  /** 重试/降级提示（可选）。用于把「正在重试」告诉用户，而不是静默变慢。 */
  onNotice?: (msg: string) => void;
}

interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * 发起流式请求并累积结果，失败时按策略重试（P0-1）。
 *
 * 重试边界是本函数最重要的约束：
 *  - 只重试「尚未向调用方输出任何增量」的失败 —— 一旦 reasoning/content/tool 增量
 *    已经回调给 handlers，重试会造成重复输出或重复工具调用，一律不重试；
 *  - 4xx（408/409/425/429 除外）不重试；
 *  - 用户 abort 不重试（agent 按 signal.aborted 走取消路径）。
 *  - 例外：4xx 且服务端明确拒绝 parallel_tool_calls 时，降级为 false 重发一次
 *    （不占重试预算，见 issue #11）。
 */
export async function chatStream(
  cfg: Config,
  messages: Message[],
  tools: ToolSpec[],
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
): Promise<StreamResult> {
  const policy = cfg.retry ?? DEFAULT_RETRY_CONFIG;
  // 已经取消的 signal 不应再发请求（调用方可能在进入前就按了 ESC）。
  if (signal?.aborted) throw abortError();
  let attempt = 0;
  /**
   * 瘦网关降级（issue #11）：服务端明确拒绝 parallel_tool_calls 时，本次请求内
   * 改用 false 重发一次。只降级这一轮，不写回配置 —— 用户配的是意图，
   * 网关能力是运行时事实，混在一起会让「为什么没并行」变得无法解释。
   */
  let downgraded = false;
  /** 输出上限夹紧只做一次：夹过还被拒说明是别的问题，交给调用方。 */
  let clamped = false;
  /**
   * 不透明 400 的安全降级（issue #21）：文案解析不出上限时夹到 OPAQUE_400_DOWNGRADE_FLOOR
   * 重发一次。只降不升（当前值 ≤8192 不动）；降级值通过 activeCfg 覆盖 —— 刻意不写
   * learnedMaxTokens：单次观察不该固化成该 provider+model 的永久上限。
   */
  let opaqueDowngraded = false;
  let activeCfg = cfg;
  /** 协议候选与当前下标：端点不存在时换下一个协议（不占重试预算）。 */
  const plan = orderedPlan(cfg);
  let planIdx = 0;
  for (;;) {
    attempt += 1;
    const ep = plan[planIdx]!;
    try {
      const r = await streamOnce(activeCfg, ep, messages, tools, handlers, signal, policy, downgraded);
      if (plan.length > 1) workingProto.set(planKey(cfg), ep.proto);
      return r;
    } catch (e) {
      if (signal?.aborted) throw abortError();
      const err = e instanceof LLMError ? e : new LLMError((e as Error)?.message ?? String(e));
      // max_tokens 超过该模型上限：学到上限、夹紧后同轮重发一次（不占重试预算）。
      if (!clamped) {
        const limit = parseMaxTokensLimit(err, effectiveMaxTokens(activeCfg));
        if (limit !== null) {
          clamped = true;
          learnedMaxTokens.set(maxTokensKey(cfg), limit);
          handlers.onNotice?.(
            `${cfg.model} 的输出上限是 ${limit.toLocaleString()} tokens（当前配置 ${cfg.maxTokens.toLocaleString()}），本次起自动夹紧并重发。`,
          );
          attempt -= 1;
          continue;
        }
      }
      if (planIdx < plan.length - 1 && isEndpointAbsent(err)) {
        const next = plan[planIdx + 1]!;
        handlers.onNotice?.(
          `${ep.proto} 端点不可用（HTTP ${err.status}），改用 ${next.proto} 协议重发。`,
        );
        planIdx += 1;
        attempt -= 1;
        continue;
      }
      // 网关不认 parallel_tool_calls：不占用重试预算，直接降级重发一次。
      // 必须放在 canRetry 判定之前 —— 4xx 本来不重试，否则这里会直接抛给主循环。
      if (!downgraded && ep.proto === "openai" && isParallelToolCallsRejection(err)) {
        downgraded = true;
        handlers.onNotice?.("网关不支持 parallel_tool_calls，本次请求已降级为串行（false）重发。");
        continue;
      }
      // 不透明 400（issue #21）：文案解析不出上限、非上下文超长/鉴权/parallel 拒绝时，
      // 夹到保守值重发一次。放在 parallel 降级之后 —— 那是更具体的信号，优先认领。
      if (!opaqueDowngraded && shouldDowngradeForOpaque400(err, effectiveMaxTokens(activeCfg))) {
        opaqueDowngraded = true;
        const original = effectiveMaxTokens(activeCfg);
        activeCfg = { ...activeCfg, maxTokens: OPAQUE_400_DOWNGRADE_FLOOR };
        handlers.onNotice?.(
          `网关拒绝了原 max_tokens=${original.toLocaleString()}（错误文案里解析不出上限），已降级到 ${OPAQUE_400_DOWNGRADE_FLOOR.toLocaleString()} 重发（仅本次请求；若持续失败请检查 settings.json 的 max_tokens 配置）。`,
        );
        attempt -= 1;
        continue;
      }
      const canRetry = err.retryable && isRetryableStatus(err.status);
      if (!canRetry || attempt >= policy.maxAttempts) {
        if (attempt > 1) err.message = `${err.message}（已尝试 ${attempt} 次）`;
        appendMaxTokensHint(err);
        throw err;
      }
      const delay = backoffMs(attempt, policy, err.retryAfterMs);
      handlers.onNotice?.(
        `LLM 请求失败：${err.message}；${(delay / 1000).toFixed(1)}s 后重试（第 ${attempt + 1}/${policy.maxAttempts} 次）`,
      );
      await sleepAbortable(delay, signal);
    }
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(e: unknown): boolean {
  return (e as Error | undefined)?.name === "AbortError";
}

function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(h);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** 指数退避 + 抖动；服务端给了 Retry-After 就优先听它的（封顶 30s）。 */
function backoffMs(attempt: number, policy: RetryConfig, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  const exp = Math.min(MAX_BACKOFF_MS, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = policy.baseDelayMs > 0 ? Math.random() * policy.baseDelayMs * 0.25 : 0;
  return Math.round(exp + jitter);
}

/** 可被 abort 打断的 sleep（退避期间用户按 ESC 要能立刻停）。 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 已经输出过内容后的中断：明确不可重试，避免重复正文/重复工具调用。 */
function partialInterrupt(e: Error, emittedChars: number): LLMError {
  const err = new LLMError(
    `流式响应中断（已输出 ${emittedChars} 字符，为避免重复不再重试）：${e.message}`,
    e instanceof LLMError ? e.status : undefined,
  );
  err.retryable = false;
  return err;
}

/**
 * 单次流式请求（不重试）。失败语义：
 *  - LLMTimeoutError：连接/首字节或空闲超时，调用方按「是否已输出」决定能否重试；
 *  - LLMError(status)：HTTP 失败；
 *  - 其余：网络错误。
 */
async function streamOnce(
  cfg: Config,
  ep: Endpoint,
  messages: Message[],
  tools: ToolSpec[],
  handlers: StreamHandlers,
  signal: AbortSignal | undefined,
  policy: RetryConfig,
  /** 网关拒绝 parallel_tool_calls 后的降级重发：本次请求体强制 false。 */
  forceSerial = false,
): Promise<StreamResult> {
  const ctrl = new AbortController();
  let timedOut: "connect" | "idle" | null = null;
  /** 已向调用方输出的字符数；>0 表示失败不可重试。 */
  let emittedChars = 0;
  /** 流 reader 的释放动作（读完或异常都要 releaseLock）。 */
  let releaseReader: (() => void) | null = null;
  const onUserAbort = (): void => ctrl.abort();
  signal?.addEventListener("abort", onUserAbort, { once: true });
  const connectTimer = setTimeout(() => {
    timedOut = "connect";
    ctrl.abort();
  }, policy.connectTimeoutMs);
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = "idle";
      ctrl.abort();
    }, policy.streamIdleTimeoutMs);
  };
  try {
    const res = await fetch(endpointUrl(ep, "chat"), {
      method: "POST",
      headers: protoHeaders(cfg, ep.proto),
      body: JSON.stringify(
        bodyFor(ep.proto, forceSerial ? { ...cfg, parallelToolCalls: "off" } : cfg, messages, tools, true),
      ),
      signal: ctrl.signal,
    });
    clearTimeout(connectTimer);
    if (!res.ok) {
      const err = await describeError(res);
      err.retryable = isRetryableStatus(res.status);
      err.retryAfterMs = parseRetryAfter(res);
      throw err;
    }
    if (!res.body) throw new LLMError("响应没有 body，无法流式读取");

    const streamReader = res.body.getReader();
    releaseReader = () => streamReader.releaseLock?.();
    armIdle();
    const decoder = new TextDecoder();
    let buffer = "";

    if (ep.proto === "anthropic") {
      const acc = new AnthropicStreamAccumulator(handlers);
      for (;;) {
        const { done, value } = await streamReader.read();
        if (done) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.search(/\r?\n\r?\n/);
        while (sep !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
          sep = buffer.search(/\r?\n\r?\n/);
          for (const line of rawEvent.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;
            try {
              acc.feed(JSON.parse(data) as Record<string, unknown>);
            } catch {
              // 忽略无法解析的 keep-alive 片段
            }
            emittedChars = acc.emitted;
          }
        }
      }
      if (acc.error) {
        const err = new LLMError(acc.error.message);
        err.retryable = isRetryableAnthropicError(acc.error.type);
        throw err;
      }
      // message_stop 或 stop_reason 至少要有一个，否则是连接被中途掐断（与 OpenAI 路径同口径）。
      if (!acc.sawStop && acc.finishReason === null) {
        throw new LLMError("流式连接提前结束（未收到 message_stop 或 stop_reason）");
      }
      return acc.result();
    }

    let content = "";
    let reasoning = "";
    let finishReason: string | null = null;
    let usage: Usage | null = null;
    const partials = new Map<number, PartialToolCall>();
    let lastRaw: unknown = null;
    /** 是否收到显式 [DONE]；与 finish_reason 一起用于识别连接被提前掐断。 */
    let sawDone = false;

    const handleChunk = (chunk: Record<string, unknown>): void => {
      lastRaw = chunk;
      if (typeof chunk["usage"] === "object" && chunk["usage"] !== null) {
        usage = chunk["usage"] as Usage;
      }
      const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      if (!choice) return;

      if (typeof choice["finish_reason"] === "string") {
        finishReason = choice["finish_reason"] as string;
      }

      const delta = choice["delta"] as Record<string, unknown> | undefined;
      if (!delta) return;

      const r = delta["reasoning_content"];
      if (typeof r === "string" && r.length > 0) {
        reasoning += r;
        emittedChars += r.length;
        handlers.onReasoning?.(r);
      }
      // 部分服务端把 reasoning 放在 reasoning 或 thinking 字段
      const th = delta["thinking"];
      if (typeof th === "string" && th.length > 0) {
        reasoning += th;
        emittedChars += th.length;
        handlers.onReasoning?.(th);
      }

      const ct = delta["content"];
      if (typeof ct === "string" && ct.length > 0) {
        content += ct;
        emittedChars += ct.length;
        handlers.onContent?.(ct);
      }

      const tcs = delta["tool_calls"] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = typeof tc["index"] === "number" ? tc["index"] : 0;
          let p = partials.get(idx);
          if (!p) {
            p = { id: "", name: "", args: "" };
            partials.set(idx, p);
          }
          if (typeof tc["id"] === "string" && tc["id"].length > 0) p.id = tc["id"];
          const fn = tc["function"] as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn["name"] === "string" && fn["name"].length > 0) p.name = fn["name"];
            if (typeof fn["arguments"] === "string" && fn["arguments"].length > 0) {
              p.args += fn["arguments"];
              emittedChars += fn["arguments"].length;
              handlers.onToolCallDelta?.(idx, p.name, fn["arguments"]);
            }
          }
        }
      }
    };

    for (;;) {
      const { done, value } = await streamReader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以空行分隔
      let sep = buffer.search(/\r?\n\r?\n/);
      while (sep !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        sep = buffer.search(/\r?\n\r?\n/);

        for (const line of rawEvent.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            sawDone = true;
            continue;
          }
          try {
            handleChunk(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // 忽略无法解析的 keep-alive 片段
          }
        }
      }
    }

    // SSE 正常收尾：OpenAI 兼容端点应发 [DONE] 或至少一个 finish_reason。
    // 两者都没有却 EOF，说明连接被中途掐断（部分网关/代理会这样，客户端读到的
    // 是正常 EOF 而不是错误）。必须显式失败，否则会拿半截内容当完整答案。
    if (!sawDone && finishReason === null) {
      const err = new LLMError("流式连接提前结束（未收到 [DONE] 或 finish_reason）");
      if (emittedChars > 0) throw partialInterrupt(err, emittedChars);
      throw err;
    }

    const toolCalls: ToolCall[] = [...partials.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, p]) => p.name.length > 0)
      .map(([, p], i) => ({
        id: p.id || `call_${i}_${Date.now()}`,
        type: "function" as const,
        function: { name: p.name, arguments: p.args || "{}" },
      }));

    return { content, reasoning, toolCalls, finishReason, usage, raw: lastRaw };
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (timedOut) {
      const err = new LLMTimeoutError(
        timedOut,
        timedOut === "connect" ? policy.connectTimeoutMs : policy.streamIdleTimeoutMs,
      );
      if (emittedChars > 0) throw partialInterrupt(err, emittedChars);
      throw err;
    }
    if (e instanceof LLMError) {
      if (emittedChars > 0) throw partialInterrupt(e, emittedChars);
      throw e;
    }
    if (isAbortError(e) && ctrl.signal.aborted) {
      // 除了超时与用户取消，没有别的内部 abort 来源；兜底按连接超时归类。
      const err = new LLMTimeoutError("connect", policy.connectTimeoutMs);
      if (emittedChars > 0) throw partialInterrupt(err, emittedChars);
      throw err;
    }
    const err = new LLMError(`网络请求失败：${(e as Error)?.message ?? String(e)}`);
    if (emittedChars > 0) throw partialInterrupt(err, emittedChars);
    throw err;
  } finally {
    clearTimeout(connectTimer);
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onUserAbort);
    releaseReader?.();
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/**
 * `/models` 请求候选（按协议优先级）：url + 头。探测与 listModels 共用，
 * 保证 Anthropic 端点用 /v1/models + x-api-key，而不是拿 Bearer 去撞 OpenAI 路径。
 */
export function modelsRequests(cfg: Config): Array<{ proto: ProviderType; url: string; headers: Record<string, string> }> {
  return orderedPlan(cfg).map((ep) => ({
    proto: ep.proto,
    url: endpointUrl(ep, "models"),
    headers: protoHeaders(cfg, ep.proto),
  }));
}

export async function listModels(cfg: Config): Promise<string[]> {
  const reqs = modelsRequests(cfg);
  let lastErr: unknown;
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i]!;
    try {
      const res = await fetch(r.url, { headers: r.headers });
      if (!res.ok) throw await describeError(res);
      const json = (await res.json()) as { data?: Array<{ id?: string }> };
      return (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    } catch (e) {
      lastErr = e;
      if (i < reqs.length - 1 && isEndpointAbsent(e)) continue;
      throw e;
    }
  }
  throw lastErr;
}

/** 粗略 token 估算：ASCII 约 4 字符/token，CJK 约 1.5 字符/token。 */
export function estimateTokens(messages: Message[], tools: ToolSpec[] = []): number {
  // 逐段累积「文本」与「字符数」两样东西：
  // 字符数用于算ASCII 份额，文本本身用于数 CJK。
  // 早期版本把字符数（number）当文本传给 countCjk，String(number) 后再数 CJK 恒为 0，
  // 于是中文被按 4 字符/token 计，低估约 2.7 倍 —— 压缩触发点因此严重偏晚。
  let chars = 0;
  let cjk = 0;
  let images = 0;
  const eat = (s: string): void => {
    chars += s.length;
    cjk += countCjk(s);
  };

  for (const m of messages) {
    if (typeof m.content === "string") {
      eat(m.content ?? "");
    } else if (Array.isArray(m.content)) {
      // 多模态：text part 按原算法；image part 固定 800 tokens/图
      // （OpenAI detail:low 档量级；各服务端口径不一，粗估即可 —— PRD §5.5）
      for (const p of m.content) {
        if (p.type === "text") eat(p.text);
        else images += 1;
      }
    }
    for (const tc of m.tool_calls ?? []) {
      eat(tc.function.arguments);
      eat(tc.function.name);
    }
  }

  eat(JSON.stringify(tools));

  const ascii = Math.max(0, chars - cjk);
  return Math.ceil(ascii / 4 + cjk / 1.5) + messages.length * 4 + images * 800;
}

/**
 * 统计 CJK 字符数。
 *
 * 必须传字符串本身，不能传长度 —— 数字里没有 CJK，恒返回 0。
 * 覆盖范围按 code point 判定，含中日韩表意文字与假名音标。
 */
function countCjk(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // 0x3000-0x30FF：CJK 标点 / 假名；0x3400-0x9FFF：表意文字与兼容区
    // 0xF900-0xFAFF：兼容表意文字；0xFF00-0xFF60：全角字符
    if (
      (cp >= 0x3000 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60)
    ) {
      n++;
    }
  }
  return n;
}
