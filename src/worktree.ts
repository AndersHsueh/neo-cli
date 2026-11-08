/**
 * worktree.ts — 托管 git worktree（issue #9 最小片）。
 *
 * 定位：worktree 是**文件级隔离**，让并行会话各占一份检出、互不踩工作区；
 * 它**不是**安全沙箱、不是权限边界 —— 权限仍由 /mode 与审批闸门负责。
 *
 * 托管口径（本模块只认这一种）：
 *  - 位置：<主仓库根>/.neo/worktrees/<name>
 *  - 分支：neo/<name>（已存在则复用，不重建、不覆盖）
 *  - 只碰 .neo/worktrees/ 下由 neo 建的这些；用户自己的其它 worktree 一概不列、不删。
 *
 * 为什么不用 `git worktree list --porcelain` 判断「托管」：
 * 手工 `git worktree add .neo/worktrees/x` 也能落进同一路径，但分支不一定是 neo/x。
 * 这里用「路径在托管目录内 + 分支等于 neo/<name>」双条件，宁可漏认也不误删。
 *
 * 所有 git 调用走注入的 exec（默认 spawnSync），单测用真临时仓库，不 mock。
 */
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 托管目录（相对主仓库根）。 */
export const WORKTREE_DIR = ".neo/worktrees";
/** 托管分支前缀。 */
export const WORKTREE_BRANCH_PREFIX = "neo/";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeDeps {
  /** 执行 git 命令。测试可注入；默认 spawnSync。 */
  exec?: (args: string[], cwd: string) => GitResult;
}

function defaultExec(args: string[], cwd: string): GitResult {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return {
      code: p.exitCode ?? 1,
      stdout: p.stdout?.toString() ?? "",
      stderr: p.stderr?.toString() ?? "",
    };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
}

function git(deps: WorktreeDeps, args: string[], cwd: string): GitResult {
  return (deps.exec ?? defaultExec)(args, cwd);
}

/* ------------------------------------------------------------------ */
/* 名字与路径                                                          */
/* ------------------------------------------------------------------ */

/**
 * 名字合法性：只允许 [A-Za-z0-9._-]，不以 . / - 开头，长度 1..64。
 *
 * 刻意收得比 git 分支名窄：名字会直接变成目录名与分支名的一部分，
 * 放行 `..`、空格、`~`、`:` 之类会引出路径穿越或 git ref 语法歧义。
 */
export function isValidWorktreeName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  if (name.startsWith(".") || name.startsWith("-")) return false;
  if (name === "." || name === "..") return false;
  return true;
}

/** 名字 → 分支名。 */
export function worktreeBranch(name: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${name}`;
}

/** 名字 → 托管目录绝对路径。 */
export function worktreePath(repoRoot: string, name: string): string {
  return join(repoRoot, WORKTREE_DIR, name);
}

/** 托管目录绝对路径（不保证存在）。 */
export function worktreeRoot(repoRoot: string): string {
  return join(repoRoot, WORKTREE_DIR);
}

/* ------------------------------------------------------------------ */
/* 仓库探测                                                            */
/* ------------------------------------------------------------------ */

export interface RepoInfo {
  ok: true;
  /** 主仓库工作树根（--show-toplevel；在 worktree 里调用时是该 worktree 自己的根）。 */
  root: string;
  /** 共享的 git 目录（--git-common-dir 的绝对路径）。 */
  commonDir: string;
  /** 主仓库根：托管目录与分支都挂在它下面，不从 worktree 里再套一层。 */
  mainRoot: string;
}

export interface RepoError {
  ok: false;
  message: string;
}

/**
 * 探测 cwd 所在的 git 仓库。
 *
 * mainRoot 的算法：commonDir 通常是 `<主仓库根>/.git`，去掉末段 `.git` 即主仓库根。
 * 这样在某个托管 worktree 里再跑 `--worktree` 不会在它下面再建一层 .neo/worktrees。
 * 裸仓库（commonDir 不以 .git 结尾）退回 toplevel。
 */
export function detectRepo(cwd: string, deps: WorktreeDeps = {}): RepoInfo | RepoError {
  const top = git(deps, ["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0 || top.stdout.trim() === "") {
    return {
      ok: false,
      message:
        `当前目录不是 git 仓库：${cwd}\n` +
        `  --worktree / /worktree 需要在一个 git 仓库里使用（先 git init，或 -C 指到仓库内）。`,
    };
  }
  const root = top.stdout.trim();
  const common = git(deps, ["rev-parse", "--git-common-dir"], cwd);
  const commonRaw = common.code === 0 ? common.stdout.trim() : "";
  const commonDir = commonRaw === "" ? join(root, ".git") : resolve(root, commonRaw);
  const base = commonDir.split(sep).pop() ?? "";
  const rawMainRoot = base === ".git" ? commonDir.slice(0, -(base.length + 1)) || sep : root;
  // issue #26：mainRoot 走 canonical 口径。git 报的是 realpath（macOS 上
  // /var/... → /private/var/...），而调用方手上的 repo 常是原始路径；
  // 源侧返回 canonical，测试侧按 canonical 比较，两边才同时成立。
  const mainRoot = canonicalize(rawMainRoot);
  return { ok: true, root, commonDir, mainRoot };
}

/* ------------------------------------------------------------------ */
/* 脏检测                                                              */
/* ------------------------------------------------------------------ */

/**
 * 工作区是否脏：有已跟踪改动（含暂存）或有未跟踪文件都算脏。
 * 用 `status --porcelain` 一次拿全 —— 只看 `diff` 会漏掉未跟踪文件，
 * 而「未跟踪文件」恰恰是最容易被 remove 吞掉的东西。
 */
export function isDirty(dir: string, deps: WorktreeDeps = {}): boolean {
  const r = git(deps, ["status", "--porcelain"], dir);
  if (r.code !== 0) return true; // 读不出状态 = 不可判定，按脏处理（宁可不删）
  return r.stdout.trim() !== "";
}

/* ------------------------------------------------------------------ */
/* 创建 / 复用                                                         */
/* ------------------------------------------------------------------ */

export interface EnsureOk {
  ok: true;
  /** 工作树绝对路径（会话 cwd）。 */
  path: string;
  branch: string;
  /** true = 本次新建；false = 复用已有。 */
  created: boolean;
  repoRoot: string;
}

export interface EnsureErr {
  ok: false;
  message: string;
}

/**
 * 创建或复用托管 worktree。
 *
 * 复用条件：托管路径已登记在本仓库的 worktree 列表里，且分支等于 neo/<name>。
 * 路径被占但不是托管 worktree（用户自己的目录/别人的 worktree）→ 报错，绝不覆盖。
 *
 * 失败路径不留半成品：git 失败时若托管目录已被创建（或已登记），尽力回滚
 * （remove --force + 删目录 + 删本次新建的分支），然后把原始错误报回去。
 */
export function ensureWorktree(
  repoRoot: string,
  name: string,
  deps: WorktreeDeps = {},
): EnsureOk | EnsureErr {
  if (!isValidWorktreeName(name)) {
    return {
      ok: false,
      message:
        `worktree 名字非法："${name}"\n` +
        `  只允许字母/数字/._-，不以 . 或 - 开头，长度 1..64（例：feat-a、fix_9）。`,
    };
  }
  const path = worktreePath(repoRoot, name);
  const branch = worktreeBranch(name);

  // 已登记：路径与分支都对上才算复用；分支不对说明有人手工占了同名目录，报错。
  // issue #26：路径比对走 canonical 口径 —— 调用方给的可能是原始路径
  // （macOS 上 /var/...），git 登记的是 realpath（/private/var/...），
  // 直接字符串相等会误判成「没登记」并报「不是 neo 托管的 worktree」。
  const listed = listManaged(repoRoot, deps);
  const target = canonicalize(path);
  const existing = listed.find((w) => canonicalize(w.path) === target);
  if (existing) {
    if (existing.branch !== branch) {
      return {
        ok: false,
        message:
          `托管目录 ${path} 已被占用，但分支是 ${existing.branch ?? "(detached)"} 而不是 ${branch}。\n` +
          `  先 /worktree remove ${name} 或换个名字。`,
      };
    }
    return { ok: true, path, branch, created: false, repoRoot };
  }

  // 目录在但没登记：不是 neo 管的，不能动。
  if (existsSync(path)) {
    return {
      ok: false,
      message:
        `路径 ${path} 已存在，但它不是 neo 托管的 worktree（未登记在 git worktree list 里）。\n` +
        `  为免误删，neo 不会覆盖它；请换个名字，或自行清理该目录。`,
    };
  }

  // 分支已存在（例如上次 remove 后残留、或用户自己建过）：直接挂上去，不重建。
  const branchExists =
    git(deps, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).code === 0;

  mkdirSync(worktreeRoot(repoRoot), { recursive: true });
  const addArgs = branchExists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path];
  const add = git(deps, addArgs, repoRoot);
  if (add.code !== 0) {
    // 回滚：git 可能已经建了目录/登记了 worktree。
    rollback(repoRoot, path, branch, { removeBranch: !branchExists, deps });
    const detail = (add.stderr || add.stdout).trim().split("\n").slice(0, 3).join("\n  ");
    return {
      ok: false,
      message: `创建 worktree 失败（git worktree add 退出码 ${add.code}）：\n  ${detail}`,
    };
  }
  return { ok: true, path, branch, created: true, repoRoot };
}

/** 失败回滚：尽力把本次可能留下的目录/登记/分支清掉。永不抛错。 */
function rollback(
  repoRoot: string,
  path: string,
  branch: string,
  opts: { removeBranch: boolean; deps: WorktreeDeps },
): void {
  try {
    git(opts.deps, ["worktree", "remove", "--force", path], repoRoot);
  } catch {
    /* 未登记时这条必然失败，忽略 */
  }
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch {
    /* 删不掉就留着，至少不掩盖原始错误 */
  }
  if (opts.removeBranch) {
    try {
      git(opts.deps, ["branch", "-D", branch], repoRoot);
    } catch {
      /* 分支没建成时忽略 */
    }
  }
  try {
    git(opts.deps, ["worktree", "prune"], repoRoot);
  } catch {
    /* prune 失败不影响错误上报 */
  }
}

/* ------------------------------------------------------------------ */
/* 列表                                                                */
/* ------------------------------------------------------------------ */

export interface ManagedWorktree {
  name: string;
  path: string;
  /** 分支名（去 refs/heads/）；detached 时为 null。 */
  branch: string | null;
  /** 有已跟踪改动或未跟踪文件。 */
  dirty: boolean;
  /** 是否当前会话所在（cwd 等于该 worktree 根，或位于其内部任意深度子目录）。 */
  current: boolean;
}

/** 解析 `git worktree list --porcelain` 的输出。 */
export function parseWorktreeList(out: string): Array<{ path: string; branch: string | null }> {
  const items: Array<{ path: string; branch: string | null }> = [];
  let path: string | null = null;
  let branch: string | null = null;
  const flush = (): void => {
    if (path !== null) items.push({ path, branch });
    path = null;
    branch = null;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      branch = ref.replace(/^refs\/heads\//, "");
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return items;
}

/** 路径归一：软链（/tmp → /private/tmp、/var → /private/var）下比较要一致。 */
export function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * 祖先归一：把路径里**已存在的最长祖先**做 realpath，再拼回剩余段。
 *
 * 为什么不能直接 realpathSync 整条路径：托管叶子（.neo/worktrees/<name>）
 * 在 ensureWorktree 首次创建前并不存在，realpathSync 会抛 ENOENT；
 * 而要比较的恰恰是「尚未创建的托管路径」与「git 报的已存在路径」。
 *
 * 口径（issue #26）：
 *  - 存在的部分 → 软链展开（macOS /var → /private/var、/tmp → /private/tmp）；
 *  - 不存在的尾部 → 逐段原样拼回，不做任何假设（不写死 /private）。
 * 这样「调用方传入的原始路径」与「git 报的 realpath」在同一口径下可比。
 */
export function canonicalize(p: string): string {
  const abs = resolve(p);
  // 从深到浅找第一个已存在的祖先。
  const segments: string[] = [];
  let cur = abs;
  for (;;) {
    if (existsSync(cur)) break;
    const parent = dirname(cur);
    if (parent === cur) return abs; // 到根都不存在（罕见）：退回绝对路径
    segments.unshift(basename(cur));
    cur = parent;
  }
  let head: string;
  try {
    head = realpathSync(cur);
  } catch {
    head = cur;
  }
  return segments.length === 0 ? head : join(head, ...segments);
}

/**
 * cwd 是否落在 dir 之内（含 dir 本身，任意深度）。
 *
 * 为什么不能只比「同一路径」：会话 cwd 可以是 worktree 的子目录 ——
 * `neo -C .neo/worktrees/feat/sub`，或直接在 worktree 子目录里启动 neo。
 * 那时 remove 该 worktree 同样会删掉进程脚下的目录（cwd 失效、相对路径全乱）。
 *
 * 判定口径：
 *  1. 两边都先 realpath（软链别名、/tmp → /private/tmp 之类归一）；
 *  2. 用 `relative(dir, cwd)` 判断包含关系，而不是字符串 startsWith ——
 *     `/r/.neo/worktrees/feat2` 与 `/r/.neo/worktrees/feat` 同前缀但无关，
 *     startsWith 会误判成「在内部」；relative 给出 `../feat2` 一眼看穿；
 *  3. 同一 inode 也算（realpath 失败时的兜底，例如路径已被删）。
 */
function isWithin(dir: string, cwd: string): boolean {
  const rd = realish(dir);
  const rc = realish(cwd);
  if (rd === rc) return true;
  const rel = relative(rd, rc);
  if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return true;
  try {
    return statSync(rd).ino === statSync(rc).ino;
  } catch {
    return false;
  }
}

/**
 * 列出 neo 托管的 worktree（只认 .neo/worktrees/<name> + 分支 neo/<name>）。
 * cwd 用于标记「当前会话所在」；不传则全部 current=false。
 */
export function listManaged(
  repoRoot: string,
  deps: WorktreeDeps = {},
  cwd?: string,
): ManagedWorktree[] {
  const r = git(deps, ["worktree", "list", "--porcelain"], repoRoot);
  if (r.code !== 0) return [];
  // issue #26：rootDir 与 item.path 两侧都归一到 canonical 再取 relative。
  // 托管目录（.neo/worktrees）可能尚不存在，canonicalize 只对已存在的祖先展开软链、
  // 原样拼回不存在的尾部，所以叶子缺失也不会抛。
  const rootDir = canonicalize(worktreeRoot(repoRoot));
  const out: ManagedWorktree[] = [];
  for (const item of parseWorktreeList(r.stdout)) {
    const itemPath = canonicalize(item.path);
    const rel = relative(rootDir, itemPath);
    // 必须落在托管目录的下一层：rel 为空 = 托管目录本身，含 .. = 跑出去了。
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (rel.includes(sep)) continue;
    if (item.branch !== worktreeBranch(rel)) continue;
    out.push({
      name: rel,
      path: item.path,
      branch: item.branch,
      dirty: isDirty(item.path, deps),
      current: cwd !== undefined && isWithin(item.path, cwd),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 托管目录下存在、但 git 已不认的残留子目录（prune 后可清理的孤儿）。 */
export function orphanDirs(repoRoot: string, deps: WorktreeDeps = {}): string[] {
  const rootDir = worktreeRoot(repoRoot);
  if (!existsSync(rootDir)) return [];
  // issue #26：known 集合按 canonical 口径存，与下面的 join(rootDir, name) 对齐，
  // 否则软链路径下每个真实托管目录都会被误判成孤儿。
  const known = new Set(listManaged(repoRoot, deps).map((w) => canonicalize(w.path)));
  const out: string[] = [];
  for (const ent of readdirSync(rootDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const p = join(rootDir, ent.name);
    if (!known.has(canonicalize(p))) out.push(p);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

export interface RemoveOk {
  ok: true;
  name: string;
  path: string;
  /** 是否顺带 prune 了孤儿登记。 */
  pruned: boolean;
}

export interface RemoveErr {
  ok: false;
  /** 需要用户显式确认才能继续（脏工作区 / 未跟踪文件）。 */
  needsForce: boolean;
  message: string;
}

/**
 * 删除托管 worktree。
 *
 * 拒绝条件（按优先级）：
 *  1. 当前会话所在 → 拒绝（cwd 等于该 worktree 根**或在其内部任意深度子目录**，
 *     删掉自己脚下的目录，进程会立刻失去 cwd）；--force 也不放行；
 *  2. 工作区脏且未 force → 拒绝，并列出改动（绝不吞掉未提交/未跟踪的东西）；
 *  3. 不是托管 worktree → 拒绝（不碰用户的其它 worktree）。
 * 成功后 prune，清掉 git 里的残留登记。
 *
 * 注：被 .gitignore 忽略的文件不计入脏（git status 默认口径），
 * 因此干净删除时它们会随目录一起消失 —— 与 `git worktree remove` 语义一致。
 */
export function removeWorktree(
  repoRoot: string,
  name: string,
  opts: { force?: boolean; cwd?: string; deps?: WorktreeDeps } = {},
): RemoveOk | RemoveErr {
  const deps = opts.deps ?? {};
  if (!isValidWorktreeName(name)) {
    return { ok: false, needsForce: false, message: `worktree 名字非法："${name}"` };
  }
  const path = worktreePath(repoRoot, name);
  const listed = listManaged(repoRoot, deps, opts.cwd);
  const target = listed.find((w) => w.name === name);
  if (!target) {
    return {
      ok: false,
      needsForce: false,
      message:
        `没有名为 "${name}" 的托管 worktree。\n` +
        `  /worktree list 查看 neo 托管的清单（只含 ${WORKTREE_DIR}/ 下由 neo 创建的那些）。`,
    };
  }
  if (target.current) {
    return {
      ok: false,
      needsForce: false,
      message:
        `"${name}" 就是当前会话所在的 worktree，不能删除自己脚下的目录。\n` +
        `  （当前 cwd ${opts.cwd ?? "?"} 在该 worktree 内，含其子目录。）\n` +
        `  请在主仓库或另一个 worktree 里执行 /worktree remove ${name}。`,
    };
  }
  if (target.dirty && !opts.force) {
    const st = git(deps, ["status", "--short"], target.path);
    const lines = st.stdout.trim().split("\n").filter(Boolean).slice(0, 10);
    return {
      ok: false,
      needsForce: true,
      message:
        `"${name}" 有未提交改动或未跟踪文件，拒绝删除：\n` +
        lines.map((l) => `  ${l}`).join("\n") +
        `\n  先提交/丢弃这些改动，或确认要丢弃后执行：/worktree remove ${name} --force`,
    };
  }
  const rm = git(deps, ["worktree", "remove", "--force", target.path], repoRoot);
  if (rm.code !== 0) {
    const detail = (rm.stderr || rm.stdout).trim().split("\n").slice(0, 3).join("\n  ");
    return { ok: false, needsForce: false, message: `删除 worktree 失败：\n  ${detail}` };
  }
  const prune = git(deps, ["worktree", "prune"], repoRoot);
  return { ok: true, name, path: target.path, pruned: prune.code === 0 };
}
