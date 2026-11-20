/**
 * issue #54：按子目录按需加载嵌套 AGENTS.md / CLAUDE.md。
 *
 * 纯函数 + 临时目录（含假 git 根与非 git 树），不触网、不碰真实 ~/.neo。
 * 与 #17（`.neo/rules` + `paths:` glob）、#63（额外工作根 / --add-dir）口径对齐但不实现后者。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INSTRUCTION_FILE_NAMES,
  collectAncestorInstructionFiles,
  collectNestedInstructionFiles,
  composePermanentMemory,
  findGitWorkTreeRoot,
  formatNestedAgentsBlock,
  loadSessionInstructionMemory,
  nestedAgentsReport,
  pickInstructionFile,
} from "../src/cli/nestedAgents.ts";
import { readRootMemoryFile } from "../src/cli/cdWorkdir.ts";
import { helpText } from "../src/cli/help.ts";
import { readFileSync } from "node:fs";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-54-nested-")));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

let seq = 0;
function tempCase(name: string): string {
  seq += 1;
  const dir = join(SANDBOX, `${name}-${seq}`);
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

function writeFile(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function initFakeGit(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
}

describe("A 单目录文件名优先级", () => {
  test("优先级为 AGENTS.md → NEO.md → .neo.md → CLAUDE.md，同一目录只取一个", () => {
    expect([...INSTRUCTION_FILE_NAMES]).toEqual(["AGENTS.md", "NEO.md", ".neo.md", "CLAUDE.md"]);
    const dir = tempCase("prio-all");
    writeFile(dir, "CLAUDE.md", "CLAUDE-BODY");
    writeFile(dir, ".neo.md", "NEO-DOT-BODY");
    writeFile(dir, "NEO.md", "NEO-BODY");
    writeFile(dir, "AGENTS.md", "AGENTS-BODY");
    const picked = pickInstructionFile(dir);
    expect(picked?.name).toBe("AGENTS.md");
    expect(picked?.text).toBe("AGENTS-BODY");
    expect(picked?.text).not.toContain("NEO-BODY");
    expect(picked?.text).not.toContain("CLAUDE-BODY");
  });

  test("只有 CLAUDE.md 时才选它；有 NEO.md 时不改选 CLAUDE.md", () => {
    const onlyClaude = tempCase("only-claude");
    writeFile(onlyClaude, "CLAUDE.md", "CLAUDE-ONLY");
    expect(pickInstructionFile(onlyClaude)?.name).toBe("CLAUDE.md");
    expect(readRootMemoryFile(onlyClaude)?.text).toBe("CLAUDE-ONLY");

    const neoWins = tempCase("neo-wins");
    writeFile(neoWins, "NEO.md", "NEO-WINS");
    writeFile(neoWins, "CLAUDE.md", "CLAUDE-LOSES");
    expect(pickInstructionFile(neoWins)?.name).toBe("NEO.md");
    expect(pickInstructionFile(neoWins)?.text).toBe("NEO-WINS");
  });

  test("跳过同名目录，只认普通文件；都不存在则返回 null", () => {
    const dir = tempCase("skip-dir");
    mkdirSync(join(dir, "AGENTS.md"));
    writeFile(dir, "CLAUDE.md", "FILE-CLAUDE");
    expect(pickInstructionFile(dir)?.name).toBe("CLAUDE.md");
    const empty = tempCase("empty");
    expect(pickInstructionFile(empty)).toBeNull();
    expect(readRootMemoryFile(empty)).toBeNull();
  });
});

describe("B 启动不预载子目录嵌套文件", () => {
  test("git 仓内启动只收 cwd 与祖先，不收 packages/foo 等子目录", () => {
    const repo = tempCase("no-preload");
    initFakeGit(repo);
    writeFile(repo, "AGENTS.md", "ROOT-AGENTS");
    writeFile(repo, "packages/foo/AGENTS.md", "FOO-NESTED-SHOULD-NOT-PRELOAD");
    writeFile(repo, "packages/foo/bar/CLAUDE.md", "BAR-NESTED-SHOULD-NOT-PRELOAD");
    const cwd = join(repo, "packages");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "NEO.md", "PACKAGES-NEO");

    const permanent = composePermanentMemory(cwd);
    const texts = permanent?.files.map((f) => f.text) ?? [];
    expect(texts).toContain("ROOT-AGENTS");
    expect(texts).toContain("PACKAGES-NEO");
    expect(texts.join("\n")).not.toContain("FOO-NESTED-SHOULD-NOT-PRELOAD");
    expect(texts.join("\n")).not.toContain("BAR-NESTED-SHOULD-NOT-PRELOAD");
    expect(permanent?.text).not.toContain("FOO-NESTED-SHOULD-NOT-PRELOAD");
  });
});

describe("C 祖先链只走到 git 工作树根", () => {
  test("有 git 根：向上收到工作树根（含），不越过 .git，也不收到子目录", () => {
    const outer = tempCase("outer-not-git");
    writeFile(outer, "AGENTS.md", "ABOVE-GIT-SHOULD-NOT-LOAD");
    const repo = join(outer, "repo");
    mkdirSync(repo, { recursive: true });
    initFakeGit(repo);
    writeFile(repo, "AGENTS.md", "GIT-ROOT-AGENTS");
    writeFile(repo, "packages/AGENTS.md", "PACKAGES-AGENTS");
    const cwd = join(repo, "packages", "foo");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "AGENTS.md", "FOO-CWD-AGENTS");
    writeFile(cwd, "src/AGENTS.md", "NESTED-CHILD");

    expect(findGitWorkTreeRoot(cwd)).toBe(realpathSync(repo));
    const ancestors = collectAncestorInstructionFiles(cwd);
    const texts = ancestors.map((f) => f.text);
    expect(texts).toContain("GIT-ROOT-AGENTS");
    expect(texts).toContain("PACKAGES-AGENTS");
    expect(texts).not.toContain("FOO-CWD-AGENTS");
    expect(texts).not.toContain("ABOVE-GIT-SHOULD-NOT-LOAD");
    expect(texts).not.toContain("NESTED-CHILD");
    // 更通用的在前（git 根 → 靠近 cwd）
    expect(texts.indexOf("GIT-ROOT-AGENTS")).toBeLessThan(texts.indexOf("PACKAGES-AGENTS"));
  });

  test("无 git 仓：不走到 / 或父目录，只返回 cwd 自己的文件", () => {
    const parent = tempCase("nongit-parent");
    writeFile(parent, "AGENTS.md", "PARENT-SHOULD-NOT-LOAD");
    const cwd = join(parent, "proj");
    mkdirSync(cwd, { recursive: true });
    writeFile(cwd, "AGENTS.md", "CWD-ONLY");
    expect(findGitWorkTreeRoot(cwd)).toBeNull();
    expect(collectAncestorInstructionFiles(cwd)).toEqual([]);
    const mem = composePermanentMemory(cwd);
    expect(mem?.files).toHaveLength(1);
    expect(mem?.text).toContain("CWD-ONLY");
    expect(mem?.text).not.toContain("PARENT-SHOULD-NOT-LOAD");
  });

  test("cwd 就是 git 根时没有祖先；.git 文件也算工作树根", () => {
    const repo = tempCase("cwd-is-root");
    initFakeGit(repo);
    writeFile(repo, "AGENTS.md", "AT-ROOT");
    writeFile(repo, "sub/AGENTS.md", "CHILD");
    expect(collectAncestorInstructionFiles(repo)).toEqual([]);
    expect(composePermanentMemory(repo)?.text).toContain("AT-ROOT");
    expect(composePermanentMemory(repo)?.text).not.toContain("CHILD");

    const linked = tempCase("git-file");
    writeFile(linked, ".git", "gitdir: /tmp/fake-gitdir-54\n");
    const sub = join(linked, "pkg");
    mkdirSync(sub, { recursive: true });
    expect(findGitWorkTreeRoot(sub)).toBe(realpathSync(linked));
  });
});

describe("D 按需嵌套：从触达路径向上到但不含会话根", () => {
  test("触达 packages/foo/bar/x.ts 且 packages/foo/AGENTS.md 存在时必须收录", () => {
    const repo = tempCase("on-demand");
    initFakeGit(repo);
    writeFile(repo, "AGENTS.md", "ROOT-PERM");
    writeFile(repo, "packages/foo/AGENTS.md", "FOO-NESTED-MARKER");
    writeFile(repo, "packages/foo/bar/x.ts", "export const x = 1;\n");
    const files = collectNestedInstructionFiles({
      roots: [repo],
      touched: ["packages/foo/bar/x.ts"],
    });
    expect(files.map((f) => f.text)).toContain("FOO-NESTED-MARKER");
    expect(files.map((f) => f.text)).not.toContain("ROOT-PERM");
  });

  test("不重复注入已在永久段的 cwd / 祖先文件；roots 外的路径忽略", () => {
    const repo = tempCase("exclude-perm");
    initFakeGit(repo);
    const rootFile = writeFile(repo, "AGENTS.md", "ROOT-PERM");
    const pkgFile = writeFile(repo, "packages/AGENTS.md", "PKG-PERM");
    writeFile(repo, "packages/foo/AGENTS.md", "FOO-NESTED");
    writeFile(repo, "packages/foo/a.ts", "a");
    const outside = tempCase("outside");
    writeFile(outside, "AGENTS.md", "OUTSIDE-SHOULD-IGNORE");
    writeFile(outside, "z.ts", "z");

    const files = collectNestedInstructionFiles({
      roots: [repo],
      touched: ["packages/foo/a.ts", join(outside, "z.ts")],
      exclude: [rootFile, pkgFile],
    });
    const texts = files.map((f) => f.text);
    expect(texts).toContain("FOO-NESTED");
    expect(texts).not.toContain("ROOT-PERM");
    expect(texts).not.toContain("PKG-PERM");
    expect(texts).not.toContain("OUTSIDE-SHOULD-IGNORE");
  });

  test("helper 接受 roots 列表，但只收录被触达的那一个根下的文件", () => {
    const a = tempCase("root-a");
    const b = tempCase("root-b");
    writeFile(a, "pkg/AGENTS.md", "FROM-A");
    writeFile(a, "pkg/a.ts", "a");
    writeFile(b, "pkg/AGENTS.md", "FROM-B");
    writeFile(b, "pkg/b.ts", "b");
    const onlyA = collectNestedInstructionFiles({
      roots: [a, b],
      touched: [join(a, "pkg/a.ts")],
    });
    expect(onlyA.map((f) => f.text)).toEqual(["FROM-A"]);
    expect(onlyA.map((f) => f.text)).not.toContain("FROM-B");
  });

  test("目录触达（list_dir）从该目录本身往上收；写/改不存在的文件也从其父目录走", () => {
    const repo = tempCase("dir-and-create");
    writeFile(repo, "packages/foo/AGENTS.md", "FOO-DIR");
    mkdirSync(join(repo, "packages/foo/bar"), { recursive: true });
    const viaDir = collectNestedInstructionFiles({
      roots: [repo],
      touched: ["packages/foo"],
    });
    expect(viaDir.map((f) => f.text)).toContain("FOO-DIR");

    const viaCreate = collectNestedInstructionFiles({
      roots: [repo],
      touched: ["packages/foo/bar/new.ts"],
    });
    expect(viaCreate.map((f) => f.text)).toContain("FOO-DIR");
  });
});

describe("E 渲染、/context 报告与 safe-mode", () => {
  test("临时块带来源路径；标题与 #17 路径作用域规则区分；报告只列路径不带大段正文", () => {
    const repo = tempCase("format");
    const p = writeFile(repo, "pkg/AGENTS.md", "NESTED-BODY-MARKER-SHOULD-BE-IN-BLOCK");
    const files = collectNestedInstructionFiles({ roots: [repo], touched: ["pkg/x.ts"] });
    const block = formatNestedAgentsBlock(files);
    expect(block).toContain("嵌套");
    expect(block).toContain(p);
    expect(block).toContain("NESTED-BODY-MARKER-SHOULD-BE-IN-BLOCK");
    expect(block).not.toContain("路径作用域规则");
    expect(block).not.toContain("add-dir");

    const huge = "X".repeat(8000);
    const report = nestedAgentsReport([
      { path: p, dir: join(repo, "pkg"), name: "AGENTS.md", text: huge },
    ]);
    expect(report.join("\n")).toContain(p);
    expect(report.join("\n")).not.toContain(huge);
  });

  test("safe-mode 不加载根文件、祖先或嵌套；关闭时才组永久段", () => {
    const repo = tempCase("safe");
    initFakeGit(repo);
    writeFile(repo, "AGENTS.md", "SHOULD-SKIP-IN-SAFE");
    const sub = join(repo, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFile(sub, "AGENTS.md", "CWD-SHOULD-SKIP");
    expect(loadSessionInstructionMemory(sub, { safeMode: true })).toBeNull();
    expect(loadSessionInstructionMemory(sub, { safeMode: false })?.text).toContain("SHOULD-SKIP-IN-SAFE");
    expect(loadSessionInstructionMemory(sub, { safeMode: false })?.text).toContain("CWD-SHOULD-SKIP");
  });
});

describe("F 帮助与 README 口径：#54 / #63 / #17 分开", () => {
  test("帮助不再写「只加载新根上那一个」，并区分 #54 与 #63 / #17", () => {
    const text = helpText();
    expect(text).toContain("/cd");
    expect(text).not.toContain("只加载新根上那一个");
    expect(text).toContain("#54");
    expect(text).toContain("#63");
    expect(text).toContain("#17");
    expect(text).toContain("AGENTS.md");
    expect(text).toContain("CLAUDE.md");
    expect(text).toMatch(/按需|嵌套/);
    expect(text).not.toMatch(/#63[^\n]*已实现/);
  });

  test("README 说明 #54 按需加载，并与 #17 / #63 区分；不再写只加载新根那一个", () => {
    const readme = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
    expect(readme).not.toContain("#54` 嵌套 `AGENTS.md`（本命令只加载新根上那一个");
    expect(readme).toContain("#54");
    expect(readme).toContain("#17");
    expect(readme).toContain("#63");
    expect(readme).toContain("CLAUDE.md");
    expect(readme).toMatch(/按需加载|按子目录按需/);
    expect(readme).toContain(".neo/rules");
    expect(readme).toMatch(/add-dir/);
  });
});

describe("G /cd 刷新祖先链并改跟新根做按需加载", () => {
  test("换到 git 仓子目录后永久段含新根自己与祖先，不含其嵌套子目录", async () => {
    const { changeSessionCwd } = await import("../src/cli/cdWorkdir.ts");
    const { PromptManager } = await import("../src/prompt/manager.ts");
    const repo = tempCase("cd-refresh");
    initFakeGit(repo);
    writeFile(repo, "AGENTS.md", "NEW-ROOT-ANCESTOR");
    const sub = join(repo, "pkg");
    mkdirSync(sub, { recursive: true });
    writeFile(sub, "AGENTS.md", "NEW-CWD-AGENTS");
    writeFile(sub, "deep/AGENTS.md", "STILL-NESTED-NOT-PERM");
    const old = tempCase("cd-old");
    writeFile(old, "AGENTS.md", "OLD-CWD-AGENTS");

    const cfg = { cwd: old } as import("../src/config.ts").Config;
    const meta = { cwd: old } as import("../src/session.ts").SessionMeta;
    const promptManager = new PromptManager({ mailbox: false, askUser: false });
    promptManager.setProjectMemory({ path: join(old, "AGENTS.md"), text: "OLD-CWD-AGENTS" });
    const messages: import("../src/llm.ts").Message[] = [{ role: "system", content: "sys" }];
    const result = await changeSessionCwd(sub, {
      cfg,
      meta,
      messages,
      persist: () => {},
      promptManager,
      refreshSystemPrompt: () => {},
      previousCwd: { get: () => null, set: () => {} },
    });
    expect(result.ok).toBe(true);
    const mem = promptManager.getProjectMemory();
    expect(mem?.text).toContain("NEW-CWD-AGENTS");
    expect(mem?.text).toContain("NEW-ROOT-ANCESTOR");
    expect(mem?.text).not.toContain("STILL-NESTED-NOT-PERM");
    expect(mem?.text).not.toContain("OLD-CWD-AGENTS");

    const nested = collectNestedInstructionFiles({
      roots: [cfg.cwd],
      touched: ["deep/x.ts"],
    });
    expect(nested.map((f) => f.text)).toContain("STILL-NESTED-NOT-PERM");
    expect(nested.map((f) => f.text)).not.toContain("NEW-CWD-AGENTS");
  });
});
