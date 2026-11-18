/** K45b structural ownership gate: promoted pure leaves must not keep a second algorithm. */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

test("K45b boundary: prompt select/tokens/tiers delegate to compat/v1", () => {
  for (const rel of ["../src/prompt/select.ts", "../src/prompt/tokens.ts", "../src/prompt/tiers.ts"]) {
    const source = read(rel);
    expect(source).toContain("@neo/core-compat/compat/v1");
    expect(source).not.toMatch(/export function (selectPromptTier|isWindowTrusted|rank|countSystemTokens)\b/);
    expect(source).not.toMatch(/export const TIER_CORE/);
    expect(source).not.toMatch(/FULL_CORE|STANDARD_CORE|MINI_CORE|CJK_RE|MESSAGE_OVERHEAD/);
  }
});

test("K45b boundary: maxTokens classify/clamp delegates, state stays local", () => {
  const source = read("../src/llm/maxTokens.ts");
  expect(source).toContain("@neo/core-compat/compat/v1");
  expect(source).not.toMatch(/export function (isParallelToolCallsRejection|isContextLengthErrorText|isMaxTokensErrorText|isAuthErrorText|parseMaxTokensLimit|shouldDowngradeForOpaque400)\b/);
  expect(source).not.toMatch(/export const OPAQUE_400_DOWNGRADE_FLOOR/);
  // stateful symbols remain local, not imported as the unique algorithm.
  expect(source).toMatch(/export const learnedMaxTokens/);
  expect(source).toMatch(/export function (appendMaxTokensHint|effectiveMaxTokens|announceLearnedLimit)\b/);
});

test("K45b boundary: anthropic wire conversion delegates; accumulator stays", () => {
  const source = read("../src/anthropicWire.ts");
  expect(source).toContain("@neo/core-compat/compat/v1");
  expect(source).not.toMatch(/export function (sanitizeToolId|toAnthropicMessages|toAnthropicTools|buildAnthropicBody|mapStopReason|mapUsage|parseAnthropicMessage|isRetryableAnthropicError)\b/);
  expect(source).toMatch(/export class AnthropicStreamAccumulator/);
});

test("K45b boundary: fallback attribution delegates; controller stays", () => {
  const source = read("../src/modelFallback.ts");
  expect(source).toContain("@neo/core-compat/compat/v1");
  expect(source).not.toMatch(/export function (redactFallbackText|attributeFailure)\b/);
  expect(source).not.toMatch(/function explicitModelLevel/);
  expect(source).toMatch(/export class ModelFallbackController/);
});
