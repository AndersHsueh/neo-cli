/**
 * btw.test.ts — /btw 旁支提问（issue #61）。
 *
 * 覆盖（tests/README.md §4）：
 *  - E1 旁支回答基于当前会话上下文（fake chatStream 断言收到的 messages 含前文与本次问题）。
 *  - E2 问题与回答都不入 agent.messages，也不落 session 文件。
 *  - E3 发给模型的请求不带任何工具（tools 为空数组）。
 *  - E4 主轮次在途时插问：主轮次正常收口、消息不丢不乱。
 *  - E5 缺参数 / oneshot 模式 / 模型失败 → 可读提示且不崩（经 dispatchCommand 真实分发）。
 *  - E6 /btw 出现在命令声明表 COMMANDS（补全可见）。
 *
 * 不触网、不用 mock.module（bun test 单进程共享模块表）；沙箱目录 afterAll 清理，
 * NEO_SESSIONS_DIR 注入后还原。运行：bun test tests/btw.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent } from "../src/agent.ts";
import type { AgentIO } from "../src/agent.ts";
import { dispatchCommand, wireCommands } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commands.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { saveSession } from "../src/session.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult } from "../src/llm.ts";

const SANDBOX = join(tmpdir(), "neo-btw-test-" + Date.now());
mkdirSync(SANDBOX, { recursive: true });
const SESSIONS = join(SANDBOX, "sessions");
const OLD_SESSIONS_ENV = process.env["NEO_SESSIONS_DIR"];
process.env["NEO_SESSIONS_DIR"] = SESSIONS;
afterAll(() => {
  if (OLD_SESSIONS_ENV === undefined) delete process.env["NEO_SESSIONS_DIR"];
  else process.env["NEO_SESSIONS_DIR"] = OLD_SESSIONS_ENV;
  rmSync(SANDBOX, { recursive: true, force: true });
});

wireCommands();

/* ------ 脚手架（本地定义：tests/helpers.ts 只有 captureConsole，无共享 makeCfg） ------ */

function result(part: Partial<StreamResult>): StreamResult {
  return { content: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null, ...part };
}

function makeCfg(): Config {
  const provider = {
    name: "p1", type: "openai" as const, baseUrl: "http://localhost:0", apiKey: "k",
    models: { default: "m-default", deep_reasoning: "m-deep", balanced: "m-bal", fast: "m-fast" },
    maxTokens: 100, temperature: 0.3, contextWindow: 100_000,
  };
  return {
    providerName: "p1", providerType: "openai", apiKey: "k", baseUrl: "http://localhost:0",
    modelTier: "default", model: "m-default", providers: [provider],
    routes: {
      default: { provider: "p1", model: null, fallbackAllowed: true },
      deep_reasoning: { provider: "p1", model: null, fallbackAllowed: true },
      balanced: { provider: "p1", model: null, fallbackAllowed: true },
      fast: { provider: "p1", model: null, fallbackAllowed: true },
    },
    classifierModel: "x", classifierProvider: "p1", legacyFormat: false,
    maxTokens: 100, temperature: 0.3, contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8, maxToolIterations: 80, toolOutputLimit: 30_000,
    theme: "matrix", showReasoning: false, cwd: SANDBOX, settingsPath: null,
    skillsStore: join(SANDBOX, "skills"),
    memory: {
      enabled: false, userLevelDir: join(SANDBOX, "mem"), userWikiDir: join(SANDBOX, "wiki"),
      journalDir: join(SANDBOX, "journal"),
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false, mode: "off" as const, modelTier: "fast", maxOpsPerTurn: 2,
        maxPagesPerSession: 8, minConfidence: 0.65, minInferredConfidence: 0.75,
        journalRetentionDays: 7, flushTimeoutMs: 3000,
      },
      quiet: true,
    },
  } as Config;
}

/** 任意方法调用都记录进 calls 的哑输出层（AgentIO / Console 双用，缺的方法自动补）。 */
function spyIO(): { calls: Record<string, string[]>; io: AgentIO } {
  const calls: Record<string, string[]> = {};
  const io = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== "string") return undefined;
      // noUncheckedIndexedAccess：索引访问结果可能 undefined，先取到局部变量再用。
      const bucket = (calls[prop] ??= []);
      return (...args: unknown[]) => {
        bucket.push(args.filter((a) => typeof a === "string").join(" "));
      };
    },
  }) as unknown as AgentIO;
  return { calls, io };
}

function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

function commandCtx(agent: Agent, ui: AgentIO, memoryMode?: "interactive" | "oneshot"): CommandContext {
  return {
    agent,
    ui: ui as unknown as CommandContext["ui"],
    cfg: makeCfg(),
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "btw-test", path: join(SESSIONS, "btw-test.json"), createdAt: "t", updatedAt: "t", model: "m-default", cwd: SANDBOX, turns: 0 },
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
    memoryMode,
  } as unknown as CommandContext;
}

describe("#61 /btw 旁支提问", () => {
  test("#61 E1+E3 旁支回答基于当前上下文，且请求不带任何工具", async () => {
    let turn = 0;
    let sideMessages: Message[] | null = null;
    let sideTools: unknown[] | null = null;
    const agent = new Agent({
      cfg: makeCfg(), console: spyIO().io, mode: "auto-all", systemPrompt: "sys",
      chatStream: async (_cfg, messages, tools) => {
        turn += 1;
        if (turn === 1) return result({ content: "好的，已记住。" });
        sideMessages = messages.map((m) => ({ ...m }));
        sideTools = tools as unknown[];
        return result({ content: "暗号是蓝鲸七号。" });
      },
    });
    await agent.send("暗号是蓝鲸七号，请记住");
    const r = await agent.askSide("刚才的暗号是什么？");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toBe("暗号是蓝鲸七号。");
    const texts = (sideMessages ?? []).map(textOf);
    expect(texts.some((t) => t.includes("蓝鲸七号"))).toBe(true);
    expect(texts.some((t) => t.includes("刚才的暗号是什么"))).toBe(true);
    expect(Array.isArray(sideTools)).toBe(true);
    expect((sideTools ?? []).length).toBe(0);
  });

  test("#61 E2 回答不入 agent.messages，也不落 session 文件", async () => {
    let turn = 0;
    const agent = new Agent({
      cfg: makeCfg(), console: spyIO().io, mode: "auto-all", systemPrompt: "sys",
      // 主轮次与旁支必须返回**不同**内容：否则「回答不入历史」这条断言会被主轮次
      // 自己的正文命中，分不清是旁支污染还是主轮次内容。
      chatStream: async () => {
        const n = turn++;
        return result({ content: n === 0 ? "主轮次回答" : "旁支回答内容XYZ" });
      },
    });
    await agent.send("主轮次消息");
    const before = agent.messages.length;
    const r = await agent.askSide("旁支问题ABC？");
    expect(r.ok).toBe(true);
    expect(agent.messages.length).toBe(before);
    const all = agent.messages.map(textOf).join("\n");
    expect(all).not.toContain("旁支问题ABC");
    expect(all).not.toContain("旁支回答内容XYZ");
    saveSession(agent.messages, {
      id: "btw-e2", path: join(SESSIONS, "btw-e2.json"), createdAt: "t", updatedAt: "t",
      model: "m-default", cwd: SANDBOX, turns: 1,
    });
    const raw = readFileSync(join(SESSIONS, "btw-e2.json"), "utf8");
    expect(raw).not.toContain("旁支问题ABC");
    expect(raw).not.toContain("旁支回答内容XYZ");
  });

  test("#61 E4 主轮次在途时插问：主轮次正常收口、消息不丢", async () => {
    let call = 0;
    let resolveMain!: (r: StreamResult) => void;
    const agent = new Agent({
      cfg: makeCfg(), console: spyIO().io, mode: "auto-all", systemPrompt: "sys",
      chatStream: async () => {
        call += 1;
        if (call === 1) return new Promise<StreamResult>((res) => { resolveMain = res; });
        return result({ content: "旁支回答" });
      },
    });
    const main = agent.send("主任务进行中");
    // 等主轮次真的把请求发出去（send 内部有多处 await）。不等就会让插问抢到
    // 「第 1 次调用」那个永不 resolve 的 promise —— 测的就不是「主轮次在途」而是
    // 「插问在途」，两种场景的失败含义完全不同。
    while (call === 0) await new Promise((r) => setTimeout(r, 1));
    const side = await agent.askSide("插问一句");
    expect(side.ok).toBe(true);
    resolveMain(result({ content: "主任务完成" }));
    await main;
    const texts = agent.messages.map(textOf);
    expect(texts.some((t) => t.includes("主任务进行中"))).toBe(true);
    expect(texts.some((t) => t.includes("主任务完成"))).toBe(true);
    expect(texts.some((t) => t.includes("插问一句"))).toBe(false);
    expect(texts.some((t) => t.includes("旁支回答"))).toBe(false);
  });

  test("#61 E5a 缺参数：只提示用法，不发请求", async () => {
    let requested = false;
    const agent = new Agent({
      cfg: makeCfg(), console: spyIO().io, mode: "auto-all", systemPrompt: "sys",
      chatStream: async () => { requested = true; return result({ content: "x" }); },
    });
    const { calls, io } = spyIO();
    await dispatchCommand("/btw", commandCtx(agent, io));
    expect(requested).toBe(false);
    expect((calls["warn"] ?? []).some((w) => w.includes("用法"))).toBe(true);
  });

  test("#61 E5b oneshot（-p）模式不可用：提示且不发请求", async () => {
    let requested = false;
    const agent = new Agent({
      cfg: makeCfg(), console: spyIO().io, mode: "auto-all", systemPrompt: "sys",
      chatStream: async () => { requested = true; return result({ content: "x" }); },
    });
    const { calls, io } = spyIO();
    await dispatchCommand("/btw 顺便问下", commandCtx(agent, io, "oneshot"));
    expect(requested).toBe(false);
    expect((calls["warn"] ?? []).length).toBeGreaterThan(0);
  });

  test("#61 E5c 模型失败：可读错误提示且不崩", async () => {
    const agent = new Agent({
      cfg: makeCfg(), console: spyIO().io, mode: "auto-all", systemPrompt: "sys",
      chatStream: async () => { throw new Error("boom-网络炸了"); },
    });
    const { calls, io } = spyIO();
    await dispatchCommand("/btw 顺便问下", commandCtx(agent, io));
    expect((calls["warn"] ?? []).some((w) => w.includes("/btw 失败") && w.includes("boom-网络炸了"))).toBe(true);
  });

  test("#61 E6 /btw 在命令声明表里", () => {
    const entry = COMMANDS.find((c) => c.name === "btw");
    expect(entry).toBeDefined();
    expect((entry?.description ?? "").length).toBeGreaterThan(0);
  });
});
