/**
 * 记忆系统公共 API（PRD docs/memory-prd.md §6.1 / §6.2 / §A）。
 *
 * 当前 commit 为「stage 1 — type 层绿 / 行为层红」：所有函数签名已
 * 暴露给测试文件，运行时抛 `MemoryError` 表示尚未实现。后续 commit
 * 逐 feature 推（先 Config，再 recordIndex / ensureProfile / ingest …）。
 */

import type { Config } from "../config.ts";
import type { Message } from "../llm.ts";
import type {
  IngestEngine,
  IngestOpts,
  IngestResult,
  MemoryEntry,
  ProfileSlice,
} from "./types.ts";
import { MemoryError } from "./types.ts";

import { recordIndex as recordIndexImpl, type RecordIndexOpts } from "./recordIndex.ts";
import { ensureProfile as ensureProfileImpl, reInjectProfile as reInjectProfileImpl, estimateTextTokens } from "./profile.ts";
import { ingestUserLevel as ingestUserLevelImpl, defaultIngestEngine } from "./ingest.ts";
import { initProjectLevel as initProjectLevelImpl } from "./init.ts";
import { forgetDryRun, forgetYes, forgetResume } from "./forget.ts";
import { reindex as reindexImpl } from "./reindex.ts";
import { redactSummary as redactSummaryImpl } from "./redact.ts";
export { defaultIngestEngine };
export { parseIndexEntry } from "./schema.ts";
export { sanitizeCwd, generateShortId, buildFileName, renderIndexEntry, parseIndexFile, takeGraphemes } from "./schema.ts";

/* ------------------------------------------------------------------ */
/* §6.1 公共 API                                                        */
/* ------------------------------------------------------------------ */

export async function ensureProfile(
  cfg: Config,
  opts?: { oneShot?: boolean },
): Promise<ProfileSlice | null> {
  return ensureProfileImpl(cfg, opts);
}

export async function recordIndex(
  cfg: Config,
  cwd: string,
  opts: RecordIndexOpts,
): Promise<string | null> {
  return recordIndexImpl(cfg, cwd, opts);
}

export async function reInjectProfile(
  cfg: Config,
  messages: Message[],
): Promise<Message[]> {
  return reInjectProfileImpl(cfg, messages);
}

export async function ingestUserLevel(
  cfg: Config,
  opts?: IngestOpts,
): Promise<IngestResult> {
  return ingestUserLevelImpl(cfg, opts);
}

export async function initProjectLevel(
  cfg: Config,
  cwd: string,
): Promise<void> {
  return initProjectLevelImpl(cfg, cwd);
}

/* ------------------------------------------------------------------ */
/* §A /memory 子命令族                                                  */
/* ------------------------------------------------------------------ */

export async function redactSummary(
  cfg: Config,
  path: string,
  pattern: string,
): Promise<void> {
  return redactSummaryImpl(cfg, path, pattern);
}

export async function forgetEntries(
  cfg: Config,
  shortIds: string[],
  opts?: { yes?: boolean; dryRun?: boolean },
): Promise<{ deleted: string[]; skipped: string[] }> {
  const paths = shortIds.map((s) => resolveRawPath(cfg, s));
  if (opts?.dryRun) {
    const r = await forgetDryRun(cfg, paths);
    return { deleted: r.wouldDelete, skipped: Object.keys(r.reasonByPath) };
  }
  if (opts?.yes) {
    return forgetYes(cfg, paths);
  }
  // default：y/N 询问（v0.1 占位：自动拒）
  return { deleted: [], skipped: paths };
}

export async function reindexForCwd(
  cfg: Config,
  newCwd: string,
): Promise<{ renamed: string[]; failed: string[] }> {
  return reindexImpl(cfg, "", newCwd);
}

export async function listStatus(
  cfg: Config,
  opts?: { cwd?: string; date?: string },
): Promise<string> {
  return listStatusImpl(cfg, opts);
}

/* ------------------------------------------------------------------ */
/* 工具（供其它 memory 子模块用）                                          */
/* ------------------------------------------------------------------ */

export function estimateProfile(text: string): number {
  return estimateTextTokens(text);
}

/* ------------------------------------------------------------------ */
/* IngestEngine 注入点（§7.4 #2）                                       */
/* ------------------------------------------------------------------ */

/** 进程内 IngestEngine 注册点；测试可在 beforeAll 里设置。 */
let _ingestEngine: IngestEngine = defaultIngestEngine;

export function registerIngestEngine(engine: IngestEngine): void {
  _ingestEngine = engine;
}

export function currentIngestEngine(): IngestEngine {
  return _ingestEngine;
}

/* ------------------------------------------------------------------ */
/* 类型再导出                                                           */
/* ------------------------------------------------------------------ */

export type {
  IngestEngine,
  IngestOpts,
  IngestResult,
  MemoryEntry,
  ProfileSlice,
} from "./types.ts";
export { MemoryError } from "./types.ts";
export type { MemoryErrorCode } from "./types.ts";
/* ------------------------------------------------------------------ */
/* 内部 helpers                                                          */
/* ------------------------------------------------------------------ */

import { readdirSync } from "node:fs";
import { join } from "node:path";

function resolveRawPath(cfg: Config, shortId: string): string {
  const rawDir = join(cfg.memory.userLevelDir, "raw");
  // 简单按 shortId 搜：精确文件名匹配 `<date>_*_<shortId>.md`
  let files: string[];
  try {
    files = readdirSync(rawDir);
  } catch {
    return join(rawDir, `${shortId}.md`);
  }
  for (const f of files) {
    if (f.endsWith(`_${shortId}.md`)) return join(rawDir, f);
  }
  return join(rawDir, `${shortId}.md`);
}

/**
 * listStatus 实现（§A /memory status）：按 cwd 列出当前 cwd 在用户级索引里的条目。
 */
async function listStatusImpl(cfg: Config, opts?: { cwd?: string; date?: string }): Promise<string> {
  const rawDir = join(cfg.memory.userLevelDir, "raw");
  const targetCwd = opts?.cwd ?? cfg.cwd;
  let files: string[];
  try {
    files = readdirSync(rawDir).filter((f) => f.endsWith(".md"));
  } catch {
    return `cwd: ${targetCwd}  索引 0 条：`;
  }

  const lines: string[] = [`cwd: ${targetCwd}  索引 ${files.length} 条：`];
  for (const f of files) {
    try {
      const { parseIndexFile } = await import("./schema.ts");
      const text = await import("node:fs").then((m) => m.readFileSync(join(rawDir, f), "utf8"));
      const entry = parseIndexFile(text);
      if (opts?.cwd && entry.cwd !== opts.cwd) continue;
      if (opts?.date && entry.date !== opts.date) continue;
      lines.push(`  - ${entry.date} ${f.replace(/\.md$/, "")} ${entry.summary}`);
    } catch {
      continue;
    }
  }
  return lines.join("\n");
}
