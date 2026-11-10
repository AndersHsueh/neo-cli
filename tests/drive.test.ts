/**
 * issue #24：目标驱动自动续跑（`/drive`）。
 *
 * 锁住语义：完成条件只认可验证信号（检查命令 exit 0）；未通过自动再排一轮；
 * 到上限 / 连续空转 / 用户 stop 都会停；入队失败（忙）时跳过这一拍不计数。
 */
import { describe, expect, test } from "bun:test";

import { DriveManager, DRIVE_IDLE_LIMIT, formatDriveState, type DriveCheckResult } from "../src/drive.ts";
import type { Config } from "../src/config.ts";

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

/* ------------------------------------------------------------------ */
/* issue #50：LLM 评估完成条件（judge）                                 */
/* ------------------------------------------------------------------ */

type JudgeReply = { done: boolean; reason?: string } | "throw" | "garbage";

function judgeDeps(opts: {
  checks?: Array<boolean | "throw">;
  judges?: JudgeReply[];
} = {}) {
  const enqueued: string[] = [];
  const checks: Array<boolean | "throw"> = [...(opts.checks ?? [])];
  const judges: JudgeReply[] = [...(opts.judges ?? [])];
  const judgeInputs: Array<{ criteria: string; prompt: string; recentOutput: string }> = [];
  const dm = new DriveManager({
    runCheck: async (): Promise<DriveCheckResult> => {
      const next = checks.shift();
      if (next === "throw") throw new Error("检查命令炸了");
      return { ok: next === true, code: next === true ? 0 : 1, output: next === true ? "ok" : "FAIL" };
    },
    enqueue: (prompt) => {
      enqueued.push(prompt);
      return true;
    },
    evaluate: async (input) => {
      judgeInputs.push({ criteria: input.criteria, prompt: input.prompt, recentOutput: input.recentOutput });
      const next = judges.shift();
      if (next === undefined) throw new Error("judge 脚本耗尽");
      if (next === "throw") throw new Error("judge 请求超时");
      if (next === "garbage") return { done: false, reason: undefined, invalid: true } as never;
      return next;
    },
  });
  return { dm, enqueued, judgeInputs };
}

function judgeSpec(over: Partial<{ check: string; judge: { criteria: string }; prompt: string; maxRounds: number }> = {}) {
  return { check: "", judge: { criteria: "README 可读性已改好" }, prompt: "改 README", maxRounds: 3, ...over };
}

describe("issue #50 judge 判定（PRD §2.2 硬口径）", () => {
  test("J1 无检查命令 + 模型判断达成 → done，来源 model", async () => {
    const { dm } = judgeDeps({ judges: [{ done: true, reason: "README 已重写" }] });
    expect(dm.start(judgeSpec()).ok).toBe(true);
    const out = await dm.onTurnEnd({ toolCalls: 2 });
    expect(out.action).toBe("done");
    expect(dm.state?.status).toBe("done");
    expect(dm.state?.source).toBe("model");
    expect(dm.state?.reason).toContain("模型判断");
    expect(dm.state?.reason).not.toContain("已验证");
  });

  test("J2 检查命令 exit 0 → done，来源 verified，不调 judge", async () => {
    const { dm, judgeInputs } = judgeDeps({ checks: [true] });
    expect(dm.start(judgeSpec({ check: "bun test" })).ok).toBe(true);
    const out = await dm.onTurnEnd({ toolCalls: 1 });
    expect(out.action).toBe("done");
    expect(dm.state?.source).toBe("verified");
    expect(dm.state?.reason).toContain("已验证");
    expect(judgeInputs.length).toBe(0);
  });

  test("J3 检查命令未过 + 模型判断达成 → done，来源 model，文案说明检查未过", async () => {
    const { dm } = judgeDeps({ checks: [false], judges: [{ done: true, reason: "手工步骤已完成" }] });
    expect(dm.start(judgeSpec({ check: "bun test" })).ok).toBe(true);
    const out = await dm.onTurnEnd({ toolCalls: 1 });
    expect(out.action).toBe("done");
    expect(dm.state?.source).toBe("model");
    expect(dm.state?.reason).toContain("模型判断");
    expect(dm.state?.reason).toContain("检查命令未通过");
    expect(dm.state?.reason).not.toContain("已验证");
  });

  test("J4 模型判断未达成 → continue，沿用 maxRounds", async () => {
    const { dm, enqueued } = judgeDeps({ judges: [{ done: false, reason: "还没改完" }] });
    expect(dm.start(judgeSpec()).ok).toBe(true);
    const out = await dm.onTurnEnd({ toolCalls: 3 });
    expect(out.action).toBe("continue");
    expect(enqueued).toEqual(["改 README"]);
    expect(dm.state?.rounds).toBe(1);
  });

  test("J5 judge 抛错 → 视为未达成，记 note，不崩", async () => {
    const { dm } = judgeDeps({ judges: ["throw"] });
    expect(dm.start(judgeSpec()).ok).toBe(true);
    const out = await dm.onTurnEnd({ toolCalls: 1 });
    expect(out.action).toBe("continue");
    expect(dm.state?.judgeFailures).toBe(1);
    expect(dm.state?.lastJudgeNote).toContain("失败");
  });

  test("J6 judge 返回垃圾 → 视为未达成，记 note", async () => {
    const { dm } = judgeDeps({ judges: ["garbage"] });
    expect(dm.start(judgeSpec()).ok).toBe(true);
    const out = await dm.onTurnEnd({ toolCalls: 1 });
    expect(out.action).toBe("continue");
    expect(dm.state?.judgeFailures).toBe(1);
    expect(dm.state?.lastJudgeNote).toContain("无法解析");
  });

  test("J7 连续 2 次 judge 失败 → 暂停并提示用户", async () => {
    const { dm } = judgeDeps({ judges: ["throw", "throw"] });
    expect(dm.start(judgeSpec()).ok).toBe(true);
    await dm.onTurnEnd({ toolCalls: 1 });
    const out = await dm.onTurnEnd({ toolCalls: 1 });
    expect(out.action).toBe("idle-stop");
    expect(dm.state?.status).toBe("stopped");
    expect(dm.state?.reason).toContain("模型判断连续");
  });

  test("J8 judge 成功后失败计数清零", async () => {
    const { dm } = judgeDeps({ judges: ["throw", { done: false }] });
    expect(dm.start(judgeSpec()).ok).toBe(true);
    await dm.onTurnEnd({ toolCalls: 1 });
    expect(dm.state?.judgeFailures).toBe(1);
    await dm.onTurnEnd({ toolCalls: 1 });
    expect(dm.state?.judgeFailures).toBe(0);
  });

  test("J9 两者都缺 → start 报用法错误", () => {
    const { dm } = judgeDeps();
    const r = dm.start({ check: "", prompt: "x", maxRounds: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("检查命令");
  });

  test("J10 只有 judge 没有 check：runCheck 不被调用", async () => {
    let checkCalls = 0;
    const dm = new DriveManager({
      runCheck: async () => {
        checkCalls += 1;
        return { ok: false, code: 1, output: "" };
      },
      enqueue: () => true,
      evaluate: async () => ({ done: false }),
    });
    expect(dm.start(judgeSpec()).ok).toBe(true);
    await dm.onTurnEnd({ toolCalls: 1 });
    expect(checkCalls).toBe(0);
  });

  test("J11 未接线 evaluate 却给了 judge → start 报错（不静默降级）", () => {
    const dm = new DriveManager({ runCheck: async () => ({ ok: false, code: 1, output: "" }), enqueue: () => true });
    const r = dm.start(judgeSpec());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("模型判断");
  });
});

describe("issue #50 文案铁律（PRD §2.2）", () => {
  test("K1 model 来源的 status/结束文案不含「已验证 / 通过验证」", async () => {
    const { dm } = judgeDeps({ judges: [{ done: true, reason: "看起来完成了" }] });
    dm.start(judgeSpec());
    await dm.onTurnEnd({ toolCalls: 1 });
    const text = formatDriveState(dm.state).join("\n");
    expect(text).not.toContain("已验证");
    expect(text).not.toContain("通过验证");
    expect(text).toContain("模型判断");
  });

  test("K2 verified 来源的文案不写成「模型认为完成」", async () => {
    const { dm } = judgeDeps({ checks: [true] });
    dm.start(judgeSpec({ check: "bun test" }));
    await dm.onTurnEnd({ toolCalls: 1 });
    const text = formatDriveState(dm.state).join("\n");
    expect(text).not.toContain("模型认为完成");
    expect(text).toContain("已验证");
  });

  test("K3 status 显示最近判断来源与原因", async () => {
    const { dm } = judgeDeps({ judges: [{ done: false, reason: "还差 X" }] });
    dm.start(judgeSpec());
    await dm.onTurnEnd({ toolCalls: 1 });
    const text = formatDriveState(dm.state).join("\n");
    expect(text).toContain("最近判断");
    expect(text).toContain("模型判断");
    expect(text).toContain("还差 X");
  });
});

/* ------------------------------------------------------------------ */
/* issue #50 命令解析（PRD §2.1）                                       */
/* ------------------------------------------------------------------ */

describe("issue #50 /drive 命令解析", () => {
  async function run(arg: string) {
    const { dispatchCommand, wireCommands } = await import("../src/cli/commands.ts");
    const { captureConsole } = await import("./helpers.ts");
    wireCommands();
    const cap = captureConsole();
    const started: Array<Record<string, unknown>> = [];
    const ctx = {
      cfg: { cwd: "/tmp" } as unknown as Config,
      ui: cap.ui,
      drive: {
        start: (spec: Record<string, unknown>) => {
          started.push(spec);
          return { ok: true as const };
        },
        stop: () => {},
        status: () => ["状态：进行中"],
      },
    } as unknown as Parameters<typeof dispatchCommand>[1];
    await dispatchCommand(`/drive ${arg}`.trim(), ctx);
    return { out: cap.out(), started };
  }

  test("L1 --judge \"标准\" -- 提示：只给模型判断", async () => {
    const { started } = await run('--judge "README 可读性已改好" -- 改 README');
    expect(started[0]).toMatchObject({
      check: "",
      judge: { criteria: "README 可读性已改好" },
      prompt: "改 README",
    });
  });

  test("L2 检查命令 + --judge：两者同时给", async () => {
    const { started } = await run('bun test --judge "手工步骤也做完" -- 修到全绿');
    expect(started[0]).toMatchObject({
      check: "bun test",
      judge: { criteria: "手工步骤也做完" },
      prompt: "修到全绿",
    });
  });

  test("L3 两者都缺 → 用法错误，不启动", async () => {
    const { out, started } = await run("-- 只是提示");
    expect(started).toEqual([]);
    expect(out).toContain("缺少完成条件");
  });

  test("L4 引号内的空格与 --max 共存", async () => {
    const { started } = await run('--max 3 --judge "a b c" -- 干活');
    expect(started[0]).toMatchObject({
      judge: { criteria: "a b c" },
      maxRounds: 3,
      prompt: "干活",
    });
  });

  test("L5 缺 -- 分隔符 → 用法提示", async () => {
    const { out, started } = await run('--judge "x"');
    expect(started).toEqual([]);
    expect(out).toContain("缺少 `--` 分隔符");
  });

  test("L6 旧形态不变：只有检查命令", async () => {
    const { started } = await run("bun test -- 修到全绿");
    expect(started[0]).toMatchObject({ check: "bun test", prompt: "修到全绿" });
    expect((started[0] as { judge?: unknown }).judge).toBeUndefined();
  });
});
