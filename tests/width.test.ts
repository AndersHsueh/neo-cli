/**
 * width.test.ts — v0.2.3 D2：宽度数学与终端宽度回落。
 *
 * 背景（实测）：旧 `theme.truncate` 按 code unit 切，CJK 会超宽 ——
 * `truncate("中文内容很长的字符串", 10)` 返回 20 列，窄终端下工具输出右侧被折断。
 * 规格：docs/v0.2.3-tui-patch-prd[done].md D2。
 */
import { describe, expect, test } from "bun:test";

import { Console } from "../src/ui/console.ts";
import { displayWidth, truncate } from "../src/ui/theme.ts";
import { toolLineSegments } from "../src/ui/toolLine.ts";
import { captureConsole, sleep } from "./helpers.ts";

describe("D2a truncate 按显示列截断", () => {
  test("CJK 不超过目标列宽（旧实现返回 20 列）", () => {
    const s = "中文内容很长的字符串";
    // 20 列时恰好装下，不截断；其余档位必须截断且不超宽
    expect(truncate(s, 20)).toBe(s);
    for (const max of [19, 10, 6, 2]) {
      const out = truncate(s, max);
      expect(displayWidth(out)).toBeLessThanOrEqual(Math.max(1, max));
      expect(out.endsWith("…")).toBe(true);
    }
  });

  test("ASCII 行为不变", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("abc", 5)).toBe("abc");
  });

  test("max<=0 / 非有限值返回空串", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -3)).toBe("");
    expect(truncate("abc", Number.NaN)).toBe("");
  });

  test("混合宽度不切出半个宽字符", () => {
    const out = truncate("a中b文c", 4);
    expect(displayWidth(out)).toBeLessThanOrEqual(4);
    expect(out).toBe("a中…".slice(0, out.length)); // 不产生孤立代理对/乱码
    expect(out).not.toContain("\uFFFD");
  });

  test("ANSI 着色串按可见宽度截断且不切断转义", () => {
    const painted = "\x1b[31m中文内容很长的字符串\x1b[0m";
    const out = truncate(painted, 6);
    expect(out).not.toContain("\x1b[31m\x1b[0m"); // 不产生空着色壳
    expect(displayWidth(out)).toBeLessThanOrEqual(6);
  });
});

describe("D2c 失败摘要不挤掉工具名", () => {
  test("长路径错误下 read_file 仍完整可见，摘要只占一半宽度", () => {
    const seg = toolLineSegments({
      name: "read_file",
      args: '{"path":"a.txt"}',
      width: 80,
      status: "error",
      errorText: "错误: 文件不存在: /very/long/path/that/keeps/going/and/going/a.txt",
    });
    expect(seg.name).toBe("read_file");
    expect(displayWidth(seg.tail)).toBeLessThanOrEqual(40);
    expect(displayWidth(` ⚡ ${seg.name} ${seg.args} ${seg.tail}`)).toBeLessThanOrEqual(80);
  });

  test("成功尾部不受影响", () => {
    const seg = toolLineSegments({ name: "shell", args: "", width: 80, status: "ok" });
    expect(seg.tail).toBe("✓");
  });
});

describe("D2b Console 宽度回落", () => {
  const col = (columns: (() => number) | undefined): number =>
    new Console(false, true, { stdoutIsTTY: true, ...(columns ? { columns } : {}) }).width;

  test("未报宽度时回落 80（旧实现回落 100）", () => {
    expect(col(() => 0)).toBe(80);
    expect(col(undefined)).toBe(80);
  });

  test("过窄宽度（<=20）同样回落 80，而不是按 20 排版", () => {
    expect(col(() => 20)).toBe(80);
    expect(col(() => 12)).toBe(80);
  });

  test("正常宽度原样返回", () => {
    expect(col(() => 60)).toBe(60);
    expect(col(() => 133)).toBe(133);
  });
});

describe("D2d resize 不永久杀死动画", () => {
  test("工具行在 resize 后仍会继续重画（不是只清一次就静止）", async () => {
    const { ui, out } = captureConsole({ compact: true, columns: 100 });
    ui.toolHeader("shell", '{"command":"sleep 30"}');
    const before = out().length;
    ui.handleResize(); // 清行 + 从新行重画
    expect(out().length).toBeGreaterThan(before);
    const afterResize = out().length;
    await sleep(450); // > 350ms 工具行动画周期
    expect(out().length).toBeGreaterThan(afterResize);
  });

  test("spinner 在 resize 后下一帧从新行继续", async () => {
    const { ui, out } = captureConsole({ compact: true });
    ui.startSpinner("连接中…");
    await sleep(120);
    ui.handleResize();
    const afterResize = out().length;
    await sleep(150);
    expect(out().length).toBeGreaterThan(afterResize);
    ui.stopSpinner();
  });
});
