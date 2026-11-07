/**
 * thinking 块在 Agent 层的闭环：写入历史 → 下一轮请求带回 → 会话落盘/恢复后仍在。
 * 假 chatStream，不依赖网络。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent, type AgentIO } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult, ThinkingBlock, ToolCall } from "../src/llm.ts";
import { createSession, loadSession, saveSession } from "../src/session.ts";

const SANDBOX = join(tmpdir(), `neo-thinking-agent-${Date.now()}`);
mkdirSync(SANDBOX, { recursive: true });

function makeCfg(): Config {
  const provider = {
    name: "p1",
    type: "anthropic" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
  const route = { provider: "p1", model: null, fallbackAllowed: true };
  return {
    providerName: "p1",
    providerType: "anthropic",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m",
    providers: [provider],
    routes: { default: route, deep_reasoning: route, balanced: route, fast: route },
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

function quietIO(): AgentIO {
  const noop = (): void => {};
  return new Proxy(
    { width: 100, confirm: async () => true },
    { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : noop) },
  ) as unknown as AgentIO;
}

const T1: ThinkingBlock = { type: "thinking", thinking: "先查一下", signature: "SIG1" };
const T2: ThinkingBlock = { type: "thinking", thinking: "得出结论", signature: "SIG2" };
const CALL: ToolCall = { id: "call_1", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } };

describe("thinking_blocks 在 Agent 里的闭环", () => {
  test("带工具调用的轮次与最终回答都把思考块写进 assistant 消息，下一轮请求原样带回", async () => {
    const seen: Message[][] = [];
    let call = 0;
    const fn = (_cfg: Config, messages: Message[]): Promise<StreamResult> => {
      seen.push(messages.map((m) => ({ ...m })));
      call += 1;
      const base = { content: "", reasoning: "", toolCalls: [] as ToolCall[], finishReason: "stop", usage: null, raw: null };
      return Promise.resolve(
        call === 1
          ? { ...base, toolCalls: [CALL], finishReason: "tool_calls", thinkingBlocks: [T1] }
          : { ...base, content: "完成", thinkingBlocks: [T2] },
      );
    };
    const agent = new Agent({ cfg: makeCfg(), console: quietIO(), mode: "auto-all", systemPrompt: "sys", chatStream: fn });
    await agent.send("看看目录");

    const asst = agent.messages.filter((m) => m.role === "assistant");
    expect(asst[0]!.thinking_blocks).toEqual([T1]);
    expect(asst[0]!.tool_calls?.[0]?.id).toBe("call_1");
    expect(asst[1]!.thinking_blocks).toEqual([T2]);

    // 第二次请求里，第一条 assistant 消息仍带着 T1（带工具调用的多轮对话必须原样回传）
    const second = seen[1]!.find((m) => m.role === "assistant");
    expect(second?.thinking_blocks).toEqual([T1]);
  });

  test("没有思考块（OpenAI 路径 / 无 thinking 的模型）：消息上不出现该字段", async () => {
    const fn = (): Promise<StreamResult> =>
      Promise.resolve({ content: "好", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null });
    const agent = new Agent({ cfg: makeCfg(), console: quietIO(), mode: "auto-all", systemPrompt: "sys", chatStream: fn });
    await agent.send("hi");
    const a = agent.messages.find((m) => m.role === "assistant")!;
    expect("thinking_blocks" in a).toBe(false);
  });

  test("会话落盘并恢复后思考块仍在（resume 后继续多轮工具对话不丢签名）", () => {
    process.env["NEO_SESSIONS_DIR"] = mkdtempSync(join(tmpdir(), "neo-sess-"));
    const { meta } = createSession("m", SANDBOX);
    const msgs: Message[] = [
      { role: "user", content: "x" },
      { role: "assistant", content: "y", thinking_blocks: [T1], tool_calls: [CALL] },
    ];
    saveSession(msgs, meta);
    const back = loadSession(meta.id)!;
    expect(back.messages[1]!.thinking_blocks).toEqual([T1]);
    delete process.env["NEO_SESSIONS_DIR"];
  });
});
