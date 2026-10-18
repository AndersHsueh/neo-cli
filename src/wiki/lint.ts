/**
 * wiki lint —— 断链 / Orphan / 摘要 / 日期戳 / 链接密度检查。
 *
 * 由 skills/karpathy-wiki-lint/references/lint-scripts.sh 重写而来（方案见
 * wiki-turnning-1018.md 问题 4）：sh 版只能整脚本跑、断言靠 grep 输出；
 * TS 版导出纯函数，测试直接 import 各检查逻辑。
 *
 * 与 sh 版的行为对齐点：
 *  - 链接语法 [[目标]]，剥离 |别名、#锚点、.md 后缀；
 *  - 代码块（``` 围栏）与行内反引号内的链接不计；
 *  - 豁免文件不参与 orphan / 摘要 / 戳 / 密度检查：INDEX.md / index.md / log.md
 *    / 工作流-ingest-query-lint.md（最后一个是旧技能体系的工作流页名，保留豁免
 *    以兼容存量库，新库不会创建该页）；
 *  - 断链允许集额外含 INDEX / index / log / AGENTS 四个固定页名；
 *  - 自链（[[自己]]）不计入入边，即不解除 orphan；
 *  - 主题页 < 8 时 LOWLINKS 按约定忽略（页少链不满是物理事实，不是质量问题）；
 *  - 矛盾检查（日期时间线 / 数值 / 术语 / 实体 / 状态 / 版本）是 LLM 推理活，
 *    不在本模块范围，报告里保留提示。
 *
 * 目录布局：neo 项目内是 <cwd>/.neo/wiki/wiki/（主题页），独立知识库是 <cwd>/wiki/。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type LintIssueKind = "broken" | "orphan" | "lowlinks" | "nosummary" | "nostamp";

export interface LintIssue {
  kind: LintIssueKind;
  /** 页面 basename（含 .md）。broken 时是「被引用的目标页」。 */
  page: string;
  /** 补充信息：broken 带引用者列表，lowlinks 带实际/阈值链接数。 */
  detail?: string;
}

export interface LintSummary {
  broken: number;
  orphans: number;
  lowlinks: number;
  nosummary: number;
  nostamp: number;
}

export interface LintResult {
  wikiDir: string;
  /** 全部 .md 文件数（含豁免）。 */
  totalMdCount: number;
  /** 参与检查的主题页数（豁免后）。 */
  pageCount: number;
  issues: LintIssue[];
  summary: LintSummary;
  /** 主题页 < 8 触发的 LOWLINKS 忽略。 */
  lowlinksIgnored: boolean;
  /** 渲染时的提示行（小库忽略说明、矛盾检查提示等）。 */
  notes: string[];
}

export interface LintOptions {
  /** 链接密度阈值，默认 3。 */
  minLinks?: number;
}

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 豁免文件：不参与 orphan / 摘要 / 戳 / 密度检查（与 sh 版 EXEMPT_FILES 一致）。 */
const EXEMPT_FILES = new Set(["INDEX.md", "index.md", "log.md", "工作流-ingest-query-lint.md"]);

/** 断链允许集里的固定页名（与 sh 版一致）。 */
const ALWAYS_ALLOWED = new Set(["INDEX", "index", "log", "AGENTS"]);

const SUMMARY_RE = /^## (摘要|Summary)\s*$/m;
const DATE_STAMP_RE = /(最后更新|Last updated)(：|:)\s*\d{4}-\d{2}-\d{2}/;
/** 小库阈值：主题页少于此数时忽略 LOWLINKS。 */
const SMALL_LIB_THRESHOLD = 8;
const DEFAULT_MIN_LINKS = 3;

/* ------------------------------------------------------------------ */
/* 目录解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 解析 wiki 主题页目录。顺序：
 *  1. <cwd>/.neo/wiki/wiki/  —— neo 项目内布局（/init 创建）
 *  2. <cwd>/wiki/            —— 独立知识库布局（与 sh 版兼容）
 * 都不存在返回 null。
 */
export function resolveWikiDir(cwd: string): string | null {
  const candidates = [join(cwd, ".neo", "wiki", "wiki"), join(cwd, "wiki")];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 链接提取                                                            */
/* ------------------------------------------------------------------ */

export interface RawLink {
  /** 来源页 basename（含 .md）。 */
  src: string;
  /** 目标页名（已剥离别名/锚点/.md，未校验存在性）。 */
  target: string;
}

/**
 * 从 markdown 文本提取 [[链接]]。
 * 代码块（``` 围栏翻转状态）与行内反引号内的内容跳过。
 */
export function extractLinks(fileName: string, text: string): RawLink[] {
  const links: RawLink[] = [];
  let inCode = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    // 先剔除行内反引号片段，避免 [[...]] 出现在代码里被误计
    const cleaned = line.replace(/`[^`]*`/g, " ");
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const raw = m[1] ?? "";
      const target = normalizeTarget(raw);
      if (target !== "") links.push({ src: fileName, target });
    }
  }
  return links;
}

/** [[目标|别名]] / [[目标#锚点]] / [[目标.md]] → 纯页名，trim。含 `/` 的路径式目标返回空串（与 sh 版一致：不是页名）。 */
function normalizeTarget(raw: string): string {
  let t = raw.split("|")[0] ?? "";
  t = t.split("#")[0] ?? "";
  t = t.trim();
  t = t.replace(/\.md$/, "");
  if (t.includes("/")) return ""; // [[../AGENTS]] 这类路径式链接不是 wiki 页引用
  return t;
}

/* ------------------------------------------------------------------ */
/* 主检查                                                              */
/* ------------------------------------------------------------------ */

export function lintWiki(wikiDir: string, opts: LintOptions = {}): LintResult {
  const minLinks = Math.max(0, Math.floor(opts.minLinks ?? DEFAULT_MIN_LINKS));
  const notes: string[] = [];

  const mdFiles = existsSync(wikiDir)
    ? readdirSync(wikiDir).filter((f) => f.endsWith(".md")).sort()
    : [];
  const contents = new Map<string, string>();
  for (const f of mdFiles) {
    try {
      contents.set(f, readFileSync(join(wikiDir, f), "utf8"));
    } catch {
      contents.set(f, "");
    }
  }

  // 主题页 = 非豁免文件
  const pages = mdFiles.filter((f) => !EXEMPT_FILES.has(f));
  const pageNames = new Set(pages.map((f) => f.replace(/\.md$/, "")));
  const allowed = new Set([...pageNames, ...ALWAYS_ALLOWED]);

  // 全库链接（含豁免文件发出的——INDEX 的出链是真实的图边）
  const allLinks: RawLink[] = [];
  for (const f of mdFiles) {
    allLinks.push(...extractLinks(f, contents.get(f) ?? ""));
  }

  const issues: LintIssue[] = [];

  // ---- 1. 断链：目标不在（页面名 ∪ 固定允许名）----
  const brokenRefs = new Map<string, Set<string>>();
  for (const l of allLinks) {
    if (allowed.has(l.target)) continue;
    if (!brokenRefs.has(l.target)) brokenRefs.set(l.target, new Set());
    brokenRefs.get(l.target)?.add(l.src);
  }
  for (const [target, srcs] of brokenRefs) {
    issues.push({ kind: "broken", page: target, detail: [...srcs].sort().join(", ") });
  }

  // ---- 2. Orphan：无入边（自链不算）----
  const inbound = new Set<string>();
  for (const l of allLinks) {
    const srcName = l.src.replace(/\.md$/, "");
    if (srcName !== l.target) inbound.add(l.target);
  }
  for (const f of pages) {
    const name = f.replace(/\.md$/, "");
    if (!inbound.has(name)) issues.push({ kind: "orphan", page: f });
  }

  // ---- 3. 摘要 / 日期戳 / 链接密度 ----
  const lowlinksIgnored = pages.length < SMALL_LIB_THRESHOLD;
  if (lowlinksIgnored) {
    notes.push(`主题页 ${pages.length} < ${SMALL_LIB_THRESHOLD}，LOWLINKS 按约定忽略（页少链不满是物理事实）`);
  }
  // 出链计数：按来源页 basename（含 .md）计，与 sh 版口径一致
  const outDegree = new Map<string, number>();
  for (const l of allLinks) {
    outDegree.set(l.src, (outDegree.get(l.src) ?? 0) + 1);
  }
  for (const f of pages) {
    const text = contents.get(f) ?? "";
    if (!SUMMARY_RE.test(text)) issues.push({ kind: "nosummary", page: f });
    if (!DATE_STAMP_RE.test(text)) issues.push({ kind: "nostamp", page: f });
    if (!lowlinksIgnored) {
      const n = outDegree.get(f) ?? 0;
      if (n < minLinks) {
        issues.push({ kind: "lowlinks", page: f, detail: `${n} < ${minLinks}` });
      }
    }
  }

  const count = (k: LintIssueKind): number => issues.filter((i) => i.kind === k).length;
  const summary: LintSummary = {
    broken: count("broken"),
    orphans: count("orphan"),
    lowlinks: count("lowlinks"),
    nosummary: count("nosummary"),
    nostamp: count("nostamp"),
  };

  notes.push("矛盾检查（日期时间线/数值/术语/实体/状态/版本）由 LLM 推理完成，不在 lint 范围");

  return {
    wikiDir,
    totalMdCount: mdFiles.length,
    pageCount: pages.length,
    issues,
    summary,
    lowlinksIgnored,
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

/** 渲染人类可读报告（/wiki-lint 输出）。 */
export function formatLintReport(r: LintResult): string {
  const lines: string[] = [];
  lines.push(`WIKI_DIR: ${r.wikiDir}`);
  lines.push(`页面数: ${r.totalMdCount}（主题页 ${r.pageCount}）`);
  lines.push("");
  if (r.totalMdCount === 0) {
    lines.push("⚠️  wiki/ 下没有 .md 文件，跳过全部检查。");
  }
  for (const i of r.issues) {
    switch (i.kind) {
      case "broken":
        lines.push(`BROKEN: ${i.page}（被引用于: ${i.detail ?? "?"}）`);
        break;
      case "orphan":
        lines.push(`ORPHAN: ${i.page}`);
        break;
      case "lowlinks":
        lines.push(`LOWLINKS: ${i.page}（${i.detail ?? "?"}）`);
        break;
      case "nosummary":
        lines.push(`NOSUMMARY: ${i.page}`);
        break;
      case "nostamp":
        lines.push(`NOSTAMP: ${i.page}`);
        break;
    }
  }
  if (r.issues.length === 0 && r.totalMdCount > 0) {
    lines.push("✅ 全部检查通过");
  }
  lines.push("");
  for (const n of r.notes) lines.push(`· ${n}`);
  const s = r.summary;
  lines.push(
    `SUMMARY: broken=${s.broken} orphans=${s.orphans} lowlinks=${s.lowlinks} ` +
      `nosummary=${s.nosummary} nostamp=${s.nostamp}`,
  );
  return lines.join("\n");
}
