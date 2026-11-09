/**
 * issue #25：定时 / 自节奏循环提示（`/loop`）。
 *
 * 纯逻辑 + 注入式定时器，便于单测：
 *  - `parseLoopCommand` / `parseInterval`：命令与间隔解析；
 *  - `LoopScheduler`：interval（时钟）/ self（上一轮结束后）两种节奏；
 *    忙碌或队列非空时**丢弃这一拍**（不排队、不叠加），计入 skipped；
 *  - `formatLoopStatus`：`/loop` 无参时的状态行。
 *
 * 纪律：默认关闭；会话退出必须 dispose（不留幽灵定时器）；定时器 unref。
 */
export type LoopMode = "interval" | "self";

export interface LoopSpec {
  mode: LoopMode;
  /** interval 模式生效；self 模式忽略。 */
  intervalMs: number;
  prompt: string;
}

export interface LoopState {
  spec: LoopSpec;
  startedAt: number;
  /** 成功入队的拍数。 */
  runs: number;
  /** 因忙碌/队列非空被丢弃的拍数。 */
  skipped: number;
  /** 下一次唤醒的 epoch ms；self 模式等待轮末时为 null。 */
  nextAt: number | null;
}

export const LOOP_MIN_INTERVAL_MS = 5_000;
export const LOOP_MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 解析 `30s` / `2m` / `1h` / 纯数字（秒）。非法返回 null。 */
export function parseInterval(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === "") return null;
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "s";
  const ms = n * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000);
  return Math.round(ms);
}

export type ParsedLoopCommand =
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "start"; spec: LoopSpec; warning?: string }
  | { kind: "error"; message: string };

/**
 * 解析 `/loop` 的参数（命令后面那一段，已 trim）。
 *  - 空 → status；`stop`/`off` → stop；
 *  - `self <提示>` → 自节奏；
 *  - `<间隔> <提示>` → 固定间隔；
 *  - 其它 → error（带用法）。
 */
export function parseLoopCommand(arg: string): ParsedLoopCommand {
  const text = arg.trim();
  if (text === "") return { kind: "status" };
  if (text === "stop" || text === "off") return { kind: "stop" };

  const firstSpace = text.indexOf(" ");
  const head = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();
  const usage = "用法：/loop <间隔如 2m> <提示> · /loop self <提示> · /loop stop";

  if (head.toLowerCase() === "self") {
    if (rest === "") return { kind: "error", message: `缺少提示。${usage}` };
    return { kind: "start", spec: { mode: "self", intervalMs: 0, prompt: rest } };
  }

  const parsed = parseInterval(head);
  if (parsed === null) {
    return { kind: "error", message: `间隔无法识别（"${head}"），支持 30s / 2m / 1h / 纯数字秒。${usage}` };
  }
  if (rest === "") return { kind: "error", message: `缺少提示。${usage}` };

  const warnings: string[] = [];
  let ms = parsed;
  if (ms < LOOP_MIN_INTERVAL_MS) {
    ms = LOOP_MIN_INTERVAL_MS;
    warnings.push(`间隔过小，已夹紧到 ${formatInterval(ms)}`);
  }
  if (ms > LOOP_MAX_INTERVAL_MS) {
    ms = LOOP_MAX_INTERVAL_MS;
    warnings.push(`间隔过大，已夹紧到 ${formatInterval(ms)}`);
  }
  return {
    kind: "start",
    spec: { mode: "interval", intervalMs: ms, prompt: rest },
    ...(warnings.length > 0 ? { warning: warnings.join("；") } : {}),
  };
}

export function formatInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
  if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
  return `${Math.round(ms / 1_000)} 秒`;
}

/** `/loop` 无参时的状态行（纯函数，便于单测）。 */
export function formatLoopStatus(state: LoopState | null, now: number): string[] {
  if (!state) return ["当前没有循环（/loop <间隔> <提示> 启动，/loop self <提示> 自节奏）"];
  const { spec } = state;
  const modeText = spec.mode === "self" ? "自节奏（上一轮结束后）" : `每 ${formatInterval(spec.intervalMs)}`;
  const lines = [
    `模式：${modeText}`,
    `已跑 ${state.runs} 次${state.skipped > 0 ? ` · 跳过 ${state.skipped} 次（忙碌/队列非空）` : ""}`,
  ];
  if (state.nextAt !== null) {
    const secs = Math.max(0, Math.round((state.nextAt - now) / 1000));
    lines.push(`下次唤醒：${secs}s 后`);
  } else if (spec.mode === "self") {
    lines.push("下次唤醒：等待本轮结束");
  }
  lines.push(`提示：${spec.prompt.length > 60 ? `${spec.prompt.slice(0, 60)}…` : spec.prompt}`);
  return lines;
}

export interface LoopTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (t: unknown) => void;
}

export interface LoopSchedulerOptions {
  /** 尝试把一拍注入会话；返回 false = 忙碌/队列非空，这一拍丢弃。 */
  enqueue: (prompt: string) => boolean;
  /** 定时器注入（测试用假时钟）。 */
  timers?: LoopTimers;
  now?: () => number;
}

/** 循环调度器：interval 按固定间隔排；self 在每次 turn 结束后排下一拍。 */
export class LoopScheduler {
  private timer: unknown = null;
  private cur: LoopState | null = null;
  private readonly timers: LoopTimers;
  private readonly now: () => number;

  constructor(private readonly opts: LoopSchedulerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.timers =
      opts.timers ??
      ({
        set: (fn, ms) => {
          const t = setTimeout(fn, ms);
          (t as { unref?: () => void }).unref?.();
          return t;
        },
        clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      } satisfies LoopTimers);
  }

  get state(): LoopState | null {
    return this.cur;
  }

  /** 启动（已在跑则替换旧循环）。interval 模式立刻跑第一拍，self 模式也立刻跑第一拍。 */
  start(spec: LoopSpec): void {
    this.clearTimer();
    this.cur = { spec, startedAt: this.now(), runs: 0, skipped: 0, nextAt: null };
    this.fire();
  }

  /** 停止并清空状态；再调无害。 */
  stop(): void {
    this.clearTimer();
    this.cur = null;
  }

  /** 会话退出时调用：与 stop 同义，单独命名以强调「不留幽灵定时器」。 */
  dispose(): void {
    this.stop();
  }

  /** 每轮 turn 结束时由组合根调用：self 模式据此排下一拍。 */
  onTurnEnd(): void {
    if (!this.cur || this.cur.spec.mode !== "self") return;
    if (this.timer !== null) return;
    this.scheduleIn(0);
  }

  private fire(): void {
    // fire 可能由定时器或 start 触发；cur 为 null 说明刚被 stop。
    if (!this.cur) return;
    const ok = this.opts.enqueue(this.cur.spec.prompt);
    if (ok) this.cur.runs += 1;
    else this.cur.skipped += 1;
    if (this.cur.spec.mode === "interval") this.scheduleIn(this.cur.spec.intervalMs);
    else this.cur.nextAt = null;
  }

  private scheduleIn(ms: number): void {
    if (!this.cur) return;
    this.cur.nextAt = this.now() + ms;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.fire();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }
}
