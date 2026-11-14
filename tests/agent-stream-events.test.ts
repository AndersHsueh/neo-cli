/**
 * #37 #17b-1：Agent 内部事件层契约（组合根构造 stream-json 公开事件的上游载荷）。
 *
 * 用注入式脚本化 chatStream + 注册假工具，不触网、不碰真实 ~/.neo
 * （NEO_TMP_DIR / NEO_LOG_DIR 都指向临时目录）。约定：禁 mock.module，
 * 一律构造注入 + registerTool，测试结束统一注销。
 *
 * 覆盖：
 *  - tool_start / tool_end 的 call_id 配对；
 *  - 并行段按 tool_calls 原序先发全部 start、再按原序发全部 end；
 *  - assistant_message 在工具 dispatch 之前发出，带完整 content；
 *  - 不带 tool_calls 的最终回答也发 assistant_message；
 *  - 同一 send() 内多轮工具循环每次完整响应各发一条；
 *  - 旧字段保持、新字段（output/status/paths/truncated）与状态映射。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent.ts";
import type {
  AgentEvent,
  AssistantMessageEventData,
  ToolEndEventData,
  ToolStartEventData,
} from "../src/agent/types.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";
import { registerTool } from "../src/tools/index.ts";
import type { ToolImpl } from "../src/tools/types.ts";
import { captureConsole } from "./helpers.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-agent-stream-events-"));
const previousTmpDir = process.env["NEO_TMP_DIR"];
const previousLogDir = process.env["NEO_LOG_DIR"];
const unregister: Array<() => void> = [];

beforeAll(() => {
  process.env["NEO_TMP_DIR"] = join(SANDBOX, "tmp");
  process.env["NEO_LOG_DIR"] = join(SANDBOX, "logs");
});

afterAll(() => {
  if (previousTmpDir === undefined) delete process.env["NEO_TMP_DIR"];
  else process.env["NEO_TMP_DIR"] = previousTmpDir;
  if (previousLogDir === undefined) delete process.env["NEO_LOG_DIR"];
  else process.env["NEO_LOG_DIR"] = previousLogDir;
  for (const off of unregister) off();
  rmSync(SANDBOX, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [],
    routes: {
      default: { provider: "p1", model: null, fallbackAllowed: true },
      deep_reasoning: { provider: "p1", model: null, fallbackAllowed: true },
      balanced: { provider: "p1", model: null, fallbackAllowed: true },
      fast: { provider: "p1", model: null, fallbackAllowed: true },
    },
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 256,
    temperature: 0,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 256, temperature: 0, contextWindow: 100_000 },
    compactThreshold: 0.9,
    maxToolIterations: 10,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    parallelToolCalls: "readonly",
    cwd: SANDBOX,
    settingsPath: null,
    skillsStore: join(SANDBOX, "skills"),
    memory: {
      enabled: false,
      userLevelDir: join(SANDBOX, "mem"),
      userWikiDir: join(SANDBOX, "wiki"),
      journalDir: join(SANDBOX, "journal"),
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false,
        mode: "off",
        modelTier: "fast",
        maxOpsPerTurn: 2,
        maxPagesPerSession: 8,
        minConfidence: 0.65,
        minInferredConfidence: 0.75,
        journalRetentionDays: 7,
        flushTimeoutMs: 3000,
      },
      quiet: true,
    },
    ...over,
  } as unknown as Config;
}

function result(over: Partial<StreamResult> = {}): StreamResult {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
    raw: null,
    ...over,
  };
}

function tc(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** 脚本化 chatStream：按给定顺序返回响应，多要一轮就报错（防静默死循环）。 */
function scriptedStream(
  rounds: StreamResult[],
): (cfg: Config, messages: Message[]) => Promise<StreamResult> {
  let i = 0;
  return async () => {
    const r = rounds[i];
    if (!r) throw new Error(`scripted stream exhausted at round ${i + 1}`);
    i += 1;
    return r;
  };
}

function fakeTool(name: string, output: string, parallelizable: boolean): ToolImpl {
  return {
    spec: {
      type: "function",
      function: { name, description: `test tool ${name}`, parameters: { type: "object", properties: {} } },
    },
    sensitive: false,
    kind: "evidence",
    ...(parallelizable ? { parallelizable: true } : {}),
    execute: () => output,
  };
}

function throwingTool(name: string, message: string): ToolImpl {
  return {
    spec: {
      type: "function",
      function: { name, description: `test tool ${name}`, parameters: { type: "object", properties: {} } },
    },
    sensitive: false,
    kind: "evidence",
    execute: () => {
      throw new Error(message);
    },
  };
}

function reg(impl: ToolImpl): void {
  unregister.push(registerTool(impl));
}

interface Harness {
  events: AgentEvent[];
  agent: Agent;
}

function makeHarness(rounds: StreamResult[], over: Partial<Config> = {}, withPaths = true): Harness {
  const events: AgentEvent[] = [];
  const agent = new Agent({
    cfg: makeCfg(over),
    console: captureConsole().ui,
    mode: "auto-all",
    systemPrompt: "sys",
    chatStream: scriptedStream(rounds),
    ...(withPaths ? { toolPathsOf: (name: string) => [`src/${name}.ts`] } : {}),
    onEvent: (e: AgentEvent) => {
      events.push({ type: e.type, data: e.data });
    },
  });
  return { events, agent };
}

function dataOf<T>(events: AgentEvent[], type: AgentEvent["type"]): T[] {
  return events.filter((e) => e.type === type).map((e) => e.data as T);
}

function indicesOf(events: AgentEvent[], type: AgentEvent["type"]): number[] {
  const out: number[] = [];
  events.forEach((e, i) => {
    if (e.type === type) out.push(i);
  });
  return out;
}

/* ------------------------------------------------------------------ *
 * A–E
 * ------------------------------------------------------------------ */

describe("#37 Agent 内部事件载荷", () => {
  test("A 并行段 call_id 配对与原序；assistant_message 在工具前且带完整 content", async () => {
    reg(fakeTool("t_read_a", "a ok", true));
    reg(fakeTool("t_read_b", "b ok", true));
    reg(fakeTool("t_read_c", "c ok", true));

    const first = result({
      content: "我来读取三个文件",
      reasoning: "内部思维链不得外泄",
      toolCalls: [
        tc("c1", "t_read_a", { path: "src/a.ts" }),
        tc("c2", "t_read_b", { path: "src/b.ts" }),
        tc("c3", "t_read_c", { path: "src/c.ts" }),
      ],
      finishReason: "tool_calls",
      raw: { secret: "RAW_LEAK" },
      thinkingBlocks: [{ type: "thinking", thinking: "THINK_LEAK", signature: "sig" }],
    });
    const final = result({ content: "最终答案：完成", finishReason: "stop" });
    const { events, agent } = makeHarness([first, final]);
    const stats = await agent.send("读三个文件");

    expect(stats.hadError).toBe(false);
    expect(stats.toolCalls).toBe(3);

    // ---- assistant_message ----
    const messages = dataOf<AssistantMessageEventData>(events, "assistant_message");
    expect(messages.length).toBe(2);
    expect(indicesOf(events, "assistant_message")[0]!).toBeLessThan(
      indicesOf(events, "tool_start")[0]!,
    );

    const withTools = messages[0]!;
    expect(withTools.content).toBe("我来读取三个文件");
    expect(withTools.finish_reason).toBe("tool_calls");
    expect(withTools.tool_calls).toEqual([
      { call_id: "c1", name: "t_read_a", arguments: JSON.stringify({ path: "src/a.ts" }) },
      { call_id: "c2", name: "t_read_b", arguments: JSON.stringify({ path: "src/b.ts" }) },
      { call_id: "c3", name: "t_read_c", arguments: JSON.stringify({ path: "src/c.ts" }) },
    ]);
    // 不含 reasoning / thinking_blocks / raw response / 签名思考块。
    expect(Object.keys(withTools).sort()).toEqual(["content", "finish_reason", "tool_calls"]);
    const serialized = JSON.stringify(withTools);
    expect(serialized.includes("内部思维链不得外泄")).toBe(false);
    expect(serialized.includes("THINK_LEAK")).toBe(false);
    expect(serialized.includes("RAW_LEAK")).toBe(false);

    const answer = messages[1]!;
    expect(answer.content).toBe("最终答案：完成");
    expect(answer.tool_calls).toEqual([]);
    expect(answer.finish_reason).toBe("stop");

    // ---- tool_start / tool_end ----
    const starts = dataOf<ToolStartEventData>(events, "tool_start");
    const ends = dataOf<ToolEndEventData>(events, "tool_end");
    expect(starts.map((s) => s.call_id)).toEqual(["c1", "c2", "c3"]);
    expect(ends.map((e) => e.call_id)).toEqual(["c1", "c2", "c3"]);
    expect(starts.map((s) => s.name)).toEqual(["t_read_a", "t_read_b", "t_read_c"]);
    expect(starts[0]!.args).toBe(JSON.stringify({ path: "src/a.ts" }));
    expect(starts.map((s) => s.paths)).toEqual([
      ["src/t_read_a.ts"],
      ["src/t_read_b.ts"],
      ["src/t_read_c.ts"],
    ]);

    expect(ends.map((e) => e.name)).toEqual(["t_read_a", "t_read_b", "t_read_c"]);
    expect(ends.map((e) => e.ok)).toEqual([true, true, true]);
    expect(ends.map((e) => e.truncated)).toEqual([false, false, false]);
    expect(ends.map((e) => e.status)).toEqual(["success", "success", "success"]);
    expect(ends.map((e) => e.output)).toEqual(["a ok", "b ok", "c ok"]);
    expect(ends.map((e) => e.paths)).toEqual([
      ["src/t_read_a.ts"],
      ["src/t_read_b.ts"],
      ["src/t_read_c.ts"],
    ]);

    // 并行段：全部 start 严格早于全部 end，且两者各自按 tool_calls 原序。
    const startIdx = indicesOf(events, "tool_start");
    const endIdx = indicesOf(events, "tool_end");
    expect(Math.max(...startIdx)).toBeLessThan(Math.min(...endIdx));
  });

  test("B status 映射 success/failure/not_executed；truncated 透传；未注入 toolPathsOf 时 paths=[]", async () => {
    reg(fakeTool("t_ok", "ok", false));
    reg(throwingTool("t_fail", "boom"));
    reg(fakeTool("t_long", "x".repeat(200), false));
    // t_missing 故意不注册 → dispatch 返回 executed:false。

    const first = result({
      content: "做四件事",
      toolCalls: [
        tc("k1", "t_ok"),
        tc("k2", "t_fail"),
        tc("k3", "t_missing"),
        tc("k4", "t_long"),
      ],
      finishReason: "tool_calls",
    });
    const final = result({ content: "done", finishReason: "stop" });
    const { events, agent } = makeHarness(
      [first, final],
      { parallelToolCalls: "off", toolOutputLimit: 20 },
      false,
    );
    await agent.send("go");

    const starts = dataOf<ToolStartEventData>(events, "tool_start");
    const ends = dataOf<ToolEndEventData>(events, "tool_end");
    expect(starts.map((s) => s.call_id)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(ends.map((e) => e.call_id)).toEqual(["k1", "k2", "k3", "k4"]);
    expect(ends.map((e) => e.status)).toEqual([
      "success",
      "failure",
      "not_executed",
      "success",
    ]);
    expect(ends.map((e) => e.ok)).toEqual([true, false, false, true]);
    expect(ends.map((e) => e.truncated)).toEqual([false, false, false, true]);
    expect(ends[0]!.output).toBe("ok");
    expect(ends[1]!.output).toContain("boom");
    expect(ends[2]!.output).toContain("未知工具");
    expect(ends.every((e) => Array.isArray(e.paths) && e.paths.length === 0)).toBe(true);
    expect(starts.every((s) => Array.isArray(s.paths) && s.paths.length === 0)).toBe(true);
  });

  test("C 同一 send() 内多轮工具循环：每次完整响应各发一条 assistant_message", async () => {
    reg(fakeTool("t_round", "r", false));
    const rounds: StreamResult[] = [
      result({ content: "第 1 轮", toolCalls: [tc("a1", "t_round")], finishReason: "tool_calls" }),
      result({ content: "第 2 轮", toolCalls: [tc("a2", "t_round")], finishReason: "tool_calls" }),
      result({ content: "第 3 轮最终", finishReason: "stop" }),
    ];
    const { events, agent } = makeHarness(rounds, { parallelToolCalls: "off" });
    await agent.send("多轮");

    const messages = dataOf<AssistantMessageEventData>(events, "assistant_message");
    expect(messages.map((m) => m.content)).toEqual(["第 1 轮", "第 2 轮", "第 3 轮最终"]);
    expect(messages.map((m) => m.finish_reason)).toEqual(["tool_calls", "tool_calls", "stop"]);
    expect(messages.map((m) => m.tool_calls.map((c) => c.call_id))).toEqual([
      ["a1"],
      ["a2"],
      [],
    ]);

    // 每条 assistant_message 都早于它那一轮的 tool_start。
    const amIdx = indicesOf(events, "assistant_message");
    const startIdx = indicesOf(events, "tool_start");
    expect(startIdx).toEqual([amIdx[0]! + 1, amIdx[1]! + 1]);
    expect(dataOf<ToolStartEventData>(events, "tool_start").map((s) => s.call_id)).toEqual([
      "a1",
      "a2",
    ]);
  });

  test("D 无工具调用的纯回答也发 assistant_message，且不发任何工具事件", async () => {
    const content = "完整最终答案，包含中文与 emoji 😀";
    const { events, agent } = makeHarness([
      result({ content, finishReason: "stop", reasoning: "不得外泄" }),
    ]);
    await agent.send("只回答");

    const messages = dataOf<AssistantMessageEventData>(events, "assistant_message");
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toBe(content);
    expect(messages[0]!.tool_calls).toEqual([]);
    expect(messages[0]!.finish_reason).toBe("stop");
    expect(JSON.stringify(messages[0]).includes("不得外泄")).toBe(false);
    expect(indicesOf(events, "tool_start")).toEqual([]);
    expect(indicesOf(events, "tool_end")).toEqual([]);
  });

  test("E finish_reason=length 的响应也发完整 content，事件自身不带 truncated 字段", async () => {
    const { events, agent } = makeHarness([
      result({ content: "被截断的正文", finishReason: "length" }),
    ]);
    await agent.send("长回答");

    const messages = dataOf<AssistantMessageEventData>(events, "assistant_message");
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toBe("被截断的正文");
    expect(messages[0]!.finish_reason).toBe("length");
    // truncated 由 writer 按 finish_reason === "length" 强制覆盖，Agent 事件不判。
    expect("truncated" in (messages[0] as unknown as Record<string, unknown>)).toBe(false);
  });
});
