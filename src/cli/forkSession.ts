/** #65 signed session fork: data snapshot and same-process switch. No settings IO. */
import { applyRestored, createSession, hydrateMessages, saveSession, type SessionFile, type SessionMeta } from "../session.ts";
import type { Message } from "../llm.ts";
import type { CommandContext } from "./commandContext.ts";
import { chooseSessionName } from "../sessionName.ts";
import { mailboxRoot } from "../mailbox/types.ts";
import { cwdSwitchBusyReason } from "./cdWorkdir.ts";

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
  const messages = agent.messages.filter(m => m.role !== "system");
  meta.turns = messages.filter(m => m.role === "user").length;
  // Parent is saved at the fork point; child writes are independent thereafter.
  saveSession(messages, meta);
  const oldId = meta.id;
  const child = forkSession(meta, agent.messages, cfg.model, cfg.cwd);
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
  ctx.promptManager?.invalidate();
  agent.refreshSystemPrompt();
  await agent.runSessionStart("fork");
  ui.success(`已分叉 → ${meta.id}（源自 ${oldId}）`);
}
