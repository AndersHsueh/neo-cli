/**
 * askUser 的纯数据契约与状态机（v0.4.1 B2）。
 *
 * 渲染在 tui/composer.ts（复用 select 的框线/滚动与 ask 的文本输入），
 * 这里只放：请求/回答类型、选项构建、状态转移（复用 select.reduce 的 clamp/scroll）、
 * 回答的文本化。保持可 bun test 直测。
 */
import { reduce, type SelectState } from "./select.ts";

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserRequest {
  question: string;
  /** 顶部标题（可选，≤12 字）。 */
  header?: string;
  /** 为什么问/影响什么（可选，暗色展示）。 */
  context?: string;
  /** 0–5 个选项；为空 = 纯文本提问。 */
  options?: AskUserOption[];
  /** 多选：Space 勾选，Enter 提交（至少 1 项）。 */
  multiSelect?: boolean;
  /** 是否追加「其他（自行输入）」；默认 true。空 options 时强制走文本输入。 */
  allowCustom?: boolean;
}

export type AskUserAnswer =
  | { status: "answered"; selected: string[]; custom: string | null }
  | { status: "canceled" };

/** 渲染用选项（custom=true 表示「其他（自行输入）」入口）。 */
export interface AskUserOptionView extends AskUserOption {
  custom: boolean;
}

export interface AskUserState extends SelectState {}

export function buildAskOptions(req: AskUserRequest): AskUserOptionView[] {
  const out: AskUserOptionView[] = (req.options ?? []).map((o) => ({
    label: o.label,
    ...(o.description ? { description: o.description } : {}),
    custom: false,
  }));
  if (req.allowCustom !== false) {
    out.push({ label: "其他（自行输入）", custom: true });
  }
  return out;
}

/** 与 select 共用同一套 clamp/scroll 规则。 */
export function reduceAskUser(
  state: AskUserState,
  action: "up" | "down" | { type: "resize"; viewportRows: number },
  optionCount: number,
  viewportRows: number,
): AskUserState {
  if (typeof action === "string") {
    return reduce(state, { type: action }, optionCount, viewportRows);
  }
  return reduce(state, action, optionCount, viewportRows);
}

/** 多选切换：返回新 Set（不原地改，测试/渲染都更安全）。 */
export function toggleSelected(selected: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(selected);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

export function askAnswerText(answer: AskUserAnswer): string {
  if (answer.status === "canceled") return "（已取消）";
  const parts = [...answer.selected];
  if (answer.custom) parts.push(answer.custom);
  return parts.join("；") || "（空回答）";
}
