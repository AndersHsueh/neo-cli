/**
 * format.test.ts — v0.4.16：档位纪律共享工具（ui/format.ts）。
 *
 * 背景：v0.4.13/14/15 连续三次修同一类缺陷（toFixed/Math.round 把档内值
 * 进位到档边界），纪律只写在注释里。这里把三个 helper 的行为钉死，
 * 并显式记录「fixed1 的 ≥10 降级是 token/bytes 口径，不是通用一位小数」——
 * 抽取时正是把它误用到时长秒档，导致 12.3s 变成 12s。
 */
import { describe, expect, test } from "bun:test";

import { clock, fixed1, fixed1Raw, rounded } from "../src/ui/format.ts";

describe("F1 fixed1（token/bytes 一位小数档，≥10 降级为整数）", () => {
  test("F1a 档内保留一位小数", () => {
    expect(fixed1(1)).toBe("1.0");
    expect(fixed1(1.234)).toBe("1.2");
    expect(fixed1(9.5)).toBe("9.5");
  });

  test("F1b 进位到 10.0 时降级为整数（不跨档）", () => {
    expect(fixed1(9.96)).toBe("10");
    expect(fixed1(9.99)).toBe("10");
    expect(fixed1(10)).toBe("10");
    expect(fixed1(99.95)).toBe("100");
  });

  test("F1c toFixed 的舍入到偶：9.95 仍是 9.9", () => {
    expect(fixed1(9.95)).toBe("9.9");
    expect(fixed1(9.949)).toBe("9.9");
  });
});

describe("F2 fixed1Raw（纯一位小数，升档阈值交给调用方）", () => {
  test("F2a 不降级：12.34 仍是 12.3（时长秒档要的正是这个）", () => {
    expect(fixed1Raw(12.34)).toBe("12.3");
    expect(fixed1Raw(59.94)).toBe("59.9");
  });

  test("F2b 进位到 60.0 原样返回，由调用方判断升档", () => {
    expect(fixed1Raw(59.95)).toBe("60.0");
    expect(fixed1Raw(59.999)).toBe("60.0");
  });

  test("F2c 与 fixed1 的分歧点就是 10~60 区间", () => {
    expect(fixed1(12.34)).toBe("12");
    expect(fixed1Raw(12.34)).toBe("12.3");
  });
});

describe("F3 rounded（整数档，返回数值便于比档宽）", () => {
  test("F3a 四舍五入返回 number", () => {
    expect(rounded(999.4)).toBe(999);
    expect(rounded(999.5)).toBe(1000);
    expect(typeof rounded(1.2)).toBe("number");
  });
});

describe("F4 clock（秒 → m:ss / h:mm:ss）", () => {
  test("F4a <1h 用 m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(42)).toBe("0:42");
    expect(clock(61)).toBe("1:01");
    expect(clock(3599)).toBe("59:59");
  });

  test("F4b >=1h 用 h:mm:ss", () => {
    expect(clock(3600)).toBe("1:00:00");
    expect(clock(3723)).toBe("1:02:03");
    expect(clock(36_000)).toBe("10:00:00");
  });

  test("F4c 亚秒向下取整、负数/NaN/Infinity 按 0", () => {
    expect(clock(0.9)).toBe("0:00");
    expect(clock(-5)).toBe("0:00");
    expect(clock(Number.NaN)).toBe("0:00");
    expect(clock(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
