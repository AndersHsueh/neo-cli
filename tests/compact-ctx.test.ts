/**
 * compact_ctx 工具与压缩链路测试。
 *
 * 覆盖：
 *  - 工具登记回执（有/无 reason、无宿主时报错）。
 *  - compactNow：压缩核心行为（太短抛错、成功重写历史、保留 system）。
 *  - compact：薄壳契约（太短/失败返回 false）。
 *  - 端到端：模型调 compact_ctx → 工具循环收口 → 压缩执行 → 下一轮请求
 *    看到的是摘要后的历史（fakeStream 脚本化校验消息数）。
 *  - 子代理排除：toolSpecsFor 不含 compact_ctx。
 *
 * 运行：bun test tests/compact-ctx.test.ts
 */
import { contentText } from "../src/llm.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";

import { Agent, type AgentIO } from "../src/agent.ts";
import { dispatch, toolSpecs, TOOL_NAMES_EXCLUDED_FOR_SUBAGENT } from "../src/tools/index.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const SANDBOX = join(tmpdir(), `neo-compact-ctx-test-${Date.now()}`);
mkdirSync(SANDBOX, { recursive: true });

function makeCfg(): Config {
  const provider = {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: {
      default: "m-default",
      deep_reasoning: "m-deep",
      balanced: "m-bal",
      fast: "m-fast",
    },
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [provider],
    routes: {
      default: { provider: "p1", model: null, fallbackAllowed: true },
      deep_reasoning: { provider: "p1", model: null, fallbackAllowed: true },
      balanced: { provider: "p1", model: null, fallbackAllowed: true },
      fast: { provider: "p1", model: null, fallbackAllowed: true },
    },
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 80,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
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
        mode: "off" as const,
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
  } as Config;
}

function spyConsole(over: Partial<AgentIO> = {}): AgentIO {
  const base: AgentIO = {
    line(): void {},
    blank(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    toolHeader(): void {},
    toolResult(): void {},
    indent(body: string, prefix = "│ "): string {
      return body
        .split("\n")
        .map((l) => prefix + l)
        .join("\n");
    },
    startSpinner(): void {},
    updateSpinner(): void {},
    stopSpinner(): void {},
    beginStream(): void {},
    writeStream(): void {},
    endStream(): void {},
    ensureStreamClosed(): void {},
    async confirm(): Promise<boolean> {
      return true;
    },
    width: 100,
  };
  return Object.assign(base, over) as AgentIO;
}

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 脚本化假 chatStream，记录每次调用收到的消息数（与完整消息，供压缩输入断言）。 */
function fakeStream(steps: Array<(cfg: Config, messages: Message[]) => Partial<StreamResult>>) {
  const msgCounts: number[] = [];
  const inputs: Message[][] = [];
  let i = 0;
  const fn = (cfg: Config, messages: Message[]): Promise<StreamResult> => {
    msgCounts.push(messages.length);
    inputs.push(messages.map((m) => ({ ...m })));
    const step = steps[i];
    if (!step) throw new Error(`fake chatStream: 脚本耗尽（第 ${i + 1} 次调用）`);
    i++;
    return Promise.resolve({
      content: "",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
      ...step(cfg, messages),
    } as StreamResult);
  };
  return { msgCounts, inputs, fn };
}

/* ------------------------------------------------------------------ */
/* 工具登记层                                                          */
/* ------------------------------------------------------------------ */

describe("compact_ctx 工具", () => {
  test("有宿主：登记请求并返回回执（无 reason）", async () => {
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
    });
    const ctx: ToolCtx = {
      cfg: makeCfg(),
      approve: async () => true,
      host: agent,
    };
    const r = await dispatch("compact_ctx", "{}", ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("已登记压缩请求");
  });

  test("有宿主：reason 进回执", async () => {
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
    });
    const ctx: ToolCtx = {
      cfg: makeCfg(),
      approve: async () => true,
      host: agent,
    };
    const r = await dispatch("compact_ctx", JSON.stringify({ reason: "探索完成" }), ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("探索完成");
  });

  test("无宿主（裸 ctx）：报错而非假装成功", async () => {
    const ctx: ToolCtx = {
      cfg: makeCfg(),
      approve: async () => true,
    };
    const r = await dispatch("compact_ctx", "{}", ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("没有宿主代理");
  });

  test("登记不立即压缩：历史在工具执行点保持原样", async () => {
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
    });
    const before = agent.messages.length;
    const ctx: ToolCtx = {
      cfg: makeCfg(),
      approve: async () => true,
      host: agent,
    };
    await dispatch("compact_ctx", "{}", ctx);
    expect(agent.messages.length).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* 压缩核心                                                            */
/* ------------------------------------------------------------------ */

describe("compactNow / compact", () => {
  test("对话太短：compactNow 抛错，compact 返回 false", async () => {
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
    });
    agent.messages.push(
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    );
    expect(agent.compactNow()).rejects.toThrow("对话太短");
    expect(await agent.compact()).toBe(false);
  });

  test("压缩成功：摘要 + 最近原文保留，事件携带前后 token", async () => {
    const events: string[] = [];
    const { fn } = fakeStream([
      () => ({ content: "## 摘要\n用户在做 X。" }),
    ]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
      onEvent: (e) => events.push(e.type),
    });
    agent.messages.push(
      { role: "user", content: "m1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "m2" },
      { role: "assistant", content: "a2" },
    );
    const r = await agent.compactNow();
    expect(r.beforeTokens).toBeGreaterThan(0);
    expect(r.afterTokens).toBeGreaterThan(0);
    // system + 摘要 + 最近 2 条原文（P0-2：不再只留一条摘要）
    expect(agent.messages).toHaveLength(4);
    expect(agent.messages[0]!.content).toBe("sys");
    expect(agent.messages[1]!.content).toContain("<对话摘要>");
    expect(agent.messages[1]!.content).toContain("用户在做 X");
    expect(agent.messages.slice(2).map((m) => m.content)).toEqual(["m2", "a2"]);
    expect(events).toContain("compact");
  });

  test("P0-2：保留最近原文，且不拆散 assistant(tool_calls) 与 tool 结果", async () => {
    const { fn } = fakeStream([() => ({ content: "摘要" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    const toolCall: ToolCall = {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
    };
    const convo: Message[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "", tool_calls: [toolCall] },
      { role: "tool", tool_call_id: "call_1", name: "read_file", content: "file body" },
      { role: "assistant", content: "a4" },
      { role: "user", content: "u5" },
      { role: "assistant", content: "a5" },
    ];
    agent.messages.push(...convo);
    await agent.compactNow();

    // system + 摘要 + 保留的最近 6 条
    expect(agent.messages).toHaveLength(2 + 6);
    const tail = agent.messages.slice(2);
    expect(tail.map((m) => m.content)).toEqual(["u3", "", "file body", "a4", "u5", "a5"]);
    // 保留段以 user 开头；tool 结果仍紧跟在带 tool_calls 的 assistant 之后
    expect(tail[0]!.role).toBe("user");
    expect(tail[1]!.tool_calls?.[0]?.id).toBe("call_1");
    expect(tail[2]!.role).toBe("tool");
    expect(agent.messages[1]!.content).toContain("最近 6 条保留原文");
  });

  test("P0-2：摘要器输入不再按 160 字符截断", async () => {
    const longLine = `const cmd = "${"pnpm test --filter=very-long-package-name ".repeat(12)}";`;
    const { fn, inputs } = fakeStream([() => ({ content: "摘要" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    agent.messages.push(
      { role: "user", content: longLine },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
      { role: "assistant", content: "a4" },
    );
    await agent.compactNow();

    // 第 1 次调用是压缩器：系统提示 + 用户 prompt
    const prompt = contentText(inputs[0]?.[1]?.content ?? null) ?? "";
    expect(prompt).toContain(longLine.slice(0, 300));
    expect(prompt).toContain("较早的历史");
  });

  test("P0-2：压缩调用自身的 usage 计入累计", async () => {
    const { fn } = fakeStream([
      () => ({
        content: "摘要",
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      }),
    ]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    agent.messages.push(
      { role: "user", content: "m1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "m2" },
      { role: "assistant", content: "a2" },
    );
    await agent.compactNow();
    expect(agent.cumulative).toEqual({ prompt: 120, completion: 30, reasoning: 0 });
  });

  test("P0-2：短历史的最后 user 提问必须保留为原文（切点回退修复）", async () => {
    const { fn } = fakeStream([() => ({ content: "摘要" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    const toolCall: ToolCall = {
      id: "call_short",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    };
    // 6 条：切点初始落在 tool，向下回退会到 0 —— 修复前只剩 1 条 assistant
    agent.messages.push(
      { role: "user", content: "u0" },
      { role: "assistant", content: "", tool_calls: [toolCall] },
      { role: "tool", tool_call_id: "call_short", name: "read_file", content: "body" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    );
    await agent.compactNow();
    const tail = agent.messages.slice(2);
    expect(tail.map((m) => m.content)).toEqual(["u1", "a1"]);
    expect(tail[0]!.role).toBe("user");
  });

  test("P0-2：10–11 条历史仍保留 ≥6 条原文", async () => {
    for (const len of [10, 11]) {
      const { fn } = fakeStream([() => ({ content: "摘要" })]);
      const agent = new Agent({
        cfg: makeCfg(),
        console: spyConsole(),
        mode: "auto-all",
        systemPrompt: "sys",
        chatStream: fn,
      });
      for (let i = 0; i < len; i++) {
        agent.messages.push(
          i % 2 === 0
            ? { role: "user", content: `u${i}` }
            : { role: "assistant", content: `a${i}` },
        );
      }
      await agent.compactNow();
      expect(agent.messages.slice(2).length).toBeGreaterThanOrEqual(6);
      expect(agent.messages[2]!.role).toBe("user");
    }
  });

  test("压缩器返回空内容：compactNow 抛错，compact 返回 false", async () => {    const { fn } = fakeStream([() => ({ content: "" })]);
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    agent.messages.push(
      { role: "user", content: "m1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "m2" },
      { role: "assistant", content: "a2" },
    );
    expect(agent.compactNow()).rejects.toThrow("空摘要");
    expect(await agent.compact()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 端到端：工具循环收口                                                */
/* ------------------------------------------------------------------ */

describe("compact_ctx 端到端", () => {
  test("模型调工具 → 收口压缩 → 下一轮请求看到摘要后的历史", async () => {
    const { msgCounts, fn } = fakeStream([
      // 第 1 轮：模型调 compact_ctx
      () => ({ toolCalls: [tc("compact_ctx", { reason: "阶段切换" })] }),
      // 压缩器调用
      () => ({ content: "## 摘要\n已完成探索。" }),
      // 第 2 轮：正常收尾
      () => ({ content: "done" }),
    ]);
    const infos: string[] = [];
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole({
        info(msg: string): void {
          infos.push(msg);
        },
      }),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    // 预置足够长的历史（> 4 条非 system 消息）
    agent.messages.push(
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    );
    const stats = await agent.send("继续");
    expect(stats.aborted).toBe(false);

    // 压缩确实执行了
    expect(infos.some((m) => m.includes("已按模型请求压缩上下文"))).toBe(true);
    // 历史：system + 摘要 + 最近 5 条原文 + 最终 assistant（P0-2 保留原文）
    expect(agent.messages).toHaveLength(8);
    expect(agent.messages[1]!.content).toContain("<对话摘要>");
    // 三次 LLM 调用：round1（7 条）→ 压缩器（2 条）→ round2（7 条 + budgetMsg = 8）
    expect(msgCounts).toEqual([7, 2, 8]);
    // 压缩后保留的最近段必须以 user 开头，工具调用与结果不能被拆散
    expect(agent.messages[2]!.role).toBe("user");
  });

  test("压缩器失败：本轮不中断，失败原因回灌给模型", async () => {
    const { fn } = fakeStream([
      // 第 1 轮：模型调 compact_ctx
      () => ({ toolCalls: [tc("compact_ctx", {})] }),
      // 压缩器调用：返回空 → 失败
      () => ({ content: "" }),
      // 第 2 轮：模型看到失败说明后正常收尾
      () => ({ content: "ok" }),
    ]);
    const warns: string[] = [];
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole({
        warn(msg: string): void {
          warns.push(msg);
        },
      }),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: fn,
    });
    // 预置 4 条非 system 历史：太短会让压缩器在发起 LLM 调用前就抛「对话太短」，
    // 这里要让失败发生在「压缩器返回空内容」这一步，验证 LLM 失败路径。
    agent.messages.push(
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    );
    const stats = await agent.send("继续");
    expect(stats.aborted).toBe(false);
    expect(warns.some((m) => m.includes("compact_ctx 执行失败"))).toBe(true);
    const sysNote = agent.messages.find(
      (m) => m.role === "system" && (contentText(m.content) ?? "").includes("compact_ctx 执行失败"),
    );
    expect(sysNote).toBeDefined();
    // 最终 assistant 正常产出
    const last = agent.messages[agent.messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("ok");
  });
});

/* ------------------------------------------------------------------ */
/* 子代理排除                                                          */
/* ------------------------------------------------------------------ */

describe("子代理排除", () => {
  test("主代理 toolSpecsFor 含 compact_ctx（运行时工具对主代理可见）", () => {
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
    });
    const names = agent.toolSpecsFor().map((s) => s.function.name);
    expect(names).toContain("compact_ctx");
  });

  test("isSubagent=true 时排除 task 与 compact_ctx", () => {
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "sys",
      isSubagent: true,
    });
    const names = agent.toolSpecsFor().map((s) => s.function.name);
    expect(names).not.toContain("compact_ctx");
    expect(names).not.toContain("task");
  });

  test("排除表同时登记 task 与 compact_ctx", () => {
    expect(TOOL_NAMES_EXCLUDED_FOR_SUBAGENT).toContain("task");
    expect(TOOL_NAMES_EXCLUDED_FOR_SUBAGENT).toContain("compact_ctx");
  });

  test("toolSpecs()（全量）含 compact_ctx —— 主代理可见", () => {
    const names = toolSpecs().map((s) => s.function.name);
    expect(names).toContain("compact_ctx");
  });
});
