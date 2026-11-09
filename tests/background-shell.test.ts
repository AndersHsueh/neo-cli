/**
 * issue #28：后台长驻 shell。
 *
 * 覆盖：
 *  A `BackgroundShells`：启动/接管、输出与退出码、超时转后台不杀进程、kill、上限
 *  B `shell` 工具：background:true 立刻返回 id；前台超时转后台；前台正常路径输出格式不变
 *  C `shell_output` 工具：按 id 读状态与输出尾部；未知 id 明确报错
 *  D `/ps` 文案
 *
 * 用真实短命进程（sh -c '…'），跨平台用 sh（POSIX）；Windows 不在本仓基线（见 README 平台支持）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.ts";
import { TOOLS } from "../src/tools/index.ts";
import {
  BackgroundShells,
  backgroundShells,
  formatShellJobs,
  resetBackgroundShells,
  type ShellProc,
} from "../src/tools/backgroundShell.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-bg-shell-"));

let seq = 0;
function jobMeta(): { command: string; cwd: string } {
  seq += 1;
  return { command: `job-${seq}`, cwd: SANDBOX };
}

function ctx(): ToolCtx {
  return {
    cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => true,
  };
}

function tool(name: string) {
  const impl = TOOLS.find((t) => t.spec.function.name === name);
  if (!impl) throw new Error(`找不到工具 ${name}`);
  return impl;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  resetBackgroundShells({ max: 5 });
});

afterEach(() => {
  backgroundShells.killAll();
});

/* ------------------------------------------------------------------ */
/* A. 任务表                                                            */
/* ------------------------------------------------------------------ */

describe("A BackgroundShells 任务表", () => {
  test("start + wait：拿到输出与退出码；forget 后不在列表里", async () => {
    const bg = backgroundShells;
    const started = bg.start(["sh", "-c", "printf hi; printf err >&2; exit 3"], SANDBOX, {}, jobMeta());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("期望成功");
    const waited = await bg.wait(started.id, 5_000);
    expect(waited).toEqual({ exited: true, code: 3 });
    const view = bg.view(started.id)!;
    expect(view.out).toContain("hi");
    expect(view.err).toContain("err");
    expect(view.exitCode).toBe(3);
    expect(bg.output(started.id)).toContain("[stderr] err");
    bg.forget(started.id);
    expect(bg.view(started.id)).toBeNull();
  });

  test("超时：不杀进程，标记 timeout + promoted，之后仍可读输出", async () => {
    const bg = backgroundShells;
    const started = bg.start(["sh", "-c", "printf ready; sleep 5"], SANDBOX, {}, jobMeta());
    if (!started.ok) throw new Error("期望成功");
    const waited = await bg.wait(started.id, 50);
    expect(waited.exited).toBe(false);
    const view = bg.view(started.id)!;
    expect(view.status).toBe("timeout");
    expect(view.promoted).toBe(true);
    await flush();
    expect(bg.output(started.id)).toContain("ready");
    expect(bg.kill(started.id)).toBe(1);
    expect(bg.view(started.id)).toBeNull();
  });

  test("kill：杀掉运行中进程并标记 killed；kill('all') 全停", async () => {
    const bg = backgroundShells;
    const a = bg.start(["sh", "-c", "sleep 5"], SANDBOX, {}, jobMeta());
    const b = bg.start(["sh", "-c", "sleep 5"], SANDBOX, {}, jobMeta());
    if (!a.ok || !b.ok) throw new Error("期望成功");
    expect(bg.runningCount).toBe(2);
    expect(bg.kill(a.id)).toBe(1);
    expect(bg.view(a.id)).toBeNull();
    expect(bg.kill("all")).toBe(1);
    expect(bg.runningCount).toBe(0);
  });

  test("并发上限：超过直接拒绝，不排队", async () => {
    const bg = new BackgroundShells({ max: 2 });
    const a = bg.start(["sh", "-c", "sleep 5"], SANDBOX, {}, jobMeta());
    const b = bg.start(["sh", "-c", "sleep 5"], SANDBOX, {}, jobMeta());
    const c = bg.start(["sh", "-c", "sleep 5"], SANDBOX, {}, jobMeta());
    expect(a.ok && b.ok).toBe(true);
    expect(c.ok).toBe(false);
    if (c.ok) throw new Error("期望拒绝");
    expect(c.error).toContain("上限");
    bg.killAll();
  });

  test("接管外部进程（adopt）：输出从接管时刻开始累积", async () => {
    const bg = new BackgroundShells();
    const proc = Bun.spawn(["sh", "-c", "printf adopted; sleep 0.05"], {
      stdout: "pipe",
      stderr: "pipe",
    }) as unknown as ShellProc;
    const adopted = bg.adopt(proc, jobMeta());
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) throw new Error("期望成功");
    await bg.wait(adopted.id, 5_000);
    expect(bg.output(adopted.id)).toContain("adopted");
    bg.killAll();
  });
});

/* ------------------------------------------------------------------ */
/* B. shell 工具                                                        */
/* ------------------------------------------------------------------ */

describe("B shell 工具 background / 超时转后台", () => {
  test("background:true → 立刻返回 id；前台行为不变（命令 + 输出 + exit 码）", async () => {
    const out = await tool("shell").execute({ command: "printf ok", background: true }, ctx());
    expect(String(out)).toContain("后台命令已启动（id=sh-");
    expect(String(out)).toContain("shell_output");

    const fg = await tool("shell").execute({ command: "printf fg" }, ctx());
    const text = String(fg);
    expect(text).toContain("$ printf fg");
    expect(text).toContain("fg");
    expect(text).toContain("[exit 0]");
  });

  test("前台超时 → 转后台（不杀）、返回 id；随后 shell_output 能读", async () => {
    const out = String(
      await tool("shell").execute({ command: "sleep 3", timeout_ms: 1000 }, ctx()),
    );
    expect(out).toContain("已转入后台");
    const id = /id=(sh-\d+)/.exec(out)?.[1];
    expect(id).toBeTruthy();
    const view = backgroundShells.view(id!);
    expect(view?.status).toBe("timeout");
    const read = await tool("shell_output").execute({ id: id! }, ctx());
    expect(String(read)).toContain("超时已转后台");
    backgroundShells.kill(id!);
  });

  test("plan 模式/审批拒绝：与前台同口径（不启动进程）", async () => {
    const deniedCtx: ToolCtx = { ...ctx(), approve: async () => false };
    await expect(tool("shell").execute({ command: "true", background: true }, deniedCtx)).rejects.toThrow();
    expect(backgroundShells.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* C. shell_output                                                     */
/* ------------------------------------------------------------------ */

describe("C shell_output", () => {
  test("按 id 读输出尾部；未知 id 明确报错", async () => {
    const started = backgroundShells.start(
      ["sh", "-c", "for i in 1 2 3 4 5; do echo line$i; done; sleep 0.1"],
      SANDBOX,
      {},
      jobMeta(),
    );
    if (!started.ok) throw new Error("期望成功");
    await backgroundShells.wait(started.id, 5_000);
    const read = String(await tool("shell_output").execute({ id: started.id, tail_lines: 2 }, ctx()));
    expect(read).toContain("line5");
    expect(read).not.toContain("line1\n");
    expect(read).toContain("状态：已结束（exit 0）");

    await expect(tool("shell_output").execute({ id: "sh-999" }, ctx())).rejects.toThrow(/没有 id/);
  });
});

/* ------------------------------------------------------------------ */
/* D. /ps 文案                                                         */
/* ------------------------------------------------------------------ */

describe("D /ps 文案", () => {
  test("空列表给出口提示；有任务给 id/状态/耗时/命令", async () => {
    expect(formatShellJobs([]).join("\n")).toContain("没有后台命令");
    const started = backgroundShells.start(["sh", "-c", "sleep 1"], SANDBOX, {}, { command: "npm run dev", cwd: SANDBOX });
    if (!started.ok) throw new Error("期望成功");
    const text = formatShellJobs(backgroundShells.list()).join("\n");
    expect(text).toContain("运行中");
    expect(text).toContain("npm run dev");
    expect(text).toContain("/ps kill");
    backgroundShells.kill(started.id);
  });
});
