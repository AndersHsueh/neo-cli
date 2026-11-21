/**
 * #85：子代理隔离（task `isolation: "worktree"` / 命名子代理 frontmatter `isolation: worktree`）。
 *
 * 口径（已签合同）：
 *  - 取值只能是 "worktree"；未知值拒绝派出，不降级成不隔离；
 *  - 不在 git 仓里拒绝派出；
 *  - **只新建、不复用**：目录或分支 neo/<name> 任一已存在就加后缀（createFreshWorktree），
 *    不走 #9 ensureWorktree 的复用路径；起点名 = 任务序号（sg-N / bg-N）；
 *  - 新树从主检出当前 HEAD 分出；新建后按 `.worktreeinclude` 拷文件；
 *  - 正常结束且树干净（与 #9 isDirty 同口径，被 gitignore 的不算脏）→ removeWorktree（分支保留）；
 *    否则保留并在报告里写明名字与路径；
 *  - 运行中登记在本进程表里：`/worktree remove` 拒绝删它（--force 同样不放行）。
 */
import { copyWorktreeInclude } from "./worktreeInclude.ts";
import { canonicalize, createFreshWorktree, detectRepo, isDirty, removeWorktree } from "./worktree.ts";

export type SubagentIsolation = "worktree";

export const SUBAGENT_ISOLATION_VALUES: readonly SubagentIsolation[] = ["worktree"];

/** 校验 isolation 取值：缺省/空 → undefined；"worktree" → "worktree"；其它 → 错误文案。 */
export function normalizeIsolation(raw: unknown): { ok: true; value?: SubagentIsolation } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true };
  if (raw === "worktree") return { ok: true, value: "worktree" };
  return {
    ok: false,
    error: `未知的 isolation 值 "${String(raw)}"：只支持 isolation: worktree（拒绝派出，不降级为不隔离）`,
  };
}

/** isolation=worktree 的派出前检查：必须在 git 仓里。返回 null = 可派出。 */
export function isolationPrecheck(cwd: string): string | null {
  const repo = detectRepo(cwd);
  if (!repo.ok) return `isolation: worktree 需要在 git 仓库里派出（不降级为不隔离）。${repo.message}`;
  return null;
}

export interface SubagentWorktree {
  ok: true;
  name: string;
  path: string;
  branch: string;
  mainRoot: string;
  warnings: string[];
}

const running = new Set<string>();

/** 某个路径是不是本进程里正在跑的隔离子代理的检出。 */
export function isRunningIsolatedWorktree(path: string): boolean {
  return running.has(canonicalize(path));
}

/** 只新建、不复用；成功即登记为运行中（finishSubagentWorktree 解除）。 */
export function createSubagentWorktree(cwd: string, baseName: string): SubagentWorktree | { ok: false; error: string } {
  const repo = detectRepo(cwd);
  if (!repo.ok) return { ok: false, error: repo.message };
  const made = createFreshWorktree(repo.mainRoot, baseName);
  if (!made.ok) return { ok: false, error: made.message };
  const inc = copyWorktreeInclude(repo.mainRoot, made.path);
  running.add(canonicalize(made.path));
  return { ok: true, name: made.name, path: made.path, branch: made.branch, mainRoot: repo.mainRoot, warnings: inc.warnings };
}

/**
 * 子代理结束：解除运行登记；正常结束且干净则删树（分支保留），否则保留。
 * 返回要追加到报告末尾的说明（删掉了就返回 null）。
 */
export function finishSubagentWorktree(wt: SubagentWorktree, completed: boolean): string | null {
  running.delete(canonicalize(wt.path));
  if (completed && !isDirty(wt.path)) {
    const rm = removeWorktree(wt.mainRoot, wt.name, { force: false });
    if (rm.ok) return null;
  }
  return (
    `— 隔离 worktree 已保留：${wt.name}（${wt.path}，分支 ${wt.branch}）` +
    `${completed ? "有未提交改动" : "子代理未正常结束"}；查看用 /worktree list，清理用 /worktree remove ${wt.name}`
  );
}
