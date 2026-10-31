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

/**
 * 敏感动作的统一判定。
 *
 * - auto-all：全部放行
 * - auto-edit：写文件放行，shell 仍要问
 * - plan：一律拒绝
 * - ask：一律询问
 */
export function decidePermission(mode: PermissionMode, tool: string): PermissionDecision {
  if (mode === "auto-all") return { allow: true };
  if (mode === "auto-edit" && tool !== "shell") return { allow: true };
  if (mode === "plan") return { allow: false, reason: "plan" };
  return { allow: false, reason: "needs-confirm" };
}
