/**
 * sessionName.ts — 会话代号的选择与默认编号分配（issue #82）。
 *
 * 规则（2026-11-14 拍板，取代 v0.3.1 的角色池随机）：
 *  - 显式 `--name` 最高优先级（撞名后缀交给 identity.pickUniqueName，如 Jacky-2）；
 *  - resume 有旧名 → 原样保留（历史 Matrix 角色名如 Trinity 不批量迁移）；
 *  - 否则分配默认名 `Neo#N`：单调递增、关闭后不回收。
 *
 * 默认编号落盘在信箱根目录的 `default-name-seq.json`（`{ "next": N }`），
 * 用非递归 mkdir 做跨进程独占锁（与 `.alive` 同风格），保证两个 neo 同时启动不重号。
 * 计数器丢失/损坏时按已知会话里最大的 `Neo#N` + 1 恢复，不向用户报错。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { listProfiles } from "./mailbox/identity.ts";
import { writeJsonAtomic } from "./mailbox/state.ts";

/** 默认名计数器文件（信箱根目录下）。 */
export const DEFAULT_NAME_SEQ_FILE = "default-name-seq.json";
/** 默认名计数器的独占锁目录（`.` 开头，避免被 listProfiles / sweepSessions 扫到）。 */
const DEFAULT_NAME_LOCK_DIR = ".default-name-seq.lock";
/** 锁目录超过这个年龄视为崩溃残留。临界区只有几个文件操作，正常远小于此值。 */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 5;

/** 默认名格式：`Neo#1`、`Neo#42`（精确匹配，`Trinity` / `Neo#01` / `neo#1` 都不算）。 */
const DEFAULT_NAME_RE = /^Neo#([1-9]\d*)$/;

export interface ChooseNameInput {
  /** --name 显式指定。 */
  explicit?: string | null;
  /** resume 命中的旧 profile.name。 */
  previous?: string | null;
  /** 信箱根目录；缺省时无法分配默认编号（返回 null）。 */
  root?: string | null;
}

export interface ChosenName {
  name: string;
  source: "explicit" | "resume" | "default";
}

export function defaultNameSeqPath(root: string): string {
  return join(root, DEFAULT_NAME_SEQ_FILE);
}

function sleepSync(ms: number): void {
  // 启动路径上的短等待：用 Atomics.wait 同步睡，避免把同步 API 改成异步。
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/** 已知会话里最大的 `Neo#N`；没有则 0。含已关闭（无 `.alive`）的会话。 */
function maxKnownDefaultNumber(root: string): number {
  let max = 0;
  for (const p of listProfiles(root)) {
    const m = DEFAULT_NAME_RE.exec(p.name ?? "");
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max;
}

/** 读计数器；缺失/损坏/非法（非正整数）→ null（交给恢复逻辑）。 */
function readCounter(root: string): number | null {
  const path = defaultNameSeqPath(root);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const next = (parsed as { next?: unknown }).next;
    if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1) return null;
    return next;
  } catch {
    return null;
  }
}

/** 抢锁目录；EEXIST 时重试，过旧（崩溃残留）则清理后重试。拿不到锁绝不分配。 */
function acquireLock(lockDir: string): void {
  for (;;) {
    try {
      mkdirSync(lockDir); // 非递归：EEXIST 才代表被持锁
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch {
      // 锁刚被别人释放：直接重试
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

/**
 * 分配下一个默认名 `Neo#N`。
 *
 * 并发安全：临界区（读计数器 → 恢复 → 写回）由 `.default-name-seq.lock` 独占。
 * 计数器缺失或损坏时按 `maxKnownDefaultNumber(root) + 1` 恢复，不抛错。
 */
export function allocateNextDefaultName(root: string): string {
  mkdirSync(root, { recursive: true });
  const lockDir = join(root, DEFAULT_NAME_LOCK_DIR);
  acquireLock(lockDir);
  try {
    // 有效计数器是权威值；但它可能落后于实际已分配的名字（崩溃/手工改名），
    // 所以取 max(计数器, 已知最大 Neo#N + 1)：既保证单调，也保证不撞已有会话。
    const counter = readCounter(root);
    const next = Math.max(counter ?? 0, maxKnownDefaultNumber(root) + 1);
    try {
      writeJsonAtomic(defaultNameSeqPath(root), { next: next + 1 });
    } catch {
      // 写不进去也不阻塞启动：本次仍给号（下次会按已知最大号恢复）
    }
    return `Neo#${next}`;
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // best-effort：残留锁由 stale 判定清理
    }
  }
}

/**
 * 选择会话名：显式 > resume 旧名 > 默认 `Neo#N`。
 * 显式名与 resume 旧名都不消耗默认编号；无 root 且走到默认分支时返回 null。
 */
export function chooseSessionName(input: ChooseNameInput): ChosenName | null {
  const explicit = input.explicit?.trim();
  if (explicit) return { name: explicit, source: "explicit" };
  const previous = input.previous?.trim();
  if (previous) return { name: previous, source: "resume" };
  const root = input.root?.trim();
  if (!root) return null;
  return { name: allocateNextDefaultName(root), source: "default" };
}
