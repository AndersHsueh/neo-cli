/**
 * 流式格式化器。
 *
 * 直接把 chunk 丢给终端会得到一团糟。三个必须解决的问题：
 *
 *  1. **行边界**：跨 chunk 的 `**bold**` 若逐 chunk 着色会被截断成乱码。
 *     因此按「完整行」着色，只有已确定的完整行才输出。
 *  2. **代码围栏**：``` 及其语言标注可能分处两个 chunk。
 *     只有拿到整行才能判断围栏起止，故围栏检测必须在行级进行。
 *  3. **无换行的长行**：模型偶尔输出超长单行。故缓冲超过阈值时强制断行输出，
 *     避免整段内容憋到结束才出现。
 */
import { c } from "./theme.ts";

const FLUSH_THRESHOLD = 240;

export class StreamFormatter {
  /** 已收到的原始文本（不含 ANSI）。 */
  private raw = "";
  /** 尚未输出的原始文本。 */
  private pending = "";
  private inFence = false;
  private fenceMarker = "";
  private wroteAny = false;
  /** 最后一次输出后是否处于行首。 */
  private atLineStart = true;

  constructor(private readonly opts: { colorize: boolean }) {}

  get wrote(): boolean {
    return this.wroteAny;
  }

  write(chunk: string): void {
    this.raw += chunk;
    this.pending += chunk;

    let nl: number;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl).replace(/\r$/, "");
      this.pending = this.pending.slice(nl + 1);
      this.emitLine(line);
    }

    // 超长无换行行：强制断行，避免长时间无输出
    if (this.pending.length > FLUSH_THRESHOLD) {
      const cut = this.pending.lastIndexOf(" ", FLUSH_THRESHOLD);
      const idx = cut > 40 ? cut : FLUSH_THRESHOLD;
      const head = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx);
      this.emitLine(head, true);
    }
  }

  finish(): void {
    if (this.pending) {
      const line = this.pending;
      this.pending = "";
      this.emitLine(line);
    }
    if (this.inFence) {
      this.write("\n");
      this.inFence = false;
    }
    if (this.wroteAny && !this.atLineStart) process.stdout.write("\n");
    this.atLineStart = true;
  }

  private emitLine(line: string, softBreak = false): void {
    // --- 围栏检测（仅在行首有效）---
    if (!this.inFence) {
      const m = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/.exec(line);
      if (m) {
        this.enterFence(m[1] ?? "```", (m[2] ?? "").trim());
        return;
      }
    } else {
      const m = new RegExp(`^\\s{0,3}${this.fenceMarker[0] === "`" ? "`" : "~"}{${this.fenceMarker.length},}\\s*$`).exec(line);
      if (m) {
        process.stdout.write(c.dim("└" + "─".repeat(44)) + "\n");
        this.inFence = false;
        this.fenceMarker = "";
        this.atLineStart = true;
        this.wroteAny = true;
        return;
      }
      process.stdout.write(c.dim("│ ") + (this.opts.colorize ? c.mid(line) : line) + "\n");
      this.atLineStart = true;
      this.wroteAny = true;
      return;
    }

    // --- 文本行 ---
    if (line.trim() === "") {
      if (!this.atLineStart) process.stdout.write("\n");
      this.atLineStart = true;
      this.wroteAny = true;
      return;
    }

    const painted = this.opts.colorize ? paintInline(line) : line;
    process.stdout.write(painted);
    if (!softBreak) {
      process.stdout.write("\n");
      this.atLineStart = true;
    } else {
      process.stdout.write(" ");
      this.atLineStart = false;
    }
    this.wroteAny = true;
  }

  private enterFence(marker: string, lang: string): void {
    if (!this.atLineStart) process.stdout.write("\n");
    this.inFence = true;
    this.fenceMarker = marker;
    const label = lang ? c.dim(` ${lang} `) : c.dim(" code ");
    process.stdout.write(c.dim("┌─") + label + "\n");
    this.atLineStart = true;
    this.wroteAny = true;
  }
}

/** 行内着色：**粗体**、`代码`、*斜体*、链接。 */
export function paintInline(s: string): string {
  let out = s;
  out = out.replace(/`([^`\n]+)`/g, (_m, t: string) => c.accent(t));
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => c.bold(c.bright(t)));
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) =>
    `${c.accent(t)} ${c.dim(`<${u}>`)}`,
  );
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p: string, t: string) => `${p}${c.italic(t)}`);
  return out;
}
