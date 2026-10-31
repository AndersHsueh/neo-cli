/**
 * 会话落盘、历史列表、恢复后的只读回放。
 *
 * 从入口拆出，是为了让 REPL 和单次模式共用同一套落盘规则。
 */
import type { Agent } from "../agent.ts";
import type { Config } from "../config.ts";
import type { Message } from "../llm.ts";
import { sessionLiveness } from "../mailbox/identity.ts";
import { mailboxRoot } from "../mailbox/types.ts";
import { listSessions, saveSession, type SessionMeta } from "../session.ts";
import { formatTokens } from "../tui/status.ts";
import type { Console } from "../ui/console.ts";
import { c } from "../ui/theme.ts";
import { transcriptLines } from "../ui/transcript.ts";
import { tierDisplayName } from "../config.ts";

export function persist(messages: Message[], meta: SessionMeta): void {
  try {
    const copy = messages.filter((m) => m.role !== "system");
    meta.turns = copy.filter((m) => m.role === "user").length;
    saveSession(copy, meta);
  } catch {
    // 落盘失败不打断交互
  }
}

/**
 * 回放最近几轮对话（v0.2.3 D4）。
 * 只在交互 TTY 下打印 —— `-p` / 管道场景回放会污染 stdout 的可解析性。
 */
export function replayTranscript(ui: Console, messages: Message[], turns = 3): void {
  if (process.stdout.isTTY !== true) return;
  const lines = transcriptLines(messages, { turns, width: ui.width });
  if (lines.length === 0) return;
  ui.blank();
  ui.info("以下为最近几轮对话回放（只读，不重新发送）：");
  for (const l of lines) ui.line(l);
  ui.blank();
}

export function showStats(
  ui: Console,
  agent: Agent,
  cfg: Config,
  stats: {
    durationMs: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    toolCalls: number;
    finishReason: string | null;
    aborted: boolean;
    tierSwitch: { from: string; to: string; reason: string; degraded?: string } | null;
  },
): void {
  const cum = agent.cumulative;
  const usage = agent.contextUsage();
  // v0.3.0：TTY 已有常驻状态条，轮末只补一行「本轮摘要」，不再打印三行状态栏。
  if (ui.hasLiveDock) {
    ui.line(
      c.dim(
        `· 本轮 ${(stats.durationMs / 1000).toFixed(1)}s · ` +
          `${formatTokens(stats.promptTokens)}↑ ${formatTokens(stats.completionTokens)}↓ · ` +
          `${stats.toolCalls} tools · ctx ${(usage * 100).toFixed(0)}% · ` +
          `total ${formatTokens(cum.prompt)}↑ ${formatTokens(cum.completion)}↓`,
      ),
    );
    return;
  }
  ui.statusBar([
    ["model", `${cfg.providerName}/${cfg.model}`],
    ["tier", tierDisplayName(cfg.modelTier)],
    ["stop", String(stats.finishReason ?? "stop")],
    ["tok", `${stats.promptTokens}↑ ${stats.completionTokens}↓`],
    ["think", String(stats.reasoningTokens)],
    ["tools", String(stats.toolCalls)],
    ["ctx", `${(usage * 100).toFixed(1)}%`],
    ["msgs", String(agent.historyLength)],
    ["$", (stats.durationMs / 1000).toFixed(2) + "s"],
    ["total", `${cum.prompt}↑ ${cum.completion}↓`],
  ]);
}

export interface PrintSessionsOpts {
  root?: string;
  deadAfterMs?: number;
  currentId?: string;
}

export function printSessions(ui: Console, opts: PrintSessionsOpts = {}): void {
  const root = opts.root ?? mailboxRoot();
  const deadAfterMs = opts.deadAfterMs;
  const all = listSessions(50);
  const runningOther = all.filter(
    (s) => s.id !== opts.currentId && sessionLiveness(root, s.id, { deadAfterMs }) === "running",
  );
  const runningIds = new Set(runningOther.map((r) => r.id));
  const available = all.filter((x) => x.id !== opts.currentId && !runningIds.has(x.id));
  const list = available.slice(0, 15);
  ui.blank();
  if (list.length === 0) {
    if (runningOther.length > 0) ui.info("没有可恢复的会话（运行中的会话不列出）。");
    else ui.info("还没有历史会话。");
  } else {
    ui.kv("历史会话", String(list.length));
    for (const s of list) {
      const failed = s.lastTurn && s.lastTurn.outcome !== "ok" ? c.warn(" ⚠") : "";
      ui.line(
        `  ${c.accent(s.id)} ${c.dim(s.updatedAt.slice(0, 16).replace("T", " "))} ` +
          `${c.muted(`${s.turns} 轮`)} ${c.dim(s.model)}${failed}`,
      );
    }
    ui.line(c.dim("  用 /resume <id> 或 neo --resume <id> 恢复"));
  }
  if (runningOther.length > 0) {
    ui.line(c.dim(`  另有 ${runningOther.length} 个运行中会话未列出（/peers 查看）`));
  }
  ui.blank();
}
