/**
 * 轮次诊断（v0.4.1 A1）。
 *
 * 背景：2026-10-26 实战会话最后一轮「静默空转」——会话 JSON 里没有 assistant、
 * 没有错误、mailbox 还是 outcome=ok，用户只能放弃会话。根因无法从任何日志定位。
 *
 * 本模块只做两件事：
 *  1. 每轮结束追加一条**元数据** JSONL（不记录 prompt/回答正文，保护隐私）；
 *  2. 把 TurnStats 归一成 ok/error/aborted，供 mailbox / session meta / UI 共用。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TurnOutcome = "ok" | "error" | "aborted";

/** 会话 meta 里保留的最后一轮摘要（resume 告警 / /sessions 标记用）。 */
export interface LastTurnMeta {
  at: string;
  outcome: TurnOutcome;
  finishReason: string | null;
  errorMessage?: string | null;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface TurnLogEntry {
  version: 1;
  ts: string;
  sessionId: string;
  turn: number;
  provider: string;
  model: string;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  finishReason: string | null;
  aborted: boolean;
  hadError: boolean;
  emptyResponse: boolean;
  errorMessage: string | null;
  contextWindow: number;
  contextUsage: number;
  compaction?: { before: number; after: number };
}

export interface TurnLogInput {
  sessionId: string;
  turn: number;
  provider: string;
  model: string;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  finishReason: string | null;
  aborted: boolean;
  hadError: boolean;
  emptyResponse: boolean;
  errorMessage?: string | null;
  contextWindow: number;
  contextUsage: number;
  compaction?: { before: number; after: number };
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const RETENTION_DAYS = 30;

/** 日志根目录：NEO_LOG_DIR 可覆盖（测试/多环境隔离）。 */
export function turnLogRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env["NEO_LOG_DIR"] ?? join(homedir(), ".neo", "logs");
}

function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function turnLogFile(now: Date = new Date(), root = turnLogRoot()): string {
  return join(root, "turns", `${dayKey(now)}.jsonl`);
}

let prunedForRoot: string | null = null;

function pruneOldFiles(dir: string): void {
  if (prunedForRoot === dir) return;
  prunedForRoot = dir;
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      } catch {
        /* 单个文件失败不影响其它清理 */
      }
    }
  } catch {
    /* 目录不存在等：下一次写会创建 */
  }
}

/**
 * 追加一条轮次日志。失败返回 null（诊断是增强项，不得影响主流程）。
 */
export function appendTurnLog(
  input: TurnLogInput,
  opts: { now?: Date; root?: string } = {},
): string | null {
  const now = opts.now ?? new Date();
  const root = opts.root ?? turnLogRoot();
  const dir = join(root, "turns");
  const file = join(dir, `${dayKey(now)}.jsonl`);
  const entry: TurnLogEntry = {
    version: 1,
    ts: now.toISOString(),
    ...input,
    errorMessage: input.errorMessage ? input.errorMessage.slice(0, 500) : null,
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 单文件超限时滚动一次（保留 .1 一份），避免长会话把磁盘写满。
    try {
      if (existsSync(file) && statSync(file).size > MAX_FILE_BYTES) {
        renameSync(file, `${file}.1`);
      }
    } catch {
      /* 滚动失败不阻塞写入 */
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    pruneOldFiles(dir);
    return file;
  } catch {
    return null;
  }
}

/** 统一判定本轮结果：aborted > error/empty > ok。 */
export function outcomeOf(stats: {
  aborted: boolean;
  hadError: boolean;
  emptyResponse: boolean;
}): TurnOutcome {
  if (stats.aborted) return "aborted";
  if (stats.hadError || stats.emptyResponse) return "error";
  return "ok";
}

/** resume 时的一行告警；无问题返回 null。 */
export function formatResumeWarning(meta: { lastTurn?: LastTurnMeta } | null | undefined): string | null {
  const last = meta?.lastTurn;
  if (!last || last.outcome === "ok") return null;
  const reason = last.errorMessage?.trim() || (last.outcome === "aborted" ? "上一轮被中断" : "上一轮未完成");
  return `上一轮（${last.at}）结果 ${last.outcome}：${reason}。可重新发送或用 /sessions 查看历史。`;
}
