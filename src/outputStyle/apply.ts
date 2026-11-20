/**
 * 把本会话的 outputStyle 切到指定名称（issue #73）。不写任何配置文件。
 */
import { normalizeBuiltinOutputStyle } from "./builtin.ts";
import { defaultStyleHome, discoverOutputStyles, matchOutputStyle } from "./discover.ts";
import { keepCodingInstructionsNotice } from "./render.ts";
import type { OutputStyle, OutputStyleHost } from "./types.ts";

export type ApplyOutputStyleResult =
  | { ok: true; style: OutputStyle; notices: string[] }
  | { ok: false; error: string };

export function applyOutputStyle(
  cfg: OutputStyleHost,
  name: string,
  opts: { home?: string } = {},
): ApplyOutputStyleResult {
  const home = opts.home ?? defaultStyleHome();
  const found = discoverOutputStyles({ cwd: cfg.cwd, home });
  const matched = matchOutputStyle(name, found.styles);
  if (!matched) {
    const available = found.styles.map((s) => s.name).join(", ");
    return { ok: false, error: `未知输出风格 "${name}"。可用风格：${available}` };
  }
  const canon = normalizeBuiltinOutputStyle(matched.name) ?? matched.name;
  const style: OutputStyle = { ...matched, name: canon };
  cfg.outputStyle = canon;
  const notices: string[] = [];
  const keep = keepCodingInstructionsNotice(style);
  if (keep) notices.push(keep);
  notices.push(...found.diagnostics);
  return { ok: true, style, notices };
}
