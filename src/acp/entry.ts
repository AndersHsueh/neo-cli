/**
 * `neo acp` 入口（issue #60）。
 *
 * 与 TUI / `-p` 互斥：`acp` 是独立入口，stdin/stdout 整条让给 ACP 协议，
 * 因此不接受 `-p`、`--output-format`、`--resume` 等会话级参数（PRD §2.1）。
 *
 * 互斥判定必须早于 bootstrap 里「stream-json 需要 -p」的校验 —— 否则
 * `neo acp --output-format stream-json` 会先被那条规则拦下，报出与 ACP 无关的错误。
 */
import type { Args } from "../cli/args.ts";
import { c } from "../ui/theme.ts";

/**
 * `acp` 子命令的用法错误判定。返回 null 表示可以进入 ACP 服务端。
 *
 * 只认「第一个位置参数是 acp」：`neo -p acp` 里的 acp 是提示词，不是子命令。
 */
export function acpUsageError(args: Args): string | null {
  if (args.rest[0] !== "acp") return null;
  const conflicts: string[] = [];
  if (args.print !== null) conflicts.push("-p/--print");
  if (args.outputFormat !== "text") conflicts.push("--output-format");
  if (args.resume !== null) conflicts.push("--resume");
  if (args.continueLast) conflicts.push("-c/--continue");
  if (args.listSessions) conflicts.push("--sessions");
  if (args.worktree !== null) conflicts.push("-w/--worktree");
  if (args.name !== null) conflicts.push("--name");
  if (args.model !== null) conflicts.push("-m/--model");
  if (args.provider !== null) conflicts.push("-P/--provider");
  if (args.tier !== null) conflicts.push("-t/--tier");
  if (args.auto !== null) conflicts.push("--auto");
  if (args.cwd !== null) conflicts.push("-C/--cwd");
  if (args.fallbackArgs.length > 0) conflicts.push("--fallback");
  if (args.noFallback) conflicts.push("--no-fallback");
  if (conflicts.length === 0) return null;
  return (
    `neo acp 不能与 ${conflicts.join(" / ")} 同时使用：` +
    "stdin/stdout 整条让给 ACP 协议，会话参数由编辑器在 session/new 里给出"
  );
}

/** 打印用法错误（stderr）并返回退出码 2。 */
export function reportAcpUsageError(message: string): number {
  process.stderr.write(c.err(`✖ ${message}`) + "\n");
  return 2;
}
