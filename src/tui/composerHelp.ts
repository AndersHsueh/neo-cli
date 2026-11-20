/**
 * tui/composerHelp.ts — 空输入框按 `?` 的快捷键帮助面板（issue #79）。
 *
 * 为什么不用 `notice()`：notice 会启动 #76 的 250ms 空闲 tick 心跳，帮助面板
 * 是「用户主动打开、用户主动关闭」的静态面板，不该让 tick 常驻。
 * 所以帮助只写 `composer.helpOpen`，由 compose() 画在输入框上方。
 *
 * 文案里明确写「不做 Vim」：issue #78 已关闭，避免用户按 Vim 习惯乱试。
 */

/** 帮助面板行（纯文本，compose 时统一上色/截断）。 */
export const HELP_LINES: readonly string[] = [
  "快捷键（空输入框按 ? 开关）",
  "  Enter 提交 · Ctrl+J / Shift+Enter / Alt+Enter / Ctrl+Enter 换行",
  "  ↑↓ 历史（前缀搜索）· Ctrl+P / Ctrl+N 同 ↑↓ · Ctrl+R 反向检索历史",
  "  Ctrl+S 暂存/恢复草稿 · Ctrl+X Ctrl+S 立即发送排队 · ↑ 首行收回排队",
  "  Ctrl+Y 粘回最近删除 · Alt+Y 循环更早删除 · Ctrl+_ 撤销",
  "  Ctrl+K 删到行尾 · Ctrl+U 删到行首 · Ctrl+W 删到上一空白",
  "  Alt+B / Alt+F 按词左右移动 · Alt+D 向后按词删 · Ctrl+Backspace 向前按词删",
  "  Ctrl+A / Ctrl+E 行首/行尾 · Home / End 同义",
  "  Tab / @ 补全 · / 命令菜单 · ! shell 模式 · Ctrl+V 贴图 · Ctrl+G 外部编辑器",
  "  Shift+Tab / Alt+M 循环权限模式（ask → auto-edit → auto-all → plan）",
  "  Esc 清空 · Esc Esc 回滚 · Ctrl+C 清空草稿（再按退出）",
  "  Ctrl+O 打开/关闭 transcript 视图 · 视图内 / 搜索，或 Ctrl+F · Esc 关闭",
  "  本输入框不做 Vim 模式（无普通/插入模式切换）。",
];

/** 帮助面板最多占几行（窄终端下由 compose 的 extras 裁剪兜底）。 */
export const HELP_MAX_ROWS = HELP_LINES.length;
