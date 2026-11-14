/**
 * #37 stream-json v1 端到端验收：真实 CLI 子进程 + 本地假 OpenAI SSE 端点 + 临时 sandbox settings.json。
 *
 * 范式沿用 tests/cli-json.test.ts（Bun.serve port 0 / mkdtempSync / writeSettings / Bun.spawn）。
 * 覆盖 37-A…E，断言全部落在「真实进程 stdout/stderr/exit code」上，不做 mock.module。
 *
 * 覆盖边界（如实声明，不谎称覆盖）：
 *  - 37-A 全部子项在本文件真实进程断言。
 *  - 37-B 在本文件真实进程断言：call_id 配对、tool_started→tool_finished 顺序、
 *    ClippedText 结构、敏感键 [REDACTED]、无 reasoning/thinking_blocks/raw/key 泄漏。
 *    以下子项由已提交的单元测试覆盖（本文件不重复声称）：4000 code point 截断与
 *    emoji 代理对（stream-json.test.ts C/F/K）、递归脱敏深度边界（D/E）、工具层
 *    truncated 透传（G）、status 三态完整映射与并行段原序（agent-stream-events.test.ts A/B）、
 *    同一 send() 多轮工具循环（C）、finish_reason=length（E）。
 *  - 37-C 全部子项在本文件真实进程断言（含 text / 单行 json 形状回归）。
 *  - 37-D verified / model done / 未达成三类终态均在本文件真实进程断言。
 *  - 37-E 用「注入 EPIPE」的真实 CLI 子进程断言全部语义（exit 1、恰一条 stderr 诊断、
 *    不再写 stdout、无第二个 result、不挂死、无遗留进程），并额外做一次真实下游提前关闭
 *    的不挂死断言。Windows/Cygwin 上 Bun 对已关闭的原生管道 stdout 写入会静默丢弃、
 *    不上抛 error 事件，因此物理管道关闭无法触发可观察的 EPIPE；这一环境限制在回报中如实记录，
 *    不新增必然失败的 SIGINT 断言，也不放宽任何既有断言。
 *
 * JSONL writer 的公开接口（src/streamJson.ts）已冻结，本文件只消费它产生的 stdout。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INDEX = join(import.meta.dir, "..", "src", "index.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-cli-stream-json-")));
const sessionsDir = join(SANDBOX, "sessions");
let seq = 0;

/** 工具调用参数里的脱敏标记（纯测试标记，不是真实凭据）。 */
const REDACT_MARKER = "NEO37B_MARKER_VALUE";
/** shell 工具名与 call_id：真实 CLI 内置工具，无需注册。 */
const TOOL_CALL_ID = "call_37b_1";
const TOOL_NAME = "shell";

type ServerMode = "plain" | "tool";
let mode: ServerMode = "plain";
let hits = 0;
let judgeDone = false;
let toolFirstDone = false;

const STDOUT_CLOSED_DIAGNOSTIC = "[stream-json] stdout closed; aborting";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function sse(content: string): Response {
  const payload =
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n` +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n' +
    "data: [DONE]\n\n";
  return new Response(payload, { headers: { "content-type": "text/event-stream" } });
}

/** OpenAI 流式 tool_calls 帧：arguments 里带一个敏感键，用于验证递归脱敏。 */
function sseToolCall(): Response {
  const args = JSON.stringify({
    command: "echo tool-ok",
    api_key: REDACT_MARKER,
    note: "keep-me",
  });
  const frames =
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: TOOL_CALL_ID,
                type: "function",
                function: { name: TOOL_NAME, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
          finish_reason: null,
        },
      ],
    })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(frames, { headers: { "content-type": "text/event-stream" } });
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "fake-model" }] });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      hits += 1;
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      const text = JSON.stringify(body.messages ?? []);
      // #50/#51 完成条件判定器是独立小请求，别让它消耗主回合的脚本。
      if (text.includes("完成条件判定器")) {
        return sse(
          judgeDone
            ? '{"done": true, "reason": "模型认为完成"}'
            : '{"done": false, "reason": "还没好"}',
        );
      }
      if (mode === "tool") {
        if (!toolFirstDone) {
          toolFirstDone = true;
          return sseToolCall();
        }
        return sse("最终答案：完成");
      }
      return sse("hi");
    }
    return new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${server.port}/v1`;

/** 每个用例一个独立工作目录；settings 不读用户真实配置。 */
function writeSettings(dir: string, retry = 1, idleTimeoutMs = 2_000): void {
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
          max_attempts: retry,
          base_delay_ms: 1,
          connect_timeout_ms: 2_000,
          stream_idle_timeout_ms: idleTimeoutMs,
        },
        memory: { enabled: false },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function project(retry = 1, idleTimeoutMs = 2_000): string {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir, retry, idleTimeoutMs);
  return dir;
}

function childEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    NEO_SESSIONS_DIR: sessionsDir,
    NEO_MEMORY_DISABLE: "1",
  };
}

/** 给「不挂死」类断言加硬超时，避免拖住测试进程。 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function run(
  cwd: string,
  args: string[],
): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn(["bun", INDEX, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(),
  });
  const [out, err, code] = await withTimeout(
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]) as Promise<[string, string, number]>,
    30_000,
  );
  return { out, err, code };
}

/* ------------------------------------------------------------------ *
 * EPIPE 注入夹具：把 stdout 写失败注入到真实 CLI 进程里。
 *
 * Windows/Cygwin 上关闭原生管道读端后，Bun 的 process.stdout.write 会静默丢弃
 * 后续写入、既不上抛也不发 error 事件，物理 EPIPE 无法被组合根观察到。因此这里
 * 用 bun --preload 在真实子进程里对 process.stdout.write 注入 EPIPE 异常（带
 * code="EPIPE"），走的是与真实 EPIPE 完全相同的 JsonlWriter.closeWithError →
 * onClosed → agent.cancel() → stdoutClosed → exit 1 路径。
 * ------------------------------------------------------------------ */

function preloadSource(failAfter: number): string {
  return `
const stdoutObj = process.stdout as any;
const originalWrite = stdoutObj.write.bind(stdoutObj);
let writes = 0;
stdoutObj.write = (chunk: any, ...rest: any[]): boolean => {
  writes += 1;
  if (writes > ${failAfter}) {
    const err: any = new Error("EPIPE");
    err.code = "EPIPE";
    throw err;
  }
  return originalWrite(chunk, ...rest);
};
`;
}

const PRELOAD_2 = join(SANDBOX, "epipe-preload-2.ts");
const PRELOAD_3 = join(SANDBOX, "epipe-preload-3.ts");
writeFileSync(PRELOAD_2, preloadSource(2), "utf8");
writeFileSync(PRELOAD_3, preloadSource(3), "utf8");

async function runWithEpipe(
  preload: string,
): Promise<{ out: string; err: string; code: number }> {
  const dir = project();
  const proc = Bun.spawn(
    [
      "bun",
      "--preload",
      preload,
      INDEX,
      "-p",
      "hello",
      "-y",
      "--auto",
      "off",
      "--output-format",
      "stream-json",
    ],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: childEnv() },
  );
  const [out, err, code] = await withTimeout(
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]) as Promise<[string, string, number]>,
    30_000,
  );
  return { out, err, code };
}

/** 用 ps -ef（Cygwin 兼容）统计命令行里仍带唯一标记的进程数。 */
function countMarkerProcesses(marker: string): number {
  const out = Bun.spawnSync(["ps", "-ef"], { stdout: "pipe", stderr: "pipe" });
  const text = new TextDecoder().decode(out.stdout);
  return text.split("\n").filter((line) => line.includes(marker)).length;
}

/* ------------------------------------------------------------------ *
 * JSONL 解析与通用信封断言
 * ------------------------------------------------------------------ */

interface RawEnvelope {
  schema_version: string;
  type: string;
  session_id: string | null;
  seq: number;
  timestamp: string;
  data: Record<string, unknown>;
}

/** 逐行 JSON.parse；同时排除 ANSI / banner / 数组括号 / 额外输出。 */
function parseLines(out: string): RawEnvelope[] {
  expect(out.includes("\x1b")).toBe(false);
  expect(out.endsWith("\n")).toBe(true);
  const parts = out.split("\n");
  expect(parts[parts.length - 1]).toBe("");
  const lines = parts.slice(0, -1);
  expect(lines.length).toBeGreaterThan(0);
  return lines.map((line) => {
    expect(line.startsWith("{")).toBe(true);
    expect(line.endsWith("}")).toBe(true);
    // 一行恰好一个 JSON object：唯一裸换行在末尾，字符串内换行已被 JSON 转义。
    expect(line.includes("\n")).toBe(false);
    expect(line.includes("\r")).toBe(false);
    return JSON.parse(line) as RawEnvelope;
  });
}

function assertEnvelopeShape(envs: RawEnvelope[], session: string | null): void {
  envs.forEach((env, index) => {
    expect(env.schema_version).toBe("1.0");
    expect(typeof env.type).toBe("string");
    expect(env.type.length).toBeGreaterThan(0);
    expect(env.seq).toBe(index + 1);
    expect(typeof env.timestamp).toBe("string");
    expect(env.timestamp).toMatch(ISO_RE);
    if (session === null) {
      expect(env.session_id).toBeNull();
    } else {
      expect(typeof env.session_id).toBe("string");
      expect(env.session_id).toBe(session);
    }
    expect(typeof env.data).toBe("object");
    expect(env.data).not.toBeNull();
    expect(Array.isArray(env.data)).toBe(false);
  });
}

function indexOfType(envs: RawEnvelope[], type: string): number {
  return envs.findIndex((env) => env.type === type);
}

function countType(envs: RawEnvelope[], type: string): number {
  return envs.filter((env) => env.type === type).length;
}

function isClippedText(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    Object.keys(obj).sort().join(",") === "original_chars,text,truncated" &&
    typeof obj.text === "string" &&
    typeof obj.truncated === "boolean" &&
    typeof obj.original_chars === "number"
  );
}

/**
 * 「无思考链 / 原始响应 / 凭据泄漏」的精确判定。
 *
 * 不能拿整段 stdout 做 includes("reasoning")：result.data.usage.reasoning 是
 * src/streamJson.ts 冻结契约里的合法用量字段（见 result.data.usage 的四个键）。
 * 因此逐信封检查，result 事件先剔除 usage，其余事件直接检查整个 data；
 * 同时钉住事件 type 必须是 v1 的 9 类之一，不允许夹带私有事件。
 */
function assertNoThinkingLeak(envs: RawEnvelope[]): void {
  const PUBLIC_TYPES = [
    "init", "turn_started", "assistant_message", "tool_started", "tool_finished",
    "model_fallback", "drive_finished", "error", "result",
  ];
  for (const env of envs) {
    expect(PUBLIC_TYPES).toContain(env.type);
    const rest: Record<string, unknown> = { ...env.data };
    delete rest["usage"];
    const payload = JSON.stringify(rest);
    expect(payload.includes("reasoning")).toBe(false);
    expect(payload.includes("thinking")).toBe(false);
    expect(payload.includes("signature")).toBe(false);
    expect(payload.includes("RAW_LEAK")).toBe(false);
    expect(payload.includes("THINK_LEAK")).toBe(false);
    expect(payload.includes(REDACT_MARKER)).toBe(false);
  }
}

afterAll(() => {
  server.stop(true);
  rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  mode = "plain";
  hits = 0;
  judgeDone = false;
  toolFirstDone = false;
});

/* ------------------------------------------------------------------ *
 * 37-A 普通成功
 * ------------------------------------------------------------------ */

describe("37-A 普通成功 -p --output-format stream-json", () => {
  test("A1 stdout 逐行 JSON.parse、seq 严格 1..N、恰好一个 result、exit 0、事件顺序 init→turn_started→assistant_message→result", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", "-y", "--auto", "off", "--output-format", "stream-json"]);

    expect(r.code).toBe(0);
    const envs = parseLines(r.out);
    expect(envs.length).toBeGreaterThanOrEqual(4);
    const session = envs[0]!.session_id;
    expect(typeof session).toBe("string");
    assertEnvelopeShape(envs, session);

    // 无额外 stdout：类型集合只能是 9 类公开事件之一，且不含内部事件名。
    const publicTypes = new Set([
      "init", "turn_started", "assistant_message", "tool_started", "tool_finished",
      "model_fallback", "drive_finished", "error", "result",
    ]);
    for (const env of envs) expect(publicTypes.has(env.type)).toBe(true);

    const types = envs.map((env) => env.type);
    expect(types).toEqual(["init", "turn_started", "assistant_message", "result"]);
    expect(countType(envs, "result")).toBe(1);
    expect(indexOfType(envs, "result")).toBe(envs.length - 1);

    const init = envs[0]!.data;
    expect(init.output_format).toBe("stream-json");
    expect(init.provider).toBe("fake");
    expect(init.model).toBe("fake-model");
    expect(init.model_tier).toBe("default");
    expect(init.drive).toBe(false);

    const turn = envs[1]!.data;
    expect(turn.turn).toBe(1);

    const assistant = envs[2]!.data;
    expect(assistant.content).toBe("hi");
    expect(assistant.tool_calls).toEqual([]);
    expect(assistant.finish_reason).toBe("stop");
    expect(assistant.truncated).toBe(false);
    // assistant_message 白名单：按 src/streamJson.ts:95-104 的冻结契约，
    // 共 7 个字段（含 turn），且不含 reasoning / thinking_blocks / raw / 签名思考块。
    expect(assistant.turn).toBe(1);
    expect(Object.keys(assistant).sort()).toEqual(
      ["content", "finish_reason", "model", "provider", "tool_calls", "truncated", "turn"].sort(),
    );

    const result = envs[envs.length - 1]!.data;
    expect(result.status).toBe("completed");
    expect(result.exit_code).toBe(0);
    expect(result.drive).toBeNull();
    expect(result.error).toBeNull();
    expect(Object.keys(result).sort()).toEqual(
      ["drive", "error", "exit_code", "model", "provider", "status", "usage"].sort(),
    );
    const usage = result.usage as Record<string, unknown>;
    expect(Object.keys(usage).sort()).toEqual(
      ["by_model", "completion", "prompt", "reasoning"].sort(),
    );
    expect(usage.prompt).toBe(11);
    expect(usage.completion).toBe(2);
    expect(Array.isArray(usage.by_model)).toBe(true);

    // 无思考链 / 原始响应 / 凭据字段泄漏（逐信封精确判定，排除合法的 usage.reasoning）。
    assertNoThinkingLeak(envs);
  });

  test("A2 等号形式 --output-format=stream-json 同样生效", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", "-y", "--auto", "off", "--output-format=stream-json"]);
    expect(r.code).toBe(0);
    const envs = parseLines(r.out);
    assertEnvelopeShape(envs, envs[0]!.session_id);
    expect(countType(envs, "result")).toBe(1);
    expect((envs[envs.length - 1]!.data as Record<string, unknown>).exit_code).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 37-B 工具事件（真实进程 + 真实 shell 工具）
 * ------------------------------------------------------------------ */

describe("37-B 工具事件", () => {
  test("B1 call_id 配对 / started 先于 finished / ClippedText / 敏感键脱敏 / 无泄漏", async () => {
    mode = "tool";
    const dir = project();
    const r = await run(dir, ["-p", "run tool", "-y", "--auto", "off", "--output-format", "stream-json"]);

    expect(r.code).toBe(0);
    const envs = parseLines(r.out);
    assertEnvelopeShape(envs, envs[0]!.session_id);
    expect(countType(envs, "result")).toBe(1);
    expect(indexOfType(envs, "result")).toBe(envs.length - 1);

    const started = envs.filter((env) => env.type === "tool_started");
    const finished = envs.filter((env) => env.type === "tool_finished");
    expect(started.length).toBe(1);
    expect(finished.length).toBe(1);

    const s = started[0]!;
    const f = finished[0]!;
    // call_id 配对
    expect(s.data.call_id).toBe(TOOL_CALL_ID);
    expect(f.data.call_id).toBe(TOOL_CALL_ID);
    // tool_started 严格在 tool_finished 之前，且都在 result 之前
    expect(s.seq).toBeLessThan(f.seq);
    expect(f.seq).toBeLessThan(envs[envs.length - 1]!.seq);
    expect(s.data.name).toBe(TOOL_NAME);
    expect(f.data.name).toBe(TOOL_NAME);
    expect(s.data.turn).toBe(1);
    expect(f.data.turn).toBe(1);

    // status 三态之一
    expect(typeof f.data.status).toBe("string");
    expect(["success", "failure", "not_executed"]).toContain(String(f.data.status));
    // arguments / output 均为 ClippedText 结构
    expect(isClippedText(s.data.arguments)).toBe(true);
    expect(isClippedText(f.data.output)).toBe(true);
    expect(Array.isArray(s.data.paths)).toBe(true);
    expect(Array.isArray(f.data.paths)).toBe(true);

    // 敏感键被递归脱敏，非敏感键保留；stdout 不泄漏标记值
    const sArgs = s.data.arguments as { text: string; truncated: boolean; original_chars: number };
    expect(sArgs.text.includes("[REDACTED]")).toBe(true);
    expect(sArgs.text.includes(REDACT_MARKER)).toBe(false);
    expect(sArgs.text.includes("keep-me")).toBe(true);
    expect(r.out.includes(REDACT_MARKER)).toBe(false);

    // assistant_message 带 tool_calls，其 arguments 同样是脱敏后的 ClippedText
    const assistant = envs.find((env) => env.type === "assistant_message" && Array.isArray(env.data.tool_calls) && (env.data.tool_calls as unknown[]).length > 0);
    expect(assistant).toBeDefined();
    const calls = assistant!.data.tool_calls as Array<Record<string, unknown>>;
    expect(calls.length).toBe(1);
    expect(calls[0]!.call_id).toBe(TOOL_CALL_ID);
    expect(calls[0]!.name).toBe(TOOL_NAME);
    expect(isClippedText(calls[0]!.arguments)).toBe(true);
    expect((calls[0]!.arguments as { text: string }).text.includes("[REDACTED]")).toBe(true);
    expect((calls[0]!.arguments as { text: string }).text.includes(REDACT_MARKER)).toBe(false);
    // assistant_message 在工具 dispatch 之前发出
    expect(assistant!.seq).toBeLessThan(s.seq);
    expect(assistant!.data.turn).toBe(1);
    expect(Object.keys(assistant!.data).sort()).toEqual(
      ["content", "finish_reason", "model", "provider", "tool_calls", "truncated", "turn"].sort(),
    );

    // 无 reasoning / thinking_blocks / raw / key 泄漏（逐信封精确判定，排除合法的 usage.reasoning）。
    assertNoThinkingLeak(envs);
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * 37-C 用法错误与 text / 单行 json 回归
 * ------------------------------------------------------------------ */

describe("37-C 用法错误与既有模式回归", () => {
  test("C1 缺 -p（无参数）→ stdout 恰 error+result 两行 JSONL、exit 2、session_id=null、exit_code=2、status=usage_error、stderr 一条可读诊断", async () => {
    const dir = project();
    const r = await run(dir, ["--output-format", "stream-json"]);

    expect(r.code).toBe(2);
    const envs = parseLines(r.out);
    expect(envs.map((env) => env.type)).toEqual(["error", "result"]);
    assertEnvelopeShape(envs, null);
    expect(envs[0]!.data.code).toBe("usage_error");
    expect(typeof envs[0]!.data.message).toBe("string");
    expect((envs[0]!.data.message as string).length).toBeGreaterThan(0);
    expect(envs[0]!.data.provider).toBeNull();
    expect(envs[0]!.data.model).toBeNull();
    expect(envs[1]!.data.status).toBe("usage_error");
    expect(envs[1]!.data.exit_code).toBe(2);
    expect(envs[1]!.data.drive).toBeNull();

    const diagnostics = r.err
      .split("\n")
      .filter((line) => line.trim().length > 0 && line.includes("-p"));
    expect(diagnostics.length).toBe(1);
    expect(r.err.includes("✖")).toBe(true);
  });

  test("C2 缺 -p（neo <prompt> 非 -p 形式）→ 同样按 JSONL 用法错误收口", async () => {
    const dir = project();
    const r = await run(dir, ["hello", "--output-format", "stream-json"]);

    expect(r.code).toBe(2);
    const envs = parseLines(r.out);
    expect(envs.map((env) => env.type)).toEqual(["error", "result"]);
    assertEnvelopeShape(envs, null);
    expect(envs[0]!.data.code).toBe("usage_error");
    expect(envs[1]!.data.status).toBe("usage_error");
    expect(envs[1]!.data.exit_code).toBe(2);
    expect(r.err.includes("stream-json 只能与 -p/--print 同用")).toBe(true);
  });

  test("C3 非法 format → exit 2、stdout 为空、维持原错误路径", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", "--output-format", "yaml"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("--output-format 只支持 text | json | stream-json");
  });

  test("C4 text 模式回归：stdout 仍是纯文本，不带 JSONL 信封", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", "-y", "--auto", "off"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("hi");
    expect(r.out.trim().startsWith("{")).toBe(false);
    expect(r.out.includes("schema_version")).toBe(false);
  });

  test("C5 单行 json 模式回归：形状不变、恰好一行、无 stream-json 字段", async () => {
    const dir = project();
    const r = await run(dir, ["-p", "hello", "-y", "--auto", "off", "--output-format", "json"]);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const j = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(j.v).toBe(1);
    expect(j.ok).toBe(true);
    expect(j.exit_code).toBe(0);
    expect(j.answer).toBe("hi");
    expect(j.error).toBeNull();
    expect(j.finish_reason).toBe("stop");
    expect(j.usage).toEqual({ prompt: 11, completion: 2, reasoning: 0 });
    expect(typeof j.session_id).toBe("string");
    expect(r.out.includes("schema_version")).toBe(false);
    expect(r.out.includes('"seq"')).toBe(false);
    expect(r.out.includes('"type":"result"')).toBe(false);
    expect(r.out).not.toMatch(/\x1b\[/);
  });
});

/* ------------------------------------------------------------------ *
 * 37-D drive 终态（与 #52 的 driveExitCode 组合）
 * ------------------------------------------------------------------ */

describe("37-D drive_finished 与 result 收口", () => {
  test("D1 --drive 验证成功 → drive_finished source=verified、result status=completed exit_code=0、process exit 0", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p", "修到绿", "--drive", "true", "--max", "5", "-y", "--auto", "off",
      "--output-format", "stream-json",
    ]);

    expect(r.code).toBe(0);
    const envs = parseLines(r.out);
    assertEnvelopeShape(envs, envs[0]!.session_id);
    expect(envs[0]!.data.drive).toBe(true);
    expect(countType(envs, "drive_finished")).toBe(1);
    expect(countType(envs, "result")).toBe(1);
    const dIdx = indexOfType(envs, "drive_finished");
    const rIdx = indexOfType(envs, "result");
    expect(dIdx).toBeGreaterThanOrEqual(0);
    expect(dIdx).toBeLessThan(rIdx);
    expect(rIdx).toBe(envs.length - 1);

    const d = envs[dIdx]!.data;
    expect(d.status).toBe("done");
    expect(d.source).toBe("verified");
    expect(typeof d.rounds).toBe("number");
    expect(typeof d.elapsed_ms).toBe("number");

    const result = envs[rIdx]!.data;
    expect(result.status).toBe("completed");
    expect(result.exit_code).toBe(0);
    const drive = result.drive as Record<string, unknown>;
    expect(drive.source).toBe("verified");
    expect(drive.status).toBe("done");
  }, 60_000);

  test("D2 仅 judge/model done → drive_finished source=model、result status=model_done exit_code=3、process exit 3", async () => {
    judgeDone = true;
    const dir = project();
    const r = await run(dir, [
      "-p", "看起来完成了", "--judge", "模型说了算", "--max", "1", "-y", "--auto", "off",
      "--output-format", "stream-json",
    ]);

    expect(r.code).toBe(3);
    const envs = parseLines(r.out);
    assertEnvelopeShape(envs, envs[0]!.session_id);
    expect(envs[0]!.data.drive).toBe(true);
    expect(countType(envs, "drive_finished")).toBe(1);
    expect(countType(envs, "result")).toBe(1);
    const dIdx = indexOfType(envs, "drive_finished");
    const rIdx = indexOfType(envs, "result");
    expect(dIdx).toBeLessThan(rIdx);
    expect(rIdx).toBe(envs.length - 1);

    const d = envs[dIdx]!.data;
    expect(d.status).toBe("done");
    expect(d.source).toBe("model");
    const result = envs[rIdx]!.data;
    expect(result.status).toBe("model_done");
    expect(result.exit_code).toBe(3);
    expect((result.drive as Record<string, unknown>).source).toBe("model");
  }, 60_000);

  test("D3 drive 未达成（idle-stop/exhausted）→ drive_finished 恰好一次、result failed exit_code=1、process exit 1", async () => {
    const dir = project();
    const r = await run(dir, [
      "-p", "永远不达成", "--drive", "false", "--max", "2", "-y", "--auto", "off",
      "--output-format", "stream-json",
    ]);

    expect(r.code).toBe(1);
    const envs = parseLines(r.out);
    assertEnvelopeShape(envs, envs[0]!.session_id);
    expect(countType(envs, "drive_finished")).toBe(1);
    expect(countType(envs, "result")).toBe(1);
    const dIdx = indexOfType(envs, "drive_finished");
    const rIdx = indexOfType(envs, "result");
    expect(dIdx).toBeLessThan(rIdx);
    expect(rIdx).toBe(envs.length - 1);
    expect(typeof envs[dIdx]!.data.status).toBe("string");
    expect(["idle-stop", "exhausted", "timeout"]).toContain(String(envs[dIdx]!.data.status));
    expect(envs[dIdx]!.data.source).toBeNull();
    const result = envs[rIdx]!.data;
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(1);
  }, 60_000);
});

/* ------------------------------------------------------------------ *
 * 37-E EPIPE / 下游提前关闭
 * ------------------------------------------------------------------ */

describe("37-E EPIPE 与下游提前关闭", () => {
  test("E1 下游读到 init/turn_started 后关闭（注入 EPIPE）→ exit 1、无 result、stderr 恰一条诊断、不挂死、无遗留子进程", async () => {
    const r = await runWithEpipe(PRELOAD_2);

    expect(r.code).toBe(1);
    const envs = parseLines(r.out);
    expect(envs.map((env) => env.type)).toEqual(["init", "turn_started"]);
    assertEnvelopeShape(envs, envs[0]!.session_id);
    expect(countType(envs, "result")).toBe(0);
    expect(r.out.includes('"type":"result"')).toBe(false);

    const diagnostics = r.err
      .split("\n")
      .filter((line) => line.includes(STDOUT_CLOSED_DIAGNOSTIC));
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0]!.trim()).toBe(STDOUT_CLOSED_DIAGNOSTIC);

    // 进程已退出且没有遗留带唯一标记的子进程。
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(countMarkerProcesses("epipe-preload-2.ts")).toBe(0);
  }, 30_000);

  test("E2 EPIPE 恰好发生在最终 result 写入 → 仍强制 exit 1、不产生第二个 result、stderr 恰一条诊断", async () => {
    const r = await runWithEpipe(PRELOAD_3);

    expect(r.code).toBe(1);
    const envs = parseLines(r.out);
    expect(envs.map((env) => env.type)).toEqual(["init", "turn_started", "assistant_message"]);
    assertEnvelopeShape(envs, envs[0]!.session_id);
    expect(countType(envs, "result")).toBe(0);
    expect(r.out.includes('"type":"result"')).toBe(false);

    const diagnostics = r.err
      .split("\n")
      .filter((line) => line.includes(STDOUT_CLOSED_DIAGNOSTIC));
    expect(diagnostics.length).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(countMarkerProcesses("epipe-preload-3.ts")).toBe(0);
  }, 30_000);

  test("E3 真实下游提前关闭读取端 → 进程在 15s 内退出、已交付的前两行仍是合法 JSONL 且不含 result", async () => {
    const dir = project();
    const proc = Bun.spawn(
      ["bun", INDEX, "-p", "hello", "-y", "--auto", "off", "--output-format", "stream-json"],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env: childEnv() },
    );
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let captured = "";
    while ((captured.match(/\n/g) ?? []).length < 2) {
      const { done, value } = await reader.read();
      if (done) break;
      captured += decoder.decode(value);
    }
    // 模拟下游提前关闭：取消读端。
    await reader.cancel();

    const code = await withTimeout(proc.exited, 15_000);
    // 不挂死：退出码是有限数（本环境 Bun 静默吸收对已关闭管道的写入，不产生可观察 EPIPE）。
    expect(Number.isFinite(code)).toBe(true);
    const envs = parseLines(captured);
    expect(envs.map((env) => env.type)).toEqual(["init", "turn_started"]);
    assertEnvelopeShape(envs, envs[0]!.session_id);
    expect(countType(envs, "result")).toBe(0);
  }, 30_000);
});
