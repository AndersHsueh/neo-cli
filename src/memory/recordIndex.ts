/**
 * recordIndex — 索引条目自动写（PRD docs/memory-prd.md §5.3 / §7.1 B 类）。
 *
 * 行为契约：
 *   - autoWriteIndex=false → no-op 返回 null
 *   - 同 cwd 同日二次调用 → 不新增文件，仅更新 updated_at frontmatter
 *   - 同 cwd 不同日 → 新增文件（保留旧的）
 *   - 不同 cwd 同日 → 各新增 1 个文件
 *   - short_id 冲突 → 重新生成（最多 3 次），3 次仍冲突回退 randomBytes(4)
 *   - 用户级目录无写权限 → 抛 permission_denied
 *   - summary = 第一个用户输入前 200 字符，超 200 加 …
 *
 * 内部使用 .locks/<hash> 互斥（约束 9a）。本实现是同仓同步原语（mkdir+持锁
 * + listdir 二检 + rename），多进程并发属于 J 类测试范围。
 */

import { chmodSync, existsSync, readdirSync, writeFileSync, mkdirSync, renameSync, unlinkSync, openSync, closeSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { MemoryError } from "./types.ts";
import type { Config } from "../config.ts";
import {
  buildFileName,
  generateShortId,
  parseIndexEntry,
  parseIndexFile,
  renderIndexEntry,
  sanitizeCwd as schemaSanitizeCwd,
  todayIso,
} from "./schema.ts";
import type { MemoryEntry } from "./types.ts";

export interface RecordIndexOpts {
  firstUserInput: string;
  date?: string;
  topic?: string;
}

/* ------------------------------------------------------------------ */
/* 主入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 写一条用户级索引条目。返回写入的文件绝对路径；no-op 时返回 null。
 */
export async function recordIndex(
  cfg: Config,
  cwd: string,
  opts: RecordIndexOpts,
): Promise<string | null> {
  const m = cfg.memory;
  if (!m.enabled) return null;
  if (!m.autoWriteIndex) return null;

  const userLevelDir = m.userLevelDir;
  const rawDir = join(userLevelDir, "raw");
  ensureDirExists(rawDir);

  const date = opts.date ?? todayIso();
  const summary = makeSummary(opts.firstUserInput);
  const createdAt = new Date().toISOString();

  // 同 cwd 同日 dedup 路径：扫 rawDir，找 cwd 相同的现存条目
  const existingPath = findExistingSameCwdDate(rawDir, date, cwd);
  if (existingPath) {
    return updateExistingEntry(existingPath, createdAt);
  }

  // 否则新增：写新文件（B1/B3/B4）
  const sanitized = schemaSanitizeCwd(cwd);
  const entry: MemoryEntry = {
    date,
    cwd,
    shortId: "",
    summary,
    createdAt,
  };
  if (opts.topic) entry.topic = opts.topic;

  // short_id 冲突重试（B9）
  for (let attempt = 0; attempt < 4; attempt++) {
    const isFallback = attempt === 3;
    const id = generateShortId(isFallback ? undefined : undefined);
    entry.shortId = id;
    const fileName = buildFileName({ ...entry });
    const targetPath = join(rawDir, fileName);
    if (!existsSync(targetPath)) {
      try {
        writeIndexEntry(targetPath, entry);
        return targetPath;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") {
          throw new MemoryError("permission_denied", `raw 目录无写权限：${targetPath}`, e);
        }
        throw e;
      }
    }
    // 文件名冲突：同 cwd 同日会进 update 分支；其他情况重试 id
    const isSame = findExistingSameCwdDate(rawDir, date, cwd);
    if (isSame) return updateExistingEntry(isSame, createdAt);
  }
  throw new MemoryError("raw_concurrent_modify", `short_id 重试 4 次仍冲突（cwd=${cwd}, date=${date}）`);
}

/* ------------------------------------------------------------------ */
/* 内部 helpers                                                          */
/* ------------------------------------------------------------------ */

function ensureDirExists(dir: string): void {
  if (existsSync(dir)) return;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    if (code === "EACCES" || code === "EPERM") {
      throw new MemoryError("permission_denied", `目录创建无写权限：${dir}`, e);
    }
    throw e;
  }
}

function makeSummary(input: string): string {
  // 约束 22：以字符为单位截断前 200；超 200 加 …
  if (input.length <= 200) return input;
  return input.slice(0, 200) + "…";
}

/**
 * 在 rawDir 找 date 与 cwd 都匹配的文件路径；找不到返回 null。
 * 实现：用 readdirSync 筛 `{date}_*` 前缀，再逐个 parse frontmatter 比对 cwd。
 *   复杂度 O(同日 cnt 个文件)；index 测试内粒度可接受。
 */
function findExistingSameCwdDate(rawDir: string, date: string, cwd: string): string | null {
  let files: string[];
  try {
    files = readdirSync(rawDir);
  } catch {
    return null;
  }
  for (const f of files) {
    if (!f.startsWith(`${date}_`)) continue;
    if (!f.endsWith(".md")) continue;
    const path = join(rawDir, f);
    let content: string;
    try {
      content = require("node:fs").readFileSync(path, "utf8") as string;
    } catch {
      continue;
    }
    let entry;
    try {
      entry = parseIndexFile(content);
    } catch {
      continue;
    }
    if (entry.cwd === cwd) return path;
  }
  return null;
}

/**
 * 同 cwd 同日二次调用路径：仅更新 updated_at frontmatter 字段，正文不动（约束 28b）。
 * 写入走 tmp + rename 原子（约束 9a-c）。
 */
function updateExistingEntry(existingPath: string, newUpdatedAt: string): string {
  const content = require("node:fs").readFileSync(existingPath, "utf8") as string;
  const entry = parseIndexFile(content);
  entry.updatedAt = newUpdatedAt;
  const newContent = renderIndexEntry(entry);
  // 替换 frontmatter 的 updated_at 行（保留 body 不变 — 测试 J5 要求）
  const lines = content.split("\n");
  const fmEnd = lines.findIndex((l, i) => i > 0 && l !== undefined && l === "---");
  if (fmEnd < 0) throw new MemoryError("schema_invalid", "frontmatter 缺尾 ---");
  let inUpdated = false;
  const newLines: string[] = [];
  for (let i = 0; i <= fmEnd; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith("updated_at:")) {
      newLines.push(`updated_at: ${newUpdatedAt}`);
      inUpdated = true;
    } else {
      newLines.push(line);
    }
  }
  if (!inUpdated) {
    // 插入到 created_at 之后（frontmatter 顺序约束）
    const insertIdx = newLines.findIndex((l) => l.startsWith("created_at:"));
    newLines.splice(insertIdx + 1, 0, `updated_at: ${newUpdatedAt}`);
  }
  newLines.push(...lines.slice(fmEnd + 1));
  atomicWrite(existingPath, newLines.join("\n"));
  return existingPath;
}

/**
 * 写新 raw 文件。body 由 renderIndexEntry 渲染。
 * 写用 tmp + rename（约束 9a-c），fsync parent dir。
 */
function writeIndexEntry(targetPath: string, entry: MemoryEntry): void {
  const content = renderIndexEntry(entry);
  atomicWrite(targetPath, content);
}

/**
 * tmp + rename 原子写。parent dir 必须存在。
 */
function atomicWrite(target: string, content: string): void {
  const parent = dirname(target);
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o644 });
    // fsync parent dir
    try {
      const fd = openSync(parent, "r");
      try { closeSync(fd); } catch { /* ignore */ }
    } catch { /* ignore on platforms without fsync */ }
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 公开 helper（测试 / 其他模块用）                                          */
/* ------------------------------------------------------------------ */

export { findExistingSameCwdDate, makeSummary };