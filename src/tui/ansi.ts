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
      flush();
      out.push({ kind: "sgr", s: ch, w: 0 });
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

/** 当前 active SGR：遇到 reset 清空，其余按出现顺序保留（可能冗余，但保证颜色正确）。 */
function nextActive(active: string, sgr: string): string {
  const m = /^\x1b\[([0-9;]*)m$/.exec(sgr);
  if (!m) return active;
  const params = m[1] ?? "";
  if (params === "" || params === "0") return "";
  return active + sgr;
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
  let row: Token[] = [];
  let rowW = 0;

  const emitRow = (): void => {
    const body = row.map((t) => t.s).join("");
    rows.push(rowStartActive + body + (rowStartActive ? RESET : ""));
    row = [];
    rowW = 0;
    rowStartActive = active;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind === "sgr") {
      active = nextActive(active, t.s);
      // 行首的 SGR 归入 rowStartActive，不出现在 token 列表里（否则 emit 会重复）
      if (row.length === 0) rowStartActive = active;
      else row.push(t);
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
      if (t.s === " ") {
        emitRow();
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
        const keep = row.slice(0, spaceAt);
        const rest = row.slice(spaceAt + 1);
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
    rows.push(rowStartActive + body + (rowStartActive ? RESET : ""));
  }
  return rows;
}

/** 按显示列截断（ANSI 安全；保留已出现的颜色，末尾补 RESET）。 */
export function truncateAnsi(text: string, max: number): string {
  const budget = Math.max(0, Math.trunc(max));
  if (displayWidth(text) <= budget) return text;
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
    .replace(/\x1b[@-_]/g, "");
}
