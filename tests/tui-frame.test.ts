/**
 * tui/ansi + frame 的单元测试（v0.3.0 F1 / A1-A2）。
 *
 * 不用 mock：frame 只依赖注入的 write/columns，测试里用「最小屏幕缓冲」解释
 * 真实 ANSI 字节，断言最终屏幕与光标位置 —— 与 scripts/pty-e2e.ts 的 Screen 同源思路。
 */
import { describe, expect, test } from "bun:test";
import { stripAnsi, tokenizeAnsi, truncateAnsi, wrapAnsi } from "../src/tui/ansi.ts";
import { FrameRenderer, synchronizedEnabled } from "../src/tui/frame.ts";
import { displayWidth } from "../src/ui/theme.ts";

/** 最小屏幕缓冲：只解释本测试会产生的序列。 */
class TestScreen {
  rows: string[][] = [[]];
  row = 0;
  col = 0;
  private saved: { row: number; col: number } | null = null;

  feed(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i] as string;
      if (ch === "\x1b") {
        const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(s.slice(i));
        if (!m) { i += 1; continue; }
        this.csi(m[1] ?? "", m[2] ?? "");
        i += m[0].length;
        continue;
      }
      if (ch === "\r") { this.col = 0; i += 1; continue; }
      if (ch === "\n") { this.row += 1; this.col = 0; this.ensure(); i += 1; continue; }
      const cp = s.codePointAt(i) as number;
      const glyph = String.fromCodePoint(cp);
      const w = displayWidth(glyph);
      if (w > 0) {
        this.ensure();
        const line = this.rows[this.row] as string[];
        for (let k = 0; k < w; k++) {
          const c = this.col + k;
          while (line.length < c) line.push(" ");
          line[c] = k === 0 ? glyph : "";
        }
        this.col += w;
      }
      i += glyph.length;
    }
  }

  private ensure(): void { while (this.rows.length <= this.row) this.rows.push([]); }

  private csi(paramsRaw: string, final: string): void {
    if (paramsRaw.startsWith("?")) return;
    const p = paramsRaw === "" ? [] : paramsRaw.split(";").map((x) => Number.parseInt(x, 10) || 0);
    const n = (i: number, d: number): number => (p[i] === undefined || p[i] === 0 ? d : (p[i] as number));
    switch (final) {
      case "A": this.row = Math.max(0, this.row - n(0, 1)); return;
      case "B": this.row += n(0, 1); this.ensure(); return;
      case "C": this.col += n(0, 1); return;
      case "D": this.col = Math.max(0, this.col - n(0, 1)); return;
      case "G": this.col = Math.max(0, n(0, 1) - 1); return;
      case "H":
      case "f": this.row = Math.max(0, n(0, 1) - 1); this.col = Math.max(0, n(1, 1) - 1); this.ensure(); return;
      case "K": {
        this.ensure();
        const line = this.rows[this.row] as string[];
        const mode = p[0] ?? 0;
        if (mode === 2) this.rows[this.row] = [];
        else if (mode === 1) for (let c = 0; c < Math.min(this.col, line.length); c++) line[c] = " ";
        else line.length = Math.min(line.length, this.col);
        return;
      }
      case "J": {
        const mode = p[0] ?? 0;
        if (mode === 2) { this.rows = [[]]; this.row = 0; this.col = 0; }
        else if (mode === 1) { for (let r = 0; r < this.row; r++) this.rows[r] = []; }
        else { const line = this.rows[this.row] ?? []; line.length = Math.min(line.length, this.col); this.rows.length = this.row + 1; }
        return;
      }
      case "s": this.saved = { row: this.row, col: this.col }; return;
      case "u": if (this.saved) { this.row = this.saved.row; this.col = this.saved.col; } return;
      default: return;
    }
  }

  lines(): string[] {
    const out = this.rows.map((r) => r.join("").replace(/\s+$/, ""));
    while (out.length > 1 && (out[out.length - 1] ?? "") === "") out.pop();
    return out;
  }
}

function makeFrame(screen: TestScreen, cols = 40): FrameRenderer {
  return new FrameRenderer({ write: (s) => screen.feed(s), columns: () => cols, synchronized: false });
}

describe("A1 wrapAnsi / truncateAnsi", () => {
  test("A1a CJK 按显示列折行，不超宽", () => {
    const rows = wrapAnsi("中文内容很长的字符串", 10);
    expect(rows.every((r) => displayWidth(r) <= 10)).toBe(true);
    expect(rows.join("")).toBe("中文内容很长的字符串");
  });

  test("A1b 优先在空格处折行，空格不进入下一行", () => {
    expect(wrapAnsi("hello world foo", 11)).toEqual(["hello world", "foo"]);
    expect(wrapAnsi("hello world foo", 8)).toEqual(["hello", "world", "foo"]);
  });

  test("A1c 单字符超宽时独占一行", () => {
    const rows = wrapAnsi("中中中", 1);
    expect(rows).toEqual(["中", "中", "中"]);
  });

  test("A1d ANSI 颜色不丢：每行独立可打印，SGR 不计宽度", () => {
    const red = "\x1b[31mred\x1b[0m";
    const rows = wrapAnsi(`${red} and more`, 6);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]).toContain("\x1b[31m");
    expect(rows[0]).toContain("\x1b[0m");
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(6);
  });

  test("A1e 逻辑换行保留（\\n 强制新行）", () => {
    expect(wrapAnsi("a\nb", 10)).toEqual(["a", "b"]);
  });

  test("A1f truncateAnsi 按显示列截断且补 RESET", () => {
    const out = truncateAnsi("\x1b[32m中文内容\x1b[0m", 5);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
    expect(out.endsWith("\x1b[0m")).toBe(true);
  });

  test("A1g OSC 序列（超链接）零宽：正文不计入宽度、折行不错乱", () => {
    // OSC 8 超链接：终端里只显示 "link"，URL 是不可见控制序列。
    const link = "\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\";
    expect(displayWidth(link)).toBe(4);
    expect(stripAnsi(link)).toBe("link");
    expect(wrapAnsi(link, 4)).toHaveLength(1);
    expect(wrapAnsi(link, 4).map(stripAnsi)).toEqual(["link"]);
    // 混排：链接在中间，折行只按可见列算
    expect(wrapAnsi(`ab${link}cd`, 4).map(stripAnsi)).toEqual(["abli", "nkcd"]);
  });

  test("A1h OSC 以 BEL 结尾时同样零宽", () => {
    const title = "\x1b]0;窗口标题\x07text";
    expect(displayWidth(title)).toBe(4);
    expect(stripAnsi(title)).toBe("text");
    expect(wrapAnsi(title, 10).map(stripAnsi)).toEqual(["text"]);
  });

  test("A1i 裸 ESC（不构成合法转义）零宽且不残留", () => {
    // 裸 ESC = 后面跟普通字符或直接到结尾，不构成 CSI/OSC/两字符转义。
    // 它本身不渲染任何内容，但留在输出里会把终端推进转义状态，吞掉后续输出。
    const bare = "abc\x1bdef";
    expect(displayWidth(bare)).toBe(6); // 只算可见字符，ESC 自身 0 宽
    expect(stripAnsi(bare)).toBe("abcdef");
    expect(tokenizeAnsi(bare).filter((t) => t.kind === "sgr")).toEqual([]);
    // 截断后不能以裸 ESC 收尾
    expect(truncateAnsi("hello\x1bworld", 5)).toBe("hello");
    expect(truncateAnsi("hello\x1bworld", 7)).toBe("hellowo");
    // 结尾裸 ESC 也不能留
    expect(truncateAnsi("abc\x1b", 3)).toBe("abc");
    expect(stripAnsi("abc\x1b")).toBe("abc");
    // 折行同理
    expect(wrapAnsi("abc\x1bdef", 3)).toEqual(["abc", "def"]);
  });
});

describe("F1 FrameRenderer", () => {
  test("F1a 单次 render：整帧可见、光标在输入位置", () => {
    const screen = new TestScreen();
    const frame = makeFrame(screen);
    frame.render({ rows: ["top", "input", "bottom"], cursorRow: 1, cursorCol: 3 });
    expect(screen.lines()).toEqual(["top", "input", "bottom"]);
    expect({ row: screen.row, col: screen.col }).toEqual({ row: 1, col: 3 });
  });

  test("F1b 二次 render：旧帧被擦除，不残留", () => {
    const screen = new TestScreen();
    const frame = makeFrame(screen);
    frame.render({ rows: ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], cursorRow: 1, cursorCol: 0 });
    frame.render({ rows: ["xx", "yy"], cursorRow: 0, cursorCol: 1 });
    expect(screen.lines()).toEqual(["xx", "yy"]);
    expect({ row: screen.row, col: screen.col }).toEqual({ row: 0, col: 1 });
  });

  test("F1c 帧长高再缩短无残影", () => {
    const screen = new TestScreen();
    const frame = makeFrame(screen);
    frame.render({ rows: ["r1", "r2", "r3", "r4", "r5"], cursorRow: 2, cursorCol: 0 });
    frame.render({ rows: ["only"], cursorRow: 0, cursorCol: 0 });
    expect(screen.lines()).toEqual(["only"]);
  });

  test("F1d commitAbove 把行写进上方，随后 render 帧回到下方", () => {
    const screen = new TestScreen();
    const frame = makeFrame(screen);
    frame.render({ rows: ["top", "> input", "bottom"], cursorRow: 1, cursorCol: 2 });
    frame.commitAbove(["committed 1", "committed 2"]);
    expect(screen.lines()).toEqual(["committed 1", "committed 2"]);
    frame.render({ rows: ["top", "> input2", "bottom"], cursorRow: 1, cursorCol: 3 });
    expect(screen.lines()).toEqual(["committed 1", "committed 2", "top", "> input2", "bottom"]);
    expect({ row: screen.row, col: screen.col }).toEqual({ row: 3, col: 3 });
  });

  test("F1e 提交行后立刻重画：不会把提交行擦掉（探针踩过的 bug）", () => {
    const screen = new TestScreen();
    const frame = makeFrame(screen);
    frame.render({ rows: ["rule", "> a", "rule", "status"], cursorRow: 1, cursorCol: 2 });
    frame.commitAbove(["❯ hello"]);
    frame.render({ rows: ["rule", "> ", "rule", "status"], cursorRow: 1, cursorCol: 2 });
    expect(screen.lines()[0]).toBe("❯ hello");
    expect(screen.lines().slice(1)).toEqual(["rule", ">", "rule", "status"]);
  });

  test("F1i commitAboveAndRender 单次 write 完成提交+重画", () => {
    const writes: string[] = [];
    const screen = new TestScreen();
    const frame = new FrameRenderer({
      write: (s) => { writes.push(s); screen.feed(s); },
      columns: () => 40,
      synchronized: false,
    });
    frame.render({ rows: ["rule", "> a", "status"], cursorRow: 1, cursorCol: 2 });
    const before = writes.length;
    frame.commitAboveAndRender(["committed"], { rows: ["rule", "> b", "status"], cursorRow: 1, cursorCol: 2 });
    expect(writes.length - before).toBe(1); // 一次 write，中间不留空帧
    expect(screen.lines()).toEqual(["committed", "rule", "> b", "status"]);
  });

  test("F1f clear 只擦帧、不碰上方历史", () => {
    const screen = new TestScreen();
    const frame = makeFrame(screen);
    frame.commitAbove(["history"]);
    frame.render({ rows: ["a", "b"], cursorRow: 0, cursorCol: 0 });
    frame.clear();
    expect(screen.lines()).toEqual(["history"]);
  });

  test("F1g 超宽行被兜底截断，不产生自动折行", () => {
    const screen = new TestScreen();
    const frame = makeFrame(screen, 10);
    frame.render({ rows: ["一二三四五六七八九十"], cursorRow: 0, cursorCol: 0 });
    expect(displayWidth(screen.lines()[0] ?? "")).toBeLessThanOrEqual(10);
  });
});

describe("F1h synchronizedEnabled", () => {
  test("tmux/SSH 下默认关闭", () => {
    expect(synchronizedEnabled({ TMUX: "/tmp/x" } as NodeJS.ProcessEnv)).toBe(false);
    expect(synchronizedEnabled({ SSH_TTY: "/dev/pts/1" } as NodeJS.ProcessEnv)).toBe(false);
  });
  test("iTerm/WezTerm/Kitty 默认开启，可强制关闭", () => {
    expect(synchronizedEnabled({ TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv)).toBe(true);
    expect(synchronizedEnabled({ TERM_PROGRAM: "WezTerm" } as NodeJS.ProcessEnv)).toBe(true);
    expect(synchronizedEnabled({ KITTY_WINDOW_ID: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(synchronizedEnabled({ TERM_PROGRAM: "iTerm.app", NEO_NO_SYNCHRONIZED_OUTPUT: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });
});
