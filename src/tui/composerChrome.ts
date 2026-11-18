/**
 * tui/composerChrome.ts — 输入框上下横线、标题与正文绘制（issue #79 强调色）。
 */
import { c, displayWidth, truncate } from "../ui/theme.ts";
import type { VisualLine, TextBuffer } from "./buffer.ts";
import { accentPaintFor } from "./permissionMode.ts";
import { INPUT_VIEWPORT, type Composer } from "./composer.ts";
import type { TitleView } from "./title.ts";

export function accentPaint(this: Composer): (s: string) => string {
  const status = this.deps.getStatus();
  return accentPaintFor(status.mode, this.shellMode, status.planning);
}

export function composeInput(this: Composer, 
  width: number,
  buf: TextBuffer,
  kind: "normal" | "ask" | "shell",
): { rows: string[]; cursorRow: number; cursorCol: number } {
  const contentW = Math.max(4, width - 3);
  const layout = this.layoutFor(buf.text, buf.cursor, contentW);
  const maxRows = this.maxFrameRows();
  const viewH = Math.max(1, Math.min(INPUT_VIEWPORT, maxRows - 5));
  const total = layout.lines.length;
  let scroll = this.inputScroll;
  if (layout.cursorRow < scroll) scroll = layout.cursorRow;
  else if (layout.cursorRow >= scroll + viewH) scroll = layout.cursorRow - viewH + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, total - viewH)));
  this.inputScroll = scroll;

  const rows: string[] = [];
  let ruleTitle: string | TitleView | null = kind === "ask" ? "确认" : this.titleView();
  if (total > viewH) {
    const range = `${scroll + 1}-${Math.min(scroll + viewH, total)}/${total} 行`;
    if (typeof ruleTitle === "string") ruleTitle = ruleTitle ? `${ruleTitle} · ${range}` : range;
    else if (ruleTitle) {
      ruleTitle = {
        ...ruleTitle,
        suffix: ruleTitle.suffix ? `${ruleTitle.suffix} · ${range}` : range,
      };
    }
    else ruleTitle = range;
  }
  const rule = this.topRule(width, ruleTitle, kind !== "ask" && this.busy, kind === "ask" ? null : this.accentPaint());
  rows.push(rule);
  const prefix =
    kind === "ask" ? c.warn("? ") : kind === "shell" ? c.warn("! ") : c.accent("❯ ");
  const cont = "  ";
  const placeholder =
    kind === "ask"
      ? "y / N（Enter 确认，Esc 取消）"
      : kind === "shell"
        ? "shell 命令 · Enter 执行 · 删空或 Esc 退出"
        : "输入消息 · @ 文件 · / 命令 · Ctrl+J 换行";
  // issue #30：shell 模式正文用 warn 色，和普通输入（text 色）区分。
  const paint = kind === "shell" ? c.warn : c.text;
  // issue #18：占位用 c.placeholder（grey + SGR 2），比正文暗一档且仍可读；
  // 正文/光标走 paintInputLine 的 c.text + c.inverse，不受这里影响。
  const paintPlaceholder = (s: string): string => c.placeholder(truncate(s, Math.max(0, contentW - 1)));
  const empty = buf.text === "";
  for (let v = scroll; v < Math.min(scroll + viewH, total); v++) {
    const line = layout.lines[v] as VisualLine;
    const isCursorLine = v === layout.cursorRow;
    const head = v === 0 ? prefix : cont;
    if (empty && v === 0) {
      rows.push(`${head}${c.inverse(" ")}${paintPlaceholder(placeholder)}`);
      continue;
    }
    rows.push(
      head +
        this.paintInputLine(line, isCursorLine ? layout.cursorIndex - line.start : null, contentW, paint),
    );
  }
  // 空文本时也要有一行
  if (rows.length === 1) {
    rows.push(`${prefix}${c.inverse(" ")}${paintPlaceholder(placeholder)}`);
  }
  rows.push(this.accentPaint()("─".repeat(width)));
  const cursorLine = Math.max(0, layout.cursorRow - scroll);
  return {
    rows,
    cursorRow: 1 + cursorLine,
    cursorCol: 2 + Math.min(layout.cursorCol, contentW),
  };
}

/** 单行输入渲染 + 光标反显（layout 已给出码点下标，不再二次换算显示列）。 */
export function paintInputLine(this: Composer, 
  line: VisualLine,
  cursorIdx: number | null,
  _contentW: number,
  paint: (s: string) => string = c.text,
): string {
  const chars = [...line.text];
  if (cursorIdx === null) return paint(line.text);
  const idx = Math.max(0, Math.min(chars.length, cursorIdx));
  const before = chars.slice(0, idx).join("");
  const at = chars[idx];
  const after = chars.slice(idx + 1).join("");
  const cursorCell = idx < chars.length ? c.inverse(at as string) : c.inverse(" ");
  return paint(before) + cursorCell + paint(after);
}

/** 顶线：横线 + 右侧 label；支持旧的 string 与结构化 TitleView。 */
export function topRule(this: Composer, 
  width: number,
  label: string | TitleView | null,
  busy = false,
  paint: ((s: string) => string) | null = null,
): string {
  // issue #79：输入框顶线/底横线用同一套强调色（随权限模式变）；null = 旧的 dim。
  const line = paint ?? c.dim;
  if (!label) return line("─".repeat(width));
  if (typeof label === "string") {
    const full = busy ? `${label} · 运行中` : label;
    return this.ruleWithPlainLabel(width, full, line);
  }
  const prefix = `${label.prefix}: `;
  const suffixText = [label.suffix, busy ? "运行中" : null].filter(Boolean).join(" · ");
  const suffix = suffixText ? ` · ${suffixText}` : "";
  const budget = Math.max(4, width - 8);
  let name = label.text;
  if (displayWidth(`${prefix}${name}${suffix}`) > budget) {
    const nameBudget = Math.max(1, budget - displayWidth(prefix) - displayWidth(suffix));
    name = truncate(label.text, nameBudget);
    if (displayWidth(`${prefix}${name}${suffix}`) > budget) {
      // 极窄终端：放弃分段着色，按纯文本截断，保证不超宽。
      return this.ruleWithPlainLabel(width, `${prefix}${name}${suffix}`, line);
    }
  }
  const namePainted = label.matrix ? c.matrix(name) : c.dim(name);
  const inner = `${c.dim(prefix)}${namePainted}${c.dim(suffix)}`;
  const plainLen = displayWidth(`${prefix}${name}${suffix}`);
  const dashes = Math.max(1, width - plainLen - 2 - 2);
  return line("─".repeat(dashes)) + ` ${inner} ` + line("──");
}

/** 纯文本 label（全 dim）的顶线，旧行为与极窄兜底共用。 */
export function ruleWithPlainLabel(this: Composer, width: number, text: string, line: (s: string) => string = c.dim): string {
  const label = ` ${truncate(text, Math.max(4, width - 8))} `;
  const dashes = Math.max(1, width - displayWidth(label) - 2);
  return line("─".repeat(dashes)) + c.dim(label) + line("──");
}

/** 当前标题视图：优先动画器，其次旧的 string/TitleView 注入点（测试/宿主兼容）。 */
export function titleView(this: Composer): string | TitleView | null {
  const anim = this.titleAnimator?.getView();
  if (anim) return anim.text === "" ? null : anim;
  const raw = this.deps.getTitle?.();
  if (!raw) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" ? null : t;
  }
  return raw.text.trim() === "" ? null : raw;
}
