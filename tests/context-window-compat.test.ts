/** K01b legacy-host adapter baseline: no network, files, global env or UI. */
import { test, expect } from "bun:test";
import { resolveContextWindow, knownWindow, isContextOverflowError, parseContextLimitFromError } from "../src/contextWindow.ts";
import type { ModelContextInfo } from "../src/env/types.ts";

test("K01-C01 valid window sources preserve original env identity", () => {
  for (const source of ["config", "models_api", "overflow_error", "known"] as const) {
    const env = { contextWindow: 32768.9, source, updatedAt: "t", evidence: "fixture", vision: true as const };
    const r = resolveContextWindow(512_000, "x", env, false);
    expect(r.tokens).toBe(32768);
    expect(r.source).toBe(source);
    expect(r.env).toBe(env);
  }
});
test("K01-C02 output-only sources map to models_api without mutating env", () => {
  for (const source of ["error_evidence", "behavior_probe"] as const) {
    const env = Object.freeze({ contextWindow: 64000, source, updatedAt: "t", maxOutputTokens: 42 });
    const r = resolveContextWindow(512000, "x", env);
    expect(r.source).toBe("models_api");
    expect(r.tokens).toBe(64000);
    expect(r.env).toBe(env);
    expect(env.source).toBe(source);
  }
});
test("K01-C03 legacy missing source remains metadata, not config", () => {
  const env = { contextWindow: 32000, updatedAt: "t" } as ModelContextInfo;
  const r = resolveContextWindow(64000, "x", env, false);
  expect(r.source).toBe("models_api");
  expect(r.env).toBe(env);
});
test("K01-C04 configuredExplicit only changes configured provenance", () => {
  expect(resolveContextWindow(200000.9, "deepseek-chat", null, false)).toEqual({ tokens: 200000, source: "default" });
  expect(resolveContextWindow(200000, "x", null, true).source).toBe("config");
  const env = { contextWindow: 8192, source: "config" as const, updatedAt: "t" };
  expect(resolveContextWindow(200000, "x", env, false).source).toBe("config");
});
test("K01-C05 invalid config and env retain core precedence and values", () => {
  for (const configured of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
    const env = { contextWindow: Number.NaN, source: "behavior_probe" as const, updatedAt: "t" };
    expect(resolveContextWindow(configured, "deepseek-chat", env, false)).toEqual({ tokens: 131072, source: "known" });
    expect(resolveContextWindow(configured, "no-such-model-xyz", env, false)).toEqual({ tokens: 200000, source: "default" });
  }
});
test("K01-C06 parser and known table behavior remains available", () => {
  expect(knownWindow("gpt-4o")).toBe(128000);
  expect(knownWindow("no-such-model-xyz")).toBeNull();
  expect(parseContextLimitFromError("context window is 200k tokens")).toBe(200000);
  expect(isContextOverflowError({ message: "context length exceeded", status: 413 })).toBe(true);
});

test("K01-C07 inherited window fields preserve legacy env semantics", () => {
  const env = Object.create({ contextWindow: 32768, source: "behavior_probe", updatedAt: "t" }) as ModelContextInfo;
  const r = resolveContextWindow(512000, "unknown", env, false);
  expect(r.tokens).toBe(32768);
  expect(r.source).toBe("models_api");
  expect(r.env).toBe(env);
});
