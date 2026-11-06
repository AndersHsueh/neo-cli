/**
 * plan-mode.test.ts — 交互式规划工作流（issue #14）。
 *
 * 覆盖：
 *  a. 规划态纯逻辑（PlanSession）：进入 / 提交 / 修改 / 确认切回 baseMode / 取消。
 *  b. 规划态禁写：effectiveMode 为 plan 时 decidePermission 拒绝写；approve 后按 baseMode 放行。
 *  c. /mode plan 与 --plan 语义不变（只读闸门，不会自动变成交互规划态）。
 *  d. /plan 入口与 approve / revise / cancel 路径（经 handleCommand 走真实命令分发）。
 *  e. help 文案能区分两套概念。
 *
 * 运行：bun test tests/plan-mode.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PlanSession,
  PLAN_CONTROL_TOOLS,
  PLAN_VISIBLE_TOOLS,
  effectivePermissionMode,
  filterPlanTools,
  implementationMessage,
  parsePlanDraft,
  renderPlan,
  type PlanDraft,
} from "../src/agent/plan-mode.ts";
import { decidePermission } from "../src/agent/policy.ts";
import { Agent } from "../src/agent.ts";
import { mainToolNames, toolSpecs } from "../src/tools/index.ts";
import { helpText } from "../src/cli/help.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { dispatchCommand, wireCommands } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commands.ts";
import type { Config } from "../src/config.ts";
import type { AgentIO } from "../src/agent.ts";
import { captureConsole } from "./helpers.ts";

const SANDBOX = join(tmpdir(), `neo-plan-test-${Date.now()}`);
mkdirSync(SANDBOX, { recursive: true });
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

function makeCfg(): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [],
    routes: {},
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
  } as unknown as Config;
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

/** 不注入 chatStream 的 Agent：本文件只测会话态，不发请求。 */
function makeAgent(mode: "ask" | "auto-edit" | "auto-all" | "plan", over: Record<string, unknown> = {}): Agent {
  return new Agent({
    cfg: makeCfg(),
    console: silentIO(),
    mode,
    systemPrompt: "sys",
    ...over,
  });
}

const DRAFT: PlanDraft = {
  title: "补完 /plan 入口",
  summary: "把规划态接到 CLI",
  steps: [{ title: "登记命令表" }, { title: "实现 case", detail: "start/approve/revise/cancel" }],
  risks: ["命令表漂移守卫会红"],
  files: ["src/cli/commands.ts"],
};

function makeCmdCtx(agent: Agent, ui: ReturnType<typeof captureConsole>["ui"]): CommandContext {
  return {
    agent,
    ui,
    cfg: makeCfg(),
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "s1", model: "m-default", cwd: SANDBOX } as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
  };
}

/* ------------------------------------------------------------------ */
/* a. PlanSession 纯逻辑                                               */
/* ------------------------------------------------------------------ */

describe("a. PlanSession 状态机", () => {
  test("进入：澄清态、无方案、baseMode 记录进入前的模式", () => {
    const s = new PlanSession("ask");
    expect(s.active).toBe(true);
    expect(s.phase).toBe("clarify");
    expect(s.draft).toBeNull();
    expect(s.baseMode).toBe("ask");
    expect(s.revisions).toBe(0);
  });

  test("提交方案 → proposed，方案可读", () => {
    const s = new PlanSession("auto-edit");
    s.submit(DRAFT);
    expect(s.phase).toBe("proposed");
    expect(s.draft?.title).toBe("补完 /plan 入口");
    expect(s.active).toBe(true); // 提交不等于批准，仍在规划态
  });

  test("修改方案 → 回到 clarify，revisions+1，上一版保留", () => {
    const s = new PlanSession("ask");
    s.submit(DRAFT);
    s.revise();
    expect(s.phase).toBe("clarify");
    expect(s.revisions).toBe(1);
    expect(s.draft).toEqual(DRAFT); // 保留上一版供模型参考
  });

  test("确认 → implementing，离开规划态（active=false）", () => {
    const s = new PlanSession("auto-all");
    s.submit(DRAFT);
    s.approve();
    expect(s.phase).toBe("implementing");
    expect(s.active).toBe(false);
  });

  test("snapshot 是快照，不随后续变更而变", () => {
    const s = new PlanSession("ask");
    const snap = s.snapshot();
    s.submit(DRAFT);
    expect(snap.phase).toBe("clarify");
    expect(snap.draft).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* b. 规划态禁写                                                       */
/* ------------------------------------------------------------------ */

describe("b. 规划态借用只读闸门", () => {
  test("effectivePermissionMode：规划中恒为 plan，否则原样", () => {
    expect(effectivePermissionMode("auto-all", true)).toBe("plan");
    expect(effectivePermissionMode("ask", true)).toBe("plan");
    expect(effectivePermissionMode("auto-all", false)).toBe("auto-all");
    expect(effectivePermissionMode("plan", false)).toBe("plan");
  });

  test("规划态下 decidePermission 拒绝写盘与执行", () => {
    const eff = effectivePermissionMode("auto-all", true);
    expect(decidePermission(eff, "write_file")).toEqual({ allow: false, reason: "plan" });
    expect(decidePermission(eff, "edit_file")).toEqual({ allow: false, reason: "plan" });
    expect(decidePermission(eff, "shell")).toEqual({ allow: false, reason: "plan" });
  });

  test("approve 之后按 baseMode 放行（baseMode 不是 plan）", () => {
    const agent = makeAgent("auto-all");
    agent.enterPlan("auto-all");
    expect(agent.effectiveMode).toBe("plan");
    expect(decidePermission(agent.effectiveMode, "write_file")).toEqual({ allow: false, reason: "plan" });

    agent.approvePlan();
    expect(agent.planning).toBe(false);
    expect(agent.mode).toBe("auto-all");
    expect(agent.effectiveMode).toBe("auto-all");
    expect(decidePermission(agent.effectiveMode, "write_file")).toEqual({ allow: true });
  });

  test("baseMode = ask：approve 后写盘回到「需批准」而不是放行", () => {
    const agent = makeAgent("ask");
    agent.enterPlan("ask");
    agent.approvePlan();
    expect(agent.mode).toBe("ask");
    expect(decidePermission(agent.effectiveMode, "write_file")).toEqual({
      allow: false,
      reason: "needs-confirm",
    });
  });

  test("规划态工具清单收窄：写/执行/派生类不在，只读 + 控制工具在", () => {
    const agent = makeAgent("auto-all");
    agent.enterPlan("auto-all");
    const names = agent.toolSpecsFor().map((s) => s.function.name);
    for (const n of ["write_file", "edit_file", "shell", "task", "remember"]) {
      expect(names).not.toContain(n);
    }
    for (const n of ["read_file", "grep", ...PLAN_CONTROL_TOOLS]) expect(names).toContain(n);
    // 只断言「收窄」：规划清单里每个名字都属于 PLAN_VISIBLE_TOOLS（不锁数量，
    // 运行时还会注册 task/wiki 等工具，数量随组合根变化）。
    for (const n of names) expect(PLAN_VISIBLE_TOOLS).toContain(n);
  });

  test("非规划态工具清单里没有 submit_plan / exit_plan_mode", () => {
    const agent = makeAgent("ask");
    const names = agent.toolSpecsFor().map((s) => s.function.name);
    for (const n of PLAN_CONTROL_TOOLS) expect(names).not.toContain(n);
    // 系统提示 / banner 用的 mainToolNames() 同样排除
    for (const n of PLAN_CONTROL_TOOLS) expect(mainToolNames()).not.toContain(n);
  });

  test("filterPlanTools 保持注册表顺序", () => {
    const all = toolSpecs();
    const filtered = filterPlanTools(all).map((s) => s.function.name);
    const expected = all.map((s) => s.function.name).filter((n) => PLAN_VISIBLE_TOOLS.includes(n));
    expect(filtered).toEqual(expected);
  });
});

/* ------------------------------------------------------------------ */
/* c. /mode plan 与 --plan 语义不变                                    */
/* ------------------------------------------------------------------ */

describe("c. /mode plan 与 --plan 是只读闸门，不进交互规划态", () => {
  test("mode=plan 的 Agent 默认不在规划态", () => {
    const agent = makeAgent("plan");
    expect(agent.planning).toBe(false);
    expect(agent.plan).toBeNull();
    expect(agent.effectiveMode).toBe("plan");
    expect(decidePermission(agent.effectiveMode, "write_file")).toEqual({ allow: false, reason: "plan" });
  });

  test("planBaseMode 未设置时不会自动进入规划态（--plan 启动路径）", () => {
    const agent = makeAgent("plan", { planBaseMode: undefined });
    expect(agent.planning).toBe(false);
  });

  test("/mode plan 只改权限模式，不进规划态", async () => {
    const agent = makeAgent("ask");
    const cap = captureConsole();
    await dispatchCommand("/mode plan", makeCmdCtx(agent, cap.ui));
    expect(agent.mode).toBe("plan");
    expect(agent.planning).toBe(false);
    // 文案必须点明「这是只读闸门，不是交互规划」
    expect(cap.out()).toContain("只读闸门");
    expect(cap.out()).toContain("/plan");
  });

  test("/mode 选择器里 plan 的说明仍是只读闸门", () => {
    const out = helpText();
    expect(out).toContain("--plan            只读闸门");
  });
});

/* ------------------------------------------------------------------ */
/* d. /plan 入口与 approve / revise / cancel                           */
/* ------------------------------------------------------------------ */

describe("d. /plan 命令路径", () => {
  wireCommands();

  test("/plan 登记在命令表里，说明写清与 /mode plan 的区别", () => {
    const entry = COMMANDS.find((c) => c.name === "plan");
    expect(entry).toBeDefined();
    expect(entry?.description).toContain("交互规划工作流");
    expect(entry?.description).toContain("/mode plan");
  });

  test("/plan 无参数：进入规划态，baseMode = 当前权限模式", async () => {
    const agent = makeAgent("auto-edit");
    const cap = captureConsole();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    expect(agent.planning).toBe(true);
    expect(agent.plan?.phase).toBe("clarify");
    expect(agent.plan?.baseMode).toBe("auto-edit");
    expect(agent.effectiveMode).toBe("plan");
    expect(cap.out()).toContain("已进入规划态");
  });

  test("/plan start 与无参数等价", async () => {
    const agent = makeAgent("ask");
    const cap = captureConsole();
    await dispatchCommand("/plan start", makeCmdCtx(agent, cap.ui));
    expect(agent.planning).toBe(true);
  });

  test("/plan 重复进入不丢已提交的方案", async () => {
    const agent = makeAgent("ask");
    const cap = captureConsole();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    agent.submitPlan(DRAFT);
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    expect(agent.plan?.draft?.title).toBe(DRAFT.title);
    expect(agent.plan?.phase).toBe("proposed");
  });

  test("/plan 在已提交方案时展示当前方案", async () => {
    const agent = makeAgent("ask");
    const cap = captureConsole();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    agent.submitPlan(DRAFT);
    cap.clear();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    expect(cap.out()).toContain("补完 /plan 入口");
    expect(cap.out()).toContain("步骤");
    expect(cap.out()).toContain("/plan approve");
  });

  test("/plan approve：切回 baseMode、离开规划态、方案钉进 system 消息", async () => {
    const agent = makeAgent("auto-all");
    const cap = captureConsole();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    agent.submitPlan(DRAFT);
    await dispatchCommand("/plan approve", makeCmdCtx(agent, cap.ui));
    expect(agent.planning).toBe(false);
    expect(agent.mode).toBe("auto-all");
    expect(decidePermission(agent.effectiveMode, "write_file")).toEqual({ allow: true });
    const pinned = agent.messages.filter((m) => m.role === "system" && String(m.content).includes("规划已确认"));
    expect(pinned.length).toBe(1);
    expect(String(pinned[0]?.content)).toContain("补完 /plan 入口");
    expect(cap.out()).toContain("开始实施");
  });

  test("/plan go 是 approve 的别名", async () => {
    const agent = makeAgent("ask");
    const cap = captureConsole();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    agent.submitPlan(DRAFT);
    await dispatchCommand("/plan go", makeCmdCtx(agent, cap.ui));
    expect(agent.planning).toBe(false);
    expect(agent.mode).toBe("ask");
  });

  test("/plan approve 在没有方案时拒绝（不假装开始实施）", async () => {
    const agent = makeAgent("ask");
    const cap = captureConsole();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    await dispatchCommand("/plan approve", makeCmdCtx(agent, cap.ui));
    expect(agent.planning).toBe(true); // 仍在规划态
    expect(cap.out()).toContain("还没有已提交的方案");
  });

  test("/plan approve 不在规划态时提示，不改模式", async () => {
    const agent = makeAgent("ask");
    const cap = captureConsole();
    await dispatchCommand("/plan approve", makeCmdCtx(agent, cap.ui));
    expect(agent.mode).toBe("ask");
    expect(cap.out()).toContain("当前不在规划态");
  });

  test("/plan revise：回到澄清态，revisions+1，仍在规划态", async () => {
    const agent = makeAgent("ask");
    const cap = captureConsole();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    agent.submitPlan(DRAFT);
    await dispatchCommand("/plan revise", makeCmdCtx(agent, cap.ui));
    expect(agent.planning).toBe(true);
    expect(agent.plan?.phase).toBe("clarify");
    expect(agent.plan?.revisions).toBe(1);
    expect(cap.out()).toContain("澄清态");
  });

  test("/plan cancel：退出规划态、切回 baseMode、不注入实施提示", async () => {
    const agent = makeAgent("auto-edit");
    const cap = captureConsole();
    await dispatchCommand("/plan", makeCmdCtx(agent, cap.ui));
    agent.submitPlan(DRAFT);
    await dispatchCommand("/plan cancel", makeCmdCtx(agent, cap.ui));
    expect(agent.planning).toBe(false);
    expect(agent.mode).toBe("auto-edit");
    expect(agent.messages.some((m) => String(m.content).includes("规划已确认"))).toBe(false);
    expect(cap.out()).toContain("已退出规划态");
  });

  test("模型提交方案后 requestPlanApproval 被调用（不自动批准）", () => {
    let called = 0;
    const agent = makeAgent("ask", { requestPlanApproval: () => (called += 1) });
    agent.enterPlan("ask");
    agent.submitPlan(DRAFT);
    // 直接走工具层：exit_plan_mode 只请宿主提示，不替用户批准
    const host = (agent as unknown as { makeCtx(s: AbortSignal): { planHost?: { requestPlanApproval(): void } } });
    const ctx = host.makeCtx(new AbortController().signal);
    ctx.planHost?.requestPlanApproval();
    expect(called).toBe(1);
    expect(agent.planning).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* e. 文案区分两套概念                                                 */
/* ------------------------------------------------------------------ */

describe("e. help 文案区分 /mode plan 与 /plan", () => {
  const out = helpText();

  test("--plan 行写明是只读闸门", () => {
    expect(out).toContain("--plan            只读闸门：禁止一切写操作");
  });

  test("/plan 行写明是交互规划工作流", () => {
    expect(out).toContain("/plan [子命令]   交互规划工作流");
    expect(out).toContain("/plan approve");
    expect(out).toContain("/plan revise");
    expect(out).toContain("/plan cancel");
  });

  test("明确写出两者不是一回事", () => {
    expect(out).toContain("/mode plan 与 --plan 是「只读闸门」");
    expect(out).toContain("与 /plan 不是一回事");
  });
});

/* ------------------------------------------------------------------ */
/* 方案解析与渲染                                                      */
/* ------------------------------------------------------------------ */

describe("parsePlanDraft / renderPlan / implementationMessage", () => {
  test("宽容解析：steps 可为字符串数组，risks 可为单串", () => {
    const d = parsePlanDraft({ title: "T", steps: ["a", "b"], risks: "无", files: "x.ts" });
    expect(d.steps).toEqual([{ title: "a" }, { title: "b" }]);
    expect(d.risks).toEqual([]); // 「无」被归一成空
    expect(d.files).toEqual(["x.ts"]);
  });

  test("空 title / 空 steps 抛错（不静默当已提交）", () => {
    expect(() => parsePlanDraft({ title: " ", steps: ["a"] })).toThrow(/title/);
    expect(() => parsePlanDraft({ title: "T", steps: [] })).toThrow(/steps/);
  });

  test("renderPlan 含标题/步骤/风险/文件四段", () => {
    const text = renderPlan(DRAFT);
    expect(text).toContain("方案：补完 /plan 入口");
    expect(text).toContain("1. 登记命令表");
    expect(text).toContain("2. 实现 case —— start/approve/revise/cancel");
    expect(text).toContain("命令表漂移守卫会红");
    expect(text).toContain("src/cli/commands.ts");
  });

  test("implementationMessage 把方案钉进提示", () => {
    const msg = implementationMessage(DRAFT);
    expect(msg).toContain("规划已确认");
    expect(msg).toContain("补完 /plan 入口");
  });
});
