/**
 * issue #36：自定义命名子代理。
 *
 * 全部路径基于 mkdtemp 沙箱 + 注入 agentsStore + 隔离 HOME，
 * 绝不读写真实 ~/.neo/agents、~/.claude/agents 或 ~/.neo/settings.json。
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  advertisedAgents,
  buildAgentIndex,
  discoverAgents,
  findAgent,
  isValidAgentName,
  parseAgentMarkdown,
  resolveAgentModel,
  resolveAgentTools,
  resolveTaskAgent,
  type NamedAgent,
} from "../src/agents.ts";
import { Agent, type AgentIO } from "../src/agent.ts";
import { helpText } from "../src/cli/help.ts";
import { dispatchCommand, type CommandContext } from "../src/cli/commands.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { captureConsole } from "./helpers.ts";
import { parseHooksConfig, type HooksConfig } from "../src/hooks/index.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import {
  BackgroundTasks,
  restoreJobs,
  serializeJobs,
} from "../src/tools/background.ts";
import { makeTaskTool, runSubagent } from "../src/tools/task.ts";
import { TOOL_NAMES_EXCLUDED_FOR_SUBAGENT } from "../src/tools/index.ts";
import { ToolError, type ToolCtx } from "../src/tools/types.ts";
import type { Config, ModelTier } from "../src/config.ts";
import { contentText, type Message, type StreamResult } from "../src/llm.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "neo-36-agents-")));
const made: string[] = [ROOT];
const origHome = process.env["HOME"];
const origUserProfile = process.env["USERPROFILE"];

afterAll(() => {
  if (origHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHome;
  if (origUserProfile === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUserProfile;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function sandbox(tag: string): {
  root: string;
  cwd: string;
  store: string;
  home: string;
} {
  const root = realpathSync(mkdtempSync(join(ROOT, `${tag}-`)));
  const cwd = join(root, "proj");
  const store = join(root, "store");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(home, { recursive: true });
  made.push(root);
  return { root, cwd, store, home };
}

function isolateHome(home: string): void {
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
}

function provider(over: Partial<{ models: Record<ModelTier, string> }> = {}) {
  return {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: over.models ?? {
      default: "m-default",
      deep_reasoning: "m-deep",
      balanced: "m-bal",
      fast: "m-fast",
    },
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
}

function makeCfg(cwd: string, store: string, over: Partial<Config> = {}): Config {
  const p = provider();
  const route = { provider: "p1", model: null, fallbackAllowed: true };
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [p],
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
    cwd,
    settingsPath: null,
    skillsStore: join(cwd, "skills-store"),
    agentsStore: store,
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
    ...over,
  } as unknown as Config;
}

function writeAgent(dir: string, filename: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, body, "utf8");
  return path;
}

const EXPLORER = `---
name: explorer
description: 探索代码库并汇总发现
tools: read_file, grep, glob, list_dir
model: fast
---

你是只读探索者。只读不写。
ROLE_BODY_EXPLORER
`;

/* ------------------------------------------------------------------ */
/* 名字与 frontmatter                                                  */
/* ------------------------------------------------------------------ */

describe("#36 名字与 frontmatter", () => {
  test("合法名与文件名回退", () => {
    expect(isValidAgentName("explorer")).toBe(true);
    expect(isValidAgentName("a1-review")).toBe(true);
    expect(isValidAgentName("Explorer")).toBe(false);
    expect(isValidAgentName("-bad")).toBe(false);
    expect(isValidAgentName("has_underscore")).toBe(false);
    const parsed = parseAgentMarkdown(`---\ndescription: 从文件名取名\n---\n\n正文\n`);
    expect(parsed.fields["description"]).toBe("从文件名取名");
    expect(parsed.body.trim()).toBe("正文");
    expect(parsed.closed).toBe(true);
  });

  test("tools 支持逗号、方括号与 YAML 列表，以及 Claude 别名", () => {
    const a = parseAgentMarkdown(`---\ntools: read_file, Grep, glob\n---\n`);
    expect(a.tools).toEqual(["read_file", "Grep", "glob"]);
    const b = parseAgentMarkdown(`---\ntools: [Read, Write, Edit]\n---\n`);
    expect(b.tools).toEqual(["Read", "Write", "Edit"]);
    const c = parseAgentMarkdown(`---\ntools:\n  - Bash\n  - Agent\n  - no-such-tool\n---\n`);
    expect(c.tools).toEqual(["Bash", "Agent", "no-such-tool"]);
    const resolved = resolveAgentTools(["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Agent", "no-such-tool"]);
    expect(resolved.names).toEqual(["read_file", "write_file", "edit_file", "shell", "grep", "glob"]);
    expect(resolved.warnings.some((w) => w.includes("no-such-tool"))).toBe(true);
    expect(resolved.warnings.some((w) => w.includes("Agent") || w.includes("task"))).toBe(true);
    expect(resolved.names?.includes("task")).toBe(false);
  });

  test("缺 tools 表示默认集；排除表即使写了也不放行", () => {
    expect(resolveAgentTools(undefined).names).toBeUndefined();
    const r = resolveAgentTools(["read_file", "task", "compact_ctx", "ask_user"]);
    expect(r.names).toEqual(["read_file"]);
    expect(TOOL_NAMES_EXCLUDED_FOR_SUBAGENT.some((n) => r.names?.includes(n))).toBe(false);
  });

  test("未闭合 frontmatter 视为畸形", () => {
    const parsed = parseAgentMarkdown("---\nname: x\n还没结束\n");
    expect(parsed.closed).toBe(false);
    expect(parsed.hasFrontmatter).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 发现顺序与碰撞                                                      */
/* ------------------------------------------------------------------ */

describe("#36 发现顺序与碰撞", () => {
  test("项目 .neo 胜过项目 .claude 胜过用户 .neo 胜过用户 .claude", () => {
    const s = sandbox("order");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "dup.md", `---\nname: dup\ndescription: 项目neo\n---\nA\n`);
    writeAgent(join(s.cwd, ".claude", "agents"), "dup.md", `---\nname: dup\ndescription: 项目claude\n---\nB\n`);
    writeAgent(s.store, "dup.md", `---\nname: dup\ndescription: 用户neo\n---\nC\n`);
    writeAgent(join(s.home, ".claude", "agents"), "dup.md", `---\nname: dup\ndescription: 用户claude\n---\nD\n`);
    const { agents, warnings } = discoverAgents(makeCfg(s.cwd, s.store));
    expect(agents).toHaveLength(1);
    expect(agents[0]?.description).toBe("项目neo");
    expect(agents[0]?.source).toBe("project-neo");
    expect(warnings.filter((w) => w.includes("覆盖") || w.includes("跳过")).length).toBeGreaterThanOrEqual(3);
  });

  test("各层不同名都会被发现，且不读真实 home 库", () => {
    const s = sandbox("layers");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "proj.md", `---\nname: proj\ndescription: 项目\n---\n`);
    writeAgent(join(s.cwd, ".claude", "agents"), "interop.md", `---\nname: interop\ndescription: 互操作\n---\n`);
    writeAgent(s.store, "user.md", `---\nname: user\ndescription: 用户库\n---\n`);
    writeAgent(join(s.home, ".claude", "agents"), "claude.md", `---\nname: claude\ndescription: 用户claude\n---\n`);
    const names = discoverAgents(makeCfg(s.cwd, s.store)).agents.map((a) => a.name).sort();
    expect(names).toEqual(["claude", "interop", "proj", "user"]);
  });

  test("非法名、无 description、畸形文件：告警并正确跳过或不通告", () => {
    const s = sandbox("skip");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "BadName.md", `---\ndescription: 非法\n---\n`);
    writeAgent(join(s.cwd, ".neo", "agents"), "ok.md", `---\nname: ok\ndescription: 可用\n---\n正文\n`);
    writeAgent(join(s.cwd, ".neo", "agents"), "quiet.md", `---\nname: quiet\n---\n有名无简介\n`);
    writeAgent(join(s.cwd, ".neo", "agents"), "broken.md", `---\nname: broken\ndescription: x\n`);
    const { agents, warnings } = discoverAgents(makeCfg(s.cwd, s.store));
    expect(agents.map((a) => a.name).sort()).toEqual(["ok", "quiet"]);
    expect(advertisedAgents(agents).map((a) => a.name)).toEqual(["ok"]);
    expect(warnings.some((w) => w.includes("非法"))).toBe(true);
    expect(warnings.some((w) => w.includes("description"))).toBe(true);
    expect(warnings.some((w) => w.includes("未闭合"))).toBe(true);
  });

  test("safe-mode 不加载任何自定义子代理", () => {
    const s = sandbox("safe");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const d = discoverAgents(makeCfg(s.cwd, s.store, { safeMode: true }));
    expect(d.agents).toEqual([]);
    expect(d.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 模型解析与父配置不被改写                                            */
/* ------------------------------------------------------------------ */

describe("#36 model/tier", () => {
  test("档位名、当前 provider 模型 id、未知值", () => {
    const cfg = makeCfg("/tmp", "/tmp/store");
    expect(resolveAgentModel("fast", cfg)).toEqual({ kind: "tier", tier: "fast" });
    expect(resolveAgentModel("deep", cfg)).toEqual({ kind: "tier", tier: "deep_reasoning" });
    expect(resolveAgentModel("inherit", cfg)).toEqual({ kind: "inherit" });
    expect(resolveAgentModel("m-fast", cfg)).toEqual({ kind: "model", model: "m-fast" });
    expect(resolveAgentModel("totally-unknown", cfg)).toEqual({
      kind: "unknown",
      raw: "totally-unknown",
    });
  });
});

/* ------------------------------------------------------------------ */
/* 系统提示索引与 task.agent                                           */
/* ------------------------------------------------------------------ */

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

function fakeStream(steps: Array<(cfg: Config, messages: Message[]) => Partial<StreamResult>>) {
  const calls: Array<{ model: string; tier: ModelTier; system: string }> = [];
  let i = 0;
  const fn = (cfg: Config, messages: Message[]): Promise<StreamResult> => {
    const sys = contentText(messages[0]?.content ?? "") ?? "";
    calls.push({ model: cfg.model, tier: cfg.modelTier, system: sys });
    const step = steps[i];
    if (!step) throw new Error(`fake chatStream 脚本耗尽（第 ${i + 1} 次）`);
    i++;
    return Promise.resolve({
      content: "",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
      ...step(cfg, messages),
    } as StreamResult);
  };
  return { calls, fn };
}

function makeParent(cfg: Config, stream: ReturnType<typeof fakeStream>["fn"], hooks?: HooksConfig): Agent {
  return new Agent({
    cfg,
    console: spyIO(),
    mode: "auto-all",
    systemPrompt: "sys",
    sessionId: "parent-36",
    hooks,
    chatStream: stream,
  });
}

describe("#36 索引与 task.agent", () => {
  test("system prompt 含短索引，不含角色正文；无 description 的不自动披露", () => {
    const s = sandbox("index");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    writeAgent(
      join(s.cwd, ".neo", "agents"),
      "quiet.md",
      `---\nname: quiet\n---\nSECRET_QUIET_BODY\n`,
    );
    const cfg = makeCfg(s.cwd, s.store);
    const prompt = buildSystemPrompt(cfg);
    expect(prompt).toContain("## 自定义子代理");
    expect(prompt).toContain("explorer");
    expect(prompt).toContain("探索代码库并汇总发现");
    expect(prompt).not.toContain("ROLE_BODY_EXPLORER");
    expect(prompt).not.toContain("SECRET_QUIET_BODY");
    expect(prompt).not.toContain("quiet");
    expect(buildAgentIndex(discoverAgents(cfg).agents)).toContain("explorer");
  });

  test("task.agent 跑命名子代理：角色正文接在安全核心之后，且不能剥掉核心", async () => {
    const s = sandbox("run");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const cfg = makeCfg(s.cwd, s.store);
    const parentModel = cfg.model;
    const fake = fakeStream([
      (_c, msgs) => {
        const sys = contentText(msgs[0]?.content ?? "") ?? "";
        expect(sys).toContain("派出的子代理");
        const coreAt = sys.indexOf("派出的子代理");
        const roleAt = sys.indexOf("ROLE_BODY_EXPLORER");
        expect(coreAt).toBeGreaterThanOrEqual(0);
        expect(roleAt).toBeGreaterThan(coreAt);
        expect(sys.startsWith("ROLE_BODY_EXPLORER")).toBe(false);
        return { content: "探索完毕" };
      },
    ]);
    const main = makeParent(cfg, fake.fn);
    const tool = makeTaskTool({
      run: (prompt, tier, ctx, promptTier, agent) =>
        runSubagent(main, prompt, tier, ctx, promptTier, undefined, undefined, agent),
    });
    const out = await tool.execute({ prompt: "探索 a.txt", agent: "explorer" }, {
      cfg,
      approve: async () => true,
    } as ToolCtx);
    expect(out).toContain("探索完毕");
    expect(fake.calls[0]?.tier).toBe("fast");
    expect(fake.calls[0]?.model).toBe("m-fast");
    expect(main.config.model).toBe(parentModel);
    expect(main.config.modelTier).toBe("default");
  });

  test("未知 agent 名报错并列可用名，不发起运行", async () => {
    const s = sandbox("unknown");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const cfg = makeCfg(s.cwd, s.store);
    let ran = 0;
    const tool = makeTaskTool({
      run: async () => {
        ran++;
        return "should-not-run";
      },
    });
    await expect(
      tool.execute({ prompt: "hi", agent: "nope" }, { cfg, approve: async () => true } as ToolCtx),
    ).rejects.toThrow(/未知子代理 "nope"/);
    try {
      await tool.execute({ prompt: "hi", agent: "nope" }, { cfg, approve: async () => true } as ToolCtx);
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as Error).message).toContain("explorer");
    }
    expect(ran).toBe(0);
  });

  test("不传 agent 的通用 task 不附加角色正文，行为保持原样", async () => {
    const s = sandbox("generic");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const cfg = makeCfg(s.cwd, s.store);
    const fake = fakeStream([
      (_c, msgs) => {
        const sys = contentText(msgs[0]?.content ?? "") ?? "";
        expect(sys).toContain("派出的子代理");
        expect(sys).not.toContain("ROLE_BODY_EXPLORER");
        return { content: "通用报告" };
      },
    ]);
    const main = makeParent(cfg, fake.fn);
    const out = await runSubagent(main, "读一下", undefined, { cfg, approve: async () => true });
    expect(out).toContain("通用报告");
  });

  test("safe-mode 下 agent 参数报错，但不传 agent 的通用 task 仍可用", async () => {
    const s = sandbox("safe-run");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const cfg = makeCfg(s.cwd, s.store, { safeMode: true });
    const tool = makeTaskTool({ run: async () => "generic-ok" });
    await expect(
      tool.execute({ prompt: "hi", agent: "explorer" }, { cfg, approve: async () => true } as ToolCtx),
    ).rejects.toThrow(/未知子代理 "explorer"/);
    const fake = fakeStream([() => ({ content: "仍可通用" })]);
    const main = makeParent(cfg, fake.fn);
    const out = await runSubagent(main, "通用", undefined, { cfg, approve: async () => true });
    expect(out).toContain("仍可通用");
  });

  test("模型 id 只改子代理拷贝，父 cfg 不变", async () => {
    const s = sandbox("model-id");
    isolateHome(s.home);
    writeAgent(
      join(s.cwd, ".neo", "agents"),
      "special.md",
      `---\nname: special\ndescription: 指定模型\nmodel: m-bal\n---\nBODY\n`,
    );
    const cfg = makeCfg(s.cwd, s.store);
    const fake = fakeStream([
      (c) => {
        expect(c.model).toBe("m-bal");
        return { content: "ok" };
      },
    ]);
    const main = makeParent(cfg, fake.fn);
    const tool = makeTaskTool({
      run: (prompt, tier, ctx, promptTier, agent) =>
        runSubagent(main, prompt, tier, ctx, promptTier, undefined, undefined, agent),
    });
    await tool.execute({ prompt: "go", agent: "special" }, { cfg, approve: async () => true } as ToolCtx);
    expect(main.config.model).toBe("m-default");
    expect(main.config.modelTier).toBe("default");
  });

  test("tools 白名单收窄可见工具，且 task 不能被写入白名单", async () => {
    const s = sandbox("tools");
    isolateHome(s.home);
    writeAgent(
      join(s.cwd, ".neo", "agents"),
      "reader.md",
      `---\nname: reader\ndescription: 只读\ntools: read_file, task, grep\n---\n只读角色\n`,
    );
    const cfg = makeCfg(s.cwd, s.store);
    const agent = findAgent(cfg, "reader");
    expect(agent?.tools).toEqual(["read_file", "grep"]);
    expect(agent?.tools?.includes("task")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* hooks agent_name                                                    */
/* ------------------------------------------------------------------ */

let hookSerial = 0;
function recorder(dir: string, label: string): { command: string; read: () => Record<string, unknown>[] } {
  const id = `${label}-${++hookSerial}`;
  const log = join(dir, `${id}.jsonl`);
  const sh = join(dir, `${id}.sh`);
  writeFileSync(sh, `#!/bin/sh\ncat >> '${log}'\necho >> '${log}'\n`, { encoding: "utf8", mode: 0o755 });
  return {
    command: sh,
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

describe("#36 hook 载荷 agent_name", () => {
  test("命名子代理填入名字；通用 task 仍是空字符串；不省略字段", async () => {
    const s = sandbox("hooks");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const cfg = makeCfg(s.cwd, s.store);
    const rec = recorder(s.root, "agent-name");
    const hooks = { ...parseHooksConfig({
      enabled: true,
      SubagentStart: [{ command: rec.command }],
      SubagentStop: [{ command: rec.command }],
    }), enabled: true };
    const fake = fakeStream([() => ({ content: "命名完成" }), () => ({ content: "通用完成" })]);
    const main = makeParent(cfg, fake.fn, hooks);
    const ctx: ToolCtx = { cfg, approve: async () => true };
    await runSubagent(main, "命名任务", undefined, ctx, undefined, undefined, undefined, "explorer");
    await runSubagent(main, "通用任务", undefined, ctx);
    const events = rec.read();
    const starts = events.filter((e) => e["event"] === "SubagentStart");
    const stops = events.filter((e) => e["event"] === "SubagentStop");
    expect(starts).toHaveLength(2);
    expect(stops).toHaveLength(2);
    expect(starts[0]?.["agent_name"]).toBe("explorer");
    expect(stops[0]?.["agent_name"]).toBe("explorer");
    expect(starts[1]?.["agent_name"]).toBe("");
    expect(stops[1]?.["agent_name"]).toBe("");
    expect(Object.prototype.hasOwnProperty.call(starts[1], "agent_name")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 后台任务携带名字                                                    */
/* ------------------------------------------------------------------ */

describe("#36 后台任务与 /tasks 携带 agent 名", () => {
  test("launch / list / serialize / restore 都保留 agent 名", () => {
    const s = sandbox("bg");
    const tasks = new BackgroundTasks({
      run: async () => "done",
      max: 3,
      now: () => 1000,
    });
    const r = tasks.launch({
      prompt: "后台探索",
      ctx: { cfg: makeCfg(s.cwd, s.store), approve: async () => true },
      agent: "explorer",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const listed = tasks.list();
    expect(listed[0]?.agent).toBe("explorer");
    const snap = serializeJobs(tasks.rawJobs());
    expect(snap[0]?.agent).toBe("explorer");
    const restored = restoreJobs(snap);
    expect(restored[0]?.agent).toBe("explorer");
  });

  test("makeTaskTool background:true 把 agent 传给 launch，回执带名字", async () => {
    const s = sandbox("bg-tool");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const cfg = makeCfg(s.cwd, s.store);
    let launched: { agent?: string; prompt: string } | undefined;
    const tool = makeTaskTool({
      run: async () => "sync",
      background: {
        launch: (job) => {
          launched = { agent: job.agent, prompt: job.prompt };
          return { ok: true, id: "bg-1" };
        },
      },
    });
    const out = await tool.execute(
      { prompt: "后台探索", agent: "explorer", background: true },
      { cfg, approve: async () => true } as ToolCtx,
    );
    expect(launched?.agent).toBe("explorer");
    expect(out).toContain("bg-1");
    expect(out).toContain("explorer");
  });
});

/* ------------------------------------------------------------------ */
/* /agents 命令、帮助与 COMMANDS                                       */
/* ------------------------------------------------------------------ */

function makeCmd(cfg: Config): { ctx: CommandContext; out: () => string } {
  const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
  const ctx = {
    cfg,
    ui: cap.ui,
    agent: {} as CommandContext["agent"],
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: {} as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
  } as CommandContext;
  return { ctx, out: cap.out };
}

describe("#36 /agents 与文档入口", () => {
  test("/agents 列出源、名、说明；详情含路径/工具/模型，不倾倒超长正文", async () => {
    const s = sandbox("cmd");
    isolateHome(s.home);
    const longTail = `UNIQUE_TAIL_MARKER_${"Z".repeat(80)}`;
    writeAgent(
      join(s.cwd, ".neo", "agents"),
      "explorer.md",
      `---\nname: explorer\ndescription: 探索代码库并汇总发现\ntools: read_file, grep\nmodel: fast\n---\n\n开头摘录可见。\n${"PADDING_LINE\n".repeat(40)}${longTail}\n`,
    );
    const cfg = makeCfg(s.cwd, s.store);
    const h = makeCmd(cfg);
    await dispatchCommand("/agents", h.ctx);
    const list = h.out();
    expect(list).toContain("explorer");
    expect(list).toContain("探索代码库并汇总发现");
    expect(list).toContain("项目 .neo");
    expect(list).not.toContain(longTail);

    const d = makeCmd(cfg);
    await dispatchCommand("/agents explorer", d.ctx);
    const detail = d.out();
    expect(detail).toContain("explorer");
    expect(detail).toContain(join(s.cwd, ".neo", "agents", "explorer.md"));
    expect(detail).toContain("read_file");
    expect(detail).toContain("fast");
    expect(detail).toContain("开头摘录可见");
    expect(detail).not.toContain(longTail);
  });

  test("/agents 在 safe-mode 下提示未加载；未知名列出可用项", async () => {
    const s = sandbox("cmd-safe");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const safe = makeCmd(makeCfg(s.cwd, s.store, { safeMode: true }));
    await dispatchCommand("/agents", safe.ctx);
    expect(safe.out()).toContain("未加载");
    const miss = makeCmd(makeCfg(s.cwd, s.store));
    await dispatchCommand("/agents nope", miss.ctx);
    const text = miss.out();
    expect(text).toMatch(/不存在|未知/);
    expect(text).toContain("explorer");
  });

  test("COMMANDS 与 --help 提到 /agents 和 markdown 布局，且与技能区分", () => {
    expect(COMMANDS.some((c) => c.name === "agents")).toBe(true);
    const help = helpText();
    expect(help).toContain("/agents");
    expect(help).toMatch(/\.neo\/agents/);
    expect(help).toContain("技能");
  });
});

describe("#36 resolveTaskAgent", () => {
  test("空名字是通用；有名字则解析", () => {
    const s = sandbox("resolve");
    isolateHome(s.home);
    writeAgent(join(s.cwd, ".neo", "agents"), "explorer.md", EXPLORER);
    const cfg = makeCfg(s.cwd, s.store);
    expect(resolveTaskAgent(cfg, undefined).ok).toBe(true);
    expect(("agent" in (resolveTaskAgent(cfg, undefined) as { agent?: NamedAgent }))
      ? (resolveTaskAgent(cfg, undefined) as { agent?: NamedAgent }).agent
      : undefined).toBeUndefined();
    const hit = resolveTaskAgent(cfg, "explorer");
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.agent?.name).toBe("explorer");
    const miss = resolveTaskAgent(cfg, "nope");
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toContain("explorer");
  });
});
