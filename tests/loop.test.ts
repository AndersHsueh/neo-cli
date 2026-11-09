/**
 * issue #25：定时 / 自节奏循环提示（`/loop`）的纯逻辑与调度器。
 *
 * 覆盖：间隔解析 / 命令解析（含夹紧与报错）/ 状态文案 /
 * interval 与 self 两种节奏 / 忙碌时丢弃一拍并计 skipped / stop & dispose 不留定时器。
 * 全部用注入式假定时器，不真等。
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  LOOP_MAX_INTERVAL_MS,
  LOOP_MIN_INTERVAL_MS,
  LoopScheduler,
  formatInterval,
  formatLoopStatus,
  parseInterval,
  parseLoopCommand,
} from "../src/loop.ts";

/* ------------------------------------------------------------------ */
/* 假定时器                                                            */
/* ------------------------------------------------------------------ */

function fakeClock(): {
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
  advance: (ms: number) => void;
  pending: () => number;
  now: () => number;
} {
  let t = 1_000_000;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn, ms) => {
        seq += 1;
        jobs.set(seq, { at: t + ms, fn });
        return seq;
      },
      clear: (h) => {
        jobs.delete(h as number);
      },
    },
    advance: (ms) => {
      t += ms;
      for (const [h, job] of [...jobs]) {
        if (job.at <= t) {
          jobs.delete(h);
          job.fn();
        }
      }
    },
    pending: () => jobs.size,
    now: () => t,
  };
}

/* ------------------------------------------------------------------ */
/* 1. 间隔解析                                                         */
/* ------------------------------------------------------------------ */

describe("parseInterval", () => {
  test("s / m / h / 纯数字（秒）", () => {
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("2m")).toBe(120_000);
    expect(parseInterval("1h")).toBe(3_600_000);
    expect(parseInterval("90")).toBe(90_000);
    expect(parseInterval(" 2M ")).toBe(120_000);
  });

  test("非法/零/负数 → null", () => {
    for (const bad of ["", "abc", "2x", "0s", "-5", "1.5.5m"]) {
      expect(parseInterval(bad)).toBeNull();
    }
  });
});

describe("formatInterval", () => {
  test("整天/整分/秒", () => {
    expect(formatInterval(60_000)).toBe("1 分钟");
    expect(formatInterval(3_600_000)).toBe("1 小时");
    expect(formatInterval(30_000)).toBe("30 秒");
    expect(formatInterval(5_000)).toBe("5 秒");
  });
});

/* ------------------------------------------------------------------ */
/* 2. 命令解析                                                         */
/* ------------------------------------------------------------------ */

describe("parseLoopCommand", () => {
  test("空 → status；stop/off → stop", () => {
    expect(parseLoopCommand("").kind).toBe("status");
    expect(parseLoopCommand("stop").kind).toBe("stop");
    expect(parseLoopCommand("off").kind).toBe("stop");
  });

  test("interval：2m + 提示", () => {
    const r = parseLoopCommand("2m 看下 CI");
    expect(r).toEqual({
      kind: "start",
      spec: { mode: "interval", intervalMs: 120_000, prompt: "看下 CI" },
    });
  });

  test("self：自节奏", () => {
    const r = parseLoopCommand("self 看下日志");
    expect(r).toEqual({
      kind: "start",
      spec: { mode: "self", intervalMs: 0, prompt: "看下日志" },
    });
  });

  test("间隔过小/过大 → 夹紧并给 warning", () => {
    const small = parseLoopCommand("1s 看下");
    expect(small.kind).toBe("start");
    if (small.kind !== "start") throw new Error("期望 start");
    expect(small.spec.intervalMs).toBe(LOOP_MIN_INTERVAL_MS);
    expect(small.warning).toContain("夹紧");

    const big = parseLoopCommand("99h 看下");
    if (big.kind !== "start") throw new Error("期望 start");
    expect(big.spec.intervalMs).toBe(LOOP_MAX_INTERVAL_MS);
    expect(big.warning).toContain("夹紧");
  });

  test("缺提示 / 间隔认不出 → error（带用法）", () => {
    for (const bad of ["2m", "self", "abc x"]) {
      const r = parseLoopCommand(bad);
      expect(r.kind).toBe("error");
      if (r.kind !== "error") throw new Error("期望 error");
      expect(r.message).toContain("/loop");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. 状态文案                                                         */
/* ------------------------------------------------------------------ */

describe("formatLoopStatus", () => {
  test("没有循环 → 一行提示用法", () => {
    expect(formatLoopStatus(null, 0).join("\n")).toContain("当前没有循环");
  });

  test("interval：模式 / 已跑 / 下次唤醒（相对秒）/ 提示摘要", () => {
    const now = 1_000_000;
    const lines = formatLoopStatus(
      {
        spec: { mode: "interval", intervalMs: 120_000, prompt: "看下 CI 是否绿" },
        startedAt: now,
        runs: 2,
        skipped: 1,
        nextAt: now + 45_000,
      },
      now,
    ).join("\n");
    expect(lines).toContain("每 2 分钟");
    expect(lines).toContain("已跑 2 次");
    expect(lines).toContain("跳过 1 次");
    expect(lines).toContain("45s 后");
    expect(lines).toContain("看下 CI 是否绿");
  });

  test("self：等待本轮结束；超长提示截断", () => {
    const lines = formatLoopStatus(
      {
        spec: { mode: "self", intervalMs: 0, prompt: "x".repeat(100) },
        startedAt: 0,
        runs: 0,
        skipped: 0,
        nextAt: null,
      },
      0,
    ).join("\n");
    expect(lines).toContain("自节奏");
    expect(lines).toContain("等待本轮结束");
    expect(lines).toContain("…");
  });
});

/* ------------------------------------------------------------------ */
/* 4. 调度器                                                           */
/* ------------------------------------------------------------------ */

describe("LoopScheduler", () => {
  let clock: ReturnType<typeof fakeClock>;
  let prompts: string[];
  let busy: boolean;
  let scheduler: LoopScheduler;

  beforeEach(() => {
    clock = fakeClock();
    prompts = [];
    busy = false;
    scheduler = new LoopScheduler({
      enqueue: (prompt) => {
        if (busy) return false;
        prompts.push(prompt);
        return true;
      },
      timers: clock.timers,
      now: clock.now,
    });
  });

  test("interval：启动立刻跑第一拍，之后按间隔排", () => {
    scheduler.start({ mode: "interval", intervalMs: 60_000, prompt: "看 CI" });
    expect(prompts).toEqual(["看 CI"]);
    expect(scheduler.state?.runs).toBe(1);
    expect(scheduler.state?.nextAt).toBe(clock.now() + 60_000);

    clock.advance(60_000);
    expect(prompts).toEqual(["看 CI", "看 CI"]);
    expect(scheduler.state?.runs).toBe(2);
    scheduler.dispose();
  });

  test("忙碌时丢弃这一拍并计 skipped，节奏不中断", () => {
    scheduler.start({ mode: "interval", intervalMs: 60_000, prompt: "看 CI" });
    busy = true;
    clock.advance(60_000);
    expect(prompts.length).toBe(1);
    expect(scheduler.state?.skipped).toBe(1);
    // 下一拍照常排
    expect(scheduler.state?.nextAt).not.toBeNull();
    busy = false;
    clock.advance(60_000);
    expect(prompts.length).toBe(2);
    expect(scheduler.state?.runs).toBe(2);
    scheduler.dispose();
  });

  test("self：先跑第一拍，轮末才排下一拍（不叠拍）", () => {
    scheduler.start({ mode: "self", intervalMs: 0, prompt: "看日志" });
    expect(prompts).toEqual(["看日志"]);
    expect(scheduler.state?.nextAt).toBeNull();
    expect(clock.pending()).toBe(0);

    scheduler.onTurnEnd();
    expect(clock.pending()).toBe(1);
    clock.advance(0);
    expect(prompts).toEqual(["看日志", "看日志"]);
    scheduler.dispose();
  });

  test("stop / dispose：清掉定时器与状态，再调无害", () => {
    scheduler.start({ mode: "interval", intervalMs: 60_000, prompt: "x" });
    expect(clock.pending()).toBe(1);
    scheduler.stop();
    expect(clock.pending()).toBe(0);
    expect(scheduler.state).toBeNull();
    scheduler.stop();
    scheduler.dispose();
    clock.advance(120_000);
    expect(prompts.length).toBe(1);
  });

  test("已在跑时 start 会替换旧循环（不叠加定时器）", () => {
    scheduler.start({ mode: "interval", intervalMs: 60_000, prompt: "old" });
    scheduler.start({ mode: "interval", intervalMs: 30_000, prompt: "new" });
    expect(prompts).toEqual(["old", "new"]);
    expect(clock.pending()).toBe(1);
    clock.advance(30_000);
    expect(prompts).toEqual(["old", "new", "new"]);
    scheduler.dispose();
  });
});
