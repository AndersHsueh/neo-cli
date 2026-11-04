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

/** HTML/XML 共用命名实体表（web_fetch 与 web_search）。 */
export const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 命名 / 数字字符引用一次扫完。`&#39;` 走十进制分支（码点 39 → `'`），勿塞进命名组。 */
const HTML_ENTITY = /&(?:(amp|lt|gt|quot|apos|nbsp)|#[xX]([0-9a-fA-F]+)|#(\d+));/g;

/**
 * 解码 HTML 实体（`&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;` + 数字引用）。
 *
 * 为什么必须是**单次扫描**（v0.4.23）：旧版 htmlToText 用链式 `.replace()`，
 * `&amp;lt;b&amp;gt;`（网页里字面量 `<b>` 的正规写法）会先变 `&lt;b&gt;` 再变
 * `<b>`，随后被 `/<[^>]+>/g` 当标签剥掉 —— 内容静默丢失。链式替换怎么排序都逃不掉
 * （`&amp;` 放最后则 `&amp;amp;` 又错）。
 *
 * 注意「两遍」也不等于单次解码：先命名再数字时，`&amp;#65;` 第一遍变 `&#65;`，
 * 第二遍又解成 `A`。命名与数字必须在**同一个 replace** 里匹配。
 * 与 webSearch 的 `decodeXml` 同构。
 */
export function decodeHtmlEntities(s: string): string {
  return s.replace(
    HTML_ENTITY,
    (m, name: string | undefined, hex: string | undefined, dec: string | undefined) => {
      if (name) return NAMED_ENTITIES[name] ?? m;
      if (hex) return codePointToString(parseInt(hex, 16), m);
      return codePointToString(Number(dec), m);
    },
  );
}
