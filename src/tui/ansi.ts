/**
 * tui/ansi.ts — 文本宽度 / 折行 / 截断的纯函数（v0.3.0）。
 *
 * 为什么单独一层：
 *  - 渲染层（frame/composer/dock）到处需要「按显示列折行且不切断 ANSI」；
 *  - 生产与测试共用同一套口径（CJK=2、SGR=0 宽），避免各写一份魔法数。
 *
 * 约定：所有输入都是「可能带 SGR 的文本」，输出是若干行，每行 displayWidth ≤ width，
 * 且每行自带 active SGR 前缀 + 行尾 RESET（有颜色时），保证单独打印也正确。
 */
import { displayWidth, graphemeWidth, graphemes } from "../ui/theme.ts";

const RESET = "\x1b[0m";

interface Token {
  /** sgr = 零宽转义；char = 可见字符。 */
  kind: "sgr" | "char";
  s: string;
  w: number;
}

/** 把文本切成「SGR 序列」与「可见 grapheme」两类 token（宽度按终端实际列数）。 */
export function tokenizeAnsi(text: string): Token[] {
  const out: Token[] = [];
  let run = "";
  const flush = (): void => {
    if (run === "") return;
    for (const g of graphemes(run)) out.push({ kind: "char", s: g, w: graphemeWidth(g) });
    run = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\x1b") {
      // OSC 必须先于通用两字符转义匹配：`\x1b]` 会被 `^\x1b[@-_]` 吞成两字符，
      // 剩下的正文（超链接 URL、窗口标题）就会被当成可见字符计入宽度。
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(text.slice(i));
      if (osc) {
        flush();
        out.push({ kind: "sgr", s: osc[0], w: 0 });
        i += osc[0].length;
        continue;
      }
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i));
      if (m) {
        flush();
        out.push({ kind: "sgr", s: m[0], w: 0 });
        i += m[0].length;
        continue;
      }
      const two = /^\x1b[@-_]/.exec(text.slice(i));
      if (two) {
        flush();
        out.push({ kind: "sgr", s: two[0], w: 0 });
        i += two[0].length;
        continue;
      }
      // 裸 ESC：不构成任何合法转义（后面是普通字符或已到结尾）。
      // 它不渲染内容，但**不能留在输出里** —— 终端会进入转义状态吞掉后续字符，
      // 截断后行尾残留一个裸 ESC 尤其危险。直接丢弃，不产生 token。
      i += 1;
      continue;
    }
    const cp = text.codePointAt(i) as number;
    const glyph = String.fromCodePoint(cp);
    run += glyph;
    i += glyph.length;
  }
  flush();
  return out;
}

/**
 * 当前 active SGR：按参数列表语义累积，遇到 reset 参数清空已累积的部分。
 *
 * SGR 参数是分号分隔的列表，按顺序生效：
 *  - `\x1b[31;0m` = 先红再 reset → 净效果无色；
 *  - `\x1b[0;31m` = 先 reset 再红 → 净效果红色。
 * 旧实现只比较整串是否等于 "0"，把 `\x1b[31;0m` 当普通上色追加，下一行被错误染色。
 * 但「只要含 0 就整体清空」也是错的：会连 `\x1b[0;31m` 里的 `31` 一起丢掉，下一行丢色。
 * 所以按参数逐个走：0（含空参数，等价于 0）清空累积，其余继续累积。
 */
function nextActive(active: string, sgr: string): string {
  const m = /^\x1b\[([0-9;]*)m$/.exec(sgr);
  if (!m) return active;
  const params = (m[1] ?? "").split(";");
  let acc = active;
  let pending: string[] = [];
  const flushPending = (): void => {
    if (pending.length === 0) return;
    acc += `\x1b[${pending.join(";")}m`;
    pending = [];
  };
  for (const p of params) {
    if (p === "" || p === "0") {
      flushPending();
      acc = "";
      continue;
    }
    pending.push(p);
  }
  flushPending();
  return acc;
}

/**
 * 按显示列折行（ANSI 安全）。
 * 优先在空格处折行（空格不进入下一行），没有空格时硬折；单字符超宽时独占一行。
 */
export function wrapAnsi(text: string, width: number): string[] {
  const max = Math.max(1, Math.trunc(width));
  const tokens = tokenizeAnsi(text.replace(/\r\n/g, "\n"));
  const rows: string[] = [];
  let active = "";
  let rowStartActive = "";
  // 本行是否「可能带着未闭合的颜色」：行首有 active SGR，或行内出现过 SGR。
  // 只看 rowStartActive 会漏掉「行首无色、行内才上色」的行 —— 那种行到行尾颜色仍未闭合，
  // 不补 RESET 会让下一行/提示符继续染色。
  let rowHasSgr = false;
  let row: Token[] = [];
  let rowW = 0;

  const emitRow = (): void => {
    const body = row.map((t) => t.s).join("");
    rows.push(rowStartActive + body + (rowHasSgr ? RESET : ""));
    row = [];
    rowW = 0;
    rowStartActive = active;
    rowHasSgr = active !== "";
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === "sgr") {
      active = nextActive(active, t.s);
      // 行首的 SGR 归入 rowStartActive，不出现在 token 列表里（否则 emit 会重复）
      if (row.length === 0) rowStartActive = active;
      else row.push(t);
      rowHasSgr = true;
      continue;
    }
    // 逻辑换行：直接结束当前行
    if (t.s === "\n") {
      emitRow();
      rowStartActive = active;
      continue;
    }
    if (rowW + t.w > max && row.length > 0) {
      // 恰好塞满时遇到空格：空格本身就是断点，直接丢空格换行。
      // 例：max=11，"hello world" 已占满 11 列，下一个空格不该把 "hello" 拆出去。
      // 断点后的连续空格同样是「行首空白」，要一起丢 —— 与 buffer.ts 的 wrapSegment
      // 同口径，否则 `"ab   cd"` 宽 3 会折出 `["ab ", " cd"]`（下一行以空格开头），
      // 而输入框给出 `["ab ", "cd"]`。
      // 但整行都是空格时（纯空白行），空格就是内容本身，必须原样折行保留（B1i）。
      if (t.s === " ") {
        const rowHadContent = row.some((x) => x.kind === "char" && x.s !== " ");
        emitRow();
        if (rowHadContent) {
          // 有内容：断点空格与后续连续空格都是行首空白，一起丢。
          while (i + 1 < tokens.length && tokens[i + 1]!.kind === "char" && tokens[i + 1]!.s === " ") i += 1;
          continue;
        }
        // 纯空白行：这个空格是内容，放不进上一行就落到下一行行首，不能丢。
        // row 已被 emitRow 清空，直接放进新行（不能 continue，否则空格被吞）。
        row.push(t);
        rowW = t.w;
        continue;
      }
      // 找最后一个空格做词边界（空格不进入下一行）
      let spaceAt = -1;
      for (let k = row.length - 1; k >= 0; k--) {
        if (row[k]!.kind === "char" && row[k]!.s === " ") { spaceAt = k; break; }
      }
      // 只有断点前有「非空白内容」时才按词折行；纯缩进开头一律硬折，
      // 否则 `"  （长行）"` 会被拆成只有空格的残行。
      const breakable = spaceAt > 0 && row.slice(0, spaceAt).some((x) => x.kind === "char" && x.s !== " ");
      if (breakable) {
        // 断点空格留在上一行行尾；断点后的连续空格是「行首空白」，一并丢弃。
        // 与 buffer.ts 的 wrapSegment 同口径 —— 否则 `"ab   cd"` 宽 3 会折出
        // `["ab ", " cd"]`（下一行以空格开头），而输入框给出 `["ab ", "cd"]`。
        const keep = row.slice(0, spaceAt + 1);
        let rest = row.slice(spaceAt + 1);
        while (rest.length > 0 && rest[0]!.kind === "char" && rest[0]!.s === " ") rest = rest.slice(1);
        row = keep;
        emitRow();
        row = rest;
        rowW = rest.reduce((n, x) => n + x.w, 0);
      } else {
        emitRow();
      }
      if (rowW + t.w > max && row.length > 0) emitRow(); // 极端：rest 仍超宽
    }
    row.push(t);
    rowW += t.w;
  }
  if (row.length > 0 || rows.length === 0) {
    const body = row.map((t) => t.s).join("");
    rows.push(rowStartActive + body + (rowHasSgr ? RESET : ""));
  }
  return rows;
}

/** 按显示列截断（ANSI 安全；保留已出现的颜色，末尾补 RESET）。 */
export function truncateAnsi(text: string, max: number): string {
  const budget = Math.max(0, Math.trunc(max));
  // 快路径只在「没有裸 ESC」时成立：裸 ESC 零宽，宽度检查会放行，
  // 但它必须被剥掉（见 tokenizeAnsi），所以含 ESC 时一律走完整路径。
  if (!text.includes("\x1b") && displayWidth(text) <= budget) return text;
  const tokens = tokenizeAnsi(text);
  let out = "";
  let w = 0;
  let active = "";
  for (const t of tokens) {
    if (t.kind === "sgr") { out += t.s; active = nextActive(active, t.s); continue; }
    if (w + t.w > budget) break;
    out += t.s;
    w += t.w;
  }
  return out + (active ? RESET : "");
}

/** 剥掉所有 ANSI 序列（不含换行处理），用于把外部传来的「已着色提示」还原成纯文本。 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC（超链接/标题）：正文必须整体剥掉
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\x1b/g, ""); // 裸 ESC：不构成合法转义，但同样不可见、且会污染终端状态
}
