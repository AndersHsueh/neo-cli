/**
 * #85：`.worktreeinclude` —— 新建托管 worktree 时，把主检出里「匹配且被 gitignore」的文件拷过去
 * （.env 之类没有就跑不起来的本地文件）。
 *
 * 口径（已签合同）：
 *  - 只读主仓根（detectRepo().mainRoot）上的 `.worktreeinclude`；没有该文件就什么都不拷；
 *  - 匹配用 git 自己的忽略判定：`.worktreeinclude` 命中 ∩ 标准 gitignore 命中，且未被跟踪；
 *    不承诺与 Claude Code `**\/` 整目录细则（2.1.239）完全一致；
 *  - 目标已有同名文件不覆盖（复用已有树时调用方干脆不调）；
 *  - 某个文件拷贝失败只记警告，不回滚已建好的 worktree、不中止进入；
 *  - `--safe-mode` 下照常拷贝：这只是拷文件，不算加载自定义项。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { defaultExec, type WorktreeDeps } from "./worktree.ts";

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

export interface WorktreeIncludeResult {
  /** 实际拷过去的相对路径（主仓根相对）。 */
  copied: string[];
  /** 每个失败文件一条（含路径与原因）。 */
  warnings: string[];
}

function lsFiles(args: string[], cwd: string, deps: WorktreeDeps): string[] {
  const r = (deps.exec ?? defaultExec)(["ls-files", "-z", "--others", "--ignored", ...args], cwd);
  if (r.code !== 0) return [];
  return r.stdout.split("\0").filter((p) => p !== "" && !p.endsWith("/"));
}

/**
 * 从 mainRoot 拷 `.worktreeinclude` 命中的被忽略文件到 dest。
 * `opts.copy` 供测试注入失败；缺省 copyFileSync。
 */
export function copyWorktreeInclude(
  mainRoot: string,
  dest: string,
  opts: { copy?: (src: string, dst: string) => void; deps?: WorktreeDeps } = {},
): WorktreeIncludeResult {
  const includeFile = join(mainRoot, WORKTREE_INCLUDE_FILE);
  const result: WorktreeIncludeResult = { copied: [], warnings: [] };
  if (!existsSync(includeFile)) return result;
  const deps = opts.deps ?? {};
  const matched = lsFiles([`--exclude-from=${includeFile}`], mainRoot, deps);
  if (matched.length === 0) return result;
  const ignored = new Set(lsFiles(["--exclude-standard"], mainRoot, deps));
  const copy = opts.copy ?? ((src: string, dst: string) => copyFileSync(src, dst));
  for (const rel of matched) {
    if (!ignored.has(rel)) continue;
    const target = join(dest, rel);
    if (existsSync(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      copy(join(mainRoot, rel), target);
      result.copied.push(rel);
    } catch (e) {
      result.warnings.push(`.worktreeinclude 拷贝失败（已跳过）：${rel}：${(e as Error).message}`);
    }
  }
  return result;
}
