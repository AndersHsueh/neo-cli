/**
 * agMd.ts — AGENTS.md 路由文案模板（PRD docs/memory-prd.md §约束 14a / §约束 16）。
 *
 * 按 karpathy-wiki-* 技能可用性，分两支路由：
 *   - 先手支：技能齐全，模型用 `use_skill karpathy-wiki-*` 调用
 *   - 降级支：技能缺失，模型用 `read_file` / `write_file` 直读
 */

const AGENTS_HEADER = `# 项目记忆（来自 neo 记忆系统）

本文档由 \`/init\` 一次性生成；后续手改不会被覆盖。

`;

const COMPLETE_ROUTING_SECTION = `## 工作流

wiki 操作由 \`karpathy-wiki-*\` 技能承载。涉及以下场景时**先调对应技能**加载完整规则（如已加载则跳过）：

1. 写入新内容到 \`<cwd>/.neo/wiki/raw/\` → 先 \`use_skill karpathy-wiki-new\`
2. 写入完成后触发同步编译 → \`use_skill karpathy-wiki-ingest\`
3. 提交前做健康检查 → \`use_skill karpathy-wiki-lint\`
4. 用户问「以前做过 XX」→ \`use_skill karpathy-wiki-query\`（跨库查询：用户级 → 项目级）

`;

const DEGRADED_ROUTING_SECTION = `## 工作流（降级支）

karpathy-wiki-* 技能未安装。wiki 操作**直接走文件工具**，不依赖 \`use_skill\`。

1. 写入 \`<cwd>/.neo/wiki/raw/\` → \`write_file\`
2. 写入完成后**手动触发** ingest（暂无守护进程），或等待下版；在此期间 raw 文件已落盘，不丢记忆
3. 用户问「以前做过 XX」→ 先 \`read_file ~/.neo/memorys/raw/\` 按 cwd 匹配，再 \`read_file <cwd>/.neo/wiki/\`。**回答必须标注「本回答基于原始记录，wiki 未重编译」**
4. 技能恢复后，**下一次 \`/init\`** 会重写本段为先手支

`;

const NEEDED_SKILLS = ["karpathy-wiki-new", "karpathy-wiki-ingest", "karpathy-wiki-lint", "karpathy-wiki-query"];

/** 是否所有 karpathy-wiki-* 技能都可用。 */
export function isWikiSkillComplete(discoveredNames: string[]): boolean {
  const set = new Set(discoveredNames);
  return NEEDED_SKILLS.every((n) => set.has(n));
}

/**
 * 拼装 AGENTS.md 全文（先手支 or 降级支）。
 */
export function buildAgentsContent(degraded: boolean): string {
  return [
    AGENTS_HEADER,
    degraded ? DEGRADED_ROUTING_SECTION : COMPLETE_ROUTING_SECTION,
  ].join("\n");
}