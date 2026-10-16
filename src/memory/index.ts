/**
 * 记忆系统公共 API（PRD docs/memory-prd.md §6.1 / §6.2 / §A）。
 *
 * 当前 commit 为「stage 1 — type 层绿 / 行为层红」：所有函数签名已
 * 暴露给测试文件，运行时抛 `MemoryError` 表示尚未实现。后续 commit
 * 逐 feature 推（先 Config，再 recordIndex / ensureProfile / ingest …）。
 */

import type { Config } from "../config.ts";
import type {
  IngestEngine,
  IngestOpts,
  IngestResult,
  MemoryEntry,
  ProfileSlice,
} from "./types.ts";
import { MemoryError } from "./types.ts";

/* ------------------------------------------------------------------ */
/* §6.1 公共 API                                                        */
/* ------------------------------------------------------------------ */

export async function ensureProfile(
  _cfg: Config,
  _opts?: { oneShot?: boolean },
): Promise<ProfileSlice | null> {
  throw new MemoryError("ingest_failed", "ensureProfile: not implemented (stage 1 stub)");
}

export interface RecordIndexOpts {
  firstUserInput: string;
  date?: string;
  topic?: string;
}

export async function recordIndex(
  _cfg: Config,
  _cwd: string,
  _opts: RecordIndexOpts,
): Promise<string | null> {
  throw new MemoryError("schema_invalid", "recordIndex: not implemented (stage 1 stub)");
}

export async function reInjectProfile(
  _cfg: Config,
  messages: Array<{ role: string; content: string }>,
): Promise<Array<{ role: string; content: string }>> {
  throw new MemoryError("ingest_failed", "reInjectProfile: not implemented (stage 1 stub)");
}

export async function ingestUserLevel(
  _cfg: Config,
  _opts?: IngestOpts,
): Promise<IngestResult> {
  throw new MemoryError("ingest_failed", "ingestUserLevel: not implemented (stage 1 stub)");
}

export async function initProjectLevel(
  _cfg: Config,
  _cwd: string,
): Promise<void> {
  throw new MemoryError("permission_denied", "initProjectLevel: not implemented (stage 1 stub)");
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

export function sanitizeCwd(_cwd: string): string {
  throw new MemoryError("schema_invalid", "sanitizeCwd: not implemented (stage 1 stub)");
}

export function estimateProfile(_text: string): number {
  throw new MemoryError("schema_invalid", "estimateProfile: not implemented (stage 1 stub)");
}

/* ------------------------------------------------------------------ */
/* §7 schema 解析                                                       */
/* ------------------------------------------------------------------ */

export function parseIndexEntry(input: Record<string, unknown>): MemoryEntry {
  throw new MemoryError("schema_invalid", "parseIndexEntry: not implemented (stage 1 stub)");
}

/* ------------------------------------------------------------------ */
/* IngestEngine 注入点（§7.4 #2）                                       */
/* ------------------------------------------------------------------ */

/** 默认空 IngestEngine：调用即抛错，便于让实现期显式注入。 */
export const defaultIngestEngine: IngestEngine = {
  name: "stub-no-engine",
  async ingest(): Promise<IngestResult> {
    throw new MemoryError("ingest_failed", "no IngestEngine registered");
  },
};

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