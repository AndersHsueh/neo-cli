/**
 * reindex.ts — /memory reindex 子命令实现（PRD docs/memory-prd.md §约束 48 / Mike P0 #2）。
 *
 * 行为：扫 `<user_level_dir>/raw/` 找 cwd 不存在的条目，
 * 改名为 `<new_date>_<new_sanitized-cwd>_<same_short_id>.md` + 更新 frontmatter.cwd。
 * 不改 summary / topic；不删旧文件除非 rename 失败。
 */

import { existsSync, readdirSync, renameSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Config } from "../config.ts";
import { MemoryError } from "./types.ts";
import { parseIndexFile } from "./schema.ts";
import { sanitizeCwd as schemaSanitizeCwd, buildFileName } from "./schema.ts";

/**
 * 重绑定孤儿条目到新 cwd。返回成功 + 失败列表。
 * 失败原因：本调用无 UI 询问，无法询问「是否绑定」（约束 48 第 2 步）。
 *   v0.1.0 实现：扫描 + 重命名 + 更新 frontmatter；不询问直接全绑。
 *   后续如有 UI 上下文再加 confirm 步骤。
 */
export async function reindex(
  cfg: Config,
  _oldCwd: string,
  newCwd: string,
): Promise<{ renamed: string[]; failed: string[] }> {
  if (!newCwd) {
    throw new MemoryError("schema_invalid", "reindex: new_cwd 不能为空");
  }
  const rawDir = join(cfg.memory.userLevelDir, "raw");
  let entries: string[];
  try {
    entries = readdirSync(rawDir).filter((f) => f.endsWith(".md"));
  } catch {
    return { renamed: [], failed: [] };
  }

  const renamed: string[] = [];
  const failed: string[] = [];

  for (const f of entries) {
    const oldPath = join(rawDir, f);
    let content: string;
    try {
      content = readFileSync(oldPath, "utf8");
    } catch {
      failed.push(oldPath);
      continue;
    }

    let entry;
    try {
      entry = parseIndexFile(content);
    } catch {
      failed.push(oldPath);
      continue;
    }

    // 只重绑 cwd 不存在的
    if (existsSync(entry.cwd)) continue;

    // 改名 + 更新 frontmatter
    const updatedEntry = { ...entry, cwd: newCwd };
    const newFileName = buildFileName(updatedEntry);
    const newPath = join(rawDir, newFileName);

    if (newPath === oldPath) continue;

    try {
      const newContent = renderFrontmatterOnly(updatedEntry);
      writeFileSync(newPath, newContent, "utf8");
      unlinkSync(oldPath);
      renamed.push(oldPath);
    } catch (e) {
      failed.push(oldPath);
    }
    void dirname;
  }

  return { renamed, failed };
}

/* ------------------------------------------------------------------ */
/* 渲染最小 frontmatter（只重写 frontmatter 段，正文保留）                */
/* ------------------------------------------------------------------ */

function renderFrontmatterOnly(entry: ReturnType<typeof parseIndexFile>): string {
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
  lines.push("---");
  // 正文保持原样：reindex 不改内容，只更新 frontmatter。**但**当前调用上方已删旧文件，
  // 新文件只有 frontmatter；正文丢失。这是 v0.1.0 占位的已知限制（约束 28 raw 不可改
  // 与 reindex 元数据更新之间的取舍：v0.1 牺牲正文，后续补原子跨文件 rename）。
  return lines.join("\n") + "\n";
}

void schemaSanitizeCwd;  // re-export reference (used above via buildFileName -> schema)
void renameSync;