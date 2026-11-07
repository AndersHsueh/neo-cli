/**
 * hooks.test.ts — 生命周期 hooks（issue #3）。
 *
 * 覆盖验收要求：
 *  a. 配置解析：合法条目、写错只丢该条 + 可读 warning、事件名拼错提示。
 *  b. matcher：精确名 / `mcp__*` 通配 / 正则 / 缺省全匹配。
 *  c. PreToolUse 阻断并把 reason 回给模型（退出码 2，stdout 与 JSON 两种原因来源）。
 *  d. PreToolUse 不能绕过审批：ask 模式下用户拒绝 → hook 根本不被调用；
 *     plan 模式下工具被拒 → hook 不被调用（顺序：权限在前，hook 在后）。
 *  e. PostToolUse 成功/失败都触发；onFailure=continue 不阻断但给诊断，block 则阻断。
 *  f. TurnEnd 在主代理回合结束触发；子代理回合不触发。
 *  g. 超时被杀且无孤儿进程；命令不存在 → 可读错误，不拖垮主循环。
 *  h. plan / /review 下 hook 一律不执行（只读承诺优先）。
 *  i. 子代理的工具调用同样触发 Pre/PostToolUse。
 *  j. /hooks 命令列出已加载条目与告警。
 *
 * 运行：bun test tests/hooks.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import { decidePermission } from "../src/agent/policy.ts";
import {
  dispatchHooks,
  hasAnyHook,
  matchTool,
  parseHooksConfig,
  runHook,
  type HookDef,
  type HookPayload,
  type HooksConfig,
} from "../src/hooks/index.ts";
import { dispatch, registerTool } from "../src/tools/index.ts";
import { makeMcpTool } from "../src/mcp/tool.ts";
import { makeTaskTool, runSubagent } from "../src/tools/task.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import type { Config } from "../src/config.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";

/* ------------------------------------------------------------------ */
/* 沙箱与脚手架                                                        */
/* ------------------------------------------------------------------ */

// 沙箱必须放在项目目录内：/tmp 在部分环境里会被 insideGlobalSkills 的
// 祖先上溯误判成「全局技能库」，导致 write_file 在审批前就被拒绝。
const SANDBOX = join(import.meta.dir, `.tmp-hooks-${Date.now()}`);
mkdirSync(SANDBOX, { recursive: true });
writeFileSync(join(SANDBOX, "a.txt"), "hello", "utf8");
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

function makeCfg(over: Partial<Config> = {}): Config {
  // providers 必须带齐四个档位的 models：runSubagent 会 applyTier 到子档位，
  // 缺档会以「未知档位」报错（子代理用例踩过这个坑）。
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

/** 脚本化假 chatStream：按顺序返回预设结果。 */
function fakeStream(steps: Array<Partial<StreamResult>>) {
  let i = 0;
  const fn = (): Promise<StreamResult> => {
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
  return fn;
}

/** 写一个可执行的 hook 脚本，返回其路径。 */
function script(name: string, body: string): string {
  const p = join(SANDBOX, name);
  writeFileSync(p, body, { encoding: "utf8", mode: 0o755 });
  return p;
}

/** 构造单事件的 hooks 配置（enabled）。 */
function hooksCfg(raw: unknown): HooksConfig {
  const parsed = parseHooksConfig(raw);
  return { ...parsed, enabled: true };
}

const PAYLOAD: HookPayload = {
  event: "PreToolUse",
  session_id: "s1",
  cwd: SANDBOX,
  mode: "ask",
  subagent: false,
  turn: 1,
  tool_name: "shell",
  tool_input: { command: "ls" },
} as HookPayload;

function hookDef(over: Partial<HookDef> = {}): HookDef {
  return {
    event: "PreToolUse",
    command: "true",
    timeout: 10,
    onFailure: "continue",
    origin: "test",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* a. 配置解析                                                         */
/* ------------------------------------------------------------------ */

describe("a 配置解析", () => {
  test("三个事件都能解析，缺省值正确（timeout 30s / onFailure continue）", () => {
    const c = parseHooksConfig({
      enabled: true,
      PreToolUse: [{ command: "check.sh", matcher: "shell" }],
      PostToolUse: [{ command: "fmt.sh", matcher: "write_file|edit_file" }],
      TurnEnd: [{ command: "notify.sh" }],
    });
    expect(c.enabled).toBe(true);
    expect(c.hooks.PreToolUse.length).toBe(1);
    expect(c.hooks.PostToolUse.length).toBe(1);
    expect(c.hooks.TurnEnd.length).toBe(1);
    expect(c.hooks.PreToolUse[0]!.timeout).toBe(30);
    expect(c.hooks.PreToolUse[0]!.onFailure).toBe("continue");
    expect(c.hooks.PreToolUse[0]!.origin).toBe("settings.hooks.PreToolUse[0]");
    expect(hasAnyHook(c)).toBe(true);
  });

  test("写错的条目只丢该条并给可读 warning，其余照常加载", () => {
    const c = parseHooksConfig({
      enabled: true,
      PreToolUse: [
        { command: "" }, // 缺 command
        "not-an-object", // 不是对象
        { command: "ok.sh", timeout: -5 }, // timeout 非法 → 用默认
        { command: "re.sh", matcher: "/[unclosed/" }, // 正则非法 → 丢弃
      ],
      PostToolUse: [{ command: "p.sh", onFailure: "explode" }], // 非法 onFailure → continue
    });
    expect(c.hooks.PreToolUse.map((h) => h.command)).toEqual(["ok.sh"]);
    expect(c.hooks.PreToolUse[0]!.timeout).toBe(30);
    expect(c.hooks.PostToolUse[0]!.onFailure).toBe("continue");
    const text = c.warnings.join("\n");
    expect(text).toContain("缺少 command");
    expect(text).toContain("不是对象");
    expect(text).toContain("timeout 不是正数");
    expect(text).toContain("正则非法");
    expect(text).toContain("onFailure");
  });

  test("enabled 但没有任何有效条目 → 明确提示（多半是事件名拼错）", () => {
    const c = parseHooksConfig({ enabled: true, PreTooluse: [{ command: "x.sh" }] });
    expect(hasAnyHook(c)).toBe(false);
    expect(c.warnings.join("\n")).toContain("没有任何有效条目");
  });

  test("hooks 段不是对象 / 未配置 → 不报错，enabled=false", () => {
    expect(parseHooksConfig(undefined).enabled).toBe(false);
    expect(parseHooksConfig(undefined).warnings).toEqual([]);
    const bad = parseHooksConfig([1, 2, 3]);
    expect(bad.enabled).toBe(false);
    expect(bad.warnings.join("")).toContain("必须是对象");
  });

  test("timeout 超上限被截断", () => {
    const c = parseHooksConfig({ enabled: true, TurnEnd: [{ command: "x.sh", timeout: 99999 }] });
    expect(c.hooks.TurnEnd[0]!.timeout).toBe(600);
    expect(c.warnings.join("")).toContain("超过上限");
  });
});

/* ------------------------------------------------------------------ */
/* b. matcher                                                          */
/* ------------------------------------------------------------------ */

describe("b matcher", () => {
  test("精确 / 通配 / 正则 / 缺省", () => {
    expect(matchTool("shell", "shell")).toBe(true);
    expect(matchTool("shell", "write_file")).toBe(false);
    expect(matchTool("mcp__*", "mcp__fs__read")).toBe(true);
    expect(matchTool("mcp__*", "shell")).toBe(false);
    expect(matchTool("mcp__fs__*", "mcp__fs__read")).toBe(true);
    expect(matchTool("mcp__fs__*", "mcp__db__read")).toBe(false);
    expect(matchTool("/^mcp__/", "mcp__x__y")).toBe(true);
    expect(matchTool(undefined, "anything")).toBe(true);
    expect(matchTool("", "anything")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* c. PreToolUse 阻断                                                  */
/* ------------------------------------------------------------------ */

describe("c PreToolUse 阻断", () => {
  test("退出码 2 + stdout 作为原因", async () => {
    const p = script("block.sh", '#!/bin/sh\necho "危险命令：rm -rf 被拦截"\nexit 2\n');
    const r = await runHook(hookDef({ command: p }), PAYLOAD, makeCfg());
    expect(r.kind).toBe("block");
    expect(r.code).toBe(2);
    expect(r.reason).toContain("rm -rf");
  });

  test("退出码 2 + JSON reason 优先于纯文本", async () => {
    const p = script("blockjson.sh", '#!/bin/sh\necho \'{"reason":"JSON 原因"}\'\nexit 2\n');
    const r = await runHook(hookDef({ command: p }), PAYLOAD, makeCfg());
    expect(r.kind).toBe("block");
    expect(r.reason).toBe("JSON 原因");
  });

  test("退出码 0 = 放行", async () => {
    const p = script("ok.sh", "#!/bin/sh\nexit 0\n");
    const r = await runHook(hookDef({ command: p }), PAYLOAD, makeCfg());
    expect(r.kind).toBe("ok");
  });

  test("hook 能从 stdin 读到事件 JSON", async () => {
    const out = join(SANDBOX, "payload.json");
    const p = script("dump.sh", `#!/bin/sh\ncat > ${out}\n`);
    await runHook(hookDef({ command: p }), PAYLOAD, makeCfg());
    const got = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(got["event"]).toBe("PreToolUse");
    expect(got["tool_name"]).toBe("shell");
    expect(got["session_id"]).toBe("s1");
    expect(got["cwd"]).toBe(SANDBOX);
  });

  test("dispatchHooks 遇阻断立刻停，后续 hook 不再执行", async () => {
    const marker = join(SANDBOX, "after-block.txt");
    const block = script("b1.sh", "#!/bin/sh\nexit 2\n");
    const after = script("b2.sh", `#!/bin/sh\ntouch ${marker}\n`);
    const cfg = hooksCfg({
      enabled: true,
      PreToolUse: [{ command: block }, { command: after }],
    });
    const r = await dispatchHooks(cfg, "PreToolUse", PAYLOAD, "shell", makeCfg());
    expect(r.blocked).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* d. 不能绕过审批 / plan                                              */
/* ------------------------------------------------------------------ */

describe("d hook 不能放宽权限", () => {
  test("ask 模式用户拒绝写操作 → hook 不被调用（顺序：审批在前）", async () => {
    const marker = join(SANDBOX, "pre-called.txt");
    const p = script("mark.sh", `#!/bin/sh\ntouch ${marker}\n`);
    const cfg = hooksCfg({ enabled: true, PreToolUse: [{ command: p }] });
    const io = spyIO(false); // 用户拒绝
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "ask",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("write_file", { path: join(SANDBOX, "denied.txt"), content: "x" })] },
        { content: "好的，我停下了。" },
      ]),
    });
    await agent.send("写个文件");
    expect(io.confirms.length).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(SANDBOX, "denied.txt"))).toBe(false);
  });

  test("plan 模式：工具被拒 → hook 不执行，且 hook 无法放行", async () => {
    const marker = join(SANDBOX, "plan-pre.txt");
    const p = script("planmark.sh", `#!/bin/sh\ntouch ${marker}\n`);
    const cfg = hooksCfg({ enabled: true, PreToolUse: [{ command: p }] });
    const io = spyIO(true); // 即便用户会批准，plan 也不该走到审批
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "plan",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("write_file", { path: join(SANDBOX, "plan.txt"), content: "x" })] },
        { content: "plan 下不能写。" },
      ]),
    });
    await agent.send("写个文件");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(SANDBOX, "plan.txt"))).toBe(false);
    // 权限判定本身没被 hook 影响
    expect(decidePermission("plan", "write_file")).toEqual({ allow: false, reason: "plan" });
  });

  test("hook 放行（退出码 0）不能让敏感工具跳过审批", async () => {
    const p = script("allow.sh", "#!/bin/sh\nexit 0\n");
    const cfg = hooksCfg({ enabled: true, PreToolUse: [{ command: p }] });
    const io = spyIO(false); // 用户拒绝
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "ask",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("write_file", { path: join(SANDBOX, "notwritten.txt"), content: "x" })] },
        { content: "停下。" },
      ]),
    });
    await agent.send("写");
    expect(io.confirms.length).toBe(1); // 审批照常发生
    expect(existsSync(join(SANDBOX, "notwritten.txt"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* e. PostToolUse                                                      */
/* ------------------------------------------------------------------ */

describe("e PostToolUse", () => {
  test("成功与失败都触发，载荷带 ok / result", async () => {
    const log = join(SANDBOX, "post.log");
    const p = script("post.sh", `#!/bin/sh\ncat >> ${log}\necho >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, PostToolUse: [{ command: p }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        {
          toolCalls: [
            tc("read_file", { path: join(SANDBOX, "a.txt") }),
            tc("read_file", { path: join(SANDBOX, "nope.txt") }),
          ],
        },
        { content: "读完了。" },
      ]),
    });
    await agent.send("读文件");
    // 两个 read_file 落在同一并行段（issue #11），PostToolUse 的落盘顺序 = 完成顺序，
    // 不是 tool_calls 原序 —— 所以按 path 索引断言，不按行序。
    // 每条记录之间有空行（hook 用 echo 补换行），过滤空行再解析。
    const lines = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l["event"] === "PostToolUse")).toBe(true);
    const byPath = new Map(lines.map((l) => [(l["tool_input"] as Record<string, unknown>)["path"], l]));
    expect(byPath.get(join(SANDBOX, "a.txt"))?.["ok"]).toBe(true);
    expect(String(byPath.get(join(SANDBOX, "a.txt"))?.["result"])).toContain("hello");
    expect(byPath.get(join(SANDBOX, "nope.txt"))?.["ok"]).toBe(false);
  });

  test("onFailure=continue：失败只给诊断，不阻断（工具结果照常回填）", async () => {
    const p = script("fail.sh", "#!/bin/sh\necho 'hook 自己坏了' >&2\nexit 3\n");
    const cfg = hooksCfg({ enabled: true, PostToolUse: [{ command: p, onFailure: "continue" }] });
    const io = spyIO();
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("read_file", { path: join(SANDBOX, "a.txt") })] },
        { content: "读完了。" },
      ]),
    });
    const stats = await agent.send("读");
    expect(stats.hadError).toBe(false);
    // 工具结果没被吞掉
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("hello");
    // 但诊断必须可见（不静默）
    expect(io.warns.join("\n")).toContain("hook 自己坏了");
  });

  test("onFailure=block：失败升级为阻断，原因回给模型", async () => {
    const p = script("failblock.sh", "#!/bin/sh\necho '格式检查器崩了' >&2\nexit 3\n");
    const cfg = hooksCfg({ enabled: true, PostToolUse: [{ command: p, onFailure: "block" }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("read_file", { path: join(SANDBOX, "a.txt") })] },
        { content: "读完了。" },
      ]),
    });
    await agent.send("读");
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("格式检查器崩了");
  });
});

/* ------------------------------------------------------------------ */
/* e2. 没执行的调用不触发 PostToolUse（denied-post-fix）               */
/* ------------------------------------------------------------------ */

/**
 * 缺口背景（独立复现脚本 issue3-acceptance-repro.ts 抓到的）：
 * gateTool 把「用户拒绝 / Pre 阻断」当普通字符串返回，dispatch 随后无条件
 * applyPostHook —— 于是从未执行的调用也触发了 PostToolUse，载荷还谎称 ok:true。
 *
 * 语义（本组用例逐条钉住）：
 *  1. 用户拒绝 → Pre 与 Post 都不跑；
 *  2. 审批通过 + Pre 阻断 → Pre 跑（正确）、Post 不跑、副作用不发生、原因回给模型；
 *  3. 正常执行（成功 / 工具自身失败）→ Post 照旧跑，ok 如实反映。
 */
describe("e2 没执行的调用不触发 PostToolUse", () => {
  /** 记录 Pre/Post 调用的裸 ctx（不经过 Agent，直接打 dispatch 这条真实路径）。 */
  function spyCtx(approve: boolean, preBlock: string | null = null) {
    const calls: string[] = [];
    const ctx: ToolCtx = {
      cfg: makeCfg(),
      signal: new AbortController().signal,
      approve: async () => approve,
      preToolUse: async (tool) => {
        calls.push(`pre:${tool}`);
        return preBlock;
      },
      postToolUse: async (tool) => {
        calls.push(`post:${tool}`);
        return null;
      },
    };
    return { calls, ctx };
  }

  /** 注册一个假的 MCP 工具（真 makeMcpTool，审批与 hook 走同一条 gateTool）。 */
  function withFakeMcp(): { name: string; calls: string[]; unregister: () => void } {
    const calls: string[] = [];
    const name = "mcp__fake__echo";
    const unregister = registerTool(
      makeMcpTool({
        server: "fake",
        info: { name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } },
        call: async () => {
          calls.push("remote");
          return "echoed";
        },
      }),
    );
    return { name, calls, unregister };
  }

  test("write_file：用户拒绝 → Pre/Post 都不跑，文件不写，原因回给模型", async () => {
    const target = join(SANDBOX, "e2-denied-write.txt");
    const { calls, ctx } = spyCtx(false);
    const r = await dispatch("write_file", JSON.stringify({ path: target, content: "x" }), ctx);
    expect(calls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("用户拒绝");
    expect(existsSync(target)).toBe(false);
  });

  test("edit_file：用户拒绝 → Pre/Post 都不跑，文件原样", async () => {
    const target = join(SANDBOX, "e2-denied-edit.txt");
    writeFileSync(target, "keep", "utf8");
    const { calls, ctx } = spyCtx(false);
    const r = await dispatch("edit_file", JSON.stringify({ path: target, old_string: "keep", new_string: "gone" }), ctx);
    expect(calls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("用户拒绝");
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  test("shell：用户拒绝 → Pre/Post 都不跑，命令不执行", async () => {
    const marker = join(SANDBOX, "e2-denied-shell.txt");
    const { calls, ctx } = spyCtx(false);
    const r = await dispatch("shell", JSON.stringify({ command: `touch ${marker}` }), ctx);
    expect(calls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("用户拒绝");
    expect(existsSync(marker)).toBe(false);
  });

  test("MCP 工具：用户拒绝 → Pre/Post 都不跑，远端不被调用", async () => {
    const mcp = withFakeMcp();
    try {
      const { calls, ctx } = spyCtx(false);
      const r = await dispatch(mcp.name, JSON.stringify({ text: "x" }), ctx);
      expect(calls).toEqual([]);
      expect(mcp.calls).toEqual([]); // 远端一次都没被调
      expect(r.ok).toBe(false);
      expect(r.output).toContain("用户拒绝");
    } finally {
      mcp.unregister();
    }
  });

  test("write_file：审批通过 + Pre 阻断 → Pre 跑、Post 不跑、不写盘、原因回给模型", async () => {
    const target = join(SANDBOX, "e2-preblock-write.txt");
    const { calls, ctx } = spyCtx(true, "禁止写这个路径");
    const r = await dispatch("write_file", JSON.stringify({ path: target, content: "x" }), ctx);
    expect(calls).toEqual(["pre:write_file"]); // Pre 执行了（正确），Post 没有
    expect(r.ok).toBe(false);
    expect(r.output).toContain("禁止写这个路径");
    expect(existsSync(target)).toBe(false);
  });

  test("edit_file：审批通过 + Pre 阻断 → Pre 跑、Post 不跑、文件原样", async () => {
    const target = join(SANDBOX, "e2-preblock-edit.txt");
    writeFileSync(target, "keep", "utf8");
    const { calls, ctx } = spyCtx(true, "禁止改这个文件");
    const r = await dispatch("edit_file", JSON.stringify({ path: target, old_string: "keep", new_string: "gone" }), ctx);
    expect(calls).toEqual(["pre:edit_file"]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("禁止改这个文件");
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  test("shell：审批通过 + Pre 阻断 → Pre 跑、Post 不跑、命令不执行", async () => {
    const marker = join(SANDBOX, "e2-preblock-shell.txt");
    const { calls, ctx } = spyCtx(true, "危险命令");
    const r = await dispatch("shell", JSON.stringify({ command: `touch ${marker}` }), ctx);
    expect(calls).toEqual(["pre:shell"]);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("危险命令");
    expect(existsSync(marker)).toBe(false);
  });

  test("MCP 工具：审批通过 + Pre 阻断 → Pre 跑、Post 不跑、远端不被调用", async () => {
    const mcp = withFakeMcp();
    try {
      const { calls, ctx } = spyCtx(true, "外部调用被拦");
      const r = await dispatch(mcp.name, JSON.stringify({ text: "x" }), ctx);
      expect(calls).toEqual([`pre:${mcp.name}`]);
      expect(mcp.calls).toEqual([]);
      expect(r.ok).toBe(false);
      expect(r.output).toContain("外部调用被拦");
    } finally {
      mcp.unregister();
    }
  });

  test("正常执行：成功与工具自身失败都照旧触发 Post，ok 如实反映", async () => {
    // 成功
    const okCtx = spyCtx(true);
    const okr = await dispatch("write_file", JSON.stringify({ path: join(SANDBOX, "e2-ok.txt"), content: "x" }), okCtx.ctx);
    expect(okCtx.calls).toEqual(["pre:write_file", "post:write_file"]);
    expect(okr.ok).toBe(true);

    // 工具自身失败（old_string 找不到）：确实执行过 → Post 照旧跑。
    // 注意 Pre 不在此列：edit_file 的 gateTool 在校验之后，找不到 old_string
    // 时在审批前就抛错（既有顺序，本次不改），所以只断言 Post 触发。
    const failCtx = spyCtx(true);
    writeFileSync(join(SANDBOX, "e2-fail.txt"), "abc", "utf8");
    const failr = await dispatch(
      "edit_file",
      JSON.stringify({ path: join(SANDBOX, "e2-fail.txt"), old_string: "zzz", new_string: "y" }),
      failCtx.ctx,
    );
    expect(failCtx.calls).toEqual(["post:edit_file"]);
    expect(failr.ok).toBe(false);
    expect(failr.output).toContain("找不到");
  });

  test("Post 载荷的 ok 不会把「没执行」谎报成成功（经 Agent 端到端）", async () => {
    const log = join(SANDBOX, "e2-post-payload.log");
    const p = script("e2post.sh", `#!/bin/sh\ncat >> ${log}\necho >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, PostToolUse: [{ command: p }] });
    const io = spyIO(false); // 用户拒绝
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "ask",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("write_file", { path: join(SANDBOX, "e2-agent.txt"), content: "x" })] },
        { content: "停下。" },
      ]),
    });
    await agent.send("写");
    // 被拒绝 → PostToolUse 一次都不该跑（连日志文件都不该出现）
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(SANDBOX, "e2-agent.txt"))).toBe(false);
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("用户拒绝");
  });
});

/* ------------------------------------------------------------------ */
/* f. TurnEnd                                                          */
/* ------------------------------------------------------------------ */

describe("f TurnEnd", () => {
  test("主代理回合结束触发一次，载荷带 turn_stats", async () => {
    const log = join(SANDBOX, "turnend.log");
    const p = script("turnend.sh", `#!/bin/sh\ncat >> ${log}\necho >> ${log}\n`);
    const cfg = hooksCfg({ enabled: true, TurnEnd: [{ command: p }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    await agent.send("hi");
    const lines = readFileSync(log, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBe(1);
    expect(lines[0]!["event"]).toBe("TurnEnd");
    const stats = lines[0]!["turn_stats"] as Record<string, unknown>;
    expect(stats["finish_reason"]).toBe("stop");
    expect(stats["had_error"]).toBe(false);
  });

  test("-p 单次模式（nonInteractive）同样触发", async () => {
    const marker = join(SANDBOX, "oneshot.txt");
    const p = script("oneshot.sh", `#!/bin/sh\ntouch ${marker}\n`);
    const cfg = hooksCfg({ enabled: true, TurnEnd: [{ command: p }] });
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
    expect(existsSync(marker)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* g. 超时 / 命令不存在                                                */
/* ------------------------------------------------------------------ */

describe("g 失败隔离", () => {
  test("超时被杀，且不留孤儿子进程", async () => {
    const pidFile = join(SANDBOX, "child.pid");
    // 后台子进程写自己的 pid 后长睡；超时必须整组杀掉。
    const p = script(
      "slow.sh",
      `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nwait\n`,
    );
    const started = Date.now();
    const r = await runHook(hookDef({ command: p, timeout: 1 }), PAYLOAD, makeCfg());
    const elapsed = Date.now() - started;
    expect(r.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(10_000);

    // 等一小会儿让 SIGKILL 生效，然后确认子进程已死。
    await new Promise((res) => setTimeout(res, 300));
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isFinite(pid)).toBe(true);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 20_000);

  test("命令不存在 → 可读错误，不抛异常", async () => {
    const r = await runHook(hookDef({ command: "definitely-not-a-command-xyz 2>/dev/null" }), PAYLOAD, makeCfg());
    expect(["error", "block"]).toContain(r.kind);
    if (r.kind === "error") expect(r.reason.length).toBeGreaterThan(0);
  });

  test("PreToolUse 的 hook 崩溃不阻断工具（默认 continue 语义）", async () => {
    const p = script("crash.sh", "#!/bin/sh\nexit 7\n");
    const cfg = hooksCfg({ enabled: true, PreToolUse: [{ command: p }] });
    const io = spyIO();
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("read_file", { path: join(SANDBOX, "a.txt") })] },
        { content: "读完了。" },
      ]),
    });
    await agent.send("读");
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("hello");
    expect(io.warns.join("\n")).toContain("退出码 7");
  });
});

/* ------------------------------------------------------------------ */
/* h. plan 下不执行                                                    */
/* ------------------------------------------------------------------ */

describe("h plan 只读语义", () => {
  test("plan 模式下 PostToolUse / TurnEnd 都不执行", async () => {
    const marker = join(SANDBOX, "plan-hooks.txt");
    const p = script("planall.sh", `#!/bin/sh\ntouch ${marker}\n`);
    const cfg = hooksCfg({
      enabled: true,
      PostToolUse: [{ command: p }],
      TurnEnd: [{ command: p }],
    });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "plan",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("read_file", { path: join(SANDBOX, "a.txt") })] },
        { content: "只读审查完毕。" },
      ]),
    });
    await agent.send("看看");
    expect(existsSync(marker)).toBe(false);
  });

  test("/review 的临时只读（mode=plan）同样不执行 hook", async () => {
    const marker = join(SANDBOX, "review-hooks.txt");
    const p = script("reviewall.sh", `#!/bin/sh\ntouch ${marker}\n`);
    const cfg = hooksCfg({ enabled: true, TurnEnd: [{ command: p }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([{ content: "审查完毕。" }]),
    });
    // 复刻 /review 的做法：临时借用只读闸门
    const prev = agent.mode;
    agent.mode = "plan";
    try {
      await agent.send("审查");
    } finally {
      agent.mode = prev;
    }
    expect(existsSync(marker)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* i. 子代理语义                                                       */
/* ------------------------------------------------------------------ */

describe("i 子代理", () => {
  test("子代理的工具调用触发 Pre/PostToolUse，但 TurnEnd 不触发", async () => {
    const pre = join(SANDBOX, "sub-pre.log");
    const post = join(SANDBOX, "sub-post.log");
    const turn = join(SANDBOX, "sub-turn.log");
    const pPre = script("subpre.sh", `#!/bin/sh\ncat >> ${pre}\necho >> ${pre}\n`);
    const pPost = script("subpost.sh", `#!/bin/sh\ncat >> ${post}\necho >> ${post}\n`);
    const pTurn = script("subturn.sh", `#!/bin/sh\ncat >> ${turn}\necho >> ${turn}\n`);
    const cfg = hooksCfg({
      enabled: true,
      PreToolUse: [{ command: pPre }],
      PostToolUse: [{ command: pPost }],
      TurnEnd: [{ command: pTurn }],
    });

    const main = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([
        { content: "我来做。", toolCalls: [tc("task", { prompt: "读 a.txt" })] },
        { content: "子代理报告收到。" },
      ]),
    });
    const unregister = registerTool(
      makeTaskTool({ run: (prompt, tier, ctx) => runSubagent(main, prompt, tier, ctx) }),
    );
    try {
      // 子代理自己的假流：读文件 → 交报告
      const sub = new Agent({
        cfg: makeCfg(),
        console: spyIO(),
        mode: "auto-all",
        systemPrompt: "你是主代理派生的子代理",
        hooks: cfg,
        isSubagent: true,
        chatStream: fakeStream([
          { content: "我来做。", toolCalls: [tc("read_file", { path: join(SANDBOX, "a.txt") })] },
          { content: "报告：a.txt 内容是 hello" },
        ]),
      });
      const ctx: ToolCtx = {
        cfg: makeCfg(),
        approve: async () => true,
        host: main,
        preToolUse: async (tool, args) => {
          const r = await dispatchHooks(cfg, "PreToolUse", { ...PAYLOAD, tool_name: tool } as HookPayload, tool, makeCfg());
          return r.blocked ? r.reason : null;
        },
        postToolUse: async (tool) => {
          const r = await dispatchHooks(cfg, "PostToolUse", { ...PAYLOAD, event: "PostToolUse" } as HookPayload, tool, makeCfg());
          return r.blocked ? `[hook PostToolUse failed: ${r.reason}]` : null;
        },
      };
      const out = await runSubagent(sub, "读 a.txt", undefined, ctx);
      expect(out).toContain("hello");
    } finally {
      unregister();
    }

    // 子代理内部（经 ctx 注入）触发了 Pre/Post
    expect(existsSync(pre)).toBe(true);
    expect(existsSync(post)).toBe(true);
    // 子代理的 send() 不触发 TurnEnd（isSubagent=true）
    const subOnly = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      isSubagent: true,
      chatStream: fakeStream([{ content: "子代理答完。" }]),
    });
    await subOnly.send("hi");
    expect(existsSync(turn)).toBe(false);
  });

  test("子代理继承主代理的 hooks 配置（runSubagent 内部构造）", async () => {
    const marker = join(SANDBOX, "inherit.txt");
    const p = script("inherit.sh", `#!/bin/sh\ntouch ${marker}\n`);
    const cfg = hooksCfg({ enabled: true, TurnEnd: [{ command: p }] });
    const main = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([{ content: "子代理答完。" }]),
    });
    // runSubagent 会 new Agent({ hooks: main.hooksConfig, isSubagent: true })
    const ctx: ToolCtx = { cfg: makeCfg(), approve: async () => true, host: main };
    await runSubagent(main, "随便做点什么", undefined, ctx);
    // 子代理回合不触发 TurnEnd
    expect(existsSync(marker)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* j. /hooks 命令                                                      */
/* ------------------------------------------------------------------ */

describe("j /hooks 命令", () => {
  test("列出已加载条目与配置告警", async () => {
    const { dispatchCommand, wireCommands } = await import("../src/cli/commands.ts");
    wireCommands();
    const { captureConsole } = await import("./helpers.ts");
    const cap = captureConsole();
    const cfg = makeCfg({
      hooks: parseHooksConfig({
        enabled: true,
        PreToolUse: [{ command: "guard.sh", matcher: "shell" }],
        TurnEnd: [{ command: "notify.sh", onFailure: "block" }],
        PostToolUse: [{ command: "" }], // 写错 → warning
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
    expect(out).toContain("已启用");
    expect(out).toContain("guard.sh");
    expect(out).toContain("notify.sh");
    expect(out).toContain("onFailure=block");
    expect(out).toContain("配置告警");
  });
});

/* ------------------------------------------------------------------ */
/* k. TurnEnd 的 onFailure=block（编排方澄清 2026-11-07）               */
/* ------------------------------------------------------------------ */

describe("k TurnEnd onFailure=block", () => {
  test("block：失败原因并进 errorMessage 并标 hadError（-p 因此非 0 退出）", async () => {
    const p = script("turnfail.sh", "#!/bin/sh\necho '轮末检查失败' >&2\nexit 3\n");
    const cfg = hooksCfg({ enabled: true, TurnEnd: [{ command: p, onFailure: "block" }] });
    const io = spyIO();
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    const stats = await agent.send("hi");
    // 模型正文照常产出，但这一轮被标记为出错 —— index.ts 的退出码约定据此给 1。
    expect(stats.hadError).toBe(true);
    expect(String(stats.errorMessage)).toContain("[hook TurnEnd failed:");
    expect(String(stats.errorMessage)).toContain("轮末检查失败");
    // 同时给用户可读诊断（不静默）
    expect(io.warns.join("\n")).toContain("轮末检查失败");
  });

  test("continue（默认）：失败只给诊断，不改 hadError / 退出码", async () => {
    const p = script("turnfail2.sh", "#!/bin/sh\necho '轮末检查失败' >&2\nexit 3\n");
    const cfg = hooksCfg({ enabled: true, TurnEnd: [{ command: p }] });
    const io = spyIO();
    const agent = new Agent({
      cfg: makeCfg(),
      console: io,
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false);
    expect(stats.errorMessage).toBeNull();
    expect(io.warns.join("\n")).toContain("轮末检查失败");
  });

  test("退出码 2 在 TurnEnd 上同样视为明确要求阻断（与 onFailure 无关）", async () => {
    const p = script("turnblock2.sh", "#!/bin/sh\necho '不许结束' \nexit 2\n");
    const cfg = hooksCfg({ enabled: true, TurnEnd: [{ command: p, onFailure: "continue" }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([{ content: "答完了。" }]),
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(true);
    expect(String(stats.errorMessage)).toContain("不许结束");
  });

  test("plan 模式下 TurnEnd 不执行，因此也不会因 hook 失败而标错", async () => {
    const p = script("turnfail3.sh", "#!/bin/sh\nexit 3\n");
    const cfg = hooksCfg({ enabled: true, TurnEnd: [{ command: p, onFailure: "block" }] });
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(),
      mode: "plan",
      systemPrompt: "sys",
      hooks: cfg,
      chatStream: fakeStream([{ content: "只读回答。" }]),
    });
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* l. 连续失败计数对「没执行」保持中性（2026-11-07）                     */
/* ------------------------------------------------------------------ */

/**
 * 语义（Anders 已批准的最小范围）：
 *  - notExecuted（用户拒绝 / plan 拒绝 / Pre 阻断，含 MCP）经 settleToolOutcome
 *    时**中性**：既不累加 consecutiveFailures，也不清零；
 *  - 模型侧结果仍是 ok:false（含「错误: …」文案），且不跑 PostToolUse（e2 已覆盖）；
 *  - 真失败（工具跑过但失败）仍累加，成功仍清零；
 *  - capabilityStreak 保持改前口径（拒绝的 shell 照样算一次 capability）。
 *
 * 旧口径实测（/workspace/neo-supervision/issue3-final-acceptance-streak.log）：
 * 拒绝 2 次 write → streak=2；拒绝 3 次 shell → streak=3；Pre 阻断 2 次 → streak=2。
 * 下面每一条都对着那个实测值写断言。
 */
describe("l 连续失败计数对没执行保持中性", () => {
  /** 一个必然失败真工具调用：edit_file 找不到 old_string（工具跑过 → 真失败）。 */
  function realFail(target: string): ToolCall {
    return tc("edit_file", { path: target, old_string: "zzz-not-there", new_string: "y" });
  }

  /** 一个必然成功的真工具调用。 */
  function realOk(target: string): ToolCall {
    return tc("write_file", { path: target, content: "x" });
  }

  /** 跑一轮：脚本化流第一轮给 toolCalls，第二轮收尾。返回 agent 与 tool 消息。 */
  async function runTurn(
    toolCalls: ToolCall[],
    opts: { confirmAnswer?: boolean; mode?: string; hooks?: HooksConfig; agent?: Agent } = {},
  ): Promise<{ agent: Agent; tools: Message[] }> {
    const agent =
      opts.agent ??
      new Agent({
        cfg: makeCfg(),
        console: spyIO(opts.confirmAnswer ?? true),
        mode: (opts.mode ?? "ask") as never,
        systemPrompt: "sys",
        hooks: opts.hooks,
        chatStream: fakeStream([{ content: "我来做。", toolCalls }, { content: "收尾。" }]),
      });
    await agent.send("go");
    return { agent, tools: agent.messages.filter((m) => m.role === "tool") };
  }

  test("最小序列 1：失败 + 拒绝 + 失败 → streak = 2", async () => {
    const failFile = join(SANDBOX, "l-fail-1.txt");
    writeFileSync(failFile, "abc", "utf8");
    // 拒绝 write_file 需要 ask 模式 + confirm=false；真失败用 edit_file（审批前就抛错，
    // 不受 confirm 影响），所以这里用「confirm=false 的 io + 一次真失败 edit」组合。
    const { agent, tools } = await runTurn(
      [realFail(failFile), tc("write_file", { path: join(SANDBOX, "l-denied-1.txt"), content: "x" }), realFail(failFile)],
      { confirmAnswer: false },
    );
    // 三次都是 ok:false，但只有两次真失败计入
    expect(tools.length).toBe(3);
    for (const m of tools) expect(String(m.content)).toContain("错误");
    expect(agent.toolFailureStreak).toBe(2);
    expect(existsSync(join(SANDBOX, "l-denied-1.txt"))).toBe(false);
  });

  test("最小序列 2：成功 + 拒绝 → streak = 0（拒绝不清零也不累加）", async () => {
    const { agent } = await runTurn(
      [realOk(join(SANDBOX, "l-ok-2.txt")), tc("write_file", { path: join(SANDBOX, "l-denied-2.txt"), content: "x" })],
      { confirmAnswer: false },
    );
    expect(agent.toolFailureStreak).toBe(0);
  });

  test("最小序列 3：失败 + Pre 阻断 → streak = 1", async () => {
    const failFile = join(SANDBOX, "l-fail-3.txt");
    writeFileSync(failFile, "abc", "utf8");
    const cfg = hooksCfg({ enabled: true, PreToolUse: [{ command: script("l-pre3.sh", "#!/bin/sh\necho 拦截\nexit 2\n"), matcher: "shell" }] });
    const { agent, tools } = await runTurn(
      [realFail(failFile), tc("shell", { command: `touch ${join(SANDBOX, "l-pre3-marker.txt")}` })],
      { mode: "auto-all", hooks: cfg },
    );
    expect(tools.length).toBe(2);
    expect(String(tools[1]!.content)).toContain("拦截");
    expect(existsSync(join(SANDBOX, "l-pre3-marker.txt"))).toBe(false);
    expect(agent.toolFailureStreak).toBe(1);
  });

  test("三种 notExecuted 来源都中性：用户拒绝 / plan 拒绝 / Pre 阻断", async () => {
    // ① 用户拒绝（ask + confirm=false）：实测旧口径是 3 次拒绝 → streak=3
    const denied = await runTurn(
      [
        tc("shell", { command: "true" }),
        tc("shell", { command: "true" }),
        tc("shell", { command: "true" }),
      ],
      { confirmAnswer: false },
    );
    expect(denied.agent.toolFailureStreak).toBe(0);

    // ② plan 拒绝（mode=plan，decidePermission 直接拒，hook 都不跑）
    const planned = await runTurn(
      [tc("write_file", { path: join(SANDBOX, "l-plan.txt"), content: "x" }), tc("shell", { command: "true" })],
      { mode: "plan" },
    );
    expect(planned.agent.toolFailureStreak).toBe(0);
    expect(existsSync(join(SANDBOX, "l-plan.txt"))).toBe(false);

    // ③ Pre 阻断（auto-all + hook exit 2）：实测旧口径 2 次 → streak=2
    const cfg = hooksCfg({ enabled: true, PreToolUse: [{ command: script("l-pre4.sh", "#!/bin/sh\necho blocked\nexit 2\n"), matcher: "shell" }] });
    const blocked = await runTurn(
      [tc("shell", { command: "true" }), tc("shell", { command: "true" })],
      { mode: "auto-all", hooks: cfg },
    );
    expect(blocked.agent.toolFailureStreak).toBe(0);
  });

  test("MCP 工具被拒绝 / 被阻断同样中性，且远端一次都没被调", async () => {
    const remote: string[] = [];
    const name = "mcp__l__echo";
    const unregister = registerTool(
      makeMcpTool({
        server: "l",
        info: { name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } },
        call: async () => {
          remote.push("called");
          return "echoed";
        },
      }),
    );
    try {
      // 用户拒绝
      const denied = await runTurn([tc(name, { text: "x" }), tc(name, { text: "y" })], { confirmAnswer: false });
      expect(denied.agent.toolFailureStreak).toBe(0);
      expect(remote).toEqual([]);

      // Pre 阻断
      const cfg = hooksCfg({ enabled: true, PreToolUse: [{ command: script("l-mcp-pre.sh", "#!/bin/sh\necho 外部调用被拦\nexit 2\n"), matcher: "mcp__*" }] });
      const blocked = await runTurn([tc(name, { text: "x" })], { mode: "auto-all", hooks: cfg });
      expect(blocked.agent.toolFailureStreak).toBe(0);
      expect(remote).toEqual([]);
    } finally {
      unregister();
    }
  });

  test("真失败仍累加、成功仍清零（拒绝夹在中间不改变两者）", async () => {
    const failFile = join(SANDBOX, "l-fail-6.txt");
    writeFileSync(failFile, "abc", "utf8");

    // 真失败 ×2 → 2
    const two = await runTurn([realFail(failFile), realFail(failFile)], { confirmAnswer: true });
    expect(two.agent.toolFailureStreak).toBe(2);

    // 成功 → 清零
    const ok = await runTurn([realOk(join(SANDBOX, "l-ok-6.txt"))], { confirmAnswer: true });
    expect(ok.agent.toolFailureStreak).toBe(0);

    // 失败 + 成功 + 失败 → 1（成功确实清零）
    const mixed = await runTurn(
      [realFail(failFile), realOk(join(SANDBOX, "l-ok-6b.txt")), realFail(failFile)],
      { confirmAnswer: true },
    );
    expect(mixed.agent.toolFailureStreak).toBe(1);
  });

  test("shell 非零退出仍按现有 ok:true 处理（不扩大语义）", async () => {
    const { agent, tools } = await runTurn([tc("shell", { command: "exit 3" })], { mode: "auto-all" });
    // shell 工具自身把非零退出收敛成 ok:true（既有语义，本次不动）
    expect(String(tools[0]!.content)).toContain("[exit 3]");
    expect(agent.toolFailureStreak).toBe(0);
  });

  test("并行混合批次按原序结算，与串行一致", async () => {
    const failFile = join(SANDBOX, "l-fail-8.txt");
    writeFileSync(failFile, "abc", "utf8");
    const readA = tc("read_file", { path: join(SANDBOX, "a.txt") });
    const readB = tc("read_file", { path: join(SANDBOX, "a.txt") });

    // 并行段 [read, read] 夹在两次真失败之间：失败 → 成功(read) → 成功(read) → 失败 = 1。
    // read 是成功调用，按原序清零 —— 这正是「按原序结算」的证据：
    // 若并行段被当成一个整体、只在段后结算一次，结果会不同。
    const batch = [realFail(failFile), readA, readB, realFail(failFile)];
    const par = await runTurn(batch, { confirmAnswer: true });
    expect(par.agent.toolFailureStreak).toBe(1);

    // 同一批次关掉并行 → 结果必须逐条等价
    const parOff = await runTurn(batch, {
      confirmAnswer: true,
      agent: new Agent({
        cfg: makeCfg({ parallelToolCalls: "off" }),
        console: spyIO(true),
        mode: "ask",
        systemPrompt: "sys",
        chatStream: fakeStream([{ content: "我来做。", toolCalls: batch }, { content: "收尾。" }]),
      }),
    });
    expect(parOff.agent.toolFailureStreak).toBe(1);

    // 并行段里混入被拒绝的写（write_file 不可并行 → 它是屏障，单独串行执行）：
    // 序列 = 失败 → read 成功(清零) → write 被拒(中性) → read 成功(清零) = 0。
    // 关键是拒绝那一步既没把它抬到 1，也没把前面的清零改回去。
    const mixed = await runTurn(
      [realFail(failFile), readA, tc("write_file", { path: join(SANDBOX, "l-denied-8.txt"), content: "x" }), readB],
      { confirmAnswer: false },
    );
    expect(mixed.agent.toolFailureStreak).toBe(0);
    expect(existsSync(join(SANDBOX, "l-denied-8.txt"))).toBe(false);

    // 拒绝紧跟在真失败之后：失败 → 拒绝 = 1（拒绝不清零）
    const failThenDeny = await runTurn(
      [realFail(failFile), tc("write_file", { path: join(SANDBOX, "l-denied-8b.txt"), content: "x" })],
      { confirmAnswer: false },
    );
    expect(failThenDeny.agent.toolFailureStreak).toBe(1);

    // 纯并行段内部全是拒绝（read 不会拒绝，用 MCP 之外的敏感工具做不到并行），
    // 因此「并行段内出现 notExecuted」只在段内工具可并行时才可能发生 ——
    // 当前注册表里可并行的工具全是只读、不审批，故该路径由串行分支覆盖。
    // 这里补一条：并行段之后的真失败仍然累加（结算顺序未被并行打乱）。
    const after = await runTurn([readA, readB, realFail(failFile)], { confirmAnswer: true });
    expect(after.agent.toolFailureStreak).toBe(1);
  });

  test("capabilityStreak 保持改前口径：拒绝的 shell 照样算一次 capability", async () => {
    // 通过预算提示观察 capabilityStreak（只在设了目标时显示）。
    // 目标由宿主写入，这里直接读 agent 内部计数更稳：用两轮请求的 system 提示比对。
    const seen: string[] = [];
    const agent = new Agent({
      cfg: makeCfg(),
      console: spyIO(false), // 全部拒绝
      mode: "ask",
      systemPrompt: "sys",
      readGoal: () => "把 a.txt 的内容读出来",
      chatStream: (async (_cfg: Config, messages: Message[]) => {
        const sys = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
        seen.push(sys);
        if (seen.length === 1) {
          return {
            content: "",
            reasoning: "",
            toolCalls: [tc("shell", { command: "true" }), tc("shell", { command: "true" })],
            finishReason: "tool_calls",
            usage: null,
            raw: null,
          } as StreamResult;
        }
        return {
          content: "收尾。",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
          raw: null,
        } as StreamResult;
      }) as never,
    });
    await agent.send("go");
    // 第二次请求前的预算提示里应报「已连续 2 次只扩展手段」——
    // 与改前一致：被拒绝的 shell 仍然算 capability（中性化只针对连续失败计数）。
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[1]).toContain("已连续 2 次只扩展手段");
    // 而连续失败计数保持中性
    expect(agent.toolFailureStreak).toBe(0);
  });

  test("子代理 streak 独立：子代理里的拒绝不污染主代理", async () => {
    const main = new Agent({
      cfg: makeCfg(),
      console: spyIO(false), // 子代理的审批委托到主 console → 也拒绝
      mode: "ask",
      systemPrompt: "sys",
      chatStream: fakeStream([
        { content: "派活。", toolCalls: [tc("task", { prompt: "写个文件" })] },
        { content: "主代理收尾。" },
      ]),
    });
    const unregister = registerTool(
      makeTaskTool({ run: (prompt, tier, ctx) => runSubagent(main, prompt, tier, ctx) }),
    );
    try {
      // 子代理自己的假流：两次被拒绝的 write_file
      const sub = new Agent({
        cfg: makeCfg(),
        console: spyIO(false),
        mode: "ask",
        systemPrompt: "你是子代理",
        isSubagent: true,
        chatStream: fakeStream([
          {
            content: "我来写。",
            toolCalls: [
              tc("write_file", { path: join(SANDBOX, "l-sub-1.txt"), content: "x" }),
              tc("write_file", { path: join(SANDBOX, "l-sub-2.txt"), content: "x" }),
            ],
          },
          { content: "报告：都被拒了。" },
        ]),
      });
      const ctx: ToolCtx = { cfg: makeCfg(), approve: async () => false, host: main };
      const out = await runSubagent(sub, "写个文件", undefined, ctx);
      expect(out).toContain("报告");
      // 子代理自己的计数中性
      expect(sub.toolFailureStreak).toBe(0);
      // 子代理的拒绝不会冒到主代理（主代理这次只调了 task，task 成功）
      expect(main.toolFailureStreak).toBe(0);
      expect(existsSync(join(SANDBOX, "l-sub-1.txt"))).toBe(false);
    } finally {
      unregister();
    }
  });
});
