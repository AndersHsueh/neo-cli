/**
 * 规则分类器 —— 默认实现。
 *
 * 为什么默认不是 LLM：
 *  1. 延迟。规则是零网络往返；LLM 分类每次请求多 1~3 秒。
 *  2. 成本。分类每轮都跑。放付费模型上等于每次请求先扣一笔鉴定费。
 *  3. 可解释。规则判错时，看 reason 就知道是哪条规则的问题；
 *     LLM 判错时只能猜 —— 这在调试阶段是致命的。
 *
 * 规则按优先级从高到低评估，第一个命中即返回。
 * 每条规则都必须给出可读的 reason，否则 /why 就没有价值。
 */
import {
  escalate,
  tierRank,
  TIER_ORDER,
  type ClassifyContext,
  type ClassifyResult,
  type TierClassifier,
} from "./types.ts";
import type { ModelTier } from "../config.ts";

/** 单条规则。返回 null 表示未命中。 */
interface Rule {
  id: string;
  desc: string;
  test: (ctx: ClassifyContext) => ModelTier | null;
}

/** 显式指令：`/fast`、`/deep` 之类。优先级最高，用户说了算。 */
const OVERRIDE_PREFIX = /^\s*\/(fast|balanced|default|deep|deep_reasoning)\b/i;

function toTier(word: string): ModelTier {
  const w = word.toLowerCase();
  if (w === "deep") return "deep_reasoning";
  if (w === "fast" || w === "balanced" || w === "default") return w;
  return "default";
}

/**
 * 需要深度推理的信号。
 *
 * 刻意不用「输入长度」做启发式 —— 试过，失败：
 * 「帮我设计一个多租户的系统架构」只有 16 字但显然需要深度推理，
 * 而「解释一下这段代码」300 字却不需要。所以按词分强/弱，而不是按长度猜。
 *
 * 强信号：明确指向架构设计或根因排查，不该低于 deep。
 * 弱信号：可能只是随口一问，给 balanced 足够。
 */
const DEEP_STRONG = [
  "架构", "设计", "重构", "根因", "排查", "权衡", "迁移", "并发", "分布式",
  "选型", "取舍", "容量", "性能瓶颈", "一致性", "幂等", "事务",
  "design", "architecture", "refactor", "trade-off", "tradeoff",
];

const DEEP_WEAK = [
  "为什么", "原理", "推导", "证明", "对比", "评估", "审查", "review",
  "解释", "分析", "理解", "原理",
];

/**
 * 明确要快、不值得烧钱的信号。
 *
 * 收录标准是「句子在描述一次机械动作」，而不是「出现了某个词」。
 * 所以必须同时收「找一下」与「找所有」这类变体：
 * PRD 3.4 的示例句「用 glob 找所有 .ts 文件」若只收「找一下」就会漏判，
 * 而它显然不该走深度推理。
 */
const FAST_SIGNALS = [
  "列一下", "列下", "读一下", "读下", "看一下", "看下", "跑一下", "跑下",
  "统计", "有多少", "几个", "grep", "找一下", "查一下", "改个名", "重命名",
  "列个", "打印", "输出一下", "格式", "大小",
  // 变体：同一动作的不同说法
  "找所有", "找全部", "列出所有", "列出全部", "查所有", "查全部",
  "所有文件", "全部文件", "哪些文件", "多少个", "哪些", "搜索",
];

/** 按 n 步升档。到顶则停在最高档。 */
function escalateBy(tier: ModelTier, n: number): ModelTier {
  let cur = tier;
  for (let i = 0; i < n; i++) {
    const next = escalate(cur);
    if (tierRank(next) <= tierRank(cur)) break;
    cur = next;
  }
  return cur;
}

/**
 * 从 want 出发，向上（更高档位）找第一个可用的档位；都不可用则返回 want 本身。
 *
 * 方向必须是向上：升档意图被拒绝时，正确的回落是「留在原地或再往上」，
 * 而不是往下掉。往下降会让高难度任务落到更笨的模型上，比不升更糟。
 */
function firstAvailableAtOrAbove(ctx: ClassifyContext, want: ModelTier): ModelTier {
  if (ctx.tierAvailable(want)) return want;
  for (let i = tierRank(want) + 1; i < TIER_ORDER.length; i++) {
    const cand = TIER_ORDER[i];
    if (cand && ctx.tierAvailable(cand)) return cand;
  }
  return want;
}

const RULES: Rule[] = [
  {
    id: "override",
    desc: "用户显式指令",
    test: (ctx) => {
      const m = OVERRIDE_PREFIX.exec(ctx.userInput);
      return m?.[1] ? toTier(m[1]) : null;
    },
  },
  {
    id: "tool_failure",
    desc: "工具连续失败 — 当前档位撑不住，按失败次数升档",
    test: (ctx) => {
      if (ctx.consecutiveToolFailures < 2) return null;
      // 2 次升一档，3 次升两档。失败越多说明当前档离能解决问题越远。
      const steps = ctx.consecutiveToolFailures >= 3 ? 2 : 1;
      // 从目标档位往下找第一个可用档。必须是「向上」找 —— 失败时降档是荒谬的。
      const target = firstAvailableAtOrAbove(ctx, escalateBy(ctx.currentTier, steps));
      if (tierRank(target) <= tierRank(ctx.currentTier)) return null;
      return target;
    },
  },
  {
    id: "context_pressure",
    desc: "上下文占用高 — 需要长上下文能力",
    test: (ctx) => {
      if (ctx.contextUsage < 0.5) return null;
      const want = ctx.contextUsage >= 0.7 ? "deep_reasoning" : "balanced";
      // 同样只向上找。上下文压力大却降档，只会让压缩更快撞上阈值。
      const target = firstAvailableAtOrAbove(ctx, want);
      return tierRank(target) > tierRank(ctx.currentTier) ? target : null;
    },
  },
  {
    id: "deep_strong",
    desc: "强智力信号词 — 架构/设计/根因类",
    test: (ctx) => {
      const lower = ctx.userInput.toLowerCase();
      const hit = DEEP_STRONG.find((k) => lower.includes(k.toLowerCase()));
      if (!hit) return null;
      // deep 不可用时向上找可用替代档；一个都没有就返回 null，
      // 让后续规则继续 —— 但绝不能因此掉到 fast 之类，那比留在原地更糟。
      const target = firstAvailableAtOrAbove(ctx, "deep_reasoning");
      return tierRank(target) > tierRank(ctx.currentTier) ? target : null;
    },
  },
  {
    id: "deep_weak",
    desc: "弱智力信号词 — 为什么/分析类",
    test: (ctx) => {
      const lower = ctx.userInput.toLowerCase();
      const hit = DEEP_WEAK.find((k) => lower.includes(k.toLowerCase()));
      if (!hit) return null;
      // 弱信号先给 balanced，别为了一句「为什么」就烧付费模型。
      // 但也不能低于当前档 —— 已经在高档了就别降回去。
      if (tierRank("balanced") <= tierRank(ctx.currentTier)) return null;
      const target = firstAvailableAtOrAbove(ctx, "balanced");
      return tierRank(target) > tierRank(ctx.currentTier) ? target : null;
    },
  },
  {
    id: "fast_signal",
    desc: "机械操作信号词",
    test: (ctx) => {
      const lower = ctx.userInput.toLowerCase();
      const hit = FAST_SIGNALS.find((k) => lower.includes(k.toLowerCase()));
      if (!hit) return null;
      return ctx.tierAvailable("fast") ? "fast" : null;
    },
  },
  {
    id: "long_input",
    desc: "输入很长 — 通常意味着上下文复杂",
    test: (ctx) =>
      ctx.userInput.length > 500 && ctx.tierAvailable("balanced") ? "balanced" : null,
  },
];

/** 兜底：留在当前档位。这个实现从不主动改变用户已选的档。 */
const FALLBACK = (ctx: ClassifyContext): ClassifyResult => ({
  tier: ctx.currentTier,
  reason: "无规则命中，维持当前档位",
  source: "fallback",
});

export class RuleClassifier implements TierClassifier {
  readonly name = "rule";
  readonly explicit = false;

  /** 暴露规则表，供 /why 与测试查看。不导出以免被外部改动。 */
  static describe(): string[] {
    return RULES.map((r) => `${r.id} — ${r.desc}`);
  }

  async classify(ctx: ClassifyContext): Promise<ClassifyResult> {
    for (const rule of RULES) {
      const tier = rule.test(ctx);
      if (tier !== null && tier !== undefined) {
        const source = rule.id === "override" ? ("override" as const) : ("rule" as const);
        return {
          tier,
          reason: `${rule.desc}（规则 ${rule.id}）`,
          source,
        };
      }
    }
    return FALLBACK(ctx);
  }
}
