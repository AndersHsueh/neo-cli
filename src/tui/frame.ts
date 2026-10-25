/**
 * tui/frame.ts — 底部 live 帧渲染器（v0.3.0）。
 *
 * 只负责一件事：在「已提交区（scrollback）」之上维护一块可重画的底部区域。
 *
 *  M0 实证（scripts/tui-probe.ts P2/P3）：
 *   光标停在帧内输入位置 → `CSI nA` 回帧首 → `\r\x1b[0J` 清到屏尾 →
 *   写新增提交行/整帧 → `CSI nA` + `\r` + `CSI nG` 把光标放回输入位置。
 *   提交行后必须把「帧内光标行号」归零，否则下一次擦除会把刚写进 scrollback 的行擦掉
 *   （探针第一次实现就踩到了，这里固化成 `writeRows()` 的重置）。
 *
 * 两条纪律：
 *  1. **一次 render 只写一次 stdout**（整帧拼成字符串）：减少撕裂，也让单测能精确断言。
 *  2. 支持 DEC 2026 synchronized output（原子帧）：终端支持时把整帧包进 ?2026h/l；
 *     tmux/SSH 下默认关闭（qwen-code 的实测结论：tmux 会吞/错解该序列）。
 */
import { truncateAnsi } from "./ansi.ts";
import { displayWidth } from "../ui/theme.ts";

export interface FrameDeps {
  write: (s: string) => void;
  columns: () => number;
  rows?: () => number;
  /** 是否包 ?2026h/l；默认按环境判定（见 synchronizedEnabled）。 */
  synchronized?: boolean;
}

export interface FrameState {
  /** 已着色、宽度已收敛到 <= columns 的行。 */
  rows: string[];
  /** 光标在 rows 中的行（0-based）。 */
  cursorRow: number;
  /** 光标列（0-based，显示列）。 */
  cursorCol: number;
}

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

/** DEC 2026 默认开关：白名单终端 + 非 tmux/SSH；可用环境变量强制。 */
export function synchronizedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["NEO_FORCE_SYNCHRONIZED_OUTPUT"] === "1") return true;
  if (env["NEO_NO_SYNCHRONIZED_OUTPUT"] === "1") return false;
  if (env["TMUX"] || env["SSH_TTY"] || env["SSH_CLIENT"] || env["SSH_CONNECTION"]) return false;
  const tp = env["TERM_PROGRAM"];
  if (tp === "iTerm.app" || tp === "WezTerm" || tp === "ghostty" || tp === "kitty" || tp === "Apple_Terminal") return true;
  return Boolean(env["KITTY_WINDOW_ID"]);
}

export class FrameRenderer {
  private active = false;
  /** 当前帧内光标所在行（下一次 erase 要从这里上移）。 */
  private cursorRowInFrame = 0;
  private frameHeight = 0;
  private readonly sync: boolean;

  constructor(private readonly deps: FrameDeps) {
    this.sync = deps.synchronized ?? synchronizedEnabled();
  }

  /** 拼一帧输出（原子帧包裹）。 */
  private emit(body: string): void {
    if (body === "") return;
    this.deps.write(this.sync ? `${BEGIN_SYNC}${body}${END_SYNC}` : body);
  }

  /** 把光标从当前输入位置移回帧首，并清到屏尾；返回要拼进同一次 write 的字节。 */
  private takeErase(): string {
    if (!this.active) return "\r\x1b[0J";
    let s = "\r";
    if (this.cursorRowInFrame > 0) s = `\x1b[${this.cursorRowInFrame}A\r`;
    s += "\x1b[0J";
    this.active = false;
    this.frameHeight = 0;
    this.cursorRowInFrame = 0;
    return s;
  }

  /** 生成整帧 + 光标定位字节（假定光标已在帧首），并更新帧状态。 */
  private buildFrame(state: FrameState): string {
    const cols = this.deps.columns();
    const safeRows = state.rows.map((r) => (displayWidth(r) > cols ? truncateAnsi(r, cols) : r));
    const cursorRow = clamp(state.cursorRow, 0, safeRows.length - 1);
    const cursorCol = clamp(state.cursorCol, 0, cols - 1);
    let body = safeRows.join("\r\n");
    const up = safeRows.length - 1 - cursorRow;
    if (up > 0) body += `\x1b[${up}A`;
    body += `\r\x1b[${cursorCol + 1}G`;
    this.active = true;
    this.frameHeight = safeRows.length;
    this.cursorRowInFrame = cursorRow;
    return body;
  }

  /** 生成提交行字节（行必须已经按宽度折好）。 */
  private buildRows(rows: string[]): string {
    const cols = this.deps.columns();
    let body = "";
    for (const row of rows) {
      // 防御：超宽行会让终端自动折行，帧坐标立刻失效；这里再夹一次。
      const line = displayWidth(row) > cols ? truncateAnsi(row, cols) : row;
      body += `${line}\r\n`;
    }
    return body;
  }

  /** 把光标移回帧首并清到屏尾。幂等。 */
  erase(): void {
    this.emit(this.takeErase());
  }

  /** 提交若干行到帧上方（进入 scrollback），一次 write。 */
  commitAbove(rows: string[]): void {
    if (rows.length === 0) return;
    this.emit(this.takeErase() + this.buildRows(rows));
  }

  /**
   * 提交行 + 立刻重画整帧（**同一个 write**）。
   * 流式输出每提交一行都会清帧；拆成「commitAbove → 8ms 后再 render」会让输入框
   * 周期性空 8-10ms（效率审查实测 20 行/s 时 40-50% 时间帧是空的）。
   */
  commitAboveAndRender(rows: string[], state: FrameState): void {
    const erase = this.takeErase();
    const rowsBody = rows.length > 0 ? this.buildRows(rows) : "";
    this.emit(erase + rowsBody + this.buildFrame(state));
  }

  /** 重画整帧，并把光标放到输入位置。 */
  render(state: FrameState): void {
    if (state.rows.length === 0) {
      this.erase();
      return;
    }
    this.emit(this.takeErase() + this.buildFrame(state));
  }

  /** 退出/挂起：擦掉帧，光标停在帧首。 */
  clear(): void {
    if (!this.active) return;
    let s = "\r";
    if (this.cursorRowInFrame > 0) s = `\x1b[${this.cursorRowInFrame}A\r`;
    s += "\x1b[0J";
    this.active = false;
    this.frameHeight = 0;
    this.cursorRowInFrame = 0;
    this.emit(s);
  }

  /** 终端 resize 后：上一帧的行宽已失效，只能按旧输入行号尽力擦除再整帧重画。 */
  invalidate(): void {
    this.active = false;
    this.frameHeight = 0;
    this.cursorRowInFrame = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}
