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
import { dirname, join } from "node:path";
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
  return acquireLock(join(locksDir, key));
}

/**
 * 通用目录锁原语（v0.2 记忆激活，§7.5.7）。
 *
 * 关键修复：旧实现用 `mkdirSync(lockDir, {recursive:true})` —— Node 对已存在目录
 * **不抛 EEXIST**，互斥从未生效（探针实测两次 mkdir 均成功）。这里先递归建父目录，
 * 再对锁目录本身做**非递归** mkdir：EEXIST 才是「他方持锁」。
 */
export function acquireLock(lockDir: string): string {
  mkdirSync(dirname(lockDir), { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new MemoryError("raw_concurrent_modify", `锁已被持有：${lockDir}`, e);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new MemoryError("permission_denied", `锁目录无写权限：${lockDir}`, e);
    }
    throw e;
  }
  return lockDir;
}

/**
 * 尝试取锁；被占用时返回 null 而不是抛错（自动记忆路径用：跳过本轮，不打断会话）。
 *
 * staleMs：锁目录 mtime 超过该值视为残留（持锁进程崩溃/退出未释放），先删再抢。
 * 记忆提炼是后台任务，进程随时可能被 Ctrl+C / exit 杀掉，没有这层自愈就会
 * 永久卡死后续所有捕获（E2E 实测踩到过）。
 */
export function tryAcquireLock(lockDir: string, opts: { staleMs?: number } = {}): string | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return acquireLock(lockDir);
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      if (e.code === "permission_denied") return null;
      if (e.code !== "raw_concurrent_modify") throw e;
      const staleMs = opts.staleMs ?? 0;
      if (attempt === 0 && staleMs > 0 && isStaleLock(lockDir, staleMs)) {
        releaseLock(lockDir);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** 锁目录是否残留（mtime 早于 now - staleMs）。stat 失败视为不可判定（保守返回 false）。 */
export function isStaleLock(lockDir: string, staleMs: number): boolean {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

export function releaseLock(lockDir: string | null): void {
  if (!lockDir) return;
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // best-effort；残留下次入口扫过期锁清掉
  }
}

/** 带超时重试的加锁（跨进程写同一页时排队，而不是立刻失败）。 */
export async function withLock<T>(
  lockDir: string,
  fn: () => T | Promise<T>,
  opts: { timeoutMs?: number; retryMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const retryMs = opts.retryMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let waited = false;
  for (;;) {
    const lock = tryAcquireLock(lockDir);
    if (lock) {
      try {
        return await fn();
      } finally {
        releaseLock(lock);
      }
    }
    if (Date.now() >= deadline) {
      throw new MemoryError("raw_concurrent_modify", `等待锁超时：${lockDir}`);
    }
    waited = true;
    await new Promise((r) => setTimeout(r, retryMs));
  }
  // 保持 TS 的完整分支（deadline 分支必抛，这里不可达）
  void waited;
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