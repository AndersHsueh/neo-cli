/**
 * v0.4.1 A2：上下文溢出恢复。
 *
 * 场景：服务端返回 400 context length，neo 解析真实窗口 → 压缩 → 同一轮重试一次。
 * 覆盖：恢复成功、第二次仍溢出、非上下文 4xx 不误触发。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent } from "../src/agent.ts";
import type { Classifier } from "../src/classifier/index.ts";
import type { Config } from "../src/config.ts";
import { LLMError, type Message, type StreamResult } from "../src/llm.ts";
import { captureConsole } from "./helpers.ts";

function makeCfg(): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m1",
    providers: [
      {
        name: "p1",
        type: "openai",
        baseUrl: "http://localhost:0",
        apiKey: "k",
        models: {
          default: "m1",
          deep_reasoning: "m-deep",
          balanced: "m-bal",
          fast: "m-fast",
        },
        maxTokens: null,
        temperature: null,
        contextWindow: null,
      },
    ],
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
    temperature: 0,
    contextWindow: 100_000,
    contextWindowSource: "config",
    globalDefaults: { maxTokens: 100, temperature: 0, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 10,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    cwd: join(tmpdir(), "neo-ctx"),
    settingsPath: null,
    skillsStore: join(tmpdir(), "neo-ctx-skills"),
    memory: {
      enabled: false,
      userLevelDir: join(tmpdir(), "neo-ctx-mem"),
      userWikiDir: join(tmpdir(), "neo-ctx-wiki"),
      journalDir: join(tmpdir(), "neo-ctx-journal"),
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
  } as unknown as Config;
}

function seedHistory(agent: Agent): void {
  agent.messages.push(
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "u3" },
    { role: "assistant", content: "a3" },
  );
}

const OVERFLOW = (): LLMError =>
  new LLMError("This model's maximum context length is 128000 tokens", 400);

describe("A2 上下文溢出恢复", () => {
  test("400 context → 解析窗口 → 压缩 → 重试成功", async () => {
    let calls = 0;
    const seenMaxTokens: number[] = [];
    const onLimit: number[] = [];
    const stream = async (cfg: Config): Promise<StreamResult> => {
      calls += 1;
      seenMaxTokens.push(cfg.maxTokens);
      if (calls === 1) throw OVERFLOW();
      if (calls === 2) {
        return { content: "## 摘要\n压缩完成", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null } as StreamResult;
      }
      return { content: "恢复后的答案", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null } as StreamResult;
    };
    const cfg = makeCfg();
    const agent = new Agent({
      cfg,
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
      onContextLimit: (tokens) => onLimit.push(tokens),
    });
    seedHistory(agent);

    const stats = await agent.send("继续");
    expect(stats.hadError).toBe(false);
    expect(calls).toBe(3);
    expect(cfg.contextWindow).toBe(128_000);
    expect(cfg.contextWindowSource).toBe("overflow_error");
    expect(onLimit).toEqual([128_000]);
    expect(agent.messages[agent.messages.length - 1]?.content).toBe("恢复后的答案");
    expect(agent.lastCompactionInfo).not.toBeNull();
  });

  test("第二次仍溢出 → 明确失败，不无限重试", async () => {
    let calls = 0;
    const stream = async (): Promise<StreamResult> => {
      calls += 1;
      throw OVERFLOW();
    };
    const cfg = makeCfg();
    const agent = new Agent({
      cfg,
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
    });
    seedHistory(agent);

    const stats = await agent.send("继续");
    expect(stats.hadError).toBe(true);
    expect(stats.errorMessage).toContain("已尝试压缩仍超限");
    expect(calls).toBe(3); // 主请求 → 压缩请求（失败）→ 重试请求
    expect(cfg.contextWindow).toBe(128_000);
  });

  test("最后一次迭代溢出：不得静默按 ok 收口", async () => {
    let calls = 0;
    const stream = async (): Promise<StreamResult> => {
      calls += 1;
      throw OVERFLOW();
    };
    const cfg = makeCfg();
    cfg.maxToolIterations = 1;
    const agent = new Agent({
      cfg,
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
    });
    seedHistory(agent);
    const stats = await agent.send("继续");
    expect(stats.hadError).toBe(true);
    expect(stats.errorMessage).toContain("没有产出最终回答");
    expect(stats.aborted).toBe(false);
    expect(calls).toBe(2); // 主请求 + 恢复分支里的压缩请求
  });

  test("分类切 fast：tier_switch 事件先于请求，且首请求已是 fast", async () => {
    const events: string[] = [];
    const seen: string[] = [];
    const stream = async (cfg: Config): Promise<StreamResult> => {
      seen.push(cfg.model);
      events.push("stream");
      return {
        content: "ok",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
        raw: null,
      } as StreamResult;
    };
    const classifier = {
      classify: async () => ({ tier: "fast" as const, reason: "简单问题", source: "fallback" }),
    } as unknown as Classifier;
    const cfg = makeCfg();
    const agent = new Agent({
      cfg,
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
      classifier,
      onEvent: (e) => {
        if (e.type === "tier_switch") events.push("tier_switch");
      },
    });
    const stats = await agent.send("列一下文件");
    expect(events[0]).toBe("tier_switch");
    expect(seen[0]).toBe("m-fast");
    expect(stats.tierSwitch?.to).toBe("fast");
  });

  test("普通 400（非上下文）不触发压缩重试", async () => {
    let calls = 0;
    const stream = async (): Promise<StreamResult> => {
      calls += 1;
      throw new LLMError("invalid api key", 401);
    };
    const agent = new Agent({
      cfg: makeCfg(),
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
    });
    seedHistory(agent);
    const stats = await agent.send("继续");
    expect(stats.hadError).toBe(true);
    expect(calls).toBe(1);
    expect(stats.errorMessage).toContain("invalid api key");
  });
});
