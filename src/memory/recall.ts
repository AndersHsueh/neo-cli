/**
 * recall.ts — 记忆召回（v0.2 记忆激活 §7.7）。
 *
 * 三层递进里的 R1/R2 共用本模块的检索与渲染：
 *  - 关键词抽取：中文 bigram + 英文词 + 停用词过滤；
 *  - 打分：词频 + 标题命中×3 + 近 30 天×2 + 项目级加权；
 *  - 排序：**严格两桶** —— 先全部项目级，再用户级（规格 §7.7.4；
 *    混排会让跨项目偏好压过本项目事实）；
 *  - 预算：按 token 截断，优先保留项目级。
 *
 * 零依赖、纯函数为主的实现：检索走朴素全文扫描，当前库规模（几十~几百页）
 * 足够；要换语义检索时只需替换 searchScored 的实现。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WikiLayout } from "../wiki/paths.ts";
import { estimateTokens, type Message } from "../llm.ts";
import { RECALL_MARKER, type RecallTrace, type RecallTraceHit } from "./port.ts";

/* ------------------------------------------------------------------ */
/* 关键词抽取                                                          */
/* ------------------------------------------------------------------ */

/** 高频虚词与疑问词：它们出现在几乎每页，命中率高但信息量低。 */
const STOPWORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "和", "与", "及", "或",
  "这", "那", "有", "个", "就", "不", "也", "都", "要", "会", "把", "被", "对", "从",
  "到", "为", "以", "上", "下", "里", "么", "吗", "呢", "吧", "啊", "呀", "着", "过",
  "什么", "怎么", "为什么", "如何", "一下", "我们", "你们", "他们", "可以", "需要",
  "应该", "现在", "然后", "但是", "因为", "所以", "如果", "这个", "那个", "没有",
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "on", "for", "and",
  "or", "it", "this", "that", "with", "how", "why", "what", "i", "you", "we", "do",
  "does", "did", "can", "should", "would", "could", "be", "been", "at", "by", "as",
]);

const CJK_RE = /[\u4e00-\u9fff]/;

/** 单字虚词表：用于过滤「纯虚词组成的 bigram / 短串」，避免垃圾关键词。 */
const STOP_CHARS = new Set(
  "的了是在我你他她它们和与及或这那有个就不也都要把被对从到为以上下里么吗呢吧啊呀着过怎什哪谁还又很太更最才只等其于并而则所之".split(""),
);

function allStopChars(s: string): boolean {
  for (const ch of s) {
    if (!STOP_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * 从用户输入抽取检索关键词。
 * - 英文/数字 token 原样（≥2 字符）；
 * - 中文按 bigram 切分（中文无空格，bigram 是零依赖下最稳的方案）；
 * - 长度 2~4 的完整中文串额外加入（专有名词/术语命中更准）；
 * - 去重、去停用词，最多 max 个。
 */
export function extractTerms(text: string, max = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): boolean => {
    const t = raw.trim().toLowerCase();
    if (t.length < 2) return false;
    if (STOPWORDS.has(t)) return false;
    if (CJK_RE.test(t) && allStopChars(t)) return false;
    if (seen.has(t)) return false;
    seen.add(t);
    out.push(t);
    return out.length >= max;
  };

  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9_.\-/]{1,}/g)) {
    if (push(m[0])) return out;
  }
  const runs = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) {
    if (run.length >= 2 && run.length <= 4) {
      if (push(run)) return out;
    }
    for (let i = 0; i + 1 < run.length; i++) {
      if (push(run.slice(i, i + 2))) return out;
    }
  }
  return out.slice(0, max);
}

/* ------------------------------------------------------------------ */
/* 单库检索                                                            */
/* ------------------------------------------------------------------ */

export interface ScoredHit {
  scope: "project" | "user";
  page: string;
  title: string;
  path: string;
  score: number;
  summary: string;
  snippets: string[];
  /** 该页是否包含推断内容（渲染时提示模型降低权重）。 */
  hasInference: boolean;
  /** 页面最后修改时间（近因加权用）。 */
  mtimeMs: number;
}

const SKIP_FILES = new Set(["INDEX.md", "index.md", "log.md", "AGENTS.md"]);
const RECENT_BOOST_DAYS = 30;

/** 从页面正文提取 `## 摘要` 的第一行非空文本。 */
export function extractPageSummary(text: string): string {
  const m = /^## (?:摘要|Summary)\s*\n+([\s\S]*?)(?=\n## |\n> |$)/m.exec(text);
  const first = (m?.[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("<!--"));
  return first ?? "";
}

function titleOf(text: string, fallback: string): string {
  return (/^#\s+(.+)$/m.exec(text)?.[1] ?? fallback).trim();
}

function snippetOf(text: string, terms: string[], maxLines = 2): string[] {
  const out: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i] ?? "";
    const lower = line.toLowerCase();
    if (!terms.some((t) => lower.includes(t))) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    out.push(`L${i + 1}: ${trimmed.slice(0, 120)}`);
  }
  return out;
}

/**
 * 单词库打分检索。score = Σ词频 + 标题命中×3 + 近期加成；项目级额外 +1.5。
 * 只返回 score > 0 的页面，按 score 降序。
 */
export function searchScored(
  layout: WikiLayout,
  terms: string[],
  scope: "project" | "user" = "project",
  opts: { recentDays?: number } = {},
): ScoredHit[] {
  if (terms.length === 0) return [];
  let files: string[];
  try {
    files = readdirSync(layout.pagesDir).filter((f) => f.endsWith(".md") && !SKIP_FILES.has(f));
  } catch {
    return [];
  }

  const now = Date.now();
  const recentMs = (opts.recentDays ?? RECENT_BOOST_DAYS) * 24 * 3600 * 1000;
  const hits: ScoredHit[] = [];

  for (const f of files) {
    const path = join(layout.pagesDir, f);
    let text: string;
    let mtimeMs: number;
    try {
      text = readFileSync(path, "utf8");
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
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
    if (score === 0) continue;

    const title = titleOf(text, f.replace(/\.md$/, ""));
    const titleLower = title.toLowerCase();
    if (terms.some((t) => titleLower.includes(t))) score += 3;
    if (now - mtimeMs <= recentMs) score += 2;
    if (scope === "project") score += 1.5;

    hits.push({
      scope,
      page: f,
      title,
      path,
      score,
      summary: extractPageSummary(text),
      snippets: snippetOf(text, terms),
      hasInference: /（推断|\[推断\]/.test(text),
      mtimeMs,
    });
  }

  hits.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
  return hits;
}

/* ------------------------------------------------------------------ */
/* 双桶合并 + 预算渲染                                                  */
/* ------------------------------------------------------------------ */

export interface RecallResult {
  /** 渲染后的注入文本；null = 无命中，不注入。 */
  text: string | null;
  hits: ScoredHit[];
  terms: string[];
  tokens: number;
}

export interface RecallOptions {
  projectPages?: number;
  userPages?: number;
  maxTokens?: number;
  /** 只查项目级（-p 单次模式：避免把操作员个人记忆混进服务器脚本场景）。 */
  projectOnly?: boolean;
}

export function buildRecall(
  layouts: { project: WikiLayout | null; user: WikiLayout | null },
  input: string,
  opts: RecallOptions = {},
): RecallResult {
  const terms = extractTerms(input);
  if (terms.length === 0) return { text: null, hits: [], terms, tokens: 0 };

  const projectPages = opts.projectPages ?? 2;
  const userPages = opts.userPages ?? 1;
  const maxTokens = opts.maxTokens ?? 900;

  const projectHits = layouts.project ? searchScored(layouts.project, terms, "project") : [];
  const userHits =
    !opts.projectOnly && layouts.user ? searchScored(layouts.user, terms, "user") : [];

  const picked = [...projectHits.slice(0, projectPages), ...userHits.slice(0, userPages)];
  if (picked.length === 0) return { text: null, hits: [], terms, tokens: 0 };

  const render = (hits: ScoredHit[]): string => {
    const lines: string[] = [
      `${RECALL_MARKER}以下是从记忆库检索到的可能相关内容（先项目级、后用户级）。`,
      `与当前问题相关就引用页面路径；不相关请忽略，不要强行引用。`,
      "",
    ];
    for (const h of hits) {
      const tag = h.scope === "project" ? "[项目]" : "[用户]";
      lines.push(`${tag} [[${h.page.replace(/\.md$/, "")}]] ${h.path}`);
      if (h.summary) lines.push(`  摘要：${h.summary}`);
      for (const s of h.snippets) lines.push(`  ${s}`);
      if (h.hasInference) {
        lines.push(`  含推断内容：推断仅作背景，用户确认前不得当作硬性要求。`);
      }
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  };

  // 预算截断：从尾部（用户级）开始砍，保项目级优先
  let kept = picked.slice();
  let text = render(kept);
  const tokensOf = (t: string): number => estimateTokens([{ role: "system", content: t } as Message]);
  let tokens = tokensOf(text);
  while (tokens > maxTokens && kept.length > 1) {
    kept = kept.slice(0, -1);
    text = render(kept);
    tokens = tokensOf(text);
  }
  if (tokens > maxTokens) {
    // 单页也超预算：硬截断正文（保留头部信息）
    text = text.slice(0, Math.max(200, Math.floor(maxTokens * 1.6))) + "\n…（记忆召回已截断）";
    tokens = tokensOf(text);
  }

  return { text, hits: kept, terms, tokens };
}

/** 把 RecallResult 转成 RecallTrace（写审计/测试断言用）。 */
export function toTrace(r: RecallResult): RecallTrace {
  const hits: RecallTraceHit[] = r.hits.map((h) => ({
    scope: h.scope,
    page: h.page,
    score: Math.round(h.score * 100) / 100,
  }));
  return { terms: r.terms, hits, tokens: r.tokens, injected: r.text !== null };
}

/** 构造注入消息（临时 system，标记以 RECALL_MARKER 开头）。 */
export function recallMessage(text: string): Message {
  return { role: "system", content: text };
}
