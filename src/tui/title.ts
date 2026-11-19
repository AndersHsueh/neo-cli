/**
 * tui/title.ts — 会话标题展示（issue #82：静态标题，无动画）。
 *
 * 规则：
 *  - 标题恒为 `Agent: <名字>`，普通名 dim；
 *  - 名字为 `neo` 时同样显示 `Agent: neo`（v0.3.1 的 Mr.Anderson ↔ N E O
 *    渐变与字符雨已移除，不再有任何定时器）；
 *  - 空名字兜底显示 `neo`。
 *
 * 只产出 TitleView，不碰终端；Composer 负责着色与顶线布局。
 * `TitleView.matrix` 字段保留（composer 的注入渲染路径还在用），
 * 但本类自己始终产出 `matrix: false`。
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

export class TitleAnimator {
  private name: string | null = null;
  private view: TitleView = { prefix: "Agent", text: "neo", matrix: false };
  private onFrame: (() => void) | null = null;
  private started = false;

  isStarted(): boolean { return this.started; }
  getView(): TitleView { return { ...this.view }; }

  /** 名字变化（启动 / /rename / /resume adopt）：立即生效，无动画。 */
  setName(name: string | null): void {
    const next = (name ?? "").trim();
    if (this.started && next === this.name) return;
    this.name = next;
    this.view = { prefix: "Agent", text: next === "" ? "neo" : next, matrix: false };
    if (this.started) this.emit();
  }

  start(onFrame: () => void): void {
    if (this.started) return;
    this.started = true;
    this.onFrame = onFrame;
    this.emit();
  }

  stop(): void {
    this.started = false;
    this.onFrame = null;
  }

  private emit(): void {
    this.onFrame?.();
  }
}
