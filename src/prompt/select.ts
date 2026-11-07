/**
 * 提示词档位选择（纯函数，不碰文件/网络/配置）。
 *
 * 由宿主确定性地按「有效窗口 + 完整系统开销」选最大放得下的一档，不让模型自己猜。
 * 规则出处：bot-comments/tier-selection.md §3–§5。
 */
import type { WindowSource } from "../contextWindow.ts";
import type { PromptTier } from "./tiers.ts";

export const TIER_ORDER: readonly PromptTier[] = ["full", "standard", "mini"];

/** 十进制门槛：服务端声称 128,000 时不能被 131,072 门槛误降。 */
export const STANDARD_MIN_WINDOW = 32_000;
export const FULL_MIN_WINDOW = 128_000;

export type SelectionMode = "budget-first" | "context-gated";

export interface PromptSelectionConfig {
  selectionMode: SelectionMode;
  /** 系统开销占窗口的比例上限，建议 0.10–0.15。 */
  systemBudgetRatio: number;
  /** 档位上限（能力评测/人工约束）；默认 full 即不限。 */
  maxTier: PromptTier;
  /** 完全未知窗口时的保守规划假设，不代表真实窗口至少这么大。 */
  unknownWindowBudget: number;
  /** 是否信任已知模型表（known）命中的窗口。默认 false：它不是部署事实。 */
  trustKnownWindow: boolean;
}

export const DEFAULT_SELECTION_CONFIG: Readonly<PromptSelectionConfig> = {
  selectionMode: "budget-first",
  systemBudgetRatio: 0.125,
  maxTier: "full",
  unknownWindowBudget: 8192,
  trustKnownWindow: false,
};

export interface SelectInput {
  /** 有效上下文窗口；缺失/NaN/非正数视为未知。 */
  window: number | null | undefined;
  source: WindowSource | undefined;
  /**
   * 各档的完整系统开销估计（核心 + 动态块 + 工具 schema + 封装）。
   * 必须是同一份动态内容下的三档结果；缺某一档则该档不参与选择。
   */
  overhead: Partial<Record<PromptTier, number>>;
  /** 子代理等场景要求的最低档；放不下时返回 overBudget 而不是降档。 */
  minTier?: PromptTier;
  config?: Partial<PromptSelectionConfig>;
}

export interface PromptSelection {
  tier: PromptTier;
  /** 选中档的开销是否在预算内；false = 连 mini/最低档都放不下，调用方须收窄工具或报告。 */
  fits: boolean;
  reason: string;
  window: number | null;
  windowTrusted: boolean;
  source: WindowSource | undefined;
  budget: number;
  estimatedSystemTokens: number | null;
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** 窗口是否可信用于升档：default 永不可信；known 取决于配置；其余来源须为正有限数。 */
export function isWindowTrusted(
  window: number | null | undefined,
  source: WindowSource | undefined,
  trustKnown: boolean,
): boolean {
  if (!isPositiveFinite(window)) return false;
  if (source === undefined || source === "default") return false;
  if (source === "known") return trustKnown;
  return true;
}

/** 窗口门槛允许的最大档（context-gated 与小窗口默认 mini 共用）。 */
function gateMaxTier(window: number): PromptTier {
  if (window >= FULL_MIN_WINDOW) return "full";
  if (window >= STANDARD_MIN_WINDOW) return "standard";
  return "mini";
}

function rank(t: PromptTier): number {
  return TIER_ORDER.indexOf(t);
}

export function selectPromptTier(input: SelectInput): PromptSelection {
  const cfg: PromptSelectionConfig = { ...DEFAULT_SELECTION_CONFIG, ...input.config };
  const minTier = input.minTier ?? "mini";
  const trusted = isWindowTrusted(input.window, input.source, cfg.trustKnownWindow);
  const window = isPositiveFinite(input.window) ? Math.floor(input.window) : null;

  // 未知/不可信窗口：只做保守规划预算，且不允许升到 mini 以上。
  const effective = trusted && window !== null ? window : cfg.unknownWindowBudget;
  const budget = Math.floor(effective * cfg.systemBudgetRatio);

  // 窗口小于 32,000（含可信小窗口）默认 mini；不可信一律 mini。
  let ceiling: PromptTier = trusted && window !== null ? gateMaxTier(window) : "mini";
  // budget-first 在 32,000–127,999 仍允许先试 full；context-gated 严格按门槛。
  if (trusted && window !== null && cfg.selectionMode === "budget-first" && window >= STANDARD_MIN_WINDOW) {
    ceiling = "full";
  }
  // maxTier 只能压低上限，不能抬高（rank 越大档越小）。
  if (rank(cfg.maxTier) > rank(ceiling)) ceiling = cfg.maxTier;
  // minTier 是下限要求：不能被上限压到 minTier 以下；放不下由 fits=false 暴露。
  if (rank(ceiling) > rank(minTier)) ceiling = minTier;

  const modeNote = `${cfg.selectionMode}，窗口${trusted ? `${window}（${input.source}）` : "未证实"}`;
  const candidates = TIER_ORDER.filter((t) => rank(t) >= rank(ceiling) && rank(t) <= rank(minTier));
  for (const t of candidates) {
    const cost = input.overhead[t];
    if (cost === undefined) continue;
    if (cost <= budget) {
      return {
        tier: t,
        fits: true,
        reason: `${modeNote}；${t} 开销 ${cost} ≤ 预算 ${budget}`,
        window,
        windowTrusted: trusted,
        source: input.source,
        budget,
        estimatedSystemTokens: cost,
      };
    }
  }

  // 一档都放不下：返回候选里最小的一档并标 fits=false，不静默截断核心。
  const fallback = candidates[candidates.length - 1] ?? minTier;
  const cost = input.overhead[fallback] ?? null;
  return {
    tier: fallback,
    fits: false,
    reason: `${modeNote}；${fallback} 开销 ${cost ?? "未知"} 超出预算 ${budget}，需裁减动态资料或收窄工具`,
    window,
    windowTrusted: trusted,
    source: input.source,
    budget,
    estimatedSystemTokens: cost,
  };
}
