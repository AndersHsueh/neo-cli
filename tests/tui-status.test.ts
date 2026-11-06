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
  version: "0.4.54",
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

/** 全量字段的纯文本（宽度 83）。 */
const FULL =
  "v0.4.54 · deepseek-flash · balanced · ask · ⎇ main · ctx ▓▓░░░ 42% · 0:42 · 12k tok";

describe("S1a 字段顺序与精确拼接", () => {
  test("S1a 完整状态行：model · tier · mode · ⎇ branch · ctx bar % · elapsed · tok", () => {
    expect(renderStatus(snap())).toBe(FULL);
  });

  test("S1a 全宽 83 列恰好放下所有字段", () => {
    expect(displayWidth(FULL)).toBe(83);
    expect(renderStatus(snap({ width: 83 }))).toBe(FULL);
  });

  test("S1a 可选字段缺省：mode/branch 不出现在拼接里", () => {
    expect(
      renderStatus(
        snap({ mode: undefined, branch: null, elapsedMs: 0, active: false, tokensTotal: 0 }),
      ),
    ).toBe("v0.4.54 · deepseek-flash · balanced · ctx ▓▓░░░ 42% · 0:00 · 0 tok");
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

  // v0.4.13：档位边界不能因四舍五入而跨档——跨档会让状态栏宽度突然多 2 列再缩回。
  test("S1d 一位小数档进位到 10.0 时降级为整数 k", () => {
    expect(formatTokens(9_999)).toBe("10k");
    expect(formatTokens(9_960)).toBe("10k"); // toFixed(1) 已进位到 "10.0"
    expect(formatTokens(9_950)).toBe("9.9k"); // 9.95 的 toFixed(1) 仍是 "9.9"（舍入到偶）
    expect(formatTokens(9_949)).toBe("9.9k");
  });

  test("S1d 整数 k 档进位到 1000 时升级为 M", () => {
    expect(formatTokens(999_999)).toBe("1.0M");
    expect(formatTokens(999_500)).toBe("1.0M");
    expect(formatTokens(999_499)).toBe("999k");
  });

  // v0.4.31：M 档是「一位小数」档，同样要守档内纪律——
  // 9_999_999 的 toFixed(1) 是 "10.0"，999_999_999 是 "1000.0"，
  // 原样输出会得到 "10.0M"/"1000.0M"：既跨档（宽度多 2 列）又与下一档的
  // "10M"/"1.0G" 撞值。与 k 档的 9_999 → "10k" 是同一类缺陷。
  test("S1d M 档进位到 10.0 时降级为整数 M", () => {
    expect(formatTokens(9_999_999)).toBe("10M");
    expect(formatTokens(9_960_000)).toBe("10M"); // toFixed(1) 已进位到 "10.0"
    expect(formatTokens(9_500_000)).toBe("9.5M");
  });

  test("S1d M 档进位到 1000 时升级为 G", () => {
    expect(formatTokens(999_999_999)).toBe("1.0G");
    expect(formatTokens(999_500_000)).toBe("1.0G");
    expect(formatTokens(999_499_999)).toBe("999M");
  });

  test("S1d G 档同样守档内纪律", () => {
    expect(formatTokens(1_000_000_000)).toBe("1.0G");
    expect(formatTokens(9_999_999_999)).toBe("10G");
    expect(formatTokens(999_999_999_999)).toBe("1.0T");
  });

  // v0.4.44：T 档原被当作末档，999_999_999_999_999 与 1e15 都输出 "1000T"，
  // 既跨档又与「1.0P」数量级撞值。现与 k/M/G 档同构补上 P 档。
  test("S1d T 档进位到 1000 时升级为 P", () => {
    expect(formatTokens(9_999_999_999_999)).toBe("10T");
    expect(formatTokens(10_000_000_000_000)).toBe("10T");
    expect(formatTokens(12_300_000_000_000)).toBe("12T");
    expect(formatTokens(999_499_999_999_999)).toBe("999T");
    expect(formatTokens(999_999_999_999_999)).toBe("1.0P");
    expect(formatTokens(1_000_000_000_000_000)).toBe("1.0P");
  });

  test("S1d P 档是末档，一位小数转整数", () => {
    expect(formatTokens(1_234_567_890_123_456)).toBe("1.2P");
    expect(formatTokens(9_999_999_999_999_999)).toBe("10P");
  });

  // v0.4.45：v0.4.44 补 P 档时只写了 `fixed1(v / 1e15)`，漏了末档的「整数档」那一半。
  // fixed1 只把 10.0 降级成 10，不负责把 1000.0 收成整数，于是 1e18 输出 "1000P"、
  // 1e21 输出 "1000000P"、1e300 输出 "1.0000000000000001e+285P" —— 宽度随数量级
  // 无限增长（状态栏单行硬约束被打破），且出现科学计数法。与 v0.4.31 的 M 档、
  // v0.4.44 的 T 档是同一类缺陷：末档也必须有「<10P 一位小数 / ≥10P 整数」两档。
  test("S1d P 档末档：<10P 一位小数，≥10P 整数（不出现 1000.0P/科学计数法）", () => {
    expect(formatTokens(9_950_000_000_000_000)).toBe("9.9P"); // 9.95 的 toFixed(1) 仍是 "9.9"
    expect(formatTokens(9_960_000_000_000_000)).toBe("10P"); // toFixed(1) 进位到 "10.0" → 降级
    expect(formatTokens(1e16)).toBe("10P");
    expect(formatTokens(1e17)).toBe("100P");
    expect(formatTokens(1.5e17)).toBe("150P");
    expect(formatTokens(1e18)).toBe("1000P"); // 末档无处可升，保留整数档
    expect(formatTokens(1e21)).toBe("1000000P"); // 仍是整数，不是 "1e+6"
  });
});

describe("S1e 优先级与丢弃顺序", () => {
  test("S1e 优先级数值固定", () => {
    const segs = statusSegments(snap({ queueCount: 2 }));
    expect(segs.map((s) => s.priority)).toEqual([100, 100, 90, 80, 50, 70, 60, 40, 30]);
    expect(segs.map((s) => s.text)).toEqual([
      "v0.4.54",
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
      "muted",
      "accent",
      "tier",
      "text",
      "muted",
      "dim",
      "text",
      "dim",
      "warn",
    ]);
  });

  test("S1e ctx 接近上限 / 超限用 warn，非活动时长用 muted", () => {
    expect(statusSegments(snap({ ctxUsage: 0.95 }))[5]?.role).toBe("warn");
    expect(statusSegments(snap({ ctxUsage: 1.2 }))[5]?.role).toBe("warn");
    expect(statusSegments(snap({ active: false }))[6]?.role).toBe("muted");
  });

  test("S1e 宽度不足按优先级从低到高丢字段（94→90→83→82）", () => {
    // 94 列：queue 也放得下（83 + 3 + 8）；90 列：queue(30) 先被丢
    expect(renderStatus(snap({ queueCount: 2, width: 94 }))).toBe(`${FULL} · ⇥ 2 排队`);
    expect(renderStatus(snap({ queueCount: 2, width: 90 }))).toBe(FULL);
    // 82 列：tokens(40) 被丢（83 > 82）
    expect(renderStatus(snap({ width: 82 }))).toBe(
      "v0.4.54 · deepseek-flash · balanced · ask · ⎇ main · ctx ▓▓░░░ 42% · 0:42",
    );
  });

  test("S1e/S2a 60 列：丢 queue→tokens→branch，结果 ≤60 且不折行", () => {
    const out = renderStatus(snap({ queueCount: 1, width: 60 }));
    expect(out).toBe("v0.4.54 · deepseek-flash · balanced · ask · ctx ▓▓░░░ 42%");
    expect(displayWidth(out)).toBeLessThanOrEqual(60);
  });

  test("S1e/S2b 40 列：继续丢 elapsed→mode", () => {
    const out = renderStatus(snap({ width: 40 }));
    expect(out).toBe("v0.4.54 · deepseek-flash · ctx ▓▓░░░ 42%");
    expect(displayWidth(out)).toBeLessThanOrEqual(40);
  });

  test("S1e/S2b 20 列：保底 model · ctx，model 用 … 截断", () => {
    const out = renderStatus(snap({ width: 20 }));
    expect(out).toBe("dee… · ctx ▓▓░░░ 42%");
    expect(displayWidth(out)).toBe(20);
  });

  test("S1e 每个宽度档位都不超宽（20/40/60/72/82/83/94/120）", () => {
    for (const width of [20, 40, 60, 72, 82, 83, 94, 120]) {
      const out = renderStatus(snap({ queueCount: 2, width }));
      expect(displayWidth(out)).toBeLessThanOrEqual(width);
      // 最小保底一定在
      expect(out).toContain("ctx");
    }
  });
});

describe("S1f CJK 宽度", () => {
  test("S1f CJK 分支名按显示宽度参与丢弃（不按 UTF-16 长度）", () => {
    // 全量显示宽度 = 7+14+8+3+13+13+4+7 + 7*3(分隔) = 90
    const all = renderStatus(snap({ branch: "功能/状态条", width: 90 }));
    expect(displayWidth(all)).toBe(90);
    expect(all).toContain("⎇ 功能/状态条");
    expect(all).toContain("tok");

    // 88 列：按显示宽度应丢 tokens（90>88→80）；按 code unit 会误判 85 而保留 tokens（实际 90 超宽）
    const out = renderStatus(snap({ branch: "功能/状态条", width: 88 }));
    expect(out).toBe(
      "v0.4.54 · deepseek-flash · balanced · ask · ⎇ 功能/状态条 · ctx ▓▓░░░ 42% · 0:42",
    );
    expect(displayWidth(out)).toBe(80);
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
    const out = renderStatus(snap({ queueCount: 9, width: 83 }));
    expect(out).toBe(FULL);
    expect(out).not.toContain("排队");
  });
});

describe("S1i 待办摘要（issue #10）", () => {
  test("S1i 有摘要时出现在 tokens 之后、queue 之前", () => {
    expect(renderStatus(snap({ todosSummary: "✓2/5" }))).toBe(`${FULL} · ✓2/5`);
    expect(renderStatus(snap({ todosSummary: "✓2/5", queueCount: 1 }))).toBe(
      `${FULL} · ✓2/5 · ⇥ 1 排队`,
    );
    const segs = statusSegments(snap({ todosSummary: "✓2/5" }));
    expect(segs.map((s) => s.text)).toContain("✓2/5");
    expect(segs.find((s) => s.text === "✓2/5")?.priority).toBe(35);
  });

  test("S1i 无摘要（null / undefined / 空串）不出现", () => {
    expect(renderStatus(snap({ todosSummary: null }))).toBe(FULL);
    expect(renderStatus(snap())).toBe(FULL);
    expect(renderStatus(snap({ todosSummary: "" }))).toBe(FULL);
  });

  test("S1i 窄屏可丢弃：先丢 queue(30)，再丢 todos(35)，再丢 tokens(40)", () => {
    // 全量 + 待办 = 83 + 3 + 4 = 90 列
    expect(renderStatus(snap({ todosSummary: "✓2/5", width: 90 }))).toBe(`${FULL} · ✓2/5`);
    // 93 列：全量+待办+queue = 90+3+8 = 101 > 93 → queue(30) 先丢，待办还在
    expect(renderStatus(snap({ todosSummary: "✓2/5", queueCount: 1, width: 93 }))).toBe(
      `${FULL} · ✓2/5`,
    );
    // 89 列且无 queue：todos(35) 先于 tokens(40) 被丢
    expect(renderStatus(snap({ todosSummary: "✓2/5", width: 89 }))).toBe(FULL);
  });
});

describe("S1h paint 钩子", () => {
  test("S1h 缺省 paint 是恒等（纯文本）", () => {
    expect(renderStatus(snap(), (_, text) => text)).toBe(FULL);
  });

  test("S1h paint 按角色着色，只作用于保留字段", () => {
    const painted = renderStatus(snap(), (role, text) => `<${role}>${text}`);
    expect(
      painted.startsWith("<muted>v0.4.54 · <accent>deepseek-flash · <tier>balanced · <text>ask"),
    ).toBe(true);
    expect(painted).toContain("<muted>⎇ main");
    expect(painted).toContain("<dim>ctx ▓▓░░░ 42%");
  });
});
