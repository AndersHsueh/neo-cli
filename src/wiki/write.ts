/**
 * wiki 回填域逻辑 —— wiki_write 工具的强制校验与同步。
 *
 * 设计目标（wiki-turnning-1018.md 问题 2）：「写回」在代码里只有一条合法路径，
 * 模型想漏都漏不掉——命名校验、摘要/日期戳强制、INDEX 与 log 同步都在这里完成，
 * 不靠 prompt 自觉。
 *
 * 规范来源（karpathy-wiki-new/references/AGENTS.md，改造后进 src/wiki/templates/）：
 *  - 命名前缀登记表：待澄清- / 盘点-<YYYY-MM-DD>- / 对比-<A>-与-<B> / 汇总- / <事件类型>-<MMDD>，
 *    以及无前缀的普通主题页（中文短语，见名知意）；
 *  - log 条目：`## [YYYY-MM-DD] type | title`，type ∈ {ingest, query, wiki, lint,
 *    deliverable, milestone, todo}，log.md append-only；
 *  - 页面必备：`## 摘要`（或 Summary）+ 日期戳 `> 最后更新:YYYY-MM-DD`（或 Last updated）；
 *  - 主题页可以改写（当前最优综述），只有 raw 不可改、log 只追加。
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { WikiLayout } from "./paths.ts";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** log 条目类型固定集合（不自创）。 */
export const LOG_TYPES = ["ingest", "query", "wiki", "lint", "deliverable", "milestone", "todo"] as const;
export type LogType = (typeof LOG_TYPES)[number];

/** 回填页的受管命名前缀。普通主题页（无前缀）也合法。 */
const MANAGED_PREFIXES = ["待澄清-", "盘点-", "对比-", "汇总-"];

const SUMMARY_RE = /^## (摘要|Summary)\s*$/m;
const DATE_STAMP_RE = /(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/;

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export class WikiWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikiWriteError";
  }
}

/** 命名校验。返回错误信息，null 表示合法。 */
export function validatePageName(name: string): string | null {
  if (!name.endsWith(".md")) return "页面名必须以 .md 结尾";
  const base = name.slice(0, -3);
  if (!base.trim()) return "页面名不能为空";
  // 豁免/系统文件不允许通过回填创建或改写
  const reserved = new Set(["INDEX.md", "index.md", "log.md", "AGENTS.md"]);
  if (reserved.has(name)) return `${name} 是系统文件，不经 wiki_write 维护`;
  // 前缀必须在登记表内（盘点- 后必须跟日期）
  if (base.startsWith("盘点-")) {
    if (!/^盘点-\d{4}-\d{2}-\d{2}-/.test(base)) {
      return `盘点页命名必须是 盘点-<YYYY-MM-DD>-<主题>.md，当前：${name}`;
    }
    return null;
  }
  if (MANAGED_PREFIXES.some((p) => base.startsWith(p))) return null;
  // 时间型：<事件类型>-<MMDD>
  if (/-\d{4}$/.test(base)) return null;
  // 无前缀普通主题页：合法（中文短语优先，这里不做语言强检，只挡明显的乱命名）
  return null;
}

/** 页面内容校验：摘要与日期戳必须齐备。返回缺失项列表。 */
export function validatePageContent(content: string): string[] {
  const missing: string[] = [];
  if (!SUMMARY_RE.test(content)) missing.push("## 摘要（或 ## Summary）");
  if (!DATE_STAMP_RE.test(content)) missing.push("日期戳（> 最后更新:YYYY-MM-DD 或 > Last updated:）");
  return missing;
}

/* ------------------------------------------------------------------ */
/* log                                                                 */
/* ------------------------------------------------------------------ */

export function todayStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 追加一条 log（append-only）。title 里不允许换行，防止破坏 grep 友好格式。 */
export function appendLog(layout: WikiLayout, type: LogType, title: string): void {
  if (!LOG_TYPES.includes(type)) {
    throw new WikiWriteError(`未知 log 类型 "${type}"。可用：${LOG_TYPES.join(", ")}`);
  }
  const clean = title.replace(/\r?\n/g, " ").trim();
  if (!clean) throw new WikiWriteError("log 条目标题不能为空");
  const line = `## [${todayStamp()}] ${type} | ${clean}\n`;
  appendFileSync(join(layout.pagesDir, "log.md"), line, "utf8");
}

/** 读 log 里最近一次 ingest 的日期（YYYY-MM-DD），没有返回 null。P4 的 /ingest 判定用。 */
export function lastIngestDate(layout: WikiLayout): string | null {
  const p = join(layout.pagesDir, "log.md");
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  const hits = [...text.matchAll(/^## \[(\d{4}-\d{2}-\d{2})\] ingest \|/gm)];
  const last = hits.at(-1)?.[1];
  return last ?? null;
}

/* ------------------------------------------------------------------ */
/* INDEX 同步                                                          */
/* ------------------------------------------------------------------ */

/**
 * 向 INDEX.md 的主题目录追加一行（若该页已有行则更新摘要列）。
 *
 * INDEX 是人写 + 工具共管的文件，这里刻意做**保守同步**：
 *  - 找到 [[页面]] 所在行 → 原地更新该行；
 *  - 没有该页的行 → 追加到第一个「| 主题 |」表头之后的表末（没有表则建一个）；
 *  - 不动文件其余部分（定位语、来源清单、关联图等都是人或 ingest 的领地）。
 */
export function syncIndex(layout: WikiLayout, pageName: string, summary: string): void {
  const p = join(layout.pagesDir, "INDEX.md");
  if (!existsSync(p)) {
    // 没有索引就建一个最小骨架（正常 /init 会先建）
    const skeleton = [
      "# 索引",
      "",
      `> 最后更新:${todayStamp()}`,
      "",
      "## 🗂 主题目录",
      "",
      "| 主题 | 页面 | 一句话摘要 | 元数据 |",
      "|------|------|-----------|--------|",
      indexRow(pageName, summary),
    ].join("\n");
    writeFileSync(p, skeleton + "\n", "utf8");
    return;
  }

  const text = readFileSync(p, "utf8");
  const link = `[[${pageName}]]`;
  const lines = text.split("\n");
  const rowRe = new RegExp(`^\\|.*\\[\\[${escapeRe(pageName)}\\]\\]`);

  const idx = lines.findIndex((l) => rowRe.test(l));
  if (idx !== -1) {
    // 已有行：更新摘要列（第 3 列），其余列保留
    const cells = (lines[idx] ?? "").split("|");
    if (cells.length >= 4) {
      cells[3] = ` ${summary.slice(0, 80)} `;
      lines[idx] = cells.join("|");
    } else {
      lines[idx] = indexRow(pageName, summary);
    }
    writeFileSync(p, lines.join("\n"), "utf8");
    return;
  }

  // 新页：追加到第一个表头后的最后一个表行之后；没有表就在主题目录节下建表
  const headerIdx = lines.findIndex((l) => /^\|\s*主题\s*\|/.test(l));
  if (headerIdx !== -1) {
    let insertAt = headerIdx + 1;
    // 跳过分隔行 |---|
    if ((lines[insertAt] ?? "").includes("---")) insertAt++;
    while (insertAt < lines.length && (lines[insertAt] ?? "").startsWith("|")) insertAt++;
    lines.splice(insertAt, 0, indexRow(pageName, summary));
  } else {
    lines.push("", "## 🗂 主题目录", "", "| 主题 | 页面 | 一句话摘要 | 元数据 |", "|------|------|-----------|--------|", indexRow(pageName, summary));
  }
  // 更新索引自身日期戳
  const stamped = lines.map((l) =>
    /(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/.test(l)
      ? l.replace(/(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/, `$1:${todayStamp()}`)
      : l,
  );
  writeFileSync(p, stamped.join("\n"), "utf8");
}

function indexRow(pageName: string, summary: string): string {
  return `| ${pageName} | [[${pageName}]] | ${summary.slice(0, 80)} | |`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------------ */
/* 回填操作                                                            */
/* ------------------------------------------------------------------ */

export interface WriteBackResult {
  action: "create" | "append";
  page: string;
  indexSynced: boolean;
  logged: boolean;
}

/**
 * 回填：新建页或追加段落。这是「写回 wiki」的唯一合法路径。
 *
 * - create：内容必须自带摘要与日期戳（缺了直接拒绝，不代劳——代劳会让模型
 *   养成「反正工具会补」的依赖，校验的意义就没了）；
 * - append：往已有页追加 `## 推理与依据` 段并更新日期戳；页内已有该段则续写；
 * - 两者都自动同步 INDEX（create）与 log（必登）。
 */
export function writeBack(
  layout: WikiLayout,
  opts: {
    action: "create" | "append";
    page: string;
    content: string;
    logType?: LogType;
    logTitle: string;
  },
): WriteBackResult {
  const name = opts.page.trim();
  const nameErr = validatePageName(name);
  if (nameErr) throw new WikiWriteError(nameErr);

  const target = join(layout.pagesDir, name);
  const exists = existsSync(target);

  if (opts.action === "create") {
    if (exists) {
      throw new WikiWriteError(
        `${name} 已存在。改写已有页请用 action=append（或先明确重写意图）；新建请换名`,
      );
    }
    const missing = validatePageContent(opts.content);
    if (missing.length > 0) {
      throw new WikiWriteError(`页面缺少必备结构：${missing.join("、")}`);
    }
    writeFileSync(target, opts.content.endsWith("\n") ? opts.content : opts.content + "\n", "utf8");
    syncIndex(layout, name.replace(/\.md$/, ""), extractFirstSummary(opts.content));
    appendLog(layout, opts.logType ?? "query", opts.logTitle);
    return { action: "create", page: name, indexSynced: true, logged: true };
  }

  // append
  if (!exists) {
    throw new WikiWriteError(`${name} 不存在，无法追加。新建页请用 action=create`);
  }
  const src = readFileSync(target, "utf8");
  const section = opts.content.trim();
  const anchor = /^## 推理与依据\s*$/m;
  let out: string;
  if (anchor.test(src)) {
    // 已有推理段：续写到该段末尾（下一个 ## 之前）
    out = src.replace(anchor, `## 推理与依据\n\n${section}\n`);
  } else {
    out = `${src.replace(/\s*$/, "")}\n\n## 推理与依据\n\n${section}\n`;
  }
  // 更新日期戳（更新即改戳）
  out = out.replace(
    /(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/,
    `$1:${todayStamp()}`,
  );
  writeFileSync(target, out, "utf8");
  appendLog(layout, opts.logType ?? "query", opts.logTitle);
  return { action: "append", page: name, indexSynced: false, logged: true };
}

/** 从页面内容提取摘要段的第一行非空文本，供 INDEX 一句话摘要用。 */
function extractFirstSummary(content: string): string {
  const m = /^## (?:摘要|Summary)\s*\n+([\s\S]*?)(?=\n## |\n> |$)/m.exec(content);
  const first = (m?.[1] ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first ?? "";
}
