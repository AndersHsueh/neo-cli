/**
 * flash-notice.test.ts — v0.2.3 D5：Ctrl+C 双击提示不再破坏提示符。
 *
 * 实测 bug：旧实现超时后用 `promptEcho("")` 收尾 —— 打一行 `❯ ` + 换行，
 * 既不重绘 readline，也不恢复行缓冲；用户敲到一半的字会从屏幕上消失，
 * 回车却会把它发出去。
 * 规格：docs/v0.2.3-tui-patch-prd[done].md D5。
 * simplify 审查补充：运行中的工具行计时器不能把重绘后的提示符再擦掉。
 */
import { describe, expect, test } from "bun:test";

import { captureConsole, sleep } from "./helpers.ts";
import type { Console } from "../src/ui/console.ts";

function withRestorer(
  opts: { stdoutIsTTY?: boolean } = {},
): { ui: Console; out: () => string; restores: () => number } {
  const { ui, out } = captureConsole({ stdoutIsTTY: opts.stdoutIsTTY ?? true, compact: true });
  let restores = 0;
  ui.setPromptRestorer(() => {
    restores += 1;
  });
  return { ui, out, restores: () => restores };
}

describe("D5 flashNotice", () => {
  test("打印提示后立刻重绘提示符，且不自己画 ❯", async () => {
    const { ui, out, restores } = withRestorer();
    ui.flashNotice("Press Ctrl+C again to exit", 30);
    expect(out()).toContain("again to exit");
    expect(out()).not.toContain("❯");
    expect(restores()).toBe(1);
    await sleep(60);
  });

  test("超时后清行并再次重绘，不打印 ❯ / 不写换行提示符", async () => {
    const { ui, out, restores } = withRestorer();
    ui.flashNotice("Press Ctrl+C again to exit", 20);
    await sleep(50);
    expect(restores()).toBe(2);
    // 收尾是「清当前行 + 交回 readline」，不能出现自带提示符行
    expect(out()).not.toContain("❯");
    const tail = out().slice(out().indexOf("\n") + 1);
    expect(tail).not.toMatch(/❯/);
  });

  test("无 restorer 时退化为提示 + 换行，不伪装提示符", async () => {
    const { ui, out } = captureConsole({ stdoutIsTTY: true, compact: true });
    ui.flashNotice("注意", 20);
    expect(out()).toContain("注意");
    expect(out()).not.toContain("❯");
    await sleep(50);
  });

  test("非 TTY 不写任何东西", () => {
    const { ui, out } = captureConsole({ stdoutIsTTY: false, compact: true });
    ui.setPromptRestorer(() => {
      throw new Error("非 TTY 不应重绘");
    });
    ui.flashNotice("注意", 20);
    expect(out()).toBe("");
  });

  test("运行中的工具行先被收尾，提示后不会被 350ms 计时器抢回", async () => {
    const { ui, out } = withRestorer();
    ui.toolHeader("shell", '{"command":"sleep 30"}');
    ui.flashNotice("Press Ctrl+C again to exit", 5_000);
    const afterFlash = out().length;
    await sleep(450); // > 工具行 350ms 周期
    expect(out().length).toBe(afterFlash); // 计时器已停，不会覆盖提示符
    expect(out()).not.toContain("❯");
  });
});
