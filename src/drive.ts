/**
 * 目标驱动自动续跑（issue #24）：`/drive`。
 *
 * 与既有 `/goal` 的分工（文档写死）：
 *  - `/goal <文本>` = **目标锚**（防跑偏，每轮注入给模型，模型不能改写；需要信箱）；
 *  - `/drive <检查命令> -- <提示>` = **可验证完成条件 + 自动续跑**：每轮结束跑检查命令，
 *    未通过就自动再排一轮提示，通过/到上限/连续空转就停。
 *
 * 设计铁律：**完成条件只认可验证信号**（检查命令退出码 0）。
 * 模型自己说「做完了」不算 —— 自述不可验证，会给「自欺循环」开闸。
 *
 * 本模块只放纯逻辑（状态机）；跑检查命令与入队都由调用方注入，便于单测。
 */

export interface DriveSpec {
  /** 完成条件：一条 shell 命令，退出码 0 = 达成。 */
  check: string;
  /** 每轮未达成时自动发送的提示（用户原始意图）。 */
  prompt: string;
  /** 最多自动推进多少轮（默认 5）。 */
  maxRounds: number;
}

export type DriveStatus = "running" | "done" | "exhausted" | "stopped";

export interface DriveCheckResult {
  ok: boolean;
  code: number | null;
  output: string;
}

export interface DriveState {
  spec: DriveSpec;
  status: DriveStatus;
  /** 已自动推进的轮数（不含用户手动那一轮）。 */
  rounds: number;
  /** 连续「模型没有调用任何工具」的轮数（防空转）。 */
  idleRounds: number;
  lastCheck: DriveCheckResult | null;
  startedAt: number;
  reason: string | null;
}

export interface DriveOutcome {
  action: "none" | "done" | "continue" | "exhausted" | "skipped" | "idle-stop";
  state: DriveState | null;
}

export interface DriveDeps {
  /** 跑检查命令（注入 shell 执行）。 */
  runCheck: (cmd: string) => Promise<DriveCheckResult>;
  /** 把提示排进会话队列；返回 false = 忙/队列非空（这一拍跳过）。 */
  enqueue: (prompt: string) => boolean;
  now?: () => number;
  /** 状态变化时通知（命令层用来打一行）。 */
  onEnd?: (state: DriveState, action: DriveOutcome["action"]) => void;
}

export const DEFAULT_DRIVE_MAX_ROUNDS = 5;
/** 连续多少轮没有工具调用就暂停（防空转烧钱）。 */
export const DRIVE_IDLE_LIMIT = 2;

export class DriveManager {
  private cur: DriveState | null = null;
  private running = false;
  private readonly now: () => number;

  constructor(private readonly deps: DriveDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get state(): DriveState | null {
    return this.cur ? { ...this.cur, spec: { ...this.cur.spec } } : null;
  }

  start(spec: DriveSpec): { ok: true } | { ok: false; error: string } {
    const check = spec.check.trim();
    const prompt = spec.prompt.trim();
    if (check === "") return { ok: false, error: "缺少检查命令（退出码 0 = 达成）" };
    if (prompt === "") return { ok: false, error: "缺少提示（未达成时自动发送的内容）" };
    const raw = Number.isFinite(spec.maxRounds) ? Math.floor(spec.maxRounds) : DEFAULT_DRIVE_MAX_ROUNDS;
    const maxRounds = Math.max(1, Math.min(20, raw));
    this.cur = {
      spec: { check, prompt, maxRounds },
      status: "running",
      rounds: 0,
      idleRounds: 0,
      lastCheck: null,
      startedAt: this.now(),
      reason: null,
    };
    return { ok: true };
  }

  stop(reason = "用户停止"): void {
    if (!this.cur || this.cur.status !== "running") return;
    this.cur.status = "stopped";
    this.cur.reason = reason;
  }

  /** 每轮结束时由组合根调用；返回本轮采取的动作。 */
  async onTurnEnd(args: { toolCalls: number }): Promise<DriveOutcome> {
    const state = this.cur;
    if (!state || state.status !== "running") return { action: "none", state: this.state };
    if (this.running) return { action: "none", state: this.state }; // 上一拍的检查还没跑完
    this.running = true;
    try {
      const check = await this.deps.runCheck(state.spec.check);
      state.lastCheck = check;
      if (check.ok) {
        state.status = "done";
        state.reason = `检查命令通过（exit 0）：${state.spec.check}`;
        this.deps.onEnd?.(this.state!, "done");
        return { action: "done", state: this.state };
      }
      // 防空转：连续 N 轮模型一个工具都没调，说明它大概率在原地打转。
      if (args.toolCalls === 0) state.idleRounds += 1;
      else state.idleRounds = 0;
      if (state.idleRounds >= DRIVE_IDLE_LIMIT) {
        state.status = "stopped";
        state.reason = `连续 ${state.idleRounds} 轮没有工具调用，已暂停（检查仍未通过）`;
        this.deps.onEnd?.(this.state!, "idle-stop");
        return { action: "idle-stop", state: this.state };
      }
      if (state.rounds >= state.spec.maxRounds) {
        state.status = "exhausted";
        state.reason = `已达自动推进上限 ${state.spec.maxRounds} 轮，检查仍未通过`;
        this.deps.onEnd?.(this.state!, "exhausted");
        return { action: "exhausted", state: this.state };
      }
      const queued = this.deps.enqueue(state.spec.prompt);
      if (!queued) return { action: "skipped", state: this.state };
      state.rounds += 1;
      this.deps.onEnd?.(this.state!, "continue");
      return { action: "continue", state: this.state };
    } finally {
      this.running = false;
    }
  }
}

/** `/drive` 无参时的状态行（纯函数，便于单测）。 */
export function formatDriveState(state: DriveState | null): string[] {
  if (!state) {
    return ["没有正在进行的自动续跑（/drive <检查命令> -- <提示> 启动，最多 5 轮）"];
  }
  const status =
    state.status === "running"
      ? "进行中"
      : state.status === "done"
        ? "已完成"
        : state.status === "exhausted"
          ? "已到上限"
          : "已停止";
  const lines = [
    `状态：${status} · 已自动推进 ${state.rounds}/${state.spec.maxRounds} 轮`,
    `检查命令（exit 0 = 达成）：${state.spec.check}`,
    `提示：${state.spec.prompt.length > 60 ? `${state.spec.prompt.slice(0, 60)}…` : state.spec.prompt}`,
  ];
  const last = state.lastCheck;
  if (last) {
    const tail = last.output.split(/\\r?\\n/).filter((l) => l.trim() !== "").slice(-2).join(" / ");
    lines.push(`最近一次检查：exit ${last.code ?? "?"}${tail ? ` · ${tail.slice(0, 160)}` : ""}`);
  }
  if (state.reason) lines.push(`说明：${state.reason}`);
  return lines;
}
