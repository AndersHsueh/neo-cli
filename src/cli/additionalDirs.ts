/**
 * issue #63：本会话额外工作根（`--add-dir` / `/add-dir`）。已签合同见 issue #63。
 *
 * 口径（摘要，细节以合同为准）：
 *  - 是「视野」不是权限：不做信任询问、不复活 insideCwd、不改 /mode；写文件与 shell 仍走既有审批；
 *  - 主根不变（`-C` / `/cd` 才改主根）；额外根是 realpath、按加入顺序，只活在本会话（启动 flag /
 *    斜杠命令 / 会话元数据），不写 settings、没有 `--remember`；
 *  - `/cd` 成功换主根清空全部额外根（与 Claude Code 相反，有意）；
 *  - 不从额外根加载 settings / hooks / MCP / LSP / 规则 / wiki / 技能 / 命令 / 子代理；
 *    #54 指令文件按每个工作根各算（safe-mode 下不加载）。
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Config } from "../config.ts";
import { discoverProjectRules, formatAlwaysOnRules } from "../rules/index.ts";
import { c } from "../ui/theme.ts";
import { realish } from "../worktree.ts";
import type { Args } from "./args.ts";
import type { CommandContext } from "./commandContext.ts";
import { composePermanentMemory, loadSessionInstructionMemory } from "./nestedAgents.ts";

export const ADD_DIR_HINT = "每个目录各写一次 --add-dir";

/** `~` 与 `~/x` 展开（`~user` 不展开，与 `/cd` 同口径）。 */
function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return raw;
}

/** 文件系统根：Unix 的 `/`；Windows 盘符根如 `C:\`、`D:/`。 */
export function isFilesystemRoot(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/?$/.test(n)) return true;
  if (/^\/+$/.test(n)) return true;
  if (!isAbsolute(p)) return false;
  return resolve(p, "..") === resolve(p);
}

export type AddDirResolution = { ok: true; path: string } | { ok: false; error: string };

/**
 * 解析并校验一个候选目录：相对 `base`，`~` 展开；必须已存在且是目录（symlink 到目录可以，
 * 返回 realpath）；拒绝文件系统根。`stat` 失败即报错（不对网络路径做专项探测）。
 */
export function resolveAddDirPath(base: string, raw: string, opts: { home?: string } = {}): AddDirResolution {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "路径为空" };
  const expanded = expandHome(trimmed, opts.home ?? homedir());
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
  if (isFilesystemRoot(abs)) return { ok: false, error: "不能把文件系统根加入工作根" };
  let isDir: boolean;
  try {
    isDir = statSync(abs).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, error: "目录不存在" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, error: "没有访问权限" };
    return { ok: false, error: `无法访问（${(e as Error).message}）` };
  }
  if (!isDir) return { ok: false, error: "不是目录" };
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (e) {
    return { ok: false, error: `无法解析路径（${(e as Error).message}）` };
  }
  if (isFilesystemRoot(real)) return { ok: false, error: "不能把文件系统根加入工作根" };
  return { ok: true, path: real };
}

/**
 * 启动期 `--add-dir` 校验（早于配置载入，不启会话）：句法错误、交互 TTY 下的多余位置参数、
 * 路径不存在 / 不是目录 / 文件系统根，都返回用法错误（调用方退出 2）。相对路径相对进程启动
 * cwd，不相对 `-C`。任一路径不满足即报错，不静默跳过其余路径。
 */
export function startupAddDirCheck(
  args: Pick<Args, "addDirs" | "addDirError" | "rest">,
  env: { stdinIsTTY: boolean; processCwd: string; home?: string },
): { ok: true; dirs: string[] } | { ok: false; message: string } {
  if (args.addDirError !== null) return { ok: false, message: args.addDirError };
  if (args.addDirs.length === 0) return { ok: true, dirs: [] };
  // 交互 TTY 下没被消费的位置参数会被静默丢掉（见 #63 预检），用了 --add-dir 时必须报错；
  // 带 -p 同样适用（合同「与 -p 同时有效（位置参数规则见上）」）。非 TTY 时位置参数仍当一次性提示词。
  if (env.stdinIsTTY && args.rest.length > 0) {
    return {
      ok: false,
      message:
        `--add-dir 每次只跟一个路径；交互终端下多余的位置参数不会被使用（收到：${args.rest.join(" ")}）。` +
        `${ADD_DIR_HINT}，例如 neo --add-dir ../a --add-dir ../b`,
    };
  }
  const dirs: string[] = [];
  for (const raw of args.addDirs) {
    const r = resolveAddDirPath(env.processCwd, raw, env.home ? { home: env.home } : {});
    if (!r.ok) return { ok: false, message: `--add-dir ${raw}：${r.error}` };
    if (!dirs.includes(r.path)) dirs.push(r.path);
  }
  return { ok: true, dirs };
}

/** 会话有序工作根：主根在前，额外根按加入顺序在后。 */
export function workRoots(cfg: Pick<Config, "cwd"> & { additionalDirs?: string[] }): string[] {
  return [cfg.cwd, ...(cfg.additionalDirs ?? [])];
}

function isInsideOrSame(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

interface ScopeHit {
  main: boolean;
  root: string;
  sub: boolean;
}

/** `real` 是否已在某个工作根之内（取最具体的根）。 */
function scopeOf(real: string, mainCwd: string, extras: readonly string[]): ScopeHit | null {
  let best: ScopeHit | null = null;
  let bestLen = -1;
  const mainReal = realish(mainCwd);
  for (const [i, root] of [mainReal, ...extras].entries()) {
    if (!isInsideOrSame(root, real) || root.length <= bestLen) continue;
    best = { main: i === 0, root, sub: root !== real };
    bestLen = root.length;
  }
  return best;
}

function inScopeLine(shown: string, hit: ScopeHit): string {
  const owner = hit.main ? "主根" : `额外根 ${hit.root}`;
  const base = `已在当前工作范围内：${shown}（属于 ${owner}），未重复添加。`;
  return hit.sub ? `${base}要加载该目录的技能，请用 skills_extra_paths。` : base;
}

function listText(extras: readonly string[]): string {
  return extras.length > 0 ? extras.join("、") : "（无）";
}

/**
 * 续聊 / fork 时决定本次会话的额外根：
 *  - 主根与会话记录不同 → 等同换主根，不恢复，给一行说明（与 `/cd` 口径一致）；
 *  - 主根相同 → 恢复，缺失的跳过并提示；再和命令行 `--add-dir` 按 realpath 合并；
 *  - 新会话（无记录）不继承。
 */
export function settleSessionAdditionalDirs(opts: {
  mainCwd: string;
  recordedCwd: string | null;
  recordedDirs: readonly string[] | undefined;
  cliDirs: readonly string[];
}): { dirs: string[]; notices: string[] } {
  const notices: string[] = [];
  const dirs: string[] = [];
  const recorded = opts.recordedDirs ?? [];
  if (opts.recordedCwd !== null && recorded.length > 0) {
    if (opts.recordedCwd !== opts.mainCwd) {
      notices.push(
        `会话原主根 ${opts.recordedCwd} 与本次主根 ${opts.mainCwd} 不同，视同 /cd 换主根：` +
          `不恢复会话里的 ${recorded.length} 个额外工作根。`,
      );
    } else {
      const missing: string[] = [];
      for (const d of recorded) {
        const r = resolveAddDirPath(opts.mainCwd, d);
        if (!r.ok) missing.push(d);
        else if (!dirs.includes(r.path) && !scopeOf(r.path, opts.mainCwd, [])) dirs.push(r.path);
      }
      for (const m of missing) notices.push(`额外工作根 ${m} 已不存在，已跳过；其余 ${dirs.length} 个已恢复`);
    }
  }
  for (const d of opts.cliDirs) {
    const hit = scopeOf(d, opts.mainCwd, dirs);
    if (hit) {
      if (!dirs.includes(d) || hit.main) notices.push(inScopeLine(d, hit));
      continue;
    }
    dirs.push(d);
  }
  return { dirs, notices };
}

/** 主根 + 额外根的永久项目记忆（#54 指令文件）与 `.neo/rules` 常驻规则，形状同 `/cd` 的组装。 */
export function composeSessionProjectMemory(
  cfg: Pick<Config, "cwd" | "safeMode"> & { additionalDirs?: string[] },
): { path: string; text: string } | null {
  const fileMem = loadSessionInstructionMemory(cfg.cwd, {
    safeMode: cfg.safeMode === true,
    extraRoots: cfg.additionalDirs ?? [],
  });
  let alwaysOn = "";
  if (!cfg.safeMode) {
    try {
      alwaysOn = formatAlwaysOnRules(discoverProjectRules(cfg.cwd));
    } catch {
      alwaysOn = "";
    }
  }
  if (!fileMem && alwaysOn === "") return null;
  return { path: fileMem?.path ?? join(cfg.cwd, ".neo/rules"), text: `${fileMem?.text ?? ""}${alwaysOn}` };
}

/**
 * 换额外根后的刷新：cfg / 会话元数据（整表替换）→ 落盘 → `@` 索引 → 永久段 → 系统提示。
 * 不跑 beginUserTurn、不重打 SessionStart/Stop、不重开 rewind 记账。
 */
function applyAdditionalDirs(ctx: CommandContext, dirs: string[]): void {
  const { cfg, meta } = ctx;
  cfg.additionalDirs = [...dirs];
  if (dirs.length > 0) meta.additionalDirs = [...dirs];
  else delete meta.additionalDirs;
  ctx.persistSession?.(ctx.agent.messages, meta);
  ctx.fileIndex?.setRoots?.(cfg.cwd, dirs);
  ctx.promptManager?.setProjectMemory(composeSessionProjectMemory(cfg));
  ctx.promptManager?.invalidate();
  ctx.agent.refreshSystemPrompt();
  ctx.onStatusLineRefresh?.();
}

/** `/add-dir` 参数切词：空白分隔，支持 "…" / '…' 包住含空格的路径。 */
function splitArgs(arg: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(arg); m; m = re.exec(arg)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

function printRoots(ctx: CommandContext): void {
  const { ui, cfg } = ctx;
  const extras = cfg.additionalDirs ?? [];
  ui.blank();
  ui.kv("主根", cfg.cwd);
  if (extras.length === 0) ui.line(c.dim("  当前没有额外工作根（/add-dir <路径> 加入；/cd 换主根会清空额外根）"));
  else for (const d of extras) ui.line(`  ${c.dim("额外根")} ${d}`);
  ui.blank();
}

/** `/add-dir [路径…]` · `/add-dir --remove <路径…>` · `/add-dir`（列出）。 */
export async function handleAddDirCommand(arg: string, ctx: CommandContext): Promise<void> {
  const { ui, cfg } = ctx;
  const tokens = splitArgs(arg);
  if (tokens.length === 0) {
    printRoots(ctx);
    return;
  }
  const remove = tokens[0] === "--remove";
  const paths = remove ? tokens.slice(1) : tokens;
  const unknown = paths.find((t) => t.startsWith("--"));
  if (unknown !== undefined) {
    ui.warn(`/add-dir：未知选项 ${unknown}（只支持 --remove；不提供 --remember 等持久化选项），未做任何改动。`);
    return;
  }
  if (!ctx.persistSession || !ctx.promptManager) {
    ui.warn("当前入口不支持 /add-dir（缺会话接线）；用 --add-dir <路径> 启动时指定。");
    return;
  }
  if (remove) {
    removeDirs(paths, ctx);
    return;
  }
  const extras = [...(cfg.additionalDirs ?? [])];
  const added: string[] = [];
  let failed = 0;
  for (const raw of paths) {
    if (raw === "-") {
      ui.line(c.err(`✖ -：不支持 /add-dir -（- 是 /cd 的「回上一根」）`));
      failed += 1;
      continue;
    }
    const r = resolveAddDirPath(cfg.cwd, raw);
    if (!r.ok) {
      ui.line(c.err(`✖ ${raw}：${r.error}`));
      failed += 1;
      continue;
    }
    const hit = scopeOf(r.path, cfg.cwd, extras);
    if (hit) {
      ui.info(inScopeLine(raw, hit));
      continue;
    }
    extras.push(r.path);
    added.push(r.path);
    ui.success(`已加入额外工作根：${r.path}`);
  }
  if (added.length > 0) applyAdditionalDirs(ctx, extras);
  ui.line(`已加入 ${added.length} 个，失败 ${failed} 个；当前额外根：${listText(cfg.additionalDirs ?? [])}`);
}

function removeDirs(paths: string[], ctx: CommandContext): void {
  const { ui, cfg } = ctx;
  if (paths.length === 0) {
    ui.warn("用法：/add-dir --remove <路径> [路径…]（主根请用 /cd 切换）");
    return;
  }
  const extras = [...(cfg.additionalDirs ?? [])];
  const removed: string[] = [];
  let failed = 0;
  for (const raw of paths) {
    const expanded = expandHome(raw.trim(), homedir());
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cfg.cwd, expanded);
    let idx = -1;
    try {
      const real = realpathSync(abs);
      idx = extras.indexOf(real);
    } catch {
      idx = extras.indexOf(abs); // 目录已被删：按已记录的绝对路径匹配
    }
    if (idx < 0) {
      ui.warn(`${raw} 不在本会话额外根里（主根请用 /cd 切换）；当前额外根：${listText(extras)}`);
      failed += 1;
      continue;
    }
    const [gone] = extras.splice(idx, 1);
    removed.push(gone!);
    ui.success(`已移除额外工作根：${gone}`);
  }
  if (removed.length > 0) applyAdditionalDirs(ctx, extras);
  ui.line(`已移除 ${removed.length} 个，失败 ${failed} 个；当前额外根：${listText(cfg.additionalDirs ?? [])}`);
}

/**
 * `/context`：列出额外工作根，以及因额外根而加载的 #54 指令文件路径（永久段 + 本轮按需），
 * 只列路径不倒正文。safe-mode 下根照样列出，指令文件不加载。
 */
export function additionalRootsReport(
  cfg: Pick<Config, "cwd" | "safeMode"> & { additionalDirs?: string[] },
  activeNested: ReadonlyArray<{ path: string }>,
): string[] {
  const extras = cfg.additionalDirs ?? [];
  if (extras.length === 0) return ["额外工作根：无"];
  const lines = [`额外工作根：${extras.length} 个`, ...extras.map((d) => `  ${d}`)];
  if (cfg.safeMode) {
    lines.push("  额外根指令文件：未加载（safe-mode）");
    return lines;
  }
  const mainOnly = new Set((composePermanentMemory(cfg.cwd)?.files ?? []).map((f) => f.path));
  const perm = (composePermanentMemory(cfg.cwd, extras)?.files ?? []).filter((f) => !mainOnly.has(f.path));
  const nested = activeNested.filter((f) => extras.some((d) => isInsideOrSame(d, realish(f.path))));
  const files = [...new Set([...perm.map((f) => f.path), ...nested.map((f) => f.path)])];
  if (files.length === 0) lines.push("  因额外根加载的指令文件：无");
  else {
    lines.push(`  因额外根加载的指令文件 ${files.length} 个：`);
    for (const f of files) lines.push(`    ${f}`);
  }
  return lines;
}
