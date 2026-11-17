/**
 * issue #75 规格红测：终止必须按**进程组**，而不是只杀 shell 本身。
 *
 * 背景缺陷：
 *  A. `BackgroundShells.kill()/killAll()` 只 `proc.kill(9)` 杀 shell 本身，
 *     `sh -c` 派生的孙进程残留并继续写盘（前台 shell 被 abort 时同样如此）。
 *  B. `McpManager` 并行握手：快的已握手完成（还没 registerAll）、慢的还在握手时
 *     `closeAll()`，快的那个子进程既不在 live 也不在 connecting，残留。
 *
 * 时序纪律：**不靠固定 sleep 猜时序**。所有等待都是「落盘信号（pid / marker 文件）+ 轮询」，
 * pid 存活用 `process.kill(pid, 0)` 判定。孙进程命令统一形如
 *   `sh -c 'printf $$ > GC.pid; sleep 1.5; printf x > GC.after' & wait`
 * 外层 sh 被 kill(9) 后，孙进程（内层 sh）仍会在 1.5s 后写 GC.after —— 这就是红点。
 *
 * 本文件**只写规格**：除两条回归护栏外，在 HEAD（issue #75 未修）上应失败。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupEphemeral } from "../src/cleanup.ts";
import type { Config } from "../src/config.ts";
import { McpManager } from "../src/mcp/client.ts";
import type { McpStdioServerConfig } from "../src/config/types.ts";
import { TOOLS, toolNames } from "../src/tools/index.ts";
import { BackgroundShells, backgroundShells, resetBackgroundShells } from "../src/tools/backgroundShell.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-issue75-"));

afterEach(() => {
  resetBackgroundShells({ max: 5 });
});

/* ------------------------------------------------------------------ *
 * 落盘信号 + 轮询 helper（不靠固定 sleep 猜时序）
 * ------------------------------------------------------------------ */

/** pid 是否还活着（进程已退出 / 不存在 → false）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 从 pid 文件读进程号；文件不存在 / 内容非法 → null。 */
function readPid(file: string): number | null {
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, "utf8").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 轮询等文件出现（超时返回 false）。 */
async function waitForFile(file: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return existsSync(file);
}

/** 轮询等条件成立（超时返回 false）。 */
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

/** finally 兜底：杀掉测试里记下的残留 pid。 */
function killPid(pid: number | null): void {
  if (pid === null) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
}

/** 每个用例一个独立目录（避免 pid / after 文件互相覆盖）。 */
let seq = 0;
function caseDir(): string {
  seq += 1;
  const dir = join(SANDBOX, `c${seq}`);
  // mkdir -p 语义：父目录已存在不报错
  Bun.spawnSync(["mkdir", "-p", dir]);
  return dir;
}

/**
 * 派生孙进程的命令：外层 sh 起一个内层 sh（孙进程）并 `wait`。
 * 外层被 kill(9) 后，孙进程仍会在 1.5s 后写 `after` —— 这就是红点。
 */
function grandchildCommand(dir: string, tag: string): { command: string; pidFile: string; afterFile: string } {
  const pidFile = join(dir, `${tag}.pid`);
  const afterFile = join(dir, `${tag}.after`);
  const inner = `printf $$ > ${JSON.stringify(pidFile)}; sleep 1.5; printf x > ${JSON.stringify(afterFile)}`;
  return { command: `sh -c ${JSON.stringify(inner)} & wait`, pidFile, afterFile };
}

function ctx(signal?: AbortSignal): ToolCtx {
  return {
    cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => true,
    ...(signal ? { signal } : {}),
  };
}

function tool(name: string) {
  const impl = TOOLS.find((t) => t.spec.function.name === name);
  if (!impl) throw new Error(`找不到工具 ${name}`);
  return impl;
}

/* ------------------------------------------------------------------ *
 * A. BackgroundShells 按进程组终止
 * ------------------------------------------------------------------ */

describe("#75 BackgroundShells 按进程组终止", () => {
  test("#75 BackgroundShells.kill(id) 连同派生孙进程一起终止", async () => {
    const dir = caseDir();
    const gc = grandchildCommand(dir, "gc-kill");
    const bg = new BackgroundShells();
    let pid: number | null = null;
    try {
      const started = bg.start(["sh", "-c", gc.command], dir, process.env, { command: gc.command, cwd: dir });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error("期望成功");
      // 孙进程真的起来了（pid 落盘）再终止：否则「没杀到」无从断言。
      expect(await waitForFile(gc.pidFile, 5_000)).toBe(true);
      pid = readPid(gc.pidFile);
      expect(pid).not.toBeNull();

      expect(bg.kill(started.id)).toBe(1);
      // 进程已死就不可能再写盘，不必固定等 2.5s。若一直活着，超时后仍断言 after 不存在（红点是写盘，不是「pid 没死」）。
      await waitFor(() => !isAlive(pid as number), 2_000);
      expect(existsSync(gc.afterFile)).toBe(false);
      expect(isAlive(pid as number)).toBe(false);
    } finally {
      bg.killAll();
      killPid(pid);
    }
  }, 30_000);

  test("#75 BackgroundShells.killAll() 连同派生孙进程一起终止", async () => {
    const dir = caseDir();
    const gc = grandchildCommand(dir, "gc-killall");
    const bg = new BackgroundShells();
    let pid: number | null = null;
    try {
      const started = bg.start(["sh", "-c", gc.command], dir, process.env, { command: gc.command, cwd: dir });
      expect(started.ok).toBe(true);
      expect(await waitForFile(gc.pidFile, 5_000)).toBe(true);
      pid = readPid(gc.pidFile);
      expect(pid).not.toBeNull();

      bg.killAll();
      await waitFor(() => !isAlive(pid as number), 2_000);
      expect(existsSync(gc.afterFile)).toBe(false);
      expect(isAlive(pid as number)).toBe(false);
    } finally {
      bg.killAll();
      killPid(pid);
    }
  }, 30_000);

  test("#75 TUI cleanupEphemeral({ shells }) 路径终止派生孙进程", async () => {
    const dir = caseDir();
    const gc = grandchildCommand(dir, "gc-cleanup");
    const bg = new BackgroundShells();
    let pid: number | null = null;
    try {
      const started = bg.start(["sh", "-c", gc.command], dir, process.env, { command: gc.command, cwd: dir });
      expect(started.ok).toBe(true);
      expect(await waitForFile(gc.pidFile, 5_000)).toBe(true);
      pid = readPid(gc.pidFile);
      expect(pid).not.toBeNull();

      // TUI 退出路径（src/cleanup.ts）：只传 shells，其余依赖缺省。
      cleanupEphemeral({ shells: bg });
      await waitFor(() => !isAlive(pid as number), 2_000);
      expect(existsSync(gc.afterFile)).toBe(false);
      expect(isAlive(pid as number)).toBe(false);
    } finally {
      bg.killAll();
      killPid(pid);
    }
  }, 30_000);

  test("#75 已退出的进程组再 kill/killAll 不抛错", async () => {
    const dir = caseDir();
    const bg = new BackgroundShells();
    const started = bg.start(["sh", "-c", "exit 0"], dir, process.env, { command: "exit 0", cwd: dir });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("期望成功");
    // 等它真的结束（状态由 running 变为 exited），再重复终止。
    expect(await waitFor(() => bg.view(started.id)?.status === "exited", 5_000)).toBe(true);
    expect(() => bg.kill(started.id)).not.toThrow();
    expect(() => bg.killAll()).not.toThrow();
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * B. 前台 shell 被 abort
 * ------------------------------------------------------------------ */

describe("#75 前台 shell 被 abort 时按进程组终止", () => {
  test("#75 前台 shell 被 abort（ctx.signal）时派生孙进程一并终止", async () => {
    const dir = caseDir();
    const gc = grandchildCommand(dir, "gc-abort");
    const ctrl = new AbortController();
    let pid: number | null = null;
    try {
      const running = Promise.resolve(tool("shell").execute({ command: gc.command }, ctx(ctrl.signal)));
      expect(await waitForFile(gc.pidFile, 5_000)).toBe(true);
      pid = readPid(gc.pidFile);
      expect(pid).not.toBeNull();

      ctrl.abort();
      // resolve 或 reject 都接受：这里只关心「孙进程有没有被一起收掉」。
      await running.then(
        () => undefined,
        () => undefined,
      );
      await waitFor(() => !isAlive(pid as number), 2_000);
      expect(existsSync(gc.afterFile)).toBe(false);
      expect(isAlive(pid as number)).toBe(false);
    } finally {
      backgroundShells.killAll();
      killPid(pid);
    }
  }, 30_000);

  test("#75 前台 shell 输出捕获与退出码不受影响", async () => {
    const out = await tool("shell").execute({ command: "printf hello; printf err >&2; exit 3" }, ctx());
    const text = String(out);
    expect(text).toContain("hello");
    expect(text).toContain("err");
    expect(text).toContain("[exit 3]");
  }, 30_000);
});

/* ------------------------------------------------------------------ *
 * C. McpManager 并行握手 + closeAll
 * ------------------------------------------------------------------ */

/**
 * 假 stdio MCP server（bun 运行）。
 *
 * - 启动即把 pid 写进 `pidFile`，`setInterval` 保活并**忽略 stdin end**：
 *   否则父进程一死它自己就退，测不出 closeAll 有没有真的回收子进程。
 * - `answer=true`：正常回 initialize / tools/list，并在回完 tools/list 后写 `listedFile`。
 * - `answer=false`：永不回应（模拟慢 server 卡在握手）。
 */
function fakeMcpSource(pidFile: string, listedFile: string, answer: boolean, toolsJson = "[]"): string {
  return (
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
    `const answer = ${answer ? "true" : "false"};\n` +
    `setInterval(() => {}, 1 << 30);\n` +
    `process.stdin.on("error", () => {});\n` +
    `process.stdin.on("end", () => {});\n` +
    `let buf = "";\n` +
    `process.stdin.on("data", (chunk) => {\n` +
    `  buf += String(chunk);\n` +
    `  for (;;) {\n` +
    `    const nl = buf.indexOf("\\n");\n` +
    `    if (nl === -1) break;\n` +
    `    const line = buf.slice(0, nl).trim();\n` +
    `    buf = buf.slice(nl + 1);\n` +
    `    if (line === "") continue;\n` +
    `    let msg;\n` +
    `    try { msg = JSON.parse(line); } catch { continue; }\n` +
    `    if (msg.method === undefined || msg.id === undefined) continue;\n` +
    `    if (!answer) continue;\n` +
    `    if (msg.method === "initialize") {\n` +
    `      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "f", version: "0" } } }) + "\\n");\n` +
    `    } else if (msg.method === "tools/list") {\n` +
    `      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: ${toolsJson} } }) + "\\n");\n` +
    `      writeFileSync(${JSON.stringify(listedFile)}, "1");\n` +
    `    }\n` +
    `  }\n` +
    `});\n` +
    `process.stdin.resume();\n`
  );
}

function mcpServer(name: string, script: string): McpStdioServerConfig {
  return {
    name,
    transport: "stdio",
    command: process.execPath, // bun 本体：测试环境一定有，且不依赖 PATH
    args: [script],
    env: {},
    enabled: true,
  };
}

describe("#75 McpManager 并行握手断连回收", () => {
  test("#75 McpManager：一快一慢并行握手时 closeAll，两个 MCP 子进程都退出", async () => {
    const dir = caseDir();
    const fastPidFile = join(dir, "fast.pid");
    const slowPidFile = join(dir, "slow.pid");
    const fastListed = join(dir, "fast.listed");
    const fastScript = join(dir, "fast.ts");
    const slowScript = join(dir, "slow.ts");
    writeFileSync(fastScript, fakeMcpSource(fastPidFile, fastListed, true), "utf8");
    writeFileSync(slowScript, fakeMcpSource(slowPidFile, join(dir, "slow.listed"), false), "utf8");

    const m = new McpManager([mcpServer("fast", fastScript), mcpServer("slow", slowScript)], {
      connectTimeoutMs: 10_000,
    });
    let fastPid: number | null = null;
    let slowPid: number | null = null;
    try {
      // 不 await：closeAll 要发生在两个握手都还没结算的时候。
      void m.connectAll();
      expect(await waitForFile(fastPidFile, 10_000)).toBe(true);
      expect(await waitForFile(slowPidFile, 10_000)).toBe(true);
      // 快的已回完 tools/list（握手 promise 即将结算），慢的仍卡在 initialize。
      expect(await waitForFile(fastListed, 10_000)).toBe(true);
      fastPid = readPid(fastPidFile);
      slowPid = readPid(slowPidFile);
      expect(fastPid).not.toBeNull();
      expect(slowPid).not.toBeNull();
      // 让快的那个 handshake promise 结算（它此刻既不在 live、也不在 connecting）。
      await new Promise((r) => setTimeout(r, 100));

      m.closeAll();
      // 两个子进程都必须退出：慢的在 connecting 里，快的在「已握手未注册」的空档里。
      expect(await waitFor(() => !isAlive(fastPid as number), 2_000)).toBe(true);
      expect(await waitFor(() => !isAlive(slowPid as number), 2_000)).toBe(true);
    } finally {
      try {
        m.closeAll();
      } catch {
        /* 已关闭 */
      }
      killPid(fastPid);
      killPid(slowPid);
    }
  }, 40_000);

  /**
   * 覆盖测试（当前 HEAD 上即绿）：把 closed 检查单独钉住。
   *
   * 现有「一快一慢 closeAll」只断言子进程已死，而 closeAll 会顺手关掉仍在
   * `connecting` 里的已握手连接，所以单独删掉 registerAll 里的 `if (this.closed)`
   * 时那条仍绿（Leo 复审 M3）。本用例在握手已全部结算之后、registerAll 之前
   * 调用 closeAll，再等 connectAll 返回，断言不得注册工具、不得把 server 标成
   * connected。快的 tools/list 带一个真实工具：否则 toolCount 在错误注册时仍是 0。
   */
  test("#75 McpManager：closeAll 发生在握手已结算、registerAll 之前，不得注册工具、不得进入 live", async () => {
    const dir = caseDir();
    const fastPidFile = join(dir, "fast2.pid");
    const slowPidFile = join(dir, "slow2.pid");
    const fastListed = join(dir, "fast2.listed");
    const fastScript = join(dir, "fast2.ts");
    const slowScript = join(dir, "slow2.ts");
    const pingTool = '[{ "name": "ping", "description": "p", "inputSchema": { "type": "object", "properties": {} } }]';
    writeFileSync(fastScript, fakeMcpSource(fastPidFile, fastListed, true, pingTool), "utf8");
    writeFileSync(slowScript, fakeMcpSource(slowPidFile, join(dir, "slow2.listed"), false), "utf8");

    const m = new McpManager([mcpServer("fast", fastScript), mcpServer("slow", slowScript)], {
      connectTimeoutMs: 800,
    });
    let fastPid: number | null = null;
    let slowPid: number | null = null;
    try {
      const connecting = m.connectAll();
      expect(await waitForFile(fastPidFile, 10_000)).toBe(true);
      expect(await waitForFile(slowPidFile, 10_000)).toBe(true);
      expect(await waitForFile(fastListed, 10_000)).toBe(true);
      fastPid = readPid(fastPidFile);
      slowPid = readPid(slowPidFile);
      // 让快的 handshake promise 结算；慢的仍卡在 initialize，connectAll 还没走到 registerAll。
      await new Promise((r) => setTimeout(r, 100));
      m.closeAll();
      await connecting;
      expect(m.toolCount()).toBe(0);
      expect(m.statuses().find((st) => st.name === "fast")?.status).not.toBe("connected");
      expect(toolNames()).not.toContain("mcp__fast__ping");
    } finally {
      try {
        m.closeAll();
      } catch {
        /* 已关闭 */
      }
      killPid(fastPid);
      killPid(slowPid);
    }
  }, 40_000);
});

/* ------------------------------------------------------------------ *
 * 沙箱清理
 * ------------------------------------------------------------------ */

// 沙箱目录只在本文件用；进程退出时清掉（不写真实 ~/.neo）。
process.on("exit", () => {
  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* 尽力而为 */
  }
});
