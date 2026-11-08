/**
 * worktree.test.ts — 托管 git worktree（issue #9 最小片）。
 *
 * 覆盖：
 *  a. 名字/分支/路径的纯逻辑（非法名、分支前缀、托管目录）。
 *  b. 创建与复用：新建、同名复用（不覆盖、不报错）、分支已存在时挂上去。
 *  c. 失败路径：非 git 目录、非法名、路径被非托管目录占用、git 失败不留半成品。
 *  d. 列表：只认 .neo/worktrees/<name> + neo/<name>；标记脏/当前；不碰用户自己的 worktree。
 *  e. 删除：干净成功 + prune；脏拒绝（needsForce）；不能删当前；非托管不删。
 *  f. 命令层（/worktree list|remove）：输出含名/分支/脏/当前；脏 + --force 走一次确认。
 *  g. 声明：COMMANDS 含 worktree、helpText 含 --worktree 与 /worktree。
 *
 * 夹具用真临时 git 仓库，不 mock git。
 * 运行：bun test tests/worktree.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent.ts";
import type { AgentIO } from "../src/agent.ts";
import { dispatchCommand, wireCommands } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commands.ts";
import { helpText } from "../src/cli/help.ts";
import type { Config } from "../src/config.ts";
import { COMMANDS } from "../src/input/commands.ts";
import {
  canonicalize,
  detectRepo,
  ensureWorktree,
  isValidWorktreeName,
  listManaged,
  orphanDirs,
  parseWorktreeList,
  removeWorktree,
  WORKTREE_DIR,
  worktreeBranch,
  worktreePath,
  worktreeRoot,
} from "../src/worktree.ts";
import { captureConsole } from "./helpers.ts";


const ROOT = join(tmpdir(), `neo-worktree-test-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} 失败: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

/** 建一个临时仓库（含一次提交），返回其路径。 */
function makeRepo(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "init\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
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

function makeCfg(cwd: string): Config {
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
    cwd,
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
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
  } as unknown as Config;
}

function makeCmdCtx(
  cwd: string,
  ui: ReturnType<typeof captureConsole>["ui"],
): CommandContext {
  return {
    agent: new Agent({ cfg: makeCfg(cwd), console: silentIO(), mode: "ask", systemPrompt: "sys" }),
    ui,
    cfg: makeCfg(cwd),
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "s1", model: "m-default", cwd } as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
  };
}

wireCommands();

/* ------------------------------------------------------------------ */
/* a. 名字与路径                                                       */
/* ------------------------------------------------------------------ */

describe("a. 名字与路径", () => {
  test("合法名：字母数字 . _ -，不以 . 或 - 开头", () => {
    for (const n of ["feat-a", "fix_9", "a", "v1.2", "A_b-C.1"]) {
      expect(isValidWorktreeName(n)).toBe(true);
    }
  });

  test("非法名：路径穿越、空格、斜杠、空、超长、以 . / - 开头", () => {
    for (const n of ["", "..", ".", "../x", "a/b", "a b", "-x", ".hidden", "a:b", "x".repeat(65)]) {
      expect(isValidWorktreeName(n)).toBe(false);
    }
  });

  test("分支名稳定可读：neo/<name>；路径在 .neo/worktrees/<name>", () => {
    expect(worktreeBranch("feat-a")).toBe("neo/feat-a");
    expect(worktreePath("/repo", "feat-a")).toBe(join("/repo", WORKTREE_DIR, "feat-a"));
    expect(WORKTREE_DIR).toBe(".neo/worktrees");
  });

  test("parseWorktreeList 解析 porcelain 输出", () => {
    const out = [
      "worktree /repo",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /repo/.neo/worktrees/x",
      "HEAD def",
      "branch refs/heads/neo/x",
      "",
      "worktree /repo/detached",
      "HEAD 123",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.neo/worktrees/x", branch: "neo/x" },
      { path: "/repo/detached", branch: null },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* b/c. 创建、复用、失败                                               */
/* ------------------------------------------------------------------ */

describe("b. 创建与复用", () => {
  test("新建：目录存在、分支 neo/<name>、created=true", () => {
    const repo = makeRepo("create");
    const r = ensureWorktree(repo, "feat-a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.branch).toBe("neo/feat-a");
    expect(existsSync(join(r.path, "README.md"))).toBe(true);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(git(r.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("neo/feat-a");
  });

  test("同名复用：created=false，不报错、不覆盖已有改动", () => {
    const repo = makeRepo("reuse");
    const first = ensureWorktree(repo, "feat-a");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    writeFileSync(join(first.path, "work.txt"), "in progress\n");

    const second = ensureWorktree(repo, "feat-a");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    // 复用不能重置工作区
    expect(existsSync(join(second.path, "work.txt"))).toBe(true);
  });

  test("分支已存在但没登记：挂上去而不是重建（不丢已有提交）", () => {
    const repo = makeRepo("branch-exists");
    git(repo, "branch", "neo/feat-b");
    const r = ensureWorktree(repo, "feat-b");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(git(r.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("neo/feat-b");
  });

  test("在 worktree 里再建：仍挂在主仓库的 .neo/worktrees 下，不套娃", () => {
    const repo = makeRepo("nested");
    const a = ensureWorktree(repo, "a");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const repoFromWt = detectRepo(a.path);
    expect(repoFromWt.ok).toBe(true);
    if (!repoFromWt.ok) return;
    // issue #26：mainRoot 是 canonical 口径（软链展开后的真实路径），
    // 与 makeRepo 得到的原始路径可能不同写法（macOS 上 /var → /private/var）。
    // 两边都按 canonical 比较，「不套娃」这个语义不变：仍是主仓库，不是 worktree 内部。
    expect(repoFromWt.mainRoot).toBe(canonicalize(repo));
    // 关键语义：新建的 b 挂在**主仓库**的 .neo/worktrees 下，不在 a 里面套娃。
    const b = ensureWorktree(repoFromWt.mainRoot, "b");
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(canonicalize(b.path)).toBe(canonicalize(worktreePath(repo, "b")));
    expect(b.path.startsWith(join(a.path, WORKTREE_DIR))).toBe(false);
  });
});

describe("c. 失败路径", () => {
  test("非 git 目录：detectRepo 给出可读错误", () => {
    const plain = join(ROOT, "plain");
    mkdirSync(plain, { recursive: true });
    const r = detectRepo(plain);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("不是 git 仓库");
    expect(r.message).toContain("--worktree");
  });

  test("非法名：报错且不创建任何目录", () => {
    const repo = makeRepo("bad-name");
    const r = ensureWorktree(repo, "../escape");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("名字非法");
    expect(existsSync(join(repo, WORKTREE_DIR, "..", "escape"))).toBe(false);
    expect(existsSync(join(repo, "escape"))).toBe(false);
  });

  test("路径被非托管目录占用：拒绝覆盖", () => {
    const repo = makeRepo("occupied");
    const p = worktreePath(repo, "taken");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "keep.txt"), "user data\n");
    const r = ensureWorktree(repo, "taken");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("不是 neo 托管的 worktree");
    expect(existsSync(join(p, "keep.txt"))).toBe(true);
  });

  test("git 失败：非 0 退出、不留半成品目录与分支", () => {
    const repo = makeRepo("git-fail");
    // 注入一个「add 必失败」的 exec：其它命令照常走真 git。
    const deps = {
      exec: (args: string[], cwd: string) => {
        if (args[0] === "worktree" && args[1] === "add") {
          return { code: 128, stdout: "", stderr: "fatal: 模拟失败" };
        }
        const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
        return {
          code: p.exitCode ?? 1,
          stdout: p.stdout?.toString() ?? "",
          stderr: p.stderr?.toString() ?? "",
        };
      },
    };
    const r = ensureWorktree(repo, "boom", deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("创建 worktree 失败");
    expect(r.message).toContain("模拟失败");
    expect(existsSync(worktreePath(repo, "boom"))).toBe(false);
    expect(git(repo, "branch", "--list", "neo/boom").trim()).toBe("");
    expect(listManaged(repo)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* d. 列表                                                             */
/* ------------------------------------------------------------------ */

describe("d. listManaged", () => {
  test("只列托管 worktree；用户自己的 worktree 不列", () => {
    const repo = makeRepo("list");
    const mine = ensureWorktree(repo, "mine");
    expect(mine.ok).toBe(true);
    // 用户自己建的 worktree（不在托管目录、分支也不是 neo/*）
    git(repo, "worktree", "add", "-q", "-b", "user-branch", join(ROOT, "list-user-wt"));

    const items = listManaged(repo);
    expect(items.map((w) => w.name)).toEqual(["mine"]);
    expect(items[0]!.branch).toBe("neo/mine");
    expect(items[0]!.dirty).toBe(false);
    expect(items[0]!.current).toBe(false);
  });

  test("托管目录里但分支不是 neo/<name> 的，不算托管（宁可漏认不误删）", () => {
    const repo = makeRepo("list-branch-mismatch");
    const p = worktreePath(repo, "sneaky");
    mkdirSync(join(repo, WORKTREE_DIR), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "other", p);
    expect(listManaged(repo)).toEqual([]);
  });

  test("脏标记：未跟踪文件与已跟踪改动都算脏", () => {
    const repo = makeRepo("list-dirty");
    const r = ensureWorktree(repo, "d1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "untracked.txt"), "x\n");
    expect(listManaged(repo)[0]!.dirty).toBe(true);

    git(r.path, "add", "-A");
    git(r.path, "commit", "-q", "-m", "add");
    expect(listManaged(repo)[0]!.dirty).toBe(false);

    writeFileSync(join(r.path, "README.md"), "changed\n");
    expect(listManaged(repo)[0]!.dirty).toBe(true);
  });

  test("当前标记：cwd 落在该 worktree 内时 current=true", () => {
    const repo = makeRepo("list-current");
    const r = ensureWorktree(repo, "cur");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(listManaged(repo, {}, r.path)[0]!.current).toBe(true);
    expect(listManaged(repo, {}, repo)[0]!.current).toBe(false);
  });

  /* issue #9：cwd 是 worktree 的**子目录**时同样算当前会话所在。
     `neo -C .neo/worktrees/feat/sub`、或在 worktree 子目录里启动 neo 都会走到这里。 */

  test("当前标记：cwd 是 worktree 的嵌套子目录时 current=true", () => {
    const repo = makeRepo("list-current-sub");
    const r = ensureWorktree(repo, "cur");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sub = join(r.path, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(listManaged(repo, {}, sub)[0]!.current).toBe(true);
    expect(listManaged(repo, {}, join(r.path, "a"))[0]!.current).toBe(true);
    // 兄弟目录 / 主仓库不算
    expect(listManaged(repo, {}, repo)[0]!.current).toBe(false);
  });

  test("当前标记：cwd 经符号链接指向 worktree 内部时 current=true", () => {
    const repo = makeRepo("list-current-link");
    const r = ensureWorktree(repo, "cur");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sub = join(r.path, "sub");
    mkdirSync(sub, { recursive: true });
    const link = join(ROOT, "list-current-link-alias");
    symlinkSync(sub, link);
    expect(listManaged(repo, {}, link)[0]!.current).toBe(true);

    // 仓库路径本身经软链：worktree 登记的是真实路径，cwd 走软链也要认出来。
    const repoLink = join(ROOT, "list-current-link-repo");
    symlinkSync(repo, repoLink);
    expect(listManaged(repo, {}, join(repoLink, WORKTREE_DIR, "cur"))[0]!.current).toBe(true);
  });

  test("当前标记：同前缀兄弟目录（feat / feat2 / feat-x）不算 current", () => {
    const repo = makeRepo("list-current-prefix");
    const a = ensureWorktree(repo, "feat");
    const b = ensureWorktree(repo, "feat2");
    const c = ensureWorktree(repo, "feat-x");
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    const items = listManaged(repo, {}, b.path);
    expect(items.find((w) => w.name === "feat2")!.current).toBe(true);
    expect(items.find((w) => w.name === "feat")!.current).toBe(false);
    expect(items.find((w) => w.name === "feat-x")!.current).toBe(false);
    // 托管目录本身不是任何一个 worktree 的内部
    expect(listManaged(repo, {}, worktreeRoot(repo)).every((w) => !w.current)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* e. 删除                                                             */
/* ------------------------------------------------------------------ */

describe("e. removeWorktree", () => {
  test("干净：删除成功、目录消失、worktree 登记被 prune", () => {
    const repo = makeRepo("rm-clean");
    const r = ensureWorktree(repo, "gone");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rm = removeWorktree(repo, "gone", { cwd: repo });
    expect(rm.ok).toBe(true);
    if (!rm.ok) return;
    expect(rm.pruned).toBe(true);
    expect(existsSync(r.path)).toBe(false);
    expect(git(repo, "worktree", "list").includes("gone")).toBe(false);
    expect(listManaged(repo)).toEqual([]);
  });

  test("脏（未跟踪文件）：拒绝，needsForce=true，文件仍在", () => {
    const repo = makeRepo("rm-dirty");
    const r = ensureWorktree(repo, "dirty");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "wip.txt"), "not committed\n");
    const rm = removeWorktree(repo, "dirty", { cwd: repo });
    expect(rm.ok).toBe(false);
    if (rm.ok) return;
    expect(rm.needsForce).toBe(true);
    expect(rm.message).toContain("wip.txt");
    expect(existsSync(join(r.path, "wip.txt"))).toBe(true);
  });

  test("脏（已跟踪改动）：同样拒绝", () => {
    const repo = makeRepo("rm-dirty-tracked");
    const r = ensureWorktree(repo, "dirty2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "README.md"), "modified\n");
    const rm = removeWorktree(repo, "dirty2", { cwd: repo });
    expect(rm.ok).toBe(false);
    if (rm.ok) return;
    expect(rm.needsForce).toBe(true);
  });

  test("--force 才删除脏工作区", () => {
    const repo = makeRepo("rm-force");
    const r = ensureWorktree(repo, "forced");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "wip.txt"), "x\n");
    const rm = removeWorktree(repo, "forced", { cwd: repo, force: true });
    expect(rm.ok).toBe(true);
    expect(existsSync(r.path)).toBe(false);
  });

  test("不能删除当前会话所在 worktree（即使 --force）", () => {
    const repo = makeRepo("rm-current");
    const r = ensureWorktree(repo, "here");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rm = removeWorktree(repo, "here", { cwd: r.path, force: true });
    expect(rm.ok).toBe(false);
    if (rm.ok) return;
    expect(rm.message).toContain("当前会话所在");
    expect(existsSync(r.path)).toBe(true);
  });

  /* issue #9：cwd 是 worktree 子目录时，删该 worktree 同样会删掉进程脚下的目录。 */

  test("cwd 是 worktree 子目录：remove 拒绝，--force 也拒绝，目录与文件都在", () => {
    const repo = makeRepo("rm-current-sub");
    const r = ensureWorktree(repo, "feat");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sub = join(r.path, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "keep.txt"), "in progress\n");
    git(r.path, "add", "-A");
    git(r.path, "commit", "-q", "-m", "sub");

    const plain = removeWorktree(repo, "feat", { cwd: sub });
    expect(plain.ok).toBe(false);
    if (plain.ok) return;
    expect(plain.message).toContain("当前会话所在");
    expect(plain.needsForce).toBe(false);

    const forced = removeWorktree(repo, "feat", { cwd: sub, force: true });
    expect(forced.ok).toBe(false);
    if (forced.ok) return;
    expect(forced.message).toContain("当前会话所在");

    expect(existsSync(join(sub, "keep.txt"))).toBe(true);
    expect(listManaged(repo).map((w) => w.name)).toEqual(["feat"]);
  });

  test("cwd 经符号链接指向 worktree 子目录：同样拒绝删除", () => {
    const repo = makeRepo("rm-current-link");
    const r = ensureWorktree(repo, "feat");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sub = join(r.path, "sub");
    mkdirSync(sub, { recursive: true });
    const link = join(ROOT, "rm-current-link-alias");
    symlinkSync(sub, link);
    const rm = removeWorktree(repo, "feat", { cwd: link, force: true });
    expect(rm.ok).toBe(false);
    expect(existsSync(sub)).toBe(true);
  });

  test("cwd 是同前缀兄弟 worktree：不算当前，可以删", () => {
    const repo = makeRepo("rm-current-prefix");
    const a = ensureWorktree(repo, "feat");
    const b = ensureWorktree(repo, "feat2");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const rm = removeWorktree(repo, "feat", { cwd: b.path });
    expect(rm.ok).toBe(true);
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
  });

  test("不删非托管 worktree（用户自己的、或托管目录里分支不对的）", () => {
    const repo = makeRepo("rm-unmanaged");
    const userWt = join(ROOT, "rm-unmanaged-user");
    git(repo, "worktree", "add", "-q", "-b", "user-branch", userWt);
    const rm = removeWorktree(repo, "rm-unmanaged-user", { cwd: repo });
    expect(rm.ok).toBe(false);
    expect(existsSync(userWt)).toBe(true);

    // 托管目录里但分支不是 neo/<name>：也不算托管
    const p = worktreePath(repo, "sneaky");
    mkdirSync(join(repo, WORKTREE_DIR), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "other", p);
    const rm2 = removeWorktree(repo, "sneaky", { cwd: repo, force: true });
    expect(rm2.ok).toBe(false);
    expect(existsSync(p)).toBe(true);
  });

  test("不存在的名字：可读错误", () => {
    const repo = makeRepo("rm-missing");
    const rm = removeWorktree(repo, "nope", { cwd: repo });
    expect(rm.ok).toBe(false);
    if (rm.ok) return;
    expect(rm.message).toContain("没有名为");
  });
});

/* ------------------------------------------------------------------ */
/* f. 命令层                                                           */
/* ------------------------------------------------------------------ */

describe("f. /worktree 命令", () => {
  test("list：空清单给出创建提示", async () => {
    const repo = makeRepo("cmd-empty");
    const { ui, out } = captureConsole();
    await dispatchCommand("/worktree list", makeCmdCtx(repo, ui));
    expect(out()).toContain("没有 neo 托管的 worktree");
    expect(out()).toContain("--worktree");
  });

  test("list：显示名/分支/脏/当前", async () => {
    const repo = makeRepo("cmd-list");
    const a = ensureWorktree(repo, "alpha");
    const b = ensureWorktree(repo, "beta");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    writeFileSync(join(b.path, "wip.txt"), "x\n");

    const { ui, out } = captureConsole();
    await dispatchCommand("/worktree list", makeCmdCtx(a.path, ui));
    const text = out();
    expect(text).toContain("alpha");
    expect(text).toContain("neo/alpha");
    expect(text).toContain("当前");
    expect(text).toContain("beta");
    expect(text).toContain("改动未提交");
    expect(text).toContain("干净");
  });

  test("remove：干净成功", async () => {
    const repo = makeRepo("cmd-remove");
    const r = ensureWorktree(repo, "togo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { ui, out } = captureConsole();
    await dispatchCommand("/worktree remove togo", makeCmdCtx(repo, ui));
    expect(out()).toContain("已删除 worktree togo");
    expect(existsSync(r.path)).toBe(false);
  });

  test("remove：脏且无 --force → 拒绝，不弹确认、不删", async () => {
    const repo = makeRepo("cmd-remove-dirty");
    const r = ensureWorktree(repo, "keepme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "wip.txt"), "x\n");
    const { ui, out } = captureConsole();
    await dispatchCommand("/worktree remove keepme", makeCmdCtx(repo, ui));
    expect(out()).toContain("拒绝删除");
    expect(out()).toContain("--force");
    expect(existsSync(join(r.path, "wip.txt"))).toBe(true);
  });

  test("remove --force：脏工作区经一次确认后删除", async () => {
    const repo = makeRepo("cmd-remove-force");
    const r = ensureWorktree(repo, "forceme");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "wip.txt"), "x\n");
    const { ui, out } = captureConsole({ stdinIsTTY: true });
    // 模拟用户在确认问句上点头（Console 的注入点，不 mock 模块）。
    // stdinIsTTY 必须为 true：confirm 先看 TTY、后取 asker，非 TTY 一律拒绝。
    ui.setAsker(async () => "y");
    // 先确认它确实脏 —— 否则这条测试会退化成「干净删除」，测不到确认分支。
    expect(listManaged(repo)[0]!.dirty).toBe(true);
    await dispatchCommand("/worktree remove forceme --force", makeCmdCtx(repo, ui));
    // 脏 + --force 走确认分支（确认后删除），而不是静默直接删。
    // 注意：--force 是用户已明确表达的意图，文案不该再说「拒绝删除」（那是无 --force 时的说法），
    // 但仍要弹一次确认，把「将丢弃哪些改动」摆到眼前。
    expect(out()).toContain("已强制删除");
    expect(out()).not.toContain("拒绝删除");
    expect(existsSync(r.path)).toBe(false);
  });

  test("remove --force：确认被拒时一个字节都不删", async () => {
    const repo = makeRepo("cmd-remove-force-no");
    const r = ensureWorktree(repo, "nope-me");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "wip.txt"), "x\n");
    const { ui, out } = captureConsole();
    ui.setAsker(async () => "n");
    await dispatchCommand("/worktree remove nope-me --force", makeCmdCtx(repo, ui));
    expect(out()).toContain("已取消");
    expect(existsSync(join(r.path, "wip.txt"))).toBe(true);
  });

  test("remove --force：非交互环境（无 asker）拒绝，不静默丢弃改动", async () => {
    const repo = makeRepo("cmd-remove-force-notty");
    const r = ensureWorktree(repo, "ci-wt");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "wip.txt"), "x\n");
    const { ui, out } = captureConsole({ stdinIsTTY: false });
    await dispatchCommand("/worktree remove ci-wt --force", makeCmdCtx(repo, ui));
    expect(out()).toContain("非交互模式");
    expect(existsSync(join(r.path, "wip.txt"))).toBe(true);
  });

  test("非 git 目录：list 给出可读提示而不是抛错", async () => {
    const plain = join(ROOT, "cmd-plain");
    mkdirSync(plain, { recursive: true });
    const { ui, out } = captureConsole();
    await dispatchCommand("/worktree list", makeCmdCtx(plain, ui));
    expect(out()).toContain("不是 git 仓库");
  });

  test("未知子命令：列出可用子命令", async () => {
    const repo = makeRepo("cmd-unknown");
    const { ui, out } = captureConsole();
    await dispatchCommand("/worktree bogus", makeCmdCtx(repo, ui));
    expect(out()).toContain("未知子命令");
    expect(out()).toContain("list | remove");
  });
});

describe("g. 声明与帮助", () => {
  test("COMMANDS 含 worktree，说明写的是托管与清理", () => {
    const entry = COMMANDS.find((c) => c.name === "worktree");
    expect(entry).toBeDefined();
    expect(entry!.description).toContain("list");
    expect(entry!.description).toContain("remove");
  });

  test("helpText 含 --worktree、默认路径、.gitignore 与 /worktree", () => {
    const text = helpText();
    expect(text).toContain("--worktree <name>");
    expect(text).toContain(".neo/worktrees/");
    expect(text).toContain(".gitignore");
    expect(text).toContain("/worktree list");
    expect(text).toContain("/worktree remove");
    expect(text).toContain("不是权限");
  });
});

/* ------------------------------------------------------------------ */
/* h. 软链路径（issue #26）                                            */
/* ------------------------------------------------------------------ */

/**
 * issue #26：调用方传入的**原始路径**与 git 报的 **realpath** 比对，
 * 软链路径下两者不等 → 托管清单恒空、复用失败、孤儿误判。
 *
 * macOS 上 /var → /private/var、/tmp → /private/tmp；
 * Linux 上 /tmp 非软链 → 这类用例在 CI 上是绿的，只有 macOS 会红。
 * 所以这里**显式造软链**，不依赖开发机 /tmp 的形态，
 * 让两个平台都能验证同一条不变量。
 */
describe("h. 软链路径下的托管清单", () => {
  /** 建仓库 → 用软链别名指向它 → 返回 { real, alias }。 */
  function makeLinkedRepo(name: string): { real: string; alias: string } {
    const real = makeRepo(name);
    const alias = join(ROOT, `${name}-alias`);
    symlinkSync(real, alias);
    return { real, alias };
  }

  test("listManaged：软链路径下也能列出托管 worktree", () => {
    const { real, alias } = makeLinkedRepo("link-list");
    const r = ensureWorktree(alias, "feat");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 用别名调用（调用方视角：原始路径）
    const viaAlias = listManaged(alias);
    expect(viaAlias.map((w) => w.name)).toEqual(["feat"]);
    expect(viaAlias[0]!.branch).toBe("neo/feat");

    // 用真实路径调用（git 视角：realpath）—— 两种写法结果一致
    const viaReal = listManaged(real);
    expect(viaReal.map((w) => w.name)).toEqual(["feat"]);

    // 两侧清单的 path 归一到同一口径
    expect(canonicalize(viaAlias[0]!.path)).toBe(canonicalize(viaReal[0]!.path));
  });

  test("ensureWorktree：软链路径下第二次是复用，不是「不是 neo 托管的」", () => {
    const { alias } = makeLinkedRepo("link-reuse");
    const first = ensureWorktree(alias, "feat");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = ensureWorktree(alias, "feat");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(canonicalize(second.path)).toBe(canonicalize(first.path));
  });

  test("ensureWorktree：路径用软链写法、分支用真实路径写法，也能复用同一个", () => {
    const { real, alias } = makeLinkedRepo("link-mixed");
    const first = ensureWorktree(real, "feat");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 换一种路径写法再来：仍应命中同一个托管 worktree
    const second = ensureWorktree(alias, "feat");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(canonicalize(second.path)).toBe(canonicalize(first.path));
  });

  test("removeWorktree：软链路径下能正常删除托管 worktree", () => {
    const { alias } = makeLinkedRepo("link-remove");
    const r = ensureWorktree(alias, "gone");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rm = removeWorktree(alias, "gone", { cwd: alias });
    expect(rm.ok).toBe(true);
    if (!rm.ok) return;
    expect(existsSync(r.path)).toBe(false);
    expect(listManaged(alias)).toEqual([]);
  });

  test("orphanDirs：软链路径下不把真实托管目录误判成孤儿", () => {
    const { alias } = makeLinkedRepo("link-orphan");
    const r = ensureWorktree(alias, "feat");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 托管目录里有真实托管的 feat → 不是孤儿
    expect(orphanDirs(alias)).toEqual([]);

    // 塞一个 git 不认的目录 → 仍然是孤儿
    mkdirSync(join(worktreeRoot(alias), "leftover"), { recursive: true });
    const orphans = orphanDirs(alias);
    expect(orphans.length).toBe(1);
    expect(orphans[0]!.endsWith("leftover")).toBe(true);
  });

  test("detectRepo：mainRoot 在软链路径下是 canonical 口径", () => {
    const { real, alias } = makeLinkedRepo("link-detect");
    const fromAlias = detectRepo(alias);
    const fromReal = detectRepo(real);
    expect(fromAlias.ok && fromReal.ok).toBe(true);
    if (!fromAlias.ok || !fromReal.ok) return;
    expect(fromAlias.mainRoot).toBe(canonicalize(real));
    expect(fromAlias.mainRoot).toBe(fromReal.mainRoot);
  });

  /* 安全断言不得因归一而削弱（issue #26 验收标准 3）。 */

  test("安全断言：非托管目录即使路径归一后指向托管位置，也绝不覆盖", () => {
    const { real, alias } = makeLinkedRepo("link-safety");
    // 手工占位：真实路径下的托管目录存在，但不是 neo 建的（git 不认）
    const p = worktreePath(real, "taken");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "keep.txt"), "user data\n");

    const r = ensureWorktree(alias, "taken");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("不是 neo 托管的 worktree");
    expect(existsSync(join(p, "keep.txt"))).toBe(true);
  });

  test("安全断言：软链路径下当前 worktree 仍不可删", () => {
    const { alias } = makeLinkedRepo("link-safety-current");
    const r = ensureWorktree(alias, "here");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const rm = removeWorktree(alias, "here", { cwd: r.path, force: true });
    expect(rm.ok).toBe(false);
    if (rm.ok) return;
    expect(rm.message).toContain("当前会话所在");
    expect(existsSync(r.path)).toBe(true);
  });

  test("安全断言：软链路径下脏工作区仍拒绝删除", () => {
    const { alias } = makeLinkedRepo("link-safety-dirty");
    const r = ensureWorktree(alias, "dirty");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    writeFileSync(join(r.path, "wip.txt"), "x\n");

    const rm = removeWorktree(alias, "dirty", { cwd: alias });
    expect(rm.ok).toBe(false);
    if (rm.ok) return;
    expect(rm.needsForce).toBe(true);
    expect(existsSync(join(r.path, "wip.txt"))).toBe(true);
  });
});
