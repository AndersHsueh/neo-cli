/**
 * 上下文压缩的切分与摘要提示。
 *
 * 这里不发请求。循环负责调用模型、计 token、写回历史。
 * 切点规则单独放，是因为拆错 assistant(tool_calls) 与 tool 结果，下一轮会被服务端拒绝。
 */
import { contentText, estimateTokens, type Message } from "../llm.ts";
import { ToolError } from "../tools/types.ts";
import { isRecallMessage } from "../memory/port.ts";
import { truncateArgs } from "./render.ts";

/** 压缩后保留的近期原文条数（上限）。最近的路径/命令/错误细节靠它活着。 */
export const COMPACT_KEEP_TAIL = 6;
/** 喂给摘要器的单条消息字符上限。旧的 160 字符会砍掉路径、命令与错误栈。 */
export const COMPACT_MSG_CHAR_CAP = 2_000;
/** 摘要器输入总字符上限，防止一次压缩把窗口再撑爆。 */
export const COMPACT_INPUT_CHAR_CAP = 60_000;

export interface CompactionPlan {
  /** 将被摘要替换的较早消息。 */
  head: Message[];
  /** 保留原文的近期消息。 */
  tail: Message[];
  /** 喂给压缩器的 user 提示。 */
  prompt: string;
  /** 压缩前、去掉召回临时消息后的估算 token。 */
  convoTokens: number;
}

function clip(s: string, max = COMPACT_MSG_CHAR_CAP): string {
  return s.length > max ? `${s.slice(0, max)}…[截断 ${s.length - max} 字符]` : s;
}

/**
 * 从当前历史算出安全切点。
 *
 * 只能在消息序列已经配对完整时调用。召回临时消息不是历史的一部分，输入与输出都不含它。
 */
export function planCompaction(messages: Message[]): CompactionPlan {
  const convo = messages.slice(1).filter((m) => !isRecallMessage(m));
  if (convo.length < 4) {
    throw new ToolError("对话太短，压缩不划算（非 system 消息不足 4 条）");
  }

  // 切点必须落在 user 消息之前：assistant(tool_calls) 与紧随其后的 tool 结果不会被拆开。
  // 保留条数优先 6 条；历史较短时按「至少给摘要留 2 条」退让，而不是按一半砍。
  const desiredTail = Math.min(COMPACT_KEEP_TAIL, Math.max(2, convo.length - 2));
  let cut = Math.max(0, convo.length - desiredTail);
  while (cut > 0 && convo[cut]?.role !== "user") cut -= 1;
  if (cut === 0) {
    const lastUser = convo.map((m) => m.role).lastIndexOf("user");
    if (lastUser > 0) {
      cut = lastUser;
    } else {
      cut = Math.max(1, convo.length - 1);
      while (cut > 0 && convo[cut]?.role === "tool") cut -= 1;
    }
  }
  const head = convo.slice(0, cut);
  const tail = convo.slice(cut);
  if (head.length === 0) throw new ToolError("找不到可压缩的安全切点");

  let convoText = head
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls
          .map((tc) => `${tc.function.name}(${truncateArgs(tc.function.arguments, 500)})`)
          .join("; ");
        return `assistant(tool_call): ${clip(calls)}`;
      }
      if (m.role === "tool") return `tool(${m.name ?? ""}): ${clip(contentText(m.content) ?? "")}`;
      return `${m.role}: ${clip(contentText(m.content) ?? "")}`;
    })
    .join("\n");
  if (convoText.length > COMPACT_INPUT_CHAR_CAP) {
    convoText = `${convoText.slice(0, COMPACT_INPUT_CHAR_CAP)}\n…[较早历史过长，已截断 ${convoText.length - COMPACT_INPUT_CHAR_CAP} 字符]`;
  }

  const prompt =
    `请把下面的对话历史压缩成一份结构化摘要，供后续继续工作使用。\n` +
    `必须保留：用户的目标与明确要求、已确定的事实与结论、已改动的文件路径、关键代码片段、待办事项与未解决问题。\n` +
    `丢弃：寒暄、重复内容、冗长的工具原始输出。\n` +
    `输出纯文本摘要，不要加前言。\n` +
    `注意：最近 ${tail.length} 条消息已保留原文、不在此次压缩范围内；摘要只需覆盖下面这段较早的历史。\n\n` +
    `【较早的历史（共 ${head.length} 条消息）】\n${convoText}`;

  return { head, tail, prompt, convoTokens: estimateTokens(convo) };
}

/** 用摘要替换较早历史，保留 system 与近期原文。 */
export function applyCompaction(messages: Message[], summary: string, plan: CompactionPlan): Message[] {
  const sys = messages[0]?.role === "system" ? messages[0] : undefined;
  const summaryMsg: Message = {
    role: "user",
    content:
      `<对话摘要>\n${summary}\n</对话摘要>\n\n` +
      `（较早的 ${plan.head.length} 条消息已压缩为上述摘要；最近 ${plan.tail.length} 条保留原文。）`,
  };
  return [...(sys ? [sys] : []), summaryMsg, ...plan.tail];
}
