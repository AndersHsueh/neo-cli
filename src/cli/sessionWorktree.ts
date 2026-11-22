/**
 * #85：会话中进出托管 worktree（/worktree create|enter|exit 与 enter_worktree / exit_worktree）。
 *
 * 一套实现，两个入口：斜杠给用户，工具给模型。
 *  - 创建/复用/删除仍调 src/worktree.ts（ensureWorktree / listManaged / removeWorktree）；
 *  - 换主根仍调 changeSessionCwd（#69 刷新 + #63 清空额外根）；
 *  - 本模块只管隔离绑定（SessionMeta.worktree：名字 / 路径 / isolation origin）、忙碌闸门放宽、
 *    审批归类（只有工具「实际新建」走写操作审批）、续聊恢复隔离与 /fork 绑定拷贝。
 * 不做写拦截、不做命令级 allow/deny（文件级隔离，不是沙箱）。
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { CommandContext } from "./commandContext.ts";
import { changeSessionCwd, cwdSwitchBusyReason, type CwdSwitchDeps } from "./cdWorkdir.ts";
import type { SessionMeta, WorktreeBinding } from "../session.ts";
import { gateTool, notExecuted, ToolError, type ToolImpl } from "../tools/types.ts";
import { c } from "../ui/theme.ts";
import { isRunningIsolatedWorktree } from "../subagentWorktree.ts";
import { copyWorktreeInclude } from "../worktreeInclude.ts";
import {
  canonicalize,
  detectRepo,
  ensureWorktree,
  isValidWorktreeName,
  listManaged,
  removeWorktree,
  WORKTREE_BRANCH_PREFIX,
  worktreeBranch,
  worktreePath,
  worktreeRoot,
} from "../worktree.ts";

export const WORKTREE_SUBCOMMAND_HINT = "可用：list | create <name> | enter <name> | exit | remove <name> [--force]";
export const NOT_ISOLATED_MESSAGE =
  "当前不在托管 worktree 会话里（启动时未用 --worktree，也未 /worktree create|enter；/cd 到 worktree 路径不算进入）";
export const WORKTREE_CLEARED_NOTE = "（换主根会清空额外根；/cd - 与 /worktree exit 都不恢复）";

/** p 是否在 dir 之内（含 dir 本身）；两边先 canonicalize，用 relative 判包含，不用字符串前缀。 */
export function isPathWithin(dir: string, p: string): boolean {
  const d = canonicalize(dir);
  const x = canonicalize(p);
  if (d === x) return true;
  const rel = relative(d, x);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/* ------------------------------------------------------------------ */
/* 忙碌闸门                                                             */
/* ------------------------------------------------------------------ */

/**
 * 与 /cd 共用换根闸门，两条放宽（/cd 自己的闸门不变）：
 *  1. 工具调用跳过「本轮正在进行」；
 *  2. 有后台子代理在跑不拒绝（子代理派出时已对 cfg 拍快照，含 cwd；见 task.ts 浅拷贝）。
 * wiki worker 在跑仍拒绝。
 */
export function worktreeSwitchBusyReason(opts: {
  fromTool?: boolean;
  turnActive?: boolean;
  wikiRunning?: boolean;
  backgroundTasks?: Array<{ status: string; kind?: string }>;
}): string | null {
  const wikiTasks = (opts.backgroundTasks ?? []).filter((t) => t.status === "running" && t.kind === "wiki");
  return cwdSwitchBusyReason({
    turnActive: opts.fromTool ? false : opts.turnActive === true,
    wikiRunning: opts.wikiRunning === true,
    backgroundTasks: wikiTasks,
  });
}

/** 换根依赖 + 闸门输入（工具宿主与斜杠共用）。 */
export interface SessionWorktreeDeps extends CwdSwitchDeps {
  turnActive?: boolean;
  wikiRunning?: boolean;
  backgroundTasks?: Array<{ status: string; kind?: string }>;
}

/* ------------------------------------------------------------------ */
/* 进入 / 退出                                                          */
/* ------------------------------------------------------------------ */

export type EnterResult =
  | {
      ok: true;
      unchanged: boolean;
      created: boolean;
      name: string;
      path: string;
      branch: string;
      cwd: string;
      origin: string;
      cleared: string[];
      warnings: string[];
      copied: string[];
    }
  | { ok: false; error: string; notExecuted?: boolean };

export interface EnterOptions {
  fromTool?: boolean;
  /** 工具入口：在真正动手前过审批/PreToolUse。creating=true 时按写操作审批。返回非 null = 不执行。 */
  gate?: (creating: boolean) => Promise<string | null>;
}

function busyOf(deps: SessionWorktreeDeps, fromTool: boolean): string | null {
  return worktreeSwitchBusyReason({
    fromTool,
    ...(deps.turnActive !== undefined ? { turnActive: deps.turnActive } : {}),
    ...(deps.wikiRunning !== undefined ? { wikiRunning: deps.wikiRunning } : {}),
    ...(deps.backgroundTasks ? { backgroundTasks: deps.backgroundTasks } : {}),
  });
}

function persistBinding(deps: SessionWorktreeDeps, warnings: string[]): void {
  try {
    deps.persist(deps.messages, deps.meta);
  } catch (e) {
    warnings.push(`隔离绑定落盘失败（本次会话内仍生效）：${(e as Error).message}`);
  }
}

/**
 * `/worktree create|enter <name>` 与 `enter_worktree` 的唯一实现。
 * mode=create：按 #9 ensureWorktree 创建或复用；mode=enter：只进已有托管树。
 */
export async function enterSessionWorktree(
  name: string,
  mode: "create" | "enter",
  deps: SessionWorktreeDeps,
  opts: EnterOptions = {},
): Promise<EnterResult> {
  const busy = busyOf(deps, opts.fromTool === true);
  if (busy) return { ok: false, error: busy };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: `用法：/worktree ${mode} <name>` };
  if (!isValidWorktreeName(trimmed)) {
    return {
      ok: false,
      error: `worktree 名字非法："${trimmed}"（只允许字母/数字/._-，不以 . 或 - 开头，长度 1..64）`,
    };
  }
  const { cfg, meta } = deps;
  const repo = detectRepo(cfg.cwd);
  if (!repo.ok) return { ok: false, error: repo.message };
  const listed = listManaged(repo.mainRoot);
  const existing = listed.find((w) => w.name === trimmed);
  const path = worktreePath(repo.mainRoot, trimmed);
  const branch = worktreeBranch(trimmed);

  // unchanged：当前主根已在目标树内（含子目录，canonicalize）—— 不移动、不清空、不刷新。
  if (existing && isPathWithin(existing.path, cfg.cwd)) {
    if (opts.gate) {
      const blocked = await opts.gate(false);
      if (blocked) return { ok: false, error: blocked, notExecuted: true };
    }
    return {
      ok: true,
      unchanged: true,
      created: false,
      name: trimmed,
      path,
      branch,
      cwd: cfg.cwd,
      origin: meta.worktree?.origin ?? canonicalize(cfg.cwd),
      cleared: [],
      warnings: [],
      copied: [],
    };
  }
  if (mode === "enter" && !existing) {
    return {
      ok: false,
      error:
        `没有名为 "${trimmed}" 的托管 worktree（/worktree enter 只进入已有项，不创建）。` +
        ` /worktree list 查看；新建用 /worktree create ${trimmed}`,
    };
  }
  const creating = !existing && !existsSync(path);
  if (opts.gate) {
    const blocked = await opts.gate(creating);
    if (blocked) return { ok: false, error: blocked, notExecuted: true };
  }
  const ensured = ensureWorktree(repo.mainRoot, trimmed);
  if (!ensured.ok) return { ok: false, error: ensured.message };
  const warnings: string[] = [];
  let copied: string[] = [];
  if (ensured.created) {
    // .worktreeinclude：源是主检出；复用已有树不拷（不覆盖已有文件）。safe-mode 下照常。
    const inc = copyWorktreeInclude(repo.mainRoot, ensured.path);
    copied = inc.copied;
    warnings.push(...inc.warnings);
  }
  const origin = meta.worktree?.origin ?? canonicalize(cfg.cwd);
  const switched = await changeSessionCwd(ensured.path, { ...deps, busyReason: null });
  if (!switched.ok) {
    return { ok: false, error: `${ensured.created ? `worktree ${trimmed} 已创建，但` : ""}${switched.error}` };
  }
  meta.worktree = { name: trimmed, origin, path: canonicalize(ensured.path) };
  persistBinding(deps, warnings);
  warnings.push(...(switched.warnings ?? []));
  return {
    ok: true,
    unchanged: false,
    created: ensured.created,
    name: trimmed,
    path: ensured.path,
    branch: ensured.branch,
    cwd: switched.cwd,
    origin,
    cleared: switched.clearedAdditionalDirs ?? [],
    warnings,
    copied,
  };
}

export type ExitResult =
  | { ok: true; name: string; path: string; cwd: string; cleared: string[]; warnings: string[] }
  | { ok: false; error: string; notExecuted?: boolean };

/** `/worktree exit` 与 `exit_worktree`：退回 isolation origin，清绑定；永不删树、不删分支。 */
export async function exitSessionWorktree(
  deps: SessionWorktreeDeps,
  opts: { fromTool?: boolean; gate?: () => Promise<string | null> } = {},
): Promise<ExitResult> {
  const busy = busyOf(deps, opts.fromTool === true);
  if (busy) return { ok: false, error: busy };
  const binding = deps.meta.worktree;
  if (!binding) return { ok: false, error: NOT_ISOLATED_MESSAGE };
  let originOk = false;
  try {
    originOk = statSync(binding.origin).isDirectory();
  } catch {
    originOk = false;
  }
  if (!originOk) {
    return {
      ok: false,
      error: `isolation origin ${binding.origin} 已不存在，未切换（仍在 worktree ${binding.name}；可用 /cd 换到别处）`,
    };
  }
  if (opts.gate) {
    const blocked = await opts.gate();
    if (blocked) return { ok: false, error: blocked, notExecuted: true };
  }
  const switched = await changeSessionCwd(binding.origin, { ...deps, busyReason: null });
  if (!switched.ok) return { ok: false, error: switched.error };
  delete deps.meta.worktree;
  const warnings: string[] = [];
  persistBinding(deps, warnings);
  warnings.push(...(switched.warnings ?? []));
  return {
    ok: true,
    name: binding.name,
    path: binding.path,
    cwd: switched.cwd,
    cleared: switched.clearedAdditionalDirs ?? [],
    warnings,
  };
}

/** 成功反馈（斜杠与工具共用文案）。第一行是结论。 */
export function formatEnterLines(r: Extract<EnterResult, { ok: true }>): string[] {
  if (r.unchanged) {
    return [`当前主根已在 worktree ${r.name} 内（${r.cwd}），未移动、未刷新。`];
  }
  const lines = [
    `${r.created ? "已创建" : "已复用"} worktree ${r.name} → ${r.path}（分支 ${r.branch}）`,
    `现在的主根：${r.cwd}（对话保留；/worktree exit 回到 ${r.origin}）`,
  ];
  if (r.copied.length > 0) lines.push(`.worktreeinclude：已从主检出拷入 ${r.copied.length} 个文件：${r.copied.join("、")}`);
  lines.push(...clearedLines(r.cleared));
  return lines;
}

export function formatExitLines(r: Extract<ExitResult, { ok: true }>): string[] {
  return [
    `已退出 worktree ${r.name} → 主根 ${r.cwd}`,
    `树与分支 ${worktreeBranch(r.name)} 保留在 ${r.path}（删除用 /worktree remove ${r.name}）`,
    ...clearedLines(r.cleared),
  ];
}

function clearedLines(cleared: string[]): string[] {
  if (cleared.length === 0) return [];
  return [`已清空本会话额外工作根 ${cleared.length} 个：${cleared.join("、")}`, WORKTREE_CLEARED_NOTE];
}

/* ------------------------------------------------------------------ */
/* /cd、启动、续聊、/fork、/context                                       */
/* ------------------------------------------------------------------ */

/** /cd 成功换根后：树内保持绑定；树外清除绑定（不自动跳回 origin）。返回是否改了 meta。 */
export function settleBindingAfterCd(meta: SessionMeta, newCwd: string): boolean {
  if (!meta.worktree) return false;
  if (isPathWithin(meta.worktree.path, newCwd)) return false;
  delete meta.worktree;
  return true;
}

/** 启动 `--worktree <name>`：开局即隔离态，origin = 该仓 mainRoot（不是 worktree 路径）。 */
export function startupWorktreeBinding(name: string, path: string, mainRoot: string): WorktreeBinding {
  return { name, origin: canonicalize(mainRoot), path: canonicalize(path) };
}

/** 托管路径 <mainRoot>/.neo/worktrees/<name> → mainRoot。 */
function mainRootOfManaged(path: string): string {
  return canonicalize(resolve(path, "..", "..", ".."));
}

/**
 * 续聊结算（#69 的窄例外）。
 *  - 显式 --worktree：以本次为准，不走例外；
 *  - 无绑定：按 #69 在启动目录运行，无提示；
 *  - ①有绑定 ②树还在 ③启动目录属于同一个仓：回到记录里那棵树（记录在树内子目录则回那个子目录）；
 *  - 缺一条：在启动目录运行并清除绑定，打规定文案。
 */
export function settleResumeWorktree(input: {
  recorded: WorktreeBinding | undefined;
  recordedCwd: string | null | undefined;
  startCwd: string;
  explicit: WorktreeBinding | null;
}): { cwd: string; binding: WorktreeBinding | undefined; notice: string | null } {
  const { recorded, recordedCwd, startCwd, explicit } = input;
  if (explicit) return { cwd: startCwd, binding: explicit, notice: null };
  if (!recorded) return { cwd: startCwd, binding: undefined, notice: null };
  const treeRoot = mainRootOfManaged(recorded.path);
  const alive =
    existsSync(recorded.path) &&
    listManaged(treeRoot).some((w) => w.name === recorded.name && canonicalize(w.path) === canonicalize(recorded.path));
  if (!alive) {
    return {
      cwd: startCwd,
      binding: undefined,
      notice: `会话记录的 worktree ${recorded.name}（${recorded.path}）已不存在，已清除隔离绑定，在 ${startCwd} 继续`,
    };
  }
  const startRepo = detectRepo(startCwd);
  if (!startRepo.ok || canonicalize(startRepo.mainRoot) !== treeRoot) {
    return {
      cwd: startCwd,
      binding: undefined,
      notice: `会话记录在 worktree ${recorded.name}，本次按 ${startCwd} 运行，需要请 /worktree enter ${recorded.name}`,
    };
  }
  let cwd = canonicalize(recorded.path);
  if (recordedCwd && isPathWithin(recorded.path, recordedCwd)) {
    try {
      if (statSync(recordedCwd).isDirectory()) cwd = canonicalize(recordedCwd);
    } catch {
      /* 子目录没了：回树根 */
    }
  }
  return { cwd, binding: recorded, notice: `已回到 worktree ${recorded.name}（续聊恢复隔离）` };
}

/** /fork、--resume --fork：子会话 cwd 仍在父会话绑定的树内才拷贝绑定（共用同一棵树，不新建）。 */
export function forkWorktreeBinding(parent: SessionMeta, childCwd: string): WorktreeBinding | undefined {
  const b = parent.worktree;
  if (!b) return undefined;
  return isPathWithin(b.path, childCwd) ? { ...b } : undefined;
}

/** /context：隔离态列出当前 worktree 名与 origin；不在隔离态返回空表。 */
export function worktreeContextLines(meta: SessionMeta | null | undefined): string[] {
  const b = meta?.worktree;
  if (!b) return [];
  return [`隔离 worktree：${b.name}（${b.path}）`, `isolation origin：${b.origin}（/worktree exit 回到这里）`];
}

/* ------------------------------------------------------------------ */
/* 模型工具                                                             */
/* ------------------------------------------------------------------ */

/**
 * enter_worktree / exit_worktree（蛇形名；只给主会话，已列入 TOOL_NAMES_EXCLUDED_FOR_SUBAGENT）。
 * parallelizable=false：同批里作为屏障，前面的调用用旧根、后面的用新根。
 * sensitive=true：审批由工具自己按「是否实际新建」决定（gateTool 带 detail 才问）。
 */
export function makeWorktreeTools(host: { deps: () => SessionWorktreeDeps }): ToolImpl[] {
  const enter: ToolImpl = {
    sensitive: true,
    kind: "neither",
    parallelizable: false,
    spec: {
      type: "function",
      function: {
        name: "enter_worktree",
        description:
          "把本会话主根切到 neo 托管的 git worktree（<仓>/.neo/worktrees/<name>，分支 neo/<name>）：不存在就从主检出当前 HEAD 新建，已存在就进入。" +
          "对话保留；之后相对路径的读写、glob/grep、shell 默认目录都落在这份检出里。换主根会清空本会话额外工作根。" +
          "这是文件级隔离，不是沙箱。新建会走写操作审批。必须给 name，不会自动起名。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "托管 worktree 名：字母/数字/._-，不以 . 或 - 开头，长度 1..64" },
          },
          required: ["name"],
        },
      },
    },
    async execute(args, ctx) {
      const name = typeof args["name"] === "string" ? args["name"].trim() : "";
      if (!name) throw new ToolError("enter_worktree 需要 name（不提供自动起名）");
      const r = await enterSessionWorktree(name, "create", host.deps(), {
        fromTool: true,
        gate: (creating) =>
          gateTool(ctx, "enter_worktree", args, creating ? `新建 worktree ${name}（目录 + 分支 ${worktreeBranch(name)}）` : undefined),
      });
      if (!r.ok) {
        if (r.notExecuted) notExecuted(r.error);
        throw new ToolError(r.error);
      }
      return [...formatEnterLines(r), ...r.warnings].join("\n");
    },
  };
  const exit: ToolImpl = {
    sensitive: true,
    kind: "neither",
    parallelizable: false,
    spec: {
      type: "function",
      function: {
        name: "exit_worktree",
        description:
          "退出当前托管 worktree，主根回到 isolation origin（进入前的主根；--worktree 启动则是主检出）。" +
          "不删树、不删分支；换主根会清空本会话额外工作根。不在隔离态时报错。",
        parameters: { type: "object", properties: {} },
      },
    },
    async execute(args, ctx) {
      const r = await exitSessionWorktree(host.deps(), { fromTool: true, gate: () => gateTool(ctx, "exit_worktree", args) });
      if (!r.ok) {
        if (r.notExecuted) notExecuted(r.error);
        throw new ToolError(r.error);
      }
      return [...formatExitLines(r), ...r.warnings].join("\n");
    },
  };
  return [enter, exit];
}

/* ------------------------------------------------------------------ */
/* 斜杠 /worktree                                                       */
/* ------------------------------------------------------------------ */

function switchDepsFromContext(ctx: CommandContext): SessionWorktreeDeps | null {
  if (!ctx.promptManager || !ctx.persistSession || !ctx.previousCwd) return null;
  const turnActive = typeof ctx.turnActive === "function" ? ctx.turnActive() : ctx.turnActive === true;
  return {
    cfg: ctx.cfg,
    meta: ctx.meta,
    messages: ctx.agent.messages,
    persist: ctx.persistSession,
    promptManager: ctx.promptManager,
    refreshSystemPrompt: () => ctx.agent.refreshSystemPrompt(),
    previousCwd: ctx.previousCwd,
    ...(ctx.fileIndex ? { fileIndex: ctx.fileIndex } : {}),
    ...(ctx.memory ? { memory: ctx.memory } : {}),
    ...(ctx.mailbox ? { mailbox: ctx.mailbox } : {}),
    ...(ctx.checkpoints ? { checkpoints: ctx.checkpoints } : {}),
    ...(ctx.replaceRules ? { replaceRules: ctx.replaceRules } : {}),
    ...(ctx.restartLsp ? { restartLsp: ctx.restartLsp } : {}),
    ...(ctx.onStatusLineRefresh ? { onStatusLineRefresh: ctx.onStatusLineRefresh } : {}),
    turnActive,
    wikiRunning: ctx.wikiMaintainer?.running === true,
    backgroundTasks: (ctx.tasks?.list() ?? []).map((t) => ({ status: t.status, ...(t.kind ? { kind: t.kind } : {}) })),
  };
}

/** `/worktree` 斜杠（#9 的 list/remove + #85 的 create/enter/exit）。用户亲自打的，不审批。 */
export async function handleWorktreeCommand(arg: string, ctx: CommandContext): Promise<void> {
  const { ui, cfg } = ctx;
  const [subRaw, ...subRest] = arg.split(/\s+/).filter(Boolean);
  const sub = (subRaw ?? "").toLowerCase();
  if (sub === "") {
    ui.info(`/worktree 需要子命令。${WORKTREE_SUBCOMMAND_HINT}`);
    return;
  }
  if (sub === "create" || sub === "enter" || sub === "exit") {
    const deps = switchDepsFromContext(ctx);
    if (!deps) {
      ui.warn("当前入口不支持 /worktree create|enter|exit（缺会话接线）；用 --worktree <name> 启动。");
      return;
    }
    if (sub === "exit") {
      const r = await exitSessionWorktree(deps);
      if (!r.ok) {
        ui.warn(r.error);
        return;
      }
      const [head, ...rest] = formatExitLines(r);
      ui.success(head!);
      for (const l of rest) ui.line(c.dim(`  ${l}`));
      for (const w of r.warnings) ui.warn(w);
      return;
    }
    const r = await enterSessionWorktree(subRest[0] ?? "", sub, deps);
    if (!r.ok) {
      ui.warn(r.error);
      return;
    }
    const [head, ...rest] = formatEnterLines(r);
    if (r.unchanged) ui.info(head!);
    else ui.success(head!);
    for (const l of rest) ui.line(c.dim(`  ${l}`));
    for (const w of r.warnings) ui.warn(w);
    if (!r.unchanged) ui.info("新目录的 MCP / 本地 settings 需在该目录重新启动 neo 才生效（与 /cd 相同）。");
    return;
  }
  const repo = detectRepo(cfg.cwd);
  if (!repo.ok) {
    ui.warn(repo.message);
    return;
  }
  if (sub === "list" || sub === "ls") {
    const items = listManaged(repo.mainRoot, {}, cfg.cwd);
    ui.blank();
    if (items.length === 0) {
      ui.info(`没有 neo 托管的 worktree（目录 ${worktreeRoot(repo.mainRoot)}）。`);
      ui.line(c.dim("  新建：/worktree create <name>（会话中进入），或启动时 neo --worktree <name>"));
      return;
    }
    ui.line(c.dim(`neo 托管的 worktree（${worktreeRoot(repo.mainRoot)}；分支前缀 ${WORKTREE_BRANCH_PREFIX}）`));
    for (const w of items) {
      const marks = [w.current ? c.accent("← 当前") : "", w.dirty ? c.warn("改动未提交") : c.dim("干净")]
        .filter(Boolean)
        .join(" ");
      ui.line(`  ${c.bright(w.name)} ${c.dim(w.branch ?? "(detached)")} ${marks}`);
      ui.line(`    ${c.dim(w.path)}`);
    }
    ui.line(c.dim("  只列 .neo/worktrees/ 下由 neo 创建的；你自己的其它 worktree 不在此列、也不会被这里删除。"));
    return;
  }
  if (sub === "remove" || sub === "rm") {
    const name = subRest[0] ?? "";
    const force = subRest.slice(1).includes("--force");
    if (!name) {
      ui.warn("用法：/worktree remove <name> [--force]");
      return;
    }
    // #85：正在跑的隔离子代理的检出与「自己脚下」同类，--force 同样不放行。
    if (isValidWorktreeName(name) && isRunningIsolatedWorktree(worktreePath(repo.mainRoot, name))) {
      ui.warn(
        `"${name}" 是正在运行的隔离子代理的检出（${worktreePath(repo.mainRoot, name)}），不能删除（--force 同样不放行）；等该子代理结束后再删。`,
      );
      return;
    }
    // 关键：先按 force=false 探测，**不**把 --force 直接透传下去（脏工作区要先给人看一眼再点头）。
    const probe = removeWorktree(repo.mainRoot, name, { force: false, cwd: cfg.cwd });
    if (probe.ok) {
      ui.success(`已删除 worktree ${probe.name}（${probe.path}）${probe.pruned ? "，已 prune" : ""}`);
      ui.line(c.dim(`  分支 ${worktreeBranch(probe.name)} 保留，方便复查或重新挂载。`));
      return;
    }
    if (!probe.needsForce) {
      ui.warn(probe.message);
      return;
    }
    if (!force) {
      ui.warn(probe.message);
      ui.line(c.dim(`  确认要丢弃这些改动就再执行一次：/worktree remove ${name} --force`));
      return;
    }
    ui.warn(`"${name}" 有未提交改动或未跟踪文件，--force 将丢弃它们：`);
    for (const line of probe.message.split("\n")) {
      if (/^ {2}\S/.test(line)) ui.line(c.dim(line));
    }
    const ok = await ui.confirm(`worktree_remove — 删除 ${name} 并丢弃其未提交改动 / 未跟踪文件`);
    if (!ok) {
      ui.info("已取消，未删除任何东西。");
      return;
    }
    const forced = removeWorktree(repo.mainRoot, name, { force: true, cwd: cfg.cwd });
    if (forced.ok) ui.success(`已强制删除 worktree ${forced.name}（未提交改动已丢弃）`);
    else ui.warn(forced.message);
    return;
  }
  ui.warn(`未知子命令 /worktree ${sub}。${WORKTREE_SUBCOMMAND_HINT}`);
}
