/**
 * issue #84：子代理工具排除表必须在 dispatch 层校验，且与 #53
 * 逐次 allowlist 共用 toolCallRejection，不得另写一套检查器。
 *
 * 覆盖：
 *  - 子代理点名排除表工具（compact_ctx，注册表常驻）得到错误结果，
 *    且无副作用（requestCompact 未被调用）。
 *  - 拒绝文案与 toolCallRejection(..., { deny }) 一致，证明走同一校验点。
 *  - #53 逐次 allowlist 的拒绝文案与 toolCallRejection(..., { allow }) 一致。
 *  - runSubagent 路径同样拦截（不需要调用方再传一份排除表）。
 *  - 主代理调用同一工具仍执行（排除表只作用于子代理）。
 *
 * 运行：bun test tests/subagent-tool-deny-84.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import { contentText, type Message, type StreamResult, type ToolCall } from "../src/llm.ts";
import type { Config } from "../src/config.ts";
import { runSubagent } from "../src/tools/task.ts";
import {
  TOOL_NAMES_EXCLUDED_FOR_SUBAGENT,
  toolCallRejection,
} from "../src/tools/index.ts";

const ROOT = join(tmpdir(), `neo-84-deny-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeCfg(cwd: string): Config {
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
    } as Record<"default" | "deep_reasoning" | "balanced" | "fast", string>,
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
    cwd,
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
    memory: {
      enabled: false,
      userLevelDir: join(cwd, "mem"),
      userWikiDir: join(cwd, "wiki"),
      journalDir: join(cwd, "journal"),
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

function silentIO(): AgentIO {
  return {
    line(): void {},
    blank(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    toolHeader(): void {},
    toolResult(): void {},
    indent: (b: string) => b,
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

function tc(name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: `call_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
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
  } as StreamResult;
}

function toolOutputs(messages: Message[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => contentText(m.content) ?? "");
}

/** toolCallRejection 在本文件的规格断言里必须给出拒绝文案；null 直接失败以便收窄类型。 */
function mustReject(name: string, policy: { allow?: readonly string[]; deny?: readonly string[] }): string {
  const msg = toolCallRejection(name, policy);
  if (msg === null) throw new Error(`预期 toolCallRejection(${name}) 给出拒绝文案`);
  return msg;
}

describe("issue #84 子代理排除表在 dispatch 层校验", () => {
  test("#84 子代理点名排除表工具 compact_ctx：得到错误结果，且 requestCompact 无副作用", async () => {
    const cwd = join(ROOT, `agent-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const agent = new Agent({
      cfg: makeCfg(cwd),
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "sub",
      isSubagent: true,
      chatStream: async (_c, messages): Promise<StreamResult> => {
        if (!messages.some((m) => m.role === "tool")) {
          return result({
            toolCalls: [tc("compact_ctx", { reason: "子代理不该压主上下文" })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "完成" });
      },
    });

    let compactCalls = 0;
    const orig = agent.requestCompact.bind(agent);
    agent.requestCompact = () => {
      compactCalls += 1;
      orig();
    };

    const stats = await agent.send("整理上下文");
    expect(stats.aborted).toBe(false);

    const outputs = toolOutputs(agent.messages);
    expect(outputs.length).toBe(1);
    expect(outputs[0]).toContain("未知工具");
    expect(outputs[0]).not.toContain("已登记压缩请求");
    expect(compactCalls).toBe(0);
    expect(agent.compactRequested).toBe(false);
    expect(
      agent.messages.some(
        (m) => m.role === "system" && (contentText(m.content) ?? "").includes("compact_ctx 执行失败"),
      ),
    ).toBe(false);
  });

  test("#84 拒绝文案与 toolCallRejection(deny) 一致（与 #53 共用同一校验点）", async () => {
    const cwd = join(ROOT, `same-checker-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const expected = mustReject("compact_ctx", { deny: TOOL_NAMES_EXCLUDED_FOR_SUBAGENT });
    expect(expected).toContain("未知工具");

    const agent = new Agent({
      cfg: makeCfg(cwd),
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "sub",
      isSubagent: true,
      chatStream: async (_c, messages): Promise<StreamResult> => {
        if (!messages.some((m) => m.role === "tool")) {
          return result({ toolCalls: [tc("compact_ctx")], finishReason: "tool_calls" });
        }
        return result({ content: "完成" });
      },
    });
    await agent.send("压缩");
    const outputs = toolOutputs(agent.messages);
    expect(outputs).toEqual([expected]);
  });

  test("#53 逐次 allowlist 拒绝文案与 toolCallRejection(allow) 一致（同一校验点）", async () => {
    const cwd = join(ROOT, `allow-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const allow = ["read_file"] as const;
    const expected = mustReject("shell", { allow });

    const agent = new Agent({
      cfg: makeCfg(cwd),
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "sub",
      isSubagent: true,
      toolAllowlist: allow,
      chatStream: async (_c, messages): Promise<StreamResult> => {
        if (!messages.some((m) => m.role === "tool")) {
          return result({
            toolCalls: [tc("shell", { command: "echo should-not-run" })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "完成" });
      },
    });
    await agent.send("跑命令");
    const outputs = toolOutputs(agent.messages);
    expect(outputs).toEqual([expected]);
    // 副作用：被拒的 shell 不得执行；这里用文案锁死同一校验点，命令本身也不会留下文件。
    expect(outputs[0]).toContain("未知工具");
  });

  test("#84 runSubagent：子代理点名 compact_ctx 得到错误，且无压缩副作用", async () => {
    const cwd = join(ROOT, `runsub-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const expected = mustReject("compact_ctx", { deny: TOOL_NAMES_EXCLUDED_FOR_SUBAGENT });
    let toolMsgs: string[] = [];
    let step = 0;
    const stream = async (_c: Config, messages: Message[]): Promise<StreamResult> => {
      step += 1;
      if (step === 1) {
        return result({ toolCalls: [tc("compact_ctx", { reason: "x" })], finishReason: "tool_calls" });
      }
      toolMsgs = toolOutputs(messages);
      return result({ content: "完成" });
    };
    const main = new Agent({
      cfg: makeCfg(cwd),
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: stream,
    });
    const out = await runSubagent(main, "整理", "fast", { cfg: makeCfg(cwd), approve: async () => true });
    expect(out).toContain("完成");
    expect(toolMsgs).toEqual([expected]);
    expect(toolMsgs[0]).toContain("未知工具");
    expect(toolMsgs[0]).not.toContain("已登记压缩请求");
  });

  test("#84 主代理点名 compact_ctx 仍执行（排除表只作用于子代理）", async () => {
    const cwd = join(ROOT, `main-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const agent = new Agent({
      cfg: makeCfg(cwd),
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: async (_c, messages): Promise<StreamResult> => {
        if (!messages.some((m) => m.role === "tool")) {
          return result({
            toolCalls: [tc("compact_ctx", { reason: "主代理可以压" })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "完成" });
      },
    });
    let compactCalls = 0;
    const orig = agent.requestCompact.bind(agent);
    agent.requestCompact = () => {
      compactCalls += 1;
      orig();
    };
    await agent.send("压缩");
    const outputs = toolOutputs(agent.messages);
    expect(outputs.length).toBe(1);
    expect(outputs[0]).toContain("已登记压缩请求");
    expect(outputs[0]).toContain("主代理可以压");
    expect(compactCalls).toBe(1);
  });
});
