/**
 * 输出上限（max_tokens）学习：从 400/422 文案解析上限、夹紧重发、不透明 400 降级。
 *
 * 分类/夹紧纯函数已晋升到 `@neo/core-compat/compat/v1`；本文件只保留
 * learned Map、handler 与提示副作用。
 */
import type { Config } from "../config.ts";
import { LLMError } from "./types.ts";
import {
  isParallelToolCallsRejection,
  isAuthErrorText,
  isMaxTokensErrorText,
} from "@neo/core-compat/compat/v1";
export {
  isParallelToolCallsRejection,
  isContextLengthErrorText,
  isMaxTokensErrorText,
  isAuthErrorText,
  parseMaxTokensLimit,
  OPAQUE_400_DOWNGRADE_FLOOR,
  shouldDowngradeForOpaque400,
} from "@neo/core-compat/compat/v1";

/** 已学到的输出上限（key = provider|baseUrl|model）。 */
export const learnedMaxTokens = new Map<string, number>();

/**
 * 400/422 报错文案的 max_tokens 提示行（issue #21 C）。
 * 不改写原始文案，只追加一行；鉴权类错误不加（与 max_tokens 无关，加了误导）。
 */
export function appendMaxTokensHint(err: LLMError): void {
  if (err.status !== 400 && err.status !== 422) return;
  if (isParallelToolCallsRejection(err)) return;
  const text = `${err.message}\n${err.body ?? ""}`;
  if (isAuthErrorText(text)) return;
  if (isMaxTokensErrorText(text)) return;
  err.message = `${err.message}\n（提示：部分网关对过大的 max_tokens 会回不透明的 400；若持续失败请检查 settings.json 里该 provider 的 max_tokens 配置。）`;
}

export function maxTokensKey(cfg: Config): string {
  return `${cfg.providerName}|${cfg.baseUrl}|${cfg.model}`;
}

/** 本次请求实际使用的 max_tokens：已学到上限的，夹到上限以内。 */
export function effectiveMaxTokens(cfg: Config): number {
  const learned = learnedMaxTokens.get(maxTokensKey(cfg));
  return learned !== undefined ? Math.min(cfg.maxTokens, learned) : cfg.maxTokens;
}

/** 测试用：清空已学到的输出上限。 */
export function resetLearnedMaxTokens(): void {
  learnedMaxTokens.clear();
}

/**
 * 「从报错里学到精确输出上限」的监听器（issue #8 A：免费证据入账）。
 *
 * 请求层只负责发请求与夹紧重发，**落盘归 env 层**，所以这里只回调、不写文件。
 * 监听器由入口（index.ts）注册一次；测试或库场景不注册就等于全关 —— 与今天行为一致。
 * 监听器抛错一律吞掉：入账是增强项，绝不能让一次写盘失败把用户请求搞挂。
 */
export interface MaxTokensLimitLearned {
  cfg: Config;
  /** 解析出的精确上限。 */
  limit: number;
  /** 被服务端拒掉的那个预算（本次实际发送值）。 */
  sent: number;
  /** 原始报错文案片段（落 env 事作用，已截断）。 */
  evidence: string;
}

let maxTokensLimitLearnedHandler: ((ev: MaxTokensLimitLearned) => void) | null = null;

export function setMaxTokensLimitLearnedHandler(
  fn: ((ev: MaxTokensLimitLearned) => void) | null,
): void {
  maxTokensLimitLearnedHandler = fn;
}

export function resetMaxTokensLimitLearnedHandler(): void {
  maxTokensLimitLearnedHandler = null;
}

export function announceLearnedLimit(cfg: Config, limit: number, sent: number, err: unknown): void {
  const handler = maxTokensLimitLearnedHandler;
  if (!handler) return;
  const text =
    err instanceof LLMError ? `${err.message}${err.body ? ` | ${err.body}` : ""}` : String(err);
  try {
    handler({ cfg, limit, sent, evidence: text.slice(0, 300) });
  } catch {
    /* 入账失败不影响请求 */
  }
}

