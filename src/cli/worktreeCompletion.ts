/**
 * #85：`/worktree create|enter|remove <name>` 的名字补全。
 * 只补 neo 托管的已有名字（.neo/worktrees/<name> + 分支 neo/<name>）；不在 git 仓里返回空表。
 */
import type { CompleteResult } from "../input/completion.ts";
import { detectRepo, listManaged } from "../worktree.ts";

export function completeWorktreeLine(line: string, cursor: number, sessionCwd: string): CompleteResult | null {
  const head = line.slice(0, Math.max(0, Math.min(cursor, line.length)));
  const m = /^\/worktree\s+(create|enter|remove|rm)\s+(\S*)$/i.exec(head);
  if (!m) return null;
  const prefix = m[2] ?? "";
  const start = head.length - prefix.length;
  const repo = detectRepo(sessionCwd);
  const names = repo.ok ? listManaged(repo.mainRoot).map((w) => w.name) : [];
  return { matches: names.filter((n) => n.startsWith(prefix)).sort(), token: prefix, start };
}
