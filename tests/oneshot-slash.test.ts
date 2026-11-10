/**
 * issue #41：`-p` / 非交互路径遇到**行首已知斜杠命令**时明确提示不可用。
 *
 * 背景：PRD（docs/goal-drive-prd[done].md）写「-p 不提供 /drive（命令会明确提示不可用）」，
 * 但实现里 -p 根本不解析斜杠命令，`neo -p "/drive …"` 会把整串当 prompt 发给模型。
 *
 * 覆盖：
 *  A1 `-p "/drive …"` → 退出码 2、提示可读、**一次模型请求都不发**
 *  A2 `-p "/notacommand hi"` → 不算命令，按普通 prompt 发出去（不误伤）
 *  A3 `args.rest` 非 TTY 路径同样拦截
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-oneshot-slash-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

const enc = new TextEncoder();
const ANSWER =
  'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
  "data: [DONE]\n\n";

/** 模型请求计数：A1 断言「一次都没发」。 */
let hits = 0;

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "fake-model" }] });
    if (url.pathname.endsWith("/chat/completions")) {
      hits += 1;
      return new Response(ANSWER, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => {
  server.stop(true);
  rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  hits = 0;
});

function writeSettings(dir: string): void {
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

async function run(dir: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NEO_SESSIONS_DIR: sessionsDir, NEO_MEMORY_DISABLE: "1" },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

describe("A -p / 非交互路径的斜杠命令（issue #41）", () => {
  test("A1 -p 已知斜杠命令：退出码 2、提示不可用、不发模型请求", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "/drive bun test -- 修到绿"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("不解析斜杠命令");
    expect(r.err).toContain("drive");
    expect(hits).toBe(0);
  }, 30_000);

  test("A2 -p 未知斜杠文本：不算命令，按普通 prompt 发出去（不误伤）", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "/notacommand hi"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("hi");
    expect(hits).toBeGreaterThan(0);
  }, 30_000);

  test("A3 args.rest 非 TTY 路径同样拦截", async () => {
    const dir = project();
    const proc = Bun.spawn(["bun", INDEX, "-y", "/rewind last"], {
      cwd: dir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NEO_SESSIONS_DIR: sessionsDir, NEO_MEMORY_DISABLE: "1" },
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(err).toContain("不解析斜杠命令");
    expect(hits).toBe(0);
  }, 30_000);
});
