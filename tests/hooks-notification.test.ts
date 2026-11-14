/**
 * Notification hook（issue #56）—— 「在等你」与「跑完了」的通知信号。
 *
 * 覆盖：
 *  - N1 配置解析：Notification 是第四个事件，条目照常加载；matcher 在这里匹配**触发原因**。
 *  - N2 matchReason：精确 / 通配 / 正则 / 缺省（缺省 = 全部原因）；与 matchTool 分开，不共用语义。
 *  - N3 permission_prompt：主代理**弹审批框之前**触发（顺序断言：hook 先跑，confirm 才被调用）。
 *  - N4 turn_end：一轮结束触发，与 TurnEnd 事件并存且独立（两者都配时都跑）。
 *  - N5 matcher 按原因过滤：只配 turn_end 时 permission_prompt 不触发。
 *  - N6 失败隔离：非 0 退出 / 命令不存在 / 超时都不影响主会话继续，且有可读诊断。
 *  - N7 未配置时零行为变化（不 spawn、不弹任何东西）。
 *  - N8 /hooks 展示：matcher 一栏对 Notification 显示「原因」而不是工具名。
 *
 * 为什么单独开文件：hooks.test.ts 已 1390 行，Notification 有自己的时机与语义
 * （不阻断、按原因匹配），混进去会让「阻断语义」与「通知语义」在同一文件里互相干扰。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import {
  HOOK_EVENTS,
  matchReason,
  parseHooksConfig,
  runHook,
  type HookDef,
  type HookPayload,
  type HooksConfig,
} from "../src/hooks/index.ts";
import type { Config } from "../src/config.ts";
import type { StreamResult, ToolCall } from "../src/llm.ts";

/* ------------------------------------------------------------------ */
/* 沙箱与脚手架（与 hooks.test.ts 同口径）                              */
/* ------------------------------------------------------------------ */

// 沙箱必须放在项目目录内：/tmp 在部分环境里会被 insideGlobalSkills 的
// 祖先上溯误判成「全局技能库」，导致 write_file 在审批前就被拒绝。
const SANDBOX = join(import.meta.dir, `.tmp-hooks-notify-${Date.now()}`);
mkdirSync(SANDBOX, { recursive: true });
writeFileSync(join(SANDBOX, "a.txt"), "hello", "utf8");
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

function makeCfg(over: Partial<Config> = {}): Config {
  // 与 tests/hooks.test.ts 的 makeCfg 逐字段对齐 —— 少一个字段（尤其
  // maxToolIterations）会让 agent 循环一次都不进，整条链路静默不跑，
  // 表现为「fake chatStream 从没被调用 + hadError=本轮在重试/迭代上限处结束」。
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

interface SpyIO extends AgentIO {
  warns: string[];
  infos: string[];
  confirms: string[];
}

function spyIO(confirmAnswer = true): SpyIO {
  const warns: string[] = [];
  const infos: string[] = [];
  const confirms: string[] = [];
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
    async confirm(q: string): Promise<boolean> {
      confirms.push(q);
      return confirmAnswer;
    },
    width: 100,
  };
  return Object.assign(base, { warns, infos, confirms }) as SpyIO;
}

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function fakeStream(steps: Array<Partial<StreamResult>>) {
  let i = 0;
  return (): Promise<StreamResult> => {
    const step = steps[i];
    if (!step) throw new Error(`fake chatStream: 脚本耗尽（第 ${i + 1} 次调用）`);
    i++;
    return Promise.resolve({
      content: "",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
      ...step,
    } as StreamResult);
  };
}

/** 写一个可执行的 hook 脚本，返回其路径。 */
function script(name: string, body: string): string {
  const p = join(SANDBOX, name);
  writeFileSync(p, body, { encoding: "utf8", mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

function hooksCfg(raw: unknown): HooksConfig {
  const parsed = parseHooksConfig(raw);
  return { ...parsed, enabled: true };
}

/** 读 JSONL 日志（hook 用 `cat >> log` 落盘，每条一行）。 */
function readLog(p: string): Array<Record<string, unknown>> {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function hookDef(over: Partial<HookDef> = {}): HookDef {
  return {
    event: "Notification",
    command: "true",
    timeout: 10,
    onFailure: "continue",
    origin: "test",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* N1 配置解析                                                         */
/* ------------------------------------------------------------------ */

describe("N1 Notification 配置解析", () => {
  test("N1a Notification 是第四个事件，条目照常加载", () => {
    expect(HOOK_EVENTS).toContain("Notification");
    const c = parseHooksConfig({
      enabled: true,
      Notification: [{ command: "notify.sh", matcher: "permission_prompt" }],
    });
    expect(c.hooks.Notification.length).toBe(1);
    expect(c.hooks.Notification[0]!.event).toBe("Notification");
    expect(c.hooks.Notification[0]!.matcher).toBe("permission_prompt");
    expect(c.warnings).toEqual([]);
  });

  test("N1b 只有 Notification 一条时也算「配了 hook」（不再报「没有有效条目」）", () => {
    const c = parseHooksConfig({ enabled: true, Notification: [{ command: "notify.sh" }] });
    expect(c.warnings.join("\n")).not.toContain("没有任何有效条目");
  });

  test("N1c 事件名拼错仍只丢该条并给可读 warning（Notification 拼错要能被看见）", () => {
    const c = parseHooksConfig({ enabled: true, Notifications: [{ command: "x.sh" }] });
    expect(c.hooks.Notification.length).toBe(0);
    expect(c.warnings.join("\n")).toContain("Notification");
  });
});

/* ------------------------------------------------------------------ */
/* N2 matchReason                                                      */
/* ------------------------------------------------------------------ */

describe("N2 matchReason（按触发原因匹配）", () => {
  test("N2a 精确 / 通配 / 正则 / 缺省", () => {
    expect(matchReason("permission_prompt", "permission_prompt")).toBe(true);
    expect(matchReason("permission_prompt", "turn_end")).toBe(false);
    expect(matchReason("turn_end", "permission_prompt")).toBe(false);
    expect(matchReason("*", "turn_end")).toBe(true);
    expect(matchReason("permission_*", "permission_prompt")).toBe(true);
    expect(matchReason("permission_*", "turn_end")).toBe(false);
    expect(matchReason("/^turn/", "turn_end")).toBe(true);
    expect(matchReason("/^turn/", "permission_prompt")).toBe(false);
    expect(matchReason(undefined, "turn_end")).toBe(true);
    expect(matchReason("", "permission_prompt")).toBe(true);
  });

  test("N2b 非法正则按不匹配处理（解析期已给 warning，运行期不抛）", () => {
    expect(matchReason("/[/", "turn_end")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* N3 permission_prompt：审批框弹出之前                                 */
/* ------------------------------------------------------------------ */

describe("N3 permission_prompt", () => {
  test("N3a 弹审批框之前触发，载荷带 reason=permission_prompt 与工具名", async () => {
    const log = join(SANDBOX, "n3a.log");
    const p = script("n3a.sh", `#!/bin/sh\ncat >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: p }] });
    const io = spyIO(false); // 用户拒绝，工具不执行
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "ask",
      systemPrompt: "sys",
      hooks: cfg,
      sessionId: "sess-n3a",
      chatStream: fakeStream([
        { toolCalls: [tc("write_file", { path: join(SANDBOX, "n3a.txt"), content: "x" })] },
        { content: "停下了。" },
      ]),
    });
    await agent.send("写文件");

    const lines = readLog(log);
    // 该条 Notification 没配 matcher = 全部原因都触发：本轮既有 permission_prompt
    // 也有轮末的 turn_end，所以是两条。这里只断言 permission_prompt 那条的内容。
    expect(lines.length).toBe(2);
    const ev = lines.find((e) => e["reason"] === "permission_prompt")!;
    expect(ev["event"]).toBe("Notification");
    expect(ev["tool_name"]).toBe("write_file");
    expect(ev["session_id"]).toBe("sess-n3a");
    expect(ev["cwd"]).toBe(SANDBOX);
    expect(ev["mode"]).toBe("ask");
    expect(io.confirms.length).toBe(1); // 审批照常发生
  });

  test("N3b 顺序硬约束：hook 在 ui.confirm 之前跑完（用户已经在点确认时通知才来得及）", async () => {
    const order: string[] = [];
    const p = script("n3b.sh", `#!/bin/sh\ncat > /dev/null\n`);
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: `${p} && echo hook` }] });
    const io = spyIO(true);
    const origConfirm = io.confirm.bind(io);
    io.confirm = async (q: string): Promise<boolean> => {
      // 走到 confirm 时 hook 的落盘标记必须已经存在
      order.push(`confirm:${existsSync(join(SANDBOX, "n3b.marker")) ? "after-hook" : "before-hook"}`);
      return origConfirm(q);
    };
    const markerScript = script(
      "n3b-mark.sh",
      `#!/bin/sh\ncat > /dev/null\ntouch ${join(SANDBOX, "n3b.marker")}\n`,
    );
    const cfg2 = hooksCfg({ enabled: true, Notification: [{ command: markerScript }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "ask",
      systemPrompt: "sys",
      hooks: cfg2,
      chatStream: fakeStream([
        { toolCalls: [tc("write_file", { path: join(SANDBOX, "n3b.txt"), content: "x" })] },
        { content: "好。" },
      ]),
    });
    await agent.send("写");
    expect(order).toEqual(["confirm:after-hook"]);
    expect(cfg.hooks.Notification.length).toBe(1); // 上面那条 cfg 只是占位，确认解析没崩
  });

  test("N3c 不需要审批的调用（auto-all / 只读工具）不触发 permission_prompt", async () => {
    const log = join(SANDBOX, "n3c.log");
    const p = script("n3c.sh", `#!/bin/sh\ncat >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: p, matcher: "permission_prompt" }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { toolCalls: [tc("write_file", { path: join(SANDBOX, "n3c.txt"), content: "x" })] },
        { content: "好。" },
      ]),
    });
    await agent.send("写");
    expect(readLog(log).filter((e) => e["reason"] === "permission_prompt").length).toBe(0);
    expect(existsSync(join(SANDBOX, "n3c.txt"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* N4 turn_end：与 TurnEnd 并存且独立                                   */
/* ------------------------------------------------------------------ */

describe("N4 turn_end", () => {
  test("N4a 一轮结束触发一次，载荷带 reason=turn_end", async () => {
    const log = join(SANDBOX, "n4a.log");
    const p = script("n4a.sh", `#!/bin/sh\ncat >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: p, matcher: "turn_end" }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      nonInteractive: true,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    await agent.send("hi");
    const lines = readLog(log);
    expect(lines.length).toBe(1);
    expect(lines[0]!["event"]).toBe("Notification");
    expect(lines[0]!["reason"]).toBe("turn_end");
  });

  test("N4b 与 TurnEnd 事件并存：两者都配时各跑各的，互不吞掉", async () => {
    const log = join(SANDBOX, "n4b.log");
    const p = script("n4b.sh", `#!/bin/sh\ncat >> ${log}\n`);
    const cfg = hooksCfg({
      enabled: true,
      TurnEnd: [{ command: p }],
      Notification: [{ command: p, matcher: "turn_end" }],
    });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      nonInteractive: true,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    await agent.send("hi");
    const events = readLog(log).map((e) => e["event"]);
    expect(events).toContain("TurnEnd");
    expect(events).toContain("Notification");
    expect(events.length).toBe(2);
  });

  test("N4c 子代理回合不触发 turn_end（与 TurnEnd 同口径：子代理的回合不是用户的回合）", async () => {
    const log = join(SANDBOX, "n4c.log");
    const p = script("n4c.sh", `#!/bin/sh\ncat >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: p, matcher: "turn_end" }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "ask",
      systemPrompt: "sys",
      hooks: cfg,
      isSubagent: true,
      chatStream: fakeStream([{ content: "子代理答完。" }]),
    });
    await agent.send("hi");
    expect(readLog(log).length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* N5 matcher 按原因过滤                                               */
/* ------------------------------------------------------------------ */

describe("N5 matcher 按原因过滤", () => {
  test("N5a 只配 turn_end 时，permission_prompt 不触发", async () => {
    const log = join(SANDBOX, "n5a.log");
    const p = script("n5a.sh", `#!/bin/sh\ncat >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: p, matcher: "turn_end" }] });
    const io = spyIO(false);
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "ask",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { toolCalls: [tc("write_file", { path: join(SANDBOX, "n5a.txt"), content: "x" })] },
        { content: "好。" },
      ]),
    });
    await agent.send("写");
    const reasons = readLog(log).map((e) => e["reason"]);
    expect(reasons).not.toContain("permission_prompt");
    expect(reasons).toContain("turn_end");
  });

  test("N5b 只配 permission_prompt 时，turn_end 不触发", async () => {
    const log = join(SANDBOX, "n5b.log");
    const p = script("n5b.sh", `#!/bin/sh\ncat >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: p, matcher: "permission_prompt" }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      nonInteractive: true,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    await agent.send("hi");
    expect(readLog(log).length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* N6 失败隔离                                                         */
/* ------------------------------------------------------------------ */

describe("N6 失败隔离", () => {
  test("N6a 非 0 退出：主会话继续，给可读诊断", async () => {
    const p = script("n6a.sh", "#!/bin/sh\necho 'notify failed'\nexit 3\n");
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: p }] });
    const io = spyIO();
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      nonInteractive: true,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false); // 通知失败不算本轮出错
    expect(io.warns.join("\n")).toContain("Notification hook");
    expect(io.warns.join("\n")).toContain("notify failed");
  });

  test("N6b 命令不存在：不抛异常，给可读诊断", async () => {
    const cfg = hooksCfg({
      enabled: true,
      Notification: [{ command: join(SANDBOX, "definitely-not-here.sh") }],
    });
    const io = spyIO();
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      nonInteractive: true,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false);
    expect(io.warns.join("\n")).toContain("Notification hook");
  });

  test("N6c 超时：被杀掉且不拖垮主会话", async () => {
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: "sleep 30", timeout: 1 }] });
    const io = spyIO();
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      nonInteractive: true,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    const started = Date.now();
    const stats = await agent.send("hi");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stats.hadError).toBe(false);
    expect(io.warns.join("\n")).toContain("超时");
  });

  test("N6d 退出码 2 在 Notification 上不阻断（没有模型要喂回原因）", async () => {
    const p = script("n6d.sh", "#!/bin/sh\necho 'would block'\nexit 2\n");
    const cfg = hooksCfg({ enabled: true, Notification: [{ command: p }] });
    const io = spyIO(true);
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "ask",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { toolCalls: [tc("write_file", { path: join(SANDBOX, "n6d.txt"), content: "x" })] },
        { content: "好。" },
      ]),
    });
    const stats = await agent.send("写");
    expect(stats.hadError).toBe(false);
    expect(existsSync(join(SANDBOX, "n6d.txt"))).toBe(true); // 审批通过后照常执行
  });

  test("N6e onFailure=block 对 Notification 无效（不阻断、不把本轮标错）", async () => {
    const p = script("n6e.sh", "#!/bin/sh\nexit 4\n");
    const cfg = hooksCfg({
      enabled: true,
      Notification: [{ command: p, onFailure: "block" }],
    });
    const io = spyIO();
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      nonInteractive: true,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false);
    expect(io.warns.join("\n")).toContain("Notification hook");
  });
});

/* ------------------------------------------------------------------ */
/* N7 未配置：零行为变化                                               */
/* ------------------------------------------------------------------ */

describe("N7 未配置时零行为变化", () => {
  test("N7a 没有 hooks 配置：审批照常、无诊断、无额外输出", async () => {
    const io = spyIO(false);
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "ask",
      systemPrompt: "sys",
      chatStream: fakeStream([
        { toolCalls: [tc("write_file", { path: join(SANDBOX, "n7a.txt"), content: "x" })] },
        { content: "好。" },
      ]),
    });
    await agent.send("写");
    expect(io.confirms.length).toBe(1);
    expect(io.warns).toEqual([]);
  });

  test("N7b enabled:false 时 Notification 条目一条都不跑", async () => {
    const log = join(SANDBOX, "n7b.log");
    const p = script("n7b.sh", `#!/bin/sh\ncat >> ${log}\n`);
    const parsed = parseHooksConfig({ enabled: false, Notification: [{ command: p }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "ask",
      systemPrompt: "sys",
      hooks: parsed,
      nonInteractive: true,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    await agent.send("hi");
    expect(readLog(log).length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* N8 执行器与 /hooks 展示                                             */
/* ------------------------------------------------------------------ */

describe("N8 执行器与 /hooks 展示", () => {
  test("N8a runHook 载荷与 NEO_HOOK_EVENT / NEO_HOOK_REASON 环境变量", async () => {
    const log = join(SANDBOX, "n8a.log");
    const p = script(
      "n8a.sh",
      `#!/bin/sh\nprintf '%s|%s\\n' "$NEO_HOOK_EVENT" "$NEO_HOOK_REASON" >> ${log}\ncat >> ${log}\n`,
    );
    const payload = {
      event: "Notification",
      session_id: "s8",
      cwd: SANDBOX,
      mode: "ask",
      subagent: false,
      turn: 1,
      reason: "permission_prompt",
    } as unknown as HookPayload;
    const outcome = await runHook(hookDef({ command: p }), payload, makeCfg());
    expect(outcome.kind).toBe("ok");
    const text = readFileSync(log, "utf8");
    expect(text).toContain("Notification|permission_prompt");
    expect(text).toContain('"reason":"permission_prompt"');
  });

  test("N8b /hooks 对 Notification 的 matcher 一栏显示「原因」而不是工具名", async () => {
    const { dispatchCommand, wireCommands } = await import("../src/cli/commands.ts");
    wireCommands();
    const { captureConsole } = await import("./helpers.ts");
    const cap = captureConsole();
    const cfg = makeCfg({
      hooks: parseHooksConfig({
        enabled: true,
        Notification: [{ command: "notify.sh", matcher: "permission_prompt" }],
      }),
    });
    await dispatchCommand("/hooks", {
      agent: new Agent({ cfg, console: cap.ui, mode: "ask", systemPrompt: "sys" }),
      ui: cap.ui,
      cfg,
      memory: {} as never,
      classifier: {} as never,
      meta: {} as never,
      shutdown: () => {},
      selectDeps: {} as never,
      mailbox: null,
      checkpoints: null,
    });
    const out = cap.out();
    expect(out).toContain("Notification");
    expect(out).toContain("notify.sh");
    expect(out).toContain("reason=permission_prompt");
    expect(out).not.toContain("matcher=permission_prompt");
  });
});
