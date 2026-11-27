/**
 * 提示词缓存（issue #95）：宿主侧对 Anthropic 请求体打 cache_control，
 * 以及命中率 / OpenAI cached_tokens 的展示口径。
 *
 * 不改 @neo/core-compat 的 buildAnthropicBody / mapUsage。
 */
import type { Usage } from "../llm/types.ts";

/** 本轮只用默认 TTL，不设 1h。 */
export const CACHE_CONTROL = { type: "ephemeral" } as const;

/** toAnthropicMessages 把中途 system 降级为 user 块时的正文前缀。 */
export const TEMP_SYSTEM_PREFIX = "[系统消息]";

/**
 * 在 buildAnthropicBody 的返回值上打最多三处断点。
 * 调用方负责只在 Anthropic 且 prompt_cache !== false 时使用。
 */
export function applyCacheControl(body: Record<string, unknown>): Record<string, unknown> {
  // 红测阶段先原样返回，让断点断言失败。
  return body;
}

/**
 * OpenAI 兼容路径：仅当响应里已有可识别的 cached_tokens 时挂到 cache_read。
 * 没有就不编造。
 */
export function enrichOpenAICacheUsage(usage: Usage): Usage {
  return usage;
}

/** cache_read / prompt_tokens；分母为 0 时写「无」。 */
export function formatCacheHit(cacheRead: number, promptTokens: number): string {
  if (promptTokens <= 0) return "无";
  return `${((cacheRead / promptTokens) * 100).toFixed(1)}%`;
}

/** 从未收到该字段时写「无」；收到且为 0 时写「0 tokens」。数字不加千分位。 */
export function formatCacheTokens(n: number | undefined, seen: boolean): string {
  if (!seen) return "无";
  return `${n ?? 0} tokens`;
}
