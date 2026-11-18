/** K01b structural ownership gate; NOT the functional red test (CW-N01 is). */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
test("K01 boundary: legacy module delegates base functions, no fallback table or regex algorithms", () => {
  const source = readFileSync(new URL("../src/contextWindow.ts", import.meta.url), "utf8");
  expect(source).toContain("@neo/core-compat/compat/v1");
  expect(source).not.toMatch(/KNOWN_WINDOWS|OVERFLOW_RE|normalizeCount|const patterns|function knownWindow|function parseContextLimitFromError|function isContextOverflowError/);
});
