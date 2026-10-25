/**
 * P0-6：`-p --output-format json` 与退出码。
 *
 * 用本地假 OpenAI 端点 spawn 真实 CLI 进程，断言：
 *  - json 模式 stdout 只有一行可解析 JSON、无 ANSI；
 *  - 成功 / LLM 失败 / 参数错误 的退出码分别为 0 / 1 / 2；
 *  - text 模式输出保持原样（回归）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-cli-json-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

const enc = new TextEncoder();
const EVENTS =
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
      return new Response(EVENTS, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => {
  server.stop(true);
  rmSync(SANDBOX, { recursive: true, force: true });
});

/** 每个用例一个独立工作目录 + 最小 settings.json（不读用户真实配置）。 */
function project(baseUrl: string, retry = 1): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
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
        retry: {
          max_attempts: retry,
          base_delay_ms: 1,
          connect_timeout_ms: 2_000,
          stream_idle_timeout_ms: 2_000,
        },
        memory: { enabled: false },
      },
      null,
      2,
    ),
    "utf8",
  );
  return dir;
}

async function run(cwd: string, args: string[]): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NEO_SESSIONS_DIR: sessionsDir,
      NEO_MEMORY_DISABLE: "1",
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

describe("P0-6 -p --output-format json", () => {
  test("成功：stdout 单行 JSON、字段齐全、exit 0", async () => {
    const dir = project(BASE);
    const r = await run(dir, ["-p", "hello", "-y", "--output-format", "json"]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const j = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(j["v"]).toBe(1);
    expect(j["ok"]).toBe(true);
    expect(j["exit_code"]).toBe(0);
    expect(j["answer"]).toBe("hi");
    expect(j["error"]).toBeNull();
    expect(j["finish_reason"]).toBe("stop");
    expect(j["usage"]).toEqual({ prompt: 11, completion: 2, reasoning: 0 });
    expect(typeof j["session_id"]).toBe("string");
    expect(r.out).not.toMatch(/\x1b\[/);
  });

  test("LLM 失败：exit 1、ok=false、error 可读、stdout 仍可解析", async () => {
    const dir = project("http://127.0.0.1:9/v1", 1);
    const r = await run(dir, ["-p", "hello", "-y", "--output-format", "json"]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out.trim()) as Record<string, unknown>;
    expect(j["ok"]).toBe(false);
    expect(j["exit_code"]).toBe(1);
    expect(String(j["error"])).toContain("网络请求失败");
  });

  test("参数错误：--output-format 非法 → exit 2，stdout 为空", async () => {
    const dir = project(BASE);
    const r = await run(dir, ["-p", "hello", "--output-format", "yaml"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
  });

  test("text 模式输出保持原样（回归）", async () => {
    const dir = project(BASE);
    const r = await run(dir, ["-p", "hello", "-y"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("hi");
    expect(r.out.trim().startsWith("{")).toBe(false);
  });
});
