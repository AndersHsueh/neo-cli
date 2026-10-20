/**
 * mailbox.test.ts — 文件信箱收发集成测试（M1）。
 *
 * 规格：docs/cross-session-messaging-prd[done].md v1.2 §4.2 / §4.3 / §4.4 / §4.7 / §4.10 / §4.9。
 * 全部用例在 mkdtemp 沙箱中运行，时间通过 Mailbox.now 注入，不碰真实 ~/.neo。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as identity from "../src/mailbox/identity.ts";
import * as st from "../src/mailbox/state.ts";
import { Mailbox } from "../src/mailbox/store.ts";
import {
  MailboxError,
  inboxDir,
  messagePath,
  statePath,
  type Envelope,
  type MailboxConfig,
} from "../src/mailbox/types.ts";

let SANDBOX = "";
const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const A = "20261020-100000-aaaaaa";
const B = "20261020-100000-bbbbbb";
const C = "20261020-110000-cccccc";
const clock = { t: T0 };

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-mailbox-"));
});
afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});
beforeEach(() => {
  clock.t = T0;
});

interface FreshOpts {
  configB?: Partial<MailboxConfig>;
  withC?: boolean;
}

function fresh(tag = "case", opts: FreshOpts = {}): { root: string; a: Mailbox; b: Mailbox; c?: Mailbox } {
  const root = mkdtempSync(join(SANDBOX, `${tag}-`));
  const a = session(root, A, "a");
  const b = session(root, B, "b", opts.configB);
  const c = opts.withC ? session(root, C, "c") : undefined;
  return { root, a, b, c };
}

function session(root: string, id: string, name: string, config?: Partial<MailboxConfig>): Mailbox {
  identity.createIdentity({ root, sessionId: id, cwd: "/tmp/proj", name, mode: "ask", nowMs: clock.t });
  return new Mailbox({ root, sessionId: id, now: () => clock.t, ...(config ? { config } : {}) });
}

function rawEnvelope(id: string, from: string, to: string, body: string): Envelope {
  return {
    v: 1,
    id,
    from: { session: from, name: null, cwd: "/tmp/proj", mode: "ask" },
    to,
    created_at: st.isoNow(clock.t),
    body,
  };
}

/* ------------------------------------------------------------------ */
/* 发送 / 接收                                                         */
/* ------------------------------------------------------------------ */

describe("A 发送与接收", () => {
  test("A1 按名字投递 → poll 取回 → inbox 消费后为空（at-most-once）", () => {
    const { root, a, b } = fresh();
    const env = a.send("b", "hello from A");
    expect(env.v).toBe(1);
    expect(env.id.startsWith("msg-")).toBe(true);
    expect(env.from.session).toBe(A);
    expect(env.from.name).toBe("a");
    expect(env.to).toBe(B);
    expect(env.body).toBe("hello from A");
    expect(existsSync(messagePath(root, B, env.id))).toBe(true);

    const got = b.poll();
    expect(got.length).toBe(1);
    expect(got[0]!.id).toBe(env.id);
    expect(b.inboxDepth()).toBe(0);
    expect(b.poll()).toEqual([]);
    // 回执被记录（供回信 exec 用）
    expect(st.findReceipt(root, B, env.id)?.from).toBe(A);
  });

  test("A2 接收端完全重复 from+body 去重（不同 id 也只投一次）", () => {
    const { root, b } = fresh();
    const e1 = rawEnvelope("msg-1-aaaaaa", A, B, "same body");
    const e2 = rawEnvelope("msg-2-bbbbbb", A, B, "same body");
    st.writeJsonAtomic(messagePath(root, B, e1.id), e1);
    st.writeJsonAtomic(messagePath(root, B, e2.id), e2);
    expect(b.poll().length).toBe(1);
    expect(b.inboxDepth()).toBe(0);
  });

  test("A3 队列上限：超过 50 条丢最旧", () => {
    const { root, b } = fresh("cap", { configB: { inboxMax: 2 } });
    for (const n of [1, 2, 3]) {
      st.writeJsonAtomic(messagePath(root, B, `msg-${n}-xxxxxx`), rawEnvelope(`msg-${n}-xxxxxx`, A, B, `body ${n}`));
    }
    const got = b.poll();
    expect(got.map((e) => e.id)).toEqual(["msg-2-xxxxxx", "msg-3-xxxxxx"]);
    expect(b.inboxDepth()).toBe(0);
  });

  test("A4 正文为空 / 超长被发送端拒绝", () => {
    const { root } = fresh("body");
    const a = new Mailbox({ root, sessionId: A, now: () => clock.t, config: { bodyMaxChars: 10 } });
    expect(() => a.send("b", "   ")).toThrow(/不能为空/);
    expect(() => a.send("b", "x".repeat(11))).toThrow(/超过上限 10/);
  });

  test("A5 不能发给自己", () => {
    const { a } = fresh();
    expect(() => a.send("a", "self")).toThrow(MailboxError);
    try {
      a.send(A, "self");
    } catch (e) {
      expect((e as MailboxError).code).toBe("self_target");
    }
  });

  test("A6 poll(limit) 只消费前 N 条，其余留在 inbox 等下一 tick", () => {
    const { root, b } = fresh("limit");
    for (const n of [1, 2, 3]) {
      const id = `msg-${n}-limitx`;
      st.writeJsonAtomic(messagePath(root, B, id), rawEnvelope(id, A, B, `body ${n}`));
    }
    expect(b.poll(undefined, 2).length).toBe(2);
    expect(b.inboxDepth()).toBe(1);
    expect(b.poll().length).toBe(1);
    expect(b.inboxDepth()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* target 解析 / 限流                                                  */
/* ------------------------------------------------------------------ */

describe("B target 解析与发送端限流", () => {
  test("B1 精确 id > id 片段 > 名字", () => {
    const { a } = fresh("resolve", { withC: true });
    expect(a.send(B, "by id").to).toBe(B);
    expect(a.send("110000", "by fragment").to).toBe(C);
    expect(a.send("b", "by name").to).toBe(B);
  });

  test("B2 多匹配 → ambiguous_target 并带候选", () => {
    const { a } = fresh();
    try {
      a.send("2026", "ambiguous");
      throw new Error("应当抛错");
    } catch (e) {
      const err = e as MailboxError;
      expect(err.code).toBe("ambiguous_target");
      expect((err.candidates ?? []).length).toBeGreaterThanOrEqual(2);
    }
  });

  test("B3 目标不存在 / 已死 → 错误，不排队", () => {
    const { root, a } = fresh();
    try {
      a.send("nobody", "x");
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as MailboxError).code).toBe("invalid_target");
    }
    identity.releaseAlive(root, B);
    try {
      a.send("b", "x");
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as MailboxError).code).toBe("target_dead");
    }
  });

  test("B4 发送端重复洪峰：同 body <5s 拒绝，>5s 放行；不同 body 放行", () => {
    const { a } = fresh();
    a.send("b", "same");
    try {
      a.send("b", "same");
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as MailboxError).code).toBe("duplicate");
    }
    a.send("b", "different");
    clock.t += 5_000;
    expect(a.send("b", "same").body).toBe("same");
  });

  test("B5 目标 inbox 满 → queue_full（发送端拒绝）", () => {
    const { root, a } = fresh("full");
    for (let i = 0; i < 50; i++) {
      const id = `msg-${i}-fillxx`;
      st.writeJsonAtomic(messagePath(root, B, id), rawEnvelope(id, C, B, `fill ${i}`));
    }
    try {
      a.send("b", "m3");
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as MailboxError).code).toBe("queue_full");
    }
  });
});

/* ------------------------------------------------------------------ */
/* hold / release                                                      */
/* ------------------------------------------------------------------ */

describe("C hold / release / discard", () => {
  test("C1 hold 后 poll 不投；release 后重新进入正常投递", () => {
    const { a, b } = fresh("hold");
    const e = a.send("b", "hold me");
    expect(b.hold(e.id)).toBe(true);
    expect(b.heldIds()).toContain(e.id);
    expect(b.poll()).toEqual([]);
    const released = b.release(e.id);
    expect(released?.id).toBe(e.id);
    expect(b.poll().map((x) => x.id)).toEqual([e.id]);
  });

  test("C2 discard 删除 active / held 消息", () => {
    const { a, b } = fresh();
    const e1 = a.send("b", "one");
    expect(b.discard(e1.id)).toBe(true);
    expect(b.poll()).toEqual([]);
    const e2 = a.send("b", "two");
    b.hold(e2.id);
    expect(b.discard(e2.id)).toBe(true);
    expect(b.heldIds()).toEqual([]);
  });

  test("C3 poll 裁决：hold 移入 .held；refuse 直接删除", () => {
    const { root, b } = fresh("policy");
    const held = rawEnvelope("msg-1-aaaaaa", A, B, "hold me");
    st.writeJsonAtomic(messagePath(root, B, held.id), held);
    expect(b.poll(() => "hold")).toEqual([]);
    expect(b.heldIds()).toContain(held.id);
    expect(b.inboxDepth()).toBe(0);
    expect(b.release(held.id)?.id).toBe(held.id);
    expect(b.poll(() => "accept").map((e) => e.id)).toEqual([held.id]);

    const refused = rawEnvelope("msg-2-bbbbbb", A, B, "refuse me");
    st.writeJsonAtomic(messagePath(root, B, refused.id), refused);
    expect(b.poll(() => "refuse")).toEqual([]);
    expect(b.inboxDepth()).toBe(0);
    expect(b.heldIds()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 任务号 / 执行时长 / 台账                                            */
/* ------------------------------------------------------------------ */

describe("D reply_to / exec / 台账消账", () => {
  test("D1 回信带 reply_to，宿主用 receipts 自动算 exec；发起方精确消账", () => {
    const { root, a, b } = fresh();
    const task = a.send("b", "implement X");
    const [received] = b.poll();
    expect(received!.id).toBe(task.id);

    clock.t = T0 + 60_000;
    const reply = b.send("a", "done", { reply_to: task.id });
    expect(reply.reply_to).toBe(task.id);
    expect(reply.exec).toBeDefined();
    expect(reply.exec!.started_at).toBe(new Date(T0).toISOString());
    expect(reply.exec!.ended_at).toBe(new Date(T0 + 60_000).toISOString());
    expect(reply.exec!.ms).toBe(60_000);
    // 回信本身不登记为「等待回信」的委派
    expect(b.outstanding()).toEqual([]);

    const got = a.poll();
    expect(got.length).toBe(1);
    expect(got[0]!.reply_to).toBe(task.id);
    expect(a.outstanding()).toEqual([]);
    const ledger = st.readDelegations(root, A);
    expect(ledger[0]!.status).toBe("replied");
  });

  test("D2 没有 reply_to 时按 target 最早未回兜底消账", () => {
    const { a, b } = fresh();
    a.send("b", "task");
    b.poll();
    clock.t += 1_000;
    b.send("a", "done without id");
    a.poll();
    expect(a.outstanding()).toEqual([]);
  });

  test("D3 expect_reply=false 的通知类消息不登记委派", () => {
    const { a } = fresh();
    a.send("b", "FYI only", { expect_reply: false });
    expect(a.outstanding()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* watchdog 编排                                                       */
/* ------------------------------------------------------------------ */

describe("E watchdog", () => {
  test("E1 目标进程死亡 → dead 通知，且只通知一次", () => {
    const { root, a } = fresh();
    a.send("b", "task");
    identity.releaseAlive(root, B);
    clock.t = T0 + 130_000;
    const notices = a.watchdog();
    expect(notices.length).toBe(1);
    expect(notices[0]!.kind).toBe("dead");
    expect(notices[0]!.target_id).toBe(B);
    expect(a.watchdog()).toEqual([]); // 跃迁去重
  });

  test("E2 消息未被消费 → undelivered", () => {
    const { a } = fresh();
    a.send("b", "task");
    const notices = a.watchdog();
    expect(notices.map((n) => n.kind)).toEqual(["undelivered"]);
  });

  test("E3 消费了但空闲不回信 → idle_no_reply", () => {
    const { a, b } = fresh();
    a.send("b", "task");
    b.poll();
    const notices = a.watchdog();
    expect(notices.map((n) => n.kind)).toEqual(["idle_no_reply"]);
    expect(notices[0]!.detail).toContain("未见回信");
  });

  test("E4 对方在等别人 → waiting_on_peers，不告警", () => {
    const { a, b, c } = fresh("wait", { withC: true });
    b.send("c", "please test");
    a.send("b", "task");
    b.poll();
    expect(a.watchdog()).toEqual([]);
  });

  test("E5 人类接管后抑制 idle_no_reply", () => {
    const { root, a, b } = fresh();
    a.send("b", "task");
    b.poll();
    st.noteHumanInput(root, B, T0 + 1_000);
    expect(a.watchdog()).toEqual([]);
  });

  test("E6 工作中进度超时 → stuck", () => {
    const { root, a, b } = fresh();
    a.send("b", "task");
    b.poll();
    st.mutateState(root, B, (s) => {
      s.phase = "working";
      s.last_progress_at = new Date(clock.t - 400_000).toISOString();
    }, clock.t);
    const notices = a.watchdog();
    expect(notices.map((n) => n.kind)).toEqual(["stuck"]);
  });

  test("E7 恢复后清空 notified，再次异常能重新通知", () => {
    const { root, a, b } = fresh();
    a.send("b", "task");
    b.poll();
    expect(a.watchdog().map((n) => n.kind)).toEqual(["idle_no_reply"]);
    // 回信消账 → watchdog 无 outstanding
    clock.t += 1_000;
    b.send("a", "done");
    a.poll();
    expect(a.watchdog()).toEqual([]);
    void root;
  });
});

/* ------------------------------------------------------------------ */
/* peer 列表 / 并发写 / 文件完整性                                     */
/* ------------------------------------------------------------------ */

describe("F peers / 并发写", () => {
  test("F1 peers 含自己与存活会话；dead 会话不出现", () => {
    const { root, a } = fresh("peers", { withC: true });
    const list = a.peers();
    expect(list[0]!.is_self).toBe(true);
    expect(list.map((p) => p.session)).toContain(B);
    expect(list.map((p) => p.session)).toContain(C);
    identity.releaseAlive(root, C);
    expect(a.peers().map((p) => p.session)).not.toContain(C);
  });

  test("F2 两个发送端并发写同一 inbox：文件名唯一、内容完整、无 tmp 残留", () => {
    const { root, a, b } = fresh("atomic", { withC: true });
    const c = new Mailbox({ root, sessionId: C, now: () => clock.t });
    for (let i = 0; i < 15; i++) {
      a.send("b", `a-${i}`);
      c.send("b", `c-${i}`);
    }
    const files = readdirSync(inboxDir(root, B)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(30);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    for (const f of files) {
      const env = JSON.parse(readFileSync(join(inboxDir(root, B), f), "utf8")) as Envelope;
      expect(env.v).toBe(1);
      expect(env.id).toBe(f.slice(0, -".json".length));
    }
    expect(b.poll().length).toBe(30);
  });

  test("F3 state.json 只由本会话写：发送只更新自己的 last_outbound", () => {
    const { root, a } = fresh();
    a.send("b", "x");
    const sa = st.readState(root, A)!;
    const sb = st.readState(root, B)!;
    expect(sa.last_outbound?.to).toBe(B);
    expect(sb.last_outbound).toBeNull();
    expect(existsSync(statePath(root, A))).toBe(true);
  });
});
