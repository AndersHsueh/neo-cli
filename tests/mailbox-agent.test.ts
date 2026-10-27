/**
 * mailbox-agent.test.ts — P1 注入点协议合法性（M2）。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2 §4.4。
 * 断言：跨会话消息只在「工具批次结束后的下一次迭代、自动 compact 之后」注入，
 * 注入序列为 assistant(tool_calls) → tool → user(frame) → system(budget) → assistant。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../src/mailbox/types.ts";
import * as identity from "../src/mailbox/identity.ts";
import { Mailbox } from "../src/mailbox/store.ts";
import { registerTool } from "../src/tools/index.ts";
import { makeListPeersTool, makeSendMessageTool } from "../src/tools/mailbox.ts";

let SANDBOX = "";
beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-mailbox-agent-"));
  mkdirSync(join(SANDBOX, "work"), { recursive: true });
});
afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function makeCfg(): Config {
  const provider = {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
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
    model: "m",
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
    maxToolIterations: 4,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    paste: { foldLines: 3, foldChars: 300, imageMaxBytes: 8_388_608 },
    mailbox: DEFAULT_MAILBOX_CONFIG,
    crossSessionInbound: "auto",
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
  } as Config;
}

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

function result(over: Partial<StreamResult>): StreamResult {
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

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe("P1 注入点", () => {
  test("A1 只在工具批次结束后的下一次迭代注入一次，且位于 tool 结果之后", async () => {
    const calls: { index: number; messages: Message[] }[] = [];
    let pollCount = 0;
    const frame = '<跨会话消息 id="msg-x" from="@peer" session="2026" mode="ask">hello</跨会话消息>';
    const chatStream = async (
      _cfg: Config,
      messages: Message[],
    ): Promise<StreamResult> => {
      calls.push({ index: calls.length + 1, messages: messages.map((m) => ({ ...m })) });
      if (calls.length === 1) {
        return result({
          content: "",
          toolCalls: [toolCall("c1", "list_dir", { path: join(SANDBOX, "work") })],
          finishReason: "tool_calls",
        });
      }
      return result({ content: "done" });
    };

    const agent = new Agent({
      cfg: makeCfg(),
      console: silentConsole(),
      mode: "ask",
      systemPrompt: "sys",
      chatStream,
      pollInbox: () => {
        pollCount++;
        return [frame];
      },
    });
    const stats = await agent.send("do work");
    expect(stats.aborted).toBe(false);
    expect(pollCount).toBe(1);

    // 第二次请求的消息序列：... assistant(tool_calls), tool, user(frame), system(budget)
    const second = calls[1]!.messages;
    const toolIdx = second.findIndex((m) => m.role === "tool");
    expect(toolIdx).toBeGreaterThan(0);
    const userAfterTool = second.slice(toolIdx + 1).find((m) => m.role === "user");
    expect(userAfterTool?.content).toBe(frame);
    const sysAfterUser = second.slice(second.indexOf(userAfterTool!)).find((m) => m.role === "system");
    expect(typeof sysAfterUser?.content).toBe("string");
    expect(String(sysAfterUser?.content)).toContain("本轮工具调用");
  });

  test("A2 没有工具调用的 turn 不触发 pollInbox（P1 只在工具间隙）", async () => {
    let pollCount = 0;
    let callNo = 0;
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentConsole(),
      mode: "ask",
      systemPrompt: "sys",
      chatStream: async () => {
        callNo++;
        return result({ content: "direct answer" });
      },
      pollInbox: () => {
        pollCount++;
        return ["frame"];
      },
    });
    await agent.send("hi");
    expect(callNo).toBe(1);
    expect(pollCount).toBe(0);
  });

  test("A3 pollInbox 抛错不击穿主循环：记警告后按无消息继续", async () => {
    let callNo = 0;
    const warnings: string[] = [];
    const console = silentConsole();
    console.warn = (msg: string): void => {
      warnings.push(msg);
    };
    const agent = new Agent({
      cfg: makeCfg(),
      console,
      mode: "ask",
      systemPrompt: "sys",
      chatStream: async () => {
        callNo++;
        if (callNo === 1) {
          return result({
            toolCalls: [toolCall("c1", "list_dir", { path: join(SANDBOX, "work") })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "done" });
      },
      pollInbox: () => {
        throw new Error("mailbox unavailable");
      },
    });
    const stats = await agent.send("do work");
    expect(stats.aborted).toBe(false);
    expect(callNo).toBe(2);
    expect(warnings.join("\n")).toContain("跨会话信箱轮询失败");
  });
});

describe("运行时工具可见性", () => {
  test("主代理 toolSpecsFor 含 send_message/list_peers；isSubagent=true 被排除", () => {
    const root = mkdtempSync(join(SANDBOX, "vis-"));
    const sid = "20261020-100000-visxxx";
    identity.createIdentity({ root, sessionId: sid, cwd: SANDBOX, name: "vis", mode: "ask", nowMs: Date.now() });
    const mb = new Mailbox({ root, sessionId: sid });
    const offSend = registerTool(makeSendMessageTool({ mailbox: mb }));
    const offPeers = registerTool(makeListPeersTool({ mailbox: mb }));
    try {
      const main = new Agent({
        cfg: makeCfg(),
        console: silentConsole(),
        mode: "ask",
        systemPrompt: "sys",
      });
      const sub = new Agent({
        cfg: makeCfg(),
        console: silentConsole(),
        mode: "ask",
        systemPrompt: "sys",
        isSubagent: true,
      });
      const mainNames = main.toolSpecsFor().map((s) => s.function.name);
      expect(mainNames).toContain("send_message");
      expect(mainNames).toContain("list_peers");
      expect(mainNames).toContain("compact_ctx");

      const subNames = sub.toolSpecsFor().map((s) => s.function.name);
      expect(subNames).not.toContain("send_message");
      expect(subNames).not.toContain("list_peers");
      expect(subNames).not.toContain("compact_ctx");
    } finally {
      offPeers();
      offSend();
      identity.releaseAlive(root, sid);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 目标锚注入（2026-10-26）                                            */
/* ------------------------------------------------------------------ */

describe("目标锚注入", () => {
  /** 跑一轮带一次工具调用的 turn，返回每次请求的 messages 快照。 */
  async function runOneToolTurn(opts: { readGoal?: () => string | null }): Promise<Message[][]> {
    const calls: Message[][] = [];
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentConsole(),
      mode: "ask",
      systemPrompt: "sys",
      ...(opts.readGoal ? { readGoal: opts.readGoal } : {}),
      chatStream: async (_cfg, messages) => {
        calls.push(messages.map((m) => ({ ...m })));
        if (calls.length === 1) {
          return result({
            content: "",
            toolCalls: [toolCall("c1", "list_dir", { path: join(SANDBOX, "work") })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "done" });
      },
    });
    await agent.send("do work");
    return calls;
  }

  test("设了目标：预算提示里同时含目标原文与「不可修改」约束", async () => {
    const calls = await runOneToolTurn({ readGoal: () => "找出这篇博客的作者" });
    const budget = calls[0]!.find((m) => m.role === "system" && String(m.content).includes("本轮工具调用"));
    expect(budget).toBeDefined();
    const text = String(budget!.content);
    expect(text).toContain("找出这篇博客的作者");
    expect(text).toContain("不可修改");
  });

  test("未设目标：提示退化为纯预算，不出现目标段（与旧行为一致）", async () => {
    const calls = await runOneToolTurn({ readGoal: () => null });
    const budget = calls[0]!.find((m) => m.role === "system" && String(m.content).includes("本轮工具调用"));
    expect(budget).toBeDefined();
    expect(String(budget!.content)).not.toContain("原始目标");
  });

  test("readGoal 抛错不影响本轮（增强项降级为无目标）", async () => {
    const calls = await runOneToolTurn({
      readGoal: () => {
        throw new Error("state 读失败");
      },
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  test("目标提示是临时消息：不进历史（轮末摘除）", async () => {
    const calls = await runOneToolTurn({ readGoal: () => "目标 X" });
    const last = calls[calls.length - 1]!;
    // 最后一次请求里仍带着预算提示（请求前注入），但历史中不应累积多条
    const budgets = last.filter(
      (m) => m.role === "system" && String(m.content).includes("本轮工具调用"),
    );
    expect(budgets.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 手段/目标分层计数（2026-10-26）                                      */
/* ------------------------------------------------------------------ */

describe("capability 连续计数", () => {
  /** 连续调 N 次 shell（capability），再给答案；返回最后一次请求的 system 提示。 */
  async function runShellStreak(n: number, goal: string | null): Promise<string> {
    let round = 0;
    const calls: Message[][] = [];
    // 迭代上限必须 > n：第 n 次 capability 的计数要在**下一次请求**里才可见，
    // 上限正好等于 n 时循环已收口，看不到阈值提示。
    const cfg = { ...makeCfg(), maxToolIterations: n + 2 };
    const agent = new Agent({
      cfg,
      console: silentConsole(),
      mode: "ask",
      systemPrompt: "sys",
      ...(goal ? { readGoal: () => goal } : {}),
      chatStream: async (_cfg, messages) => {
        calls.push(messages.map((m) => ({ ...m })));
        round++;
        if (round <= n) {
          return result({
            content: "",
            toolCalls: [toolCall(`c${round}`, "shell", { command: "true" })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "done" });
      },
    });
    await agent.send("do work");
    const last = calls[calls.length - 1]!;
    const sys = last.filter((m) => m.role === "system" && String(m.content).includes("本轮工具调用"));
    return String(sys[sys.length - 1]?.content ?? "");
  }

  test("连续 2 次 capability：提示里出现计数 2，未触发阈值", async () => {
    const text = await runShellStreak(2, "找出作者");
    expect(text).toContain("已连续 2 次只扩展手段");
    expect(text).not.toContain("已超过");
  });

  test("连续 4 次 capability：触发阈值，要求回锚", async () => {
    const text = await runShellStreak(4, "找出作者");
    expect(text).toContain("已超过 4 次阈值");
    expect(text).toContain("把手段当成目标");
  });

  test("未设目标：不显示计数（没有目标就没有「离目标多远」）", async () => {
    const text = await runShellStreak(3, null);
    expect(text).not.toContain("只扩展手段");
  });
});
