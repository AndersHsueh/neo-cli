/**
 * v0.4.2 tier 视觉语义：深思亮红 / 平衡绿 / 快速亮蓝 / 默认冰绿。
 *
 * 颜色断言只对纯 helper 做，不比对整屏 ANSI，避免 PTY 渲染差异导致脆弱。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { c, tierRgb } from "../src/ui/theme.ts";
import { renderStatus, statusSegments, type StatusSnapshot } from "../src/tui/status.ts";
import { Console } from "../src/ui/console.ts";
import { toolLineSegments, toolLineText } from "../src/ui/toolLine.ts";
import { sleep } from "./helpers.ts";

const OLD_FORCE = process.env["FORCE_COLOR"];
const OLD_NO = process.env["NO_COLOR"];

beforeAll(() => {
  process.env["FORCE_COLOR"] = "1";
  delete process.env["NO_COLOR"];
});

afterAll(() => {
  if (OLD_FORCE === undefined) delete process.env["FORCE_COLOR"];
  else process.env["FORCE_COLOR"] = OLD_FORCE;
  if (OLD_NO === undefined) delete process.env["NO_COLOR"];
  else process.env["NO_COLOR"] = OLD_NO;
});

const snap = (tier: string): StatusSnapshot => ({
  model: "deepseek-flash",
  tier,
  mode: "ask",
  branch: "main",
  ctxUsage: 0.42,
  elapsedMs: 42_000,
  active: true,
  tokensTotal: 12_300,
  width: 120,
});

describe("tier 色板", () => {
  test("三档 + default 映射唯一且符合约定", () => {
    expect(tierRgb("deep_reasoning")).toEqual([255, 59, 48]);
    expect(tierRgb("balanced")).toEqual([0, 255, 65]);
    expect(tierRgb("fast")).toEqual([0, 200, 255]);
    expect(tierRgb("default")).toEqual([180, 255, 190]);
    // 未知档位回退平衡绿，不出现无色
    expect(tierRgb("wat")).toEqual([0, 255, 65]);
  });

  test("c.tier 输出对应 RGB（FORCE_COLOR）", () => {
    expect(c.tier("deep_reasoning", "⚡")).toContain("38;2;255;59;48");
    expect(c.tier("balanced", "⚡")).toContain("38;2;0;255;65");
    expect(c.tier("fast", "⚡")).toContain("38;2;0;200;255");
    expect(c.tier("default", "⚡")).toContain("38;2;180;255;190");
  });
});

describe("状态条 tier 角色", () => {
  test("tier 字段用独立角色，painter 能按档位着色", () => {
    const segs = statusSegments(snap("fast"));
    expect(segs.find((s) => s.text === "fast")?.role).toBe("tier");
    const painted = renderStatus(snap("fast"), (role, text) =>
      role === "tier" ? `<tier>${text}` : text,
    );
    expect(painted).toContain("<tier>fast");
  });
});

describe("工作图标与流式前缀", () => {
  test("回答前缀 ● 使用当前 tier 色", () => {
    const chunks: string[] = [];
    const ui = new Console(true, false, {
      stdoutIsTTY: true,
      stdinIsTTY: false,
      getTier: () => "fast",
      write: (s) => chunks.push(s),
    });
    ui.beginStream("answer");
    const out = chunks.join("");
    expect(out).toContain("●");
    expect(out).toContain("38;2;0;200;255");
    ui.endStream("answer");
  });

  test("spinner 带 ⚡ 且按当前 tier 着色", async () => {
    const chunks: string[] = [];
    const ui = new Console(true, false, {
      stdoutIsTTY: true,
      stdinIsTTY: false,
      getTier: () => "fast",
      write: (s) => chunks.push(s),
    });
    ui.startSpinner("连接中…");
    await sleep(120);
    ui.stopSpinner();
    const out = chunks.join("");
    expect(out).toContain("⚡");
    expect(out).toContain("38;2;0;200;255");
    expect(out).toContain("连接中");
  });

  test("工具行 ⚡ 使用当前 tier 色", () => {
    const seg = toolLineSegments({ name: "read_file", args: "a.txt", width: 80, dots: 0 });
    const fast = toolLineText(seg, c.dim(".."), "fast");
    expect(fast).toContain("⚡");
    expect(fast).toContain("38;2;0;200;255");
    const deep = toolLineText(seg, c.dim(".."), "deep_reasoning");
    expect(deep).toContain("38;2;255;59;48");
  });
});
