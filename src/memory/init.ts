/**
 * init.ts — 项目级懒创建（PRD docs/memory-prd.md §约束 14a / §约束 15 / §约束 16 / §约束 17 / §约束 18）。
 *
 * initProjectLevel(cfg, cwd):
 *   1. mkdir <cwd>/.neo/wiki/{raw,wiki,outputs}
 *   2. 写 <cwd>/.neo/wiki/raw/tags.md（空占位）
 *   3. AGENTS.md 追加 ## 工作流 段（按 karpathy-wiki-* 完整度切先手/降级支）
 *   4. 启动日志 INFO / WARN（不抛）
 *
 * worktree 隔离（约束 50）：
 *   - cfg.memory.worktreeIsolation=false（默认）：profile 走 ~/.neo/ 全局
 *   - true：profile 走 <cwd>/.neo/wiki/profile.md（项目内隔离）
 *   本单不实现 worktree 隔离路径；留给接口测试备用
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSkills } from "../skills.ts";
import type { Config } from "../config.ts";
import { buildAgentsContent, isWikiSkillComplete } from "./agMd.ts";
import { MemoryError } from "./types.ts";

const WORKFLOW_HEAD = "## 工作流";

/**
 * 懒创建项目级 wiki 骨架 + 写 AGENTS.md。
 * 失败：启动日志 WARN；不抛（约束 17）。
 */
export async function initProjectLevel(cfg: Config, cwd: string): Promise<void> {
  const m = cfg.memory;
  if (!m.enabled) return;

  try {
    ensureWikiDirs(cwd);
    writeTagsFile(cwd);
    await writeOrUpdateAgentsContent(cfg, cwd);

    // 启动日志 INFO（不在失败分支）
    console.error(`已初始化项目级 wiki 记忆骨架 @ ${cwd}/.neo/wiki/`);
  } catch (e) {
    // 约束 17：失败不抛，会话不阻塞
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`项目级 wiki 骨架创建失败（${reason}），本次会话不写索引`);
    return;
  }
}

/* ------------------------------------------------------------------ */
/* 内部 helpers                                                          */
/* ------------------------------------------------------------------ */

function ensureWikiDirs(cwd: string): void {
  const base = join(cwd, ".neo", "wiki");
  for (const sub of ["raw", "wiki", "outputs"]) {
    const p = join(base, sub);
    if (existsSync(p)) continue;
    mkdirSync(p, { recursive: true });
  }
}

function writeTagsFile(cwd: string): void {
  const tagsPath = join(cwd, ".neo", "wiki", "raw", "tags.md");
  if (existsSync(tagsPath)) return;  // 约束 16 / 18 幂等：已含跳过
  writeFileSync(tagsPath, "", "utf8");
}

/**
 * AGENTS.md 写入策略（约束 18 幂等）：
 *   - 文件不存在：新建（含 ## 工作流 段）
 *   - 文件存在 + 已含 ## 工作流 段：跳过
 *   - 文件存在 + 不含 ## 工作流 段：append（不覆盖）
 */
async function writeOrUpdateAgentsContent(cfg: Config, cwd: string): Promise<void> {
  const agentsPath = join(cwd, "AGENTS.md");
  const skills = discoverSkills(cfg);
  const degraded = !isWikiSkillComplete(skills.map((s) => s.name));
  const section = buildAgentsContent(degraded);

  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, section, "utf8");
    return;
  }

  const existing = readFileSync(agentsPath, "utf8");
  if (existing.includes(WORKFLOW_HEAD)) {
    // 约束 18：已含工作流段，跳过
    return;
  }

  // 文件存在且无工作流段：追加（约束 15 多 feature 共享）
  appendFileSync(agentsPath, "\n\n" + section, "utf8");
}