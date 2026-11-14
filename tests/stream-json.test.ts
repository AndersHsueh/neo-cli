/**
 * #37 stream-json v1 JSONL writer 基础层单元测试（writer 级，不启动真 CLI）。
 *
 * 全部注入最小 JsonlSink / stderr 收集函数 / 固定时钟，不触碰真实 stdout。
 * 覆盖架构 §3.6–§3.9 与验收映射 37-A/B 的 writer 部分：信封字段、seq 严格递增、
 * result 单出口、4000 code point 截断、递归脱敏与深度边界、工具层截断透传、
 * EPIPE 收口、有界 flush、白名单投影、paths/reason 限长、9 类事件覆盖。
 */
import { describe, expect, test } from "bun:test";

import {
  clipFallbackReason,
  clipPaths,
  clipReason,
  clipToolArguments,
  clipToolOutput,
  JsonlWriter,
  STREAM_JSON_SCHEMA_VERSION,
  type ClippedText,
  type JsonlSink,
  type JsonlWriterOptions,
  type StreamAssistantMessageData,
  type StreamDriveFinishedData,
  type StreamEnvelope,
  type StreamErrorData,
  type StreamEventType,
  type StreamInitData,
  type StreamModelFallbackData,
  type StreamResultData,
  type StreamToolFinishedData,
  type StreamToolStartedData,
  type StreamTurnStartedData,
} from "../src/streamJson.ts";

const FIXED_ISO = "2026-11-14T08:00:00.000Z";
const SESSION_ID = "session-37";

/* ------------------------------------------------------------------ *
 * 测试数据夹具
 * ------------------------------------------------------------------ */

const clipped: ClippedText = { text: "{}", truncated: false, original_chars: 2 };

const initData: StreamInitData = {
  provider: "openai",
  model: "fake-model",
  model_tier: "default",
  output_format: "stream-json",
  drive: false,
};

const turnStartedData: StreamTurnStartedData = {
  turn: 1,
  provider: "openai",
  model: "fake-model",
};

const assistantMessageData: StreamAssistantMessageData = {
  turn: 1,
  provider: "openai",
  model: "fake-model",
  content: "hello",
  tool_calls: [],
  finish_reason: "stop",
  truncated: false,
};

const toolStartedData: StreamToolStartedData = {
  turn: 1,
  call_id: "call-1",
  name: "read_file",
  arguments: clipped,
  paths: ["src/a.ts"],
};

const toolFinishedData: StreamToolFinishedData = {
  turn: 1,
  call_id: "call-1",
  name: "read_file",
  status: "success",
  output: clipped,
  paths: ["src/a.ts"],
};

const modelFallbackData: StreamModelFallbackData = {
  from: { provider: "openai", model: "m1" },
  to: { provider: "anthropic", model: "m2" },
  reason: { code: "network", message: "failed" },
  attempts: [
    { provider: "openai", model: "m1", code: "network", message: "failed" },
  ],
};

const driveFinishedData: StreamDriveFinishedData = {
  status: "done",
  source: "verified",
  rounds: 2,
  elapsed_ms: 1234,
  reason: null,
};

const errorData: StreamErrorData = {
  code: "model_error",
  message: "boom",
  provider: "openai",
  model: "fake-model",
};

const resultData: StreamResultData = {
  status: "completed",
  exit_code: 0,
  provider: "openai",
  model: "fake-model",
  usage: {
    prompt: 10,
    completion: 5,
    reasoning: 1,
    by_model: [
      {
        provider: "openai",
        model: "fake-model",
        prompt: 10,
        completion: 5,
        reasoning: 1,
      },
    ],
  },
  drive: null,
  error: null,
};

const ALL_EVENT_TYPES: StreamEventType[] = [
  "init",
  "turn_started",
  "assistant_message",
  "tool_started",
  "tool_finished",
  "model_fallback",
  "drive_finished",
  "error",
  "result",
];

/* ------------------------------------------------------------------ *
 * 注入式 fake sink 与 harness
 * ------------------------------------------------------------------ */

interface SinkOptions {
  /** 第一次 write() 抛 EPIPE，用于模拟写失败。 */
  throwOnWrite?: boolean;
  /** write() 返回值，false 表示流内部缓冲、需等待 drain。 */
  writeReturn?: boolean;
}

/** 收集写入字符串、可手动派发 drain/error 的最小 JsonlSink。 */
class FakeSink implements JsonlSink {
  readonly lines: string[] = [];
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  writeCalls = 0;

  constructor(private readonly options: SinkOptions = {}) {}

  write(chunk: string): boolean {
    this.writeCalls += 1;
    if (this.options.throwOnWrite && this.writeCalls === 1) {
      throw new Error("EPIPE");
    }
    this.lines.push(chunk);
    return this.options.writeReturn ?? true;
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): unknown {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((item) => item !== listener),
    );
    return this;
  }

  /** 测试主动派发 drain / error 事件。 */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

interface Harness {
  writer: JsonlWriter;
  sink: FakeSink;
  stderrLines: string[];
  state: { closedCalls: number };
}

function createHarness(
  sinkOptions: SinkOptions = {},
  writerOverrides: Partial<JsonlWriterOptions> = {},
): Harness {
  const sink = new FakeSink(sinkOptions);
  const stderrLines: string[] = [];
  const state = { closedCalls: 0 };
  const writer = new JsonlWriter({
    sessionId: SESSION_ID,
    stdout: sink,
    stderr: (line: string): void => {
      stderrLines.push(line);
    },
    now: () => new Date(FIXED_ISO),
    flushTimeoutMs: 10,
    onClosed: (): void => {
      state.closedCalls += 1;
    },
    ...writerOverrides,
  });
  return { writer, sink, stderrLines, state };
}

/** 给异步断言加硬超时，防止 flush() 挂死拖住测试进程。 */
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

function parseLine(line: string): StreamEnvelope {
  return JSON.parse(line) as StreamEnvelope;
}

/* ------------------------------------------------------------------ *
 * A–L
 * ------------------------------------------------------------------ */

describe("stream-json v1 JsonlWriter", () => {
  test("A 信封字段与 seq：逐行可 JSON.parse、seq 严格 1..N、无 stdout 杂质", () => {
    const { writer, sink } = createHarness();

    expect(writer.emitInit(initData)).toBe(true);
    expect(writer.emitTurnStarted(turnStartedData)).toBe(true);
    expect(writer.emitAssistantMessage(assistantMessageData)).toBe(true);
    expect(writer.emitToolStarted(toolStartedData)).toBe(true);
    expect(writer.emitToolFinished(toolFinishedData)).toBe(true);
    expect(writer.emitError(errorData)).toBe(true);
    expect(writer.emitResult(resultData)).toBe(true);

    expect(sink.lines.length).toBe(7);
    sink.lines.forEach((line, index) => {
      expect(line.endsWith("\n")).toBe(true);
      // 一行恰好一个 JSON object：唯一的裸换行在末尾，字符串内换行已由 JSON 转义。
      expect(line.indexOf("\n")).toBe(line.length - 1);
      expect(line.includes("\x1b")).toBe(false);
      // 无数组括号包裹、无独立逗号行、无 banner。
      expect(line.startsWith("{")).toBe(true);
      expect(line.endsWith("}\n")).toBe(true);

      const envelope = parseLine(line);
      expect(envelope.schema_version).toBe("1.0");
      expect(envelope.schema_version).toBe(STREAM_JSON_SCHEMA_VERSION);
      expect(envelope.seq).toBe(index + 1);
      expect(envelope.timestamp).toBe(FIXED_ISO);
      expect(envelope.session_id).toBe(SESSION_ID);
      expect(typeof envelope.data).toBe("object");
      expect(envelope.data).not.toBeNull();
      expect(Array.isArray(envelope.data)).toBe(false);
      expect(typeof envelope.type).toBe("string");
    });

    const types = sink.lines.map((line) => parseLine(line).type);
    expect(types).toEqual([
      "init",
      "turn_started",
      "assistant_message",
      "tool_started",
      "tool_finished",
      "error",
      "result",
    ]);
    expect(types.filter((type) => type === "result").length).toBe(1);
  });

  test("B result 单出口：result 写成功后拒绝后续所有事件与重复 result", () => {
    const { writer, sink } = createHarness();

    expect(writer.emitInit(initData)).toBe(true);
    expect(writer.emitResult(resultData)).toBe(true);

    const linesBefore = sink.lines.length;
    const seqBefore = writer.currentSeq;

    expect(writer.emitResult(resultData)).toBe(false);
    expect(writer.emitInit(initData)).toBe(false);
    expect(writer.emitError(errorData)).toBe(false);
    expect(writer.emit("result", resultData)).toBe(false);

    expect(sink.lines.length).toBe(linesBefore);
    expect(writer.currentSeq).toBe(seqBefore);
    expect(writer.isResultEmitted).toBe(true);
    expect(sink.lines.filter((line) => parseLine(line).type === "result").length).toBe(1);
  });

  test("C 4000 Unicode code point 截断：含 emoji/代理对，非 UTF-16 length", () => {
    const ascii = "a".repeat(4001);
    const r1 = clipToolArguments(ascii);
    expect(r1.text.length).toBe(4000);
    expect(r1.truncated).toBe(true);
    expect(r1.original_chars).toBe(4001);

    // 2001 个 emoji = 2001 code points / 4002 UTF-16 单元；按 .length 会误截断。
    const emoji2001 = "😀".repeat(2001);
    const r2 = clipToolArguments(emoji2001);
    expect(r2.truncated).toBe(false);
    expect(r2.text).toBe(emoji2001);
    expect(r2.original_chars).toBe(2001);

    const emoji4001 = "😀".repeat(4001);
    const r3 = clipToolArguments(emoji4001);
    expect(Array.from(r3.text).length).toBe(4000);
    expect(r3.truncated).toBe(true);
    expect(r3.original_chars).toBe(4001);
  });

  test("D 递归脱敏：敏感键大小写 / api-key / apiKey 变体与嵌套", () => {
    const raw = JSON.stringify({
      api_key: "SECRET1",
      API_KEY: "SECRET2",
      "x-api-key": "SECRET3",
      access_token: "SECRET4",
      clientSecret: "SECRET5",
      nested: { password: "SECRET6" },
      ok: "keep",
    });
    const text = clipToolArguments(raw).text;

    for (const secret of [
      "SECRET1",
      "SECRET2",
      "SECRET3",
      "SECRET4",
      "SECRET5",
      "SECRET6",
    ]) {
      expect(text.includes(secret)).toBe(false);
    }
    expect(text.includes("[REDACTED]")).toBe(true);
    expect(text.includes("keep")).toBe(true);
  });

  test("E 深度边界：第 7 层及更深子树整体打码，不泄漏密钥", () => {
    // 7 层 wrapper + 最内层 {token}，最内层位于 depth 8（> REDACT_MAX_DEPTH=6）。
    let nested: unknown = { token: "DEEP_SECRET" };
    for (let i = 0; i < 7; i += 1) nested = { level: nested };

    const text = clipToolArguments(JSON.stringify(nested)).text;
    expect(text.includes("DEEP_SECRET")).toBe(false);
    expect(text.includes("[REDACTED]")).toBe(true);
  });

  test("F 修正后的 truncated 口径：原始超长即 truncated=true", () => {
    const raw = JSON.stringify({ api_key: "x".repeat(9000) });
    const result = clipToolArguments(raw);

    expect(result.original_chars > 4000).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Array.from(result.text).length <= 4000).toBe(true);
    expect(result.text.includes("x".repeat(100))).toBe(false);
  });

  test("G 工具层截断透传：DispatchResult.truncated 不被隐藏", () => {
    expect(clipToolOutput("small", true).truncated).toBe(true);
    expect(clipToolOutput("small", false).truncated).toBe(false);
  });

  test("H EPIPE/写失败：closed、恰一条 stderr、钩子恰一次、不再写 stdout", async () => {
    const { writer, sink, stderrLines, state } = createHarness({
      throwOnWrite: true,
    });

    expect(writer.emitInit(initData)).toBe(false);
    expect(writer.isClosed).toBe(true);
    expect(state.closedCalls).toBe(1);
    expect(stderrLines).toEqual(["[stream-json] stdout closed; aborting\n"]);
    expect(sink.lines.length).toBe(0);

    const callsAfterClose = sink.writeCalls;
    expect(writer.emitResult(resultData)).toBe(false);
    expect(sink.writeCalls).toBe(callsAfterClose);

    // 二次收口不重复发诊断、不重复触发钩子。
    writer.closeWithError(new Error("second"));
    expect(stderrLines.length).toBe(1);
    expect(state.closedCalls).toBe(1);

    // closed 状态下 flush 立即 resolve，不挂死。
    await withTimeout(writer.flush(), 500);
    expect(writer.isClosed).toBe(true);
  });

  test("I flush 有界：write 返回 false 后不无限等待，drain 后立即 resolve", async () => {
    const bounded = createHarness({ writeReturn: false });
    expect(bounded.writer.emitInit(initData)).toBe(true);
    await withTimeout(bounded.writer.flush(), 500);

    const drained = createHarness(
      { writeReturn: false },
      { flushTimeoutMs: 1000 },
    );
    expect(drained.writer.emitInit(initData)).toBe(true);
    const pending = drained.writer.flush();
    drained.sink.emit("drain");
    await withTimeout(pending, 500);
  });

  test("J 白名单投影：额外字段不泄漏，output_format/truncated 强制归一", () => {
    const { writer, sink } = createHarness();

    writer.emit("init", {
      ...initData,
      output_format: "text",
      headers: { Authorization: "LEAK" },
      apiKey: "LEAK",
    } as any);
    writer.emit("assistant_message", {
      ...assistantMessageData,
      reasoning: "LEAK2",
      thinking_blocks: ["LEAK2"],
      finish_reason: "length",
      truncated: false,
    } as any);

    const joined = sink.lines.join("");
    expect(joined.includes("LEAK")).toBe(false);
    expect(joined.includes("LEAK2")).toBe(false);
    expect(joined.includes("headers")).toBe(false);
    expect(joined.includes("thinking_blocks")).toBe(false);
    expect(joined.includes("reasoning")).toBe(false);

    const init = parseLine(sink.lines[0]!);
    expect(init.data).toEqual({
      provider: "openai",
      model: "fake-model",
      model_tier: "default",
      output_format: "stream-json",
      drive: false,
    });

    const assistant = parseLine(sink.lines[1]!);
    expect((assistant.data as StreamAssistantMessageData).truncated).toBe(true);
    expect((assistant.data as StreamAssistantMessageData).finish_reason).toBe("length");
  });

  test("K paths / reason 限长：≤32 条 POSIX、≤512/500/240 code points", () => {
    const paths: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      paths.push(`C:\\repo\\src\\deep\\${"z".repeat(600)}\\file-${i}.ts`);
    }
    const clippedPaths = clipPaths(paths);
    expect(clippedPaths.length).toBeLessThanOrEqual(32);
    for (const path of clippedPaths) {
      expect(Array.from(path).length).toBeLessThanOrEqual(512);
      expect(path.includes("\\")).toBe(false);
      expect(path.includes("/")).toBe(true);
    }

    expect(Array.from(clipReason("a".repeat(600))).length).toBeLessThanOrEqual(500);
    expect(Array.from(clipFallbackReason("a".repeat(300))).length).toBeLessThanOrEqual(240);
  });

  test("L 9 类事件覆盖与 result 字段齐全", () => {
    const { writer, sink } = createHarness();

    expect(writer.emitInit(initData)).toBe(true);
    expect(writer.emitTurnStarted(turnStartedData)).toBe(true);
    expect(writer.emitAssistantMessage(assistantMessageData)).toBe(true);
    expect(writer.emitToolStarted(toolStartedData)).toBe(true);
    expect(writer.emitToolFinished(toolFinishedData)).toBe(true);
    expect(writer.emitModelFallback(modelFallbackData)).toBe(true);
    expect(writer.emitDriveFinished(driveFinishedData)).toBe(true);
    expect(writer.emitError(errorData)).toBe(true);
    expect(writer.emitResult(resultData)).toBe(true);

    const envelopes = sink.lines.map(parseLine);
    expect(envelopes.length).toBe(9);
    for (const envelope of envelopes) {
      expect(typeof envelope.data).toBe("object");
      expect(Array.isArray(envelope.data)).toBe(false);
      expect(envelope.data).not.toBeNull();
    }

    const types = envelopes.map((envelope) => envelope.type);
    expect([...new Set(types)].sort()).toEqual(ALL_EVENT_TYPES.slice().sort());
    expect(types.filter((type) => type === "result").length).toBe(1);

    const result = envelopes[envelopes.length - 1]!;
    expect(result.type).toBe("result");
    const data = result.data as StreamResultData;
    expect(Object.keys(data).sort()).toEqual(
      ["drive", "error", "exit_code", "model", "provider", "status", "usage"].sort(),
    );
    expect(Object.keys(data.usage).sort()).toEqual(
      ["by_model", "completion", "prompt", "reasoning"].sort(),
    );
    expect(data.status).toBe("completed");
    expect(data.exit_code).toBe(0);
    expect(data.provider).toBe("openai");
    expect(data.model).toBe("fake-model");
    expect(data.usage.prompt).toBe(10);
    expect(data.usage.completion).toBe(5);
    expect(data.usage.reasoning).toBe(1);
    expect(Array.isArray(data.usage.by_model)).toBe(true);
    expect(data.usage.by_model.length).toBe(1);
    expect(data.drive).toBeNull();
    expect(data.error).toBeNull();
  });
});
