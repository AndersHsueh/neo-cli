/**
 * locks.ts — 锁原语（PRD docs/memory-prd.md 约束 9a）。
 *
 * 提供两件事：
 *   1. acquireCwdLock — 同 cwd 并发写互斥（J1）
 *   2. scanExpiredLocks + unlink 残留 — 启动 / recordIndex 入口自愈（J4 / 约束 9a-d）
 *
 * 锁键：sha256(sanitized_cwd)[:16]，与 PRD §约束 9a 一致。
 */

import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MemoryError } from "./types.ts";

/* ------------------------------------------------------------------ */
/* 锁键                                                                  */
/* ------------------------------------------------------------------ */

export function cwdLockKey(sanitizedCwd: string): string {
  return createHash("sha256").update(sanitizedCwd, "utf8").digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* acquireCwdLock                                                        */
/* ------------------------------------------------------------------ */

/**
 * 取 cwd 锁：mkdir `<userLevelDir>/.locks/<key>` 持锁。
 * 失败语义：
 *   - mkdir EEXIST → 持锁方为他人（或自身持有） → throw raw_concurrent_modify
 *   - mkdir 其他 errno → throw 同 code 错误
 *   - mkdir 成功 → 返回锁目录路径；调用方负责 release（rmSync）
 */
export function acquireCwdLock(userLevelDir: string, sanitizedCwd: string): string {
  const locksDir = join(userLevelDir, ".locks");
  const key = cwdLockKey(sanitizedCwd);
  const lockDir = join(locksDir, key);
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new MemoryError("raw_concurrent_modify", `cwd 锁已被持有：${lockDir}`, e);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new MemoryError("permission_denied", `cwd 锁目录无写权限：${lockDir}`, e);
    }
    throw e;
  }
  return lockDir;
}

export function releaseCwdLock(lockDir: string): void {
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // best-effort；残留下次 recordIndex 入口扫过期锁清掉（J4）
  }
}

/* ------------------------------------------------------------------ */
/* scanExpiredLocks — 约束 9a-d 残留锁自愈                                  */
/* ------------------------------------------------------------------ */

/**
 * 扫 `<userLevelDir>/.locks/` 下 mtime ≥ ttlHours 的锁目录，返回路径列表。
 * 不删；调用方按需 unlink。
 */
export function scanExpiredLocks(userLevelDir: string, ttlHours: number = 24): string[] {
  const locksDir = join(userLevelDir, ".locks");
  let entries: string[];
  try {
    entries = readdirSync(locksDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - ttlHours * 3600 * 1000;
  const expired: string[] = [];
  for (const name of entries) {
    const full = join(locksDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.mtimeMs >= cutoff) continue;
    expired.push(full);
  }
  return expired;
}

/**
 * 扫过期锁并 unlink；调用方在 recordIndex 入口调用。
 * mtime 通过 utimesSync 模拟「旧锁」用于测试。
 */
export function reapExpiredLocks(userLevelDir: string, ttlHours: number = 24): number {
  const paths = scanExpiredLocks(userLevelDir, ttlHours);
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  return paths.length;
}

/* ------------------------------------------------------------------ */
/* 工具（测试用）                                                         */
/* ------------------------------------------------------------------ */

/** 强制把某锁目录的 mtime 改成「现在 - ttlHours * 3600s」，用于测试。 */
export function ageLock(lockDir: string, ttlHours: number): void {
  const mtime = new Date(Date.now() - ttlHours * 3600 * 1000);
  utimesSync(lockDir, mtime, mtime);
}