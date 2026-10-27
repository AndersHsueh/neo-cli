/**
 * mailbox/types.ts — 跨会话消息的类型、常量与路径（叶子模块，无 IO）。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2
 *  - §4.1 磁盘布局与会话身份
 *  - §4.2 消息信封 schema（含 2026-10-20 裁决的 reply_to / exec 元数据）
 *  - §4.10 会话状态机与委派台账
 *
 * 本模块不 import 任何 src/ 下的其他模块，也不做文件读写；
 * state/identity/store 依次建立在它之上。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const ENVELOPE_VERSION = 1 as const;
export const STATE_VERSION = 1 as const;

/** 单条消息正文上限（字符）。发送端拒绝，超限不产生任何文件。 */
export const BODY_MAX_CHARS = 100_000;
/** 接收端 inbox 上限；超过时丢最旧。 */
export const INBOX_MAX_MESSAGES = 50;
/** 发送端重复洪峰窗口：与上一条发往同一目标的 body 全同且间隔小于此值 → 拒绝。 */
export const DUPLICATE_WINDOW_MS = 5_000;

/** 心跳与存活判定（2026-10-20 裁决：120s 无心跳判死）。 */
export const HEARTBEAT_MS = 15_000;
export const STALE_AFTER_MS = 30_000;
export const DEAD_AFTER_MS = 120_000;
/** 工作中无进展判 stuck（容忍长工具，如全量测试）。 */
export const PROGRESS_TIMEOUT_MS = 300_000;
/** 委派 watchdog 检查间隔。 */
export const WATCHDOG_INTERVAL_S = 120;
/** 连续自动 turn 上限（每会话独立计数）。 */
export const AUTO_TURN_LIMIT = 20;
/** 死会话目录 TTL 清理。 */
export const SESSION_TTL_MS = 30 * 60_000;
/** 委派台账 / 入站回执的条目上限。 */
export const DELEGATION_MAX = 200;
export const RECEIPT_MAX = 200;

/* ------------------------------------------------------------------ */
/* 基础类型                                                            */
/* ------------------------------------------------------------------ */

/**
 * 权限模式。与 src/agent.ts 的 PermissionMode 结构完全一致；
 * 这里重复声明是为了让 mailbox 层不依赖 agent.ts（避免循环依赖）。
 */
export type PermissionMode = "ask" | "auto-edit" | "auto-all" | "plan";

export type InboundPolicy = "accept" | "hold" | "refuse";

export type SessionPhase = "starting" | "idle" | "working" | "waiting_input" | "exiting";

/** 查询方根据 state + `.alive` + 心跳派生出的有效状态。 */
export type EffectiveState = "alive" | "stale" | "dead";

export type TurnOutcome = "ok" | "aborted" | "error";
export type AbortSource = "human" | "signal" | "error" | null;

/** 状态通知类型（只有这四类会通知；waiting_on_peers/healthy/blocked 不通知）。 */
export type WatchdogKind = "dead" | "idle_no_reply" | "stuck" | "undelivered";

/** watchdog 完整判定结果（含不通知的中间态，便于测试与调试）。 */
export type WatchdogVerdict =
  | WatchdogKind
  | "waiting_on_peers"
  | "healthy"
  | "blocked";

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

export interface MailboxConfig {
  heartbeatMs: number;
  staleAfterMs: number;
  deadAfterMs: number;
  progressTimeoutMs: number;
  watchdogIntervalS: number;
  autoTurnLimit: number;
  inboxMax: number;
  bodyMaxChars: number;
  duplicateWindowMs: number;
  sessionTtlMs: number;
  delegationMax: number;
  receiptMax: number;
}

export const DEFAULT_MAILBOX_CONFIG: MailboxConfig = {
  heartbeatMs: HEARTBEAT_MS,
  staleAfterMs: STALE_AFTER_MS,
  deadAfterMs: DEAD_AFTER_MS,
  progressTimeoutMs: PROGRESS_TIMEOUT_MS,
  watchdogIntervalS: WATCHDOG_INTERVAL_S,
  autoTurnLimit: AUTO_TURN_LIMIT,
  inboxMax: INBOX_MAX_MESSAGES,
  bodyMaxChars: BODY_MAX_CHARS,
  duplicateWindowMs: DUPLICATE_WINDOW_MS,
  sessionTtlMs: SESSION_TTL_MS,
  delegationMax: DELEGATION_MAX,
  receiptMax: RECEIPT_MAX,
};

export function resolveMailboxConfig(overrides: Partial<MailboxConfig> = {}): MailboxConfig {
  return { ...DEFAULT_MAILBOX_CONFIG, ...overrides };
}

/* ------------------------------------------------------------------ */
/* 身份 / 状态 / 信封                                                  */
/* ------------------------------------------------------------------ */

export interface PeerProfile {
  version: 1;
  session: string;
  /** 显示与寻址别名；未 /rename 时为 null。 */
  name: string | null;
  cwd: string;
  mode: PermissionMode;
  pid: number;
  started_at: string;
  updated_at: string;
}

/** 信封里发送方快照（不是完整 profile）。 */
export interface SessionRef {
  session: string;
  name: string | null;
  cwd: string;
  mode: PermissionMode;
}

/** 回信的执行窗口（2026-10-20 裁决；宿主计算，模型不自己报时）。 */
export interface ExecMeta {
  started_at: string;
  ended_at: string;
  ms: number;
}

/** 纯文本信封。body 是唯一载荷；reply_to/exec 只是关联与计时元数据。 */
export interface Envelope {
  v: 1;
  id: string;
  from: SessionRef;
  to: string;
  created_at: string;
  reply_to?: string;
  exec?: ExecMeta;
  body: string;
}

export interface MessageRefMeta {
  from: string;
  message_id: string;
  at: string;
}

export interface LastOutbound {
  to: string;
  message_id: string;
  at: string;
}

/** 本会话作为发起方、已发出未回信的委派摘要（state.json 的 outstanding）。 */
export interface OutstandingDelegation {
  message_id: string;
  target_id: string;
  target_name: string | null;
  sent_at: string;
}

export interface TurnInfo {
  seq: number;
  source: "user" | "mailbox";
  /** mailbox turn 的触发者 session id；user turn 为 null。 */
  from: string | null;
  started_at: string;
}

export interface LastTurn {
  seq: number;
  ended_at: string;
  outcome: TurnOutcome;
  abort_source: AbortSource;
}

/**
 * 会话目标锚（2026-10-26）。
 *
 * 为什么需要：`isStuck` 判的是 `last_progress_at`，而跑偏的会话每一步都在
 * touchProgress（DNS 解析成功、拿到 IP 都是真实进展）——心跳满格、方向全错。
 * 进度信号 ≠ 方向信号，这里补的是后者。
 *
 * **模型只读**：目标只由用户 /goal 或宿主写入。漂移的第一步就是模型把
 * 「找出作者」重述成「拿到答案」再重述成「打通外部连接」；目标若可写，
 * 一定会被重述。目标必须是外部事实，不是模型自述。
 */
export interface SessionGoal {
  /** 原始目标原文，不截断（回锚提示要用完整表述）。 */
  text: string;
  set_at: string;
  set_by: "user" | "host";
}

export interface SessionState {
  version: 1;
  session: string;
  name: string | null;
  mode: PermissionMode;
  phase: SessionPhase;
  since: string;
  heartbeat_at: string;
  last_progress_at: string;
  turn: TurnInfo | null;
  last_turn: LastTurn | null;
  last_inbound: MessageRefMeta | null;
  last_outbound: LastOutbound | null;
  outstanding: OutstandingDelegation[];
  last_human_input_at: string | null;
  queue_depth: number;
  /** 目标锚（2026-10-26）。旧 state 无此字段 → 视为 null，不判 state 非法。 */
  goal?: SessionGoal | null;
}

/* ------------------------------------------------------------------ */
/* 委派台账 / 入站回执                                                 */
/* ------------------------------------------------------------------ */

export interface Delegation {
  id: string;
  message_id: string;
  target_id: string;
  target_name: string | null;
  /** 正文前 120 字符，只用于告警提示与人工辨别，不存全文。 */
  body_preview: string;
  sent_at: string;
  status: "outstanding" | "replied";
  replied_at: string | null;
  /** 已发过的异常类型，跃迁去重。 */
  notified: WatchdogKind[];
}

/** 收到一条消息时的回执：用于发回信时自动计算 exec 时长。 */
export interface Receipt {
  message_id: string;
  from: string;
  received_at: string;
}

/* ------------------------------------------------------------------ */
/* 状态查询 / watchdog 输入输出                                        */
/* ------------------------------------------------------------------ */

/** 对某个 peer 的只读观察快照（由 identity/store 层收集，吃纯函数判定）。 */
export interface PeerObservation {
  session: string;
  name: string | null;
  cwd: string;
  mode: PermissionMode;
  exists: boolean;
  alive: boolean;
  /** profile.pid 对应进程是否仍存在（watchdog 误报 dead 的第二道保险）。 */
  pid_alive: boolean;
  effective: EffectiveState;
  state: SessionState | null;
  /** 该 peer 的 inbox / .held 里仍存在的消息 id（判断 undelivered 用）。 */
  inbox_message_ids: ReadonlySet<string>;
}

export interface WatchdogNotice {
  kind: WatchdogKind;
  delegation_id: string;
  message_id: string;
  target_id: string;
  target_name: string | null;
  body_preview: string;
  detail: string;
}

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

export type MailboxErrorCode =
  | "invalid_target" // 找不到目标
  | "ambiguous_target" // 名字/id 片段多匹配
  | "target_dead" // 目标存在但进程已死 / 无 .alive
  | "self_target" // 发给自己
  | "queue_full" // 对方 inbox ≥ 50
  | "duplicate" // 重复洪峰
  | "body_too_large"
  | "empty_body"
  | "not_found" // 消息 / held 条目不存在
  | "session_alive" // .alive 已存在
  | "resume_conflict" // resume 改键时目标目录已存在
  | "invalid_envelope"
  | "invalid_state"
  | "io_error";

export class MailboxError extends Error {
  readonly code: MailboxErrorCode;
  readonly candidates?: string[];
  readonly cause?: unknown;
  constructor(code: MailboxErrorCode, message: string, opts: { candidates?: string[]; cause?: unknown } = {}) {
    super(message);
    this.code = code;
    this.candidates = opts.candidates;
    this.cause = opts.cause;
    this.name = "MailboxError";
  }
}

/* ------------------------------------------------------------------ */
/* 磁盘布局                                                            */
/* ------------------------------------------------------------------ */

/**
 * 信箱根目录。测试注入惯例与 NEO_SESSIONS_DIR 一致：NEO_MAILBOX_DIR 覆盖默认。
 * 默认与 sessions 同级：~/.neo/mailbox。
 */
export function mailboxRoot(): string {
  const env = process.env["NEO_MAILBOX_DIR"];
  if (env) return env;
  return join(homedir(), ".neo", "mailbox");
}

export function sessionDir(root: string, sessionId: string): string {
  return join(root, sessionId);
}

export function profilePath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "profile.json");
}

export function statePath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "state.json");
}

export function delegationsPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "delegations.json");
}

export function receiptsPath(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "receipts.json");
}

export function inboxDir(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), "inbox");
}

export function heldDir(root: string, sessionId: string): string {
  return join(inboxDir(root, sessionId), ".held");
}

export function aliveDir(root: string, sessionId: string): string {
  return join(sessionDir(root, sessionId), ".alive");
}

/** `.alive` 锁的 owner 元数据（pid/时间）；用于并发抢锁时识别「刚启动还没写 profile」的持有者。 */
export function aliveOwnerPath(root: string, sessionId: string): string {
  return join(aliveDir(root, sessionId), "owner.json");
}

export function messagePath(root: string, sessionId: string, messageId: string): string {
  return join(inboxDir(root, sessionId), `${messageId}.json`);
}

export function heldMessagePath(root: string, sessionId: string, messageId: string): string {
  return join(heldDir(root, sessionId), `${messageId}.json`);
}
