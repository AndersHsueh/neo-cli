/**
 * MCP 旧式 SSE 传输（issue #44，来源 #29 非目标）。
 *
 * 与 streamable HTTP（`httpRpc.ts`）的区别 —— 两者都叫「SSE」，但不是一回事：
 *
 *  - **streamable HTTP**：每个请求 POST 到同一端点，响应体可能就是事件流，
 *    请求与响应在同一条流里按 id 配对，无状态。
 *  - **旧式 SSE**（本文件）：启动时建一条 **GET 长连接**，首事件 `event: endpoint`
 *    给出 POST 目标；之后所有 JSON-RPC 消息 POST 到该目标（服务端回 202，body 为空），
 *    **结果从 GET 长连接流回来**。因此必须常驻一个读流循环 + pending Map。
 *
 * 生命周期语义向 `StdioRpc` 靠（而不是向 `HttpRpc`）：长连接断了 = 连接死了，
 * 在途请求**立即** reject，不让工具调用干等到超时。
 *
 * 口径与 #29 主项一致：**不重连**。断了就是断了，用户看 `/mcp` 并重启 neo。
 */
import type { McpRpc } from "./jsonrpc.ts";
import { parseSseBlocks, type JsonRpcResponse } from "./sseParse.ts";

export interface SseRpcOptions {
  /** GET 长连接地址（配置里的 `url`）。 */
  url: string;
  /** 额外请求头（鉴权等）。 */
  headers?: Record<string, string>;
  /** 单次请求超时（毫秒）。 */
  requestTimeoutMs?: number;
  /** 握手超时（毫秒）：等 `event: endpoint` 的时间。 */
  handshakeTimeoutMs?: number;
  /** 测试注入点：默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * 读流的最小结构类型。
 *
 * 不用 `ReadableStreamDefaultReader<Uint8Array>`：bun-types 给它的定义多一个
 * `readMany`，而 `res.body.getReader()` 推断出来的是 `ReadableStreamDefaultReader<any>`，
 * 两者不兼容（TS2741）。这里只声明我们真正用到的两个方法。
 */
interface SseReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(reason?: unknown): Promise<void>;
}

export class SseRpc implements McpRpc {
  private nextId = 1;
  private closed = false;
  /** 长连接已断开（服务端关闭/读流出错）。与 `closed` 区分：这是传输层自己发现的死亡。 */
  private dead = false;
  /** 握手得到的 POST 目标（已按 GET URL 解析成绝对地址）。 */
  private endpoint: string | null = null;
  private pending = new Map<number, Pending>();
  private readonly inflight = new Set<AbortController>();
  private reader: SseReader | null = null;
  readonly stderrTail: string[] = [];
  private readonly timeoutMs: number;
  private readonly handshakeTimeoutMs: number;

  constructor(private readonly opts: SseRpcOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }

  get alive(): boolean {
    return !this.closed && this.endpoint !== null && !this.dead;
  }

  private headers(): Record<string, string> {
    return { ...(this.opts.headers ?? {}) };
  }

  /**
   * 建 GET 长连接并等 `event: endpoint`。
   *
   * 握手失败（连不上 / 超时 / 首事件不是 endpoint）一律抛错，由 manager 收敛成
   * 该 server 的 error 状态 —— 与 stdio 的「拉进程失败」同一处理位置。
   */
  async start(): Promise<void> {
    if (this.closed) throw new Error("MCP 连接已关闭");
    if (this.endpoint) return;
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), this.handshakeTimeoutMs);
    let res: Response;
    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      res = await fetchImpl(this.opts.url, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.headers() },
        signal: ctrl.signal,
      });
    } catch (e) {
      const msg = ctrl.signal.aborted ? `握手超时（${this.handshakeTimeoutMs}ms）` : (e as Error).message;
      this.stderrTail.push(`GET ${this.opts.url} 失败：${msg}`);
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
      this.inflight.delete(ctrl);
    }
    if (!res.ok) {
      const err = `HTTP ${res.status} ${res.statusText}`;
      this.stderrTail.push(`GET ${this.opts.url} 失败：${err}`);
      try {
        await res.body?.cancel?.();
      } catch {
        /* 忽略 */
      }
      throw new Error(err);
    }
    const body = res.body;
    if (!body) throw new Error("SSE 响应没有 body");
    const reader = body.getReader();
    this.reader = reader;

    // 等首事件 endpoint。读到的第一批事件里若已夹带别的消息，交给 dispatch 处理。
    const endpoint = await this.awaitEndpoint(reader);
    // 相对路径必须按 GET 的 URL 解析（`/message` 是根绝对路径，`msg` 是同目录相对路径）。
    this.endpoint = new URL(endpoint, this.opts.url).toString();
    // 握手之后继续常驻读流（不 await：它跑到连接关闭为止）。
    void this.readLoop(reader);
  }

  /** 读流直到拿到 `event: endpoint`；期间收到的 JSON-RPC 消息照常分发。 */
  private async awaitEndpoint(reader: SseReader): Promise<string> {
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE 流在 endpoint 握手前就结束了");
      buf += decoder.decode(value, { stream: true });
      const { blocks, rest } = parseSseBlocks(buf);
      buf = rest;
      for (const block of blocks) {
        if (block.event === "endpoint") {
          const data = block.data.trim();
          if (!data) throw new Error("endpoint 事件没有 data");
          return data;
        }
        if (block.data) this.dispatch(block.data);
      }
    }
  }

  /** 常驻读流：分发结果；流结束/出错 = 连接死亡，在途请求立即失败。 */
  private async readLoop(reader: SseReader): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { blocks, rest } = parseSseBlocks(buf);
        buf = rest;
        for (const block of blocks) if (block.data) this.dispatch(block.data);
      }
      this.failAll(new Error("MCP SSE 连接已被服务端关闭"));
    } catch (e) {
      this.failAll(new Error(`MCP SSE 连接中断：${(e as Error).message}`));
    } finally {
      // 断流 = 连接死亡（不重连，与 #29 主项同口径）：后续 request 立刻失败，不干等超时。
      this.dead = true;
    }
  }

  /** 一条事件 data → 按 id 配对到 pending；服务端请求回 -32601（与 stdio 同口径）。 */
  private dispatch(data: string): void {
    if (data === "[DONE]") return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(data) as JsonRpcResponse;
    } catch {
      return; // 心跳/非 JSON 事件跳过
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;
    if (m["method"] === undefined && m["id"] !== undefined) {
      const id = Number(m["id"]);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const err = m["error"];
      if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        p.reject(new Error(`JSON-RPC 错误 ${e["code"] ?? ""}：${e["message"] ?? "未知错误"}`.trim()));
      } else {
        p.resolve(m["result"]);
      }
      return;
    }
    // 服务端发来的请求：明确回「不支持」，不静默丢弃（否则对方会一直等）。
    if (typeof m["method"] === "string" && m["id"] !== undefined) {
      void this.post({ jsonrpc: "2.0", id: m["id"], error: { code: -32601, message: `neo 不支持 ${String(m["method"])}` } });
    }
  }

  /** POST 一条消息到 endpoint。旧式 SSE 的 POST 一律 202，body 不读。 */
  private async post(body: unknown): Promise<void> {
    if (this.closed) throw new Error("MCP 连接已关闭");
    if (!this.endpoint) throw new Error("SSE 连接尚未完成 endpoint 握手");
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const fetchImpl = this.opts.fetchImpl ?? fetch;
      const res = await fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.headers() },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = `HTTP ${res.status} ${res.statusText}`;
        this.stderrTail.push(`POST ${this.endpoint} 失败：${err}`);
        throw new Error(err);
      }
      await res.body?.cancel?.();
    } catch (e) {
      const msg = ctrl.signal.aborted ? `请求超时（${this.timeoutMs}ms）` : (e as Error).message;
      throw new Error(msg);
    } finally {
      clearTimeout(timer);
      this.inflight.delete(ctrl);
    }
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.alive) throw new Error("MCP 连接已关闭");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求 ${method} 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      // POST 失败（网络/非 2xx）要立刻 reject，别让这条请求干等超时。
      this.post({ jsonrpc: "2.0", id, method, params: params ?? {} }).catch((e: Error) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(e);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return;
    try {
      await this.post({ jsonrpc: "2.0", method, params: params ?? {} });
    } catch (e) {
      // 通知失败不阻断握手（与 stdio 一致：写失败由后续请求暴露）。
      this.stderrTail.push(`通知 ${method} 失败：${(e as Error).message}`);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("MCP 连接已关闭"));
    for (const ctrl of this.inflight) {
      try {
        ctrl.abort();
      } catch {
        /* 忽略 */
      }
    }
    this.inflight.clear();
    try {
      void this.reader?.cancel();
    } catch {
      /* 忽略 */
    }
    this.reader = null;
  }
}
