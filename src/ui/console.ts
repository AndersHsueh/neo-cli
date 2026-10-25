/**
 * 控制台输出层。
 * 关键约束：readline 在交互模式下一直接管光标，任何非提示符写入都可能打乱行。
 * 因此所有写入都经由 Console 统一处理：流式输出结束后强制补一个换行，
 * 使 readline 的内部行缓冲回到一致状态。
 *
 * v0.2.3：
 *  - 构造注入 `{ stdoutIsTTY, stdinIsTTY, columns, write }`，让 TTY 分支可在 bun test
 *    里直测（项目踩坑约定：不用 mock.module 全局污染）。
 *  - 流式块记录 kind（D1）：收尾时不再由调用方猜「关的是哪个块」。
 *  - 工具调用历史 + 失败详情（D3）；宽度/resize（D2）；Ctrl+C 提示交回 readline（D5）。
 *  - 动画行只有一个持有者：任何「借行」输出（flashNotice / resize）先走
 *    `yieldAnimationLines()`，避免两个计时器抢同一行。
 */
import { c, displayWidth, padEndW, truncate, glyph } from "./theme.ts";
import {
  nextDots,
  paintTail,
  toolLineSegments,
  toolLineText,
  type ToolLineStatus,
} from "./toolLine.ts";
import {
  FAILURE_DETAIL_LINES,
  MAX_TOOL_HISTORY,
  formatOutputLines,
  failureDetailRows,
  summarizeFailure,
  type ToolCallRecord,
} from "./toolLog.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MATRIX_FRAMES = ["ﾐ", "ﾋ", "ﾉ", "ﾘ", "ﾔ", "ｶ", "ﾁ", "ﾈ"];

export type StreamKind = "reasoning" | "answer" | "tool-args";

/** 构造注入点：默认走真实 stdout/stdin，测试注入收集器。 */
export interface ConsoleDeps {
  /** stdout 是否 TTY（影响紧凑模式与动画）。默认 process.stdout.isTTY。 */
  stdoutIsTTY?: boolean;
  /** stdin 是否 TTY（只影响审批问句）。默认 process.stdin.isTTY。 */
  stdinIsTTY?: boolean;
  /** 终端列数；默认读 process.stdout.columns。 */
  columns?: () => number;
  /**
   * 输出通道。默认 process.stdout.write。
   * 注意：与 SelectDeps.out 是两套（那个还要 on/off resize 事件）；
   * 这里只需 write，保持函数式最小面。
   */
  write?: (s: string) => void;
  /**
   * TTY 下的底部 live 帧桥（v0.3.0）。有 dock 时所有输出改走 dock：
   * 流式行缓冲、工具行 transient、状态条由 composer 负责；非 TTY 不传。
   */
  dock?: ConsoleDock;
}

/** Console 用到的 dock 子集（structural，避免 ui → tui 的实体依赖）。 */
export interface ConsoleDock {
  writeStream(text: string): void;
  line(text?: string): void;
  blank(): void;
  tool(text: string): void;
  spinner(text: string | null): void;
  dropActivity(): void;
  finishActivity(): void;
  failTool(detailLines: string[]): void;
  commitLines(lines: string[]): void;
  notice(text: string, ms: number): void;
  resize(): void;
}

export class Console {
  private spinnerTimer: Timer | null = null;
  private spinnerText = "";
  private spinnerFrame = 0;
  private spinnerLineActive = false;
  /** 当前打开的流式块类型（null = 无）。 */
  private streamKind: StreamKind | null = null;
  private asker: ((prompt: string) => Promise<string>) | null = null;
  /** 紧凑工具行模式（默认；toolcall_info_details=true 时走旧版详情块）。 */
  private readonly toolCompact: boolean;
  private toolLineActive = false;
  private toolLineTimer: Timer | null = null;
  private toolName = "";
  private toolArgs = "";
  private toolDots = 0;
  private toolStatus: ToolLineStatus = "running";
  private toolError = "";
  /** 当前工具开始时间（toolResult 用它算耗时）。 */
  private toolStartedAt = 0;
  /** 最近工具调用（含完整输出），供 /last 回看。 */
  private toolHistory: ToolCallRecord[] = [];
  /** 提示符重绘回调（由持有 readline 的一方注入；D5）。 */
  private promptRestorer: (() => void) | null = null;
  private flashTimer: Timer | null = null;
  private readonly dock: ConsoleDock | null;

  constructor(
    private readonly useMatrixSpinner = true,
    toolcallInfoDetails = true,
    private readonly deps: ConsoleDeps = {},
  ) {
    // 紧凑模式只在 TTY 生效：非 TTY（管道 / -p / CI）保留逐行详情，避免动画控制符污染日志。
    this.toolCompact = !toolcallInfoDetails && this.stdoutIsTTY();
    this.dock = deps.dock ?? null;
  }

  private stdoutIsTTY(): boolean {
    return this.deps.stdoutIsTTY ?? process.stdout.isTTY === true;
  }

  private stdinIsTTY(): boolean {
    return this.deps.stdinIsTTY ?? process.stdin.isTTY === true;
  }

  private write(s: string): void {
    (this.deps.write ?? ((x: string) => process.stdout.write(x)))(s);
  }

  /** 供 StreamFormatter 复用同一输出通道（正文/代码块也走注入点）。 */
  writeRaw(s: string): void {
    if (this.dock) { this.dock.writeStream(s); return; }
    this.write(s);
  }

  /**
   * 终端宽度。某些环境（PTY 未设置 winsize、CI）下 columns 为 0 或 undefined，
   * 直接参与算术会让 truncate 收到负数宽度 —— 必须夹到合理下限。
   * v0.2.3：回落值 100 → 80（80 列是终端最普遍的默认宽度，100 会系统性地算宽 20 列）。
   */
  private cols(): number {
    const n = this.deps.columns ? this.deps.columns() : process.stdout.columns;
    return typeof n === "number" && n > 20 ? n : 80;
  }

  /** 终端宽度，供块级渲染用。非 TTY 与异常宽度下统一回落 80。 */
  get width(): number {
    return this.cols();
  }

  /** 是否处于底部 live 帧模式（TTY）。showStats 据此决定单行摘要还是三行状态栏。 */
  get hasLiveDock(): boolean {
    return this.dock !== null;
  }

  /** 统一缩进，避免各处自己拼前缀。 */
  indent(body: string, prefix = "│ "): string {
    return body
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
  }

  // ---------- 动画行所有权 ----------

  /**
   * 把动画行（spinner / 紧凑工具行）收尾成完整行，让出当前行给别的输出。
   *
   * 只有这里能收尾动画行 —— flashNotice / resize / 异常输出都走它，
   * 否则两个计时器会用 `\r\x1b[2K` 抢同一行（v0.2.3 simplify 审查的 critical）。
   */
  private yieldAnimationLines(): void {
    this.finishToolLine();
    this.stopSpinnerOnly();
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
  }

  // ---------- 紧凑工具行 ----------

  /** 当前工具行的唯一拼装实现（dock / 非 dock / /last 之外的实时路径共用）。 */
  private toolLineNow(includeDots = true): string {
    const seg = toolLineSegments({
      name: this.toolName,
      args: this.toolArgs,
      width: this.cols(),
      ...(includeDots ? { dots: this.toolDots } : {}),
      status: this.toolStatus,
      errorText: this.toolError,
    });
    return toolLineText(seg, paintTail(seg, this.toolStatus));
  }

  private renderToolLine(): void {
    if (!this.toolLineActive) return;
    if (this.dock) {
      this.dock.tool(this.toolLineNow());
      return;
    }
    const seg = toolLineSegments({
      name: this.toolName,
      args: this.toolArgs,
      width: this.cols(),
      dots: this.toolDots,
      status: this.toolStatus,
      errorText: this.toolError,
    });
    this.write(`\r\x1b[2K${this.toolLineNow()}`);
  }

  /** 清掉当前工具行（下一个工具调用覆盖同一行时用，不留换行）。 */
  private clearToolLine(): void {
    if (!this.toolLineActive) return;
    if (this.dock) {
      if (this.toolLineTimer) { clearInterval(this.toolLineTimer); this.toolLineTimer = null; }
      this.toolLineActive = false;
      this.dock.dropActivity();
      return;
    }
    if (this.toolLineTimer) {
      clearInterval(this.toolLineTimer);
      this.toolLineTimer = null;
    }
    this.toolLineActive = false;
    this.write("\r\x1b[2K");
  }

  /** 结束当前工具行（保留已显示内容并换行）；其它输出前调用。 */
  private finishToolLine(): void {
    if (!this.toolLineActive) return;
    if (this.dock) {
      if (this.toolLineTimer) { clearInterval(this.toolLineTimer); this.toolLineTimer = null; }
      this.toolLineActive = false;
      this.dock.finishActivity();
      return;
    }
    if (this.toolLineTimer) {
      clearInterval(this.toolLineTimer);
      this.toolLineTimer = null;
    }
    this.toolLineActive = false;
    this.write("\n");
  }

  /** 记录一次工具调用（/last 回看的数据源）。 */
  private pushToolCall(rec: ToolCallRecord): void {
    this.toolHistory.push(rec);
    if (this.toolHistory.length > MAX_TOOL_HISTORY) {
      this.toolHistory.splice(0, this.toolHistory.length - MAX_TOOL_HISTORY);
    }
  }

  /** 最近的工具调用，最新在前。/last 用它（内部夹取范围，调用方不必再判）。 */
  recentToolCalls(n = MAX_TOOL_HISTORY): ToolCallRecord[] {
    const k = Math.max(1, Math.min(MAX_TOOL_HISTORY, Math.trunc(n) || 1));
    return this.toolHistory.slice(-k).reverse();
  }

  // ---------- 基础写入 ----------

  line(s = ""): void {
    if (this.dock) { this.stopSpinner(); this.dock.line(s); return; }
    this.stopSpinner();
    this.write(s + "\n");
  }

  blank(): void {
    if (this.dock) { this.stopSpinner(); this.dock.blank(); return; }
    this.line("");
  }

  // ---------- Spinner ----------

  startSpinner(text: string): void {
    this.stopSpinner();
    // 非 TTY（管道 / 重定向）下动画只会产生垃圾字符，直接跳过
    if (!this.stdoutIsTTY()) return;
    this.spinnerText = text;
    this.spinnerLineActive = false;
    this.spinnerTimer = setInterval(() => {
      const frames = this.useMatrixSpinner ? MATRIX_FRAMES : FRAMES;
      const f = frames[this.spinnerFrame++ % frames.length] ?? "⠋";
      if (this.dock) {
        this.dock.spinner(` ${f} ${this.spinnerText}`);
        return;
      }
      const clear = this.spinnerLineActive ? "\r\x1b[2K" : "";
      this.spinnerLineActive = true;
      this.write(clear + ` ${c.accent(f)} ${c.dim(this.spinnerText)}`);
    }, 90);
    this.spinnerTimer.unref?.();
  }

  updateSpinner(text: string): void {
    this.spinnerText = text;
  }

  stopSpinner(finalLine?: string): void {
    if (this.dock) {
      // dock 里工具行/spinner 都归一个活动行：finishActivity 会按 persist 决定提交/丢弃。
      if (this.spinnerTimer) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
      }
      if (this.toolLineTimer) {
        clearInterval(this.toolLineTimer);
        this.toolLineTimer = null;
      }
      this.toolLineActive = false;
      this.spinnerLineActive = false;
      this.dock.finishActivity();
      if (finalLine) this.dock.line(finalLine);
      return;
    }
    // 任何 spinner 停止都意味着要让出输出行：紧凑工具行先收尾（换行保留）。
    this.finishToolLine();
    this.stopSpinnerOnly(finalLine);
  }

  /** 只停 spinner，不动紧凑工具行（工具行原地更新时用）。 */
  private stopSpinnerOnly(finalLine?: string): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerLineActive) {
      this.write("\r\x1b[2K");
      this.spinnerLineActive = false;
    }
    if (this.dock) {
      if (finalLine) this.dock.line(finalLine);
      return;
    }
    if (finalLine) this.write(finalLine + "\n");
  }

  // ---------- 流式输出 ----------

  beginStream(kind: StreamKind): void {
    this.stopSpinner();
    if (this.streamKind) return;
    this.streamKind = kind;
    switch (kind) {
      case "reasoning":
        this.writeRaw(c.dim("┌ think "));
        break;
      case "answer":
        this.writeRaw(c.accent("● "));
        break;
      case "tool-args":
        this.writeRaw(c.tool("│ "));
        break;
    }
  }

  writeStream(text: string, kind: StreamKind): void {
    if (!this.streamKind) return;
    const painted = kind === "reasoning" ? c.dim(text) : c.text(text);
    this.writeRaw(painted);
  }

  /**
   * 结束流式块。
   * `newline=false` 用于正文：换行由 StreamFormatter 自己收尾，避免双空行。
   * kind 省略时按 beginStream 记录的块类型收尾（推理块补 `└─`）。
   */
  endStream(kind?: StreamKind, newline = true): void {
    if (!this.streamKind) return;
    const current = kind ?? this.streamKind;
    this.streamKind = null;
    if (newline) this.writeRaw("\n");
    if (current === "reasoning") this.writeRaw(c.dim("└─\n"));
  }

  /** 无输出时也要收尾：按当前打开的块类型关闭，避免「关了 answer、reasoning 的 └─ 丢了」。 */
  ensureStreamClosed(): void {
    if (this.streamKind) this.endStream(this.streamKind);
  }

  private stopStreamingRaw(): void {
    this.ensureStreamClosed();
  }

  // ---------- 尺寸变化 ----------

  /**
   * SIGWINCH / resize 处理（D2）。
   *
   * append-only 已输出的历史行无法回溯，能做的只有：**不再用 `\r\x1b[2K` 覆盖
   * 一个坐标已经失效的行**。做法是把动画行定格成完整行、从新行第 0 列重画；
   * 计时器**保留**（否则长任务里 resize 一次，动画就永久消失，看起来像卡死）。
   */
  handleResize(): void {
    if (!this.stdoutIsTTY()) return;
    if (this.dock) { this.dock.resize(); return; }
    if (this.toolLineActive) {
      this.write("\n"); // 旧行定格
      this.renderToolLine(); // 新行第 0 列，安全重画；toolLineTimer 继续跑
    } else if (this.spinnerLineActive) {
      this.write("\n");
      this.spinnerLineActive = false; // 下一帧自然从新行开始
    }
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.promptRestorer?.();
  }

  // ---------- 结构化区块 ----------

  /** 大标题块，例如工具调用。紧凑模式下只维护一行并用 . / .. / ... 动画。 */
  toolHeader(name: string, argsPreview: string): void {
    if (!this.toolCompact) {
      this.stopSpinner();
      const w = this.cols();
      const head = ` ${c.tool("⚡")} ${c.bright(name)}`;
      const room = w - displayWidth(name) - 6;
      const tail = room > 12 ? c.dim(truncate(argsPreview, room)) : "";
      this.line(head + (tail ? " " + tail : ""));
      this.toolStartedAt = Date.now();
      this.toolName = name;
      this.toolArgs = argsPreview;
      return;
    }

    // 下一个工具调用覆盖同一行：先清掉上一行（不留换行），再停 spinner。
    this.clearToolLine();
    this.stopSpinnerOnly();
    this.toolName = name;
    this.toolArgs = argsPreview;
    this.toolDots = 0;
    this.toolStatus = "running";
    this.toolError = "";
    this.toolStartedAt = Date.now();
    this.toolLineActive = true;
    this.renderToolLine();
    this.toolLineTimer = setInterval(() => {
      if (!this.toolLineActive || this.toolStatus !== "running") return;
      this.toolDots = nextDots(this.toolDots);
      this.renderToolLine();
    }, 350);
    this.toolLineTimer.unref?.();
  }

  /**
   * 工具结果块。
   *
   * 详情模式：缩进 + 限高打印正文。
   * 紧凑模式：成功只把当前行尾标改成 ✓（下一条覆盖）；失败把行收尾后补
   * ≤3 行错误正文 + `/last` 提示 —— 失败罕见但信息量最大，值得多占几行。
   *
   * 注意 maxLines 只在**详情模式**生效；紧凑模式的失败详情固定
   * FAILURE_DETAIL_LINES 行，避免把「一行覆盖」的清爽变成刷屏。
   */
  toolResult(body: string, maxLines = 18, ok = true): void {
    const record: ToolCallRecord = {
      name: this.toolName || "tool",
      args: this.toolArgs,
      ok,
      ms: this.toolStartedAt > 0 ? Date.now() - this.toolStartedAt : 0,
      output: body,
      at: Date.now(),
    };
    this.pushToolCall(record);

    if (this.dock && this.toolCompact) {
      const summary = ok ? null : summarizeFailure(body, { maxLines: FAILURE_DETAIL_LINES });
      this.toolStatus = ok ? "ok" : "error";
      this.toolError = summary?.tail ?? "";
      if (this.toolLineTimer) { clearInterval(this.toolLineTimer); this.toolLineTimer = null; }
      this.dock.tool(this.toolLineNow());
      this.toolLineActive = false;
      if (!ok && summary) this.dock.failTool(failureDetailRows(summary, this.cols()));
      return;
    }

    if (!this.toolCompact) {
      this.stopSpinner();
      const rows = formatOutputLines(body, { maxLines, width: this.cols(), margin: "│ " });
      if (this.dock) {
        this.dock.commitLines(rows);
        return;
      }
      for (const l of rows) this.line(l);
      return;
    }

    const summary = ok ? null : summarizeFailure(body, { maxLines: FAILURE_DETAIL_LINES });
    this.toolStatus = ok ? "ok" : "error";
    this.toolError = summary?.tail ?? "";
    this.stopSpinnerOnly();

    if (this.toolLineActive) {
      if (this.toolLineTimer) {
        clearInterval(this.toolLineTimer);
        this.toolLineTimer = null;
      }
      this.renderToolLine();
      // 失败行要留痕（失败信息比「一行覆盖」重要）；成功仍属于可覆盖的动画行
      if (!ok) {
        this.toolLineActive = false;
        this.write("\n");
      }
    } else {
      // 行已被其它输出收尾（例如审批问句 / resize）：用独立一行显示最终状态。
      this.line(this.toolLineNow(false));
    }

    if (!ok && summary) {
      for (const l of failureDetailRows(summary, this.cols())) this.line(l);
    }
  }

  /** 键值对，例如 usage 统计。 */
  kv(key: string, value: string): void {
    this.line(`${c.dim(key.padEnd(10))} ${value}`);
  }

  error(msg: string): void {
    this.stopSpinner();
    this.line(`${c.err("✖ ")} ${c.err(msg)}`);
  }

  warn(msg: string): void {
    this.stopStreamingRaw();
    this.line(`${c.warn("! ")} ${c.warn(msg)}`);
  }

  info(msg: string): void {
    this.stopStreamingRaw();
    this.line(`${c.dim("· ")} ${c.muted(msg)}`);
  }

  success(msg: string): void {
    this.line(`${c.ok("✔ ")} ${c.ok(msg)}`);
  }

  /** 状态栏（token / 停止原因 / 耗时）。 */
  statusBar(fields: Array<[string, string]>): void {
    this.stopSpinner();
    const parts = fields.map(([k, v]) => `${c.dim(k)} ${c.muted(v)}`);
    const line = parts.join(c.dim(" │ "));
    this.line("");
    this.line(c.dim("─".repeat(Math.max(10, Math.min(this.cols(), displayWidth(line) + 2)))));
    this.line(line);
  }

  /** 让出一行给外部（readline）使用。 */
  flush(): void {
    if (this.dock) { this.stopSpinner(); return; }
    this.yieldAnimationLines();
  }

  /**
   * 底部闪现一条提示（如 Ctrl+C 双击确认），ms 后自动清除。
   *
   * v0.2.3 修法：**不自己画提示符**。先收尾动画行（否则 350ms 的工具行计时器
   * 下一拍就把 readline 刚重画的提示符擦掉），再写提示 + 换行，然后调用注入的
   * `promptRestorer` 让 readline 重绘（保留用户已敲到一半的行缓冲）。
   */
  flashNotice(text: string, ms: number): void {
    if (!this.stdoutIsTTY()) return;
    if (this.dock) { this.dock.notice(text, ms); return; }
    this.yieldAnimationLines();
    this.write(`\r\x1b[2K${c.warn(text)}\n`);
    this.promptRestorer?.();
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.write("\r\x1b[2K");
      this.promptRestorer?.();
    }, ms);
    this.flashTimer.unref?.();
  }

  /**
   * 注册提示符重绘函数。必须由持有 readline 的一方向注入
   * （与 `setAsker` 同源理由：Console 不直接摸 readline）。
   */
  setPromptRestorer(fn: (() => void) | null): void {
    this.promptRestorer = fn;
  }

  // ---------- 审批交互 ----------

  /**
   * 询问用户是否批准一次敏感操作。
   *
   * 实现要点：**必须复用 readline 自己的问句机制**。
   * 若另起一个 raw-mode stdin 监听，readline 仍会同时消费并回显同一个字符，
   * 结果是输入内容被打印两遍、且可能与提示符错位。
   *
   * 非 TTY（管道 / CI / -p 重定向）下无法交互，一律拒绝并说明原因 ——
   * 挂起等待输入比直接失败糟糕得多。脚本里要放行请用 -y。
   */
  async confirm(question: string): Promise<boolean> {
    this.stopSpinner();
    if (!this.stdinIsTTY()) {
      this.line(
        `${c.warn("✖ 非交互模式")} ${c.dim("无法征求批准")} ${c.warn(question)}\n` +
          `  ${c.dim("已拒绝。脚本场景请显式加 -y（全部放行）或 --edit（仅放行写文件）。")}`,
      );
      return false;
    }
    const asker = this.asker;
    if (!asker) {
      this.line(`${c.warn("✖ 当前环境无法征求批准")} ${c.warn(question)} ${c.dim("已拒绝。")}`);
      return false;
    }

    this.blank();
    const answer = await asker(`${c.warn("?")} ${c.warn(question)} ${c.dim("[y/N]")} `);
    this.blank();
    return /^(y|yes|是|好|ok|allow)$/i.test(answer.trim());
  }

  /**
   * 注册问句函数。必须由持有 readline 的一方向注入，
   * 这样输入只被 readline 消费一次。
   */
  setAsker(fn: ((prompt: string) => Promise<string>) | null): void {
    this.asker = fn;
  }
}

// ---------- 单行读取 ----------

export { padEndW, glyph };
