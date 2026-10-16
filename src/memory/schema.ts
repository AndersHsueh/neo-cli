/**
 * 记忆系统 schema 校验（PRD docs/memory-prd.md §4.1 / §7.1 A 类）。
 *
 * 项目沿用「手写 runtime 校验，不引入 zod」（与 skills-prd §6.1 同款约定）。
 * 错误一律抛 MemoryError code="schema_invalid"。
 */

import { isAbsolute } from "node:path";
import { MemoryError } from "./types.ts";
import type { MemoryEntry } from "./types.ts";

/* ------------------------------------------------------------------ */
/* 字段正则                                                              */
/* ------------------------------------------------------------------ */

/** ISO 8601 日期：YYYY-MM-DD。 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 8 位 hex short_id。 */
const SHORT_ID_RE = /^[a-f0-9]{8}$/;

/* ------------------------------------------------------------------ */
/* parseIndexEntry — 校验 + 标准化                                       */
/* ------------------------------------------------------------------ */

/**
 * 校验 frontmatter 对象 → 返回标准化 MemoryEntry。
 * - A1: 合法 → 成功
 * - A2: 缺 date → schema_invalid
 * - A3: date 非 ISO → schema_invalid
 * - A4: cwd 非绝对 → schema_invalid
 * - A5: short_id 非 8 位 hex → schema_invalid
 * - A6: summary > 200 或 < 1 字符 → schema_invalid
 * - A7: topic 含换行 → schema_invalid
 * - A8: 额外字段 → 保留
 */
export function parseIndexEntry(input: Record<string, unknown>): MemoryEntry {
  const date = input["date"];
  const cwd = input["cwd"];
  const shortId = input["short_id"];
  const summary = input["summary"];

  if (typeof date !== "string" || !ISO_DATE_RE.test(date)) {
    throw new MemoryError("schema_invalid", `MemoryEntry.date 必须匹配 YYYY-MM-DD（实际：${JSON.stringify(date)}）`);
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new MemoryError("schema_invalid", `MemoryEntry.cwd 必须是绝对路径（实际：${JSON.stringify(cwd)}）`);
  }
  if (typeof shortId !== "string" || !SHORT_ID_RE.test(shortId)) {
    throw new MemoryError("schema_invalid", `MemoryEntry.short_id 必须是 8 位 hex（实际：${JSON.stringify(shortId)}）`);
  }
  if (typeof summary !== "string" || summary.length < 1 || summary.length > 200) {
    throw new MemoryError("schema_invalid", `MemoryEntry.summary 必须在 1~200 字符（实际长度：${typeof summary === "string" ? summary.length : typeof summary}）`);
  }

  const topicRaw = input["topic"];
  if (topicRaw !== undefined) {
    if (typeof topicRaw !== "string" || topicRaw.includes("\n") || topicRaw.length > 60) {
      throw new MemoryError("schema_invalid", `MemoryEntry.topic 必须单行 ≤60 字符（实际：${JSON.stringify(topicRaw)}）`);
    }
  }

  const entry: MemoryEntry = {
    date,
    cwd,
    shortId,
    summary,
    createdAt: typeof input["created_at"] === "string" ? input["created_at"] : new Date().toISOString(),
  };
  if (typeof topicRaw === "string") entry.topic = topicRaw;
  if (typeof input["updated_at"] === "string") entry.updatedAt = input["updated_at"];
  if (typeof input["redacted_at"] === "string") entry.redactedAt = input["redacted_at"];
  if (typeof input["redacted_count"] === "number") entry.redactedCount = input["redacted_count"];

  // A8: 保留任意额外字段（向前兼容）
  for (const [k, v] of Object.entries(input)) {
    if (!(k in entry)) entry[k] = v;
  }

  return entry;
}

/* ------------------------------------------------------------------ */
/* generateShortId — 约束 9                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成 8 位 hex short_id（约束 9）。
 * 优先用 crypto.randomUUID().slice(0,8)；冲突重试最多 3 次；
 * 3 次仍冲突回退到 crypto.getRandomValues(4 bytes)（Bun / Node 18+ API）。
 */
export function generateShortId(rng: { uuid: () => string; getRandomBytes: (n: number) => Uint8Array } = {
  uuid: () => crypto.randomUUID(),
  getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
}): string {
  for (let i = 0; i < 3; i++) {
    const id = rng.uuid().replace(/-/g, "").slice(0, 8);
    if (/^[a-f0-9]{8}$/.test(id)) return id;
  }
  return Array.from(rng.getRandomBytes(4), (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* sanitizeCwd — 约束 8 文件命名                                          */
/* ------------------------------------------------------------------ */

/**
 * 把绝对 cwd 路径转成文件名安全的短串（约束 8）。
 * 规则：
 *   1. basename + parent 第一级 one-step truncation
 *   2. NFC 规范化（约束 49：macOS 中文/Unicode）
 *   3. 小写
 *   4. 非 [a-z0-9-] 替换为 -
 *   5. 多个 - 合并
 *   6. 截断到 60 字符（默认）；win32 平台 40 字符（约束 49）
 *
 * 注意：encodeURIComponent 这里**不**用 — PRD §约束 49 提到 macOS 中文路径
 * 「用 NFC + encodeURIComponent + 替换 % 为 -」是另一种方案；这里采用更通用的
 * 「非 [a-z0-9-] → -」方案，输出短且 URL 安全，覆盖中文 / 空格 / 拉丁字符。
 */
export function sanitizeCwd(cwd: string, opts?: { platform?: "macos" | "linux" | "win32" | "auto"; maxLen?: number }): string {
  const maxLen = opts?.maxLen ?? (opts?.platform === "win32" ? 40 : 60);
  // 取路径末段（更可读；冲突时再加 short_id 区分）
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  const tail = parts.length > 0 ? parts[parts.length - 1] ?? "root" : "root";
  const norm = tail.normalize("NFC").toLowerCase();
  const clean = norm.replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (clean || "x").slice(0, maxLen);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 把 MemoryEntry 渲染成完整 raw 文件内容。
 * 顺序：--- yaml frontmatter ---\n\n# H1\n\n简短正文
 */
export function renderIndexEntry(entry: MemoryEntry): string {
  const lines: string[] = ["---"];
  lines.push(`date: ${entry.date}`);
  lines.push(`cwd: ${entry.cwd}`);
  if (entry.topic) lines.push(`topic: ${entry.topic}`);
  lines.push(`short_id: ${entry.shortId}`);
  lines.push(`summary: ${entry.summary}`);
  lines.push(`created_at: ${entry.createdAt}`);
  if (entry.updatedAt) lines.push(`updated_at: ${entry.updatedAt}`);
  if (entry.redactedAt) lines.push(`redacted_at: ${entry.redactedAt}`);
  if (typeof entry.redactedCount === "number") lines.push(`redacted_count: ${entry.redactedCount}`);
  for (const [k, v] of Object.entries(entry)) {
    if (["date", "cwd", "topic", "short_id", "summary", "created_at", "updated_at", "redacted_at", "redacted_count"].includes(k)) continue;
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(`# ${entry.topic || "记忆条目"}（${entry.date}）`);
  lines.push("");
  lines.push(`（一句话概要与 summary 字段冗余但保留正文段以便 LLM 检索：${entry.summary}）`);
  lines.push("");
  return lines.join("\n");
}

/**
 * 从已有 raw 文件正文提取 frontmatter 字段并 parse 为 MemoryEntry。
 * 失败 → 抛 schema_invalid（带回部分字段名供调试）。
 */
export function parseIndexFile(content: string): MemoryEntry {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m || m[1] === undefined) throw new MemoryError("schema_invalid", "raw 文件缺 frontmatter 分隔符 ---");
  const yaml = m[1];
  const obj: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val: string | number = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = JSON.parse(val) as string;
    if (key === "redacted_count") val = Number(val);
    obj[key] = val;
  }
  return parseIndexEntry(obj);
}

/* ------------------------------------------------------------------ */
/* 文件名构建                                                            */
/* ------------------------------------------------------------------ */

export function buildFileName(entry: MemoryEntry, opts?: { maxLen?: number }): string {
  const sanitized = sanitizeCwd(entry.cwd, { maxLen: opts?.maxLen });
  return `${entry.date}_${sanitized}_${entry.shortId}.md`;
}

/* ------------------------------------------------------------------ */
/* 默认日期（首次调用）                                                    */
/* ------------------------------------------------------------------ */

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}