/**
 * ui/transcript.ts — 会话恢复回放（v0.2.3 D4，纯函数）。
 *
 * `--resume` 只打一行「已恢复会话」，屏幕是空的；上下文虽然都在，
 * 人却不知道上次聊到哪。这里从 messages 切出最近 N 轮并渲染成行，
 * IO（打印、着色开关）由调用方负责 —— 便于 bun test 直测。
 */
import { contentText, type Message } from "../llm.ts";
import { renderMarkdown } from "./render.ts";
import { c, truncate } from "./theme.ts";

export interface TranscriptOptions {
  /** 回放最近几轮（一个 user 消息起一轮），默认 3。 */
  turns?: number;
  /** 渲染宽度，默认 100。 */
  width?: number;
  /** 总行数上限（含分隔空行与截断提示），默认 120。 */
  maxLines?: number;
}

/** 用户行：首行 `❯ `，续行两空格缩进（与输入框视觉对齐）。 */
function formatUser(text: string, width: number): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines.map((l, i) => {
    const t = truncate(l, Math.max(8, width - 4));
    return i === 0 ? `${c.accent("❯")} ${t}` : `  ${c.muted(t)}`;
  });
}

/** 助手行：正文走 renderMarkdown，首行加 `● `，其余保持块级渲染结果。 */
function formatAssistant(text: string, width: number): string[] {
  const rendered = renderMarkdown(text.trim(), width).split("\n");
  return rendered.map((l, i) => (i === 0 ? `${c.accent("●")} ${l}` : l));
}

/**
 * 把一轮压到 budget 行以内。超出时保留**头部**（问题与结论通常在前），
 * 末尾补一行提示 —— 单段超长回答（几百行代码）不能让回放直接刷屏。
 */
function clampBlock(block: string[], budget: number): string[] {
  if (block.length <= budget) return block;
  const keep = Math.max(1, budget - 1);
  return [...block.slice(0, keep), c.dim(`… 本段还有 ${block.length - keep} 行未显示`)];
}

export function transcriptLines(messages: Message[], opts: TranscriptOptions = {}): string[] {
  const turns = Math.max(1, opts.turns ?? 3);
  const width = Math.max(20, opts.width ?? 100);
  const maxLines = Math.max(2, opts.maxLines ?? 120);

  // 按 user 消息切轮；system / tool / 空正文（纯工具调用轮）不进回放
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (cur && cur.length > 0) blocks.push(cur);
      cur = [];
      const text = (contentText(m.content) ?? "").trim();
      if (text) cur.push(...formatUser(text, width));
      continue;
    }
    if (m.role !== "assistant") continue;
    // 历史被裁剪/压缩后可能以 assistant 开头：没有 user 起头也照常回放
    if (cur === null) cur = [];
    const text = (contentText(m.content) ?? "").trim();
    if (text) cur.push(...formatAssistant(text, width));
  }
  if (cur && cur.length > 0) blocks.push(cur);
  if (blocks.length === 0) return [];

  // 从最新一轮往回取，直到行数预算用完 —— 保证「最近的」一定显示
  const picked: string[][] = [];
  let used = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const separator = picked.length === 0 ? 0 : 1; // 轮次间空行
    // 单轮也要能压进预算：至少留 2 行（1 行内容 + 1 行截断提示）
    const budget = Math.max(2, maxLines - used - separator);
    if (picked.length > 0 && used + separator + Math.min(blocks[i]!.length, 2) > maxLines) break;
    const block = clampBlock(blocks[i]!, budget);
    picked.unshift(block);
    used += block.length + separator;
    if (picked.length >= turns) break;
  }

  const out: string[] = [];
  const hidden = blocks.length - picked.length;
  if (hidden > 0) out.push(c.dim(`… 更早的 ${hidden} 轮未显示（工具输出不回放）`));
  const body: string[] = [];
  for (const b of picked) {
    if (body.length > 0) body.push("");
    body.push(...b);
  }
  out.push(...body);
  return out;
}
