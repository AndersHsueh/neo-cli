/**
 * input/fileIndex.ts — `@` 补全的文件索引（v0.2.4 C1）。
 *
 * 两条来源，git 优先：
 *  1. `git ls-files -z --cached --others --exclude-standard`：尊重 `.gitignore`、
 *     一次进程开销换全量清单，比递归扫盘快且不会把 node_modules 拖进来；
 *  2. 非 git 仓库 / 无 git / 空仓库 → 有界 FS 遍历（跳过重目录，深度与条数封顶）。
 *
 * 索引带 TTL 缓存（默认 5s）：Tab 连按不会反复扫盘；新建文件后 5s 内可见，
 * 也可以用 `invalidate()` 立即失效。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RunOutput {
  ok: boolean;
  stdout: string;
}

export interface FileIndexOptions {
  cwd: string;
  /** 文件数上限（默认 20000，防超大仓库撑爆候选）。 */
  limit?: number;
  /** 缓存有效期（默认 5000ms）：只在过期后触发后台刷新，不阻塞按键。 */
  ttlMs?: number;
  /** 时间源（测试注入）。 */
  now?: () => number;
  /** 同步执行 git（测试注入用；生产走 runAsync）。 */
  run?: (args: string[], cwd: string) => RunOutput;
  /** 异步执行 git；默认 Bun.spawn（不阻塞事件循环）。 */
  runAsync?: (args: string[], cwd: string) => Promise<RunOutput>;
  /** FS 回退（测试注入）；默认 walkFiles。 */
  walk?: (cwd: string, limit: number) => string[];
}

export const DEFAULT_FILE_LIMIT = 20_000;
export const DEFAULT_INDEX_TTL_MS = 5_000;

/** 回退遍历时整体跳过的目录名。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".cache",
  ".venv",
  "venv",
  "target",
  "coverage",
  ".next",
  ".turbo",
  ".worktrees",
]);

const MAX_WALK_DEPTH = 12;

/** 默认同步 git 调用（仅测试/兜底用）：失败返回 ok=false，由调用方回退。 */
export function defaultRun(args: string[], cwd: string): RunOutput {
  try {
    const res = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "ignore" });
    const stdout = new TextDecoder().decode(res.stdout ?? new Uint8Array());
    return { ok: res.exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * 默认异步 git 调用（生产路径）。
 * 为什么必须异步：`git ls-files` 在 2 万文件仓库实测 75ms，同步会卡住 Tab 按键
 * （simplify 效率审查的 critical）。异步后按键路径只剩缓存读取（~1µs）。
 */
export async function defaultRunAsync(args: string[], cwd: string): Promise<RunOutput> {
  try {
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "ignore" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * git 清单（NUL 分隔，路径含空格不会裂）。返回 null 表示「git 路径不可用」，
 * 包括失败与空输出两种情况 —— 空输出在非空仓库里没有意义，回退更安全。
 */
export function listFromGit(
  cwd: string,
  limit: number,
  run: (args: string[], cwd: string) => RunOutput = defaultRun,
): string[] | null {
  const out = run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd);
  if (!out.ok) return null;
  return splitGitOutput(out.stdout, limit);
}

function splitGitOutput(stdout: string, limit: number): string[] | null {
  const files = stdout.split("\0").filter((f) => f !== "");
  if (files.length === 0) return null;
  return files.slice(0, limit);
}

/** 异步版 listFromGit（生产路径）。 */
export async function listFromGitAsync(
  cwd: string,
  limit: number,
  runAsync: (args: string[], cwd: string) => Promise<RunOutput> = defaultRunAsync,
): Promise<string[] | null> {
  const out = await runAsync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd);
  if (!out.ok) return null;
  return splitGitOutput(out.stdout, limit);
}

/**
 * 目录判定（含软链）：与 skills/tools 的判定语义一致，但在本文件内联 ——
 * 索引层是叶子模块，不该反向依赖 skills.ts（会拖慢单测、也易制造循环依赖）。
 */
function isDirEntry(full: string, isDir: boolean, isSymlink: boolean): boolean {
  if (isDir) return true;
  if (!isSymlink) return false;
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

/** 有界 FS 遍历（BFS，目录名与深度都封顶）。 */
export function walkFiles(root: string, limit: number): string[] {
  const out: string[] = [];
  const queue: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: "", depth: 0 }];
  while (queue.length > 0 && out.length < limit) {
    const cur = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue; // 权限不足等：跳过该目录，不中断整个索引
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= limit) break;
      const childRel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
      const full = join(cur.dir, e.name);
      if (isDirEntry(full, e.isDirectory(), e.isSymbolicLink())) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name) || cur.depth >= MAX_WALK_DEPTH) continue;
        queue.push({ dir: full, rel: childRel, depth: cur.depth + 1 });
      } else {
        // 文件与软链文件都收（git 路径也会列出软链，两条来源保持一致）
        out.push(childRel);
      }
    }
  }
  return out;
}

/** 文件索引：懒加载 + TTL 缓存。 */
export class FileIndex {
  private files: string[] | null = null;
  private loadedAt = -Infinity;
  private readonly limit: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly walk: (cwd: string, limit: number) => string[];
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: FileIndexOptions) {
    this.limit = Math.max(1, opts.limit ?? DEFAULT_FILE_LIMIT);
    this.ttlMs = Math.max(0, opts.ttlMs ?? DEFAULT_INDEX_TTL_MS);
    this.now = opts.now ?? Date.now;
    this.walk = opts.walk ?? walkFiles;
  }

  /**
   * 读缓存（**永不同步扫盘**）。缓存为空或过期时返回现有值并 kick 一次后台刷新；
   * 首次调用可能是空数组，下一次 Tab 就有内容 —— 按键路径不允许付 75ms 的代价。
   */
  list(): string[] {
    const stale = this.files === null || this.now() - this.loadedAt >= this.ttlMs;
    if (stale) void this.refresh();
    return this.files ?? [];
  }

  /** 后台刷新（in-flight 去重，可 await；测试与启动预热都用它）。 */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    let files: string[] | null = null;
    if (this.opts.run) {
      files = listFromGit(this.opts.cwd, this.limit, this.opts.run);
    } else if (this.opts.runAsync) {
      files = await listFromGitAsync(this.opts.cwd, this.limit, this.opts.runAsync);
    } else {
      files = await listFromGitAsync(this.opts.cwd, this.limit);
    }
    this.files = files ?? this.walk(this.opts.cwd, this.limit);
    this.loadedAt = this.now();
  }

  /** 让缓存立即失效（新建文件后调用；下一次 list 会 kick 刷新）。 */
  invalidate(): void {
    this.files = null;
    this.loadedAt = -Infinity;
    void this.refresh();
  }

  /** 当前缓存的条目数（未加载时为 0）。 */
  get size(): number {
    return this.files?.length ?? 0;
  }
}
