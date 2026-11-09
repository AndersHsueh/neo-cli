/**
 * rules/index.ts — 路径作用域项目规则（issue #17）。
 *
 * 目标：整仓 `AGENTS.md` 之外，再提供**按路径 glob 条件加载**的规则目录，
 * 解决 monorepo / 前后端同仓时「目录专属约定要么每轮付 token、要么漏掉」的两难。
 *
 * 数据流（三段，全部纯函数可单测）：
 *  1. 发现：`discoverProjectRules(cwd)` → `.neo/rules/**` + `.claude/rules/**` 的 `*.md`；
 *  2. 匹配：`selectScopedRules(rules, touched)` → 只挑带 `paths` 且命中的；
 *  3. 渲染：`formatAlwaysOnRules`（进系统提示词）/ `formatScopedRulesBlock`（临时 system 消息）。
 *
 * 纪律：
 *  - 无规则时**零额外上下文**：所有格式化函数空输入返回 ""；
 *  - 不猜路径：只认工具参数里明确带路径的键，不解析 shell 命令文本；
 *  - 预算硬上限：单条 + 总量都截断并标注，规则不能把上下文顶掉；
 *  - 本模块只读文件系统与纯计算，不写任何东西。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/** 规则目录（相对 cwd）。`.neo/rules` 主、`.claude/rules` 兼容 Claude Code 迁移。 */
export const RULE_DIRS = [".neo/rules", ".claude/rules"] as const;

/** 单条规则的正文上限（字符）。 */
export const RULE_MAX_BODY_CHARS = 4_000;
/** 每会话规则总长上限（与 AGENTS.md 分开计量）。 */
export const RULE_MAX_ALWAYS_ON_CHARS = 16_000;
/** 一轮 scoped 规则总长上限。 */
export const RULE_MAX_SCOPED_CHARS = 12_000;

export interface ProjectRule {
  /** 绝对路径（排障用）。 */
  file: string;
  /** 相对 cwd 的 POSIX 路径（展示 / 去重 / 排序键）。 */
  relPath: string;
  /** 展示名：frontmatter 的 `title`，缺省用文件名去扩展名。 */
  name: string;
  /** glob 列表；空数组 = 每会话加载。 */
  paths: string[];
  body: string;
}

export interface RuleMatch {
  rule: ProjectRule;
  /** 命中原因（`pattern ← path`），按发现顺序去重。 */
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** 把 frontmatter 里 `paths` / `globs` / `title` 的几种常见写法都认下来。 */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { meta: {}, body: normalized.replace(/\s+$/, "") };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: normalized.replace(/\s+$/, "") };
  const head = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "").replace(/\s+$/, "");

  const meta: Record<string, string> = {};
  let currentListKey: string | null = null;
  for (const rawLine of head.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentListKey) {
      meta[currentListKey] = `${meta[currentListKey] ? `${meta[currentListKey]},` : ""}${unquote(item[1] ?? "")}`;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      currentListKey = null;
      continue;
    }
    const key = (kv[1] ?? "").toLowerCase();
    const value = (kv[2] ?? "").trim();
    if (value === "") {
      currentListKey = key;
      meta[key] = meta[key] ?? "";
      continue;
    }
    currentListKey = null;
    meta[key] = value;
  }
  return { meta, body };
}

/** 把一个值/列表写法的字段拆成数组（去掉行内方括号与引号）。 */
function splitList(value: string | undefined): string[] {
  if (!value) return [];
  let v = value.trim();
  if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1);
  return v
    .split(",")
    .map((x) => unquote(x))
    .filter((x) => x !== "");
}

/** 解析单个规则文件。frontmatter 未闭合时整段当正文（不猜）。 */
export function parseRuleFile(
  raw: string,
  opts: { file: string; relPath: string },
): ProjectRule {
  const { meta, body } = parseFrontmatter(raw);
  const paths = [...splitList(meta["paths"]), ...splitList(meta["globs"])];
  const title = unquote(meta["title"] ?? "");
  const name = title !== "" ? title : basename(opts.relPath).replace(/\.md$/i, "");
  return { file: opts.file, relPath: opts.relPath, name, paths, body };
}

/* ------------------------------------------------------------------ */
/* 路径与 glob                                                         */
/* ------------------------------------------------------------------ */

/** 绝对/相对路径 → 相对 cwd 的 POSIX 路径；cwd 外返回 null。 */
export function normalizeRelPath(cwd: string, p: string): string | null {
  const cleaned = p.trim().replace(/\\/g, "/");
  if (cleaned === "") return null;
  const abs = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  if (rel === "" || rel === ".") return ".";
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
  return rel;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * glob → 正则。支持的语法写死在测试里：`**`（跨层，含 0 层）、`*`（段内）、`?`、
 * `{a,b}` 交替、尾部 `/`（目录前缀）。
 */
function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end !== -1) {
        const parts = glob
          .slice(i + 1, end)
          .split(",")
          .map((x) => escapeRegExp(x.trim()));
        out += `(?:${parts.join("|")})`;
        i = end + 1;
        continue;
      }
    }
    out += escapeRegExp(c);
    i += 1;
  }
  return new RegExp(`${out}$`);
}

/**
 * 规则 glob 是否命中某个相对路径。
 * 不含 `/` 的模式按 **basename** 匹配任意层级（`*.md` 命中 `docs/x.md`）。
 */
export function matchRuleGlob(pattern: string, relPath: string): boolean {
  let pat = pattern.trim().replace(/\\/g, "/");
  if (pat === "") return false;
  if (pat.endsWith("/")) pat = `${pat}**`;
  const target = relPath.replace(/\\/g, "/");
  const re = globToRegExp(pat);
  return pat.includes("/") ? re.test(target) : re.test(basename(target));
}

/* ------------------------------------------------------------------ */
/* 发现                                                                */
/* ------------------------------------------------------------------ */

function walkRules(root: string, relDir: string, out: Array<{ abs: string; rel: string }>): void {
  let entries: string[];
  try {
    entries = readdirSync(join(root, relDir));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const rel = `${relDir}/${entry}`;
    let isDir = false;
    try {
      isDir = statSync(join(root, rel)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walkRules(root, rel, out);
    else if (/\.md$/i.test(entry)) out.push({ abs: join(root, rel), rel });
  }
}

/**
 * 发现规则文件（按 relPath 字典序，结果确定）。
 * 目录不存在 = 没有规则，不抛错、不告警。
 */
export function discoverProjectRules(cwd: string): ProjectRule[] {
  const found: Array<{ abs: string; rel: string }> = [];
  for (const dir of RULE_DIRS) walkRules(cwd, dir, found);
  found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const rules: ProjectRule[] = [];
  for (const item of found) {
    try {
      rules.push(parseRuleFile(readFileSync(item.abs, "utf8"), { file: item.abs, relPath: item.rel }));
    } catch {
      /* 单个文件读不了就跳过，规则是增强项 */
    }
  }
  return rules;
}

/* ------------------------------------------------------------------ */
/* 命中选择                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从「本会话已触达路径」里挑出命中的 scoped 规则。
 * `cwd` 给了就把触达路径按 cwd 归一（绝对路径也能匹配）；不给视为已经是相对路径。
 */
export function selectScopedRules(
  rules: ProjectRule[],
  touched: string[],
  opts: { cwd?: string } = {},
): RuleMatch[] {
  const paths: string[] = [];
  for (const raw of touched) {
    const rel = opts.cwd ? normalizeRelPath(opts.cwd, raw) : raw.trim().replace(/\\/g, "/");
    if (rel !== null && rel !== "") paths.push(rel);
  }
  const out: RuleMatch[] = [];
  for (const rule of rules) {
    if (rule.paths.length === 0) continue;
    const reasons: string[] = [];
    for (const pattern of rule.paths) {
      for (const p of paths) {
        if (!matchRuleGlob(pattern, p)) continue;
        const reason = `${pattern} ← ${p}`;
        if (!reasons.includes(reason)) reasons.push(reason);
      }
    }
    if (reasons.length > 0) out.push({ rule, reasons });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function truncateBody(body: string): string {
  if (body.length <= RULE_MAX_BODY_CHARS) return body;
  return `${body.slice(0, RULE_MAX_BODY_CHARS)}…（截断）`;
}

function capText(sections: string[], maxChars: number): string {
  const text = sections.join("");
  if (text.length <= maxChars) return text;
  let out = "";
  for (const section of sections) {
    if (out.length + section.length > maxChars) break;
    out += section;
  }
  return `${out}\n…（规则总量超过预算，其余已截断）\n`;
}

/** 每会话规则块：拼进系统提示词的项目记忆段。空输入返回 ""。 */
export function formatAlwaysOnRules(rules: ProjectRule[]): string {
  const always = rules.filter((r) => r.paths.length === 0);
  if (always.length === 0) return "";
  const sections = always.map(
    (r) => `\n### ${r.name}（${r.relPath}）\n${truncateBody(r.body)}\n`,
  );
  return `\n## 项目规则（每会话加载，来源 ${RULE_DIRS.join(" / ")}）\n${capText(sections, RULE_MAX_ALWAYS_ON_CHARS)}`;
}

/** scoped 规则块：作为本轮临时 system 消息。空输入返回 ""。 */
export function formatScopedRulesBlock(matches: RuleMatch[]): string {
  if (matches.length === 0) return "";
  const sections = matches.map(
    (m) =>
      `\n### ${m.rule.name}（${m.rule.relPath}）\n命中：${m.reasons.join("；")}\n${truncateBody(m.rule.body)}\n`,
  );
  return `## 路径作用域规则（仅因本轮触达匹配文件而加载）\n${capText(sections, RULE_MAX_SCOPED_CHARS)}`;
}

/* ------------------------------------------------------------------ */
/* 工具参数 → 触达路径                                                 */
/* ------------------------------------------------------------------ */

/** 明确带路径参数的工具 → 参数键。**不收录 shell**：从命令文本猜路径误命中代价更高。 */
const TOOL_PATH_KEYS: Record<string, string[]> = {
  read_file: ["path", "file_path"],
  write_file: ["path", "file_path"],
  edit_file: ["path", "file_path"],
  list_dir: ["path"],
  glob: ["path"],
  grep: ["path"],
};

/** 从一次工具调用里提取触达路径（已归一成 cwd 相对 POSIX；cwd 外丢弃）。 */
export function extractTouchedPaths(toolName: string, argsJson: string, cwd: string): string[] {
  const keys = TOOL_PATH_KEYS[toolName];
  if (!keys) return [];
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return [];
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const rec = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of keys) {
    const value = rec[key];
    if (typeof value !== "string" || value.trim() === "") continue;
    const rel = normalizeRelPath(cwd, value);
    if (rel !== null && rel !== "." && !out.includes(rel)) out.push(rel);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* /context 报告                                                       */
/* ------------------------------------------------------------------ */

/**
 * `/context` 的两行报告：条数 + 命中原因（每条规则最多列 3 个原因）。
 * 一条规则都没有时给一行「未发现」，避免 /context 里出现空节。
 */
export function rulesReport(alwaysOn: ProjectRule[], loaded: RuleMatch[], total: number): string[] {
  if (total === 0) return ["未发现路径作用域规则（.neo/rules 或 .claude/rules）"];
  const lines = [`每会话 ${alwaysOn.length} 条 · 路径作用域 ${loaded.length} 条已加载（共 ${total} 条）`];
  for (const m of loaded) {
    const reasons = m.reasons.slice(0, 3).join("；");
    const more = m.reasons.length > 3 ? `；…另 ${m.reasons.length - 3} 处` : "";
    lines.push(`  ${m.rule.name}：${reasons}${more}`);
  }
  return lines;
}
