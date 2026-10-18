/**
 * wiki 检索 —— wiki_search 工具的实现。
 *
 * 定位（wiki-turnning-1018.md 问题 2）：给「查」一个明确的工具入口，
 * 不靠模型自觉去 read_file。规模出口原则：先 INDEX 定位；库大了（>150 页）
 * 或需要关键词命中时走这里，捞候选页后回 INDEX 校对归属。
 *
 * 实现：朴素关键词检索（多词 AND + 简单相关度排序），不引入外部依赖。
 * 对「项目内回忆之前动作」的规模（几十到几百页）足够；将来要语义检索
 * 再换实现，接口不变。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { WikiLayout } from "./paths.ts";

export interface SearchHit {
  page: string;
  title: string;
  /** 命中得分（词频和，仅用于排序）。 */
  score: number;
  /** 命中行摘要（最多 3 行，带行号）。 */
  snippets: string[];
}

/**
 * 全库关键词检索。多词 AND：包含全部词的页面才算命中，按词频和排序。
 * 豁免文件（log.md）参与检索——时间线查询靠它；INDEX.md 不参与（它是目录不是内容）。
 */
export function searchWiki(layout: WikiLayout, query: string, limit = 10): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const files = readdirSync(layout.pagesDir).filter((f) => f.endsWith(".md"));
  const hits: SearchHit[] = [];

  for (const f of files) {
    // INDEX 是目录不是内容，不参与命中
    if (f === "INDEX.md" || f === "index.md") continue;
    let text: string;
    try {
      text = readFileSync(join(layout.pagesDir, f), "utf8");
    } catch {
      continue;
    }
    const lower = text.toLowerCase();

    // 多词 AND
    if (!terms.every((t) => lower.includes(t))) continue;

    // 计分：词频和
    let score = 0;
    for (const t of terms) {
      let i = 0;
      let n = 0;
      while ((i = lower.indexOf(t, i)) !== -1) {
        n++;
        i += t.length;
      }
      score += n;
    }

    // 命中行摘要：取前 3 个含任一词的行
    const snippets: string[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && snippets.length < 3; i++) {
      const line = lines[i] ?? "";
      const ll = line.toLowerCase();
      if (terms.some((t) => ll.includes(t))) {
        snippets.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    }

    const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? f.replace(/\.md$/, "")).trim();
    hits.push({ page: f, title, score, snippets });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** 渲染检索结果（工具输出）。 */
export function formatSearchResults(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `无命中: ${query}`;
  const lines = [`${hits.length} 个页面命中（按相关度排序）:`];
  for (const h of hits) {
    lines.push(`- [[${h.page.replace(/\.md$/, "")}]] ${h.title}（score ${h.score}）`);
    for (const s of h.snippets) lines.push(`    ${s}`);
  }
  return lines.join("\n");
}

/** 空库守卫：主题页目录不存在或没有 .md 时给出可行动的提示。 */
export function wikiIsEmpty(layout: WikiLayout): boolean {
  if (!existsSync(layout.pagesDir)) return true;
  return readdirSync(layout.pagesDir).filter((f) => f.endsWith(".md")).length === 0;
}
