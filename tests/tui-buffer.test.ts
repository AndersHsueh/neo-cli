/**
 * tui/buffer 的单元测试（v0.3.0 验收条款 B1-B4）。
 *
 * 覆盖 PRD §6：
 * - B1 `layoutBuffer` 按显示列折行（CJK/emoji/长英文词/空格/空文本/末尾换行）
 * - B2 光标行列映射 + 上下移动（折行边界、跨逻辑行、clamp、显示列 preferred column）
 * - B3 编辑操作（插入/换行/退格/Delete/Home/End/Kill/Ctrl+W）
 * - B4 历史 ↑↓ 前缀搜索、草稿保留、边界 clamp
 *
 * 纯逻辑、无 IO、无 mock：断言全部用公开 API。宽度事实源是 theme 的
 * `displayWidth`，测试不硬编码 emoji 的列宽（emoji 宽度随主题实现可能变化）。
 */
import { describe, expect, test } from "bun:test";
import { InputHistory, TextBuffer, layoutBuffer, toChars } from "../src/tui/buffer.ts";
import { displayWidth } from "../src/ui/theme.ts";

/** 只关心视觉行文本时的简写。 */
function lineTexts(text: string, width: number): string[] {
  return layoutBuffer(text, 0, width).lines.map((l) => l.text);
}

/** 只关心视觉行码点范围时的简写。 */
function lineRanges(text: string, width: number): Array<[number, number]> {
  return layoutBuffer(text, 0, width).lines.map((l) => [l.start, l.end] as [number, number]);
}

describe("B1 layoutBuffer 按显示列折行", () => {
  test("B1a CJK 刚好填满不折行", () => {
    const layout = layoutBuffer("中文", 2, 4);
    expect(layout.lines.map((l) => l.text)).toEqual(["中文"]);
    expect(layout.cursorRow).toBe(0);
    expect(layout.cursorCol).toBe(4);
  });

  test("B1b CJK 超一列就折行", () => {
    const layout = layoutBuffer("中文a", 3, 4);
    expect(layout.lines.map((l) => l.text)).toEqual(["中文", "a"]);
    expect(layout.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [2, 3],
    ]);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorCol).toBe(1);
  });

  test("B1c emoji 按 displayWidth 计列", () => {
    // 宽度事实源：整个「a😀」的显示宽度；不写死 emoji 是 1 还是 2 列。
    const pairWidth = displayWidth("a😀");
    expect(pairWidth).toBeGreaterThan(0);

    const single = layoutBuffer("a😀b", 0, 100);
    expect(single.lines.map((l) => l.text)).toEqual(["a😀b"]);

    const wrapped = layoutBuffer("a😀b", 3, pairWidth);
    expect(wrapped.lines.map((l) => l.text)).toEqual(["a😀", "b"]);
    expect(wrapped.cursorRow).toBe(1);
    expect(wrapped.cursorCol).toBe(displayWidth("b"));

    // 光标列是显示列：cursor=2 在 emoji 之后。
    expect(layoutBuffer("a😀b", 2, 100).cursorCol).toBe(pairWidth);
  });

  test("B1d 长英文词按显示列硬折行", () => {
    expect(lineTexts("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(lineRanges("abcdefgh", 3)).toEqual([
      [0, 3],
      [3, 6],
      [6, 8],
    ]);
  });

  test("B1e 优先在空格处断行（空格留在上一行行尾）", () => {
    const layout = layoutBuffer("hello world", 0, 6);
    expect(layout.lines.map((l) => l.text)).toEqual(["hello ", "world"]);
    expect(layout.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 6],
      [6, 11],
    ]);
  });

  test("B1f 断点空格不回填下一行", () => {
    const layout = layoutBuffer("hello world", 0, 5);
    expect(layout.lines.map((l) => l.text)).toEqual(["hello", "world"]);
    const second = layout.lines[1];
    expect(second?.text.startsWith(" ")).toBe(false);
    // 被跳过的断点空格不进入任何视觉行文本，故第二行 start=6。
    expect(second?.start).toBe(6);
  });

  test("B1f2 断点后的连续空格一并丢弃，不产生纯空格视觉行", () => {
    // 旧实现只跳过断点那一个空格，"ab   cd"（宽 3）折出 ["ab ", "  ", "cd"]：
    // 中间多一条纯空格行，输入框凭空变高、↑↓ 多跳一行。
    expect(lineTexts("ab   cd", 3)).toEqual(["ab ", "cd"]);
    expect(lineTexts("x     y", 3)).toEqual(["x  ", "y"]);
    // 任何折出来的行都不以空格开头（除非原文整行就是空白，见 B1i）
    for (const [text, w] of [["ab   cd", 3], ["x     y", 3], ["abc     def", 3]] as const) {
      for (const line of lineTexts(text, w)) {
        expect(line.startsWith(" ")).toBe(false);
      }
    }
  });

  test("B1g 空文本是一行空行", () => {
    const layout = layoutBuffer("", 0, 10);
    expect(layout.lines).toEqual([{ text: "", start: 0, end: 0 }]);
    expect(layout.cursorRow).toBe(0);
    expect(layout.cursorCol).toBe(0);
  });

  test("B1h 末尾换行产生最后一个空行", () => {
    const layout = layoutBuffer("ab\n", 3, 10);
    expect(layout.lines.map((l) => l.text)).toEqual(["ab", ""]);
    expect(layout.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [3, 3],
    ]);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorCol).toBe(0);
    // 换行符位置的游标属于上一行行尾。
    expect(layoutBuffer("ab\n", 2, 10).cursorRow).toBe(0);
    expect(layoutBuffer("ab\n", 2, 10).cursorCol).toBe(2);
  });

  test("B1i 纯空格行按显示列折行且不丢字", () => {
    expect(lineTexts("    ", 2)).toEqual(["  ", "  "]);
    const five = layoutBuffer("     ", 0, 2).lines;
    expect(five.map((l) => l.text)).toEqual(["  ", "  ", " "]);
    expect(five.reduce((n, l) => n + l.text.length, 0)).toBe(5);
  });

  test("B1j 逻辑换行与软折行都进入视觉行", () => {
    const layout = layoutBuffer("abcd\nef", 0, 2);
    expect(layout.lines.map((l) => l.text)).toEqual(["ab", "cd", "ef"]);
    expect(layout.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [2, 4],
      [5, 7],
    ]);
  });

  test("B1k 非法宽度按 1 列兜底（resize 到 0 不卡死）", () => {
    expect(lineTexts("ab", 0)).toEqual(["a", "b"]);
    expect(lineTexts("ab", -3)).toEqual(["a", "b"]);
  });
});

describe("B2 光标映射与上下移动", () => {
  test("B2a cursorCol 是显示列而非码点列", () => {
    expect(layoutBuffer("中文", 1, 10).cursorCol).toBe(2);
    expect(layoutBuffer("中文", 2, 10).cursorCol).toBe(4);
  });

  test("B2b 光标在折行边界时归后一行行首", () => {
    const at1 = layoutBuffer("abcd", 1, 2);
    expect([at1.cursorRow, at1.cursorCol]).toEqual([0, 1]);
    const at2 = layoutBuffer("abcd", 2, 2);
    expect([at2.cursorRow, at2.cursorCol]).toEqual([1, 0]);
    const at3 = layoutBuffer("abcd", 3, 2);
    expect([at3.cursorRow, at3.cursorCol]).toEqual([1, 1]);
    const at4 = layoutBuffer("abcd", 4, 2);
    expect([at4.cursorRow, at4.cursorCol]).toEqual([1, 2]);
  });

  test("B2c 跨逻辑行的光标映射", () => {
    const head = layoutBuffer("ab\ncd", 2, 10);
    expect([head.cursorRow, head.cursorCol]).toEqual([0, 2]);
    const second = layoutBuffer("ab\ncd", 3, 10);
    expect([second.cursorRow, second.cursorCol]).toEqual([1, 0]);
    const end = layoutBuffer("ab\ncd", 5, 10);
    expect([end.cursorRow, end.cursorCol]).toEqual([1, 2]);
  });

  test("B2d 上下移动跨视觉行", () => {
    const buffer = new TextBuffer("abcdef");
    buffer.cursor = 5;
    buffer.move("up", 3);
    expect(buffer.cursor).toBe(2);
    buffer.move("up", 3);
    expect(buffer.cursor).toBe(2); // 第一行保持不动
    buffer.move("down", 3);
    expect(buffer.cursor).toBe(5);
  });

  test("B2e 上下移动跨逻辑行", () => {
    const buffer = new TextBuffer("ab\ncd");
    buffer.cursor = 1;
    buffer.move("down", 10);
    expect(buffer.cursor).toBe(4);
    buffer.move("up", 10);
    expect(buffer.cursor).toBe(1);
  });

  test("B2f 上下移动用显示列做 preferred column（不是码点列）", () => {
    // 「中文」占 4 列；光标在「中」之后（码点列 1 / 显示列 2）。
    // 下移到「abc」行时，若误用码点列会落在 cursor=3，用显示列应落在 cursor=4。
    const buffer = new TextBuffer("中文abc");
    buffer.cursor = 1;
    buffer.move("down", 4);
    expect(buffer.cursor).toBe(4);
  });

  test("B2g 目标行更短时 clamp 到行尾，且 preferred column 保留", () => {
    const buffer = new TextBuffer("abcdefgh\nab");
    buffer.cursor = 6; // 视觉第 2 行、显示列 2
    buffer.move("down", 4);
    expect(buffer.cursor).toBe(11); // 短行「ab」行尾
    buffer.move("down", 4);
    expect(buffer.cursor).toBe(11); // 最后一行保持不动
    buffer.move("up", 4);
    expect(buffer.cursor).toBe(6); // 回到原显示列，不被 clamp 永久吞掉
  });

  test("B2h Up 在第一行 / Down 在最后一行保持不动", () => {
    const buffer = new TextBuffer("ab");
    buffer.cursor = 1;
    buffer.move("up", 10);
    expect(buffer.cursor).toBe(1);
    buffer.move("down", 10);
    expect(buffer.cursor).toBe(1);
  });

  test("B2i 在折行边界上按上下移动仍然落在正确显示列", () => {
    const buffer = new TextBuffer("abcdef");
    buffer.cursor = 2; // 视觉第 0 行行尾（折行边界）
    buffer.move("down", 3);
    expect(buffer.cursor).toBe(5); // 第 1 行显示列 2
    expect(layoutBuffer(buffer.text, buffer.cursor, 3).cursorRow).toBe(1);
  });

  test("B2j 从未满宽折行行的行尾上移不粘在原地", () => {
    // cursor=6 是最后一行行尾（显示列 3 == 宽度）：落在边界上时不能被映射回下一行、
    // 否则连按 ↑ 会永远停在最后一行。
    const buffer = new TextBuffer("abcdef");
    buffer.cursor = 6;
    buffer.move("up", 3);
    expect(layoutBuffer(buffer.text, buffer.cursor, 3).cursorRow).toBe(0);
    expect(buffer.cursor).toBe(2);
    buffer.move("down", 3);
    expect(buffer.cursor).toBe(6); // preferred column 3 保留，回到最后一行行尾
  });
});

describe("B3 编辑操作", () => {
  test("B3a 构造光标在末尾，插入按码点前进", () => {
    const buffer = new TextBuffer("ab");
    expect(buffer.cursor).toBe(2);
    expect(buffer.length).toBe(2);
    buffer.insert("中");
    expect(buffer.text).toBe("ab中");
    expect(buffer.cursor).toBe(3);
  });

  test("B3b insert 支持含换行的文本，前进量按码点算", () => {
    const buffer = new TextBuffer("");
    buffer.insert("a\n😀");
    expect(buffer.text).toBe("a\n😀");
    expect(buffer.length).toBe(3);
    expect(buffer.cursor).toBe(3);
  });

  test("B3c newline 等价于插入单个换行", () => {
    const buffer = new TextBuffer("ab");
    buffer.cursor = 1;
    buffer.newline();
    expect(buffer.text).toBe("a\nb");
    expect(buffer.cursor).toBe(2);
  });

  test("B3d 退格一次删一个汉字", () => {
    const buffer = new TextBuffer("中文");
    buffer.backspace();
    expect(buffer.text).toBe("中");
    expect(buffer.cursor).toBe(1);
  });

  test("B3e 退格一次删一整个 emoji（一个码点）", () => {
    const buffer = new TextBuffer("a😀b");
    buffer.cursor = 2;
    buffer.backspace();
    expect(buffer.text).toBe("ab");
    expect(buffer.cursor).toBe(1);
  });

  test("B3f Delete 删光标处一个码点", () => {
    const buffer = new TextBuffer("中文");
    buffer.cursor = 0;
    buffer.delete();
    expect(buffer.text).toBe("文");
    expect(buffer.cursor).toBe(0);
    buffer.delete();
    expect(buffer.text).toBe("");
    buffer.delete(); // 空缓冲再次 Delete 是 no-op
    expect(buffer.text).toBe("");
  });

  test("B3g Home/End 作用于当前逻辑行", () => {
    const buffer = new TextBuffer("ab\ncd");
    buffer.cursor = 4;
    buffer.move("home", 10);
    expect(buffer.cursor).toBe(3);
    buffer.move("end", 10);
    expect(buffer.cursor).toBe(5);

    buffer.cursor = 1;
    buffer.move("home", 10);
    expect(buffer.cursor).toBe(0);
    buffer.move("end", 10);
    expect(buffer.cursor).toBe(2);

    // 光标刚好压在换行符上时仍属于上一逻辑行。
    buffer.cursor = 2;
    buffer.move("home", 10);
    expect(buffer.cursor).toBe(0);
    buffer.move("end", 10);
    expect(buffer.cursor).toBe(2);
  });

  test("B3h killToEnd 删到当前逻辑行行尾（不含换行）", () => {
    const first = new TextBuffer("ab\ncd");
    first.cursor = 1;
    first.killToEnd();
    expect(first.text).toBe("a\ncd");
    expect(first.cursor).toBe(1);

    const second = new TextBuffer("ab\ncd");
    second.cursor = 3;
    second.killToEnd();
    expect(second.text).toBe("ab\n");
    expect(second.cursor).toBe(3);
  });

  test("B3i killToStart 删到当前逻辑行行首（不含换行）", () => {
    const second = new TextBuffer("ab\ncd");
    second.cursor = 4;
    second.killToStart();
    expect(second.text).toBe("ab\nd");
    expect(second.cursor).toBe(3);

    const first = new TextBuffer("ab\ncd");
    first.cursor = 1;
    first.killToStart();
    expect(first.text).toBe("b\ncd");
    expect(first.cursor).toBe(0);
  });

  test("B3j Ctrl+W 中文只删一个字而不是整句", () => {
    const single = new TextBuffer("中文");
    single.deleteWordLeft();
    expect(single.text).toBe("中");
    expect(single.cursor).toBe(1);

    const mixed = new TextBuffer("中文abc");
    mixed.deleteWordLeft();
    expect(mixed.text).toBe("中文");
    expect(mixed.cursor).toBe(2);
  });

  test("B3k Ctrl+W 删 ASCII 连续段，标点单独成词", () => {
    const ascii = new TextBuffer("hello world");
    ascii.deleteWordLeft();
    expect(ascii.text).toBe("hello ");
    expect(ascii.cursor).toBe(6);

    const punct = new TextBuffer("abc,def");
    punct.deleteWordLeft();
    expect(punct.text).toBe("abc,");
    expect(punct.cursor).toBe(4);
  });

  test("B3l Ctrl+W 跳过空白再删前一个词", () => {
    const buffer = new TextBuffer("abc   ");
    buffer.deleteWordLeft();
    expect(buffer.text).toBe("");
    expect(buffer.cursor).toBe(0);
  });

  test("B3m word-left / word-right 移动位置", () => {
    const buffer = new TextBuffer("hello world");
    buffer.cursor = 11;
    buffer.move("word-left", 100);
    expect(buffer.cursor).toBe(6);
    buffer.move("word-left", 100);
    expect(buffer.cursor).toBe(0);

    buffer.move("word-right", 100);
    expect(buffer.cursor).toBe(5);
    buffer.move("word-right", 100);
    expect(buffer.cursor).toBe(11);

    const cjk = new TextBuffer("中文");
    cjk.cursor = 2;
    cjk.move("word-left", 100);
    expect(cjk.cursor).toBe(1);
    cjk.move("word-right", 100);
    expect(cjk.cursor).toBe(2);

    const punct = new TextBuffer("ab,cd");
    punct.cursor = 5;
    punct.move("word-left", 100);
    expect(punct.cursor).toBe(3); // 跳过 def 段
    punct.move("word-left", 100);
    expect(punct.cursor).toBe(2); // 逗号单独成词
  });

  test("B3n setText / clear 重置文本与光标", () => {
    const buffer = new TextBuffer("abc");
    buffer.setText("中文");
    expect(buffer.text).toBe("中文");
    expect(buffer.cursor).toBe(2);
    buffer.setText("ab", 1);
    expect(buffer.cursor).toBe(1);
    buffer.clear();
    expect(buffer.text).toBe("");
    expect(buffer.cursor).toBe(0);
    expect(buffer.length).toBe(0);
  });

  test("B3o 边界编辑不越界", () => {
    const buffer = new TextBuffer("");
    buffer.backspace();
    buffer.delete();
    expect(buffer.text).toBe("");
    expect(buffer.cursor).toBe(0);

    buffer.insert("a");
    buffer.cursor = 0;
    buffer.backspace();
    expect(buffer.text).toBe("a");
    buffer.cursor = 0;
    buffer.killToStart();
    expect(buffer.text).toBe("a");
    buffer.cursor = 1;
    buffer.killToEnd();
    expect(buffer.text).toBe("a");
  });

  test("B3p chars / length / toChars 都按码点", () => {
    const buffer = new TextBuffer("a😀中");
    expect(buffer.chars).toEqual(["a", "😀", "中"]);
    expect(buffer.length).toBe(3);
    expect(toChars("a😀中")).toEqual(["a", "😀", "中"]);
  });
});

describe("B4 InputHistory 历史导航", () => {
  test("B4a push 忽略空/纯空白与连续重复", () => {
    const history = new InputHistory();
    history.push("");
    history.push("   ");
    history.push("\t");
    expect(history.size).toBe(0);
    history.push("a");
    history.push("a");
    expect(history.size).toBe(1);
    history.push("b");
    expect(history.size).toBe(2);
  });

  test("B4b 首次 up 记住草稿，空前缀按最近优先", () => {
    const history = new InputHistory(["one", "two"]);
    expect(history.up("")).toBe("two");
    expect(history.up("")).toBe("one");
    expect(history.up("")).toBeNull();
    expect(history.down("")).toBe("two");
    expect(history.down("")).toBe("");
    expect(history.down("")).toBe(""); // 已在底部，继续返回草稿
  });

  test("B4c 前缀搜索只回溯匹配项", () => {
    const history = new InputHistory(["git status", "bun test", "bun run"]);
    expect(history.up("bun ")).toBe("bun run");
    expect(history.up("bun ")).toBe("bun test");
    expect(history.up("bun ")).toBeNull();
  });

  test("B4d down 返回较新匹配项，到底回到草稿", () => {
    const history = new InputHistory(["bun test", "bun run"]);
    expect(history.up("bun r")).toBe("bun run");
    expect(history.up("bun run")).toBeNull();
    expect(history.down("bun run")).toBe("bun r");
  });

  test("B4e 无匹配条目时 up 返回 null", () => {
    const history = new InputHistory(["abc"]);
    expect(history.up("xyz")).toBeNull();
  });

  test("B4f reset 清空导航态（下次 up 重新记忆前缀）", () => {
    const history = new InputHistory(["alpha", "beta"]);
    expect(history.up("al")).toBe("alpha");
    history.reset();
    expect(history.up("be")).toBe("beta");
  });

  test("B4g 未导航时 down 返回 null", () => {
    const history = new InputHistory(["a"]);
    expect(history.down("x")).toBeNull();
  });

  test("B4h push 后导航态复位，可立即回溯最新条目", () => {
    const history = new InputHistory();
    history.push("first");
    history.push("second");
    expect(history.up("")).toBe("second");
    expect(history.up("")).toBe("first");
  });

  test("B4i 构造传入的数组不被篡改", () => {
    const source = ["a"];
    const history = new InputHistory(source);
    history.push("b");
    expect(source).toEqual(["a"]);
    expect(history.size).toBe(2);
  });
});

describe("B1e 折行按 grapheme 取宽（v0.4.29）", () => {
  // 根因：wrapSegment 曾逐 code point 用 charWidth 累加，与 displayWidth 的
  // grapheme 口径分叉 —— VS16 / ZWJ / 区域指示符三类输入会折错行。
  test("VS16 变体 ❤️ 不被低估宽度（视觉行不超宽）", () => {
    const text = "❤️❤️❤️";
    const width = 5;
    const lines = layoutBuffer(text, 0, width).lines;
    for (const l of lines) expect(displayWidth(l.text)).toBeLessThanOrEqual(width);
    // 每颗 ❤️ 2 列 → 5 列只能放 2 颗
    expect(lines.map((l) => l.text)).toEqual(["❤️❤️", "❤️"]);
  });

  test("ZWJ 家庭 emoji 不被拆到两行", () => {
    const family = "👨‍👩‍👧‍👦";
    const lines = layoutBuffer(family, 0, 3).lines;
    expect(lines.map((l) => l.text)).toEqual([family]);
    expect(displayWidth(lines[0]!.text)).toBeLessThanOrEqual(3);
  });

  test("区域指示符国旗按整体 2 列折行", () => {
    const lines = layoutBuffer("🇨🇳🇨🇳", 0, 4).lines;
    expect(lines.map((l) => l.text)).toEqual(["🇨🇳🇨🇳"]);
    expect(lines.every((l) => displayWidth(l.text) <= 4)).toBe(true);
  });

  test("start/end 仍是码点下标（grapheme 不改变下标口径）", () => {
    const lines = layoutBuffer("❤️❤️", 0, 2).lines;
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
});
