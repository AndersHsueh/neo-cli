/**
 * tui/permissionMode.ts — 权限模式 ↔ 输入框强调色 / 循环顺序（issue #79）。
 *
 * 两件事：
 *  1. `cycleMode`：Shift+Tab / Alt+M 的下一档。顺序必须与 `/mode` 的档位一致：
 *     ask → auto-edit → auto-all → plan → ask。plan 是**只读闸门**，不是 `/plan`
 *     的交互规划工作流（后者由 status.planning 单独表示）。
 *  2. `accentRole`：输入框上下横线的强调色。状态条把 auto-edit 显示成 `edit`、
 *     auto-all 显示成 `yolo`（现有口径），这里要能同时认规范名与别名。
 *
 * 刻意不出现 Claude Code 的 default / acceptEdits / bypassPermissions 名称。
 */
import { c, type palette } from "../ui/theme.ts";

export type PermissionModeName = "ask" | "auto-edit" | "auto-all" | "plan";

/** 循环顺序（`/mode` 的四个档位）。 */
export const MODE_CYCLE: readonly PermissionModeName[] = ["ask", "auto-edit", "auto-all", "plan"];

/** 状态条别名 → 规范名（显示名沿用现有口径，不改）。 */
const ALIASES: Record<string, PermissionModeName> = {
  ask: "ask",
  "auto-edit": "auto-edit",
  edit: "auto-edit",
  "auto-all": "auto-all",
  yolo: "auto-all",
  plan: "plan",
};

/** 把状态条里的 mode 字符串归一成规范名；未知返回 null。 */
export function normalizeMode(mode: string | undefined | null): PermissionModeName | null {
  if (typeof mode !== "string") return null;
  return ALIASES[mode.trim().toLowerCase()] ?? null;
}

/** 下一档：ask → auto-edit → auto-all → plan → ask（未知档从 ask 起）。 */
export function cycleMode(current: string | undefined | null): PermissionModeName {
  const cur = normalizeMode(current);
  if (cur === null) return "auto-edit";
  const i = MODE_CYCLE.indexOf(cur);
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length] as PermissionModeName;
}

export type AccentRole = keyof typeof palette;

/**
 * 输入框横线强调色：
 *  - shell 模式 `!`：amber（与现有 shell warn 同色）
 *  - plan（只读闸门）：cyan
 *  - auto-edit / edit：magenta
 *  - auto-all / yolo：red
 *  - 其余（ask / 未知）：dimGreen —— 与旧外观（`c.dim`）一致，默认观感不变
 */
export function accentRole(mode: string | undefined | null, shellMode: boolean, planning = false): AccentRole {
  if (shellMode) return "amber";
  // 规划工作流生效权限也是 plan，横线用同一套 cyan，和 /mode plan 只读闸门同色。
  if (planning) return "cyan";
  switch (normalizeMode(mode)) {
    case "plan": return "cyan";
    case "auto-edit": return "magenta";
    case "auto-all": return "red";
    default: return "dimGreen";
  }
}

/**
 * 把 accentRole 映射到 theme 已有画笔（不要用 c.tier：那是模型档位色，
 * dimGreen/cyan/magenta 都会回落到磷光绿）。
 */
export function accentPaintFor(
  mode: string | undefined | null,
  shellMode: boolean,
  planning = false,
): (s: string) => string {
  switch (accentRole(mode, shellMode, planning)) {
    case "cyan": return c.tool;
    case "magenta": return c.accentMagenta;
    case "red": return c.err;
    case "amber": return c.warn;
    default: return c.dim;
  }
}
