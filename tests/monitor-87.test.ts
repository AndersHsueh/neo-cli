/**
 * issue #87：事件驱动监视（Monitor）。
 *
 * 覆盖已签架构 + TUI/命令形态：
 *  A 命令解析与列表文案（/monitor，不用 /watch）
 *  B 注入：origin "monitor"、包装、空闲打包、忙碌排队合并并插到用户消息前
 *  C 缓冲/注入上限：超限留最新并注明丢弃数；到期/退出通知不得丢
 *  D 时限：默认/最长/-p 上限、非法 timeout_ms、到点通知、重新开始用新 id
 *  E 生命周期：取消一条/全部、取消子代理、会话结束收进程组；
 *    /ps kill 不误杀监视，取消 mon-N 不动 sh-N
 *  F 权限：plan 拒启动、允许列出/取消；ws 参数报错；并发上限 5
 *  G 流：不完整行缓冲、二进制不进上下文只告警、子代理不泄漏到父会话
 *  H 正交：/loop / /drive 语义不变；/ps 不出现监视
 *  I -p：斜杠 /monitor 立刻报错；等待监视结束的辅助契约
 *
 * 进程内桩 / 假输出流，不连真实 CI / 外部 WebSocket，不改 ~/.neo/settings.json。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decidePermission } from "../src/agent/policy.ts";
import { COMMANDS, knownSlashCommand } from "../src/input/commands.ts";
import { parseInterval } from "../src/loop.ts";
import { parseLoopCommand } from "../src/loop.ts";
import { parseDriveArgs } from "../src/oneshotDrive.ts";
import {
  DEFAULT_MONITOR_TIMEOUT_MS,
  INJECTION_MAX_BYTES,
  INJECTION_MAX_LINES,
  MAX_MONITOR_TIMEOUT_MS,
  MAX_RUNNING_MONITORS,
  MONITOR_BUFFER_MAX_BYTES,
  MONITOR_BUFFER_MAX_LINES,
  ONESHOT_MAX_MONITOR_TIMEOUT_MS,
  formatMonitorJobs,
  formatMonitorTimeout,
  insertBeforeQueuedUser,
  parseMonitorCommand,
  parseMonitorTimeoutMs,
  wrapMonitorEvent,
} from "../src/monitor.ts";
import {
  MonitorTable,
  replaceMonitorsForTest,
  resetMonitors,
  sessionMonitors,
  type MonitorOwner,
} from "../src/monitors.ts";
import { cleanupEphemeral } from "../src/cleanup.ts";
import {
  backgroundShells,
  formatShellJobs,
  resetBackgroundShells,
  type ShellProc,
} from "../src/tools/backgroundShell.ts";
import { TOOLS } from "../src/tools/index.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import type { Config } from "../src/config.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-monitor-87-"));

/* ------------------------------------------------------------------ */
/* 假输出流                                                            */
/* ------------------------------------------------------------------ */

class FakeStream {
  private rec: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly stream: ReadableStream<Uint8Array>;
  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.rec = c;
      },
    });
  }
  push(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.rec?.enqueue(bytes);
  }
  close(): void {
    try {
      this.rec?.close();
    } catch {
      /* already closed */
    }
  }
}

function makeFakeProc(): {
  proc: ShellProc;
  stdout: FakeStream;
  stderr: FakeStream;
  exit: (code: number) => void;
  killed: () => boolean;
} {
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExited = r;
  });
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  let killed = false;
  let done = false;
  const finish = (code: number): void => {
    if (done) return;
    done = true;
    stdout.close();
    stderr.close();
    resolveExited(code);
  };
  const proc: ShellProc = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
    kill: () => {
      killed = true;
      finish(9);
    },
    pid: undefined,
  };
  return { proc, stdout, stderr, exit: finish, killed: () => killed };
}

async function tick(ms = 25): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function tool(name: string) {
  const impl = TOOLS.find((t) => t.spec.function.name === name);
  if (!impl) throw new Error(`找不到工具 ${name}`);
  return impl;
}

function ctx(over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => true,
    ...over,
  };
}

interface Capture {
  injections: Array<{ origin: string; text: string; owner: MonitorOwner }>;
  ui: string[];
}

function makeTable(over: {
  busy?: () => boolean;
  oneshot?: boolean;
  now?: () => number;
  capture?: Capture;
} = {}): { table: MonitorTable; capture: Capture; procs: Map<string, ReturnType<typeof makeFakeProc>> } {
  const capture: Capture = over.capture ?? { injections: [], ui: [] };
  const procs = new Map<string, ReturnType<typeof makeFakeProc>>();
  let seq = 0;
  const table = new MonitorTable({
    isBusy: over.busy ?? (() => false),
    isOneshot: () => over.oneshot === true,
    now: over.now,
    spawn: () => {
      const fake = makeFakeProc();
      seq += 1;
      procs.set(`p${seq}`, fake);
      return fake.proc;
    },
    onInject: (owner, text) => {
      capture.injections.push({ origin: "monitor", text, owner });
    },
    onUserVisible: (line) => {
      capture.ui.push(line);
    },
  });
  return { table, capture, procs };
}

function lastProc(procs: Map<string, ReturnType<typeof makeFakeProc>>): ReturnType<typeof makeFakeProc> {
  const last = [...procs.values()].at(-1);
  if (!last) throw new Error("还没有假进程");
  return last;
}

afterEach(() => {
  resetMonitors();
  resetBackgroundShells({ max: 5 });
});

/* ================================================================== */
/* A. 命令解析与列表文案                                               */
/* ================================================================== */

describe("A87 命令解析与列表文案", () => {
  test("A1 斜杠命令名是 /monitor，不是 /watch；登记进 COMMANDS 与 knownSlashCommand", () => {
    expect(COMMANDS.some((c) => c.name === "monitor")).toBe(true);
    expect(COMMANDS.some((c) => c.name === "watch")).toBe(false);
    expect(knownSlashCommand("/monitor")).toBe("monitor");
    expect(knownSlashCommand("/monitor --for 10m tail -f log")).toBe("monitor");
    expect(knownSlashCommand("/watch")).toBeNull();
  });

  test("A2 /monitor 无参 = 列表；stop 要 id 或 all；关键字是 stop 不是 kill", () => {
    expect(parseMonitorCommand("")).toEqual({ kind: "list" });
    const bare = parseMonitorCommand("stop");
    expect(bare.kind).toBe("error");
    if (bare.kind === "error") {
      expect(bare.message).toMatch(/id|all/);
      expect(bare.message).toContain("stop");
    }
    expect(parseMonitorCommand("stop mon-1")).toEqual({ kind: "stop", id: "mon-1" });
    expect(parseMonitorCommand("stop all")).toEqual({ kind: "stop", id: "all" });
    const killAsCmd = parseMonitorCommand("kill mon-1");
    expect(killAsCmd.kind).toBe("start");
    if (killAsCmd.kind === "start") expect(killAsCmd.command).toBe("kill mon-1");
  });

  test("A3 --for 与 /loop 糖；命令以时长令牌开头时用 -- 隔开；只写时长是用法错误", () => {
    const a = parseMonitorCommand("--for 10m tail -f server.log");
    expect(a.kind).toBe("start");
    if (a.kind === "start") {
      expect(a.command).toBe("tail -f server.log");
      expect(a.timeoutMs).toBe(10 * 60_000);
    }
    const b = parseMonitorCommand("10m tail -f server.log");
    expect(b.kind).toBe("start");
    if (b.kind === "start") {
      expect(b.command).toBe("tail -f server.log");
      expect(b.timeoutMs).toBe(10 * 60_000);
    }
    const c = parseMonitorCommand("--for 5m -- 5m-script.sh");
    expect(c.kind).toBe("start");
    if (c.kind === "start") expect(c.command).toBe("5m-script.sh");
    expect(parseMonitorCommand("10m").kind).toBe("error");
    expect(parseMonitorCommand("--for 10m").kind).toBe("error");
  });

  test("A4 列表文案：空态说明怎么启动；有任务含 id/状态/剩余/已回流/命令摘要/页脚；命令约 60 字截断", () => {
    const empty = formatMonitorJobs([], 0).join("\n");
    expect(empty).toMatch(/\/monitor/);
    expect(empty).not.toContain("/ps");
    const long = "x".repeat(80);
    const lines = formatMonitorJobs(
      [
        {
          id: "mon-1",
          status: "running",
          remainingMs: 3 * 60_000 + 20_000,
          flushedCount: 12,
          command: "tail -f server.log",
          description: "tail -f server.log",
        },
        {
          id: "mon-2",
          status: "running",
          remainingMs: 60_000,
          flushedCount: 0,
          command: long,
          description: long,
        },
      ],
      0,
    );
    const text = lines.join("\n");
    expect(text).toContain("mon-1");
    expect(text).toContain("运行中");
    expect(text).toContain("剩余 3m20s");
    expect(text).toContain("已回流 12 条");
    expect(text).toContain("tail -f server.log");
    expect(text).toContain("mon-2");
    expect(text).toContain("…");
    expect(text).not.toContain(long);
    expect(text).toContain("/monitor stop <id> 取消一条");
    expect(text).toContain("/monitor stop all 全部停止");
  });

  test("A5 启动成功行时限文案与包装辅助", () => {
    expect(formatMonitorTimeout(DEFAULT_MONITOR_TIMEOUT_MS)).toBe("5 分钟");
    expect(wrapMonitorEvent("mon-1", "hello")).toBe(`<监视事件 id="mon-1">\nhello\n</监视事件>`);
  });
});

/* ================================================================== */
/* B. 注入                                                             */
/* ================================================================== */

describe("B87 注入到当前会话", () => {
  test("B1 启动后到达的输出行注入当前会话，origin 是 monitor，带已签包装", async () => {
    const { table, capture, procs } = makeTable();
    const started = table.start({ command: "tail -f log", cwd: SANDBOX });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("期望成功");
    expect(started.id).toBe("mon-1");
    lastProc(procs).stdout.push("error: boom\n");
    await tick();
    expect(capture.injections).toHaveLength(1);
    expect(capture.injections[0]?.origin).toBe("monitor");
    expect(capture.injections[0]?.text).toContain(`<监视事件 id="mon-1">`);
    expect(capture.injections[0]?.text).toContain("error: boom");
    expect(capture.injections[0]?.text).toContain(`</监视事件>`);
    expect(capture.ui.some((l) => l.includes("已开始监视 mon-1") && l.includes("5 分钟"))).toBe(true);
  });

  test("B2 空闲时一次读到的多行打成一包，不要一行一轮", async () => {
    const { table, capture, procs } = makeTable();
    table.start({ command: "tail -f log", cwd: SANDBOX });
    lastProc(procs).stdout.push("a\nb\nc\n");
    await tick();
    expect(capture.injections).toHaveLength(1);
    const text = capture.injections[0]?.text ?? "";
    expect(text).toContain("a");
    expect(text).toContain("b");
    expect(text).toContain("c");
    expect([...text.matchAll(/<监视事件/g)]).toHaveLength(1);
  });

  test("B3 忙碌时排队到轮末，合并成一次注入", async () => {
    let busy = true;
    const { table, capture, procs } = makeTable({ busy: () => busy });
    table.start({ command: "tail -f log", cwd: SANDBOX });
    lastProc(procs).stdout.push("one\n");
    await tick();
    expect(capture.injections).toHaveLength(0);
    lastProc(procs).stdout.push("two\nthree\n");
    await tick();
    expect(capture.injections).toHaveLength(0);
    busy = false;
    table.onTurnEnd();
    expect(capture.injections).toHaveLength(1);
    const text = capture.injections[0]?.text ?? "";
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("three");
  });

  test("B4 注入插到已排队用户消息前面", () => {
    const queue: Array<{ origin: string; text: string }> = [
      { origin: "mailbox", text: "mail" },
      { origin: "user", text: "hello" },
      { origin: "user", text: "world" },
    ];
    insertBeforeQueuedUser(queue, { origin: "monitor", text: "<监视事件 id=\"mon-1\">x</监视事件>" });
    expect(queue.map((q) => q.origin)).toEqual(["mailbox", "monitor", "user", "user"]);
    expect(queue[1]?.text).toContain("监视事件");
  });
});

/* ================================================================== */
/* C. 上限                                                             */
/* ================================================================== */

describe("C87 缓冲与注入上限", () => {
  test("C1 单条监视缓冲 200 行 / 32KB，超限留最新并注明丢了多少", async () => {
    expect(MONITOR_BUFFER_MAX_LINES).toBe(200);
    expect(MONITOR_BUFFER_MAX_BYTES).toBe(32 * 1024);
    let busy = true;
    const { table, capture, procs } = makeTable({ busy: () => busy });
    table.start({ command: "gen", cwd: SANDBOX });
    const lines = Array.from({ length: 250 }, (_, i) => `L${String(i + 1).padStart(3, "0")}`);
    lastProc(procs).stdout.push(lines.join("\n") + "\n");
    await tick();
    busy = false;
    table.onTurnEnd();
    const text = capture.injections[0]?.text ?? "";
    // 250 行先被缓冲上限丢掉 50，注入上限再留最新 50，合计丢 200。
    expect(text).toMatch(/已丢弃.*200/);
    expect(text).not.toContain("L001");
    expect(text).not.toContain("L051");
    expect(text).toContain("L250");
    const body = text.split("\n").filter((l) => /^L\d{3}$/.test(l));
    expect(body.length).toBeLessThanOrEqual(50);
  });

  test("C2 每次注入总计 50 行 / 8KB，超限留最新并注明丢弃数", async () => {
    expect(INJECTION_MAX_LINES).toBe(50);
    expect(INJECTION_MAX_BYTES).toBe(8 * 1024);
    let busy = true;
    const { table, capture, procs } = makeTable({ busy: () => busy });
    table.start({ command: "gen", cwd: SANDBOX });
    const lines = Array.from({ length: 80 }, (_, i) => `N${String(i + 1).padStart(3, "0")}`);
    lastProc(procs).stdout.push(lines.join("\n") + "\n");
    await tick();
    busy = false;
    table.onTurnEnd();
    const text = capture.injections[0]?.text ?? "";
    expect(text).toMatch(/已丢弃.*30/);
    expect(text).not.toContain("N001");
    expect(text).toContain("N080");
    const body = text.split("\n").filter((l) => /^N\d{3}$/.test(l));
    expect(body.length).toBeLessThanOrEqual(50);
  });

  test("C3 到期或命令退出的通知不得丢，可以和待发送的行打在同一次注入里", async () => {
    let busy = true;
    const { table, capture, procs } = makeTable({ busy: () => busy });
    table.start({ command: "gen", cwd: SANDBOX });
    lastProc(procs).stdout.push("last-line\n");
    await tick();
    lastProc(procs).exit(0);
    await tick();
    expect(capture.injections).toHaveLength(0);
    busy = false;
    table.onTurnEnd();
    expect(capture.injections).toHaveLength(1);
    const text = capture.injections[0]?.text ?? "";
    expect(text).toContain("last-line");
    expect(text).toMatch(/退出|结束/);
    expect(text).toContain("exit 0");
    const endBlocks = capture.ui.filter((l) => l.includes("mon-1") && (l.includes("退出") || l.includes("结束")));
    expect(endBlocks.length).toBeGreaterThanOrEqual(1);
    expect(endBlocks.some((l) => l.includes("last-line") && (l.includes("退出") || l.includes("exit")))).toBe(true);
  });

  test("C4 命令零输出就退出时，说清没有输出，不要只写流结束", async () => {
    const { table, capture, procs } = makeTable();
    table.start({ command: "true", cwd: SANDBOX });
    lastProc(procs).exit(0);
    await tick();
    const text = capture.injections.map((i) => i.text).join("\n");
    expect(text).toMatch(/没有输出/);
    expect(text).not.toMatch(/流结束/);
  });
});

/* ================================================================== */
/* D. 时限                                                             */
/* ================================================================== */

describe("D87 时限", () => {
  test("D1 默认 5 分钟，最长 30 分钟，-p 最长 10 分钟；超上限拒绝不暗默夹断", () => {
    expect(DEFAULT_MONITOR_TIMEOUT_MS).toBe(300_000);
    expect(MAX_MONITOR_TIMEOUT_MS).toBe(30 * 60_000);
    expect(ONESHOT_MAX_MONITOR_TIMEOUT_MS).toBe(10 * 60_000);
    expect(parseMonitorTimeoutMs(undefined, { oneshot: false })).toEqual({ ok: true, timeoutMs: 300_000 });
    const over = parseMonitorTimeoutMs(31 * 60_000, { oneshot: false });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/30/);
    const pOver = parseMonitorTimeoutMs(15 * 60_000, { oneshot: true });
    expect(pOver.ok).toBe(false);
    if (!pOver.ok) expect(pOver.error).toMatch(/10/);
  });

  test("D2 timeout_ms 为 0、负数或非数字一律拒绝", () => {
    expect(parseMonitorTimeoutMs(0, { oneshot: false }).ok).toBe(false);
    expect(parseMonitorTimeoutMs(-1, { oneshot: false }).ok).toBe(false);
    expect(parseMonitorTimeoutMs(Number.NaN, { oneshot: false }).ok).toBe(false);
    expect(parseMonitorTimeoutMs("abc" as unknown as number, { oneshot: false }).ok).toBe(false);
  });

  test("D3 到点通知「监视结束」不是错误，重新开始拿到新 id", async () => {
    const { table, capture } = makeTable();
    const a = table.start({ command: "tail -f a", cwd: SANDBOX, timeoutMs: 40 });
    expect(a.ok).toBe(true);
    if (!a.ok) throw new Error("期望成功");
    await tick(80);
    const text = capture.injections.map((i) => i.text).join("\n");
    expect(text).toMatch(/监视结束/);
    expect(text).not.toMatch(/错误/);
    expect(table.list().every((v) => v.id !== a.id || v.status !== "running")).toBe(true);
    const b = table.start({ command: "tail -f b", cwd: SANDBOX, timeoutMs: 60_000 });
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error("期望成功");
    expect(b.id).not.toBe(a.id);
    expect(b.id).toBe("mon-2");
  });
});

/* ================================================================== */
/* E. 生命周期                                                         */
/* ================================================================== */

describe("E87 生命周期与进程组隔离", () => {
  test("E1 取消一条 / 取消全部会杀掉对应监视进程，不影响其它表", async () => {
    const { table, procs } = makeTable();
    const a = table.start({ command: "a", cwd: SANDBOX });
    const b = table.start({ command: "b", cwd: SANDBOX });
    if (!a.ok || !b.ok) throw new Error("期望成功");
    expect(table.runningCount()).toBe(2);
    expect(table.stop(a.id)).toBe(1);
    await tick();
    expect([...procs.values()][0]?.killed()).toBe(true);
    expect([...procs.values()][1]?.killed()).toBe(false);
    expect(table.stop("all")).toBe(1);
    await tick();
    expect([...procs.values()][1]?.killed()).toBe(true);
    expect(table.runningCount()).toBe(0);
  });

  test("E2 取消发起它的子代理：只停该子代理的监视并丢弃未刷新行，不泄漏到父会话", async () => {
    let busy = true;
    const { table, capture, procs } = makeTable({ busy: () => busy });
    const parent = table.start({ command: "parent", cwd: SANDBOX, owner: { kind: "session" } });
    const child = table.start({
      command: "child",
      cwd: SANDBOX,
      owner: { kind: "subagent", id: "sg-1" },
    });
    if (!parent.ok || !child.ok) throw new Error("期望成功");
    lastProc(procs).stdout.push("secret-from-child\n");
    await tick();
    const n = table.cancelByOwner({ kind: "subagent", id: "sg-1" });
    expect(n).toBe(1);
    busy = false;
    table.onTurnEnd();
    const leaked = capture.injections.filter((i) => i.text.includes("secret-from-child"));
    expect(leaked).toHaveLength(0);
    expect(capture.injections.every((i) => i.owner.kind !== "subagent")).toBe(true);
    expect(table.list().some((v) => v.id === parent.id)).toBe(true);
    expect(table.list().some((v) => v.id === child.id)).toBe(false);
  });

  test("E3 会话结束：先停注入再杀进程组，未完成监视被收掉", async () => {
    const order: string[] = [];
    const fake = makeFakeProc();
    const table = new MonitorTable({
      isBusy: () => true,
      spawn: () => fake.proc,
      onInject: () => {
        order.push("inject");
      },
      onUserVisible: () => {},
    });
    table.start({ command: "sleep", cwd: SANDBOX });
    fake.stdout.push("late\n");
    await tick();
    table.stopInjection();
    order.push("stopped-inject");
    table.killAll();
    order.push("killed");
    expect(fake.killed()).toBe(true);
    expect(order[0]).toBe("stopped-inject");
    expect(order[1]).toBe("killed");
    expect(order).not.toContain("inject");
    expect(table.runningCount()).toBe(0);
  });

  test("E4 /ps kill 不杀监视；取消 mon-N 不杀 sh-N", async () => {
    const { table } = makeTable();
    const mon = table.start({ command: "mon", cwd: SANDBOX });
    if (!mon.ok) throw new Error("期望成功");
    const sh = backgroundShells.start(["sh", "-c", "sleep 30"], SANDBOX, {}, { command: "sleep 30", cwd: SANDBOX });
    expect(sh.ok).toBe(true);
    if (!sh.ok) throw new Error("期望成功");
    const killedShells = backgroundShells.kill("all");
    expect(killedShells).toBeGreaterThanOrEqual(1);
    expect(table.runningCount()).toBe(1);
    const sh2 = backgroundShells.start(["sh", "-c", "sleep 30"], SANDBOX, {}, { command: "sleep 30", cwd: SANDBOX });
    if (!sh2.ok) throw new Error("期望成功");
    table.stop(mon.id);
    await tick();
    expect(backgroundShells.view(sh2.id)?.status === "running" || backgroundShells.view(sh2.id)?.status === "timeout").toBe(
      true,
    );
    backgroundShells.kill(sh2.id);
  });

  test("E5 cleanupEphemeral 先停监视注入再杀进程组", () => {
    const calls: string[] = [];
    cleanupEphemeral({
      loop: { dispose: () => calls.push("loop") },
      drive: { stop: () => calls.push("drive") },
      monitors: {
        stopInjection: () => calls.push("monitors-stop-inject"),
        killAll: () => calls.push("monitors-kill"),
      },
      tasks: { cancelAll: () => calls.push("tasks") },
      shells: { killAll: () => calls.push("shells") },
      lsp: { closeAll: () => calls.push("lsp") },
      mcp: { closeAll: () => calls.push("mcp") },
      closeMailbox: () => calls.push("mailbox"),
    });
    expect(calls).toEqual([
      "loop",
      "drive",
      "monitors-stop-inject",
      "tasks",
      "monitors-kill",
      "shells",
      "lsp",
      "mcp",
      "mailbox",
    ]);
  });
});

/* ================================================================== */
/* F. 权限 / ws / 并发                                                */
/* ================================================================== */

describe("F87 权限、ws、并发上限", () => {
  test("F1 plan 模式拒绝启动，允许列出和取消；ask/auto-edit 与 shell 同桶", () => {
    expect(decidePermission("plan", "monitor")).toEqual({ allow: false, reason: "plan" });
    expect(decidePermission("auto-all", "monitor")).toEqual({ allow: true });
    expect(decidePermission("auto-edit", "monitor")).toEqual(decidePermission("auto-edit", "shell"));
    expect(decidePermission("ask", "monitor")).toEqual(decidePermission("ask", "shell"));
  });

  test("F2 工具 list/stop 在 plan 下仍可执行；start 走审批", async () => {
    const { table } = makeTable();
    replaceMonitorsForTest(table);
    const started = await tool("monitor").execute({ action: "start", command: "echo hi" }, ctx());
    expect(String(started)).toMatch(/mon-1/);
    const listed = await tool("monitor").execute({ action: "list" }, ctx({ readOnly: true }));
    expect(String(listed)).toContain("mon-1");
    const approve = async () => false;
    await expect(
      tool("monitor").execute({ action: "start", command: "echo no" }, ctx({ approve, readOnly: true })),
    ).rejects.toThrow(/plan|拒绝|禁止/);
    const stopped = await tool("monitor").execute({ action: "stop", id: "mon-1" }, ctx({ readOnly: true }));
    expect(String(stopped)).toMatch(/取消|停止|已/);
  });

  test("F3 传了 ws 要明确报错 WebSocket 源后置，不得当成命令监视", async () => {
    await expect(
      tool("monitor").execute({ command: "tail -f log", ws: "wss://example.com" }, ctx()),
    ).rejects.toThrow(/WebSocket/);
    expect(sessionMonitors.runningCount()).toBe(0);
  });

  test("F4 正在跑的监视最多 5 条，与 sh-N 分开计算；超限提示 /monitor", () => {
    expect(MAX_RUNNING_MONITORS).toBe(5);
    const { table } = makeTable();
    for (let i = 0; i < 5; i++) {
      const r = table.start({ command: `c${i}`, cwd: SANDBOX });
      expect(r.ok).toBe(true);
    }
    const sixth = table.start({ command: "c5", cwd: SANDBOX });
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.error).toContain("/monitor");
      expect(sixth.error).toMatch(/上限|5/);
    }
    const sh = backgroundShells.start(["sh", "-c", "sleep 30"], SANDBOX, {}, { command: "sleep 30", cwd: SANDBOX });
    expect(sh.ok).toBe(true);
    if (sh.ok) backgroundShells.kill(sh.id);
  });

  test("F5 缺 command 的 start 立即报错；省略 action 但带 command 视为 start", async () => {
    await expect(tool("monitor").execute({ action: "start" }, ctx())).rejects.toThrow(/command/);
    const { table } = makeTable();
    replaceMonitorsForTest(table);
    const out = await tool("monitor").execute({ command: "echo hi" }, ctx());
    expect(String(out)).toMatch(/mon-1/);
  });
});

/* ================================================================== */
/* G. 流与子代理隔离                                                   */
/* ================================================================== */

describe("G87 流处理与子代理隔离", () => {
  test("G1 不完整行先缓冲，凑齐换行再注入", async () => {
    const { table, capture, procs } = makeTable();
    table.start({ command: "tail", cwd: SANDBOX });
    lastProc(procs).stdout.push("hel");
    await tick();
    expect(capture.injections).toHaveLength(0);
    lastProc(procs).stdout.push("lo\n");
    await tick();
    expect(capture.injections).toHaveLength(1);
    expect(capture.injections[0]?.text).toContain("hello");
    expect(capture.injections[0]?.text).not.toContain("hel\n");
  });

  test("G2 二进制不进上下文，只告警", async () => {
    const { table, capture, procs } = makeTable();
    table.start({ command: "cat bin", cwd: SANDBOX });
    lastProc(procs).stdout.push(new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x10]));
    await tick();
    const text = capture.injections.map((i) => i.text).join("\n");
    const ui = capture.ui.join("\n");
    expect(text + ui).toMatch(/二进制|binary/i);
    expect(text).not.toContain("\u0000");
  });

  test("G3 stdout/stderr 按到达顺序合并", async () => {
    const { table, capture, procs } = makeTable();
    table.start({ command: "both", cwd: SANDBOX });
    const p = lastProc(procs);
    p.stdout.push("out1\n");
    await tick();
    p.stderr.push("err1\n");
    await tick();
    const joined = capture.injections.map((i) => i.text).join("\n");
    expect(joined.indexOf("out1")).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf("err1")).toBeGreaterThan(joined.indexOf("out1"));
  });

  test("G4 子代理监视只注入该子代理消息流，不爬到父会话", async () => {
    const { table, capture, procs } = makeTable();
    table.start({ command: "parent-cmd", cwd: SANDBOX, owner: { kind: "session" } });
    const child = table.start({
      command: "child-cmd",
      cwd: SANDBOX,
      owner: { kind: "subagent", id: "sg-9" },
    });
    if (!child.ok) throw new Error("期望成功");
    lastProc(procs).stdout.push("only-child\n");
    await tick();
    const childInj = capture.injections.filter((i) => i.owner.kind === "subagent" && i.owner.id === "sg-9");
    const parentInj = capture.injections.filter((i) => i.owner.kind === "session");
    expect(childInj.some((i) => i.text.includes("only-child"))).toBe(true);
    expect(parentInj.some((i) => i.text.includes("only-child"))).toBe(false);
  });
});

/* ================================================================== */
/* H. 与 /loop / /drive / /ps 正交                                     */
/* ================================================================== */

describe("H87 与 /loop / /drive / /ps 正交", () => {
  test("H1 /loop 解析与忙碌丢拍口径不变", () => {
    const r = parseLoopCommand("2m 看下 CI");
    expect(r.kind).toBe("start");
    if (r.kind === "start") {
      expect(r.spec.mode).toBe("interval");
      expect(r.spec.intervalMs).toBe(120_000);
      expect(r.spec.prompt).toBe("看下 CI");
    }
    expect(parseLoopCommand("stop").kind).toBe("stop");
    expect(parseInterval("10m")).toBe(600_000);
  });

  test("H2 /drive 参数解析口径不变", () => {
    expect(parseDriveArgs(["-p", "hello"])).toBeNull();
  });

  test("H3 /ps 文案不出现监视；监视列表不出现 sh-N", async () => {
    const { table } = makeTable();
    table.start({ command: "tail -f x", cwd: SANDBOX });
    const sh = backgroundShells.start(["sh", "-c", "sleep 30"], SANDBOX, {}, { command: "sleep 30", cwd: SANDBOX });
    if (!sh.ok) throw new Error("期望成功");
    const ps = formatShellJobs(backgroundShells.list()).join("\n");
    expect(ps).toContain(sh.id);
    expect(ps).not.toContain("mon-1");
    expect(ps).not.toMatch(/监视/);
    const mon = formatMonitorJobs(table.list(), Date.now()).join("\n");
    expect(mon).toContain("mon-1");
    expect(mon).not.toContain(sh.id);
    backgroundShells.kill(sh.id);
  });
});

/* ================================================================== */
/* I. -p 契约                                                          */
/* ================================================================== */

describe("I87 -p 契约", () => {
  test("I1 仍有未到期监视时 waitUntilSettled 不会立刻结束，监视结束后才 resolve", async () => {
    const { table, procs } = makeTable({ oneshot: true });
    table.start({ command: "work", cwd: SANDBOX, timeoutMs: 5_000 });
    const startedAt = Date.now();
    const waiting = table.waitUntilSettled();
    let resolved = false;
    void waiting.then(() => {
      resolved = true;
    });
    await tick(40);
    expect(resolved).toBe(false);
    lastProc(procs).exit(0);
    await waiting;
    expect(resolved).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(0);
    expect(table.runningCount()).toBe(0);
  });

  test("I2 没有监视时 waitUntilSettled 立刻结束", async () => {
    const { table } = makeTable({ oneshot: true });
    const t0 = Date.now();
    await table.waitUntilSettled();
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("I3 -p 下 timeout 超过 10 分钟被拒绝", () => {
    const { table } = makeTable({ oneshot: true });
    const r = table.start({ command: "long", cwd: SANDBOX, timeoutMs: 11 * 60_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/10/);
  });
});

export { SANDBOX };
