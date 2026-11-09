/**
 * 仓库地图（issue #15）—— 给系统提示词注入一份**受预算限制的符号地图**。
 *
 * 目标：大仓里让模型先看见「哪个文件定义了什么」，少烧几轮 glob/grep 找入口。
 * 做法是最小版（不引 tree-sitter 依赖）：按语言用行首正则抽导出/定义符号，
 * 按路径排序，累计到 token 预算就截断 —— 宁可少给几行，也不能把上下文灌爆。
 *
 * 纪律：
 *  - **预算硬上限**：`budget_tokens × 4` 字符封顶，超了截断并在末尾标注；
 *  - **扫描有上限**：最多 `max_files` 个源文件，跳过依赖/构建目录与超大文件；
 *  - **结果缓存**：同一进程同一 cwd 缓存 20 秒（每次提示词渲染都走一遍文件系统太贵）；
 *  - **失败静默**：读不到/解析失败就当没有地图（增强项，不得阻塞启动）。
 */
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { extname, join, relative, sep } from "node:path";

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

let cache: { key: string; at: number; map: RepoMap } | null = null;

/** 测试用：清掉缓存。 */
export function resetRepoMapCache(): void {
  cache = null;
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
  if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS) return cache.map;

  try {
    const sources = collectSources(cfg.cwd, conf.maxFiles);
    const lines: string[] = [];
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
    cache = { key, at: now, map };
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
