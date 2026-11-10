/**
 * 最小 LSP 客户端（issue #23）：JSON-RPC over stdio + Content-Length 帧。
 *
 * 定位：**只读情报通道** —— 编辑后诊断 + definition/references/hover。
 * 不做沙箱、不捆绑语言服务器：用户按 settings 配一条 command（如 `typescript-language-server --stdio`），
 * 没配就是零开销（不 spawn、不扫盘）。
 *
 * 与 MCP 的 jsonrpc.ts 刻意分开：MCP 是「一行一个 JSON」的 stdio 传输，LSP 是
 * `Content-Length: N\r\n\r\n<json>` 帧；混用会互相踩。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface LspDiagnostic {
  line: number; // 0-based（LSP 原始口径）
  character: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  code?: string | number;
}

export interface LspClientOptions {
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  requestTimeoutMs?: number;
  /** 排障：server 的 stderr 一行。 */
  onStderr?: (line: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

const DEFAULT_TIMEOUT_MS = 8_000;

/** LSP 的 Content-Length 帧编码（导出给单测）。 */
export function encodeLspMessage(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload]);
}

/** 增量解帧：喂字节，吐完整消息。 */
export class LspFramer {
  private buf = Buffer.alloc(0);
  push(chunk: Buffer): JsonRpcMessage[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: JsonRpcMessage[] = [];
    for (;;) {
      const headerEnd = this.buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return out;
      const header = this.buf.subarray(0, headerEnd).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + length) return out;
      const body = this.buf.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buf = this.buf.subarray(bodyStart + length);
      try {
        out.push(JSON.parse(body) as JsonRpcMessage);
      } catch {
        /* 坏 JSON 跳过 */
      }
    }
  }
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private framer = new LspFramer();
  private closed = false;
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private dirty = new Set<string>();
  private readonly timeoutMs: number;
  readonly stderrTail: string[] = [];

  constructor(private readonly opts: LspClientOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get alive(): boolean {
    return !this.closed && this.proc !== null && this.proc.exitCode === null;
  }

  /** 启动并握手。失败抛可读错误（调用方决定是否降级）。 */
  async start(): Promise<void> {
    if (this.proc) return;
    let proc: ChildProcessWithoutNullStreams;
    try {
      // 用 node:child_process 而不是 Bun.spawn：LSP 需要「小帧立即出门」，
      // node 的 Writable 语义确定（Bun 的 Subprocess stdin 是 FileSink，行为受缓冲影响）。
      proc = spawn(this.opts.command, this.opts.args ?? [], {
        cwd: this.opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      throw new Error(`无法启动 LSP server ${this.opts.name}（${this.opts.command}）：${(e as Error).message}`);
    }
    this.proc = proc;
    // node 的 spawn 对「命令不存在」是**异步 error 事件**而不是同步抛错：
    // 不挂监听会变成未捕获异常，挂上后转成可读错误（等待 initialize 的调用方会收到）。
    proc.on("error", (e) => {
      this.failAll(new Error(`无法启动 LSP server ${this.opts.name}（${this.opts.command}）：${e.message}`));
    });
    void this.readStdout();
    void this.readStderr();
    proc.on("exit", (code) => {
      this.failAll(new Error(`LSP server ${this.opts.name} 已退出（code ${code ?? "?"}）`));
    });
    try {
      await this.request("initialize", {
        processId: process.pid,
        rootUri: `file://${this.opts.cwd}`,
        capabilities: {
          textDocument: {
            publishDiagnostics: {},
            hover: {},
            definition: {},
            references: {},
            completion: {},
            callHierarchy: {},
          },
          workspace: { symbol: {}, configuration: true },
        },
      });
      this.notify("initialized", {});
    } catch (e) {
      this.close();
      throw e;
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.alive) return Promise.reject(new Error(`LSP server ${this.opts.name} 未连接`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP 请求 ${method} 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.alive) return;
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  diagnosticsFor(uri: string): LspDiagnostic[] | undefined {
    return this.diagnostics.get(uri);
  }

  /** didOpen/didChange 之后标记「在等这个文件的新诊断」。 */
  markDirty(uri: string): void {
    this.dirty.add(uri);
  }

  /** 等某个文件的新诊断；超时返回已有值（可能 null）。 */
  async waitDiagnostics(uri: string, timeoutMs = 1_500): Promise<LspDiagnostic[] | null> {
    // dirty = 「已同步但还没收到这个文件的 publishDiagnostics」；等到它被 publish 清掉再取，
    // 否则会把「server 还没回」误当成「没有诊断」。
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.dirty.has(uri)) return this.diagnostics.get(uri) ?? [];
      if (Date.now() >= deadline) {
        this.dirty.delete(uri);
        return this.diagnostics.get(uri) ?? null;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error(`LSP server ${this.opts.name} 已关闭`));
    const proc = this.proc;
    this.proc = null;
    try {
      proc?.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      proc?.kill();
    } catch {
      /* 已退出 */
    }
  }

  private write(msg: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || this.closed) return;
    try {
      stdin.write(encodeLspMessage(msg));
    } catch {
      /* 写失败由后续请求超时暴露 */
    }
  }

  private async readStdout(): Promise<void> {
    const stream = this.proc?.stdout;
    if (!stream) return;
    try {
      for await (const chunk of stream) {
        for (const msg of this.framer.push(Buffer.from(chunk))) this.onMessage(msg);
      }
    } catch {
      /* 进程被杀 */
    }
  }

  private async readStderr(): Promise<void> {
    const stream = this.proc?.stderr;
    if (!stream) return;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl === -1) break;
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (line === "") continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
          this.opts.onStderr?.(line);
        }
      }
    } catch {
      /* ignore */
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`LSP ${msg.error.code ?? ""}：${msg.error.message ?? "未知错误"}`));
      else p.resolve(msg.result);
      return;
    }
    // server→client 请求（有 id 也有 method）：必须应答，否则真实 server（pyright 等）会挂住。
    // 我们不提供任何配置/注册能力，回「空结果」即符合协议（workspace/configuration 要回等长数组）。
    if (msg.id !== undefined && msg.id !== null && msg.method !== undefined) {
      this.answerServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri?: string; diagnostics?: unknown[] } | undefined;
      const uri = params?.uri;
      if (!uri) return;
      this.diagnostics.set(uri, normalizeDiagnostics(params?.diagnostics));
      this.dirty.delete(uri);
    }
  }

  /** 应答 server→client 请求：只回形状正确的最小结果，不实现任何能力。 */
  private answerServerRequest(id: number | string, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = (params as { items?: unknown[] } | undefined)?.items;
      result = Array.isArray(items) ? items.map(() => null) : [];
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: `file://${this.opts.cwd}`, name: this.opts.name }];
    } else if (method === "client/registerCapability" || method === "client/unregisterCapability") {
      result = null;
    }
    // 其余（window/workDoneProgress/create、window/showMessageRequest 等）一律回 null：
    // 宁可让 server 拿到「没有值」，也不能让它等到超时。
    this.write({ jsonrpc: "2.0", id, result });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** LSP 诊断 → 紧凑结构（保留全部严重级别，展示时由调用方截断）。 */
export function normalizeDiagnostics(raw: unknown): LspDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const out: LspDiagnostic[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const d = item as Record<string, unknown>;
    const range = d["range"] as { start?: { line?: number; character?: number } } | undefined;
    const message = typeof d["message"] === "string" ? d["message"] : "";
    if (message === "") continue;
    out.push({
      line: typeof range?.start?.line === "number" ? range.start.line : 0,
      character: typeof range?.start?.character === "number" ? range.start.character : 0,
      severity: d["severity"] === 1 ? "error" : d["severity"] === 2 ? "warning" : d["severity"] === 3 ? "info" : "hint",
      message,
      source: typeof d["source"] === "string" ? d["source"] : undefined,
      code: (d["code"] as string | number | undefined) ?? undefined,
    });
  }
  return out;
}
