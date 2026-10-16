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
  _cfg: Config,
  _path: string,
  _pattern: string,
): Promise<void> {
  throw new MemoryError("schema_invalid", "redactSummary: not implemented (stage 1 stub)");
}

export async function forgetEntries(
  _cfg: Config,
  _shortIds: string[],
  _opts?: { yes?: boolean; dryRun?: boolean },
): Promise<{ deleted: string[]; skipped: string[] }> {
  throw new MemoryError("permission_denied", "forgetEntries: not implemented (stage 1 stub)");
}

export async function reindexForCwd(
  _cfg: Config,
  _newCwd: string,
): Promise<{ renamed: string[]; failed: string[] }> {
  throw new MemoryError("schema_invalid", "reindexForCwd: not implemented (stage 1 stub)");
}

export async function listStatus(
  _cfg: Config,
  _opts?: { cwd?: string; date?: string },
): Promise<string> {
  throw new MemoryError("ingest_failed", "listStatus: not implemented (stage 1 stub)");
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