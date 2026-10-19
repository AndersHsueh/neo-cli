/**
 * symlink 遍历回归 —— PRD docs/skills-prd[done].md §5（前置必修）/ §7.1 F 组。
 *
 * 运行：bun test
 *
 * ============================================================================
 * 【为什么单独成文件】
 * ============================================================================
 * F 组是本特性的**地基**：不修 `e.isDirectory() || e.isSymbolicLink()`，
 * glob / grep / list_dir / 工作目录树全部对软链失效（PRD §5.1 实测）。
 *
 * 它与 skills.test.ts 分开放行，是因为 skills.test.ts 会
 * `import "../src/skills.ts"`（该模块尚未实现）。同文件时模块解析失败会让
 * 整个文件无法加载，F 组的真实失败原因（「glob 返回无匹配」）就被
 * 「Cannot find module」掩盖掉了。
 *
 * 本文件**刻意不 import src/skills.ts**，因此始终可运行 ——
 * 阶段 A（无实现）时它会暴露真实的 symlink 遍历缺陷，
 * 阶段 B（实现后）它必须保持对真实目录的既有行为不回归。
 * ============================================================================
 *
 * 布局（全部在 mkdtemp 沙箱内，软链用绝对路径）：
 *
 *   <SANDBOX>/n/cwd/                ← 项目工作目录（ctx.cfg.cwd）
 *     skills/foo -> <SANDBOX>/n/store/foo   （软链，模拟 use_skill 建出的懒加载产物）
 *     real/pdf/SKILL.md             （真目录对照组）
 *   <SANDBOX>/n/store/              ← 假全局技能库（cfg.skillsStore）
 *     foo/SKILL.md
 *
 * 本文件不读写真实 ~/.neo/skills/。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/tools/index.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import type { Config } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/index.ts";

// realpathSync 归一：macOS 的 tmpdir() 是 /var/folders/...（本身是软链），
// 与后续 realpath 结果（/private/var/...）不一致会让相对路径断言失真。
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-symlink-test-")));

/** 唯一标识正文内容，grep 靠它命中。 */
const NEEDLE = "SYMNEEDLE-7f3a";

/** SKILL.md 固定内容。NEEDLE 落在第 8 行（1 起）。 */
const SKILL_MD_FOO = `---\nname: foo\ndescription: 软链侧技能\n---\n\n# Foo\n\n${NEEDLE}\n`;
const SKILL_MD_PDF = `---\nname: pdf\ndescription: 真目录技能\n---\n\n# PDF\n\n${NEEDLE}\n`;

/** 行号由内容推导而非手写，fixture 一改断言自动跟随，杜绝漂移导致的假红。 */
const NEEDLE_LINE = SKILL_MD_FOO.split("\n").findIndex((l) => l.includes(NEEDLE)) + 1;

let seq = 0;

interface Layout {
  cwd: string;
  store: string;
  link: string;
  ctx: ToolCtx;
  cfg: Config;
}

/** 每次调用铺一套全新的沙箱布局。 */
function layout(): Layout {
  const n = `t${seq++}`;
  const cwd = join(SANDBOX, n, "cwd");
  const store = join(SANDBOX, n, "store");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, "skills"), { recursive: true });

  // 假全局技能库
  mkdirSync(join(store, "foo"), { recursive: true });
  writeFileSync(join(store, "foo", "SKILL.md"), SKILL_MD_FOO, "utf8");
  writeFileSync(join(store, "foo", "inner.md"), `内页也含 ${NEEDLE}\n`, "utf8");

  // 项目侧软链（绝对路径，模拟 use_skill 的懒加载产物）
  const link = join(cwd, "skills", "foo");
  symlinkSync(join(store, "foo"), link, "dir");

  // 真目录对照组
  mkdirSync(join(cwd, "real", "pdf"), { recursive: true });
  writeFileSync(join(cwd, "real", "pdf", "SKILL.md"), SKILL_MD_PDF, "utf8");

  const cfg = {
    cwd,
    toolOutputLimit: 30_000,
    skillsStore: store,
  } as unknown as Config;

  return { cwd, store, link, cfg, ctx: { cfg, approve: async () => true } };
}

/* ================================================================== */
/* F1 glob —— 修复前返回「无匹配文件」                                */
/* ================================================================== */

describe("F1 glob 能穿过软链", () => {
  test('glob "skills/**/*.md" 从 cwd 能列出软链内的 SKILL.md', async () => {
    const { cwd, ctx } = layout();

    const r = await dispatch("glob", JSON.stringify({ pattern: "skills/**/*.md", path: cwd }), ctx);

    expect(r.ok).toBe(true);
    // 修复前：glob 返回「无匹配文件: skills/**/*.md」，此处必失败
    expect(r.output).not.toContain("无匹配文件");
    expect(r.output).toContain("SKILL.md");
    expect(r.output).toContain("skills/foo/SKILL.md");
  });

  test("glob 不因软链产生重复条目（同一文件只列一次）", async () => {
    const { cwd, ctx } = layout();

    const r = await dispatch("glob", JSON.stringify({ pattern: "**/*.md", path: cwd }), ctx);

    expect(r.ok).toBe(true);
    const hits = r.output.split("\n").filter((l) => l.includes("skills/foo/SKILL.md"));
    expect(hits.length).toBe(1);
  });
});

/* ================================================================== */
/* F2 grep —— 修复前 filesScanned: 0，静默扫不到                      */
/* ================================================================== */

describe("F2 grep 能穿过软链", () => {
  test("grep 从 cwd 递归能命中软链内文件并给出行号", async () => {
    const { cwd, ctx } = layout();

    const r = await dispatch("grep", JSON.stringify({ pattern: NEEDLE, path: cwd }), ctx);

    expect(r.ok).toBe(true);
    // 修复前：「无匹配。扫描 0 个文件」，此处必失败
    expect(r.output).not.toContain("无匹配");
    expect(r.output).toContain(`SKILL.md:${NEEDLE_LINE}:`);
    expect(r.output).toContain(`skills/foo/SKILL.md:${NEEDLE_LINE}:`);
  });

  test("grep 能扫到软链内的非 SKILL.md 附件", async () => {
    const { cwd, ctx } = layout();

    const r = await dispatch("grep", JSON.stringify({ pattern: NEEDLE, path: cwd }), ctx);

    expect(r.ok).toBe(true);
    expect(r.output).toContain("skills/foo/inner.md");
  });
});

/* ================================================================== */
/* F3 / F4 list_dir —— 软链要呈现为目录                               */
/* ================================================================== */

describe("F3/F4 list_dir 把软链当目录", () => {
  test("F3 list_dir skills：软链显示为 foo/（带尾斜杠）", async () => {
    const { cwd, ctx } = layout();

    const r = await dispatch("list_dir", JSON.stringify({ path: join(cwd, "skills") }), ctx);

    expect(r.ok).toBe(true);
    expect(r.output).toContain("foo/");
    // 修复前显示为 `foo  (128B, 05:13)` —— 被当成文件
    expect(r.output).not.toMatch(/foo\s+\(\d+B/);
  });

  test("F4 list_dir skills recursive：能列出软链内文件", async () => {
    const { cwd, ctx } = layout();

    const r = await dispatch(
      "list_dir",
      JSON.stringify({ path: join(cwd, "skills"), recursive: true }),
      ctx,
    );

    expect(r.ok).toBe(true);
    expect(r.output).toContain("foo/");
    expect(r.output).toContain("SKILL.md");
    expect(r.output).toContain("inner.md");
  });
});

/* ================================================================== */
/* F5 修复不破坏真实目录遍历（回归护栏）                              */
/* ================================================================== */

describe("F5 真实目录遍历不被修复破坏", () => {
  test('glob "real/**/*.md" 对真目录同样有效', async () => {
    const { cwd, ctx } = layout();

    const r = await dispatch("glob", JSON.stringify({ pattern: "real/**/*.md", path: cwd }), ctx);

    expect(r.ok).toBe(true);
    expect(r.output).toContain("real/pdf/SKILL.md");
  });

  test("grep 对真目录同样命中并给出行号", async () => {
    const { cwd, ctx } = layout();

    const r = await dispatch("grep", JSON.stringify({ pattern: NEEDLE, path: cwd }), ctx);

    expect(r.ok).toBe(true);
    expect(r.output).toContain(`real/pdf/SKILL.md:${NEEDLE_LINE}:`);
  });

  test("list_dir 真目录仍按目录呈现并可递归", async () => {
    const { cwd, ctx } = layout();

    const flat = await dispatch("list_dir", JSON.stringify({ path: join(cwd, "real") }), ctx);
    expect(flat.ok).toBe(true);
    expect(flat.output).toContain("pdf/");
    expect(flat.output).not.toContain("SKILL.md"); // 非递归时不列内容

    const deep = await dispatch(
      "list_dir",
      JSON.stringify({ path: join(cwd, "real"), recursive: true }),
      ctx,
    );
    expect(deep.ok).toBe(true);
    expect(deep.output).toContain("pdf/SKILL.md");
  });
});

/* ================================================================== */
/* F6 §5.3 验收项之四：工作目录树把软链显示为目录                      */
/* （PRD §7.1 F 组未列此例，但 §5.3 验收标准与 §12 改动点索引都要求      */
/*   src/system-prompt.ts:40 一并修复，故补上，否则该验收项无测试覆盖）  */
/* ================================================================== */

describe("F6 system prompt 工作目录树把软链显示为目录", () => {
  test("工作目录树含 skills/foo/ 且能递归到 skills/foo/SKILL.md", () => {
    const { cwd, store, cfg } = layout();

    const prompt = buildSystemPrompt(cfg);

    // 修复前：树里是 `skills/foo`（无尾斜杠），且不会列出其内容
    expect(prompt).toContain("skills/foo/");
    expect(prompt).toContain("skills/foo/SKILL.md");
    expect(store).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

// 必须用 afterAll 而非顶层 cleanup()：bun 在**收集阶段**就执行模块顶层代码，
// 顶层调用会在任何用例开始前删掉 SANDBOX。本文件此前侥幸没炸，只因为 layout()
// 用的是 mkdirSync(recursive) 而非 mkdtempSync —— 删了会自愈。
// 这是掩盖而非安全：一旦有人改用 mkdtempSync，全部用例会以ENOENT 假红。
// 同样的坑曾让 tests/skills.test.ts 的 57 个用例假红（详见 docs/red-phase-evidence.md）。
afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});