/**
 * 上下文窗口解析（v0.4.1 A2）——纯函数层，不碰文件/网络。
 *
 * 为什么需要它：实战中 `settings.context_window` 配的是 512k，但模型实际窗口
 * 可能更小（或运行时切到别的模型），配置值不能当事实。这里的策略：
 *  1. 优先用「探测到的」窗口（/models 元数据或溢出错误里解析出的上限）；
 *  2. 没有探测值 → 用配置值；
 *  3. 配置缺失才用已知模型兜底表（不拿猜测覆盖用户配置）。
 */
import type { ModelContextInfo } from "./env/types.ts";

export type WindowSource = "config" | "models_api" | "overflow_error" | "known";

export interface ResolvedWindow {
  tokens: number;
  source: WindowSource;
  /** 命中 env 事实时带回完整记录（含 observedMaxPromptTokens 等）。 */
  env?: ModelContextInfo;
}

/** 仅用于「配置缺失」时兜底；不覆盖用户显式配置，避免猜错。 */
const KNOWN_WINDOWS: ReadonlyArray<{ re: RegExp; tokens: number }> = [
  { re: /claude/i, tokens: 200_000 },
  { re: /gpt-4o/i, tokens: 128_000 },
  { re: /deepseek/i, tokens: 131_072 },
  { re: /qwen/i, tokens: 131_072 },
  { re: /glm-4\.6|glm-5/i, tokens: 200_000 },
  { re: /minimax-m[23]/i, tokens: 200_000 },
];

export function knownWindow(model: string): number | null {
  for (const k of KNOWN_WINDOWS) if (k.re.test(model)) return k.tokens;
  return null;
}

/**
 * 解析窗口：env 探测值 > 配置值 > 已知兜底。
 * env 里的 contextWindow 若非法（≤0/null）直接忽略。
 */
export function resolveContextWindow(
  configured: number,
  model: string,
  env?: ModelContextInfo | null,
): ResolvedWindow {
  if (env?.contextWindow && Number.isFinite(env.contextWindow) && env.contextWindow > 0) {
    return { tokens: Math.floor(env.contextWindow), source: env.source, env };
  }
  if (Number.isFinite(configured) && configured > 0) {
    return { tokens: Math.floor(configured), source: "config" };
  }
  const known = knownWindow(model);
  if (known) return { tokens: known, source: "known" };
  return { tokens: 200_000, source: "known" };
}

const OVERFLOW_RE =
  /(context[\s_-]*(?:length|window)|max(?:imum)?[\s_-]*context|prompt[\s_-]*(?:is\s+)?too\s+long|too\s+many\s+tokens|exceed[^\n]{0,40}(?:context|token)|reduce[^\n]{0,40}(?:length|tokens))/i;

/** 是否为「上下文超限」类错误（仅这类错误值得压缩后重试）。 */
export function isContextOverflowError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const message = (err as { message?: string } | null)?.message ?? "";
  if (!message) return false;
  // 明确的 4xx 才算；5xx/网络错误不按上下文处理（交给重试层）。
  if (typeof status === "number" && status >= 500) return false;
  if (typeof status === "number" && status !== 400 && status !== 413 && status !== 422) return false;
  return OVERFLOW_RE.test(message);
}

/** 把 1,000 / 128k / 1m 这类写法归一成 token 数。 */
function normalizeCount(raw: string, unit: string | undefined): number | null {
  const n = Number(raw.replace(/[,_]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (unit ?? "").toLowerCase();
  if (u === "k") return Math.round(n * 1_000);
  if (u === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

/**
 * 从服务端错误文案里解析真实窗口，例如：
 *  - "This model's maximum context length is 128000 tokens"
 *  - "context window is 200k tokens"
 *  - "maximum context length: 131,072"
 * 解析不到返回 null。
 */
export function parseContextLimitFromError(message: string): number | null {
  if (!message) return null;
  const patterns: Array<RegExp> = [
    /(?:maximum|max)\s+context\s*(?:length|window)?\s*(?:is|of|:|=)?\s*([\d][\d,_\.]*)\s*(k|m)?(?:\s*tokens?)?/i,
    /context\s*(?:length|window)\s*(?:is|of|:|=)?\s*([\d][\d,_\.]*)\s*(k|m)?(?:\s*tokens?)?/i,
    /([\d][\d,_\.]*)\s*(k|m)?\s*tokens?\s*(?:maximum|limit|max)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(message);
    if (!m) continue;
    const n = normalizeCount(m[1] ?? "", m[2]);
    // 过滤明显不是窗口的小数字（如 "max_tokens is 8192" 也可能命中第 4 条）。
    if (n !== null && n >= 8_000) return n;
  }
  return null;
}
