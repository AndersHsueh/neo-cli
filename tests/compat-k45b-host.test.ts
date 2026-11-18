/** K45b two-host comparison: legacy adapters and the pinned archive agree on promoted leaves. */
import { describe, expect, test } from "bun:test";
import * as pack from "@neo/core-compat/compat/v1";
import {
  isParallelToolCallsRejection,
  isContextLengthErrorText,
  isMaxTokensErrorText,
  isAuthErrorText,
  parseMaxTokensLimit,
  shouldDowngradeForOpaque400,
  OPAQUE_400_DOWNGRADE_FLOOR,
} from "../src/llm/maxTokens.ts";
import { LLMError, LLMTimeoutError } from "../src/llm/types.ts";
import {
  TIER_ORDER,
  STANDARD_MIN_WINDOW,
  FULL_MIN_WINDOW,
  DEFAULT_SELECTION_CONFIG,
  isWindowTrusted,
  rank,
  selectPromptTier,
} from "../src/prompt/select.ts";
import { countSystemTokens } from "../src/prompt/tokens.ts";
import { TIER_CORE, type PromptTier } from "../src/prompt/tiers.ts";
import {
  sanitizeToolId,
  toAnthropicMessages,
  toAnthropicTools,
  buildAnthropicBody,
  mapStopReason,
  mapUsage,
  parseAnthropicMessage,
  isRetryableAnthropicError,
} from "../src/anthropicWire.ts";
import { attributeFailure, redactFallbackText } from "../src/modelFallback.ts";

describe("K45b host comparison", () => {
  test("value exports from adapters are the packaged functions/constants", () => {
    expect(isParallelToolCallsRejection).toBe(pack.isParallelToolCallsRejection);
    expect(isContextLengthErrorText).toBe(pack.isContextLengthErrorText);
    expect(isMaxTokensErrorText).toBe(pack.isMaxTokensErrorText);
    expect(isAuthErrorText).toBe(pack.isAuthErrorText);
    expect(parseMaxTokensLimit).toBe(pack.parseMaxTokensLimit);
    expect(shouldDowngradeForOpaque400).toBe(pack.shouldDowngradeForOpaque400);
    expect(OPAQUE_400_DOWNGRADE_FLOOR).toBe(pack.OPAQUE_400_DOWNGRADE_FLOOR);
    expect(selectPromptTier).toBe(pack.selectPromptTier);
    expect(isWindowTrusted).toBe(pack.isWindowTrusted);
    expect(rank).toBe(pack.rank);
    expect(countSystemTokens).toBe(pack.countSystemTokens);
    expect(TIER_ORDER).toBe(pack.TIER_ORDER);
    expect(TIER_CORE).toBe(pack.TIER_CORE);
    expect(sanitizeToolId).toBe(pack.sanitizeToolId);
    expect(toAnthropicMessages).toBe(pack.toAnthropicMessages);
    expect(buildAnthropicBody).toBe(pack.buildAnthropicBody);
    expect(mapStopReason).toBe(pack.mapStopReason);
    expect(mapUsage).toBe(pack.mapUsage);
    expect(parseAnthropicMessage).toBe(pack.parseAnthropicMessage);
    expect(isRetryableAnthropicError).toBe(pack.isRetryableAnthropicError);
    expect(attributeFailure).toBe(pack.attributeFailure);
    expect(redactFallbackText).toBe(pack.redactFallbackText);
  });

  test("legacy LLMError instances are classified and attributed through the archive", () => {
    const parsed = new LLMError("max_tokens: 100000 > 64000, which is the maximum allowed", 400);
    expect(parseMaxTokensLimit(parsed, 100000)).toBe(64000);
    expect(shouldDowngradeForOpaque400(new LLMError("opaque gateway 400", 400), 512000)).toBe(true);
    expect(isParallelToolCallsRejection(new LLMError("unknown field: parallel_tool_calls", 400))).toBe(true);
    expect(attributeFailure(new LLMError("too many requests", 429), false)?.code).toBe("rate_limit");
    expect(attributeFailure(new LLMTimeoutError("idle", 1000), false)?.code).toBe("timeout");
    expect(attributeFailure(new LLMError("invalid api key", 401), false)).toBeNull();
  });

  test("prompt select/tokens/tiers and wire conversion stay aligned", () => {
    expect(STANDARD_MIN_WINDOW).toBe(32_000);
    expect(FULL_MIN_WINDOW).toBe(128_000);
    expect(DEFAULT_SELECTION_CONFIG.maxTier).toBe("full");
    const selection = selectPromptTier({
      window: 200000,
      source: "config",
      overhead: { mini: 100, standard: 200, full: 300 },
    });
    expect(selection.tier).toBe("full");
    expect(isWindowTrusted(200000, "default", false)).toBe(false);
    expect(rank("mini")).toBe(2);
    const overhead = countSystemTokens(["hello"], []);
    expect(overhead.tokenizer).toBe("estimate");
    expect(overhead.tokens).toBeGreaterThan(0);
    const tiers: PromptTier[] = ["full", "standard", "mini"];
    for (const t of tiers) expect(TIER_CORE[t]).toContain("${sessionName}");
    expect(sanitizeToolId("ab/cd")).toBe("ab_cd");
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(isRetryableAnthropicError("overloaded_error")).toBe(true);
    expect(redactFallbackText("Bearer sk-abcdefghijklmnop https://example.com")).toContain("[REDACTED]");
    expect(toAnthropicTools([{ type: "function", function: { name: "x", description: "d", parameters: {} } }])).toEqual([
      { name: "x", description: "d", input_schema: {} },
    ]);
    const msgs = toAnthropicMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(msgs.system).toBe("sys");
    expect(msgs.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(
      buildAnthropicBody(
        { model: "m", maxTokens: 1024, temperature: 0, parallel: false },
        [{ role: "user", content: "hi" }],
        [],
        false,
      ).model,
    ).toBe("m");
    expect(parseAnthropicMessage({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }).content).toBe("ok");
    expect(mapUsage({ input_tokens: 3, output_tokens: 2 }).total_tokens).toBe(5);
    // core 已晋升的 isContextLengthErrorText 比旧侧原正则更宽；配对后以 core 为准。
    expect(isContextLengthErrorText("too many tokens in the request")).toBe(true);
  });
});
