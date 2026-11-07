/**
 * 系统开销计数（估计路径）。
 *
 * 没有目标 tokenizer，因此结果一律是「估计」：取 estimateTokens 与「字符数×1.5」的较大值作保守起点，
 * 再加工具 schema、协议开销与 20% 余量。这不是严格上界，不能据此保证任何后端都不溢出。
 */
import { estimateTokens, type Message, type ToolSpec } from "../llm.ts";

/** 每条消息的封装余量（role/分隔符）。 */
const MESSAGE_OVERHEAD = 4;
/** 未知 tokenizer 的计数余量。 */
const SAFETY_MARGIN = 0.2;

export interface SystemOverhead {
  /** 估计的完整系统开销（含工具 schema、封装与余量）。 */
  tokens: number;
  /** 计数口径；目前恒为估计。 */
  tokenizer: "estimate";
}

export function countSystemTokens(systemTexts: readonly string[], tools: readonly ToolSpec[] = []): SystemOverhead {
  const messages: Message[] = systemTexts.map((content) => ({ role: "system", content }));
  const chars = systemTexts.reduce((n, s) => n + s.length, 0) + JSON.stringify(tools).length;
  const heuristic = estimateTokens(messages, [...tools]);
  const conservative = Math.ceil(chars * 1.5) + systemTexts.length * MESSAGE_OVERHEAD;
  const base = Math.max(heuristic, conservative);
  return { tokens: Math.ceil(base * (1 + SAFETY_MARGIN)), tokenizer: "estimate" };
}
