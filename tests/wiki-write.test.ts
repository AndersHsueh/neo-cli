/**
 * wiki 回填 / 检索 / raw 拦截测试（src/wiki/write.ts、search.ts、paths.ts、tools 拦截）。
 *
 * 运行：bun test tests/wiki-write.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveWikiLayout, resolveUserWikiLayout, insideRawDir } from "../src/wiki/paths.ts";
import {
  validatePageName,
  validatePageContent,
  appendLog,
  lastIngestDate,
  syncIndex,
  writeBack,
  checkLinkTargets,
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

/* ------------------------------------------------------------------ */
/* 链接目标校验（issue #22）                                            */
/* ------------------------------------------------------------------ */

describe("链接目标校验（issue #22）", () => {
  /** 独立的项目级/用户级双层沙箱，互不干扰，避免依赖开发机状态。 */
  const LROOT = join(tmpdir(), `neo-wiki-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const PROJ = join(LROOT, "proj");
  const USER = join(LROOT, "user");
  const PROJ_PAGES = join(PROJ, ".neo", "wiki", "wiki");
  const USER_PAGES = join(USER, "wiki");
  mkdirSync(PROJ_PAGES, { recursive: true });
  mkdirSync(USER_PAGES, { recursive: true });

  const projLayout = resolveWikiLayout(PROJ)!;
  const userLayout = resolveUserWikiLayout(USER)!;

  afterAll(() => {
    rmSync(LROOT, { recursive: true, force: true });
  });

  function projPage(name: string): void {
    writeFileSync(join(PROJ_PAGES, name), "# x\n\n## 摘要\n\ns\n\n> 最后更新:2026-10-18\n", "utf8");
  }
  function userPage(name: string): void {
    writeFileSync(join(USER_PAGES, name), "# x\n\n## 摘要\n\ns\n\n> 最后更新:2026-10-18\n", "utf8");
  }

  test("验收 1：目标在本层不存在 → 警告指名缺失目标", () => {
    const r = checkLinkTargets("正文提到 [[幽灵页]]。", {
      layout: projLayout,
      otherLayout: userLayout,
    });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.kind).toBe("missing");
    expect(r.issues[0]!.target).toBe("幽灵页");
    expect(r.issues[0]!.message).toContain("幽灵页");
    expect(r.issues[0]!.message).toContain("项目级 wiki");
  });

  test("验收 2：目标只在用户级 → 跨层提示指名「在用户级 wiki」", () => {
    userPage("用户独有页.md");
    const r = checkLinkTargets("见 [[用户独有页]]。", {
      layout: projLayout,
      otherLayout: userLayout,
    });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.kind).toBe("cross-layer");
    expect(r.issues[0]!.otherScope).toBe("user");
    expect(r.issues[0]!.message).toContain("用户独有页");
    expect(r.issues[0]!.message).toContain("用户级 wiki");
    expect(r.issues[0]!.message).toContain("项目级");
  });

  test("验收 2 反向：目标只在项目级 → 写用户级时提示「在项目级 wiki」", () => {
    projPage("项目独有页.md");
    const r = checkLinkTargets("见 [[项目独有页]]。", {
      layout: userLayout,
      otherLayout: projLayout,
    });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.kind).toBe("cross-layer");
    expect(r.issues[0]!.otherScope).toBe("project");
    expect(r.issues[0]!.message).toContain("项目级 wiki");
    expect(r.issues[0]!.message).toContain("用户级");
  });

  test("验收 2：用户级库未创建 → 按「两层都无」处理", () => {
    const r = checkLinkTargets("见 [[哪都没有]]。", {
      layout: projLayout,
      otherLayout: null,
    });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.kind).toBe("missing");
    expect(r.issues[0]!.message).not.toContain("用户级 wiki");
  });

  test("验收 3：目标在本层存在 → 零告警", () => {
    projPage("本层存在页.md");
    const r = checkLinkTargets("见 [[本层存在页]]。", {
      layout: projLayout,
      otherLayout: userLayout,
    });
    expect(r.issues).toHaveLength(0);
    expect(r.resolved).toContain("本层存在页");
  });

  test("验收 4：三种语法归一后都能正确校验", () => {
    projPage("语法页.md");
    // 三种写法都指向同一个存在的页 → 零告警
    const ok = checkLinkTargets("[[语法页|别名]] [[语法页#锚点]] [[语法页.md]]", {
      layout: projLayout,
      otherLayout: userLayout,
    });
    expect(ok.issues).toHaveLength(0);

    // 不存在的目标：三种写法都被归一后指名
    for (const raw of ["[[缺失页|别名]]", "[[缺失页#锚点]]", "[[缺失页.md]]"]) {
      const r = checkLinkTargets(raw, { layout: projLayout, otherLayout: userLayout });
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]!.target).toBe("缺失页");
    }
  });

  test("验收 4：路径式目标（归一后为空）按 lint 口径跳过", () => {
    const r = checkLinkTargets("见 [[../AGENTS]] 与 [[sub/page]]。", {
      layout: projLayout,
      otherLayout: userLayout,
    });
    expect(r.issues).toHaveLength(0);
  });

  test("口径与 lint 一致：代码块与行内反引号里的链接不计", () => {
    const r = checkLinkTargets("```\n[[幽灵]]\n```\n行内 `[[幽灵2]]` 结束。", {
      layout: projLayout,
      otherLayout: userLayout,
    });
    expect(r.issues).toHaveLength(0);
  });

  test("writeBack：默认 warn 不阻断 —— 写入成功但结果带 linkIssues", () => {
    const r = writeBack(projLayout, {
      action: "create",
      page: "带断链的页.md",
      content: "# 带断链的页\n\n## 摘要\n\n摘要。\n\n> 最后更新:2026-10-18\n\n见 [[幽灵页]]。\n",
      logTitle: "写带断链的页",
      otherLayout: userLayout,
    });
    expect(r.linkIssues).toHaveLength(1);
    expect(r.linkIssues[0]!.target).toBe("幽灵页");
    // 仍然落盘了（警告不阻断）
    expect(existsSync(join(PROJ_PAGES, "带断链的页.md"))).toBe(true);
  });

  test("writeBack：strict 模式阻断写入且不落盘", () => {
    expect(() =>
      writeBack(projLayout, {
        action: "create",
        page: "严格模式页.md",
        content: "# 严格模式页\n\n## 摘要\n\n摘要。\n\n> 最后更新:2026-10-18\n\n见 [[幽灵页2]]。\n",
        logTitle: "严格模式",
        otherLayout: userLayout,
        linkCheck: "strict",
      }),
    ).toThrow(/链接目标校验未通过/);
    expect(existsSync(join(PROJ_PAGES, "严格模式页.md"))).toBe(false);
  });

  test("writeBack：off 模式完全跳过校验", () => {
    const r = writeBack(projLayout, {
      action: "create",
      page: "跳过校验页.md",
      content: "# 跳过校验页\n\n## 摘要\n\n摘要。\n\n> 最后更新:2026-10-18\n\n见 [[幽灵页3]]。\n",
      logTitle: "跳过校验",
      otherLayout: userLayout,
      linkCheck: "off",
    });
    expect(r.linkIssues).toHaveLength(0);
  });

  test("自链不算断链", () => {
    const r = checkLinkTargets("见 [[自链页]]。", {
      layout: projLayout,
      selfPage: "自链页",
      otherLayout: userLayout,
    });
    expect(r.issues).toHaveLength(0);
  });

  test("工具层：wiki_write 输出里带跨层提示（project scope）", async () => {
    const toolCtx = {
      cfg: {
        cwd: PROJ,
        toolOutputLimit: 30_000,
        memory: { userWikiDir: USER, scopeMode: "both" },
      } as unknown as Config,
      approve: async () => true,
    };
    const r = await dispatch(
      "wiki_write",
      JSON.stringify({
        action: "create",
        page: "工具跨层页.md",
        content:
          "# 工具跨层页\n\n## 摘要\n\n摘要。\n\n> 最后更新:2026-10-18\n\n见 [[用户独有页]]。\n",
        log_title: "工具跨层",
      }),
      toolCtx,
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("用户独有页");
    expect(r.output).toContain("用户级 wiki");
  });
});
