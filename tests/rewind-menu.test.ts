/**
 * issue #47：交互式 rewind 菜单的纯逻辑。
 *
 * 覆盖：
 *  A EscDoublePress：窗口内双击命中、超窗不命中、reset 后不误判、命中后复位
 *  B 菜单数据：轮次项（编号/时间/提示截断/检查点/已压缩）、模式项顺序
 *  C 结果文案：含自动轮与跳过计数
 *
 * 按键接线与模态渲染由 scripts/pty-e2e.ts 的 S30 兜底（真 PTY）。
 */
import { describe, expect, test } from "bun:test";

import {
  EscDoublePress,
  REWIND_MENU_WINDOW_MS,
  modeLabel,
  modeMenuItems,
  rewindSummary,
  turnMenuItems,
} from "../src/tui/rewindMenu.ts";
import type { RewindTurn } from "../src/rewind.ts";

describe("A EscDoublePress", () => {
  test("A1 窗口内两次 Esc 命中（≤400ms）", () => {
    const d = new EscDoublePress();
    expect(d.arm(1000)).toBe(false);
    expect(d.arm(1000 + REWIND_MENU_WINDOW_MS)).toBe(true);
  });

  test("A2 超过窗口不命中，且以第二次为新起点重新武装", () => {
    const d = new EscDoublePress();
    expect(d.arm(0)).toBe(false);
    expect(d.arm(REWIND_MENU_WINDOW_MS + 1)).toBe(false);
    // 第二次已成为新起点：紧接着再按一次应命中
    expect(d.arm(REWIND_MENU_WINDOW_MS + 2)).toBe(true);
  });

  test("A3 命中后复位：第三次 Esc 不会立刻再命中", () => {
    const d = new EscDoublePress();
    d.arm(0);
    expect(d.arm(10)).toBe(true);
    expect(d.arm(20)).toBe(false);
  });

  test("A4 reset 后不误判（Esc → 打字 → Esc 不算双击）", () => {
    const d = new EscDoublePress();
    expect(d.arm(0)).toBe(false);
    d.reset();
    expect(d.armed).toBe(false);
    expect(d.arm(10)).toBe(false);
  });

  test("A5 窗口可注入（测试不真等 400ms）", () => {
    const d = new EscDoublePress(50);
    expect(d.arm(0)).toBe(false);
    expect(d.arm(51)).toBe(false);
    expect(d.arm(60)).toBe(true);
  });
});

function turn(over: Partial<RewindTurn> = {}): RewindTurn {
  return {
    index: 0,
    prompt: "读一下 a.txt",
    at: "2026-11-10T13:24:05.000Z",
    messagesBefore: 1,
    checkpointSeqs: [],
    source: "human",
    ...over,
  };
}

describe("B 菜单数据", () => {
  test("B1 轮次项带编号、时间、提示与检查点提示", () => {
    const items = turnMenuItems([
      turn({ index: 0, checkpointSeqs: [1, 2] }),
      turn({ index: 1, prompt: "第二句", at: "2026-11-10T13:30:00.000Z" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]!.label).toContain("[0]");
    expect(items[0]!.label).toContain("13:24:05");
    expect(items[0]!.label).toContain("读一下 a.txt");
    expect(items[0]!.hint).toContain("2 个文件检查点");
    expect(items[1]!.value).toBe(1);
    expect(items[1]!.hint).toContain("无文件检查点");
  });

  test("B2 长提示截断到 50 字符 + 省略号", () => {
    const long = "x".repeat(80);
    const items = turnMenuItems([turn({ prompt: long })]);
    expect(items[0]!.label).toContain("…");
    expect(items[0]!.label).not.toContain("x".repeat(51));
  });

  test("B3 已压缩轮次带标记（issue #39 口径可见）", () => {
    const items = turnMenuItems([turn({ compacted: true })]);
    expect(items[0]!.hint).toContain("已压缩");
  });

  test("B4 模式项顺序固定 both → code → conversation", () => {
    expect(modeMenuItems().map((m) => m.value)).toEqual(["both", "code", "conversation"]);
    expect(modeLabel("both")).toBe("代码 + 对话");
  });
});

describe("C 结果文案", () => {
  test("C1 含自动轮与跳过计数", () => {
    const s = rewindSummary({
      turnsRemoved: 2,
      autoTurnsRemoved: 1,
      messagesRemoved: 5,
      filesRestored: 3,
      filesSkipped: 1,
    });
    expect(s).toContain("已回滚 2 轮");
    expect(s).toContain("另含 1 个自动轮");
    expect(s).toContain("对话 -5 条");
    expect(s).toContain("文件恢复 3 处");
    expect(s).toContain("跳过 1 处");
  });

  test("C2 无自动轮/无跳过时不出现多余文案", () => {
    const s = rewindSummary({
      turnsRemoved: 1,
      autoTurnsRemoved: 0,
      messagesRemoved: 2,
      filesRestored: 0,
      filesSkipped: 0,
    });
    expect(s).not.toContain("自动轮");
    expect(s).not.toContain("跳过");
  });
});
