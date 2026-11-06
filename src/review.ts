/**
 * review.ts — `/review` 的 diff 采集层（issue #12）。
 *
 * 为什么采集放在 CLI 侧而不是让模型自己跑 `git diff`：
 * 「工作区干净」必须是**确定性结论**。模型跑 shell 有权限闸门、有失败重试、
 * 有输出截断，任何一环都可能让它把「没读到 diff」说成「没改动」。
 * 这里用 git 直接取，取不到就明确报错，不猜。
 *
 * 只读：本模块只执行 `git rev-parse` / `git diff` / `git status`，
 * 不改工作树、不写盘、不碰 index。
 *
 * 范围口径（与 issue #12 一致）：
 *  - 无基线：`git diff HEAD`（已暂存 + 未暂存）+ 未跟踪文件名单；
 *  - 有基线：`git diff <ref>`（该 ref 到当前工作树的全部差异）+ 未跟踪文件名单。
 *    注意未跟踪文件在任何基线下都列出来 —— 它们不在任何 commit 里，
 *    `git diff <ref>` 天然看不见，漏掉它们等于漏审新文件。
 */

/** diff 体积上限（字符）。超过就截断并在提示里注明，避免撑爆上下文。 */
export const REVIEW_DIFF_LIMIT = 80_000;

/** 未跟踪文件名单上限（条）。名单只是提示，超长时截断即可。 */
export const REVIEW_UNTRACKED_LIMIT = 200;

export interface ReviewDeps {
  /** 执行 git 命令，返回 {code, stdout, stderr}。测试可注入。 */
  exec?: (args: string[], cwd: string) => { code: number; stdout: string; stderr: string };
}

function defaultExec(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
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

export type ReviewScope =
  /** 相对 HEAD 的已暂存 + 未暂存改动。 */
  | { kind: "worktree" }
  /** 相对某个 ref 的全部差异。 */
  | { kind: "ref"; ref: string };

export interface ReviewDiff {
  ok: true;
  scope: ReviewScope;
  /** 人类可读的范围说明，例：未提交改动 / 相对 main。 */
  label: string;
  /** diff 正文（可能已截断）。 */
  patch: string;
  /** 是否发生了截断。 */
  truncated: boolean;
  /** 截断前的原始字符数（未截断时等于 patch.length）。 */
  patchLength: number;
  /** 未跟踪文件（相对路径，已排序）。 */
  untracked: string[];
  /** 未跟踪名单是否被截断。 */
  untrackedTruncated: boolean;
  /** 是否有任何改动（diff 非空或存在未跟踪文件）。 */
  hasChanges: boolean;
}

export interface ReviewFailure {
  ok: false;
  /** 面向用户的友好说明（不抛异常，命令层直接打印）。 */
  message: string;
}

export type ReviewResult = ReviewDiff | ReviewFailure;

/** 未跟踪文件名单（`git status --porcelain` 里的 `??` 项）。 */
function listUntracked(cwd: string, exec: ReviewDeps["exec"]): string[] {
  const r = exec!(["status", "--porcelain", "--untracked-files=all"], cwd);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim())
    .filter((l) => l !== "")
    .sort();
}

/**
 * 采集审查范围。
 *
 * 失败一律返回 `{ok:false, message}`，由调用方打印 —— 命令层不该因为
 * 用户打了个不存在的分支名就崩掉整条 drain 循环。
 */
export function collectReviewDiff(
  cwd: string,
  ref?: string,
  deps: ReviewDeps = {},
): ReviewResult {
  const exec = deps.exec ?? defaultExec;
  const target = (ref ?? "").trim();

  // 1. 是不是 git 仓库
  const inside = exec(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, message: `当前目录不是 git 仓库：${cwd}` };
  }

  // 2. 有基线时先确认 ref 存在，不存在就友好报错（不抛）
  if (target !== "") {
    const verify = exec(["rev-parse", "--verify", "--quiet", `${target}^{commit}`], cwd);
    if (verify.code !== 0 || verify.stdout.trim() === "") {
      return {
        ok: false,
        message: `找不到基线 "${target}"（git rev-parse --verify 失败）。可用分支名、tag 或任意 commit-ish。`,
      };
    }
  }

  // 3. 取 diff。无基线走 `diff HEAD`（staged + unstaged 一起），有基线走 `diff <ref>`
  const args = target === "" ? ["diff", "HEAD"] : ["diff", target];
  const diff = exec(args, cwd);
  if (diff.code !== 0) {
    const why = (diff.stderr || diff.stdout).trim().split("\n")[0] ?? "";
    return {
      ok: false,
      message: `git ${args.join(" ")} 执行失败${why ? `：${why}` : ""}`,
    };
  }

  const raw = diff.stdout;
  const truncated = raw.length > REVIEW_DIFF_LIMIT;
  const patch = truncated
    ? `${raw.slice(0, REVIEW_DIFF_LIMIT)}\n\n…（diff 已截断：原始 ${raw.length} 字符，仅保留前 ${REVIEW_DIFF_LIMIT} 字符）`
    : raw;

  const allUntracked = listUntracked(cwd, exec);
  const untrackedTruncated = allUntracked.length > REVIEW_UNTRACKED_LIMIT;
  const untracked = allUntracked.slice(0, REVIEW_UNTRACKED_LIMIT);

  const scope: ReviewScope = target === "" ? { kind: "worktree" } : { kind: "ref", ref: target };
  return {
    ok: true,
    scope,
    label: target === "" ? "未提交改动" : `相对 ${target}`,
    patch,
    truncated,
    patchLength: raw.length,
    untracked,
    untrackedTruncated,
    hasChanges: raw.trim() !== "" || untracked.length > 0,
  };
}

/**
 * 拼给模型的审查提示。
 *
 * 三条硬要求写进提示里：只审查不改文件、分级 findings 带定位、没问题也要说话。
 * 最后一条不是客套 —— 空回复在 neo 里会被当成错误轮（emptyResponse），
 * 用户看到的是「本轮未完成」，比一句「未发现明显问题」糟糕得多。
 */
export function buildReviewPrompt(d: ReviewDiff): string {
  const parts: string[] = [];
  parts.push(
    `请对以下 ${d.label} 做一次**只读代码审查**。`,
    "",
    "要求：",
    "1. 只审查，不要修改任何文件（不要 write_file / edit_file，不要跑会改工作树的命令）。",
    "2. 输出分级 findings，级别用 critical / warning / note：",
    "   - critical：会导致错误行为、数据损坏、安全问题；",
    "   - warning：可疑逻辑、边界没处理、错误被吞、资源泄漏；",
    "   - note：可读性、命名、重复、可简化处。",
    "   每条必须带：文件路径 + 相关片段或行号（diff 里能看到就写，看不到就写文件路径与函数/符号名）、问题、建议。",
    "3. 没有问题就明确写「未发现明显问题」，不要空回复。",
    "4. 不要复述 diff 内容，直接给结论。",
    "",
    `范围：${d.label}`,
  );
  if (d.truncated) {
    parts.push(`注意：diff 已截断（原始 ${d.patchLength} 字符），未覆盖的部分不要臆测。`);
  }
  parts.push("", "```diff", d.patch.trimEnd(), "```");
  if (d.untracked.length > 0) {
    parts.push(
      "",
      `未跟踪文件（不在 diff 里，需要时可用 read_file 查看，但同样不要修改）：`,
      ...d.untracked.map((f) => `- ${f}`),
    );
    if (d.untrackedTruncated) parts.push(`（名单已截断，仅列前 ${d.untracked.length} 个）`);
  }
  return parts.join("\n");
}

/** 一行范围摘要（UI 用）：文件数 / 增删行数。 */
export function summarizePatch(patch: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) files++;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    else if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { files, added, removed };
}
