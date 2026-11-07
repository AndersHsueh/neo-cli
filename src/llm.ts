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

export interface Message {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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

function buildBody(cfg: Config, messages: Message[], tools: ToolSpec[], stream: boolean) {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
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
function bodyFor(proto: ProviderType, cfg: Config, messages: Message[], tools: ToolSpec[], stream: boolean) {
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
  for (let i = 0; i < plan.length; i++) {
    const ep = plan[i]!;
    try {
      const r = await chatOnce(cfg, ep, messages, tools);
      if (plan.length > 1) workingProto.set(planKey(cfg), ep.proto);
      return r;
    } catch (e) {
      lastErr = e;
      if (i < plan.length - 1 && isEndpointAbsent(e)) continue;
      throw e;
    }
  }
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
  /** 协议候选与当前下标：端点不存在时换下一个协议（不占重试预算）。 */
  const plan = orderedPlan(cfg);
  let planIdx = 0;
  for (;;) {
    attempt += 1;
    const ep = plan[planIdx]!;
    try {
      const r = await streamOnce(cfg, ep, messages, tools, handlers, signal, policy, downgraded);
      if (plan.length > 1) workingProto.set(planKey(cfg), ep.proto);
      return r;
    } catch (e) {
      if (signal?.aborted) throw abortError();
      const err = e instanceof LLMError ? e : new LLMError((e as Error)?.message ?? String(e));
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
      const canRetry = err.retryable && isRetryableStatus(err.status);
      if (!canRetry || attempt >= policy.maxAttempts) {
        if (attempt > 1) err.message = `${err.message}（已尝试 ${attempt} 次）`;
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
