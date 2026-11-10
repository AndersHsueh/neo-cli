/**
 * 仓库地图（issue #15 / #49）—— 给系统提示词注入一份**受预算限制的符号地图**。
 *
 * 目标：大仓里让模型先看见「哪个文件定义了什么」，少烧几轮 glob/grep 找入口。
 * 做法（不引 tree-sitter / LSP，纯文本解析）：按语言用行首正则抽导出/定义符号，
 * 再用 import/require 构建「文件 → 被引用次数」图，**按引用度排序**，
 * 累计到 token 预算就截断 —— 宁可少给几行，也不能把上下文灌爆。
 *
 * 纪律：
 *  - **预算硬上限**：`budget_tokens × 4` 字符封顶，超了截断并在末尾标注；
 *  - **引用度只用于排序**：正文里不出现「被引用 N 次」这类元数据（#49）；
 *  - **扫描有上限**：最多 `max_files` 个源文件，跳过依赖/构建目录与超大文件；
 *  - **结果缓存**：同一进程同一 cwd 缓存 20 秒，且**目录 mtime / 文件数变化即失效**（#49）；
 *  - **失败静默**：读不到/解析失败就当没有地图（增强项，不得阻塞启动）。
 */
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, extname, join, posix, relative, sep } from "node:path";

import { DEFAULT_REPO_MAP, type Config, type RepoMapConfig } from "../config.ts";

export interface RepoMapStats {
  /** 实际扫描的源文件数。 */
  files: number;
  /** 收进地图的符号数。 */
  symbols: number;
  /** 地图正文字符数。 */
  chars: number;
  /** 是否因预算截断。 */
  truncated: boolean;
  /** 是否真的生成了地图（关闭/空仓库时为 false）。 */
  enabled: boolean;
}

export interface RepoMap {
  text: string;
  stats: RepoMapStats;
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  ".cache",
  ".turbo",
  ".neo",
  ".claude",
]);

const SOURCE_LANG: Record<string, Lang> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "py",
  ".go": "go",
  ".rs": "rust",
};

type Lang = "ts" | "py" | "go" | "rust";

/** 单文件符号上限：防止一个巨型 index 文件把预算吃光。 */
const MAX_SYMBOLS_PER_FILE = 10;
/** 单文件大小上限：超过就不解析（生成物/数据文件没有地图价值）。 */
const MAX_FILE_BYTES = 300_000;
/** 缓存时长。 */
const CACHE_TTL_MS = 20_000;

/** 从源码文本里抽「关键符号」（导出/顶层定义），按出现顺序去重。 */
export function extractSymbols(text: string, lang: Lang): string[] {
  const patterns: Record<Lang, RegExp[]> = {
    ts: [
      /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s*\{([^}]*)\}/gm,
    ],
    py: [
      /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
      /^class\s+([A-Za-z_]\w*)/gm,
    ],
    go: [
      /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
      /^type\s+([A-Za-z_]\w*)/gm,
    ],
    rust: [
      /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|union)\s+([A-Za-z_]\w*)/gm,
    ],
  };
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string): void => {
    const n = name.trim();
    if (n === "" || seen.has(n) || out.length >= MAX_SYMBOLS_PER_FILE) return;
    seen.add(n);
    out.push(n);
  };
  for (const re of patterns[lang]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // `export { a, b as c }`：取导出名（as 前那个）
      const raw = (m[1] ?? "").trim();
      if (raw.includes(",") || raw.includes(" as ")) {
        for (const piece of raw.split(",")) {
          add(piece.trim().split(/\s+as\s+/)[0] ?? "");
        }
      } else {
        add(raw);
      }
      if (out.length >= MAX_SYMBOLS_PER_FILE) return out;
    }
  }
  return out;
}

interface SourceFile {
  rel: string;
  abs: string;
  lang: Lang;
}

/**
 * 从源码文本里抽 import 目标（issue #49）。
 *
 * 只做「够用」的纯文本解析：行注释/块注释先剥掉，再按语言取 import 语句里的模块串。
 * 返回的是**原始模块串**（如 `./a`、`react`、`crate::foo`），路径归一交给 resolveImportTarget。
 */
export function extractImports(text: string, lang: Lang): string[] {
  const src = stripComments(text, lang);
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    const s = (v ?? "").trim();
    if (s !== "") out.push(s);
  };
  if (lang === "ts") {
    // import ... from "x" / export ... from "x" / import "x" / require("x") / import("x")
    // 三个正则分别扫，最后按源码位置排序，保证输出顺序与书写顺序一致。
    const fromRe = /(?:^|[\s;])(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']/g;
    const bareRe = /(?:^|[\s;])import\s*["']([^"']+)["']/g;
    const callRe = /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
    const hits: Array<{ at: number; spec: string }> = [];
    for (const re of [fromRe, bareRe, callRe]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const spec = (m[1] ?? "").trim();
        if (spec !== "") hits.push({ at: m.index, spec });
      }
    }
    return hits.sort((a, b) => a.at - b.at).map((h) => h.spec);
  }
  if (lang === "py") {
    const importRe = /^[ \t]*import\s+([\w.]+(?:\s+as\s+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:\s+as\s+\w+)?)*)/gm;
    const fromRe = /^[ \t]*from\s+([\w.]+)\s+import\b/gm;
    let m: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((m = importRe.exec(src)) !== null) {
      for (const piece of (m[1] ?? "").split(",")) push(piece.trim().split(/\s+as\s+/)[0]);
    }
    fromRe.lastIndex = 0;
    while ((m = fromRe.exec(src)) !== null) push(m[1]);
    return out;
  }
  if (lang === "go") {
    // import "x" / import alias "x" / import ( ... )
    const singleRe = /^[ \t]*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
    const blockRe = /^[ \t]*import\s*\(([\s\S]*?)\)/gm;
    let m: RegExpExecArray | null;
    singleRe.lastIndex = 0;
    while ((m = singleRe.exec(src)) !== null) push(m[1]);
    blockRe.lastIndex = 0;
    while ((m = blockRe.exec(src)) !== null) {
      const inner = m[1] ?? "";
      const lineRe = /(?:^|\n)[ \t]*(?:[\w.]+\s+)?"([^"]+)"/g;
      let n: RegExpExecArray | null;
      while ((n = lineRe.exec(inner)) !== null) push(n[1]);
    }
    return out;
  }
  // rust：use a::b; / use a::{b, c}; / mod x; / pub mod x;
  const useRe = /^[ \t]*(?:pub\s+)?use\s+([^;]+);/gm;
  const modRe = /^[ \t]*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm;
  let m: RegExpExecArray | null;
  useRe.lastIndex = 0;
  while ((m = useRe.exec(src)) !== null) {
    // `use a::b as c` → 取 a::b；`use a::{b, c}` → 取前缀 a
    const path = (m[1] ?? "").trim().split(/\s+as\s+/)[0]?.trim() ?? "";
    const head = path.includes("::{") ? path.slice(0, path.indexOf("::{")) : path;
    push(head);
  }
  modRe.lastIndex = 0;
  while ((m = modRe.exec(src)) !== null) push(m[1]);
  return out;
}

/** 剥掉行注释与块注释（各语言共有的 // 与块注释、py 的 #），避免注释里的 import 被算进去。 */
function stripComments(text: string, lang: Lang): string {
  if (lang === "py") {
    // py 的 # 注释；字符串里的 # 会误伤，但地图只做启发式，接受这个误差。
    return text
      .split("\n")
      .map((line) => {
        const i = line.indexOf("#");
        return i === -1 ? line : line.slice(0, i);
      })
      .join("\n");
  }
  // ts / go / rust：先块注释再行注释
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * 把 import 串解析成仓库内的相对路径（issue #49）。解析不到（外部包/文件不存在）返回 null。
 *
 * - ts/js：相对路径按 from 文件所在目录解析，补扩展名或 `/index.*`；
 * - py：点号路径按包目录解析（`.` → 当前包 `__init__.py`，`.mod` → 同级 `mod.py`，`..parent` → 上一级）；
 * - go：按包路径尾段匹配目录（`example.com/x/internal/util` → `internal/util/*.go`）；
 * - rust：`crate::a::b` → `src/a/b.rs` 或 `src/a/b/mod.rs`。
 */
export function resolveImportTarget(fromRel: string, spec: string, files: Set<string>): string | null {
  const fromDir = posix.dirname(fromRel.split(sep).join("/"));
  const base = fromDir === "." ? "" : `${fromDir}/`;
  const candidates = (p: string): string[] => {
    // posix.normalize 会保留末尾斜杠（"pkg/" → "pkg/"），拼扩展名前必须去掉，
    // 否则会得到 "pkg//__init__.py" 这种永不命中的路径。
    const norm = posix.normalize(p).replace(/\/+$/, "");
    if (norm === "" || norm.startsWith("..")) return [];
    const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"];
    const out = [norm];
    for (const e of exts) out.push(`${norm}${e}`);
    for (const e of exts) out.push(`${norm}/index${e}`);
    // py 包：目录下的 __init__.py
    out.push(`${norm}/__init__.py`);
    return out;
  };
  const firstHit = (list: string[]): string | null => {
    for (const c of list) if (files.has(c)) return c;
    return null;
  };

  if (spec.startsWith(".")) {
    // 相对路径（ts/js 与 py 的点号路径共用前缀判断）
    if (spec.startsWith("./") || spec.startsWith("../")) {
      return firstHit(candidates(posix.normalize(`${base}${spec}`)));
    }
    // py 的点号：`.` / `..` / `.mod` / `..parent`
    // 点号数 - 1 = 上跳层数；`.` 表示当前包目录，`..` 表示上一级。
    let dots = 0;
    while (spec[dots] === ".") dots++;
    const rest = spec.slice(dots);
    const ups = Array<string>(Math.max(0, dots - 1)).fill("..");
    const dir = posix.normalize([base === "" ? "." : base, ...ups].join("/"));
    const target = rest === "" ? dir : posix.normalize(`${dir === "." ? "" : `${dir}/`}${rest.split(".").join("/")}`);
    return firstHit(candidates(target));
  }

  // 非相对：go 包路径 / rust crate 路径 / 其它（外部包）
  if (spec.includes("::")) {
    // rust：crate::a::b / self::a / super::a / std::...
    const parts = spec.split("::").filter((p) => p !== "");
    const head = parts[0];
    if (head === "std" || head === "core" || head === "alloc") return null;
    const restParts = head === "crate" ? parts.slice(1) : head === "self" ? parts.slice(1) : head === "super" ? parts.slice(1) : parts;
    const rel = `src/${restParts.join("/")}`;
    return firstHit([`${rel}.rs`, `${rel}/mod.rs`]);
  }
  // go：按目录尾段匹配
  const segs = spec.split("/").filter((s) => s !== "");
  for (let take = segs.length; take >= 1; take--) {
    const tail = segs.slice(segs.length - take).join("/");
    for (const f of files) {
      if (f === `${tail}.go` || f.startsWith(`${tail}/`)) return f;
    }
  }
  return null;
}

/**
 * 构建「文件 → 被多少个文件引用」图（issue #49）。
 *
 * - 自引用不计；同一文件多次 import 同一目标只算一次；
 * - 循环 import 天然安全：只做一次遍历，不做递归展开；
 * - 读不到/解析不出的 import 直接忽略（外部包）。
 */
export function buildRefGraph(cwd: string, rels: string[]): Map<string, number> {
  const files = new Set(rels);
  const refs = new Map<string, number>();
  for (const r of rels) refs.set(r, 0);
  for (const rel of rels) {
    const lang = SOURCE_LANG[extname(rel).toLowerCase()];
    if (!lang) continue;
    let text: string;
    try {
      const abs = join(cwd, rel.split("/").join(sep));
      if (statSync(abs).size > MAX_FILE_BYTES) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const spec of extractImports(text, lang)) {
      const target = resolveImportTarget(rel, spec, files);
      if (target === null || target === rel || seen.has(target)) continue;
      seen.add(target);
      refs.set(target, (refs.get(target) ?? 0) + 1);
    }
  }
  return refs;
}

/** 按被引用次数降序排序；同引用数保持输入顺序（稳定排序）。 */
export function sortSourcesByRefs<T>(items: T[], refs: Map<string, number>, keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => (refs.get(keyOf(b)) ?? 0) - (refs.get(keyOf(a)) ?? 0));
}

function collectSources(cwd: string, maxFiles: number): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string, relDir: string): void => {
    if (files.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
      const abs = join(dir, e.name);
      let rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      const lang = SOURCE_LANG[extname(e.name).toLowerCase()];
      if (!lang) continue;
      files.push({ rel: rel.split(sep).join("/"), abs, lang });
    }
  };
  walk(cwd, "");
  return files;
}

let cache: { key: string; stamp: string; at: number; map: RepoMap } | null = null;

/** 测试用：清掉缓存。 */
export function resetRepoMapCache(): void {
  cache = null;
}

/**
 * 目录状态指纹（issue #49）：廉价失效用。
 *
 * 只 stat 一层（cwd 与其下第一层目录）的 mtime + 文件数，不做全量遍历 ——
 * 目的是「改了文件/加了文件就失效」，不是精确内容哈希。
 */
function dirStamp(cwd: string): string {
  const parts: string[] = [];
  const visit = (dir: string, relDir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let files = 0;
    const subdirs: Array<{ abs: string; rel: string }> = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || IGNORE_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        subdirs.push({ abs: join(dir, e.name), rel: relDir === "" ? e.name : `${relDir}/${e.name}` });
      } else {
        files++;
      }
    }
    let mtime = 0;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      mtime = 0;
    }
    parts.push(`${relDir || "."}:${files}:${Math.floor(mtime)}`);
    if (depth > 0) for (const d of subdirs) visit(d.abs, d.rel, depth - 1);
  };
  visit(cwd, "", 2);
  return parts.join("|");
}

/**
 * 生成仓库地图。关闭 / 空仓库 / 任何 IO 异常 → 空图（text=""），调用方直接跳过注入。
 */
export function buildRepoMap(cfg: Pick<Config, "cwd" | "repoMap">): RepoMap {
  const conf: RepoMapConfig = cfg.repoMap ?? DEFAULT_REPO_MAP;
  const empty = (enabled: boolean): RepoMap => ({
    text: "",
    stats: { files: 0, symbols: 0, chars: 0, truncated: false, enabled },
  });
  if (!conf.enabled) return empty(false);

  const key = `${cfg.cwd}\u0000${conf.budgetTokens}\u0000${conf.maxFiles}`;
  const now = Date.now();
  // 目录状态变了就失效，不必等满 20s（issue #49）。
  const stamp = dirStamp(cfg.cwd);
  if (cache && cache.key === key && cache.stamp === stamp && now - cache.at < CACHE_TTL_MS) return cache.map;

  try {
    const collected = collectSources(cfg.cwd, conf.maxFiles);
    // issue #49：按「被多少个文件引用」排序，被引用多的先出现（预算不够时先保住入口文件）。
    const refs = buildRefGraph(
      cfg.cwd,
      collected.map((f) => f.rel),
    );
    const sources = sortSourcesByRefs(collected, refs, (f) => f.rel);    const lines: string[] = [];
    let chars = 0;
    let symbols = 0;
    let truncated = false;
    const limit = Math.max(200, conf.budgetTokens * 4);
    const header =
      "## 仓库地图（关键符号，预算内）\n以下为源码文件的主要导出/定义；需要细节再用 read_file/grep。\n";
    chars += header.length;
    for (const file of sources) {
      let text: string;
      try {
        const size = statSync(file.abs).size;
        if (size > MAX_FILE_BYTES) continue;
        text = readFileSync(file.abs, "utf8");
      } catch {
        continue;
      }
      const names = extractSymbols(text, file.lang);
      if (names.length === 0) continue;
      let line = `${file.rel}: ${names.join(", ")}`;
      // 单行也不许超过剩余预算：超了就截断该行并停止。
      if (chars + line.length + 1 > limit) {
        const room = Math.max(0, limit - chars - 1);
        if (room >= Math.min(40, line.length)) {
          line = `${line.slice(0, room - 1)}…`;
        } else {
          truncated = true;
          break;
        }
        lines.push(line);
        chars += line.length + 1;
        symbols += names.length;
        truncated = true;
        break;
      }
      lines.push(line);
      chars += line.length + 1;
      symbols += names.length;
    }
    if (lines.length === 0) return empty(true);
    const text = `${header}${lines.join("\n")}`;
    const truncatedLine = truncated ? "\n（地图已按预算截断；用 glob/grep 找其余符号）" : "";
    const map: RepoMap = {
      text: `${text}${truncatedLine}`,
      stats: {
        files: sources.length,
        symbols,
        chars: chars + truncatedLine.length,
        truncated,
        enabled: true,
      },
    };
    cache = { key, stamp, at: now, map };
    return map;
  } catch {
    return empty(true);
  }
}

/** `/context` 用的一行摘要（不触发重复扫描：命中缓存）。 */
export function repoMapSummary(cfg: Pick<Config, "cwd" | "repoMap">): string {
  const { stats } = buildRepoMap(cfg);
  if (!stats.enabled) return "已关闭";
  if (stats.chars === 0) return "未生成（没有可提取的源文件符号）";
  return `${stats.files} 文件 / ${stats.symbols} 符号 · 约 ${Math.round(stats.chars / 4)} tokens（预算 ${cfg.repoMap.budgetTokens}）${
    stats.truncated ? " · 已截断" : ""
  }`;
}
