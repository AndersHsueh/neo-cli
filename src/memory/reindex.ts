/**
 * /memory reindex 子命令实现（PRD docs/memory-prd.md 约束 48）。
 *
 * 当前为 stage 1 stub：签名齐备、运行时抛错。
 */

import type { Config } from "../config.ts";
import { MemoryError } from "./types.ts";

export async function reindex(
  _cfg: Config,
  _oldCwd: string,
  _newCwd: string,
): Promise<{ renamed: string[]; failed: string[] }> {
  throw new MemoryError("schema_invalid", "reindex: not implemented (stage 1 stub)");
}