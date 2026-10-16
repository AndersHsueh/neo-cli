/**
 * redact.ts — /memory redact 子命令实现（PRD docs/memory-prd.md §A / §约束 46 / §约束 47）。
 *
 * 对已存在索引条目按 PII 模式重过滤，不改正文，仅在 frontmatter 加
 * `redacted_at: <ISO>` 与 `redacted_count: N`。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "../config.ts";
import { MemoryError } from "./types.ts";
import { parseIndexFile, renderIndexEntry } from "./schema.ts";
import { redactPII, type PIIMode, PII_MODE_NAMES } from "./pii.ts";

/**
 * 把用户传的模式字符串映射成标准 PIIMode 或 "ALL"。
 * - "ALL" / "API_KEY" / "PAT" / "JWT" / "AWS_KEY" / "SLACK_TOKEN" / "EMAIL" / mode name
 */
function normalizePattern(pattern: string): PIIMode | "ALL" {
  const u = pattern.toUpperCase();
  if (u === "ALL" || u === "API_KEY") return "ALL";
  const found = PII_MODE_NAMES.find((m) => m.toUpperCase() === u);
  return found ?? "ALL";
}

export async function redactSummary(
  cfg: Config,
  path: string,
  pattern: string | PIIMode,
): Promise<void> {
  if (!cfg.memory.enabled) return;
  if (!cfg.memory.piiFilter.enabled) {
    throw new MemoryError("permission_denied", "PII 过滤未启用（cfg.memory.piiFilter.enabled=false）");
  }
  if (!existsSync(path)) {
    throw new MemoryError("schema_invalid", `redact: 文件不存在：${path}`);
  }

  const content = readFileSync(path, "utf8");
  let entry;
  try {
    entry = parseIndexFile(content);
  } catch (e) {
    throw new MemoryError("schema_invalid", `redact: frontmatter 解析失败：${path}`, e);
  }

  // 约束 47：只在 summary / topic 字段做（不改 raw 正文）
  // 模式名解析：PIIMode 或 ALL（全部）/ API_KEY 等同 ALL 兼容
  const normMode = normalizePattern(pattern);
  const modes: PIIMode[] | undefined = normMode === "ALL" ? undefined : [normMode as PIIMode];
  const summaryRes = redactPII(entry.summary, modes ? { modes } : undefined);
  const topicRes = entry.topic ? redactPII(entry.topic, modes ? { modes } : undefined) : null;

  const total = summaryRes.total + (topicRes?.total ?? 0);
  if (total === 0) {
    // 没命中；按 K6 期望「frontmatter 加 redacted_at + redacted_count」语义，
    // 即使 0 处也算一次 redact 动作（记录时间戳）。
  }

  const updated = {
    ...entry,
    summary: summaryRes.text,
    topic: topicRes ? topicRes.text : entry.topic,
    redactedAt: new Date().toISOString(),
    redactedCount: total,
  };

  // 约束 47：只改 frontmatter，正文原样保留。v0.1.0 占位：renderIndexEntry 重渲染整文件
  // （含原 H1 + summary 更新后）。后续如有 raw 不可改严格版本，用文件级 frontmatter-only 替换。
  const newContent = renderIndexEntry(updated);
  writeFileSync(path, newContent, "utf8");
  console.error(`redactSummary: ${total} 处敏感串已脱敏 @ ${path}`);
}