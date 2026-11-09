/**
 * issue #16：后台子代理（task background 模式）。
 *
 * 覆盖：
 *  A `BackgroundTasks`：并发上限 / 完成收集只一次 / 失败与取消不汇报 / cancel 会 abort
 *  B `task` 工具：background:true 立刻返回（不调用同步 run）；未接线时明确报错；同步模式不变
 *  C Agent 主循环：每次请求前调用 pollBackground，把结果作为 user 消息注入
 */
import { describe, expect, test } from "bun:test";

import { Agent, type AgentIO } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult } from "../src/llm.ts";
import { BackgroundTasks } from "../src/tools/background.ts";
import { makeTaskTool } from "../src/tools/task.ts";
import { ToolError, type ToolCtx } from "../src/tools/types.ts";

function fakeCtx(): ToolCtx {
  return {
    cfg: { cwd: "/tmp", toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => true,
  };
}

/** 让 then/catch 回调有机会跑（后台任务完成是异步的）。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function deferredRunner(): {
  bg: BackgroundTasks;
  pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void; signal: AbortSignal }>;
} {
  const pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void; signal: AbortSignal }> = [];
  const bg = new BackgroundTasks({
    run: (_job, signal) =>
      new Promise<string>((resolve, reject) => {
        pending.push({ resolve, reject, signal });
      }),
  });
  return { bg, pending };
}

/* ------------------------------------------------------------------ */
/* A. 任务表                                                            */
/* ------------------------------------------------------------------ */

describe("A BackgroundTasks 任务表", () => {
  test("launch 立刻返回 id、running=1；完成后 collectFinished 只取一次", async () => {
    const { bg, pending } = deferredRunner();
    const r = bg.launch({ prompt: "探索依赖", ctx: fakeCtx() });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("期望成功");
    expect(r.job.id).toBe("bg-1");
    expect(bg.runningCount).toBe(1);

    pending[0]!.resolve("结论：依赖只有 a、b");
    await flush();
    expect(bg.runningCount).toBe(0);
    const first = bg.collectFinished();
    expect(first.length).toBe(1);
    expect(first[0]).toContain("后台子代理结果");
    expect(first[0]).toContain("依赖只有 a、b");
    // 只汇报一次
    expect(bg.collectFinished()).toEqual([]);
    expect(bg.list()[0]?.status).toBe("done");
  });

  test("并发上限：第 4 个直接拒绝，不静默排队", () => {
    const { bg } = deferredRunner();
    for (let i = 0; i < 3; i++) expect(bg.launch({ prompt: `t${i}`, ctx: fakeCtx() }).ok).toBe(true);
    const over = bg.launch({ prompt: "t4", ctx: fakeCtx() });
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error("期望拒绝");
    expect(over.error).toContain("并发上限");
  });

  test("失败任务：状态 error、结果块带失败原因", async () => {
    const { bg, pending } = deferredRunner();
    bg.launch({ prompt: "x", ctx: fakeCtx() });
    pending[0]!.reject(new Error("子代理炸了"));
    await flush();
    const out = bg.collectFinished();
    expect(out[0]).toContain("status=\"error\"");
    expect(out[0]).toContain("子代理炸了");
  });

  test("cancel 会 abort 任务、标记 cancelled，且不向主会话汇报", async () => {
    const { bg, pending } = deferredRunner();
    const r = bg.launch({ prompt: "长任务", ctx: fakeCtx() });
    if (!r.ok) throw new Error("期望成功");
    expect(bg.cancel(r.job.id)).toBe(1);
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(bg.runningCount).toBe(0);
    expect(bg.collectFinished()).toEqual([]);
    expect(bg.list()[0]?.status).toBe("cancelled");
    // 再发 abort 后的完成也不算数
    pending[0]!.resolve("不该盖掉 cancelled");
    await flush();
    expect(bg.list()[0]?.status).toBe("cancelled");
  });

  test("cancel('all') 取消全部；未知 id 返回 0", async () => {
    const { bg } = deferredRunner();
    bg.launch({ prompt: "a", ctx: fakeCtx() });
    bg.launch({ prompt: "b", ctx: fakeCtx() });
    expect(bg.cancel("nope")).toBe(0);
    expect(bg.cancel("all")).toBe(2);
    expect(bg.runningCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* B. task 工具                                                         */
/* ------------------------------------------------------------------ */

describe("B task 工具 background 模式", () => {
  function toolWith(over: { run?: (p: string) => Promise<string>; background?: boolean } = {}) {
    const launched: string[] = [];
    const tool = makeTaskTool({
      run: over.run ?? (async () => "sync-result"),
      background: over.background === false
        ? undefined
        : {
            launch: (job) => {
              launched.push(job.prompt);
              return { ok: true, id: "bg-7" };
            },
          },
    });
    return { tool, launched };
  }

  test("background:true → 立刻返回任务 id，不调用同步 run", async () => {
    let syncCalled = 0;
    const { tool, launched } = toolWith({
      run: async () => {
        syncCalled += 1;
        return "sync";
      },
    });
    const out = await tool.execute({ prompt: "深挖依赖", background: true }, fakeCtx());
    expect(String(out)).toContain("bg-7");
    expect(String(out)).toContain("/tasks");
    expect(syncCalled).toBe(0);
    expect(launched).toEqual(["深挖依赖"]);
  });

  test("background:true 但未接线 → 明确报错，不退化成同步静默执行", async () => {
    const { tool } = toolWith({ background: false });
    await expect(tool.execute({ prompt: "x", background: true }, fakeCtx())).rejects.toBeInstanceOf(ToolError);
  });

  test("未传 background → 旧同步行为不变", async () => {
    const { tool, launched } = toolWith({ run: async () => "sync-result" });
    const out = await tool.execute({ prompt: "算个数" }, fakeCtx());
    expect(String(out)).toBe("sync-result");
    expect(launched).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* C. 主循环注入                                                        */
/* ------------------------------------------------------------------ */

function silentConsole(): AgentIO {
  return {
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
}

function makeCfg(): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m",
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
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 4,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    paste: { foldLines: 3, foldChars: 300, imageMaxBytes: 8_388_608 },
    mailbox: {
      autoTurnLimit: 20,
      heartbeatMs: 120_000,
      deadAfterMs: 120_000,
      progressTimeoutMs: 600_000,
      watchdogIntervalS: 120,
    },
    crossSessionInbound: "auto",
    cwd: "/tmp",
    settingsPath: null,
    skillsStore: "/tmp/skills",
    memory: {
      enabled: false,
      userLevelDir: "/tmp/mem",
      userWikiDir: "/tmp/wiki",
      journalDir: "/tmp/journal",
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
        quiet: true,
      },
      quiet: true,
    },
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

function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

describe("C 主循环注入后台结果", () => {
  test("每次请求前调用 pollBackground，把结果作为 user 消息注入（只注入一次）", async () => {
    const calls: Message[][] = [];
    let polls = 0;
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "sys",
      chatStream: async (_cfg, messages) => {
        calls.push(messages.map((m) => ({ ...m })));
        return result({ content: "ok" });
      },
      pollBackground: () => {
        polls += 1;
        return polls === 1 ? ['<后台子代理结果 id="bg-1" status="done">结论 OK</后台子代理结果>'] : [];
      },
    });
    await agent.send("hi");
    expect(polls).toBe(1);
    const first = calls[0]!;
    expect(first.some((m) => m.role === "user" && textOf(m).includes("后台子代理结果"))).toBe(true);
    // 只注入一次
    expect(agent.messages.filter((m) => textOf(m).includes("后台子代理结果")).length).toBe(1);
  });
});
