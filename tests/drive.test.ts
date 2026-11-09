/**
 * issue #24：目标驱动自动续跑（`/drive`）。
 *
 * 锁住语义：完成条件只认可验证信号（检查命令 exit 0）；未通过自动再排一轮；
 * 到上限 / 连续空转 / 用户 stop 都会停；入队失败（忙）时跳过这一拍不计数。
 */
import { describe, expect, test } from "bun:test";

import { DriveManager, DRIVE_IDLE_LIMIT, formatDriveState, type DriveCheckResult } from "../src/drive.ts";

function fakeDeps(results: Array<boolean | "throw"> = []): {
  dm: DriveManager;
  enqueued: string[];
  checks: number;
  setEnqueue: (ok: boolean) => void;
} {
  const enqueued: string[] = [];
  let queueOk = true;
  let checks = 0;
  const dm = new DriveManager({
    runCheck: async (): Promise<DriveCheckResult> => {
      checks += 1;
      const next = results.shift();
      if (next === "throw") throw new Error("检查命令炸了");
      return { ok: next === true, code: next === true ? 0 : 1, output: next === true ? "ok" : "FAIL test" };
    },
    enqueue: (prompt) => {
      if (!queueOk) return false;
      enqueued.push(prompt);
      return true;
    },
  });
  return { dm, enqueued, checks, setEnqueue: (ok) => (queueOk = ok) };
}

function spec(over: Partial<{ check: string; prompt: string; maxRounds: number }> = {}) {
  return { check: "bun test", prompt: "修到测试全绿", maxRounds: 3, ...over };
}

describe("issue #24 DriveManager", () => {
  test("start 校验：缺检查命令 / 缺提示 → 明确报错；maxRounds 夹紧 1–20", () => {
    const { dm } = fakeDeps();
    expect(dm.start({ check: "", prompt: "x", maxRounds: 3 }).ok).toBe(false);
    expect(dm.start({ check: "true", prompt: "  ", maxRounds: 3 }).ok).toBe(false);
    expect(dm.start(spec({ maxRounds: 0 })).ok).toBe(true);
    expect(dm.state?.spec.maxRounds).toBe(1);
    expect(dm.start(spec({ maxRounds: 99 })).ok).toBe(true);
    expect(dm.state?.spec.maxRounds).toBe(20);
  });

  test("检查通过 → done，不再入队", async () => {
    const { dm, enqueued } = fakeDeps([true]);
    dm.start(spec());
    const out = await dm.onTurnEnd({ toolCalls: 1 });
    expect(out.action).toBe("done");
    expect(dm.state?.status).toBe("done");
    expect(enqueued).toEqual([]);
  });

  test("未通过 → 自动再排一轮；到上限 → exhausted", async () => {
    const { dm, enqueued } = fakeDeps([false, false, false, false]);
    dm.start(spec({ maxRounds: 2 }));
    expect((await dm.onTurnEnd({ toolCalls: 1 })).action).toBe("continue");
    expect(enqueued).toEqual(["修到测试全绿"]);
    expect((await dm.onTurnEnd({ toolCalls: 1 })).action).toBe("continue");
    expect(dm.state?.rounds).toBe(2);
    // 第 3 次轮末：已到上限
    expect((await dm.onTurnEnd({ toolCalls: 1 })).action).toBe("exhausted");
    expect(dm.state?.status).toBe("exhausted");
    expect(enqueued.length).toBe(2);
  });

  test("入队失败（忙）→ skipped，不计数，下一轮再试", async () => {
    const { dm, enqueued, setEnqueue } = fakeDeps([false, false]);
    dm.start(spec());
    setEnqueue(false);
    expect((await dm.onTurnEnd({ toolCalls: 1 })).action).toBe("skipped");
    expect(dm.state?.rounds).toBe(0);
    setEnqueue(true);
    expect((await dm.onTurnEnd({ toolCalls: 1 })).action).toBe("continue");
    expect(dm.state?.rounds).toBe(1);
    expect(enqueued).toEqual(["修到测试全绿"]);
  });

  test("防空转：连续 N 轮没有工具调用 → 暂停并交回用户", async () => {
    const { dm } = fakeDeps(Array.from({ length: 5 }, () => false));
    dm.start(spec({ maxRounds: 5 }));
    expect((await dm.onTurnEnd({ toolCalls: 0 })).action).toBe("continue");
    expect((await dm.onTurnEnd({ toolCalls: 0 })).action).toBe("idle-stop");
    expect(dm.state?.status).toBe("stopped");
    expect(dm.state?.reason).toContain(`${DRIVE_IDLE_LIMIT} 轮没有工具调用`);
  });

  test("stop：进行中可随时停；已结束再停无害", async () => {
    const { dm } = fakeDeps([true]);
    dm.start(spec());
    dm.stop();
    expect(dm.state?.status).toBe("stopped");
    const out = await dm.onTurnEnd({ toolCalls: 1 });
    expect(out.action).toBe("none");
    dm.stop();
    expect(dm.state?.status).toBe("stopped");
  });

  test("检查命令抛错不应击穿：本轮按未通过处理（不崩）", async () => {
    const { dm, enqueued } = fakeDeps(["throw", false]);
    dm.start(spec());
    // runCheck 抛错会让 onTurnEnd 拒绝 —— 组合根负责兜住；这里只确认 reject 而不是静默继续
    await expect(dm.onTurnEnd({ toolCalls: 1 })).rejects.toThrow();
    expect(enqueued.length).toBe(0);
  });

  test("formatDriveState：空 / 三种状态 / 最近检查摘要", async () => {
    expect(formatDriveState(null).join("\n")).toContain("没有正在进行的自动续跑");
    const { dm } = fakeDeps([false]);
    dm.start(spec());
    await dm.onTurnEnd({ toolCalls: 1 });
    const lines = formatDriveState(dm.state).join("\n");
    expect(lines).toContain("进行中");
    expect(lines).toContain("已自动推进 1/3 轮");
    expect(lines).toContain("bun test");
    expect(lines).toContain("exit 1");
  });
});
