/**
 * toolcall-display.test.ts — 紧凑工具行格式化 + toolcall_info_details 配置。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dotsText, nextDots, toolLineSegments } from "../src/ui/toolLine.ts";
import { displayWidth } from "../src/ui/theme.ts";
import { loadConfig } from "../src/config.ts";

let SANDBOX = "";
beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-toolcall-display-"));
});
afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function cfgFor(cwd: string, settings?: Record<string, unknown>): ReturnType<typeof loadConfig> {
  writeFileSync(join(cwd, "settings.json"), JSON.stringify(settings ?? {}), "utf8");
  const old = process.cwd();
  try {
    process.chdir(cwd);
    return loadConfig();
  } finally {
    process.chdir(old);
  }
}

describe("A 紧凑工具行", () => {
  test("A1 点号循环 3 档", () => {
    expect([dotsText(0), dotsText(1), dotsText(2)]).toEqual([".", "..", "..."]);
    expect(nextDots(0)).toBe(1);
    expect(nextDots(1)).toBe(2);
    expect(nextDots(2)).toBe(0);
  });

  test("A2 运行中 / 完成 / 失败尾标", () => {
    const running = toolLineSegments({ name: "list_dir", args: '{"path":"."}', width: 100, dots: 1 });
    expect(running.tail).toBe("..");
    const ok = toolLineSegments({ name: "list_dir", args: "", width: 100, status: "ok" });
    expect(ok.tail).toBe("✓");
    const err = toolLineSegments({
      name: "send_message",
      args: "{}",
      width: 100,
      status: "error",
      errorText: "错误: 找不到目标\n第二行",
    });
    expect(err.tail.startsWith("✗ 错误: 找不到目标")).toBe(true);
    expect(err.tail).not.toContain("\n");
  });

  test("A3 长参数截断到单行宽度内", () => {
    const seg = toolLineSegments({
      name: "send_message",
      args: `{"target":"a-very-long-target-name","body":"${"x".repeat(400)}"}`,
      width: 80,
      dots: 2,
    });
    const line = ` ⚡ ${seg.name} ${seg.args} ${seg.tail}`;
    expect(displayWidth(line)).toBeLessThanOrEqual(80);
    expect(seg.args.length).toBeGreaterThan(0);
  });

  test("A4 超长工具名也能收敛", () => {
    const seg = toolLineSegments({ name: "x".repeat(200), args: "y".repeat(200), width: 60 });
    const line = ` ⚡ ${seg.name} ${seg.args} ${seg.tail}`;
    expect(displayWidth(line)).toBeLessThanOrEqual(60);
  });

  test("A5 超长错误摘要不撑爆单行", () => {
    const seg = toolLineSegments({
      name: "send_message",
      args: "{}",
      width: 60,
      status: "error",
      errorText: `错误: ${"炸".repeat(200)}`,
    });
    const line = ` ⚡ ${seg.name} ${seg.args} ${seg.tail}`;
    expect(displayWidth(line)).toBeLessThanOrEqual(60);
    expect(seg.tail.startsWith("✗")).toBe(true);
  });
});

describe("B 配置", () => {
  test("B1 toolcall_info_details 默认 false", () => {
    const cwd = mkdtempSync(join(SANDBOX, "cfg-"));
    const cfg = cfgFor(cwd);
    expect(cfg.toolcallInfoDetails).toBe(false);
  });

  test("B2 显式 true 与连字符别名均可开启", () => {
    const cwd1 = mkdtempSync(join(SANDBOX, "cfg-true-"));
    expect(cfgFor(cwd1, { toolcall_info_details: true }).toolcallInfoDetails).toBe(true);
    const cwd2 = mkdtempSync(join(SANDBOX, "cfg-hyphen-"));
    expect(cfgFor(cwd2, { "toolcall-info-details": true }).toolcallInfoDetails).toBe(true);
  });
});
