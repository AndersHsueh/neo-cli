/**
 * env/wiki.ts — 环境快照 → 用户级 wiki 派生页（v0.4.0 平台适配层）。
 *
 * 用户拍板（PRD §9）：单页 `~/.neo/wiki/wiki/环境.md`，脚本拥有生成块：
 *  - `<!-- neo:env:start -->` … `<!-- neo:env:end -->` 之间由脚本整块重写；
 *  - 块外（`## 人工补充` 等）永不触碰，允许人/remember 维护；
 *  - INDEX 摘要随写同步；log 只在「首次创建」或「机器/OS/shell 变了」时记一条，
 *    避免每次会话刷 log。
 *
 * 注意：调用方必须保证「-p / 非交互模式」不走到这里（用户裁决：只注入不落盘）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WikiLayout } from "../wiki/paths.ts";
import {
  appendLog,
  syncIndex,
  todayStamp,
  validatePageContent,
  writeAtomic,
} from "../wiki/write.ts";
import type { EnvSnapshot } from "./types.ts";
import {
  ENV_BLOCK_END,
  ENV_BLOCK_START,
  readEnvPageFingerprint,
  renderEnvPage,
} from "./render.ts";

export const ENV_PAGE_NAME = "环境.md";

const SUMMARY_HEADING_RE = /^## (?:摘要|Summary)\s*$/m;
const DATE_STAMP_RE = /(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/;

export interface EnvPageMergeResult {
  content: string;
  previousFingerprint: string | null;
  /** 是否命中已有生成块（否则是追加）。 */
  replacedBlock: boolean;
}

/** 生成一份全新页面（含必备的摘要 + 日期戳 + 人工补充区）。 */
export function buildEnvPage(summary: string, block: string, date = todayStamp()): string {
  return [
    "## 摘要",
    "",
    summary,
    "",
    `> 最后更新:${date}`,
    "",
    block,
    "",
    "## 人工补充",
    "",
    "（此段由人或 `remember` 维护，`/env` 永不改写：编辑器、常用路径、个人习惯等稳定信息。）",
    "",
  ].join("\n");
}

/**
 * 把新生成块合并进已有页面：
 *  - 有 start/end 标记 → 只替换标记区间；
 *  - 无标记 → 追加到文末（保留全部人工内容）；
 *  - 缺摘要/日期戳 → 补齐（页面校验要求）。
 */
export function mergeEnvPage(
  existing: string | null,
  block: string,
  summary: string,
  date = todayStamp(),
): EnvPageMergeResult {
  if (existing === null) {
    return { content: buildEnvPage(summary, block, date), previousFingerprint: null, replacedBlock: false };
  }

  const previousFingerprint = readEnvPageFingerprint(existing);
  let out = existing.replace(/\r\n/g, "\n");
  let replacedBlock = false;

  const start = out.indexOf(ENV_BLOCK_START);
  const end = out.indexOf(ENV_BLOCK_END);
  if (start >= 0 && end > start) {
    out = `${out.slice(0, start)}${block}${out.slice(end + ENV_BLOCK_END.length)}`;
    replacedBlock = true;
  } else {
    out = `${out.replace(/\s*$/, "")}\n\n${block}\n`;
  }

  // 日期戳：有则改，无则补在摘要后面（再没有摘要就补页首）。
  if (DATE_STAMP_RE.test(out)) {
    out = out.replace(DATE_STAMP_RE, (_m, label: string, colon: string) => `${label}${colon}${date}`);
  } else if (SUMMARY_HEADING_RE.test(out)) {
    out = out.replace(SUMMARY_HEADING_RE, (m) => `${m}\n\n> 最后更新:${date}`);
  } else {
    out = `## 摘要\n\n${summary}\n\n> 最后更新:${date}\n\n${out.replace(/^\s*/, "")}`;
  }

  const missing = validatePageContent(out);
  if (missing.length > 0) {
    // 理论上走不到：上面已补齐摘要+日期戳。保险起见再兜一次，避免半成品页落盘。
    out = `## 摘要\n\n${summary}\n\n> 最后更新:${date}\n\n${out.replace(/^\s*/, "")}`;
  }

  return { content: out.endsWith("\n") ? out : `${out}\n`, previousFingerprint, replacedBlock };
}

export interface EnvPageSyncResult {
  action: "created" | "updated" | "unchanged";
  pagePath: string;
  logged: boolean;
  fingerprint: string;
}

/**
 * 同步环境页。返回 action 供调用方决定是否提示；任何 IO 错误向上抛，由调用方
 * 按「非致命」处理（环境记录失败不能影响会话）。
 */
export function syncEnvPage(layout: WikiLayout, snap: EnvSnapshot): EnvPageSyncResult {
  const { summary, block, fingerprint } = renderEnvPage(snap);
  const pagePath = join(layout.pagesDir, ENV_PAGE_NAME);
  const existing = existsSync(pagePath) ? readFileSync(pagePath, "utf8") : null;
  const merged = mergeEnvPage(existing, block, summary);
  const changed = existing === null || merged.content !== existing;

  if (!changed) {
    return { action: "unchanged", pagePath, logged: false, fingerprint };
  }

  writeAtomic(pagePath, merged.content);
  syncIndex(layout, ENV_PAGE_NAME.replace(/\.md$/, ""), summary);

  // log 纪律：只在首次创建或关键字段（机器/OS/shell）变化时记一条。
  const keyChanged = existing !== null && merged.previousFingerprint !== fingerprint;
  const logged = existing === null || keyChanged;
  if (logged) {
    const reason = existing === null ? "首次生成" : "机器/OS/shell 变化";
    appendLog(layout, "wiki", `环境快照 ${snap.static.hostname}（${reason}，自动生成）`);
  }

  return { action: existing === null ? "created" : "updated", pagePath, logged, fingerprint };
}
