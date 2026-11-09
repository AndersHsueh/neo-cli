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

/** 一次 shell 直通的授权结果。 */
export type ShellVerdict = "allow" | "deny" | "plan";

/**
 * 只做授权，不执行。拆出来是为了让 TUI 能在**挂起输入框之前**把确认框画出来。
 *
 * 背景（issue #34）：`runShellWithTui` 先 `composer.suspend()` 再调 runShell，而 ask 模式下
 * runShell 里的 `ui.confirm` 需要 composer 画确认框 —— suspend 之后 composer 不再渲染，
 * 确认框永远不出现、按键也不会进 composer，于是**死锁**（表面现象像「跑完 shell 后输入失效」，
 * 其实 shell 从没执行过）。所以授权必须发生在挂起之前。
 */
export async function authorizeShell(
  cmdline: string,
  ui: Console,
  mode: PermissionMode,
): Promise<ShellVerdict> {
  const cmd = cmdline.trim();
  if (!cmd) return "allow";
  const decision = decidePermission(mode, "shell");
  if (!decision.allow && decision.reason === "plan") return "plan";
  if (!decision.allow) {
    const ok = await ui.confirm(`shell — 执行: ${cmd}`);
    return ok ? "allow" : "deny";
  }
  return "allow";
}

/** 真正执行（授权已通过）；stdout/stderr 交给当前 tty。 */
export async function executeShell(cmdline: string, cfg: Config, ui: Console): Promise<void> {
  const cmd = cmdline.trim();
  if (!cmd) return;
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

/** 非 TUI 路径：授权 + 执行一步到位（行为与拆分前完全一致）。 */
export async function runShell(
  cmdline: string,
  cfg: Config,
  ui: Console,
  mode: PermissionMode,
): Promise<void> {
  const cmd = cmdline.trim();
  if (!cmd) return;
  const verdict = await authorizeShell(cmd, ui, mode);
  if (verdict === "plan") {
    ui.warn(`plan 模式禁止执行 shell：${cmd}`);
    return;
  }
  if (verdict === "deny") {
    ui.info("已拒绝。");
    return;
  }
  await executeShell(cmd, cfg, ui);
}
