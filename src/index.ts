#!/usr/bin/env bun
/**
 * neo 组合根：解析参数、组装会话、跑 REPL。
 *
 * 斜杠命令在 cli/commands.ts，shell 直通在 cli/shell.ts，
 * 会话落盘在 cli/sessions.ts，Agent 循环在 agent/loop.ts。
 * 这里只负责把它们接起来。新增命令不要改本文件。
 */
import { homedir } from "node:os";
import { rule } from "./ui/theme.ts";
import { bootstrap } from "./cli/bootstrap.ts";
import { startSession } from "./cli/sessionStart.ts";
import { runOneshotOrPiped } from "./cli/oneshot.ts";
import { runInteractive } from "./cli/inputLayer.ts";

async function main(): Promise<number> {
  const boot = await bootstrap();
  if (typeof boot === "number") return boot;
  const s = await startSession(boot);
  const oneshot = await runOneshotOrPiped(s);
  if (oneshot !== null) return oneshot;
  return await runInteractive(s);
}

const code = await main();
void homedir;
void rule;
process.exit(code);
