/**
 * issue #17：路径作用域规则的**轮内注入**（Agent 集成）。
 *
 * 断言：
 *  - 本会话触达 `src/api/a.ts` 后，下一请求的 messages 里出现「路径作用域规则」临时 system 消息；
 *  - 该消息在轮末从历史摘除（不落盘、不污染后续轮次）；
 *  - `agent.activeRules` 给出命中原因，供 /context 展示。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";
import { DEFAULT_MAILBOX_CONFIG } from "../src/mailbox/types.ts";
import {
  extractTouchedPaths,
  formatScopedRulesBlock,
  selectScopedRules,
  type ProjectRule,
} from "../src/rules/index.ts";

let SANDBOX = "";

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-rules-agent-"));
  mkdirSync(join(SANDBOX, "src", "api"), { recursive: true });
  writeFileSync(join(SANDBOX, "src", "api", "a.ts"), "export const a = 1;\n", "utf8");
  mkdirSync(join(SANDBOX, ".neo", "rules"), { recursive: true });
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
        quiet: true,
      },
      quiet: true,
    },
  } as unknown as Config;
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

const API_RULE: ProjectRule = {
  file: join(SANDBOX, ".neo", "rules", "api.md"),
  relPath: ".neo/rules/api.md",
  name: "接口约定",
  paths: ["src/api/**"],
  body: "改接口时必须同步更新 openapi.yaml。",
};

function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

describe("issue #17 轮内注入", () => {
  test("触达匹配路径 → 下一请求带 scoped 规则临时消息，轮末摘除", async () => {
    const seen: Message[][] = [];
    let call = 0;
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "sys",
      chatStream: async (_cfg, messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        call += 1;
        if (call === 1) {
          return result({
            toolCalls: [toolCall("c1", "read_file", { path: "src/api/a.ts" })],
            finishReason: "tool_calls",
          });
        }
        return result({ content: "done" });
      },
      // 与组合根同样的注入方式
      toolPathsOf: (name, args) => extractTouchedPaths(name, args, SANDBOX),
      scopedRulesPrompt: (touched) => {
        const matches = selectScopedRules([API_RULE], touched, { cwd: SANDBOX });
        const text = formatScopedRulesBlock(matches);
        return text === "" ? null : { text, matches };
      },
    });

    await agent.send("看看 src/api 的实现");

    // 第二轮请求里应当带上规则正文与命中原因
    const second = seen[1]!;
    const injected = second.filter((m) => m.role === "system" && textOf(m).includes("路径作用域规则"));
    expect(injected.length).toBe(1);
    expect(textOf(injected[0]!)).toContain("改接口时必须同步更新 openapi.yaml。");
    expect(textOf(injected[0]!)).toContain("src/api/** ← src/api/a.ts");

    // 轮末摘除：历史里不再有那段文字
    expect(agent.messages.some((m) => textOf(m).includes("路径作用域规则"))).toBe(false);

    // /context 用的命中记录
    expect(agent.activeRules.length).toBe(1);
    expect(agent.activeRules[0]!.rule.name).toBe("接口约定");
  });

  test("没触达匹配路径 → 不注入，也不留残片", async () => {
    const seen: Message[][] = [];
    const agent = new Agent({
      cfg: makeCfg(),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "sys",
      chatStream: async (_cfg, messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        return result({ content: "ok" });
      },
      toolPathsOf: (name, args) => extractTouchedPaths(name, args, SANDBOX),
      scopedRulesPrompt: (touched) => {
        const matches = selectScopedRules([API_RULE], touched, { cwd: SANDBOX });
        const text = formatScopedRulesBlock(matches);
        return text === "" ? null : { text, matches };
      },
    });
    await agent.send("闲聊");
    expect(seen[0]!.some((m) => textOf(m).includes("路径作用域规则"))).toBe(false);
    expect(agent.activeRules).toEqual([]);
  });
});
