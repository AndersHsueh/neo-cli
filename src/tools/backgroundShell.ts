/**
 * 后台长驻 shell（issue #28）。
 *
 * 与 #16（后台子代理）正交：这里管的是**长时间 shell 进程**（dev server / watch / 长测试）。
 *
 * 能力：
 *  - `shell` 工具传 `background: true` → 立刻返回任务 id（`sh-N`），会话继续可用；
 *  - `shell` 前台调用**超时后不杀进程**，而是把同一条进程「转后台」并返回 id（显式、可回读）；
 *  - `shell_output` 工具按 id 读后续输出与退出码；用户用 `/ps` 列出/停止；
 *  - 会话退出 `killAll()`，不留孤儿。
 *
 * 会话内唯一实例：模块级单例（与 TOOLS 注册表同口径），测试用 `resetBackgroundShells()` 隔离。
 */

export type ShellStatus = "running" | "exited" | "killed" | "timeout";

export interface ShellJobView {
  id: string;
  command: string;
  cwd: string;
  status: ShellStatus;
  exitCode: number | null;
  elapsedMs: number;
  /** 是否由前台超时转入后台。 */
  promoted: boolean;
  /** stdout / stderr 的尾部（各自截断到 keepChars）。 */
  out: string;
  err: string;
}

/** 只依赖用到的字段，测试可以塞任何结构相同的 proc。 */
export interface ShellProc {
  stdout: ReadableStream<Uint8Array> | null | undefined;
  stderr: ReadableStream<Uint8Array> | null | undefined;
  exited: Promise<number>;
  kill(signal?: number): void;
  pid?: number;
}

interface Job {
  id: string;
  command: string;
  cwd: string;
  proc: ShellProc;
  status: ShellStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  promoted: boolean;
  out: string;
  err: string;
  done: Promise<{ code: number }>;
}

export interface BackgroundShellOptions {
  /** 同时保留的后台命令上限（默认 5）；前台超时转入也受此限制。 */
  max?: number;
  /** stdout/stderr 各保留的最大字符数（默认 64k，只留尾部）。 */
  keepChars?: number;
  now?: () => number;
}

export const DEFAULT_SHELL_MAX = 5;
const DEFAULT_KEEP_CHARS = 64 * 1024;

export class BackgroundShells {
  private jobs: Job[] = [];
  private seq = 0;
  private readonly max: number;
  private readonly keepChars: number;
  private readonly now: () => number;

  constructor(opts: BackgroundShellOptions = {}) {
    this.max = opts.max ?? DEFAULT_SHELL_MAX;
    this.keepChars = opts.keepChars ?? DEFAULT_KEEP_CHARS;
    this.now = opts.now ?? (() => Date.now());
  }

  get runningCount(): number {
    return this.jobs.filter((j) => j.status === "running").length;
  }

  get size(): number {
    return this.jobs.length;
  }

  /**
   * 接管一个**已经启动**的进程（前台 shell 与超时转后台都走这里）。
   * 输出从接管那一刻开始累积；接管前的输出由调用方自己处理。
   */
  adopt(
    proc: ShellProc,
    meta: { command: string; cwd: string },
  ): { ok: true; id: string } | { ok: false; error: string } {
    if (this.runningCount >= this.max) {
      return {
        ok: false,
        error: `后台命令已达上限 ${this.max}（/ps 查看，/ps kill <id|all> 清理）`,
      };
    }
    this.seq += 1;
    const job: Job = {
      id: `sh-${this.seq}`,
      command: meta.command,
      cwd: meta.cwd,
      proc,
      status: "running",
      exitCode: null,
      startedAt: this.now(),
      endedAt: null,
      promoted: false,
      out: "",
      err: "",
      done: Promise.resolve({ code: 0 }),
    };
    job.done = this.watch(job);
    this.jobs.push(job);
    return { ok: true, id: job.id };
  }

  /** 启动并接管一个新进程。 */
  start(
    argv: string[],
    cwd: string,
    env: Record<string, string | undefined>,
    meta: { command: string; cwd: string },
  ): { ok: true; id: string } | { ok: false; error: string } {
    if (this.runningCount >= this.max) {
      return { ok: false, error: `后台命令已达上限 ${this.max}（/ps 查看，/ps kill <id|all> 清理）` };
    }
    let proc: ShellProc;
    try {
      proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env }) as unknown as ShellProc;
    } catch (e) {
      return { ok: false, error: `无法启动 shell：${(e as Error).message}` };
    }
    return this.adopt(proc, meta);
  }

  /** 前台等待：超时返回 exited:false（进程留着转后台，不杀）。 */
  async wait(id: string, timeoutMs: number): Promise<{ exited: boolean; code: number | null }> {
    const job = this.find(id);
    if (!job) return { exited: true, code: null };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const raced = await Promise.race([
      job.done.then((v) => ({ kind: "exit" as const, code: v.code })),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    if (raced === "timeout") {
      if (job.status === "running") {
        job.status = "timeout"; // 语义：前台等待超时，已转后台继续跑
        job.promoted = true;
      }
      return { exited: false, code: null };
    }
    return { exited: true, code: raced.code };
  }

  /** 前台命令正常结束后把记录摘掉（不占 /ps 列表）。 */
  forget(id: string): void {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i !== -1) this.jobs.splice(i, 1);
  }

  /** 取任务快照（含输出尾部）；不存在返回 null。 */
  view(id: string): ShellJobView | null {
    const job = this.find(id);
    return job ? this.toView(job) : null;
  }

  list(): ShellJobView[] {
    return [...this.jobs].sort((a, b) => b.startedAt - a.startedAt).map((j) => this.toView(j));
  }

  /** 输出全文（已按 keepChars 截尾）；不存在返回 null。 */
  output(id: string): string | null {
    const job = this.find(id);
    if (!job) return null;
    const parts: string[] = [];
    if (job.out.trim()) parts.push(job.out.trimEnd());
    if (job.err.trim()) parts.push(`[stderr] ${job.err.trimEnd()}`);
    return parts.join("\n");
  }

  /** 停止指定任务（id 或 "all"）；返回实际影响的数量（含清理已结束记录）。 */
  kill(target = "all"): number {
    let n = 0;
    for (const job of [...this.jobs]) {
      if (target !== "all" && job.id !== target) continue;
      if (job.status === "running" || job.status === "timeout") {
        try {
          job.proc.kill(9);
        } catch {
          /* 已退出 */
        }
        job.status = "killed";
        n += 1;
      }
      if (target !== "all") this.forget(job.id);
    }
    if (target === "all") {
      for (const job of [...this.jobs]) {
        if (job.status !== "running" && job.status !== "timeout") this.forget(job.id);
      }
    }
    return n;
  }

  /** 会话退出时调用。 */
  killAll(): void {
    for (const job of this.jobs) {
      if (job.status === "running" || job.status === "timeout") {
        try {
          job.proc.kill(9);
        } catch {
          /* 已退出 */
        }
        job.status = "killed";
      }
    }
    this.jobs = [];
  }

  /* ---------------- 内部 ---------------- */

  private find(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  private toView(job: Job): ShellJobView {
    return {
      id: job.id,
      command: job.command,
      cwd: job.cwd,
      status: job.status,
      exitCode: job.exitCode,
      elapsedMs: (job.endedAt ?? this.now()) - job.startedAt,
      promoted: job.promoted,
      out: job.out.length > 2_000 ? job.out.slice(-2_000) : job.out,
      err: job.err.length > 2_000 ? job.err.slice(-2_000) : job.err,
    };
  }

  private watch(job: Job): Promise<{ code: number }> {
    return (async () => {
      const pump = async (stream: ReadableStream<Uint8Array> | null | undefined, key: "out" | "err"): Promise<void> => {
        if (!stream) return;
        const decoder = new TextDecoder();
        try {
          for await (const chunk of stream) {
            job[key] += decoder.decode(chunk, { stream: true });
            if (job[key].length > this.keepChars) job[key] = job[key].slice(-this.keepChars);
          }
        } catch {
          /* 进程被杀时流会中断 */
        }
      };
      const [outP, errP] = [pump(job.proc.stdout, "out"), pump(job.proc.stderr, "err")];
      const code = await job.proc.exited;
      await Promise.all([outP, errP]);
      job.exitCode = code;
      job.endedAt = this.now();
      if (job.status === "running" || job.status === "timeout") job.status = "exited";
      return { code };
    })();
  }
}

/** 会话内唯一实例（与 TOOLS 注册表同口径）。 */
export const backgroundShells = new BackgroundShells();

/** 测试用：清空单例（杀掉残留进程，避免跨测试污染）。 */
export function resetBackgroundShells(opts: BackgroundShellOptions = {}): void {
  backgroundShells.killAll();
  Object.assign(backgroundShells, new BackgroundShells(opts));
}

/** `/ps` 与 `shell_output` 共用的状态标签。 */
export function shellStatusLabel(status: ShellStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "timeout":
      return "超时已转后台";
    case "exited":
      return "已结束";
    case "killed":
      return "已停止";
  }
}

/** `/ps` 的行（纯函数，便于单测）：id / 状态 / 耗时 / 命令摘要。 */
export function formatShellJobs(views: ShellJobView[]): string[] {
  if (views.length === 0) return ["没有后台命令。模型可用 shell（background: true）启动长任务。"];
  const lines = views.map((v) => {
    const secs = Math.max(0, Math.round(v.elapsedMs / 1000));
    const code = v.exitCode === null ? "" : ` exit=${v.exitCode}`;
    const promoted = v.promoted ? "（前台超时转入）" : "";
    const cmd = v.command.length > 60 ? `${v.command.slice(0, 60)}…` : v.command;
    return `  ${v.id}  ${shellStatusLabel(v.status)}${promoted}  ${secs}s${code}  ${cmd}`;
  });
  lines.push("  /ps kill <id|all> 停止 · shell_output 工具可按 id 读输出");
  return lines;
}
