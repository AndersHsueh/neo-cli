/**
 * 控制台输出层。
 * 关键约束：readline 在交互模式下一直接管光标，任何非提示符写入都可能打乱行。
 * 因此所有写入都经由 Console 统一处理：流式输出结束后强制补一个换行，
 * 使 readline 的内部行缓冲回到一致状态。
 */
import { c, displayWidth, padEndW, truncate, glyph } from "./theme.ts";

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
  /**
   * 终端宽度。某些环境（PTY 未设置 winsize、CI）下 columns 为 0 或 undefined，
   * 直接参与算术会让 truncate 收到负数宽度 —— 必须夹到合理下限。
   */
  private cols(): number {
    const n = process.stdout.columns;
    return typeof n === "number" && n > 20 ? n : 100;
  }

  constructor(private readonly useMatrixSpinner = true) {}

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

  /** 大标题块，例如工具调用。 */
  toolHeader(name: string, argsPreview: string): void {
    this.stopSpinner();
    const w = this.cols();
    const head = ` ${c.tool("⚡")} ${c.bright(name)}`;
    const room = w - displayWidth(name) - 6;
    const tail = room > 12 ? c.dim(truncate(argsPreview, room)) : "";
    this.line(head + (tail ? " " + tail : ""));
  }

  /** 工具结果块（缩进、限高）。 */
  toolResult(body: string, maxLines = 18): void {
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
    this.stopSpinner();
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

  /** 简单的单字符选择，用于权限模式切换。 */
  async choose(question: string, options: Array<{ key: string; label: string }>): Promise<string> {
    this.stopSpinner();
    this.blank();
    this.line(c.bold(question));
    for (const o of options) this.line(`  ${c.accent(o.key)}) ${c.text(o.label)}`);
    const asker = this.asker;
    const a = asker ? await asker(c.dim("❯ ")) : "";
    this.blank();
    return a.trim().toLowerCase();
  }
}

// ---------- 单行读取 ----------

export { padEndW, glyph };
