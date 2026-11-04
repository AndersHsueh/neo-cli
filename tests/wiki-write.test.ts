/**
 * wiki 回填 / 检索 / raw 拦截测试（src/wiki/write.ts、search.ts、paths.ts、tools 拦截）。
 *
 * 运行：bun test tests/wiki-write.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveWikiLayout, insideRawDir } from "../src/wiki/paths.ts";
import {
  validatePageName,
  validatePageContent,
  appendLog,
  lastIngestDate,
  syncIndex,
  writeBack,
  WikiWriteError,
  todayStamp,
} from "../src/wiki/write.ts";
import { searchWiki, formatSearchResults, wikiIsEmpty } from "../src/wiki/search.ts";
import { dispatch } from "../src/tools/index.ts";
import { registerTool } from "../src/tools/index.ts";
import { registerWikiTools } from "../src/tools/wiki.ts";
import type { Config } from "../src/config.ts";

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const ROOT = join(tmpdir(), `neo-wiki-write-${Date.now()}`);
const CWD = join(ROOT, "proj");
mkdirSync(join(CWD, ".neo", "wiki", "wiki"), { recursive: true });
mkdirSync(join(CWD, ".neo", "wiki", "raw"), { recursive: true });

const LAYOUT = resolveWikiLayout(CWD)!;
const PAGES = join(CWD, ".neo", "wiki", "wiki");
const RAW = join(CWD, ".neo", "wiki", "raw");

function makeCfg(): Config {
  return { cwd: CWD, toolOutputLimit: 30_000 } as Config;
}
const ctx = { cfg: makeCfg(), approve: async () => true };

function page(name: string, content: string): void {
  writeFileSync(join(PAGES, name), content, "utf8");
}
function validPage(title: string, extra = ""): string {
  return `# ${title}\n\n## 摘要\n\n${title}的摘要。\n\n> 最后更新:2026-10-18\n${extra}`;
}

// 注册 wiki 工具（带清理，不污染其它测试文件）
const unregisterWiki = registerWikiTools(registerTool);
afterAll(() => {
  unregisterWiki();
  rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

describe("wiki 布局解析", () => {
  test("neo 布局：.neo/wiki/wiki + raw", () => {
    expect(LAYOUT).toEqual({
      pagesDir: PAGES,
      rawDir: RAW,
      kind: "neo",
      scope: "project",
    });
  });

  test("insideRawDir：raw 内为真，主题页与项目内其它路径为假", () => {
    expect(insideRawDir(CWD, join(RAW, "a.md"))).toBe(true);
    expect(insideRawDir(CWD, join(RAW, "sub", "b.md"))).toBe(true);
    expect(insideRawDir(CWD, join(PAGES, "a.md"))).toBe(false);
    expect(insideRawDir(CWD, join(CWD, "src", "x.ts"))).toBe(false);
    expect(insideRawDir(CWD, join(CWD, ".neo", "wiki-evil.md"))).toBe(false);
  });

  test("insideRawDir：raw 内以 .. 开头的子目录不算越界（v0.4.31 修复）", () => {
    // relative() 对 raw/..foo/x 返回 "..foo/x"，旧实现 startsWith("..") 误判为越界，
    // 让 raw 护栏漏掉这一类路径。
    expect(insideRawDir(CWD, join(RAW, "..foo", "evil.md"))).toBe(true);
    expect(insideRawDir(CWD, join(CWD, "wiki", "raw", "..foo", "evil.md"))).toBe(true);
    // 真正的越界仍然为假
    expect(insideRawDir(CWD, join(RAW, "..", "wiki", "a.md"))).toBe(false);
    expect(insideRawDir(CWD, join(RAW, "..", "..", "evil.md"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 命名与内容校验                                                      */
/* ------------------------------------------------------------------ */

describe("命名与内容校验", () => {
  test("合法命名：登记表前缀 + 无前缀中文短语 + 时间型", () => {
    expect(validatePageName("待澄清-采样策略.md")).toBeNull();
    expect(validatePageName("盘点-2026-10-18-阶段.md")).toBeNull();
    expect(validatePageName("对比-A-与-B.md")).toBeNull();
    expect(validatePageName("汇总-性能.md")).toBeNull();
    expect(validatePageName("读书笔记-0612.md")).toBeNull();
    expect(validatePageName("研究方法.md")).toBeNull();
  });

  test("非法命名：盘点缺日期、非 md、空名、系统文件", () => {
    expect(validatePageName("盘点-阶段.md")).toMatch(/盘点-<YYYY-MM-DD>-<主题>/);
    expect(validatePageName("foo.txt")).toMatch(/\.md 结尾/);
    expect(validatePageName("  .md")).toMatch(/不能为空/);
    expect(validatePageName("INDEX.md")).toMatch(/系统文件/);
    expect(validatePageName("log.md")).toMatch(/系统文件/);
  });

  test("内容校验：缺摘要 / 缺日期戳分别报告，中英两套都认", () => {
    expect(validatePageContent(validPage("A"))).toEqual([]);
    expect(validatePageContent("# A\n\n正文")).toHaveLength(2);
    expect(validatePageContent("# A\n\n## Summary\n\nx\n\n> Last updated: 2026-10-18")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* log                                                                 */
/* ------------------------------------------------------------------ */

describe("log 登记与 ingest 时间", () => {
  test("appendLog 追加 grep 友好条目；未知类型拒绝；换行被清洗", () => {
    appendLog(LAYOUT, "query", "测试条目一");
    appendLog(LAYOUT, "todo", "多行\n标题");
    const log = readFileSync(join(PAGES, "log.md"), "utf8");
    expect(log).toContain(`## [${todayStamp()}] query | 测试条目一`);
    expect(log).toContain(`## [${todayStamp()}] todo | 多行 标题`);
    expect(() => appendLog(LAYOUT, "hack" as never, "x")).toThrow(WikiWriteError);
    expect(() => appendLog(LAYOUT, "query", "  ")).toThrow(WikiWriteError);
  });

  test("lastIngestDate 取最近一条 ingest；没有返回 null", () => {
    expect(lastIngestDate(LAYOUT)).toBeNull();
    appendLog(LAYOUT, "ingest", "第一次");
    expect(lastIngestDate(LAYOUT)).toBe(todayStamp());
  });
});

/* ------------------------------------------------------------------ */
/* INDEX 同步                                                          */
/* ------------------------------------------------------------------ */

describe("INDEX 同步", () => {
  test("无索引 → 建最小骨架；已有索引 → 追加行；重复回填 → 更新摘要列", () => {
    rmSync(join(PAGES, "INDEX.md"), { force: true });
    syncIndex(LAYOUT, "新页", "第一版摘要");
    let text = readFileSync(join(PAGES, "INDEX.md"), "utf8");
    expect(text).toContain("| 新页 | [[新页]] | 第一版摘要 | |");

    syncIndex(LAYOUT, "另一页", "另一页摘要");
    text = readFileSync(join(PAGES, "INDEX.md"), "utf8");
    expect(text).toContain("| 另一页 | [[另一页]] | 另一页摘要 | |");

    syncIndex(LAYOUT, "新页", "更新后的摘要");
    text = readFileSync(join(PAGES, "INDEX.md"), "utf8");
    expect(text).toContain("更新后的摘要");
    expect(text).not.toContain("第一版摘要");
  });
});

/* ------------------------------------------------------------------ */
/* writeBack                                                           */
/* ------------------------------------------------------------------ */

describe("writeBack 回填", () => {
  test("create：写入 + INDEX 同步 + log 登记；重复 create 拒绝", () => {
    const r = writeBack(LAYOUT, {
      action: "create",
      page: "对比-方案A-与-方案B.md",
      content: validPage("对比-方案A-与-方案B"),
      logTitle: "回填 A/B 对比结论",
    });
    expect(r.action).toBe("create");
    expect(r.indexSynced).toBe(true);
    expect(r.logged).toBe(true);
    expect(existsSync(join(PAGES, "对比-方案A-与-方案B.md"))).toBe(true);

    expect(() =>
      writeBack(LAYOUT, {
        action: "create",
        page: "对比-方案A-与-方案B.md",
        content: validPage("x"),
        logTitle: "重复",
      }),
    ).toThrow(/已存在/);
  });

  test("create 缺摘要/戳 → 拒绝且不落盘", () => {
    expect(() =>
      writeBack(LAYOUT, {
        action: "create",
        page: "汇总-测试.md",
        content: "# 没有摘要的页",
        logTitle: "x",
      }),
    ).toThrow(/缺少必备结构/);
    expect(existsSync(join(PAGES, "汇总-测试.md"))).toBe(false);
  });

  test("append：追加推理与依据段 + 更新日期戳；页不存在拒绝；二次 append 续写", () => {
    page("研究方法.md", validPage("研究方法", "\n一些正文。\n"));
    const r = writeBack(LAYOUT, {
      action: "append",
      page: "研究方法.md",
      content: "第一条推理链。",
      logTitle: "补推理链",
    });
    expect(r.action).toBe("append");
    let text = readFileSync(join(PAGES, "研究方法.md"), "utf8");
    expect(text).toContain("## 推理与依据");
    expect(text).toContain("第一条推理链。");
    expect(text).toContain(`> 最后更新:${todayStamp()}`);

    writeBack(LAYOUT, {
      action: "append",
      page: "研究方法.md",
      content: "第二条推理链。",
      logTitle: "再补",
    });
    text = readFileSync(join(PAGES, "研究方法.md"), "utf8");
    expect(text).toContain("第一条推理链。");
    expect(text).toContain("第二条推理链。");
  });

  test("append 到不存在页 → 拒绝", () => {
    expect(() =>
      writeBack(LAYOUT, {
        action: "append",
        page: "不存在.md",
        content: "x",
        logTitle: "x",
      }),
    ).toThrow(/不存在/);
  });
});

/* ------------------------------------------------------------------ */
/* search                                                              */
/* ------------------------------------------------------------------ */

describe("searchWiki 检索", () => {
  test("多词 AND + 相关度排序 + 命中行摘要", () => {
    page("采样策略.md", validPage("采样策略", "\n温度采样与 top-p 采样的取舍。\n采样是核心。\n"));
    page("温度控制.md", validPage("温度控制", "\n温度参数影响采样质量。\n"));
    page("无关页.md", validPage("无关页", "\n完全无关的内容。\n"));

    const hits = searchWiki(LAYOUT, "采样 温度");
    expect(hits.length).toBe(2);
    expect(hits[0]?.page).toBe("采样策略.md"); // 词频更高
    expect(hits[0]?.snippets.length).toBeGreaterThan(0);
    expect(searchWiki(LAYOUT, "采样 不存在的词")).toEqual([]);
    expect(searchWiki(LAYOUT, "")).toEqual([]);
  });

  test("INDEX 不参与命中；log 参与", () => {
    page("INDEX.md", "# 索引\n\n采样 温度 特殊词");
    page("log.md", "# 日志\n\n## [2026-10-18] query | 采样 温度 问题");
    const hits = searchWiki(LAYOUT, "特殊词");
    expect(hits.map((h) => h.page)).toEqual([]);
    const hits2 = searchWiki(LAYOUT, "问题");
    expect(hits2.map((h) => h.page)).toContain("log.md");
  });

  test("formatSearchResults 与 wikiIsEmpty", () => {
    expect(formatSearchResults("q", [])).toContain("无命中");
    expect(wikiIsEmpty(LAYOUT)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 工具壳 + raw 拦截                                                    */
/* ------------------------------------------------------------------ */

describe("wiki 工具壳与 raw 拦截", () => {
  test("wiki_search 工具：正常检索 + 空库提示 + 非知识库目录报错", async () => {
    const r = await dispatch("wiki_search", JSON.stringify({ query: "采样" }), ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("采样策略");

    const emptyDir = join(ROOT, "empty-proj");
    mkdirSync(emptyDir, { recursive: true });
    const r2 = await dispatch(
      "wiki_search",
      JSON.stringify({ query: "x" }),
      { cfg: { cwd: emptyDir } as Config, approve: async () => true },
    );
    expect(r2.ok).toBe(false);
    expect(r2.output).toContain("不是 wiki 知识库");
  });

  test("wiki_write 工具：create 全链路 + 校验失败转 ToolError", async () => {
    const r = await dispatch(
      "wiki_write",
      JSON.stringify({
        action: "create",
        page: "待澄清-采样口径.md",
        content: validPage("待澄清-采样口径"),
        log_title: "记录采样口径疑问",
      }),
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("已新建");
    expect(r.output).toContain("INDEX.md 已同步");
    expect(r.output).toContain("log.md 已登记");

    const r2 = await dispatch(
      "wiki_write",
      JSON.stringify({
        action: "create",
        page: "非法名!!",
        content: validPage("x"),
        log_title: "x",
      }),
      ctx,
    );
    // 非法名!! 不以 .md 结尾 → 命名校验拒绝
    expect(r2.ok).toBe(false);
  });

  test("raw 拦截：write_file 覆盖已有 raw 文件被拒；新建放行；edit_file 同理", async () => {
    writeFileSync(join(RAW, "existing.md"), "原始内容", "utf8");

    // 覆盖已有 → 拒
    const r1 = await dispatch(
      "write_file",
      JSON.stringify({ path: join(RAW, "existing.md"), content: "改" }),
      ctx,
    );
    expect(r1.ok).toBe(false);
    expect(r1.output).toContain("raw 源不可修改");
    expect(readFileSync(join(RAW, "existing.md"), "utf8")).toBe("原始内容");

    // 新建 → 放行
    const r2 = await dispatch(
      "write_file",
      JSON.stringify({ path: join(RAW, "new-source.md"), content: "新素材" }),
      ctx,
    );
    expect(r2.ok).toBe(true);

    // edit_file 已有文件 → 拒
    const r3 = await dispatch(
      "edit_file",
      JSON.stringify({ path: join(RAW, "existing.md"), old_string: "原始", new_string: "改" }),
      ctx,
    );
    expect(r3.ok).toBe(false);
    expect(r3.output).toContain("raw 源不可修改");
  });

  test("raw 拦截覆盖 raw 内 .. 前缀子目录：write_file 覆盖被拒（v0.4.31 修复）", async () => {
    const dotDir = join(RAW, "..foo");
    mkdirSync(dotDir, { recursive: true });
    const victim = join(dotDir, "keep.md");
    writeFileSync(victim, "原始内容", "utf8");

    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: victim, content: "改" }),
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("raw 源不可修改");
    expect(readFileSync(victim, "utf8")).toBe("原始内容");
  });

  test("主题页不受 raw 拦截影响：可正常写", async () => {
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: join(PAGES, "普通写入.md"), content: "# x\n\n## 摘要\n\ns\n\n> 最后更新:2026-10-18\n" }),
      ctx,
    );
    expect(r.ok).toBe(true);
  });
});
