/**
 * tui/sanitizeInput.ts — 提交前剥掉不可见 Unicode（issue #79 P1.10）。
 *
 * 为什么在**提交时**做而不是输入时：粘贴/IME 带进来的零宽字符在编辑时看不见，
 * 用户无法判断自己删掉了什么；提交时统一剥掉，模型收到的文本才干净。
 *
 * 必须保留：
 *  - 换行 `\n`（多行消息）与普通空格；
 *  - emoji ZWJ 序列里的 U+200D 与 variation selector（U+FE0E/U+FE0F）——
 *    剥掉它们会把 `👨‍👩‍👧‍👦` 拆成四个独立 emoji、把 `❤️` 变成黑白爱心。
 *
 * 剥掉：零宽空格/连接符（除 ZWJ 外）、BOM、双向控制符（LRM/RLM/嵌入/覆盖/隔离）、
 * 软连字符、word joiner、以及其它 Cf 类格式字符（Mongolian vowel separator 等）。
 */

/**
 * 不可见格式字符集合。
 *
 * 用显式码点而不是 `\p{Cf}` 全类：`\p{Cf}` 会连 ZWJ（U+200D）一起吃掉，
 * 而 ZWJ 是 emoji 组合序列的粘合剂，必须保留。
 */
const INVISIBLE =
  /[\u00AD\u061C\u070F\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0]/g;

/** 剥掉不可见 Unicode（保留换行、空格、ZWJ 与 variation selector）。 */
export function stripInvisible(text: string): string {
  if (text === "") return text;
  return text.replace(INVISIBLE, "");
}
