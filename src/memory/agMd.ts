/**
 * agMd.ts — AGENTS.md 的 wiki 工作流区块（wiki-turnning-1018.md「区块所有权」）。
 *
 * AGENTS.md 有两个作者：/init 生成的记忆骨架 + 用户手写的「约定/踩坑」。
 * 本模块只负责 wiki 工作流区块：
 *   - 区块用 HTML 注释标记包裹（neo:wiki-workflow:start / end）；
 *   - 写入策略：无标记 → 追加区块；有标记 → 只重写标记之间的内容；
 *   - 区块外的内容（用户手写、旧版 /init 生成）一律不碰。
 *
 * 旧版按 karpathy-wiki-* 技能可用性分先手/降级两支 —— 技能已退役（能力内化
 * 为 src/wiki/ 与工具层），两支合并为单一区块。
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const WIKI_SECTION_START = "<!-- neo:wiki-workflow:start";
export const WIKI_SECTION_END = "<!-- neo:wiki-workflow:end -->";
/** 区块标记的完整开头（含说明尾巴），用于识别旧格式标记。 */
const START_RE = /<!-- neo:wiki-workflow:start[^>]*-->/;

/** 模板目录（src/wiki/templates/）。用 import.meta 解析，不依赖 cwd。 */
function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "wiki", "templates");
}

/** 读 wiki 工作流区块模板。 */
function loadSectionTemplate(): string {
  return readFileSync(join(templatesDir(), "agents-wiki-section.md"), "utf8");
}

/**
 * 计算 AGENTS.md 应有的最终内容。
 *
 *  - 文件不存在 → 头部 + 区块；
 *  - 有区块 → 区块间内容替换为最新模板，其余原样；
 *  - 无区块 → 原文 + 空行 + 区块（追加，不覆盖）。
 */
export function composeAgentsContent(existing: string | null): string {
  const section = loadSectionTemplate().trimEnd();
  if (existing === null || existing.trim() === "") {
    return `${section}\n`;
  }
  if (START_RE.test(existing) && existing.includes(WIKI_SECTION_END)) {
    const start = existing.search(START_RE);
    const end = existing.indexOf(WIKI_SECTION_END);
    const endIdx = end + WIKI_SECTION_END.length;
    return existing.slice(0, start) + section + existing.slice(endIdx);
  }
  // 无区块：追加（约束 15 多 feature 共享 / 约束 18 幂等的延续）
  return `${existing.replace(/\s*$/, "")}\n\n${section}\n`;
}

/**
 * 把 wiki 工作流区块写入 <cwd>/AGENTS.md（区块所有权模式）。
 * 幂等：重复调用结果一致（区块内容 = 最新模板）。
 */
export function writeWikiSection(cwd: string): void {
  const p = join(cwd, "AGENTS.md");
  const existing = existsSync(p) ? readFileSync(p, "utf8") : null;
  writeFileSync(p, composeAgentsContent(existing), "utf8");
}

/**
 * 旧接口兼容壳。旧签名 buildAgentsContent(degraded: boolean) 的调用方
 * （memory/init.ts）已迁移；保留导出避免第三方引用炸裂，但 degraded 参数已无意义。
 */
export function buildAgentsContent(_degraded = false): string {
  void _degraded;
  return composeAgentsContent(null);
}

/** 追加式写入（仅当文件存在且无区块时用；init.ts 现走 writeWikiSection）。 */
export function appendAgentsSection(cwd: string): void {
  const p = join(cwd, "AGENTS.md");
  if (!existsSync(p)) {
    writeFileSync(p, composeAgentsContent(null), "utf8");
    return;
  }
  const existing = readFileSync(p, "utf8");
  if (START_RE.test(existing)) {
    writeWikiSection(cwd); // 已有区块 → 走重写
    return;
  }
  appendFileSync(p, `\n\n${loadSectionTemplate().trimEnd()}\n`, "utf8");
}
