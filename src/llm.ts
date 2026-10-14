/**
 * OpenAI 兼容 LLM 客户端。
 *
 * 针对本项目实测到的服务端特性做了三点适配：
 *  1. 推理模型会额外返回 reasoning_content，与 content 分开流式下发；
 *     两者都要累积，但只有 content 进对话历史，reasoning 只做展示。
 *  2. tool_calls 以增量形式下发（delta.tool_calls 带 index），需按 index 拼接。
 *  3. SSE 以空行分隔事件，末条为 data: [DONE]。
 */
import type { Config } from "./config.ts";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LLMError";
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
    // 推理模型 + tools 的常见约束：并行调用会产生不确定结果，强制单个。
    body.parallel_tool_calls = false;
  }
  if (cfg.thinking !== undefined) body.thinking = cfg.thinking;
  return body;
}

function authHeaders(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
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
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(buildBody(cfg, messages, tools, false)),
  });
  if (!res.ok) throw await describeError(res);

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

export interface StreamHandlers {
  onReasoning?: (delta: string) => void;
  onContent?: (delta: string) => void;
  onToolCallDelta?: (index: number, name: string | null, argsDelta: string) => void;
}

interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * 发起流式请求并累积结果。
 * 同时把增量回调给 handlers，用于实时渲染。
 */
export async function chatStream(
  cfg: Config,
  messages: Message[],
  tools: ToolSpec[],
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
): Promise<StreamResult> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(buildBody(cfg, messages, tools, true)),
    signal,
  });
  if (!res.ok) throw await describeError(res);
  if (!res.body) throw new LLMError("响应没有 body，无法流式读取");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: Usage | null = null;
  const partials = new Map<number, PartialToolCall>();
  let lastRaw: unknown = null;

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
      handlers.onReasoning?.(r);
    }
    // 部分服务端把 reasoning 放在 reasoning 或 thinking 字段
    const th = delta["thinking"];
    if (typeof th === "string" && th.length > 0) {
      reasoning += th;
      handlers.onReasoning?.(th);
    }

    const ct = delta["content"];
    if (typeof ct === "string" && ct.length > 0) {
      content += ct;
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
            handlers.onToolCallDelta?.(idx, p.name, fn["arguments"]);
          }
        }
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
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
          if (!data || data === "[DONE]") continue;
          try {
            handleChunk(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // 忽略无法解析的 keep-alive 片段
          }
        }
      }
    }
  } finally {
    reader.releaseLock?.();
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
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

export async function listModels(cfg: Config): Promise<string[]> {
  const res = await fetch(`${cfg.baseUrl}/models`, { headers: authHeaders(cfg) });
  if (!res.ok) throw await describeError(res);
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

/** 粗略 token 估算：ASCII 约 4 字符/token，CJK 约 1.5 字符/token。 */
export function estimateTokens(messages: Message[], tools: ToolSpec[] = []): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length + tc.function.name.length;
  }
  const toolChars = JSON.stringify(tools).length;
  const total = chars + toolChars;
  const cjk = countCjk(chars + toolChars);
  const ascii = total - cjk;
  return Math.ceil(ascii / 4 + cjk / 1.5) + messages.length * 4;
}

function countCjk(s: number | string): number {
  const str = typeof s === "number" ? String(s) : s;
  let n = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x3000 && cp <= 0x9fff) n++;
  }
  return n;
}
