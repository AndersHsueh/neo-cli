/**
 * Anthropic 流式累积器（带状态）。纯 wire 转换已晋升到
 * `@neo/core-compat/compat/v1`；累加器仍留在旧侧。
 *
 * 只 `import type` 自 llm.ts：llm.ts 反过来依赖本文件，运行时不能成环。
 */
import type { StreamResult, ThinkingBlock, ToolCall } from "./llm.ts";
import { mapStopReason, mapUsage, type RawUsage } from "@neo/core-compat/compat/v1";
export {
  sanitizeToolId,
  toAnthropicMessages,
  toAnthropicTools,
  buildAnthropicBody,
  mapStopReason,
  mapUsage,
  parseAnthropicMessage,
  isRetryableAnthropicError,
} from "@neo/core-compat/compat/v1";
export type { AnthropicMessage, AnthropicBodyInput, RawUsage } from "@neo/core-compat/compat/v1";

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
