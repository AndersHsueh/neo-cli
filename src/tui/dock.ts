/**
 * tui/dock.ts — Console 与底部 live 帧之间的桥（v0.3.0）。
 *
 * 为什么需要它：Console 原来直接往 stdout 写（流式 chunk / `\r\x1b[2K` 工具行 /
 * spinner / flashNotice）。底部有了 live 帧之后，**任何绕过帧的写入都会把帧擦掉**。
 * 这里把 Console 的写语义翻译成三类：
 *   1. 流式文本 → 行缓冲（凑满一行才提交流水线，pending 行作为帧上方的一行显示）；
 *   2. 工具行 / spinner → 帧里的「活动行」（transient：可被下一个工具覆盖）；
 *   3. line/blank/失败详情 → 提交行（进入 scrollback）。
 *
 * 非 TTY 不构造 dock（Console 走原路径），所以这里可以假定 Columns/ANSI 都可用。
 */
import { wrapAnsi } from "./ansi.ts";

/** 未完成行的最大缓冲：超过就按空格软断一次，避免 reasoning 通道无限 pending 导致 O(L²) rewrap。 */
const MAX_PENDING = 240;

/** dock 对宿主（composer）的最小要求，方便单测注入假宿主。 */
export interface DockHost {
  /** 当前终端列数（每次现取，resize 后立即生效）。 */
  width(): number;
  /** 把若干行提交到帧上方（进入 scrollback）。 */
  commitAbove(rows: string[]): void;
  /** 更新「流式未完成行」的显示（帧上方，不进入 scrollback）。 */
  setPending(rows: string[]): void;
  /** 更新活动行（spinner / 当前工具）。persist=true 时 stop/finish 会把它提交成历史。 */
  setActivity(text: string | null, persist: boolean): void;
  /** 把活动行提交成历史行（工具成功后由下一次输出触发；失败时立刻触发）。 */
  commitActivity(): void;
  /** 丢弃活动行（spinner 停止）。 */
  clearActivity(): void;
  /** 底部闪现提示（不占输入区）。 */
  notice(text: string, ms: number): void;
  /** 请求重画（宽度/活动行变化后）。 */
  rerender(): void;
}

export class TranscriptDock {
  /** 尚未遇到换行的流式文本（可能带 SGR）。 */
  private pending = "";
  private activity: string | null = null;
  private activityPersist = false;

  constructor(private readonly host: DockHost) {}

  /** 当前 pending 原文（测试/调试用）。 */
  get pendingText(): string { return this.pending; }

  private commit(rows: string[]): void {
    if (rows.length > 0) this.host.commitAbove(rows);
  }

  /** 流式文本：按完整行切分、按列折行后提交；剩余部分显示在帧上方。 */
  writeStream(text: string): void {
    if (text === "") return;
    this.pending += text;
    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.commit(wrapAnsi(line, this.host.width()));
    }
    this.trimPending();
    this.host.setPending(this.pending === "" ? [] : wrapAnsi(this.pending, this.host.width()));
  }

  /** 无换行长行（reasoning 通道）按 240 字符软断，避免每 delta 全量 rewrap。 */
  private trimPending(): void {
    while (this.pending.length > MAX_PENDING) {
      let cut = this.pending.lastIndexOf(" ", MAX_PENDING);
      if (cut <= 40) cut = MAX_PENDING;
      // 不能切在 ANSI 序列中间：若切点前 12 字符内有未闭合的 ESC 序列，退到它前面。
      const esc = this.pending.lastIndexOf("\x1b", cut);
      if (esc !== -1 && cut - esc < 12) {
        const seq = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(this.pending.slice(esc));
        if (seq && esc + seq[0].length > cut) cut = esc;
      }
      if (cut <= 0) break;
      const head = this.pending.slice(0, cut).trimEnd();
      this.pending = this.pending.slice(cut).replace(/^ +/, "");
      if (head !== "") this.commit(wrapAnsi(head, this.host.width()));
    }
  }

  /** 把未完成行强行收成一行（后面要接别的输出时用）。 */
  flushPending(): void {
    if (this.pending === "") return;
    this.commit(wrapAnsi(this.pending, this.host.width()));
    this.pending = "";
    this.host.setPending([]);
  }

  /** 提交一行（空串 = 空行）。pending 先落定，保证顺序。 */
  line(text = ""): void {
    this.flushPending();
    this.finishActivity();
    this.commit(wrapAnsi(text, this.host.width()));
  }

  blank(): void {
    this.line("");
  }

  /** 工具行开始/更新：transient 且 persist（下一个工具覆盖，遇其它输出提交）。 */
  tool(text: string): void {
    this.flushPending();
    this.activity = text;
    this.activityPersist = true;
    this.host.setActivity(text, true);
  }

  /** spinner：transient 且不 persist（停止即丢弃）。 */
  spinner(text: string | null): void {
    this.activity = text;
    this.activityPersist = false;
    this.host.setActivity(text, false);
  }

  /** 工具失败：活动行先落成历史，再批量提交详情行（一次 commitAbove）。 */
  failTool(detailLines: string[]): void {
    this.flushPending();
    this.commitActivity();
    const rows = detailLines.flatMap((l) => wrapAnsi(l, this.host.width()));
    if (rows.length > 0) this.host.commitAbove(rows);
  }

  /** 批量提交若干完整行（Console 详情模式 / statusBar 用；一次 commitAbove）。 */
  commitLines(lines: string[]): void {
    if (lines.length === 0) return;
    this.flushPending();
    this.finishActivity();
    const rows = lines.flatMap((l) => (l === "" ? [""] : wrapAnsi(l, this.host.width())));
    this.host.commitAbove(rows);
  }

  /** spinner/工具行收尾：persist 的提交，不 persist 的丢弃。 */
  finishActivity(): void {
    if (this.activity === null) return;
    // 只有「要落历史的工具行」才需要先把 pending 落定；spinner 收尾不能 flush ——
    // 否则 agent 在首个正文 chunk 前调 stopSpinner 时，会把刚写的「● 」单独提交成一行。
    if (this.activityPersist) {
      this.flushPending();
      this.commitActivity();
    } else {
      this.dropActivity();
    }
  }

  /** 丢弃活动行（例如 spinner 被 interrupt）。 */
  dropActivity(): void {
    this.activity = null;
    this.activityPersist = false;
    this.host.clearActivity();
  }

  private commitActivity(): void {
    this.activity = null;
    this.host.commitActivity();
  }

  notice(text: string, ms: number): void {
    this.host.notice(text, ms);
  }

  /** 终端 resize：pending 行按新宽度重排。 */
  resize(): void {
    if (this.pending !== "") this.host.setPending(wrapAnsi(this.pending, this.host.width()));
    this.host.rerender();
  }
}
