/**
 * attachments.ts —— 附件 chip 生成与还原（PRD docs/paste-enhancement-prd.md §5.3/§5.4）。
 *
 * chip 语义（PRD §3，与 Claude Code 对齐）：
 *  - 编号 N 会话内递增，图片与文本各自独立计数（调用方持有两个计数器）；
 *  - chip 是普通文本，用户可手动删除；删除 = 放弃附件（resolve 不还原/不发送）；
 *  - 还原只认 pending 附件里的精确 chip 串——用户手打同款字样不误还原（PRD 测试 2）。
 *
 * 编号由调用方传入，本模块零模块级可变状态——
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

export interface ImageAttachment {
  kind: "image";
  /** 精确 chip 串，如 `[Image #1]`。 */
  chip: string;
  /** data URL（data:image/png;base64,…），发送时作为 image_url part。 */
  dataUrl: string;
  /** 原始字节数（UI 反馈用）。 */
  bytes: number;
}

export type Attachment = TextAttachment | ImageAttachment;

/** 生成文本 chip 串（纯函数）。 */
export function makeTextChip(n: number, lines: number): string {
  return `[Pasted text #${n} +${lines} lines]`;
}

/** 由原文构造文本附件（纯函数）。n = 会话内递增编号。 */
export function makeTextAttachment(n: number, content: string): TextAttachment {
  const lines = content.split("\n").length;
  return { kind: "text", chip: makeTextChip(n, lines), content, lines };
}

/** 生成图片 chip 串（纯函数）。 */
export function makeImageChip(n: number): string {
  return `[Image #${n}]`;
}

/** 由 PNG 字节构造图片附件（纯函数）。n = 会话内独立递增编号。 */
export function makeImageAttachment(n: number, data: Buffer): ImageAttachment {
  return {
    kind: "image",
    chip: makeImageChip(n),
    dataUrl: `data:image/png;base64,${data.toString("base64")}`,
    bytes: data.length,
  };
}

/** 输入队列元素（PRD §5.4）：行文本（含 chip）+ 该行绑定的附件。 */
export interface QueuedLine {
  text: string;
  attachments: Attachment[];
}

export interface ResolvedLine {
  /** 纯文本：文本 chip 已还原为原文，图片 chip 已剔除。 */
  text: string;
  /** 行内仍存在的图片附件的 data URL（按出现顺序）。 */
  images: string[];
}

/**
 * 行提交还原（纯函数，PRD §5.4 resolveLine）。
 *  - 文本 chip 仍在行内 → 替换为原文；
 *  - 图片 chip 仍在行内 → 收集进 images（发送时组装 image_url part）；
 *  - chip 已被用户删除 → 该附件静默丢弃；
 *  - 手打同款字样因不在 attachments 里而不受影响。
 */
export function resolveLine(text: string, attachments: Attachment[]): ResolvedLine {
  let out = text;
  const images: string[] = [];
  for (const a of attachments) {
    if (!out.includes(a.chip)) continue; // chip 被删 → 丢弃
    if (a.kind === "text") out = out.split(a.chip).join(a.content);
    else {
      images.push(a.dataUrl);
      out = out.split(a.chip).join("");
    }
  }
  return { text: out, images };
}

/**
 * 行提交时绑定附件：从 pending 里挑出 chip 仍在本行内的那些（纯函数）。
 * 返回的数组随 QueuedLine 入队，drain 时交给 resolveLine。
 */
export function bindAttachments(text: string, pending: Attachment[]): Attachment[] {
  return pending.filter((a) => text.includes(a.chip));
}
