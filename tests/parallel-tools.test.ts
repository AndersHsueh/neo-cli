/**
 * issue #11：只读工具并行调用（parallel_tool_calls）。
 *
 * 覆盖：
 *  1. 一轮内多个只读工具并行完成（墙钟远小于串行之和），且 tool 结果按原序回填；
 *  2. 混合批次 [read, write, read] 的屏障语义：写工具不与相邻读写并发，顺序不乱；
 *  3. parallel_tool_calls=off 时即使模型返回多个只读调用也串行（并行度峰值 === 1）；
 *  4. buildBody 的请求体字段随配置变化；网关拒绝该字段时同轮降级重发而不炸。
 *
 * 约定：禁 mock.module（bun test 单进程共享模块表），一律构造注入 + registerTool。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import { resolveParallelToolCalls } from "../src/config.ts";
import { chatStream } from "../src/llm.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";
import { isParallelizable, registerTool } from "../src/tools/index.ts";
import { wikiSearchTool } from "../src/tools/wiki.ts";
import type { ToolImpl } from "../src/tools/types.ts";
import { captureConsole, sleep } from "./helpers.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-parallel-tools-"));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

function makeCfg(over: Partial<Config> = {}): Config {
  const model = "m-default";
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model,
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

function tc(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** 脚本化 chatStream：第一轮返回给定 tool_calls，第二轮正常收尾。 */
function scriptedStream(
  toolCalls: ToolCall[],
  seen: Message[][] = [],
): (cfg: Config, messages: Message[]) => Promise<StreamResult> {
  let round = 0;
  return async (_cfg, messages) => {
    seen.push(messages.map((m) => ({ ...m })));
    round++;
    if (round === 1) {
      return {
        content: "",
        reasoning: "",
        toolCalls,
        finishReason: "tool_calls",
        usage: null,
        raw: null,
      } as StreamResult;
    }
    return {
      content: "done",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
    } as StreamResult;
  };
}

/** 假工具：可控延迟 + 记录并发峰值与执行顺序。 */
interface Probe {
  /** 当前并发数。 */
  active: number;
  /** 观测到的并发峰值。 */
  peak: number;
  /** 进入/离开事件序列（`+name` 开始、`-name` 结束）。 */
  events: string[];
}

function makeProbe(): Probe {
  return { active: 0, peak: 0, events: [] };
}

function fakeTool(
  name: string,
  probe: Probe,
  opts: { parallelizable: boolean; delayMs: number },
): ToolImpl {
  return {
    sensitive: !opts.parallelizable,
    kind: opts.parallelizable ? "evidence" : "neither",
    ...(opts.parallelizable ? { parallelizable: true } : {}),
    spec: {
      type: "function",
      function: { name, description: `test tool ${name}`, parameters: { type: "object", properties: {} } },
    },
    async execute() {
      probe.active++;
      probe.peak = Math.max(probe.peak, probe.active);
      probe.events.push(`+${name}`);
      await sleep(opts.delayMs);
      probe.events.push(`-${name}`);
      probe.active--;
      return `${name} ok`;
    },
  };
}

/** 注册若干假工具，返回统一注销函数（bun test 共享注册表，必须清理）。 */
function registerAll(impls: ToolImpl[]): () => void {
  const offs = impls.map((i) => registerTool(i));
  return () => {
    for (const off of offs) off();
  };
}

function toolMessages(messages: Message[]): Message[] {
  return messages.filter((m) => m.role === "tool");
}

/* ------------------------------------------------------------------ */
/* 标记与配置                                                          */
/* ------------------------------------------------------------------ */

describe("parallelizable 标记", () => {
  test("只读工具标 true，写/有副作用工具一律 false", () => {
    // wiki_search 由组合根 registerWikiTools 注册（不在静态 TOOLS 里），测试里手动挂上
    const off = registerTool(wikiSearchTool);
    try {
      for (const name of ["read_file", "list_dir", "glob", "grep", "web_fetch", "web_search", "wiki_search"]) {
        expect(isParallelizable(name)).toBe(true);
      }
      for (const name of [
        "write_file",
        "edit_file",
        "shell",
        "use_skill",
        "compact_ctx",
        "task",
        "ask_user",
        "remember",
        "send_message",
        "wiki_write",
        "不存在的工具",
      ]) {
        expect(isParallelizable(name)).toBe(false);
      }
    } finally {
      off();
    }
  });

  test("resolveParallelToolCalls：默认 readonly，off/false 关，未知值回落默认", () => {
    expect(resolveParallelToolCalls(undefined)).toBe("readonly");
    expect(resolveParallelToolCalls("off")).toBe("off");
    expect(resolveParallelToolCalls("READONLY")).toBe("readonly");
    expect(resolveParallelToolCalls(false)).toBe("off");
    expect(resolveParallelToolCalls(true)).toBe("readonly");
    expect(resolveParallelToolCalls("garbage")).toBe("readonly");
  });
});

/* ------------------------------------------------------------------ */
/* 并行只读                                                            */
/* ------------------------------------------------------------------ */

describe("只读工具并行", () => {
  test("一轮内 3 个只读工具并行完成，墙钟远小于串行之和，结果按原序回填", async () => {
    const probe = makeProbe();
    const off = registerAll([
      fakeTool("t_read_a", probe, { parallelizable: true, delayMs: 80 }),
      fakeTool("t_read_b", probe, { parallelizable: true, delayMs: 80 }),
      fakeTool("t_read_c", probe, { parallelizable: true, delayMs: 80 }),
    ]);
    try {
      const seen: Message[][] = [];
      const agent = new Agent({
        cfg: makeCfg(),
        console: captureConsole().ui,
        mode: "auto-all",
        systemPrompt: "sys",
        chatStream: scriptedStream(
          [
            tc("c1", "t_read_a"),
            tc("c2", "t_read_b"),
            tc("c3", "t_read_c"),
          ],
          seen,
        ),
      });
      const t0 = Date.now();
      const stats = await agent.send("read three");
      const wall = Date.now() - t0;

      expect(stats.hadError).toBe(false);
      expect(stats.toolCalls).toBe(3);
      // 并行：80ms 量级；串行至少 240ms。留足 CI 抖动余量。
      expect(wall).toBeLessThan(200);
      expect(probe.peak).toBe(3);

      // 结果按 tool_calls 原序回填
      const tools = toolMessages(agent.messages);
      expect(tools.map((m) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
      expect(tools.map((m) => m.name)).toEqual(["t_read_a", "t_read_b", "t_read_c"]);
      expect(tools.map((m) => m.content)).toEqual(["t_read_a ok", "t_read_b ok", "t_read_c ok"]);

      // 第二次请求看到的 tool 消息同样按序
      const second = seen[1]!;
      expect(toolMessages(second).map((m) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
    } finally {
      off();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 混合批次屏障                                                        */
/* ------------------------------------------------------------------ */

describe("混合批次不乱序", () => {
  test("[read, write, read] 全串行：写工具不与相邻读写并发，顺序与结果均按原序", async () => {
    const probe = makeProbe();
    const off = registerAll([
      fakeTool("t_r1", probe, { parallelizable: true, delayMs: 30 }),
      fakeTool("t_w1", probe, { parallelizable: false, delayMs: 30 }),
      fakeTool("t_r2", probe, { parallelizable: true, delayMs: 30 }),
    ]);
    try {
      const agent = new Agent({
        cfg: makeCfg(),
        console: captureConsole().ui,
        mode: "auto-all",
        systemPrompt: "sys",
        chatStream: scriptedStream([tc("c1", "t_r1"), tc("c2", "t_w1"), tc("c3", "t_r2")]),
      });
      await agent.send("mixed");

      // 屏障语义：任何时刻并发度都不超过 1，且严格按 读→写→读 完成
      expect(probe.peak).toBe(1);
      expect(probe.events).toEqual(["+t_r1", "-t_r1", "+t_w1", "-t_w1", "+t_r2", "-t_r2"]);

      const tools = toolMessages(agent.messages);
      expect(tools.map((m) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
      expect(tools.map((m) => m.name)).toEqual(["t_r1", "t_w1", "t_r2"]);
    } finally {
      off();
    }
  });

  test("[read, read, write, read, read]：两段并行被写工具切开，写仍是屏障", async () => {
    const probe = makeProbe();
    const off = registerAll([
      fakeTool("t_a", probe, { parallelizable: true, delayMs: 40 }),
      fakeTool("t_b", probe, { parallelizable: true, delayMs: 40 }),
      fakeTool("t_w", probe, { parallelizable: false, delayMs: 10 }),
      fakeTool("t_c", probe, { parallelizable: true, delayMs: 40 }),
      fakeTool("t_d", probe, { parallelizable: true, delayMs: 40 }),
    ]);
    try {
      const agent = new Agent({
        cfg: makeCfg(),
        console: captureConsole().ui,
        mode: "auto-all",
        systemPrompt: "sys",
        chatStream: scriptedStream([
          tc("c1", "t_a"),
          tc("c2", "t_b"),
          tc("c3", "t_w"),
          tc("c4", "t_c"),
          tc("c5", "t_d"),
        ]),
      });
      await agent.send("mixed2");

      // 峰值 2（两段各两个），写工具独占
      expect(probe.peak).toBe(2);
      const w = probe.events.indexOf("+t_w");
      expect(probe.events.slice(0, w).filter((e) => e.startsWith("+"))).toEqual(["+t_a", "+t_b"]);
      expect(probe.events.slice(0, w).filter((e) => e.startsWith("-"))).toEqual(["-t_a", "-t_b"]);
      const after = probe.events.slice(probe.events.indexOf("-t_w"));
      expect(after.filter((e) => e.startsWith("+"))).toEqual(["+t_c", "+t_d"]);

      expect(toolMessages(agent.messages).map((m) => m.tool_call_id)).toEqual([
        "c1",
        "c2",
        "c3",
        "c4",
        "c5",
      ]);
    } finally {
      off();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 配置 off                                                            */
/* ------------------------------------------------------------------ */

describe("parallel_tool_calls=off", () => {
  test("即使模型返回多个只读调用也串行（并行度峰值 === 1）", async () => {
    const probe = makeProbe();
    const off = registerAll([
      fakeTool("t_off_a", probe, { parallelizable: true, delayMs: 20 }),
      fakeTool("t_off_b", probe, { parallelizable: true, delayMs: 20 }),
      fakeTool("t_off_c", probe, { parallelizable: true, delayMs: 20 }),
    ]);
    try {
      const agent = new Agent({
        cfg: makeCfg({ parallelToolCalls: "off" }),
        console: captureConsole().ui,
        mode: "auto-all",
        systemPrompt: "sys",
        chatStream: scriptedStream([
          tc("c1", "t_off_a"),
          tc("c2", "t_off_b"),
          tc("c3", "t_off_c"),
        ]),
      });
      await agent.send("serial");

      expect(probe.peak).toBe(1);
      expect(probe.events).toEqual([
        "+t_off_a",
        "-t_off_a",
        "+t_off_b",
        "-t_off_b",
        "+t_off_c",
        "-t_off_c",
      ]);
      expect(toolMessages(agent.messages).map((m) => m.tool_call_id)).toEqual(["c1", "c2", "c3"]);
    } finally {
      off();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 请求体                                                              */
/* ------------------------------------------------------------------ */

describe("请求体 parallel_tool_calls", () => {
  const tools = [
    {
      type: "function" as const,
      function: { name: "read_file", description: "d", parameters: { type: "object", properties: {} } },
    },
  ];

  /** 起一个本地假端点，记录每次请求体，返回 SSE 成功响应。 */
  function serveCapture(): { url: string; bodies: Array<Record<string, unknown>>; stop: () => void } {
    const bodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Record<string, unknown>);
        const body =
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n";
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      bodies,
      stop: () => server.stop(true),
    };
  }

  test("readonly（默认）→ 请求体 true；off → false", async () => {
    const s = serveCapture();
    try {
      const base = {
        baseUrl: s.url,
        apiKey: "k",
        model: "m",
        maxTokens: 16,
        temperature: 0,
        retry: { maxAttempts: 1, baseDelayMs: 1, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000 },
      };
      await chatStream(makeCfg({ ...base, parallelToolCalls: "readonly" }), [{ role: "user", content: "hi" }], tools);
      await chatStream(makeCfg({ ...base, parallelToolCalls: "off" }), [{ role: "user", content: "hi" }], tools);
      // 未填字段（旧调用方）按默认 readonly 处理
      await chatStream(
        makeCfg({ ...base, parallelToolCalls: undefined as unknown as Config["parallelToolCalls"] }),
        [{ role: "user", content: "hi" }],
        tools,
      );
      expect(s.bodies.map((b) => b["parallel_tool_calls"])).toEqual([true, false, true]);
    } finally {
      s.stop();
    }
  });

  test("瘦网关拒绝该字段：同轮降级为 false 重发，不炸主循环", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        bodies.push(body);
        if (body["parallel_tool_calls"] === true) {
          return new Response(
            JSON.stringify({ error: { message: "unknown field: parallel_tool_calls" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        const sse =
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n";
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const notices: string[] = [];
      const r = await chatStream(
        makeCfg({
          baseUrl: `http://127.0.0.1:${server.port}`,
          retry: { maxAttempts: 1, baseDelayMs: 1, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000 },
        }),
        [{ role: "user", content: "hi" }],
        tools,
        { onNotice: (m) => notices.push(m) },
      );
      expect(r.content).toBe("hi");
      expect(bodies.map((b) => b["parallel_tool_calls"])).toEqual([true, false]);
      expect(notices.join("\n")).toContain("降级");
    } finally {
      server.stop(true);
    }
  });
});
