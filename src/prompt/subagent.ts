/**
 * 子代理系统提示词（issue #20）。
 *
 * 与主代理共享同义安全核心，但默认 mini：子代理独立上下文、任务短，不该继承主代理的长度。
 * 档位按子代理**实际选中的**模型窗口计预算，不复用主代理的窗口。
 * 升级只是约束细化，不增加权限；放不下要求的档位时返回 fits=false，由调用方收窄任务，而不是降低控制要求。
 */
import type { WindowSource } from "../contextWindow.ts";
import type { ToolSpec } from "../llm.ts";
import { renderSubagentCore } from "./render.ts";
import { DEFAULT_SELECTION_CONFIG, TIER_ORDER, selectPromptTier, type PromptSelection, type PromptSelectionConfig } from "./select.ts";
import type { PromptTier } from "./tiers.ts";
import { countSystemTokens } from "./tokens.ts";

/** task 工具的 prompt_tier 参数：auto = mini。 */
export type SubPromptTierRequest = "auto" | "standard" | "full";

export function normalizePromptTierRequest(v: unknown): SubPromptTierRequest | null {
  if (v === undefined || v === null || v === "") return "auto";
  return v === "auto" || v === "standard" || v === "full" ? v : null;
}

/** 任务措辞里出现这些信号时，宿主要求至少 standard（高后果/长自治）。 */
const HIGH_STAKES_WORDS = [
  "删除", "清理", "覆盖", "重写", "迁移", "回滚", "强推", "发布", "部署", "生产", "提交并推送",
  "delete", "remove", "overwrite", "rewrite", "migrate", "rollback", "force", "publish", "deploy", "production", "push",
];

export function requiredMinTier(taskText: string): PromptTier {
  const lower = taskText.toLowerCase();
  return HIGH_STAKES_WORDS.some((w) => lower.includes(w.toLowerCase())) ? "standard" : "mini";
}

function rank(t: PromptTier): number {
  return TIER_ORDER.indexOf(t);
}

export interface SubPromptInput {
  /** 派出它的主会话名（不是后端模型名）。 */
  parentSessionName: string | null | undefined;
  /** 子代理实际使用的窗口与来源（applyTier 之后的 cfg）。 */
  window: number | null | undefined;
  source: WindowSource | undefined;
  /** 子代理工具集 schema，计入开销。 */
  tools: readonly ToolSpec[];
  /** 子代理的报告格式/环境/任务等动态正文（不含核心）。 */
  dynamicBody: string;
  request: SubPromptTierRequest;
  taskText: string;
  config?: Partial<PromptSelectionConfig>;
}

export interface SubPromptResult {
  text: string;
  selection: PromptSelection;
  /** 要求的最低档（由请求与任务措辞共同决定）。 */
  requiredTier: PromptTier;
}

export function renderSubagentPrompt(input: SubPromptInput): SubPromptResult {
  const requested: PromptTier = input.request === "auto" ? "mini" : input.request;
  const auto = requiredMinTier(input.taskText);
  // 取更大的一档：主代理请求与宿主规则任一要求更高，就按更高的来。
  const required = rank(requested) <= rank(auto) ? requested : auto;

  const compose = (t: PromptTier): string => `${renderSubagentCore(t, input.parentSessionName)}\n\n${input.dynamicBody}`;
  const overhead: Partial<Record<PromptTier, number>> = {};
  for (const t of TIER_ORDER) overhead[t] = countSystemTokens([compose(t)], input.tools).tokens;

  const cfg = { ...DEFAULT_SELECTION_CONFIG, ...input.config };
  // 子代理的上限就是它被要求的档：auto 请求只会到 mini，不会因窗口大而自动升大档。
  const selection = selectPromptTier({
    window: input.window,
    source: input.source,
    overhead,
    minTier: required,
    config: { ...cfg, maxTier: required },
  });
  return { text: compose(selection.tier), selection, requiredTier: required };
}
