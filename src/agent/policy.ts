/**
 * 权限策略。
 *
 * 工具审批和 `!cmd` 必须走同一套判定。两处各写一遍，plan 模式就会有一条旁路。
 * 策略只回答「能不能做」，不负责打印、不负责真正执行。
 */
import type { PermissionMode } from "./types.ts";

export type PermissionDecision =
  | { allow: true }
  | { allow: false; reason: "plan" | "denied" }
  | { allow: false; reason: "needs-confirm" };

/** MCP 外部工具名前缀（与 src/mcp/tool.ts 的 MCP_TOOL_PREFIX 同口径）。 */
const MCP_PREFIX = "mcp__";

/**
 * 该工具是否来自外部 MCP server。
 *
 * 只按前缀判定，不查注册表：策略是叶子模块（shell.ts 也要用），
 * 反向依赖工具注册表会复活 tools → agent 的循环依赖；而前缀是命名约定的一部分
 * （见 mcp/tool.ts），注册表里不可能出现 `mcp__` 开头的内置工具。
 */
export function isMcpToolName(tool: string): boolean {
  return tool.startsWith(MCP_PREFIX);
}

/**
 * 敏感动作的统一判定。
 *
 * - auto-all：全部放行
 * - auto-edit：写文件放行；shell 与 MCP 工具仍要问
 * - plan：一律拒绝
 * - ask：一律询问
 *
 * 为什么 MCP 工具在 auto-edit 下也要问：auto-edit 的语义是「放行**本仓库的写盘**」，
 * 而 MCP 工具的副作用我们完全不知道 —— 它可能写盘、可能发网络请求、可能删远端资源。
 * 与 shell 同口径（副作用未知 → 必须确认）是唯一站得住的默认值；
 * 要全放行请显式用 auto-all。
 */
export function decidePermission(mode: PermissionMode, tool: string): PermissionDecision {
  if (mode === "auto-all") return { allow: true };
  if (mode === "auto-edit" && tool !== "shell" && !isMcpToolName(tool)) return { allow: true };
  if (mode === "plan") return { allow: false, reason: "plan" };
  return { allow: false, reason: "needs-confirm" };
}
