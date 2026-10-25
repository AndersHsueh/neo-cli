/**
 * 检索用文件枚举（P0-5）。
 *
 * 背景：grep/glob 旧实现手写 readdir 递归，只跳过 dotfile 与字面量
 * node_modules/.git —— 不守 .gitignore、看不见隐藏文件、在 dist/build/
 * 生成物上白扫，命中预算被噪声吃光。
 *
 * 本模块统一提供「符合 gitignore 语义」的文件清单：
 *  1. 在 git 工作区内：`git ls-files --cached --others --exclude-standard`
 *     （tracked + untracked、排除 ignored；隐藏文件天然包含）；
 *  2. 非 git 目录：JS 遍历 + 最小 .gitignore 匹配器（支持 !、尾 /、前导 /、**）；
 *  3. 匹配仍由调用方用 JS 正则完成（不切 git grep，避免 POSIX ERE 方言差异）。
 *
 * 不依赖 ripgrep：本机未安装 rg，git 是更稳的最小公共底座。
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

export interface ListedFile {
  /** 相对搜索根的路径，统一用 "/" 分隔。 */
  rel: string;
  /** 绝对路径（拼接时已用 resolve，可直接读）。 */
  full: string;
}

export interface ListResult {
  files: ListedFile[];
  backend: "git" | "walk";
  /** 枚举是否因 maxFiles 截断（只影响完整性提示，不影响匹配语义）。 */
  truncated: boolean;
}

/** 单次检索枚举的文件数上限：防止极端仓库把内存与时间打爆。 */
export const MAX_LIST_FILES = 20_000;

/** fallback 遍历的深度上限（防软链环）。 */
const MAX_WALK_DEPTH = 20;

/** 非 git 目录的兜底跳过：这些目录没有 ignore 文件时也不该扫。 */
const FALLBACK_SKIP_DIRS = new Set([".git", "node_modules"]);

async function gitList(root: string, maxFiles: number): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(
      ["git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return stdout.split("\0").filter((f) => f !== "").slice(0, maxFiles);
  } catch {
    return null;
  }
}

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

const REGEX_SPECIAL = /[.+^${}()|\\]/g;

/** 把 gitignore 的 glob 段转成正则主体（不含首尾锚点）。 */
function wildcardBody(pat: string): string {
  let out = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i] ?? "";
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        if (pat[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const end = pat.indexOf("]", i);
      if (end !== -1) {
        out += pat.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    out += ch.replace(REGEX_SPECIAL, "\\$&");
  }
  return out;
}

/**
 * 解析一份 .gitignore。baseRel 是该文件所在目录相对搜索根的路径，
 * 用于把「含斜杠/前导斜杠」的模式锚定到正确层级。
 */
export function parseGitignore(text: string, baseRel = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const prefix = baseRel ? `${baseRel.replace(REGEX_SPECIAL, "\\$&")}/` : "";
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;

    const body = wildcardBody(line);
    const hasSlash = line.includes("/");
    let re: RegExp;
    if (anchored || hasSlash) {
      // 相对 .gitignore 所在目录锚定
      re = new RegExp(`^${prefix}${body}${dirOnly ? "$" : "(?:/.*)?$"}`);
    } else {
      // 无斜杠：任意层级匹配名字
      re = new RegExp(`(?:^|/)${body}${dirOnly ? "$" : "(?:/.*)?$"}`);
    }
    rules.push({ re, negate, dirOnly });
  }
  return rules;
}

function loadGitignore(dir: string, baseRel: string): IgnoreRule[] {
  const file = join(dir, ".gitignore");
  if (!existsSync(file)) return [];
  try {
    return parseGitignore(readFileSync(file, "utf8"), baseRel);
  } catch {
    return [];
  }
}

function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) ignored = !r.negate;
  }
  return ignored;
}

function isDirEntry(full: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

function walkList(root: string, maxFiles: number): ListResult {
  const files: ListedFile[] = [];
  let truncated = false;
  const stack: Array<{ dir: string; rel: string; depth: number; rules: IgnoreRule[] }> = [
    { dir: root, rel: "", depth: 0, rules: [] },
  ];

  while (stack.length > 0) {
    const cur = stack.pop() as { dir: string; rel: string; depth: number; rules: IgnoreRule[] };
    const localRules = [...cur.rules, ...loadGitignore(cur.dir, cur.rel)];
    let entries: Dirent[];
    try {
      entries = readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (e.name === ".git") continue;
      const full = join(cur.dir, e.name);
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const dir = isDirEntry(full, e);
      if (isIgnored(localRules, rel, dir)) continue;
      if (dir) {
        if (FALLBACK_SKIP_DIRS.has(e.name) || cur.depth >= MAX_WALK_DEPTH) continue;
        stack.push({ dir: full, rel, depth: cur.depth + 1, rules: localRules });
      } else {
        files.push({ rel, full });
      }
    }
  }
  return { files, backend: "walk", truncated };
}

/**
 * git 只把软链本身当条目列出，不会列软链目标里的文件。
 * 但本项目的 skills/<name> 就是软链（全局技能库懒加载产物），
 * glob/grep 必须能穿过去 —— 否则「skills/foo/SKILL.md」在 git 仓库里会消失。
 * 这里对 git 清单做一次软链展开：目录软链递归、文件软链保留。
 */
function expandGitEntries(root: string, rels: string[], maxFiles: number): ListedFile[] {
  const out: ListedFile[] = [];
  const seen = new Set<string>();
  const push = (rel: string, full: string): void => {
    if (seen.has(rel) || out.length >= maxFiles) return;
    seen.add(rel);
    out.push({ rel, full });
  };
  const walkDir = (dirAbs: string, relBase: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || out.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name === ".git") continue;
      const full = join(dirAbs, e.name);
      const rel = `${relBase}/${e.name}`;
      if (isDirEntry(full, e)) walkDir(full, rel, depth + 1);
      else push(rel, full);
    }
  };

  for (const rel of rels) {
    const full = join(root, rel);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) {
      push(rel, full);
      continue;
    }
    let target;
    try {
      target = statSync(full);
    } catch {
      continue;
    }
    if (target.isDirectory()) walkDir(full, rel, 0);
    else push(rel, full);
  }
  return out;
}

/**
 * 枚举搜索根下的文件（gitignore 语义优先）。
 *
 * git 调用失败（不在仓库里 / 没装 git）或输出为空时回退到 JS 遍历 ——
 * 空仓库里两者的结果都是空，回退不会引入噪声。
 */
export async function listSearchFiles(
  root: string,
  maxFiles: number = MAX_LIST_FILES,
): Promise<ListResult> {
  const fromGit = await gitList(root, maxFiles);
  if (fromGit !== null && fromGit.length > 0) {
    const files = expandGitEntries(root, fromGit, maxFiles);
    return { files, backend: "git", truncated: fromGit.length >= maxFiles || files.length >= maxFiles };
  }
  return walkList(root, maxFiles);
}
