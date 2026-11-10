/**
 * tui/rewindMenu.ts — 交互式 rewind 菜单的纯逻辑（issue #47）。
 *
 * 与 composer 的分工：这里只做「Esc Esc 判定 + 菜单数据构造 + 结果文案」，
 * 全部是纯函数，bun test 可直测；按键接线与模态渲染留在 composer。
 *
 * 口径（issue #47，Lead 已定）：
 *  - 只在**空闲且输入框为空**时连按两次 Esc（间隔 ≤ 400ms）才打开；
 *  - 单 Esc 的 5 种语义（取消本轮 / 清空输入 / 退出 shell 模式 / 关 `/` 菜单 / 其它前置态）
 *    一律不变 —— 所以本模块只在「本来 Esc 什么都不做」的那一种情形下武装；
 *  - 列表只列用户轮次（issue #42 口径）；选轮次后再选 code / conversation / both。
 */
import type { RewindMode, RewindTurn } from "../rewind.ts";

/** 两次 Esc 的最大间隔（ms）。 */
export const REWIND_MENU_WINDOW_MS = 400;

/** 菜单标题。 */
export const REWIND_TURN_QUESTION = "回滚到哪一轮之前？";
export const REWIND_MODE_QUESTION = "回滚什么？";

/** 模式选项（顺序固定：both 在最前，与 `/rewind` 默认值一致）。 */
export const REWIND_MODES: ReadonlyArray<{ mode: RewindMode; label: string; hint: string }> = [
  { mode: "both", label: "代码 + 对话", hint: "默认" },
  { mode: "code", label: "只回滚代码", hint: "对话保留" },
  { mode: "conversation", label: "只回滚对话", hint: "文件保留" },
];

/** 菜单项（与 ui/select.ts 的 SelectOption 同形，避免 composer 再转一次）。 */
export interface RewindMenuItem<T> {
  label: string;
  hint?: string;
  value: T;
}

/**
 * Esc Esc 判定器。
 *
 * 调用方只在「Esc 本来无事可做」时调 `arm()`；`arm()` 返回 true 表示这是第二次
 * （窗口内）→ 打开菜单。窗口外/首次返回 false（并重新武装）。
 *
 * 时间由调用方注入（`now`），测试不真等 400ms。
 */
export class EscDoublePress {
  private armedAt: number | null = null;

  constructor(private readonly windowMs: number = REWIND_MENU_WINDOW_MS) {}

  /** 按下一次 Esc：true = 命中双击（应打开菜单）。 */
  arm(nowMs: number): boolean {
    const prev = this.armedAt;
    this.armedAt = nowMs;
    if (prev !== null && nowMs - prev <= this.windowMs) {
      this.armedAt = null; // 命中后复位：第三次 Esc 重新开始计数
      return true;
    }
    return false;
  }

  /** 任何其它按键 / 状态变化都要复位，避免「Esc、打字、Esc」被误判成双击。 */
  reset(): void {
    this.armedAt = null;
  }

  get armed(): boolean {
    return this.armedAt !== null;
  }
}

/** 轮次菜单项：`[n] HH:MM:SS  提示…  · k 个文件检查点`。 */
export function turnMenuItems(turns: readonly RewindTurn[]): RewindMenuItem<number>[] {
  return turns.map((t) => {
    const time = t.at.slice(11, 19);
    const prompt = t.prompt.length > 50 ? `${t.prompt.slice(0, 50)}…` : t.prompt;
    const files = t.checkpointSeqs.length > 0 ? `${t.checkpointSeqs.length} 个文件检查点` : "无文件检查点";
    const compacted = t.compacted ? " · 已压缩" : "";
    return { label: `[${t.index}] ${time}  ${prompt}`, hint: `${files}${compacted}`, value: t.index };
  });
}

/** 模式菜单项。 */
export function modeMenuItems(): RewindMenuItem<RewindMode>[] {
  return REWIND_MODES.map((m) => ({ label: m.label, hint: m.hint, value: m.mode }));
}

/** 模式的中文名（结果文案用）。 */
export function modeLabel(mode: RewindMode): string {
  return REWIND_MODES.find((m) => m.mode === mode)?.label ?? mode;
}

/** 回滚结果的一行摘要（与 `/rewind` 命令的文案同口径，但不含「已回滚 N 轮」前缀）。 */
export function rewindSummary(r: {
  turnsRemoved: number;
  autoTurnsRemoved: number;
  messagesRemoved: number;
  filesRestored: number;
  filesSkipped: number;
}): string {
  const auto = r.autoTurnsRemoved > 0 ? `（另含 ${r.autoTurnsRemoved} 个自动轮）` : "";
  return (
    `已回滚 ${r.turnsRemoved} 轮${auto}：对话 -${r.messagesRemoved} 条，文件恢复 ${r.filesRestored} 处` +
    (r.filesSkipped > 0 ? `，跳过 ${r.filesSkipped} 处（快照缺失/过大）` : "")
  );
}
