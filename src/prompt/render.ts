/**
 * 核心提示词渲染：会话名替换与子代理身份句。
 * 三档正文在 tiers.ts（脚本生成，勿手改）。
 */
import { TIER_CORE, type PromptTier } from "./tiers.ts";

const MAX_NAME_LEN = 32;
// 控制字符与行/段分隔符（U+2028/U+2029）；用转义写，避免源码里出现字面换行。
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "g");

/** 会话名作为宿主生成的短标签：去控制字符/换行、限长；空则回退 neo，避免名字内容成为新指令。 */
export function sanitizeSessionName(name: string | null | undefined): string {
  const cleaned = (name ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN)
    .trim();
  return cleaned || "neo";
}

/** 渲染某档核心：把 ${sessionName} 换成清洗后的名字。用函数替换，避免名字里的 `$&` 等被当成替换模式。 */
export function renderCore(tier: PromptTier, sessionName: string | null | undefined): string {
  const name = sanitizeSessionName(sessionName);
  return TIER_CORE[tier].replaceAll("${sessionName}", () => name);
}

/**
 * 子代理核心：只把第一个句号之前的身份句换成「你是 ${sessionName} 派出的子代理。」，
 * 其余全文保留（不做全局替换，避免误改后文）。sessionName 是派出它的主会话名，不是后端模型名。
 */
export function renderSubagentCore(tier: PromptTier, parentSessionName: string | null | undefined): string {
  const name = sanitizeSessionName(parentSessionName);
  const raw = TIER_CORE[tier];
  const stop = raw.indexOf("。");
  const rest = stop === -1 ? "" : raw.slice(stop + 1);
  return `你是 ${name} 派出的子代理。${rest}`;
}
