/**
 * 输出风格的公共类型（issue #73）。
 *
 * 本模块是叶子：不依赖 src/config.ts，避免 loadConfig 接线成环。
 */
export const BUILTIN_OUTPUT_STYLES = [
  "Default",
  "Proactive",
  "Concise",
  "Explanatory",
  "Learning",
] as const;

export type BuiltinOutputStyle = (typeof BUILTIN_OUTPUT_STYLES)[number];

export interface OutputStyle {
  name: string;
  description: string;
  kind: "builtin" | "custom";
  /** 解析自 frontmatter；本轮永不据此摘 renderCore。 */
  keepCodingInstructions?: boolean;
  /** 注入系统提示词的指令正文；Default 为空。 */
  body: string;
  sourcePath?: string;
}

export interface DiscoverResult {
  styles: OutputStyle[];
  diagnostics: string[];
}

/** applyOutputStyle 只依赖这几个字段，避免从本包 import Config。 */
export interface OutputStyleHost {
  cwd: string;
  outputStyle: string;
  settingsPath: string | null;
}

export interface OutputStyleOption {
  label: string;
  hint: string;
  value: string;
}

export interface ResolveOutputStyleResult {
  outputStyle: string;
  outputStyleWarnings: string[];
}
