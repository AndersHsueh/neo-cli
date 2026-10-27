/**
 * journal.ts — 记忆运行日志（v0.2 记忆激活 §7.5.2 / §7.6.3）。
 *
 * 职责分层：
 *  - TurnRecord → `<journalDir>/YYYY-MM-DD.jsonl`：每一轮「有信息量」的对话一条，先落盘再提炼。
 *    先 journal 后 LLM 的意义：进程崩溃/ LLM 失败都不丢原始素材，下次 flush 可重试。
 *  - AuditEntry → `<journalDir>/capture-log.jsonl`：每次提炼/合并的结果审计，供 /memory why。
 *  - dedupe-hashes.txt：已写入内容的规范化哈希，跨轮次去重用。
 *
 * journal 是运行时状态：不进 git、不参与 wiki 语义、按保留期滚动清理。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface TurnToolUse {
  name: string;
  ok: boolean;
  digest: string;
}

export interface TurnRecord {
  v: 1;
  /** 唯一 id：审计与失败重试的关联键。 */
  id: string;
  ts: string;
  sessionId: string;
  cwd: string;
  kind: "turn" | "compact" | "explicit" | "aborted";
  turn: number;
  /** 用户输入（≤600 字，已脱敏）。 */
  user: string;
  /** 助手最终正文（≤2000 字，已脱敏；compact 为压缩摘要）。 */
  answer: string;
  tools: TurnToolUse[];
  filesTouched: string[];
  /** 显式记忆的作用域提示（remember 工具 / /remember 用）。 */
  hintScope?: "project" | "user";
}

export type AuditStatus = "applied" | "partial" | "dropped" | "failed" | "skipped" | "deferred";

export interface AuditEntry {
  ts: string;
  id: string;
  sessionId: string;
  turn: number;
  kind: TurnRecord["kind"];
  status: AuditStatus;
  /** 实际落页 op 数。 */
  applied: number;
  /** 被规则丢弃的 op 数。 */
  dropped: number;
  /** 丢因/失败原因（≤10 条）。 */
  reasons: string[];
  ms: number;
}

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function localDate(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function journalPath(dir: string, date: string): string {
  return join(dir, `${date}.jsonl`);
}

function auditPath(dir: string): string {
  return join(dir, "capture-log.jsonl");
}

function hashPath(dir: string): string {
  return join(dir, "dedupe-hashes.txt");
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

export function newRecordId(): string {
  return randomUUID();
}

/** 追加一条 TurnRecord。单行 JSON + append（<4KB 在 POSIX 下原子追加）。 */
export function appendTurn(dir: string, rec: TurnRecord): string {
  ensureDir(dir);
  const path = journalPath(dir, localDate(new Date(rec.ts)));
  appendFileSync(path, JSON.stringify(rec) + "\n", "utf8");
  return path;
}

/** 追加一条审计记录。 */
export function appendAudit(dir: string, entry: AuditEntry): void {
  ensureDir(dir);
  appendFileSync(auditPath(dir), JSON.stringify(entry) + "\n", "utf8");
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

export function readAudit(dir: string, limit = 50): AuditEntry[] {
  const path = auditPath(dir);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as AuditEntry);
    } catch {
      // 坏行跳过：journal 是尽力而为的运行状态，不让一行脏数据炸掉整条链路
    }
  }
  return out.slice(-limit);
}

/** 某 id 的审计状态（失败计数/终态判定用）。 */
export function auditState(dir: string, id: string): { attempts: number; terminal: boolean } {
  let attempts = 0;
  let terminal = false;
  for (const e of readAudit(dir, 10_000)) {
    if (e.id !== id) continue;
    attempts++;
    if (e.status === "applied" || e.status === "partial" || e.status === "dropped" || e.status === "skipped") {
      terminal = true;
    }
  }
  return { attempts, terminal };
}

/**
 * 扫描待处理记录（按 ts 升序）：
 *  - 只扫保留期内的 journal 文件；
 *  - 已有终态审计的跳过；
 *  - 失败 ≥2 次的跳过（放弃，不再无限重试）。
 */
export function pendingRecords(
  dir: string,
  opts: { retentionDays?: number; maxAgeDays?: number; limit?: number } = {},
): TurnRecord[] {
  const retentionDays = opts.maxAgeDays ?? opts.retentionDays ?? 7;
  const limit = opts.limit ?? 20;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => DATE_RE.test(f)).sort();
  } catch {
    return [];
  }
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  const out: TurnRecord[] = [];
  for (const f of files) {
    const full = join(dir, f);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec: TurnRecord;
      try {
        rec = JSON.parse(t) as TurnRecord;
      } catch {
        continue;
      }
      if (!rec || typeof rec.id !== "string") continue;
      if (Date.parse(rec.ts) < cutoff) continue;
      const st = auditState(dir, rec.id);
      if (st.terminal || st.attempts >= 2) continue;
      out.push(rec);
    }
  }
  out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return out.slice(0, limit);
}

/** 清理超过保留期的 journal 文件（capture-log 不清理，它是审计）。 */
export function cleanupJournal(dir: string, retentionDays = 7): number {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => DATE_RE.test(f));
  } catch {
    return 0;
  }
  const cutoff = localDate(new Date(Date.now() - retentionDays * 24 * 3600 * 1000));
  let removed = 0;
  for (const f of files) {
    if (f.replace(/\.jsonl$/, "") >= cutoff) continue;
    try {
      rmSync(join(dir, f));
      removed++;
    } catch {
      // best-effort
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* 去重哈希                                                            */
/* ------------------------------------------------------------------ */

/** 内容规范化：小写、去标点空白（中英文都适用）。 */
export function normalizeForHash(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function contentHash(page: string, body: string): string {
  return createHash("sha1").update(`${page}\n${normalizeForHash(body)}`, "utf8").digest("hex");
}

export function readAppliedHashes(dir: string): Set<string> {
  const path = hashPath(dir);
  if (!existsSync(path)) return new Set();
  try {
    const text = readFileSync(path, "utf8");
    return new Set(text.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function appendAppliedHashes(dir: string, hashes: string[]): void {
  if (hashes.length === 0) return;
  ensureDir(dir);
  appendFileSync(hashPath(dir), hashes.join("\n") + "\n", "utf8");
}
