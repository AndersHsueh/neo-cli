/**
 * HTML / XML 字符实体解码 —— web_fetch（htmlToText）与 web_search（decodeXml）共用。
 *
 * 为什么单独拆出来：v0.4.19 / v0.4.20 两次修「越界数字实体」时，同一份
 * `codePointToString` 在 index.ts 和 webSearch.ts 各写了一遍，实体表也开始漂移
 * （`&apos;` 只有 XML 侧认）。共享一份后，行为一致性由模块保证，而不是靠两次手改对齐。
 *
 * 零依赖叶子模块，不 import 任何工具代码，避免引入循环依赖。
 */

/**
 * 数字字符引用 → 字符。码点越界（> 0x10FFFF）、落在代理区（0xD800–0xDFFF）
 * 或为 NUL（0）时原样保留。
 *
 * 越界/代理区：`String.fromCodePoint` 会抛 RangeError，而引用来自外部网页与
 * RSS，畸形实体（如 `&#1114112;`）不该让整个工具崩掉。
 *
 * NUL（v0.4.21）：`&#0;` 是合法码点，`String.fromCodePoint(0)` 不抛错，但解出来
 * 的 U+0000 会污染下游 —— 进模型上下文、进终端渲染、进 JSON 序列化都是纯噪声，
 * 且肉眼不可见（排查时表现为「字符串莫名截断」）。原样保留成可见文本更有用。
 *
 * `raw` 是匹配到的原文（`&#1114112;` 或 `&#x110000;`），原样返回时不改写进制。
 */
export function codePointToString(cp: number, raw: string): string {
  if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return raw;
  }
  return String.fromCodePoint(cp);
}

/**
 * 解码**数字**字符引用（十进制 `&#65;` 与十六进制 `&#x41;` / `&#X41;`）。
 * 命名实体（`&amp;` 等）由调用方按各自场景处理：HTML 与 XML 的实体表并不相同。
 */
export function decodeNumericEntities(s: string): string {
  return s
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (m, h: string) => codePointToString(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d: string) => codePointToString(Number(d), m));
}
