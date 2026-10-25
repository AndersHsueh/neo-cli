/**
 * tui-status.test.ts — v0.3.0 S1/S2：底部状态行拼装（纯函数，无 IO）。
 *
 * 规格：docs/v0.3.0-tui-prd[done].md §3.2 状态行示例 + §6 S1/S2。
 * M0 探针（P1~P4）只提供终端事实；状态行的字段顺序/丢弃优先级是产品规格。
 *
 * 断言口径：
 *  - 纯文本断言（paint 缺省恒等），宽度一律用 theme.displayWidth（CJK=2、SGR=0 宽）；
 *  - `⎇` 在 theme.charWidth 里是 1 列，`⎇ ` 前缀因此是 2 列 —— 测试直接按 displayWidth。
 *  - token 格式严格按函数规格分段：<1e3 原样 / <1e4 一位小数 k / <1e6 整数 k / 其余一位小数 M。
 *    因此 12300 → "12k"（不是示例串里的 "12.3k"；示例只是版式示意，函数规则优先）。
 */
import { describe, expect, test } from "bun:test";

import { displayWidth } from "../src/ui/theme.ts";
import {
  formatElapsed,
  formatTokens,
  progressBar,
  renderStatus,
  statusSegments,
  type StatusSnapshot,
} from "../src/tui/status.ts";

const snap = (over: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
  model: "deepseek-flash",
  tier: "balanced",
  mode: "ask",
  branch: "main",
  ctxUsage: 0.42,
  elapsedMs: 42_000,
  active: true,
  tokensTotal: 12_300,
  width: 120,
  ...over,
});

/** 全量字段的纯文本（宽度 73）。 */
const FULL =
  "deepseek-flash · balanced · ask · ⎇ main · ctx ▓▓░░░ 42% · 0:42 · 12k tok";

describe("S1a 字段顺序与精确拼接", () => {
  test("S1a 完整状态行：model · tier · mode · ⎇ branch · ctx bar % · elapsed · tok", () => {
    expect(renderStatus(snap())).toBe(FULL);
  });

  test("S1a 全宽 73 列恰好放下所有字段", () => {
    expect(displayWidth(FULL)).toBe(73);
    expect(renderStatus(snap({ width: 73 }))).toBe(FULL);
  });

  test("S1a 可选字段缺省：mode/branch 不出现在拼接里", () => {
    expect(
      renderStatus(
        snap({ mode: undefined, branch: null, elapsedMs: 0, active: false, tokensTotal: 0 }),
      ),
    ).toBe("deepseek-flash · balanced · ctx ▓▓░░░ 42% · 0:00 · 0 tok");
  });

  test("S1a branch 为 null / 空串 / 纯空白都不显示", () => {
    expect(renderStatus(snap({ branch: "" }))).not.toContain("⎇");
    expect(renderStatus(snap({ branch: "   " }))).not.toContain("⎇");
    expect(renderStatus(snap({ branch: null }))).not.toContain("⎇");
    expect(renderStatus(snap({ branch: "main" }))).toContain("⎇ main");
  });

  test("S1a active=false 仍显示上一轮时长（不是 0:00）", () => {
    const out = renderStatus(snap({ active: false, elapsedMs: 42_000 }));
    expect(out).toContain("0:42");
    expect(out).toContain("12k tok");
  });
});

describe("S1b ctx 进度条与百分比", () => {
  test("S1b 0/0.42/1 的三段进度条", () => {
    expect(progressBar(0)).toBe("░░░░░");
    expect(progressBar(0.42)).toBe("▓▓░░░");
    expect(progressBar(1)).toBe("▓▓▓▓▓");
  });

  test("S1b 四舍五入（0.5 进位、0.1 进 1 格）", () => {
    expect(progressBar(0.5)).toBe("▓▓▓░░");
    expect(progressBar(0.1)).toBe("▓░░░░");
  });

  test("S1b >1 clamp 到满格、<0 clamp 到空格、NaN 按 0", () => {
    expect(progressBar(1.4)).toBe("▓▓▓▓▓");
    expect(progressBar(-0.3)).toBe("░░░░░");
    expect(progressBar(Number.NaN)).toBe("░░░░░");
  });

  test("S1b 自定义格数", () => {
    expect(progressBar(0.55, 10)).toBe("▓▓▓▓▓▓░░░░");
    expect(progressBar(0.5, 3)).toBe("▓▓░");
    expect(progressBar(0.5, 0)).toBe("");
  });

  test("S1b 百分比取整 + 一位小数不存在", () => {
    expect(renderStatus(snap({ ctxUsage: 0.426 }))).toContain("ctx ▓▓░░░ 43%");
    expect(renderStatus(snap({ ctxUsage: 1 }))).toContain("ctx ▓▓▓▓▓ 100%");
    expect(renderStatus(snap({ ctxUsage: 0.004 }))).toContain("ctx ░░░░░ 0%");
    expect(renderStatus(snap({ ctxUsage: -0.2 }))).toContain("ctx ░░░░░ 0%");
    expect(renderStatus(snap({ ctxUsage: Number.NaN }))).toContain("ctx ░░░░░ 0%");
  });

  test("S1b ctx>100% 显示 >100% 而不是 123%", () => {
    expect(renderStatus(snap({ ctxUsage: 1.234 }))).toContain("ctx ▓▓▓▓▓ >100%");
    expect(renderStatus(snap({ ctxUsage: 1.0001 }))).toContain(">100%");
    // 恰好 1 是 100%，不是 >100%
    expect(renderStatus(snap({ ctxUsage: 1 }))).not.toContain(">100%");
  });
});

describe("S1c 时长格式", () => {
  test("S1c <1h 是 m:ss（分钟不补零、秒补两位）", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(42_000)).toBe("0:42");
    expect(formatElapsed(59_000)).toBe("0:59");
    expect(formatElapsed(60_000)).toBe("1:00");
    expect(formatElapsed(727_000)).toBe("12:07");
  });

  test("S1c >=1h 是 h:mm:ss", () => {
    expect(formatElapsed(3_600_000)).toBe("1:00:00");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  test("S1c 亚秒向下取整、负数按 0", () => {
    expect(formatElapsed(999)).toBe("0:00");
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});

describe("S1d token 格式", () => {
  test("S1d <1000 原样", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  test("S1d 1k~10k 一位小数 k", () => {
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(9_500)).toBe("9.5k");
  });

  test("S1d 10k~1M 整数 k", () => {
    expect(formatTokens(10_000)).toBe("10k");
    expect(formatTokens(12_300)).toBe("12k");
    expect(formatTokens(123_456)).toBe("123k");
  });

  test("S1d >=1M 一位小数 M", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });

  test("S1d 负数/NaN 归零", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("S1e 优先级与丢弃顺序", () => {
  test("S1e 优先级数值固定", () => {
    const segs = statusSegments(snap({ queueCount: 2 }));
    expect(segs.map((s) => s.priority)).toEqual([100, 90, 80, 50, 70, 60, 40, 30]);
    expect(segs.map((s) => s.text)).toEqual([
      "deepseek-flash",
      "balanced",
      "ask",
      "⎇ main",
      "ctx ▓▓░░░ 42%",
      "0:42",
      "12k tok",
      "⇥ 2 排队",
    ]);
  });

  test("S1e 角色语义", () => {
    const segs = statusSegments(snap({ queueCount: 2 }));
    expect(segs.map((s) => s.role)).toEqual([
      "accent",
      "dim",
      "text",
      "muted",
      "dim",
      "text",
      "dim",
      "warn",
    ]);
  });

  test("S1e ctx 接近上限 / 超限用 warn，非活动时长用 muted", () => {
    expect(statusSegments(snap({ ctxUsage: 0.95 }))[4]?.role).toBe("warn");
    expect(statusSegments(snap({ ctxUsage: 1.2 }))[4]?.role).toBe("warn");
    expect(statusSegments(snap({ active: false }))[5]?.role).toBe("muted");
  });

  test("S1e 宽度不足按优先级从低到高丢字段（84→80→73→72）", () => {
    // 84 列：queue 也放得下（73 + 3 + 8）；80 列：queue(30) 先被丢
    expect(renderStatus(snap({ queueCount: 2, width: 84 }))).toBe(`${FULL} · ⇥ 2 排队`);
    expect(renderStatus(snap({ queueCount: 2, width: 80 }))).toBe(FULL);
    // 72 列：tokens(40) 被丢（73 > 72）
    expect(renderStatus(snap({ width: 72 }))).toBe(
      "deepseek-flash · balanced · ask · ⎇ main · ctx ▓▓░░░ 42% · 0:42",
    );
  });

  test("S1e/S2a 60 列：丢 queue→tokens→branch，结果 ≤60 且不折行", () => {
    const out = renderStatus(snap({ queueCount: 1, width: 60 }));
    expect(out).toBe("deepseek-flash · balanced · ask · ctx ▓▓░░░ 42% · 0:42");
    expect(displayWidth(out)).toBeLessThanOrEqual(60);
  });

  test("S1e/S2b 40 列：继续丢 elapsed→mode", () => {
    const out = renderStatus(snap({ width: 40 }));
    expect(out).toBe("deepseek-flash · ctx ▓▓░░░ 42%");
    expect(displayWidth(out)).toBeLessThanOrEqual(40);
  });

  test("S1e/S2b 20 列：保底 model · ctx，model 用 … 截断", () => {
    const out = renderStatus(snap({ width: 20 }));
    expect(out).toBe("dee… · ctx ▓▓░░░ 42%");
    expect(displayWidth(out)).toBe(20);
  });

  test("S1e 每个宽度档位都不超宽（20/40/60/72/73/84/120）", () => {
    for (const width of [20, 40, 60, 72, 73, 84, 120]) {
      const out = renderStatus(snap({ queueCount: 2, width }));
      expect(displayWidth(out)).toBeLessThanOrEqual(width);
      // 最小保底一定在
      expect(out).toContain("ctx");
    }
  });
});

describe("S1f CJK 宽度", () => {
  test("S1f CJK 分支名按显示宽度参与丢弃（不按 UTF-16 长度）", () => {
    // 全量显示宽度 = 14+8+3+13+13+4+7 + 6*3(分隔) = 80
    const all = renderStatus(snap({ branch: "功能/状态条", width: 80 }));
    expect(displayWidth(all)).toBe(80);
    expect(all).toContain("⎇ 功能/状态条");
    expect(all).toContain("tok");

    // 78 列：按显示宽度应丢 tokens（80>78→70）；按 code unit 会误判 75 而保留 tokens（实际 80 超宽）
    const out = renderStatus(snap({ branch: "功能/状态条", width: 78 }));
    expect(out).toBe(
      "deepseek-flash · balanced · ask · ⎇ 功能/状态条 · ctx ▓▓░░░ 42% · 0:42",
    );
    expect(displayWidth(out)).toBe(70);
    expect(out).not.toContain("tok");
  });
});

describe("S1g queue", () => {
  test("S1g queueCount>0 追加 ⇥ N 排队", () => {
    expect(renderStatus(snap({ queueCount: 2 }))).toBe(`${FULL} · ⇥ 2 排队`);
  });

  test("S1g queueCount=0/undefined 不显示", () => {
    expect(renderStatus(snap({ queueCount: 0 }))).toBe(FULL);
    expect(renderStatus(snap())).toBe(FULL);
  });

  test("S1g queue 先于 tokens 被丢弃", () => {
    const out = renderStatus(snap({ queueCount: 9, width: 73 }));
    expect(out).toBe(FULL);
    expect(out).not.toContain("排队");
  });
});

describe("S1h paint 钩子", () => {
  test("S1h 缺省 paint 是恒等（纯文本）", () => {
    expect(renderStatus(snap(), (_, text) => text)).toBe(FULL);
  });

  test("S1h paint 按角色着色，只作用于保留字段", () => {
    const painted = renderStatus(snap(), (role, text) => `<${role}>${text}`);
    expect(painted.startsWith("<accent>deepseek-flash · <dim>balanced · <text>ask")).toBe(true);
    expect(painted).toContain("<muted>⎇ main");
    expect(painted).toContain("<dim>ctx ▓▓░░░ 42%");
  });
});
