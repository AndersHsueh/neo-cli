/**
 * 记忆召回（v0.2 记忆激活 M1）。
 *
 * 规格：docs/001-memory-system-design[done].md §7.7（R0/R1/R2 共用检索层）。
 * 重点钉死：**严格两桶（项目级先于用户级）**、预算截断、-p 只查项目级、无命中零注入。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WikiLayout } from "../src/wiki/paths.ts";
import {
  buildRecall,
  extractPageSummary,
  extractTerms,
  searchScored,
  toTrace,
} from "../src/memory/recall.ts";
import { RECALL_MARKER } from "../src/memory/port.ts";
import { todayStamp } from "../src/wiki/write.ts";

let SANDBOX = "";
let PROJECT: WikiLayout;
let USER: WikiLayout;

function writePage(layout: WikiLayout, name: string, title: string, summary: string, body: string): string {
  const path = join(layout.pagesDir, name);
  writeFileSync(
    path,
    `# ${title}\n\n## 摘要\n\n${summary}\n\n> 最后更新:${todayStamp()}\n\n## 正文\n\n${body}\n`,
    "utf8",
  );
  return path;
}

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-recall-"));
  const pPages = join(SANDBOX, "proj", "wiki");
  const uPages = join(SANDBOX, "user", "wiki");
  mkdirSync(pPages, { recursive: true });
  mkdirSync(uPages, { recursive: true });
  PROJECT = { pagesDir: pPages, rawDir: join(SANDBOX, "proj", "raw"), kind: "neo", scope: "project" };
  USER = { pagesDir: uPages, rawDir: join(SANDBOX, "user", "raw"), kind: "user", scope: "user" };

  // 系统文件：不参与检索
  writeFileSync(join(pPages, "INDEX.md"), "# 索引\n\n## 摘要\n\n目录页不该被召回。\n\n> 最后更新:2026-01-01\n");
  writeFileSync(join(pPages, "log.md"), "# 日志\n\n## 摘要\n\n日志也不该召回。\n\n> 最后更新:2026-01-01\n");

  writePage(PROJECT, "踩坑-热键系统.md", "踩坑-热键系统", "热键必须挂 input 流而非 readline 实例，否则永不触发",
    "症状：ESC 没反应。\n根因：attach 挂错了对象。\n修法：挂 input 流。");
  writePage(PROJECT, "决策-模型路由.md", "决策-模型路由", "模型档位与 provider 正交",
    "决策：路由表按档位配置。\n理由：跨供应商调度。");
  writePage(PROJECT, "架构-输入层.md", "架构-输入层", "粘贴/热键/选择器都在输入层",
    "热键系统与粘贴共用输入队列。");
  writePage(USER, "偏好-沟通.md", "偏好-沟通", "偏好先给结论再给依据，中文，不用 emoji",
    "事实：用户明确说过先给结论。\n\n## 推断（待确认）\n\n- （推断 2026-10-20 · 置信 0.7 · session s1）可能偏好短回答");
  writePage(USER, "环境.md", "环境", "macOS + zsh + Bun",
    "事实：日常在 macOS 上开发。");
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 关键词抽取                                                          */
/* ------------------------------------------------------------------ */

describe("A extractTerms 关键词抽取", () => {
  test("A1 中文 bigram + 停用词过滤", () => {
    const terms = extractTerms("热键系统为什么不触发");
    expect(terms).toContain("热键");
    expect(terms).toContain("触发");
    expect(terms).not.toContain("为什");
    expect(terms).not.toContain("什么");
  });

  test("A2 英文/数字 token 保留，且与中文混排", () => {
    const terms = extractTerms("修一下 hotkeys.ts 的 keypress 问题");
    expect(terms).toContain("hotkeys.ts");
    expect(terms).toContain("keypress");
  });

  test("A3 去重且不超过 max", () => {
    const terms = extractTerms("热键热键热键热键 粘贴粘贴粘贴 输入输入 队列队列 系统系统 触发器", 5);
    expect(terms.length).toBeLessThanOrEqual(5);
    expect(new Set(terms).size).toBe(terms.length);
  });

  test("A4 纯停用词不产生关键词（避免垃圾召回）", () => {
    expect(extractTerms("那这个是怎么了")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 单库检索                                                            */
/* ------------------------------------------------------------------ */

describe("B searchScored 单库打分", () => {
  test("B1 命中页按分数排序，且排除 INDEX/log", () => {
    const hits = searchScored(PROJECT, ["热键"], "project");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.page !== "INDEX.md" && h.page !== "log.md")).toBe(true);
    expect(hits[0]?.page).toBe("踩坑-热键系统.md");
  });

  test("B2 标题命中加权（标题含词 > 正文含词）", () => {
    // 架构页正文含「热键」一次；踩坑页标题含「热键」且正文多次 → 分数更高
    const hits = searchScored(PROJECT, ["热键"], "project");
    const byPage = new Map(hits.map((h) => [h.page, h.score]));
    expect(byPage.get("踩坑-热键系统.md")!).toBeGreaterThan(byPage.get("架构-输入层.md")!);
  });

  test("B3 摘要/片段/推断标记提取", () => {
    const hits = searchScored(USER, ["偏好"], "user");
    const hit = hits.find((h) => h.page === "偏好-沟通.md");
    expect(hit).toBeDefined();
    expect(hit!.summary).toContain("先给结论");
    expect(hit!.snippets.length).toBeGreaterThan(0);
    expect(hit!.hasInference).toBe(true);
  });

  test("B4 无命中返回空数组", () => {
    expect(searchScored(PROJECT, ["量子纠缠"], "project")).toEqual([]);
  });

  test("B5 近期修改加权：旧文件排在同等命中之后", () => {
    const old = writePage(PROJECT, "踩坑-旧热键.md", "旧热键记录", "热键旧方案", "热键旧方案正文");
    const oldTime = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    utimesSync(old, oldTime, oldTime);
    const hits = searchScored(PROJECT, ["热键"], "project");
    const fresh = hits.findIndex((h) => h.page === "踩坑-热键系统.md");
    const stale = hits.findIndex((h) => h.page === "踩坑-旧热键.md");
    expect(fresh).toBeGreaterThanOrEqual(0);
    expect(stale).toBeGreaterThanOrEqual(0);
    expect(fresh).toBeLessThan(stale);
    rmSync(old);
  });
});

/* ------------------------------------------------------------------ */
/* 双桶合并与预算                                                       */
/* ------------------------------------------------------------------ */

describe("C buildRecall 双桶召回（项目级优先）", () => {
  const layouts = { get project() { return PROJECT; }, get user() { return USER; } };

  test("C1 严格两桶：项目级即使分数更低也排在用户级前", () => {
    // 「热键」在项目级强命中；「偏好」在用户级强命中 —— 复合词同时命中两边时项目级仍在前
    const r = buildRecall(layouts, "热键 偏好", {});
    expect(r.text).not.toBeNull();
    const text = r.text!;
    expect(text.startsWith(RECALL_MARKER)).toBe(true);
    const firstProject = text.indexOf("[项目]");
    const firstUser = text.indexOf("[用户]");
    expect(firstProject).toBeGreaterThanOrEqual(0);
    expect(firstUser).toBeGreaterThan(firstProject);
  });

  test("C2 每库数量上限：项目 2 + 用户 1", () => {
    const r = buildRecall(layouts, "热键 模型 架构 偏好 环境 队列", { projectPages: 2, userPages: 1 });
    const scopeCount = { project: 0, user: 0 };
    for (const h of r.hits) scopeCount[h.scope]++;
    expect(scopeCount.project).toBeLessThanOrEqual(2);
    expect(scopeCount.user).toBeLessThanOrEqual(1);
  });

  test("C3 -p 单次模式 projectOnly：不召回用户级", () => {
    const r = buildRecall(layouts, "偏好 沟通 结论", { projectOnly: true });
    expect(r.text).toBeNull();
    expect(r.hits).toEqual([]);
    // 同样的 query 在双库模式会命中用户页
    const both = buildRecall(layouts, "偏好 沟通 结论", {});
    expect(both.text).not.toBeNull();
    expect(both.hits.some((h) => h.scope === "user")).toBe(true);
  });

  test("C4 无命中 → 不注入（text=null，零 token）", () => {
    const r = buildRecall(layouts, "量子纠缠 薛定谔 波函数", {});
    expect(r.text).toBeNull();
    expect(r.tokens).toBe(0);
    expect(r.hits).toEqual([]);
  });

  test("C5 预算截断：超预算时先丢用户级，项目级优先保留", () => {
    const r = buildRecall(layouts, "热键 偏好 环境", { maxTokens: 120 });
    expect(r.text).not.toBeNull();
    const trace = toTrace(r);
    expect(trace.tokens).toBeLessThanOrEqual(120);
    if (trace.hits.length > 1) {
      expect(trace.hits[0]?.scope).toBe("project");
    }
  });

  test("C6 token 预算：正常额度下不截断（<900）", () => {
    const r = buildRecall(layouts, "热键 偏好", { maxTokens: 900 });
    expect(r.tokens).toBeLessThanOrEqual(900);
    expect(r.text).toContain("[[踩坑-热键系统]]");
    expect(r.text).toContain("含推断内容");
  });

  test("C7 渲染含页面绝对路径（模型可直接 read_file 读全文）", () => {
    const r = buildRecall(layouts, "热键", {});
    expect(r.text).toContain(join(PROJECT.pagesDir, "踩坑-热键系统.md"));
  });

  test("C8 toTrace 生成审计结构", () => {
    const r = buildRecall(layouts, "热键 偏好", {});
    const trace = toTrace(r);
    expect(trace.injected).toBe(true);
    expect(trace.terms.length).toBeGreaterThan(0);
    expect(trace.hits.every((h) => h.page.endsWith(".md"))).toBe(true);
    expect(typeof trace.tokens).toBe("number");
  });
});

/* ------------------------------------------------------------------ */
/* 摘要提取                                                            */
/* ------------------------------------------------------------------ */

describe("D extractPageSummary", () => {
  test("D1 取摘要段第一行非空文本", () => {
    const text = "# 页\n\n## 摘要\n\n第一行\n\n第二行\n\n> 最后更新:2026-01-01\n";
    expect(extractPageSummary(text)).toBe("第一行");
  });

  test("D2 无摘要段返回空串", () => {
    expect(extractPageSummary("# 只有标题\n\n正文\n")).toBe("");
  });
});
