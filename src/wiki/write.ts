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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WikiLayout } from "./paths.ts";
import { extractLinkTargets } from "./links.ts";

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
/* 链接目标校验（issue #22）                                            */
/* ------------------------------------------------------------------ */

/**
 * 固定页名（与 lint.ts 的 ALWAYS_ALLOWED 一致）：这些名字不算断链，
 * 但它们不是主题页，所以不参与「本层存在」的判定。
 */
const LINK_ALLOWED_NAMES = new Set(["INDEX", "index", "log", "AGENTS"]);

/** 缺失目标的两种情形。 */
export type LinkIssueKind = "missing" | "cross-layer";

export interface LinkIssue {
  kind: LinkIssueKind;
  /** 缺失的目标页名（归一化后，不含 .md）。 */
  target: string;
  /**
   * 目标所在的另一层（kind=cross-layer 时有值）："user" 或 "project"。
   */
  otherScope?: "user" | "project";
  /** 人类可读的说明文案（含层名，指名缺失目标）。 */
  message: string;
}

export interface LinkCheckResult {
  issues: LinkIssue[];
  /** 本层存在的目标（已归一化）。 */
  resolved: string[];
}

/** 本层作用域的展示名。 */
function scopeLabel(scope: "project" | "user"): string {
  return scope === "user" ? "用户级 wiki" : "项目级 wiki";
}

/**
 * 列出某层 pagesDir 下的主题页名（归一化后、不含 .md）。
 * 目录不存在返回空集（该层视为不存在）。
 */
export function listPageNames(pagesDir: string | null | undefined): Set<string> {
  const names = new Set<string>();
  if (!pagesDir || !existsSync(pagesDir)) return names;
  let files: string[] = [];
  try {
    files = readdirSync(pagesDir);
  } catch {
    return names;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    names.add(f.replace(/\.md$/, ""));
  }
  return names;
}

/**
 * 校验正文里的 [[链接]] 目标是否存在于本层。
 *
 * 口径与 src/wiki/lint.ts 一致（同一套 normalizeLinkTarget，见 ./links.ts）：
 *  - `[[目标|别名]]` / `[[目标#锚点]]` / `[[目标.md]]` 归一后按纯页名比对；
 *  - 归一后为空串的路径式目标（`[[../AGENTS]]`）按 lint 口径跳过；
 *  - 代码块与行内反引号内的链接不计。
 *
 * 本层不存在但另一层存在时，报 kind=cross-layer 并指名层名
 * （issue #22 的核心：断链的根因多是「用户级/项目级串层」，只报断链会误导）。
 */
export function checkLinkTargets(
  content: string,
  opts: {
    /** 本层布局（决定本层 pagesDir 与作用域名）。 */
    layout: WikiLayout;
    /** 本次要写入的页名（不含 .md）。自身链接不算断链。 */
    selfPage?: string;
    /** 另一层布局；不存在（用户级未创建）时按「两层都无」处理。 */
    otherLayout?: WikiLayout | null;
  },
): LinkCheckResult {
  const ownScope = opts.layout.scope === "user" || opts.layout.kind === "user" ? "user" : "project";
  const own = listPageNames(opts.layout.pagesDir);
  const ownLabel = scopeLabel(ownScope);

  const other = opts.otherLayout ?? null;
  const otherScope: "user" | "project" = ownScope === "user" ? "project" : "user";
  const otherLabel = scopeLabel(otherScope);
  const otherNames = other ? listPageNames(other.pagesDir) : new Set<string>();

  const issues: LinkIssue[] = [];
  const resolved: string[] = [];

  for (const target of extractLinkTargets(content)) {
    // 固定页名（INDEX/index/log/AGENTS）不算断链
    if (LINK_ALLOWED_NAMES.has(target)) continue;
    // 自身链接（自链）在本层成立
    if (opts.selfPage && target === opts.selfPage) {
      resolved.push(target);
      continue;
    }
    if (own.has(target)) {
      resolved.push(target);
      continue;
    }
    if (otherNames.has(target)) {
      issues.push({
        kind: "cross-layer",
        target,
        otherScope,
        message: `${target} 在${otherLabel}，${ownLabel}没有 —— 请改链到本层，或把该页复制到本层`,
      });
      continue;
    }
    issues.push({
      kind: "missing",
      target,
      message: `${target} 在${ownLabel}不存在（另一层也没有）—— 写入后会成断链`,
    });
  }

  return { issues, resolved };
}

/** 把校验结果渲染成给模型看的中文提示行。 */
export function formatLinkIssues(issues: LinkIssue[]): string {
  return issues.map((i) => `⚠️ 链接目标缺失：${i.message}`).join("\n");
}

/* ------------------------------------------------------------------ */
/* log                                                                 */
/* ------------------------------------------------------------------ */

export function todayStamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 原子写：同目录 tmp 文件 + rename。
 *
 * 为什么需要：记忆页会被「自动归纳」与「人工回填」从两个进程并发写，
 * 直接 writeFileSync 在崩溃/并发下可能留下半截文件。rename 在同一文件系统
 * 内是原子的 —— 读者要么看到旧内容、要么看到完整新内容。
 */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort 清理：tmp 残留不影响正确性
    }
    throw e;
  }
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
    writeAtomic(p, skeleton + "\n");
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
    writeAtomic(p, lines.join("\n"));
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
  writeAtomic(p, stamped.join("\n"));
}

/**
 * 从 INDEX 主题目录删除某页的行（/memory forget 用）。
 * 返回是否真的删了一行；INDEX 不存在或没有该行时返回 false（不报错）。
 */
export function removeIndexRow(layout: WikiLayout, pageName: string): boolean {
  const p = join(layout.pagesDir, "INDEX.md");
  if (!existsSync(p)) return false;
  const lines = readFileSync(p, "utf8").split("\n");
  const rowRe = new RegExp(`^\\|.*\\[\\[${escapeRe(pageName)}\\]\\]`);
  const idx = lines.findIndex((l) => rowRe.test(l));
  if (idx === -1) return false;
  lines.splice(idx, 1);
  const stamped = lines.map((l) =>
    /(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/.test(l)
      ? l.replace(/(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/, `$1:${todayStamp()}`)
      : l,
  );
  writeAtomic(p, stamped.join("\n"));
  return true;
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
  /** 链接目标校验发现的问题（issue #22）。默认不阻断写入，仅提示。 */
  linkIssues: LinkIssue[];
}

/**
 * 链接目标校验的开关（issue #22）。
 *
 * 默认「警告不阻断」：append 场景多为追加审计行，硬报错会挡死整次回填；
 * 跨层链接有时正是作者有意引用另一层。create 场景是否走严格模式，
 * 由维护者拍板（见 docs/wiki-write-link-check-prd.md）。
 */
export type LinkCheckMode = "off" | "warn" | "strict";

/** 默认口径：警告不阻断。 */
export const DEFAULT_LINK_CHECK_MODE: LinkCheckMode = "warn";

/**
 * 回填：新建页或追加段落。这是「写回 wiki」的唯一合法路径。
 *
 * - create：内容必须自带摘要与日期戳（缺了直接拒绝，不代劳——代劳会让模型
 *   养成「反正工具会补」的依赖，校验的意义就没了）；
 * - append：往已有页追加 `## 推理与依据` 段并更新日期戳；页内已有该段则续写；
 * - 两者都自动同步 INDEX（create）与 log（必登）；
 * - 链接目标校验（issue #22）：落盘前检查正文里的 [[X]]，缺失或跨层时提示。
 */
export function writeBack(
  layout: WikiLayout,
  opts: {
    action: "create" | "append";
    page: string;
    content: string;
    logType?: LogType;
    logTitle: string;
    /** 另一层布局（用于跨层判定）；缺省则不查另一层。 */
    otherLayout?: WikiLayout | null;
    /** 链接校验口径，默认 warn（警告不阻断）。strict 时缺失/跨层直接抛错。 */
    linkCheck?: LinkCheckMode;
  },
): WriteBackResult {
  const name = opts.page.trim();
  const nameErr = validatePageName(name);
  if (nameErr) throw new WikiWriteError(nameErr);

  const target = join(layout.pagesDir, name);
  const exists = existsSync(target);

  // 链接目标校验：落盘前做（issue #22）。strict 抛错阻断，warn 只记录。
  const mode = opts.linkCheck ?? DEFAULT_LINK_CHECK_MODE;
  const linkIssues: LinkIssue[] = [];
  if (mode !== "off") {
    const checked = checkLinkTargets(opts.content, {
      layout,
      selfPage: name.replace(/\.md$/, ""),
      otherLayout: opts.otherLayout ?? null,
    });
    linkIssues.push(...checked.issues);
    if (mode === "strict" && linkIssues.length > 0) {
      throw new WikiWriteError(
        `链接目标校验未通过：\n${formatLinkIssues(linkIssues)}\n` +
          `（严格模式下不写入；改链接或用其它 action 重试）`,
      );
    }
  }

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
    writeAtomic(target, opts.content.endsWith("\n") ? opts.content : opts.content + "\n");
    syncIndex(layout, name.replace(/\.md$/, ""), extractFirstSummary(opts.content));
    appendLog(layout, opts.logType ?? "query", opts.logTitle);
    return { action: "create", page: name, indexSynced: true, logged: true, linkIssues };
  }

  // append
  if (!exists) {
    throw new WikiWriteError(`${name} 不存在，无法追加。新建页请用 action=create`);
  }
  const src = readFileSync(target, "utf8");
  const section = opts.content.trim();
  const anchor = /^## 推理与依据\s*$/m;
  const m = anchor.exec(src);
  let out: string;
  if (m) {
    // 已有推理段：真正续写到该段末尾（下一个 ## 标题之前），而不是插到段首。
    // 旧实现用 replace(anchor, header+section) 会把新内容塞到旧内容前面，顺序反了。
    const start = m.index + m[0].length;
    const rest = src.slice(start);
    const next = /^## /m.exec(rest);
    if (next) {
      const insertAt = start + next.index;
      out = `${src.slice(0, insertAt).replace(/\s*$/, "")}\n\n${section}\n\n${src.slice(insertAt)}`;
    } else {
      out = `${src.replace(/\s*$/, "")}\n\n${section}\n`;
    }
  } else {
    out = `${src.replace(/\s*$/, "")}\n\n## 推理与依据\n\n${section}\n`;
  }
  // 更新日期戳（更新即改戳）
  out = out.replace(
    /(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/,
    `$1:${todayStamp()}`,
  );
  writeAtomic(target, out);
  // v0.2 记忆激活（§7.5.6）：append 也要同步 INDEX 摘要 —— 否则自动沉淀的页面
  // 在 INDEX 里永远停着创建时的旧摘要，召回与人都看到过时信息。
  syncIndex(layout, name.replace(/\.md$/, ""), extractFirstSummary(out));
  appendLog(layout, opts.logType ?? "query", opts.logTitle);
  return { action: "append", page: name, indexSynced: true, logged: true, linkIssues };
}

/** 从页面内容提取摘要段的第一行非空文本，供 INDEX 一句话摘要用。 */
export function extractFirstSummary(content: string): string {
  const m = /^## (?:摘要|Summary)\s*\n+([\s\S]*?)(?=\n## |\n> |$)/m.exec(content);
  const first = (m?.[1] ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first ?? "";
}
