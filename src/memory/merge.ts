/**
 * merge.ts — 记忆合并/落页（v0.2 记忆激活 §7.6.5）。
 *
 * 提炼器给出 op，但「写不写、写到哪、算不算重复」由这里裁决：
 *  1. 作用域解析 + 路径包含校验（自动写入不得越出记忆库）；
 *  2. 去重：内容哈希 + 页面内相似度（shingle Jaccard），防止 20 轮相似对话写 20 遍；
 *  3. 事实/推断分流：用户级事实进 `## 事实（用户明确表达）`，推断进 `## 推断（待确认）`；
 *  4. 冲突/更正：supersedes 命中页面原文时，追加带日期的「更正」行；
 *  5. 上限：单页 16KB 后转 `-续N` 页；每轮 op 数已由 distill 限制；
 *  6. 落页统一走 wiki 的校验/INDEX/log（append 也同步 INDEX）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WikiLayout } from "../wiki/paths.ts";
import {
  appendLog,
  syncIndex,
  todayStamp,
  writeAtomic,
  writeBack,
} from "../wiki/write.ts";
import { assertInsideLayout } from "./layout.ts";
import {
  appendAppliedHashes,
  contentHash,
  normalizeForHash,
  readAppliedHashes,
} from "./journal.ts";
import type { DistillOp, MemoryInventoryItem } from "./distill.ts";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const USER_FACT_HEADING = "## 事实（用户明确表达）";
export const USER_INFER_HEADING = "## 推断（待确认）";
const DEFAULT_MAX_PAGE_BYTES = 16 * 1024;
const SCHEMA_SKIP = new Set(["INDEX.md", "index.md", "log.md", "AGENTS.md"]);

/* ------------------------------------------------------------------ */
/* 清单                                                                */
/* ------------------------------------------------------------------ */

/** 收集双库页面清单，供提炼器判断 create/append。 */
export function collectInventory(
  layouts: { project: WikiLayout | null; user: WikiLayout | null },
  limit = 60,
): MemoryInventoryItem[] {
  const out: MemoryInventoryItem[] = [];
  const read = (layout: WikiLayout | null, scope: "project" | "user"): void => {
    if (!layout || out.length >= limit) return;
    let files: string[];
    try {
      files = readdirSync(layout.pagesDir).filter((f) => f.endsWith(".md") && !SCHEMA_SKIP.has(f));
    } catch {
      return;
    }
    for (const f of files) {
      if (out.length >= limit) return;
      let text: string;
      try {
        text = readFileSync(join(layout.pagesDir, f), "utf8");
      } catch {
        continue;
      }
      const stamp = /(最后更新|Last updated)(：|:)\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[3];
      const updated = stamp ?? safeDate(join(layout.pagesDir, f));
      out.push({ scope, page: f, summary: extractPageSummary(text), updated });
    }
  };
  read(layouts.project, "project");
  read(layouts.user, "user");
  return out;
}

function extractPageSummary(text: string): string {
  const m = /^## (?:摘要|Summary)\s*\n+([\s\S]*?)(?=\n## |\n> |$)/m.exec(text);
  const first = (m?.[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("<!--"));
  return first ?? "";
}

function safeDate(path: string): string {
  try {
    return new Date(statSync(path).mtimeMs).toISOString().slice(0, 10);
  } catch {
    return todayStamp();
  }
}

/* ------------------------------------------------------------------ */
/* 去重                                                                */
/* ------------------------------------------------------------------ */

/** 规范化文本的 n-gram 集合（中文按字符、英文按词，统一 3-gram 字符窗口即可）。 */
function shingles(normalized: string, n = 3): Set<string> {
  const set = new Set<string>();
  if (normalized.length <= n) {
    if (normalized) set.add(normalized);
    return set;
  }
  for (let i = 0; i + n <= normalized.length; i++) set.add(normalized.slice(i, i + n));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 内容是否已存在于页面（子串或相似度）。 */
export function isDuplicate(body: string, pageText: string): boolean {
  const nb = normalizeForHash(body);
  const np = normalizeForHash(pageText);
  if (!nb) return true;
  if (np.includes(nb)) return true;
  if (nb.length < 12) return false;
  return jaccard(shingles(nb), shingles(np)) >= 0.85;
}

/* ------------------------------------------------------------------ */
/* 页面构造                                                            */
/* ------------------------------------------------------------------ */

function userSectionFor(op: DistillOp): string {
  return op.inferred ? USER_INFER_HEADING : USER_FACT_HEADING;
}

function bulletFor(op: DistillOp, ctx: MergeContext): string {
  if (op.inferred) {
    return `- （推断 ${ctx.date} · 置信 ${op.confidence.toFixed(2)} · session ${ctx.sessionId}）${op.body}`;
  }
  return `- ${ctx.date}：${op.body}`;
}

function projectCreateContent(op: DistillOp, ctx: MergeContext): string {
  return [
    `# ${op.page.replace(/\.md$/, "")}`,
    "",
    "## 摘要",
    "",
    op.summary,
    "",
    `> 最后更新:${ctx.date}`,
    `> 来源:session ${ctx.sessionId} · ${ctx.date} · 自动归纳`,
    "",
    "## 正文",
    "",
    op.body,
    "",
  ].join("\n");
}

function userCreateContent(op: DistillOp, ctx: MergeContext): string {
  const section = userSectionFor(op);
  return [
    `# ${op.page.replace(/\.md$/, "")}`,
    "",
    "## 摘要",
    "",
    op.summary,
    "",
    `> 最后更新:${ctx.date}`,
    `> 来源:session ${ctx.sessionId} · ${ctx.date} · 自动归纳`,
    "",
    section,
    "",
    bulletFor(op, ctx),
    "",
  ].join("\n");
}

/** 在指定二级标题段末插入一行；段不存在则新建该段。同时刷新日期戳。 */
export function appendToSection(
  src: string,
  heading: string,
  block: string,
  date: string,
): string {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}\\s*$`, "m");
  const m = re.exec(src);
  let out: string;
  if (m) {
    const start = m.index + m[0].length;
    const next = /^## /m.exec(src.slice(start));
    if (next) {
      const insertAt = start + next.index;
      out = `${src.slice(0, insertAt).replace(/\s*$/, "")}\n\n${block}\n\n${src.slice(insertAt)}`;
    } else {
      out = `${src.replace(/\s*$/, "")}\n\n${block}\n`;
    }
  } else {
    out = `${src.replace(/\s*$/, "")}\n\n${heading}\n\n${block}\n`;
  }
  return out.replace(
    /(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/,
    `$1:${date}`,
  );
}

function continuationName(layout: WikiLayout, page: string): string {
  const base = page.replace(/\.md$/, "");
  for (let n = 1; n < 100; n++) {
    const cand = `${base}-续${n}.md`;
    if (!existsSync(join(layout.pagesDir, cand))) return cand;
  }
  return `${base}-续99.md`;
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

export interface MergeContext {
  project: WikiLayout;
  user: WikiLayout | null;
  sessionId: string;
  date: string;
  journalDir: string;
  maxPageBytes?: number;
}

export interface MergeApplied {
  index: number;
  scope: "project" | "user";
  action: "create" | "append";
  page: string;
  status: "created" | "appended" | "deduped" | "split";
}

export interface MergeDropped {
  index: number;
  reason: string;
}

export interface MergeResult {
  applied: MergeApplied[];
  dropped: MergeDropped[];
}

/**
 * 应用 op 列表。任何单条 op 的失败只丢弃该 op，不影响其余 op，
 * 也不向调用方抛错（返回 dropped 原因供审计）。
 */
export function applyOps(ops: DistillOp[], ctx: MergeContext): MergeResult {
  const applied: MergeApplied[] = [];
  const dropped: MergeDropped[] = [];
  const maxPageBytes = ctx.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
  const seenHashes = readAppliedHashes(ctx.journalDir);
  const newHashes: string[] = [];

  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (!op) continue;
    const layout = op.scope === "user" ? ctx.user : ctx.project;
    if (!layout) {
      dropped.push({ index, reason: "用户记忆库不可用（单次模式未启用用户级）" });
      continue;
    }

    try {
      const hash = contentHash(op.page, op.body);
      if (seenHashes.has(hash)) {
        applied.push({ index, scope: op.scope, action: op.action, page: op.page, status: "deduped" });
        continue;
      }

      // 同批内也不允许重复（seenHashes 只含历史，本轮新写的要加进去）
      seenHashes.add(hash);
      let target = join(layout.pagesDir, op.page);
      assertInsideLayout(layout, target);

      let exists = existsSync(target);
      let pageText = exists ? readFileSync(target, "utf8") : "";
      let action = op.action;

      // append 目标不存在（清单过期/竞态）→ 降级为 create，不丢信息但保持结构合法
      if (action === "append" && !exists) action = "create";

      // 去重：整页相似或 body 已包含
      if (exists && isDuplicate(op.body, pageText)) {
        applied.push({ index, scope: op.scope, action, page: op.page, status: "deduped" });
        newHashes.push(hash);
        continue;
      }

      // 页面超限：转续页
      let split = false;
      if (exists && Buffer.byteLength(pageText, "utf8") > maxPageBytes) {
        const cont = continuationName(layout, op.page);
        target = join(layout.pagesDir, cont);
        assertInsideLayout(layout, target);
        pageText = "";
        exists = false;
        action = "create";
        split = true;
      }

      if (action === "create") {
        const content =
          op.scope === "user" ? userCreateContent(op, ctx) : projectCreateContent(op, ctx);
        writeBack(layout, {
          action: "create",
          page: split ? target.split("/").pop() ?? op.page : op.page,
          content,
          logType: "wiki",
          logTitle: `自动记忆：${op.scope}/${split ? target.split("/").pop() : op.page}（create）`,
        });
        applied.push({
          index,
          scope: op.scope,
          action: "create",
          page: split ? target.split("/").pop() ?? op.page : op.page,
          status: split ? "split" : "created",
        });
      } else {
        // append
        const correction =
          op.supersedes && pageText.includes(op.supersedes)
            ? `\n\n> 更正（${ctx.date} · session ${ctx.sessionId}）：原结论「${op.supersedes}」→ 见下\n\n`
            : "\n\n";
        if (op.scope === "user") {
          const block = bulletFor(op, ctx);
          const out = appendToSection(pageText, userSectionFor(op), block, ctx.date);
          writeAtomic(target, out);
          syncIndex(layout, op.page.replace(/\.md$/, ""), extractPageSummary(out));
          appendLog(layout, "wiki", `自动记忆：user/${op.page}（append）`);
        } else {
          writeBack(layout, {
            action: "append",
            page: op.page,
            content: `${correction}- ${ctx.date}（session ${ctx.sessionId}）：${op.body}`,
            logType: "wiki",
            logTitle: `自动记忆：project/${op.page}（append）`,
          });
        }
        applied.push({ index, scope: op.scope, action: "append", page: op.page, status: "appended" });
      }
      newHashes.push(hash);
    } catch (e) {
      dropped.push({ index, reason: (e as Error).message });
    }
  }

  if (newHashes.length > 0) appendAppliedHashes(ctx.journalDir, newHashes);
  return { applied, dropped };
}
