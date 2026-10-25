/**
 * 启动 banner 的 v0.3.x 视觉约束：
 *  - 标题是 M.A.T.R.I.X；
 *  - 只保留标题下一条横线，底部用空行与输入框顶线分隔。
 */
import { describe, expect, test } from "bun:test";
import { banner } from "../src/ui/theme.ts";
import { stripAnsi } from "../src/tui/ansi.ts";

describe("B1 启动 banner", () => {
  test("B1a 标题 M.A.T.R.I.X，不再显示 N E O", () => {
    const plain = stripAnsi(banner("fake-model", "http://127.0.0.1:1234", "ipsa", "default", "read_file shell"));
    expect(plain).toContain("M.A.T.R.I.X");
    expect(plain).not.toContain("N E O");
    expect(plain).toContain("wake up, neo...");
  });

  test("B1b 只有标题下一条横线；底部是空行（不再有第二条 rule）", () => {
    const plain = stripAnsi(banner("fake-model", "http://127.0.0.1:1234", "ipsa", "default", "read_file shell"));
    expect(plain.endsWith("\n ")).toBe(true); // 末尾是「空格行」：dock 会稳定落成空行
    const lines = plain.split("\n");
    expect(lines.at(-1)?.trim()).toBe(""); // 视觉空行
    expect(lines.filter((l) => l.trim() === "").length).toBe(1);
    const rules = lines.filter((l) => /^─+$/.test(l.trim()));
    expect(rules.length).toBe(1);
    const lastContent = [...lines].reverse().find((l) => l.trim() !== "") ?? "";
    expect(lastContent).toContain("tools");
  });

  test("B1c 不传 provider 时不出现 provider 行，但底部空行仍在", () => {
    const plain = stripAnsi(banner("m", "http://127.0.0.1:1", undefined, undefined, "read_file"));
    expect(plain).not.toContain("provider ");
    expect(plain.endsWith("\n ")).toBe(true);
  });
});
