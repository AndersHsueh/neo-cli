/**
 * v0.4.1 A1：轮次诊断 + 空响应硬化。
 *
 * 覆盖：空响应两轮 → 错误收口（不再静默 ok）、length 时放大 max_tokens 重试、
 * 正常轮诊断日志、outcome 判定、resume 告警、session meta lastTurn 持久化。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import type { StreamResult } from "../src/llm.ts";
import { appendTurnLog, outcomeOf, formatResumeWarning } from "../src/turnDiagnostics.ts";
import { createSession, saveSession, loadSession } from "../src/session.ts";
import { captureConsole } from "./helpers.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-turn-diag-"));
const LOG_DIR = join(SANDBOX, "logs");
const SESSION_DIR = join(SANDBOX, "sessions");
const OLD_LOG = process.env["NEO_LOG_DIR"];
const OLD_SESS = process.env["NEO_SESSIONS_DIR"];

beforeAll(() => {
  process.env["NEO_LOG_DIR"] = LOG_DIR;
  process.env["NEO_SESSIONS_DIR"] = SESSION_DIR;
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(SESSION_DIR, { recursive: true });
});

afterAll(() => {
  if (OLD_LOG === undefined) delete process.env["NEO_LOG_DIR"];
  else process.env["NEO_LOG_DIR"] = OLD_LOG;
  if (OLD_SESS === undefined) delete process.env["NEO_SESSIONS_DIR"];
  else process.env["NEO_SESSIONS_DIR"] = OLD_SESS;
  rmSync(SANDBOX, { recursive: true, force: true });
});

function makeCfg(maxTokens = 100): Config {
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
    maxTokens,
    temperature: 0,
    contextWindow: 100_000,
    globalDefaults: { maxTokens, temperature: 0, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 10,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
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
  } as unknown as Config;
}

interface Call {
  maxTokens: number;
}

function emptyStream(
  calls: Call[],
  finishReason: string,
  content = "",
): (cfg: Config) => Promise<StreamResult> {
  return async (cfg: Config) => {
    calls.push({ maxTokens: cfg.maxTokens });
    return {
      content,
      reasoning: "reasoning-only",
      toolCalls: [],
      finishReason,
      usage: null,
      raw: null,
    } as StreamResult;
  };
}

function readLastLog(): Record<string, unknown> {
  const day = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  const file = join(LOG_DIR, "turns", `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}.jsonl`);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
}

describe("A1 空响应硬化", () => {
  test("连续两轮空正文：按错误收口、写诊断日志、不伪造 assistant", async () => {
    const calls: Call[] = [];
    const agent = new Agent({
      cfg: makeCfg(),
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: emptyStream(calls, "stop"),
      sessionId: "sess-empty",
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(true);
    expect(stats.emptyResponse).toBe(true);
    expect(stats.errorMessage).toContain("连续两轮未产出正文");
    expect(calls).toHaveLength(2);
    expect(agent.messages.filter((m) => m.role === "assistant")).toHaveLength(0);

    const log = readLastLog();
    expect(log["sessionId"]).toBe("sess-empty");
    expect(log["emptyResponse"]).toBe(true);
    expect(log["hadError"]).toBe(true);
    expect(String(log["errorMessage"])).toContain("连续两轮");
  });

  test("finishReason=length：第二次请求自动放大 max_tokens", async () => {
    const calls: Call[] = [];
    let n = 0;
    const stream = async (cfg: Config): Promise<StreamResult> => {
      calls.push({ maxTokens: cfg.maxTokens });
      n += 1;
      return {
        content: n === 1 ? "" : "ok",
        reasoning: "thinking",
        toolCalls: [],
        finishReason: n === 1 ? "length" : "stop",
        usage: null,
        raw: null,
      } as StreamResult;
    };
    const agent = new Agent({
      cfg: makeCfg(100),
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
      sessionId: "sess-length",
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false);
    expect(stats.emptyResponse).toBe(false);
    expect(agent.messages[agent.messages.length - 1]?.content).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.maxTokens).toBeGreaterThan(calls[0]!.maxTokens);
  });

  test("正常轮日志记录 finishReason/usage/contextUsage", async () => {
    const stream = async (): Promise<StreamResult> =>
      ({
        content: "done",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        raw: null,
      }) as StreamResult;
    const agent = new Agent({
      cfg: makeCfg(),
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: stream,
      sessionId: "sess-ok",
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false);
    const log = readLastLog();
    expect(log["sessionId"]).toBe("sess-ok");
    expect(log["finishReason"]).toBe("stop");
    expect(log["promptTokens"]).toBe(12);
    expect(log["contextUsage"]).toBeGreaterThan(0);
  });
});

describe("A1 状态归一与恢复告警", () => {
  test("outcomeOf：aborted > error/empty > ok", () => {
    expect(outcomeOf({ aborted: false, hadError: false, emptyResponse: false })).toBe("ok");
    expect(outcomeOf({ aborted: false, hadError: true, emptyResponse: false })).toBe("error");
    expect(outcomeOf({ aborted: false, hadError: false, emptyResponse: true })).toBe("error");
    expect(outcomeOf({ aborted: true, hadError: true, emptyResponse: true })).toBe("aborted");
  });

  test("formatResumeWarning：只有异常轮才告警", () => {
    expect(formatResumeWarning(null)).toBeNull();
    expect(formatResumeWarning({})).toBeNull();
    expect(formatResumeWarning({ lastTurn: { at: "t", outcome: "ok", finishReason: "stop" } })).toBeNull();
    const warning = formatResumeWarning({
      lastTurn: { at: "t", outcome: "error", finishReason: null, errorMessage: "上下文超限" },
    });
    expect(warning).toContain("上下文超限");
  });

  test("session meta lastTurn 可持久化并读回", async () => {
    const sess = createSession("m", SANDBOX);
    sess.meta.lastTurn = {
      at: "2026-10-26T09:10:38.000Z",
      outcome: "error",
      finishReason: null,
      errorMessage: "模型连续两轮未产出正文",
    };
    saveSession([{ role: "user", content: "hi" }], sess.meta);
    const loaded = loadSession(sess.meta.id);
    expect(loaded?.meta.lastTurn?.outcome).toBe("error");
    expect(loaded?.meta.lastTurn?.errorMessage).toContain("连续两轮");
  });

  test("appendTurnLog 在坏目录下返回 null 而不抛", () => {
    const r = appendTurnLog(
      {
        sessionId: "x",
        turn: 1,
        provider: "p",
        model: "m",
        durationMs: 1,
        iterations: 1,
        toolCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        finishReason: "stop",
        aborted: false,
        hadError: false,
        emptyResponse: false,
        errorMessage: null,
        contextWindow: 1,
        contextUsage: 0,
      },
      { root: "/proc/definitely-not-writable" },
    );
    expect(r).toBeNull();
  });
});
