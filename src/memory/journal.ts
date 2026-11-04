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

/** 审计文件里的一行 → AuditEntry；坏行返回 null（journal 是尽力而为的运行状态，不让一行脏数据炸掉整条链路）。 */
function parseAuditLine(line: string): AuditEntry | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as AuditEntry;
  } catch {
    return null;
  }
}

/** 读审计文件全部行（不截断）。 */
function readAllAudit(dir: string): AuditEntry[] {
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
    const e = parseAuditLine(line);
    if (e) out.push(e);
  }
  return out;
}

export function readAudit(dir: string, limit = 50): AuditEntry[] {
  return readAllAudit(dir).slice(-limit);
}

/** 终态审计：这些状态意味着这条 journal 记录已经处理完毕，不该再进队列。 */
const TERMINAL_STATUS: ReadonlySet<AuditStatus> = new Set<AuditStatus>(["applied", "partial", "dropped", "skipped"]);

/**
 * 某 id 的审计状态（失败计数/终态判定用）。
 *
 * 注意：**不能**用 readAudit(dir, N) 取尾部窗口来判定 —— capture-log.jsonl 是跨会话
 * 追加的，一条早期记录的终态审计会被后来的记录挤出窗口，导致已提炼的记录被当成
 * 「未处理」重新提炼（重复写页 + 重复消耗 LLM）。这里按 id 全量扫描，代价是每次
 * pendingRecords 都要读一遍审计文件；pendingRecords 内部改为一次扫描 + 索引复用。
 */
export function auditState(dir: string, id: string): { attempts: number; terminal: boolean } {
  let attempts = 0;
  let terminal = false;
  for (const e of readAllAudit(dir)) {
    if (e.id !== id) continue;
    attempts++;
    if (TERMINAL_STATUS.has(e.status)) terminal = true;
  }
  return { attempts, terminal };
}

/** 全量审计索引：id → 该 id 的审计状态。pendingRecords 一次扫描复用。 */
function auditIndex(dir: string): Map<string, { attempts: number; terminal: boolean }> {
  const idx = new Map<string, { attempts: number; terminal: boolean }>();
  for (const e of readAllAudit(dir)) {
    if (typeof e?.id !== "string") continue;
    let st = idx.get(e.id);
    if (!st) {
      st = { attempts: 0, terminal: false };
      idx.set(e.id, st);
    }
    st.attempts++;
    if (TERMINAL_STATUS.has(e.status)) st.terminal = true;
  }
  return idx;
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
  // 审计状态一次扫描成索引：逐条调 auditState 会把整个审计文件重读 N 遍
  const audits = auditIndex(dir);
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
      const st = audits.get(rec.id);
      if (st && (st.terminal || st.attempts >= 2)) continue;
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
