/**
 * issue #54：按目录选取 AGENTS.md / CLAUDE.md，并按需注入嵌套指令。
 *
 * - 启动 / `/cd`：cwd 根文件 +（若在 git 工作树内）向上到工作树根的祖先文件，写入永久项目记忆段。
 * - 子目录文件不预载：本轮触达路径时再以临时 system 消息注入，轮末摘除（与 #17 同生命周期）。
 * - `roots` 是会话有序工作根列表（主根在前，#63 额外根按加入顺序在后）；
 *   每个额外根按与主根相同的算法各算永久段，触达路径归入最具体（路径最长）的根。
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

/** 单个工作根的永久文件：根文件 + 该根自己的 git 祖先。 */
function rootPermanentFiles(root: string): { rootFile: InstructionFile | null; ancestors: InstructionFile[] } {
  return { rootFile: pickInstructionFile(root), ancestors: collectAncestorInstructionFiles(root) };
}

/**
 * 永久项目记忆段：cwd 根文件 + git 祖先。不含 cwd 子目录。无文件则 null。
 * #63：`extraRoots` 每个额外根各算一遍（根文件 + 该根自己的 git 祖先），按文件 realpath
 * 去重后合并进同一永久段；已在主根段里的文件不重复出现。
 */
export function composePermanentMemory(cwd: string, extraRoots: readonly string[] = []): PermanentMemory | null {
  const { rootFile: cwdFile, ancestors } = rootPermanentFiles(cwd);
  const seen = new Set<string>();
  const keep = (f: InstructionFile): boolean => {
    const key = tryRealpath(f.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const mainFiles = [...(cwdFile ? [cwdFile] : []), ...ancestors].filter(keep);
  const parts: string[] = [];
  if (cwdFile && mainFiles.includes(cwdFile)) parts.push(cwdFile.text);
  const mainAncestors = ancestors.filter((f) => mainFiles.includes(f));
  if (mainAncestors.length > 0) {
    const sections = mainAncestors.map((f) => `### ${f.path}\n${f.text}`).join("\n\n");
    parts.push(`## 上级项目指令（git 工作树根到当前目录之间）\n\n${sections}`);
  }
  const files = [...mainFiles];
  for (const root of extraRoots) {
    const { rootFile, ancestors: up } = rootPermanentFiles(root);
    const picked = [...up, ...(rootFile ? [rootFile] : [])].filter(keep);
    if (picked.length === 0) continue;
    files.push(...picked);
    const sections = picked.map((f) => `### ${f.path}\n${f.text}`).join("\n\n");
    parts.push(`## 额外工作根指令（${root}：根文件与其 git 工作树内的祖先）\n\n${sections}`);
  }
  if (files.length === 0) return null;
  return {
    path: cwdFile?.path ?? files[0]!.path,
    text: parts.join("\n\n"),
    files,
  };
}

/** safe-mode 下根 / 祖先 / 嵌套全部不加载（含 #63 额外根）。 */
export function loadSessionInstructionMemory(
  cwd: string,
  opts: { safeMode?: boolean; extraRoots?: readonly string[] } = {},
): PermanentMemory | null {
  if (opts.safeMode) return null;
  return composePermanentMemory(cwd, opts.extraRoots ?? []);
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

/**
 * 触达路径归入**最具体**的工作根（realpath 最长者优先），不是 roots 里先命中的那个：
 * 祖先根（例如 monorepo 根）不能截走主根下的嵌套指令。相对路径相对主根（roots[0]）。
 */
function locateTouchedUnderRoots(
  raw: string,
  roots: string[],
): { abs: string; root: string } | null {
  const trimmed = raw.trim();
  if (trimmed === "" || roots.length === 0) return null;
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(roots[0]!, trimmed.replace(/\\/g, "/"));
  let best: string | null = null;
  for (const r of roots) {
    if (!isInside(r, abs)) continue;
    if (best === null || tryRealpath(r).length > tryRealpath(best).length) best = r;
  }
  return best ? { abs, root: best } : null;
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
  const rootOf = new Map<string, string>();
  for (const raw of opts.touched) {
    const located = locateTouchedUnderRoots(raw, roots);
    if (!located) continue;
    const startDir = startDirForTouched(located.abs);
    for (const dir of walkUpExclusive(startDir, located.root)) {
      const file = pickInstructionFile(dir);
      if (!file) continue;
      if (excluded.has(file.path) || excluded.has(resolve(file.path))) continue;
      if (!byPath.has(file.path)) {
        byPath.set(file.path, file);
        rootOf.set(file.path, located.root);
      }
    }
  }
  // 深度按各自所属工作根算，不只看 roots[0]。
  return [...byPath.values()].sort((a, b) => {
    const da = depthFromRoot(a.dir, rootOf.get(a.path) ?? a.dir);
    const db = depthFromRoot(b.dir, rootOf.get(b.path) ?? b.dir);
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
