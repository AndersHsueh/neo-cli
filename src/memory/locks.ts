/**
 * locks.ts — 记忆写入的互斥锁原语（v0.2 记忆激活 §7.5.7）。
 *
 * 只提供通用目录锁：先递归建父目录，再对锁目录本身做**非递归** mkdir。
 * 这是刻意为之：旧实现用 `mkdirSync(lockDir,{recursive:true})`，Node 对已存在目录
 * 不抛 EEXIST，互斥从未生效（v0.2 探针实测两次 mkdir 均成功）。
 *
 * EEXIST 才表示「他方持锁」。持锁方崩溃留下的残留锁由 staleMs 自愈。
 */
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryError } from "./types.ts";

/** 取锁（严格）：被占用抛 MemoryError(raw_concurrent_modify)。 */
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
 * 永久卡死后续所有捕获（真实 E2E 踩到过）。
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

/** 锁目录是否残留（mtime 早于 now - staleMs）。stat 失败视为不可判定（保守 false）。 */
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
    // best-effort：残留锁由下一次 tryAcquireLock 的 staleMs 自愈
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
    await new Promise((r) => setTimeout(r, retryMs));
  }
}
