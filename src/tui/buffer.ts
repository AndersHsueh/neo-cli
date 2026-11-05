/**
 * tui/buffer.ts — 自绘输入框的纯文本缓冲（v0.3.0 B1-B4，纯逻辑、无 IO）。
 *
 * 两层职责，互不依赖：
 * 1. `layoutBuffer`：把 text + cursor 映射成「视觉行 + 光标行列」。折行单位是
 *    **显示列**（CJK/emoji 按 `displayWidth`），不是码点列 —— 终端里一列就是一格，
 *    用码点列会让中文输入的光标与 ↑↓ 全错位。
 * 2. `TextBuffer` / `InputHistory`：可变的编辑缓冲与历史导航。所有下标都是
 *    **code point 下标**（`Array.from` 语义），所以退格一次删一个整字/一个 emoji，
 *    不会切出半个 surrogate pair。
 *
 * 折行规则（PRD §6 B1）：
 * - 先按 `\n` 切逻辑行，再在逻辑行内按显示列软折行；空文本 → 一行空行；
 *   末尾 `\n` → 最后一个空行。
 * - 优先在空格处断行：断点空格留在上一行行尾（若放得下）；放不下时（上一行已满）
 *   该空格被丢弃，不回填下一行，避免视觉行以空格开头。
 * - 视觉行是左闭右开 `[start, end)`；光标落在折行边界时归后一行行首（B2）。
 */

import { charWidth, displayWidth, graphemeWidth, graphemes } from "../ui/theme.ts";

/** 一条视觉行。start/end 是整段 text 的 code point 下标，`[start, end)`。 */
export interface VisualLine {
  text: string;
  start: number;
  end: number;
}

/** 布局结果。cursorCol 是视觉行内的**显示列**；cursorIndex 是全文码点下标。 */
export interface BufferLayout {
  lines: VisualLine[];
  cursorRow: number;
  cursorCol: number;
  cursorIndex: number;
}

/** 按码点切分（不要用 `s.split("")`，那会切坏 emoji）。 */
export function toChars(s: string): string[] {
  return Array.from(s);
}

/** 宽度兜底：resize 到 0 / NaN 时按 1 列渲染，保证不死循环。 */
function normalizeWidth(width: number): number {
  if (!Number.isFinite(width)) return 1;
  const w = Math.floor(width);
  return w >= 1 ? w : 1;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** ASCII 字母数字下划线连续段算一个词；CJK/标点各自单独成词。 */
function isWordChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_"
  );
}

/**
 * 从 chars 的 `start` 起取一个 **grapheme cluster** 的结束下标（不含）。
 *
 * 为什么不能逐 code point 累加宽度（v0.4.30 修）：`charWidth` 是单码点近似，
 * 而 `displayWidth` 按 grapheme 整体算。两者在三种输入上分叉：
 *  - `❤️`（U+2764 + VS16）：逐字 1+0=1 列，整体 2 列 → 视觉行超宽；
 *  - `👨‍👩‍👧‍👦`（ZWJ 序列）：逐字 2+0+2+0+2+0+2=8 列，整体 2 列 → 被拆成 4 行；
 *  - `🇨🇳`（区域指示符对）：逐字 2+2=4，整体 2 列。
 * 折行单位必须是 grapheme，否则「一行放得下几个字」与终端实际渲染对不上，
 * 输入框会折错行、光标列也会偏。
 */
function graphemeEnd(chars: string[], start: number, to: number): number {
  const first = chars[start] as string;
  let end = start + 1;
  // 快速路径：ASCII 与常见单码点字符不可能是多码点 grapheme 的开头。
  const cp = first.codePointAt(0) ?? 0;
  if (cp < 0x300 && !(cp >= 0x1f1e6 && cp <= 0x1f1ff)) return end;
  // 慢路径：把剩余文本交给 Segmenter，取第一个 cluster 的码点数。
  const rest = chars.slice(start, to).join("");
  const g = graphemes(rest)[0];
  if (g === undefined) return end;
  end = start + toChars(g).length;
  return Math.min(end, to);
}

/**
 * 把 chars 的 `[from, to)` 段折成若干视觉行（绝对下标与 chars 一致）。
 * 断点空格回填规则见文件头注释。
 */
function wrapSegment(chars: string[], from: number, to: number, width: number, out: VisualLine[]): void {
  if (from >= to) {
    out.push({ text: "", start: from, end: from });
    return;
  }
  let i = from;
  while (i < to) {
    let cols = 0;
    let j = i;
    let lastSpace = -1;
    while (j < to) {
      // 按 grapheme 整体取宽，与 displayWidth 同口径（见 graphemeEnd 注释）。
      const end = graphemeEnd(chars, j, to);
      const chunk = chars.slice(j, end).join("");
      const cw = graphemeWidth(chunk);
      if (cols + cw > width) break;
      cols += cw;
      // 行首的空格不作为断点（否则会折出一行只有一个空格）。
      if (chunk === " " && j > i) lastSpace = j;
      j = end;
    }
    if (j >= to) {
      out.push({ text: chars.slice(i, to).join(""), start: i, end: to });
      return;
    }
    if (lastSpace >= 0) {
      // 断点空格留在上一行行尾，下一行从空格之后开始。
      const end = lastSpace + 1;
      // 必须在推进 i 之前判断：断点前是否已有非空白。有 → 这是词边界折行，
      // 断点后的连续空格是行首空白，应丢弃（否则 `"ab   cd"` 宽 3 会多出纯空格行）。
      // 无 → 整段就是空白（B1i），空格本身是内容，必须原样折行保留。
      const lineHadContent = chars.slice(i, lastSpace).some((c) => c !== " ");
      out.push({ text: chars.slice(i, end).join(""), start: i, end });
      i = end;
      if (lineHadContent) {
        while (i < to && chars[i] === " ") i += 1;
      }
      continue;
    }
    // 硬折：上一行已满且没有可用空白断点。
    let end = j;
    if (end === i) end = i + 1; // 单字宽于 width（如 width=1 的 CJK），强制放一个字
    out.push({ text: chars.slice(i, end).join(""), start: i, end });
    i = end;
    // 断点是空格时它放不进上一行：丢弃，不回填下一行。
    while (i < to && chars[i] === " ") i += 1;
  }
}

/**
 * 计算视觉行与光标行列。
 *
 * @param text   纯文本（可含 `\n`）
 * @param cursor code point 下标，0..len（越界自动 clamp）
 * @param width  可用显示列数，<=0/NaN 按 1 处理
 */
export function layoutBuffer(text: string, cursor: number, width: number): BufferLayout {
  const chars = toChars(text);
  const cols = normalizeWidth(width);
  const lines: VisualLine[] = [];

  let lineStart = 0;
  for (let i = 0; i <= chars.length; i += 1) {
    const atEnd = i === chars.length;
    if (atEnd || chars[i] === "\n") {
      wrapSegment(chars, lineStart, i, cols, lines);
      lineStart = i + 1;
    }
  }

  let pos = Number.isFinite(cursor) ? Math.trunc(cursor) : chars.length;
  pos = Math.max(0, Math.min(chars.length, pos));

  // 左闭右开：取「start <= pos」的最后一行，于是折行边界上的光标归后一行行首。
  // 被丢弃的断点空格 / 逻辑行换行符落在两行之间的空隙里，归上一行行尾（clamp 到 end）。
  let row = 0;
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k] as VisualLine;
    if (pos >= line.start) row = k;
    else break;
  }
  const current = lines[row] as VisualLine;
  const point = Math.min(Math.max(pos, current.start), current.end);
  const cursorCol = displayWidth(chars.slice(current.start, point).join(""));

  return { lines, cursorRow: row, cursorCol, cursorIndex: point };
}

/** 可变文本缓冲。`text` / `cursor` 是公开的唯一事实源，其余操作都只改这两个字段。 */
export class TextBuffer {
  text: string;
  /** code point 下标，0..length。 */
  cursor: number;

  /** 上下移动的 preferred column（显示列）；非垂直移动/编辑后失效。 */
  private goalCol: number | null = null;

  constructor(text = "") {
    this.text = text;
    this.cursor = toChars(text).length;
  }

  get chars(): string[] {
    return toChars(this.text);
  }

  get length(): number {
    return toChars(this.text).length;
  }

  setText(text: string, cursor?: number): void {
    this.text = text;
    this.cursor = this.clampCursor(cursor === undefined ? this.length : cursor);
    this.goalCol = null;
  }

  clear(): void {
    this.text = "";
    this.cursor = 0;
    this.goalCol = null;
  }

  /** 在 cursor 处插入字符串（可含 `\n`），cursor 前进插入内容的码点数。 */
  insert(s: string): void {
    const add = toChars(s);
    if (add.length > 0) {
      const chars = toChars(this.text);
      this.text = chars.slice(0, this.cursor).concat(add, chars.slice(this.cursor)).join("");
      this.cursor += add.length;
    }
    this.goalCol = null;
  }

  newline(): void {
    this.insert("\n");
  }

  /** 删 cursor 前一个 code point（中文一次一个整字，emoji 一次一个）。 */
  backspace(): void {
    if (this.cursor <= 0) {
      this.goalCol = null;
      return;
    }
    this.replaceRange(this.cursor - 1, this.cursor);
  }

  /** 删 cursor 处一个 code point。 */
  delete(): void {
    if (this.cursor >= this.length) {
      this.goalCol = null;
      return;
    }
    this.replaceRange(this.cursor, this.cursor + 1);
  }

  move(
    kind: "left" | "right" | "up" | "down" | "home" | "end" | "word-left" | "word-right",
    width: number,
  ): void {
    switch (kind) {
      case "left":
        this.cursor = this.clampCursor(this.cursor - 1);
        this.goalCol = null;
        return;
      case "right":
        this.cursor = this.clampCursor(this.cursor + 1);
        this.goalCol = null;
        return;
      case "home":
        this.cursor = this.logicalLineStart();
        this.goalCol = null;
        return;
      case "end":
        this.cursor = this.logicalLineEnd();
        this.goalCol = null;
        return;
      case "word-left":
        this.cursor = this.wordLeftPos();
        this.goalCol = null;
        return;
      case "word-right":
        this.cursor = this.wordRightPos();
        this.goalCol = null;
        return;
      case "up":
        this.moveVertical(-1, normalizeWidth(width));
        return;
      case "down":
        this.moveVertical(1, normalizeWidth(width));
        return;
    }
  }

  /** 删到当前逻辑行行尾（不含换行）。 */
  killToEnd(): void {
    this.replaceRange(this.cursor, this.logicalLineEnd());
  }

  /** 删到当前逻辑行行首（不含换行）。 */
  killToStart(): void {
    this.replaceRange(this.logicalLineStart(), this.cursor);
  }

  /** 等价 Ctrl+W。中文每次只删一个字，不吞整句。 */
  deleteWordLeft(): void {
    const target = this.wordLeftPos();
    if (target < this.cursor) this.replaceRange(target, this.cursor);
    else this.goalCol = null;
  }

  // ---- 内部 ----

  private clampCursor(n: number): number {
    if (!Number.isFinite(n)) return this.length;
    return Math.max(0, Math.min(this.length, Math.trunc(n)));
  }

  /** 替换 `[from, to)`，光标落在插入内容之后。 */
  private replaceRange(from: number, to: number, insert: string[] = []): void {
    const chars = toChars(this.text);
    const start = Math.max(0, Math.min(chars.length, from));
    const end = Math.max(start, Math.min(chars.length, to));
    this.text = chars.slice(0, start).concat(insert, chars.slice(end)).join("");
    this.cursor = start + insert.length;
    this.goalCol = null;
  }

  /**
   * 垂直移动：用**显示列**做 preferred column；目标行更短时 clamp 到行尾。
   * goalCol 只在连续 up/down 之间保留，非垂直移动或编辑后被清空。
   */
  private moveVertical(direction: -1 | 1, width: number): void {
    const layout = layoutBuffer(this.text, this.cursor, width);
    const targetRow = layout.cursorRow + direction;
    if (targetRow < 0 || targetRow >= layout.lines.length) return; // 首行/末行保持不动
    if (this.goalCol === null) this.goalCol = layout.cursorCol;
    const goal = this.goalCol;

    const line = layout.lines[targetRow] as VisualLine;
    const chars = toChars(this.text);
    let pos = line.start;
    let col = 0;
    while (pos < line.end) {
      // 与折行同口径：按 grapheme 整体取宽，否则 ❤️/👨‍👩‍👧‍👦 上会算错目标列。
      const next = graphemeEnd(chars, pos, line.end);
      const cw = graphemeWidth(chars.slice(pos, next).join(""));
      if (col + cw > goal) break;
      col += cw;
      pos = next;
    }
    // 左闭右开 + 边界归后一行行首：满宽视觉行的 end 会被映射到下一行，
    // 直接落 end 会「按 ↑ 却停在原地」。退一格保证落在目标行内（行尾前一个槽位）。
    if (pos === line.end && targetRow < layout.lines.length - 1) {
      pos = Math.max(line.start, pos - 1);
    }
    this.cursor = pos;
  }

  private logicalLineStart(): number {
    const chars = toChars(this.text);
    let i = this.cursor;
    while (i > 0 && chars[i - 1] !== "\n") i -= 1;
    return i;
  }

  private logicalLineEnd(): number {
    const chars = toChars(this.text);
    let i = this.cursor;
    while (i < chars.length && chars[i] !== "\n") i += 1;
    return i;
  }

  /** 向左找「一个词」：先跳空白；ASCII 连续段整段跳过；CJK/标点各算一个词。 */
  private wordLeftPos(): number {
    const chars = toChars(this.text);
    let i = this.cursor;
    while (i > 0 && isSpace(chars[i - 1] as string)) i -= 1;
    if (i <= 0) return 0;
    const prev = chars[i - 1] as string;
    if (isWordChar(prev)) {
      while (i > 0 && isWordChar(chars[i - 1] as string)) i -= 1;
    } else {
      i -= 1;
    }
    return i;
  }

  /** 向右找「一个词」：先跳空白；ASCII 连续段整段跳过；CJK/标点各算一个词。 */
  private wordRightPos(): number {
    const chars = toChars(this.text);
    let i = this.cursor;
    while (i < chars.length && isSpace(chars[i] as string)) i += 1;
    if (i >= chars.length) return chars.length;
    if (isWordChar(chars[i] as string)) {
      while (i < chars.length && isWordChar(chars[i] as string)) i += 1;
    } else {
      i += 1;
    }
    return i;
  }
}

/**
 * 提交历史导航（B4）。
 *
 * 语义：第一次 `up(current)` 记住 `prefix=current` 与 `draft=current`，之后只在
 * 满足 `startsWith(prefix)` 的条目里前后跳；`down` 到底返回草稿；`reset()`（提交后）
 * 清导航态。`push` 忽略空/纯空白与和上一条完全相同的输入。
 */
const HISTORY_LIMIT = 1000;

export class InputHistory {
  private readonly entries: string[];
  /** 当前选中的条目下标；=== entries.length 表示未在导航。 */
  private navIndex = 0;
  private prefix: string | null = null;
  private draft: string | null = null;

  constructor(entries: string[] = []) {
    this.entries = [...entries];
  }

  get size(): number {
    return this.entries.length;
  }

  push(line: string): void {
    if (line.trim() === "") return;
    if (this.entries[this.entries.length - 1] === line) {
      this.resetNav();
      return;
    }
    this.entries.push(line);
    this.resetNav();
  }

  /** 提交后复位导航状态（条目本身保留）。 */
  reset(): void {
    this.resetNav();
  }

  up(current: string): string | null {
    if (this.prefix === null) {
      this.prefix = current;
      this.draft = current;
      this.navIndex = this.entries.length;
    }
    const prefix = this.prefix;
    for (let i = this.navIndex - 1; i >= 0; i -= 1) {
      const entry = this.entries[i] as string;
      if (entry.startsWith(prefix)) {
        this.navIndex = i;
        return entry;
      }
    }
    return null;
  }

  down(_current: string): string | null {
    if (this.prefix === null) return null; // 还没向上翻过，没有可回退的导航态
    const prefix = this.prefix;
    for (let i = this.navIndex + 1; i < this.entries.length; i += 1) {
      const entry = this.entries[i] as string;
      if (entry.startsWith(prefix)) {
        this.navIndex = i;
        return entry;
      }
    }
    this.navIndex = this.entries.length;
    return this.draft;
  }

  private resetNav(): void {
    this.navIndex = this.entries.length;
    this.prefix = null;
    this.draft = null;
  }
}
