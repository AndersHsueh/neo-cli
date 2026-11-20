/**
 * 风格段渲染、持久化提示与 keep-coding-instructions 提示（issue #73）。
 */
import { normalizeBuiltinOutputStyle } from "./builtin.ts";
import type { OutputStyle, OutputStyleOption } from "./types.ts";
import { builtinHint } from "./builtin.ts";

export function renderStyleSection(style: OutputStyle): string {
  if (normalizeBuiltinOutputStyle(style.name) === "Default") return "";
  const body = style.body.trim();
  const heading = `## 输出风格（${style.name}）`;
  return body === "" ? `\n\n${heading}` : `\n\n${heading}\n\n${body}`;
}

export function persistOutputStyleHint(settingsPath: string | null): string {
  const loaded = settingsPath
    ? `当前已加载的那份配置（${settingsPath}）`
    : "当前已加载的那份（cfg.settingsPath，常常是 ~/.neo/settings.json）";
  return (
    `要持久化请在已经存在的工作区 settings.json，或${loaded}写入 outputStyle` +
    `（内置值用 PascalCase 专名：Default、Proactive、Concise、Explanatory、Learning）。` +
    `neo 是「第一份存在的候选文件全赢」（settingsPath.ts / loadConfig），` +
    `不是字段级 workspace-over-user 合并；不要为这个字段新建一份工作区 settings.json，` +
    `否则下次启动会把用户级 providers 盖掉。`
  );
}

export function keepCodingInstructionsNotice(style: OutputStyle): string | null {
  if (style.keepCodingInstructions === false) return "本轮仍保留核心";
  return null;
}

export function buildOutputStyleOptions(
  styles: readonly OutputStyle[],
  current: string,
): OutputStyleOption[] {
  const currentCanon = current.trim();
  return styles.map((s) => {
    const base = builtinHint(s.name) || s.description || "";
    const on =
      s.name === currentCanon || s.name.toLowerCase() === currentCanon.toLowerCase();
    return {
      label: s.name,
      hint: on ? (base ? `当前 · ${base}` : "当前") : base,
      value: s.name,
    };
  });
}
