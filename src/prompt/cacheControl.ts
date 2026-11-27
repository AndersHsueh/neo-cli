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

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function withCache<T extends Record<string, unknown>>(block: T): T & { cache_control: typeof CACHE_CONTROL } {
  return { ...block, cache_control: CACHE_CONTROL };
}

function isTrailingTempUser(msg: unknown): boolean {
  if (!isRecord(msg) || msg["role"] !== "user") return false;
  const content = msg["content"];
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => isRecord(b) && typeof b["text"] === "string" && b["text"].startsWith(TEMP_SYSTEM_PREFIX),
  );
}

/**
 * 在 buildAnthropicBody 的返回值上打最多三处断点。
 * 调用方负责只在 Anthropic 且 prompt_cache !== false 时使用。
 */
export function applyCacheControl(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };

  if (typeof out["system"] === "string" && out["system"].length > 0) {
    out["system"] = [withCache({ type: "text", text: out["system"] })];
  } else if (Array.isArray(out["system"]) && out["system"].length > 0) {
    const sys = out["system"].map((b) => (isRecord(b) ? { ...b } : b));
    const last = sys[sys.length - 1];
    if (isRecord(last)) sys[sys.length - 1] = withCache(last);
    out["system"] = sys;
  }

  if (Array.isArray(out["tools"]) && out["tools"].length > 0) {
    const tools = out["tools"].map((t) => (isRecord(t) ? { ...t } : t));
    const last = tools[tools.length - 1];
    if (isRecord(last)) tools[tools.length - 1] = withCache(last);
    out["tools"] = tools;
  }

  if (Array.isArray(out["messages"]) && out["messages"].length > 0) {
    const messages = out["messages"].map((m) => {
      if (!isRecord(m)) return m;
      const content = Array.isArray(m["content"])
        ? m["content"].map((b) => (isRecord(b) ? { ...b } : b))
        : m["content"];
      return { ...m, content };
    });
    let i = messages.length - 1;
    while (i >= 0 && isTrailingTempUser(messages[i])) i--;
    if (i >= 0 && isRecord(messages[i])) {
      const content = messages[i]["content"];
      if (Array.isArray(content) && content.length > 0) {
        const last = content[content.length - 1];
        if (isRecord(last)) content[content.length - 1] = withCache(last);
      }
    }
    out["messages"] = messages;
  }

  return out;
}

/**
 * OpenAI 兼容路径：仅当响应里已有可识别的 cached_tokens 时挂到 cache_read。
 * 没有就不编造。
 */
export function enrichOpenAICacheUsage(usage: Usage): Usage {
  if (typeof usage.cache_read_input_tokens === "number" || typeof usage.cache_creation_input_tokens === "number") {
    return usage;
  }
  const details = usage.prompt_tokens_details;
  if (details && typeof details.cached_tokens === "number") {
    return { ...usage, cache_read_input_tokens: details.cached_tokens };
  }
  return usage;
}

/** 从一次 usage 取出 cache 读写；缺省字段不记为 0。 */
export function cacheUsageParts(usage: Usage): { creation: number; read: number; creationSeen: boolean; readSeen: boolean; seen: boolean } {
  const creationSeen = typeof usage.cache_creation_input_tokens === "number";
  const readSeen = typeof usage.cache_read_input_tokens === "number";
  return {
    creation: creationSeen ? usage.cache_creation_input_tokens! : 0,
    read: readSeen ? usage.cache_read_input_tokens! : 0,
    creationSeen,
    readSeen,
    seen: creationSeen || readSeen,
  };
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

export function formatCostCacheLines(cum: {
  prompt: number;
  cacheCreation: number;
  cacheRead: number;
  cacheFieldsSeen: boolean;
  cacheCreationSeen?: boolean;
  cacheReadSeen?: boolean;
}): { write: string; read: string; hit: string } {
  if (!cum.cacheFieldsSeen) {
    return { write: "无", read: "无", hit: "无" };
  }
  const writeSeen = cum.cacheCreationSeen ?? true;
  const readSeen = cum.cacheReadSeen ?? true;
  return {
    write: formatCacheTokens(cum.cacheCreation, writeSeen),
    read: formatCacheTokens(cum.cacheRead, readSeen),
    hit: formatCacheHit(cum.cacheRead, cum.prompt),
  };
}

export function formatContextCacheHit(
  last: { promptTokens: number; cacheReadTokens: number; cacheFieldsSeen: boolean } | null,
): { value: string; showLastHint: boolean } {
  if (!last || !last.cacheFieldsSeen || last.promptTokens <= 0) {
    return { value: "无", showLastHint: false };
  }
  return { value: formatCacheHit(last.cacheReadTokens, last.promptTokens), showLastHint: true };
}
