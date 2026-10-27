/**
 * mailbox-state.test.ts — 状态机 / 台账 / 回执 / watchdog 纯判定。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2 §4.9 / §4.10。
 * 全部用例用注入时间与临时目录，不碰真实 ~/.neo。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as identity from "../src/mailbox/identity.ts";
import * as st from "../src/mailbox/state.ts";
import {
  DEFAULT_MAILBOX_CONFIG,
  aliveOwnerPath,
  delegationsPath,
  statePath,
  type Delegation,
  type PeerObservation,
  type SessionState,
} from "../src/mailbox/types.ts";

let SANDBOX = "";
beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-mailbox-state-"));
});
afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const SELF = "20261020-100000-aaaaaa";
const PEER = "20261020-100000-bbbbbb";

function freshRoot(tag = "case"): string {
  return mkdtempSync(join(SANDBOX, `${tag}-`));
}

function seedSession(root: string, sessionId = SELF, opts: { name?: string | null; mode?: SessionState["mode"]; nowMs?: number } = {}): void {
  identity.createIdentity({
    root,
    sessionId,
    cwd: "/tmp/proj",
    name: opts.name ?? null,
    mode: opts.mode ?? "ask",
    nowMs: opts.nowMs ?? T0,
  });
}

function mkDelegation(over: Partial<Delegation> = {}): Delegation {
  return {
    id: "del-1",
    message_id: "msg-1",
    target_id: PEER,
    target_name: "peer",
    body_preview: "do work",
    sent_at: new Date(T0).toISOString(),
    status: "outstanding",
    replied_at: null,
    notified: [],
    ...over,
  };
}

function mkObs(over: Partial<PeerObservation> = {}): PeerObservation {
  return {
    session: PEER,
    name: "peer",
    cwd: "/tmp/proj",
    mode: "ask",
    exists: true,
    alive: true,
    pid_alive: true,
    effective: "alive",
    state: null,
    inbox_message_ids: new Set<string>(),
    ...over,
  };
}

function workingState(over: Partial<SessionState> = {}): SessionState {
  const s = st.initialState(PEER, { name: "peer", mode: "ask", nowMs: T0 });
  s.phase = "working";
  s.turn = { seq: 1, source: "mailbox", from: SELF, started_at: new Date(T0).toISOString() };
  s.last_progress_at = new Date(T0).toISOString();
  return { ...s, ...over };
}

function idleState(over: Partial<SessionState> = {}): SessionState {
  const s = st.initialState(PEER, { name: "peer", mode: "ask", nowMs: T0 });
  s.phase = "idle";
  return { ...s, ...over };
}

/* ------------------------------------------------------------------ */
/* 状态机转移                                                          */
/* ------------------------------------------------------------------ */

describe("A 状态机", () => {
  test("A1 初始 state 为 idle 且字段齐全", () => {
    const root = freshRoot();
    seedSession(root);
    const s = st.readState(root, SELF);
    expect(s).not.toBeNull();
    expect(s!.phase).toBe("idle");
    expect(s!.version).toBe(1);
    expect(s!.outstanding).toEqual([]);
    expect(st.isoMs(s!.heartbeat_at)).toBe(T0);
  });

  test("A2 beginTurn / touchProgress / endTurn 转移", () => {
    const root = freshRoot();
    seedSession(root);
    st.beginTurn(root, SELF, { seq: 1, source: "mailbox", from: PEER }, T0 + 1_000);
    let s = st.readState(root, SELF)!;
    expect(s.phase).toBe("working");
    expect(s.turn).toEqual(
      expect.objectContaining({ seq: 1, source: "mailbox", from: PEER, started_at: new Date(T0 + 1_000).toISOString() }),
    );

    st.touchProgress(root, SELF, T0 + 2_000);
    s = st.readState(root, SELF)!;
    expect(st.isoMs(s.last_progress_at)).toBe(T0 + 2_000);

    st.endTurn(root, SELF, { outcome: "aborted", abortSource: "human" }, T0 + 3_000);
    s = st.readState(root, SELF)!;
    expect(s.phase).toBe("idle");
    expect(s.turn).toBeNull();
    expect(s.last_turn).toEqual(
      expect.objectContaining({ seq: 1, outcome: "aborted", abort_source: "human" }),
    );
  });

  test("A3 读损坏 state 返回 null，不抛错", () => {
    const root = freshRoot();
    seedSession(root);
    writeFileSync(statePath(root, SELF), "{ not-json", "utf8");
    expect(st.readState(root, SELF)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 有效状态派生                                                        */
/* ------------------------------------------------------------------ */

describe("B 有效状态派生", () => {
  const cfg = { deadAfterMs: 120_000, staleAfterMs: 30_000 };

  test("B1 .alive 不存在 → dead", () => {
    expect(st.deriveEffective(st.initialState(SELF, { nowMs: T0 }), { alive: false, nowMs: T0, cfg })).toEqual({
      effective: "dead",
      heartbeat_age_ms: Number.POSITIVE_INFINITY,
    });
  });

  test("B2 心跳新鲜 → alive；30–120s → stale；>120s → dead", () => {
    const s = st.initialState(SELF, { nowMs: T0 });
    expect(st.deriveEffective(s, { alive: true, nowMs: T0 + 10_000, cfg }).effective).toBe("alive");
    expect(st.deriveEffective(s, { alive: true, nowMs: T0 + 60_000, cfg }).effective).toBe("stale");
    expect(st.deriveEffective(s, { alive: true, nowMs: T0 + 121_000, cfg }).effective).toBe("dead");
  });

  test("B3 stuck 判定：working 且进度超时；waiting_input 不算", () => {
    const working = workingState({ last_progress_at: new Date(T0).toISOString() });
    expect(st.isStuck(working, T0 + 301_000, { progressTimeoutMs: 300_000 })).toBe(true);
    expect(st.isStuck(working, T0 + 299_000, { progressTimeoutMs: 300_000 })).toBe(false);
    expect(st.isStuck({ ...working, phase: "waiting_input" }, T0 + 999_000, { progressTimeoutMs: 300_000 })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 入站回执                                                            */
/* ------------------------------------------------------------------ */

describe("C 入站回执", () => {
  test("C1 记录 / 查询 / 同 id 去重", () => {
    const root = freshRoot();
    seedSession(root);
    st.recordReceipt(root, SELF, { message_id: "msg-1", from: PEER, received_at: new Date(T0).toISOString() });
    st.recordReceipt(root, SELF, { message_id: "msg-1", from: PEER, received_at: new Date(T0 + 1).toISOString() });
    const list = st.readReceipts(root, SELF);
    expect(list.length).toBe(1);
    expect(st.findReceipt(root, SELF, "msg-1")?.received_at).toBe(new Date(T0).toISOString());
    expect(st.findReceipt(root, SELF, "msg-x")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 委派台账                                                            */
/* ------------------------------------------------------------------ */

describe("D 委派台账", () => {
  test("D1 append 同步 state.outstanding 投影", () => {
    const root = freshRoot();
    seedSession(root);
    st.appendDelegation(root, SELF, {
      message_id: "msg-1",
      target_id: PEER,
      target_name: "peer",
      body_preview: "do work",
      sent_at: new Date(T0).toISOString(),
    }, { nowMs: T0 });
    expect(st.readDelegations(root, SELF).length).toBe(1);
    expect(st.readState(root, SELF)!.outstanding).toEqual([
      { message_id: "msg-1", target_id: PEER, target_name: "peer", sent_at: new Date(T0).toISOString() },
    ]);
  });

  test("D2 收到 reply_to 精确消账；无 reply_to 退回同 target 最早未回", () => {
    const root = freshRoot();
    seedSession(root);
    for (const id of ["msg-1", "msg-2"]) {
      st.appendDelegation(root, SELF, {
        message_id: id, target_id: PEER, target_name: "peer", body_preview: id, sent_at: new Date(T0).toISOString(),
      }, { nowMs: T0 });
    }
    const exact = st.resolveDelegation(root, SELF, { reply_to: "msg-2", from: PEER }, { nowMs: T0 + 1_000 });
    expect(exact.changed).toBe(true);
    expect(exact.resolved[0]?.message_id).toBe("msg-2");
    let list = st.readDelegations(root, SELF);
    expect(list.find((d) => d.message_id === "msg-2")?.status).toBe("replied");
    expect(list.find((d) => d.message_id === "msg-1")?.status).toBe("outstanding");

    const fallback = st.resolveDelegation(root, SELF, { from: PEER }, { nowMs: T0 + 2_000 });
    expect(fallback.resolved[0]?.message_id).toBe("msg-1");
    list = st.readDelegations(root, SELF);
    expect(list.every((d) => d.status === "replied")).toBe(true);
    expect(st.readState(root, SELF)!.outstanding).toEqual([]);
  });

  test("D3 已回信超过 24h 的条目被清理，未回信保留", () => {
    const root = freshRoot();
    seedSession(root);
    st.appendDelegation(root, SELF, {
      message_id: "msg-old", target_id: PEER, target_name: "peer", body_preview: "old", sent_at: new Date(T0).toISOString(),
    }, { nowMs: T0 });
    st.appendDelegation(root, SELF, {
      message_id: "msg-new", target_id: PEER, target_name: "peer", body_preview: "new", sent_at: new Date(T0).toISOString(),
    }, { nowMs: T0 });
    st.resolveDelegation(root, SELF, { reply_to: "msg-old", from: PEER }, { nowMs: T0 });
    st.pruneDelegations(root, SELF, T0 + 25 * 3600_000);
    const list = st.readDelegations(root, SELF);
    expect(list.map((d) => d.message_id)).toEqual(["msg-new"]);
  });

  test("D4 notified 标记 / 清空", () => {
    const root = freshRoot();
    seedSession(root);
    const d = st.appendDelegation(root, SELF, {
      message_id: "msg-1", target_id: PEER, target_name: "peer", body_preview: "x", sent_at: new Date(T0).toISOString(),
    }, { nowMs: T0 });
    st.markDelegationNotified(root, SELF, d.id, "dead", T0);
    expect(st.readDelegations(root, SELF)[0]!.notified).toEqual(["dead"]);
    st.clearDelegationNotified(root, SELF, d.id, T0);
    expect(st.readDelegations(root, SELF)[0]!.notified).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* watchdog 纯判定矩阵                                                 */
/* ------------------------------------------------------------------ */

describe("E watchdog 判定矩阵", () => {
  const cfg = { progressTimeoutMs: 300_000 };
  const sentAt = new Date(T0).toISOString();

  function verdict(obs: PeerObservation | undefined, delegation = mkDelegation()): string {
    const map = new Map<string, PeerObservation>();
    if (obs) map.set(PEER, obs);
    return st.classifyDelegations(SELF, [delegation], map, T0 + 200_000, cfg)[0]!.verdict;
  }

  test("E1 目标不存在 / 不 alive / effective=dead 且 pid 已死 → dead", () => {
    expect(verdict(undefined)).toBe("dead");
    expect(verdict(mkObs({ alive: false, effective: "dead", pid_alive: false }))).toBe("dead");
    expect(verdict(mkObs({ effective: "dead", pid_alive: false }))).toBe("dead");
  });

  test("E2 消息仍在 inbox/.held → undelivered（优先于其它）", () => {
    expect(verdict(mkObs({ state: idleState({ outstanding: [{} as never] }), inbox_message_ids: new Set(["msg-1"]) }))).toBe(
      "undelivered",
    );
  });

  test("E3 空闲但自己在等别人 → waiting_on_peers，不告警", () => {
    expect(verdict(mkObs({ state: idleState({ outstanding: [{ message_id: "m", target_id: "x", target_name: "c", sent_at: sentAt }] }) }))).toBe(
      "waiting_on_peers",
    );
  });

  test("E4 空闲且收到过我们的任务、未回信 → idle_no_reply", () => {
    const obs = mkObs({
      state: idleState({ last_inbound: { from: SELF, message_id: "msg-1", at: sentAt } }),
    });
    expect(verdict(obs)).toBe("idle_no_reply");
  });

  test("E5 空闲且已回信 → healthy", () => {
    const obs = mkObs({
      state: idleState({
        last_inbound: { from: SELF, message_id: "msg-1", at: sentAt },
        last_outbound: { to: SELF, message_id: "msg-2", at: new Date(T0 + 1_000).toISOString() },
      }),
    });
    expect(verdict(obs)).toBe("healthy");
  });

  test("E6 人类接管后（last_human_input_at 晚于 sent_at）→ healthy，不报 idle_no_reply", () => {
    const obs = mkObs({
      state: idleState({
        last_inbound: { from: SELF, message_id: "msg-1", at: sentAt },
        last_human_input_at: new Date(T0 + 5_000).toISOString(),
      }),
    });
    expect(verdict(obs)).toBe("healthy");
  });

  test("E7 working 且进度新鲜 → healthy；进度超时 → stuck", () => {
    expect(verdict(mkObs({ state: workingState() }))).toBe("healthy");
    expect(
      verdict(mkObs({ state: workingState({ last_progress_at: new Date(T0 - 400_000).toISOString() }) })),
    ).toBe("stuck");
  });

  test("E8 waiting_input → blocked（不发通知）", () => {
    expect(verdict(mkObs({ state: idleState({ phase: "waiting_input" }) }))).toBe("blocked");
  });

  test("E9 活着但 state 缺失 → healthy（不误报）", () => {
    expect(verdict(mkObs({ state: null }))).toBe("healthy");
  });

  test("E10 心跳超时但 pid 仍活（长 turn）→ 不报 dead，按 phase 判 healthy", () => {
    expect(verdict(mkObs({ effective: "stale", pid_alive: true, state: workingState() }))).toBe("healthy");
  });
});

/* ------------------------------------------------------------------ */
/* 身份：命名 / 改键 / TTL                                             */
/* ------------------------------------------------------------------ */

describe("F 身份与清理", () => {
  test("F1 撞名只扫存活会话：同名自动加后缀，dead 名字可复用", () => {
    const root = freshRoot();
    seedSession(root, "20261020-100000-aaaaaa", { name: "worker" });
    const second = identity.createIdentity({
      root, sessionId: "20261020-100000-bbbbbb", cwd: "/tmp/proj", name: "worker", nowMs: T0 + 1_000,
    });
    expect(second.profile.name).toBe("worker-2");

    identity.releaseAlive(root, "20261020-100000-bbbbbb");
    const third = identity.createIdentity({
      root, sessionId: "20261020-100000-cccccc", cwd: "/tmp/proj", name: "worker", nowMs: T0 + 2_000,
    });
    expect(third.profile.name).toBe("worker-2"); // 第二个已 dead，后缀可复用
  });

  test("F2 rename 改 profile + state；不改 session-id", () => {
    const root = freshRoot();
    seedSession(root, SELF);
    identity.renameSession(root, SELF, "leader-ai", T0 + 1_000);
    expect(identity.readProfile(root, SELF)!.name).toBe("leader-ai");
    expect(st.readState(root, SELF)!.name).toBe("leader-ai");
  });

  test("F3 rekey：目录 / profile / state 一起迁移，.alive 跟走", () => {
    const root = freshRoot();
    seedSession(root, SELF);
    const NEW = "20261020-110000-dddddd";
    identity.rekeySession(root, SELF, NEW, T0 + 5_000);
    expect(identity.sessionExists(root, SELF)).toBe(false);
    expect(identity.sessionExists(root, NEW)).toBe(true);
    expect(identity.readProfile(root, NEW)!.session).toBe(NEW);
    expect(st.readState(root, NEW)!.session).toBe(NEW);
    expect(identity.isAlive(root, NEW)).toBe(true);
  });

  test("F4 TTL：dead 且过期目录删除；alive 保留", () => {
    const root = freshRoot();
    seedSession(root, "20261020-100000-aaaaaa");
    seedSession(root, "20261020-100000-bbbbbb");
    identity.releaseAlive(root, "20261020-100000-aaaaaa");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(statePath(root, "20261020-100000-aaaaaa"), old, old);
    utimesSync(statePath(root, "20261020-100000-bbbbbb"), old, old);
    const removed = identity.sweepSessions(root, { nowMs: Date.now(), ttlMs: 60_000 });
    expect(removed).toContain("20261020-100000-aaaaaa");
    expect(removed).not.toContain("20261020-100000-bbbbbb");
    expect(identity.sessionExists(root, "20261020-100000-aaaaaa")).toBe(false);
    expect(identity.sessionExists(root, "20261020-100000-bbbbbb")).toBe(true);
  });

  test("F5 同一 session-id 双开被 .alive 拒绝；心跳过期后可 takeover", () => {
    const root = freshRoot();
    const nowMs = Date.now();
    seedSession(root, SELF, { nowMs });
    expect(() =>
      identity.createIdentity({ root, sessionId: SELF, cwd: "/tmp/proj", nowMs }),
    ).toThrow(/已有活进程|拒绝双开/);

    const old = new Date(nowMs - 200_000);
    utimesSync(statePath(root, SELF), old, old);
    // 模拟 v0.3.1 老锁（无 owner.json）：回退到 profile pid + 心跳判活
    rmSync(aliveOwnerPath(root, SELF), { force: true });
    identity.createIdentity({ root, sessionId: SELF, cwd: "/tmp/proj", nowMs });
    expect(identity.isAlive(root, SELF)).toBe(true);
  });

  test("F6 rekey 到 dead 会话：接管其信箱目录（未读丢弃），身份切到目标 id", () => {
    const root = freshRoot();
    seedSession(root, SELF);
    seedSession(root, "20261020-100000-bbbbbb");
    identity.releaseAlive(root, "20261020-100000-bbbbbb");
    const p = identity.rekeySession(root, SELF, "20261020-100000-bbbbbb", T0 + 5_000);
    expect(p.session).toBe("20261020-100000-bbbbbb");
    expect(identity.sessionExists(root, SELF)).toBe(false);
    expect(identity.readProfile(root, "20261020-100000-bbbbbb")?.session).toBe("20261020-100000-bbbbbb");
    expect(st.readState(root, "20261020-100000-bbbbbb")?.session).toBe("20261020-100000-bbbbbb");
    expect(identity.isAlive(root, "20261020-100000-bbbbbb")).toBe(true);
  });

  test("F7 rekey 到仍有活进程的会话：拒绝（resume_conflict）", () => {
    const root = freshRoot();
    seedSession(root, SELF);
    seedSession(root, "20261020-100000-bbbbbb");
    expect(() => identity.rekeySession(root, SELF, "20261020-100000-bbbbbb", T0 + 5_000)).toThrow(/活进程/);
    expect(identity.sessionExists(root, SELF)).toBe(true);
  });

  test("F8 心跳超时但 pid 仍活 → observePeer 降级为 stale，不误报 dead", () => {
    const root = freshRoot();
    seedSession(root, SELF);
    st.mutateState(root, SELF, (s) => {
      s.heartbeat_at = new Date(T0).toISOString();
      s.phase = "working";
      s.last_progress_at = new Date(T0).toISOString();
    }, T0);
    const obs = identity.observePeer(root, SELF, {
      nowMs: T0 + 200_000,
      cfg: { deadAfterMs: 120_000, staleAfterMs: 30_000 },
    });
    expect(obs.pid_alive).toBe(true);
    expect(obs.effective).toBe("stale");
  });
});

/* ------------------------------------------------------------------ */
/* 兼容性                                                              */
/* ------------------------------------------------------------------ */

describe("G 文件兼容", () => {
  test("G1 delegations / receipts 非法 JSON 被容忍", () => {
    const root = freshRoot();
    seedSession(root);
    writeFileSync(delegationsPath(root, SELF), "not json", "utf8");
    expect(st.readDelegations(root, SELF)).toEqual([]);
    expect(st.readReceipts(root, SELF)).toEqual([]);
  });

  test("G2 默认配置含 2026-10-20 裁决值", () => {
    expect(DEFAULT_MAILBOX_CONFIG.deadAfterMs).toBe(120_000);
    expect(DEFAULT_MAILBOX_CONFIG.watchdogIntervalS).toBe(120);
    expect(DEFAULT_MAILBOX_CONFIG.autoTurnLimit).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
/* 目标锚（2026-10-26）                                                */
/* ------------------------------------------------------------------ */

describe("H 目标锚", () => {
  test("H1 新建会话 goal 为 null", () => {
    const root = freshRoot();
    seedSession(root);
    expect(st.readGoal(root, SELF)).toBeNull();
  });

  test("H2 setGoal 写入后可读回，含 set_by 与时间戳", () => {
    const root = freshRoot();
    seedSession(root);
    st.setGoal(root, SELF, "找出这篇博客的作者", { by: "user", nowMs: T0 });
    const g = st.readGoal(root, SELF);
    expect(g?.text).toBe("找出这篇博客的作者");
    expect(g?.set_by).toBe("user");
    expect(g?.set_at).toBe(new Date(T0).toISOString());
  });

  test("H3 空串 / 纯空白视为清除", () => {
    const root = freshRoot();
    seedSession(root);
    st.setGoal(root, SELF, "目标 A");
    st.setGoal(root, SELF, "   ");
    expect(st.readGoal(root, SELF)).toBeNull();
  });

  test("H4 覆盖写：后一次 setGoal 替换前一次", () => {
    const root = freshRoot();
    seedSession(root);
    st.setGoal(root, SELF, "旧目标");
    st.setGoal(root, SELF, "新目标");
    expect(st.readGoal(root, SELF)?.text).toBe("新目标");
  });

  test("H5 旧 state 无 goal 字段 → 视为 null，不判 state 非法", () => {
    const root = freshRoot();
    seedSession(root);
    // 模拟 2026-10-26 之前写下的 state：删掉 goal 字段
    const p = statePath(root, SELF);
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    delete raw["goal"];
    writeFileSync(p, JSON.stringify(raw), "utf8");
    expect(st.readState(root, SELF)).not.toBeNull();
    expect(st.readGoal(root, SELF)).toBeNull();
  });

  test("H6 setGoal 不改变 phase / turn 等既有字段", () => {
    const root = freshRoot();
    seedSession(root);
    const before = st.readState(root, SELF)!;
    st.setGoal(root, SELF, "目标");
    const after = st.readState(root, SELF)!;
    expect(after.phase).toBe(before.phase);
    expect(after.turn).toEqual(before.turn);
    expect(after.session).toBe(before.session);
  });
});
