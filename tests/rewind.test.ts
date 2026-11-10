/**
 * issue #27：按轮次回滚 `/rewind`。
 *
 * 覆盖：
 *  A `CheckpointStore.undoSeqs`：只恢复指定快照、恢复顺序从新到旧、undо(count) 行为不变
 *  B `RewindLog`：轮次记账、both / code / conversation 三种模式、边界与持久化
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointStore } from "../src/checkpoint.ts";
import { MAX_REWIND_TURNS, RewindLog, type RewindTurn } from "../src/rewind.ts";

const dirs: string[] = [];
function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "neo-rewind-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(cwd: string): CheckpointStore {
  return new CheckpointStore({ cwd, sessionId: "s1" });
}

function writeAt(cwd: string, rel: string, text: string): void {
  writeFileSync(join(cwd, rel), text, "utf8");
}

/* ------------------------------------------------------------------ */
/* A. undoSeqs                                                         */
/* ------------------------------------------------------------------ */

describe("A CheckpointStore.undoSeqs", () => {
  test("只恢复指定 seq，其余文件的当前内容保留", () => {
    const cwd = sandbox();
    writeAt(cwd, "a.txt", "a-v1");
    writeAt(cwd, "b.txt", "b-v1");
    const st = store(cwd);
    const ea = st.beforeWrite(join(cwd, "a.txt"), "write_file")!;
    writeAt(cwd, "a.txt", "a-v2");
    const eb = st.beforeWrite(join(cwd, "b.txt"), "write_file")!;
    writeAt(cwd, "b.txt", "b-v2");

    const results = st.undoSeqs([ea.seq]);
    expect(results.length).toBe(1);
    expect(results[0]?.restored).toBe("content");
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a-v1");
    expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("b-v2");
    // 已恢复的条目从 manifest 摘掉；b 的还在
    expect(st.list(10).map((e) => e.seq)).toEqual([eb.seq]);
  });

  test("同一文件多轮改：从新到旧恢复，得到最早内容", () => {
    const cwd = sandbox();
    writeAt(cwd, "f.txt", "v0");
    const st = store(cwd);
    const e1 = st.beforeWrite(join(cwd, "f.txt"), "edit_file")!;
    writeAt(cwd, "f.txt", "v1");
    const e2 = st.beforeWrite(join(cwd, "f.txt"), "edit_file")!;
    writeAt(cwd, "f.txt", "v2");

    st.undoSeqs([e1.seq, e2.seq]);
    expect(readFileSync(join(cwd, "f.txt"), "utf8")).toBe("v0");
  });

  test("undo(count) 行为不变（仍按最近 N 条）", () => {
    const cwd = sandbox();
    writeAt(cwd, "x.txt", "x0");
    const st = store(cwd);
    st.beforeWrite(join(cwd, "x.txt"), "write_file");
    writeAt(cwd, "x.txt", "x1");
    st.undo(1);
    expect(readFileSync(join(cwd, "x.txt"), "utf8")).toBe("x0");
  });
});

/* ------------------------------------------------------------------ */
/* B. RewindLog                                                        */
/* ------------------------------------------------------------------ */

interface FakeWorld {
  log: RewindLog;
  messages: { arr: string[] };
  restored: number[][];
  setCheckpoints: (turn: number, seqs: number[]) => void;
  conv: { length(): number; truncate(n: number): void };
  store: { undoSeqs(seqs: number[]): Array<{ restored: "content" }> };
}

function world(): FakeWorld {
  const restored: number[][] = [];
  const messages = { arr: ["system", "u1", "a1", "u2", "a2", "u3", "a3"] };
  const log = new RewindLog({ now: () => new Date("2026-11-09T00:00:00Z") });
  const world: FakeWorld = {
    log,
    messages,
    restored,
    conv: {
      length: () => messages.arr.length,
      truncate: (n) => {
        messages.arr.length = n;
      },
    },
    store: {
      undoSeqs: (seqs) => {
        restored.push(seqs);
        return seqs.map(() => ({ restored: "content" as const }));
      },
    },
    setCheckpoints: () => {},
  };
  // 三轮：第 0 轮之前有 1 条(system)，第 1 轮之前 3 条，第 2 轮之前 5 条
  log.endTurn(log.beginTurn({ prompt: "第一轮", messagesLength: 1, checkpointSeqBefore: 0 }), [1, 2]);
  log.endTurn(log.beginTurn({ prompt: "第二轮", messagesLength: 3, checkpointSeqBefore: 2 }), [3]);
  log.endTurn(log.beginTurn({ prompt: "第三轮", messagesLength: 5, checkpointSeqBefore: 3 }), []);
  return world;
}

describe("B RewindLog 轮次记账与回滚", () => {
  test("begin/end 记账：prompt、messagesBefore、checkpointSeqs、index 连续", () => {
    const { log } = world();
    const turns = log.list();
    expect(turns.map((t) => t.index)).toEqual([0, 1, 2]);
    expect(turns[0]).toMatchObject({ prompt: "第一轮", messagesBefore: 1, checkpointSeqs: [1, 2] });
    expect(turns[1]?.checkpointSeqs).toEqual([3]);
  });

  test("both：恢复文件 + 截断对话 + 丢弃轮次", () => {
    const w = world();
    const r = w.log.rewind({ target: 1, mode: "both", store: w.store, conversation: w.conv });
    expect(r.turnsRemoved).toBe(2);
    expect(r.messagesRemoved).toBe(4); // 7 → 3
    expect(w.messages.arr).toEqual(["system", "u1", "a1"]);
    expect(r.filesRestored).toBe(1); // 第二轮 1 个检查点；第三轮没有
    expect(w.restored).toEqual([[3]]);
    expect(w.log.list().map((t) => t.prompt)).toEqual(["第一轮"]);
  });

  test("code：只恢复文件，对话与轮次保留（seqs 清空防重复）", () => {
    const w = world();
    const r = w.log.rewind({ target: 2, mode: "code", store: w.store, conversation: w.conv });
    expect(r.turnsRemoved).toBe(1);
    expect(r.messagesRemoved).toBe(0);
    expect(w.messages.arr.length).toBe(7);
    expect(w.log.list().length).toBe(3);
    expect(w.log.list()[2]?.checkpointSeqs).toEqual([]);
    // 再按 code 回滚同一轮：没有可恢复的快照
    const again = w.log.rewind({ target: 2, mode: "code", store: w.store, conversation: w.conv });
    expect(again.filesRestored).toBe(0);
    expect(again.notes.join("")).toContain("没有产生文件检查点");
  });

  test("conversation：只截断对话，文件不动，轮次丢弃", () => {
    const w = world();
    const r = w.log.rewind({ target: "last", mode: "conversation", store: w.store, conversation: w.conv });
    expect(r.filesRestored).toBe(0);
    expect(w.restored).toBeEmpty?.() ?? expect(w.restored.length).toBe(0);
    expect(w.messages.arr.length).toBe(5);
    expect(w.log.list().length).toBe(2);
  });

  test("边界：空表 / 非法 target / last 指向最近一轮", () => {
    const empty = new RewindLog();
    const store = { undoSeqs: () => [] };
    const conv = { length: () => 1, truncate: () => {} };
    expect(empty.rewind({ target: "last", mode: "both", store, conversation: conv }).notes.join("")).toContain(
      "还没有可回滚",
    );

    const w = world();
    expect(w.log.rewind({ target: 5, mode: "both", store: w.store, conversation: w.conv }).notes.join("")).toContain(
      "不存在",
    );
    expect(w.log.rewind({ target: -1, mode: "both", store: w.store, conversation: w.conv }).notes.join("")).toContain(
      "不存在",
    );
  });

  test("持久化往返：serialize → 新实例，轮次内容一致", () => {
    const w = world();
    const saved = w.log.serialize();
    const revived = new RewindLog({ records: saved as RewindTurn[] });
    expect(revived.list()).toEqual(w.log.list());
  });

  test("超过上限只保留最近 MAX_REWIND_TURNS 轮，索引重排", () => {
    const log = new RewindLog();
    for (let i = 0; i < MAX_REWIND_TURNS + 5; i++) {
      log.endTurn(log.beginTurn({ prompt: `t${i}`, messagesLength: i, checkpointSeqBefore: 0 }), []);
    }
    const turns = log.list();
    expect(turns.length).toBe(MAX_REWIND_TURNS);
    expect(turns[turns.length - 1]?.index).toBe(MAX_REWIND_TURNS - 1);
    expect(turns[0]?.prompt).toBe(`t${5}`);
  });
});

/* ------------------------------------------------------------------ */
/* C. #42 只把用户轮次当回滚目标（跨会话 / 自动轮过滤）                */
/* ------------------------------------------------------------------ */

function mixedWorld(): FakeWorld {
  const restored: number[][] = [];
  const messages = { arr: ["system", "u1", "a1", "m1", "u2", "a2", "u3", "a3"] };
  const log = new RewindLog({ now: () => new Date("2026-11-10T00:00:00Z") });
  const w: FakeWorld = {
    log,
    messages,
    restored,
    conv: {
      length: () => messages.arr.length,
      truncate: (n) => {
        messages.arr.length = n;
      },
    },
    store: {
      undoSeqs: (seqs) => {
        restored.push(seqs);
        return seqs.map(() => ({ restored: "content" as const }));
      },
    },
    setCheckpoints: () => {},
  };
  // 轮 0 human（之前 1 条）→ 跨会话消息 auto（之前 3 条）→ 轮 1 human（之前 4 条）→ loop auto（之前 6 条）
  log.endTurn(log.beginTurn({ prompt: "第一轮", messagesLength: 1, checkpointSeqBefore: 0 }), [1]);
  log.endTurn(
    log.beginTurn({ prompt: "<跨会话消息 from=Tank>", messagesLength: 3, checkpointSeqBefore: 1, source: "auto" }),
    [2],
  );
  log.endTurn(log.beginTurn({ prompt: "第二轮", messagesLength: 4, checkpointSeqBefore: 2 }), [3]);
  log.endTurn(log.beginTurn({ prompt: "自动续跑", messagesLength: 6, checkpointSeqBefore: 3, source: "auto" }), [4]);
  return w;
}

describe("C 只列用户轮次（issue #42）", () => {
  test("C1 列表只列用户轮次、编号连续，自动轮不出现", () => {
    const w = mixedWorld();
    const turns = w.log.list();
    expect(turns.map((t) => t.prompt)).toEqual(["第一轮", "第二轮"]);
    expect(turns.map((t) => t.index)).toEqual([0, 1]);
  });

  test("C2 回滚到用户轮次时，其后的自动轮检查点一并恢复", () => {
    const w = mixedWorld();
    const r = w.log.rewind({ target: 0, mode: "both", store: w.store, conversation: w.conv });
    expect(r.turnsRemoved).toBe(2); // 用户轮次
    expect(r.autoTurnsRemoved).toBe(2); // 跨会话 + loop 自动轮
    expect(w.restored).toEqual([[1, 2, 3, 4]]);
    expect(w.messages.arr).toEqual(["system"]);
    expect(w.log.list()).toEqual([]);
  });

  test("C3 last = 最近一个用户轮次（不是最近一条记录）", () => {
    const w = mixedWorld();
    const r = w.log.rewind({ target: "last", mode: "code", store: w.store, conversation: w.conv });
    expect(r.turnsRemoved).toBe(1);
    expect(r.autoTurnsRemoved).toBe(1);
    expect(w.restored).toEqual([[3, 4]]);
  });

  test("C4 serialize 保留自动轮（否则其检查点回滚不了），revive 后用户列表不变", () => {
    const w = mixedWorld();
    const saved = w.log.serialize();
    expect(saved.length).toBe(4);
    expect(saved.filter((t) => t.source === "auto").length).toBe(2);
    const revived = new RewindLog({ records: saved });
    expect(revived.list().map((t) => t.prompt)).toEqual(["第一轮", "第二轮"]);
  });

  test("C5 旧会话记录没有 source 字段：按用户轮次兼容", () => {
    const old: RewindTurn[] = [
      { index: 0, prompt: "旧1", at: "2026-11-01T00:00:00Z", messagesBefore: 1, checkpointSeqs: [] },
      { index: 1, prompt: "旧2", at: "2026-11-01T00:01:00Z", messagesBefore: 3, checkpointSeqs: [] },
    ];
    const log = new RewindLog({ records: old });
    expect(log.list().map((t) => t.prompt)).toEqual(["旧1", "旧2"]);
  });
});
