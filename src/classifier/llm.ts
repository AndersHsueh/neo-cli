/**
 * LLM 分类器 —— 可选实现。
 *
 * 存在的意义有两个：
 *  1. 规则判不准时的兜底（"分析这段代码为什么慢" 这类不含关键词但确实需要智力）。
 *  2. 验证接口设计 —— 一个真正不同的实现能跑通，说明 TierClassifier 抽象是干净的。
 *
 * 为什么不作默认：
 *  - 延迟。每轮多 1~3 秒网络往返。
 *  - 成本。每轮都跑。放付费模型上等于每次请求先扣一笔鉴定费。
 *  - 不可解释。判错时无法追溯到具体依据，调试期几乎无法使用。
 *
 * 因此默认走 RuleClassifier；要开这个得显式 /auto llm。
 *
 * 无环保证：本分类器固定使用 classifier_provider + classifier_model，
 * 由配置外部指定，绝不使用分类结果来决定自己跑在哪。
 */
import type { Config } from "../config.ts";
import { chat, LLMError, type Message } from "../llm.ts";
import {
  isModelTier,
  type ModelTier,
} from "../config.ts";
import type { ClassifyContext, ClassifyResult, TierClassifier } from "./types.ts";
import { TIER_ORDER } from "./types.ts";

const SYSTEM = `你是请求难度分类器。只输出一个词，不要任何解释。
可选值：${TIER_ORDER.join("、")}

判据：
- fast：机械操作。列文件、读文件、跑命令、改字符串、查数量。无需推理。
- balanced：常规开发。写常规功能、改局部代码、解释短概念。
- default：默认档。不确定时的安全选择。
- deep_reasoning：需要深度推理。架构设计、根因排查、复杂权衡、多方案对比。

只输出一个词。`;

export class LlmClassifier implements TierClassifier {
  readonly name = "llm";
  readonly explicit = false;

  constructor(
    private readonly cfg: Config,
    /**
     * 判定超时。分类器不值得等太久，超时就用兜底。
     */
    private readonly timeoutMs = 8000,
  ) {}

  async classify(ctx: ClassifyContext): Promise<ClassifyResult> {
    // 不可用的档位先从候选里剔除，避免分类器推荐一个跑不通的档
    const candidates = TIER_ORDER.filter(ctx.tierAvailable);
    if (candidates.length === 0) {
      return this.hold(ctx, "没有可用档位，维持当前");
    }

    const hint = this.buildHint(ctx);
    const messages: Message[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: hint },
    ];

    // 用独立的临时配置：固定 classifier_provider + classifier_model，
    // 不受当前档位影响（这正是打破循环依赖的地方）。
    const callCfg: Config = {
      ...this.cfg,
      providerName: this.cfg.classifierProvider,
      baseUrl:
        this.cfg.providers.find((p) => p.name === this.cfg.classifierProvider)?.baseUrl ??
        this.cfg.baseUrl,
      apiKey:
        this.cfg.providers.find((p) => p.name === this.cfg.classifierProvider)?.apiKey ??
        this.cfg.apiKey,
      model: this.cfg.classifierModel,
      // 推理模型（glm-5.3-flash 等）会先输出思维链，正文排在后面。
      // 预算给太小会出现「只有 reasoning、content 为空」—— 实测 16 不够，
      // 因为思维链本身就要几十 token。这里给足冗余。
      maxTokens: 512,
      temperature: 0,
    };

    try {
      const res = await withTimeout(chat(callCfg, messages), this.timeoutMs);
      const parsed = this.parse(res.content, candidates);
      if (parsed) {
        return {
          tier: parsed,
          reason: `LLM 判定（${this.cfg.classifierProvider}/${this.cfg.classifierModel}）`,
          source: "llm",
        };
      }
      return this.hold(ctx, `LLM 输出无法解析: ${res.content.trim().slice(0, 40) || "(空)"}`);
    } catch (e) {
      // 分类失败绝不能让整个请求失败 —— 这是个优化层，不是必需品。
      // 兜底必须是「当前档」而不是某个固定档：正在 deep_reasoning 时判错，
      // 掉回 default 等于用更笨的模型硬扛难题，比不分类更糟。
      const msg = e instanceof LLMError ? e.message : (e as Error).message;
      return this.hold(ctx, `LLM 分类失败，回落当前档: ${msg.slice(0, 60)}`);
    }
  }

  /** 兜底：留在当前档位。任何失败路径都走这里，绝不主动往下掉。 */
  private hold(ctx: ClassifyContext, why: string): ClassifyResult {
    return { tier: ctx.currentTier, reason: why, source: "fallback" };
  }

  /**
   * 解析时把 reasoning_content 也纳入考虑。
   * 推理模型有时把答案放在思维链末尾而 content 为空，
   * 只看 content 会误判成「无法解析」。
   */
  private parse(raw: string, candidates: readonly ModelTier[]): ModelTier | null {
    for (const haystack of [raw]) {
      const text = haystack.toLowerCase();
      for (const c of candidates) {
        if (text.includes(c)) return c;
      }
      // deep 是 deep_reasoning 的简写
      if (text.includes("deep") && candidates.includes("deep_reasoning")) return "deep_reasoning";
    }
    return null;
  }

  private buildHint(ctx: ClassifyContext): string {
    const parts = [`请求：${truncate(ctx.userInput, 600)}`];
    if (ctx.consecutiveToolFailures > 0) {
      parts.push(`最近工具连续失败 ${ctx.consecutiveToolFailures} 次，说明当前档位可能不够。`);
    }
    if (ctx.contextUsage > 0.4) {
      parts.push(`上下文已用 ${(ctx.contextUsage * 100).toFixed(0)}%。`);
    }
    parts.push(`可选档位：${TIER_ORDER.filter(ctx.tierAvailable).join("、")}`);
    return parts.join("\n");
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 给 promise 加超时。分类器不值得让整轮请求干等。 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超时 ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { isModelTier };
