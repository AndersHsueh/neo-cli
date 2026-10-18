/**
 * init.ts — 项目级懒创建（PRD docs/memory-prd.md §约束 14a / §约束 15 / §约束 16 / §约束 17 / §约束 18）。
 *
 * initProjectLevel(cfg, cwd):
 *   1. mkdir <cwd>/.neo/wiki/{raw,wiki,outputs}
 *   2. 写 <cwd>/.neo/wiki/raw/tags.md（空占位）
 *   3. mkdir <cwd>/skills/（空目录，用户自建技能入口；wiki 能力已内化为代码，不再软链技能）
 *   4. AGENTS.md 写 wiki 工作流区块（区块所有权模式，只动 neo:wiki-workflow 标记之间的内容）
 *   5. 启动日志 INFO / WARN（不抛）
 *
 * worktree 隔离（约束 50）：
 *   - cfg.memory.worktreeIsolation=false（默认）：profile 走 ~/.neo/ 全局
 *   - true：profile 走 <cwd>/.neo/wiki/profile.md（项目内隔离）
 *   本单不实现 worktree 隔离路径；留给接口测试备用
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { writeWikiSection } from "./agMd.ts";
import { MemoryError } from "./types.ts";

/**
 * 懒创建项目级 wiki 骨架 + 写 AGENTS.md。
 * 失败：抛 MemoryError（约束 17 期望调用方吞掉并 WARN；这里按 §7.1 E3 实抛）。
 * 调用方应在 src/index.ts 钩子处 try/catch 并 stderr WARN，避免阻塞会话。
 */
export async function initProjectLevel(cfg: Config, cwd: string): Promise<void> {
  const m = cfg.memory;
  if (!m.enabled) return;

  ensureWikiDirsOrThrow(cwd);
  writeTagsFile(cwd);
  ensureSkillsDir(cwd);
  writeOrUpdateAgentsContent(cfg, cwd);

  // 启动日志 INFO（不在失败分支）
  console.error(`已初始化项目级 wiki 记忆骨架 @ ${cwd}/.neo/wiki/`);
}

/* ------------------------------------------------------------------ */
/* 内部 helpers                                                          */
/* ------------------------------------------------------------------ */

function ensureWikiDirsOrThrow(cwd: string): void {
  const base = join(cwd, ".neo", "wiki");
  for (const sub of ["raw", "wiki", "outputs"]) {
    const p = join(base, sub);
    if (existsSync(p)) continue;
    try {
      mkdirSync(p, { recursive: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new MemoryError("permission_denied", `项目级 wiki 骨架目录无写权限：${p}`, e);
      }
      throw e;
    }
  }
}

function writeTagsFile(cwd: string): void {
  const tagsPath = join(cwd, ".neo", "wiki", "raw", "tags.md");
  if (existsSync(tagsPath)) return;  // 约束 16 / 18 幂等：已含跳过
  writeFileSync(tagsPath, "", "utf8");
}

/**
 * 项目技能目录（<cwd>/skills/）。wiki 能力已内化为代码，/init 不再软链任何
 * karpathy-wiki-* 技能；此目录保留为用户自建技能的入口（skills.ts 扫描它）。
 */
function ensureSkillsDir(cwd: string): void {
  const p = join(cwd, "skills");
  if (existsSync(p)) return;
  try {
    mkdirSync(p, { recursive: true });
  } catch {
    // 技能目录创建失败不阻塞骨架初始化（约束 17：WARN 不抛）
  }
}

/**
 * AGENTS.md 写入策略（区块所有权模式，wiki-turnning-1018.md）：
 *   - 文件不存在：新建（含 wiki 工作流区块）
 *   - 文件存在：只重写 neo:wiki-workflow 标记之间的区块；区块外的手写内容不动
 *   - 无区块：追加区块（不覆盖）
 * 幂等：重复调用结果一致。
 */
function writeOrUpdateAgentsContent(cfg: Config, cwd: string): void {
  void cfg;
  writeWikiSection(cwd);
}