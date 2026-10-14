/**
 * 分类器注册表与选择。
 *
 * agent 只依赖 TierClassifier 接口，不知道背后是谁在判。
 * 新增实现只需在这里注册一行 —— 这正是做成接口而非 if/else 的收益。
 */
import type { Config, ModelTier } from "../config.ts";
import { RuleClassifier } from "./rules.ts";
import { LlmClassifier } from "./llm.ts";
import { ClassifierError, type ClassifyContext, type ClassifyResult, type TierClassifier } from "./types.ts";

export type ClassifierName = "off" | "rule" | "llm";

export const CLASSIFIER_NAMES: readonly ClassifierName[] = ["off", "rule", "llm"];

export function isClassifierName(v: string): v is ClassifierName {
  return (CLASSIFIER_NAMES as readonly string[]).includes(v);
}

function build(name: ClassifierName, cfg: Config): TierClassifier {
  switch (name) {
    case "off":
      // off 也实现接口：它是个「永远维持当前档」的分类器，而不是 if 特判。
      // 这样调用方不必为它写分支。
      return {
        name: "off",
        explicit: true,
        async classify(ctx) {
          return { tier: ctx.currentTier, reason: "自动分类已关闭", source: "fallback" as const };
        },
      };
    case "rule":
      return new RuleClassifier();
    case "llm":
      return new LlmClassifier(cfg);
    default:
      throw new ClassifierError(`未知分类器 "${name}"。可选：${CLASSIFIER_NAMES.join(", ")}`);
  }
}

/**
 * 分类执行器。
 *
 * 持有当前启用的分类器，并记录最近一次判定供 /why 查看。
 * 任何异常都被吞掉并转为「维持当前档」—— 分类是优化层，绝不能让它拖垮主流程。
 */
export class Classifier {
  private impl: TierClassifier;
  private last: ClassifyResult | null = null;
  private lastError: string | null = null;

  constructor(
    private cfg: Config,
    public enabled: ClassifierName = "rule",
  ) {
    this.impl = build(enabled, cfg);
  }

  get name(): ClassifierName {
    return this.enabled;
  }

  /** 切换实现。cfg 会变（provider 改了），所以重建。 */
  use(name: ClassifierName, cfg?: Config): void {
    if (!isClassifierName(name)) {
      throw new ClassifierError(`未知分类器 "${name}"。可选：${CLASSIFIER_NAMES.join(", ")}`);
    }
    this.enabled = name;
    this.impl = build(name, cfg ?? this.cfg);
  }

  /** 最近一次判定，供 /why 展示。 */
  get lastResult(): ClassifyResult | null {
    return this.last;
  }

  get lastFailure(): string | null {
    return this.lastError;
  }

  /**
   * 执行分类。返回 null 表示「不需要切档」。
   *
   * 判定结果不等于目标时调用方才需要动。
   */
  async classify(input: string, currentTier: ModelTier, contextUsage: number, consecutiveToolFailures: number): Promise<ClassifyResult | null> {
    if (this.enabled === "off") return null;

    const ctx: ClassifyContext = {
      userInput: input,
      contextUsage,
      consecutiveToolFailures,
      currentTier,
      tierAvailable: (t) => {
        const route = this.cfg.routes[t];
        if (!route) return false;
        const p = this.cfg.providers.find((x) => x.name === route.provider);
        // 这里只判断「配置上存在且 provider 已声明类型」，
        // 协议是否已接入由 applyTier 决定并负责降级。
        return p !== undefined;
      },
    };

    try {
      const r = await this.impl.classify(ctx);
      this.last = r;
      this.lastError = null;
      return r;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.last = {
        tier: currentTier,
        reason: `分类失败，维持当前档：${(e as Error).message}`,
        source: "fallback",
      };
      return null;
    }
  }
}

export { RuleClassifier, LlmClassifier };
export type { ClassifyContext, ClassifyResult, TierClassifier };
