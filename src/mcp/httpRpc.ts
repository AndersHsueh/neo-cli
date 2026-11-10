/**
 * MCP streamable HTTP 传输（issue #29）。
 *
 * 协议要点（MCP Streamable HTTP）：
 *  - 每个 JSON-RPC 消息都 **POST 到同一个端点**（`url`）；
 *  - 响应可能是 `application/json`（单条结果），也可能是 `text/event-stream`（SSE 流，
 *    逐事件返回，流里可能夹着通知与心跳）；两种都要能读；
 *  - 服务端可能在响应头给 `Mcp-Session-Id`，之后的请求必须带上它；
 *  - 通知（没有 `id`）通常回 202，不要求 body。
 *
 * 与 StdioRpc 的差别：HTTP 是无状态传输，**没有子进程、没有 stderr**，所以
 * `stderrTail` 里放的是传输层自己的失败摘要（给 `/mcp` 排障用，不伪造子进程语义）。
 *
 * 越权/凭据：只发配置里显式给的 `headers`（首期静态 Bearer），不做 OAuth 登录。
 */
import type { McpRpc } from "./jsonrpc.ts";
import { parseSseBlocks, type JsonRpcResponse } from "./sseParse.ts";

export interface HttpRpcOptions {
  /** streamable HTTP 端点（完整 URL）。 */
  url: string;
  /** 额外请求头（鉴权等）。 */
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  /** 测试注入点：默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** 把响应体截一段进错误信息：JSON-RPC 的错误常在 body 里，不能只报状态码。 */
async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text ? `：${text.slice(0, 300).replace(/\s+/g, " ")}` : "";
  } catch {
    return "";
  }
}

export class HttpRpc implements McpRpc {
  private nextId = 1;
  private closed = false;
  private sessionId: string | null = null;
  private readonly inflight = new Set<AbortController>();
  readonly stderrTail: string[] = [];
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpRpcOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get alive(): boolean {
    return !this.closed;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      // 两种响应形态都要声明接受，服务端据此选择 JSON 或 SSE。
      Accept: "application/json, text/event-stream",
      ...(this.opts.headers ?? {}),
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  private async post(body: unknown): Promise<Response> {
    if (this.closed) throw new Error("MCP 连接已关闭");
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const res = await fetchImpl(this.opts.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      return res;
    } catch (e) {
      const msg = ctrl.signal.aborted ? `请求超时（${this.timeoutMs}ms）` : (e as Error).message;
      this.stderrTail.push(`POST ${this.opts.url} 失败：${msg}`);
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
      this.inflight.delete(ctrl);
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params: params ?? {} });
    if (!res.ok) {
      const snippet = await bodySnippet(res);
      const err = `HTTP ${res.status} ${res.statusText}${snippet}`;
      this.stderrTail.push(`${method} 失败：${err}`);
      throw new Error(err);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) return this.readSseResult<T>(res, id);
    return parseResult<T>(await res.json(), method);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return;
    try {
      const res = await this.post({ jsonrpc: "2.0", method, params: params ?? {} });
      if (!res.ok) this.stderrTail.push(`通知 ${method} 返回 HTTP ${res.status}`);
      await res.body?.cancel?.();
    } catch (e) {
      // 通知失败不阻断握手（与 stdio 一致：写失败由后续请求暴露）。
      this.stderrTail.push(`通知 ${method} 失败：${(e as Error).message}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const ctrl of this.inflight) {
      try {
        ctrl.abort();
      } catch {
        /* 忽略 */
      }
    }
    this.inflight.clear();
  }

  /**
   * 从 SSE 流里读到与请求 id 匹配的响应。
   *
   * 流里可能先来服务端通知（无 id / 别的 id），一律跳过；读到我们这条就返回。
   * 流被服务端关掉还没等到结果 = 协议错误（明确报错，别让工具调用干等超时）。
   */
  private async readSseResult<T>(res: Response, id: number): Promise<T> {
    const body = res.body;
    if (!body) throw new Error("SSE 响应没有 body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE 事件以空行分隔（切分规则与旧式 SSE 传输共用，见 sseParse.ts）。
        const { blocks, rest } = parseSseBlocks(buf);
        buf = rest;
        for (const block of blocks) {
          if (block.data === "" || block.data === "[DONE]") continue;
          let parsed: JsonRpcResponse;
          try {
            parsed = JSON.parse(block.data) as JsonRpcResponse;
          } catch {
            continue; // 心跳/非 JSON 事件跳过
          }
          if (parsed.id !== id) continue; // 服务端通知或别的请求的结果
          return parseResult<T>(parsed, "unknown");
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* 忽略 */
      }
    }
    throw new Error("SSE 流已结束但没等到响应（可能被服务端提前关闭）");
  }
}

/** JSON-RPC 响应 → 结果；带 error 时抛出可读错误。 */
function parseResult<T>(raw: unknown, method: string): T {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`MCP HTTP 响应不是 JSON-RPC 对象（${method}）`);
  }
  const msg = raw as JsonRpcResponse;
  if (msg.error) {
    throw new Error(`JSON-RPC 错误 ${msg.error.code ?? ""}：${msg.error.message ?? "未知错误"}`.trim());
  }
  if (!("result" in msg)) {
    throw new Error(`MCP HTTP 响应缺少 result（${method}）`);
  }
  return msg.result as T;
}
