/**
 * `/drive` 检查命令的唯一执行实现（issue #24 / #51）。
 *
 * 交互 `/drive` 与 `-p --drive` 都走这里，避免两份「shell 解析 + 60s 硬超时」
 * 各写一遍后漂移（#51 首版就是因为在 -p 分支内联了一份而被 Lead 打回）。
 */
import type { Config } from "./config.ts";
import type { DriveCheckResult } from "./drive.ts";
import { getShell, prepareShellInvocation } from "./shell.ts";

/** 检查命令硬超时：到点 kill -9，按未通过处理。 */
const CHECK_TIMEOUT_MS = 60_000;
/** 输出只留尾部这么多字符：给 judge 与 /drive 文案共用。 */
const OUTPUT_TAIL_CHARS = 800;

export async function runDriveCheck(cmd: string, cfg: Config): Promise<DriveCheckResult> {
  const shellSpec = getShell(cfg);
  const inv = prepareShellInvocation(shellSpec, cmd, {
    ...process.env,
    NO_COLOR: process.env.NO_COLOR ?? "1",
  });
  const proc = Bun.spawn(inv.argv, { cwd: cfg.cwd, stdout: "pipe", stderr: "pipe", env: inv.env });
  const timer = setTimeout(() => proc.kill(9), CHECK_TIMEOUT_MS);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { ok: code === 0, code, output: `${out}\n${err}`.trim().slice(-OUTPUT_TAIL_CHARS) };
}
