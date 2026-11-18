/**
 * issue #80 ACP 后续规格红测。
 *
 * 覆盖四项：available_commands_update、session/set_mode、session/load、usage_update。
 * 形态与 tests/acp-rereview.test.ts 同口径：管道级假客户端、本地假 SSE、沙箱 settings；
 * 夹具复制最小子集，不 import 未公开 helper，也不改 A1–E1。
 *
 * 本文件只写规格：在基线 eb963a0 上应失败。
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "../src/input/commands.ts";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-acp-followup-")));
const sessionsDir = join(SANDBOX, "sessions");
const LEGAL_MODES = ["ask", "auto-edit", "auto-all", "plan"] as const;
setDefaultTimeout(30_000);
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
        env: { enabled: false },
      },
      null,
      2,
    ),
    "utf8",
  );
}

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

function initializeRequest(id: number, protocolVersion = 1): string {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "neo-acp-followup-client", title: "neo acp followup client", version: "0.0.0" },
      },
    }) + "\n"
  );
}

function newSessionRequest(id: number, cwd: string, mcpServers: unknown[] = []): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers } }) + "\n";
}

function loadSessionRequest(id: number, cwd: string, sessionId: string, mcpServers: unknown[] = []): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/load", params: { cwd, sessionId, mcpServers } }) + "\n";
}

function setModeRequest(id: number, sessionId: string, modeId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/set_mode", params: { sessionId, modeId } }) + "\n";
}

function promptBlocksRequest(id: number, sessionId: string, prompt: unknown[]): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt } }) + "\n";
}

function promptRequest(id: number, sessionId: string, text: string): string {
  return promptBlocksRequest(id, sessionId, [{ type: "text", text }]);
}

function jsonRpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
}

function permissionResponse(id: unknown, params: unknown, kind: "allow_once" | "reject_once"): string {
  const options =
    (params as { options?: Array<{ optionId?: unknown; kind?: unknown }> } | undefined)?.options ?? [];
  const picked = options.find((o) => o.kind === kind) ?? options[0];
  const optionId = typeof picked?.optionId === "string" ? picked.optionId : kind;
  return jsonRpcResult(id, { outcome: { outcome: "selected", optionId } });
}

function modesOf(resp: JsonRpcMessage | null | undefined): {
  currentModeId?: unknown;
  availableModes?: unknown;
} | null {
  const modes = (resp?.result as { modes?: { currentModeId?: unknown; availableModes?: unknown } } | undefined)?.modes;
  return modes ?? null;
}

function modeIdsOf(resp: JsonRpcMessage | null | undefined): string[] {
  const modes = modesOf(resp)?.availableModes;
  if (!Array.isArray(modes)) return [];
  return modes
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string");
}

function updatesOf(messages: JsonRpcMessage[], kind: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.method !== "session/update") continue;
    const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update;
    if (update && update["sessionUpdate"] === kind) out.push(update);
  }
  return out;
}

function writeStoredSession(id: string, cwd: string, messages: Array<{ role: string; content: string }>): void {
  mkdirSync(sessionsDir, { recursive: true });
  const path = join(sessionsDir, `${id}.json`);
  const now = new Date().toISOString();
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        meta: { id, path, createdAt: now, updatedAt: now, model: "fake-model", cwd, turns: 1 },
        messages,
      },
      null,
      2,
    ),
    "utf8",
  );
}

/* ------------------------------------------------------------------ *
 * 假 LLM 端点
 * ------------------------------------------------------------------ */

interface FakeLlm {
  baseUrl: string;
  hits: () => number;
  prompts: () => string[];
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

function fakeLlm(script: string[], fallback = sseTextFrames("完成"), delayMs = 0): FakeLlm {
  let hits = 0;
  const prompts: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "fake-model" }] });
      }
      if (url.pathname.endsWith("/chat/completions")) {
        const body = (await req.json().catch(() => ({}))) as { messages?: Array<{ role?: unknown; content?: unknown }> };
        if (JSON.stringify(body.messages ?? []).includes("完成条件判定器")) {
          return new Response(sseTextFrames('{"done": false, "reason": "还没好"}'), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        prompts.push(JSON.stringify(body.messages ?? []));
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
    prompts: () => prompts,
    stop: () => server.stop(true),
  };
}

/* ------------------------------------------------------------------ *
 * 管道级假客户端
 * ------------------------------------------------------------------ */

interface ClientState {
  sessionId: string | null;
  serverRequests: string[];
  updates: string[];
  sentPrompt: boolean;
}

interface ClientOptions {
  cwd?: string;
  mcpServers?: unknown[];
  promptBlocks?: unknown[];
  policy?: "allow" | "reject" | "error" | "ignore";
  onMessage?: (msg: JsonRpcMessage, state: ClientState, api: ClientApi) => void | Promise<void>;
  timeoutMs?: number;
  /** 初始化成功后发 session/load 而不是 session/new。 */
  loadSessionId?: string;
}

interface ClientApi {
  write: (line: string) => void;
  closeStdin: () => Promise<void>;
}

interface ClientRun {
  out: string;
  err: string;
  timedOut: () => boolean;
  state: ClientState;
  messages: JsonRpcMessage[];
  waitFor: (pred: (msg: JsonRpcMessage) => boolean, ms: number) => Promise<JsonRpcMessage | null>;
  write: (line: string) => void;
  closeStdin: () => Promise<void>;
  kill: () => void;
}

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
  };
  let out = "";
  let err = "";
  let timedOut = false;
  let buf = "";
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

  const api: ClientApi = { write, closeStdin };

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
          if (opts.loadSessionId !== undefined) {
            write(loadSessionRequest(2, opts.cwd ?? cwd, opts.loadSessionId, opts.mcpServers ?? []));
          } else {
            write(newSessionRequest(2, opts.cwd ?? cwd, opts.mcpServers ?? []));
          }
        }
        if (msg.id === 2) {
          const sid =
            sessionIdOf(msg) ??
            (msg.error === undefined && opts.loadSessionId !== undefined ? opts.loadSessionId : null);
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
    await proc.exited;
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
  await waitFor((m) => m.id === 2, 8_000);

  return {
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    timedOut: () => timedOut,
    state,
    messages,
    waitFor,
    write,
    closeStdin,
    kill: () => {
      clearTimeout(timer);
      killSpawnedBun(proc);
    },
  };
}

/* ================================================================== *
 * F1 斜杠命令广告
 * ================================================================== */

describe("F1 available_commands_update", () => {
  test("F1 session/new 之后广告现有斜杠命令，不发明新命令", async () => {
    const dir = project();
    const r = await runClient(dir);
    try {
      const update = await r.waitFor((m) => updatesOf([m], "available_commands_update").length > 0, 5_000);
      expect(update).not.toBeNull();
      const commands = updatesOf(r.messages, "available_commands_update")[0]?.["availableCommands"];
      expect(Array.isArray(commands)).toBe(true);
      const advertised = new Set(
        (commands as Array<{ name?: unknown }>).map((c) => c.name).filter((n): n is string => typeof n === "string"),
      );
      const existing = new Set(COMMANDS.map((c) => c.name));
      expect([...advertised].sort()).toEqual([...existing].sort());
      expect(advertised.has("acceptEdits")).toBe(false);
    } finally {
      await r.closeStdin();
      r.kill();
    }
  });
});

/* ================================================================== *
 * F2 / F3 / F4 session/set_mode
 * ================================================================== */

describe("F2–F4 session/set_mode", () => {
  test("F2 session/new 响应广告 neo 已有档位，currentMode 来自 settings", async () => {
    const dir = project();
    patchSettings(dir, { permission_mode: "auto-edit" });
    const r = await runClient(dir);
    try {
      const created = r.messages.find((m) => m.id === 2);
      expect(created?.error).toBeUndefined();
      const modes = modesOf(created);
      expect(modes).not.toBeNull();
      expect(modes?.currentModeId).toBe("auto-edit");
      expect(modeIdsOf(created).sort()).toEqual([...LEGAL_MODES].sort());
      // 不要广告 Claude 那套名称。
      expect(modeIdsOf(created)).not.toContain("acceptEdits");
      expect(modeIdsOf(created)).not.toContain("bypassPermissions");
    } finally {
      await r.closeStdin();
      r.kill();
    }
  });

  test("F3 非法 mode 回 -32602；切到 plan 后写工具不得落盘", async () => {
    const ws = workspace();
    const target = join(ws, "f3-should-not-write.txt");
    const llm = fakeLlm([sseToolCallFrames("call-f3", "write_file", { path: target, content: "不该写入\n" })]);
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, { cwd: ws });
      try {
        const sid = r.state.sessionId as string;
        expect(sid).toBeTruthy();

        r.write(setModeRequest(4, sid, "acceptEdits"));
        const illegal = await r.waitFor((m) => m.id === 4, 5_000);
        expect(illegal).not.toBeNull();
        expect(errorCode(illegal)).toBe(-32602);

        r.write(setModeRequest(5, sid, "plan"));
        const switched = await r.waitFor((m) => m.id === 5, 5_000);
        expect(switched).not.toBeNull();
        expect(switched?.error).toBeUndefined();

        r.write(promptRequest(6, sid, "写文件"));
        const promptDone = await r.waitFor((m) => m.id === 6, 12_000);
        expect(promptDone).not.toBeNull();
        expect(promptDone?.error).toBeUndefined();
        expect(r.state.serverRequests.includes("session/request_permission")).toBe(false);
        await new Promise((res) => setTimeout(res, 200));
        expect(existsSync(target)).toBe(false);
      } finally {
        await r.closeStdin();
        r.kill();
      }
    } finally {
      llm.stop();
    }
  });

  test("F4 成功切换后发出 current_mode_update", async () => {
    const dir = project();
    const r = await runClient(dir);
    try {
      const sid = r.state.sessionId as string;
      r.write(setModeRequest(4, sid, "auto-all"));
      const switched = await r.waitFor((m) => m.id === 4, 5_000);
      expect(switched?.error).toBeUndefined();
      const update = await r.waitFor((m) => updatesOf([m], "current_mode_update").length > 0, 5_000);
      expect(update).not.toBeNull();
      const body = updatesOf(r.messages, "current_mode_update")[0];
      expect(body?.["currentModeId"]).toBe("auto-all");
    } finally {
      await r.closeStdin();
      r.kill();
    }
  });
});

/* ================================================================== *
 * F5 usage_update
 * ================================================================== */

describe("F5 usage_update", () => {
  test("F5 prompt 结束后发出真实 token/上下文占用，不编数字", async () => {
    const llm = fakeLlm([sseTextFrames("你好，这是一轮正常回复。")]);
    try {
      const dir = project(llm.baseUrl);
      // 用非默认窗口交叉验证 size 走 contextWindow，不是夹具里写死的 100000。
      patchSettings(dir, {
        providers: [
          {
            provider_name: "fake",
            provider_type: "openai",
            base_url: llm.baseUrl,
            api_key: "test",
            default_model_name: "fake-model",
            deep_reasoning_model_name: "fake-model",
            balanced_model_name: "fake-model",
            fast_model_name: "fake-model",
            max_tokens: 64,
            temperature: 0,
            context_window: 50_000,
          },
        ],
      });
      const r = await runClient(dir, { promptBlocks: [{ type: "text", text: "打个招呼" }] });
      try {
        const promptDone = await r.waitFor((m) => m.id === 3, 12_000);
        expect(promptDone).not.toBeNull();
        expect(promptDone?.error).toBeUndefined();
        const update = await r.waitFor((m) => updatesOf([m], "usage_update").length > 0, 5_000);
        expect(update).not.toBeNull();
        const body = updatesOf(r.messages, "usage_update")[0];
        const used = body?.["used"];
        const size = body?.["size"];
        expect(typeof used).toBe("number");
        expect(typeof size).toBe("number");
        expect(size).toBe(50_000);
        expect(used as number).toBeGreaterThan(100);
        expect(used as number).toBeLessThanOrEqual(50_000);
      } finally {
        await r.closeStdin();
        r.kill();
      }
    } finally {
      llm.stop();
    }
  });
});

/* ================================================================== *
 * F6–F8 session/load（复用 --resume，单进程仍只一个 session）
 * ================================================================== */

describe("F6–F8 session/load", () => {
  test("F6 initialize 广告 loadSession: true", async () => {
    const dir = project();
    const r = await runClient(dir);
    try {
      const init = r.messages.find((m) => m.id === 1);
      const caps = (init?.result as { agentCapabilities?: { loadSession?: unknown } } | undefined)?.agentCapabilities;
      expect(caps?.loadSession).toBe(true);
    } finally {
      await r.closeStdin();
      r.kill();
    }
  });

  test("F7 session/load 复用已有会话文件并续上历史，仍只支持一个 session", async () => {
    const ws = workspace();
    const sessionId = "20260101-000000-followup";
    writeStoredSession(sessionId, ws, [
      { role: "user", content: "先前说过的秘密口令 ALPHA-80" },
      { role: "assistant", content: "已记住口令。" },
    ]);
    const llm = fakeLlm([sseTextFrames("口令还在。")]);
    try {
      const dir = project(llm.baseUrl);
      const r = await runClient(dir, {
        cwd: ws,
        loadSessionId: sessionId,
        promptBlocks: [{ type: "text", text: "口令是什么？" }],
      });
      try {
        const loaded = r.messages.find((m) => m.id === 2);
        expect(loaded?.error).toBeUndefined();
        expect(r.state.sessionId).toBe(sessionId);
        const modes = modesOf(loaded);
        expect(modeIdsOf(loaded).sort()).toEqual([...LEGAL_MODES].sort());
        expect(typeof modes?.currentModeId).toBe("string");
        expect(LEGAL_MODES).toContain(modes?.currentModeId as (typeof LEGAL_MODES)[number]);

        const promptDone = await r.waitFor((m) => m.id === 3, 12_000);
        expect(promptDone).not.toBeNull();
        expect(promptDone?.error).toBeUndefined();
        expect(llm.prompts().some((p) => p.includes("ALPHA-80"))).toBe(true);

        const commands = await r.waitFor((m) => updatesOf([m], "available_commands_update").length > 0, 5_000);
        expect(commands).not.toBeNull();
      } finally {
        await r.closeStdin();
        r.kill();
      }
    } finally {
      llm.stop();
    }
  });

  test("F8 已有 session 时再 load 被拒绝；不存在的 id 回错误", async () => {
    const ws = workspace();
    const sessionId = "20260101-000000-exists";
    writeStoredSession(sessionId, ws, [{ role: "user", content: "历史" }]);
    const dir = project();
    const r = await runClient(dir, { cwd: ws });
    try {
      const sid = r.state.sessionId as string;
      expect(sid).toBeTruthy();

      r.write(loadSessionRequest(4, ws, sessionId));
      const second = await r.waitFor((m) => m.id === 4, 5_000);
      expect(second).not.toBeNull();
      expect(errorCode(second)).toBe(-32603);

      await r.closeStdin();
      r.kill();
    } finally {
      /* 下一进程测缺失 id */
    }

    const missing = await runClient(dir, { cwd: ws, loadSessionId: "no-such-session-id" });
    try {
      const loaded = missing.messages.find((m) => m.id === 2);
      expect(loaded).not.toBeNull();
      expect(loaded?.error).toBeDefined();
      expect(errorCode(loaded)).toBe(-32602);
      expect(loaded?.result).toBeUndefined();
    } finally {
      await missing.closeStdin();
      missing.kill();
    }
  });
});
