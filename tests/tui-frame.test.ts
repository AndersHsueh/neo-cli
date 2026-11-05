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
    // 断点空格留在上一行行尾（放得下时），不进入下一行行首 —— 与 buffer.ts 的
    // layoutBuffer 同口径：layoutBuffer("hello world foo", 0, 8) 同样是
    // ["hello ", "world ", "foo"]。旧期望 ["hello","world","foo"] 是丢弃断点空格的旧行为。
    expect(wrapAnsi("hello world foo", 8)).toEqual(["hello ", "world ", "foo"]);
  });

  test("A1b2 连续空格折行与 layoutBuffer 同口径（下一行不以空格开头）", () => {
    // 断点后的连续空格是「行首空白」，必须一起丢弃；否则 "ab   cd" 宽 3 会折出
    // ["ab ", " cd"]，与输入框 layoutBuffer 给出的 ["ab ", "cd"] 对不上。
    expect(wrapAnsi("ab   cd", 3)).toEqual(["ab ", "cd"]);
    expect(wrapAnsi("ab    cd", 3)).toEqual(["ab ", "cd"]);
    expect(wrapAnsi("hello   world", 6)).toEqual(["hello ", "world"]);
    // 纯空白行是例外：空格就是内容，必须原样折行保留，一个都不能丢。
    expect(wrapAnsi("    ", 2)).toEqual(["  ", "  "]);
    expect(wrapAnsi("     ", 2)).toEqual(["  ", "  ", " "]);
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

  test("A1j 行内才开始的 SGR 也要在行尾补 RESET", () => {
    // 颜色从行首开始（rowStartActive 非空）时行尾补 RESET 已有覆盖（A1d）；
    // 这里覆盖「行首无颜色、行内才出现 SGR」：整行颜色在行尾仍未闭合，
    // 不补 RESET 会让后续输出（下一行、提示符）全部染上该颜色。
    const red = "\x1b[31m";
    const reset = "\x1b[0m";

    // 不折行：单行内出现 SGR
    const single = wrapAnsi(`ab${red}cd`, 10);
    expect(single).toHaveLength(1);
    expect(single[0]).toBe(`ab${red}cd${reset}`);

    // 折行：第一行行首无颜色、行内出现 SGR，行尾同样要补
    const wrapped = wrapAnsi(`ab${red}cdef`, 3);
    expect(wrapped).toEqual([`ab${red}c${reset}`, `${red}def${reset}`]);

    // 行内 SGR 后又被 reset 闭合：颜色已闭合，行尾再补一个 RESET 是幂等冗余（无害），
    // 这里只断言「不会漏补」，不要求「不多补」—— 折行时 emitRow 拿不到本行精确的末态。
    const closed = wrapAnsi(`ab${red}cd${reset}ef`, 10);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.endsWith(reset)).toBe(true);
    expect(stripAnsi(closed[0]!)).toBe("abcdef");
  });

  test("A1k 复合参数 SGR 里的 0 参数按 reset 处理", () => {
    // SGR 参数是「分号分隔的列表」，`0` 出现在任意位置都表示 reset：
    //  - `\x1b[31;0m` = 先红再 reset，净效果无色；
    //  - `\x1b[0;31m` = 先 reset 再红，净效果红色。
    // 旧实现只比较整串是否等于 "0"，把 `\x1b[31;0m` 当普通上色追加进 active，
    // 导致下一行被错误地染上红色（\x1b[31mAAA\x1b[31;0mBBB 折行后第二行变红）。
    const red = "\x1b[31m";
    const reset = "\x1b[0m";

    // 复合参数以 reset 结尾：颜色已闭合，下一行不能带颜色前缀，也不该多补 RESET
    const tailReset = wrapAnsi(`${red}AAA\x1b[31;0mBBB`, 3);
    expect(tailReset.map(stripAnsi)).toEqual(["AAA", "BBB"]);
    expect(tailReset[1]).toBe("BBB");

    // 纯 reset 复合参数同样清空 active（不额外残留）
    const allReset = truncateAnsi(`${red}AAA\x1b[0;0mBBB`, 6);
    expect(allReset).toBe(`${red}AAA\x1b[0;0mBBB`);

    // 复合参数以 reset 开头：净效果是红色，下一行仍要带颜色
    const headReset = wrapAnsi(`${red}AAA\x1b[0;31mBBB`, 3);
    expect(headReset[1]).toBe(`${red}BBB${reset}`);

    // 非 0 的复合参数（如 \x1b[1;31m 粗体红）仍按上色累积
    const bold = wrapAnsi(`\x1b[1;31mAAA BBB`, 3);
    expect(bold[1]).toContain("\x1b[1;31m");
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
