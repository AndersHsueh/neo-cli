/**
 * mailbox/identity.ts — 会话身份、`.alive` 锁、名字、TTL 清理与 peer 观察。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2 §4.1 / §4.9 / §4.10。
 *
 * 关键设计：
 *  - 目录名 = 当前 session-id；名字只是显示与寻址别名。
 *  - `.alive` 用非递归 mkdir 做独占锁（EEXIST = 已有活进程），退出时删除；
 *    崩溃残留由 TTL / stale 接管清理。
 *  - 心跳看 state.json 的 mtime（state 每 15s 原子重写一次）。
 *  - 死会话不补投未读消息：TTL 到点整目录删除。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";

import {
  DEAD_AFTER_MS,
  MailboxError,
  PROGRESS_TIMEOUT_MS,
  SESSION_TTL_MS,
  aliveDir,
  heldDir,
  inboxDir,
  profilePath,
  sessionDir,
  statePath,
  type MailboxConfig,
  type PeerObservation,
  type PeerProfile,
  type SessionState,
} from "./types.ts";
import {
  deriveEffective,
  initialState,
  isoNow,
  mutateState,
  readJsonOrNull,
  readState,
  writeJsonAtomic,
  writeState,
} from "./state.ts";

/* ------------------------------------------------------------------ */
/* 布局                                                                */
/* ------------------------------------------------------------------ */

/** 建立 session 目录骨架（幂等）。 */
export function ensureSessionLayout(root: string, sessionId: string): void {
  mkdirSync(sessionDir(root, sessionId), { recursive: true });
  mkdirSync(inboxDir(root, sessionId), { recursive: true });
  mkdirSync(heldDir(root, sessionId), { recursive: true });
}

export function sessionExists(root: string, sessionId: string): boolean {
  return existsSync(sessionDir(root, sessionId));
}

/* ------------------------------------------------------------------ */
/* profile                                                             */
/* ------------------------------------------------------------------ */

export function readProfile(root: string, sessionId: string): PeerProfile | null {
  const p = readJsonOrNull<PeerProfile>(profilePath(root, sessionId));
  if (!p || p.version !== 1 || p.session !== sessionId) return null;
  if (typeof p.cwd !== "string" || typeof p.mode !== "string") return null;
  return p;
}

export function writeProfile(root: string, profile: PeerProfile): void {
  writeJsonAtomic(profilePath(root, profile.session), profile);
}

/** 扫描根目录下所有可解析的 profile（不含 . 开头的目录）。 */
export function listProfiles(root: string): PeerProfile[] {
  if (!existsSync(root)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: PeerProfile[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const p = readProfile(root, e.name);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.started_at.localeCompare(b.started_at));
  return out;
}

/* ------------------------------------------------------------------ */
/* .alive 锁                                                           */
/* ------------------------------------------------------------------ */

export function isAlive(root: string, sessionId: string): boolean {
  return existsSync(aliveDir(root, sessionId));
}

/**
 * 心跳年龄（ms）。优先看 state.json mtime（15s 心跳重写），
 * 缺失时看 profile.json；两者都没有 → Infinity。
 */
export function heartbeatAgeMs(root: string, sessionId: string, nowMs: number = Date.now()): number {
  for (const p of [statePath(root, sessionId), profilePath(root, sessionId)]) {
    if (!existsSync(p)) continue;
    try {
      return Math.max(0, nowMs - statSync(p).mtimeMs);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  return Number.POSITIVE_INFINITY;
}

export type SessionLiveness = "running" | "dead";

export interface LivenessOpts {
  nowMs?: number;
  deadAfterMs?: number;
  pidAlive?: (pid: number) => boolean;
}

/**
 * 会话是否「运行中」。
 *
 * 规则（2026-10-26 用户裁决）：
 *  - running = .alive 存在 且 profile.pid 存活 且 心跳年龄 <= deadAfterMs（默认 120s）；
 *  - pid 已死 / 心跳 >120s（事件循环卡死/机器休眠）/ 无 profile → dead，可立刻恢复并清残留锁。
 * 注意：心跳是独立 15s tick，长 turn 不会让它变旧；>120s 说明进程已经不可响应。
 */
export function sessionLiveness(root: string, sessionId: string, opts: LivenessOpts = {}): SessionLiveness {
  if (!sessionExists(root, sessionId)) return "dead";
  if (!isAlive(root, sessionId)) return "dead";
  const profile = readProfile(root, sessionId);
  if (!profile) return "dead";
  const nowMs = opts.nowMs ?? Date.now();
  const deadAfterMs = opts.deadAfterMs ?? DEAD_AFTER_MS;
  const age = heartbeatAgeMs(root, sessionId, nowMs);
  const pidAlive = (opts.pidAlive ?? isProcessAlive)(profile.pid);
  return pidAlive && age <= deadAfterMs ? "running" : "dead";
}

export interface AcquireAliveOpts {
  /** 心跳超过 deadAfterMs 时是否允许回收残留锁。 */
  takeover?: boolean;
  deadAfterMs?: number;
  nowMs?: number;
  /** 进程存活判定注入（测试用；默认 process.kill(pid,0)）。 */
  pidAlive?: (pid: number) => boolean;
}

/**
 * 取 `.alive` 独占锁。EEXIST：
 *  - takeover=false（默认）→ 抛 session_alive；
 *  - takeover=true 且心跳超时 → 视为崩溃残留，先删后建；
 *  - takeover=true 但心跳新鲜 → 仍抛 session_alive（同一 id 不允许双活）。
 */
export function acquireAlive(root: string, sessionId: string, opts: AcquireAliveOpts = {}): void {
  ensureSessionLayout(root, sessionId);
  const dir = aliveDir(root, sessionId);
  const tryMkdir = (): void => {
    mkdirSync(dir); // 非递归：父目录已在，EEXIST 才代表被持锁
  };
  try {
    tryMkdir();
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw new MailboxError("io_error", `创建 .alive 锁失败：${dir}（${(e as Error).message}）`, { cause: e });
    }
  }

  if (!opts.takeover) {
    throw new MailboxError("session_alive", `会话 ${sessionId} 已有活进程（.alive 存在）`);
  }
  const nowMs = opts.nowMs ?? Date.now();
  const deadAfterMs = opts.deadAfterMs ?? DEAD_AFTER_MS;
  // pid 已不存在 = 崩溃残留：立刻回收，不必等心跳超时（用户裁决 2026-10-26）。
  const profile = readProfile(root, sessionId);
  const pidAlive = opts.pidAlive ?? isProcessAlive;
  if (profile && !pidAlive(profile.pid)) {
    rmSync(dir, { recursive: true, force: true });
    tryMkdir();
    return;
  }
  const age = heartbeatAgeMs(root, sessionId, nowMs);
  if (age <= deadAfterMs) {
    throw new MailboxError(
      "session_alive",
      `会话 ${sessionId} 的 .alive 残留但心跳仍新鲜（${Math.round(age / 1000)}s），拒绝双开`,
    );
  }
  rmSync(dir, { recursive: true, force: true });
  tryMkdir();
}

export function releaseAlive(root: string, sessionId: string): void {
  try {
    rmSync(aliveDir(root, sessionId), { recursive: true, force: true });
  } catch {
    // best-effort：残留锁由 takeover/TTL 清理
  }
}

/* ------------------------------------------------------------------ */
/* 名字                                                                */
/* ------------------------------------------------------------------ */

function normalizeName(name: string): string {
  const n = name.trim();
  if (n === "") throw new MailboxError("invalid_target", "名字不能为空");
  if (/[/\\\u0000-\u001f]/.test(n)) throw new MailboxError("invalid_target", `名字含非法字符：${name}`);
  return n;
}

/** 撞名自动加后缀 -2、-3…（只扫存活会话；dead 名字可复用）。 */
export function pickUniqueName(root: string, base: string, opts: { nowMs?: number; excludeSession?: string } = {}): string {
  const wanted = normalizeName(base);
  const nowMs = opts.nowMs ?? Date.now();
  const taken = new Set<string>();
  for (const p of listProfiles(root)) {
    if (opts.excludeSession && p.session === opts.excludeSession) continue;
    if (!isAlive(root, p.session)) continue;
    if (p.name) taken.add(p.name);
  }
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${wanted}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new MailboxError("invalid_target", `名字 ${wanted} 的候选后缀已用尽`);
}

/* ------------------------------------------------------------------ */
/* 创建 / 重命名 / resume 改键                                          */
/* ------------------------------------------------------------------ */

export interface CreateIdentityOpts {
  root: string;
  sessionId: string;
  cwd: string;
  mode?: PeerProfile["mode"];
  name?: string | null;
  pid?: number;
  nowMs?: number;
  takeover?: boolean;
  deadAfterMs?: number;
}

export interface Identity {
  profile: PeerProfile;
  state: SessionState;
}

/**
 * 启动时创建身份：目录 + profile + 初始 state + `.alive` 锁。
 * 已存在 profile/state 时保留（同一 session 被 resume 的场景），只更新 mode/name。
 */
export function createIdentity(opts: CreateIdentityOpts): Identity {
  const nowMs = opts.nowMs ?? Date.now();
  ensureSessionLayout(opts.root, opts.sessionId);
  const old = readProfile(opts.root, opts.sessionId);
  const wantedName = opts.name ? pickUniqueName(opts.root, opts.name, { nowMs }) : (old?.name ?? null);
  const nowIso = isoNow(nowMs);

  const profile: PeerProfile = {
    version: 1,
    session: opts.sessionId,
    name: wantedName,
    cwd: opts.cwd,
    mode: opts.mode ?? old?.mode ?? "ask",
    pid: opts.pid ?? process.pid,
    started_at: old?.started_at ?? nowIso,
    updated_at: nowIso,
  };
  writeProfile(opts.root, profile);

  acquireAlive(opts.root, opts.sessionId, {
    takeover: opts.takeover ?? true,
    deadAfterMs: opts.deadAfterMs,
    nowMs,
  });

  let state = readState(opts.root, opts.sessionId);
  if (!state) {
    state = initialState(opts.sessionId, { name: wantedName, mode: profile.mode, nowMs });
    writeState(opts.root, state);
  } else {
    mutateState(opts.root, opts.sessionId, (s) => {
      s.name = wantedName;
      s.mode = profile.mode;
      s.heartbeat_at = nowIso;
    }, nowMs);
  }
  return { profile, state: readState(opts.root, opts.sessionId) ?? state };
}

/** /rename：只改显示名，不动目录与 session-id。 */
export function renameSession(root: string, sessionId: string, name: string, nowMs: number = Date.now()): PeerProfile {
  const profile = readProfile(root, sessionId);
  if (!profile) throw new MailboxError("not_found", `会话 ${sessionId} 的 profile 不存在`);
  const unique = pickUniqueName(root, name, { nowMs, excludeSession: sessionId });
  profile.name = unique;
  profile.updated_at = isoNow(nowMs);
  writeProfile(root, profile);
  mutateState(root, sessionId, (s) => {
    s.name = unique;
  }, nowMs);
  return profile;
}

/**
 * 交互 /resume 切换 session-id 时的信箱改键：
 * 目录、profile、state 内的 session 字段一起迁移，保证「身份 = 当前 session-id」。
 */
export function rekeySession(
  root: string,
  oldSessionId: string,
  newSessionId: string,
  nowMs: number = Date.now(),
): PeerProfile {
  if (oldSessionId === newSessionId) {
    const p = readProfile(root, oldSessionId);
    if (!p) throw new MailboxError("not_found", `会话 ${oldSessionId} 的 profile 不存在`);
    return p;
  }
  if (!sessionExists(root, oldSessionId)) {
    if (sessionExists(root, newSessionId)) {
      const p = readProfile(root, newSessionId);
      if (!p) throw new MailboxError("invalid_state", `会话 ${newSessionId} 的 profile 损坏`);
      return p;
    }
    throw new MailboxError("not_found", `当前信箱 ${oldSessionId} 不存在，无法改键`);
  }
  if (sessionExists(root, newSessionId)) {
    if (isAlive(root, newSessionId)) {
      throw new MailboxError("resume_conflict", `目标 session-id ${newSessionId} 仍有活进程，拒绝改键`);
    }
    // 目标会话已 dead：按「进程没了就没了」裁决接管其信箱（旧未读一起丢弃）。
    rmSync(sessionDir(root, newSessionId), { recursive: true, force: true });
  }
  // 必须在 rename 之前读：readState/readProfile 会校验 path 上的 session-id。
  const profile = readProfile(root, oldSessionId);
  const state = readState(root, oldSessionId);
  renameSync(sessionDir(root, oldSessionId), sessionDir(root, newSessionId));

  if (!profile) throw new MailboxError("invalid_state", `改键前 profile 丢失：${oldSessionId}`);
  profile.session = newSessionId;
  profile.updated_at = isoNow(nowMs);
  writeProfile(root, profile);
  if (state) {
    state.session = newSessionId;
    writeState(root, state);
    mutateState(root, newSessionId, (s) => {
      s.heartbeat_at = isoNow(nowMs);
    }, nowMs);
  }
  return profile;
}

/* ------------------------------------------------------------------ */
/* TTL 清理 / peer 观察                                                */
/* ------------------------------------------------------------------ */

export interface SweepOpts {
  nowMs?: number;
  ttlMs?: number;
}

/**
 * 清理死会话目录：非 alive 且最近 mtime 超过 ttl。
 * 「进程没了就没了」——不保留未读，整目录删（§4.9 裁决）。
 */
export function sweepSessions(root: string, opts: SweepOpts = {}): string[] {
  if (!existsSync(root)) return [];
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? SESSION_TTL_MS;
  const removed: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (isAlive(root, e.name)) continue;
    // 以 state.json 的 mtime 作为最后活动时间（心跳会持续刷新）；缺失时退回 profile。
    const newest = (() => {
      for (const p of [statePath(root, e.name), profilePath(root, e.name)]) {
        if (!existsSync(p)) continue;
        try {
          return statSync(p).mtimeMs;
        } catch {
          // 继续尝试下一个
        }
      }
      try {
        return statSync(sessionDir(root, e.name)).mtimeMs;
      } catch {
        return nowMs;
      }
    })();
    if (nowMs - newest > ttlMs) {
      rmSync(sessionDir(root, e.name), { recursive: true, force: true });
      removed.push(e.name);
    }
  }
  return removed;
}

function inboxMessageIds(root: string, sessionId: string): Set<string> {
  const ids = new Set<string>();
  for (const dir of [inboxDir(root, sessionId), heldDir(root, sessionId)]) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith("msg-") && f.endsWith(".json")) ids.add(f.slice(0, -".json".length));
      }
    } catch {
      // ignore
    }
  }
  return ids;
}

export interface ObserveOpts {
  nowMs?: number;
  cfg: Pick<MailboxConfig, "deadAfterMs" | "staleAfterMs">;
}

/** profile.pid 对应进程是否仍存在。ESRCH=不存在；EPERM=存在但无权限（视为活）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 单个 peer 的只读观察快照（不存在也返回 exists:false，供 watchdog 判 dead）。 */
export function observePeer(root: string, sessionId: string, opts: ObserveOpts): PeerObservation {
  const nowMs = opts.nowMs ?? Date.now();
  const exists = sessionExists(root, sessionId);
  const profile = exists ? readProfile(root, sessionId) : null;
  const state = exists ? readState(root, sessionId) : null;
  const alive = exists && isAlive(root, sessionId);
  const pidAlive = isProcessAlive(profile?.pid ?? 0);
  const derived = deriveEffective(state, { alive, nowMs, cfg: opts.cfg });
  // 心跳超时但进程仍活着（长 turn / event loop 卡顿）→ 降级为 stale，
  // 避免 watchdog 把「正在干活的活进程」误报成 dead。
  const effective = derived.effective === "dead" && alive && pidAlive ? "stale" : derived.effective;
  return {
    session: sessionId,
    name: profile?.name ?? state?.name ?? null,
    cwd: profile?.cwd ?? "",
    mode: profile?.mode ?? state?.mode ?? "ask",
    exists,
    alive,
    pid_alive: pidAlive,
    effective,
    state,
    inbox_message_ids: exists ? inboxMessageIds(root, sessionId) : new Set<string>(),
  };
}

/** 所有 peer（含自己）的观察快照，key = session id。 */
export function observeAllPeers(root: string, opts: ObserveOpts): Map<string, PeerObservation> {
  const out = new Map<string, PeerObservation>();
  for (const p of listProfiles(root)) {
    out.set(p.session, observePeer(root, p.session, opts));
  }
  return out;
}

/** 供进度判定使用的默认值（避免 identity 依赖 store 配置）。 */
export const DEFAULT_PROGRESS_TIMEOUT = PROGRESS_TIMEOUT_MS;
export const DEFAULT_HEARTBEAT_DEAD_AFTER = DEAD_AFTER_MS;
