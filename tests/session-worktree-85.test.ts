/**
 * issue #85：会话中进出托管 worktree（/worktree create|enter|exit、enter_worktree / exit_worktree）、
 * isolation origin 与续聊、/cd 与 /fork 的绑定口径、.worktreeinclude、文案与对照段。
 * 按已签合同 /workspace/neo-85-slice-final.md（sha256 44dddd87…）逐条编码。
 *
 * 新模块一律在用例内动态 import：红态时每条用例各自失败，便于逐条核对。
 *
 * 运行：bun test tests/session-worktree-85.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makePreviousCwdSlot, type PreviousCwdSlot } from "../src/cli/cdWorkdir.ts";
import { dispatchCommand, type CommandContext } from "../src/cli/commands.ts";
import { forkSession } from "../src/cli/forkSession.ts";
import { helpText } from "../src/cli/help.ts";
import { isSteerable } from "../src/cli/midTurnSteer.ts";
import type { Config } from "../src/config.ts";
import { COMMANDS } from "../src/input/commands.ts";
import type { Message } from "../src/llm.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import { createSession, loadSession, saveSession, type SessionMeta } from "../src/session.ts";
import { TOOL_NAMES_EXCLUDED_FOR_SUBAGENT, dispatch, isParallelizable, registerTool } from "../src/tools/index.ts";
import type { ToolCtx, ToolImpl } from "../src/tools/types.ts";
import { ensureWorktree, worktreeBranch, worktreePath } from "../src/worktree.ts";
import { captureConsole } from "./helpers.ts";

const sw = () => import("../src/cli/sessionWorktree.ts");
const inc = () => import("../src/worktreeInclude.ts");
const comp = () => import("../src/cli/worktreeCompletion.ts");

const made: string[] = [];
const prevSessionsDir = process.env["NEO_SESSIONS_DIR"];
const prevMailboxDir = process.env["NEO_MAILBOX_DIR"];
const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), "neo-85-sessions-")));
made.push(sessionsRoot);
process.env["NEO_SESSIONS_DIR"] = sessionsRoot;
process.env["NEO_MAILBOX_DIR"] = join(sessionsRoot, "mailbox");

const unregisters: Array<() => void> = [];
afterAll(() => {
  for (const u of unregisters) u();
  if (prevSessionsDir === undefined) delete process.env["NEO_SESSIONS_DIR"];
  else process.env["NEO_SESSIONS_DIR"] = prevSessionsDir;
  if (prevMailboxDir === undefined) delete process.env["NEO_MAILBOX_DIR"];
  else process.env["NEO_MAILBOX_DIR"] = prevMailboxDir;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix = "neo-85-"): string {
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

/** 临时仓库（含一次提交），布局：<top>/repo（主检出）、<top>/shared、<top>/other。 */
function workspace(): { top: string; repo: string; shared: string; other: string } {
  const top = tempDir("neo-85-ws-");
  const repo = join(top, "repo");
  const shared = join(top, "shared");
  const other = join(top, "other");
  for (const d of [repo, shared, other]) mkdirSync(d, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  put(repo, ".gitignore", ".neo/\n.env\n*.local\n");
  put(repo, "README.md", "MAIN-README\n");
  mkdirSync(join(repo, "sub"), { recursive: true });
  put(repo, "sub/keep.txt", "keep\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { top, repo, shared, other };
}

function makeCfg(cwd: string, over: Partial<Config> = {}): Config {
  return {
    cwd,
    model: "m-85",
    providerName: "test",
    modelTier: "balanced",
    toolOutputLimit: 30_000,
    contextWindow: 200_000,
    contextWindowSource: "models_api",
    skillsStore: join(cwd, ".no-global-skills"),
    agentsStore: join(cwd, ".no-global-agents"),
    env: { prompt: false },
    repoMap: { enabled: false, budgetTokens: 1000, maxFiles: 500 },
    hooks: { enabled: false, hooks: {}, warnings: [] },
    lsp: { enabled: false, servers: [] },
    memory: { enabled: false, scopeMode: "project" },
    ...over,
  } as unknown as Config;
}

interface Harness {
  ws: ReturnType<typeof workspace>;
  cfg: Config;
  meta: SessionMeta;
  messages: Message[];
  promptManager: PromptManager;
  previousCwd: PreviousCwdSlot;
  fileIndexRoots: { cwd: string; extras: string[] } | null;
  persistCalls: number;
  refreshCalls: number;
  ctx: (ui: CommandContext["ui"], over?: Partial<CommandContext>) => CommandContext;
  /** 工具宿主：与斜杠共用同一套换根依赖。 */
  deps: (over?: Record<string, unknown>) => Record<string, unknown>;
}

function harness(): Harness {
  const ws = workspace();
  const cfg = makeCfg(ws.repo);
  const sess = createSession(cfg.model, ws.repo);
  const promptManager = new PromptManager({ mailbox: false, askUser: false, sessionName: "s85" });
  const messages: Message[] = [{ role: "system", content: promptManager.render(cfg).text }];
  saveSession(messages, sess.meta);
  const h: Harness = {
    ws,
    cfg,
    meta: sess.meta,
    messages,
    promptManager,
    previousCwd: makePreviousCwdSlot(),
    fileIndexRoots: null,
    persistCalls: 0,
    refreshCalls: 0,
    deps: (over = {}) => ({
      cfg: h.cfg,
      meta: h.meta,
      messages: h.messages,
      persist: (msgs: Message[], meta: SessionMeta) => {
        h.persistCalls += 1;
        saveSession(msgs, meta);
      },
      promptManager: h.promptManager,
      refreshSystemPrompt: () => {
        h.refreshCalls += 1;
        h.messages[0] = { role: "system", content: h.promptManager.render(h.cfg).text };
      },
      previousCwd: h.previousCwd,
      fileIndex: {
        setCwd: (cwd: string) => {
          h.fileIndexRoots = { cwd, extras: [] };
        },
        setRoots: (cwd: string, extras: string[]) => {
          h.fileIndexRoots = { cwd, extras: [...extras] };
        },
      },
      ...over,
    }),
    ctx: (ui, over = {}) =>
      ({
        agent: {
          messages: h.messages,
          refreshSystemPrompt: () => {
            h.refreshCalls += 1;
            h.messages[0] = { role: "system", content: h.promptManager.render(h.cfg).text };
          },
          activeNestedAgents: [],
          planning: false,
          mode: "ask",
          contextUsage: () => 0,
          lastCompactionInfo: null,
        },
        ui,
        cfg: h.cfg,
        memory: { setCwd: () => {} },
        classifier: {},
        meta: h.meta,
        shutdown: () => {},
        selectDeps: {},
        mailbox: null,
        checkpoints: null,
        promptManager: h.promptManager,
        persistSession: (msgs: Message[], meta: SessionMeta) => {
          h.persistCalls += 1;
          saveSession(msgs, meta);
        },
        previousCwd: h.previousCwd,
        fileIndex: {
          setCwd: (cwd: string) => {
            h.fileIndexRoots = { cwd, extras: [] };
          },
          setRoots: (cwd: string, extras: string[]) => {
            h.fileIndexRoots = { cwd, extras: [...extras] };
          },
        },
        turnActive: false,
        ...over,
      }) as unknown as CommandContext,
  };
  return h;
}

async function run(h: Harness, line: string, over: Partial<CommandContext> = {}): Promise<string> {
  const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
  await dispatchCommand(line, h.ctx(cap.ui, over));
  return cap.out();
}

function wt(h: Harness, name: string): string {
  return worktreePath(h.ws.repo, name);
}

/* ------------------------------------------------------------------ */
/* /worktree create                                                    */
/* ------------------------------------------------------------------ */

describe("/worktree create <name>", () => {
  test("新建：切主根到检出，输出含创建/名字/路径/分支/现在的主根；元数据记录隔离绑定", async () => {
    const h = harness();
    const out = await run(h, "/worktree create feat");
    const path = wt(h, "feat");
    expect(existsSync(path)).toBe(true);
    expect(h.cfg.cwd).toBe(realpathSync(path));
    expect(h.meta.cwd).toBe(realpathSync(path));
    expect(out).toContain("已创建");
    expect(out).toContain("feat");
    expect(out).toContain(path);
    expect(out).toContain(worktreeBranch("feat"));
    expect(out).toContain("主根");
    expect(h.meta.worktree?.name).toBe("feat");
    expect(h.meta.worktree?.origin).toBe(h.ws.repo);
    expect(loadSession(h.meta.id)?.meta.worktree?.name).toBe("feat");
    expect(h.fileIndexRoots?.cwd).toBe(realpathSync(path));
  });

  test("复用已有托管树：输出说复用，不新建", async () => {
    const h = harness();
    expect(ensureWorktree(h.ws.repo, "reuse").ok).toBe(true);
    const out = await run(h, "/worktree create reuse");
    expect(out).toContain("已复用");
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "reuse")));
  });

  test("缺名字、非法名字：明确报错，不切根", async () => {
    const h = harness();
    const a = await run(h, "/worktree create");
    expect(a).toContain("/worktree create <name>");
    const b = await run(h, "/worktree create ../evil");
    expect(b).toContain("名字非法");
    expect(h.cfg.cwd).toBe(h.ws.repo);
    expect(h.meta.worktree).toBeUndefined();
  });

  test("不在 git 仓里：明确报错，不降级、不切根", async () => {
    const h = harness();
    const plain = tempDir("neo-85-plain-");
    h.cfg.cwd = plain;
    const out = await run(h, "/worktree create feat");
    expect(out).toContain("不是 git 仓库");
    expect(h.cfg.cwd).toBe(plain);
    expect(existsSync(join(plain, ".neo"))).toBe(false);
  });

  test("换根清空额外根：列出被清掉的根并用 #85 口径句", async () => {
    const h = harness();
    await run(h, `/add-dir ${h.ws.shared}`);
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    const out = await run(h, "/worktree create feat");
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
    expect(out).toContain("已清空本会话额外工作根 1 个");
    expect(out).toContain(h.ws.shared);
    expect(out).toContain("（换主根会清空额外根；/cd - 与 /worktree exit 都不恢复）");
  });

  test("create/enter/exit 都更新 /cd - 的上一根；随后 /cd - 回到树里不恢复隔离绑定", async () => {
    const h = harness();
    await run(h, "/worktree create feat");
    expect(h.previousCwd.get()).toBe(h.ws.repo);
    await run(h, "/worktree exit");
    expect(h.previousCwd.get()).toBe(realpathSync(wt(h, "feat")));
    await run(h, "/cd -");
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "feat")));
    expect(h.meta.worktree).toBeUndefined();
    const out = await run(h, "/worktree exit");
    expect(out).toContain("当前不在托管 worktree 会话里");
  });

  test("隔离态下再 create：origin 不变，上一棵留在磁盘；新树从主检出 HEAD 分出，不带当前树的提交与脏改动", async () => {
    const h = harness();
    await run(h, "/worktree create first");
    const first = realpathSync(wt(h, "first"));
    put(first, "only-in-first.txt", "committed in first\n");
    git(first, "add", "-A");
    git(first, "commit", "-q", "-m", "first-only");
    put(first, "dirty-in-first.txt", "dirty\n");
    await run(h, "/worktree create second");
    const second = realpathSync(wt(h, "second"));
    expect(h.cfg.cwd).toBe(second);
    expect(h.meta.worktree?.name).toBe("second");
    expect(h.meta.worktree?.origin).toBe(h.ws.repo);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(join(second, "only-in-first.txt"))).toBe(false);
    expect(existsSync(join(second, "dirty-in-first.txt"))).toBe(false);
    expect(existsSync(join(second, "README.md"))).toBe(true);
    await run(h, "/worktree exit");
    expect(h.cfg.cwd).toBe(h.ws.repo);
  });
});

/* ------------------------------------------------------------------ */
/* unchanged                                                           */
/* ------------------------------------------------------------------ */

describe("unchanged：当前主根已在目标树内", () => {
  test("在树根或其子目录里对同名树 enter/create：不移动、不清空额外根、不刷新", async () => {
    const h = harness();
    await run(h, "/worktree create feat");
    const tree = realpathSync(wt(h, "feat"));
    await run(h, "/cd sub");
    expect(h.cfg.cwd).toBe(join(tree, "sub"));
    await run(h, `/add-dir ${h.ws.shared}`);
    const persistBefore = h.persistCalls;
    const refreshBefore = h.refreshCalls;
    for (const line of ["/worktree enter feat", "/worktree create feat"]) {
      const out = await run(h, line);
      expect(out).toContain("未移动");
      expect(h.cfg.cwd).toBe(join(tree, "sub"));
      expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    }
    expect(h.persistCalls).toBe(persistBefore);
    expect(h.refreshCalls).toBe(refreshBefore);
  });

  test("enter_worktree 工具同样 unchanged（canonicalize 判断，软链写法也算在树内）", async () => {
    const h = harness();
    const mod = await sw();
    await run(h, "/worktree create feat");
    const alias = join(h.ws.top, "alias-feat");
    symlinkSync(realpathSync(wt(h, "feat")), alias);
    h.cfg.cwd = alias;
    const r = await mod.enterSessionWorktree("feat", "create", h.deps() as never, { fromTool: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unchanged).toBe(true);
    expect(h.cfg.cwd).toBe(alias);
  });
});

/* ------------------------------------------------------------------ */
/* /worktree enter / exit / list / remove / 提示                        */
/* ------------------------------------------------------------------ */

describe("/worktree enter <name>", () => {
  test("只进入已有托管树", async () => {
    const h = harness();
    expect(ensureWorktree(h.ws.repo, "have").ok).toBe(true);
    const out = await run(h, "/worktree enter have");
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "have")));
    expect(out).toContain("have");
    expect(h.meta.worktree?.name).toBe("have");
  });

  test("不存在：报错、不创建、不切根", async () => {
    const h = harness();
    const out = await run(h, "/worktree enter ghost");
    expect(out).toContain("ghost");
    expect(existsSync(wt(h, "ghost"))).toBe(false);
    expect(h.cfg.cwd).toBe(h.ws.repo);
  });

  test("不是托管项（目录在但没登记）：报错、不切根", async () => {
    const h = harness();
    mkdirSync(wt(h, "fake"), { recursive: true });
    await run(h, "/worktree enter fake");
    expect(h.cfg.cwd).toBe(h.ws.repo);
    expect(h.meta.worktree).toBeUndefined();
  });
});

describe("/worktree exit", () => {
  test("从会话中进入：退回 origin，不删树、不删分支，清除隔离绑定", async () => {
    const h = harness();
    await run(h, "/worktree create feat");
    const out = await run(h, "/worktree exit");
    expect(h.cfg.cwd).toBe(h.ws.repo);
    expect(h.meta.worktree).toBeUndefined();
    expect(loadSession(h.meta.id)?.meta.worktree).toBeUndefined();
    expect(existsSync(wt(h, "feat"))).toBe(true);
    expect(git(h.ws.repo, "branch", "--list", "neo/feat").trim()).not.toBe("");
    expect(out).toContain("feat");
  });

  test("从 --worktree 启动：origin 是 mainRoot，exit 回到主检出", async () => {
    const h = harness();
    const mod = await sw();
    const ensured = ensureWorktree(h.ws.repo, "boot");
    expect(ensured.ok).toBe(true);
    const tree = realpathSync(wt(h, "boot"));
    h.cfg.cwd = tree;
    h.meta.cwd = tree;
    h.meta.worktree = mod.startupWorktreeBinding("boot", tree, h.ws.repo);
    expect(h.meta.worktree.origin).toBe(h.ws.repo);
    await run(h, "/worktree exit");
    expect(h.cfg.cwd).toBe(h.ws.repo);
  });

  test("非隔离态拒绝，文案按合同", async () => {
    const h = harness();
    const out = await run(h, "/worktree exit");
    expect(out).toContain(
      "当前不在托管 worktree 会话里（启动时未用 --worktree，也未 /worktree create|enter；/cd 到 worktree 路径不算进入）",
    );
  });

  test("origin 目录不在了：报错、不切根", async () => {
    const h = harness();
    await run(h, "/worktree create feat");
    h.meta.worktree = { ...h.meta.worktree!, origin: join(h.ws.top, "vanished") };
    await run(h, "/worktree exit");
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "feat")));
    expect(h.meta.worktree?.name).toBe("feat");
  });

  test("exit 不恢复进入前的额外根", async () => {
    const h = harness();
    await run(h, `/add-dir ${h.ws.shared}`);
    await run(h, "/worktree create feat");
    await run(h, "/worktree exit");
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });
});

describe("/worktree 提示、list / remove 沿用 #9", () => {
  test("无子命令与未知子命令：提示可用子命令", async () => {
    const h = harness();
    const hint = "可用：list | create <name> | enter <name> | exit | remove <name> [--force]";
    expect(await run(h, "/worktree")).toContain(hint);
    expect(await run(h, "/worktree bogus")).toContain(hint);
  });

  test("list 仍列出托管树；remove 后分支保留", async () => {
    const h = harness();
    expect(ensureWorktree(h.ws.repo, "gone").ok).toBe(true);
    expect(await run(h, "/worktree list")).toContain("gone");
    await run(h, "/worktree remove gone");
    expect(existsSync(wt(h, "gone"))).toBe(false);
    expect(git(h.ws.repo, "branch", "--list", "neo/gone").trim()).not.toBe("");
  });

  test("不能删自己脚下的树（进入后）", async () => {
    const h = harness();
    await run(h, "/worktree create feat");
    const out = await run(h, "/worktree remove feat --force");
    expect(out).toContain("不能删除自己脚下");
    expect(existsSync(wt(h, "feat"))).toBe(true);
  });

  test("忙碌时 /worktree 不是可注入的中轮转向（#66）", () => {
    expect(isSteerable({ text: "/worktree create x", attachments: [], origin: "user" } as never)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* /cd 与隔离绑定                                                       */
/* ------------------------------------------------------------------ */

describe("/cd 与隔离绑定（#69）", () => {
  test("隔离态下 /cd 到树内（子目录）保持绑定", async () => {
    const h = harness();
    await run(h, "/worktree create feat");
    await run(h, "/cd sub");
    expect(h.meta.worktree?.name).toBe("feat");
    await run(h, "/worktree exit");
    expect(h.cfg.cwd).toBe(h.ws.repo);
  });

  test("/cd 到树外：清除绑定（不自动跳回 origin）并按 #63 清空额外根", async () => {
    const h = harness();
    await run(h, "/worktree create feat");
    await run(h, `/add-dir ${h.ws.shared}`);
    await run(h, `/cd ${h.ws.other}`);
    expect(h.cfg.cwd).toBe(h.ws.other);
    expect(h.meta.worktree).toBeUndefined();
    expect(loadSession(h.meta.id)?.meta.worktree).toBeUndefined();
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });

  test("/cd 到某个 .neo/worktrees/<name> 只是普通换根，不建立绑定", async () => {
    const h = harness();
    expect(ensureWorktree(h.ws.repo, "plain").ok).toBe(true);
    await run(h, `/cd ${wt(h, "plain")}`);
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "plain")));
    expect(h.meta.worktree).toBeUndefined();
    expect(await run(h, "/worktree exit")).toContain("当前不在托管 worktree 会话里");
  });
});

/* ------------------------------------------------------------------ */
/* 忙碌闸门                                                             */
/* ------------------------------------------------------------------ */

describe("忙碌闸门", () => {
  test("斜杠：本轮进行中拒绝；工具：跳过「本轮正在进行」", async () => {
    const mod = await sw();
    expect(mod.worktreeSwitchBusyReason({ fromTool: false, turnActive: true })).not.toBeNull();
    expect(mod.worktreeSwitchBusyReason({ fromTool: true, turnActive: true })).toBeNull();
  });

  test("有后台子代理在跑时仍允许（斜杠与工具）；wiki 在跑时仍拒绝", async () => {
    const mod = await sw();
    const tasks = [{ status: "running", kind: "task" }];
    expect(mod.worktreeSwitchBusyReason({ fromTool: false, backgroundTasks: tasks })).toBeNull();
    expect(mod.worktreeSwitchBusyReason({ fromTool: true, backgroundTasks: tasks })).toBeNull();
    expect(mod.worktreeSwitchBusyReason({ fromTool: false, wikiRunning: true })).not.toBeNull();
    expect(mod.worktreeSwitchBusyReason({ fromTool: true, wikiRunning: true })).not.toBeNull();
    expect(
      mod.worktreeSwitchBusyReason({ fromTool: true, backgroundTasks: [{ status: "running", kind: "wiki" }] }),
    ).not.toBeNull();
  });

  test("集成：后台子代理在跑时 /worktree create 成功；/cd 闸门不变（仍拒绝）", async () => {
    const h = harness();
    const tasks = { list: () => [{ id: "bg-1", status: "running", kind: "task" }], cancel: () => 0 };
    await run(h, "/worktree create feat", { tasks } as unknown as Partial<CommandContext>);
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "feat")));
    const out = await run(h, `/cd ${h.ws.other}`, { tasks } as unknown as Partial<CommandContext>);
    expect(out).toContain("后台子代理任务");
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "feat")));
  });

  test("集成：本轮进行中 /worktree create 被拒、不建树", async () => {
    const h = harness();
    await run(h, "/worktree create feat", { turnActive: true } as Partial<CommandContext>);
    expect(existsSync(wt(h, "feat"))).toBe(false);
    expect(h.cfg.cwd).toBe(h.ws.repo);
  });
});

/* ------------------------------------------------------------------ */
/* 模型工具                                                             */
/* ------------------------------------------------------------------ */

function toolCtx(cfg: Config, approve: ToolCtx["approve"] = async () => true): ToolCtx {
  return { cfg, approve } as unknown as ToolCtx;
}

async function tools(h: Harness, over: Record<string, unknown> = {}): Promise<Record<string, ToolImpl>> {
  const mod = await sw();
  const list = mod.makeWorktreeTools({ deps: () => h.deps(over) as never });
  return Object.fromEntries(list.map((t: ToolImpl) => [t.spec.function.name, t]));
}

describe("enter_worktree / exit_worktree", () => {
  test("蛇形工具名；enter 必填 name、exit 无参数；都标 parallelizable=false", async () => {
    const h = harness();
    const t = await tools(h);
    expect(Object.keys(t).sort()).toEqual(["enter_worktree", "exit_worktree"]);
    const enter = t["enter_worktree"]!;
    expect((enter.spec.function.parameters as { required?: string[] }).required).toEqual(["name"]);
    const exitProps = (t["exit_worktree"]!.spec.function.parameters as { properties?: object }).properties ?? {};
    expect(Object.keys(exitProps)).toEqual([]);
    expect(enter.parallelizable).toBe(false);
    expect(t["exit_worktree"]!.parallelizable).toBe(false);
  });

  test("与斜杠同语义：enter_worktree 新建并切根，返回前已完成刷新与额外根清空", async () => {
    const h = harness();
    h.cfg.additionalDirs = [h.ws.shared];
    h.meta.additionalDirs = [h.ws.shared];
    const t = await tools(h);
    const out = String(await t["enter_worktree"]!.execute({ name: "feat" }, toolCtx(h.cfg)));
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "feat")));
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
    expect(h.refreshCalls).toBeGreaterThan(0);
    expect(h.fileIndexRoots?.cwd).toBe(realpathSync(wt(h, "feat")));
    expect(out).toContain("已创建");
    expect(out).toContain(h.ws.shared);
    expect(h.meta.worktree?.name).toBe("feat");
    const back = String(await t["exit_worktree"]!.execute({}, toolCtx(h.cfg)));
    expect(h.cfg.cwd).toBe(h.ws.repo);
    expect(back).toContain("feat");
    expect(existsSync(wt(h, "feat"))).toBe(true);
  });

  test("不提供省略 name 自动起名：缺 name 报错、不建树", async () => {
    const h = harness();
    const t = await tools(h);
    await expect(Promise.resolve().then(() => t["enter_worktree"]!.execute({}, toolCtx(h.cfg)))).rejects.toThrow();
    expect(existsSync(join(h.ws.repo, ".neo", "worktrees"))).toBe(false);
  });

  test("失败不切根、不刷新、不清空额外根（非法名 / 非 git）", async () => {
    const h = harness();
    h.cfg.additionalDirs = [h.ws.shared];
    const t = await tools(h);
    await expect(Promise.resolve().then(() => t["enter_worktree"]!.execute({ name: "../x" }, toolCtx(h.cfg)))).rejects.toThrow();
    expect(h.cfg.cwd).toBe(h.ws.repo);
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    expect(h.refreshCalls).toBe(0);
    const plain = tempDir("neo-85-plain-");
    h.cfg.cwd = plain;
    await expect(Promise.resolve().then(() => t["enter_worktree"]!.execute({ name: "ok" }, toolCtx(h.cfg)))).rejects.toThrow(/不是 git 仓库/);
    expect(h.cfg.cwd).toBe(plain);
  });

  test("exit_worktree 非隔离态拒绝（同斜杠文案）", async () => {
    const h = harness();
    const t = await tools(h);
    await expect(Promise.resolve().then(() => t["exit_worktree"]!.execute({}, toolCtx(h.cfg)))).rejects.toThrow(/当前不在托管 worktree 会话里/);
  });

  test("工具跳过本轮进行中；有后台子代理在跑仍可用；wiki 在跑拒绝", async () => {
    const h = harness();
    const busy = await tools(h, { turnActive: true, backgroundTasks: [{ status: "running", kind: "task" }] });
    await busy["enter_worktree"]!.execute({ name: "feat" }, toolCtx(h.cfg));
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "feat")));
    const wiki = await tools(h, { wikiRunning: true });
    await expect(Promise.resolve().then(() => wiki["exit_worktree"]!.execute({}, toolCtx(h.cfg)))).rejects.toThrow();
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "feat")));
  });

  test("子代理不可用这两个工具（排除表 + dispatch 拒绝）", async () => {
    const h = harness();
    expect(TOOL_NAMES_EXCLUDED_FOR_SUBAGENT).toContain("enter_worktree");
    expect(TOOL_NAMES_EXCLUDED_FOR_SUBAGENT).toContain("exit_worktree");
    const t = await tools(h);
    for (const impl of Object.values(t)) unregisters.push(registerTool(impl));
    expect(isParallelizable("enter_worktree")).toBe(false);
    expect(isParallelizable("exit_worktree")).toBe(false);
    const r = await dispatch("enter_worktree", JSON.stringify({ name: "x" }), {
      ...toolCtx(h.cfg),
      isSubagent: true,
    } as ToolCtx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("未知工具");
    expect(existsSync(wt(h, "x"))).toBe(false);
  });

  test("-p 注册这两个工具（sessionStart 共用装配）；ACP 不注册", () => {
    const start = readFileSync(join(import.meta.dir, "../src/cli/sessionStart.ts"), "utf8");
    expect(start).toContain("makeWorktreeTools(");
    const acp = readFileSync(join(import.meta.dir, "../src/acp/session.ts"), "utf8");
    expect(acp).not.toContain("makeWorktreeTools");
    expect(acp).not.toContain("enter_worktree");
  });
});

/* ------------------------------------------------------------------ */
/* 审批归类                                                             */
/* ------------------------------------------------------------------ */

describe("审批归类", () => {
  test("enter_worktree 实际新建：走写操作审批；拒绝则不建树、不切根", async () => {
    const h = harness();
    const asked: string[] = [];
    const t = await tools(h);
    const deny: ToolCtx["approve"] = async (tool) => {
      asked.push(tool);
      return false;
    };
    await expect(Promise.resolve().then(() => t["enter_worktree"]!.execute({ name: "feat" }, toolCtx(h.cfg, deny)))).rejects.toThrow();
    expect(asked).toEqual(["enter_worktree"]);
    expect(existsSync(wt(h, "feat"))).toBe(false);
    expect(h.cfg.cwd).toBe(h.ws.repo);
  });

  test("进入已有树（created=false）与 exit_worktree：不审批", async () => {
    const h = harness();
    expect(ensureWorktree(h.ws.repo, "have").ok).toBe(true);
    const asked: string[] = [];
    const spy: ToolCtx["approve"] = async (tool) => {
      asked.push(tool);
      return false;
    };
    const t = await tools(h);
    await t["enter_worktree"]!.execute({ name: "have" }, toolCtx(h.cfg, spy));
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "have")));
    await t["exit_worktree"]!.execute({}, toolCtx(h.cfg, spy));
    expect(h.cfg.cwd).toBe(h.ws.repo);
    expect(asked).toEqual([]);
  });

  test("用户亲自打的斜杠不审批（ask 模式下也不弹确认）", async () => {
    const h = harness();
    let confirms = 0;
    const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
    cap.ui.confirm = async () => {
      confirms += 1;
      return false;
    };
    await dispatchCommand("/worktree create feat", h.ctx(cap.ui));
    expect(confirms).toBe(0);
    expect(h.cfg.cwd).toBe(realpathSync(wt(h, "feat")));
  });
});

/* ------------------------------------------------------------------ */
/* 续聊                                                                 */
/* ------------------------------------------------------------------ */

describe("续聊恢复隔离（#69 窄例外）", () => {
  function recordIn(h: Harness, name: string): { tree: string; binding: { name: string; origin: string; path: string } } {
    expect(ensureWorktree(h.ws.repo, name).ok).toBe(true);
    const tree = realpathSync(wt(h, name));
    return { tree, binding: { name, origin: h.ws.repo, path: tree } };
  }

  test("三个条件都满足：回到记录的树并打规定文案（启动目录是主检出）", async () => {
    const h = harness();
    const mod = await sw();
    const { tree, binding } = recordIn(h, "feat");
    const r = mod.settleResumeWorktree({ recorded: binding, recordedCwd: tree, startCwd: h.ws.repo, explicit: null });
    expect(r.cwd).toBe(tree);
    expect(r.binding?.name).toBe("feat");
    expect(r.notice).toBe("已回到 worktree feat（续聊恢复隔离）");
  });

  test("启动目录是同仓另一棵托管树、或主检出子目录：同样算同一个仓", async () => {
    const h = harness();
    const mod = await sw();
    const { tree, binding } = recordIn(h, "feat");
    const { tree: other } = recordIn(h, "other");
    expect(mod.settleResumeWorktree({ recorded: binding, recordedCwd: tree, startCwd: other, explicit: null }).cwd).toBe(tree);
    expect(
      mod.settleResumeWorktree({ recorded: binding, recordedCwd: tree, startCwd: join(h.ws.repo, "sub"), explicit: null }).cwd,
    ).toBe(tree);
  });

  test("记录在树的子目录：回到那个子目录（最终主根 = 记录主根，额外根可按 #63 恢复）", async () => {
    const h = harness();
    const mod = await sw();
    const { tree, binding } = recordIn(h, "feat");
    const r = mod.settleResumeWorktree({ recorded: binding, recordedCwd: join(tree, "sub"), startCwd: h.ws.repo, explicit: null });
    expect(r.cwd).toBe(join(tree, "sub"));
  });

  test("树不在了：规定文案，清除绑定，在启动目录继续", async () => {
    const h = harness();
    const mod = await sw();
    const { tree, binding } = recordIn(h, "feat");
    git(h.ws.repo, "worktree", "remove", "--force", tree);
    const r = mod.settleResumeWorktree({ recorded: binding, recordedCwd: tree, startCwd: h.ws.repo, explicit: null });
    expect(r.cwd).toBe(h.ws.repo);
    expect(r.binding).toBeUndefined();
    expect(r.notice).toBe(`会话记录的 worktree feat（${tree}）已不存在，已清除隔离绑定，在 ${h.ws.repo} 继续`);
  });

  test("启动目录不属于同一个仓：规定文案，清除绑定，在启动目录继续", async () => {
    const h = harness();
    const mod = await sw();
    const { tree, binding } = recordIn(h, "feat");
    const r = mod.settleResumeWorktree({ recorded: binding, recordedCwd: tree, startCwd: h.ws.other, explicit: null });
    expect(r.cwd).toBe(h.ws.other);
    expect(r.binding).toBeUndefined();
    expect(r.notice).toBe(`会话记录在 worktree feat，本次按 ${h.ws.other} 运行，需要请 /worktree enter feat`);
  });

  test("记录里没有隔离绑定：按 #69 在启动目录运行，无提示", async () => {
    const h = harness();
    const mod = await sw();
    const r = mod.settleResumeWorktree({ recorded: undefined, recordedCwd: h.ws.other, startCwd: h.ws.repo, explicit: null });
    expect(r.cwd).toBe(h.ws.repo);
    expect(r.binding).toBeUndefined();
    expect(r.notice).toBeNull();
  });

  test("显式 --resume --worktree：不走自动回到记录树的例外；绑定改为本次 --worktree（origin 仍为 mainRoot）", async () => {
    const h = harness();
    const mod = await sw();
    const { tree, binding } = recordIn(h, "feat");
    const { tree: explicitTree } = recordIn(h, "explicit");
    const explicit = mod.startupWorktreeBinding("explicit", explicitTree, h.ws.repo);
    const r = mod.settleResumeWorktree({ recorded: binding, recordedCwd: tree, startCwd: explicitTree, explicit });
    expect(r.cwd).toBe(explicitTree);
    expect(r.binding).toEqual(explicit);
    expect(r.notice).toBeNull();
  });

  test("比较走 canonicalize：记录与启动目录用软链写法也成立", async () => {
    const h = harness();
    const mod = await sw();
    const { tree, binding } = recordIn(h, "feat");
    const alias = join(h.ws.top, "alias-repo");
    symlinkSync(h.ws.repo, alias);
    const r = mod.settleResumeWorktree({ recorded: binding, recordedCwd: tree, startCwd: alias, explicit: null });
    expect(r.cwd).toBe(tree);
  });

  test("bootstrap 接线：续聊前结算 worktree，显式 --worktree 不走例外", () => {
    const src = readFileSync(join(import.meta.dir, "../src/cli/bootstrap.ts"), "utf8");
    expect(src).toContain("settleResumeWorktree(");
    expect(src).toContain("startupWorktreeBinding(");
  });

  test("#69 文档注明续聊恢复隔离这个窄例外", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/cd-workdir-prd.md"), "utf8");
    expect(doc).toContain("续聊恢复隔离");
  });
});

/* ------------------------------------------------------------------ */
/* /fork（#65）                                                         */
/* ------------------------------------------------------------------ */

describe("/fork 与隔离绑定", () => {
  test("/fork 不新建树，拷贝隔离绑定，输出含「与父会话共用 worktree <name>」", async () => {
    const h = harness();
    await run(h, "/worktree create feat");
    const before = git(h.ws.repo, "worktree", "list");
    const oldId = h.meta.id;
    const ctxOver = {
      agent: {
        messages: h.messages,
        refreshSystemPrompt: () => {},
        runSessionStart: async () => {},
        opt: {},
        activeNestedAgents: [],
      },
      memory: { setSessionId: () => {}, setCwd: () => {} },
    } as unknown as Partial<CommandContext>;
    const out = await run(h, "/fork", ctxOver);
    expect(h.meta.id).not.toBe(oldId);
    expect(h.meta.worktree?.name).toBe("feat");
    expect(h.meta.worktree?.origin).toBe(h.ws.repo);
    expect(out).toContain("与父会话共用 worktree feat");
    expect(git(h.ws.repo, "worktree", "list")).toBe(before);
  });

  test("forkSession：cwd 比较先 canonicalize（软链写法的同一主根也拷贝额外根与绑定）", () => {
    const ws = workspace();
    const alias = join(ws.top, "alias");
    symlinkSync(ws.repo, alias);
    const parent = createSession("m", alias).meta;
    parent.additionalDirs = [ws.shared];
    parent.worktree = { name: "feat", origin: ws.repo, path: ws.repo };
    const child = forkSession(parent, [], "m", ws.repo);
    expect(child.meta.additionalDirs).toEqual([ws.shared]);
    expect(child.meta.worktree?.name).toBe("feat");
  });

  test("/help 写明 fork 在隔离态时两个会话会在同一棵树里写", () => {
    expect(helpText()).toContain("两个会话会在同一棵树里写");
  });
});

/* ------------------------------------------------------------------ */
/* .worktreeinclude                                                     */
/* ------------------------------------------------------------------ */

describe(".worktreeinclude", () => {
  test("新建时按 git 忽略判定拷「匹配且被 gitignore」的文件；已跟踪、未被忽略的不拷", async () => {
    const h = harness();
    put(h.ws.repo, ".worktreeinclude", ".env\n*.local\nREADME.md\nnotes.txt\n");
    put(h.ws.repo, ".env", "SECRET=1\n");
    put(h.ws.repo, "conf/app.local", "LOCAL\n");
    put(h.ws.repo, "notes.txt", "untracked but not ignored\n");
    await run(h, "/worktree create feat");
    const tree = realpathSync(wt(h, "feat"));
    expect(readFileSync(join(tree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(readFileSync(join(tree, "conf/app.local"), "utf8")).toBe("LOCAL\n");
    expect(existsSync(join(tree, "notes.txt"))).toBe(false);
    expect(readFileSync(join(tree, "README.md"), "utf8")).toBe("MAIN-README\n");
  });

  test("源目录是主检出：在另一棵树里 create 仍从 mainRoot 拷", async () => {
    const h = harness();
    put(h.ws.repo, ".worktreeinclude", ".env\n");
    put(h.ws.repo, ".env", "FROM-MAIN\n");
    await run(h, "/worktree create first");
    put(realpathSync(wt(h, "first")), ".env", "FROM-FIRST\n");
    await run(h, "/worktree create second");
    expect(readFileSync(join(realpathSync(wt(h, "second")), ".env"), "utf8")).toBe("FROM-MAIN\n");
  });

  test("复用已有树不覆盖已有文件；缺 .worktreeinclude 则跳过", async () => {
    const h = harness();
    expect(ensureWorktree(h.ws.repo, "have").ok).toBe(true);
    put(realpathSync(wt(h, "have")), ".env", "KEEP\n");
    put(h.ws.repo, ".worktreeinclude", ".env\n");
    put(h.ws.repo, ".env", "NEW\n");
    await run(h, "/worktree create have");
    expect(readFileSync(join(realpathSync(wt(h, "have")), ".env"), "utf8")).toBe("KEEP\n");
    const h2 = harness();
    put(h2.ws.repo, ".env", "X\n");
    await run(h2, "/worktree create nofile");
    expect(existsSync(join(realpathSync(wt(h2, "nofile")), ".env"))).toBe(false);
  });

  test("某个文件拷贝失败：警告该路径，不回滚已建好的 worktree", async () => {
    const h = harness();
    const mod = await inc();
    put(h.ws.repo, ".worktreeinclude", ".env\n*.local\n");
    put(h.ws.repo, ".env", "A\n");
    put(h.ws.repo, "b.local", "B\n");
    expect(ensureWorktree(h.ws.repo, "cp").ok).toBe(true);
    const dest = realpathSync(wt(h, "cp"));
    const r = mod.copyWorktreeInclude(h.ws.repo, dest, {
      copy: (src: string, dst: string) => {
        if (src.endsWith(".env")) throw new Error("EACCES");
        writeFileSync(dst, readFileSync(src));
      },
    });
    expect(r.warnings.join("\n")).toContain(".env");
    expect(r.copied).toEqual(["b.local"]);
    expect(existsSync(dest)).toBe(true);
  });

  test("--safe-mode 下照常拷贝", async () => {
    const h = harness();
    h.cfg.safeMode = true;
    put(h.ws.repo, ".worktreeinclude", ".env\n");
    put(h.ws.repo, ".env", "SAFE\n");
    await run(h, "/worktree create feat");
    expect(readFileSync(join(realpathSync(wt(h, "feat")), ".env"), "utf8")).toBe("SAFE\n");
  });

  test("启动 --worktree 新建同样处理（bootstrap 接线）", () => {
    const src = readFileSync(join(import.meta.dir, "../src/cli/bootstrap.ts"), "utf8");
    expect(src).toContain("copyWorktreeInclude(");
  });
});

/* ------------------------------------------------------------------ */
/* 补全、/context、文案                                                  */
/* ------------------------------------------------------------------ */

describe("补全与 /context", () => {
  test("create / enter / remove 补托管名字；enter / remove 只补已有项", async () => {
    const h = harness();
    const mod = await comp();
    expect(ensureWorktree(h.ws.repo, "alpha").ok).toBe(true);
    expect(ensureWorktree(h.ws.repo, "beta").ok).toBe(true);
    for (const sub of ["create", "enter", "remove"]) {
      const line = `/worktree ${sub} a`;
      const r = mod.completeWorktreeLine(line, line.length, h.ws.repo);
      expect(r?.matches).toEqual(["alpha"]);
    }
    const none = mod.completeWorktreeLine("/worktree enter zz", 18, h.ws.repo);
    expect(none?.matches).toEqual([]);
    expect(mod.completeWorktreeLine("/cd a", 5, h.ws.repo)).toBeNull();
  });

  test("/context 在隔离态列出当前 worktree 名与 origin（报告函数 + 处理器接线）", async () => {
    const h = harness();
    const mod = await sw();
    expect(mod.worktreeContextLines(h.meta)).toEqual([]);
    await run(h, "/worktree create feat");
    const lines = mod.worktreeContextLines(h.meta).join("\n");
    expect(lines).toContain("feat");
    expect(lines).toContain(h.ws.repo);
    const src = readFileSync(join(import.meta.dir, "../src/cli/commandSession.ts"), "utf8");
    expect(src).toContain("worktreeContextLines(");
  });
});

describe("文案从未来时改为现在时，/help 与 README 对照段", () => {
  test("help：/worktree 子命令与建树基线句、对照要点", () => {
    const text = helpText();
    expect(text).not.toContain("创建走命令行 --worktree <name>");
    for (const s of [
      "/worktree create <name>",
      "/worktree enter <name>",
      "/worktree exit",
      "enter_worktree",
      "exit_worktree",
      "主检出当前的 HEAD",
      "isolation: worktree",
      ".worktreeinclude",
    ]) {
      expect(text).toContain(s);
    }
  });

  test("commands.ts 描述更新", () => {
    const entry = COMMANDS.find((c) => c.name === "worktree");
    expect(entry?.description).not.toContain("创建用 --worktree");
    expect(entry?.description).toContain("create");
    expect(entry?.description).toContain("exit");
  });

  test("README：去掉「本片不含子代理自动 isolation、.worktreeinclude」，写入与 Claude Code 的对照段", () => {
    const readme = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
    expect(readme).not.toContain("本片不含子代理自动 isolation");
    for (const s of [
      "/worktree create",
      "enter_worktree",
      "EnterWorktree",
      "ExitWorktree",
      "永不删树",
      "主检出当前 HEAD",
      "isolation: worktree",
      ".worktreeinclude",
      "2.1.239",
      "两个会话会在同一棵树里写",
    ]) {
      expect(readme).toContain(s);
    }
  });
});
