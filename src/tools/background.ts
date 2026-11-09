/**
 * 后台子代理任务表（issue #16）。
 *
 * 定位：`task` 工具的**异步模式**。同步模式一字不改（不传 background 就是旧行为）；
 * 传 `background: true` 时立刻返回任务 id，子代理在后台跑，完成后结果由主循环在
 * 下一次请求前以一条 user 消息注入（见 AgentOptions.pollBackground）。
 *
 * 纪律：
 *  - 默认仍 ≤1 层深度：后台任务跑的还是同一个子代理（task 工具对子代理不可见），不能无限套娃；
 *  - 并发上限（默认 3）：超过直接拒绝并说清楚，不静默排队（排队会拖垮「后台」的语义）；
 *  - 取消：每个任务一个 AbortController，`cancel` 会同步 abort —— 子代理通过 ctx.signal
 *    收到取消（runSubagent 已有 abort 链路）；
 *  - 结果只汇报一次：collectFinished() 取走即标记已汇报，避免重复注入。
 */
import type { ToolCtx } from "./types.ts";

export type BackgroundStatus = "running" | "done" | "error" | "cancelled";

export interface BackgroundJob {
  /** 稳定 id（bg-1、bg-2…，本进程内递增）。 */
  id: string;
  prompt: string;
  startedAt: number;
  status: BackgroundStatus;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
  /** 已汇报给主会话（collectFinished 取走后置 true）。 */
  reported: boolean;
  tier?: string;
  promptTier?: string;
  /** 发起时的工具上下文（审批/检查点委托；signal 会被替换成任务自己的）。 */
  ctx: ToolCtx;
}

/** `task` 工具发起后台任务时带过来的现场。 */
export interface BackgroundLaunch {
  prompt: string;
  tier?: string;
  promptTier?: string;
  /** 发起时的工具上下文（审批委托主 console；后台跑期间仍然有效）。 */
  ctx: ToolCtx;
}

/** 交给 `/tasks` 展示的只读视图。 */
export interface BackgroundView {
  id: string;
  status: BackgroundStatus;
  prompt: string;
  elapsedMs: number;
  result: string | null;
  error: string | null;
}

export interface BackgroundOptions {
  /** 真正跑子代理的函数（组合根注入 runSubagent）。 */
  run: (job: BackgroundJob, signal: AbortSignal) => Promise<string>;
  /** 并发上限（默认 3）。 */
  max?: number;
  now?: () => number;
}

export const DEFAULT_BACKGROUND_MAX = 3;

export class BackgroundTasks {
  private readonly jobs: BackgroundJob[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private seq = 0;
  private readonly max: number;
  private readonly now: () => number;

  constructor(private readonly opts: BackgroundOptions) {
    this.max = opts.max ?? DEFAULT_BACKGROUND_MAX;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 当前运行中的任务数。 */
  get runningCount(): number {
    return this.jobs.filter((j) => j.status === "running").length;
  }

  get size(): number {
    return this.jobs.length;
  }

  /**
   * 启动一个后台任务。超过并发上限返回 error（不排队 —— 排队会让「后台」变成隐藏积压）。
   */
  launch(job: BackgroundLaunch): { ok: true; job: BackgroundJob } | { ok: false; error: string } {
    if (this.runningCount >= this.max) {
      return {
        ok: false,
        error: `后台子代理已达并发上限 ${this.max}（用 /tasks 查看，/tasks cancel 取消）`,
      };
    }
    this.seq += 1;
    const ctrl = new AbortController();
    const record: BackgroundJob = {
      id: `bg-${this.seq}`,
      prompt: job.prompt,
      startedAt: this.now(),
      status: "running",
      finishedAt: null,
      result: null,
      error: null,
      reported: false,
      tier: job.tier,
      promptTier: job.promptTier,
      ctx: job.ctx,
    };
    this.jobs.push(record);
    this.controllers.set(record.id, ctrl);
    // 不 await：这就是「后台」的全部含义。失败收敛到任务状态，不抛给主循环。
    void this.opts
      .run(record, ctrl.signal)
      .then((text) => {
        if (record.status === "cancelled") return;
        record.status = "done";
        record.result = text;
      })
      .catch((e: unknown) => {
        if (record.status === "cancelled") return;
        record.status = "error";
        record.error = (e as Error)?.message ?? String(e);
      })
      .finally(() => {
        record.finishedAt = this.now();
        this.controllers.delete(record.id);
      });
    return { ok: true, job: record };
  }

  /** 所有任务（新→旧）。 */
  list(): BackgroundView[] {
    return [...this.jobs]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((j) => ({
        id: j.id,
        status: j.status,
        prompt: j.prompt,
        elapsedMs: (j.finishedAt ?? this.now()) - j.startedAt,
        result: j.result,
        error: j.error,
      }));
  }

  /**
   * 取走「已结束且尚未汇报」的结果，标记为已汇报。
   * 返回给主循环注入用的文本块（每块一条 user 消息）。
   */
  collectFinished(): string[] {
    const out: string[] = [];
    for (const j of this.jobs) {
      if (j.reported || j.status === "running") continue;
      j.reported = true;
      if (j.status === "done") {
        out.push(
          `<后台子代理结果 id="${j.id}" status="done"\n${j.result ?? ""}\n</后台子代理结果>`,
        );
      } else if (j.status === "error") {
        out.push(
          `<后台子代理结果 id="${j.id}" status="error">\n失败：${j.error ?? "未知错误"}\n</后台子代理结果>`,
        );
      }
      // cancelled 不汇报：用户主动取消的任务不需要再打扰主会话。
    }
    return out;
  }

  /** 取消指定任务；"all" 或空 = 全部。返回实际取消的数量。 */
  cancel(target = "all"): number {
    const ids = target === "all" ? [...this.controllers.keys()] : [target];
    let n = 0;
    for (const id of ids) {
      const ctrl = this.controllers.get(id);
      const job = this.jobs.find((j) => j.id === id);
      if (!ctrl || !job || job.status !== "running") continue;
      job.status = "cancelled";
      try {
        ctrl.abort();
      } catch {
        /* 已中止 */
      }
      this.controllers.delete(id);
      n += 1;
    }
    return n;
  }

  /** 会话退出时调用。 */
  cancelAll(): void {
    this.cancel("all");
  }
}
