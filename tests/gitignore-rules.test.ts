/**
 * K 组 —— .gitignore 约束验证（PRD §6.5 约束 14/15）
 *
 * 运行：bun test
 *
 * ============================================================================
 * 【为什么单独成文件】
 * ============================================================================
 * 本组断言的是**仓库根的 .gitignore 真实行为**，因此：
 *   - 必须在 worktree 根目录运行（依赖 `git check-ignore` 的仓库上下文）
 *   - 断言用 `git check-ignore` 的实际退出码，而不是读 .gitignore 文本。
 *     文本断言只能证明「有那行字」，证不了「git 真的按它执行」——
 *     而 §6.5 约束 14 的实质恰恰是行为：项目私有技能**不能**被忽略。
 *
 * ============================================================================
 * 【环境坏了必须 fail，不能 skip —— team-lead 明确要求】
 * ============================================================================
 * K1 先校验环境：`git worktree list` 必须能正常输出且包含本 worktree。
 * 若环境损坏（如 .git 指针被破坏），**直接 fail 并说明**，
 * 绝不用 skip/tolerate 掩盖 —— 环境的坏必须被看见。
 * ============================================================================
 *
 * 覆盖的约束：
 *   约束 14 —— `.neo/skills/` 一条即可（目录被忽略后无法被负向规则重新包含，
 *              写 `.neo/skills/` 会连带全部内容一起忽略，无需逐条加 `!`）
 *   约束 15 —— raw 与 wiki 不加规则（`.neo/.wiki/raw/`、`.neo/.wiki/` 必须在版本控制内）
 *   决策 4  —— 项目私有技能（`skills/<name>/` 真目录）**必须**进 git，
 *              只有 `skills/<name>` 软链才该被忽略，而 gitignore 无法区分二者
 *              —— 这正是**不能写裸 `skills/`** 的原因。
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, realpathSync, symlinkSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 仓库根（本测试文件位于 <root>/tests/）。 */
const ROOT = join(import.meta.dir, "..");

/**
 * 跑 git 并返回；非零退出不抛，由调用方判断。
 * 用 execFileSync 而非 shell，避免任何注入面。
 */
function git(args: string[], cwd = ROOT): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() };
  }
}

/** 该路径是否被 gitignore 命中。 */
function isIgnored(path: string, cwd = ROOT): boolean {
  return git(["check-ignore", "-q", path], cwd).ok;
}

/**
 * 环境守卫 —— team-lead 明确要求：**每个** K 组用例在断言前都要校验工作区状态。
 *
 * 背景：product-owner 报告过 worktree 里疑似有 agent 跑过 `git init`。
 * 若环境被破坏，`git check-ignore` 会给出**误导性结果**（而非报错），
 * 那时整个 K 组就变成假绿。所以环境的坏必须被看见 —— 直接 fail，不 skip、不容忍。
 *
 * 注意：本函数只校验「主 worktree 的 git 可用性」。
 * K4.1 / K9 在临时仓库里跑，那里断言的是 git 的机制而非本仓库状态，不需要此守卫。
 */
function assertWorktreeHealthy(): void {
  const wt = git(["worktree", "list"]);
  if (!wt.ok || !wt.out.includes("feature-skills")) {
    // 刻意不用 expect()：让失败信息直接说明「工作区状态异常」而非一条路径断言
    throw new Error(
      `工作区状态异常：git worktree list 未能输出本 worktree（feature-skills）。\n` +
        `这会让 git check-ignore 给出误导性结果，使 K 组整体变成假绿。\n` +
        `git 输出：${wt.out || "(空)"}`,
    );
  }
  if (git(["rev-parse", "--is-inside-work-tree"]).out.trim() !== "true") {
    throw new Error("工作区状态异常：git rev-parse --is-inside-work-tree 不为 true。");
  }
}

/* ------------------------------------------------------------------ */
/* K1 环境自检 —— 坏环境必须 fail，不得 skip                          */
/* ------------------------------------------------------------------ */

describe("K. .gitignore 约束（PRD §6.5）", () => {
  test("K1 环境自检：worktree 完好且 git 可用（环境坏了直接 fail，不得跳过）", () => {
    const wt = git(["worktree", "list"]);
    assertWorktreeHealthy();
    // 环境损坏时 git 会报错或输出异常 —— 这里必须显式失败，让问题被看见
    expect(wt.ok).toBe(true);
    expect(wt.out).toContain("feature-skills");
    expect(git(["rev-parse", "--is-inside-work-tree"]).out.trim()).toBe("true");
    // check-ignore 必须真的可用。历史上出现过 git 环境损坏导致它静默失效，
    // 所以拿一个**本仓库确实存在**的已跟踪文件做反向锚点：
    // 它必须「不被忽略」。若这条也false，说明 git 环境本身坏了，必须 fail。
    // （不能用 node_modules 做锚点 —— 本 worktree 里该目录并不存在，
    //   check-ignore 对不存在的路径会返回未命中，锚点失效。）
    expect(`src/skills.ts 被忽略=${isIgnored("src/skills.ts")}`).toBe("src/skills.ts 被忽略=false");
    expect(`.gitignore 被忽略=${isIgnored(".gitignore")}`).toBe(".gitignore 被忽略=false");
  });

  /* ---------------------------------------------------------------- */
  /* 约束 14：.neo/skills/ 连带全部内容忽略，且不需要逐条 !          */
  /* ---------------------------------------------------------------- */

  test("K2 约束 14：`.neo/skills/` 及其全部内容被忽略", () => {
    assertWorktreeHealthy();
    for (const p of [
      ".neo/skills/",
      ".neo/skills/pdf/SKILL.md",
      ".neo/skills/pdf/references/detail.md",
      ".neo/skills/pdf/scripts/extract.py",
      ".neo/skills/pdf/nested/deep/file.txt",
    ]) {
      expect(`${p}=${isIgnored(p)}`).toBe(`${p}=true`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 决策 4 核心：项目私有技能必须进 git，只有软链该忽略            */
  /* ---------------------------------------------------------------- */

  test("K3 决策 4：项目私有技能目录未被忽略（不能写裸 `skills/`）", () => {
    assertWorktreeHealthy();
    for (const p of [
      "skills/", // 目录本身
      "skills/pdf/", // 软链位置的目录形态
      "skills/project-private/SKILL.md", // 项目私有技能的真实文件
      "skills/team-skill/references/detail.md",
    ]) {
      expect(`${p}=${isIgnored(p)}`).toBe(`${p}=false`);
    }
  });

  test("K4 .gitignore 不得含裸 `skills/` 规则（否则连带忽略项目私有技能）", () => {
    assertWorktreeHealthy();
    const text = readFileSync(join(ROOT, ".gitignore"), "utf8");
    const lines = text.split("\n").map((l) => l.trim());
    // 精确匹配 `skills/`，不能是 `.neo/skills/` 或 `skills/*/SKILL.md` 之类
    expect(lines).not.toContain("skills/");
    // 也不该有任何把整个 skills 目录递归忽略的变体
    expect(lines.some((l) => /^skills\/\*\*?$/.test(l))).toBe(false);
  });

  /**
   * 决策 4 的**技术边界**（team-lead 提供线索，我独立实测确认）：
   * git 遇到含软链的 pathspec 直接报 fatal，**根本不进入忽略规则匹配**：
   *
   *   $ git check-ignore -v linked-skill/SKILL.md
   *   fatal: pathspec 'linked-skill/SKILL.md' is beyond a symbolic link   (exit 128)
   *
   * 所以「只忽略软链、保留真目录」不是难写的规则，而是 **git 匹配机制层面不支持**。
   * 这条用例把该事实钉住—— 若哪天 git 改变了该行为，本用例会红并提示重新评估 PRD §3.3。
   */
  test("K4.1 决策 4 的技术边界：git 对穿过软链的 pathspec 直接 fatal，不做忽略匹配", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "neo-linkedge-")));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, ".gitignore"), readFileSync(join(ROOT, ".gitignore"), "utf8"), "utf8");
      mkdirSync(join(dir, "real"), { recursive: true });
      writeFileSync(join(dir, "real", "SKILL.md"), "x", "utf8");
      // 软链到真目录，模拟 <cwd>/skills/<name> -> store/<name>
      symlinkSync(join(dir, "real"), join(dir, "linked-skill"), "dir");

      const throughLink = git(["check-ignore", "-v", "linked-skill/SKILL.md"], dir);
      // 关键：非零退出且提示 beyond a symbolic link —— 说明根本没进规则匹配
      expect(throughLink.ok).toBe(false);
      expect(throughLink.out).toContain("beyond a symbolic link");

      // 而真目录本身可以被正常判定（证明不是 git 整体坏了）
      expect(git(["check-ignore", "-q", "real/SKILL.md"], dir).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * K4.2 防呆守卫：**永远不要在 worktree 里跑 `git init`**。
   *
   * 背景：product-owner 报告过「有 agent 在 worktree 里跑过 git init」。
   * worktree 的 `.git` 是**指针文件**（内容形如 `gitdir: /abs/path/.git/worktrees/xxx`），
   * 一旦被 `git init` 覆盖成目录，主仓库的 worktree 登记就断了 ——
   * 症状是 `git check-ignore` 静默给出**误导性结果**（不报错，但语义全变），
   * 那时整个 K 组会变成假绿。
   *
   * 本守卫断言 `.git` 仍是**指针文件且指向 worktree 登记目录**。
   * 刻意不自己跑 `git init` 去"验证会坏"—— 那是真的会破坏环境。
   */
  test("K4.2 防呆：worktree 的 .git 必须是指向 worktrees/ 的指针文件（不可被 git init 覆盖）", () => {
    assertWorktreeHealthy();
    const dotGit = join(ROOT, ".git");
    const st = lstatSync(dotGit);
    // 必须是普通文件（指针）。若变成目录，说明有人在这里跑了 git init。
    expect(`isDirectory=${st.isDirectory()}`).toBe("isDirectory=false");
    const content = readFileSync(dotGit, "utf8");
    expect(content).toContain("gitdir:");
    // 指针必须指向主仓库的 worktrees/<name> 登记目录
    expect(content).toMatch(/gitdir:.*\.git[/\\]worktrees[/\\]/);
    // 登记目录里必须有本worktree 的 HEAD，否则 worktree 已脱离主仓库
    const m = /gitdir:\s*(.+)/.exec(content);
    const gitdir = m?.[1]?.trim();
    expect(gitdir).toBeTruthy();
    expect(existsSync(join(gitdir!, "HEAD"))).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /* 约束 15：raw 与 wiki 不加规则，必须在版本控制内                 */
  /* ---------------------------------------------------------------- */

  test("K5 约束 15：`.neo/.wiki/raw/` 与 `.neo/.wiki/` 均未被忽略", () => {
    assertWorktreeHealthy();
    for (const p of [
      ".neo/.wiki/",
      ".neo/.wiki/raw/",
      ".neo/.wiki/raw/某模板原文.md",
      ".neo/.wiki/知识图谱.md",
    ]) {
      expect(`${p}=${isIgnored(p)}`).toBe(`${p}=false`);
    }
  });

  test("K6 约束 15：`.neo/.wiki/outputs/` 被忽略（派生物不进版本控制）", () => {
    assertWorktreeHealthy();
    expect(isIgnored(".neo/.wiki/outputs/")).toBe(true);
    expect(isIgnored(".neo/.wiki/outputs/生成物.md")).toBe(true);
  });

  /* ---------------------------------------------------------------- */
  /* 既有规则不得被本次改动破坏                                        */
  /* ---------------------------------------------------------------- */

  test("K7 既有忽略规则未回归：.worktrees/ 与构建产物仍在", () => {
    assertWorktreeHealthy();
    for (const p of [
      ".worktrees/",
      ".worktrees/feature-skills/src/index.ts",
      "node_modules/",
      "settings.json",
      ".neo-session/",
      ".DS_Store",
      "neo-session.json",
      "dist/",
      "build/",
      "out/",
      "*.tsbuildinfo",
      ".cache/",
    ]) {
      expect(`${p}=${isIgnored(p)}`).toBe(`${p}=true`);
    }
  });

  test("K8 源码与文档未被误忽略（技能系统不该影响常规文件）", () => {
    assertWorktreeHealthy();
    for (const p of [
      "src/skills.ts",
      "src/tools/index.ts",
      "src/system-prompt.ts",
      "tests/skills.test.ts",
      "tests/core.test.ts",
      "docs/skills-prd.md",
      "package.json",
      "README.md",
    ]) {
      expect(`${p}=${isIgnored(p)}`).toBe(`${p}=false`);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 行为级验证：规则在真实仓库中确实按预期执行                      */
  /* ---------------------------------------------------------------- */

  test("K9 行为级：真实临时仓库中复现「私有技能入库、软链被忽略」", () => {
    // 在临时 git 仓库里复用本仓库的 .gitignore，验证 git 的**实际行为**而非文本 ——
    // 这是约束 14 与决策 4 的落点：文本里有那行字，不代表 git 真按它执行。
    // macOS 上 tmpdir() 是 /var/folders/...（本身是软链），realpath 后才是 /private/var/...。
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "neo-ignore-")));
    // git 默认会对非 ASCII 路径做八进制转义（如 "模板.md" → "\346\250\241..."），
    // 所以这里统一用 ASCII 文件名，避免断言被转义干扰。
    const UNIGNORED = [".gitignore", "skills/project-private/SKILL.md", "src/skills.ts", ".neo/.wiki/raw/tpl.md"];
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
      writeFileSync(join(dir, ".gitignore"), readFileSync(join(ROOT, ".gitignore"), "utf8"), "utf8");

      for (const p of [
        ".neo/skills/pdf/SKILL.md", // 期望忽略
        "skills/project-private/SKILL.md", // 期望保留
        ".neo/.wiki/raw/tpl.md", // 期望保留
        ".neo/.wiki/outputs/x.md", // 期望忽略
        "src/skills.ts", // 期望保留
      ]) {
        const full = join(dir, p);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, "x", "utf8");
      }

      const local = (p: string) => isIgnored(p, dir);
      expect(`.neo/skills=${local(".neo/skills/pdf/SKILL.md")}`).toBe(".neo/skills=true");
      expect(`私有技能=${local("skills/project-private/SKILL.md")}`).toBe("私有技能=false");
      expect(`wiki/raw=${local(".neo/.wiki/raw/tpl.md")}`).toBe("wiki/raw=false");
      expect(`wiki/outputs=${local(".neo/.wiki/outputs/x.md")}`).toBe("wiki/outputs=true");
      expect(`src=${local("src/skills.ts")}`).toBe("src=false");

      // git status 只应看到未被忽略的文件。
      // 必须用 -uall：默认会把未跟踪目录折叠成 `.neo/`、`skills/` 一行，
      // 那样既看不出 skills/ 里有东西、也看不出 .neo/.wiki/raw/ 被保留了。
      const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" });
      const seen = status
        .split("\n")
        .filter(Boolean)
        .map((l) => l.slice(3))
        .sort();
      // .neo/ 仍在（因为 .neo/.wiki/raw/ 保留），skills/ 与 src/ 保留，
      // 而 .neo/skills/ 与 .neo/.wiki/outputs/ 必须消失
      expect(seen).toEqual([...UNIGNORED].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
