/**
 * issue #87：监视任务表（独立于 backgroundShells）。
 *
 * id 形如 mon-N。复用 #28/#75 进程组终止原语，但不把监视塞进后台 shell 表。
 */
import type { Config } from "./config.ts";
import {
  MAX_RUNNING_MONITORS,
  capPendingLines,
  formatMonitorJobs,
  formatMonitorUiBlock,
  isBinaryChunk,
  packInjection,
  parseMonitorTimeoutMs,
  splitCompleteLines,
  startSuccessLine,
  summarizeCommand,
  utf8Bytes,
  wrapMonitorEvent,
  type MonitorJobView,
  type MonitorStatus,
  type PendingLine,
} from "./monitor.ts";
import { terminateProcessGroup } from "./processGroup.ts";
import { getShell, prepareShellInvocation } from "./shell.ts";
import type { ShellProc } from "./tools/backgroundShell.ts";

export type MonitorOwner = { kind: "session" } | { kind: "subagent"; id: string };

export interface MonitorTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (t: unknown) => void;
}

export interface MonitorTableOptions {
  isBusy?: (owner?: MonitorOwner) => boolean;
  isOneshot?: () => boolean;
  now?: () => number;
  timers?: MonitorTimers;
  spawn?: (command: string, cwd: string, env: Record<string, string | undefined>) => ShellProc;
  onInject?: (owner: MonitorOwner, text: string) => void;
  onUserVisible?: (line: string) => void;
  cfg?: Config;
}

interface Job {
  id: string;
  command: string;
  description: string;
  cwd: string;
  timeoutMs: number;
  owner: MonitorOwner;
  proc: ShellProc;
  status: MonitorStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  flushedCount: number;
  leftover: string;
  pending: PendingLine[];
  pendingDropped: number;
  notices: string[];
  binaryWarned: boolean;
  everHadOutput: boolean;
  timer: unknown;
  closed: boolean;
}

function sameOwner(a: MonitorOwner, b: MonitorOwner): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "session" || a.id === (b as { id: string }).id;
}

function ownerKey(o: MonitorOwner): string {
  return o.kind === "session" ? "session" : `subagent:${o.id}`;
}

const defaultTimers: MonitorTimers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

export class MonitorTable {
  private jobs: Job[] = [];
  private seq = 0;
  private injectionStopped = false;
  private readonly now: () => number;
  private readonly timers: MonitorTimers;
  private readonly opts: MonitorTableOptions;
  private waiters: Array<() => void> = [];
  private sessionInjectQueue: string[] = [];

  constructor(opts: MonitorTableOptions = {}) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.timers = opts.timers ?? defaultTimers;
  }

  /** 组合根在 REPL / -p 装配注入与忙碌判定。 */
  configure(opts: Partial<MonitorTableOptions>): void {
    Object.assign(this.opts, opts);
    if (opts.now) (this as unknown as { now: () => number }).now = opts.now;
    if (opts.timers) (this as unknown as { timers: MonitorTimers }).timers = opts.timers;
  }

  runningCount(): number {
    return this.jobs.filter((j) => j.status === "running").length;
  }

  hasUnfinished(): boolean {
    return this.jobs.some(
      (j) => j.status === "running" || j.pending.length > 0 || j.notices.length > 0 || j.leftover !== "",
    );
  }

  list(): MonitorJobView[] {
    const now = this.now();
    return this.jobs
      .filter((j) => j.status === "running")
      .map((j) => this.toView(j, now));
  }

  formatList(): string[] {
    return formatMonitorJobs(this.list(), this.now());
  }

  start(opts: {
    command: string;
    cwd: string;
    timeoutMs?: number;
    description?: string;
    owner?: MonitorOwner;
    env?: Record<string, string | undefined>;
  }): { ok: true; id: string; timeoutMs: number } | { ok: false; error: string } {
    if (this.injectionStopped) return { ok: false, error: "会话正在退出，不能再启动监视" };
    const checked = parseMonitorTimeoutMs(opts.timeoutMs, { oneshot: this.opts.isOneshot?.() === true });
    if (!checked.ok) return checked;
    if (this.runningCount() >= MAX_RUNNING_MONITORS) {
      return { ok: false, error: `监视已达上限 ${MAX_RUNNING_MONITORS}（/monitor 查看，/monitor stop 清理）` };
    }
    const command = opts.command.trim();
    if (!command) return { ok: false, error: "缺少 command" };

    let proc: ShellProc;
    try {
      proc = (this.opts.spawn ?? this.defaultSpawn.bind(this))(command, opts.cwd, opts.env ?? process.env);
    } catch (e) {
      return { ok: false, error: `无法启动监视：${(e as Error).message}` };
    }

    this.seq += 1;
    const id = `mon-${this.seq}`;
    const description = (opts.description ?? "").trim() || summarizeCommand(command);
    const job: Job = {
      id,
      command,
      description,
      cwd: opts.cwd,
      timeoutMs: checked.timeoutMs,
      owner: opts.owner ?? { kind: "session" },
      proc,
      status: "running",
      exitCode: null,
      startedAt: this.now(),
      endedAt: null,
      flushedCount: 0,
      leftover: "",
      pending: [],
      pendingDropped: 0,
      notices: [],
      binaryWarned: false,
      everHadOutput: false,
      timer: null,
      closed: false,
    };
    job.timer = this.timers.set(() => this.onTimeout(job), checked.timeoutMs);
    this.jobs.push(job);
    this.watch(job);
    this.opts.onUserVisible?.(startSuccessLine(id, checked.timeoutMs, description));
    return { ok: true, id, timeoutMs: checked.timeoutMs };
  }

  stop(target: string): number {
    if (target === "all") {
      const running = this.jobs.filter((j) => j.status === "running");
      for (const job of running) this.cancelJob(job, "已取消监视");
      this.flushAll({ force: true });
      return running.length;
    }
    const job = this.jobs.find((j) => j.id === target);
    if (!job || job.status !== "running") return 0;
    this.cancelJob(job, "已取消监视");
    this.flushOwner(job.owner, true);
    return 1;
  }

  /** 子代理结束：停掉它起的监视，丢弃未刷新的行，不注入父会话。 */
  cancelByOwner(owner: MonitorOwner): number {
    const matches = this.jobs.filter((j) => sameOwner(j.owner, owner));
    let n = 0;
    for (const job of matches) {
      this.discardJob(job);
      if (job.status === "cancelled" || job.status === "running") n += 1;
    }
    this.wake();
    return n;
  }

  /** 会话退出第一步：不再向模型/UI 注入。 */
  stopInjection(): void {
    this.injectionStopped = true;
    this.sessionInjectQueue = [];
    for (const job of this.jobs) {
      job.pending = [];
      job.notices = [];
      job.leftover = "";
      job.pendingDropped = 0;
    }
    this.wake();
  }

  /** 会话退出第二步：按进程组杀掉全部监视。 */
  killAll(): void {
    for (const job of this.jobs) {
      this.clearTimer(job);
      terminateProcessGroup(job.proc, { sync: true });
      if (job.status === "running") job.status = "cancelled";
      job.closed = true;
    }
    this.jobs = [];
    this.wake();
  }

  onTurnEnd(): void {
    this.flushAll({ force: true });
  }

  async waitUntilSettled(): Promise<void> {
    for (;;) {
      if (!this.isBusy()) this.flushAll({ force: true });
      this.reapFinished();
      if (!this.hasUnfinished()) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  /** -p：取出下一条会话注入；没有未完成监视且队列空时返回 null。 */
  async nextSessionInjection(): Promise<string | null> {
    for (;;) {
      const next = this.sessionInjectQueue.shift();
      if (next !== undefined) return next;
      if (!this.isBusy()) this.flushAll({ force: true });
      this.reapFinished();
      const queued = this.sessionInjectQueue.shift();
      if (queued !== undefined) return queued;
      if (!this.hasUnfinished()) return null;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  private defaultSpawn(command: string, cwd: string, env: Record<string, string | undefined>): ShellProc {
    const spec = getShell(this.opts.cfg ?? ({ cwd } as Config));
    const invocation = prepareShellInvocation(spec, command, {
      ...env,
      NO_COLOR: env["NO_COLOR"] ?? process.env.NO_COLOR ?? "1",
    });
    return Bun.spawn(invocation.argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: invocation.env,
      detached: true,
    }) as unknown as ShellProc;
  }

  private watch(job: Job): void {
    const pump = async (stream: ReadableStream<Uint8Array> | null | undefined): Promise<void> => {
      if (!stream) return;
      try {
        for await (const chunk of stream) {
          if (job.closed || job.status !== "running") break;
          this.onChunk(job, chunk);
        }
      } catch {
        /* 进程被杀时流会中断 */
      }
    };
    void (async () => {
      const outP = pump(job.proc.stdout);
      const errP = pump(job.proc.stderr);
      let code = 0;
      try {
        code = await job.proc.exited;
      } catch {
        code = -1;
      }
      await Promise.all([outP, errP]);
      this.onExit(job, code);
    })();
  }

  private onChunk(job: Job, chunk: Uint8Array): void {
    if (job.status !== "running" || job.closed) return;
    if (isBinaryChunk(chunk)) {
      if (!job.binaryWarned) {
        job.binaryWarned = true;
        job.notices.push("输出含有二进制数据，已忽略，不进入上下文");
      }
      this.tryFlush(job.owner);
      return;
    }
    const text = new TextDecoder().decode(chunk);
    const { lines, leftover } = splitCompleteLines(job.leftover, text);
    job.leftover = leftover;
    const at = this.now();
    for (const line of lines) {
      job.pending.push({ text: line, at, bytes: utf8Bytes(line) });
      job.everHadOutput = true;
    }
    job.pendingDropped += capPendingLines(job.pending);
    this.tryFlush(job.owner);
  }

  private onExit(job: Job, code: number): void {
    if (job.closed) return;
    if (job.status !== "running") {
      // 已在 timeout/cancel 路径收尾，只补退出码
      job.exitCode = code;
      this.flushLeftover(job);
      this.wake();
      return;
    }
    job.exitCode = code;
    job.status = "exited";
    job.endedAt = this.now();
    this.clearTimer(job);
    this.flushLeftover(job);
    if (!job.everHadOutput && job.pending.length === 0) {
      job.notices.push(`命令已退出，exit ${code}（没有输出）`);
    } else {
      job.notices.push(`命令已退出，exit ${code}`);
    }
    this.tryFlush(job.owner);
    this.wake();
  }

  private onTimeout(job: Job): void {
    job.timer = null;
    if (job.status !== "running") return;
    job.status = "timed_out";
    job.endedAt = this.now();
    this.flushLeftover(job);
    job.notices.push("监视结束");
    terminateProcessGroup(job.proc, { sync: false });
    this.tryFlush(job.owner);
    this.wake();
  }

  private cancelJob(job: Job, notice: string): void {
    if (job.status !== "running") return;
    job.status = "cancelled";
    job.endedAt = this.now();
    this.clearTimer(job);
    this.flushLeftover(job);
    job.notices.push(notice);
    terminateProcessGroup(job.proc, { sync: false });
    job.closed = true;
  }

  private discardJob(job: Job): void {
    this.clearTimer(job);
    job.pending = [];
    job.notices = [];
    job.leftover = "";
    job.pendingDropped = 0;
    if (job.status === "running") {
      job.status = "cancelled";
      job.endedAt = this.now();
      terminateProcessGroup(job.proc, { sync: false });
    }
    job.closed = true;
    this.jobs = this.jobs.filter((j) => j !== job);
  }

  private flushLeftover(job: Job): void {
    if (job.leftover !== "") {
      job.pending.push({ text: job.leftover, at: this.now(), bytes: utf8Bytes(job.leftover) });
      job.everHadOutput = true;
      job.leftover = "";
      job.pendingDropped += capPendingLines(job.pending);
    }
  }

  private isBusy(owner?: MonitorOwner): boolean {
    return this.opts.isBusy?.(owner) === true;
  }

  private tryFlush(owner: MonitorOwner): void {
    if (this.injectionStopped) return;
    if (this.isBusy(owner)) return;
    this.flushOwner(owner, false);
  }

  private flushAll(opts: { force: boolean }): void {
    if (this.injectionStopped) return;
    const keys = new Map<string, MonitorOwner>();
    for (const job of this.jobs) keys.set(ownerKey(job.owner), job.owner);
    for (const owner of keys.values()) {
      if (!opts.force && this.isBusy(owner)) continue;
      this.flushOwner(owner, opts.force);
    }
  }

  private flushOwner(owner: MonitorOwner, force: boolean): void {
    if (this.injectionStopped) return;
    if (!force && this.isBusy(owner)) return;
    const jobs = this.jobs.filter(
      (j) => sameOwner(j.owner, owner) && (j.pending.length > 0 || j.notices.length > 0),
    );
    if (jobs.length === 0) return;
    const blocks = packInjection(
      jobs.map((j) => ({
        id: j.id,
        title: j.description,
        pending: j.pending,
        dropped: j.pendingDropped,
        notices: j.notices,
      })),
    );
    if (blocks.length === 0) return;
    const text = blocks.map((b) => wrapMonitorEvent(b.id, b.body)).join("\n\n");
    this.opts.onInject?.(owner, text);
    if (owner.kind === "session" && this.opts.isOneshot?.() === true) {
      this.sessionInjectQueue.push(text);
    }
    for (const b of blocks) {
      this.opts.onUserVisible?.(formatMonitorUiBlock({ id: b.id, title: b.title, lines: b.lines, notices: b.notices }));
    }
    for (const job of jobs) {
      const block = blocks.find((b) => b.id === job.id);
      if (block) job.flushedCount += block.lines.length;
      job.pending = [];
      job.pendingDropped = 0;
      job.notices = [];
    }
    this.reapFinished();
    this.wake();
  }

  private reapFinished(): void {
    this.jobs = this.jobs.filter((j) => {
      if (j.status === "running") return true;
      const pending = j.pending.length > 0 || j.notices.length > 0 || j.leftover !== "";
      return pending;
    });
  }

  private toView(job: Job, now: number): MonitorJobView {
    return {
      id: job.id,
      status: job.status,
      remainingMs: Math.max(0, job.startedAt + job.timeoutMs - now),
      flushedCount: job.flushedCount,
      command: job.command,
      description: job.description,
    };
  }

  private clearTimer(job: Job): void {
    if (job.timer !== null) {
      this.timers.clear(job.timer);
      job.timer = null;
    }
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }
}

/** 会话内唯一实例（与 backgroundShells 同口径，但是另一张表）。 */
export let sessionMonitors = new MonitorTable();

export function resetMonitors(): void {
  try {
    sessionMonitors.stopInjection();
  } catch {
    /* ignore */
  }
  try {
    sessionMonitors.killAll();
  } catch {
    /* ignore */
  }
  sessionMonitors = new MonitorTable();
}

export function replaceMonitorsForTest(table: MonitorTable): void {
  try {
    sessionMonitors.stopInjection();
  } catch {
    /* ignore */
  }
  try {
    sessionMonitors.killAll();
  } catch {
    /* ignore */
  }
  sessionMonitors = table;
}
