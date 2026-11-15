/**
 * 输出上限（max_tokens）学习：从 400/422 文案解析上限、夹紧重发、不透明 400 降级。
 */
import type { Config } from "../config.ts";
import { LLMError } from "./types.ts";

/**
 * 服务端是否在抱怨 parallel_tool_calls 这个字段（瘦网关常见：400 unknown field）。
 *
 * 只在 4xx 且错误文本里同时出现字段名与「不认识/不支持」语义时才认，
 * 避免把普通的参数错误误判成降级信号。
 */
export function isParallelToolCallsRejection(err: unknown): boolean {
  if (!(err instanceof LLMError)) return false;
  const status = err.status;
  if (status === undefined || status < 400 || status >= 500) return false;
  const text = `${err.message}\n${err.body ?? ""}`.toLowerCase();
  if (!text.includes("parallel_tool_calls")) return false;
  return /(unknown|unsupported|not supported|unrecognized|invalid|not allowed|unexpected|不支持|未知)/.test(text);
}


/* ------------------------------------------------------------------ */
/* 输出上限（max_tokens）学习                                           */
/* ------------------------------------------------------------------ */

/**
 * 服务端因 max_tokens 超过**该模型**的上限而拒绝时，从错误文案里取出上限。
 *
 * 为什么需要：上限因模型而异（MiniMax 实测：M3 系 524,288，M2.7 系 196,608），而 provider 级
 * 的 `max_tokens` 对四个档位共用 —— 配成 M3 能接受的值，切到 fast 档的 M2.7 就必然 400。
 * 不可能让用户逐模型手工调配置，所以按报错学习、夹紧、重发。
 *
 * 只在 400/422 且文案同时出现 max tokens 语义与「>/超过/exceed」时才认，并且要求
 * 解析出的上限小于本次发送的值（否则夹紧没有意义，不能死循环）。
 */
/**
 * 上下文窗口类错误文案（context length / prompt too long）。
 * 由 agent 的 overflow 恢复处理，max_tokens 的学习与降级都不碰。
 */
export function isContextLengthErrorText(text: string): boolean {
  return /context[\s_-]*(length|window)|prompt[\s_-]*(is\s+)?too\s+long/i.test(text);
}

/** 文案是否提及 max tokens（语义层面，无论能否解析出具体数字）。 */
export function isMaxTokensErrorText(text: string): boolean {
  return /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?|最大.{0,4}token/i.test(text);
}

/** 鉴权类错误文案（401/403，及少数网关用 400 表达的 key 错误）。 */
export function isAuthErrorText(text: string): boolean {
  return /unauthorized|forbidden|authentication|invalid[\s_-]*api[\s_-]*key|api[\s_-]*key|missing[\s_-]*key/i.test(
    text,
  );
}

export function parseMaxTokensLimit(err: unknown, sent: number): number | null {
  if (!(err instanceof LLMError)) return null;
  if (err.status !== 400 && err.status !== 422) return null;
  const text = `${err.message}\n${err.body ?? ""}`;
  // 上下文窗口类错误不是这里的事（由 agent 的 overflow 恢复处理）。
  if (isContextLengthErrorText(text)) return null;
  // 形态 1（MiniMax）：max tokens > 196608
  // 形态 2（Anthropic 官方）：max_tokens: 100000 > 64000, which is the maximum allowed …
  // 形态 3（OpenAI 风格）：supports at most 4096 completion tokens / maximum is 4096
  const patterns = [
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?\s*(?:>|greater than|exceeds?|more than|above)\s*([\d,_]+)/i,
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?\s*[:=]?\s*[\d,_]+\s*>\s*([\d,_]+)/i,
    /(?:at most|up to|no more than|limited to|maximum (?:is|of|allowed)|不超过|上限为?)\s*([\d,_]+)\s*(?:completion |output )?tokens?/i,
    /max(?:imum)?[\s_-]*(?:completion[\s_-]*|output[\s_-]*)?tokens?[^\n]{0,60}?(?:is|of|:|=|limit(?:ed)?(?: to)?|at most|up to|不超过|上限为?)\s*([\d,_]+)/i,
  ];
  if (!isMaxTokensErrorText(text)) return null;
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number((m[1] ?? "").replace(/[,_]/g, ""));
    if (Number.isFinite(n) && n >= 256 && n < sent) return Math.floor(n);
  }
  return null;
}

/** 已学到的输出上限（key = provider|baseUrl|model）。 */
export const learnedMaxTokens = new Map<string, number>();

/**
 * 不透明 400 的安全降级地板（issue #21）。
 *
 * 取 8192 = settings.example.json 的默认 max_tokens：本项目对「保守但可用的输出预算」
 * 的既有默认，不引入第三个魔数。issue 实测网关对 16384 都返回 200，8192 远低于典型上限。
 * 刻意不用 contextWindow 的比例 —— 探测兜底的 200,000 不是事实，拿猜测当基数只会放大猜测。
 */
export const OPAQUE_400_DOWNGRADE_FLOOR = 8192;

/**
 * 不透明 400 的安全降级判定（issue #21）。
 *
 * 背景：v0.4.75 的 parseMaxTokensLimit 只认「网关明说上限」的文案；有些网关对过大的
 * max_tokens 回完全不透明 400（如 "request was rejected by an internal MaaS component"），
 * 文案里既没有 max tokens 语义也没有数字，400 又不在重试列表里 → 整个会话发不出请求。
 *
 * 触发条件（全部满足才降级）：
 *  1. status === 400（401/403/404/5xx 各走各的路径，不掺和）；
 *  2. parseMaxTokensLimit 返回 null（文案解析不出上限 —— 能解析的走 v0.4.75 学习机制）；
 *  3. 不是上下文超长文案（那是 agent 的 overflow 恢复管的）；
 *  4. 不是鉴权类文案（少数网关用 400 表达 key 错误，降级重发没有意义）；
 *  5. 当前生效值 > OPAQUE_400_DOWNGRADE_FLOOR（只降不升：≤8192 时降级没有意义）。
 *
 * 作用域由调用方决定：**仅本次请求内降级一次，不记忆**。learnedMaxTokens 记的是网关
 * 明说的上限（稳定陈述，可记忆）；不透明 400 学到的「8192 能通」只是单次观察 ——
 * 可能是限流、网关抖动或请求体其它字段的问题，固化会永久污染该 provider+model。
 */
export function shouldDowngradeForOpaque400(err: unknown, sent: number): boolean {
  if (!(err instanceof LLMError)) return false;
  if (err.status !== 400) return false;
  // parallel_tool_calls 被拒是另一条降级路径（issue #11），不能被这里抢走。
  if (isParallelToolCallsRejection(err)) return false;
  const text = `${err.message}\n${err.body ?? ""}`;
  if (isContextLengthErrorText(text)) return false;
  if (isAuthErrorText(text)) return false;
  if (parseMaxTokensLimit(err, sent) !== null) return false;
  return sent > OPAQUE_400_DOWNGRADE_FLOOR;
}

/**
 * 400/422 报错文案的 max_tokens 提示行（issue #21 C）。
 * 不改写原始文案，只追加一行；鉴权类错误不加（与 max_tokens 无关，加了误导）。
 */
export function appendMaxTokensHint(err: LLMError): void {
  if (err.status !== 400 && err.status !== 422) return;
  if (isParallelToolCallsRejection(err)) return;
  const text = `${err.message}\n${err.body ?? ""}`;
  if (isAuthErrorText(text)) return;
  if (isMaxTokensErrorText(text)) return;
  err.message = `${err.message}\n（提示：部分网关对过大的 max_tokens 会回不透明的 400；若持续失败请检查 settings.json 里该 provider 的 max_tokens 配置。）`;
}

export function maxTokensKey(cfg: Config): string {
  return `${cfg.providerName}|${cfg.baseUrl}|${cfg.model}`;
}

/** 本次请求实际使用的 max_tokens：已学到上限的，夹到上限以内。 */
export function effectiveMaxTokens(cfg: Config): number {
  const learned = learnedMaxTokens.get(maxTokensKey(cfg));
  return learned !== undefined ? Math.min(cfg.maxTokens, learned) : cfg.maxTokens;
}

/** 测试用：清空已学到的输出上限。 */
export function resetLearnedMaxTokens(): void {
  learnedMaxTokens.clear();
}

/**
 * 「从报错里学到精确输出上限」的监听器（issue #8 A：免费证据入账）。
 *
 * 请求层只负责发请求与夹紧重发，**落盘归 env 层**，所以这里只回调、不写文件。
 * 监听器由入口（index.ts）注册一次；测试或库场景不注册就等于全关 —— 与今天行为一致。
 * 监听器抛错一律吞掉：入账是增强项，绝不能让一次写盘失败把用户请求搞挂。
 */
export interface MaxTokensLimitLearned {
  cfg: Config;
  /** 解析出的精确上限。 */
  limit: number;
  /** 被服务端拒掉的那个预算（本次实际发送值）。 */
  sent: number;
  /** 原始报错文案片段（落 env 事作用，已截断）。 */
  evidence: string;
}

let maxTokensLimitLearnedHandler: ((ev: MaxTokensLimitLearned) => void) | null = null;

export function setMaxTokensLimitLearnedHandler(
  fn: ((ev: MaxTokensLimitLearned) => void) | null,
): void {
  maxTokensLimitLearnedHandler = fn;
}

export function resetMaxTokensLimitLearnedHandler(): void {
  maxTokensLimitLearnedHandler = null;
}

export function announceLearnedLimit(cfg: Config, limit: number, sent: number, err: unknown): void {
  const handler = maxTokensLimitLearnedHandler;
  if (!handler) return;
  const text =
    err instanceof LLMError ? `${err.message}${err.body ? ` | ${err.body}` : ""}` : String(err);
  try {
    handler({ cfg, limit, sent, evidence: text.slice(0, 300) });
  } catch {
    /* 入账失败不影响请求 */
  }
}

