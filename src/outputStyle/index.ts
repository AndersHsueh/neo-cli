/**
 * 输出风格（issue #73）：解析、发现、命令、渲染。
 */
export { BUILTIN_OUTPUT_STYLES, type BuiltinOutputStyle, type OutputStyle, type DiscoverResult } from "./types.ts";
export { builtinOutputStyles, builtinOutputStyle, normalizeBuiltinOutputStyle, isBuiltinOutputStyleName } from "./builtin.ts";
export { discoverOutputStyles, matchOutputStyle, parseOutputStyleFile, projectStyleDirs } from "./discover.ts";
export { resolveOutputStyleConfig, activeOutputStyle } from "./resolve.ts";
export { renderStyleSection, persistOutputStyleHint, keepCodingInstructionsNotice, buildOutputStyleOptions } from "./render.ts";
export { applyOutputStyle, type ApplyOutputStyleResult } from "./apply.ts";
export { handleOutputStyleCommand } from "./command.ts";
