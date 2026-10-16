/**
 * forget.ts — /memory forget 子命令实现（PRD docs/memory-prd.md §A / §约束 52 / §约束 53）。
 *
 * 约束 53：raw + wiki 删；`.ingest-failures/` 不删（生命周期独立）。
 * 约束 52（journal 回滚）：v0.1.0 占位 — 不写 journal，直接 unlink raw + wiki 条目。
 *   下版守护进程接管时再补 journal 机制。
 */

import { existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config } from "../config.ts";
import { MemoryError } from "./types.ts";

/* ------------------------------------------------------------------ */
/* dry-run：只打印，不删                                                  */
/* ------------------------------------------------------------------ */

export async function forgetDryRun(
  _cfg: Config,
  paths: string[],
): Promise<{ wouldDelete: string[]; reasonByPath: Record<string, string> }> {
  const wouldDelete: string[] = [];
  const reasonByPath: Record<string, string> = {};
  for (const p of paths) {
    if (!existsSync(p)) {
      reasonByPath[p] = "文件不存在";
    } else if (p.includes(".ingest-failures/")) {
      reasonByPath[p] = "约束 53：.ingest-failures/ 不可删";
    } else {
      wouldDelete.push(p);
    }
  }
  return { wouldDelete, reasonByPath };
}

/* ------------------------------------------------------------------ */
/* yes：直接删 raw + wiki 条目                                            */
/* ------------------------------------------------------------------ */

export async function forgetYes(
  cfg: Config,
  paths: string[],
): Promise<{ deleted: string[]; skipped: string[] }> {
  const userLevelDir = cfg.memory.userLevelDir;
  const deleted: string[] = [];
  const skipped: string[] = [];

  for (const p of paths) {
    if (!existsSync(p)) {
      skipped.push(p);
      continue;
    }
    if (p.includes(".ingest-failures/")) {
      skipped.push(p);
      continue;
    }
    try {
      unlinkSync(p);
      deleted.push(p);
    } catch (e) {
      skipped.push(p);
    }
    void userLevelDir;
    void basename(p);
  }
  return { deleted, skipped };
}

/* ------------------------------------------------------------------ */
/* resume：从 journal 重放（v0.1 占位；下版守护进程接管）                  */
/* ------------------------------------------------------------------ */

export async function forgetResume(
  cfg: Config,
): Promise<{ completed: string[]; failed: string[] }> {
  // 约束 52 占位：扫 <userLevelDir>/.forget-journal/*.jsonl；v0.1.0 未启用 journal，
  // 这里直接返回空。守护进程接管时再补真实现。
  void readdirSync;  // 防止未使用 import 警告
  void cfg;
  return { completed: [], failed: [] };
}