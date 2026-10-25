/**
 * tui/composer.ts — 自绘输入区（v0.3.0 的核心）。
 *
 * 组成（自上而下，全部在底部 live 帧里）：
 *   [pending 流式行] [候选提示] [notice] [活动行]
 *   ──────── neo · <cwd> ──────────
 *   ❯ 输入（多行 / 折行 / 光标反显）
 *   ──────────────────────────────
 *   model · tier · mode · ⎇ branch · ctx ▓▓░░░ 42% · 0:42 · 12.3k tok
 *
 * 设计依据：
 *  - M0（scripts/tui-probe.ts）：raw mode + emitKeypressEvents 可用；Ctrl+J 看 sequence("\n")、
 *    Enter 看 "\r"；UTF-8 字符的 key.name 是 undefined；live 帧擦除/重画/滚动/交错全部实测通过。
 *  - qwen-code：上下横线、无左右边框、历史 append-only、宽度单一来源、粘贴 idle 兜底、
 *    审批态不卸载输入框。
 *  - Alice 翻车复盘：多行必须真接线、bracketed paste 必须真开启、光标按码点/显示列分开、
 *    禁止 remount 清状态、流式期间允许输入。
 *
 * 非 TTY 不使用本类（index.ts 保留 readline 路径）。
 */
import { emitKeypressEvents } from "node:readline";
import { c, displayWidth, truncate } from "../ui/theme.ts";
import { formatCandidateHint, applyMatch, completeLine, triggerAt, type CommandEntry } from "../input/completion.ts";
import { reduce as reduceSelect, type SelectOption, type SelectState } from "../ui/select.ts";
import { FrameRenderer } from "./frame.ts";
import { TextBuffer, InputHistory, layoutBuffer, type VisualLine } from "./buffer.ts";
import { PasteMachine, mapKey, type RawKey, type KeyAction } from "./keys.ts";
import { renderStatus, type StatusSnapshot, type StatusSegment } from "./status.ts";
import { stripAnsi, truncateAnsi, wrapAnsi } from "./ansi.ts";
import { shouldFold } from "../paste.ts";

/** 状态行数据源（index.ts 提供闭包；width/queueCount 由 Composer 补）。 */
export type ComposerStatus = Omit<StatusSnapshot, "width" | "queueCount">;

/** 粘贴折叠阈值（与 settings.json 的 paste.fold_* 对齐）。 */
export interface ComposerPasteConfig {
  foldLines: number;
  foldChars: number;
}

export interface ComposerDeps {
  stdin: NodeJS.ReadStream;
  stdout: { write: (s: string) => void; columns?: number; rows?: number };
  columns?: () => number;
  rows?: () => number;
  getStatus: () => ComposerStatus;
  /** 顶线右侧标签（会话名 / cwd 短名）。 */
  getTitle?: () => string;
  commands: CommandEntry[];
  files: () => string[];
  /** 提交一条消息（此时 buffer 已清空，attachments 是 chip 绑定列表）。 */
  onSubmit: (text: string, attachments: unknown[]) => void;
  /** 用户确认退出（双 Ctrl+C / Ctrl+D）。 */
  onExit: () => void;
  /** 运行中 ESC / Ctrl+C：请求取消当前轮。 */
  onCancelTurn?: () => void;
  /** 大段粘贴 → chip（真实实现来自 src/attachments.ts）。 */
  pasteText?: (text: string) => { chip: string; attachment: unknown };
  /** Ctrl+V 贴图；返回 null 表示剪贴板无图。 */
  pasteImage?: () => Promise<{ chip: string; attachment: unknown } | null>;
  paste?: ComposerPasteConfig;
  /** bracketed paste 丢包时的 idle 兜底（默认 1000ms）；测试可调小。 */
  pasteIdleMs?: number;
  /** 提交用户行之前调一次（dock 用来先把流式 pending 行落定，保证提交顺序）。 */
  beforeUserCommit?: () => void;
  /** resize 时通知宿主（dock 用新宽度重排 pending）。 */
  onResize?: () => void;
  now?: () => number;
}

interface SelectSession {
  question: string;
  options: SelectOption<unknown>[];
  state: SelectState;
  viewport: number;
  resolve: (v: unknown) => void;
}

interface AskState {
  question: string;
  buf: TextBuffer;
  resolve: (v: string) => void;
}

interface TabCycle {
  start: number;
  matches: string[];
  index: number;
  applied: string;
  cursorAfter: number;
}

export interface ComposedFrame {
  rows: string[];
  cursorRow: number;
  cursorCol: number;
}

const INPUT_VIEWPORT = 8;
const DOUBLE_CTRL_C_MS = 2000;
const NOTICE_DEFAULT_MS = 1800;

const identityPaint = (_role: StatusSegment["role"], text: string): string => text;

export class Composer {
  private readonly buf = new TextBuffer();
  private readonly history = new InputHistory();
  private readonly frame: FrameRenderer;
  private readonly now: () => number;
  private readonly fold: ComposerPasteConfig;
  private readonly paste = new PasteMachine();
  private pasteChunks: string[] = [];
  private pasteTimer: Timer | null = null;
  private readonly pasteIdleMs: number;
  private attachments: unknown[] = [];
  private mode: "normal" | "ask" | "select" = "normal";
  private select: SelectSession | null = null;
  private askState: AskState | null = null;
  private hint: string | null = null;
  private tabCycle: TabCycle | null = null;
  private noticeText: string | null = null;
  private noticeUntil = 0;
  private activity: string | null = null;
  private pendingRows: string[] = [];
  private inputScroll = 0;
  /** 输入布局缓存：文本/光标/宽度没变时，流式每帧不重算整份 layout（效率审查）。 */
  private layoutCache: { text: string; cursor: number; width: number; layout: ReturnType<typeof layoutBuffer> } | null =
    null;
  private queueCount = 0;
  private busy = false;
  private started = false;
  private stopped = false;
  private suspended = false;
  private lastCtrlCAt = 0;
  private armedExit = false;
  private renderTimer: Timer | null = null;
  private tickTimer: Timer | null = null;
  private noticeTimer: Timer | null = null;
  private keypressHandler: ((ch: string | undefined, key: RawKey) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private closedResolve: (() => void) | null = null;
  private wasRaw = false;
  private readonly closedPromise: Promise<void>;

  constructor(private readonly deps: ComposerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.fold = deps.paste ?? { foldLines: 3, foldChars: 300 };
    this.pasteIdleMs = Math.max(20, deps.pasteIdleMs ?? 1000);
    this.frame = new FrameRenderer({
      write: (s) => deps.stdout.write(s),
      columns: () => this.cols(),
      rows: () => this.rowsCount(),
    });
    this.closedPromise = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });
  }

  /** 会话结束（index 用它 await）。 */
  get closed(): Promise<void> { return this.closedPromise; }

  get text(): string { return this.buf.text; }

  // ---------------------------------------------------------------- 生命周期

  start(): void {
    if (this.started) return;
    this.started = true;
    const stdin = this.deps.stdin as unknown as {
      setRawMode?: (v: boolean) => void;
      isRaw?: boolean;
      on: (ev: string, fn: (...a: never[]) => void) => void;
      off: (ev: string, fn: (...a: never[]) => void) => void;
    };
    this.wasRaw = stdin.isRaw === true;
    if (stdin.isRaw !== true) stdin.setRawMode?.(true);
    emitKeypressEvents(this.deps.stdin as unknown as NodeJS.ReadStream);
    this.keypressHandler = (ch, key) => this.handleKey(ch, key);
    stdin.on("keypress", this.keypressHandler as never);
    const out = this.deps.stdout as unknown as {
      on?: (ev: string, fn: () => void) => void;
      off?: (ev: string, fn: () => void) => void;
    };
    this.resizeHandler = () => this.onResize();
    out.on?.("resize", this.resizeHandler);
    // 开 bracketed paste + 隐藏硬件光标（自己画反显块；硬件光标位置仍给 IME 用作锚点）。
    this.deps.stdout.write("\x1b[?2004h\x1b[?25l");
    // 异常退出兜底：进程退出时同步还原终端（raw off / 光标 / bracketed paste）。
    process.once("exit", this.restoreOnExit);
    this.scheduleRender();
    this.tickTimer = setInterval(() => this.tick(), 250);
    this.tickTimer.unref?.();
  }

  /** exit 事件里只能同步写，不碰定时器/异步。 */
  private readonly restoreOnExit = (): void => {
    try {
      const stdin = this.deps.stdin as unknown as { setRawMode?: (v: boolean) => void };
      this.deps.stdout.write("\x1b[?25h\x1b[?2004l");
      stdin.setRawMode?.(this.wasRaw);
    } catch {
      /* 退出路径尽力而为 */
    }
  };

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    process.off("exit", this.restoreOnExit);
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.noticeTimer) { clearTimeout(this.noticeTimer); this.noticeTimer = null; }
    if (this.pasteTimer) { clearTimeout(this.pasteTimer); this.pasteTimer = null; }
    this.pasteChunks = [];
    const stdin = this.deps.stdin as unknown as {
      setRawMode?: (v: boolean) => void;
      off: (ev: string, fn: (...a: never[]) => void) => void;
    };
    if (this.keypressHandler) stdin.off("keypress", this.keypressHandler as never);
    this.keypressHandler = null;
    const out = this.deps.stdout as unknown as { off?: (ev: string, fn: () => void) => void };
    if (this.resizeHandler) out.off?.("resize", this.resizeHandler);
    this.resizeHandler = null;
    this.frame.clear();
    this.deps.stdout.write("\x1b[?25h\x1b[?2004l");
    stdin.setRawMode?.(this.wasRaw);
    this.closedResolve?.();
    this.closedResolve = null;
  }

  private tick(): void {
    if (this.stopped) return;
    // 通知到期 / 状态行时钟 / spinner 由 Console 自己的 timer 驱动
    if (this.noticeText && this.now() >= this.noticeUntil) {
      this.noticeText = null;
      this.scheduleRender();
      return;
    }
    if (this.busy || this.activity !== null || this.noticeText) this.scheduleRender();
  }

  private onResize(): void {
    // resize 后上一帧的行宽已失效：先按旧帧坐标尽力擦掉，再放弃坐标整帧重画。
    // 只 invalidate 不擦会把旧顶线留在 scrollback（S15 实测的残影）。
    this.frame.erase();
    this.frame.invalidate();
    this.inputScroll = 0;
    this.deps.onResize?.();
    this.scheduleRender();
  }

  /** 由 index 在队列变化时更新（状态行显示排队条数）。 */
  setQueueCount(n: number): void {
    if (this.queueCount === n) return;
    this.queueCount = n;
    this.scheduleRender();
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.scheduleRender();
  }

  /**
   * 临时让出终端（执行 `!cmd` 这类会直接写 tty 的子进程）：
   * 停按键监听、恢复 cooked mode、显示光标、擦掉帧。resume() 后恢复 raw + 重画。
   */
  suspend(): void {
    if (!this.started || this.stopped || this.suspended) return;
    this.suspended = true;
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    const stdin = this.deps.stdin as unknown as {
      setRawMode?: (v: boolean) => void;
      off: (ev: string, fn: (...a: never[]) => void) => void;
    };
    if (this.keypressHandler) stdin.off("keypress", this.keypressHandler as never);
    this.frame.clear();
    this.frame.invalidate();
    // 把外部进程的输出「定格」在 scrollback：从新行开始，resume 也从新行重画，
    // 避免 cooked 回显（^C）与帧争夺同一行。
    this.deps.stdout.write("\r\n\x1b[?25h\x1b[?2004l");
    stdin.setRawMode?.(false);
  }

  resume(): void {
    if (!this.started || this.stopped || !this.suspended) return;
    this.suspended = false;
    const stdin = this.deps.stdin as unknown as {
      setRawMode?: (v: boolean) => void;
      on: (ev: string, fn: (...a: never[]) => void) => void;
    };
    stdin.setRawMode?.(true);
    emitKeypressEvents(this.deps.stdin as unknown as NodeJS.ReadStream);
    if (this.keypressHandler) stdin.on("keypress", this.keypressHandler as never);
    this.frame.invalidate();
    this.deps.stdout.write("\r\n\x1b[?2004h\x1b[?25l");
    this.scheduleRender();
  }

  get isSuspended(): boolean { return this.suspended; }

  // ---------------------------------------------------------------- 尺寸

  /** 输入区可用列数：留 1 列给行尾反显光标，避免「行满即触发终端 auto-wrap」。 */
  private layoutFor(text: string, cursor: number, width: number): ReturnType<typeof layoutBuffer> {
    const c = this.layoutCache;
    if (c && c.text === text && c.cursor === cursor && c.width === width) return c.layout;
    const layout = layoutBuffer(text, cursor, width);
    this.layoutCache = { text, cursor, width, layout };
    return layout;
  }

  private contentWidth(): number {
    return Math.max(4, this.cols() - 3);
  }

  private cols(): number {
    const n = this.deps.columns ? this.deps.columns() : (this.deps.stdout.columns ?? process.stdout.columns);
    return typeof n === "number" && n > 20 ? n : 80;
  }

  private rowsCount(): number {
    const n = this.deps.rows ? this.deps.rows() : (this.deps.stdout.rows ?? process.stdout.rows);
    return typeof n === "number" && n > 0 ? n : 24;
  }

  /** 帧最多占几行（永远给屏幕顶留 1 行；极小的 tmux 分屏下也夹住）。 */
  private maxFrameRows(): number {
    return Math.max(4, this.rowsCount() - 1);
  }

  // ---------------------------------------------------------------- DockHost

  width(): number { return this.cols(); }

  commitAbove(rows: string[]): void {
    if (rows.length === 0) return;
    // 提交与重画合成一次 write：流式每行提交后帧不会空 8-10ms。
    this.frame.commitAboveAndRender(rows, this.compose());
  }

  setPending(rows: string[]): void {
    this.pendingRows = rows.slice(-2);
    this.scheduleRender();
  }

  setActivity(text: string | null, _persist: boolean): void {
    // 提交/丢弃由 dock 决定（它持有 persist 语义）；composer 只负责把文本画在帧里。
    this.activity = text;
    this.scheduleRender();
  }

  commitActivity(): void {
    const text = this.activity;
    this.activity = null;
    if (text) {
      this.frame.commitAboveAndRender(wrapAnsi(text, this.cols()), this.compose());
    }
  }

  clearActivity(): void {
    this.activity = null;
    this.scheduleRender();
  }

  notice(text: string, ms = NOTICE_DEFAULT_MS): void {
    this.noticeText = text;
    this.noticeUntil = this.now() + Math.max(100, ms);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      if (this.noticeText !== null && this.now() >= this.noticeUntil) {
        this.noticeText = null;
        this.scheduleRender();
      }
    }, Math.max(100, ms) + 20);
    this.noticeTimer.unref?.();
    this.scheduleRender();
  }

  rerender(): void { this.scheduleRender(); }

  // ---------------------------------------------------------------- 渲染

  scheduleRender(): void {
    if (this.stopped || !this.started || this.suspended) return;
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 8);
    this.renderTimer.unref?.();
  }

  private render(): void {
    if (this.stopped) return;
    const f = this.compose();
    this.frame.render(f);
  }

  /** 组装当前帧（纯函数式，不写终端；测试直接断言它）。 */
  compose(): ComposedFrame {
    const width = this.cols();
    const maxRows = this.maxFrameRows();
    const status = this.buildStatus(width);
    const statusRow = renderStatus(status, (role, text) => paintRole(role, text));
    const extras: string[] = [];
    const pending = this.pendingRows.slice(-2);
    extras.push(...pending.map((r) => truncateAnsi(r, width)));
    if (this.hint) extras.push(truncateAnsi(c.dim(`· ${this.hint}`), width));
    if (this.noticeText) extras.push(truncateAnsi(`${c.warn("! ")}${c.warn(this.noticeText)}`, width));
    if (this.activity) extras.push(...wrapAnsi(c.dim(this.activity), width).slice(-1));

    let rows: string[] = [];
    let cursorRow = 0;
    let cursorCol = 0;

    if (this.mode === "select" && this.select) {
      const box = this.composeSelect(width, this.select);
      rows = [...extras, ...box.rows, statusRow];
      const extraCount = extras.length;
      cursorRow = extraCount + box.cursorRow;
      cursorCol = box.cursorCol;
    } else if (this.mode === "ask" && this.askState) {
      const q = wrapAnsi(c.warn(`? ${this.askState.question}`), width);
      extras.push(...q);
      const box = this.composeInput(width, this.askState.buf, "ask");
      rows = [...extras, ...box.rows, statusRow];
      cursorRow = extras.length + box.cursorRow;
      cursorCol = box.cursorCol;
    } else {
      const box = this.composeInput(width, this.buf, "normal");
      rows = [...extras, ...box.rows, statusRow];
      cursorRow = extras.length + box.cursorRow;
      cursorCol = box.cursorCol;
    }

    // 高度不够：从顶部丢 extras（pending/hint/notice/activity），再丢输入窗口顶部行
    while (rows.length > maxRows && extras.length > 0) {
      rows = rows.slice(1);
      extras.shift();
      cursorRow -= 1;
    }
    if (rows.length > maxRows) {
      const drop = rows.length - maxRows;
      rows = rows.slice(drop);
      cursorRow -= drop;
    }
    cursorRow = Math.max(0, Math.min(cursorRow, rows.length - 1));
    cursorCol = Math.max(0, Math.min(cursorCol, width - 1));
    return { rows, cursorRow, cursorCol };
  }

  private buildStatus(width: number): StatusSnapshot {
    return {
      ...this.deps.getStatus(),
      width,
      queueCount: this.queueCount,
    };
  }

  private composeInput(
    width: number,
    buf: TextBuffer,
    kind: "normal" | "ask",
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
    let ruleTitle = kind === "ask" ? "确认" : this.titleWithBusy();
    if (total > viewH) {
      const range = `${scroll + 1}-${Math.min(scroll + viewH, total)}/${total} 行`;
      ruleTitle = ruleTitle ? `${ruleTitle} · ${range}` : range;
    }
    const rule = this.topRule(width, ruleTitle);
    rows.push(rule);
    const prefix = kind === "ask" ? c.warn("? ") : c.accent("❯ ");
    const cont = "  ";
    const placeholder = kind === "ask" ? "y / N（Enter 确认，Esc 取消）" : "输入消息 · @ 文件 · / 命令 · Ctrl+J 换行";
    const empty = buf.text === "";
    for (let v = scroll; v < Math.min(scroll + viewH, total); v++) {
      const line = layout.lines[v] as VisualLine;
      const isCursorLine = v === layout.cursorRow;
      const head = v === 0 ? prefix : cont;
      if (empty && v === 0) {
        rows.push(`${head}${c.inverse(" ")}${c.dim(truncate(placeholder, Math.max(0, contentW - 1)))}`);
        continue;
      }
      rows.push(head + this.paintInputLine(line, isCursorLine ? layout.cursorIndex - line.start : null, contentW));
    }
    // 空文本时也要有一行
    if (rows.length === 1) {
      rows.push(`${prefix}${c.inverse(" ")}${c.dim(truncate(placeholder, Math.max(0, contentW - 1)))}`);
    }
    rows.push(c.dim("─".repeat(width)));
    const cursorLine = Math.max(0, layout.cursorRow - scroll);
    return {
      rows,
      cursorRow: 1 + cursorLine,
      cursorCol: 2 + Math.min(layout.cursorCol, contentW),
    };
  }

  /** 单行输入渲染 + 光标反显（layout 已给出码点下标，不再二次换算显示列）。 */
  private paintInputLine(line: VisualLine, cursorIdx: number | null, _contentW: number): string {
    const chars = [...line.text];
    if (cursorIdx === null) return c.text(line.text);
    const idx = Math.max(0, Math.min(chars.length, cursorIdx));
    const before = chars.slice(0, idx).join("");
    const at = chars[idx];
    const after = chars.slice(idx + 1).join("");
    const cursorCell = idx < chars.length ? c.inverse(at as string) : c.inverse(" ");
    return c.text(before) + cursorCell + c.text(after);
  }

  private topRule(width: number, title: string | null): string {
    if (!title) return c.dim("─".repeat(width));
    const label = ` ${truncate(title, Math.max(4, width - 8))} `;
    const dashes = Math.max(1, width - displayWidth(label) - 2);
    return c.dim("─".repeat(dashes)) + c.dim(label) + c.dim("──");
  }

  private title(): string | null {
    const t = this.deps.getTitle?.();
    return t && t.trim() !== "" ? t.trim() : null;
  }

  /** 顶线标题：忙碌时追加「运行中」——用户能看出 agent 还在跑（PTY 也用它判定 idle）。 */
  private titleWithBusy(): string | null {
    const base = this.title();
    if (!this.busy) return base;
    return base ? `${base} · 运行中` : "运行中";
  }

  private composeSelect(
    width: number,
    sel: SelectSession,
  ): { rows: string[]; cursorRow: number; cursorCol: number } {
    const total = sel.options.length;
    const scroll = sel.state.scroll;
    const rows: string[] = [];
    rows.push(this.topRule(width, "选择"));
    rows.push(c.bold(truncate(sel.question, Math.max(4, width - 2))));
    const end = Math.min(scroll + sel.viewport, total);
    for (let i = scroll; i < end; i++) {
      const o = sel.options[i] as SelectOption<unknown>;
      const marked = i === sel.state.cursor;
      const marker = marked ? c.accent("❯ ") : "  ";
      const hint = o.hint ? c.dim(`  ${truncate(o.hint, Math.max(4, Math.floor(width / 2)))}`) : "";
      const avail = Math.max(4, width - 2 - (o.hint ? displayWidth(o.hint) + 4 : 0));
      const label = truncate(o.label, avail);
      rows.push(marker + (marked ? c.bold(label) : c.dim(label)) + hint);
    }
    rows.push(c.dim("─".repeat(width)));
    return { rows, cursorRow: 2 + Math.max(0, sel.state.cursor - scroll), cursorCol: 0 };
  }

  // ---------------------------------------------------------------- 按键

  /** 入口：由 stdin keypress 调用；测试也可直接调。 */
  handleKey(ch: string | undefined, key: RawKey): void {
    if (this.stopped || this.suspended) return;
    const raw: RawKey = { ...key, ch: key.ch ?? ch };

    // 粘贴态优先：Ctrl+C 先救场，其余全部按字面文本收（含 \r\n）。
    // 状态机用 keys.ts 的 PasteMachine，composer 只做「收文本 / idle 兜底 / 折叠」的 IO 层。
    if (this.paste.active) {
      if (raw.ctrl && raw.name === "c") {
        this.finishPaste(false);
        this.handleCtrlC();
        return;
      }
      const r = this.paste.feed(raw);
      if (r.kind === "end") {
        this.finishPaste(true);
        return;
      }
      if (r.kind === "text") {
        this.pasteChunks.push(r.text);
        this.armPasteTimer();
      }
      return;
    }

    const action = mapKey(raw);
    if (!action) return;

    // 粘贴边界必须先于模态分发：否则审批/选择态里 paste-start 被当普通键吃掉，
    // 粘贴内容会逐字符走 mapKey（审批可能被 "y\r" 代答）。
    if (action.type === "paste-start") {
      this.paste.start();
      this.pasteChunks = [];
      this.hint = "粘贴中…";
      this.armPasteTimer();
      this.scheduleRender();
      return;
    }
    if (action.type === "paste-end") return; // 不在粘贴态：忽略迟到边界

    if (this.mode === "select" && this.select) {
      this.handleSelectKey(action);
      return;
    }
    if (this.mode === "ask" && this.askState) {
      this.handleAskKey(action);
      return;
    }
    this.handleNormalAction(action);
  }

  private handleSelectKey(action: KeyAction): void {
    const sel = this.select;
    if (!sel) return;
    if (action.type === "up" || action.type === "down") {
      sel.state = reduceSelect(sel.state, { type: action.type }, sel.options.length, sel.viewport);
      this.scheduleRender();
      return;
    }
    if (action.type === "submit") {
      const v = sel.options[sel.state.cursor]?.value ?? null;
      this.finishSelect();
      sel.resolve(v);
      return;
    }
    if (action.type === "escape" || action.type === "ctrl-c") {
      this.finishSelect();
      sel.resolve(null);
      return;
    }
  }

  private finishSelect(): void {
    this.mode = "normal";
    this.select = null;
    this.scheduleRender();
  }

  private handleAskKey(action: KeyAction): void {
    const ask = this.askState;
    if (!ask) return;
    if (action.type === "submit") {
      const text = ask.buf.text;
      this.finishAsk();
      ask.resolve(text);
      return;
    }
    if (action.type === "escape") {
      this.finishAsk();
      ask.resolve("");
      return;
    }
    if (action.type === "ctrl-c") {
      // 审批中 Ctrl+C = 拒绝 + 恢复「取消本轮 / 双击退出」语义（v0.2.4 的 SIGINT 行为）。
      this.finishAsk();
      ask.resolve("");
      this.handleCtrlC();
      return;
    }
    if (action.type === "insert") ask.buf.insert(action.text);
    else this.applyEditAction(action, ask.buf);
    this.scheduleRender();
  }

  private finishAsk(): void {
    this.mode = "normal";
    this.askState = null;
    this.scheduleRender();
  }

  private handleNormalAction(action: KeyAction): void {
    switch (action.type) {
      case "insert":
        this.buf.insert(action.text);
        this.resetTabIfEdited();
        this.scheduleRender();
        return;
      case "submit":
        this.submit();
        return;
      case "newline":
        this.buf.newline();
        this.resetTabIfEdited();
        this.scheduleRender();
        return;
      case "tab":
        this.tabComplete();
        return;
      case "escape":
        if (this.busy) {
          this.deps.onCancelTurn?.();
          this.notice("已请求取消本轮");
        } else if (this.buf.text !== "") {
          this.buf.clear();
          this.history.reset(); // 清空后 ↓ 不能把 ↑ 之前的草稿复活
          this.tabCycle = null;
          this.hint = null;
        }
        this.scheduleRender();
        return;
      case "ctrl-c":
        this.handleCtrlC();
        return;
      case "ctrl-d":
        if (this.buf.text === "") this.deps.onExit();
        else { this.buf.delete(); this.scheduleRender(); }
        return;
      case "ctrl-o":
        this.notice("transcript 视图将在 v0.3.1 提供");
        return;
      case "ctrl-v":
        void this.pasteImage();
        return;
      case "up":
      case "down":
        if (this.moveLineOrHistory(action.type)) return;
        return;
      default:
        this.applyEditAction(action, this.buf);
        this.resetTabIfEdited();
        this.scheduleRender();
    }
  }

  /** ↑↓：在视觉行内移动；到首/末行时走历史。 */
  private moveLineOrHistory(dir: "up" | "down"): boolean {
    const width = this.contentWidth();
    const layout = this.layoutFor(this.buf.text, this.buf.cursor, width);
    if (dir === "up" && layout.cursorRow === 0) {
      const entry = this.history.up(this.buf.text);
      if (entry !== null) {
        this.buf.setText(entry, entry.length);
        this.scheduleRender();
      }
      return true;
    }
    if (dir === "down" && layout.cursorRow === layout.lines.length - 1) {
      const entry = this.history.down(this.buf.text);
      if (entry !== null) {
        this.buf.setText(entry, entry.length);
        this.scheduleRender();
      }
      return true;
    }
    this.applyEditAction({ type: dir }, this.buf);
    this.resetTabIfEdited();
    this.scheduleRender();
    return true;
  }

  private applyEditAction(action: KeyAction, buf: TextBuffer): void {
    const width = this.contentWidth();
    switch (action.type) {
      case "backspace": buf.backspace(); return;
      case "delete": buf.delete(); return;
      case "left": buf.move("left", width); return;
      case "right": buf.move("right", width); return;
      case "up": buf.move("up", width); return;
      case "down": buf.move("down", width); return;
      case "home": buf.move("home", width); return;
      case "end": buf.move("end", width); return;
      case "word-left": buf.move("word-left", width); return;
      case "word-right": buf.move("word-right", width); return;
      case "kill-end": buf.killToEnd(); return;
      case "kill-start": buf.killToStart(); return;
      case "kill-word": buf.deleteWordLeft(); return;
      default: return;
    }
  }

  private resetTabIfEdited(): void {
    this.tabCycle = null;
  }

  private submit(): void {
    let text = this.buf.text;
    if (text.trim() === "") return;
    // 行尾反斜杠 = 续行（与 v0.2.4 兼容）
    if (text.endsWith("\\") && !text.endsWith("\\\\")) {
      this.buf.setText(`${text.slice(0, -1)}\n`, text.length);
      this.scheduleRender();
      return;
    }
    const attachments = this.attachments;
    this.history.push(text);
    // 先把流式未完成行落定，再提交用户行，保证 scrollback 顺序。
    this.deps.beforeUserCommit?.();
    // 输入框提交后清空：用户消息必须落进上方 scrollback（否则历史里只剩助手输出）。
    this.commitUserInput(text);
    this.buf.clear();
    this.attachments = [];
    this.tabCycle = null;
    this.hint = null;
    this.inputScroll = 0;
    // 注意：onSubmit 里可能同步触发新一轮（命令），先把状态清理干净再回调。
    this.deps.onSubmit(text, attachments);
    this.scheduleRender();
  }

  /** 用户消息进 scrollback：首行 `❯ `、续行两空格；折行与输入框共用 layoutBuffer。 */
  private commitUserInput(text: string): void {
    const contentW = this.contentWidth();
    const rows: string[] = [];
    text.split("\n").forEach((line, i) => {
      const prefix = i === 0 ? c.accent("❯ ") : "  ";
      const layout = layoutBuffer(line, line.length, contentW);
      for (const vl of layout.lines) rows.push(prefix + c.text(vl.text));
    });
    this.frame.commitAboveAndRender(rows, this.compose());
  }

  private handleCtrlC(): void {
    if (this.busy) this.deps.onCancelTurn?.();
    const now = this.now();
    if (this.armedExit && now - this.lastCtrlCAt <= DOUBLE_CTRL_C_MS) {
      this.deps.onExit();
      return;
    }
    this.armedExit = true;
    this.lastCtrlCAt = now;
    this.notice("再按 Ctrl+C 退出", DOUBLE_CTRL_C_MS);
  }

  private tabComplete(): void {
    const line = this.buf.text;
    const cursor = this.buf.cursor;
    if (this.tabCycle && line === this.tabCycle.applied && cursor === this.tabCycle.cursorAfter) {
      const cyc = this.tabCycle;
      const index = (cyc.index + 1) % cyc.matches.length;
      const applied = applyMatch(line, cursor, cyc.start, cyc.matches[index] as string);
      this.buf.setText(applied.line, applied.cursor);
      this.tabCycle = { ...cyc, index, applied: applied.line, cursorAfter: applied.cursor };
      this.hint = formatCandidateHint(this.lastKind, cyc.matches);
      this.scheduleRender();
      return;
    }
    const ctx = triggerAt(line, cursor);
    if (!ctx || (ctx.kind === "file" && line.trimStart().startsWith("/"))) return;
    const result = completeLine(line, {
      files: ctx.kind === "file" ? this.deps.files() : [],
      commands: this.deps.commands,
      cursor,
    });
    if (!result || result.matches.length === 0) {
      this.hint = "无候选";
      this.tabCycle = null;
      this.scheduleRender();
      return;
    }
    const applied = applyMatch(line, cursor, result.start, result.matches[0] as string);
    this.lastKind = ctx.kind;
    this.buf.setText(applied.line, applied.cursor);
    this.tabCycle = {
      start: result.start,
      matches: result.matches,
      index: 0,
      applied: applied.line,
      cursorAfter: applied.cursor,
    };
    this.hint = result.matches.length > 1 ? formatCandidateHint(ctx.kind, result.matches) : null;
    this.scheduleRender();
  }

  private lastKind: "file" | "command" = "file";

  private async pasteImage(): Promise<void> {
    if (!this.deps.pasteImage) return;
    let r: { chip: string; attachment: unknown } | null = null;
    try {
      r = await this.deps.pasteImage();
    } catch (e) {
      this.notice((e as Error).message);
      return;
    }
    if (!r) {
      this.notice("剪贴板里没有图片");
      return;
    }
    this.attachments.push(r.attachment);
    this.buf.insert(r.chip);
    this.scheduleRender();
  }

  /** paste-end 丢包保护：idle 超时按「粘贴已结束」收尾，避免之后所有按键被吞。 */
  private armPasteTimer(): void {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {
      this.pasteTimer = null;
      if (this.paste.active) this.finishPaste(true);
    }, this.pasteIdleMs);
    this.pasteTimer.unref?.();
  }

  private finishPaste(commit: boolean): void {
    if (this.pasteTimer) { clearTimeout(this.pasteTimer); this.pasteTimer = null; }
    this.paste.reset();
    const text = this.pasteChunks.join("");
    this.pasteChunks = [];
    this.hint = null;
    if (!commit) { this.scheduleRender(); return; }
    if (text === "") { this.scheduleRender(); return; }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // 模态：审批答案进 ask buffer；选择菜单直接丢弃（避免 "y" 代答 / 残留污染主缓冲）。
    if (this.mode === "select") { this.scheduleRender(); return; }
    if (this.mode === "ask" && this.askState) {
      this.askState.buf.insert(normalized);
      this.scheduleRender();
      return;
    }
    // 自绘输入框允许小段多行直接插入；只有超过阈值才折叠为 chip。
    const fold = shouldFold(text, this.fold, { allowMultiline: true });
    if (fold && this.deps.pasteText) {
      const r = this.deps.pasteText(text);
      this.attachments.push(r.attachment);
      this.buf.insert(r.chip);
    } else {
      this.buf.insert(normalized);
    }
    this.scheduleRender();
  }

  // ---------------------------------------------------------------- 模态

  /** 审批问句：在帧里显示问题，Enter 返回输入内容、Esc 返回空串。 */
  ask(question: string): Promise<string> {
    if (this.askState) return Promise.resolve("");
    // Console.confirm 的 asker 参数是「已着色 + 带 ?/[y/N]」的整串提示；
    // 自绘模态自己负责 ? 与占位提示，这里还原成纯问题。
    const plain = stripAnsi(question)
      .replace(/^\?\s*/, "")
      .replace(/\s*\[y\/N\]\s*$/i, "")
      .trim();
    return new Promise<string>((resolve) => {
      this.askState = { question: plain, buf: new TextBuffer(), resolve };
      this.mode = "ask";
      this.scheduleRender();
    });
  }

  /** 选择菜单：↑↓/Enter/Esc，返回 null = 取消。 */
  choose<T>(question: string, options: SelectOption<T>[], initial = 0): Promise<T | null> {
    if (this.select || options.length === 0) return Promise.resolve(null);
    const viewport = Math.max(1, Math.min(options.length, Math.min(10, this.maxFrameRows() - 7)));
    const cursor = Math.min(Math.max(0, Math.trunc(initial)), options.length - 1);
    return new Promise<T | null>((resolve) => {
      this.select = {
        question,
        options: options as SelectOption<unknown>[],
        // 唯一状态机复用 ui/select.ts 的 reduce（clamp + scroll 跟随），composeSelect 只负责画。
        state: reduceSelect(
          { cursor, scroll: 0 },
          { type: "resize", viewportRows: viewport },
          options.length,
          viewport,
        ),
        viewport,
        resolve: (v) => resolve(v as T | null),
      };
      this.mode = "select";
      this.scheduleRender();
    });
  }
}

/** 状态行角色 → 主题色。 */
function paintRole(role: StatusSegment["role"], text: string): string {
  switch (role) {
    case "accent": return c.accent(text);
    case "dim": return c.dim(text);
    case "muted": return c.muted(text);
    case "warn": return c.warn(text);
    case "tool": return c.tool(text);
    default: return c.text(text);
  }
}

