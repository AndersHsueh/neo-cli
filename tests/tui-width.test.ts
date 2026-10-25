/**
 * Unicode 显示宽度独立口径（v0.3.0 质量审查 critical #1）。
 *
 * 这里写死「外部真值」：终端里 emoji/ZWJ/VS16/组合字符分别占几列，
 * 不复用实现的中间变量，防止「实现与断言共用同一套宽度模型」的自证。
 */
import { describe, expect, test } from "bun:test";
import { charWidth, displayWidth, graphemeWidth, graphemes, truncate } from "../src/ui/theme.ts";

describe("W1 Unicode 宽度真值", () => {
  test("W1a emoji = 2 列（不是 1）", () => {
    expect(displayWidth("😀")).toBe(2);
    expect(charWidth("😀")).toBe(2);
    expect(displayWidth("a😀b")).toBe(4);
  });

  test("W1b ZWJ 家庭 emoji = 2 列（不是一个 emoji 各算 2）", () => {
    const family = "👨‍👩‍👧";
    expect(graphemes(family).length).toBe(1);
    expect(graphemeWidth(family)).toBe(2);
    expect(displayWidth(`x${family}y`)).toBe(4);
  });

  test("W1c VS16 变体（❤️）= 2 列", () => {
    expect(displayWidth("❤️")).toBe(2);
    expect(displayWidth("❤")).toBe(1); // 无 VS16 的杂项符号按 1 列（与多数终端一致）
  });

  test("W1d 国旗 = 2 列", () => {
    expect(displayWidth("🇨🇳")).toBe(2);
    expect(graphemes("🇨🇳").length).toBe(1);
  });

  test("W1e 组合字符 e + combining acute = 1 列", () => {
    expect(displayWidth("e\u0301")).toBe(1);
    expect(graphemes("e\u0301").length).toBe(1);
  });

  test("W1f CJK / 控制字符", () => {
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("\n")).toBe(0);
    expect(displayWidth("a\nb")).toBe(2);
  });

  test("W1g truncate 按 grapheme 切，不切坏 emoji/组合字符", () => {
    expect(truncate("😀😀😀", 5)).toBe("😀😀…");
    expect(truncate("e\u0301e\u0301e\u0301", 2)).toBe("e\u0301…");
  });
});
