/**
 * lifecycle-hooks-86.test.ts — SubagentStart / SubagentStop（issue #86）。
 *
 * 先于实现提交：本文件在实现跟上之前必须红（断言失败或缺模块）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import {
  HOOK_EVENTS,
  hookMatches,
  parseHooksConfig,
  type HookDef,
  type HooksConfig,
} from "../src/hooks/index.ts";
import { helpText } from "../src/cli/help.ts";
import { runSubagent, subagentStopReason } from "../src/tools/task.ts";
import { ToolError, type ToolCtx } from "../src/tools/types.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult } from "../src/llm.ts";

const SANDBOX = join(import.meta.dir, `.tmp-hooks86-${Date.now()}`);
mkdirSync(SANDBOX, { recursive: true });
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

let serial = 0;

function makeCfg(over: Partial<Config> = {}): Config {
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
    },
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
  const route = { provider: "p1", model: null, fallbackAllowed: true };
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [provider],
    routes: {
      default: route,
      deep_reasoning: route,
      balanced: route,
      fast: route,
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
    cwd: SANDBOX,
    settingsPath: null,
    skillsStore: join(SANDBOX, "skills"),
    hooks: parseHooksConfig(undefined),
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
    ...over,
  } as unknown as Config;
}

function spyIO(): AgentIO {
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

function fakeStream(
  steps: Array<Partial<StreamResult> | (() => Partial<StreamResult> | Promise<Partial<StreamResult>>)>,
): () => Promise<StreamResult> {
  let i = 0;
  return async (): Promise<StreamResult> => {
    const step = steps[i];
    if (!step) throw new Error(`fake chatStream: 脚本耗尽（第 ${i + 1} 次调用）`);
    i++;
    const resolved = typeof step === "function" ? await step() : step;
    return {
      content: "",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
      ...resolved,
    } as StreamResult;
  };
}

function script(name: string, body: string): string {
  const p = join(SANDBOX, name);
  writeFileSync(p, body, { encoding: "utf8", mode: 0o755 });
  return p;
}

function recorder(label: string): { command: string; read: () => Record<string, unknown>[] } {
  const id = `${label}-${++serial}`;
  const log = join(SANDBOX, `${id}.jsonl`);
  const cmd = script(
    `${id}.sh`,
    `#!/bin/sh\ncat >> '${log}'\necho >> '${log}'\n`,
  );
  return {
    command: cmd,
    read: () => {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

function hooksCfg(raw: unknown): HooksConfig {
  const parsed = parseHooksConfig(raw);
  return { ...parsed, enabled: true };
}

function hookDef(over: Partial<HookDef> = {}): HookDef {
  return {
    event: "SubagentStart",
    command: "true",
    timeout: 30,
    onFailure: "continue",
    origin: "test",
    ...over,
  };
}

function makeParent(
  hooks: HooksConfig,
  stream: () => Promise<StreamResult>,
  over: { sessionId?: string } = {},
): Agent {
  return new Agent({
    cfg: makeCfg(),
    console: spyIO(),
    mode: "auto-all",
    systemPrompt: "sys",
    sessionId: over.sessionId ?? "parent-sess",
    hooks,
    chatStream: stream,
  });
}

function ctxOf(main: Agent, signal?: AbortSignal): ToolCtx {
  return { cfg: main.config, approve: async () => true, host: main, signal };
}

/* ------------------------------------------------------------------ */
/* 事件名与配置解析                                                     */
/* ------------------------------------------------------------------ */

describe("#86 事件名与解析", () => {
  test("SubagentStart / SubagentStop 进入 HOOK_EVENTS，未知事件名仍被拒绝", () => {
    expect(HOOK_EVENTS).toContain("SubagentStart");
    expect(HOOK_EVENTS).toContain("SubagentStop");
    const typo = parseHooksConfig({
      enabled: true,
      SubagentLaunch: [{ command: "true" }],
    });
    expect((typo.hooks as Record<string, unknown>)["SubagentLaunch"]).toBeUndefined();
    expect(typo.warnings.some((w) => w.includes("事件名只认") && w.includes("SubagentStart") && w.includes("SubagentStop"))).toBe(
      true,
    );
  });

  test("settings.example.json 里的新事件能被解析", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "../settings.example.json"), "utf8")) as {
      hooks: unknown;
    };
    const cfg = parseHooksConfig(raw.hooks);
    expect(cfg.hooks.SubagentStart.length).toBeGreaterThan(0);
    expect(cfg.hooks.SubagentStop.length).toBeGreaterThan(0);
    expect(cfg.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 前台派出载荷                                                         */
/* ------------------------------------------------------------------ */

describe("#86 前台 runSubagent 载荷", () => {
  test("Start 然后 Stop，同一 task_id 为该实例第一个 sg-N，字段约定锁死", async () => {
    const rec = recorder("pair");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const stream = fakeStream([{ content: "子代理报告：完成。" }]);
    const main = makeParent(hooks, stream);
    const out = await runSubagent(main, "整理这段代码", undefined, ctxOf(main));
    expect(out).toContain("完成");
    const events = rec.read();
    expect(events.map((e) => e["event"])).toEqual(["SubagentStart", "SubagentStop"]);
    const start = events[0]!;
    const stop = events[1]!;
    expect(start["task_id"]).toBe("sg-1");
    expect(stop["task_id"]).toBe("sg-1");
    expect(start["agent_type"]).toBe("task");
    expect(stop["agent_type"]).toBe("task");
    // 本切锁死：agent_name 以空字符串出现，不省略。
    expect(start["agent_name"]).toBe("");
    expect(stop["agent_name"]).toBe("");
    expect(start["description"]).toBe("整理这段代码");
    expect(start["subagent"]).toBe(false);
    expect(stop["subagent"]).toBe(false);
    expect(start["session_id"]).toBe("parent-sess");
    expect(stop["session_id"]).toBe("parent-sess");
    expect(start["cwd"]).toBe(SANDBOX);
    expect(start["turn"]).toBe(main.turnCounter);
    expect(stop["reason"]).toBe("completed");
  });

  test("第二次前台派出是 sg-2，不复用、不与 bg- 混用", async () => {
    const rec = recorder("second");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const stream = fakeStream([{ content: "一" }, { content: "二" }]);
    const main = makeParent(hooks, stream);
    await runSubagent(main, "第一次任务", undefined, ctxOf(main));
    await runSubagent(main, "第二次任务", undefined, ctxOf(main));
    const starts = rec.read().filter((e) => e["event"] === "SubagentStart");
    expect(starts.map((e) => e["task_id"])).toEqual(["sg-1", "sg-2"]);
    expect(starts.every((e) => String(e["task_id"]).startsWith("sg-"))).toBe(true);
    expect(starts.every((e) => !String(e["task_id"]).startsWith("bg-"))).toBe(true);
  });

  test("调用方传入 jobId: bg-3 时 Start/Stop 都用 bg-3，不生成 sg-N", async () => {
    const rec = recorder("bg");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const stream = fakeStream([{ content: "后台完成" }, { content: "前台完成" }]);
    const main = makeParent(hooks, stream);
    await runSubagent(main, "后台任务", undefined, ctxOf(main), undefined, undefined, { jobId: "bg-3" });
    await runSubagent(main, "随后的前台", undefined, ctxOf(main));
    const events = rec.read();
    const bg = events.filter((e) => e["description"] === "后台任务");
    const fg = events.filter((e) => e["description"] === "随后的前台");
    expect(bg.map((e) => e["task_id"])).toEqual(["bg-3", "bg-3"]);
    expect(fg.map((e) => e["task_id"])).toEqual(["sg-1", "sg-1"]);
  });

  test("description 长于 500 字符时硬截断到 500", async () => {
    const rec = recorder("trunc");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const stream = fakeStream([{ content: "ok" }]);
    const main = makeParent(hooks, stream);
    const prompt = "任务" + "字".repeat(600);
    await runSubagent(main, prompt, undefined, ctxOf(main));
    const start = rec.read().find((e) => e["event"] === "SubagentStart")!;
    expect(typeof start["description"]).toBe("string");
    expect((start["description"] as string).length).toBe(500);
    expect(start["description"]).toBe(prompt.slice(0, 500));
  });
});

/* ------------------------------------------------------------------ */
/* 校验失败、开关、续跑、计数                                           */
/* ------------------------------------------------------------------ */

describe("#86 校验 / 开关 / 续跑", () => {
  test("空 prompt、无效档位：两次 hook 都不打，且不递增 sg-N", async () => {
    const rec = recorder("validate");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const stream = fakeStream([{ content: "成功派出" }]);
    const main = makeParent(hooks, stream);
    await expect(runSubagent(main, "   ", undefined, ctxOf(main))).rejects.toThrow(ToolError);
    await expect(runSubagent(main, "有效任务", "not-a-tier", ctxOf(main))).rejects.toThrow(ToolError);
    await expect(runSubagent(main, "有效任务", undefined, ctxOf(main), "bogus-prompt-tier")).rejects.toThrow(
      ToolError,
    );
    expect(rec.read()).toEqual([]);
    await runSubagent(main, "真正派出", undefined, ctxOf(main));
    const starts = rec.read().filter((e) => e["event"] === "SubagentStart");
    expect(starts.map((e) => e["task_id"])).toEqual(["sg-1"]);
  });

  test("emitSubagentHooks: false 不打 hook、不递增 sg-N", async () => {
    const rec = recorder("off");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const stream = fakeStream([{ content: "wiki" }, { content: "前台" }]);
    const main = makeParent(hooks, stream);
    await runSubagent(main, "维护 wiki", undefined, ctxOf(main), undefined, undefined, {
      emitSubagentHooks: false,
    });
    expect(rec.read()).toEqual([]);
    await runSubagent(main, "普通派出", undefined, ctxOf(main));
    const starts = rec.read().filter((e) => e["event"] === "SubagentStart");
    expect(starts.map((e) => e["task_id"])).toEqual(["sg-1"]);
  });

  test("续跑有 resume.messages：不打 Start，打 Stop，task_id 为传入的 bg-N，且不递增 sg-N", async () => {
    const rec = recorder("resume");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const stream = fakeStream([{ content: "续跑答复" }, { content: "之后的前台" }]);
    const main = makeParent(hooks, stream);
    const messages: Message[] = [
      { role: "system", content: "你是已在跑的子代理" },
      { role: "user", content: "上一轮任务" },
      { role: "assistant", content: "上一轮报告" },
    ];
    await runSubagent(main, "请继续", undefined, ctxOf(main), undefined, { messages }, { jobId: "bg-7" });
    const afterResume = rec.read();
    expect(afterResume.map((e) => e["event"])).toEqual(["SubagentStop"]);
    expect(afterResume[0]!["task_id"]).toBe("bg-7");
    expect(afterResume[0]!["reason"]).toBe("completed");
    await runSubagent(main, "新的前台", undefined, ctxOf(main));
    const starts = rec.read().filter((e) => e["event"] === "SubagentStart");
    expect(starts.map((e) => e["task_id"])).toEqual(["sg-1"]);
  });
});

/* ------------------------------------------------------------------ */
/* Stop reason                                                         */
/* ------------------------------------------------------------------ */

describe("#86 SubagentStop.reason", () => {
  test("正常完成是 completed", async () => {
    const rec = recorder("ok");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const main = makeParent(hooks, fakeStream([{ content: "好了" }]));
    await runSubagent(main, "做完", undefined, ctxOf(main));
    expect(rec.read().find((e) => e["event"] === "SubagentStop")!["reason"]).toBe("completed");
  });

  test("hadError 且未 abort 为 error", async () => {
    const rec = recorder("err");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const main = makeParent(
      hooks,
      fakeStream([
        { content: "", reasoning: "想了", toolCalls: [] },
        { content: "", reasoning: "又想了", toolCalls: [] },
      ]),
    );
    await runSubagent(main, "会失败的任务", undefined, ctxOf(main));
    expect(rec.read().find((e) => e["event"] === "SubagentStop")!["reason"]).toBe("error");
  });

  test("aborted 为 cancelled", async () => {
    const rec = recorder("abort");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    });
    const ctrl = new AbortController();
    const stream = fakeStream([
      async () => {
        ctrl.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    ]);
    const main = makeParent(hooks, stream);
    await runSubagent(main, "会被取消", undefined, ctxOf(main, ctrl.signal));
    const events = rec.read();
    expect(events.map((e) => e["event"])).toEqual(["SubagentStart", "SubagentStop"]);
    expect(events[1]!["reason"]).toBe("cancelled");
    expect(events[0]!["task_id"]).toBe(events[1]!["task_id"]);
  });

  test("aborted 即使同时 hadError 也是 cancelled（决策函数锁死）", () => {
    expect(subagentStopReason({ aborted: false, hadError: false })).toBe("completed");
    expect(subagentStopReason({ aborted: false, hadError: true })).toBe("error");
    expect(subagentStopReason({ aborted: true, hadError: false })).toBe("cancelled");
    expect(subagentStopReason({ aborted: true, hadError: true })).toBe("cancelled");
  });
});

/* ------------------------------------------------------------------ */
/* matcher                                                             */
/* ------------------------------------------------------------------ */

describe("#86 matcher 只认 agent_type", () => {
  test("agent_type 为 task 时命中；不匹配的 matcher 不跑；不读 agent_name", async () => {
    const hit = recorder("hit");
    const miss = recorder("miss");
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [
        { command: hit.command, matcher: "task" },
        { command: miss.command, matcher: "other" },
      ],
      SubagentStop: [{ command: hit.command, matcher: "task" }],
    });
    const main = makeParent(hooks, fakeStream([{ content: "ok" }]));
    await runSubagent(main, "匹配测试", undefined, ctxOf(main));
    expect(hit.read().map((e) => e["event"])).toEqual(["SubagentStart", "SubagentStop"]);
    expect(miss.read()).toEqual([]);

    // hookMatches 只把第 5 个参数（agent_type）当匹配对象，不读 name。
    const byName = hookDef({ matcher: "alice" });
    expect(hookMatches(byName, "alice", null, null, "task")).toBe(false);
    expect(hookMatches(hookDef({ matcher: "task" }), "alice", null, null, "task")).toBe(true);
    expect(hookMatches(hookDef({ matcher: "other" }), null, null, null, "task")).toBe(false);
    expect(hookMatches(hookDef({ matcher: "task" }), null, null, null, "task")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Start 不阻断、不注入；Stop 不续跑                                     */
/* ------------------------------------------------------------------ */

describe("#86 Start 不可阻断 / Stop 不续跑", () => {
  test("Start 退出码非 0 或超时：不阻断派出，子代理仍运行；不注入 additionalContext", async () => {
    const rec = recorder("diag");
    const startFail = script(
      `start-fail-${++serial}.sh`,
      `#!/bin/sh\ncat >> /dev/null\necho '{"additionalContext":"SECRET_INJECT_SHOULD_NOT_APPEAR"}'\nexit 2\n`,
    );
    const startTimeout = script(`start-timeout-${++serial}.sh`, `#!/bin/sh\nsleep 2\n`);
    const hooks = hooksCfg({
      enabled: true,
      SubagentStart: [
        { command: startFail },
        { command: startTimeout, timeout: 1 },
        { command: rec.command },
      ],
      SubagentStop: [{ command: rec.command }],
    });
    const stream = fakeStream([
      () => {
        // 抓不到子代理 messages 引用时，用报告正文自证：密钥不得出现在本轮请求里。
        return { content: "子代理仍然跑完了" };
      },
      () => ({ content: "第二次也跑完了" }),
    ]);
    const main = makeParent(hooks, stream);
    const out1 = await runSubagent(main, "失败也不阻断", undefined, ctxOf(main));
    expect(out1).toContain("仍然跑完了");
    expect(out1).not.toContain("SECRET_INJECT_SHOULD_NOT_APPEAR");
    expect(JSON.stringify(main.messages)).not.toContain("SECRET_INJECT_SHOULD_NOT_APPEAR");

    // 再跑一次确认超时同样不阻断（上一条已含 timeout hook）。
    const failEvents = rec.read();
    expect(failEvents.some((e) => e["event"] === "SubagentStart")).toBe(true);
    expect(failEvents.some((e) => e["event"] === "SubagentStop")).toBe(true);

    const inspect: Message[][] = [];
    const inspectStream = async (_cfg: Config, msgs: Message[]): Promise<StreamResult> => {
      inspect.push(msgs.map((m) => ({ ...m })));
      return {
        content: "检查上下文",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
        raw: null,
      };
    };
    const main2 = makeParent(hooks, inspectStream);
    const out2 = await runSubagent(main2, "超时也不阻断", undefined, ctxOf(main2));
    expect(out2).toContain("检查上下文");
    const blob = JSON.stringify(inspect);
    expect(blob).not.toContain("SECRET_INJECT_SHOULD_NOT_APPEAR");
  }, 20_000);

  test("Stop 的 decision:block 或退出码 2 不让子代理续跑", async () => {
    const block = script(
      `stop-block-${++serial}.sh`,
      `#!/bin/sh\ncat >/dev/null\necho '{"decision":"block","reason":"请再跑一轮"}\n'\n`,
    );
    const exit2 = script(`stop-exit2-${++serial}.sh`, `#!/bin/sh\ncat >/dev/null\necho nope\nexit 2\n`);
    let calls = 0;
    const counting = async (): Promise<StreamResult> => {
      calls++;
      return {
        content: `第${calls}次`,
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
        raw: null,
      };
    };
    const hooks = hooksCfg({
      enabled: true,
      SubagentStop: [{ command: block }, { command: exit2, onFailure: "block" }],
    });
    const main = makeParent(hooks, counting);
    const out = await runSubagent(main, "不要续跑", undefined, ctxOf(main));
    expect(out).toContain("第1次");
    expect(calls).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* #64 回归：子代理回合不触发父会话事件                                   */
/* ------------------------------------------------------------------ */

describe("#86 保留 #64 子代理跳过约定", () => {
  test("子代理回合不触发父会话的 SessionStart / UserPromptSubmit / Stop / PreCompact / TurnEnd", async () => {
    const rec = recorder("skip64");
    const hooks = hooksCfg({
      enabled: true,
      SessionStart: [{ command: rec.command }],
      UserPromptSubmit: [{ command: rec.command }],
      Stop: [{ command: rec.command }],
      PreCompact: [{ command: rec.command }],
      TurnEnd: [{ command: rec.command }],
      Notification: [{ command: rec.command, matcher: "turn_end" }],
    });
    const main = makeParent(hooks, fakeStream([{ content: "子代理答完。" }]));
    await runSubagent(main, "不要触发父会话事件", undefined, ctxOf(main));
    expect(rec.read()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 文档与调用点                                                         */
/* ------------------------------------------------------------------ */

describe("#86 文档与调用点", () => {
  test("/help 与 /hooks 说明提到新事件，并写明续跑 Stop 可能没有成对 Start", async () => {
    const help = helpText();
    expect(help).toContain("SubagentStart");
    expect(help).toContain("SubagentStop");
    const { handleSystemCommands } = await import("../src/cli/commandSystem.ts");
    const { captureConsole } = await import("./helpers.ts");
    const cap = captureConsole();
    const hooks = parseHooksConfig({
      enabled: true,
      SubagentStart: [{ command: "start", matcher: "task" }],
      SubagentStop: [{ command: "stop", matcher: "task" }],
    });
    await handleSystemCommands("hooks", "", [], { cfg: { hooks }, ui: cap.ui } as never);
    const text = cap.out();
    expect(text).toContain("SubagentStart");
    expect(text).toContain("SubagentStop");
    expect(text).toMatch(/Stop 可能没有成对的 Start|没有成对的 Start/);
  });

  test("runWikiWorker 显式关闭 hook；后台 /tasks 与续跑传入既有任务 id", () => {
    const sessionStart = readFileSync(join(import.meta.dir, "../src/cli/sessionStart.ts"), "utf8");
    const wikiBlock = sessionStart.match(/async function runWikiWorker[\s\S]*?\n}\n\n/ )?.[0] ?? "";
    expect(wikiBlock).toContain("emitSubagentHooks: false");
    const bgBlock = sessionStart.match(/s\.backgroundTasks = new BackgroundTasks\([\s\S]*?\n  \}\);/)?.[0] ?? "";
    expect(bgBlock).toMatch(/jobId:\s*job\.id/);
    expect(sessionStart).not.toContain("runSubagent 不知道自己的 jobId");

    const repl = readFileSync(join(import.meta.dir, "../src/cli/repl.ts"), "utf8");
    expect(repl).toMatch(/runSubagent\([\s\S]*?jobId:\s*id/);

    const ingest = readFileSync(join(import.meta.dir, "../src/cli/commandWorkspace.ts"), "utf8");
    expect(ingest).toContain("runSubagent(");
    expect(ingest).not.toMatch(/runSubagent\([\s\S]*emitSubagentHooks:\s*false/);
  });
});
