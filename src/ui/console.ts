/**
 * 控制台输出层。
 * 关键约束：readline 在交互模式下一直接管光标，任何非提示符写入都可能打乱行。
 * 因此所有写入都经由 Console 统一处理：流式输出结束后强制补一个换行，
 * 使 readline 的内部行缓冲回到一致状态。
 */
import { c, displayWidth, padEndW, truncate, glyph } from "./theme.ts";
import { nextDots, toolLineSegments, type ToolLineStatus } from "./toolLine.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MATRIX_FRAMES = ["ﾐ", "ﾋ", "ﾉ", "ﾘ", "ﾔ", "ｶ", "ﾁ", "ﾈ"];

export type StreamKind = "reasoning" | "answer" | "tool-args";

export class Console {
  private spinnerTimer: Timer | null = null;
  private spinnerText = "";
  private spinnerFrame = 0;
  private spinnerLineActive = false;
  private streaming = false;
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
  /**
   * 终端宽度。某些环境（PTY 未设置 winsize、CI）下 columns 为 0 或 undefined，
   * 直接参与算术会让 truncate 收到负数宽度 —— 必须夹到合理下限。
   */
  private cols(): number {
    const n = process.stdout.columns;
    return typeof n === "number" && n > 20 ? n : 100;
  }

  /** 终端宽度，供块级渲染用。非 TTY 与异常宽度下统一回落100。 */
  get width(): number {
    return this.cols();
  }

  /** 统一缩进，避免各处自己拼前缀。 */
  indent(body: string, prefix = "│ "): string {
    return body
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
  }

  constructor(
    private readonly useMatrixSpinner = true,
    toolcallInfoDetails = true,
  ) {
    // 紧凑模式只在 TTY 生效：非 TTY（管道 / -p / CI）保留逐行详情，避免动画控制符污染日志。
    this.toolCompact = !toolcallInfoDetails && process.stdout.isTTY === true;
  }

  // ---------- 紧凑工具行 ----------

  private renderToolLine(): void {
    if (!this.toolLineActive) return;
    const seg = toolLineSegments({
      name: this.toolName,
      args: this.toolArgs,
      width: this.cols(),
      dots: this.toolDots,
      status: this.toolStatus,
      errorText: this.toolError,
    });
    const tail =
      this.toolStatus === "ok"
        ? c.ok(seg.tail)
        : this.toolStatus === "error"
          ? c.err(seg.tail)
          : c.accent(seg.tail);
    const text =
      ` ${c.tool("⚡")} ${c.bright(seg.name)}` +
      (seg.args ? ` ${c.dim(seg.args)}` : "") +
      ` ${tail}`;
    process.stdout.write(`\r\x1b[2K${text}`);
  }

  /** 清掉当前工具行（下一个工具调用覆盖同一行时用，不留换行）。 */
  private clearToolLine(): void {
    if (!this.toolLineActive) return;
    if (this.toolLineTimer) {
      clearInterval(this.toolLineTimer);
      this.toolLineTimer = null;
    }
    this.toolLineActive = false;
    process.stdout.write("\r\x1b[2K");
  }

  /** 结束当前工具行（保留已显示内容并换行）；其它输出前调用。 */
  private finishToolLine(): void {
    if (!this.toolLineActive) return;
    if (this.toolLineTimer) {
      clearInterval(this.toolLineTimer);
      this.toolLineTimer = null;
    }
    this.toolLineActive = false;
    process.stdout.write("\n");
  }

  // ---------- 基础写入 ----------

  line(s = ""): void {
    this.stopSpinner();
    process.stdout.write(s + "\n");
  }

  blank(): void {
    this.line("");
  }

  /** 用户输入回显（带 Matrix 提示符）。 */
  promptEcho(text: string): void {
    this.stopSpinner();
    process.stdout.write(c.accent("❯ ") + c.text(text) + "\n");
  }

  // ---------- Spinner ----------

  startSpinner(text: string): void {
    this.stopSpinner();
    // 非 TTY（管道 / 重定向）下动画只会产生垃圾字符，直接跳过
    if (!process.stdout.isTTY) return;
    this.spinnerText = text;
    this.spinnerLineActive = false;
    this.spinnerTimer = setInterval(() => {
      const frames = this.useMatrixSpinner ? MATRIX_FRAMES : FRAMES;
      const f = frames[this.spinnerFrame++ % frames.length] ?? "⠋";
      const clear = this.spinnerLineActive ? "\r\x1b[2K" : "";
      this.spinnerLineActive = true;
      process.stdout.write(clear + ` ${c.accent(f)} ${c.dim(this.spinnerText)}`);
    }, 90);
    this.spinnerTimer.unref?.();
  }

  updateSpinner(text: string): void {
    this.spinnerText = text;
  }

  stopSpinner(finalLine?: string): void {
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
      process.stdout.write("\r\x1b[2K");
      this.spinnerLineActive = false;
    }
    if (finalLine) process.stdout.write(finalLine + "\n");
  }

  // ---------- 流式输出 ----------

  beginStream(kind: StreamKind): void {
    this.stopSpinner();
    if (this.streaming) return;
    this.streaming = true;
    switch (kind) {
      case "reasoning":
        process.stdout.write(c.dim("┌ think "));
        break;
      case "answer":
        process.stdout.write(c.accent("● "));
        break;
      case "tool-args":
        process.stdout.write(c.tool("│ "));
        break;
    }
  }

  writeStream(text: string, kind: StreamKind): void {
    if (!this.streaming) return;
    const painted = kind === "reasoning" ? c.dim(text) : c.text(text);
    process.stdout.write(painted);
  }

  endStream(kind: StreamKind): void {
    if (!this.streaming) return;
    this.streaming = false;
    // 结束流式行：填满剩余列以便清行，然后换行
    process.stdout.write("\n");
    if (kind === "reasoning") {
      process.stdout.write(c.dim("└─\n"));
    }
  }

  /** 无输出时也要收尾，避免提示符粘在思考行上。 */
  ensureStreamClosed(kind: StreamKind): void {
    if (this.streaming) this.endStream(kind);
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
   * 工具结果块（缩进、限高）。
   * 紧凑模式：不打印正文，只把当前行尾标改成 ✓ / ✗（失败附首行摘要）；
   * 下一个工具调用会覆盖这一行。
   */
  toolResult(body: string, maxLines = 18, ok = true): void {
    if (!this.toolCompact) {
      this.stopSpinner();
      const w = this.cols();
      const lines = body.replace(/\t/g, "  ").split("\n");
      const shown = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
      const indent = c.dim("│ ");
      const room = Math.max(20, w - 6);
      for (const l of shown) this.line(indent + c.muted(truncate(l, room)));
      if (lines.length > maxLines) {
        this.line(indent + c.dim(`… 还有 ${lines.length - maxLines} 行未显示`));
      }
      return;
    }

    // 紧凑模式：原地把当前行尾标改成 ✓/✗，不能先 finish（那会多出一行）。
    this.stopSpinnerOnly();

    this.toolStatus = ok ? "ok" : "error";
    this.toolError = ok ? "" : (body.split("\n")[0] ?? "");
    if (this.toolLineActive) {
      if (this.toolLineTimer) {
        clearInterval(this.toolLineTimer);
        this.toolLineTimer = null;
      }
      this.renderToolLine();
      return;
    }
    // 行已被其它输出收尾（例如审批问句）：用独立一行显示最终状态。
    const seg = toolLineSegments({
      name: this.toolName,
      args: this.toolArgs,
      width: this.cols(),
      status: this.toolStatus,
      errorText: this.toolError,
    });
    const tail = ok ? c.ok(seg.tail) : c.err(seg.tail);
    const text =
      ` ${c.tool("⚡")} ${c.bright(seg.name)}` + (seg.args ? ` ${c.dim(seg.args)}` : "") + ` ${tail}`;
    this.line(text);
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

  private stopStreamingRaw(): void {
    if (this.streaming) {
      this.streaming = false;
      process.stdout.write("\n");
    }
  }

  /** 让出一行给外部（readline）使用。 */
  flush(): void {
    this.finishToolLine();
    this.stopSpinner();
  }

  /**
   * 底部闪现一条提示（如 Ctrl+C 双击确认），ms 后自动清除。
   *
   * 清除用「回车 + 清行 + 重打提示符」而不是清屏：提示符行可能已有用户
   * 敲到一半的输入，重打 readline 缓冲能恢复显示；窗口极短，轻微错位可接受。
   */
  flashNotice(text: string, ms: number): void {
    if (!process.stdout.isTTY) return;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    process.stdout.write(c.warn(text));
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      process.stdout.write("\r\x1b[2K");
      this.promptEcho("");
    }, ms);
    this.flashTimer.unref?.();
  }

  private flashTimer: Timer | null = null;

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
    if (!process.stdin.isTTY) {
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
