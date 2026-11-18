/** K01: base algorithms live only in core's built compat/v1; legacy-host DTO adaptation only. */
import { resolveContextWindow as resolveCoreWindow, type WindowSource } from "@neo/core-compat/compat/v1";
import type { ModelContextInfo } from "./env/types.ts";
export { knownWindow, isContextOverflowError, parseContextLimitFromError } from "@neo/core-compat/compat/v1";
export type { WindowSource } from "@neo/core-compat/compat/v1";
export interface ResolvedWindow {
  tokens: number;
  source: WindowSource;
  env?: ModelContextInfo;
}
/** Legacy snapshots also carry output-probe provenance; not a context-window fact source. */
function windowSourceOf(source: ModelContextInfo["source"]): Exclude<WindowSource, "default"> {
  switch (source) {
    case "config": case "models_api": case "overflow_error": case "known": return source;
    default: return "models_api";
  }
}
export function resolveContextWindow(
  configured: number, model: string, env?: ModelContextInfo | null, configuredExplicit = true,
): ResolvedWindow {
  const result = resolveCoreWindow(configured, model, env ? { ...env, source: windowSourceOf(env.source) } : env);
  // Keep the original (possibly frozen/extended) record, never the normalization copy.
  if (result.env && env) return { ...result, env };
  return { tokens: result.tokens, source: result.source === "config" && !configuredExplicit ? "default" : result.source };
}
