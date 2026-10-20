/**
 * mailbox/state.ts — 会话状态机、委派台账、入站回执的读写与纯判定。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2 §4.9 / §4.10。
 *
 * 分两层：
 *  - IO 层：原子读写 state.json / delegations.json / receipts.json，状态转移入口；
 *  - 纯函数层：effective state 派生、watchdog 判定、台账匹配（测试不需要真等 2 分钟）。
 *
 * 单写者假设：每个 session 只有一个进程写自己的 state/台账；
 * 查询方只读。写入统一 tmp + rename。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  DELEGATION_MAX,
  RECEIPT_MAX,
  STATE_VERSION,
  delegationsPath,
  receiptsPath,
  statePath,
  type AbortSource,
  type Delegation,
  type EffectiveState,
  type MailboxConfig,
  type OutstandingDelegation,
  type PeerObservation,
  type Receipt,
  type SessionPhase,
  type SessionState,
  type TurnOutcome,
  type WatchdogKind,
  type WatchdogNotice,
  type WatchdogVerdict,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* 时间与 JSON 工具                                                    */
/* ------------------------------------------------------------------ */

export function isoNow(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function isoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** 原子写 JSON（tmp + rename）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort：tmp 残留不影响正确性
    }
    throw e;
  }
}

/** 读 JSON；不存在 / 损坏 / 非对象 → null（查询路径不得因单个坏文件崩溃）。 */
export function readJsonOrNull<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* SessionState                                                        */
/* ------------------------------------------------------------------ */

export function initialState(
  sessionId: string,
  opts: { name?: string | null; mode?: SessionState["mode"]; nowMs?: number } = {},
): SessionState {
  const now = isoNow(opts.nowMs);
  return {
    version: STATE_VERSION,
    session: sessionId,
    name: opts.name ?? null,
    mode: opts.mode ?? "ask",
    phase: "idle",
    since: now,
    heartbeat_at: now,
    last_progress_at: now,
    turn: null,
    last_turn: null,
    last_inbound: null,
    last_outbound: null,
    outstanding: [],
    last_human_input_at: null,
    queue_depth: 0,
  };
}

/** 读 state；不存在 / 版本不符 / 必要字段缺失 → null。 */
export function readState(root: string, sessionId: string): SessionState | null {
  const s = readJsonOrNull<SessionState>(statePath(root, sessionId));
  if (!s || s.version !== STATE_VERSION || s.session !== sessionId) return null;
  if (typeof s.phase !== "string" || !Array.isArray(s.outstanding)) return null;
  return s;
}

export function writeState(root: string, state: SessionState): void {
  writeJsonAtomic(statePath(root, state.session), state);
}

/** 读-改-写。单写者假设下无需锁；返回更新后的 state。 */
export function mutateState(
  root: string,
  sessionId: string,
  fn: (state: SessionState) => void,
  nowMs: number = Date.now(),
): SessionState {
  const state = readState(root, sessionId) ?? initialState(sessionId, { nowMs });
  fn(state);
  state.version = STATE_VERSION;
  state.session = sessionId;
  writeState(root, state);
  return state;
}

/** 心跳：只刷 heartbeat_at（15s tick 调用）。 */
export function touchHeartbeat(root: string, sessionId: string, nowMs: number = Date.now()): SessionState {
  return mutateState(root, sessionId, (s) => {
    s.heartbeat_at = isoNow(nowMs);
  }, nowMs);
}

/** 进度：工具结果回填 / turn 开始时刷 last_progress_at。 */
export function touchProgress(root: string, sessionId: string, nowMs: number = Date.now()): SessionState {
  return mutateState(root, sessionId, (s) => {
    s.last_progress_at = isoNow(nowMs);
    s.heartbeat_at = isoNow(nowMs);
  }, nowMs);
}

export function setPhase(
  root: string,
  sessionId: string,
  phase: SessionPhase,
  nowMs: number = Date.now(),
): SessionState {
  return mutateState(root, sessionId, (s) => {
    if (s.phase !== phase) s.since = isoNow(nowMs);
    s.phase = phase;
    s.heartbeat_at = isoNow(nowMs);
  }, nowMs);
}

/** turn 开始：phase=working，记录触发来源（user / mailbox + from）。 */
export function beginTurn(
  root: string,
  sessionId: string,
  info: { seq: number; source: "user" | "mailbox"; from?: string | null },
  nowMs: number = Date.now(),
): SessionState {
  return mutateState(root, sessionId, (s) => {
    s.phase = "working";
    s.since = isoNow(nowMs);
    s.heartbeat_at = isoNow(nowMs);
    s.last_progress_at = isoNow(nowMs);
    s.turn = {
      seq: info.seq,
      source: info.source,
      from: info.from ?? null,
      started_at: isoNow(nowMs),
    };
  }, nowMs);
}

/** turn 结束：phase=idle，写 last_turn。ESC 叫停时 outcome=aborted, abort_source=human。 */
export function endTurn(
  root: string,
  sessionId: string,
  info: { outcome: TurnOutcome; abortSource?: AbortSource },
  nowMs: number = Date.now(),
): SessionState {
  return mutateState(root, sessionId, (s) => {
    const seq = s.turn?.seq ?? 0;
    s.phase = "idle";
    s.since = isoNow(nowMs);
    s.heartbeat_at = isoNow(nowMs);
    s.last_progress_at = isoNow(nowMs);
    s.last_turn = {
      seq,
      ended_at: isoNow(nowMs),
      outcome: info.outcome,
      abort_source: info.abortSource ?? null,
    };
    s.turn = null;
  }, nowMs);
}

export function noteHumanInput(root: string, sessionId: string, nowMs: number = Date.now()): SessionState {
  return mutateState(root, sessionId, (s) => {
    s.last_human_input_at = isoNow(nowMs);
    s.heartbeat_at = isoNow(nowMs);
  }, nowMs);
}

export function noteOutbound(
  root: string,
  sessionId: string,
  out: { to: string; message_id: string },
  nowMs: number = Date.now(),
): SessionState {
  return mutateState(root, sessionId, (s) => {
    s.last_outbound = { to: out.to, message_id: out.message_id, at: isoNow(nowMs) };
    s.heartbeat_at = isoNow(nowMs);
  }, nowMs);
}

export function noteInbound(
  root: string,
  sessionId: string,
  inbound: { from: string; message_id: string },
  nowMs: number = Date.now(),
): SessionState {
  return mutateState(root, sessionId, (s) => {
    s.last_inbound = { from: inbound.from, message_id: inbound.message_id, at: isoNow(nowMs) };
    s.heartbeat_at = isoNow(nowMs);
  }, nowMs);
}

export function setNameInState(root: string, sessionId: string, name: string | null, nowMs: number = Date.now()): SessionState {
  return mutateState(root, sessionId, (s) => {
    s.name = name;
  }, nowMs);
}

/* ------------------------------------------------------------------ */
/* 有效状态派生（纯函数）                                              */
/* ------------------------------------------------------------------ */

export interface EffectiveOpts {
  alive: boolean;
  nowMs: number;
  cfg: Pick<MailboxConfig, "deadAfterMs" | "staleAfterMs">;
}

/** 查询方派生有效状态：dead / stale / alive。 */
export function deriveEffective(
  state: SessionState | null,
  opts: EffectiveOpts,
): { effective: EffectiveState; heartbeat_age_ms: number } {
  if (!opts.alive) return { effective: "dead", heartbeat_age_ms: Number.POSITIVE_INFINITY };
  // 没有 state 文件但 .alive 在：无法判定心跳，按 alive 处理（进程刚启动尚未写 state 的短窗口）。
  const hb = isoMs(state?.heartbeat_at);
  if (hb === null) return { effective: "alive", heartbeat_age_ms: 0 };
  const age = Math.max(0, opts.nowMs - hb);
  if (age > opts.cfg.deadAfterMs) return { effective: "dead", heartbeat_age_ms: age };
  if (age > opts.cfg.staleAfterMs) return { effective: "stale", heartbeat_age_ms: age };
  return { effective: "alive", heartbeat_age_ms: age };
}

/** 工作中且进度超时 → stuck。waiting_input 不算（人在处理）。 */
export function isStuck(state: SessionState | null, nowMs: number, cfg: Pick<MailboxConfig, "progressTimeoutMs">): boolean {
  if (!state || state.phase !== "working") return false;
  const progress = isoMs(state.last_progress_at);
  if (progress === null) return false;
  return nowMs - progress > cfg.progressTimeoutMs;
}

/* ------------------------------------------------------------------ */
/* 入站回执（用于回信时自动计算 exec）                                 */
/* ------------------------------------------------------------------ */

export function readReceipts(root: string, sessionId: string): Receipt[] {
  const list = readJsonOrNull<Receipt[]>(receiptsPath(root, sessionId));
  return Array.isArray(list) ? list.filter(isReceipt) : [];
}

function isReceipt(r: unknown): r is Receipt {
  if (typeof r !== "object" || r === null) return false;
  const x = r as Partial<Receipt>;
  return typeof x.message_id === "string" && typeof x.from === "string" && typeof x.received_at === "string";
}

/** 记录收到的一条消息；同一 message_id 只记一次。 */
export function recordReceipt(root: string, sessionId: string, receipt: Receipt, max = RECEIPT_MAX): void {
  const list = readReceipts(root, sessionId);
  if (list.some((r) => r.message_id === receipt.message_id)) return;
  list.push(receipt);
  while (list.length > max) list.shift();
  writeJsonAtomic(receiptsPath(root, sessionId), list);
}

export function findReceipt(root: string, sessionId: string, messageId: string): Receipt | null {
  return readReceipts(root, sessionId).find((r) => r.message_id === messageId) ?? null;
}

/* ------------------------------------------------------------------ */
/* 委派台账                                                            */
/* ------------------------------------------------------------------ */

export function readDelegations(root: string, sessionId: string): Delegation[] {
  const list = readJsonOrNull<Delegation[]>(delegationsPath(root, sessionId));
  return Array.isArray(list) ? list.filter(isDelegation) : [];
}

function isDelegation(d: unknown): d is Delegation {
  if (typeof d !== "object" || d === null) return false;
  const x = d as Partial<Delegation>;
  return (
    typeof x.id === "string" &&
    typeof x.message_id === "string" &&
    typeof x.target_id === "string" &&
    typeof x.sent_at === "string" &&
    (x.status === "outstanding" || x.status === "replied") &&
    Array.isArray(x.notified)
  );
}

function toOutstanding(d: Delegation): OutstandingDelegation {
  return {
    message_id: d.message_id,
    target_id: d.target_id,
    target_name: d.target_name,
    sent_at: d.sent_at,
  };
}

/** 台账 + state.outstanding 同步写（state 是查询投影，delegations 是真相）。 */
function writeDelegationsAndProjection(
  root: string,
  sessionId: string,
  list: Delegation[],
  nowMs: number,
): void {
  writeJsonAtomic(delegationsPath(root, sessionId), list);
  try {
    mutateState(root, sessionId, (s) => {
      s.outstanding = list.filter((d) => d.status === "outstanding").map(toOutstanding);
    }, nowMs);
  } catch {
    // 状态文件写失败不影响台账；查询方读 delegations 也能工作
  }
}

/** 追加一条待回信委派。回复类消息（reply_to 命中他人）默认不进来。 */
export function appendDelegation(
  root: string,
  sessionId: string,
  d: Omit<Delegation, "id" | "status" | "replied_at" | "notified">,
  opts: { max?: number; nowMs?: number } = {},
): Delegation {
  const list = readDelegations(root, sessionId);
  const entry: Delegation = {
    ...d,
    id: `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "outstanding",
    replied_at: null,
    notified: [],
  };
  list.push(entry);
  const max = opts.max ?? DELEGATION_MAX;
  while (list.length > max) {
    // 先淘汰最旧的已回信条目，再淘汰最旧条目（避免长期会话无限增长）
    const repliedIdx = list.findIndex((x) => x.status === "replied");
    list.splice(repliedIdx >= 0 ? repliedIdx : 0, 1);
  }
  writeDelegationsAndProjection(root, sessionId, list, opts.nowMs ?? Date.now());
  return entry;
}

export interface ResolveResult {
  resolved: Delegation[];
  changed: boolean;
}

/**
 * 收到回信时消账：优先 reply_to 精确匹配；没有则退回「同一 target 最早未回」。
 * 匹配原则见 PRD §4.10.4。
 */
export function resolveDelegation(
  root: string,
  sessionId: string,
  info: { reply_to?: string | null; from: string },
  opts: { nowMs?: number } = {},
): ResolveResult {
  const list = readDelegations(root, sessionId);
  const nowMs = opts.nowMs ?? Date.now();
  const resolved: Delegation[] = [];

  if (info.reply_to) {
    const hit = list.find((d) => d.message_id === info.reply_to && d.status === "outstanding");
    if (hit) {
      hit.status = "replied";
      hit.replied_at = isoNow(nowMs);
      resolved.push(hit);
    }
  }
  if (resolved.length === 0) {
    const fallback = list.find((d) => d.target_id === info.from && d.status === "outstanding");
    if (fallback) {
      fallback.status = "replied";
      fallback.replied_at = isoNow(nowMs);
      resolved.push(fallback);
    }
  }

  if (resolved.length === 0) return { resolved, changed: false };
  writeDelegationsAndProjection(root, sessionId, list, nowMs);
  return { resolved, changed: true };
}

/** 标记某异常已通知（跃迁去重）。 */
export function markDelegationNotified(
  root: string,
  sessionId: string,
  delegationId: string,
  kind: WatchdogKind,
  nowMs: number = Date.now(),
): void {
  const list = readDelegations(root, sessionId);
  const hit = list.find((d) => d.id === delegationId);
  if (!hit || hit.notified.includes(kind)) return;
  hit.notified.push(kind);
  writeDelegationsAndProjection(root, sessionId, list, nowMs);
}

/** 异常消失 / 恢复时清空 notified，让下次异常能再次通知。 */
export function clearDelegationNotified(
  root: string,
  sessionId: string,
  delegationId: string,
  nowMs: number = Date.now(),
): void {
  const list = readDelegations(root, sessionId);
  const hit = list.find((d) => d.id === delegationId);
  if (!hit || hit.notified.length === 0) return;
  hit.notified = [];
  writeDelegationsAndProjection(root, sessionId, list, nowMs);
}

/** 清理已回信超过 24h 的条目。 */
export function pruneDelegations(
  root: string,
  sessionId: string,
  nowMs: number = Date.now(),
  retentionMs = 24 * 3600_000,
): void {
  const list = readDelegations(root, sessionId);
  const kept = list.filter((d) => {
    if (d.status !== "replied") return true;
    const repliedAt = isoMs(d.replied_at);
    return repliedAt === null || nowMs - repliedAt <= retentionMs;
  });
  if (kept.length === list.length) return;
  writeDelegationsAndProjection(root, sessionId, kept, nowMs);
}

/* ------------------------------------------------------------------ */
/* watchdog 判定（纯函数）                                             */
/* ------------------------------------------------------------------ */

/**
 * 对每条 outstanding 委派给出判定。判定顺序与 PRD §4.10.4 表格一致：
 * dead > undelivered > waiting_on_peers > idle_no_reply > healthy > stuck > blocked。
 * 只有 WatchdogKind 会进入通知；其余是中间态（便于测试/调试）。
 *
 * selfSession 是「发起方」的 session id：idle_no_reply 要判断 peer 最近收到的
 * 消息是否来自发起方、以及 peer 是否回过发起方。
 */
export function classifyDelegations(
  selfSession: string,
  delegations: readonly Delegation[],
  observations: ReadonlyMap<string, PeerObservation>,
  nowMs: number,
  cfg: Pick<MailboxConfig, "progressTimeoutMs">,
): { delegation: Delegation; verdict: WatchdogVerdict }[] {
  const out: { delegation: Delegation; verdict: WatchdogVerdict }[] = [];
  for (const d of delegations) {
    if (d.status !== "outstanding") continue;
    out.push({ delegation: d, verdict: classifyOne(selfSession, d, observations.get(d.target_id), nowMs, cfg) });
  }
  return out;
}

function classifyOne(
  selfSession: string,
  d: Delegation,
  obs: PeerObservation | undefined,
  nowMs: number,
  cfg: Pick<MailboxConfig, "progressTimeoutMs">,
): WatchdogVerdict {
  if (!obs || !obs.exists) return "dead";
  if (!obs.alive) return "dead";
  // 心跳超时但进程仍在（长 turn / event loop 卡顿）不算 dead；继续按 phase 判。
  if (obs.effective === "dead" && !obs.pid_alive) return "dead";
  if (obs.inbox_message_ids.has(d.message_id)) return "undelivered";

  const st = obs.state;
  if (!st) return "healthy"; // 活着但还没写 state：不误报
  if (st.phase === "idle" && st.outstanding.length > 0) return "waiting_on_peers";
  if (st.phase === "idle") {
    const sentAt = isoMs(d.sent_at);
    const inboundAt = isoMs(st.last_inbound?.at);
    const outboundAt = isoMs(st.last_outbound?.at);
    const lastHumanAt = isoMs(st.last_human_input_at);
    const gotOurTask =
      st.last_inbound?.from === selfSession && sentAt !== null && inboundAt !== null && inboundAt >= sentAt;
    const repliedToUs =
      st.last_outbound?.to === selfSession && sentAt !== null && outboundAt !== null && outboundAt >= sentAt;
    const humanTook = sentAt !== null && lastHumanAt !== null && lastHumanAt >= sentAt;
    if (gotOurTask && !repliedToUs && !humanTook) return "idle_no_reply";
    return "healthy";
  }
  if (st.phase === "working") {
    const progress = isoMs(st.last_progress_at);
    if (progress !== null && nowMs - progress > cfg.progressTimeoutMs) return "stuck";
    return "healthy";
  }
  if (st.phase === "waiting_input") return "blocked";
  if (st.phase === "exiting") return "dead";
  return "healthy";
}
