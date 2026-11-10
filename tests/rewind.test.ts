/**
 * issue #27：按轮次回滚 `/rewind`。
 *
 * 覆盖：
 *  A `CheckpointStore.undoSeqs`：只恢复指定快照、恢复顺序从新到旧、undо(count) 行为不变
 *  B `RewindLog`：轮次记账、both / code / conversation 三种模式、边界与持久化
 *  C 压缩后下标平移（issue #39）：`noteCompaction` 把已有轮次的 messagesBefore 按被删头段
 *    平移；起点落在被压缩区间内的轮次 clamp 到摘要位置；旧会话（无新字段）行为不变
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
/* C. 压缩后下标平移（issue #39）                                       */
/* ------------------------------------------------------------------ */

describe("C 压缩后 messagesBefore 平移（issue #39）", () => {
  /**
   * 会话形状（与 world() 同款）：system + 3 轮，每轮 user+assistant。
   * 下标：0 system / 1 u1 / 2 a1 / 3 u2 / 4 a2 / 5 u3 / 6 a3
   * 轮次起点：第 0 轮 1、第 1 轮 3、第 2 轮 5。
   */
  function threeTurns(): { log: RewindLog; messages: { arr: string[] } } {
    const messages = { arr: ["system", "u1", "a1", "u2", "a2", "u3", "a3"] };
    const log = new RewindLog({ now: () => new Date("2026-11-09T00:00:00Z") });
    log.endTurn(log.beginTurn({ prompt: "第一轮", messagesLength: 1, checkpointSeqBefore: 0 }), []);
    log.endTurn(log.beginTurn({ prompt: "第二轮", messagesLength: 3, checkpointSeqBefore: 0 }), []);
    log.endTurn(log.beginTurn({ prompt: "第三轮", messagesLength: 5, checkpointSeqBefore: 0 }), []);
    return { log, messages };
  }

  test("C1 压缩掉头部 4 条（下标 1..4）→ 已有轮次 messagesBefore 平移 -3", () => {
    const { log } = threeTurns();
    // applyCompaction 的真实形状：system + 1 条摘要 + tail（这里 tail = [u3, a3]）
    // 被删掉的是下标 1..4 共 4 条，替换成 1 条摘要 → 净减 3。
    log.noteCompaction({ removedFrom: 1, removedTo: 4, summaryIndex: 1 });
    const turns = log.list();
    // 第 0 轮起点 1 落在被压缩区间内 → clamp 到摘要位置 1
    expect(turns[0]?.messagesBefore).toBe(1);
    // 第 1 轮起点 3 也在区间内 → clamp 到 1
    expect(turns[1]?.messagesBefore).toBe(1);
    // 第 2 轮起点 5 在区间之后 → 平移 4 条被删、补 1 条摘要 = 5 - 4 + 1 = 2
    expect(turns[2]?.messagesBefore).toBe(2);
  });

  test("C2 压缩后 rewind conversation 截到正确位置（不再静默不回滚）", () => {
    const { log, messages } = threeTurns();
    // 压缩后真实历史：system / 摘要 / u3 / a3 —— 长度 4
    messages.arr = ["system", "摘要", "u3", "a3"];
    log.noteCompaction({ removedFrom: 1, removedTo: 4, summaryIndex: 1 });
    const conv = {
      length: () => messages.arr.length,
      truncate: (n: number) => {
        messages.arr.length = n;
      },
    };
    const store = { undoSeqs: () => [] };
    // 回滚到第 2 轮（起点原为 5，平移后 2）之前 → 截到 2
    const r = log.rewind({ target: 2, mode: "conversation", store, conversation: conv });
    expect(r.messagesRemoved).toBe(2);
    expect(messages.arr).toEqual(["system", "摘要"]);
  });

  test("C3 起点落在被压缩区间内的轮次：clamp 到摘要位置并给出说明", () => {
    const { log, messages } = threeTurns();
    messages.arr = ["system", "摘要", "u3", "a3"];
    log.noteCompaction({ removedFrom: 1, removedTo: 4, summaryIndex: 1 });
    const conv = {
      length: () => messages.arr.length,
      truncate: (n: number) => {
        messages.arr.length = n;
      },
    };
    const store = { undoSeqs: () => [] };
    // 回滚到第 0 轮（起点 1 已被压进摘要）→ clamp 到 1，摘要保留
    const r = log.rewind({ target: 0, mode: "conversation", store, conversation: conv });
    expect(messages.arr).toEqual(["system"]);
    expect(r.messagesRemoved).toBe(3);
    expect(r.notes.join("")).toContain("压进摘要");
  });

  test("C4 多次压缩累计平移", () => {
    const { log } = threeTurns();
    // 第一次：删 1..2（2 条）→ 净减 1
    log.noteCompaction({ removedFrom: 1, removedTo: 2, summaryIndex: 1 });
    // 第二次：历史已变成 [system, 摘要1, u2, a2, u3, a3]（6 条），压缩 1..3（摘要1,u2,a2 3 条）→ 净减 2
    log.noteCompaction({ removedFrom: 1, removedTo: 3, summaryIndex: 1 });
    const turns = log.list();
    // 第 2 轮起点 5：第一次后 5-2+1=4；第二次后 4-3+1=2
    expect(turns[2]?.messagesBefore).toBe(2);
  });

  test("C5 旧会话（无压缩记录）行为不变", () => {
    const { log, messages } = threeTurns();
    const conv = {
      length: () => messages.arr.length,
      truncate: (n: number) => {
        messages.arr.length = n;
      },
    };
    const store = { undoSeqs: () => [] };
    const r = log.rewind({ target: 2, mode: "conversation", store, conversation: conv });
    expect(r.messagesRemoved).toBe(2);
    expect(messages.arr).toEqual(["system", "u1", "a1", "u2", "a2"]);
  });

  test("C6 压缩记录随 serialize 往返（--resume 后仍正确）", () => {
    const { log } = threeTurns();
    log.noteCompaction({ removedFrom: 1, removedTo: 4, summaryIndex: 1 });
    const saved = log.serialize();
    const revived = new RewindLog({ records: saved as RewindTurn[] });
    expect(revived.list()[2]?.messagesBefore).toBe(2);
    // 再压缩一次，revived 也要跟着平移
    revived.noteCompaction({ removedFrom: 1, removedTo: 1, summaryIndex: 1 });
    expect(revived.list()[2]?.messagesBefore).toBe(2);
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
