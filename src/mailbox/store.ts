/**
 * mailbox/store.ts — 文件信箱的收发、限流、hold/release、peer 列表与 watchdog 编排。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2
 *  - §4.3 发送路径（target 解析 / 限流 / 去重 / 不排队不缓存）
 *  - §4.4 接收路径（poll 即消费，at-most-once）
 *  - §4.7 接收端防环闸门
 *  - §4.10 状态机投影、委派台账、watchdog 通知
 *
 * 设计：store 只做 IO 与编排；状态判定、台账匹配等纯逻辑在 state.ts，
 * 时间通过 opts.now 注入，测试不需要真等。
 */
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  INBOX_MAX_MESSAGES,
  MailboxError,
  heldDir,
  heldMessagePath,
  inboxDir,
  mailboxRoot,
  messagePath,
  resolveMailboxConfig,
  type Delegation,
  type EffectiveState,
  type Envelope,
  type ExecMeta,
  type MailboxConfig,
  type PeerObservation,
  type PeerProfile,
  type SessionState,
  type WatchdogKind,
  type WatchdogNotice,
} from "./types.ts";
import * as identity from "./identity.ts";
import * as st from "./state.ts";

export interface MailboxOptions {
  /** 根目录；缺省 NEO_MAILBOX_DIR / ~/.neo/mailbox。 */
  root?: string;
  sessionId: string;
  config?: Partial<MailboxConfig>;
  /** 时间注入（毫秒）；缺省 Date.now。 */
  now?: () => number;
}

export interface SendOptions {
  /** 回信时填被回复消息的 id（任务号）。 */
  reply_to?: string;
  /** 显式执行窗口；缺省由 receipts 自动计算。 */
  exec?: ExecMeta;
  /**
   * 是否登记为「等待回信」的委派。缺省：非回信（无 reply_to）= true。
   * 纯通知类消息可显式传 false，避免 watchdog 误判对方不回信。
   */
  expect_reply?: boolean;
}

export interface PeerInfo {
  session: string;
  name: string | null;
  cwd: string;
  mode: PeerProfile["mode"];
  alive: boolean;
  effective: EffectiveState;
  heartbeat_age_ms: number;
  state: SessionState | null;
  is_self: boolean;
}

export interface WatchdogOptions {
  nowMs?: number;
}

export class Mailbox {
  readonly root: string;
  /** 当前 session-id（交互 /resume 改键时会变；只认当前 session-id）。 */
  sessionId: string;
  readonly cfg: MailboxConfig;
  private readonly now: () => number;
  /** 上一条已投递消息（跨 poll 调用保留，用于完全重复去重）。 */
  private lastDelivered: { from: string; body: string } | null = null;
  /** 发送端重复洪峰窗口：target → 上一条 body / 时间。 */
  private readonly lastSent = new Map<string, { body: string; at: number }>();

  constructor(opts: MailboxOptions) {
    this.root = opts.root ?? mailboxRoot();
    this.sessionId = opts.sessionId;
    this.cfg = resolveMailboxConfig(opts.config);
    this.now = opts.now ?? (() => Date.now());
  }

  /* ---------------------------------------------------------------- */
  /* 身份                                                              */
  /* ---------------------------------------------------------------- */

  profile(): PeerProfile {
    const p = identity.readProfile(this.root, this.sessionId);
    if (!p) throw new MailboxError("invalid_state", `会话 ${this.sessionId} 的 profile 不存在`);
    return p;
  }

  /** 同步当前权限模式到 profile/state（/mode 切换后调用）。 */
  setMode(mode: PeerProfile["mode"]): void {
    const p = identity.readProfile(this.root, this.sessionId);
    if (!p) throw new MailboxError("invalid_state", `会话 ${this.sessionId} 的 profile 不存在`);
    p.mode = mode;
    p.updated_at = st.isoNow(this.now());
    identity.writeProfile(this.root, p);
    st.mutateState(this.root, this.sessionId, (s) => {
      s.mode = mode;
    }, this.now());
  }

  /**
   * 交互 /resume 切换 session-id 时迁移信箱身份：
   * 目录 / profile / state / `.alive` 一起改键，随后本实例改用新 id。
   * 目标 id 的信箱若仍有活进程则拒绝；dead 则按裁决接管（未读丢弃）。
   */
  rekey(newSessionId: string): PeerProfile {
    const profile = identity.rekeySession(this.root, this.sessionId, newSessionId, this.now());
    this.sessionId = newSessionId;
    this.lastDelivered = null;
    this.lastSent.clear();
    return profile;
  }

  /**
   * 接管一个已死会话的信箱身份（交互 /resume 用）：
   *  - 目标运行中 → 拒绝（resume_conflict）；
   *  - 保留目标的 name / inbox / outstanding，更新 pid/mode；
   *  - 当前身份退役（释放 .alive、清空名字），避免同名占用/寻址歧义；
   *  - 最后把 sessionId 切到目标。
   */
  adopt(newSessionId: string): PeerProfile {
    if (newSessionId === this.sessionId) return this.profile();
    if (identity.sessionLiveness(this.root, newSessionId, {
      nowMs: this.now(),
      deadAfterMs: this.cfg.deadAfterMs,
    }) === "running") {
      throw new MailboxError("resume_conflict", `会话 ${newSessionId} 正在另一个进程中运行，不能恢复`);
    }
    const cur = this.sessionId;
    const curProfile = identity.readProfile(this.root, cur);
    // 先接管目标（失败则当前身份原样保留）
    identity.createIdentity({
      root: this.root,
      sessionId: newSessionId,
      cwd: curProfile?.cwd ?? process.cwd(),
      mode: curProfile?.mode,
      name: null, // null = 保留目标旧名字（createIdentity 的 old?.name 路径）
      nowMs: this.now(),
    });
    // 当前身份退役：释放锁 + 清名（profile/state 都清，避免 observePeer 走 state.name）
    identity.releaseAlive(this.root, cur);
    if (curProfile) {
      curProfile.name = null;
      curProfile.updated_at = st.isoNow(this.now());
      identity.writeProfile(this.root, curProfile);
    }
    st.mutateState(this.root, cur, (s) => {
      s.name = null;
    }, this.now());
    this.sessionId = newSessionId;
    this.lastDelivered = null;
    this.lastSent.clear();
    return this.profile();
  }

  state(): SessionState | null {
    return st.readState(this.root, this.sessionId);
  }

  /* ---------------------------------------------------------------- */
  /* 发送                                                              */
  /* ---------------------------------------------------------------- */

  send(target: string, body: string, opts: SendOptions = {}): Envelope {
    this.validateBody(body);
    const nowMs = this.now();
    const peer = this.resolvePeer(target, { requireAlive: true });
    if (peer.session === this.sessionId) {
      throw new MailboxError("self_target", "不能给当前会话自己发消息（会形成无意义的自环）");
    }
    if (this.inboxDepthOf(peer.session) >= INBOX_MAX_MESSAGES) {
      throw new MailboxError(
        "queue_full",
        `目标 ${peer.name ?? peer.session} 的待处理队列已满（≥${INBOX_MAX_MESSAGES}），请合并内容或稍后再试`,
      );
    }

    const prev = this.lastSent.get(peer.session);
    if (prev && prev.body === body && nowMs - prev.at < this.cfg.duplicateWindowMs) {
      throw new MailboxError(
        "duplicate",
        `与上一条发给 ${peer.name ?? peer.session} 的消息完全相同且间隔不足 ${this.cfg.duplicateWindowMs / 1000}s，已拒绝`,
      );
    }
    this.lastSent.set(peer.session, { body, at: nowMs });

    const replyTo = opts.reply_to?.trim() ? opts.reply_to.trim() : undefined;
    const exec = opts.exec ?? this.computeExec(replyTo, nowMs);
    const profile = this.profile();
    const envelope: Envelope = {
      v: 1,
      id: newMessageId(nowMs),
      from: {
        session: profile.session,
        name: profile.name,
        cwd: profile.cwd,
        mode: profile.mode,
      },
      to: peer.session,
      created_at: st.isoNow(nowMs),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(exec ? { exec } : {}),
      body,
    };

    st.writeJsonAtomic(messagePath(this.root, peer.session, envelope.id), envelope);
    st.noteOutbound(this.root, this.sessionId, { to: peer.session, message_id: envelope.id }, nowMs);

    const trackDelegation = opts.expect_reply ?? !replyTo;
    if (trackDelegation) {
      st.appendDelegation(
        this.root,
        this.sessionId,
        {
          message_id: envelope.id,
          target_id: peer.session,
          target_name: peer.name,
          body_preview: preview(body),
          sent_at: envelope.created_at,
        },
        { max: this.cfg.delegationMax, nowMs },
      );
    }
    return envelope;
  }

  /** 回信时长：优先用 receipts 里「收到原任务」的时间自动算，模型不需要时钟。 */
  private computeExec(replyTo: string | undefined, nowMs: number): ExecMeta | undefined {
    if (!replyTo) return undefined;
    const receipt = st.findReceipt(this.root, this.sessionId, replyTo);
    if (!receipt) return undefined;
    const startMs = st.isoMs(receipt.received_at);
    if (startMs === null) return undefined;
    return {
      started_at: receipt.received_at,
      ended_at: st.isoNow(nowMs),
      ms: Math.max(0, nowMs - startMs),
    };
  }

  private validateBody(body: string): void {
    if (typeof body !== "string") throw new MailboxError("invalid_target", "消息正文必须是字符串");
    if (body.trim() === "") throw new MailboxError("empty_body", "消息正文不能为空");
    if (body.length > this.cfg.bodyMaxChars) {
      throw new MailboxError(
        "body_too_large",
        `消息正文 ${body.length} 字符，超过上限 ${this.cfg.bodyMaxChars}`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* 接收                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 取出并消费 inbox 中所有可投递消息。
   *  - 队列超上限：先丢最旧；
   *  - decide 回调按入站策略逐条裁决：accept 正常投递 / hold 移入 .held /
   *    refuse 立即删除；裁决发生在读文件之后、去重与消费之前；
   *  - 与上一条已投递 from+body 全同：丢弃；
   *  - 读即 unlink（at-most-once，崩溃丢消息可接受，PRD §4.9 裁决）；
   *  - 同时记 receipts、消委派台账、更新 last_inbound。
   */
  poll(decide?: (env: Envelope) => "accept" | "hold" | "refuse", limit?: number): Envelope[] {
    const dir = inboxDir(this.root, this.sessionId);
    if (!existsSync(dir)) return [];
    const nowMs = this.now();
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("msg-") && f.endsWith(".json"))
      .sort();
    while (files.length > this.cfg.inboxMax) {
      const f = files.shift();
      if (f) unlinkQuiet(join(dir, f));
    }
    // 自动 turn 链预算有限时只消费前 N 条，其余留在 inbox 等下一 tick（不丢）。
    const batch = limit !== undefined ? files.slice(0, Math.max(0, limit)) : files;

    const out: Envelope[] = [];
    for (const f of batch) {
      const path = join(dir, f);
      const env = readEnvelope(path);
      if (!env || env.to !== this.sessionId) {
        unlinkQuiet(path);
        continue;
      }
      const verdict = decide?.(env) ?? "accept";
      if (verdict === "refuse") {
        unlinkQuiet(path);
        continue;
      }
      if (verdict === "hold") {
        try {
          renameSync(path, heldMessagePath(this.root, this.sessionId, env.id));
        } catch {
          // hold 失败退化为消费，避免消息永久卡住
        }
        continue;
      }
      // 先消费再判定去重：重复消息同样不留在磁盘上。
      unlinkQuiet(path);
      if (this.lastDelivered && this.lastDelivered.from === env.from.session && this.lastDelivered.body === env.body) {
        continue;
      }
      this.lastDelivered = { from: env.from.session, body: env.body };
      out.push(env);
      st.recordReceipt(
        this.root,
        this.sessionId,
        { message_id: env.id, from: env.from.session, received_at: st.isoNow(nowMs) },
        this.cfg.receiptMax,
      );
      st.resolveDelegation(
        this.root,
        this.sessionId,
        { reply_to: env.reply_to ?? null, from: env.from.session },
        { nowMs },
      );
    }

    if (out.length > 0) {
      const last = out[out.length - 1]!;
      st.noteInbound(
        this.root,
        this.sessionId,
        { from: last.from.session, message_id: last.id },
        nowMs,
      );
    }
    return out;
  }

  /** 把一条消息移出正常投递路径（/inbox 的 hold）。 */
  hold(messageId: string): boolean {
    const from = messagePath(this.root, this.sessionId, messageId);
    if (!existsSync(from)) return false;
    const to = heldMessagePath(this.root, this.sessionId, messageId);
    renameSync(from, to);
    return true;
  }

  /** 放行一条 held 消息；返回信封供调用方注入。 */
  release(messageId: string): Envelope | null {
    const from = heldMessagePath(this.root, this.sessionId, messageId);
    if (!existsSync(from)) return null;
    const env = readEnvelope(from);
    renameSync(from, messagePath(this.root, this.sessionId, messageId));
    return env;
  }

  discard(messageId: string): boolean {
    const active = messagePath(this.root, this.sessionId, messageId);
    if (existsSync(active)) {
      unlinkQuiet(active);
      return true;
    }
    const held = heldMessagePath(this.root, this.sessionId, messageId);
    if (existsSync(held)) {
      unlinkQuiet(held);
      return true;
    }
    return false;
  }

  heldIds(): string[] {
    const dir = heldDir(this.root, this.sessionId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith("msg-") && f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }

  inboxDepthOf(sessionId: string): number {
    const dir = inboxDir(this.root, sessionId);
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir).filter((f) => f.startsWith("msg-") && f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  /** 当前会话自己的 inbox 深度。 */
  inboxDepth(): number {
    return this.inboxDepthOf(this.sessionId);
  }

  /* ---------------------------------------------------------------- */
  /* peer 查询 / watchdog                                              */
  /* ---------------------------------------------------------------- */

  resolvePeer(target: string, opts: { requireAlive?: boolean } = {}): PeerProfile {
    const wanted = target.trim();
    if (!wanted) throw new MailboxError("invalid_target", "target 不能为空");
    const profiles = identity.listProfiles(this.root);

    const exact = profiles.find((p) => p.session === wanted);
    if (exact) return this.finishPeer(exact, opts);
    const fragment = profiles.filter((p) => p.session.includes(wanted));
    if (fragment.length > 1) {
      throw new MailboxError("ambiguous_target", `target "${wanted}" 匹配到多个 session`, {
        candidates: fragment.map((p) => describePeer(p)),
      });
    }
    const frag = fragment[0];
    if (frag) return this.finishPeer(frag, opts);
    const byName = profiles.filter((p) => p.name === wanted);
    if (byName.length > 1) {
      throw new MailboxError("ambiguous_target", `名字 "${wanted}" 匹配到多个会话`, {
        candidates: byName.map((p) => describePeer(p)),
      });
    }
    const named = byName[0];
    if (named) return this.finishPeer(named, opts);
    throw new MailboxError("invalid_target", `找不到目标会话 "${wanted}"`);
  }

  private finishPeer(p: PeerProfile, opts: { requireAlive?: boolean }): PeerProfile {
    if (opts.requireAlive && !identity.isAlive(this.root, p.session)) {
      throw new MailboxError("target_dead", `目标 ${p.name ?? p.session} 的进程已退出，v1 不排队、不缓存离线消息`);
    }
    return p;
  }

  observe(sessionId: string, nowMs: number = this.now()): PeerObservation {
    return identity.observePeer(this.root, sessionId, { nowMs, cfg: this.cfg });
  }

  peers(): PeerInfo[] {
    const nowMs = this.now();
    const out: PeerInfo[] = [];
    for (const p of identity.listProfiles(this.root)) {
      const obs = identity.observePeer(this.root, p.session, { nowMs, cfg: this.cfg });
      const heartbeatAge = identity.heartbeatAgeMs(this.root, p.session, nowMs);
      out.push({
        session: p.session,
        name: p.name,
        cwd: p.cwd,
        mode: p.mode,
        alive: obs.alive,
        effective: obs.effective,
        heartbeat_age_ms: Number.isFinite(heartbeatAge) ? heartbeatAge : -1,
        state: obs.state,
        is_self: p.session === this.sessionId,
      });
    }
    // 自己排第一，其余按名字/id 排序
    out.sort((a, b) => {
      if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
      return (a.name ?? a.session).localeCompare(b.name ?? b.session);
    });
    return out.filter((p) => p.alive || p.is_self);
  }

  outstanding(): Delegation[] {
    return st.readDelegations(this.root, this.sessionId).filter((d) => d.status === "outstanding");
  }

  /**
   * 委派 watchdog：只返回「首次跃迁」的异常通知。
   * 判定顺序见 state.classifyDelegations（dead > undelivered > waiting_on_peers >
   * idle_no_reply > healthy > stuck > blocked）。
   */
  watchdog(opts: WatchdogOptions = {}): WatchdogNotice[] {
    const nowMs = opts.nowMs ?? this.now();
    st.pruneDelegations(this.root, this.sessionId, nowMs);
    const entries = st.readDelegations(this.root, this.sessionId).filter((d) => d.status === "outstanding");
    if (entries.length === 0) return [];

    const observations = new Map<string, PeerObservation>();
    for (const d of entries) {
      if (!observations.has(d.target_id)) {
        observations.set(d.target_id, identity.observePeer(this.root, d.target_id, { nowMs, cfg: this.cfg }));
      }
    }
    const verdicts = st.classifyDelegations(this.sessionId, entries, observations, nowMs, this.cfg);
    const notices: WatchdogNotice[] = [];
    for (const { delegation, verdict } of verdicts) {
      if (isWatchdogKind(verdict)) {
        if (!delegation.notified.includes(verdict)) {
          notices.push(this.makeNotice(delegation, verdict, observations.get(delegation.target_id), nowMs));
          st.markDelegationNotified(this.root, this.sessionId, delegation.id, verdict, nowMs);
        }
      } else {
        // 恢复正常 / 在等别人 / 等审批：清空已通知，下次异常可再次提醒
        st.clearDelegationNotified(this.root, this.sessionId, delegation.id, nowMs);
      }
    }
    return notices;
  }

  private makeNotice(
    d: Delegation,
    kind: WatchdogKind,
    obs: PeerObservation | undefined,
    nowMs: number,
  ): WatchdogNotice {
    let detail: string;
    if (kind === "dead") {
      if (!obs || !obs.exists) detail = "目标会话目录已不存在";
      else {
        const age = identity.heartbeatAgeMs(this.root, d.target_id, nowMs);
        detail = Number.isFinite(age) ? `心跳已停止约 ${Math.round(age / 1000)}s` : "进程疑似退出";
      }
    } else if (kind === "undelivered") {
      detail = "消息仍在对方 inbox/.held 中未被消费（可能被 hold 或入站策略拦住）";
    } else if (kind === "idle_no_reply") {
      detail = "对方已空闲，但未见回信（可能只把结果打到了自己的屏幕）";
    } else {
      const progress = st.isoMs(obs?.state?.last_progress_at ?? null);
      const age = progress === null ? "?" : `${Math.round((nowMs - progress) / 1000)}s`;
      detail = `工作中已 ${age} 无进展（可能网络 / tool-call 卡死）`;
    }
    return {
      kind,
      delegation_id: d.id,
      message_id: d.message_id,
      target_id: d.target_id,
      target_name: d.target_name,
      body_preview: d.body_preview,
      detail,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function newMessageId(nowMs: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `msg-${nowMs}-${rand}`;
}

function preview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 120);
}

function describePeer(p: PeerProfile): string {
  return `${p.name ?? "(未命名)"} / ${p.session}`;
}

function isWatchdogKind(v: string): v is WatchdogKind {
  return v === "dead" || v === "idle_no_reply" || v === "stuck" || v === "undelivered";
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

function readEnvelope(path: string): Envelope | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isEnvelope(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isEnvelope(x: unknown): x is Envelope {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Partial<Envelope>;
  return (
    e.v === 1 &&
    typeof e.id === "string" &&
    typeof e.body === "string" &&
    typeof e.to === "string" &&
    typeof e.created_at === "string" &&
    typeof e.from === "object" &&
    e.from !== null &&
    typeof e.from.session === "string" &&
    (e.reply_to === undefined || typeof e.reply_to === "string") &&
    (e.exec === undefined || (typeof e.exec === "object" && e.exec !== null))
  );
}

/* 兼容导出：调用方需要从路径拼出 inbox 文件时用。 */
export { inboxDir, heldDir };
