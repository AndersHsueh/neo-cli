/**
 * issue #60 复审（R1–R9）规格红测。
 *
 * 来源：/workspace/neo-cli-acp-60-review.md 的阻断发现 + 独立探针
 * （/workspace/acp-60-independent-review/ 的 probe.py / supplemental.py / cwd-policy.py）。
 *
 * 形态：与 tests/acp-protocol.test.ts 同口径 —— 管道级假客户端（真起 `bun src/index.ts acp`）、
 * 本地假 SSE 端点（Bun.serve port 0）、沙箱 settings / 目录；不触网、不读真实 settings。
 * 夹具从 acp-protocol.test.ts 复制最小子集（不 import 未公开 helper，也不改它的 A1–E1）。
 *
 * 本文件**只写规格**：每条测试描述「协议应有的行为」，在 HEAD d33fdfe 上应失败。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-acp-rereview-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;


afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 沙箱 settings / 目录
 * ------------------------------------------------------------------ */

function writeSettings(dir: string, baseUrl = "http://127.0.0.1:9/v1", apiKey = "test"): void {
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      {
        default_provider: "fake",
        default_model_tier: "default",
        classifier_provider: "fake",
        classifier_model_name: "fake-model",
        providers: [
          {
            provider_name: "fake",
            provider_type: "openai",
            base_url: baseUrl,
            api_key: apiKey,
            default_model_name: "fake-model",
            deep_reasoning_model_name: "fake-model",
            balanced_model_name: "fake-model",
            fast_model_name: "fake-model",
            max_tokens: 64,
            temperature: 0,
            context_window: 100_000,
          },
        ],
        retry: {
          max_attempts: 1,
          base_delay_ms: 1,
          connect_timeout_ms: 1_000,
          stream_idle_timeout_ms: 1_000,
        },
        memory: { enabled: false },
        // 环境探测会写用户级 wiki 页；测试里关掉，避免无关副作用。
        env: { enabled: false },
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** 改沙箱 settings 的某个顶层键（permission_mode / max_tool_iterations / mcpServers …）。 */
function patchSettings(dir: string, patch: Record<string, unknown>): void {
  const path = join(dir, "settings.json");
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2), "utf8");
}

function project(baseUrl?: string, apiKey?: string): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir, baseUrl, apiKey);
  return dir;
}

function workspace(): string {
  const dir = join(SANDBOX, `ws${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function childEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEO_SESSIONS_DIR: sessionsDir,
    NEO_MAILBOX_DIR: join(SANDBOX, "mailbox"),
    NEO_MEMORY_DIR: join(SANDBOX, "memory"),
    NEO_USER_WIKI_DIR: join(SANDBOX, "wiki"),
    NEO_MEMORY_JOURNAL_DIR: join(SANDBOX, "journal"),
    NEO_MEMORY_DISABLE: "1",
    ...overrides,
  };
  for (const key of ["NEO_API_KEY", "NEO_BASE_URL", "NEO_PROVIDER", "NEO_MODEL", "NEO_TIER"]) {
    delete env[key];
  }
  return env;
}

/** pid 是否还活着（进程已退出 / 不存在 → false）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** finally 兜底：杀掉测试里记下的残留 pid。 */
function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

/** 从 pid 文件读进程号；文件不存在/内容非法 → null。 */
function readPid(file: string): number | null {
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 轮询等文件出现（超时返回 false）。 */
async function waitForFile(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return existsSync(file);
}

/**
 * 最小 stdio MCP server 源码（N3/R5 共用）。
 *
 * 逐行读 JSON-RPC：initialize / tools/list 正常回，通知不回；
 * 启动时把 pid 写进 `marker`；`setInterval` 保活并**忽略 stdin 关闭** ——
 * 否则父进程一死它自己就退，测不出 dispose 有没有真的回收子进程。
 */
function minimalMcpSource(marker: string, opts: { answerHandshake: boolean }): string {
  return (
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n` +
    `const answer = ${opts.answerHandshake ? "true" : "false"};\n` +
    `setInterval(() => {}, 1 << 30);\n` +
    `process.stdin.on("error", () => {});\n` +
    `process.stdin.on("end", () => {});\n` +
    `let buf = "";\n` +
    `process.stdin.on("data", (chunk) => {\n` +
    `  buf += String(chunk);\n` +
    `  for (;;) {\n` +
    `    const nl = buf.indexOf("\\n");\n` +
    `    if (nl === -1) break;\n` +
    `    const line = buf.slice(0, nl).trim();\n` +
    `    buf = buf.slice(nl + 1);\n` +
    `    if (line === "") continue;\n` +
    `    let msg;\n` +
    `    try { msg = JSON.parse(line); } catch { continue; }\n` +
    `    if (msg.method === undefined || msg.id === undefined) continue;\n` +
    `    if (!answer) continue;\n` +
    `    if (msg.method === "initialize") {\n` +
    `      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "p", version: "0" } } }) + "\\n");\n` +
    `    } else if (msg.method === "tools/list") {\n` +
    `      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\\n");\n` +
    `    }\n` +
    `  }\n` +
    `});\n` +
    `process.stdin.resume();\n`
  );
}

/** Bun.spawn 的 pid 是启动器；超时清理必须连它的直接子进程一起打。 */
function killSpawnedBun(proc: Bun.Subprocess): void {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(out.stdout);
  const kids: number[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isFinite(pid) && ppid === proc.pid) kids.push(pid);
  }
  for (const pid of [...kids, proc.pid]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * JSON-RPC 夹具
 * ------------------------------------------------------------------ */

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

function errorCode(resp: JsonRpcMessage | null | undefined): number {
  const err = resp?.error as { code?: unknown } | undefined;
  return typeof err?.code === "number" ? err.code : Number.NaN;
}

function sessionIdOf(resp: JsonRpcMessage | null | undefined): string | null {
  const result = resp?.result as { sessionId?: unknown } | undefined;
  return typeof result?.sessionId === "string" && result.sessionId !== "" ? result.sessionId : null;
}

function stopReasonOf(resp: JsonRpcMessage | null | undefined): unknown {
  return (resp?.result as { stopReason?: unknown } | undefined)?.stopReason;
}

function initializeRequest(id: number, protocolVersion = 1): string {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "neo-acp-rereview-client", title: "neo acp rereview client", version: "0.0.0" },
      },
    }) + "\n"
  );
}

function newSessionRequest(id: number, cwd: string, mcpServers: unknown[] = []): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers } }) + "\n";
}

function promptBlocksRequest(id: number, sessionId: string, prompt: unknown[]): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt } }) + "\n";
}

function promptRequest(id: number, sessionId: string, text: string): string {
  return promptBlocksRequest(id, sessionId, [{ type: "text", text }]);
}

function cancelNotification(sessionId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }) + "\n";
}

function jsonRpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
}

/** 权限响应：按 kind 挑 optionId（不硬编码实现自定的 id）。 */
function permissionResponse(id: unknown, params: unknown, kind: "allow_once" | "reject_once"): string {
  const options =
    (params as { options?: Array<{ optionId?: unknown; kind?: unknown }> } | undefined)?.options ?? [];
  const picked = options.find((o) => o.kind === kind) ?? options[0];
  const optionId = typeof picked?.optionId === "string" ? picked.optionId : kind;
  return jsonRpcResult(id, { outcome: { outcome: "selected", optionId } });
}

/* ------------------------------------------------------------------ *
 * 假 LLM 端点
 * ------------------------------------------------------------------ */

interface FakeLlm {
  baseUrl: string;
  hits: () => number;
  stop: () => void;
}

function sseToolCallFrames(callId: string, name: string, args: unknown): string {
  return (
    `data: ${JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: "" } }] }, finish_reason: null },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    "data: [DONE]\n\n"
  );
}

function sseTextFrames(text: string, finishReason = "stop"): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } })}\n\n` +
    "data: [DONE]\n\n"
  );
}

/**
 * 起本地假 OpenAI 端点。`script` 按「第 N 次 chat/completions」回放，用尽后回 fallback。
 * 完成条件判定器（#50/#51）是独立小请求，单独回 not done，不吃脚本。
 */
function fakeLlm(script: string[], fallback = sseTextFrames("完成"), delayMs = 0): FakeLlm {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "fake-model" }] });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json().catch(() => ({}))) as { messages?: unknown };
        if (JSON.stringify(body.messages ?? []).includes("完成条件判定器")) {
          return new Response(sseTextFrames('{"done": false, "reason": "还没好"}'), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        const frame = script[hits] ?? fallback;
        hits += 1;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        return new Response(frame, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    hits: () => hits,
    stop: () => server.stop(true),
  };
}

/* ------------------------------------------------------------------ *
 * 管道级假客户端（可编程）
 * ------------------------------------------------------------------ */

interface ClientState {
  sessionId: string | null;
  serverRequests: string[];
  updates: string[];
  sentPrompt: boolean;
  sentCancel: boolean;
}

interface ClientOptions {
  /** session/new 的 cwd（默认 = spawn 目录）。 */
  cwd?: string;
  /** session/new 的 mcpServers（默认空数组）。 */
  mcpServers?: unknown[];
  /** 收到 session/new 响应后发的 prompt 块（不发则只建会话）。 */
  promptBlocks?: unknown[];
  /** 服务端请求（带 id 的 inbound request）的默认策略。 */
  policy?: "allow" | "reject" | "error" | "ignore";
  /** 逐条消息回调：可自行回应服务端请求 / 追加写 stdin / 关 stdin。 */
  onMessage?: (msg: JsonRpcMessage, state: ClientState, api: ClientApi) => void | Promise<void>;
  timeoutMs?: number;
}

interface ClientApi {
  write: (line: string) => void;
  closeStdin: () => Promise<void>;
  /** 已收到的全部 stdout 文本（实时）。 */
  out: () => string;
  /** 已收到的全部 stderr 文本（实时）。 */
  err: () => string;
  /** 进程退出码；未退出为 null。 */
  exitCode: () => number | null;
}

interface ClientRun {
  out: string;
  err: string;
  code: () => number;
  timedOut: () => boolean;
  state: ClientState;
  messages: JsonRpcMessage[];
  /** 等到 stdout 出现满足条件的消息（含已经到达的；超时返回 null）。 */
  waitFor: (pred: (msg: JsonRpcMessage) => boolean, ms: number) => Promise<JsonRpcMessage | null>;
  /** 往进程 stdin 写一条原始协议行。 */
  write: (line: string) => void;
  closeStdin: () => Promise<void>;
  /** 进程是否已退出。 */
  exited: () => boolean;
  kill: () => void;
}

/**
 * 起一个 acp 子进程，按行读 stdout，把每条消息交给 onMessage。
 * 超时一律 killSpawnedBun（红态下不挂死）。
 */
async function runClient(cwd: string, opts: ClientOptions = {}): Promise<ClientRun> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const policy = opts.policy ?? "allow";
  const proc = Bun.spawn(["bun", INDEX, "acp"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  const decoder = new TextDecoder();
  const state: ClientState = {
    sessionId: null,
    serverRequests: [],
    updates: [],
    sentPrompt: false,
    sentCancel: false,
  };
  let out = "";
  let err = "";
  let timedOut = false;
  let buf = "";
  let exitCode: number | null = null;
  const messages: JsonRpcMessage[] = [];
  const waiters: Array<{ pred: (m: JsonRpcMessage) => boolean; resolve: (m: JsonRpcMessage) => void }> = [];

  const errReader = (async () => {
    for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
      err += decoder.decode(chunk, { stream: true });
    }
  })();

  const timer = setTimeout(() => {
    timedOut = true;
    killSpawnedBun(proc);
  }, timeoutMs);

  const write = (line: string): void => {
    try {
      proc.stdin.write(line);
      proc.stdin.flush();
    } catch {
      /* 子进程可能已退出 */
    }
  };

  let stdinClosed = false;
  const closeStdin = async (): Promise<void> => {
    if (stdinClosed) return;
    stdinClosed = true;
    try {
      await proc.stdin.end();
    } catch {
      /* 已退出 */
    }
  };

  const api: ClientApi = {
    write,
    closeStdin,
    out: () => out,
    err: () => err,
    exitCode: () => exitCode,
  };

  const loop = (async () => {
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      out += text;
      buf += text;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "") continue;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch {
          continue;
        }
        messages.push(msg);

        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (w.pred(msg)) {
            waiters.splice(i, 1);
            w.resolve(msg);
          }
        }

        // 服务端 → 客户端的请求：默认按 policy 回应（onMessage 可覆盖）。
        if (typeof msg.method === "string" && msg.id !== undefined) {
          state.serverRequests.push(msg.method);
          if (policy === "allow") {
            if (msg.method === "session/request_permission") {
              write(permissionResponse(msg.id, msg.params, "allow_once"));
            } else {
              write(jsonRpcError(msg.id, -32601, `测试客户端不实现 ${msg.method}`));
            }
          } else if (policy === "reject") {
            if (msg.method === "session/request_permission") {
              write(permissionResponse(msg.id, msg.params, "reject_once"));
            } else {
              write(jsonRpcError(msg.id, -32601, `测试客户端不实现 ${msg.method}`));
            }
          } else if (policy === "error") {
            write(jsonRpcError(msg.id, -32603, "测试客户端不实现权限请求"));
          }
        }

        if (msg.method === "session/update" && msg.id === undefined) {
          const kind = (msg.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update?.sessionUpdate;
          if (typeof kind === "string") state.updates.push(kind);
        }

        if (msg.id === 1 && msg.result !== undefined) {
          write(newSessionRequest(2, opts.cwd ?? cwd, opts.mcpServers ?? []));
        }
        if (msg.id === 2) {
          const sid = sessionIdOf(msg);
          if (sid !== null) {
            state.sessionId = sid;
            if (opts.promptBlocks !== undefined && !state.sentPrompt) {
              state.sentPrompt = true;
              write(promptBlocksRequest(3, sid, opts.promptBlocks));
            }
          } else if (opts.promptBlocks === undefined) {
            await closeStdin();
          }
        }

        await opts.onMessage?.(msg, state, api);
      }
    }
    await errReader;
    exitCode = await proc.exited;
  })();

  const waitFor = (pred: (msg: JsonRpcMessage) => boolean, ms: number): Promise<JsonRpcMessage | null> =>
    new Promise((resolve) => {
      const existing = messages.find(pred);
      if (existing) {
        resolve(existing);
        return;
      }
      const t = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === wrapped);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, ms);
      const wrapped = (m: JsonRpcMessage): void => {
        clearTimeout(t);
        resolve(m);
      };
      waiters.push({ pred, resolve: wrapped });
    });

  void loop.catch(() => undefined);
  write(initializeRequest(1));
  // 先等到 session/new 有结果，再把控制权交回测试；stdout 循环继续在后台跑。
  await waitFor((m) => m.id === 2, 8_000);

  return {
    get out() { return out; },
    get err() { return err; },
    code: () => exitCode ?? -1,
    timedOut: () => timedOut,
    state,
    messages,
    waitFor,
    write,
    closeStdin,
    exited: () => exitCode !== null || proc.exitCode !== null,
    kill: () => {
      clearTimeout(timer);
      killSpawnedBun(proc);
    },
  };
}

/* ================================================================== *
 * R1 队头阻塞：请求后面的权限响应与 cancel 必须立刻可达
 * ================================================================== */

describe("R1 入站队头阻塞", () => {
  test("R1 重叠请求不得挡住其后的 cancel 与权限响应（原 prompt 1s 内返回）", async () => {
    const ws = workspace();
    const target = join(ws, "r1-blocked.txt");
    const llm = fakeLlm([sseToolCallFrames("call-r1", "write_file", { path: target, content: "不该写入\n" })]);
    try {
      const dir = project(llm.baseUrl);
      let permissionSeen: JsonRpcMessage | null = null;
      const r = await runClient(dir, {
        cwd: ws,
        policy: "ignore", // 权限请求先不回应：模拟编辑器还在等用户点
        promptBlocks: [{ type: "text", text: "写文件" }],
        onMessage: (msg, state, api) => {
          if (msg.method !== "session/request_permission" || msg.id === undefined) return;
          if (permissionSeen !== null) return;
          permissionSeen = msg;
          // 按原始字节到达顺序：第二个 prompt → cancel → 权限响应
          api.write(promptRequest(4, state.sessionId as string, "第二个请求"));
          api.write(cancelNotification(state.sessionId as string));
          api.write(permissionResponse(msg.id, msg.params, "allow_once"));
        },
      });
      // 等权限请求真正到达（runClient 在 session/new 完成后即返回，此时模型可能还没回 tool_calls）。
      await r.waitFor((m) => m.method === "session/request_permission", 5_000);
      expect(permissionSeen).not.toBeNull();

      // 原 prompt（id=3）应在约 1s 内以 cancel 路径返回 —— 当前实现会死锁。
      const first = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 1_500);
      r.kill();
      expect(first).not.toBeNull();
      expect(stopReasonOf(first as JsonRpcMessage)).toBe("cancelled");
      // 被取消的那次写盘不得发生。
      expect(existsSync(target)).toBe(false);
    } finally {
      llm.stop();
    }
  }, 40_000);
});

/* ================================================================== *
 * R2 cancel 污染下一轮
 * ================================================================== */

describe("R2 cancel 只作用于当前轮", () => {
  test("R2 取消一轮后，同 session 的下一轮应正常走权限并 end_turn", async () => {
    const ws = workspace();
    const first = join(ws, "r2-first.txt");
    const second = join(ws, "r2-second.txt");
    const llm = fakeLlm([
      sseToolCallFrames("call-r2a", "write_file", { path: first, content: "第一轮\n" }),
      sseToolCallFrames("call-r2b", "write_file", { path: second, content: "第二轮\n" }),
    ]);
    try {
      const dir = project(llm.baseUrl);
      let phase = 0;
      let secondPermission: JsonRpcMessage | null = null;
      const r = await runClient(dir, {
        cwd: ws,
        policy: "ignore",
        promptBlocks: [{ type: "text", text: "第一轮" }],
        onMessage: (msg, state, api) => {
          if (msg.method === "session/request_permission" && msg.id !== undefined) {
            if (phase === 0) {
              phase = 1;
              // 第一轮：cancel + 按官方规范回权限 cancelled
              api.write(cancelNotification(state.sessionId as string));
              api.write(jsonRpcResult(msg.id, { outcome: { outcome: "cancelled" } }));
              return;
            }
            if (phase === 1) {
              phase = 2;
              secondPermission = msg;
              api.write(permissionResponse(msg.id, msg.params, "allow_once"));
            }
            return;
          }
          // 第二轮 prompt 由测试在第一轮 cancelled 之后显式发出，避免与 waitFor 竞态重复发送。
        },
      });

      const firstResp = await r.waitFor((m) => m.id === 3 && m.result !== undefined, 5_000);
      expect(stopReasonOf(firstResp as JsonRpcMessage)).toBe("cancelled");

      // 下一轮由测试显式发出（不依赖 onMessage 与 waitFor 的时序）：这才是「取消后再聊」。
      if (!r.state.sessionId) throw new Error("session/new 未返回 sessionId");
      r.write(promptRequest(4, r.state.sessionId, "第二轮"));
      const secondResp = await r.waitFor((m) => m.id === 4 && (m.result !== undefined || m.error !== undefined), 5_000);
      r.kill();
      // 第二轮必须真的弹权限（当前实现直接 cancelled，连权限都不问）。
      expect(secondPermission).not.toBeNull();
      expect(secondResp).not.toBeNull();
      expect(stopReasonOf(secondResp as JsonRpcMessage)).not.toBe("cancelled");
      // 允许后文件应写出。
      expect(existsSync(second)).toBe(true);
    } finally {
      llm.stop();
    }
  }, 40_000);
});

/* ================================================================== *
 * R3 原始 stdin EOF
 * ================================================================== */

describe("R3 stdin EOF 必须停止在途工作", () => {
  test("R3a EOF 后在途 shell 不得继续写盘，进程应退出", async () => {
    const ws = workspace();
    const started = join(ws, "started");
    const afterEof = join(ws, "after-eof");
    const llm = fakeLlm([
      sseToolCallFrames("call-r3a", "shell", {
        command: "printf started > started; sleep 0.7; printf after-eof > after-eof",
      }),
    ]);
    try {
      const dir = project(llm.baseUrl);
      patchSettings(dir, { permission_mode: "auto-all" });
      let closed = false;
      const r = await runClient(dir, {
        cwd: ws,
        promptBlocks: [{ type: "text", text: "跑个命令" }],
        onMessage: async (_msg, _state, api) => {
          if (closed) return;
          if (!existsSync(started)) return;
          closed = true;
          await api.closeStdin();
        },
      });
      // 等工具真的启动后再关 stdin（onMessage 里可能已关；这里兜底轮询）。
      for (let i = 0; i < 200 && !existsSync(started); i++) {
        await new Promise((res) => setTimeout(res, 20));
      }
      if (!closed) {
        closed = true;
        await r.closeStdin();
      }
      await new Promise((res) => setTimeout(res, 1_200));
      const stillRunning = !r.exited();
      r.kill();
      // 宿主已断连：不该再有工具写盘。
      expect(existsSync(afterEof)).toBe(false);
      // 进程应结束（当前实现会活到工具跑完、正常 end_turn）。
      expect(stillRunning).toBe(false);
    } finally {
      llm.stop();
    }
  }, 40_000);

  test("R3b 卡在权限请求时 EOF：进程退出、不写盘、子进程已回收", async () => {
    const ws = workspace();
    const pidFile = join(ws, "r3b.pid");
    const bgAfterEof = join(ws, "r3b-bg-after-eof");
    const never = join(ws, "never.txt");
    // 第 1 轮：后台 shell（auto-edit 下 shell 仍要确认 → 用 ask + 首个权限请求回 allow）。
    // 第 2 轮：write_file 卡在权限请求不回应，此时 EOF。
    const llm = fakeLlm([
      sseToolCallFrames("call-r3b-bg", "shell", {
        command: `printf $$ > ${JSON.stringify(pidFile)}; sleep 1.5; printf x > ${JSON.stringify(bgAfterEof)}`,
        background: true,
      }),
      sseToolCallFrames("call-r3b-w", "write_file", { path: never, content: "x" }),
    ]);
    let bgPid: number | null = null;
    try {
      const dir = project(llm.baseUrl);
      let closed = false;
      let allowedFirst = false;
      const r = await runClient(dir, {
        cwd: ws,
        policy: "ignore", // 默认不回应；下面只放行第一个（shell）
        promptBlocks: [{ type: "text", text: "先起后台命令，再写文件" }],
        onMessage: async (msg, _state, api) => {
          if (msg.method !== "session/request_permission" || msg.id === undefined) return;
          if (!allowedFirst) {
            // 第一个权限请求 = shell：批准，让后台命令真的跑起来。
            allowedFirst = true;
            api.write(permissionResponse(msg.id, msg.params, "allow_once"));
            return;
          }
          // 第二个 = write_file：不回应；等后台 shell 真的跑起来（pid 落盘）再 EOF，
          // 否则 EOF 可能抢在 bash 写 pid 之前，「子进程已回收」就无从断言。
          if (closed) return;
          closed = true;
          await waitForFile(pidFile, 3_000);
          await api.closeStdin();
        },
      });
      // 等后台 shell 真的启动（pid 落盘）。
      await waitForFile(pidFile, 6_000);
      // 再等第二个权限请求（write_file）到达。
      const perm = await r.waitFor((m) => m.method === "session/request_permission", 8_000);
      expect(perm).not.toBeNull();
      if (!closed) {
        closed = true;
        await r.closeStdin();
      }
      const settled = await r.waitFor(
        (m) => m.id === 3 && (m.result !== undefined || m.error !== undefined),
        1_200,
      );
      await new Promise((res) => setTimeout(res, 200));
      const stillRunning = !r.exited();
      // 保留原有断言：约 1s 内应有终态（退出或 prompt 有响应）。
      expect(settled !== null || !stillRunning).toBe(true);
      // 加强：进程必须真的退出。
      expect(stillRunning).toBe(false);
      // 加强：卡在权限的写盘不得发生。
      expect(existsSync(never)).toBe(false);
      // 加强：后台 shell 不得在 EOF 后继续写盘，且进程已被回收。
      await new Promise((res) => setTimeout(res, 2_500));
      bgPid = readPid(pidFile);
      r.kill();
      expect(existsSync(bgAfterEof)).toBe(false);
      expect(bgPid).not.toBeNull();
      expect(isAlive(bgPid as number)).toBe(false);
    } finally {
      llm.stop();
      if (bgPid !== null) killPid(bgPid);
    }
  }, 40_000);
});

/* ================================================================== *
 * R4 session cwd 决定配置与权限
 * ================================================================== */

describe("R4 session cwd 决定配置与权限", () => {
  test("R4a 模型配置应来自 session cwd，而不是 spawn 目录", async () => {
    const spawnLlm = fakeLlm([sseTextFrames("SPAWN_CONFIG")]);
    const wsLlm = fakeLlm([sseTextFrames("WORKSPACE_CONFIG")]);
    try {
      const dir = project(spawnLlm.baseUrl);
      const ws = workspace();
      writeSettings(ws, wsLlm.baseUrl);
      patchSettings(ws, { permission_mode: "plan" });

      const r = await runClient(dir, {
        cwd: ws,
        promptBlocks: [{ type: "text", text: "hi" }],
      });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 8_000);
      r.kill();
      expect(resp).not.toBeNull();
      // 请求必须打到工作区的 provider（B），不是 spawn 目录的（A）。
      expect(wsLlm.hits()).toBeGreaterThan(0);
      expect(spawnLlm.hits()).toBe(0);
    } finally {
      spawnLlm.stop();
      wsLlm.stop();
    }
  }, 40_000);

  test("R4b 权限模式应来自 session cwd（plan 下不得写盘）", async () => {
    const ws = workspace();
    const target = join(ws, "r4b-plan.txt");
    const llm = fakeLlm([sseToolCallFrames("call-r4b", "write_file", { path: "r4b-plan.txt", content: "不该写入\n" })]);
    try {
      const dir = project(llm.baseUrl);
      patchSettings(dir, { permission_mode: "auto-all" }); // spawn 目录：auto-all
      writeSettings(ws, llm.baseUrl);
      patchSettings(ws, { permission_mode: "plan" }); // 工作区：plan

      const r = await runClient(dir, {
        cwd: ws,
        promptBlocks: [{ type: "text", text: "写文件" }],
      });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 8_000);
      r.kill();
      expect(resp).not.toBeNull();
      // plan 下工作区文件不得被写出（当前实现继承了 spawn 目录的 auto-all）。
      expect(existsSync(target)).toBe(false);
    } finally {
      llm.stop();
    }
  }, 40_000);

  test("R4c 工作区无 settings 时，模型配置与权限模式回退到同一份启动目录 settings", async () => {
    // 复现 Leo 正控 relative-overwrite-edit：auto-all 写在 spawn 目录，session cwd 无 settings。
    // 模型配置已回退到 spawn 目录；权限模式必须读同一份文件，不得单独落回 ask。
    const ws = workspace();
    const target = join(ws, "target.txt");
    writeFileSync(target, "old text\n", "utf8");
    const llm = fakeLlm([
      sseToolCallFrames("call-r4c-w", "write_file", { path: "target.txt", content: "new text\n" }),
      sseToolCallFrames("call-r4c-e", "edit_file", { path: "target.txt", old_string: "new", new_string: "edited" }),
    ]);
    try {
      const dir = project(llm.baseUrl);
      patchSettings(dir, { permission_mode: "auto-all" });
      const r = await runClient(dir, {
        cwd: ws,
        policy: "ignore", // 不应答权限：auto-all 下本就不该问
        promptBlocks: [{ type: "text", text: "改文件" }],
      });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 6_000);
      r.kill();
      expect(r.state.serverRequests.filter((m) => m === "session/request_permission")).toEqual([]);
      expect(stopReasonOf(resp)).toBe("end_turn");
      expect(readFileSync(target, "utf8")).toBe("edited text\n");
      expect(existsSync(join(dir, "target.txt"))).toBe(false);
      const diffPaths = r.messages
        .filter((m) => m.method === "session/update")
        .flatMap((m) => ((m.params as { update?: { content?: unknown[] } }).update?.content ?? []) as { type?: string; path?: string }[])
        .filter((c) => c.type === "diff")
        .map((c) => c.path);
      expect(diffPaths).toEqual([target, target]);
    } finally {
      llm.stop();
    }
  }, 40_000);
});

/* ================================================================== *
 * R5 MCP 装配
 * ================================================================== */

describe("R5 MCP 装配", () => {
  test("R5a settings.mcpServers 的 stdio server 应在 session/new 后被拉起，且 EOF 后回收", async () => {
    const ws = workspace();
    const marker = join(ws, "mcp-started.marker");
    const fakeMcp = join(ws, "fake-mcp.ts");
    writeFileSync(fakeMcp, minimalMcpSource(marker, { answerHandshake: true }), "utf8");
    const llm = fakeLlm([sseTextFrames("ok")]);
    let mcpPid: number | null = null;
    try {
      const dir = project(llm.baseUrl);
      patchSettings(dir, {
        mcpServers: { localprobe: { command: process.execPath, args: [fakeMcp] } },
      });
      const r = await runClient(dir, { cwd: ws });
      const newResp = await r.waitFor((m) => m.id === 2 && (m.result !== undefined || m.error !== undefined), 8_000);
      expect(sessionIdOf(newResp)).not.toBeNull();
      // 等 MCP 子进程真的起来（握手 + 拉起）。
      const started = await waitForFile(marker, 8_000);
      mcpPid = readPid(marker);
      expect(started).toBe(true);
      expect(mcpPid).not.toBeNull();
      // EOF：dispose 必须回收 MCP 子进程（它忽略 stdin 关闭，只能靠 kill）。
      await r.closeStdin();
      for (let i = 0; i < 250 && !r.exited(); i++) await new Promise((res) => setTimeout(res, 20));
      await new Promise((res) => setTimeout(res, 500));
      r.kill();
      expect(isAlive(mcpPid as number)).toBe(false);
    } finally {
      llm.stop();
      if (mcpPid !== null) killPid(mcpPid);
    }
  }, 40_000);

  test("R5b 客户端 session/new 传入的 stdio mcpServers 应被接入，且 EOF 后回收", async () => {
    const ws = workspace();
    const marker = join(ws, "client-mcp.marker");
    const fakeMcp = join(ws, "fake-client-mcp.ts");
    writeFileSync(fakeMcp, minimalMcpSource(marker, { answerHandshake: true }), "utf8");
    const llm = fakeLlm([sseTextFrames("ok")]);
    let mcpPid: number | null = null;
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, {
        cwd: ws,
        mcpServers: [{
          name: "clientprobe",
          command: process.execPath,
          args: [fakeMcp],
          env: [{ name: "ACP_MCP_SECRET", value: "s3cr3t-acp-mcp-token" }],
        }],
      });
      const newResp = await r.waitFor((m) => m.id === 2 && (m.result !== undefined || m.error !== undefined), 8_000);
      expect(sessionIdOf(newResp)).not.toBeNull();
      const started = await waitForFile(marker, 8_000);
      mcpPid = readPid(marker);
      expect(started).toBe(true);
      expect(mcpPid).not.toBeNull();
      await r.closeStdin();
      for (let i = 0; i < 250 && !r.exited(); i++) await new Promise((res) => setTimeout(res, 20));
      await new Promise((res) => setTimeout(res, 500));
      const err = r.err;
      r.kill();
      // 不得把 MCP env/header 值写进诊断。
      expect(err.includes("s3cr3t-acp-mcp-token")).toBe(false);
      expect(isAlive(mcpPid as number)).toBe(false);
    } finally {
      llm.stop();
      if (mcpPid !== null) killPid(mcpPid);
    }
  }, 40_000);
});

/* ================================================================== *
 * R6 resource_link 是 v1 必选
 * ================================================================== */

describe("R6 resource_link 内容块", () => {
  test("R6 合法 resource_link 不得回 -32602", async () => {
    const ws = workspace();
    const inputFile = join(ws, "input.txt");
    writeFileSync(inputFile, "resource link 内容\n", "utf8");
    const llm = fakeLlm([sseTextFrames("收到资源链接")]);
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, {
        cwd: ws,
        promptBlocks: [{ type: "resource_link", uri: `file://${inputFile}`, name: "input.txt" }],
      });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 8_000);
      r.kill();
      expect(resp).not.toBeNull();
      expect(errorCode(resp)).not.toBe(-32602);
      // 要么进了模型调用，要么至少以合法 prompt 结果结束。
      const ok = llm.hits() > 0 || stopReasonOf(resp) !== undefined;
      expect(ok).toBe(true);
    } finally {
      llm.stop();
    }
  }, 40_000);
});

/* ================================================================== *
 * R7 重叠 prompt 必须拒绝
 * ================================================================== */

describe("R7 重叠 prompt", () => {
  test("R7 第二个 prompt 应回 -32603，且不触发第二次模型调用", async () => {
    const ws = workspace();
    const llm = fakeLlm([sseTextFrames("慢回答")], sseTextFrames("慢回答"), 350);
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, {
        cwd: ws,
        promptBlocks: [{ type: "text", text: "第一个" }],
      });
      // 第一个 prompt 已在 runClient 里发出（模型有 350ms 延迟），此时尚未结束。
      // 按原始客户端字节到达顺序立刻塞入第二个 session/prompt。
      if (!r.state.sessionId) throw new Error("session/new 未返回 sessionId");
      r.write(promptRequest(4, r.state.sessionId, "第二个"));
      const second = await r.waitFor((m) => m.id === 4 && (m.result !== undefined || m.error !== undefined), 8_000);
      const first = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 8_000);
      r.kill();
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(errorCode(second)).toBe(-32603);
      expect(llm.hits()).toBe(1);
    } finally {
      llm.stop();
    }
  }, 40_000);
});

/* ================================================================== *
 * R8 非正常终止的 stopReason 映射
 * ================================================================== */

describe("R8 stopReason 映射", () => {
  test("R8a finish_reason=length 应映射为 max_tokens", async () => {
    const ws = workspace();
    const llm = fakeLlm([sseTextFrames("被截断的部分正文", "length")]);
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, { cwd: ws, promptBlocks: [{ type: "text", text: "写长文" }] });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 10_000);
      r.kill();
      expect(resp).not.toBeNull();
      expect(stopReasonOf(resp)).toBe("max_tokens");
    } finally {
      llm.stop();
    }
  }, 40_000);

  test("R8b 达到 max_tool_iterations 应映射为 max_turn_requests", async () => {
    const ws = workspace();
    // 模型每轮都只请求 list_dir（只读、无需批准），永不收口。
    const llm = fakeLlm([], sseToolCallFrames("call-r8b", "list_dir", { path: "." }));
    try {
      const dir = project(llm.baseUrl);
      patchSettings(dir, { max_tool_iterations: 1 });
      const r = await runClient(dir, { cwd: ws, promptBlocks: [{ type: "text", text: "一直列目录" }] });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 15_000);
      r.kill();
      expect(resp).not.toBeNull();
      expect(stopReasonOf(resp)).toBe("max_turn_requests");
    } finally {
      llm.stop();
    }
  }, 40_000);

  test("R8c finish_reason=content_filter/refusal 应映射为 refusal", async () => {
    const ws = workspace();
    const llm = fakeLlm([sseTextFrames("拒绝继续", "content_filter")]);
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, { cwd: ws, promptBlocks: [{ type: "text", text: "越权请求" }] });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 8_000);
      r.kill();
      expect(resp).not.toBeNull();
      expect(stopReasonOf(resp)).toBe("refusal");
    } finally {
      llm.stop();
    }
  }, 40_000);
});

/* ================================================================== *
 * N1 EOF 回收后台 shell
 * ================================================================== */

describe("N1 EOF 回收后台 shell", () => {
  test("N1 后台 shell 在 stdin EOF 后不得继续写盘", async () => {
    const ws = workspace();
    const pidFile = join(ws, "bg.pid");
    const afterEof = join(ws, "bg-after-eof");
    const llm = fakeLlm([
      sseToolCallFrames("call-n1", "shell", {
        command: `printf $$ > ${JSON.stringify(pidFile)}; sleep 1.5; printf x > ${JSON.stringify(afterEof)}`,
        background: true,
      }),
      sseTextFrames("已启动后台命令"),
    ]);
    let bgPid: number | null = null;
    try {
      const dir = project(llm.baseUrl);
      patchSettings(dir, { permission_mode: "auto-all" });
      const r = await runClient(dir, { cwd: ws, promptBlocks: [{ type: "text", text: "起个后台命令" }] });
      // 等本轮真的结束（end_turn），此时后台 shell 还在 sleep。
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 15_000);
      expect(resp).not.toBeNull();
      expect(stopReasonOf(resp)).toBe("end_turn");
      // background:true 立刻返回，pid 可能晚于 end_turn 落盘。
      await waitForFile(pidFile, 1_000);
      bgPid = readPid(pidFile);
      expect(bgPid).not.toBeNull();
      // EOF：后台 shell 必须被回收，不得继续写盘。
      await r.closeStdin();
      await new Promise((res) => setTimeout(res, 2_500));
      r.kill();
      expect(existsSync(afterEof)).toBe(false);
      expect(isAlive(bgPid as number)).toBe(false);
    } finally {
      llm.stop();
      if (bgPid !== null) killPid(bgPid);
    }
  }, 40_000);
});

/* ================================================================== *
 * N2 迭代上限判定
 * ================================================================== */

describe("N2 迭代上限判定", () => {
  test("N2 最后一轮已正常作答时不得报 max_turn_requests", async () => {
    const ws = workspace();
    // 第 1 轮工具调用，第 2 轮正常收口作答 —— 迭代次数用满但已作答，不该报上限。
    const llm = fakeLlm([
      sseToolCallFrames("call-n2", "list_dir", { path: "." }),
      sseTextFrames("final answer"),
    ]);
    try {
      const dir = project(llm.baseUrl);
      patchSettings(dir, { max_tool_iterations: 2 });
      const r = await runClient(dir, { cwd: ws, promptBlocks: [{ type: "text", text: "列目录再回答" }] });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 15_000);
      r.kill();
      expect(resp).not.toBeNull();
      expect(stopReasonOf(resp)).toBe("end_turn");
    } finally {
      llm.stop();
    }
  }, 40_000);
});

/* ================================================================== *
 * N3 session/new 握手中 EOF
 * ================================================================== */

describe("N3 session/new 握手中 EOF", () => {
  test("N3 session/new 仍在等 MCP 握手时 EOF，已启动的 MCP 子进程须回收", async () => {
    const ws = workspace();
    const marker = join(ws, "n3-mcp.pid");
    const fakeMcp = join(ws, "n3-mcp.ts");
    // 写 pid 后永不回应 initialize，且忽略 stdin 关闭：只能靠 dispose 的 kill 回收。
    writeFileSync(fakeMcp, minimalMcpSource(marker, { answerHandshake: false }), "utf8");
    const llm = fakeLlm([sseTextFrames("ok")]);
    let mcpPid: number | null = null;
    let started = false;
    let eofSent = false;
    let sessionNewBeforeEof = false;
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, {
        cwd: ws,
        mcpServers: [{ name: "n3probe", command: process.execPath, args: [fakeMcp], env: [] }],
        // id=1 回来后 session/new 已发出：等 MCP 子进程 pid 落盘（它不回 initialize，
        // session/new 仍卡在握手、4s 超时前），然后 EOF。
        onMessage: async (msg, _state, api) => {
          if (msg.id === 2 && !eofSent) sessionNewBeforeEof = true;
          if (msg.id !== 1) return;
          started = await waitForFile(marker, 3_000);
          eofSent = true;
          await api.closeStdin();
        },
      });
      mcpPid = readPid(marker);
      expect(started).toBe(true);
      expect(sessionNewBeforeEof).toBe(false);
      expect(mcpPid).not.toBeNull();
      // 等 neo 退出（握手超时 4s 内应被 EOF 打断），再给 500ms 观察子进程。
      for (let i = 0; i < 400 && !r.exited(); i++) await new Promise((res) => setTimeout(res, 20));
      await new Promise((res) => setTimeout(res, 500));
      r.kill();
      expect(isAlive(mcpPid as number)).toBe(false);
    } finally {
      llm.stop();
      if (mcpPid !== null) killPid(mcpPid);
    }
  }, 40_000);
});

/* ================================================================== *
 * R9 引擎失败不得伪装成功
 * ================================================================== */

describe("R9 引擎失败", () => {
  test("R9a 模型连续空响应失败时不得回伪装成功的 end_turn", async () => {
    const ws = workspace();
    // 只回 error 帧 + 空 delta：引擎会判「连续两轮未产出正文」并 hadError。
    const errorFrame = 'data: {"error":{"message":"local fake backend error"}}\n\ndata: [DONE]\n\n';
    const llm = fakeLlm([errorFrame], errorFrame);
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, { cwd: ws, promptBlocks: [{ type: "text", text: "hi" }] });
      const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 15_000);
      r.kill();
      expect(resp).not.toBeNull();
      const textUpdates = r.state.updates.filter((u) => u === "agent_message_chunk");
      // 客户端没拿到任何正文，就不该收到「成功结束」。
      const isSuccessEndTurn = resp?.error === undefined && stopReasonOf(resp) === "end_turn";
      expect(textUpdates.length === 0 && isSuccessEndTurn).toBe(false);
    } finally {
      llm.stop();
    }
  }, 40_000);

  test("R9b 模型连接失败不得回伪装成功的 end_turn", async () => {
    const ws = workspace();
    // 丢弃端口，必然连不上。缺的是协议层可见失败，不是 stderr 诊断。
    const dir = project("http://127.0.0.1:9/v1");
    const r = await runClient(dir, { cwd: ws, promptBlocks: [{ type: "text", text: "hi" }] });
    const resp = await r.waitFor((m) => m.id === 3 && (m.result !== undefined || m.error !== undefined), 8_000);
    r.kill();
    expect(resp).not.toBeNull();
    const isSuccessEndTurn = resp?.error === undefined && stopReasonOf(resp) === "end_turn";
    expect(isSuccessEndTurn).toBe(false);
  }, 40_000);
});
