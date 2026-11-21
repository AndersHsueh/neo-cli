/**
 * issue #85：子代理隔离（task isolation / 命名子代理 isolation: worktree）、在跑子代理的 cwd 快照、
 * enter_worktree / exit_worktree 的 parallelizable=false 屏障（真 Agent + 假 LLM 脚本）。
 * 按已签合同 /workspace/neo-85-slice-final.md 逐条编码。
 *
 * Boris 点名的红测：
 *  1. 隔离子代理只新建、不复用（目录或分支 neo/<name> 任一已存在就加后缀）；
 *  2. 在跑的子代理读不到换根后的 cfg.cwd；
 *  3. 工具 parallelizable=false 屏障（同批前面旧根、后面新根；失败不切根）。
 *
 * 运行：bun test tests/session-worktree-85-subagent.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import { discoverAgents } from "../src/agents.ts";
import { makePreviousCwdSlot } from "../src/cli/cdWorkdir.ts";
import { dispatchCommand, type CommandContext } from "../src/cli/commands.ts";
import type { Config, ModelTier } from "../src/config.ts";
import { contentText, type Message, type StreamResult, type ToolCall } from "../src/llm.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import { createSession, saveSession, type SessionMeta } from "../src/session.ts";
import { BackgroundTasks } from "../src/tools/background.ts";
import { registerTool } from "../src/tools/index.ts";
import { makeTaskTool, runSubagent } from "../src/tools/task.ts";
import { ToolError, type ToolCtx } from "../src/tools/types.ts";
import { ensureWorktree, worktreePath } from "../src/worktree.ts";
import { captureConsole } from "./helpers.ts";

const sw = () => import("../src/cli/sessionWorktree.ts");
const sub = () => import("../src/subagentWorktree.ts");

const made: string[] = [];
const prevSessionsDir = process.env["NEO_SESSIONS_DIR"];
const prevMailboxDir = process.env["NEO_MAILBOX_DIR"];
const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), "neo-85s-sessions-")));
made.push(sessionsRoot);
process.env["NEO_SESSIONS_DIR"] = sessionsRoot;
process.env["NEO_MAILBOX_DIR"] = join(sessionsRoot, "mailbox");

afterAll(() => {
  if (prevSessionsDir === undefined) delete process.env["NEO_SESSIONS_DIR"];
  else process.env["NEO_SESSIONS_DIR"] = prevSessionsDir;
  if (prevMailboxDir === undefined) delete process.env["NEO_MAILBOX_DIR"];
  else process.env["NEO_MAILBOX_DIR"] = prevMailboxDir;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix = "neo-85s-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function put(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function makeRepo(): { top: string; repo: string; shared: string } {
  const top = tempDir("neo-85s-ws-");
  const repo = join(top, "repo");
  const shared = join(top, "shared");
  mkdirSync(repo, { recursive: true });
  mkdirSync(shared, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  put(repo, ".gitignore", ".neo/\n*.log\nskills/\n");
  put(repo, "marker.txt", "MAIN-MARKER\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { top, repo, shared };
}

function makeCfg(cwd: string, tier: ModelTier = "default"): Config {
  const provider = {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: { default: "m-default", deep_reasoning: "m-deep", balanced: "m-bal", fast: "m-fast" } as Record<ModelTier, string>,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: tier,
    model: `m-${tier}`,
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
    skillsStore: join(cwd, ".no-global-skills"),
    agentsStore: join(cwd, ".no-global-agents"),
    parallelToolCalls: "on",
    env: { prompt: false },
    memory: {
      enabled: false,
      userLevelDir: join(cwd, ".mem"),
      userWikiDir: join(cwd, ".wiki"),
      journalDir: join(cwd, ".journal"),
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

function silentIO(confirm: () => Promise<boolean> = async () => true): AgentIO {
  return {
    line(): void {},
    blank(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    toolHeader(): void {},
    toolResult(): void {},
    indent: (body: string) => body,
    startSpinner(): void {},
    updateSpinner(): void {},
    stopSpinner(): void {},
    beginStream(): void {},
    writeStream(): void {},
    endStream(): void {},
    ensureStreamClosed(): void {},
    confirm,
    width: 100,
  } as AgentIO;
}

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

type Step = (cfg: Config, messages: Message[]) => Partial<StreamResult> | Promise<Partial<StreamResult>>;

function fakeStream(steps: Step[]) {
  const seen: Config[] = [];
  let i = 0;
  const fn = async (cfg: Config, messages: Message[]): Promise<StreamResult> => {
    seen.push(cfg);
    const step = steps[i];
    if (!step) throw new Error(`fake chatStream: 脚本耗尽（第 ${i + 1} 次调用）`);
    i++;
    const r = await step(cfg, messages);
    return { content: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null, ...r } as StreamResult;
  };
  return { fn, seen };
}

function toolResults(messages: Message[]): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => contentText(m.content) ?? "");
}

const isSubPrompt = (msgs: Message[]): boolean => (contentText(msgs[0]?.content ?? "") ?? "").includes("派出的子代理");

/* ------------------------------------------------------------------ */
/* 会话宿主（工具与斜杠共用）                                             */
/* ------------------------------------------------------------------ */

interface Host {
  cfg: Config;
  meta: SessionMeta;
  messages: Message[];
  pm: PromptManager;
  deps: (over?: Record<string, unknown>) => Record<string, unknown>;
  ctx: (ui: CommandContext["ui"], over?: Partial<CommandContext>) => CommandContext;
}

function host(cfg: Config, getMessages: () => Message[] = () => []): Host {
  const meta = createSession(cfg.model, cfg.cwd).meta;
  const pm = new PromptManager({ mailbox: false, askUser: false, sessionName: "s85s" });
  const prev = makePreviousCwdSlot();
  const h: Host = {
    cfg,
    meta,
    messages: [],
    pm,
    deps: (over = {}) => ({
      cfg,
      meta,
      messages: getMessages(),
      persist: (msgs: Message[], m: SessionMeta) => saveSession(msgs, m),
      promptManager: pm,
      refreshSystemPrompt: () => {},
      previousCwd: prev,
      ...over,
    }),
    ctx: (ui, over = {}) =>
      ({
        agent: { messages: getMessages(), refreshSystemPrompt: () => {}, activeNestedAgents: [], planning: false, mode: "ask" },
        ui,
        cfg,
        memory: { setCwd: () => {} },
        classifier: {},
        meta,
        shutdown: () => {},
        selectDeps: {},
        mailbox: null,
        checkpoints: null,
        promptManager: pm,
        persistSession: (msgs: Message[], m: SessionMeta) => saveSession(msgs, m),
        previousCwd: prev,
        turnActive: false,
        ...over,
      }) as unknown as CommandContext,
  };
  return h;
}

/** 工具注册在模块级宿主上；每个用例把 currentHost 指向自己的会话。 */
let currentHost: Host | null = null;
const unregisters: Array<() => void> = [];
beforeAll(async () => {
  // 红态时模块不存在：吞掉加载错误，让每条用例各自失败（逐条可核对），而不是整文件一个 unnamed 失败。
  const mod = await sw().catch(() => null);
  if (!mod) return;
  for (const t of mod.makeWorktreeTools({ deps: () => currentHost!.deps() as never })) unregisters.push(registerTool(t));
});
afterAll(() => {
  for (const u of unregisters) u();
});

/* ------------------------------------------------------------------ */
/* Boris 1：只新建、不复用                                               */
/* ------------------------------------------------------------------ */

describe("Boris#1 隔离子代理只新建、不复用", () => {
  test("目录与分支都不存在：用起点名", async () => {
    const mod = await sub();
    const { repo } = makeRepo();
    const r = mod.createSubagentWorktree(repo, "sg-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe("sg-1");
      expect(r.path).toBe(worktreePath(repo, "sg-1"));
      expect(r.branch).toBe("neo/sg-1");
    }
  });

  test("托管目录已存在（上次留下的树）：加后缀，不挂到旧树上", async () => {
    const mod = await sub();
    const { repo } = makeRepo();
    expect(ensureWorktree(repo, "sg-1").ok).toBe(true);
    const r = mod.createSubagentWorktree(repo, "sg-1");
    expect(r.ok && r.name).toBe("sg-1-2");
  });

  test("只有分支 neo/<name> 残留（remove 后分支保留）：加后缀，不复用脏分支", async () => {
    const mod = await sub();
    const { repo } = makeRepo();
    git(repo, "branch", "neo/sg-1");
    const r = mod.createSubagentWorktree(repo, "sg-1");
    expect(r.ok && r.name).toBe("sg-1-2");
  });

  test("只有目录（未登记）残留：加后缀；直到目录与分支都不存在", async () => {
    const mod = await sub();
    const { repo } = makeRepo();
    mkdirSync(worktreePath(repo, "sg-1"), { recursive: true });
    git(repo, "branch", "neo/sg-1-2");
    const r = mod.createSubagentWorktree(repo, "sg-1");
    expect(r.ok && r.name).toBe("sg-1-3");
  });

  test("e2e：上一会话的 neo/sg-1 带着脏提交，新子代理挂在 sg-1-2 上、看不到那份提交", async () => {
    const { repo } = makeRepo();
    expect(ensureWorktree(repo, "sg-1").ok).toBe(true);
    const stale = realpathSync(worktreePath(repo, "sg-1"));
    put(stale, "stale.txt", "STALE\n");
    git(stale, "add", "-A");
    git(stale, "commit", "-q", "-m", "stale");
    git(repo, "worktree", "remove", "--force", stale);
    const cfg = makeCfg(repo);
    const fake = fakeStream([
      () => ({ toolCalls: [tc("list_dir", { path: "." })], finishReason: "tool_calls" }),
      () => ({ content: "done" }),
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await runSubagent(main, "看看目录", undefined, { cfg, approve: async () => true }, undefined, undefined, { isolation: "worktree" });
    const subCfg = fake.seen[0]!;
    expect(subCfg.cwd).toBe(worktreePath(repo, "sg-1-2"));
  });

  test("源码：隔离子代理不走 ensureWorktree 复用分支", () => {
    const src = readFileSync(join(import.meta.dir, "../src/subagentWorktree.ts"), "utf8");
    expect(src).not.toContain("ensureWorktree(");
  });
});

/* ------------------------------------------------------------------ */
/* Boris 2：在跑的子代理读不到换根后的 cfg.cwd                             */
/* ------------------------------------------------------------------ */

describe("Boris#2 在跑子代理的 cwd 是派出时快照", () => {
  test("后台子代理在跑 → 父会话 /worktree create 成功 → 子代理此后的工具仍按旧根执行", async () => {
    const { repo } = makeRepo();
    const cfg = makeCfg(repo);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    const subMessages: Message[][] = [];
    const fake = fakeStream([
      async () => {
        reached();
        await gate;
        return { toolCalls: [tc("read_file", { path: "marker.txt" }), tc("shell", { command: "pwd" })], finishReason: "tool_calls" };
      },
      (_c, msgs) => {
        subMessages.push(msgs);
        return { content: "report" };
      },
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    const bg = new BackgroundTasks({ run: (job, signal) => runSubagent(main, job.prompt, undefined, { ...job.ctx, signal }) });
    const launched = bg.launch({ prompt: "读 marker", ctx: { cfg, approve: async () => true } as ToolCtx });
    expect(launched.ok).toBe(true);
    await atGate;
    const h = host(cfg);
    const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
    await dispatchCommand("/worktree create feat", h.ctx(cap.ui, { tasks: { list: () => bg.list(), cancel: () => 0 } } as never));
    const tree = realpathSync(worktreePath(repo, "feat"));
    put(tree, "marker.txt", "TREE-MARKER\n");
    expect(cfg.cwd).toBe(tree);
    release();
    for (let i = 0; i < 200 && bg.list()[0]?.status === "running"; i++) await Bun.sleep(10);
    expect(bg.list()[0]?.status).toBe("done");
    const results = toolResults(subMessages[0]!);
    expect(results[0]).toContain("MAIN-MARKER");
    expect(results[0]).not.toContain("TREE-MARKER");
    expect(results[1]).toContain(repo);
    expect(results[1]).not.toContain(".neo/worktrees/feat");
    expect(fake.seen.every((c) => c.cwd === repo)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Boris 3：parallelizable=false 屏障                                    */
/* ------------------------------------------------------------------ */

describe("Boris#3 enter_worktree / exit_worktree 是同批屏障", () => {
  test("同一批：前面的调用按旧根，后面的按新根；返回前已切根", async () => {
    const { repo } = makeRepo();
    const cfg = makeCfg(repo);
    let main!: Agent;
    let mainMessages: Message[] = [];
    const fake = fakeStream([
      () => ({
        toolCalls: [
          tc("read_file", { path: "marker.txt" }),
          tc("shell", { command: "pwd" }),
          tc("enter_worktree", { name: "feat" }),
          tc("shell", { command: "pwd" }),
          tc("exit_worktree", {}),
          tc("shell", { command: "pwd" }),
        ],
        finishReason: "tool_calls",
      }),
      (_c, msgs) => {
        mainMessages = msgs;
        return { content: "ok" };
      },
    ]);
    main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    currentHost = host(cfg, () => main.messages);
    await main.send("进出 worktree");
    const results = toolResults(mainMessages);
    const tree = worktreePath(repo, "feat");
    expect(results[0]).toContain("MAIN-MARKER");
    expect(results[1]).toContain(repo);
    expect(results[1]).not.toContain(tree);
    expect(results[2]).toContain("feat");
    expect(results[3]).toContain(tree);
    expect(results[4]).toContain("feat");
    expect(results[5]).toContain(repo);
    expect(results[5]).not.toContain(tree);
    expect(cfg.cwd).toBe(repo);
    expect(existsSync(tree)).toBe(true);
  });

  test("屏障按新根读：树里改过的文件在 enter 之后可见，enter 之前不可见", async () => {
    const { repo } = makeRepo();
    expect(ensureWorktree(repo, "have").ok).toBe(true);
    const tree = realpathSync(worktreePath(repo, "have"));
    put(tree, "marker.txt", "TREE-MARKER\n");
    const cfg = makeCfg(repo);
    let main!: Agent;
    let mainMessages: Message[] = [];
    const fake = fakeStream([
      () => ({
        toolCalls: [
          tc("read_file", { path: "marker.txt" }),
          tc("enter_worktree", { name: "have" }),
          tc("read_file", { path: "marker.txt" }),
        ],
        finishReason: "tool_calls",
      }),
      (_c, msgs) => {
        mainMessages = msgs;
        return { content: "ok" };
      },
    ]);
    main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    currentHost = host(cfg, () => main.messages);
    await main.send("进入");
    const results = toolResults(mainMessages);
    expect(results[0]).toContain("MAIN-MARKER");
    expect(results[2]).toContain("TREE-MARKER");
    expect(cfg.cwd).toBe(tree);
  });

  test("失败不切根：同批后面的调用仍按旧根", async () => {
    const { repo } = makeRepo();
    const cfg = makeCfg(repo);
    let main!: Agent;
    let mainMessages: Message[] = [];
    const fake = fakeStream([
      () => ({
        toolCalls: [tc("enter_worktree", { name: "../bad" }), tc("read_file", { path: "marker.txt" })],
        finishReason: "tool_calls",
      }),
      (_c, msgs) => {
        mainMessages = msgs;
        return { content: "ok" };
      },
    ]);
    main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    currentHost = host(cfg, () => main.messages);
    await main.send("坏名字");
    const results = toolResults(mainMessages);
    expect(results[0]).toContain("名字非法");
    expect(results[1]).toContain("MAIN-MARKER");
    expect(cfg.cwd).toBe(repo);
  });

  test("审批：plan 模式下 enter_worktree 新建被拒；auto-edit 免问；ask 弹确认", async () => {
    for (const [mode, expectCreated, expectConfirm] of [
      ["plan", false, 0],
      ["auto-edit", true, 0],
      ["ask", true, 1],
    ] as const) {
      const { repo } = makeRepo();
      const cfg = makeCfg(repo);
      let confirms = 0;
      let main!: Agent;
      const fake = fakeStream([
        () => ({ toolCalls: [tc("enter_worktree", { name: "feat" })], finishReason: "tool_calls" }),
        () => ({ content: "ok" }),
      ]);
      main = new Agent({
        cfg,
        console: silentIO(async () => {
          confirms += 1;
          return true;
        }),
        mode,
        systemPrompt: "main",
        chatStream: fake.fn,
      });
      currentHost = host(cfg, () => main.messages);
      await main.send("新建");
      expect(existsSync(worktreePath(repo, "feat"))).toBe(expectCreated);
      expect(confirms).toBe(expectConfirm);
    }
  });

  test("审批：plan 模式下进入已有树不审批、可进入", async () => {
    const { repo } = makeRepo();
    expect(ensureWorktree(repo, "have").ok).toBe(true);
    const cfg = makeCfg(repo);
    let main!: Agent;
    const fake = fakeStream([
      () => ({ toolCalls: [tc("enter_worktree", { name: "have" })], finishReason: "tool_calls" }),
      () => ({ content: "ok" }),
    ]);
    main = new Agent({ cfg, console: silentIO(async () => false), mode: "plan", systemPrompt: "main", chatStream: fake.fn });
    currentHost = host(cfg, () => main.messages);
    await main.send("进入已有");
    expect(cfg.cwd).toBe(realpathSync(worktreePath(repo, "have")));
  });
});

/* ------------------------------------------------------------------ */
/* 子代理隔离：入口、快照、清理                                            */
/* ------------------------------------------------------------------ */

describe("task isolation=worktree 与命名子代理 isolation: worktree", () => {
  test("task 工具 schema 增加可选 isolation，取值只能是 worktree", () => {
    const t = makeTaskTool({ run: async () => "x" });
    const props = (t.spec.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props["isolation"]?.enum).toEqual(["worktree"]);
  });

  test("未知 isolation 值：拒绝派出，不降级", async () => {
    let ran = 0;
    const { repo } = makeRepo();
    const t = makeTaskTool({
      run: async () => {
        ran += 1;
        return "x";
      },
    });
    await expect(
      Promise.resolve().then(() => t.execute({ prompt: "p", isolation: "sandbox" }, { cfg: makeCfg(repo), approve: async () => true } as ToolCtx)),
    ).rejects.toThrow(/isolation/);
    expect(ran).toBe(0);
  });

  test("不在 git 仓：isolation=worktree 直接拒绝派出（task 工具与 runSubagent 都拒）", async () => {
    let ran = 0;
    const plain = tempDir("neo-85s-plain-");
    const cfg = makeCfg(plain);
    const t = makeTaskTool({
      run: async () => {
        ran += 1;
        return "x";
      },
    });
    await expect(
      Promise.resolve().then(() => t.execute({ prompt: "p", isolation: "worktree" }, { cfg, approve: async () => true } as ToolCtx)),
    ).rejects.toThrow(/git/);
    expect(ran).toBe(0);
    const fake = fakeStream([]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await expect(
      runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, { isolation: "worktree" }),
    ).rejects.toThrow(ToolError);
    expect(fake.seen.length).toBe(0);
  });

  test("task 把 isolation 交给同步与后台两条路径", async () => {
    const { repo } = makeRepo();
    const cfg = makeCfg(repo);
    const seen: unknown[] = [];
    const t = makeTaskTool({
      run: async (...a: unknown[]) => {
        seen.push(a[5]);
        return "x";
      },
      background: {
        launch: (job: unknown) => {
          seen.push((job as { isolation?: string }).isolation);
          return { ok: true, id: "bg-1" };
        },
      },
    } as never);
    await t.execute({ prompt: "p", isolation: "worktree" }, { cfg, approve: async () => true } as ToolCtx);
    await t.execute({ prompt: "p", isolation: "worktree", background: true }, { cfg, approve: async () => true } as ToolCtx);
    expect(seen).toEqual(["worktree", "worktree"]);
    const start = readFileSync(join(import.meta.dir, "../src/cli/sessionStart.ts"), "utf8");
    expect(start).toContain("isolation: job.isolation");
  });

  test("命名子代理 frontmatter：isolation: worktree 被解析；未知值拒绝派出", async () => {
    const { repo } = makeRepo();
    put(repo, ".neo/agents/iso.md", "---\nname: iso\ndescription: d\nisolation: worktree\n---\nbody\n");
    put(repo, ".neo/agents/bad.md", "---\nname: bad\ndescription: d\nisolation: sandbox\n---\nbody\n");
    const cfg = makeCfg(repo);
    const found = discoverAgents(cfg).agents;
    expect(found.find((a) => a.name === "iso")?.isolation).toBe("worktree");
    const fake = fakeStream([
      () => ({ toolCalls: [tc("list_dir", { path: "." })], finishReason: "tool_calls" }),
      () => ({ content: "done" }),
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, undefined, "iso");
    expect(fake.seen[0]!.cwd).toContain(join(".neo", "worktrees", "sg-1"));
    const fake2 = fakeStream([]);
    const main2 = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake2.fn });
    await expect(
      runSubagent(main2, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, undefined, "bad"),
    ).rejects.toThrow(/isolation/);
    expect(fake2.seen.length).toBe(0);
  });

  test("子代理 cwd 是新建的树；额外根为空；从主检出 HEAD 分出（不带当前树的提交/脏改动）", async () => {
    const { repo, shared } = makeRepo();
    expect(ensureWorktree(repo, "cur").ok).toBe(true);
    const cur = realpathSync(worktreePath(repo, "cur"));
    put(cur, "cur-commit.txt", "C\n");
    git(cur, "add", "-A");
    git(cur, "commit", "-q", "-m", "cur");
    put(cur, "cur-dirty.txt", "D\n");
    const cfg = makeCfg(cur);
    cfg.additionalDirs = [shared];
    let listing = "";
    const fake = fakeStream([
      () => ({ toolCalls: [tc("list_dir", { path: "." })], finishReason: "tool_calls" }),
      (_c, msgs) => {
        listing = toolResults(msgs)[0] ?? "";
        return { content: "done" };
      },
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, { isolation: "worktree" });
    const subCfg = fake.seen[0]!;
    expect(subCfg.cwd).toBe(worktreePath(repo, "sg-1"));
    expect(subCfg.additionalDirs ?? []).toEqual([]);
    expect(cfg.additionalDirs).toEqual([shared]);
    expect(cfg.cwd).toBe(cur);
    expect(listing).toContain("marker.txt");
    expect(listing).not.toContain("cur-commit.txt");
    expect(listing).not.toContain("cur-dirty.txt");
  });

  test("沿用父会话已加载的技能集合，不按 worktree 根再发现", async () => {
    const { repo } = makeRepo();
    put(repo, "skills/demo/SKILL.md", "---\nname: demo\ndescription: d\n---\nDEMO-SKILL-BODY\n");
    const cfg = makeCfg(repo);
    let skillOut = "";
    const fake = fakeStream([
      () => ({ toolCalls: [tc("use_skill", { name: "demo" })], finishReason: "tool_calls" }),
      (_c, msgs) => {
        skillOut = toolResults(msgs)[0] ?? "";
        return { content: "done" };
      },
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, { isolation: "worktree" });
    expect(existsSync(join(worktreePath(repo, "sg-1"), "skills"))).toBe(false);
    expect(skillOut).toContain("DEMO-SKILL-BODY");
  });

  test("正常结束且树干净（被 gitignore 的文件不算脏）：自动删除，分支保留", async () => {
    const { repo } = makeRepo();
    const cfg = makeCfg(repo);
    const fake = fakeStream([
      () => ({ toolCalls: [tc("write_file", { path: "run.log", content: "ignored\n" })], finishReason: "tool_calls" }),
      () => ({ content: "done" }),
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, { isolation: "worktree" });
    expect(existsSync(worktreePath(repo, "sg-1"))).toBe(false);
    expect(git(repo, "branch", "--list", "neo/sg-1").trim()).not.toBe("");
  });

  test("有脏改动：保留，报告里写明名字与路径", async () => {
    const { repo } = makeRepo();
    const cfg = makeCfg(repo);
    const fake = fakeStream([
      () => ({ toolCalls: [tc("write_file", { path: "new.txt", content: "dirty\n" })], finishReason: "tool_calls" }),
      () => ({ content: "done" }),
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    const report = await runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, { isolation: "worktree" });
    const path = worktreePath(repo, "sg-1");
    expect(existsSync(join(path, "new.txt"))).toBe(true);
    expect(report).toContain("sg-1");
    expect(report).toContain(path);
    expect(existsSync(join(repo, "new.txt"))).toBe(false);
  });

  test("运行中不可 remove 该树（--force 同样不放行）；结束后登记解除", async () => {
    const mod = await sub();
    const { repo } = makeRepo();
    const cfg = makeCfg(repo);
    let removeOut = "";
    let runningDuring = false;
    const h = host(cfg);
    const fake = fakeStream([
      async () => {
        runningDuring = mod.isRunningIsolatedWorktree(worktreePath(repo, "sg-1"));
        put(worktreePath(repo, "sg-1"), "dirty.txt", "x\n");
        const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
        cap.ui.confirm = async () => true;
        await dispatchCommand("/worktree remove sg-1 --force", h.ctx(cap.ui));
        removeOut = cap.out();
        return { content: "done" };
      },
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, { isolation: "worktree" });
    expect(runningDuring).toBe(true);
    expect(removeOut).toContain("sg-1");
    expect(existsSync(join(worktreePath(repo, "sg-1"), "dirty.txt"))).toBe(true);
    expect(mod.isRunningIsolatedWorktree(worktreePath(repo, "sg-1"))).toBe(false);
  });

  test("未写 isolation：沿用今天的行为（与父同 cwd，#63 快照额外根）；内部派出不自动隔离", async () => {
    const { repo, shared } = makeRepo();
    const cfg = makeCfg(repo);
    cfg.additionalDirs = [shared];
    const fake = fakeStream([() => ({ content: "done" }), () => ({ content: "done" })]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await runSubagent(main, "p", undefined, { cfg, approve: async () => true });
    await runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, { emitSubagentHooks: false });
    expect(fake.seen[0]!.cwd).toBe(repo);
    expect(fake.seen[0]!.additionalDirs).toEqual([shared]);
    expect(fake.seen[1]!.cwd).toBe(repo);
    expect(existsSync(join(repo, ".neo", "worktrees"))).toBe(false);
  });

  test("子代理提示里说明它在隔离检出中", async () => {
    const { repo } = makeRepo();
    const cfg = makeCfg(repo);
    let sys = "";
    const fake = fakeStream([
      (_c, msgs) => {
        if (isSubPrompt(msgs)) sys = contentText(msgs[0]!.content) ?? "";
        return { content: "done" };
      },
    ]);
    const main = new Agent({ cfg, console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: fake.fn });
    await runSubagent(main, "p", undefined, { cfg, approve: async () => true }, undefined, undefined, { isolation: "worktree" });
    expect(sys).toContain(worktreePath(repo, "sg-1"));
  });
});
