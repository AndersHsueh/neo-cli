/**
 * ingest.ts — 写入时同步 ingest（PRD docs/memory-prd.md §5.2 / §7.1 F 类 / §约束 19/20/21）。
 *
 * 实现：
 *   - defaultIngestEngine：defaultImpl（happy path 真写 wiki/index.md；failure 注入抛错）
 *   - ingestUserLevel：包装引擎调用，失败时落 .ingest-failures/<date>_<id>.log
 *                     + 触发下一次扫重试
 *   - retryFailedIngestes：扫 .ingest-failures/*.log 重新跑
 *
 * 失败注入（PRD §7.4 #2 测试可注入）：
 *   - opts.failure ∈ { "network" | "429" | "unparseable" | "timeout" } 强制抛错
 *   - 默认实现即带；测试可用 registerIngestEngine 注入自定义引擎
 *   - 环境变量 NEO_MEMORY_INGEST_FAIL（兜底；测试不走，避免 env 泄漏）
 *
 * raw 是真相源（约束 19/20/21）：失败绝不回滚已写的 raw。
 */

import { existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import type { IngestEngine, IngestOpts, IngestResult } from "./types.ts";
import { MemoryError } from "./types.ts";
import { currentIngestEngine } from "./index.ts";

/* ------------------------------------------------------------------ */
/* defaultIngestEngine — happy path 真实现 + failure 注入               */
/* ------------------------------------------------------------------ */

export class DefaultIngestEngine implements IngestEngine {
  readonly name = "default-classifier-provider";

  async ingest(cfg: Config, opts?: IngestOpts): Promise<IngestResult> {
    // 1. failure 注入（PRD §7.4 #2 测试可注入）
    if (opts?.failure === "network") {
      throw new MemoryError("ingest_failed", "网络错误（注入）");
    }
    if (opts?.failure === "429") {
      console.error("记忆 ingest 配额耗尽（429）");
      throw new MemoryError("ingest_failed", "rate limit 429（注入）");
    }
    if (opts?.failure === "unparseable") {
      throw new MemoryError("ingest_failed", "LLM 输出无法解析（注入）");
    }
    // F5 兼容：失败名 `timeout`（短）与 `timeout_fast`（冗余别名）。
    if (opts?.failure === "timeout_fast" || opts?.failure === "timeout") {
      throw new MemoryError("ingest_failed", "ingest 超时（注入）");
    }

    // F4 retry：网络/超时类失败（PRD §约束 21）做 500ms × 2 = 3 attempts 总尝试；
    // 当前默认实现无真网络（happy path 立即成功），但保留 retry 壳便于真实 LLM 接入。
    return await ingestWithRetry(() => this.runHappyPath(cfg), opts);
  }

  private async runHappyPath(cfg: Config): Promise<IngestResult> {

    // 2. happy path：扫 raw/*.md → wiki/index.md
    const userLevelDir = cfg.memory.userLevelDir;
    const rawDir = join(userLevelDir, "raw");
    const wikiDir = join(userLevelDir, "wiki");
    ensureDirExists(wikiDir);

    let rawFiles: string[];
    try {
      rawFiles = readdirSync(rawDir).filter(f => f.endsWith(".md"));
    } catch {
      rawFiles = [];
    }

    // 真实 ingest 会调 LLM 渲染 wiki 视图。本实现按 §7.4 #2 占位：
    // 写一份最小可解析的 wiki/index.md，含 date / short_id / summary。
    const lines: string[] = ["# 记忆索引", ""];
    let entries = 0;
    for (const f of rawFiles) {
      try {
        const text = readFileSync(join(rawDir, f), "utf8");
        const m = text.match(/^---\n([\s\S]*?)\n---/);
        if (!m || m[1] === undefined) continue;
        const fm = m[1];
        const dateM = fm.match(/^date:\s*(.+)$/m);
        const idM = fm.match(/^short_id:\s*(.+)$/m);
        const sumM = fm.match(/^summary:\s*(.+)$/m);
        if (!dateM || !idM || !sumM) continue;
        const date = dateM[1];
        const id = (idM[1] ?? "").trim();
        const summary = sumM[1] ?? "";
        lines.push(`- ${date} ${id} ${summary}`);
        entries++;
      } catch {
        // skip unparseable
      }
    }
    writeFileSync(join(wikiDir, "index.md"), lines.join("\n") + "\n", "utf8");

    return { wikiPath: "wiki/index.md", indexEntries: entries };
  }
}

/* ------------------------------------------------------------------ */
/* 默认注册实例                                                            */
/* ------------------------------------------------------------------ */

export const defaultIngestEngine: IngestEngine = new DefaultIngestEngine();

/* ------------------------------------------------------------------ */
/* ingestUserLevel — 包装引擎调用 + 失败日志                              */
/* ------------------------------------------------------------------ */

/**
 * 跑一次用户级 ingest。
 *   - 成功：{ wikiPath, indexEntries }
 *   - 失败：抛 MemoryError code='ingest_failed'；失败前在 .ingest-failures/ 落日志
 *   - 成功或失败都会先扫 .ingest-failures/ 重试上一次失败的（F6）
 */
export async function ingestUserLevel(cfg: Config, opts?: IngestOpts): Promise<IngestResult> {
  // F6：扫历史失败重试
  await retryFailedIngestes(cfg, opts);

  const engine = currentIngestEngine();
  try {
    return await engine.ingest(cfg, opts);
  } catch (e) {
    if (e instanceof MemoryError && e.code === "ingest_failed") {
      writeFailureLog(cfg, opts, e);
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 失败日志                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 在 `<userLevelDir>/.ingest-failures/<date>_<short_id>.log` 落一条记录。
 * 文件名取当前日期 + 8 hex id（短 id 与 ingest 跑出的索引条目无关，仅用于本地失败记录）。
 */
export function writeFailureLog(cfg: Config, _opts: IngestOpts | undefined, error: MemoryError): string {
  const journalDir = cfg.memory.ingestJournal.dir;
  ensureDirExists(journalDir);
  const date = new Date().toISOString().slice(0, 10);
  const id = randomUUID().replace(/-/g, "").slice(0, 8);
  const path = join(journalDir, `${date}_${id}.log`);
  const log = [
    `ts: ${new Date().toISOString()}`,
    `code: ${error.code}`,
    `message: ${error.message}`,
    ``,
  ].join("\n");
  writeFileSync(path, log, "utf8");
  return path;
}

/* ------------------------------------------------------------------ */
/* 重试                                                                    */
/* ------------------------------------------------------------------ */

/**
 * 扫 `<journalDir>/*.log` 跑 ingest；成功后 unlink（F6）。
 * 失败：保留 log 文件，下一次调用继续重试。
 */
export async function retryFailedIngestes(cfg: Config, opts?: IngestOpts): Promise<number> {
  const journalDir = cfg.memory.ingestJournal.dir;
  let logs: string[];
  try {
    logs = readdirSync(journalDir).filter(f => f.endsWith(".log"));
  } catch {
    return 0;
  }

  const engine = currentIngestEngine();
  let cleared = 0;
  for (const f of logs) {
    const full = join(journalDir, f);
    try {
      await engine.ingest(cfg, opts);
      unlinkSync(full);
      cleared++;
    } catch {
      // 保留 log 等下次
    }
  }
  return cleared;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                    */
/* ------------------------------------------------------------------ */

function ensureDirExists(dir: string): void {
  if (existsSync(dir)) return;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
}
/* ------------------------------------------------------------------ */
/* 内部 helpers                                                          */
/* ------------------------------------------------------------------ */

/**
 * retry 壳（PRD §约束 21）：网络 / 超时类失败做 500ms × 2 = 3 attempts；
 * 配额（429）/ 解析错误不重试（直接抛）。
 */
async function ingestWithRetry(
  fn: () => Promise<IngestResult>,
  opts?: IngestOpts,
): Promise<IngestResult> {
  const failMode = opts?.failure;
  const shouldRetry = failMode === "network" || failMode === "timeout" || failMode === "timeout_fast";
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!shouldRetry) throw e;
      if (attempt < 2) {
        console.error(`记忆 ingest 重试 ${attempt + 1}/2`);
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    }
  }
  throw lastErr;
}
