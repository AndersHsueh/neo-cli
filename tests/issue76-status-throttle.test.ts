/**
 * issue #76：getStatus() 里 branch 与 ctxUsage 各自 500ms–1s 节流。
 *
 * 状态行每帧都问 getStatus()；branch 的 git spawn 与 ctxUsage 遍历 messages
 * 都不应在节流窗口内重复做昂贵工作。实现见 src/cli/statusCache.ts，
 * 由 src/cli/inputLayer.ts 的 getStatus 接线。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STATUS_FIELD_TTL_MS,
  createThrottledStatusFields,
} from "../src/cli/statusCache.ts";

const INPUT_LAYER = join(import.meta.dir, "..", "src", "cli", "inputLayer.ts");

describe("issue #76 getStatus 字段节流", () => {
  test("#76g TTL 落在 500ms–1s（含边界）", () => {
    expect(STATUS_FIELD_TTL_MS).toBeGreaterThanOrEqual(500);
    expect(STATUS_FIELD_TTL_MS).toBeLessThanOrEqual(1000);
  });

  test("#76h 节流窗口内 branch / ctxUsage 不重复计算（各自缓存）", () => {
    let now = 1_000_000;
    let branchCalls = 0;
    let ctxCalls = 0;
    const fields = createThrottledStatusFields({
      getBranch: () => {
        branchCalls += 1;
        return "main";
      },
      ctxUsage: () => {
        ctxCalls += 1;
        return 0.42;
      },
      now: () => now,
    });

    expect(fields.branch()).toBe("main");
    expect(fields.ctxUsage()).toBe(0.42);
    expect(branchCalls).toBe(1);
    expect(ctxCalls).toBe(1);

    now += STATUS_FIELD_TTL_MS - 1;
    expect(fields.branch()).toBe("main");
    expect(fields.ctxUsage()).toBe(0.42);
    expect(branchCalls).toBe(1);
    expect(ctxCalls).toBe(1);
  });

  test("#76i 超过 TTL 后各自重新计算", () => {
    let now = 1_000_000;
    let branchCalls = 0;
    let ctxCalls = 0;
    let branch: string | null = "main";
    let ctx = 0.1;
    const fields = createThrottledStatusFields({
      getBranch: () => {
        branchCalls += 1;
        return branch;
      },
      ctxUsage: () => {
        ctxCalls += 1;
        return ctx;
      },
      now: () => now,
    });

    expect(fields.branch()).toBe("main");
    expect(fields.ctxUsage()).toBe(0.1);

    branch = "dev";
    ctx = 0.8;
    now += STATUS_FIELD_TTL_MS;
    expect(fields.branch()).toBe("dev");
    expect(fields.ctxUsage()).toBe(0.8);
    expect(branchCalls).toBe(2);
    expect(ctxCalls).toBe(2);
  });

  test("#76j 两个字段各自缓存：只读其一不会连带刷新另一个的计时", () => {
    let now = 1_000_000;
    let branchCalls = 0;
    let ctxCalls = 0;
    const fields = createThrottledStatusFields({
      getBranch: () => {
        branchCalls += 1;
        return "main";
      },
      ctxUsage: () => {
        ctxCalls += 1;
        return 0.2;
      },
      now: () => now,
    });

    fields.branch();
    now += 100;
    fields.ctxUsage();
    expect(branchCalls).toBe(1);
    expect(ctxCalls).toBe(1);

    // t = 1_000_550：branch 距上次计算已超过 TTL（550ms），应重算；
    // ctxUsage 距上次计算只有 TTL-50（450ms），应仍走缓存。
    // 这正好说明只读其一不会连带刷新另一个的时钟。
    now += STATUS_FIELD_TTL_MS - 50;
    fields.branch();
    expect(branchCalls).toBe(2);
    fields.ctxUsage();
    expect(ctxCalls).toBe(1);
  });

  test("#76k inputLayer getStatus 已接线节流（branch / ctxUsage）", () => {
    const src = readFileSync(INPUT_LAYER, "utf8");
    expect(src).toContain("createThrottledStatusFields");
    expect(src).toMatch(/createThrottledStatusFields\s*\(/);
    expect(src).toMatch(/getBranch\s*:/);
    expect(src).toMatch(/ctxUsage\s*:/);
  });
});
