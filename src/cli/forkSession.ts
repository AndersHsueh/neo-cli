/** #65 signed session fork: data snapshot and same-process switch. No settings IO. */
import { applyRestored, createSession, hydrateMessages, saveSession, type SessionFile, type SessionMeta } from "../session.ts";
import type { Message } from "../llm.ts";
import type { CommandContext } from "./commandContext.ts";
import { chooseSessionName } from "../sessionName.ts";
import { mailboxRoot } from "../mailbox/types.ts";
import { cwdSwitchBusyReason } from "./cdWorkdir.ts";
import { composeSessionProjectMemory, settleSessionAdditionalDirs } from "./additionalDirs.ts";
import { canonicalize } from "../worktree.ts";
import { forkWorktreeBinding } from "./sessionWorktree.ts";

export function forkBusyReason(opts: {
  turnActive?: boolean;
  wikiRunning?: boolean;
  backgroundTasks?: Array<{ status: string; kind?: string }>;
  shells?: Array<{ status: string }>;
  loopRunning?: boolean;
  driveRunning?: boolean;
}): string | null {
  const busy = cwdSwitchBusyReason(opts);
  if (busy) return `${busy}；请先结束或查看 /tasks。`;
  if (opts.shells?.some(s => s.status === "running")) return "后台 shell 正在运行，请先结束或查看 /ps。";
  if (opts.loopRunning) return "/loop 仍在调度，请先 /loop stop。";
  if (opts.driveRunning) return "/drive 仍在调度，请先 /drive stop。";
  return null;
}

/** Pure copy boundaries + explicit session/attachment persistence. Never walks mail or backups. */
export function forkSession(parent: SessionMeta, messages: Message[], model: string, cwd: string): SessionFile {
  const meta = createSession(model, cwd).meta;
  meta.forkedFrom = parent.id;
  if (parent.outputStyle !== undefined) meta.outputStyle = parent.outputStyle;
  if (parent.todos) meta.todos = structuredClone(parent.todos);
  // #63：主根不变才拷贝额外根；主根变了按换主根口径不带过去（缺失路径由宿主按 resume 办法跳过）。
  // #85：主根比较先 canonicalize（软链写法的同一主根也算不变）。
  if (parent.additionalDirs && parent.additionalDirs.length > 0 && canonicalize(parent.cwd) === canonicalize(cwd)) {
    meta.additionalDirs = [...parent.additionalDirs];
  }
  // #85：父会话停在某托管树里 → 子会话共用这棵树并拷贝隔离绑定（#65 不新建树）。
  const binding = forkWorktreeBinding(parent, cwd);
  if (binding) meta.worktree = binding;
  if (parent.rewind) meta.rewind = structuredClone(parent.rewind).map(r => ({ ...r, checkpointSeqs: [],
    messagesBefore: messages[0]?.role === "system"
      ? 1 + messages.slice(0, r.messagesBefore).filter(m => m.role !== "system").length
      : r.messagesBefore,
  }));
  if (parent.backgroundTasks) meta.backgroundTasks = structuredClone(parent.backgroundTasks).map(j => ({
    ...j, status: j.status === "running" ? "interrupted" : j.status,
  }));
  const copy = structuredClone(hydrateMessages(messages.filter(m => m.role !== "system")));
  meta.turns = copy.filter(m => m.role === "user").length;
  saveSession(copy, meta);
  return { version: 1, meta, messages: copy };
}

export async function handleFork(arg: string, ctx: CommandContext): Promise<void> {
  const { agent, cfg, meta, ui } = ctx;
  if (arg) { ui.warn("用法：/fork（不接受名字或 prompt）"); return; }
  const busy = forkBusyReason({
    turnActive: typeof ctx.turnActive === "function" ? ctx.turnActive() : ctx.turnActive,
    wikiRunning: ctx.wikiMaintainer?.running,
    backgroundTasks: ctx.tasks?.list(), shells: ctx.shells?.list(),
    loopRunning: ctx.loopRunning?.(), driveRunning: ctx.driveRunning?.(),
  });
  if (busy) { ui.warn(`无法分叉：${busy}`); return; }
  ctx.prepareFork?.();
  if (ctx.todos) meta.todos = structuredClone(ctx.todos());
  if (cfg.outputStyle !== undefined) meta.outputStyle = cfg.outputStyle;
  // #63：同进程 /fork 主根不变，额外根取本会话当前值（与 todos 同理先同步进父 meta）。
  const liveDirs = cfg.additionalDirs ?? [];
  if (liveDirs.length > 0) meta.additionalDirs = [...liveDirs];
  else delete meta.additionalDirs;
  const messages = agent.messages.filter(m => m.role !== "system");
  meta.turns = messages.filter(m => m.role === "user").length;
  // Parent is saved at the fork point; child writes are independent thereafter.
  saveSession(messages, meta);
  const oldId = meta.id;
  const child = forkSession(meta, agent.messages, cfg.model, cfg.cwd);
  const settled = settleSessionAdditionalDirs({ mainCwd: cfg.cwd, recordedCwd: cfg.cwd, recordedDirs: liveDirs, cliDirs: [] });
  if (settled.dirs.length > 0) child.meta.additionalDirs = settled.dirs;
  else delete child.meta.additionalDirs;
  let name: string | undefined;
  if (ctx.mailbox) name = ctx.mailbox.fork(child.meta.id, cfg.cwd, agent.mode).name ?? undefined;
  else name = chooseSessionName({ root: mailboxRoot() })?.name;
  // Keep object identity: all persistence callbacks close over this same meta.
  for (const key of Object.keys(meta)) delete (meta as unknown as Record<string, unknown>)[key];
  Object.assign(meta, child.meta);
  agent.messages = applyRestored(agent.messages[0], child.messages);
  agent.opt.sessionId = meta.id;
  ctx.memory.setSessionId(meta.id);
  ctx.checkpoints?.fork(meta.id);
  ctx.onMailboxRekey?.();
  ctx.onFork?.();
  if (name) {
    ctx.onNameChange?.(name);
    ctx.promptManager?.setSessionName(name);
  }
  if (settled.dirs.length !== liveDirs.length) {
    cfg.additionalDirs = settled.dirs;
    ctx.fileIndex?.setRoots?.(cfg.cwd, settled.dirs);
    ctx.promptManager?.setProjectMemory(composeSessionProjectMemory(cfg));
    saveSession(child.messages, meta);
  }
  for (const n of settled.notices) ui.warn(n);
  ctx.promptManager?.invalidate();
  agent.refreshSystemPrompt();
  await agent.runSessionStart("fork");
  ui.success(`已分叉 → ${meta.id}（源自 ${oldId}）${meta.worktree ? `，与父会话共用 worktree ${meta.worktree.name}` : ""}`);
  if (meta.worktree) ui.line(`  两个会话会在同一棵树里写（${meta.worktree.path}）；/fork 不新建 worktree。`);
}
