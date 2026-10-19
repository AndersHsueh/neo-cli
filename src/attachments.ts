/**
 * attachments.ts —— 附件 chip 生成与还原（PRD docs/paste-enhancement-prd.md §5.3/§5.4）。
 *
 * M1 范围：文本附件（长文本折叠）。图片附件（kind:"image"）随 M2 剪贴板扩展。
 *
 * chip 语义（PRD §3，与 Claude Code 对齐）：
 *  - 编号 N 会话内递增，图片与文本各自独立（M1 只有文本）；
 *  - chip 是普通文本，用户可手动删除；删除 = 放弃附件（resolveLine 不还原）；
 *  - 还原只认 pending 附件里的精确 chip 串——用户手打同款字样不误还原（PRD 测试 2）。
 *
 * 编号由调用方传入（index.ts 持有会话级计数器），本模块零模块级可变状态——
 * 规避 bun test 单进程模块表共享的污染问题（踩坑 #6 同源教训）。
 */

export interface TextAttachment {
  kind: "text";
  /** 精确 chip 串，如 `[Pasted text #1 +3 lines]`。 */
  chip: string;
  /** 折叠的完整原文。 */
  content: string;
  /** 原文行数（chip 里的 +X lines）。 */
  lines: number;
}

/** 生成 chip 串（纯函数）。 */
export function makeTextChip(n: number, lines: number): string {
  return `[Pasted text #${n} +${lines} lines]`;
}

/** 输入队列元素（PRD §5.4）：行文本（含 chip）+ 该行绑定的附件。 */
export interface QueuedLine {
  text: string;
  attachments: TextAttachment[];
}

/** 由原文构造文本附件（纯函数）。n = 会话内递增编号。 */
export function makeTextAttachment(n: number, content: string): TextAttachment {
  const lines = content.split("\n").length;
  return { kind: "text", chip: makeTextChip(n, lines), content, lines };
}

/**
 * 把行内 chip 还原为原文（纯函数）。
 * 只处理 attachments 里登记的 chip；chip 已被用户删除 → 该附件静默丢弃。
 * 手打的同款字样因不在 attachments 里而不受影响。
 */
export function resolveLine(text: string, attachments: TextAttachment[]): string {
  let out = text;
  for (const a of attachments) {
    if (out.includes(a.chip)) out = out.split(a.chip).join(a.content);
  }
  return out;
}

/**
 * 行提交时绑定附件：从 pending 里挑出 chip 仍在本行内的那些（纯函数）。
 * 返回的数组随 QueuedLine 入队，drain 时交给 resolveLine。
 */
export function bindAttachments(text: string, pending: TextAttachment[]): TextAttachment[] {
  return pending.filter((a) => text.includes(a.chip));
}
