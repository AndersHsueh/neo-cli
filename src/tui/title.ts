/**
 * tui/title.ts — 会话标题展示 + Neo 专属动画（v0.3.1，可注入时钟/随机源）。
 *
 * 规则（用户 2026-10-26 拍板）：
 *  - 标题：`Agent: <名字>`；普通名 dim；
 *  - 名字 === "neo"：开局 `Mr.Anderson`（dim），每 10–20s 切换一次，
 *    在 `Mr.Anderson` ↔ `N E O`（Matrix 绿）之间往复；
 *  - 每次切换前 3 帧 ×80ms 字符雨，每帧显示宽度 == 目标文本宽度；
 *  - timer 由宿主（Composer）start/stop 统一管理；本类自己清 timer。
 *
 * 只产出 TitleView，不碰终端；Composer 负责着色与顶线布局。
 */

export interface TitleView {
  /** 固定前缀（当前恒为 "Agent"）。 */
  prefix: string;
  /** 显示名（不含前缀/busy 后缀）。 */
  text: string;
  /** true 时用 Matrix 绿渲染。 */
  matrix: boolean;
  /** 与名字分段着色的附加信息（如输入滚动范围），恒 dim。 */
  suffix?: string;
}

export type TitleTimer = ReturnType<typeof setTimeout>;

export interface TitleAnimatorDeps {
  rng?: () => number;
  setTimeout?: (fn: () => void, ms: number) => TitleTimer;
  clearTimeout?: (t: TitleTimer) => void;
  /** 切换间隔（毫秒，含端点）；默认 10_000–20_000。 */
  minSwitchMs?: number;
  maxSwitchMs?: number;
  /** 字符雨帧数（2–4）；默认 3。 */
  flashFrames?: number;
  /** 字符雨帧间隔；默认 80ms。 */
  flashFrameMs?: number;
  /** 字符雨候选字符（必须都是 1 列宽）。 */
  rainChars?: string;
}

const MR_ANDERSON = "Mr.Anderson";
const NEO_TITLE = "N E O";
const DEFAULT_RAIN = "01ｦｧｨｩｪｫｲｭﾐﾋﾉﾘﾔｶﾁﾈﾂ";

export class TitleAnimator {
  private readonly rng: () => number;
  private readonly setT: (fn: () => void, ms: number) => TitleTimer;
  private readonly clearT: (t: TitleTimer) => void;
  private readonly minSwitchMs: number;
  private readonly maxSwitchMs: number;
  private readonly flashFrames: number;
  private readonly flashFrameMs: number;
  private readonly rain: string[];

  private name: string | null = null;
  private view: TitleView = { prefix: "Agent", text: "neo", matrix: false };
  private timer: TitleTimer | null = null;
  private flash: { frames: string[]; index: number; matrix: boolean } | null = null;
  private onFrame: (() => void) | null = null;
  private started = false;

  constructor(deps: TitleAnimatorDeps = {}) {
    this.rng = deps.rng ?? Math.random;
    this.setT =
      deps.setTimeout ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      });
    this.clearT = deps.clearTimeout ?? ((t) => clearTimeout(t));
    this.minSwitchMs = Math.max(10, deps.minSwitchMs ?? 10_000);
    this.maxSwitchMs = Math.max(this.minSwitchMs, deps.maxSwitchMs ?? 20_000);
    this.flashFrames = Math.max(2, Math.min(4, deps.flashFrames ?? 3));
    this.flashFrameMs = Math.max(10, deps.flashFrameMs ?? 80);
    this.rain = Array.from(deps.rainChars ?? DEFAULT_RAIN);
  }

  isStarted(): boolean { return this.started; }
  getView(): TitleView { return { ...this.view }; }

  /** 名字变化（启动 / /rename / /resume adopt）。同名且已启动时不动画重启。 */
  setName(name: string | null): void {
    const next = (name ?? "").trim();
    if (this.started && next === this.name) return;
    this.name = next;
    this.clearTimers();
    if (next === "neo") {
      this.view = { prefix: "Agent", text: MR_ANDERSON, matrix: false };
      if (this.started) {
        this.scheduleSwitch();
        this.emit();
      }
      return;
    }
    this.view = { prefix: "Agent", text: next === "" ? "neo" : next, matrix: false };
    if (this.started) this.emit();
  }

  start(onFrame: () => void): void {
    if (this.started) return;
    this.started = true;
    this.onFrame = onFrame;
    if (this.name === "neo") {
      this.view = { prefix: "Agent", text: MR_ANDERSON, matrix: false };
      this.scheduleSwitch();
    }
    this.emit();
  }

  stop(): void {
    this.clearTimers();
    this.started = false;
    this.onFrame = null;
  }

  private clearTimers(): void {
    if (this.timer) {
      this.clearT(this.timer);
      this.timer = null;
    }
    this.flash = null;
  }

  private emit(): void {
    this.onFrame?.();
  }

  private randomDelay(): number {
    const span = this.maxSwitchMs - this.minSwitchMs;
    const v = Math.floor(this.rng() * (span + 1));
    return Math.min(this.maxSwitchMs, Math.max(this.minSwitchMs, this.minSwitchMs + v));
  }

  private scheduleSwitch(): void {
    const delay = this.randomDelay();
    this.timer = this.setT(() => {
      this.timer = null;
      this.beginTransition();
    }, delay);
  }

  private beginTransition(): void {
    const targetMatrix = !this.view.matrix;
    const targetText = targetMatrix ? NEO_TITLE : MR_ANDERSON;
    const frames = this.buildFrames(targetText);
    this.flash = { frames, index: 0, matrix: targetMatrix };
    this.view = { prefix: "Agent", text: frames[0] as string, matrix: targetMatrix };
    this.emit();
    this.scheduleFlash();
  }

  private scheduleFlash(): void {
    this.timer = this.setT(() => {
      this.timer = null;
      this.advanceFlash();
    }, this.flashFrameMs);
  }

  private advanceFlash(): void {
    const f = this.flash;
    if (!f) return;
    f.index += 1;
    if (f.index < f.frames.length) {
      this.view = { prefix: "Agent", text: f.frames[f.index] as string, matrix: f.matrix };
      this.emit();
      this.scheduleFlash();
      return;
    }
    this.flash = null;
    this.view = {
      prefix: "Agent",
      text: f.matrix ? NEO_TITLE : MR_ANDERSON,
      matrix: f.matrix,
    };
    this.emit();
    this.scheduleSwitch();
  }

  /** 帧宽必须等于目标文本（全部 1 列宽字符；空格位不替换）。 */
  private buildFrames(target: string): string[] {
    const chars = Array.from(target);
    const n = chars.length;
    const count = this.flashFrames;
    const frames: string[] = [];
    for (let i = 0; i < count; i += 1) {
      // 每一帧都至少留一个未收敛位，避免第 3 帧提前等于目标（实际只有 2 帧雨）。
      const locked = Math.floor(((i + 1) * n) / (count + 1));
      let s = "";
      for (let j = 0; j < n; j += 1) {
        const ch = chars[j] as string;
        if (j < locked || ch === " ") s += ch;
        else s += this.rain[Math.floor(this.rng() * this.rain.length) % this.rain.length] ?? "0";
      }
      frames.push(s);
    }
    return frames;
  }
}
