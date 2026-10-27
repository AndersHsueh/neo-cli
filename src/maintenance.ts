/**
 * 运行时垃圾清理（v0.4.1 B5）。
 *
 * 两类只增不减的目录：
 *  - `<cwd>/.neo/tmp/tool-*.txt`：B4 的超长工具输出落盘；
 *  - `<root>/<session-id>/`：mailbox 里已死会话的目录（心跳文件 mtime 为最后活动）。
 *
 * 只清「明显过期」的：默认 7 天。删目录前校验 session-id 形状与真实目录，
 * 绝不递归删用户工作目录。
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CleanupOptions {
  /** 超过该年龄才删（默认 7 天）。 */
  maxAgeMs?: number;
  now?: number;
}

export interface CleanupResult {
  removedTmpFiles: number;
  removedMailboxDirs: string[];
  freedBytes: number;
  errors: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const SESSION_ID_RE = /^\d{8}-\d{6}-[a-z0-9]+$/;

function ageOf(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** 清 .neo/tmp 下过期文件；返回删除数/释放字节。 */
export function cleanupTmpDir(
  cwd: string,
  opts: CleanupOptions = {},
): { removed: number; freedBytes: number; errors: string[] } {
  const maxAge = opts.maxAgeMs ?? 7 * DAY;
  const now = opts.now ?? Date.now();
  const dir = join(cwd, ".neo", "tmp");
  let removed = 0;
  let freedBytes = 0;
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed, freedBytes, errors };
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const age = ageOf(p, now);
    if (age === null || age < maxAge) continue;
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(p, { force: true });
      removed += 1;
      freedBytes += size;
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { removed, freedBytes, errors };
}

/** 清 mailbox 下过期（默认 7 天无心跳）的会话目录。 */
export function cleanupMailboxDirs(
  root: string,
  opts: CleanupOptions = {},
): { removed: string[]; errors: string[] } {
  const maxAge = opts.maxAgeMs ?? 7 * DAY;
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { removed, errors };
  }
  for (const name of entries) {
    if (!SESSION_ID_RE.test(name)) continue;
    const dir = join(root, name);
    // 以 state.json（15s 心跳）mtime 为准；缺失时退回 profile/目录本身。
    const state = join(dir, "state.json");
    const profile = join(dir, "profile.json");
    let age = ageOf(state, now);
    if (age === null) age = ageOf(profile, now);
    if (age === null) age = ageOf(dir, now);
    if (age === null || age < maxAge) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { removed, errors };
}

/** 启动时统一清理（交互模式调用；失败静默）。 */
export function cleanupRuntime(
  cwd: string,
  mailboxRootPath: string,
  opts: CleanupOptions = {},
): CleanupResult {
  const tmp = cleanupTmpDir(cwd, opts);
  const mb = cleanupMailboxDirs(mailboxRootPath, opts);
  return {
    removedTmpFiles: tmp.removed,
    removedMailboxDirs: mb.removed,
    freedBytes: tmp.freedBytes,
    errors: [...tmp.errors, ...mb.errors],
  };
}
