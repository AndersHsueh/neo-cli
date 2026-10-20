/**
 * pii.ts — PII 敏感串过滤（PRD docs/memory-prd.md §5.7 / §约束 45 / §约束 46 / §约束 47）。
 *
 * 自动过滤模式（约束 45）：
 *   - openai-key  → sk- + 20+ alphanum
 *   - github-pat  → ghp_ + 36 alphanum
 *   - jwt         → ey...ey.sign.sign
 *   - aws-key     → AKIA + 16 uppercase+digit
 *   - slack-token → xox[baprs]- + alnum/dash
 *   - email       → 字面邮箱
 *
 * 命中即替换为 `[REDACTED:<mode>]`，不告警（启动日志 INFO 一行「N 处敏感串已脱敏」）。
 * 不做语义判断（约束 45）。
 */

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "openai-key", pattern: /sk-[a-zA-Z0-9]{20,}/g },
  { name: "github-pat", pattern: /ghp_[a-zA-Z0-9]{36}/g },
  { name: "jwt",         pattern: /ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: "aws-key",     pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "slack-token", pattern: /xox[baprs]-[0-9a-zA-Z-]+/g },
  { name: "email",       pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
];

export type PIIMode = "openai-key" | "github-pat" | "jwt" | "aws-key" | "slack-token" | "email";

export interface RedactResult {
  text: string;
  /** 命中计数（按模式分组）。 */
  counts: Partial<Record<PIIMode, number>>;
  /** 总命中数。 */
  total: number;
}

/**
 * 把 text 里的敏感串替换为 [REDACTED:<mode>]。
 * 约束 45：全部模式匹配（可由 opts.modes 限定子集）。
 * 约束 47：只在 summary / topic 字段调用；raw 正文不动（调用方负责）。
 */
export function redactPII(text: string, opts?: { modes?: PIIMode[] }): RedactResult {
  const active = opts?.modes
    ? PII_PATTERNS.filter((p) => opts.modes!.includes(p.name as PIIMode))
    : PII_PATTERNS;
  let out = text;
  const counts: Partial<Record<PIIMode, number>> = {};
  let total = 0;
  for (const { name, pattern } of active) {
    // 防御：pattern 必须带 g 旗，否则 replace 不会全部替换
    if (!pattern.flags.includes("g")) {
      console.error(`PII 模式 ${name} 缺 g flag 旗`);
      continue;
    }
    const matches = out.match(pattern);
    if (!matches) continue;
    counts[name as PIIMode] = matches.length;
    total += matches.length;
    out = out.replace(pattern, `[REDACTED:${name}]`);
  }
  return { text: out, counts, total };
}

/** 已知模式名集合（供 UI 列举 / 测试断言）。 */
// v0.1.12 清理：PII_MODE_NAMES 随旧 redact 实现一并删除（无消费者）