/**
 * sessionName.ts — 会话代号的选择与默认编号分配（issue #82）。
 *
 * 规则（2026-11-14 拍板，取代 v0.3.1 的角色池随机）：
 *  - 显式 `--name` 最高优先级（撞名后缀交给 identity.pickUniqueName，如 Jacky-2）；
 *  - resume 有旧名 → 原样保留（历史 Matrix 角色名如 Trinity 不批量迁移）；
 *  - 否则分配默认名 `Neo#N`：单调递增、关闭后不回收；撞名时**再分配下一个号**，
 *    绝不给默认名加 `-2` 后缀（P2）。
 *
 * 默认编号落盘在信箱根目录的 `default-name-seq.json`（`{ "next": N }`），
 * 用非递归 mkdir 做跨进程独占锁（与 `.alive` 同风格），保证两个 neo 同时启动不重号。
 * 计数器丢失/损坏时按已知会话里最大的 `Neo#N` + 1 恢复，不向用户报错；
 * 但**写回预留失败**必须报错（`DefaultNameReservationError`）—— 不能把没落盘的号当成功发出。
 *
 * 锁协议（P2）：锁目录里写 `owner.json`（pid / starttime / token）。
 * 活持有者的锁绝不回收（SIGSTOP 的进程也算活）；死持有者用 rename 到唯一临时名再删，
 * 释放按身份（dev+ino+token）校验，绝不误删后继者的锁。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  createIdentity,
  isProcessAlive,
  listProfiles,
  runningTakenNames,
  type Identity,
} from "./mailbox/identity.ts";
import type { PeerProfile } from "./mailbox/types.ts";
import { writeJsonAtomic } from "./mailbox/state.ts";

/** 默认名计数器文件（信箱根目录下）。 */
export const DEFAULT_NAME_SEQ_FILE = "default-name-seq.json";
/** 默认名计数器的独占锁目录（`.` 开头，避免被 listProfiles / sweepSessions 扫到）。 */
const DEFAULT_NAME_LOCK_DIR = ".default-name-seq.lock";
/** 锁目录里的持有者身份文件。 */
const LOCK_OWNER_FILE = "owner.json";
/**
 * `owner.json` 缺失/损坏时的宽限期：持有者刚 mkdir 成功、还没写完 owner.json 的窗口。
 * 超过这个年龄仍是空的 → 视为崩溃残留，可回收。
 */
const OWNER_GRACE_MS = 1_000;
const LOCK_RETRY_MS = 5;
/** 死持有者回收失败（rename 撞车）后的退避。 */
const LOCK_RECLAIM_RETRY_MS = 2;
/**
 * 等待者自己第一次看到「无有效 owner」的时刻。
 * 不能只信锁目录 mtime：ext4 复用 inode 可能带上旧时间戳，
 * 刚 mkdir、还没写成 owner.json 的活锁会被误判为过期而偷走。
 */
const missingOwnerSince = new Map<string, number>();

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

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

/**
 * 默认名预留失败：计数器写不进去（权限 / 磁盘 / 路径被占）。
 *
 * 语义：**没有预留成功就不发号**。调用方必须把它当致命错误处理，
 * 不能吞掉后回落到别的名字 —— 否则下一个进程会发出同一个 `Neo#N`。
 */
export class DefaultNameReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefaultNameReservationError";
  }
}

function reservationError(root: string, cause: unknown): DefaultNameReservationError {
  const path = defaultNameSeqPath(root);
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new DefaultNameReservationError(
    `无法预留默认会话名：计数器 ${path} 写入失败（${detail}）。` +
      `请检查该路径的写权限与磁盘空间后重试。`,
  );
}

export function defaultNameSeqPath(root: string): string {
  return join(root, DEFAULT_NAME_SEQ_FILE);
}

function sleepSync(ms: number): void {
  // 启动路径上的短等待：用 Atomics.wait 同步睡，避免把同步 API 改成异步。
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/* ------------------------------------------------------------------ */
/* 锁协议：持有者身份                                                  */
/* ------------------------------------------------------------------ */

export interface DefaultNameLockOwner {
  pid: number;
  token: string;
  starttime?: string;
}

/** 一把已持有的默认名锁：release 时按 `dev + ino + token` 认身份。 */
export type DefaultNameLockHold = {
  root: string;
  token: string;
  dev: number;
  ino: number;
  pid: number;
};

export function defaultNameLockDir(root: string): string {
  return join(root, DEFAULT_NAME_LOCK_DIR);
}

function lockOwnerPath(root: string): string {
  return join(defaultNameLockDir(root), LOCK_OWNER_FILE);
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/** 解析 `/proc/<pid>/stat` 括号后的字段；失败返回 null。 */
function procStatFields(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm 字段可能含空格与括号，所以从**最后一个** ')' 之后切。
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    return fields.length > 0 ? fields : null;
  } catch {
    return null;
  }
}

/**
 * 进程启动时间（防 PID 复用）：`/proc/<pid>/stat` 括号后的第 20 个字段。
 * 非 Linux / 读不到 → undefined（退化为 kill(pid, 0)）。
 */
function processStartTime(pid: number): string | undefined {
  const fields = procStatFields(pid);
  // 括号后第 1 个字段是 state（总第 3 个），starttime 是总第 22 个 → 这里下标 19。
  const starttime = fields?.[19];
  return starttime && /^\d+$/.test(starttime) ? starttime : undefined;
}

/** 进程状态；`Z` = 僵尸（kill(0) 仍成功，但 finally 不会再跑，锁必须可回收）。 */
function processState(pid: number): string | undefined {
  const state = procStatFields(pid)?.[0];
  return state && /^[A-Za-z]$/.test(state) ? state : undefined;
}

/** 读锁目录的持有者身份；缺失/损坏 → null。 */
export function readDefaultNameLockOwner(root: string): DefaultNameLockOwner | null {
  try {
    const raw = JSON.parse(readFileSync(lockOwnerPath(root), "utf8")) as Partial<DefaultNameLockOwner>;
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    if (typeof raw.token !== "string" || raw.token === "") return null;
    const starttime = typeof raw.starttime === "string" ? raw.starttime : undefined;
    return starttime ? { pid: raw.pid, token: raw.token, starttime } : { pid: raw.pid, token: raw.token };
  } catch {
    return null;
  }
}

/**
 * 持有者是否仍活着。
 *
 *  - `kill(pid, 0)` 失败（ESRCH）→ 死；
 *  - 有 starttime 且与 /proc 当前值不一致 → PID 已被复用，原持有者已死；
 *  - SIGSTOP 的进程 kill(0) 仍成功、starttime 也不变 → 活的，锁不可回收。
 */
function ownerAlive(owner: DefaultNameLockOwner): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  // 僵尸：kill(0) 仍成功，但进程已结束、不会再执行 finally，必须允许回收。
  if (processState(owner.pid) === "Z") return false;
  if (!owner.starttime) return true;
  const current = processStartTime(owner.pid);
  // 读不到 /proc（非 Linux）时不能据此判死：保守视为活。
  if (current === undefined) return true;
  return current === owner.starttime;
}

/** `owner.json` 还没写出来的宽限期判定（看锁目录 mtime）。 */
function withinOwnerGrace(root: string, nowMs: number): boolean {
  try {
    return nowMs - statSync(defaultNameLockDir(root)).mtimeMs < OWNER_GRACE_MS;
  } catch {
    // 目录已消失：别人刚释放，直接重试即可（不算「仍在宽限期」）
    return false;
  }
}

/**
 * 回收一个死持有者的锁：`rename` 到唯一临时名再删。
 *
 * 不直接 `rmSync` 正在用的路径 —— 否则可能删掉后来者刚抢到的新锁。
 * rename 失败（目录已被别人回收/替换）返回 false，调用方重试整段 acquire。
 */
function reclaimDeadLock(
  root: string,
  check: { requireMissing?: boolean; expectedToken?: string } = {},
): boolean {
  // 回收前最后一眼：避免把刚 mkdir、尚未写完 owner.json 的活锁 rename 走。
  const current = readDefaultNameLockOwner(root);
  if (check.requireMissing) {
    if (current !== null) return false;
    if (withinOwnerGrace(root, Date.now())) return false;
  }
  if (check.expectedToken) {
    if (current === null || current.token !== check.expectedToken) return false;
    if (ownerAlive(current)) return false;
  }
  const dir = defaultNameLockDir(root);
  const tomb = `${dir}.reclaim.${randomToken()}`;
  try {
    renameSync(dir, tomb);
  } catch {
    return false;
  }
  try {
    rmSync(tomb, { recursive: true, force: true });
  } catch {
    // best-effort：临时名以 `.` 开头，不会被 listProfiles / sweepSessions 扫到
  }
  return true;
}

/**
 * 抢默认名锁。EEXIST 时：
 *  - 持有者仍活着 → 休眠重试，**绝不删锁**（活进程被 SIGSTOP 也算活）；
 *  - 持有者已死，或 owner.json 过了宽限期仍缺失/损坏 → 回收后重试；
 *  - 宽限期内的空 owner.json → 视为「正在写入」，继续等。
 */
export function acquireDefaultNameLock(root: string): DefaultNameLockHold {
  mkdirSync(root, { recursive: true });
  const dir = defaultNameLockDir(root);
  const token = randomToken();
  const pid = process.pid;
  for (;;) {
    try {
      mkdirSync(dir); // 非递归：EEXIST 才代表被持锁
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = readDefaultNameLockOwner(root);
      if (owner === null) {
        const now = Date.now();
        if (withinOwnerGrace(root, now)) {
          missingOwnerSince.delete(root);
          sleepSync(LOCK_RETRY_MS);
          continue;
        }
        const firstSeen = missingOwnerSince.get(root) ?? now;
        missingOwnerSince.set(root, firstSeen);
        // 必须由本进程连续观察满宽限期，才把「无 owner」当成崩溃残留。
        if (now - firstSeen < OWNER_GRACE_MS) {
          sleepSync(LOCK_RETRY_MS);
          continue;
        }
        missingOwnerSince.delete(root);
        if (!reclaimDeadLock(root, { requireMissing: true })) sleepSync(LOCK_RECLAIM_RETRY_MS);
        continue;
      }
      missingOwnerSince.delete(root);
      if (ownerAlive(owner)) {
        sleepSync(LOCK_RETRY_MS);
        continue;
      }
      if (!reclaimDeadLock(root, { expectedToken: owner.token })) sleepSync(LOCK_RECLAIM_RETRY_MS);
      continue;
    }

    // mkdir 成功：立刻记下 inode 并写 owner.json。
    // 若在写 owner 前目录被别人 rename 走（误回收或并发回收），路径会 ENOENT：
    // 这不是致命错误，必须重试，且不得 rmSync 当前路径（可能已是后继者的新锁）。
    let born: { dev: number; ino: number };
    try {
      const now = new Date();
      try { utimesSync(dir, now, now); } catch { /* 刷新 mtime，避免 inode 复用带上旧时间戳导致宽限期误判 */ }
      const st = statSync(dir);
      born = { dev: Number(st.dev), ino: Number(st.ino) };
    } catch {
      sleepSync(LOCK_RECLAIM_RETRY_MS);
      continue;
    }
    const starttime = processStartTime(pid);
    const owner: DefaultNameLockOwner = starttime ? { pid, token, starttime } : { pid, token };
    try {
      writeFileSync(lockOwnerPath(root), `${JSON.stringify({ ...owner, createdMs: Date.now() })}\n`, "utf8");
    } catch (e) {
      try {
        const st = statSync(dir);
        if (Number(st.dev) === born.dev && Number(st.ino) === born.ino) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // 目录已不在或已不是我们的：不要碰后继者
      }
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        sleepSync(LOCK_RECLAIM_RETRY_MS);
        continue;
      }
      throw e;
    }

    // 写完后再确认：目录仍是我们 mkdir 的那个 inode，且 owner.token 仍是我们的。
    // 若在 write 前被 rename，write 可能写进后继者新目录 —— 此时绝不能进入临界区。
    try {
      const st = statSync(dir);
      if (Number(st.dev) !== born.dev || Number(st.ino) !== born.ino) {
        sleepSync(LOCK_RECLAIM_RETRY_MS);
        continue;
      }
    } catch {
      sleepSync(LOCK_RECLAIM_RETRY_MS);
      continue;
    }
    const written = readDefaultNameLockOwner(root);
    if (written === null || written.token !== token) {
      sleepSync(LOCK_RECLAIM_RETRY_MS);
      continue;
    }
    missingOwnerSince.delete(root);
    return { root, token, dev: born.dev, ino: born.ino, pid };
  }
}

/**
 * 按身份释放锁：`dev + ino` 与 hold 一致 **且** `owner.json.token` 一致才释放。
 *
 * 任一条件不满足（锁已被回收、已被后继者重新取得）→ 直接返回，
 * 绝不删除别人的锁。释放同样走 rename 到唯一临时名再删。
 */
export function releaseDefaultNameLock(hold: DefaultNameLockHold): void {
  const dir = defaultNameLockDir(hold.root);
  try {
    const st = statSync(dir);
    if (Number(st.dev) !== hold.dev || Number(st.ino) !== hold.ino) return;
  } catch {
    return; // 目录已不在：无需释放
  }
  const owner = readDefaultNameLockOwner(hold.root);
  if (owner === null || owner.token !== hold.token) return;
  const tomb = `${dir}.released.${hold.token}.${randomToken()}`;
  try {
    renameSync(dir, tomb);
  } catch {
    return; // 抢不过后来者：不删任何路径
  }
  try {
    rmSync(tomb, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/* ------------------------------------------------------------------ */
/* 计数器                                                              */
/* ------------------------------------------------------------------ */

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

/**
 * 分配下一个默认名 `Neo#N`。
 *
 * 并发安全：临界区（读计数器 → 恢复 → 写回）由 `.default-name-seq.lock` 独占。
 * 计数器缺失或损坏时按 `maxKnownDefaultNumber(root) + 1` 恢复，不抛错；
 * 但**写回预留失败**抛 `DefaultNameReservationError` —— 没预留成功的号不得发出。
 */
export function allocateNextDefaultName(root: string): string {
  const hold = acquireDefaultNameLock(root);
  try {
    // 有效计数器是权威值；但它可能落后于实际已分配的名字（崩溃/手工改名），
    // 所以取 max(计数器, 已知最大 Neo#N + 1)：既保证单调，也保证不撞已有会话。
    const counter = readCounter(root);
    const next = Math.max(counter ?? 0, maxKnownDefaultNumber(root) + 1);
    try {
      writeJsonAtomic(defaultNameSeqPath(root), { next: next + 1 });
    } catch (e) {
      throw reservationError(root, e);
    }
    return `Neo#${next}`;
  } finally {
    releaseDefaultNameLock(hold);
  }
}

export interface AllocateUnusedOpts {
  /** 占用判定；缺省用 `runningTakenNames(root)`（运行中会话占用的名字）。 */
  isTaken?: (name: string) => boolean;
  deadAfterMs?: number;
  nowMs?: number;
  excludeSession?: string;
  excludeSessions?: string[];
}

/**
 * 分配一个**未被占用**的默认名：反复 `allocateNextDefaultName` 直到不撞名。
 *
 * 默认名撞名时再分配下一个号，绝不给默认名加 `-2` 后缀 ——
 * `Neo#1-2` 既不是合法默认名，也会让「编号单调递增」的承诺失效。
 */
export function allocateUnusedDefaultName(root: string, opts: AllocateUnusedOpts = {}): string {
  const isTaken =
    opts.isTaken ??
    ((name: string) =>
      runningTakenNames(root, {
        nowMs: opts.nowMs,
        deadAfterMs: opts.deadAfterMs,
        excludeSession: opts.excludeSession,
        excludeSessions: opts.excludeSessions,
      }).has(name));
  for (;;) {
    const name = allocateNextDefaultName(root);
    if (!isTaken(name)) return name;
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
  return { name: allocateUnusedDefaultName(root), source: "default" };
}

/* ------------------------------------------------------------------ */
/* 真实装配：openMailboxIdentity                                       */
/* ------------------------------------------------------------------ */

export interface OpenMailboxIdentityOpts {
  root: string;
  sessionId: string;
  cwd: string;
  mode?: PeerProfile["mode"];
  /** --name 显式指定。 */
  explicit?: string | null;
  /** resume 命中的旧 profile.name。 */
  previous?: string | null;
  deadAfterMs?: number;
  nowMs?: number;
  takeover?: boolean;
  excludeSessions?: string[];
  pid?: number;
  /**
   * 默认名分配后的竞态注入点（测试用）：**分配到名字之后、决定采用并 createIdentity 之前**调用。
   * 生产路径不传。
   */
  onAfterDefaultAllocate?: (name: string) => void;
}

export interface OpenMailboxIdentityResult {
  identity: Identity;
  chosen: ChosenName;
  /** 显式名被占用加了后缀时的原始名（只有 `--name` 会走这条路径）。 */
  suffixFrom?: string;
}

/**
 * 装配会话身份（bootstrap / /resume 的真实入口）。
 *
 *  - `--name`：`createIdentity({ applyUniqueSuffix: true })`，撞名加 `-2` 后缀，记 `suffixFrom`；
 *  - resume：保留旧名，仍走既有唯一后缀语义；
 *  - 默认：`allocateUnusedDefaultName` 拿号 → `onAfterDefaultAllocate` → 查占用 → 占用则再分配，
 *    最后 `createIdentity({ applyUniqueSuffix: false })`（撞名抛错，绝不写成 `Neo#1-2`）。
 */
export function openMailboxIdentity(opts: OpenMailboxIdentityOpts): OpenMailboxIdentityResult {
  const explicit = opts.explicit?.trim();
  const previous = opts.previous?.trim();
  const base = {
    root: opts.root,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    mode: opts.mode,
    deadAfterMs: opts.deadAfterMs,
    nowMs: opts.nowMs,
    takeover: opts.takeover,
    excludeSessions: opts.excludeSessions,
    pid: opts.pid,
  };

  if (explicit) {
    const identity = createIdentity({ ...base, name: explicit, applyUniqueSuffix: true });
    const chosen: ChosenName = { name: explicit, source: "explicit" };
    const finalName = identity.profile.name;
    return finalName && finalName !== explicit
      ? { identity, chosen, suffixFrom: explicit }
      : { identity, chosen };
  }

  if (previous) {
    const identity = createIdentity({ ...base, name: previous, applyUniqueSuffix: true });
    return { identity, chosen: { name: previous, source: "resume" } };
  }

  const isTaken = (name: string): boolean =>
    runningTakenNames(opts.root, {
      nowMs: opts.nowMs,
      deadAfterMs: opts.deadAfterMs,
      excludeSession: opts.sessionId,
      excludeSessions: opts.excludeSessions,
    }).has(name);
  const name = allocateUnusedDefaultName(opts.root, {
    isTaken: (candidate) => {
      opts.onAfterDefaultAllocate?.(candidate);
      return isTaken(candidate);
    },
    deadAfterMs: opts.deadAfterMs,
    nowMs: opts.nowMs,
    excludeSession: opts.sessionId,
    excludeSessions: opts.excludeSessions,
  });
  const identity = createIdentity({ ...base, name, applyUniqueSuffix: false });
  return { identity, chosen: { name, source: "default" } };
}
