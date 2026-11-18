/**
 * #64 生命周期 hooks（Agent 层边界）。
 *
 * 覆盖编排者基础 10 例之外的边界，全部走真实 Agent 入口（`agent.send` / `agent.compact`），
 * 不 mock 模块、不触网、不写真实 home：
 *  - SessionStart 只由宿主显式触发（new/resume/clear），load 历史回放不算；
 *  - UserPromptSubmit 在分类器等预模型调用之前阻断（零模型请求）；
 *  - Stop 只在模型正常终止时触发，工具轮不触发；每条用户输入最多续跑一次；
 *  - 续跑共享原预算/取消/总迭代上限，abort 不续跑；
 *  - PreCompact 覆盖手动/自动，拒绝时历史与快照不变、同轮不重复触发；
 *  - 子代理不触发这四类会话/用户事件（防递归）。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentIO } from "../src/agent.ts";
import { parseHooksConfig } from "../src/hooks/index.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";
import { LLMError } from "../src/llm.ts";

const SANDBOX = mkdtempSync(join(import.meta.dir, ".tmp-hooks64-agent-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

function makeCfg(over: Partial<Config> = {}): Config {
  const provider = {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: { default: "m-default", deep_reasoning: "m-deep", balanced: "m-bal", fast: "m-fast" },
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

interface SpyIO extends AgentIO {
  warns: string[];
  infos: string[];
}

function spyIO(): SpyIO {
  const warns: string[] = [];
  const infos: string[] = [];
  const base: AgentIO = {
    line(): void {},
    blank(): void {},
    info(m: string): void {
      infos.push(m);
    },
    warn(m: string): void {
      warns.push(m);
    },
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
  return Object.assign(base, { warns, infos }) as SpyIO;
}

let serial = 0;

/** 写一条可执行 hook 脚本；`body` 是 sh 片段。 */
function script(body: string): string {
  const path = join(SANDBOX, `h${serial++}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

/** 输出固定文本并以指定退出码结束的 hook。 */
function hook(output: string, code = 0): { command: string } {
  return { command: script(`cat >/dev/null\nprintf '%s' '${output.replaceAll("'", "'\\''")}'\nexit ${code}`) };
}

/** 每次被调用就往 mark 文件追加一行的 hook（用于计数）。 */
function countingHook(mark: string, tag: string, output = "", code = 0): { command: string } {
  return {
    command: script(
      `cat >/dev/null\necho ${tag} >> '${mark}'\nprintf '%s' '${output.replaceAll("'", "'\\''")}'\nexit ${code}`,
    ),
  };
}

function marks(mark: string): string[] {
  try {
    return readFileSync(mark, "utf8").trim().split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function result(over: Partial<StreamResult> = {}): StreamResult {
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

interface Setup {
  agent: Agent;
  io: SpyIO;
  /** 每次模型请求的 messages 快照。 */
  seen: Message[][];
  /** 每次模型请求用的 cfg 快照（预算/迭代上限断言用）。 */
  cfgs: Config[];
}

function setup(
  raw: Record<string, unknown>,
  steps: Array<Partial<StreamResult>>,
  overrides: Partial<Config> = {},
  agentOver: Record<string, unknown> = {},
): Setup {
  const io = spyIO();
  const seen: Message[][] = [];
  const cfgs: Config[] = [];
  let i = 0;
  const hooks = parseHooksConfig({ enabled: true, ...raw });
  const agent = new Agent({
    cfg: makeCfg(overrides),
    console: io,
    mode: "auto-all",
    hooks,
    systemPrompt: "sys",
    chatStream: async (...args: unknown[]) => {
      seen.push(JSON.parse(JSON.stringify(args[1])) as Message[]);
      cfgs.push(JSON.parse(JSON.stringify(args[0])) as Config);
      const step = steps[i];
      i++;
      if (!step) throw new Error(`fake chatStream: 脚本耗尽（第 ${i} 次调用）`);
      return result(step);
    },
    ...agentOver,
  });
  return { agent, io, seen, cfgs };
}

function history(agent: Agent): void {
  for (let i = 0; i < 16; i++) {
    agent.messages.push({ role: i % 2 ? "assistant" : "user", content: `old ${i} ` + "history ".repeat(30) });
  }
}

/* ------------------------------------------------------------------ */
/* SessionStart                                                        */
/* ------------------------------------------------------------------ */

test("#64 SessionStart is host-driven and fires for new/resume/clear only", async () => {
  const mark = join(SANDBOX, `ss-${serial++}`);
  const { agent, seen } = setup({ SessionStart: [countingHook(mark, "start", "startup context")] }, [
    { content: "reply" },
    { content: "reply after start" },
  ]);
  // 构造 Agent 不等于会话开始：宿主必须显式触发。
  expect(marks(mark)).toEqual([]);
  await agent.send("hello");
  expect(marks(mark)).toEqual([]);
  // 先发生的请求不可能看见后注入的上下文：这一条必须干净。
  expect(JSON.stringify(seen[0])).not.toContain("startup context");

  await agent.runSessionStart("new");
  expect(marks(mark)).toEqual(["start"]);
  await agent.runSessionStart("resume");
  await agent.runSessionStart("clear");
  expect(marks(mark)).toEqual(["start", "start", "start"]);
  // 附加上下文进主模型（SessionStart 的 stdout 是给模型的上下文）：
  // 由 runSessionStart 之后的下一次真实请求看见，且会话级可见（不随轮末摘除）。
  await agent.send("after start");
  expect(JSON.stringify(seen[1])).toContain("startup context");
});

test("#64 SessionStart failure is diagnostic only and never blocks the turn", async () => {
  const { agent, io, seen } = setup({ SessionStart: [hook("startup exploded", 2)] }, [{ content: "reply" }]);
  const r = await agent.runSessionStart("new");
  expect(r.blocked).toBe(false);
  expect([...io.warns, ...io.infos].join("\n")).toContain("startup exploded");
  await agent.send("hello");
  expect(seen.length).toBe(1);
});

test("#64 SessionStart has no fork or env-file source", async () => {
  const { agent } = setup({ SessionStart: [hook("x")] }, [{ content: "reply" }]);
  // 只认 new / resume / clear；其它来源一律拒绝（不静默当成 new）。
  await expect(agent.runSessionStart("fork" as unknown as "new")).rejects.toThrow();
  await expect(agent.runSessionStart("env-file" as unknown as "new")).rejects.toThrow();
});

/* ------------------------------------------------------------------ */
/* UserPromptSubmit                                                    */
/* ------------------------------------------------------------------ */

test("#64 UserPromptSubmit blocks before the classifier (zero pre-model calls)", async () => {
  let classified = 0;
  const { agent, seen } = setup(
    { UserPromptSubmit: [hook("blocked by policy", 2)] },
    [{ content: "reply" }],
    {},
    {
      classifier: {
        classify: async () => {
          classified++;
          return null;
        },
      },
    },
  );
  await agent.send("hello");
  expect(classified).toBe(0);
  expect(seen.length).toBe(0);
});

test("#64 UserPromptSubmit block reason is visible and history stays untouched", async () => {
  const { agent, io } = setup({ UserPromptSubmit: [hook("policy says no", 2)] }, [{ content: "reply" }]);
  const before = JSON.stringify(agent.messages);
  const stats = await agent.send("hello");
  expect(JSON.stringify(agent.messages)).toBe(before);
  expect([...io.warns, ...io.infos].join("\n")).toContain("policy says no");
  // 阻断不是「模型失败」：不报 hadError，也不产出空回答。
  expect(stats.hadError).toBe(false);
});

test("#64 UserPromptSubmit additional context is injected once per user input", async () => {
  const { agent, seen } = setup({ UserPromptSubmit: [hook("ctx-marker-64")] }, [
    { content: "first" },
    { content: "second" },
  ]);
  await agent.send("one");
  await agent.send("two");
  for (const request of seen) {
    expect(JSON.stringify(request).split("ctx-marker-64").length - 1).toBe(1);
  }
});

test("#64 UserPromptSubmit context is removed after the turn and not repeated next input", async () => {
  const { agent, seen } = setup({ UserPromptSubmit: [hook("ups-turn-marker")] }, [
    { content: "first" },
    { content: "second" },
  ]);
  await agent.send("one");
  // 轮末摘除：历史里不留 UPS 上下文（它只服务本次原用户输入）。
  expect(JSON.stringify(agent.messages)).not.toContain("ups-turn-marker");
  await agent.send("two");
  // 第二次请求恰好一条（本次注入），不是两条（上次残留 + 本次）。
  expect(JSON.stringify(seen[1]).split("ups-turn-marker").length - 1).toBe(1);
});

test("#64 UserPromptSubmit does not fire for Stop continuation or internal turns", async () => {
  const mark = join(SANDBOX, `ups-${serial++}`);
  const { agent, seen } = setup(
    {
      UserPromptSubmit: [countingHook(mark, "ups")],
      Stop: [hook(JSON.stringify({ decision: "block", reason: "keep going" }))],
    },
    [{ content: "first" }, { content: "second" }],
  );
  await agent.send("hello");
  // 两次模型请求（原轮 + 一次续跑），但只有一条真实用户输入。
  expect(seen.length).toBe(2);
  expect(marks(mark)).toEqual(["ups"]);
});

/* ------------------------------------------------------------------ */
/* Stop                                                                */
/* ------------------------------------------------------------------ */

test("#64 Stop does not fire after tool iterations, only on normal termination", async () => {
  const mark = join(SANDBOX, `stop-${serial++}`);
  const { agent, seen } = setup(
    { Stop: [countingHook(mark, "stop", JSON.stringify({ decision: "block", reason: "again" }))] },
    [
      { content: "let me look", toolCalls: [tc("read_file", { path: "a.txt" })] },
      { content: "done reading" },
      { content: "done again" },
    ],
  );
  writeFileSync(join(SANDBOX, "a.txt"), "hello\n", "utf8");
  await agent.send("read it");
  // 工具轮不触发 Stop：只有模型正常终止那一次触发，续跑一次后收口。
  expect(marks(mark)).toEqual(["stop", "stop"]);
  expect(seen.length).toBe(3);
});

test("#64 Stop continuation does not reset the original iteration budget", async () => {
  const mark = join(SANDBOX, `stop-budget-${serial++}`);
  const { agent, seen } = setup(
    { Stop: [countingHook(mark, "stop", JSON.stringify({ decision: "block", reason: "more" }))] },
    [
      { content: "a", toolCalls: [tc("read_file", { path: "a.txt" })] },
      { content: "b", toolCalls: [tc("read_file", { path: "a.txt" })] },
      { content: "c", toolCalls: [tc("read_file", { path: "a.txt" })] },
    ],
    { maxToolIterations: 3 },
  );
  writeFileSync(join(SANDBOX, "a.txt"), "hello\n", "utf8");
  const stats = await agent.send("go");
  // 原预算 3 次迭代，续跑不新开预算：总请求数不超过 3。
  expect(seen.length).toBeLessThanOrEqual(3);
  expect(stats.iterations).toBeLessThanOrEqual(3);
});

test("#64 Stop continuation shares the original cancel signal", async () => {
  const mark = join(SANDBOX, `stop-cancel-${serial++}`);
  const io = spyIO();
  const seen2: Message[][] = [];
  let calls = 0;
  const agent2 = new Agent({
    cfg: makeCfg(),
    console: io,
    mode: "auto-all",
    systemPrompt: "sys",
    hooks: parseHooksConfig({
      enabled: true,
      Stop: [countingHook(mark, "stop2", JSON.stringify({ decision: "block", reason: "more" }))],
    }),
    chatStream: async (...args: unknown[]) => {
      seen2.push(JSON.parse(JSON.stringify(args[1])) as Message[]);
      calls++;
      if (calls === 1) agent2.cancel();
      return result({ content: `reply ${calls}` });
    },
  });
  const stats = await agent2.send("hello");
  expect(stats.aborted).toBe(true);
  expect(seen2.length).toBe(1);
  // 取消后 hook 不得被调用，更不能被它复活出第二次请求。
  expect(marks(mark)).toEqual([]);
});

test("#64 Stop plain stdout with exit2 does not continue (only JSON block+reason does)", async () => {
  for (const [output, code] of [
    ["please continue", 2],
    ['{"decision":"block"}', 2],
    ["", 2],
  ] as Array<[string, number]>) {
    const mark = join(SANDBOX, `stop-exit2-${serial++}`);
    const { agent, seen } = setup({ Stop: [countingHook(mark, "stop", output, code)] }, [
      { content: "first" },
      { content: "second" },
    ]);
    await agent.send("hello");
    // hook 确实跑过（不是没触发），但退出码 2 + 普通 stdout 不得续跑。
    expect(marks(mark)).toEqual(["stop"]);
    expect(seen.length).toBe(1);
  }
});

test("#64 Stop exit-code failure is diagnostic only and never continues", async () => {
  const mark = join(SANDBOX, `stop-err-${serial++}`);
  const { agent, io, seen } = setup({ Stop: [countingHook(mark, "stop", "hook crashed", 1)] }, [
    { content: "first" },
    { content: "second" },
  ]);
  await agent.send("hello");
  expect(marks(mark)).toEqual(["stop"]);
  expect(seen.length).toBe(1);
  // 失败理由不得被当成续跑理由，但也不能静默：必须留下诊断。
  expect([...io.warns, ...io.infos].join("\n")).toContain("hook crashed");
});

test("#64 Stop second block only diagnoses the limit, no third round", async () => {
  const { agent, io, seen } = setup(
    { Stop: [hook(JSON.stringify({ decision: "block", reason: "keep going" }))] },
    [{ content: "first" }, { content: "second" }, { content: "third" }],
  );
  await agent.send("hello");
  expect(seen.length).toBe(2);
  expect([...io.warns, ...io.infos].join("\n")).toContain("续跑");
});

test("#64 Stop does not continue after abort or error", async () => {
  const mark = join(SANDBOX, `stop-abort-${serial++}`);
  const io = spyIO();
  let calls = 0;
  const agent = new Agent({
    cfg: makeCfg(),
    console: io,
    mode: "auto-all",
    systemPrompt: "sys",
    hooks: parseHooksConfig({
      enabled: true,
      Stop: [countingHook(mark, "stop", JSON.stringify({ decision: "block", reason: "more" }))],
    }),
    chatStream: async () => {
      calls++;
      // 真 LLMError（不是用 Error.name 伪装）：生产 catch 只认 instanceof。
      throw new LLMError("boom", 500);
    },
  });
  const stats = await agent.send("hello");
  expect(stats.hadError).toBe(true);
  expect(calls).toBe(1);
  expect(marks(mark)).toEqual([]);
});

test("#64 Stop continuation keeps TurnEnd and Notification turn_end at exactly one each", async () => {
  const mark = join(SANDBOX, `stop-final-${serial++}`);
  const { agent } = setup(
    {
      Stop: [hook(JSON.stringify({ decision: "block", reason: "verify" }))],
      TurnEnd: [countingHook(mark, "end")],
      Notification: [countingHook(mark, "notice", "", 0)],
    },
    [{ content: "first" }, { content: "second" }],
  );
  await agent.send("hello");
  expect(marks(mark).filter((m) => m === "end").length).toBe(1);
  expect(marks(mark).filter((m) => m === "notice").length).toBe(1);
});

/* ------------------------------------------------------------------ */
/* PreCompact                                                          */
/* ------------------------------------------------------------------ */

test("#64 PreCompact runs for manual compaction before history is touched", async () => {
  const mark = join(SANDBOX, `pc-${serial++}`);
  const { agent } = setup({ PreCompact: [countingHook(mark, "pre")] }, [{ content: "summary" }]);
  history(agent);
  expect(await agent.compact()).toBe(true);
  expect(marks(mark)).toEqual(["pre"]);
});

test("#64 PreCompact rejection keeps history and snapshot identical (manual)", async () => {
  const { agent, seen } = setup({ PreCompact: [hook("nope", 2)] }, [{ content: "summary" }]);
  history(agent);
  const before = JSON.stringify(agent.messages);
  const snapshot = JSON.stringify(agent.lastCompact);
  expect(await agent.compact()).toBe(false);
  expect(seen.length).toBe(0);
  expect(JSON.stringify(agent.messages)).toBe(before);
  expect(JSON.stringify(agent.lastCompact)).toBe(snapshot);
});

test("#64 PreCompact rejection leaves persisted snapshot files untouched", async () => {
  const dir = mkdtempSync(join(SANDBOX, "snap-"));
  const file = join(dir, "session.json");
  const original = JSON.stringify({ messages: [{ role: "system", content: "sys" }], meta: { turns: 0 } });
  writeFileSync(file, original, "utf8");
  const { agent } = setup({ PreCompact: [hook("keep snapshot", 2)] }, [{ content: "summary" }]);
  history(agent);
  const compacted: unknown[] = [];
  agent.opt.onCompacted = (rec) => compacted.push(rec);
  expect(await agent.compact()).toBe(false);
  // 真实磁盘快照：拒绝时一个字节都不许变，且不得触发压缩生效回调。
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(compacted).toEqual([]);
});

test("#64 PreCompact rejection is a distinct state from ordinary compaction failure", async () => {
  const blocked = setup({ PreCompact: [hook("policy", 2)] }, [{ content: "summary" }]);
  history(blocked.agent);
  expect(await blocked.agent.compact()).toBe(false);
  // 普通失败（摘要器返回空）与阻断必须可区分：阻断带可见原因。
  const failed = setup({}, [{ content: "" }]);
  history(failed.agent);
  expect(await failed.agent.compact()).toBe(false);
  const blockedText = [...blocked.io.warns, ...blocked.io.infos].join("\n");
  expect(blockedText).toContain("policy");
});

test("#64 automatic PreCompact fires once per turn and never retries", async () => {
  const mark = join(SANDBOX, `pc-auto-${serial++}`);
  const { agent, seen } = setup(
    { PreCompact: [countingHook(mark, "pre", "no", 2)] },
    [{ content: "reply" }],
    { contextWindow: 1000, compactThreshold: 0.01 },
  );
  history(agent);
  const old = JSON.stringify(agent.messages);
  const snapshot = JSON.stringify(agent.lastCompact);
  const stats = await agent.send("trigger");
  expect(marks(mark)).toEqual(["pre"]);
  expect(seen.length).toBe(0);
  expect(JSON.stringify(agent.messages.slice(0, -1))).toBe(old);
  expect(JSON.stringify(agent.lastCompact)).toBe(snapshot);
  // 本轮明确停止并提示，不是静默继续。
  expect(stats.hadError).toBe(true);
});

test("#64 automatic PreCompact rejection does not fall into trimOldToolOutputs", async () => {
  const { agent, seen } = setup(
    { PreCompact: [hook("no", 2)] },
    [{ content: "reply" }],
    { contextWindow: 1000, compactThreshold: 0.01, maxTokens: 900 },
  );
  history(agent);
  agent.messages.push({ role: "tool", tool_call_id: "c1", name: "read_file", content: "x".repeat(500) });
  const toolContent = agent.messages.at(-1)!.content;
  await agent.send("trigger");
  expect(seen.length).toBe(0);
  expect(agent.messages.at(-2)!.content).toBe(toolContent);
});

/* ------------------------------------------------------------------ */
/* 内部轮（drive/loop/续跑）共享真实用户生命周期额度                    */
/* ------------------------------------------------------------------ */

test("#64 internal turns share one UserPromptSubmit and one Stop allowance", async () => {
  const mark = join(SANDBOX, `internal-${serial++}`);
  const { agent, seen } = setup(
    {
      UserPromptSubmit: [countingHook(mark, "ups")],
      Stop: [countingHook(mark, "stop", JSON.stringify({ decision: "block", reason: "again" }))],
    },
    [{ content: "first" }, { content: "second" }, { content: "third" }, { content: "fourth" }, { content: "fifth" }],
  );
  // 宿主（drive / loop）用 beginUserTurn 声明「这是同一条真实用户输入」，
  // 之后的内部 send 不得再发 UPS，也不得重置 Stop 额度。
  // 一条用户输入 = 一次 begin + N 次内部 send + 一次 end（begin 会重置额度，
  // 所以第二次 begin 只能出现在「下一条真实用户输入」处，不能用于内部轮）。
  agent.beginUserTurn("drive round 1");
  await agent.send("drive round 1");
  expect(marks(mark).filter((m) => m === "ups").length).toBe(1);
  expect(marks(mark).filter((m) => m === "stop").length).toBe(2);
  // 第二轮内部 send（同一条用户输入）：额度已用完，不得再续跑，也不得再发 UPS。
  await agent.send("drive round 2");
  expect(marks(mark).filter((m) => m === "ups").length).toBe(1);
  expect(marks(mark).filter((m) => m === "stop").length).toBe(3);
  expect(seen.length).toBe(3);
  agent.endUserTurn();

  // 下一条真实用户输入：额度重新发放 —— UPS 再发一次，Stop 续跑也重新可用。
  agent.beginUserTurn("drive round 3");
  await agent.send("drive round 3");
  expect(marks(mark).filter((m) => m === "ups").length).toBe(2);
  expect(marks(mark).filter((m) => m === "stop").length).toBe(5);
  expect(seen.length).toBe(5);
  agent.endUserTurn();
});

/* ------------------------------------------------------------------ */
/* 子代理不触发会话/用户事件                                            */
/* ------------------------------------------------------------------ */

test("#64 subagent turns do not trigger session or user lifecycle events", async () => {
  const mark = join(SANDBOX, `sub-${serial++}`);
  const { agent } = setup(
    {
      SessionStart: [countingHook(mark, "start")],
      UserPromptSubmit: [countingHook(mark, "ups")],
      Stop: [countingHook(mark, "stop", JSON.stringify({ decision: "block", reason: "again" }))],
      PreCompact: [countingHook(mark, "pre")],
    },
    [{ content: "reply" }],
    {},
    { isSubagent: true },
  );
  await agent.send("subagent work");
  await agent.runSessionStart("new");
  expect(marks(mark)).toEqual([]);
});


test("#64 Stop continuation retains original UPS context until final completion", async () => {
  const {agent, seen}=setup({UserPromptSubmit:[hook("retained-context")], Stop:[hook('{"decision":"block","reason":"verify"}')]}, [{content:"first"},{content:"last"}]);
  await agent.send("hello");
  expect(seen.length).toBe(2);
  for(const request of seen) expect(JSON.stringify(request).split("retained-context").length-1).toBe(1);
  expect(JSON.stringify(agent.messages)).not.toContain("retained-context");
});

test("#64 Stop after tool and terminal response cannot exceed original request cap", async () => {
  const {agent, seen}=setup({Stop:[hook('{"decision":"block","reason":"verify"}')]}, [{content:"read",toolCalls:[tc("read_file",{path:"a.txt"})]},{content:"done"},{content:"extra"}],{maxToolIterations:2});
  const stats=await agent.send("hello");
  expect(seen.length).toBe(2);
  expect(stats.iterations).toBe(2);
});

test("#64 truncated model termination does not trigger Stop", async () => {
  const mark=join(SANDBOX,`length-${serial++}`);
  const {agent, seen}=setup({Stop:[countingHook(mark,"stop",'{"decision":"block","reason":"verify"}')]},[{content:"partial",finishReason:"length"},{content:"extra"}]);
  await agent.send("hello");
  expect(seen.length).toBe(1);
  expect(marks(mark)).toEqual([]);
});

test("#64 explicit blocked user boundary cannot be bypassed by a second submit/send", async () => {
  const {agent, seen}=setup({UserPromptSubmit:[hook("denied",2)]},[{content:"must not call"}]);
  agent.beginUserTurn("hello");
  expect((await agent.submitUserPrompt("hello")).blocked).toBe(true);
  expect((await agent.submitUserPrompt("hello")).blocked).toBe(true);
  expect((await agent.send("hello")).blocked).toBe(true);
  expect(seen.length).toBe(0);
  agent.endUserTurn();
});

test("#64 automatic refusal preserves a previous compaction snapshot", async () => {
  const {agent}=setup({PreCompact:[hook("retain",2)]},[{content:"never"}],{contextWindow:1000,compactThreshold:0.01});
  history(agent);
  agent.lastCompact={beforeTokens:900,afterTokens:100};
  await agent.send("trigger");
  expect(agent.lastCompact).toEqual({beforeTokens:900,afterTokens:100});
});


test("#64 cancellation interrupts UserPromptSubmit before classifier or model", async () => {
  let classified=0;
  const {agent, seen}=setup({UserPromptSubmit:[{command:script("cat >/dev/null; sleep 2; echo late"),timeout:3}]},[{content:"never"}],{}, {classifier:{classify:async()=>{classified++;return null;}}});
  const timer=setTimeout(()=>agent.cancel(),50);
  try {
    const stats=await agent.send("hello");
    expect(stats.aborted).toBe(true);
    expect(seen.length).toBe(0);
    expect(classified).toBe(0);
  } finally {clearTimeout(timer);}
},5000);

test("#64 cancellation interrupts the in-flight Stop hook without reviving a request", async () => {
  const {agent, seen}=setup({Stop:[{command:script(`cat >/dev/null; sleep 2; echo '{"decision":"block","reason":"late"}'`),timeout:3}]},[{content:"first"},{content:"never"}]);
  const started=Date.now();
  const timer=setTimeout(()=>agent.cancel(),80);
  try {
    const stats=await agent.send("hello");
    expect(stats.aborted).toBe(true);
    expect(seen.length).toBe(1);
    expect(Date.now()-started).toBeLessThan(1500);
  } finally {clearTimeout(timer);}
},5000);

test("#64 cancellation during automatic PreCompact prevents summarizer requests", async () => {
  const {agent, seen}=setup({PreCompact:[{command:script("cat >/dev/null; sleep 2; echo late"),timeout:3}]},[{content:"never"}],{contextWindow:1000,compactThreshold:0.01});
  history(agent);
  const before=JSON.stringify(agent.messages);
  const timer=setTimeout(()=>agent.cancel(),50);
  try {
    const stats=await agent.send("trigger");
    expect(stats.aborted).toBe(true);
    expect(seen.length).toBe(0);
    expect(JSON.stringify(agent.messages.slice(0,-1))).toBe(before);
  } finally {clearTimeout(timer);}
},5000);
