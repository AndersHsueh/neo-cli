/**
 * 系统开销计数（估计路径）。
 *
 * 没有目标 tokenizer，因此结果一律是「估计」：按字符类别保守估算，再加工具 schema、
 * 协议开销与 20% 余量。这不是严格上界，不能据此保证任何后端都不溢出。
 *
 * 分类别而不是统一按「字符数×1.5」：该比例只适合 CJK，对 ASCII/JSON（工具 schema 约占总开销一半）
 * 会高估 4 倍以上，导致小窗口永远判成超预算。实测（cl100k）：工具 schema 5168 字符 ≈ 2096 token，
 * 中文约 1.0–1.3 字符/token。
 */
import { estimateTokens, type Message, type ToolSpec } from "../llm.ts";

/** 每条消息的封装余量（role/分隔符）。 */
const MESSAGE_OVERHEAD = 4;
/** 未知 tokenizer 的计数余量。 */
const SAFETY_MARGIN = 0.2;
/** 保守取 1 字符/token 计 CJK（实测 cl100k 约 1.0–1.3 字符/token，低估会溢出，高估只是偏保守）。 */
const CJK_CHARS_PER_TOKEN = 1;
/** ASCII/JSON 取 3 字符/token（比 estimateTokens 的 4 更保守；实测 JSON schema 约 2.5 字符/token）。 */
const ASCII_CHARS_PER_TOKEN = 2.5;

const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/g;

export interface SystemOverhead {
  /** 估计的完整系统开销（含工具 schema、封装与余量）。 */
  tokens: number;
  /** 计数口径；目前恒为估计。 */
  tokenizer: "estimate";
}

function conservativeTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN + other / ASCII_CHARS_PER_TOKEN);
}

export function countSystemTokens(systemTexts: readonly string[], tools: readonly ToolSpec[] = []): SystemOverhead {
  const messages: Message[] = systemTexts.map((content) => ({ role: "system", content }));
  const heuristic = estimateTokens(messages, [...tools]);
  const conservative =
    systemTexts.reduce((n, s) => n + conservativeTokens(s), 0) +
    (tools.length > 0 ? conservativeTokens(JSON.stringify(tools)) : 0) +
    systemTexts.length * MESSAGE_OVERHEAD;
  const base = Math.max(heuristic, conservative);
  return { tokens: Math.ceil(base * (1 + SAFETY_MARGIN)), tokenizer: "estimate" };
}
