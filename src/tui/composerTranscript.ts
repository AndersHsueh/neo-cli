/**
 * tui/composerTranscript.ts — issue #90 transcript 视图与 composer 的接线。
 *
 * 纯逻辑在 transcriptView.ts；这里只负责开关、按键分发，以及把面板画进
 * 输入框上方的可用高度（输入框与状态行始终可见）。
 */
import type { KeyAction } from "./keys.ts";
import type { ComposedFrame, Composer } from "./composer.ts";
import {
  handleTranscriptAction,
  openTranscriptView,
  renderTranscriptPanel,
} from "./transcriptView.ts";

export function toggleTranscriptView(this: Composer): void {
  if (this.rewindMenuOpen || this.mode !== "normal") return;
  if (this.transcriptView) {
    closeTranscriptView.call(this);
    return;
  }
  this.helpOpen = false;
  this.menu = null;
  this.menuDismissedFor = this.buf.text;
  this.hint = null;
  this.transcriptView = openTranscriptView(this.deps.getMessages?.() ?? []);
  this.scheduleRender();
}

export function closeTranscriptView(this: Composer): void {
  if (!this.transcriptView) return;
  this.transcriptView = null;
  this.menuDismissedFor = null;
  this.syncCommandMenu();
  this.scheduleRender();
}

export function handleTranscriptViewKey(this: Composer, action: KeyAction): void {
  const view = this.transcriptView;
  if (!view) return;
  const { state, effect } = handleTranscriptAction(view, action, { busy: this.busy });
  this.transcriptView = state;
  if (state === null) {
    this.menuDismissedFor = null;
    this.syncCommandMenu();
    if (effect === "close-and-cancel") this.deps.onCancelTurn?.();
    this.scheduleRender();
    return;
  }
  this.scheduleRender();
}

/** 视图打开时的整帧：面板占输入框以上可用高度。 */
export function composeTranscriptFrame(
  this: Composer,
  width: number,
  maxRows: number,
  box: { rows: string[]; cursorRow: number; cursorCol: number },
  statusRow: string,
): ComposedFrame {
  const reserved = box.rows.length + 1;
  const height = Math.max(3, maxRows - reserved);
  const panel = renderTranscriptPanel(this.transcriptView!, {
    width,
    height,
    busy: this.busy,
  });
  const rows = [...panel.lines, ...box.rows, statusRow];
  let cursorRow = panel.cursorRow;
  let cursorCol = panel.cursorCol;
  if (rows.length > maxRows) {
    const drop = rows.length - maxRows;
    if (drop < panel.lines.length) {
      rows.splice(0, drop);
      cursorRow -= drop;
    }
  }
  cursorRow = Math.max(0, Math.min(cursorRow, rows.length - 1));
  cursorCol = Math.max(0, Math.min(cursorCol, width - 1));
  return { rows, cursorRow, cursorCol };
}
