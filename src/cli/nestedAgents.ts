/**
 * issue #54：按目录选取 AGENTS.md / CLAUDE.md，并按需注入嵌套指令。
 *
 * - 启动 / `/cd`：cwd 根文件 +（若在 git 工作树内）向上到工作树根的祖先文件，写入永久项目记忆段。
 * - 子目录文件不预载：本轮触达路径时再以临时 system 消息注入，轮末摘除（与 #17 同生命周期）。
 * - `roots` 预留多工作根（#63 可把额外根传进来）；本单只接线当前会话 cwd。
 */
import { realpathSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "NEO.md", ".neo.md", "CLAUDE.md"] as const;

export const NESTED_AGENTS_MAX_BODY_CHARS = 4_000;
export const NESTED_AGENTS_MAX_TOTAL_CHARS = 12_000;

export interface InstructionFile {
  path: string;
  dir: string;
  name: string;
  text: string;
}

export interface PermanentMemory {
  path: string;
  text: string;
  files: InstructionFile[];
}

function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function samePath(a: string, b: string): boolean {
  return tryRealpath(a) === tryRealpath(b);
}

/** `path` 是 `root` 本身或其子孙。 */
function isInside(root: string, path: string): boolean {
  const r = tryRealpath(root);
  const p = resolve(path);
  const pReal = tryRealpath(p);
  return pReal === r || pReal.startsWith(r + sep) || p === r || p.startsWith(r + sep);
}

function truncateBody(body: string, max: number): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}…（截断）`;
}

function capText(sections: string[], max: number): string {
  const joined = sections.join("");
  if (joined.length <= max) return joined;
  return `${joined.slice(0, max)}…（截断）`;
}

/** 某一目录上按优先级取第一个存在的普通文件。同目录多个名字不拼接。 */
export function pickInstructionFile(dir: string): InstructionFile | null {
  const base = resolve(dir);
  for (const name of INSTRUCTION_FILE_NAMES) {
    const p = join(base, name);
    try {
      if (!statSync(p).isFile()) continue;
      return { path: p, dir: base, name, text: readFileSync(p, "utf8") };
    } catch {
      /* 不存在 / 不可读：试下一个 */
    }
  }
  return null;
}

/**
 * 从 start 向上找工作树根（含 `.git` 目录或 worktree 的 `.git` 文件）。
 * 找不到则返回 null，不把 `/` 或 `$HOME` 当成根。
 */
export function findGitWorkTreeRoot(start: string): string | null {
  let cur = resolve(start);
  try {
    const st = statSync(cur);
    if (!st.isDirectory()) cur = dirname(cur);
  } catch {
    cur = dirname(cur);
  }
  cur = tryRealpath(cur);
  for (;;) {
    try {
      const st = statSync(join(cur, ".git"));
      if (st.isDirectory() || st.isFile()) return cur;
    } catch {
      /* 这一层没有 .git */
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * 从 cwd 的父目录向上到 git 工作树根（含根、不含 cwd）收集指令文件。
 * 无 git 仓时返回空数组。顺序：工作树根更通用的在前。
 */
export function collectAncestorInstructionFiles(
  cwd: string,
  opts?: { gitRoot?: string | null },
): InstructionFile[] {
  const start = tryRealpath(resolve(cwd));
  const gitRoot = opts && "gitRoot" in opts ? opts.gitRoot : findGitWorkTreeRoot(start);
  if (!gitRoot) return [];
  const gitAbs = tryRealpath(resolve(gitRoot));
  if (!isInside(gitAbs, start)) return [];
  if (samePath(start, gitAbs)) return [];

  const chain: string[] = [];
  let cur = dirname(start);
  for (;;) {
    chain.push(cur);
    if (samePath(cur, gitAbs)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    if (!isInside(gitAbs, parent)) break;
    cur = parent;
  }
  chain.reverse();
  const out: InstructionFile[] = [];
  for (const dir of chain) {
    const file = pickInstructionFile(dir);
    if (file) out.push(file);
  }
  return out;
}

/** 永久项目记忆段：cwd 根文件 + git 祖先。不含 cwd 子目录。无文件则 null。 */
export function composePermanentMemory(cwd: string): PermanentMemory | null {
  const cwdFile = pickInstructionFile(cwd);
  const ancestors = collectAncestorInstructionFiles(cwd);
  const files = [...(cwdFile ? [cwdFile] : []), ...ancestors];
  if (files.length === 0) return null;
  const parts: string[] = [];
  if (cwdFile) parts.push(cwdFile.text);
  if (ancestors.length > 0) {
    const sections = ancestors.map((f) => `### ${f.path}\n${f.text}`).join("\n\n");
    parts.push(`## 上级项目指令（git 工作树根到当前目录之间）\n\n${sections}`);
  }
  return {
    path: cwdFile?.path ?? ancestors[0]!.path,
    text: parts.join("\n\n"),
    files,
  };
}

/** safe-mode 下根 / 祖先 / 嵌套全部不加载。 */
export function loadSessionInstructionMemory(
  cwd: string,
  opts: { safeMode?: boolean } = {},
): PermanentMemory | null {
  if (opts.safeMode) return null;
  return composePermanentMemory(cwd);
}

function startDirForTouched(abs: string): string {
  try {
    if (statSync(abs).isDirectory()) return tryRealpath(abs);
  } catch {
    /* 文件尚不存在（write/edit 创建）按其父目录走 */
  }
  return dirname(resolve(abs));
}

/** 从 start 向上走到但不含 root。start 若等于 root 则空。 */
function walkUpExclusive(start: string, root: string): string[] {
  const rootAbs = tryRealpath(resolve(root));
  let cur = resolve(start);
  if (!isInside(rootAbs, cur) && !samePath(cur, rootAbs)) return [];
  const out: string[] = [];
  while (!samePath(cur, rootAbs)) {
    if (!isInside(rootAbs, cur)) break;
    out.push(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

function locateTouchedUnderRoots(
  raw: string,
  roots: string[],
): { abs: string; root: string } | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (isAbsolute(trimmed)) {
    const abs = resolve(trimmed);
    const root = roots.find((r) => isInside(r, abs));
    return root ? { abs, root } : null;
  }
  const posix = trimmed.replace(/\\/g, "/");
  for (const root of roots) {
    const abs = resolve(root, posix);
    if (isInside(root, abs)) return { abs, root };
  }
  return null;
}

function depthFromRoot(dir: string, root: string): number {
  const rel = relative(tryRealpath(root), tryRealpath(dir));
  if (rel === "") return 0;
  return rel.split(/[\\/]/).filter(Boolean).length;
}

/**
 * 本轮触达路径对应的嵌套指令文件：从触达路径所在目录向上到但不含所属工作根。
 * `exclude` 用于去掉已在永久段的 cwd / 祖先文件。
 */
export function collectNestedInstructionFiles(opts: {
  roots: string[];
  touched: string[];
  exclude?: Iterable<string>;
}): InstructionFile[] {
  const roots = opts.roots.map((r) => tryRealpath(resolve(r)));
  const excluded = new Set<string>();
  for (const p of opts.exclude ?? []) {
    excluded.add(resolve(p));
    excluded.add(tryRealpath(p));
  }
  const byPath = new Map<string, InstructionFile>();
  for (const raw of opts.touched) {
    const located = locateTouchedUnderRoots(raw, roots);
    if (!located) continue;
    const startDir = startDirForTouched(located.abs);
    for (const dir of walkUpExclusive(startDir, located.root)) {
      const file = pickInstructionFile(dir);
      if (!file) continue;
      if (excluded.has(file.path) || excluded.has(resolve(file.path))) continue;
      if (!byPath.has(file.path)) byPath.set(file.path, file);
    }
  }
  return [...byPath.values()].sort((a, b) => {
    const da = depthFromRoot(a.dir, roots[0] ?? a.dir);
    const db = depthFromRoot(b.dir, roots[0] ?? b.dir);
    if (da !== db) return da - db;
    return a.path.localeCompare(b.path);
  });
}

/** 临时 system 消息正文。空输入返回 ""。标题与 #17「路径作用域规则」区分。 */
export function formatNestedAgentsBlock(files: InstructionFile[]): string {
  if (files.length === 0) return "";
  const sections = files.map((f) => `\n### ${f.path}\n${truncateBody(f.text, NESTED_AGENTS_MAX_BODY_CHARS)}\n`);
  return `## 嵌套项目指令（仅因本轮触达子目录而加载）\n${capText(sections, NESTED_AGENTS_MAX_TOTAL_CHARS)}`;
}

/** `/context` 报告：只列路径名，不附大段正文。 */
export function nestedAgentsReport(files: ReadonlyArray<{ path: string; text?: string; dir?: string; name?: string }>): string[] {
  if (files.length === 0) return ["本轮未加载嵌套指令文件"];
  const lines = [`本轮已加载 ${files.length} 个嵌套指令文件`];
  for (const f of files) lines.push(`  ${f.path}`);
  return lines;
}
