/**
 * Anthropic Messages 协议的**纯转换层**（无网络、无副作用）。
 *
 * 内部消息模型（Message / ToolCall / ToolSpec / StreamResult）一直是 OpenAI 形态，
 * 会话持久化、压缩、子代理、记忆都依赖它。这里只在请求边界做双向转换：
 *   Message[] / ToolSpec[]  →  Anthropic 请求体
 *   Anthropic 响应 / SSE 事件  →  StreamResult / 回调
 * 这样切协议（甚至同一会话里切 provider）不会让历史失效。
 *
 * 只 `import type`：llm.ts 反过来依赖本文件，运行时不能成环。
 */
import type { Message, StreamResult, ThinkingBlock, ToolCall, ToolSpec, Usage } from "./llm.ts";

type Block = Record<string, unknown>;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

/** tool_use.id / tool_result.tool_use_id 只允许 [a-zA-Z0-9_-]；其他协议生成的 id 可能含别的字符。 */
export function sanitizeToolId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return s.length > 0 ? s : "call_0";
}

function imageBlock(url: string): Block {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return { type: "text", text: "[无法识别的图片]" };
}

function userBlocks(content: Message["content"]): Block[] {
  if (content === null) return [];
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  const out: Block[] = [];
  for (const p of content) {
    if (p.type === "text") {
      if (p.text.length > 0) out.push({ type: "text", text: p.text });
    } else {
      out.push(imageBlock(p.image_url.url));
    }
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * OpenAI 形态消息 → Anthropic 的 system + messages。
 *
 *  - system：Anthropic 只有顶层 system 字段。**开头**连续的 system 消息合并进去；
 *    对话中途插入的 system 消息（实现提示、steer 等）没有对应位置，改成 user 文本块，
 *    内容原样保留并带「[系统消息]」前缀，不丢也不提升为顶层指令。
 *  - tool → user 消息里的 tool_result 块；连续的 tool 结果合并进同一条 user 消息
 *    （Anthropic 要求 tool_use 之后紧跟包含全部 tool_result 的一条 user 消息）。
 *  - 相邻同角色消息合并：保证 user / assistant 严格交替。
 */
export function toAnthropicMessages(messages: Message[]): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  let seenNonSystem = false;

  const push = (role: "user" | "assistant", blocks: Block[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    out.push({ role, content: [...blocks] });
  };

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      if (!text) continue;
      if (!seenNonSystem) systemParts.push(text);
      else push("user", [{ type: "text", text: `[系统消息]\n${text}` }]);
      continue;
    }
    seenNonSystem = true;

    if (m.role === "user") {
      push("user", userBlocks(m.content));
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      // 思考块必须排在 text / tool_use 之前，并保持原样（含签名）。
      for (const tb of m.thinking_blocks ?? []) blocks.push({ ...tb });
      if (typeof m.content === "string" && m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: sanitizeToolId(tc.id),
          name: tc.function.name,
          input: parseArgs(tc.function.arguments),
        });
      }
      // 空助手消息（无正文无工具调用）Anthropic 会拒收，给一个占位而不是丢弃以保持交替。
      if (blocks.length === 0) blocks.push({ type: "text", text: "(无内容)" });
      push("assistant", blocks);
    } else {
      const text = typeof m.content === "string" ? m.content : "";
      push("user", [
        {
          type: "tool_result",
          tool_use_id: sanitizeToolId(m.tool_call_id ?? ""),
          content: text.length > 0 ? text : "(无输出)",
        },
      ]);
    }
  }

  // tool_result 必须排在同一条 user 消息的最前面（Anthropic 的硬性要求）。
  for (const msg of out) {
    if (msg.role !== "user") continue;
    const results = msg.content.filter((b) => b["type"] === "tool_result");
    if (results.length === 0) continue;
    msg.content = [...results, ...msg.content.filter((b) => b["type"] !== "tool_result")];
  }
  return { system: systemParts.join("\n\n"), messages: out };
}

export function toAnthropicTools(tools: ToolSpec[]): Block[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

export interface AnthropicBodyInput {
  model: string;
  maxTokens: number;
  temperature: number;
  thinking?: { type: "enabled" | "disabled" };
  /** 是否允许并行工具调用。 */
  parallel: boolean;
}

/** thinking 预算下限（Anthropic 规定 budget_tokens >= 1024 且 < max_tokens）。 */
const MIN_THINKING_BUDGET = 1024;

export function buildAnthropicBody(
  input: AnthropicBodyInput,
  messages: Message[],
  tools: ToolSpec[],
  stream: boolean,
): Record<string, unknown> {
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens,
    messages: msgs,
    stream,
    temperature: input.temperature,
  };
  if (system) body.system = system;
  if (tools.length > 0) {
    body.tools = toAnthropicTools(tools);
    body.tool_choice = { type: "auto", disable_parallel_tool_use: !input.parallel };
  }
  if (input.thinking?.type === "disabled") {
    body.thinking = { type: "disabled" };
  } else if (input.thinking?.type === "enabled" && input.maxTokens > MIN_THINKING_BUDGET) {
    // 预算取输出上限的一半（至少 1024）：给正文留足空间，又不让思考吃光 max_tokens。
    body.thinking = {
      type: "enabled",
      budget_tokens: Math.min(input.maxTokens - 1, Math.max(MIN_THINKING_BUDGET, Math.floor(input.maxTokens / 2))),
    };
  }
  return body;
}

/** Anthropic stop_reason → 内部沿用的 OpenAI finish_reason 取值。 */
export function mapStopReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return reason;
  }
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

/**
 * Anthropic usage → 内部 Usage。
 * Anthropic 的 input_tokens **不含**缓存命中/写入部分，三者相加才是本次请求的真实输入规模。
 */
export function mapUsage(u: RawUsage): Usage {
  const prompt =
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const completion = u.output_tokens ?? 0;
  const out: Usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  const th = u.output_tokens_details?.thinking_tokens;
  if (typeof th === "number") out.completion_tokens_details = { reasoning_tokens: th };
  return out;
}

/** 非流式响应 → StreamResult。 */
export function parseAnthropicMessage(json: Record<string, unknown>): StreamResult {
  const blocks = Array.isArray(json["content"]) ? (json["content"] as Block[]) : [];
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];
  for (const b of blocks) {
    const type = b["type"];
    if (type === "text" && typeof b["text"] === "string") content += b["text"];
    else if (type === "thinking" && typeof b["thinking"] === "string") {
      reasoning += b["thinking"];
      if (typeof b["signature"] === "string" && b["signature"]) {
        thinkingBlocks.push({ type: "thinking", thinking: b["thinking"], signature: b["signature"] });
      }
    } else if (type === "redacted_thinking" && typeof b["data"] === "string") {
      thinkingBlocks.push({ type: "redacted_thinking", data: b["data"] });
    } else if (type === "tool_use" && typeof b["name"] === "string") {
      toolCalls.push({
        id: typeof b["id"] === "string" && b["id"] ? b["id"] : `call_${toolCalls.length}_${Date.now()}`,
        type: "function",
        function: { name: b["name"], arguments: JSON.stringify(b["input"] ?? {}) },
      });
    }
  }
  const usage = json["usage"];
  return {
    content,
    reasoning,
    toolCalls,
    finishReason: mapStopReason(json["stop_reason"] as string | null | undefined),
    usage: typeof usage === "object" && usage !== null ? mapUsage(usage as RawUsage) : null,
    raw: json,
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
  };
}

export interface AnthropicStreamHandlers {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
  onToolCallDelta?: (index: number, name: string | null, argsDelta: string) => void;
}

interface PartialTool {
  order: number;
  id: string;
  name: string;
  args: string;
  /** content_block_start 里就带了完整 input（非标准）；之后若又来 delta，以 delta 为准。 */
  seeded: boolean;
}

/**
 * SSE 事件累积器。llm.ts 把每个解析后的 `data:` JSON 喂进来；
 * 回调语义与 OpenAI 路径完全一致（同一套 handlers）。
 *
 * 不在这里抛错：服务端 `error` 事件记入 `error`，由调用方转成 LLMError
 * （本文件不能依赖 llm.ts 的运行时，否则成环）。
 */
export class AnthropicStreamAccumulator {
  content = "";
  reasoning = "";
  finishReason: string | null = null;
  sawStop = false;
  /** 已向调用方输出的字符数（与 OpenAI 路径同口径，>0 表示失败不可重试）。 */
  emitted = 0;
  error: { type: string; message: string } | null = null;
  lastRaw: unknown = null;

  private usage: RawUsage | null = null;
  private tools = new Map<number, PartialTool>();
  private blockTypes = new Map<number, string>();
  /** 按 content block 下标累积的思考块（流式里 thinking/signature 是分片到达的）。 */
  private thinking = new Map<number, { thinking: string; signature: string; redacted?: string }>();

  constructor(private readonly h: AnthropicStreamHandlers) {}

  private mergeUsage(u: RawUsage | undefined): void {
    if (!u) return;
    const cur = (this.usage ??= {});
    // message_start 里常是 0 占位，message_delta 带累计值：只让非零/首次出现的值覆盖。
    for (const k of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ] as const) {
      const v = u[k];
      if (typeof v === "number" && (v > 0 || cur[k] === undefined)) cur[k] = v;
    }
    const th = u.output_tokens_details?.thinking_tokens;
    if (typeof th === "number" && (th > 0 || cur.output_tokens_details === undefined)) {
      cur.output_tokens_details = { thinking_tokens: th };
    }
  }

  feed(ev: Record<string, unknown>): void {
    this.lastRaw = ev;
    const type = ev["type"];
    switch (type) {
      case "message_start": {
        const msg = ev["message"] as { usage?: RawUsage } | undefined;
        this.mergeUsage(msg?.usage);
        return;
      }
      case "content_block_start": {
        const idx = typeof ev["index"] === "number" ? ev["index"] : 0;
        const cb = (ev["content_block"] ?? {}) as Record<string, unknown>;
        const bt = typeof cb["type"] === "string" ? cb["type"] : "";
        this.blockTypes.set(idx, bt);
        if (bt === "thinking") {
          this.thinking.set(idx, {
            thinking: typeof cb["thinking"] === "string" ? cb["thinking"] : "",
            signature: typeof cb["signature"] === "string" ? cb["signature"] : "",
          });
        } else if (bt === "redacted_thinking") {
          this.thinking.set(idx, { thinking: "", signature: "", redacted: typeof cb["data"] === "string" ? cb["data"] : "" });
        }
        if (bt === "tool_use") {
          const input = cb["input"];
          const hasInput =
            typeof input === "object" && input !== null && Object.keys(input as object).length > 0;
          this.tools.set(idx, {
            order: this.tools.size,
            id: typeof cb["id"] === "string" ? cb["id"] : "",
            name: typeof cb["name"] === "string" ? cb["name"] : "",
            args: hasInput ? JSON.stringify(input) : "",
            seeded: hasInput,
          });
        }
        return;
      }
      case "content_block_delta": {
        const idx = typeof ev["index"] === "number" ? ev["index"] : 0;
        const d = (ev["delta"] ?? {}) as Record<string, unknown>;
        const dt = d["type"];
        if (dt === "text_delta" && typeof d["text"] === "string" && d["text"].length > 0) {
          this.content += d["text"];
          this.emitted += d["text"].length;
          this.h.onContent?.(d["text"]);
        } else if (dt === "thinking_delta" && typeof d["thinking"] === "string" && d["thinking"].length > 0) {
          this.reasoning += d["thinking"];
          this.emitted += d["thinking"].length;
          const tb = this.thinking.get(idx);
          if (tb) tb.thinking += d["thinking"];
          this.h.onReasoning?.(d["thinking"]);
        } else if (dt === "signature_delta" && typeof d["signature"] === "string") {
          const tb = this.thinking.get(idx);
          if (tb) tb.signature += d["signature"];
        } else if (dt === "input_json_delta" && typeof d["partial_json"] === "string") {
          const t = this.tools.get(idx);
          if (!t) return;
          if (t.seeded) {
            t.args = "";
            t.seeded = false;
          }
          if (d["partial_json"].length > 0) {
            t.args += d["partial_json"];
            this.emitted += d["partial_json"].length;
            this.h.onToolCallDelta?.(t.order, t.name, d["partial_json"]);
          }
        }
        // signature_delta / citations_delta 等：对对话没有价值，忽略。
        return;
      }
      case "message_delta": {
        const d = ev["delta"] as { stop_reason?: string | null } | undefined;
        if (typeof d?.stop_reason === "string") this.finishReason = mapStopReason(d.stop_reason);
        this.mergeUsage(ev["usage"] as RawUsage | undefined);
        return;
      }
      case "message_stop":
        this.sawStop = true;
        return;
      case "error": {
        const e = (ev["error"] ?? {}) as { type?: string; message?: string };
        this.error = { type: e.type ?? "error", message: e.message ?? "服务端返回 error 事件" };
        return;
      }
      default:
        // ping 及未来新增事件：忽略。
        return;
    }
  }

  result(): StreamResult {
    const toolCalls: ToolCall[] = [...this.tools.values()]
      .sort((a, b) => a.order - b.order)
      .filter((t) => t.name.length > 0)
      .map((t, i) => ({
        id: t.id || `call_${i}_${Date.now()}`,
        type: "function" as const,
        function: { name: t.name, arguments: t.args || "{}" },
      }));
    const thinkingBlocks: ThinkingBlock[] = [...this.thinking.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, t]): ThinkingBlock[] => {
        if (t.redacted !== undefined) return t.redacted ? [{ type: "redacted_thinking", data: t.redacted }] : [];
        // 没有签名的思考块回带必被拒收，宁可不带。
        return t.signature ? [{ type: "thinking", thinking: t.thinking, signature: t.signature }] : [];
      });
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls,
      finishReason: this.finishReason,
      usage: this.usage ? mapUsage(this.usage) : null,
      raw: this.lastRaw,
      ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    };
  }
}

/** error 事件类型里哪些值得重试（过载/限流/服务端故障）；其余（鉴权、参数）重试无意义。 */
export function isRetryableAnthropicError(type: string): boolean {
  return type === "overloaded_error" || type === "api_error" || type === "rate_limit_error";
}
