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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  const start = existing.search(START_RE);
  const end = existing.indexOf(WIKI_SECTION_END);
  // 标记必须成对且按 start → end 顺序出现才认作「区块」。
  // 乱序（END 在 START 之前，多由手工编辑/复制粘贴造成）时不能按区块处理：
  // slice 会产出第二个 END，每次调用文件都增长一整个区块（非幂等）。
  if (start !== -1 && end !== -1 && end > start) {
    const endIdx = end + WIKI_SECTION_END.length;
    return existing.slice(0, start) + section + existing.slice(endIdx);
  }
  // 无区块（或标记乱序）：先摘掉残留标记行，再追加。
  // 摘标记是幂等的关键：否则乱序文件每次调用都多留一对标记，无限膨胀。
  const cleaned = existing
    .split("\n")
    .filter((line) => !START_RE.test(line) && !line.includes(WIKI_SECTION_END))
    .join("\n")
    .replace(/\s*$/, "");
  // 追加（约束 15 多 feature 共享 / 约束 18 幂等的延续）
  return cleaned === "" ? `${section}\n` : `${cleaned}\n\n${section}\n`;
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
