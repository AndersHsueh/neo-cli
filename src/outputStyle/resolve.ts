/**
 * 配置字段接线（issue #73）。供 loadConfig 一行展开，不在 config.ts 里写业务。
 */
import { builtinOutputStyles, normalizeBuiltinOutputStyle } from "./builtin.ts";
import { defaultStyleHome, discoverOutputStyles, matchOutputStyle } from "./discover.ts";
import type { OutputStyle, ResolveOutputStyleResult } from "./types.ts";

export function resolveOutputStyleConfig(
  raw: Record<string, unknown> | undefined,
  opts: { cwd: string; home?: string },
): ResolveOutputStyleResult {
  const value = raw?.["outputStyle"];
  if (value === undefined || value === null || String(value).trim() === "") {
    return { outputStyle: "Default", outputStyleWarnings: [] };
  }
  const query = String(value).trim();
  const home = opts.home ?? defaultStyleHome();
  const found = discoverOutputStyles({ cwd: opts.cwd, home });
  const matched = matchOutputStyle(query, found.styles);
  if (matched) {
    const name = normalizeBuiltinOutputStyle(matched.name) ?? matched.name;
    return { outputStyle: name, outputStyleWarnings: [] };
  }
  const available = found.styles.map((s) => s.name).join(", ");
  return {
    outputStyle: "Default",
    outputStyleWarnings: [`未知的 outputStyle "${query}"，已回退为 Default。可用风格：${available}`],
  };
}

export function activeOutputStyle(
  cfg: { cwd: string; outputStyle?: string },
  home = defaultStyleHome(),
): OutputStyle {
  const query = cfg.outputStyle ?? "Default";
  const found = discoverOutputStyles({ cwd: cfg.cwd, home });
  const matched = matchOutputStyle(query, found.styles);
  if (matched) {
    const canon = normalizeBuiltinOutputStyle(matched.name);
    return canon ? { ...matched, name: canon } : matched;
  }
  return builtinOutputStyles()[0]!;
}
