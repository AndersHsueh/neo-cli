/**
 * profile.ts — 记忆系统 profile 注入（PRD docs/memory-prd.md §5.4 / §7.1 C 类）。
 *
 * 三层截断 fallback（约束 12a）：
 *   L1 段落边界（`\n\n`）落入 [400, 600] tokens 区间 → 截到最近段落边界
 *   L2 标题边界（`/^#{1,6}\s+.+$/m`）落入区间 → 截到最近标题边界
 *   L3 上述都不落入 → 二分查找硬截断到 500 tokens 字符边界
 *
 * 并列规则：<500 与 >500 都接受；选绝对距离 |i - 500| 最小者；并列时取 ≤500 那个。
 * stderr WARN 走 console.error（不可污染 LLM 流）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../llm.ts";
import { MemoryError } from "./types.ts";
import type { ProfileSlice } from "./types.ts";
import type { Config } from "../config.ts";
import type { Message } from "../llm.ts";

/* ------------------------------------------------------------------ */
/* 工具：估算纯文本 token                                                */
/* ------------------------------------------------------------------ */

/** 估算单字符串 token 数（去掉每消息固定开销，避免系统性偏松）。*/
const PER_MESSAGE_OVERHEAD = estimateTokens([{ role: "user", content: "" }], []);
export function estimateTextTokens(text: string): number {
  return Math.max(0, estimateTokens([{ role: "user", content: text }], []) - PER_MESSAGE_OVERHEAD);
}

/* ------------------------------------------------------------------ */
/* 技能缺失警告（约束 40 / §7.1 G1）                                     */
/* ------------------------------------------------------------------ */

let _karpathyWikiWarned = false;

/**
 * karpathy-wiki-* 技能已退役（能力内化为 src/wiki/ 与工具层，见 wiki-turnning-1018.md）。
 * 本函数保留为 no-op：签名与幂等标记不动，避免调用方与测试大改。
 */
export function warnIfWikiSkillsMissing(_cfg: Config): void {
  void _cfg;
}

/** 测试用：重置幂等标记。 */
export function _resetKarpathyWikiWarned(): void {
  _karpathyWikiWarned = false;
}

/* ------------------------------------------------------------------ */
/* 工具：找边界偏移（按 i 算累计 token）                                  */
/* ------------------------------------------------------------------ */

/** 扫描所有「段落边界」偏移（`\n\n`），返回字符索引数组。 */
function paragraphOffsets(text: string): number[] {
  const offsets: number[] = [];
  const re = /\n\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) offsets.push(m.index);
  return offsets;
}

/** 扫描所有 markdown 标题边界偏移（`/^#{1,6}\s+.+$/m`），返回行首字符索引数组。 */
function headingOffsets(text: string): number[] {
  const offsets: number[] = [];
  const re = /^#{1,6}\s+.+$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) offsets.push(m.index);
  return offsets;
}

/* ------------------------------------------------------------------ */
/* 工具：选择最近到目标 token 数的边界                                  */
/* ------------------------------------------------------------------ */

/**
 * 在边界数组里选最接近 targetTokens 的偏移。
 *   - <target 与 >target 都接受
 *   - 选绝对距离 |tokens(i) - target| 最小者
 *   - 并列时取 ≤target 那个
 * 返回 { idx, tokens }；若无任何候选返回 null。
 */
function pickClosest(
  text: string,
  offsets: number[],
  targetTokens: number,
): { idx: number; tokens: number } | null {
  let best: { idx: number; tokens: number } | null = null;
  let bestDist = Infinity;
  let bestIsLTE = false;
  for (const o of offsets) {
    if (o <= 0 || o >= text.length) continue;
    const tokens = estimateTextTokens(text.slice(0, o));
    const dist = Math.abs(tokens - targetTokens);
    const isLTE = tokens <= targetTokens;
    if (dist < bestDist) {
      best = { idx: o, tokens };
      bestDist = dist;
      bestIsLTE = isLTE;
    } else if (dist === bestDist) {
      // 并列规则：取 ≤target 那个
      if (isLTE && !bestIsLTE) {
        best = { idx: o, tokens };
        bestIsLTE = true;
      }
    }
    void bestIsLTE; // keep var alive (TS doesn't track usage pattern cleanly)
  }
  return best;
}

/**
 * 在 [0, len) 区间二分查找 estimateTextTokens(text.slice(0, idx)) 第一次 ≥ targetTokens。
 * 走估算可能不严格单调（边界字符数变化），所以返回「最近 ≥ target」而不是「首次 ≥」。
 */
function findHardCut(text: string, targetTokens: number): number {
  let lo = 0;
  let hi = text.length;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 30; i++) {
    if (lo >= hi) break;
    const mid = (lo + hi) >>> 1;
    const tokens = estimateTextTokens(text.slice(0, mid));
    const dist = Math.abs(tokens - targetTokens);
    if (dist < bestDist) {
      bestIdx = mid;
      bestDist = dist;
    }
    if (tokens < targetTokens) lo = mid + 1;
    else if (tokens > targetTokens) hi = mid;
    else break;
  }
  return bestIdx;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                                */
/* ------------------------------------------------------------------ */

export interface EnsureProfileOpts {
  /** -p 单次模式：默认不注入；noProfileInOneShot=true 时强制 return null。 */
  oneShot?: boolean;
}

const INJECTION_RANGE_MIN = 400;
const INJECTION_RANGE_MAX = 600;
const TARGET_TOKENS = 500;

/**
 * ensureProfile 实现（§5.4）。返回注入到 messages[1] 的文本块；null = 不注入。
 */
export async function ensureProfile(
  cfg: Config,
  opts?: EnsureProfileOpts,
): Promise<ProfileSlice | null> {
  // 约束 40 / §7.1 G1：karpathy-wiki-* 技能缺失 stderr WARN（一次幂等）
  warnIfWikiSkillsMissing(cfg);

  const m = cfg.memory;
  if (!m.enabled) return null;
  if (opts?.oneShot && m.noProfileInOneShot) return null;

  const profilePath = join(m.userLevelDir, "profile.md");
  if (!existsSync(profilePath)) return null;

  let text: string;
  try {
    const buf = readFileSync(profilePath);
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (e) {
    if (e instanceof Error && e.name === "TypeError") {
      throw new MemoryError("schema_invalid", "profile.md 非 UTF-8（约束 5.4 schema_invalid）");
    }
    throw e;
  }

  const totalTokens = estimateTextTokens(text);
  const totalBytes = Buffer.byteLength(text, "utf8");

  if (totalTokens <= TARGET_TOKENS) {
    return buildSlice(cfg, text, null, totalTokens, totalBytes);
  }

  // L1: 段落边界
  const pOffsets = paragraphOffsets(text);
  const l1 = pickClosest(text, pOffsets, TARGET_TOKENS);
  if (l1 && l1.tokens >= INJECTION_RANGE_MIN && l1.tokens <= INJECTION_RANGE_MAX) {
    console.error("profile.md 超 500 tokens，按段落边界截断");
    return buildSlice(cfg, text.slice(0, l1.idx), 1, l1.tokens, Buffer.byteLength(text.slice(0, l1.idx), "utf8"));
  }

  // L2: 标题边界
  const hOffsets = headingOffsets(text);
  const l2 = pickClosest(text, hOffsets, TARGET_TOKENS);
  if (l2 && l2.tokens >= INJECTION_RANGE_MIN && l2.tokens <= INJECTION_RANGE_MAX) {
    console.error("profile.md 超 500 tokens，按 markdown 标题边界截断");
    return buildSlice(cfg, text.slice(0, l2.idx), 2, l2.tokens, Buffer.byteLength(text.slice(0, l2.idx), "utf8"));
  }

  // L3: 硬截断
  const hardIdx = findHardCut(text, TARGET_TOKENS);
  console.error("[硬截]无段落/标题边界，按字符截断");
  return buildSlice(cfg, text.slice(0, hardIdx), 3, TARGET_TOKENS, Buffer.byteLength(text.slice(0, hardIdx), "utf8"));
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 构造注入到 messages[1] 的 ProfileSlice（约束 31 格式）。
 *   ```
 *   ## 用户画像（来自记忆系统）
 *
 *   <profile.md 全文，最长 500 tokens 截断>
 *
 *   > 来源：~/.neo/memorys/profile.md（<N> 字节，<M> tokens）
 *   ```
 */
function buildSlice(
  cfg: Config,
  content: string,
  truncatedAt: 1 | 2 | 3 | null,
  estimatedTokens: number,
  bytes: number,
): ProfileSlice {
  const m = cfg.memory;
  // 约束 31 + H4 spec：H1 「## 用户画像」严格（无括号，跟测试 regex 匹配）；
  // 来源行用半角逗号。
  const block = [
    "## 用户画像",
    "",
    content,
    "",
    `> 来源：${m.userLevelDir}/profile.md(${bytes} 字节,${estimatedTokens} tokens)`,
  ].join("\n");
  return {
    content: block,
    truncatedAt,
    estimatedTokens,
    bytes,
    cwd: cfg.cwd,
    timeRange: { from: undefined, to: undefined },
    sourceEntries: [],
  };
}
/* ------------------------------------------------------------------ */
/* reInjectProfile（约束 26 / 约束 27）                                   */
/* ------------------------------------------------------------------ */

export interface ReInjectProfileOpts {
  /** 缓存前次注入文本；null = 重新读盘（默认 §7.1 简化路径）。 */
  cached?: ProfileSlice | null;
}

/**
 * 把 profile 注入到 messages[1]（约束 26：不追加到 messages[0]）。
 * - 若 messages[1] 已是 profile 块：保持不动（D1-D3 优化路径；v0.1 简化版总是覆盖读盘）
 * - 否则：messages.splice(1，0，profile)
 * - 若 profile.md 不存在或 noProfileInOneShot + oneShot：删除 messages[1]（如有）
 */
export async function reInjectProfile(
  cfg: Config,
  messages: Message[],
  opts?: ReInjectProfileOpts,
): Promise<Message[]> {
  const m = cfg.memory;
  if (!m.enabled) return messages;

  // 简化路径（H2 + 约束 27）：重新读盘，不复用缓存。
  // 性能开销忽略不计；后续优化可加 cache。
  const slice = opts?.cached !== undefined ? opts.cached : await ensureProfile(cfg);

  if (slice === null) {
    // 无 profile：删除 messages[1]（如有）
    const existing = messages[1];
    if (existing && (existing as { role?: string }).role === "system" &&
        typeof (existing as { content?: string }).content === "string" &&
        (existing as { content: string }).content.startsWith("## 用户画像")) {
      const out = messages.slice();
      out.splice(1, 1);
      return out;
    }
    return messages;
  }

  // 找现有 profile 块在 messages 的索引（约束 26：在 messages[1] 槽位）
  const out = messages.slice();
  const profileSlot = 1; // 约束 26
  if (profileSlot < out.length &&
      (out[profileSlot] as { role?: string }).role === "system" &&
      typeof (out[profileSlot] as { content?: string }).content === "string" &&
      ((out[profileSlot] as { content: string }).content.startsWith("## 用户画像"))) {
    // D1-D3 路径：保持 messages[1] 是 profile 但内容用新的（约束 27：compact 后重新保证）
    out[profileSlot] = { role: "system", content: slice.content };
  } else {
    out.splice(profileSlot, 0, { role: "system", content: slice.content });
  }
  return out;
}
