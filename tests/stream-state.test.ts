/**
 * stream-state.test.ts — v0.2.3 D1：流式状态复位。
 *
 * 实测 bug（PTY S1）：`agent.ts` 正常路径从不调用 endStream("answer")，
 * Console.streaming 置 true 后再无复位，后续 beginStream 命中早退 ——
 * 一次会话里 `●` 正文前缀只会出现一次。
 * 规格：docs/v0.2.3-tui-patch-prd[done].md D1。
 * simplify 审查补充：流式块记录 kind，收尾不再靠调用方猜。
 */
import { describe, expect, test } from "bun:test";

import { captureConsole } from "./helpers.ts";
import { StreamFormatter } from "../src/ui/stream.ts";

const bullets = (s: string): number => s.split("● ").length - 1;

describe("D1 流式状态", () => {
  test("beginStream 写 ● 前缀，endStream 默认补换行", () => {
    const { ui, out } = captureConsole();
    ui.beginStream("answer");
    ui.writeStream("你好", "answer");
    ui.endStream();
    expect(out()).toContain("● ");
    expect(out().endsWith("\n")).toBe(true);
  });

  test("endStream(newline=false) 不写任何换行（正文换行由 StreamFormatter 负责）", () => {
    const { ui, out } = captureConsole();
    ui.beginStream("answer");
    ui.writeStream("你好", "answer");
    ui.endStream("answer", false);
    expect(out()).toBe("● 你好");
  });

  test("复位后下一个批次还能拿到 ● 前缀（回归：旧实现第二段无前缀）", () => {
    const { ui, out } = captureConsole();
    ui.beginStream("answer");
    ui.writeStream("第一段", "answer");
    ui.endStream("answer", false);
    ui.beginStream("answer");
    ui.writeStream("第二段", "answer");
    ui.endStream("answer", false);
    expect(bullets(out())).toBe(2);
  });

  test("endStream 幂等：重复调用不产生额外换行", () => {
    const { ui, out } = captureConsole();
    ui.beginStream("answer");
    ui.endStream("answer");
    const once = out();
    ui.endStream("answer");
    expect(out()).toBe(once);
  });

  test("工具行收尾后正文流仍能正常开新块", () => {
    const { ui, out } = captureConsole({ compact: true });
    ui.toolHeader("read_file", '{"path":"a.txt"}');
    ui.toolResult("hello", 2, true);
    ui.beginStream("answer");
    ui.writeStream("读完了", "answer");
    ui.endStream("answer", false);
    expect(bullets(out())).toBe(1);
    expect(out()).toContain("读完了");
  });

  test("ensureStreamClosed 在已复位后不写多余换行", () => {
    const { ui, out } = captureConsole();
    ui.beginStream("answer");
    ui.endStream("answer");
    const before = out();
    ui.ensureStreamClosed();
    expect(out()).toBe(before);
  });

  test("kind 由 Console 记录：推理块收尾补 └─，不依赖调用方传对 kind", () => {
    const { ui, out } = captureConsole();
    ui.beginStream("reasoning");
    ui.writeStream("思考中", "reasoning");
    ui.ensureStreamClosed(); // 无参
    expect(out()).toContain("┌ think");
    expect(out()).toContain("└─");
  });

  test("正文与 ● 前缀相邻（真实路径：StreamFormatter 经 writeRaw 复用 Console 通道）", () => {
    const { ui, out } = captureConsole();
    const fmt = new StreamFormatter({ colorize: false, write: (s) => ui.writeRaw(s) });
    ui.beginStream("answer");
    fmt.write("第一段\n");
    fmt.finish();
    ui.endStream("answer", false);
    ui.beginStream("answer");
    fmt.write("第二段\n");
    fmt.finish();
    ui.endStream("answer", false);
    const text = out();
    expect(text).toContain("● 第一段");
    expect(text).toContain("● 第二段");
    expect(bullets(text)).toBe(2);
  });
});
