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
/**
 * 整行就是 START 标记（允许前后空白）。
 *
 * 必须锚定 `^...$`：`START_RE` 是子串匹配，用户手写行里引用标记
 * （`- 别手改 <!-- ...start ... --> 之间的内容`）也会命中，把它当边界
 * 就会连同区块外的手写内容一起被替换掉。
 */
const START_LINE_RE = /^\s*<!-- neo:wiki-workflow:start[^>]*-->\s*$/;

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
 * 这一行是否「就是标记本身」（独占一行，允许前后空白）。
 *
 * 行内出现标记（用户手写说明里引用标记）不算 —— 否则清理残留标记时
 * 会把用户整行文字一起删掉。
 */
function isMarkerLine(line: string): boolean {
  return START_LINE_RE.test(line) || line.trim() === WIKI_SECTION_END;
}

/**
 * 找「独占一行的标记行」在原串里的起始偏移；没有返回 null。
 *
 * 独占一行 = 去掉首尾空白后整行就是标记本身（START 允许带说明尾巴）。
 * 行内出现标记（用户手写说明里引用标记）不算边界。
 */
function findMarkerLine(text: string, marker: RegExp | string): number | null {
  let offset = 0;
  for (const line of text.split("\n")) {
    const hit = typeof marker === "string" ? line.trim() === marker : marker.test(line);
    if (hit) return offset + line.indexOf(line.trim());
    offset += line.length + 1; // +1 = 被 split 吃掉的 \n
  }
  return null;
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
  // 区块边界只认「独占一行的标记行」（允许前后空白）。
  // 用 search/indexOf 做子串匹配会把用户正文行里的标记当成边界：
  // `- 别手改 <!-- ...start ... --> 之间的内容` 会被当成区块开头，
  // 连同它前面的手写内容一起被替换掉 —— 违反「区块外内容一律不碰」。
  const start = findMarkerLine(existing, START_LINE_RE);
  const end = findMarkerLine(existing, WIKI_SECTION_END);
  // 标记必须成对且按 start → end 顺序出现才认作「区块」。
  // 乱序（END 在 START 之前，多由手工编辑/复制粘贴造成）时不能按区块处理：
  // slice 会产出第二个 END，每次调用文件都增长一整个区块（非幂等）。
  if (start !== null && end !== null && end > start) {
    return existing.slice(0, start) + section + existing.slice(end + WIKI_SECTION_END.length);
  }
  // 无区块（或标记乱序）：先摘掉残留标记行，再追加。
  // 摘标记是幂等的关键：否则乱序文件每次调用都多留一对标记，无限膨胀。
  // 只摘「整行就是标记」的行 —— 用子串匹配会把用户手写的说明整行吃掉
  // （例：`- 别手改 <!-- neo:wiki-workflow:start ... --> 之间的内容`），
  // 而「区块外内容一律不碰」是本模块的核心承诺。
  const cleaned = existing
    .split("\n")
    .filter((line) => !isMarkerLine(line))
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
