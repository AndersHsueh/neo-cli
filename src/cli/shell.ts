/**
 * 用户输入的 `!cmd` 直通 shell。
 *
 * 权限必须与工具层的 approve 保持一致。判定在 agent/policy.ts，
 * 这里只负责询问和执行，避免 plan 模式出现第二条旁路。
 */
import { decidePermission } from "../agent/policy.ts";
import type { PermissionMode } from "../agent/types.ts";
import type { Config } from "../config.ts";
import { getShell, prepareShellInvocation, shellErrorHint } from "../shell.ts";
import type { Console } from "../ui/console.ts";
import { c } from "../ui/theme.ts";

export async function runShell(
  cmdline: string,
  cfg: Config,
  ui: Console,
  mode: PermissionMode,
): Promise<void> {
  const cmd = cmdline.trim();
  if (!cmd) return;

  const decision = decidePermission(mode, "shell");
  if (!decision.allow && decision.reason === "plan") {
    ui.warn(`plan 模式禁止执行 shell：${cmd}`);
    return;
  }
  if (!decision.allow) {
    const ok = await ui.confirm(`shell — 执行: ${cmd}`);
    if (!ok) {
      ui.info("已拒绝。");
      return;
    }
  }

  ui.blank();
  ui.line(`${c.dim("$")} ${c.text(cmd)}`);
  try {
    const spec = getShell(cfg);
    const invocation = prepareShellInvocation(spec, cmd);
    const proc = Bun.spawn(invocation.argv, {
      cwd: cfg.cwd,
      stdout: "inherit",
      stderr: "inherit",
      env: invocation.env,
    });
    const code = await proc.exited;
    if (code !== 0) ui.line(c.dim(`exit ${code}`));
  } catch (e) {
    ui.error(`执行失败: ${shellErrorHint(e, getShell(cfg))}`);
  }
  ui.blank();
}
