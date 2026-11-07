/**
 * 最小 JSON-RPC 2.0 over stdio 客户端（issue #2）。
 *
 * 为什么自写而不引官方 SDK：MCP 的 stdio 传输就是「一行一个 JSON 对象」，
 * 我们只需要 initialize / tools/list / tools/call 三个方法。官方 SDK 会带来
 * 一棵依赖树和它自己的传输/重连策略，而 neo 要的是「连不上就报一句人话」。
 * 自写后整个客户端零依赖、可被测试直接驱动，失败路径也全在掌控中。
 *
 * 协议要点（MCP 2024-11-05）：
 *  - 请求：{jsonrpc:"2.0", id, method, params}，响应按 id 配对（可能乱序）；
 *  - 通知：无 id，不需要响应（如 notifications/initialized）；
 *  - 服务端也可能发请求（sampling/roots），本客户端一律回 -32601 不支持，
 *    不静默丢弃 —— 否则对方会一直等。
 */
import type { Subprocess } from "bun";

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly code: number;
  constructor(err: JsonRpcError) {
    super(err.message);
    this.name = "RpcError";
    this.code = err.code;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface StdioRpcOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** 单次请求超时（毫秒）。默认 20s：npx 冷启动拉包可能慢，但不会无限等。 */
  requestTimeoutMs?: number;
  /** 子进程 stderr 的一行（排障用，调用方决定是否展示）。 */
  onStderr?: (line: string) => void;
}

/** 单行 JSON 解析上限：防止某个 server 吐出一行 500MB 把内存打爆。 */
const MAX_LINE = 8 * 1024 * 1024;

/**
 * 一个 stdio JSON-RPC 连接。
 *
 * 生命周期：start() → request()* → close()。任何一侧断开都会让**所有**在途请求
 * 立刻 reject（而不是等到超时），这样工具调用能马上给模型一句「连接已断开」。
 */
export class StdioRpc {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private closed = false;
  /** 最近若干行 stderr，连接失败时拼进错误信息（npx 的报错都在这里）。 */
  readonly stderrTail: string[] = [];

  constructor(private readonly opts: StdioRpcOptions) {}

  get alive(): boolean {
    return !this.closed && this.proc !== null;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  /** 启动子进程。同步返回；命令不存在时抛错（由调用方转成可读错误）。 */
  start(): void {
    if (this.proc) return;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, this.opts.env);

    try {
      this.proc = Bun.spawn([this.opts.command, ...this.opts.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
        cwd: this.opts.cwd,
      });
    } catch (e) {
      // Bun.spawn 对不存在的可执行文件抛 ENOENT —— 这正是「坏命令」路径。
      throw new Error(`无法启动 ${this.opts.command}：${(e as Error).message}`);
    }

    void this.readStdout();
    void this.readStderr();
    void this.proc.exited.then((code) => {
      // 进程退出 = 连接死亡。在途请求立即失败，别让工具调用干等到超时。
      this.failAll(
        new Error(
          `MCP 服务进程已退出（code ${code}）` +
            (this.stderrTail.length > 0 ? `：${this.stderrTail[this.stderrTail.length - 1]}` : ""),
        ),
      );
    });
  }

  private async readStdout(): Promise<void> {
    const stream = this.proc?.stdout;
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        this.buf += decoder.decode(chunk, { stream: true });
        if (this.buf.length > MAX_LINE) {
          // 单行超限：丢弃缓冲并让连接失败，避免无界增长。
          this.buf = "";
          this.failAll(new Error("MCP 服务输出超过单行上限，连接已放弃"));
          this.close();
          return;
        }
        let nl = this.buf.indexOf("\n");
        while (nl !== -1) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line !== "") this.handleLine(line);
          nl = this.buf.indexOf("\n");
        }
      }
    } catch {
      /* 流关闭/进程被杀：交给 exited 处理 */
    }
  }

  private async readStderr(): Promise<void> {
    const stream = this.proc?.stderr;
    if (!stream || typeof stream === "number") return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          this.stderrTail.push(t);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
          this.opts.onStderr?.(t);
        }
      }
    } catch {
      /* 同上 */
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // 有些 server 会往 stdout 打日志 —— 不能因此崩，记进 stderr 尾巴排障。
      this.stderrTail.push(`[stdout 非 JSON] ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;

    // 响应：有 id 且无 method
    if (m["method"] === undefined && m["id"] !== undefined) {
      const id = Number(m["id"]);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      const err = m["error"];
      if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        p.reject(
          new RpcError({
            code: Number(e["code"] ?? -32603),
            message: String(e["message"] ?? "未知错误"),
            data: e["data"],
          }),
        );
      } else {
        p.resolve(m["result"]);
      }
      return;
    }

    // 服务端发来的请求：明确回「不支持」，不静默丢弃。
    if (typeof m["method"] === "string" && m["id"] !== undefined) {
      this.write({
        jsonrpc: "2.0",
        id: m["id"],
        error: { code: -32601, message: `neo 不支持 ${String(m["method"])}` },
      });
    }
    // 通知（无 id）忽略。
  }

  private write(obj: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || typeof stdin === "number" || this.closed) return;
    try {
      stdin.write(`${JSON.stringify(obj)}\n`);
      stdin.flush();
    } catch {
      /* 写失败由 exited 兜底 */
    }
  }

  /** 发一个请求并等待响应。 */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.alive) return Promise.reject(new Error("MCP 连接已关闭"));
    const id = this.nextId++;
    const timeoutMs = this.opts.requestTimeoutMs ?? 20_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  /** 发通知（无响应）。 */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** 关闭：先关 stdin（多数 server 见此退出），再兜底 kill。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("MCP 连接已关闭"));
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      /* 已关闭 */
    }
    try {
      proc.kill();
    } catch {
      /* 已退出 */
    }
  }
}
