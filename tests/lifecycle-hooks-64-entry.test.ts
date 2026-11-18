/**
 * #64 生命周期 hooks（入口层：-p / ACP / /hooks）。
 *
 * 全部真起子进程（`bun src/index.ts`）+ 本地假 OpenAI SSE 端点，不触网、不读真实
 * settings.json / ~/.neo。断言重点是入口级事实，fake IO 测不出来：
 *  - `-p` 一次输入只触发一次 UserPromptSubmit，SessionStart 一次；
 *  - UserPromptSubmit exit2 在 -p 下零模型请求、退出码 2、原因走 stderr；
 *  - ACP：stdout 只有 JSON-RPC，诊断走 stderr；阻断返回合法响应不挂起；
 *  - ACP `session/prompt` 每次一次 UserPromptSubmit，`session/load` 回放不算提交；
 *  - `/hooks` 列出全部新事件。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-hooks64-entry-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

const SPAWN_TIMEOUT_MS = 15_000;

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** 记录每次模型请求的假端点；`requests` 用于断言「零模型请求」。 */
const requests: string[] = [];
const SSE =
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
  "data: [DONE]\n\n";
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "fake-model" }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      requests.push("chat");
      return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => {
  server.stop(true);
});

function writeSettings(dir: string, hooks?: Record<string, unknown>): void {
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
            base_url: BASE,
            api_key: "test",
            default_model_name: "fake-model",
            deep_reasoning_model_name: "fake-model",
            balanced_model_name: "fake-model",
            fast_model_name: "fake-model",
            max_tokens: 64,
            temperature: 0,
            context_window: 100_000,
          },
        ],
        retry: { max_attempts: 1, base_delay_ms: 1, connect_timeout_ms: 2_000, stream_idle_timeout_ms: 2_000 },
        memory: { enabled: false },
        ...(hooks ? { hooks } : {}),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function project(hooks?: Record<string, unknown>): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir, hooks);
  return dir;
}

/** 在项目目录里写一条 hook 脚本，返回其绝对路径。 */
function hookScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
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
  for (const key of ["NEO_API_KEY", "NEO_BASE_URL", "NEO_PROVIDER", "NEO_MODEL", "NEO_TIER"]) delete env[key];
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

interface RunResult {
  out: string;
  err: string;
  code: number;
  timedOut: boolean;
}

async function runCli(cwd: string, args: string[], stdinText?: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdin: stdinText === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  if (stdinText !== undefined) {
    try {
      // Bun.spawn 的 stdin 在 "pipe" 下仍被标为可选：这里显式守卫，不跳过测试。
      const stdin = proc.stdin;
      if (stdin) {
        stdin.write(stdinText);
        await stdin.end();
      }
    } catch {
      /* 已退出 */
    }
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killSpawnedBun(proc);
  }, SPAWN_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { out, err, code, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function marks(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* -p 入口                                                             */
/* ------------------------------------------------------------------ */

describe("#64 -p 入口", () => {
  test("#64 -p fires SessionStart once and UserPromptSubmit once per input", async () => {
    const dir = project();
    const mark = join(dir, "marks.txt");
    const recorder = hookScript(dir, "rec.sh", `cat >/dev/null\necho $NEO_HOOK_EVENT >> '${mark}'`);
    writeSettings(dir, {
      enabled: true,
      SessionStart: [{ command: recorder }],
      UserPromptSubmit: [{ command: recorder }],
    });
    const r = await runCli(dir, ["-p", "hello", "-y"]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(marks(mark)).toEqual(["SessionStart", "UserPromptSubmit"]);
  }, 40_000);

  test("#64 -p UserPromptSubmit exit2 blocks with zero model requests", async () => {
    const dir = project();
    const blocker = hookScript(dir, "block.sh", "cat >/dev/null\necho 'blocked by policy' >&2\nexit 2");
    writeSettings(dir, { enabled: true, UserPromptSubmit: [{ command: blocker }] });
    const before = requests.length;
    const r = await runCli(dir, ["-p", "hello", "-y"]);
    expect(r.timedOut).toBe(false);
    expect(requests.length).toBe(before);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("blocked by policy");
  }, 40_000);

  test("#64 -p --drive fires UserPromptSubmit once across rounds and Stop at most once per input", async () => {
    const dir = project();
    const mark = join(dir, "marks.txt");
    const recorder = hookScript(dir, "rec.sh", `cat >/dev/null\necho $NEO_HOOK_EVENT >> '${mark}'`);
    const stop = hookScript(
      dir,
      "stop.sh",
      `cat >/dev/null\necho Stop >> '${mark}'\necho '{"decision":"block","reason":"S33 再确认一次"}'`,
    );
    writeSettings(dir, {
      enabled: true,
      UserPromptSubmit: [{ command: recorder }],
      Stop: [{ command: stop }],
    });
    // 检查命令恒失败 → 驱动必然跑满两轮内部 send；Stop 每轮都请求续跑。
    // 假端点恒返回「hi」正文（无工具调用）→ 每轮都会走到 Stop。
    const before = requests.length;
    const r = await runCli(dir, ["-p", "hello", "-y", "--drive", "false", "--max", "2"]);
    expect(r.timedOut).toBe(false);
    const events = marks(mark);
    // 一次真实用户输入（--drive 的提示）只提交一次 UserPromptSubmit。
    expect(events.filter((e) => e === "UserPromptSubmit").length).toBe(1);
    // Stop 额度按「每条用户输入一次」：原轮用掉后，后续内部轮不得重置。
    expect(events.filter((e) => e === "Stop").length).toBe(3);
    expect(requests.length - before).toBe(3);
  }, 40_000);

  test("#64 -p --drive stops spending model requests once UserPromptSubmit blocks", async () => {
    const dir = project();
    const blocker = hookScript(dir, "block.sh", "cat >/dev/null\necho 'drive blocked' >&2\nexit 2");
    writeSettings(dir, { enabled: true, UserPromptSubmit: [{ command: blocker }] });
    const before = requests.length;
    const r = await runCli(dir, ["-p", "hello", "-y", "--drive", "false", "--max", "3"]);
    expect(r.timedOut).toBe(false);
    expect(requests.length).toBe(before);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("drive blocked");
  }, 40_000);

  test("#64 -p json mode does not backfill a previous answer when blocked", async () => {
    const dir = project();
    const blocker = hookScript(dir, "block.sh", "cat >/dev/null\necho 'json blocked' >&2\nexit 2");
    writeSettings(dir, { enabled: true, UserPromptSubmit: [{ command: blocker }] });
    const r = await runCli(dir, ["-p", "hello", "-y", "--output-format", "json"]);
    expect(r.timedOut).toBe(false);
    expect(r.code).not.toBe(0);
    const payload = JSON.parse(r.out.trim()) as { ok?: boolean; answer?: unknown; exit_code?: number };
    expect(payload.ok).toBe(false);
    expect(payload.answer).toBeNull();
    expect(payload.exit_code).not.toBe(0);
  }, 40_000);

  test("#64 -p SessionStart failure is diagnostic only", async () => {
    const dir = project();
    const broken = hookScript(dir, "broken.sh", "cat >/dev/null\necho 'startup warning' >&2\nexit 2");
    writeSettings(dir, { enabled: true, SessionStart: [{ command: broken }] });
    const r = await runCli(dir, ["-p", "hello", "-y"]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.err).toContain("startup warning");
  }, 40_000);
});

/* ------------------------------------------------------------------ */
/* /hooks                                                              */
/* ------------------------------------------------------------------ */

describe("#64 /hooks", () => {
  test("#64 /hooks lists all four new lifecycle events", async () => {
    // 真命令分发的文本契约；真实TTY事件另由S31/S32/S33覆盖。
    const {parseHooksConfig}=await import("../src/hooks/index.ts");
    const {handleSystemCommands}=await import("../src/cli/commandSystem.ts");
    const {captureConsole}=await import("./helpers.ts");
    const cap=captureConsole();
    const hooks=parseHooksConfig({enabled:true,
      SessionStart:[{command:"start"}], UserPromptSubmit:[{command:"submit"}],
      Stop:[{command:"stop"}], PreCompact:[{command:"pre",matcher:"manual"}]});
    await handleSystemCommands("hooks","",[],{cfg:{hooks},ui:cap.ui} as never);
    const text=cap.out();
    for(const event of ["SessionStart","UserPromptSubmit","Stop","PreCompact"]) expect(text).toContain(event);
    expect(text).toContain("trigger=manual");
  }, 60_000);
});

/* ------------------------------------------------------------------ */
/* ACP 入口                                                            */
/* ------------------------------------------------------------------ */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

function parseNdjson(text: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    out.push(JSON.parse(t) as JsonRpcMessage);
  }
  return out;
}

function findResponse(messages: JsonRpcMessage[], id: number): JsonRpcMessage | undefined {
  return messages.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
}

function sessionIdOf(resp: JsonRpcMessage | undefined): string | null {
  const result = resp?.result as { sessionId?: unknown } | undefined;
  return typeof result?.sessionId === "string" && result.sessionId !== "" ? result.sessionId : null;
}

function initializeRequest(id: number): string {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    }) + "\n"
  );
}

function newSessionRequest(id: number, cwd: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "session/new", params: { cwd, mcpServers: [] } }) + "\n";
}

function promptRequest(id: number, sessionId: string, text: string): string {
  return (
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
    }) + "\n"
  );
}

/**
 * 起 acp 子进程：initialize → session/new → session/prompt，等 prompt 响应后关 stdin。
 * 返回 stdout / stderr / 退出码。
 */
async function runAcpSession(cwd: string, promptText: string | string[], resumeId?: string): Promise<RunResult> {
  const prompts=typeof promptText === "string" ? [promptText] : promptText;
  const proc = Bun.spawn(["bun", INDEX, "acp"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  const decoder = new TextDecoder();
  let out = "";
  let err = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killSpawnedBun(proc);
  }, SPAWN_TIMEOUT_MS);
  const errReader = (async () => {
    for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
      err += decoder.decode(chunk, { stream: true });
    }
  })();
  let sentPrompt = false;
  let sid=resumeId ?? "";
  let promptIndex=0;
  let pending="";
  const processed=new Set<number>();
  // Bun.spawn 的 stdin 在 "pipe" 下仍被标为可选：显式守卫，不跳过测试。
  const stdin = proc.stdin;
  if (!stdin) {
    throw new Error("acp 子进程没有 stdin 管道");
  }
  try {
    stdin.write(initializeRequest(1));
    stdin.write(resumeId ? JSON.stringify({jsonrpc:"2.0",id:2,method:"session/load",params:{sessionId:resumeId,cwd,mcpServers:[]}})+"\n" : newSessionRequest(2, cwd));
    stdin.flush();
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      const text=decoder.decode(chunk, {stream:true});
      out+=text; pending+=text;
      const lines=pending.split("\n"); pending=lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (t === "" || !t.startsWith("{")) continue;
        let parsed: JsonRpcMessage;
        try {
          parsed = JSON.parse(t) as JsonRpcMessage;
        } catch {
          continue;
        }
        if (typeof parsed.id !== "number" || processed.has(parsed.id)) continue;
        processed.add(parsed.id);
        if (parsed.id === 2) sid = resumeId ?? sessionIdOf(parsed) ?? "";
        if (parsed.id === 2 || parsed.id === 2+promptIndex) {
          if (promptIndex < prompts.length && sid && !parsed.error) {
            sentPrompt=true;
            stdin.write(promptRequest(3+promptIndex,sid,prompts[promptIndex++]!));
            stdin.flush();
          } else {
            await stdin.end();
          }
        }
      }
    }
    await errReader;
    const code = await proc.exited;
    return { out, err, code, timedOut };
  } finally {
    clearTimeout(timer);
    if (!sentPrompt) {
      try {
        await stdin.end();
      } catch {
        /* 已退出 */
      }
    }
  }
}

describe("#64 ACP 入口", () => {
  test("#64 ACP stdout stays pure JSON-RPC while hooks diagnose on stderr", async () => {
    const dir = project();
    const noisy = hookScript(dir, "noisy.sh", "cat >/dev/null\necho 'hook diagnostic line' >&2\nexit 0");
    writeSettings(dir, { enabled: true, SessionStart: [{ command: noisy }], UserPromptSubmit: [{ command: noisy }] });
    const r = await runAcpSession(dir, "hi");
    expect(r.timedOut).toBe(false);
    // stdout 每一行都必须是合法 JSON-RPC（不得混入 hook 文本）。
    for (const line of r.out.split("\n")) {
      const t = line.trim();
      if (t === "") continue;
      const parsed = JSON.parse(t) as JsonRpcMessage;
      expect(parsed.jsonrpc).toBe("2.0");
    }
    expect(r.err).toContain("hook diagnostic line");
  }, 40_000);

  test("#64 ACP UserPromptSubmit exit2 returns a legal response and does not hang", async () => {
    const dir = project();
    const blocker = hookScript(dir, "block.sh", "cat >/dev/null\necho 'acp blocked' >&2\nexit 2");
    writeSettings(dir, { enabled: true, UserPromptSubmit: [{ command: blocker }] });
    const before = requests.length;
    const r = await runAcpSession(dir, "hi");
    expect(r.timedOut).toBe(false);
    expect(requests.length).toBe(before);
    const messages = parseNdjson(r.out);
    const resp = findResponse(messages, 3);
    expect(resp).toBeDefined();
    // 合法响应：要么是 result（stopReason），要么是 JSON-RPC 错误 —— 不能是半截输出。
    expect(resp?.result !== undefined || resp?.error !== undefined).toBe(true);
    expect(r.err).toContain("acp blocked");
  }, 40_000);

  test("#64 ACP session/new fires SessionStart(new) once; session/prompt adds only UPS", async () => {
    const dir = project();
    const mark = join(dir, "marks.txt");
    const recorder = hookScript(dir, "rec.sh", `cat >/dev/null\necho $NEO_HOOK_EVENT >> '${mark}'`);
    writeSettings(dir, { enabled: true, SessionStart: [{ command: recorder }], UserPromptSubmit: [{ command: recorder }] });
    const r = await runAcpSession(dir, "hi");
    expect(r.timedOut).toBe(false);
    const events = marks(mark);
    expect(events[0]).toBe("SessionStart");
    expect(events.filter((e) => e === "SessionStart").length).toBe(1);
    expect(events.filter((e) => e === "UserPromptSubmit").length).toBe(1);
  }, 40_000);

  test("#64 ACP session/prompt fires UserPromptSubmit once per prompt", async () => {
    const dir = project();
    const mark = join(dir, "marks.txt");
    const recorder = hookScript(dir, "rec.sh", `cat >/dev/null\necho $NEO_HOOK_EVENT >> '${mark}'`);
    writeSettings(dir, { enabled: true, SessionStart: [{ command: recorder }], UserPromptSubmit: [{ command: recorder }] });
    const r = await runAcpSession(dir, ["hi", "second"]);
    expect(r.timedOut).toBe(false);
    const events = marks(mark);
    expect(events.filter((e) => e === "SessionStart").length).toBe(1);
    expect(events.filter((e) => e === "UserPromptSubmit").length).toBe(2);
  }, 40_000);
});


test("#64 ACP load replays history with SessionStart(resume) and no UserPromptSubmit", async()=> {
  const dir=project();
  const mark=join(dir,"resume.txt");
  const rec=hookScript(dir,"rec.sh",`cat >/dev/null; echo "$NEO_HOOK_EVENT:$NEO_HOOK_SOURCE" >> '${mark}'`);
  writeSettings(dir,{enabled:true,SessionStart:[{command:rec}],UserPromptSubmit:[{command:rec}]});
  const first=await runAcpSession(dir,"hello");
  const sid=sessionIdOf(findResponse(parseNdjson(first.out),2));
  expect(sid).not.toBeNull();
  const old=marks(mark);
  const before=requests.length;
  const resumed=await runAcpSession(dir,[],sid!);
  expect(resumed.timedOut).toBe(false);
  expect(findResponse(parseNdjson(resumed.out),2)?.error).toBeUndefined();
  expect(marks(mark).slice(old.length)).toEqual(["SessionStart:resume"]);
  expect(requests.length).toBe(before);
},40000);


test("#64 CLI resume of an empty saved session still has source resume", async()=> {
  const dir=project();
  const mark=join(dir,"sources.txt");
  const rec=hookScript(dir,"sources.sh",`cat >/dev/null; echo "$NEO_HOOK_SOURCE" >> '${mark}'`);
  writeSettings(dir,{enabled:true,SessionStart:[{command:rec}]});
  const first=await runAcpSession(dir,"seed");
  const sid=sessionIdOf(findResponse(parseNdjson(first.out),2));
  expect(sid).not.toBeNull();
  const file=join(sessionsDir,`${sid}.json`);
  const stored=JSON.parse(readFileSync(file,"utf8"));
  stored.messages=[];
  writeFileSync(file,JSON.stringify(stored));
  const next=await runCli(dir,["--resume",sid!,"-p","hello","-y"]);
  expect(next.timedOut).toBe(false);
  expect(next.code).toBe(0);
  expect(marks(mark)).toEqual(["new","resume"]);
},40000);
