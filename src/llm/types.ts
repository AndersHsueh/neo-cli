/**
 * LLM 消息模型、用量与错误类型。
 */
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
