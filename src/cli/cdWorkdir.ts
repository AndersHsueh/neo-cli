/**
 * issue #69：交互 `/cd` 切换本会话工作目录（保留对话）。
 *
 * 语义（拍板口径，详见 docs/cd-workdir-prd.md）：
 *  - 相对路径相对**当前会话 cfg.cwd**，不是 process.cwd()；支持 `~` / `~/x`；
 *  - 先 resolve 再 realpath，只存规范绝对路径（软链的逻辑路径不当根）；
 *  - 目标是文件 / 不存在 / 不可访问（含 realpath 失败）一律明确拒绝；空目录不是失败；
 *  - 同根（realpath 相同）= 成功且 unchanged，不刷新任何状态；
 *  - `-` 回到上一根；失败的 /cd 不写入上一根槽；
 *  - 先做完所有路径预检，再动会话状态；persist 属于成功条件；
 *  - 全程不调用 process.chdir（会话 cwd 是 cfg.cwd，进程 cwd 不动）。
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { CompleteResult } from "../input/completion.ts";
import type { Config } from "../config.ts";
import type { Message } from "../llm.ts";
import type { PromptManager } from "../prompt/manager.ts";
import type { ProjectRule } from "../rules/index.ts";
import { discoverProjectRules, formatAlwaysOnRules } from "../rules/index.ts";
import { loadSessionInstructionMemory, pickInstructionFile } from "./nestedAgents.ts";
import type { SessionMeta } from "../session.ts";
import { completeWorktreeLine } from "./worktreeCompletion.ts";

/** `~` 前缀（`~` 本身或 `~/...`；`~user` 不展开）。 */
function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return join(home, raw.slice(2));
  return raw;
}

/**
 * 解析 `/cd` 目标：相对当前会话 cwd，`~` 展开，最终只返回 realpath。
 * 非目录 / 不存在 / 无权限（含 realpath 失败）都返回可读错误。
 */
export function resolveCdTarget(
  currentCwd: string,
  raw: string,
  opts: { home?: string } = {},
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, error: "目标路径为空" };
  const home = opts.home ?? homedir();
  const expanded = expandHome(trimmed, home);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(currentCwd, expanded);

  let real: string;
  try {
    real = realpathSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, error: `目录不存在：${abs}` };
    if (code === "EACCES" || code === "EPERM") return { ok: false, error: `没有访问权限：${abs}` };
    return { ok: false, error: `无法解析路径 ${abs}：${(e as Error).message}` };
  }
  try {
    if (!statSync(real).isDirectory()) return { ok: false, error: `不是目录：${real}` };
  } catch (e) {
    return { ok: false, error: `无法访问 ${real}：${(e as Error).message}` };
  }
  return { ok: true, path: real };
}

/**
 * 换根前的忙碌判定（issue #69 拍板 9）：飞行中的后台子代理、wiki worker、
 * 本轮用户 turn / 工具循环期间都不允许换根 —— 它们各自持有旧根的路径上下文。
 * 空闲、以及 done / interrupted 的后台任务返回 null。
 */
export function cwdSwitchBusyReason(opts: {
  turnActive?: boolean;
  wikiRunning?: boolean;
  backgroundTasks?: Array<{ status: string; kind?: string }>;
}): string | null {
  if (opts.turnActive) return "本轮 turn / 工具循环正在进行，不能切换工作目录（等这一轮结束再 /cd）";
  if (opts.wikiRunning) return "后台 wiki worker 正在运行，不能切换工作目录（等它结束再 /cd）";
  const running = (opts.backgroundTasks ?? []).filter((t) => t.status === "running");
  if (running.length > 0) {
    const wiki = running.filter((t) => t.kind === "wiki").length;
    const tasks = running.length - wiki;
    const parts: string[] = [];
    if (tasks > 0) parts.push(`后台子代理任务 ${tasks} 个`);
    if (wiki > 0) parts.push(`wiki 任务 ${wiki} 个`);
    return `${parts.join("、")}正在运行，不能切换工作目录（/tasks 查看进度，或等它们结束）`;
  }
  return null;
}

export interface PreviousCwdSlot {
  get(): string | null;
  set(value: string | null): void;
}

/**
 * 换根依赖。除 cfg/meta/messages/persist/promptManager 外都可选：
 * 没注入的侧状态 = 本入口没有它（`-p` / 测试裸 ctx），不是「跳过刷新」的借口。
 */
export interface CwdSwitchDeps {
  cfg: Config;
  meta: SessionMeta;
  messages: Message[];
  persist: (messages: Message[], meta: SessionMeta) => void;
  promptManager: PromptManager;
  refreshSystemPrompt: () => void;
  previousCwd: PreviousCwdSlot;
  fileIndex?: { setCwd: (cwd: string) => void; setRoots?: (cwd: string, extraRoots: readonly string[]) => void };
  memory?: { setCwd: (cwd: string) => void };
  mailbox?: { setCwd: (cwd: string) => void } | null;
  checkpoints?: { rebind: (cwd: string) => void };
  replaceRules?: (cwd: string, rules: ProjectRule[]) => void;
  busyReason?: string | null;
  restartLsp?: (cfg: Config) => void | Promise<void>;
  /** `~` 展开用的 home（测试注入；缺省 os.homedir()）。 */
  home?: string;
  /** #57：主根变化后刷新自定义状态区。 */
  onStatusLineRefresh?: () => void;
}

export type CwdSwitchResult =
  | { ok: true; cwd: string; unchanged: boolean; warnings?: string[]; clearedAdditionalDirs?: string[] }
  | { ok: false; error: string };

/**
 * 新根目录上的那一个项目指令文件：AGENTS.md → NEO.md → .neo.md → CLAUDE.md。
 * 祖先链与永久段组装见 loadSessionInstructionMemory（issue #54）。
 * `.neo/rules` 的 always-on 规则由 replaceRules 侧负责。
 */
export function readRootMemoryFile(cwd: string): { path: string; text: string } | null {
  const file = pickInstructionFile(cwd);
  return file ? { path: file.path, text: file.text } : null;
}

/** 新根的路径作用域规则（`.neo/rules`，不遍历上级、不按需加载子目录 AGENTS.md）。 */
function discoverRulesFor(cwd: string): ProjectRule[] {
  try {
    return discoverProjectRules(cwd);
  } catch {
    return [];
  }
}

/**
 * 换根主流程。顺序刻意固定：
 *  1. 忙碌判定 → 2. 解析目标（含 `-`）→ 3. 同根短路 → 4. 预检新根记忆文件
 *  → 5. 改 cfg/meta → 6. persist（失败即回滚）→ 7. 必做改挂（失败即回滚 + 回写磁盘）
 *  → 8. 上一根槽 → 9. 重建 messages[0] → 10. LSP 重启（失败只警告）。
 *
 * 任何一步失败，cfg/meta/磁盘/FileIndex/记忆/规则/检查点/上一根槽都停在旧根。
 */

function currentProjectMemory(pm: PromptManager): { path: string; text: string } | null {
  const mem = pm.getProjectMemory();
  if (!mem) return null;
  return { path: mem.path, text: mem.text };
}

export async function changeSessionCwd(arg: string, deps: CwdSwitchDeps): Promise<CwdSwitchResult> {
  const { cfg, meta, messages } = deps;

  if (deps.busyReason) return { ok: false, error: deps.busyReason };

  const oldCwd = cfg.cwd;
  const raw = arg.trim();
  if (raw === "") return { ok: false, error: "用法：/cd <目录> · /cd -（回上一根）· /cd（看当前）" };

  let targetRaw = raw;
  if (raw === "-") {
    const prev = deps.previousCwd.get();
    if (!prev) return { ok: false, error: "没有上一根可回（本会话还没成功切换过工作目录）" };
    targetRaw = prev;
  }

  const resolved = resolveCdTarget(oldCwd, targetRaw, deps.home ? { home: deps.home } : {});
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const target = resolved.path;

  // 同根：成功但什么都不刷新（不 persist、不改上一根、不改挂）。
  if (target === oldCwd) return { ok: true, cwd: target, unchanged: true };

  // 预检：新根的项目记忆（cwd 文件 + git 祖先，#54）与规则先读出来。
  const fileMem = loadSessionInstructionMemory(target, { safeMode: cfg.safeMode });
  const newRules = discoverRulesFor(target);
  const alwaysOnText = formatAlwaysOnRules(newRules);
  const newMemory =
    fileMem || alwaysOnText !== ""
      ? {
          path: fileMem?.path ?? join(target, ".neo/rules"),
          text: `${fileMem?.text ?? ""}${alwaysOnText}`,
        }
      : null;

  const oldMetaCwd = meta.cwd;
  // #63：成功换主根清空本会话全部额外根（含启动 --add-dir）；任何失败都恢复原表。
  const oldExtras = cfg.additionalDirs ?? [];
  const oldMetaExtras = meta.additionalDirs;
  const restoreExtras = (): void => {
    cfg.additionalDirs = oldExtras;
    if (oldMetaExtras === undefined) delete meta.additionalDirs;
    else meta.additionalDirs = oldMetaExtras;
  };
  const oldMemory = currentProjectMemory(deps.promptManager);
  const undos: Array<() => void> = [];

  const rollbackLive = (): void => {
    for (const undo of undos.reverse()) {
      try {
        undo();
      } catch {
        /* 尽力恢复，不掩盖原错误 */
      }
    }
    cfg.cwd = oldCwd;
    meta.cwd = oldMetaCwd;
    restoreExtras();
    deps.promptManager.setProjectMemory(oldMemory);
    deps.promptManager.invalidate();
    try {
      deps.refreshSystemPrompt();
    } catch {
      /* 回滚时系统提示刷新失败不掩盖原错误 */
    }
    try {
      deps.persist(messages, meta);
    } catch {
      /* 回写失败只能留给用户看到；不抛，避免掩盖原始错误 */
    }
  };

  cfg.cwd = target;
  meta.cwd = target;
  cfg.additionalDirs = [];
  delete meta.additionalDirs;

  try {
    deps.persist(messages, meta);
  } catch (e) {
    cfg.cwd = oldCwd;
    meta.cwd = oldMetaCwd;
    restoreExtras();
    return { ok: false, error: `会话落盘失败，工作目录未切换：${(e as Error).message}` };
  }

  try {
    if (deps.fileIndex) {
      deps.fileIndex.setCwd(target);
      undos.push(() => {
        deps.fileIndex?.setCwd(oldCwd);
        if (oldExtras.length > 0) deps.fileIndex?.setRoots?.(oldCwd, oldExtras);
      });
    }
    if (deps.memory) {
      deps.memory.setCwd(target);
      undos.push(() => deps.memory?.setCwd(oldCwd));
    }
    if (deps.checkpoints) {
      deps.checkpoints.rebind(target);
      undos.push(() => deps.checkpoints?.rebind(oldCwd));
    }
    if (deps.replaceRules) {
      deps.replaceRules(target, newRules);
      undos.push(() => deps.replaceRules?.(oldCwd, discoverRulesFor(oldCwd)));
    }
    if (deps.mailbox) {
      deps.mailbox.setCwd(target);
      undos.push(() => deps.mailbox?.setCwd(oldCwd));
    }
    deps.promptManager.setProjectMemory(newMemory);
    deps.promptManager.invalidate();
    deps.refreshSystemPrompt();
  } catch (e) {
    rollbackLive();
    return { ok: false, error: `切换工作目录失败（已回滚）：${(e as Error).message}` };
  }

  deps.previousCwd.set(oldCwd);

  // 语言服务器重启失败只警告，不回滚已成功的换根。
  // 必须在返回前 await，否则 rejected Promise 进不了 result.warnings，
  // 命令处理里的 ui.warn 也看不到。
  const warnings: string[] = [];
  if (deps.restartLsp) {
    try {
      await deps.restartLsp(cfg);
    } catch (e) {
      warnings.push(`LSP 重启失败（已忽略）：${(e as Error).message}`);
    }
  }

  const result = {
    ok: true as const,
    cwd: target,
    unchanged: false as const,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(oldExtras.length > 0 ? { clearedAdditionalDirs: [...oldExtras] } : {}),
  };
  deps.onStatusLineRefresh?.();
  return result;
}

/** 补全时跳过的目录（只做最简单的两个，不做复杂忽略）。 */
const SKIP_COMPLETION_DIRS = new Set(["node_modules", ".git"]);

/**
 * `/cd ` 之后的最小目录补全：只列 prefix 所在目录的**这一层**子目录。
 * 不递归、不列文件；prefix 相对 sessionCwd（`~` 也支持）。
 * 返回用于替换参数的路径字符串（保留用户已打的目录前缀）。
 */
export function listCdCompletions(sessionCwd: string, prefix: string, limit = 50): string[] {
  const max = Math.max(0, limit);
  if (max === 0) return [];
  const raw = prefix;
  const slash = raw.lastIndexOf("/");
  const dirPart = slash === -1 ? "" : raw.slice(0, slash + 1);
  const namePart = slash === -1 ? raw : raw.slice(slash + 1);

  const home = homedir();
  const baseDir = dirPart === "" ? sessionCwd : resolve(sessionCwd, expandHome(dirPart, home));

  let names: string[];
  try {
    names = readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .filter((e) => !SKIP_COMPLETION_DIRS.has(e.name))
      .filter((e) => e.name.startsWith(namePart))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const name of names) {
    if (out.length >= max) break;
    const full = join(baseDir, name);
    // 软链只在确实指向目录时才算候选（不递归，只 stat 这一层）。
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(`${dirPart}${name}/`);
  }
  return out;
}

/** `/cd` 无参与成功/失败提示共用的展示：把 home 缩成 `~`，长路径只留末两段。 */
export function formatCwdForDisplay(cwd: string, home = homedir()): string {
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
  return cwd;
}

/** 上一根槽的默认实现（会话闭包持有）。 */
export function makePreviousCwdSlot(initial: string | null = null): PreviousCwdSlot {
  let value = initial;
  return {
    get: () => value,
    set: (v) => {
      value = v;
    },
  };
}

/**
 * 行内 `/cd <prefix>` 的补全结果；不是 `/cd` 参数上下文则返回 null。
 * #63：`/add-dir` 同类（只补目录、相对会话主根），补的是最后一个路径参数。
 */
export function completeCdLine(line: string, cursor: number, sessionCwd: string, limit?: number): CompleteResult | null {
  const head = line.slice(0, Math.max(0, Math.min(cursor, line.length)));
  const m = /^\/(cd|add-dir)(\s+)(.*)$/.exec(head);
  // #85：/worktree create|enter|remove 补托管名字（同一个行内补全入口）。
  if (!m) return completeWorktreeLine(line, cursor, sessionCwd);
  let prefix = m[3] ?? "";
  let start = m[0].length - prefix.length;
  if (m[1] === "add-dir") {
    const cut = prefix.lastIndexOf(" ");
    if (cut >= 0) {
      start += cut + 1;
      prefix = prefix.slice(cut + 1);
    }
  }
  return { matches: listCdCompletions(sessionCwd, prefix, limit), token: prefix, start };
}
