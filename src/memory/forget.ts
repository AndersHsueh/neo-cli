/**
 * /memory forget 子命令实现（PRD docs/memory-prd.md §A / 约束 52）。
 *
 * 当前为 stage 1 stub：签名齐备、运行时抛错。后续 commit 推 journal 机制。
 */

import type { Config } from "../config.ts";
import { MemoryError } from "./types.ts";

export async function forgetDryRun(
  _cfg: Config,
  _paths: string[],
): Promise<{ wouldDelete: string[]; reasonByPath: Record<string, string> }> {
  throw new MemoryError("permission_denied", "forgetDryRun: not implemented (stage 1 stub)");
}

export async function forgetYes(
  _cfg: Config,
  _paths: string[],
): Promise<{ deleted: string[]; skipped: string[] }> {
  throw new MemoryError("permission_denied", "forgetYes: not implemented (stage 1 stub)");
}

export async function forgetResume(
  _cfg: Config,
): Promise<{ completed: string[]; failed: string[] }> {
  throw new MemoryError("permission_denied", "forgetResume: not implemented (stage 1 stub)");
}