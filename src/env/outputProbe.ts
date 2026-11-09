/**
 * env/outputProbe.ts — 模型单次输出上限（`max_output_tokens`）的边界发现（issue #8）。
 *
 * 两条互不依赖的路径：
 *  **A 免费证据**：请求撞出来的 400/422 文案里若能解析出精确上限，直接入账
 *    （`persistLearnedOutputLimit`）。不需要开关、不额外发请求。
 *  **B 主动探测**：网关什么都不说时，用尽量少的请求去试边界（`runOutputProbe`）。
 *    **默认关闭**，由 provider 的 `probe_max_output_tokens` 显式开启。
 *
 * 铁律（与 #6/#21 一致，写在代码里而不是文档里）：
 *  - 只写**空字段**：手写值（含显式 `false`）绝不覆盖，`max_tokens`（请求预算）永不被改；
 *  - **不归因不透明 400**：那是单次观察，可能是限流/网关抖动/别的字段，固化会永久污染配置；
 *  - 单次 `usage.completion_tokens`、`finish_reason === "length"`、请求预算本身，
 *    都**不是**能力上限；
 *  - 任何落盘 / env 事实写入失败都吞掉：能力补全是增强项，不得影响会话。
 *
 * 依赖方向：本模块 → config（类型）、llm（判定与单次请求）、modelCaps（写回）、
 * modelWindows（env 事实）。不反向 import，避免循环。
 */
import type { Config } from "../config.ts";
import type { OutputProbeSettings } from "../config.ts";
import {
  isAuthErrorText,
  isContextLengthErrorText,
  parseMaxTokensLimit,
  rawChatOnce,
  LLMError,
  type Message,
} from "../llm.ts";
import { writeBackCapabilities } from "./modelCaps.ts";
import { modelKey, readModelContexts, recordModelContext } from "./modelWindows.ts";
import type { ModelContextInfo } from "./types.ts";

/** 复用 config 的定义（settings 解析在 config.ts，这里重导出给调用方少 import 一处）。 */
export { DEFAULT_OUTPUT_PROBE, resolveOutputProbe } from "../config.ts";
export type { OutputProbeSettings } from "../config.ts";

/** 防空转 memo 的 TTL：7 天内不重复探测（结论不论成败都算「探过」）。 */
export const OUTPUT_PROBE_MEMO_TTL_DAYS = 7;

/** 探测请求的正文：越短越好 —— 探测的成本主要在「发出一轮请求」而不是内容。 */
export const OUTPUT_PROBE_MESSAGES: Message[] = [{ role: "user", content: "ok" }];

export type ProbeFailureKind = "limit" | "opaque" | "context" | "auth" | "other";

/** 一次探测请求的结果。 */
export type ProbeAttempt =
  | { candidate: number; ok: true }
  | { candidate: number; ok: false; kind: ProbeFailureKind; limit?: number; message?: string };

/** 整轮探测的结论。 */
export type ProbeOutcome =
  | { outcome: "found"; limit: number; attempts: ProbeAttempt[] }
  | { outcome: "lower_bound"; atLeast: number; attempts: ProbeAttempt[] }
  | { outcome: "inconclusive"; reason: Exclude<ProbeFailureKind, "limit">; attempts: ProbeAttempt[] };

/** env 事实里的防空转备忘（`ModelContextInfo.outputProbe`）。 */
export interface OutputProbeMemo {
  at: string;
  outcome: ProbeOutcome["outcome"];
  atLeast?: number;
  limit?: number;
  reason?: string;
}

/**
 * 阶梯候选：从 start 起翻倍，最多 maxAttempts 个，且不超过 cap。
 *
 * 不把 cap 本身塞进候选（除非 start 就等于 cap）：`start=8192, cap=20000` 的答案是
 * `8192, 16384` —— 试 20000 没有意义，真正要知道的是「翻倍到哪一档被拒」。
 */
export function probeCandidates(settings: OutputProbeSettings): number[] {
  const limit = Math.max(1, Math.min(8, Math.floor(settings.maxAttempts)));
  const cap = Math.max(256, Math.floor(settings.cap));
  let cur = Math.max(256, Math.floor(settings.start));
  const out: number[] = [];
  while (out.length < limit) {
    if (cur > cap) break;
    out.push(cur);
    const next = cur * 2;
    if (!Number.isFinite(next) || next <= cur || next > cap) break;
    cur = next;
  }
  return out;
}

/**
 * 探测失败 → 归因。顺序有讲究：
 *  1. 上下文超长 / 鉴权优先排除（它们不是「输出上限」问题，混进来会把结论带偏）；
 *  2. 能解析出数字才算 `limit`；
 *  3. 400/422 但解析不出数字 = `opaque` —— **不归因**，只记「问不出来」；
 *  4. 其余（5xx / 超时 / 网络）= `other`。
 */
export function classifyProbeError(
  err: unknown,
  candidate: number,
): { kind: ProbeFailureKind; limit?: number; message: string } {
  const text =
    err instanceof LLMError
      ? `${err.message}${err.body ? `\n${err.body}` : ""}`
      : ((err as Error)?.message ?? String(err));
  if (isContextLengthErrorText(text)) return { kind: "context", message: text.slice(0, 300) };
  if (isAuthErrorText(text)) return { kind: "auth", message: text.slice(0, 300) };
  const limit = parseMaxTokensLimit(err, candidate);
  if (limit !== null) return { kind: "limit", limit, message: text.slice(0, 300) };
  if (err instanceof LLMError && (err.status === 400 || err.status === 422)) {
    return { kind: "opaque", message: text.slice(0, 300) };
  }
  return { kind: "other", message: text.slice(0, 300) };
}

/**
 * 跑一轮阶梯探测。`request` 由调用方注入（真实场景是 `rawChatOnce`，测试里是假函数）：
 * resolve = 网关接受该预算；throw = 被拒/出错，交给 `classify` 归因。
 *
 * 一旦归因出**非 limit** 的失败就立即停止 —— 继续试只会把「不知道」变成「猜」。
 */
export async function runOutputProbe(opts: {
  settings: OutputProbeSettings;
  request: (candidate: number) => Promise<unknown>;
  classify?: (err: unknown, candidate: number) => { kind: ProbeFailureKind; limit?: number; message?: string };
}): Promise<ProbeOutcome> {
  const classify = opts.classify ?? classifyProbeError;
  const attempts: ProbeAttempt[] = [];
  let lastOk: number | null = null;

  for (const candidate of probeCandidates(opts.settings)) {
    try {
      await opts.request(candidate);
      attempts.push({ candidate, ok: true });
      lastOk = candidate;
    } catch (err) {
      const c = classify(err, candidate);
      if (c.kind === "limit") {
        attempts.push({ candidate, ok: false, kind: "limit", limit: c.limit, message: c.message });
        return { outcome: "found", limit: c.limit!, attempts };
      }
      attempts.push({ candidate, ok: false, kind: c.kind, message: c.message });
      return { outcome: "inconclusive", reason: c.kind as Exclude<ProbeFailureKind, "limit">, attempts };
    }
  }

  return { outcome: "lower_bound", atLeast: lastOk ?? opts.settings.start, attempts };
}

/**
 * 现在该不该跑主动探测。`outputLimitDeclared` 由调用方按「手写优先」判定
 * （`max_output_tokens` 已填即 true），这里只回答「还有什么理由不跑」。
 */
export function shouldRunOutputProbe(opts: {
  settings: OutputProbeSettings;
  outputLimitDeclared: boolean;
  memo?: OutputProbeMemo;
  now?: Date;
  ttlDays?: number;
}): { run: boolean; reason: "disabled" | "declared" | "recent" | "ok" } {
  if (!opts.settings.enabled) return { run: false, reason: "disabled" };
  if (opts.outputLimitDeclared) return { run: false, reason: "declared" };
  const ttl = (opts.ttlDays ?? OUTPUT_PROBE_MEMO_TTL_DAYS) * 86_400_000;
  const now = (opts.now ?? new Date()).getTime();
  if (opts.memo) {
    const at = Date.parse(opts.memo.at);
    if (Number.isFinite(at) && now - at < ttl) return { run: false, reason: "recent" };
  }
  return { run: true, reason: "ok" };
}

/** 读该 provider|model 的探测 memo（env 事实里没有 = undefined）。 */
export function readOutputProbeMemo(cfg: Config): OutputProbeMemo | undefined {
  return readModelContexts(cfg)[modelKey(cfg.providerName, cfg.model)]?.outputProbe;
}

/**
 * 落 env 事实：保留既有上下文窗口/能力标记，只更新输出上限与探测 memo。
 *
 * `value` 是「本次拿到的上限」；既有事实里已有值（例如 /models 给的，或用户手写后的
 * 记录）时**不覆盖** —— 与 settings 的「手写优先」同一口径。
 */
function recordOutputLimitFact(
  cfg: Config,
  patch: { source: ModelContextInfo["source"]; value: number | null; evidence: string; memo?: OutputProbeMemo },
): void {
  try {
    const existing = readModelContexts(cfg)[modelKey(cfg.providerName, cfg.model)];
    recordModelContext(cfg, {
      contextWindow: existing?.contextWindow ?? null,
      source: patch.source,
      maxOutputTokens: existing?.maxOutputTokens ?? patch.value,
      vision: existing?.vision,
      tools: existing?.tools,
      reasoning: existing?.reasoning,
      evidence: patch.evidence.slice(0, 300),
      ...(patch.memo ? { outputProbe: patch.memo } : {}),
    });
  } catch {
    /* env 事实是增强项，写不进去不影响会话 */
  }
}

/** 一句话结论（落 env evidence / 启动日志用）。 */
export function describeProbeOutcome(outcome: ProbeOutcome): string {
  if (outcome.outcome === "found") {
    const tried = outcome.attempts.map((a) => a.candidate.toLocaleString()).join(" → ");
    return `行为探测：上限 ${outcome.limit.toLocaleString()}（候选 ${tried}，400/422 明确给出上限）`;
  }
  if (outcome.outcome === "lower_bound") {
    return `行为探测：已验证网关接受 ${outcome.atLeast.toLocaleString()}，未探到上界（未写配置）`;
  }
  return `行为探测：无法确定上限（${outcome.reason}），未写配置`;
}

/**
 * 把探测结论落地：只有 `found` 才写 settings（且只写空字段），三种结论都记 env memo。
 */
export function applyProbeOutcome(
  cfg: Config,
  outcome: ProbeOutcome,
  opts: { now?: Date } = {},
): { written: string[]; memo: OutputProbeMemo } {
  const memo: OutputProbeMemo = {
    at: (opts.now ?? new Date()).toISOString(),
    outcome: outcome.outcome,
  };

  if (outcome.outcome === "found") {
    memo.limit = outcome.limit;
    const r = writeBackCapabilities(cfg, { maxOutputTokens: outcome.limit });
    recordOutputLimitFact(cfg, {
      source: "behavior_probe",
      value: outcome.limit,
      evidence: describeProbeOutcome(outcome),
      memo,
    });
    return { written: r.written, memo };
  }

  if (outcome.outcome === "lower_bound") memo.atLeast = outcome.atLeast;
  else memo.reason = outcome.reason;

  // lower_bound / inconclusive 都不改配置：只记「探过什么、为什么没结论」。
  recordOutputLimitFact(cfg, {
    source: "behavior_probe",
    value: null,
    evidence: describeProbeOutcome(outcome),
    memo,
  });
  return { written: [], memo };
}

/**
 * A 路径：把「从报错里学到的精确上限」入账（issue #8 免费证据）。
 * 只在 `max_output_tokens` 为空时写 settings；env 事实里保留证据文案。
 */
export function persistLearnedOutputLimit(
  cfg: Config,
  limit: number,
  evidence: string,
): { written: string[] } {
  const n = Math.floor(limit);
  if (!Number.isFinite(n) || n <= 0) return { written: [] };
  const r = writeBackCapabilities(cfg, { maxOutputTokens: n });
  recordOutputLimitFact(cfg, {
    source: "error_evidence",
    value: n,
    evidence: `报错学到上限 ${n.toLocaleString()}：${evidence}`,
  });
  return { written: r.written };
}

/**
 * 真实探测入口：用 `rawChatOnce` 发阶梯请求，再把结论落地。
 * 调用方负责前置判定（`shouldRunOutputProbe`）与展示。
 */
export async function probeOutputLimitForConfig(
  cfg: Config,
  settings: OutputProbeSettings,
): Promise<{ outcome: ProbeOutcome; written: string[]; memo: OutputProbeMemo }> {
  const outcome = await runOutputProbe({
    settings,
    request: (candidate) => rawChatOnce(cfg, OUTPUT_PROBE_MESSAGES, candidate),
  });
  const applied = applyProbeOutcome(cfg, outcome);
  return { outcome, ...applied };
}
