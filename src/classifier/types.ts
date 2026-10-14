/**
 * 档位分类器接口。
 *
 * 设计意图：分类决策是一个会演进的部件 —— 规则够用时用规则，
 * 规则判不准时加 LLM，未来还可能有基于历史成功率或任务类型嵌入的分类器。
 * 这些全部收敛到同一个接口后面，agent 只依赖接口，不关心背后是谁在判。
 *
 * 关键约束：分类器自己不能用分类结果来决定用谁跑 —— 那是循环依赖。
 * 因此 LLM 分类器固定走 classifier_provider（见 config），那是外部指定的。
 */
import type { ModelTier } from "../config.ts";

/** 分类器判定所需的输入。都是廉价可得的信息，不含任何需要额外调用的数据。 */
export interface ClassifyContext {
  /** 用户的原始输入。 */
  userInput: string;
  /** 当前上下文占用率，0..1。 */
  contextUsage: number;
  /** 最近连续的工具失败次数。连续失败说明当前档位撑不住。 */
  consecutiveToolFailures: number;
  /** 当前档位。用于「升档容易、降档难」这类不对称策略。 */
  currentTier: ModelTier;
  /** 该档位是否在当前 provider 下可用。不可用时分类器应避免推荐它。 */
  tierAvailable: (tier: ModelTier) => boolean;
}

/** 分类结论。 */
export interface ClassifyResult {
  tier: ModelTier;
  /**
   * 人类可读的判定理由。
   *
   * 必须存在：规则分类器出错时，看这一句就知道是哪条规则判错了。
   * LLM 分类器出错时无从追溯，所以规则版的可解释性反而是它不可替代的优势。
   */
  reason: string;
  /** 决策来源，用于 /why 与统计。 */
  source: "override" | "rule" | "llm" | "fallback";
}

/**
 * 分类器实现。
 *
 * 实现者：
 *   - RuleClassifier（规则，零延迟零成本，当前默认）
 *   - LlmClassifier（用 classifier_model_name 判定，一次额外调用）
 */
export interface TierClassifier {
  /** 标识名，用于 /auto 选择与 /why 展示。 */
  readonly name: string;
  /** 是否为用户显式指定（显式指定的实现不会参与自动回退链）。 */
  readonly explicit: boolean;
  classify(ctx: ClassifyContext): Promise<ClassifyResult>;
}

/** 实现选择失败时的异常。 */
export class ClassifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierError";
  }
}

/** 按「难度从低到高」排序，供升档/降档时比较。 */
export const TIER_ORDER: readonly ModelTier[] = [
  "fast",
  "balanced",
  "default",
  "deep_reasoning",
];

export function tierRank(tier: ModelTier): number {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length : i;
}

/** 取更高的一档。到顶则返回原值。 */
export function escalate(tier: ModelTier): ModelTier {
  return TIER_ORDER[Math.min(tierRank(tier) + 1, TIER_ORDER.length - 1)] ?? tier;
}

/** 取更低的一档。到顶则返回原值。 */
export function descend(tier: ModelTier): ModelTier {
  return TIER_ORDER[Math.max(tierRank(tier) - 1, 0)] ?? tier;
}
