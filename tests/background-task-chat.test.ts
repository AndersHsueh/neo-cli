/**
 * background-task-chat.test.ts — 跨会话恢复 + 续聊（issue #48，来源 #16 非目标）。
 *
 * 覆盖 issue #48 的四条验收：
 *  1. 子代理对话（`runSubagent` 的 messages）落盘：**会话目录独立 JSON**，
 *     按任务 id 分文件，单文件有字符上限（session 文件是整篇重写，不能把对话塞进 meta）；
 *  2. `runSubagent` 支持「从已有 messages 继续」：不再每次从零 new Agent；
 *     `/tasks chat <id> <消息>` 追加用户消息并继续该子代理；
 *  3. 恢复后的取消语义（AbortController 重建）；running→interrupted 沿用 #45；
 *  4. 损坏 / 缺失 / 类型不对的文件降级为空，不崩。
 *
 * 全部用临时目录（NEO_SESSIONS_DIR 注入），不碰真实 ~/.neo。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  saveSubagentTranscript,
  loadSubagentTranscript,
  transcriptPath,
  MAX_TRANSCRIPT_MESSAGES,
  MAX_TRANSCRIPT_CHARS,
} from "../src/tools/transcript.ts";
import type { Message, StreamResult } from "../src/llm.ts";
import type { AgentIO } from "../src/agent.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import type { Config } from "../src/config.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-bg-chat-"));
const PREV_SESSIONS = process.env["NEO_SESSIONS_DIR"];

beforeAll(() => {
  process.env["NEO_SESSIONS_DIR"] = SANDBOX;
});

afterAll(() => {
  if (PREV_SESSIONS === undefined) delete process.env["NEO_SESSIONS_DIR"];
  else process.env["NEO_SESSIONS_DIR"] = PREV_SESSIONS;
  rmSync(SANDBOX, { recursive: true, force: true });
});

function msg(role: Message["role"], content: string): Message {
  return { role, content } as Message;
}

/* ------------------------------------------------------------------ */
/* C. 子代理对话落盘                                                     */
/* ------------------------------------------------------------------ */

describe("C 子代理对话落盘（issue #48）", () => {
  test("C1 写入 / 读回：按 (sessionId, jobId) 分文件，内容原样", () => {
    const messages: Message[] = [
      msg("system", "你是子代理"),
      msg("user", "探索依赖"),
      msg("assistant", "结论：只有 a、b"),
    ];
    saveSubagentTranscript("sess-1", "bg-1", messages);

    const path = transcriptPath("sess-1", "bg-1");
    expect(existsSync(path)).toBe(true);
    // 独立文件，不在 session meta 里
    expect(path).toContain("transcripts");
    expect(path).toContain("bg-1");

    const loaded = loadSubagentTranscript("sess-1", "bg-1");
    expect(loaded).toHaveLength(3);
    expect(loaded![1]!.content).toBe("探索依赖");
    expect(loaded![2]!.content).toBe("结论：只有 a、b");
  });

  test("C2 条数超上限只保留最近的 N 条（系统提示恒保留）", () => {
    const messages: Message[] = [msg("system", "系统提示")];
    for (let i = 0; i < MAX_TRANSCRIPT_MESSAGES + 10; i++) {
      messages.push(msg("user", `消息${i}`));
    }
    saveSubagentTranscript("sess-2", "bg-2", messages);
    const loaded = loadSubagentTranscript("sess-2", "bg-2")!;
    expect(loaded.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_MESSAGES);
    // 系统提示必须在（续聊要复用同一身份）
    expect(loaded[0]!.role).toBe("system");
    // 保留的是最近的消息
    expect(loaded[loaded.length - 1]!.content).toBe(`消息${MAX_TRANSCRIPT_MESSAGES + 9}`);
  });

  test("C3 单条超长内容截断（不把单个文件撑爆）", () => {
    const huge = "x".repeat(MAX_TRANSCRIPT_CHARS + 10_000);
    saveSubagentTranscript("sess-3", "bg-3", [msg("system", "sys"), msg("user", huge)]);
    const loaded = loadSubagentTranscript("sess-3", "bg-3")!;
    const body = String(loaded[1]!.content);
    expect(body.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS + 40);
    expect(body).toContain("已截断");
  });

  test("C4 缺失 / 损坏 / 类型不对 → null，不抛", () => {
    expect(loadSubagentTranscript("sess-none", "bg-none")).toBeNull();

    const path = transcriptPath("sess-4", "bg-4");
    mkdirSync(join(SANDBOX, "transcripts", "sess-4"), { recursive: true });
    writeFileSync(path, "{ 这不是 JSON", "utf8");
    expect(loadSubagentTranscript("sess-4", "bg-4")).toBeNull();

    writeFileSync(path, JSON.stringify({ messages: "不是数组" }), "utf8");
    expect(loadSubagentTranscript("sess-4", "bg-4")).toBeNull();

    // 数组里混入脏条目：丢掉坏的，保留好的
    writeFileSync(
      path,
      JSON.stringify({ messages: [null, { role: "user", content: "好的" }, { role: 42 }] }),
      "utf8",
    );
    const loaded = loadSubagentTranscript("sess-4", "bg-4")!;
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.content).toBe("好的");
  });

  test("C5 落盘文件里不含活引用（只有纯 JSON）", () => {
    saveSubagentTranscript("sess-5", "bg-5", [msg("system", "sys"), msg("user", "hi")]);
    const raw = readFileSync(transcriptPath("sess-5", "bg-5"), "utf8");
    expect(raw).not.toContain("function");
    expect(raw).not.toContain("AbortSignal");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* X. 续聊（runSubagent 带历史 + /tasks chat）                           */
/* ------------------------------------------------------------------ */

describe("X 续聊（issue #48）", () => {
  test("X1 runSubagent 带 resume.messages：历史被复用，不是从零起跑", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { runSubagent } = await import("../src/tools/task.ts");
    
    const seen: Message[][] = [];
    const main = new Agent({
      cfg: makeCfg(),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "主代理",
      chatStream: async (_c, messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        return resultOf({ content: "续聊回答" });
      },
    });

    const history: Message[] = [
      msg("system", "你是子代理（原提示词）"),
      msg("user", "第一轮问题"),
      msg("assistant", "第一轮回答"),
    ];
    const ctx = fakeCtx();
    const reply = await runSubagent(main, "第二轮问题", undefined, ctx, undefined, { messages: history });

    expect(reply).toContain("续聊回答");
    // 发给模型的 messages 里必须有历史（系统提示 + 第一轮问答 + 新问题）
    const sent = seen[0]!;
    expect(sent[0]!.role).toBe("system");
    expect(String(sent[0]!.content)).toContain("原提示词");
    expect(sent.some((m) => String(m.content).includes("第一轮问题"))).toBe(true);
    expect(sent.some((m) => String(m.content).includes("第一轮回答"))).toBe(true);
    expect(sent.some((m) => String(m.content).includes("第二轮问题"))).toBe(true);
  });

  test("X2 onMessages 回调拿到最终 messages（供落盘）", async () => {
    const { Agent } = await import("../src/agent.ts");
    const { runSubagent } = await import("../src/tools/task.ts");
    
    const main = new Agent({
      cfg: makeCfg(),
      console: silentConsole(),
      mode: "auto-edit",
      systemPrompt: "主代理",
      chatStream: async () => resultOf({ content: "答" }),
    });
    let captured: Message[] | null = null;
    await runSubagent(main, "问题", undefined, fakeCtx(), undefined, {
      onMessages: (msgs) => {
        captured = msgs;
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.length).toBeGreaterThanOrEqual(2);
    expect(captured!.some((m) => m.role === "assistant")).toBe(true);
  });

  test("X3 /tasks chat <id> <消息>：读回对话并继续；无记录时给可读错误", async () => {
    const { dispatchCommand, wireCommands } = await import("../src/cli/commands.ts");
    const { captureConsole } = await import("./helpers.ts");
    wireCommands();

    // 有记录 → 调用 chat 并显示回复
    const cap = captureConsole();
    const calls: Array<{ id: string; text: string }> = [];
    const ctx = {
      cfg: { cwd: "/tmp" } as unknown as Config,
      ui: cap.ui,
      tasks: {
        list: () => [],
        cancel: () => 0,
        chat: async (id: string, text: string) => {
          calls.push({ id, text });
          return { ok: true as const, reply: "续聊回复正文" };
        },
      },
    } as unknown as Parameters<typeof dispatchCommand>[1];
    await dispatchCommand("/tasks chat bg-1 继续查一下", ctx);
    expect(calls).toEqual([{ id: "bg-1", text: "继续查一下" }]);
    expect(cap.out()).toContain("续聊回复正文");

    // 缺参数 → 用法提示，不调用
    const cap2 = captureConsole();
    await dispatchCommand("/tasks chat", { ...ctx, ui: cap2.ui } as unknown as Parameters<typeof dispatchCommand>[1]);
    expect(cap2.out()).toContain("用法");

    // 未接线 → 明说
    const cap3 = captureConsole();
    await dispatchCommand("/tasks chat bg-1 hi", {
      cfg: { cwd: "/tmp" } as unknown as Config,
      ui: cap3.ui,
      tasks: { list: () => [], cancel: () => 0 },
    } as unknown as Parameters<typeof dispatchCommand>[1]);
    expect(cap3.out()).toContain("不支持续聊");
  });
});

/* ------------------------------------------------------------------ */
/* 本地 helper（避免跨文件依赖）                                          */
/* ------------------------------------------------------------------ */

function fakeCtx(): ToolCtx {
  return {
    cfg: { cwd: "/tmp", toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => true,
    signal: new AbortController().signal,
  } as unknown as ToolCtx;
}

function makeCfg(): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m",
    providers: [
      {
        name: "p1",
        type: "openai",
        vision: false,
        reasoning: false,
        models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
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
      return body.split("\n").map((l) => prefix + l).join("\n");
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

function resultOf(over: Partial<StreamResult> = {}): StreamResult {
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
