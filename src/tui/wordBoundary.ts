/**
 * tui/wordBoundary.ts — 输入框的**唯一**词边界规则（issue #79）。
 *
 * 为什么单独一个文件：按词移动（Alt+B/F、Ctrl/Alt+←/→）与按词删除
 * （Alt+D、Ctrl+Backspace、Alt+Backspace）必须共用同一套判定，否则
 * 「按词左移三次」与「按词删三次」会删到不同的地方 —— 这类分叉极难被用户描述清楚。
 *
 * 词类（`wordClass`）：
 *  - `alnum`：ASCII 字母数字连续段（`[A-Za-z0-9]`）。`_` `.` `/` `-` 等标点**不是**词字符，
 *    各自算分隔 —— 于是 `src/tui/keys.ts` 按词左移是 `ts` → `.` → `keys` → `/` → `tui` → `/` → `src`。
 *  - `han` / `hiragana` / `katakana` / `hangul`：中日韩按 Unicode script 连续段成词，
 *    `你好世界` 是一词、`こんにちは` 是一词；ASCII 与 CJK 相邻处也切开（`中文abc词` → 中文 / abc / 词）。
 *  - `space`：空白（按词移动时整段跳过）。
 *  - `other`：其余标点/符号，**单个**成词。
 *
 * 注意与 Ctrl+W（`deleteWordLeft`）的区别：Ctrl+W 是「删到上一空白」，一次吃掉
 * 整段路径或无空白的整句中文；本文件只管「按词」。
 */

/** 词类。 */
export type WordClass = "alnum" | "han" | "hiragana" | "katakana" | "hangul" | "space" | "other";

function isAlnum(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

function isSpaceCp(cp: number): boolean {
  // 只认「空白」语义：空格 / 制表 / 换行 / 回车 / 全角空格。
  // 不认 \u200b 之类零宽字符（它们不是空白，按 other 处理，避免把不可见字符当分隔吃掉）。
  return cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x3000;
}

/** 单个码点的词类（按码点，不按 grapheme —— 词边界只需要 base 字符）。 */
export function wordClass(ch: string): WordClass {
  const cp = ch.codePointAt(0) ?? 0;
  if (isSpaceCp(cp)) return "space";
  if (isAlnum(cp)) return "alnum";
  // CJK 统一表意文字（含扩展 A、兼容区）
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) {
    return "han";
  }
  if (cp >= 0x3040 && cp <= 0x309f) return "hiragana";
  if (cp >= 0x30a0 && cp <= 0x30ff) return "katakana";
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)) return "hangul";
  return "other";
}

/** 该词类是否「成段」（连续同类算一个词）；`other` 与 `space` 各自单算。 */
function isRun(cls: WordClass): boolean {
  return cls === "alnum" || cls === "han" || cls === "hiragana" || cls === "katakana" || cls === "hangul";
}

/**
 * 从 `pos` 向左找「一个词」的起点：先跳空白，再整段跳过同类词。
 * 返回 0..pos（`pos` 处已是行首时返回 0）。
 */
export function wordLeftIndex(chars: string[], pos: number): number {
  let i = Math.max(0, Math.min(chars.length, pos));
  while (i > 0 && wordClass(chars[i - 1] as string) === "space") i -= 1;
  if (i <= 0) return 0;
  const cls = wordClass(chars[i - 1] as string);
  if (!isRun(cls)) return i - 1; // 标点：单个成词
  while (i > 0 && wordClass(chars[i - 1] as string) === cls) i -= 1;
  return i;
}

/**
 * 从 `pos` 向右找「一个词」的终点：先跳空白，再整段跳过同类词。
 * 返回 pos..chars.length。
 */
export function wordRightIndex(chars: string[], pos: number): number {
  let i = Math.max(0, Math.min(chars.length, pos));
  while (i < chars.length && wordClass(chars[i] as string) === "space") i += 1;
  if (i >= chars.length) return chars.length;
  const cls = wordClass(chars[i] as string);
  if (!isRun(cls)) return i + 1;
  while (i < chars.length && wordClass(chars[i] as string) === cls) i += 1;
  return i;
}

/**
 * 从 `pos` 向左找「上一空白之后」的位置（Ctrl+W 用）。
 *
 * 先跳空白，再一路吃到空白/行首 —— 于是 `src/tui/keys.ts` 整段一次删掉，
 * 无空白的中文整句也一次删掉（与按词删除刻意区分）。
 */
export function whitespaceLeftIndex(chars: string[], pos: number): number {
  let i = Math.max(0, Math.min(chars.length, pos));
  while (i > 0 && wordClass(chars[i - 1] as string) === "space") i -= 1;
  while (i > 0 && wordClass(chars[i - 1] as string) !== "space") i -= 1;
  return i;
}
