/**
 * issue #75 复审 P2：detached（setsid）之后，终端 SIGINT / SIGHUP / SIGTERM
 * 不再传到子进程，neo 必须自己先回收再退出，否则前台 shell 和孙进程会继续写盘。
 *
 * 红点（当前 HEAD，尚无信号处理时）：
 *  - neo -p 在独立进程组收到 SIGINT / SIGHUP 后，sh-after 与 gc-after 会被写出；
 *  - ACP 收到 SIGTERM / SIGHUP 后，后台 shell 的孙进程仍会写 gc-after；
 *  - TUI onTerm / onCrash 源码里只关 MCP，契约断言失败。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-issue75-signals-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

const enc = new TextEncoder();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

function readPid(file: string): number | null {
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function waitForFile(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await Bun.sleep(20);
  }
  return existsSync(file);
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(20);
  }
  return pred();
}

/** 对 Bun.spawn 的 pid（可能是启动器）及其直接子进程、进程组发同一信号。 */
function signalSpawned(proc: Bun.Subprocess, sig: NodeJS.Signals): void {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(out.stdout);
  const targets = new Set<number>();
  if (typeof proc.pid === "number" && proc.pid > 0) {
    targets.add(proc.pid);
    try {
      process.kill(-proc.pid, sig);
    } catch {
      /* 不是组长或组已不在 */
    }
  }
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (Number.isFinite(pid) && typeof proc.pid === "number" && ppid === proc.pid) targets.add(pid);
  }
  for (const pid of targets) {
    try {
      process.kill(pid, sig);
    } catch {
      /* 已退出 */
    }
  }
}

function killSpawned(proc: Bun.Subprocess): void {
  signalSpawned(proc, "SIGKILL");
}

let shellCommand = "";
let firstRoundTool = true;

function toolCallFrames(name: string, args: Record<string, unknown>): string[] {
  const argsJson = JSON.stringify(args);
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, id: "call_sig", type: "function", function: { name, arguments: "" } }],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

const ANSWER_FRAMES =
  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}}\n\n' +
  "data: [DONE]\n\n";

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "fake-model" }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      return (async () => {
        let messages: Array<{ role?: string }> = [];
        try {
          const body = (await req.json()) as { messages?: Array<{ role?: string }> };
          if (Array.isArray(body.messages)) messages = body.messages;
        } catch {
          /* 非法请求体也照常回帧 */
        }
        const toolRounds = messages.reduce((n, m) => (n + (m.role === "tool" ? 1 : 0)), 0);
        const frames = firstRoundTool && toolRounds === 0 ? toolCallFrames("shell", JSON.parse(shellCommand) as Record<string, unknown>) : [ANSWER_FRAMES];
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const f of frames) {
              controller.enqueue(enc.encode(f));
              await Bun.sleep(2);
            }
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      })();
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => {
  server.stop(true);
  rmSync(SANDBOX, { recursive: true, force: true });
});

function writeSettings(dir: string, extra: Record<string, unknown> = {}): void {
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
        retry: { max_attempts: 1, base_delay_ms: 1, connect_timeout_ms: 2_000, stream_idle_timeout_ms: 8_000 },
        memory: { enabled: false },
        permission_mode: "auto-all",
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function project(): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir);
  return dir;
}

function childEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NEO_SESSIONS_DIR: sessionsDir,
    NEO_MAILBOX_DIR: join(SANDBOX, "mailbox"),
    NEO_MEMORY_DIR: join(SANDBOX, "memory"),
    NEO_USER_WIKI_DIR: join(SANDBOX, "wiki"),
    NEO_MEMORY_JOURNAL_DIR: join(SANDBOX, "journal"),
    NEO_MEMORY_DISABLE: "1",
  };
  for (const key of ["NEO_API_KEY", "NEO_BASE_URL", "NEO_PROVIDER", "NEO_MODEL", "NEO_TIER"]) {
    delete env[key];
  }
  return env;
}

/** 前台 shell：自身写 sh.pid / sh-after，并派生一个写 gc.pid / gc-after 的孙进程。 */
function foregroundCmd(dir: string): { command: string; shPid: string; gcPid: string; shAfter: string; gcAfter: string } {
  const shPid = join(dir, "sh.pid");
  const gcPid = join(dir, "gc.pid");
  const shAfter = join(dir, "sh-after");
  const gcAfter = join(dir, "gc-after");
  const command =
    `printf $$ > ${JSON.stringify(shPid)}; ` +
    `sh -c ${JSON.stringify(`printf $$ > ${JSON.stringify(gcPid)}; sleep 2; printf x > ${JSON.stringify(gcAfter)}`)} & ` +
    `sleep 2; printf x > ${JSON.stringify(shAfter)}; wait`;
  return { command, shPid, gcPid, shAfter, gcAfter };
}

function grandchildOnlyCmd(dir: string): { command: string; gcPid: string; gcAfter: string } {
  const gcPid = join(dir, "gc.pid");
  const gcAfter = join(dir, "gc-after");
  const command =
    `sh -c ${JSON.stringify(`printf $$ > ${JSON.stringify(gcPid)}; sleep 2; printf x > ${JSON.stringify(gcAfter)}`)} & wait`;
  return { command, gcPid, gcAfter };
}

afterEach(() => {
  firstRoundTool = true;
  shellCommand = JSON.stringify({ command: "true" });
});

describe("#75 neo -p 信号须回收已脱组的前台 shell", () => {
  async function runPlainPAndSignal(sig: NodeJS.Signals): Promise<{
    shAfter: string;
    gcAfter: string;
    sh: number | null;
    gc: number | null;
  }> {
    const dir = project();
    const cmd = foregroundCmd(dir);
    shellCommand = JSON.stringify({ command: cmd.command });
    const proc = Bun.spawn(["bun", INDEX, "-p", "跑命令", "-y"], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
      // 模拟终端前台作业：neo 自成一组，tty 的 SIGINT/SIGHUP 会打到整组。
      detached: true,
    });
    const outP = new Response(proc.stdout).text();
    const errP = new Response(proc.stderr).text();
    let sh: number | null = null;
    let gc: number | null = null;
    try {
      expect(await waitForFile(cmd.shPid, 20_000)).toBe(true);
      expect(await waitForFile(cmd.gcPid, 5_000)).toBe(true);
      sh = readPid(cmd.shPid);
      gc = readPid(cmd.gcPid);
      expect(sh).not.toBeNull();
      expect(gc).not.toBeNull();
      signalSpawned(proc, sig);
      const exited = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      if (!exited) killSpawned(proc);
      await Promise.race([proc.exited, Bun.sleep(1_000)]);
      if (gc !== null) await waitFor(() => !isAlive(gc as number), 2_000);
      if (sh !== null) await waitFor(() => !isAlive(sh as number), 500);
      return { shAfter: cmd.shAfter, gcAfter: cmd.gcAfter, sh, gc };
    } finally {
      killSpawned(proc);
      await Promise.all([outP, errP]).catch(() => undefined);
      killPid(sh);
      killPid(gc);
    }
  }

  test("#75 neo -p 在独立进程组收到 SIGINT 后，前台 shell 与孙进程都不得写盘", async () => {
    const r = await runPlainPAndSignal("SIGINT");
    expect(existsSync(r.shAfter)).toBe(false);
    expect(existsSync(r.gcAfter)).toBe(false);
    if (r.sh !== null) expect(isAlive(r.sh)).toBe(false);
    if (r.gc !== null) expect(isAlive(r.gc)).toBe(false);
  }, 40_000);

  test("#75 neo -p 在独立进程组收到 SIGHUP 后，前台 shell 与孙进程都不得写盘", async () => {
    const r = await runPlainPAndSignal("SIGHUP");
    expect(existsSync(r.shAfter)).toBe(false);
    expect(existsSync(r.gcAfter)).toBe(false);
    if (r.sh !== null) expect(isAlive(r.sh)).toBe(false);
    if (r.gc !== null) expect(isAlive(r.gc)).toBe(false);
  }, 40_000);
});

describe("#75 ACP 信号须回收后台 shell 的孙进程", () => {
  async function runAcpAndSignal(sig: NodeJS.Signals): Promise<{ gcAfter: string; gc: number | null }> {
    const dir = project();
    const cmd = grandchildOnlyCmd(dir);
    shellCommand = JSON.stringify({ command: cmd.command, background: true });
    const proc = Bun.spawn(["bun", INDEX, "acp"], {
      cwd: dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
    });
    const decoder = new TextDecoder();
    let buf = "";
    const messages: Array<{ id?: unknown; method?: unknown; result?: unknown }> = [];
    const waiters: Array<{ pred: (m: (typeof messages)[0]) => boolean; resolve: (m: (typeof messages)[0]) => void }> =
      [];
    const write = (line: string): void => {
      try {
        proc.stdin.write(line);
        proc.stdin.flush();
      } catch {
        /* 已退出 */
      }
    };
    const errP = (async () => {
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        void decoder.decode(chunk, { stream: true });
      }
    })();
    const loop = (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl === -1) break;
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === "") continue;
          let msg: (typeof messages)[0];
          try {
            msg = JSON.parse(line) as (typeof messages)[0];
          } catch {
            continue;
          }
          messages.push(msg);
          for (const w of [...waiters]) {
            if (w.pred(msg)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(msg);
            }
          }
        }
      }
    })();
    const waitForMsg = (pred: (m: (typeof messages)[0]) => boolean, ms: number) =>
      new Promise<(typeof messages)[0] | null>((resolve) => {
        const existing = messages.find(pred);
        if (existing) {
          resolve(existing);
          return;
        }
        const t = setTimeout(() => resolve(null), ms);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(t);
            resolve(m);
          },
        });
      });
    let gc: number | null = null;
    try {
      write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "issue75-signals", title: "t", version: "0" },
          },
        }) + "\n",
      );
      const init = await waitForMsg((m) => m.id === 1 && m.result !== undefined, 8_000);
      expect(init).not.toBeNull();
      write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: dir, mcpServers: [] } }) + "\n");
      const created = await waitForMsg((m) => m.id === 2 && m.result !== undefined, 8_000);
      const sessionId = (created?.result as { sessionId?: unknown } | undefined)?.sessionId;
      expect(typeof sessionId).toBe("string");
      write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text: "起后台命令" }] },
        }) + "\n",
      );
      const done = await waitForMsg((m) => m.id === 3 && m.result !== undefined, 20_000);
      expect(done).not.toBeNull();
      expect(await waitForFile(cmd.gcPid, 5_000)).toBe(true);
      gc = readPid(cmd.gcPid);
      expect(gc).not.toBeNull();
      signalSpawned(proc, sig);
      const exited = await Promise.race([
        proc.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      if (!exited) killSpawned(proc);
      await Promise.race([proc.exited, Bun.sleep(1_000)]);
      if (gc !== null) await waitFor(() => !isAlive(gc as number), 2_000);
      return { gcAfter: cmd.gcAfter, gc };
    } finally {
      killSpawned(proc);
      void loop;
      void errP;
      killPid(gc);
    }
  }

  test("#75 ACP 收到 SIGTERM 后，后台 shell 的孙进程不得写盘", async () => {
    const r = await runAcpAndSignal("SIGTERM");
    expect(existsSync(r.gcAfter)).toBe(false);
    if (r.gc !== null) expect(isAlive(r.gc)).toBe(false);
  }, 40_000);

  test("#75 ACP 收到 SIGHUP 后，后台 shell 的孙进程不得写盘", async () => {
    const r = await runAcpAndSignal("SIGHUP");
    expect(existsSync(r.gcAfter)).toBe(false);
    if (r.gc !== null) expect(isAlive(r.gc)).toBe(false);
  }, 40_000);
});

describe("#75 TUI onTerm/onCrash 须回收后台 shell", () => {
  test("#75 TUI onTerm/onCrash 必须回收后台 shell", () => {
    const src = readFileSync(join(import.meta.dir, "../src/cli/inputLayer.ts"), "utf8");
    const reapStart = src.indexOf("const reapSession");
    const crashStart = src.indexOf("const onCrash");
    expect(reapStart).toBeGreaterThan(0);
    expect(crashStart).toBeGreaterThan(reapStart);
    const reapBody = src.slice(reapStart, crashStart);
    const onCrash = src.slice(crashStart, src.indexOf('process.on("SIGINT", onSigintTui)'));
    // 共享 reapSession：崩溃与 SIGTERM/SIGHUP 都走 cleanupEphemeralResources。
    expect(/cleanupEphemeralResources\s*\(/.test(reapBody)).toBe(true);
    expect(/reapSession\s*\(/.test(onCrash)).toBe(true);
    expect(src).toMatch(/signals:\s*\[\s*"SIGTERM"\s*,\s*"SIGHUP"\s*\]/);
    expect(src).toMatch(/cleanup:\s*reapSession/);
  });
});
