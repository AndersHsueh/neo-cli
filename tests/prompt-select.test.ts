/**
 * 提示词档位选择（selectPromptTier）与系统开销计数（countSystemTokens）的单元测试。
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_SELECTION_CONFIG,
  FULL_MIN_WINDOW,
  STANDARD_MIN_WINDOW,
  isWindowTrusted,
  selectPromptTier,
} from "../src/prompt/select.ts";
import { countSystemTokens } from "../src/prompt/tokens.ts";
import type { ToolSpec } from "../src/llm.ts";
import type { PromptTier } from "../src/prompt/tiers.ts";

const oh = (full: number, standard: number, mini: number): Partial<Record<PromptTier, number>> => ({
  full,
  standard,
  mini,
});

const TRUSTED = "models_api" as const;

const TOOL: ToolSpec = {
  type: "function",
  function: { name: "x", description: "d", parameters: { type: "object", properties: {} } },
} as ToolSpec;

describe("selectPromptTier：阈值边界（budget-first）", () => {
  const small = oh(100, 100, 100);

  test("window=31_999 可信但 <32000 → 只能 mini", () => {
    const r = selectPromptTier({ window: 31_999, source: TRUSTED, overhead: small });
    expect(r.tier).toBe("mini");
    expect(r.fits).toBe(true);
    expect(r.budget).toBe(Math.floor(31_999 * 0.125));
  });

  test("window=32_000 → full（budget-first 放得下就用大档）", () => {
    const r = selectPromptTier({ window: STANDARD_MIN_WINDOW, source: TRUSTED, overhead: small });
    expect(r.tier).toBe("full");
    expect(r.fits).toBe(true);
  });

  test("window=127_999 → full（budget-first）", () => {
    const r = selectPromptTier({ window: 127_999, source: TRUSTED, overhead: small });
    expect(r.tier).toBe("full");
    expect(r.fits).toBe(true);
  });

  test("window=128_000 → full", () => {
    const r = selectPromptTier({ window: FULL_MIN_WINDOW, source: TRUSTED, overhead: small });
    expect(r.tier).toBe("full");
    expect(r.fits).toBe(true);
  });
});

describe("selectPromptTier：阈值边界（context-gated）", () => {
  const cfg = { selectionMode: "context-gated" as const };
  const small = oh(100, 100, 100);

  test("window=31_999 → mini", () => {
    const r = selectPromptTier({ window: 31_999, source: TRUSTED, overhead: small, config: cfg });
    expect(r.tier).toBe("mini");
    expect(r.fits).toBe(true);
  });

  test("window=32_000 → standard", () => {
    const r = selectPromptTier({ window: 32_000, source: TRUSTED, overhead: small, config: cfg });
    expect(r.tier).toBe("standard");
    expect(r.fits).toBe(true);
  });

  test("window=127_999 → standard", () => {
    const r = selectPromptTier({ window: 127_999, source: TRUSTED, overhead: small, config: cfg });
    expect(r.tier).toBe("standard");
    expect(r.fits).toBe(true);
  });

  test("window=128_000 → full", () => {
    const r = selectPromptTier({ window: 128_000, source: TRUSTED, overhead: small, config: cfg });
    expect(r.tier).toBe("full");
    expect(r.fits).toBe(true);
  });
});

describe("selectPromptTier：32768 窗口与动态开销", () => {
  // budget = floor(32768 * 0.125) = 4096
  test("budget-first：full=4953 超预算 → standard=3628", () => {
    const r = selectPromptTier({ window: 32_768, source: TRUSTED, overhead: oh(4953, 3628, 298) });
    expect(r.budget).toBe(4096);
    expect(r.tier).toBe("standard");
    expect(r.fits).toBe(true);
  });

  test("budget-first：full=3753 → full", () => {
    const r = selectPromptTier({ window: 32_768, source: TRUSTED, overhead: oh(3753, 3628, 298) });
    expect(r.tier).toBe("full");
    expect(r.fits).toBe(true);
  });

  test("context-gated：full=3753 也只到 standard", () => {
    const r = selectPromptTier({
      window: 32_768,
      source: TRUSTED,
      overhead: oh(3753, 3628, 298),
      config: { selectionMode: "context-gated" },
    });
    expect(r.tier).toBe("standard");
    expect(r.fits).toBe(true);
  });
});

describe("selectPromptTier：预算比例边界", () => {
  // window=32000 → budget=4000，full 为唯一会被比较的大档（standard/mini 设得很大）
  test("开销恰好等于预算 → 放得下", () => {
    const r = selectPromptTier({ window: 32_000, source: TRUSTED, overhead: oh(4000, 99_999, 99_999) });
    expect(r.budget).toBe(4000);
    expect(r.tier).toBe("full");
    expect(r.fits).toBe(true);
  });

  test("开销 = 预算 + 1 → 放不下", () => {
    const r = selectPromptTier({ window: 32_000, source: TRUSTED, overhead: oh(4001, 99_999, 99_999) });
    expect(r.budget).toBe(4000);
    expect(r.fits).toBe(false);
  });
});

describe("selectPromptTier：动态超预算", () => {
  test("三档都超预算 → fits=false、tier=mini、reason 含「超出预算」", () => {
    const r = selectPromptTier({ window: 32_768, source: TRUSTED, overhead: oh(9000, 8000, 7000) });
    expect(r.fits).toBe(false);
    expect(r.tier).toBe("mini");
    expect(r.reason).toContain("超出预算");
    expect(r.estimatedSystemTokens).toBe(7000);
  });
});

describe("selectPromptTier：窗口不可信", () => {
  const ov = oh(100, 100, 100);

  const cases: Array<[string, number | null | undefined]> = [
    ["undefined", undefined],
    ["null", null],
    ["NaN", Number.NaN],
    ["0", 0],
    ["-5", -5],
    ["Infinity", Number.POSITIVE_INFINITY],
  ];
  for (const [label, w] of cases) {
    test(`window=${label} → mini 且不报错，budget 使用 unknownWindowBudget`, () => {
      const r = selectPromptTier({ window: w, source: TRUSTED, overhead: ov });
      expect(r.tier).toBe("mini");
      expect(r.windowTrusted).toBe(false);
      expect(r.budget).toBe(1024);
    });
  }

  test("source=default 即使 window=200000 → mini", () => {
    const r = selectPromptTier({ window: 200_000, source: "default", overhead: ov });
    expect(r.tier).toBe("mini");
    expect(r.windowTrusted).toBe(false);
  });

  test("source=undefined → mini", () => {
    const r = selectPromptTier({ window: 200_000, source: undefined, overhead: ov });
    expect(r.tier).toBe("mini");
    expect(r.windowTrusted).toBe(false);
  });

  test("source=known 默认（trustKnownWindow=false）→ mini", () => {
    const r = selectPromptTier({ window: 200_000, source: "known", overhead: ov });
    expect(r.tier).toBe("mini");
    expect(r.windowTrusted).toBe(false);
  });

  test("source=known 且 trustKnownWindow=true → 可升到 full", () => {
    const r = selectPromptTier({
      window: 200_000,
      source: "known",
      overhead: ov,
      config: { trustKnownWindow: true },
    });
    expect(r.tier).toBe("full");
    expect(r.windowTrusted).toBe(true);
    expect(isWindowTrusted(200_000, "known", true)).toBe(true);
  });
});

describe("selectPromptTier：maxTier", () => {
  const ov = oh(100, 100, 100);

  test("maxTier=standard 即使窗口很大也不选 full", () => {
    const r = selectPromptTier({
      window: 200_000,
      source: TRUSTED,
      overhead: ov,
      config: { maxTier: "standard" },
    });
    expect(r.tier).toBe("standard");
  });

  test("maxTier=mini 只能 mini", () => {
    const r = selectPromptTier({
      window: 200_000,
      source: TRUSTED,
      overhead: ov,
      config: { maxTier: "mini" },
    });
    expect(r.tier).toBe("mini");
  });

  test("maxTier=full 不能抬高小窗口的上限（仍是 mini）", () => {
    const r = selectPromptTier({
      window: 20_000,
      source: TRUSTED,
      overhead: ov,
      config: { maxTier: "full" },
    });
    expect(r.tier).toBe("mini");
  });

  test("maxTier=full 不能抬高 context-gated 门槛（50000 仍是 standard）", () => {
    const r = selectPromptTier({
      window: 50_000,
      source: TRUSTED,
      overhead: ov,
      config: { maxTier: "full", selectionMode: "context-gated" },
    });
    expect(r.tier).toBe("standard");
  });
});

describe("selectPromptTier：minTier", () => {
  test("minTier=standard 且 standard 放不下 → tier=standard、fits=false，不降到 mini", () => {
    // window=200000 → budget=25000；full/standard 都超预算，mini 很小但不得被选
    const r = selectPromptTier({
      window: 200_000,
      source: TRUSTED,
      overhead: oh(50_000, 30_000, 100),
      minTier: "standard",
    });
    expect(r.tier).toBe("standard");
    expect(r.fits).toBe(false);
  });

  test("minTier=standard 且 standard 放得下 → standard 或更大", () => {
    const r = selectPromptTier({
      window: 200_000,
      source: TRUSTED,
      overhead: oh(50_000, 1000, 100),
      minTier: "standard",
    });
    expect(r.tier).toBe("standard");
    expect(r.fits).toBe(true);
  });
});

describe("selectPromptTier：overhead 缺档", () => {
  test("缺 full 时 full 不参与选择，standard 放得下即选 standard", () => {
    const r = selectPromptTier({ window: 200_000, source: TRUSTED, overhead: { standard: 100 } });
    expect(r.tier).toBe("standard");
    expect(r.fits).toBe(true);
  });

  test("只给 mini 时直接选 mini", () => {
    const r = selectPromptTier({ window: 200_000, source: TRUSTED, overhead: { mini: 100 } });
    expect(r.tier).toBe("mini");
    expect(r.fits).toBe(true);
  });
});

describe("selectPromptTier：默认配置", () => {
  test("DEFAULT_SELECTION_CONFIG 与文档约定一致", () => {
    expect(DEFAULT_SELECTION_CONFIG.selectionMode).toBe("budget-first");
    expect(DEFAULT_SELECTION_CONFIG.systemBudgetRatio).toBe(0.125);
    expect(DEFAULT_SELECTION_CONFIG.maxTier).toBe("full");
    expect(DEFAULT_SELECTION_CONFIG.unknownWindowBudget).toBe(8192);
    expect(DEFAULT_SELECTION_CONFIG.trustKnownWindow).toBe(false);
  });
});

describe("countSystemTokens", () => {
  test("空数组且无工具 → tokens 非负且 tokenizer 为 estimate", () => {
    const r = countSystemTokens([]);
    expect(r.tokens).toBeGreaterThanOrEqual(0);
    expect(r.tokenizer).toBe("estimate");
  });

  test("加长文本 tokens 单调增加", () => {
    const short = countSystemTokens(["abc"]).tokens;
    const long = countSystemTokens(["abc".repeat(100)]).tokens;
    const longer = countSystemTokens(["abc".repeat(1000)]).tokens;
    expect(long).toBeGreaterThan(short);
    expect(longer).toBeGreaterThan(long);
  });

  test("传入 tools 比不传更大", () => {
    const without = countSystemTokens(["hello"]).tokens;
    const withTools = countSystemTokens(["hello"], [TOOL]).tokens;
    expect(withTools).toBeGreaterThan(without);
  });

  test("1000 个中文字符的结果 ≥ 1000（保守估计）", () => {
    const r = countSystemTokens(["中".repeat(1000)]);
    expect(r.tokens).toBeGreaterThanOrEqual(1000);
  });
});
