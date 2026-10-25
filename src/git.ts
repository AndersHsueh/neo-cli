/**
 * git.ts — 只读的仓库信息（v0.3.0，从 index.ts 的 main 闭包里抽出来）。
 *
 * 状态条只关心「当前分支」；会话中途切分支不在本版范围，所以按 cwd 缓存一次。
 * spawn 可注入：单测用真临时仓库，不依赖当前工作目录。
 */
export interface GitDeps {
  /** 执行 git 命令并返回 stdout；失败返回 null。 */
  exec?: (args: string[], cwd: string) => string | null;
}

function defaultExec(args: string[], cwd: string): string | null {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch {
    return null;
  }
}

const cache = new Map<string, string | null>();

/**
 * 当前分支名；非 git 仓库 / detached HEAD / git 不可用时返回 null。
 * 同一 cwd 只 spawn 一次（状态条每帧调用，不能每次都起进程）。
 */
export function getBranch(cwd: string, deps: GitDeps = {}): string | null {
  if (cache.has(cwd)) return cache.get(cwd) ?? null;
  const exec = deps.exec ?? defaultExec;
  const out = exec(["rev-parse", "--abbrev-ref", "HEAD"], cwd)?.trim() ?? "";
  const branch = out !== "" && out !== "HEAD" ? out : null;
  cache.set(cwd, branch);
  return branch;
}

/** 清缓存（测试用；生产不需要）。 */
export function resetBranchCache(): void {
  cache.clear();
}
