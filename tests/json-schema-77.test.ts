/**
 * #77：`-p --json-schema` 结构化输出。
 *
 * 本地假 OpenAI 端点 + spawn 真实 CLI。覆盖拍板澄清：
 *  非法 schema / 缺值 / 缺文件 / 不可编译 $schema → exit 2、0 次模型请求；
 *  一次过 / 回喂成功 / 回喂耗尽；text / json / stream-json 形状；
 *  抽取偏严、format 不强制、draft-07 与 2020-12、请求体无原生 response_format；
 *  drive 结束后回喂不重跑检查命令、model_done 保持 3；帮助文案披露。
 * 不宣称与 Claude Code / Codex 兼容。不把本单写成修 D1。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { helpText } from "../src/cli/help.ts";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-json-schema-77-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

const OBJECT_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
const SCHEMA = JSON.stringify(OBJECT_SCHEMA);
const ARRAY_SCHEMA = JSON.stringify({ type: "array", items: { type: "number" } });
const EMAIL_SCHEMA = JSON.stringify({
  type: "object",
  properties: { email: { type: "string", format: "email" } },
  required: ["email"],
});
const DRAFT07_SCHEMA = JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
});
const DRAFT2020_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
});

/** 非 judge 的 chat/completions 次数（本单计「模型请求」用这个）。 */
let hits = 0;
/** 含 judge 在内的全部请求体，用来断言没有原生 response_format / text.format。 */
const bodies: unknown[] = [];
/** 按非 judge 请求序号返回的助手正文；超出则重复最后一项。 */
let script: string[] = ['{"ok": true}'];
/** 从第 N 次非 judge 请求起卡住，供 SIGINT 用例。 */
let hangFrom: number | null = null;
/** 先回一次 shell true（测 text 进度走 stderr），只发一次，避免工具循环把最后一条消息角色搅乱。 */
let pendingToolCall = false;

function sse(content: string): Response {
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
    "data: [DONE]\n\n";
  return new Response(payload, { headers: { "content-type": "text/event-stream" } });
}

function sseToolCall(): Response {
  const args = JSON.stringify({ command: "true" });
  const frames =
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_fake_shell", type: "function", function: { name: "shell", arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }],
    })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

function sseJudge(done: boolean): Response {
  return sse(JSON.stringify({ done, reason: done ? "模型认为完成" : "还没好" }));
}

const hangingStream = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start() {
        /* 故意不 enqueue / 不 close：模拟卡住的流 */
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "fake-model" }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content: unknown }>;
        response_format?: unknown;
        text?: unknown;
      };
      bodies.push(body);
      const text = JSON.stringify(body.messages ?? []);
      if (text.includes("完成条件判定器")) {
        return sseJudge(true);
      }
      hits += 1;
      if (hangFrom !== null && hits >= hangFrom) return hangingStream();
      if (pendingToolCall) {
        pendingToolCall = false;
        return sseToolCall();
      }
      const reply = script[Math.min(hits - 1, script.length - 1)] ?? "";
      return sse(reply);
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
  bodies.length = 0;
  script = ['{"ok": true}'];
  hangFrom = null;
  pendingToolCall = false;
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
        retry: {
          max_attempts: 1,
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
}

function project(): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir);
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function signalSpawnedBun(proc: Bun.Subprocess, signal: NodeJS.Signals = "SIGINT"): void {
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
  const targets = kids.length > 0 ? kids : [proc.pid];
  for (const pid of targets) {
    try {
      process.kill(pid, signal);
    } catch {
      /* 已退出 */
    }
  }
}

async function run(
  cwd: string,
  args: string[],
  opts: { stdin?: "ignore" | "pipe" } = {},
): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin ?? "ignore",
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

function common(extra: string[] = []): string[] {
  return ["-y", "--auto", "off", "--no-fallback", ...extra];
}

function parseJsonLine(text: string): Record<string, unknown> {
  const lines = text.trim().split("\n");
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

function parseJsonl(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

function assertNoNativeStructuredOutput(): void {
  const blob = JSON.stringify(bodies);
  expect(blob.includes("response_format")).toBe(false);
  expect(blob.includes("text.format")).toBe(false);
  for (const body of bodies) {
    const rec = body as Record<string, unknown>;
    expect(rec["response_format"]).toBeUndefined();
    const text = rec["text"];
    if (text && typeof text === "object") {
      expect((text as Record<string, unknown>)["format"]).toBeUndefined();
    }
  }
}

describe("77-1 非法 schema / 用法错误：exit 2、0 次模型请求", () => {
  test("缺值（旗标悬空）→ exit 2，stderr 有诊断，0 次请求", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--json-schema"]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  }, 30_000);

  test("等号空值 --json-schema= → exit 2，0 次请求", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--json-schema="]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  }, 30_000);

  test("文件不存在 → exit 2，stderr 有诊断，0 次请求", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--json-schema", "no-such-schema.json"]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  }, 30_000);

  test("JSON 解析失败 → exit 2，0 次请求", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--json-schema", "{"]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  }, 30_000);

  test("不是可编译的 JSON Schema → exit 2，0 次请求", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--json-schema",
      JSON.stringify({ type: "object", properties: "not-an-object" }),
    ]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  }, 30_000);

  test("无法编译的 $schema → exit 2，0 次请求", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--json-schema",
      JSON.stringify({ $schema: "https://json-schema.org/draft/9999-99/schema", type: "object" }),
    ]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  }, 30_000);

  test("无 -p 仅带 --json-schema → exit 2，0 次请求", async () => {
    const dir = project();
    const r = await run(dir, ["--json-schema", SCHEMA, ...common()]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  }, 30_000);

  test("与 acp 同用 → exit 2，0 次请求", async () => {
    const dir = project();
    const r = await run(dir, ["acp", "--json-schema", SCHEMA]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(hits).toBe(0);
  }, 30_000);

  test("stream-json 非法 schema → stdout 为 error+result（usage_error / 2），0 次请求", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--output-format",
      "stream-json",
      "--json-schema",
      "{",
    ]);
    expect(r.code).toBe(2);
    expect(hits).toBe(0);
    const events = parseJsonl(r.out);
    expect(events.map((e) => e.type)).toEqual(["error", "result"]);
    expect(events[0]!.data["code"] ?? events[0]!.data["status"]).toBeDefined();
    expect(events[1]!.data["status"]).toBe("usage_error");
    expect(events[1]!.data["exit_code"]).toBe(2);
    expect("structured_output" in events[1]!.data).toBe(false);
    expect(r.err.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("77-2 合法 schema、一次过", () => {
  test("json：structured_output 为解析后的值，answer 仍在，exit 0；请求体无 response_format", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--output-format",
      "json",
      "--json-schema",
      SCHEMA,
    ]);
    expect(r.code).toBe(0);
    expect(hits).toBe(1);
    const j = parseJsonLine(r.out);
    expect(j["ok"]).toBe(true);
    expect(j["exit_code"]).toBe(0);
    expect(j["answer"]).toBe('{"ok": true}');
    expect(j["structured_output"]).toEqual({ ok: true });
    expect(j["error"]).toBeNull();
    assertNoNativeStructuredOutput();
  }, 30_000);

  test("json：structured_output 可以是数组", async () => {
    script = ["[1, 2, 3]"];
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--output-format",
      "json",
      "--json-schema",
      ARRAY_SCHEMA,
    ]);
    expect(r.code).toBe(0);
    const j = parseJsonLine(r.out);
    expect(j["structured_output"]).toEqual([1, 2, 3]);
    expect(j["answer"]).toBe("[1, 2, 3]");
  }, 30_000);

  test("text（默认 format，只带 --json-schema）：stdout 只有紧凑单行 JSON，进度/工具在 stderr", async () => {
    pendingToolCall = true;
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--json-schema", SCHEMA]);
    expect(r.code).toBe(0);
    expect(r.out).toBe('{"ok":true}\n');
    expect(r.out).not.toMatch(/\x1b\[/);
    // 工具进度不得出现在 stdout；stderr 才是进度通道
    expect(r.err.length).toBeGreaterThan(0);
    assertNoNativeStructuredOutput();
  }, 30_000);

  test("text：数组值同样打成紧凑单行", async () => {
    script = ["[1, 2, 3]"];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "text", "--json-schema", ARRAY_SCHEMA]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("[1,2,3]\n");
  }, 30_000);

  test("stream-json：仅最终 result 带 structured_output，中间事件没有该键", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--output-format",
      "stream-json",
      "--json-schema",
      SCHEMA,
    ]);
    expect(r.code).toBe(0);
    const events = parseJsonl(r.out);
    const result = events.filter((e) => e.type === "result");
    expect(result).toHaveLength(1);
    expect(result[0]!.data["status"]).toBe("completed");
    expect(result[0]!.data["exit_code"]).toBe(0);
    expect(result[0]!.data["structured_output"]).toEqual({ ok: true });
    for (const ev of events) {
      if (ev.type !== "result") {
        expect("structured_output" in ev.data).toBe(false);
      }
    }
  }, 30_000);

  test("判断 inline / 路径前先 trim：空白包裹的 inline、@path、普通路径、等号形式都生效", async () => {
    const dir = project();
    writeFileSync(join(dir, "schema.json"), SCHEMA, "utf8");

    const inline = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", `  ${SCHEMA}  `]);
    expect(inline.code).toBe(0);
    expect((parseJsonLine(inline.out)["structured_output"] as { ok: boolean }).ok).toBe(true);

    const at = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", "  @schema.json  "]);
    expect(at.code).toBe(0);
    expect((parseJsonLine(at.out)["structured_output"] as { ok: boolean }).ok).toBe(true);

    const path = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", "  schema.json  "]);
    expect(path.code).toBe(0);
    expect((parseJsonLine(path.out)["structured_output"] as { ok: boolean }).ok).toBe(true);

    const eq = await run(dir, ["-p", "hello", ...common(), "--output-format=json", `--json-schema=${SCHEMA}`]);
    expect(eq.code).toBe(0);
    expect((parseJsonLine(eq.out)["structured_output"] as { ok: boolean }).ok).toBe(true);
  }, 30_000);

  test("路径相对 args.cwd（-C），@path 去掉 @ 再读", async () => {
    const dir = project();
    const sub = join(dir, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "schema.json"), SCHEMA, "utf8");
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "-C",
      sub,
      "--output-format",
      "json",
      "--json-schema",
      "@schema.json",
    ]);
    expect(r.code).toBe(0);
    expect(parseJsonLine(r.out)["structured_output"]).toEqual({ ok: true });
  }, 30_000);
});

describe("77-3 回喂后成功（含空答案 / 围栏偏严）", () => {
  test("先不合规再成功：json 带字段，exit 0，恰好 2 次请求（不超过 2 次回喂）", async () => {
    script = ['{"ok": "no"}', '{"ok": true}'];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(r.code).toBe(0);
    expect(hits).toBe(2);
    const j = parseJsonLine(r.out);
    expect(j["structured_output"]).toEqual({ ok: true });
    expect(j["ok"]).toBe(true);
  }, 30_000);

  test("空答案视为抽取失败并回喂，随后成功", async () => {
    script = ["   ", '{"ok": true}'];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(r.code).toBe(0);
    expect(hits).toBe(2);
    expect(parseJsonLine(r.out)["structured_output"]).toEqual({ ok: true });
  }, 30_000);

  test("围栏外还有叙述：不抽取，回喂后成功", async () => {
    script = ['Here is the result:\n```json\n{"ok": true}\n```\n', '{"ok": true}'];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(r.code).toBe(0);
    expect(hits).toBe(2);
  }, 30_000);

  test("多个围栏：不抽取，回喂后成功", async () => {
    script = ['```json\n{"ok": true}\n```\n```json\n{"ok": false}\n```', '{"ok": true}'];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(r.code).toBe(0);
    expect(hits).toBe(2);
  }, 30_000);

  test("叙述里第一个 { 不抽取，回喂后成功", async () => {
    script = ['The result is {"ok": true} as requested.', '{"ok": true}'];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(r.code).toBe(0);
    expect(hits).toBe(2);
  }, 30_000);

  test("半段 JSON：不抽取，回喂后成功", async () => {
    script = ['{"ok":', '{"ok": true}'];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(r.code).toBe(0);
    expect(hits).toBe(2);
  }, 30_000);

  test("整段 JSON 允许前后空白；单个 json 围栏与普通围栏可抽取，一次过", async () => {
    const dir = project();

    script = ['  \n{"ok": true}\n  '];
    const whole = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(whole.code).toBe(0);
    expect(hits).toBe(1);
    expect(parseJsonLine(whole.out)["structured_output"]).toEqual({ ok: true });

    hits = 0;
    script = ['```json\n{"ok": true}\n```'];
    const fenced = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(fenced.code).toBe(0);
    expect(hits).toBe(1);
    expect(parseJsonLine(fenced.out)["structured_output"]).toEqual({ ok: true });

    hits = 0;
    script = ['```\n{"ok": true}\n```'];
    const plain = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(plain.code).toBe(0);
    expect(hits).toBe(1);
    expect(parseJsonLine(plain.out)["structured_output"]).toEqual({ ok: true });
  }, 30_000);
});

describe("77-4 回喂耗尽仍不合规", () => {
  test("json：省略 structured_output，answer 仍保留原文，ok=false，exit 1；恰好 3 次尝试", async () => {
    script = ["not json", "still not", '{"ok": "no"}'];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA]);
    expect(r.code).toBe(1);
    expect(hits).toBe(3);
    const j = parseJsonLine(r.out);
    expect("structured_output" in j).toBe(false);
    expect(j["ok"]).toBe(false);
    expect(j["exit_code"]).toBe(1);
    expect(j["answer"]).toBe('{"ok": "no"}');
    expect(j["answer"]).not.toBeNull();
  }, 30_000);

  test("text：stdout 不打正文（不要把原始叙述或半段 JSON 打出去），exit 1，stderr 有诊断", async () => {
    script = ["not json", "still not", "The result is {ok:true}"];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--json-schema", SCHEMA]);
    expect(r.code).toBe(1);
    expect(hits).toBe(3);
    expect(r.out.trim()).toBe("");
    expect(r.out).not.toContain("The result is");
    expect(r.out).not.toContain("{");
    expect(r.err.length).toBeGreaterThan(0);
  }, 30_000);

  test("stream-json：因 schema 把 0 改成 1 时 status=failed，result 无该字段，中间事件也没有", async () => {
    script = ["nope", "nope", "nope"];
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--output-format",
      "stream-json",
      "--json-schema",
      SCHEMA,
    ]);
    expect(r.code).toBe(1);
    expect(hits).toBe(3);
    const events = parseJsonl(r.out);
    const result = events.filter((e) => e.type === "result");
    expect(result).toHaveLength(1);
    expect(result[0]!.data["status"]).toBe("failed");
    expect(result[0]!.data["exit_code"]).toBe(1);
    expect("structured_output" in result[0]!.data).toBe(false);
    for (const ev of events) {
      if (ev.type !== "result") expect("structured_output" in ev.data).toBe(false);
    }
  }, 30_000);
});

describe("77-5 drive / SIGINT / 无旗标回归 / 帮助文案", () => {
  test("drive 检查通过后回喂成功：exit 0，检查命令只跑 1 次（不重跑），请求次数含回喂", async () => {
    script = ["not json", '{"ok": true}'];
    const dir = project();
    const checkFile = join(dir, "check-runs.txt");
    const checkCmd = `sh -c 'echo ran >> "${checkFile}"; exit 0'`;
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--drive",
      checkCmd,
      "--max",
      "1",
      "--output-format",
      "json",
      "--json-schema",
      SCHEMA,
    ]);
    expect(r.code).toBe(0);
    expect(hits).toBe(2);
    const j = parseJsonLine(r.out);
    expect(j["structured_output"]).toEqual({ ok: true });
    const runs = readFileSync(checkFile, "utf8").trim().split("\n");
    expect(runs).toEqual(["ran"]);
  }, 30_000);

  test("drive 检查通过但回喂耗尽：原会是 0 的改为 1，省略字段，检查命令仍只跑 1 次", async () => {
    script = ["nope", "nope", "nope"];
    const dir = project();
    const checkFile = join(dir, "check-runs.txt");
    const checkCmd = `sh -c 'echo ran >> "${checkFile}"; exit 0'`;
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--drive",
      checkCmd,
      "--output-format",
      "json",
      "--json-schema",
      SCHEMA,
    ]);
    expect(r.code).toBe(1);
    expect(hits).toBe(3);
    const j = parseJsonLine(r.out);
    expect(j["ok"]).toBe(false);
    expect("structured_output" in j).toBe(false);
    expect(j["answer"]).not.toBeNull();
    const runs = readFileSync(checkFile, "utf8").trim().split("\n");
    expect(runs).toEqual(["ran"]);
  }, 30_000);

  test("drive model_done + 字段缺失：保持 exit 3 与 model_done，省略字段", async () => {
    script = ["nope", "nope", "nope"];
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--judge",
      "完成即可",
      "--output-format",
      "stream-json",
      "--json-schema",
      SCHEMA,
    ]);
    expect(hits).toBe(3);
    expect(r.code).toBe(3);
    const events = parseJsonl(r.out);
    const result = events.find((e) => e.type === "result");
    expect(result).toBeDefined();
    expect(result!.data["status"]).toBe("model_done");
    expect(result!.data["exit_code"]).toBe(3);
    expect("structured_output" in result!.data).toBe(false);
  }, 30_000);

  test("drive model_done + 校验通过：仍为 exit 3，但字段出现", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      ...common(),
      "--judge",
      "完成即可",
      "--output-format",
      "json",
      "--json-schema",
      SCHEMA,
    ]);
    expect(r.code).toBe(3);
    const j = parseJsonLine(r.out);
    expect(j["ok"]).toBe(false);
    expect(j["exit_code"]).toBe(3);
    expect(j["structured_output"]).toEqual({ ok: true });
    expect(j["answer"]).toBe('{"ok": true}');
  }, 30_000);

  test("回喂中途 SIGINT：exit 130，省略 structured_output（json 既有 aborted 契约不变）", async () => {
    script = ["not json"];
    hangFrom = 2;
    const dir = project();
    const proc = Bun.spawn(
      ["bun", INDEX, "-p", "hello", ...common(), "--output-format", "json", "--json-schema", SCHEMA],
      {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: {
          ...process.env,
          NEO_SESSIONS_DIR: sessionsDir,
          NEO_MEMORY_DISABLE: "1",
        },
      },
    );
    await sleep(800);
    signalSpawnedBun(proc, "SIGINT");
    const [out, , code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(130);
    const j = JSON.parse(out.trim()) as Record<string, unknown>;
    expect(j["aborted"]).toBe(true);
    expect(j["exit_code"]).toBe(130);
    expect(j["ok"]).toBe(false);
    expect("structured_output" in j).toBe(false);
  }, 30_000);

  test("无旗标时 json 形状不变：没有 structured_output 键", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json"]);
    expect(r.code).toBe(0);
    const j = parseJsonLine(r.out);
    expect(j["answer"]).toBe('{"ok": true}');
    expect("structured_output" in j).toBe(false);
    expect(j["v"]).toBe(1);
    expect(j["ok"]).toBe(true);
  }, 30_000);

  test("无旗标时 text 形状不变", async () => {
    script = ["hi"];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("hi");
    expect(r.out.trim().startsWith("{")).toBe(false);
  }, 30_000);

  test("--json-schema 不强制 -y：无工具时不带 -y 也能一次过", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p",
      "hello",
      "--auto",
      "off",
      "--no-fallback",
      "--output-format",
      "json",
      "--json-schema",
      SCHEMA,
    ]);
    expect(r.code).toBe(0);
    expect(parseJsonLine(r.out)["structured_output"]).toEqual({ ok: true });
  }, 30_000);

  test("帮助文案披露 --json-schema，以及 drive 结束后回喂可能再调工具、改变工作区、不重跑检查命令", () => {
    const help = helpText();
    expect(help).toContain("--json-schema");
    expect(help).not.toContain("--output-schema");
    expect(help).toMatch(/回喂.*工具|再调工具/);
    expect(help).toMatch(/改变工作区|工作区/);
    expect(help).toMatch(/不重跑检查命令|不会重跑检查命令/);
  });
});

describe("77-7 format 注解不强制；draft-07 与 2020-12 可编译", () => {
  test("带未知/不校验 format 的合法实例应通过", async () => {
    script = ['{"email": "not-an-email"}'];
    const dir = project();
    const r = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", EMAIL_SCHEMA]);
    expect(r.code).toBe(0);
    expect(parseJsonLine(r.out)["structured_output"]).toEqual({ email: "not-an-email" });
  }, 30_000);

  test("draft-07 与 2020-12 都能编译并一次过", async () => {
    const dir = project();
    const d7 = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", DRAFT07_SCHEMA]);
    expect(d7.code).toBe(0);
    expect(parseJsonLine(d7.out)["structured_output"]).toEqual({ ok: true });

    hits = 0;
    const d20 = await run(dir, ["-p", "hello", ...common(), "--output-format", "json", "--json-schema", DRAFT2020_SCHEMA]);
    expect(d20.code).toBe(0);
    expect(parseJsonLine(d20.out)["structured_output"]).toEqual({ ok: true });
  }, 30_000);
});
