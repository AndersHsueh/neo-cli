/**
 * 目标驱动自动续跑（issue #24）：`/drive`。
 *
 * 与既有 `/goal` 的分工（文档写死）：
 *  - `/goal <文本>` = **目标锚**（防跑偏，每轮注入给模型，模型不能改写；需要信箱）；
 *  - `/drive <检查命令> -- <提示>` = **可验证完成条件 + 自动续跑**：每轮结束跑检查命令，
 *    未通过就自动再排一轮提示，通过/到上限/连续空转就停。
 *
 * 设计铁律（issue #50 修正后）：**验证优先，模型判断单独标注来源**。
 *  - 检查命令 exit 0 = **已验证**（verified），这是硬条件；
 *  - 用户显式给 `--judge "<标准>"` 时，检查命令未过（或没有检查命令）再问模型判断，
 *    达成则停止推进，但来源标注为**模型判断**（model），绝不冒充「已验证」。
 *
 * 本模块只放纯逻辑（状态机）；跑检查命令、问模型、入队都由调用方注入，便于单测。
 */

/** 完成判定的来源：verified = 检查命令 exit 0；model = 模型判断（issue #50）。 */
export type DriveSource = "verified" | "model";

export interface DriveSpec {
  /** 完成条件：一条 shell 命令，退出码 0 = 达成。空串 = 没有检查命令（只靠 judge）。 */
  check: string;
  /** 模型判断标准（issue #50）。不给 = 不启用模型判断。 */
  judge?: { criteria: string };
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
  /** 完成判定的来源（issue #50）：done 才有意义；null = 还没判定过。 */
  source: DriveSource | null;
  /** 最近一次模型判断的结果（issue #50）：null = 还没问过。 */
  lastJudge: { done: boolean; reason: string | null } | null;
  /** 连续 judge 失败次数（抛错/超时/输出不可解析），issue #50。 */
  judgeFailures: number;
  /** 最近一次 judge 失败的说明（给用户看）。 */
  lastJudgeNote: string | null;
}

export interface DriveOutcome {
  action: "none" | "done" | "continue" | "exhausted" | "skipped" | "idle-stop";
  state: DriveState | null;
}

/** 模型判断的输入（issue #50，PRD §2.3）。 */
export interface JudgeInput {
  criteria: string;
  prompt: string;
  /** 最近一轮工具输出摘要（已截断并标注）。 */
  recentOutput: string;
  lastCheck: DriveCheckResult | null;
}

/** 模型判断的结果；`invalid: true` = 输出不可解析（按未达成处理）。 */
export interface JudgeResult {
  done: boolean;
  reason?: string;
  invalid?: boolean;
}

export interface DriveDeps {
  /** 跑检查命令（注入 shell 执行）。 */
  runCheck: (cmd: string) => Promise<DriveCheckResult>;
  /** 把提示排进会话队列；返回 false = 忙/队列非空（这一拍跳过）。 */
  enqueue: (prompt: string) => boolean;
  /** 模型判断（issue #50）。不传 = 不支持 judge，start 会明确报错。 */
  evaluate?: (input: JudgeInput) => Promise<JudgeResult>;
  now?: () => number;
  /**
   * 防空转阈值（issue #51）。默认 `DRIVE_IDLE_LIMIT`；传 0 = 关闭防空转。
   * `-p --drive` 无人值守下必须关掉：无人可问，「停下来」没有意义，
   * 轮次耗尽才是 PRD §2.2 规定的终态。
   */
  idleLimit?: number;
  /** 状态变化时通知（命令层用来打一行）。 */
  onEnd?: (state: DriveState, action: DriveOutcome["action"]) => void;
}

export const DEFAULT_DRIVE_MAX_ROUNDS = 5;
/** 连续多少轮没有工具调用就暂停（防空转烧钱）。 */
export const DRIVE_IDLE_LIMIT = 2;
/** 模型判断连续失败多少次就暂停（issue #50，PRD §2.2）。 */
export const JUDGE_FAILURE_LIMIT = 2;

export class DriveManager {
  private cur: DriveState | null = null;
  private running = false;
  private readonly now: () => number;
  /** 防空转阈值；0 = 关闭（issue #51：`-p` 无人值守下没有「停下来问人」这回事）。 */
  private readonly idleLimit: number;

  constructor(private readonly deps: DriveDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.idleLimit = deps.idleLimit ?? DRIVE_IDLE_LIMIT;
  }

  get state(): DriveState | null {
    return this.cur ? { ...this.cur, spec: { ...this.cur.spec } } : null;
  }

  start(spec: DriveSpec): { ok: true } | { ok: false; error: string } {
    const check = spec.check.trim();
    const prompt = spec.prompt.trim();
    const criteria = spec.judge?.criteria.trim() ?? "";
    if (check === "" && criteria === "") {
      return {
        ok: false,
        error: "缺少完成条件：给检查命令（退出码 0 = 达成）或 --judge \"<标准>\"（模型判断）",
      };
    }
    if (criteria !== "" && !this.deps.evaluate) {
      return { ok: false, error: "当前会话不支持模型判断（未接线 evaluate）" };
    }
    if (prompt === "") return { ok: false, error: "缺少提示（未达成时自动发送的内容）" };
    const raw = Number.isFinite(spec.maxRounds) ? Math.floor(spec.maxRounds) : DEFAULT_DRIVE_MAX_ROUNDS;
    const maxRounds = Math.max(1, Math.min(20, raw));
    this.cur = {
      spec: { check, ...(criteria !== "" ? { judge: { criteria } } : {}), prompt, maxRounds },
      status: "running",
      rounds: 0,
      idleRounds: 0,
      lastCheck: null,
      startedAt: this.now(),
      reason: null,
      source: null,
      lastJudge: null,
      judgeFailures: 0,
      lastJudgeNote: null,
    };
    return { ok: true };
  }

  stop(reason = "用户停止"): void {
    if (!this.cur || this.cur.status !== "running") return;
    this.cur.status = "stopped";
    this.cur.reason = reason;
  }

  /**
   * 墙钟是否已超时（issue #51）。
   *
   * 只在**轮间**由调用方检查 —— 单轮本身可能超过上限（受 80 次工具迭代与单轮
   * token 预算约束），到点时若正处一轮中，等该轮结束再停，不做硬杀（PRD §2.5）。
   */
  expired(maxMs: number): boolean {
    if (!this.cur || this.cur.status !== "running") return false;
    return this.now() - this.cur.startedAt >= maxMs;
  }

  /** 标记为墙钟超时（issue #51）：与 exhausted 区分，摘要里 status=timeout。 */
  timeout(reason: string): void {
    if (!this.cur || this.cur.status !== "running") return;
    this.cur.status = "stopped";
    this.cur.reason = reason;
  }

  /** 每轮结束时由组合根调用；返回本轮采取的动作。 */
  async onTurnEnd(args: { toolCalls: number; recentOutput?: string }): Promise<DriveOutcome> {
    const state = this.cur;
    if (!state || state.status !== "running") return { action: "none", state: this.state };
    if (this.running) return { action: "none", state: this.state }; // 上一拍的检查还没跑完
    this.running = true;
    try {
      // ---- 1. 检查命令（硬条件）：有才跑；exit 0 → 已验证 ----
      let check: DriveCheckResult | null = null;
      if (state.spec.check !== "") {
        check = await this.deps.runCheck(state.spec.check);
        state.lastCheck = check;
        if (check.ok) {
          state.status = "done";
          state.source = "verified";
          state.reason = `检查命令通过（exit 0，已验证）：${state.spec.check}`;
          this.deps.onEnd?.(this.state!, "done");
          return { action: "done", state: this.state };
        }
      }

      // ---- 2. 模型判断（issue #50）：检查命令未过 / 没有检查命令时再问 ----
      const criteria = state.spec.judge?.criteria;
      if (criteria && this.deps.evaluate) {
        const verdict = await this.judgeOnce(state, criteria, check, args.recentOutput ?? "");
        if (verdict === "failed") {
          // 连续失败到上限 → 暂停并交回用户（PRD §2.2）。
          if (state.judgeFailures >= JUDGE_FAILURE_LIMIT) {
            state.status = "stopped";
            state.reason = `模型判断连续 ${state.judgeFailures} 次失败（${state.lastJudgeNote ?? "未知原因"}），已暂停`;
            this.deps.onEnd?.(this.state!, "idle-stop");
            return { action: "idle-stop", state: this.state };
          }
        } else if (verdict.done) {
          state.status = "done";
          state.source = "model";
          const why = verdict.reason ? `：${verdict.reason}` : "";
          state.reason =
            check !== null
              ? `模型判断达成（检查命令未通过；来源为模型判断，不是检查命令结果）${why}`
              : `模型判断达成（来源为模型判断，不是检查命令结果）${why}`;
          this.deps.onEnd?.(this.state!, "done");
          return { action: "done", state: this.state };
        }
      }

      // ---- 3. 未达成：防空转 / 上限 / 再排一轮 ----
      // 防空转：连续 N 轮模型一个工具都没调，说明它大概率在原地打转。
      // issue #51：`-p` 无人值守下关掉这条（idleLimit=0）—— 无人可问，「停下来」没有意义，
      // 轮次耗尽才是 PRD §2.2 规定的终态 exhausted。
      if (args.toolCalls === 0) state.idleRounds += 1;
      else state.idleRounds = 0;
      if (this.idleLimit > 0 && state.idleRounds >= this.idleLimit) {
        state.status = "stopped";
        state.reason = `连续 ${state.idleRounds} 轮没有工具调用，已暂停（条件仍未达成）`;
        this.deps.onEnd?.(this.state!, "idle-stop");
        return { action: "idle-stop", state: this.state };
      }
      if (state.rounds >= state.spec.maxRounds) {
        state.status = "exhausted";
        state.reason = `已达自动推进上限 ${state.spec.maxRounds} 轮，条件仍未达成`;
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

  /**
   * 问一次模型判断（issue #50）。
   *
   * 抛错 / 超时 / 输出不可解析都按**未达成**处理并累加失败计数 ——
   * 绝不因为「判断失败」就宣布完成，也不让异常击穿状态机。
   */
  private async judgeOnce(
    state: DriveState,
    criteria: string,
    check: DriveCheckResult | null,
    recentOutput: string,
  ): Promise<JudgeResult | "failed"> {
    let result: JudgeResult;
    try {
      result = await this.deps.evaluate!({ criteria, prompt: state.spec.prompt, recentOutput, lastCheck: check });
    } catch (e) {
      state.judgeFailures += 1;
      state.lastJudgeNote = `判断请求失败：${(e as Error).message}`;
      return "failed";
    }
    if (result.invalid || typeof result.done !== "boolean") {
      state.judgeFailures += 1;
      state.lastJudgeNote = "判断输出无法解析（按未达成处理）";
      return "failed";
    }
    state.judgeFailures = 0;
    state.lastJudgeNote = null;
    state.lastJudge = { done: result.done, reason: result.reason?.trim() || null };
    return result;
  }
}

/** `/drive` 无参时的状态行（纯函数，便于单测）。 */
export function formatDriveState(state: DriveState | null): string[] {
  if (!state) {
    return [
      "没有正在进行的自动续跑（/drive <检查命令> -- <提示> 启动，最多 5 轮）",
      "  也可用 /drive --judge \"<完成标准>\" -- <提示>：由模型判断是否达成（来源标注为模型判断）",
    ];
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
  ];
  if (state.spec.check !== "") {
    lines.push(`检查命令（exit 0 = 达成）：${state.spec.check}`);
  }
  if (state.spec.judge) {
    lines.push(`模型判断标准：${state.spec.judge.criteria}`);
  }
  lines.push(
    `提示：${state.spec.prompt.length > 60 ? `${state.spec.prompt.slice(0, 60)}…` : state.spec.prompt}`,
  );
  const last = state.lastCheck;
  if (last) {
    const tail = last.output.split(/\\r?\\n/).filter((l) => l.trim() !== "").slice(-2).join(" / ");
    lines.push(`最近一次检查：exit ${last.code ?? "?"}${tail ? ` · ${tail.slice(0, 160)}` : ""}`);
  }
  // issue #50：最近一次判断的来源与原因要看得见（PRD §2.2）。
  if (state.lastJudge) {
    const verdict = state.lastJudge.done ? "达成" : "未达成";
    const why = state.lastJudge.reason ? ` · ${state.lastJudge.reason}` : "";
    lines.push(`最近判断：模型判断 · ${verdict}${why}`);
  }
  if (state.source) {
    lines.push(`完成来源：${state.source === "verified" ? "已验证（检查命令 exit 0）" : "模型判断（来源为模型判断，不是检查命令结果）"}`);
  }
  if (state.judgeFailures > 0 && state.lastJudgeNote) {
    lines.push(`判断异常：连续 ${state.judgeFailures} 次 · ${state.lastJudgeNote}`);
  }
  if (state.reason) lines.push(`说明：${state.reason}`);
  return lines;
}
