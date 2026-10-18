/**
 * wiki lint（src/wiki/lint.ts）测试。
 *
 * 覆盖：链接提取（代码块/行内反引号/别名/锚点/.md）、断链、orphan（自链不算）、
 * 摘要/日期戳、链接密度（阈值 + 小库忽略）、豁免文件、目录解析优先级、报告渲染。
 *
 * 运行：bun test tests/wiki-lint.test.ts
 */
import { describe, expect, test, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractLinks,
  lintWiki,
  formatLintReport,
  resolveWikiDir,
  type LintIssue,
} from "../src/wiki/lint.ts";

const ROOT = join(tmpdir(), `neo-wiki-lint-${Date.now()}`);
let seq = 0;

function makeWiki(files: Record<string, string>): string {
  const dir = join(ROOT, `wiki-${seq++}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

/** 造一个合格主题页（有摘要、有日期戳）。 */
function page(opts: {
  title: string;
  links?: string[];
  summary?: boolean;
  stamp?: boolean;
  body?: string;
}): string {
  const parts: string[] = [`# ${opts.title}`, ""];
  if (opts.summary !== false) parts.push("## 摘要", "", "一句话摘要。", "");
  if (opts.stamp !== false) parts.push("最后更新：2026-10-18", "");
  parts.push(opts.body ?? "");
  for (const l of opts.links ?? []) parts.push(`[[${l}]]`);
  return parts.join("\n");
}

const kinds = (issues: LintIssue[], k: LintIssue["kind"]): string[] =>
  issues.filter((i) => i.kind === k).map((i) => i.page);

/* ------------------------------------------------------------------ */
/* extractLinks                                                        */
/* ------------------------------------------------------------------ */

describe("extractLinks", () => {
  test("基础提取 + 别名/锚点/.md 剥离", () => {
    const links = extractLinks(
      "a.md",
      ["[[b]]", "[[c|别名]]", "[[d#锚点]]", "[[e.md]]", "[[f]]"].join("\n"),
    );
    expect(links.map((l) => l.target)).toEqual(["b", "c", "d", "e", "f"]);
    expect(links.every((l) => l.src === "a.md")).toBe(true);
  });

  test("代码围栏内的链接不计", () => {
    const links = extractLinks("a.md", ["```", "[[ghost]]", "```", "", "[[real]]"].join("\n"));
    expect(links.map((l) => l.target)).toEqual(["real"]);
  });

  test("行内反引号内的链接不计", () => {
    const links = extractLinks("a.md", "写法是 `[[ghost]]` 然后 [[real]]");
    expect(links.map((l) => l.target)).toEqual(["real"]);
  });

  test("空目标（[[|x]] 剥离别名后为空）不计", () => {
    const links = extractLinks("a.md", "[[|别名]]");
    expect(links).toEqual([]);
  });

  test("路径式目标（含 /）不计——与 sh 版口径一致", () => {
    const links = extractLinks("a.md", "[[../AGENTS]] [[sub/page]] [[real]]");
    expect(links.map((l) => l.target)).toEqual(["real"]);
  });
});

/* ------------------------------------------------------------------ */
/* lintWiki：断链 / orphan                                             */
/* ------------------------------------------------------------------ */

describe("lintWiki 断链与 orphan", () => {
  test("断链：目标页不存在，报告引用者", () => {
    const dir = makeWiki({
      "a.md": page({ title: "A", links: ["b", "missing-page"] }),
      "b.md": page({ title: "B" }),
    });
    const r = lintWiki(dir);
    const broken = kinds(r.issues, "broken");
    expect(broken).toEqual(["missing-page"]);
    const issue = r.issues.find((i) => i.kind === "broken");
    expect(issue?.detail).toBe("a.md");
  });

  test("orphan：无入边的主题页；自链不解除 orphan", () => {
    const dir = makeWiki({
      "a.md": page({ title: "A", links: ["a"] }), // 只链自己 → 仍是 orphan
      "b.md": page({ title: "B" }), // 无人链 → orphan
      "c.md": page({ title: "C", links: ["b"] }), // b 被 c 链 → b 不是 orphan
    });
    const r = lintWiki(dir);
    const orphans = kinds(r.issues, "orphan").sort();
    expect(orphans).toEqual(["a.md", "c.md"]);
  });

  test("INDEX.md 发出的链接是真实边（豁免文件的出链有效）", () => {
    const dir = makeWiki({
      "INDEX.md": "# 索引\n\n[[a]]\n[[b]]",
      "a.md": page({ title: "A" }),
      "b.md": page({ title: "B" }),
    });
    const r = lintWiki(dir);
    expect(kinds(r.issues, "orphan")).toEqual([]);
  });

  test("INDEX/log 等固定页名不算断链（即使页面不存在）", () => {
    const dir = makeWiki({ "a.md": page({ title: "A", links: ["INDEX", "log", "AGENTS"] }) });
    const r = lintWiki(dir);
    expect(kinds(r.issues, "broken")).toEqual([]);
  });

  test("豁免文件不参与 orphan / 摘要 / 戳检查", () => {
    const dir = makeWiki({
      "log.md": "# 日志（无摘要无戳，也不该被报）",
      "a.md": page({ title: "A", links: ["log"] }),
    });
    const r = lintWiki(dir);
    // log.md 豁免 → 不报 orphan；a.md 无人链 → 是 orphan（正常报告）
    expect(kinds(r.issues, "orphan")).toEqual(["a.md"]);
    expect(kinds(r.issues, "nosummary")).toEqual([]);
    expect(kinds(r.issues, "nostamp")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* lintWiki：摘要 / 戳 / 密度                                          */
/* ------------------------------------------------------------------ */

describe("lintWiki 摘要、日期戳与链接密度", () => {
  test("缺摘要 / 缺日期戳分别报告", () => {
    const dir = makeWiki({
      "a.md": page({ title: "A", summary: false }),
      "b.md": page({ title: "B", stamp: false }),
      "c.md": page({ title: "C" }),
    });
    const r = lintWiki(dir);
    expect(kinds(r.issues, "nosummary")).toEqual(["a.md"]);
    expect(kinds(r.issues, "nostamp")).toEqual(["b.md"]);
  });

  test("日期戳兼容英文 Last updated 与半角冒号", () => {
    const dir = makeWiki({
      "a.md": page({ title: "A", stamp: false, body: "Last updated: 2026-10-18\n" }),
    });
    const r = lintWiki(dir);
    expect(kinds(r.issues, "nostamp")).toEqual([]);
  });

  test("小库（<8 主题页）忽略 LOWLINKS", () => {
    const dir = makeWiki({ "a.md": page({ title: "A" }) }); // 0 出链
    const r = lintWiki(dir);
    expect(r.lowlinksIgnored).toBe(true);
    expect(kinds(r.issues, "lowlinks")).toEqual([]);
    expect(r.notes.some((n) => n.includes("LOWLINKS"))).toBe(true);
  });

  test("大库（≥8 主题页）执行密度检查", () => {
    const files: Record<string, string> = {};
    // 8 个主题页，互相链接成环（每个出度 1 < 3 → 全部 lowlinks）
    const names = Array.from({ length: 8 }, (_, i) => `p${i}`);
    for (const n of names) {
      files[`${n}.md`] = page({ title: n.toUpperCase(), links: [] });
    }
    for (let i = 0; i < names.length; i++) {
      const cur = names[i]!;
      const next = names[(i + 1) % names.length]!;
      files[`${cur}.md`] = page({ title: cur.toUpperCase(), links: [next] });
    }
    const dir = makeWiki(files);
    const r = lintWiki(dir);
    expect(r.lowlinksIgnored).toBe(false);
    expect(kinds(r.issues, "lowlinks").length).toBe(8);
    const issue = r.issues.find((i) => i.kind === "lowlinks");
    expect(issue?.detail).toBe("1 < 3");
  });

  test("minLinks 选项生效", () => {
    const files: Record<string, string> = {};
    const names = Array.from({ length: 8 }, (_, i) => `p${i}`);
    for (const n of names) files[`${n}.md`] = page({ title: n.toUpperCase() });
    for (let i = 0; i < names.length; i++) {
      const cur = names[i]!;
      const next = names[(i + 1) % names.length]!;
      files[`${cur}.md`] = page({ title: cur.toUpperCase(), links: [next] });
    }
    const dir = makeWiki(files);
    const r = lintWiki(dir, { minLinks: 1 });
    expect(kinds(r.issues, "lowlinks")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 目录解析与渲染                                                      */
/* ------------------------------------------------------------------ */

describe("resolveWikiDir 与报告渲染", () => {
  test("优先 .neo/wiki/wiki/，其次 ./wiki/，都没有返回 null", () => {
    const proj = join(ROOT, `proj-${seq++}`);
    mkdirSync(join(proj, ".neo", "wiki", "wiki"), { recursive: true });
    expect(resolveWikiDir(proj)).toBe(join(proj, ".neo", "wiki", "wiki"));

    const lib = join(ROOT, `lib-${seq++}`);
    mkdirSync(join(lib, "wiki"), { recursive: true });
    expect(resolveWikiDir(lib)).toBe(join(lib, "wiki"));

    const empty = join(ROOT, `empty-${seq++}`);
    mkdirSync(empty, { recursive: true });
    expect(resolveWikiDir(empty)).toBeNull();
  });

  test("空目录：跳过检查但有报告", () => {
    const dir = makeWiki({});
    const r = lintWiki(dir);
    expect(r.totalMdCount).toBe(0);
    expect(r.issues).toEqual([]);
    const text = formatLintReport(r);
    expect(text).toContain("没有 .md 文件");
    expect(text).toContain("SUMMARY: broken=0 orphans=0 lowlinks=0 nosummary=0 nostamp=0");
  });

  test("formatLintReport 含各类型行与 SUMMARY", () => {
    const dir = makeWiki({
      "a.md": page({ title: "A", links: ["ghost"], summary: false, stamp: false }),
    });
    const text = formatLintReport(lintWiki(dir));
    expect(text).toContain("BROKEN: ghost");
    expect(text).toContain("ORPHAN: a.md");
    expect(text).toContain("NOSUMMARY: a.md");
    expect(text).toContain("NOSTAMP: a.md");
    expect(text).toContain("SUMMARY: broken=1 orphans=1 lowlinks=0 nosummary=1 nostamp=1");
    expect(text).toContain("矛盾检查");
  });
});
