/**
 * issue #63：--add-dir / /add-dir（额外工作根）。按已签合同 /workspace/neo-63-slice-final.md 逐条编码。
 *
 * 覆盖：启动参数解析与校验、位置参数规则、ACP 冲突、/add-dir 加入/列出/--remove/未知选项/部分失败、
 * 「已在范围内」文案与 skills_extra_paths 提示、拒绝文件系统根允许 $HOME、/cd 清空口径、续聊/fork 拷贝、
 * 子代理快照、@ 索引 / glob / grep / 目录树 / 仓库地图多根、#54 每根永久段与最具体根、safe-mode、
 * 触达路径识别额外根、#66 斜杠不注入、文案现在时与对照段、不从额外根加载配置。
 *
 * 运行：bun test tests/add-dir-63.test.ts
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { parseArgs } from "../src/cli/args.ts";
import { acpUsageError } from "../src/acp/entry.ts";
import {
  ADD_DIR_HINT,
  additionalRootsReport,
  isFilesystemRoot,
  resolveAddDirPath,
  settleSessionAdditionalDirs,
  startupAddDirCheck,
  workRoots,
} from "../src/cli/additionalDirs.ts";
import { changeSessionCwd, completeCdLine, makePreviousCwdSlot } from "../src/cli/cdWorkdir.ts";
import { dispatchCommand, type CommandContext } from "../src/cli/commands.ts";
import { forkSession } from "../src/cli/forkSession.ts";
import { helpText } from "../src/cli/help.ts";
import { isSteerable } from "../src/cli/midTurnSteer.ts";
import {
  collectNestedInstructionFiles,
  composePermanentMemory,
  loadSessionInstructionMemory,
} from "../src/cli/nestedAgents.ts";
import type { Config } from "../src/config.ts";
import { COMMANDS, knownSlashCommand } from "../src/input/commands.ts";
import { FileIndex } from "../src/input/fileIndex.ts";
import type { Message } from "../src/llm.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import { buildRepoMap, resetRepoMapCache } from "../src/prompt/repoMap.ts";
import { extractTouchedPaths } from "../src/rules/index.ts";
import { createSession, loadSession, saveSession, type SessionMeta } from "../src/session.ts";
import { discoverSkills } from "../src/skills.ts";
import { discoverAgents } from "../src/agents.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import { captureConsole } from "./helpers.ts";

const made: string[] = [];
const prevSessionsDir = process.env["NEO_SESSIONS_DIR"];
const prevMailboxDir = process.env["NEO_MAILBOX_DIR"];
const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), "neo-63-sessions-")));
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

beforeEach(() => resetRepoMapCache());

function tempDir(prefix = "neo-63-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

function put(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function fakeGit(dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

function makeCfg(cwd: string, over: Partial<Config> = {}): Config {
  return {
    cwd,
    model: "m-63",
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

/** 一个主根 + 兄弟目录的工作区布局。 */
function workspace(): { top: string; main: string; shared: string; lib: string } {
  const top = tempDir("neo-63-ws-");
  const main = join(top, "app");
  const shared = join(top, "shared");
  const lib = join(top, "lib");
  for (const d of [main, shared, lib]) mkdirSync(d, { recursive: true });
  return { top, main, shared, lib };
}

/* ------------------------------------------------------------------ */
/* 启动：--add-dir 解析                                                */
/* ------------------------------------------------------------------ */

describe("启动 --add-dir：句法", () => {
  test("空格形式与 = 形式都认；每次一个、可重复，按出现顺序", () => {
    const a = parseArgs(["--add-dir", "../apps", "--add-dir=../lib"]);
    expect(a.addDirs).toEqual(["../apps", "../lib"]);
    expect(a.addDirError).toBeNull();
    expect(a.rest).toEqual([]);
  });

  test("一个 --add-dir 只吃一个路径：多余的进入位置参数", () => {
    const a = parseArgs(["--add-dir", "../a", "../b"]);
    expect(a.addDirs).toEqual(["../a"]);
    expect(a.rest).toEqual(["../b"]);
  });

  test("缺值、空值、下一个参数以 - 开头 都是用法错误", () => {
    expect(parseArgs(["--add-dir"]).addDirError).toMatch(/--add-dir/);
    expect(parseArgs(["--add-dir", ""]).addDirError).toMatch(/--add-dir/);
    expect(parseArgs(["--add-dir", "   "]).addDirError).toMatch(/--add-dir/);
    expect(parseArgs(["--add-dir="]).addDirError).toMatch(/--add-dir/);
    const dash = parseArgs(["--add-dir", "-x"]);
    expect(dash.addDirError).toMatch(/\.\/-x/);
    // 以 - 开头的下一个参数不被吞成路径
    expect(dash.addDirs).toEqual([]);
    expect(parseArgs(["--add-dir", "--plan"]).mode).toBe("plan");
  });

  test("目录名真以 - 开头写成 ./-x 可以", () => {
    const a = parseArgs(["--add-dir", "./-x"]);
    expect(a.addDirs).toEqual(["./-x"]);
    expect(a.addDirError).toBeNull();
  });
});

describe("启动 --add-dir：路径校验（startupAddDirCheck）", () => {
  test("相对路径相对进程启动 cwd 解析，不相对 -C 的目标", () => {
    const ws = workspace();
    mkdirSync(join(ws.main, "lib"), { recursive: true }); // -C 目标下的同名目录不该被选中
    const args = parseArgs(["-C", ws.main, "--add-dir", "lib"]);
    const r = startupAddDirCheck(args, { stdinIsTTY: true, processCwd: ws.top });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dirs).toEqual([ws.lib]);
  });

  test("~ 展开", () => {
    const home = tempDir("neo-63-home-");
    mkdirSync(join(home, "proj"), { recursive: true });
    const r = startupAddDirCheck(parseArgs(["--add-dir", "~/proj"]), { stdinIsTTY: true, processCwd: tmpdir(), home });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dirs).toEqual([join(home, "proj")]);
  });

  test("symlink 到目录可以，按 realpath 记并去重", () => {
    const ws = workspace();
    symlinkSync(ws.lib, join(ws.top, "lib-link"));
    const r = startupAddDirCheck(parseArgs(["--add-dir", "lib-link", "--add-dir", "lib"]), {
      stdinIsTTY: true,
      processCwd: ws.top,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dirs).toEqual([ws.lib]);
  });

  test("不存在 / 不是目录 / 文件系统根：明确报错，不静默跳过其余路径", () => {
    const ws = workspace();
    put(ws.top, "file.txt", "x");
    const missing = startupAddDirCheck(parseArgs(["--add-dir", "lib", "--add-dir", "nope"]), {
      stdinIsTTY: true,
      processCwd: ws.top,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("目录不存在");
    const file = startupAddDirCheck(parseArgs(["--add-dir", "file.txt"]), { stdinIsTTY: true, processCwd: ws.top });
    expect(file.ok).toBe(false);
    if (!file.ok) expect(file.message).toContain("不是目录");
    const root = startupAddDirCheck(parseArgs(["--add-dir", "/"]), { stdinIsTTY: true, processCwd: ws.top });
    expect(root.ok).toBe(false);
    if (!root.ok) expect(root.message).toContain("文件系统根");
  });

  test("解析层用法错误也经同一出口报出", () => {
    const r = startupAddDirCheck(parseArgs(["--add-dir"]), { stdinIsTTY: true, processCwd: tmpdir() });
    expect(r.ok).toBe(false);
  });

  test("交互 TTY：用了 --add-dir 又有未消费位置参数 → 用法错误并提示每个目录各写一次", () => {
    const ws = workspace();
    const r = startupAddDirCheck(parseArgs(["--add-dir", "lib", "shared"]), { stdinIsTTY: true, processCwd: ws.top });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(ADD_DIR_HINT);
    expect(ADD_DIR_HINT).toBe("每个目录各写一次 --add-dir");
  });

  test("非 TTY：位置参数照旧当一次性提示词，不报错", () => {
    const ws = workspace();
    const r = startupAddDirCheck(parseArgs(["--add-dir", "lib", "解释一下"]), { stdinIsTTY: false, processCwd: ws.top });
    expect(r.ok).toBe(true);
  });

  test("不用 --add-dir 时位置参数规则不变（不新增报错）", () => {
    const r = startupAddDirCheck(parseArgs(["hello"]), { stdinIsTTY: true, processCwd: tmpdir() });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dirs).toEqual([]);
  });

  test("与 -p 同时有效", () => {
    const ws = workspace();
    const r = startupAddDirCheck(parseArgs(["-p", "q", "--add-dir", "lib"]), { stdinIsTTY: true, processCwd: ws.top });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.dirs).toEqual([ws.lib]);
  });
});

describe("文件系统根判定", () => {
  test("拒绝 / 与盘符根，允许 $HOME", () => {
    expect(isFilesystemRoot("/")).toBe(true);
    expect(isFilesystemRoot("C:\\")).toBe(true);
    expect(isFilesystemRoot("D:/")).toBe(true);
    expect(isFilesystemRoot(homedir())).toBe(false);
    expect(isFilesystemRoot("/tmp")).toBe(false);
    const ok = resolveAddDirPath(tmpdir(), homedir());
    expect(ok.ok).toBe(true);
    const bad = resolveAddDirPath(tmpdir(), "/");
    expect(bad.ok).toBe(false);
  });
});

describe("neo acp 带 --add-dir", () => {
  test("进 acpUsageError 冲突清单，不静默忽略", () => {
    const msg = acpUsageError(parseArgs(["acp", "--add-dir", "/tmp"]));
    expect(msg).not.toBeNull();
    expect(msg ?? "").toContain("--add-dir");
  });
});

/* ------------------------------------------------------------------ */
/* 会话命令 /add-dir                                                   */
/* ------------------------------------------------------------------ */

interface Harness {
  ws: ReturnType<typeof workspace>;
  cfg: Config;
  meta: SessionMeta;
  messages: Message[];
  promptManager: PromptManager;
  fileIndexRoots: { cwd: string; extras: string[] } | null;
  persistCalls: number;
  ctx: (ui: CommandContext["ui"], over?: Partial<CommandContext>) => CommandContext;
}

function harness(): Harness {
  const ws = workspace();
  const cfg = makeCfg(ws.main);
  const sess = createSession(cfg.model, ws.main);
  const promptManager = new PromptManager({ mailbox: false, askUser: false, sessionName: "s63" });
  const messages: Message[] = [{ role: "system", content: promptManager.render(cfg).text }];
  saveSession(messages, sess.meta);
  const h: Harness = {
    ws,
    cfg,
    meta: sess.meta,
    messages,
    promptManager,
    fileIndexRoots: null,
    persistCalls: 0,
    ctx: (ui, over = {}) =>
      ({
        agent: {
          messages: h.messages,
          refreshSystemPrompt: () => {
            h.messages[0] = { role: "system", content: h.promptManager.render(h.cfg).text };
          },
          activeNestedAgents: [],
          planning: false,
          mode: "ask",
        },
        ui,
        cfg: h.cfg,
        memory: { setCwd: () => {} },
        classifier: {},
        meta: h.meta,
        shutdown: () => {},
        selectDeps: {},
        mailbox: null,
        promptManager: h.promptManager,
        persistSession: (msgs: Message[], meta: SessionMeta) => {
          h.persistCalls += 1;
          saveSession(msgs, meta);
        },
        previousCwd: makePreviousCwdSlot(),
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

describe("/add-dir 登记", () => {
  test("COMMANDS 登记 /add-dir，knownSlashCommand 能识别；不做 /remove-dir", () => {
    expect(COMMANDS.some((c) => c.name === "add-dir")).toBe(true);
    expect(knownSlashCommand("/add-dir ../x")).toBe("add-dir");
    expect(COMMANDS.some((c) => c.name === "remove-dir")).toBe(false);
  });

  test("忙碌时 /add-dir 不是可注入的中轮转向（#66）", () => {
    expect(isSteerable({ text: "/add-dir ../lib", attachments: [], origin: "user" } as never)).toBe(false);
  });
});

describe("/add-dir 加入与列出", () => {
  test("一条可以多个路径；相对会话主根解析；可见反馈并写入会话元数据与 cfg", async () => {
    const h = harness();
    const out = await run(h, "/add-dir ../shared ../lib");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared, h.ws.lib]);
    expect(h.meta.additionalDirs).toEqual([h.ws.shared, h.ws.lib]);
    expect(loadSession(h.meta.id)?.meta.additionalDirs).toEqual([h.ws.shared, h.ws.lib]);
    expect(out).toContain(h.ws.shared);
    expect(out).toContain(h.ws.lib);
    expect(out).toContain("已加入 2 个，失败 0 个；当前额外根：");
    expect(out).not.toMatch(/未知命令/);
  });

  test("加入后刷新 @ 索引与系统提示（模型能看见额外根）", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared");
    expect(h.fileIndexRoots).toEqual({ cwd: h.ws.main, extras: [h.ws.shared] });
    const sys = String(h.messages[0]?.content ?? "");
    expect(sys).toContain(h.ws.shared);
  });

  test("加入后重算永久段：额外根的根指令文件进入项目记忆", async () => {
    const h = harness();
    put(h.ws.shared, "AGENTS.md", "SHARED-ROOT-RULES-MARKER");
    await run(h, "/add-dir ../shared");
    expect(h.promptManager.getProjectMemory()?.text ?? "").toContain("SHARED-ROOT-RULES-MARKER");
  });

  test("不带参数：列出主根与额外根，不改状态", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared");
    const persisted = h.persistCalls;
    const out = await run(h, "/add-dir");
    expect(out).toContain(h.ws.main);
    expect(out).toContain(h.ws.shared);
    expect(out).toContain("主根");
    expect(h.persistCalls).toBe(persisted);
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
  });

  test("~ 展开", async () => {
    const h = harness();
    const out = await run(h, "/add-dir ~");
    expect(h.cfg.additionalDirs).toEqual([realpathSync(homedir())]);
    expect(out).toContain("已加入 1 个");
  });

  test("部分失败不回滚：每条失败一行 + 最后汇总", async () => {
    const h = harness();
    put(h.ws.top, "file.txt", "x");
    const out = await run(h, "/add-dir ../shared ../nope ../file.txt ../lib");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared, h.ws.lib]);
    expect(out).toMatch(/✖ \.\.\/nope：目录不存在/);
    expect(out).toMatch(/✖ \.\.\/file\.txt：不是目录/);
    const lines = out.trimEnd().split("\n");
    expect(lines[lines.length - 1]).toContain("已加入 2 个，失败 2 个；当前额外根：");
  });

  test("拒绝文件系统根，允许 $HOME", async () => {
    const h = harness();
    const out = await run(h, "/add-dir /");
    expect(out).toMatch(/✖ \/：/);
    expect(out).toContain("文件系统根");
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });

  test("symlink 按 realpath 去重：重复添加不重复", async () => {
    const h = harness();
    symlinkSync(h.ws.shared, join(h.ws.top, "shared-link"));
    await run(h, "/add-dir ../shared");
    const out = await run(h, "/add-dir ../shared-link");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    expect(out).toContain("已在当前工作范围内：");
    expect(out).toContain("未重复添加");
  });
});

describe("/add-dir 未知选项", () => {
  test("除 --remove 外的 -- 参数（含 --remember）报未知选项，不当路径", async () => {
    const h = harness();
    mkdirSync(join(h.ws.main, "--remember"), { recursive: true });
    const out = await run(h, "/add-dir --remember ../shared");
    expect(out).toMatch(/未知选项/);
    expect(out).toContain("--remember");
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
    const out2 = await run(h, "/add-dir ../shared --bogus");
    expect(out2).toMatch(/未知选项/);
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });

  test("不做 /add-dir -（- 是 /cd 的回上一根）", async () => {
    const h = harness();
    const out = await run(h, "/add-dir -");
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
    expect(out).toMatch(/✖ -：|不支持/);
  });
});

describe("/add-dir「已在范围内」", () => {
  test("就是主根：提示属于主根，不重复添加", async () => {
    const h = harness();
    const out = await run(h, "/add-dir .");
    expect(out).toContain(`已在当前工作范围内：.（属于 主根），未重复添加。`);
    expect(out).not.toContain("skills_extra_paths");
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });

  test("主根的子目录：视为已在范围内，并追加 skills_extra_paths 提示", async () => {
    const h = harness();
    mkdirSync(join(h.ws.main, "pkg"), { recursive: true });
    const out = await run(h, "/add-dir pkg");
    expect(out).toContain("已在当前工作范围内：pkg（属于 主根），未重复添加。");
    expect(out).toContain("要加载该目录的技能，请用 skills_extra_paths。");
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });

  test("已有额外根本身 / 子目录：文案含所属额外根", async () => {
    const h = harness();
    mkdirSync(join(h.ws.shared, "sub"), { recursive: true });
    await run(h, "/add-dir ../shared");
    const out = await run(h, "/add-dir ../shared/sub");
    expect(out).toContain(`已在当前工作范围内：../shared/sub（属于 额外根 ${h.ws.shared}），未重复添加。`);
    expect(out).toContain("要加载该目录的技能，请用 skills_extra_paths。");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
  });

  test("允许加入已有工作根的祖先（例如 monorepo 根）", async () => {
    const h = harness();
    const out = await run(h, `/add-dir ${h.ws.top}`);
    expect(h.cfg.additionalDirs).toEqual([h.ws.top]);
    expect(out).toContain("已加入 1 个");
  });
});

describe("/add-dir --remove", () => {
  test("按 realpath 匹配并移除；可见反馈", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared ../lib");
    symlinkSync(h.ws.shared, join(h.ws.top, "shared-link"));
    const out = await run(h, "/add-dir --remove ../shared-link");
    expect(h.cfg.additionalDirs).toEqual([h.ws.lib]);
    expect(h.meta.additionalDirs).toEqual([h.ws.lib]);
    expect(out).toContain(h.ws.shared);
    expect(out).toContain("当前额外根：");
  });

  test("realpath 失败（目录已被删）时按已记录的绝对路径匹配", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    rmSync(h.ws.shared, { recursive: true, force: true });
    await run(h, `/add-dir --remove ${h.ws.shared}`);
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });

  test("不在列表里：规定文案，提示主根请用 /cd", async () => {
    const h = harness();
    await run(h, "/add-dir ../lib");
    const out = await run(h, "/add-dir --remove ../shared");
    expect(out).toContain("../shared 不在本会话额外根里（主根请用 /cd 切换）；当前额外根：");
    const main = await run(h, "/add-dir --remove .");
    expect(main).toContain(". 不在本会话额外根里（主根请用 /cd 切换）");
    expect(h.cfg.cwd).toBe(h.ws.main);
    expect(h.cfg.additionalDirs).toEqual([h.ws.lib]);
  });
});

/* ------------------------------------------------------------------ */
/* /cd、续聊、fork、子代理                                             */
/* ------------------------------------------------------------------ */

describe("/cd 与额外根", () => {
  test("/cd 成功换主根：清空全部额外根并列出被清掉的根", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared ../lib");
    const other = join(h.ws.top, "other");
    mkdirSync(other, { recursive: true });
    const out = await run(h, `/cd ${other}`);
    expect(h.cfg.cwd).toBe(other);
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
    expect(loadSession(h.meta.id)?.meta.additionalDirs ?? []).toEqual([]);
    expect(out).toContain("已清空本会话额外工作根 2 个：");
    expect(out).toContain(h.ws.shared);
    expect(out).toContain("（/cd 换主根会清空额外根；/cd - 不恢复）");
    expect(h.fileIndexRoots).toEqual({ cwd: other, extras: [] });
  });

  test("/cd 成功后永久段不再含旧额外根的指令文件", async () => {
    const h = harness();
    put(h.ws.shared, "AGENTS.md", "SHARED-GONE-AFTER-CD");
    await run(h, "/add-dir ../shared");
    expect(h.promptManager.getProjectMemory()?.text ?? "").toContain("SHARED-GONE-AFTER-CD");
    await run(h, `/cd ${h.ws.lib}`);
    expect(h.promptManager.getProjectMemory()?.text ?? "").not.toContain("SHARED-GONE-AFTER-CD");
  });

  test("同根 /cd（unchanged）不清空也不刷新", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared");
    const out = await run(h, "/cd .");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    expect(out).not.toContain("已清空");
  });

  test("失败的 /cd 不动额外根", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared");
    await run(h, "/cd ../does-not-exist");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
  });

  test("因忙碌被拒时不清空", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared");
    await run(h, `/cd ${h.ws.lib}`, { turnActive: true } as Partial<CommandContext>);
    expect(h.cfg.cwd).toBe(h.ws.main);
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
  });

  test("/cd 到某个额外根里面的目录：同样清空全部额外根", async () => {
    const h = harness();
    mkdirSync(join(h.ws.shared, "inner"), { recursive: true });
    await run(h, "/add-dir ../shared ../lib");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared, h.ws.lib]);
    await run(h, `/cd ${join(h.ws.shared, "inner")}`);
    expect(h.cfg.cwd).toBe(join(h.ws.shared, "inner"));
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });

  test("/cd - 回到上一主根：不恢复旧额外根", async () => {
    const h = harness();
    const prev = makePreviousCwdSlot();
    await run(h, "/add-dir ../shared");
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    await run(h, `/cd ${h.ws.lib}`, { previousCwd: prev } as Partial<CommandContext>);
    await run(h, "/cd -", { previousCwd: prev } as Partial<CommandContext>);
    expect(h.cfg.cwd).toBe(h.ws.main);
    expect(h.cfg.additionalDirs ?? []).toEqual([]);
  });

  test("changeSessionCwd 换根失败回滚时恢复额外根", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared");
    let calls = 0;
    const r = await changeSessionCwd(h.ws.lib, {
      cfg: h.cfg,
      meta: h.meta,
      messages: h.messages,
      persist: () => {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
      },
      promptManager: h.promptManager,
      refreshSystemPrompt: () => {},
      previousCwd: makePreviousCwdSlot(),
    });
    expect(r.ok).toBe(false);
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    expect(h.meta.additionalDirs).toEqual([h.ws.shared]);
  });
});

describe("续聊（--resume / -c）与 fork", () => {
  test("主根相同：恢复额外根，缺失路径按规定文案跳过，再与命令行合并去重", () => {
    const ws = workspace();
    const gone = join(ws.top, "gone");
    const r = settleSessionAdditionalDirs({
      mainCwd: ws.main,
      recordedCwd: ws.main,
      recordedDirs: [ws.shared, gone],
      cliDirs: [ws.lib, ws.shared],
    });
    expect(r.dirs).toEqual([ws.shared, ws.lib]);
    expect(r.notices.join("\n")).toContain(`额外工作根 ${gone} 已不存在，已跳过；其余 1 个已恢复`);
  });

  test("主根与会话记录不同：不恢复额外根，给一行说明；命令行 --add-dir 仍生效", () => {
    const ws = workspace();
    const r = settleSessionAdditionalDirs({
      mainCwd: ws.lib,
      recordedCwd: ws.main,
      recordedDirs: [ws.shared],
      cliDirs: [ws.top],
    });
    expect(r.dirs).toEqual([ws.top]);
    expect(r.notices.length).toBe(1);
    expect(r.notices[0]).toMatch(/不恢复/);
  });

  test("新会话（无记录）不继承；命令行里落在主根内的路径按已在范围内提示", () => {
    const ws = workspace();
    mkdirSync(join(ws.main, "pkg"), { recursive: true });
    const r = settleSessionAdditionalDirs({
      mainCwd: ws.main,
      recordedCwd: null,
      recordedDirs: undefined,
      cliDirs: [join(ws.main, "pkg"), ws.lib],
    });
    expect(r.dirs).toEqual([ws.lib]);
    expect(r.notices.join("\n")).toContain("已在当前工作范围内");
  });

  test("forkSession：主根不变则拷贝额外根；主根变了不拷贝", () => {
    const ws = workspace();
    const parent = createSession("m", ws.main).meta;
    parent.additionalDirs = [ws.shared];
    const same = forkSession(parent, [], "m", ws.main);
    expect(same.meta.additionalDirs).toEqual([ws.shared]);
    const moved = forkSession(parent, [], "m", ws.lib);
    expect(moved.meta.additionalDirs ?? []).toEqual([]);
  });

  test("/fork 拷贝本会话额外根，缺失路径警告并跳过", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared ../lib");
    rmSync(h.ws.lib, { recursive: true, force: true });
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
    expect(h.meta.additionalDirs).toEqual([h.ws.shared]);
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared]);
    expect(out).toContain(`额外工作根 ${h.ws.lib} 已不存在，已跳过`);
  });
});

describe("子代理快照", () => {
  test("派出时拍快照：之后 /add-dir 不热更新已派出的子代理 cfg", async () => {
    const h = harness();
    await run(h, "/add-dir ../shared");
    const subCfg = { ...h.cfg, additionalDirs: [...(h.cfg.additionalDirs ?? [])] };
    await run(h, "/add-dir ../lib");
    expect(subCfg.additionalDirs).toEqual([h.ws.shared]);
    expect(h.cfg.additionalDirs).toEqual([h.ws.shared, h.ws.lib]);
    const task = readFileSync(join(import.meta.dir, "../src/tools/task.ts"), "utf8");
    expect(task).toMatch(/additionalDirs:\s*\[\.\.\.\(cfg\.additionalDirs \?\? \[\]\)\]/);
  });
});

/* ------------------------------------------------------------------ */
/* @、glob / grep、目录树、仓库地图                                    */
/* ------------------------------------------------------------------ */

describe("FileIndex 多根", () => {
  const noGit = () => ({ ok: false, stdout: "" });

  test("主根相对路径不变；额外根写成相对主根（../shared/x），主根优先、总上限共享", async () => {
    const ws = workspace();
    put(ws.main, "a.ts", "");
    put(ws.shared, "util/x.ts", "");
    const idx = new FileIndex({ cwd: ws.main, extraRoots: [ws.shared], run: noGit });
    await idx.refresh();
    expect(idx.list()).toEqual(["a.ts", "../shared/util/x.ts"]);
    const capped = new FileIndex({ cwd: ws.main, extraRoots: [ws.shared], run: noGit, limit: 1 });
    await capped.refresh();
    expect(capped.list()).toEqual(["a.ts"]);
  });

  test("祖先根不重复列出主根里的文件（按路径去重）", async () => {
    const ws = workspace();
    put(ws.main, "a.ts", "");
    put(ws.lib, "b.ts", "");
    const idx = new FileIndex({ cwd: ws.main, extraRoots: [ws.top], run: noGit });
    await idx.refresh();
    const list = idx.list();
    expect(list.filter((p) => p.endsWith("a.ts"))).toEqual(["a.ts"]);
    expect(list).toContain("../lib/b.ts");
  });

  test("setRoots 改额外根；setCwd（/cd）清空额外根", async () => {
    const ws = workspace();
    put(ws.shared, "s.ts", "");
    put(ws.lib, "l.ts", "");
    const idx = new FileIndex({ cwd: ws.main, run: noGit });
    idx.setRoots(ws.main, [ws.shared]);
    await idx.refresh();
    expect(idx.list()).toContain("../shared/s.ts");
    idx.setCwd(ws.lib);
    await idx.refresh();
    expect(idx.list()).toEqual(["l.ts"]);
  });
});

function toolCtx(cfg: Config): ToolCtx {
  return { cfg, approve: async () => true } as unknown as ToolCtx;
}

describe("glob / grep 默认覆盖全部工作根", () => {
  test("未给 path：搜全部工作根，额外根结果写成相对主根", async () => {
    const ws = workspace();
    put(ws.main, "m.ts", "NEEDLE main\n");
    put(ws.shared, "s.ts", "NEEDLE shared\n");
    const cfg = makeCfg(ws.main, { additionalDirs: [ws.shared] } as Partial<Config>);
    const g = String(await globTool.execute({ pattern: "**/*.ts" }, toolCtx(cfg)));
    expect(g).toContain("m.ts");
    expect(g).toContain("../shared/s.ts");
    const r = String(await grepTool.execute({ pattern: "NEEDLE" }, toolCtx(cfg)));
    expect(r).toContain("m.ts:1:");
    expect(r).toContain("../shared/s.ts:1:");
  });

  test("给了 path：仍只搜那一个（可以是额外根里的路径）", async () => {
    const ws = workspace();
    put(ws.main, "m.ts", "NEEDLE main\n");
    put(ws.shared, "s.ts", "NEEDLE shared\n");
    const cfg = makeCfg(ws.main, { additionalDirs: [ws.shared] } as Partial<Config>);
    const r = String(await grepTool.execute({ pattern: "NEEDLE", path: ws.shared }, toolCtx(cfg)));
    expect(r).toContain("s.ts:1:");
    expect(r).not.toContain("m.ts");
  });

  test("祖先根：同一文件不扫两遍", async () => {
    const ws = workspace();
    put(ws.main, "m.ts", "NEEDLE once\n");
    const cfg = makeCfg(ws.main, { additionalDirs: [ws.top] } as Partial<Config>);
    const r = String(await grepTool.execute({ pattern: "NEEDLE once" }, toolCtx(cfg)));
    expect((r.match(/NEEDLE once/g) ?? []).length).toBe(1);
  });

  test("工具描述改为默认本会话全部工作根", () => {
    expect(JSON.stringify(globTool.spec)).toContain("默认本会话全部工作根");
    expect(JSON.stringify(grepTool.spec)).toContain("默认本会话全部工作根");
  });
});

describe("系统提示：额外根、目录树、仓库地图", () => {
  test("模型能看见额外工作根；目录树按根标注、预算共享", () => {
    const ws = workspace();
    put(ws.main, "main-file.ts", "");
    put(ws.shared, "shared-file.ts", "");
    const cfg = makeCfg(ws.main, { additionalDirs: [ws.shared] } as Partial<Config>);
    const text = buildSystemPrompt(cfg);
    expect(text).toContain("额外工作根");
    expect(text).toContain(ws.shared);
    expect(text).toContain("main-file.ts");
    expect(text).toContain("shared-file.ts");
    // 两棵树不混成一套相对路径：额外根条目在自己的根标注之下
    const sharedIdx = text.indexOf(`[额外根] ${ws.shared}`);
    expect(sharedIdx).toBeGreaterThan(-1);
    expect(text.indexOf("shared-file.ts")).toBeGreaterThan(sharedIdx);
  });

  test("无额外根时系统提示不出现额外根行", () => {
    const ws = workspace();
    expect(buildSystemPrompt(makeCfg(ws.main))).not.toContain("额外工作根");
  });

  test("仓库地图覆盖额外根，条目可区分所属根；祖先根不重复主根文件", () => {
    const ws = workspace();
    put(ws.main, "src/app.ts", "export function appMain() {}\n");
    put(ws.shared, "util.ts", "export function sharedUtil() {}\n");
    const repoMap = { enabled: true, budgetTokens: 2000, maxFiles: 500 };
    const map = buildRepoMap({ cwd: ws.main, repoMap, additionalDirs: [ws.shared] } as never);
    expect(map.text).toContain("src/app.ts: appMain");
    expect(map.text).toContain("../shared/util.ts: sharedUtil");
    resetRepoMapCache();
    const anc = buildRepoMap({ cwd: ws.main, repoMap, additionalDirs: [ws.top] } as never);
    expect((anc.text.match(/appMain/g) ?? []).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* #54 接线                                                            */
/* ------------------------------------------------------------------ */

describe("#54：每个工作根各算永久段", () => {
  test("额外根的根文件 + 该根自己的 git 祖先进入永久段；子目录不预载", () => {
    const ws = workspace();
    put(ws.main, "AGENTS.md", "MAIN-ROOT");
    const repo = join(ws.top, "other-repo");
    fakeGit(repo);
    put(repo, "AGENTS.md", "OTHER-REPO-ROOT");
    const pkg = join(repo, "packages", "core");
    put(pkg, "AGENTS.md", "OTHER-PKG-ROOT");
    put(pkg, "deep/AGENTS.md", "OTHER-DEEP-SHOULD-NOT-PRELOAD");
    put(ws.top, "AGENTS.md", "ABOVE-OTHER-GIT-ROOT-SHOULD-NOT-LOAD");
    const mem = composePermanentMemory(ws.main, [pkg]);
    const text = mem?.text ?? "";
    expect(text).toContain("MAIN-ROOT");
    expect(text).toContain("OTHER-PKG-ROOT");
    expect(text).toContain("OTHER-REPO-ROOT");
    expect(text).not.toContain("OTHER-DEEP-SHOULD-NOT-PRELOAD");
    expect(text).not.toContain("ABOVE-OTHER-GIT-ROOT-SHOULD-NOT-LOAD");
  });

  test("按文件 realpath 去重：已在主根永久段里的文件不重复出现", () => {
    const ws = workspace();
    fakeGit(ws.top);
    put(ws.top, "AGENTS.md", "TOP-ONCE");
    put(ws.main, "AGENTS.md", "MAIN");
    const mem = composePermanentMemory(ws.main, [ws.top]);
    expect((mem?.text.match(/TOP-ONCE/g) ?? []).length).toBe(1);
    expect(new Set(mem?.files.map((f) => f.path)).size).toBe(mem?.files.length ?? -1);
  });

  test("safe-mode 下额外根的指令文件也不加载", () => {
    const ws = workspace();
    put(ws.shared, "AGENTS.md", "SHARED-SAFE");
    expect(loadSessionInstructionMemory(ws.main, { safeMode: true, extraRoots: [ws.shared] })).toBeNull();
    expect(loadSessionInstructionMemory(ws.main, { safeMode: false, extraRoots: [ws.shared] })?.text).toContain("SHARED-SAFE");
  });
});

describe("#54：触达归类最具体根优先（不再用 roots.find）", () => {
  test("祖先额外根排在主根后面也不能截走主根下的嵌套指令", () => {
    const ws = workspace();
    put(ws.main, "pkg/AGENTS.md", "MAIN-PKG");
    put(ws.top, "AGENTS.md", "TOP");
    put(ws.main, "AGENTS.md", "MAIN-ROOT-PERMANENT");
    // roots 顺序：祖先在前（roots.find 会先命中它）
    const files = collectNestedInstructionFiles({ roots: [ws.top, ws.main], touched: [join(ws.main, "pkg/x.ts")] });
    const paths = files.map((f) => f.path);
    expect(paths).toContain(join(ws.main, "pkg", "AGENTS.md"));
    // 归入主根后，walk 到主根为止（不含主根）：主根上方的 app 目录本身不应因大根而被加载
    expect(paths).not.toContain(join(ws.main, "AGENTS.md"));
  });

  test("归入最具体根后只走到该根为止；排序按各自所属根的深度", () => {
    const ws = workspace();
    put(ws.main, "AGENTS.md", "MAIN-ROOT-FILE");
    put(ws.main, "a/b/AGENTS.md", "MAIN-AB");
    put(ws.shared, "z/AGENTS.md", "SHARED-Z");
    const files = collectNestedInstructionFiles({
      roots: [ws.top, ws.main, ws.shared],
      touched: [join(ws.main, "a/b/c.ts"), join(ws.shared, "z/q.ts")],
    });
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain(join(ws.main, "AGENTS.md"));
    // 深度：shared/z（深 1）应排在 main/a/b（深 2）之前
    expect(paths).toEqual([join(ws.shared, "z", "AGENTS.md"), join(ws.main, "a", "b", "AGENTS.md")]);
  });

  test("触达额外根内路径：按需注入额外根子目录指令", () => {
    const ws = workspace();
    put(ws.shared, "AGENTS.md", "SHARED-ROOT-IN-PERM");
    put(ws.shared, "pkg/AGENTS.md", "SHARED-PKG-NESTED");
    const perm = composePermanentMemory(ws.main, [ws.shared]);
    const files = collectNestedInstructionFiles({
      roots: [ws.main, ws.shared],
      touched: [join(ws.shared, "pkg/x.ts")],
      exclude: perm?.files.map((f) => f.path),
    });
    expect(files.map((f) => f.text)).toEqual(["SHARED-PKG-NESTED"]);
  });
});

describe("触达路径识别额外根", () => {
  test("extractTouchedPaths：额外根里的路径不被丢弃", () => {
    const ws = workspace();
    const abs = join(ws.shared, "x.ts");
    expect(extractTouchedPaths("read_file", JSON.stringify({ path: abs }), ws.main, [ws.shared])).toEqual([abs]);
    expect(extractTouchedPaths("read_file", JSON.stringify({ path: "../shared/x.ts" }), ws.main, [ws.shared])).toEqual([abs]);
    // 主根内仍是相对路径；不在任何根内仍丢弃
    expect(extractTouchedPaths("read_file", JSON.stringify({ path: "a.ts" }), ws.main, [ws.shared])).toEqual(["a.ts"]);
    expect(extractTouchedPaths("read_file", JSON.stringify({ path: join(ws.lib, "y.ts") }), ws.main, [ws.shared])).toEqual([]);
  });

  test("workRoots：主根在前，额外根按加入顺序", () => {
    const ws = workspace();
    expect(workRoots(makeCfg(ws.main, { additionalDirs: [ws.lib, ws.shared] } as Partial<Config>))).toEqual([
      ws.main,
      ws.lib,
      ws.shared,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* /context                                                            */
/* ------------------------------------------------------------------ */

describe("/context 列出额外工作根与其 #54 指令文件路径", () => {
  // /context 处理器需要完整 Agent（窗口探测 / 能力视图 / 工具清单），这里对它调用的报告函数做单测，
  // 并钉住 /context 确实调用了它。
  test("列根与因额外根加载的指令文件路径，不倒正文；safe-mode 只列根", () => {
    const ws = workspace();
    put(ws.shared, "AGENTS.md", "SHARED-BODY-SHOULD-NOT-BE-DUMPED");
    const nested = put(ws.shared, "pkg/AGENTS.md", "NESTED-BODY");
    const cfg = makeCfg(ws.main, { additionalDirs: [ws.shared] } as Partial<Config>);
    const out = additionalRootsReport(cfg, [{ path: nested }]).join("\n");
    expect(out).toContain("额外工作根");
    expect(out).toContain(ws.shared);
    expect(out).toContain(join(ws.shared, "AGENTS.md"));
    expect(out).toContain(nested);
    expect(out).not.toContain("SHARED-BODY-SHOULD-NOT-BE-DUMPED");
    const safe = additionalRootsReport({ ...cfg, safeMode: true }, []).join("\n");
    expect(safe).toContain(ws.shared);
    expect(safe).not.toContain(join(ws.shared, "AGENTS.md"));
    const src = readFileSync(join(import.meta.dir, "../src/cli/commandSession.ts"), "utf8");
    expect(src).toContain("additionalRootsReport(");
  });
});

/* ------------------------------------------------------------------ */
/* 回归：不从额外根加载配置                                            */
/* ------------------------------------------------------------------ */

describe("不从额外根自动加载技能 / 子代理 / 规则（与 safe-mode 无关）", () => {
  test("额外根里的 .neo/skills 与 .neo/agents 不被发现", () => {
    const ws = workspace();
    put(ws.shared, ".neo/skills/side-skill/SKILL.md", "---\nname: side-skill\ndescription: x\n---\nbody\n");
    put(ws.shared, ".neo/agents/side-agent.md", "---\nname: side-agent\ndescription: x\n---\nbody\n");
    const cfg = makeCfg(ws.main, { additionalDirs: [ws.shared] } as Partial<Config>);
    expect(discoverSkills(cfg).some((s) => s.name === "side-skill")).toBe(false);
    expect(discoverAgents(cfg).agents.some((a) => a.name === "side-agent")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 文案：现在时 + 对照段                                               */
/* ------------------------------------------------------------------ */

describe("帮助与 README：现在时与对照段", () => {
  const help = helpText();
  const readme = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
  const prd = readFileSync(join(import.meta.dir, "../docs/cd-workdir-prd.md"), "utf8");

  test("--help 写明 --add-dir 句法、非 TTY 位置参数规则", () => {
    expect(help).toContain("--add-dir <路径>");
    expect(help).toContain("每个目录各写一次 --add-dir");
    expect(help).toMatch(/非 TTY[^\n]*位置参数[^\n]*一次性提示词/);
  });

  test("/help 有 /add-dir 用法（--remove、不带参数列出）", () => {
    expect(help).toContain("/add-dir");
    expect(help).toContain("/add-dir --remove");
  });

  test("旧的未来时表述已改掉（help / README / PRD）", () => {
    for (const text of [help, readme, prd]) {
      expect(text).not.toMatch(/尚未实现的 #63/);
      expect(text).not.toMatch(/#63[^\n]*(本单未实现|本版本尚未实现|本单不实现)/);
      expect(text).not.toMatch(/未来口径[^\n]*\/cd/);
    }
  });

  for (const [name, text] of [
    ["help", help],
    ["README", readme],
  ] as const) {
    test(`${name} 含与 Claude Code 的对照段`, () => {
      expect(text).toContain("与 Claude Code 不同：Claude Code 的 /cd 保留额外目录");
      expect(text).toContain("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1");
      expect(text).toContain("skills_extra_paths");
      expect(text).toContain("DirectoryAdded");
      expect(text).toContain("--remember");
      expect(text).toMatch(/每个 --add-dir 只跟一个路径|每个 `--add-dir` 只跟一个路径/);
      expect(text).toMatch(/忙碌时[^\n]*\/add-dir[^\n]*轮末/);
      expect(text).toMatch(/--remove/);
    });
  }

  test("release-notes v0.4.94 的未来时表述已对齐", () => {
    const rn = readFileSync(join(import.meta.dir, "../docs/release-notes/v0.4.94.md"), "utf8");
    expect(rn).toMatch(/#63[^\n]*(已实现|现已实现|已在)/);
  });
});

describe("/add-dir 路径补全（与 /cd 同类，只补目录）", () => {
  test("补最后一个路径参数，相对会话主根，不列文件", () => {
    const ws = workspace();
    put(ws.top, "shared-note.txt", "x");
    const line = "/add-dir ../lib ../sh";
    const r = completeCdLine(line, line.length, ws.main);
    expect(r).not.toBeNull();
    expect(r?.token).toBe("../sh");
    expect(r?.start).toBe(line.length - "../sh".length);
    expect(r?.matches.some((m) => m.startsWith("../shared"))).toBe(true);
    expect(r?.matches.some((m) => m.includes("shared-note.txt"))).toBe(false);
  });
});
