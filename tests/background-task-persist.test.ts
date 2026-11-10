/**
 * background-task-persist.test.ts — 后台子代理任务落盘（issue #45，来源 #16 非目标）。
 *
 * 覆盖 issue #45 的四条验收：
 *  1. `BackgroundJob` 剥离 `ctx` 后可序列化：prompt / tier / promptTier / status /
 *     startedAt / finishedAt / result / error —— 序列化结果里**不含**任何活引用
 *     （console / checkpoint / signal / 函数）；
 *  2. 落盘位置：session meta 的 `backgroundTasks` 字段（与 todos / rewind 同一先例）；
 *     数量与字符上限（结果截断），避免 session 文件整篇重写膨胀；
 *  3. `--resume` 后加载为**只读历史**：`running` 一律映射成 `interrupted`
 *     （不能假装还在跑），`/tasks` 可见；
 *  4. 损坏 / 缺失 / 类型不对的文件不崩，退化成空清单。
 *
 * 全部用临时目录（NEO_SESSIONS_DIR 注入），不碰真实 ~/.neo。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BackgroundTasks,
  serializeJobs,
  restoreJobs,
  MAX_PERSISTED_JOBS,
  MAX_PERSISTED_RESULT_CHARS,
  type PersistedBackgroundJob,
} from "../src/tools/background.ts";
import type { Config } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-bg-persist-"));
const PREV_SESSIONS = process.env["NEO_SESSIONS_DIR"];

beforeAll(() => {
  process.env["NEO_SESSIONS_DIR"] = SANDBOX;
});

afterAll(() => {
  if (PREV_SESSIONS === undefined) delete process.env["NEO_SESSIONS_DIR"];
  else process.env["NEO_SESSIONS_DIR"] = PREV_SESSIONS;
  rmSync(SANDBOX, { recursive: true, force: true });
});

function fakeCtx(): ToolCtx {
  return {
    cfg: { cwd: "/tmp", toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => true,
    // 活引用：序列化后必须消失
    signal: new AbortController().signal,
  } as unknown as ToolCtx;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function deferredRunner(): {
  bg: BackgroundTasks;
  pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }>;
} {
  const pending: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = [];
  const bg = new BackgroundTasks({
    run: () =>
      new Promise<string>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  });
  return { bg, pending };
}

/* ------------------------------------------------------------------ */
/* P. 序列化                                                            */
/* ------------------------------------------------------------------ */

describe("P 序列化（issue #45）", () => {
  test("P1 序列化只含纯数据字段，不含 ctx / signal / 函数", async () => {
    const { bg, pending } = deferredRunner();
    const r = bg.launch({ prompt: "探索依赖", tier: "fast", promptTier: "auto", ctx: fakeCtx() });
    if (!r.ok) throw new Error("期望成功");
    pending[0]!.resolve("结论：依赖只有 a、b");
    await flush();

    const rows = serializeJobs(bg.rawJobs());
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // 八个字段齐全
    expect(row).toMatchObject({
      id: "bg-1",
      prompt: "探索依赖",
      tier: "fast",
      promptTier: "auto",
      status: "done",
      result: "结论：依赖只有 a、b",
      error: null,
    });
    expect(typeof row.startedAt).toBe("number");
    expect(typeof row.finishedAt).toBe("number");
    // 活引用一个都不许出现
    const json = JSON.stringify(row);
    expect(json).not.toContain("approve");
    expect(json).not.toContain("signal");
    expect(json).not.toContain("cfg");
    expect(Object.keys(row).sort()).toEqual(
      ["error", "finishedAt", "id", "prompt", "promptTier", "result", "startedAt", "status", "tier"].sort(),
    );
  });

  test("P2 结果超长按上限截断（不把 session 文件撑大）", async () => {
    const { bg, pending } = deferredRunner();
    const r = bg.launch({ prompt: "长结果", ctx: fakeCtx() });
    if (!r.ok) throw new Error("期望成功");
    pending[0]!.resolve("x".repeat(MAX_PERSISTED_RESULT_CHARS + 5_000));
    await flush();

    const row = serializeJobs(bg.rawJobs())[0]!;
    expect(row.result!.length).toBeLessThanOrEqual(MAX_PERSISTED_RESULT_CHARS + 40);
    expect(row.result).toContain("已截断");
  });

  test("P3 任务数超上限只保留最近的 N 条", async () => {
    // 并发上限默认 3：这里要造超过 MAX_PERSISTED_JOBS 条任务，必须把上限调大。
    const bg = new BackgroundTasks({ run: async () => "ok", max: MAX_PERSISTED_JOBS + 10 });
    for (let i = 0; i < MAX_PERSISTED_JOBS + 3; i++) {
      bg.launch({ prompt: `任务${i}`, ctx: fakeCtx() });
    }
    await flush();
    const rows = serializeJobs(bg.rawJobs());
    expect(rows.length).toBe(MAX_PERSISTED_JOBS);
    // 保留的是最近的那批（id 最大）
    expect(rows[rows.length - 1]!.id).toBe(`bg-${MAX_PERSISTED_JOBS + 3}`);
  });
});

/* ------------------------------------------------------------------ */
/* R. 恢复                                                              */
/* ------------------------------------------------------------------ */

describe("R 恢复（issue #45）", () => {
  test("R1 running 一律映射成 interrupted（不假装还在跑）", () => {
    const persisted: PersistedBackgroundJob[] = [
      {
        id: "bg-1",
        prompt: "还在跑的任务",
        startedAt: 1000,
        status: "running",
        finishedAt: null,
        result: null,
        error: null,
      },
      {
        id: "bg-2",
        prompt: "已完成",
        startedAt: 2000,
        status: "done",
        finishedAt: 3000,
        result: "结果",
        error: null,
      },
    ];
    const views = restoreJobs(persisted);
    expect(views).toHaveLength(2);
    const running = views.find((v) => v.id === "bg-1")!;
    expect(running.status).toBe("interrupted");
    expect(views.find((v) => v.id === "bg-2")!.status).toBe("done");
  });

  test("R2 损坏 / 缺失 / 类型不对 → 空清单，不抛", () => {
    expect(restoreJobs(undefined)).toEqual([]);
    expect(restoreJobs(null)).toEqual([]);
    expect(restoreJobs("nope")).toEqual([]);
    expect(restoreJobs({ notAnArray: true })).toEqual([]);
    // 数组里混入脏条目：丢掉坏的，保留好的
    const mixed = restoreJobs([
      null,
      { id: "bg-1", prompt: "ok", startedAt: 1, status: "done", finishedAt: 2, result: "r", error: null },
      { prompt: "缺 id" },
      { id: 42, prompt: "id 类型不对", startedAt: 1, status: "done" },
    ]);
    expect(mixed.map((v) => v.id)).toEqual(["bg-1"]);
  });

  test("R3 未知 status 退化成 interrupted（不崩、不假装）", () => {
    const views = restoreJobs([
      { id: "bg-9", prompt: "怪状态", startedAt: 1, status: "weird", finishedAt: null, result: null, error: null },
    ]);
    expect(views[0]!.status).toBe("interrupted");
  });
});

/* ------------------------------------------------------------------ */
/* S. 会话文件往返                                                       */
/* ------------------------------------------------------------------ */

describe("S 会话文件往返（issue #45）", () => {
  test("S1 写入 session meta 后能读回；文件里没有活引用", async () => {
    const { saveSession, loadSession, createSession } = await import("../src/session.ts");
    const sess = createSession("test-model", SANDBOX);
    const { bg, pending } = deferredRunner();
    const r = bg.launch({ prompt: "落盘任务", ctx: fakeCtx() });
    if (!r.ok) throw new Error("期望成功");
    pending[0]!.resolve("落盘结果");
    await flush();

    sess.meta.backgroundTasks = serializeJobs(bg.rawJobs());
    saveSession([], sess.meta);

    expect(existsSync(sess.meta.path)).toBe(true);
    const raw = readFileSync(sess.meta.path, "utf8");
    expect(raw).not.toContain("approve");
    expect(raw).not.toContain("AbortSignal");

    const loaded = loadSession(sess.meta.id);
    expect(loaded).not.toBeNull();
    const views = restoreJobs(loaded!.meta.backgroundTasks);
    expect(views).toHaveLength(1);
    expect(views[0]!.prompt).toBe("落盘任务");
    expect(views[0]!.status).toBe("done");
  });

  test("S2 旧会话没有 backgroundTasks 字段 → 空清单（向后兼容）", async () => {
    const { loadSession, createSession, saveSession } = await import("../src/session.ts");
    const sess = createSession("test-model", SANDBOX);
    saveSession([], sess.meta);
    const loaded = loadSession(sess.meta.id);
    expect(loaded!.meta.backgroundTasks).toBeUndefined();
    expect(restoreJobs(loaded!.meta.backgroundTasks)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* T. /tasks 可见                                                       */
/* ------------------------------------------------------------------ */

describe("T /tasks 可见（issue #45）", () => {
  afterEach(() => {
    /* 无全局状态需清理 */
  });

  test("T1 恢复的历史任务出现在 /tasks 列表里，状态显示为中断", async () => {
    const { dispatchCommand, wireCommands } = await import("../src/cli/commands.ts");
    const { captureConsole } = await import("./helpers.ts");
    wireCommands();
    const cap = captureConsole();
    const views = restoreJobs([
      { id: "bg-1", prompt: "历史任务", startedAt: 1, status: "running", finishedAt: null, result: null, error: null },
    ]);
    const ctx = {
      cfg: { cwd: "/tmp" } as unknown as Config,
      ui: cap.ui,
      tasks: {
        list: () => views,
        cancel: () => 0,
      },
    } as unknown as Parameters<typeof dispatchCommand>[1];
    await dispatchCommand("/tasks", ctx);
    const text = cap.out();
    expect(text).toContain("bg-1");
    expect(text).toContain("历史任务");
    expect(text).toContain("中断");
  });
});
