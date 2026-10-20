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
