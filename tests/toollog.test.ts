/**
 * toollog.test.ts — v0.2.3 D3：工具调用缓存 + `/last` 回看 + 失败可读。
 *
 * 规格：docs/v0.2.3-tui-patch-prd[done].md D3。
 * 关键取舍：紧凑模式成功仍只占 1 行；失败时追加至多 3 行正文 + 指向 `/last` 的提示。
 * simplify 审查补充：失败摘要也要受宽度约束、输出要清洗控制序列。
 */
import { describe, expect, test } from "bun:test";

import { captureConsole } from "./helpers.ts";
import { displayWidth } from "../src/ui/theme.ts";
import {
  MAX_TOOL_HISTORY,
  formatDuration,
  formatToolCall,
  sanitizeOutput,
  summarizeFailure,
  type ToolCallRecord,
} from "../src/ui/toolLog.ts";

function rec(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    name: "read_file",
    args: '{"path":"a.txt"}',
    ok: true,
    ms: 12,
    output: "hello",
    at: 1_700_000_000_000,
    ...over,
  };
}

describe("D3a 失败摘要（shell 的 stderr 不再被首行挤掉）", () => {
  test("shell 失败：tail 取 stderr 首行 + exit code，不取 `$ cmd`", () => {
    const body = "$ rm -rf /nope\n[stderr] rm: no such file or directory\nmore detail\n[exit 1]";
    const { tail, detail } = summarizeFailure(body);
    expect(tail).toContain("no such file");
    expect(tail).toContain("exit 1");
    expect(tail).not.toContain("$ rm -rf");
    expect(tail).not.toContain("\n");
    expect(detail.join("\n")).toContain("more detail");
    expect(detail.length).toBeLessThanOrEqual(3);
  });

  test("无 [exit] 的通用错误：退化为正文首行，且不重复「错误:」前缀", () => {
    const { tail, detail } = summarizeFailure("错误: 找不到目标\n第二行\n第三行\n第四行");
    expect(tail).toContain("找不到目标");
    expect(tail.startsWith("错误: 错误:")).toBe(false);
    expect(detail.length).toBe(3);
    expect(detail[0]).toContain("找不到目标");
  });

  test("空正文不抛异常", () => {
    expect(() => summarizeFailure("")).not.toThrow();
    expect(summarizeFailure("").tail.length).toBeGreaterThan(0);
  });

  test("输出清洗：剥 CSI/SGR、展开 tab、保留换行（防止 stderr 清屏）", () => {
    const body = "a\x1b[2Jb\tc\x1b[31mred\x1b[0m\nd";
    const out = sanitizeOutput(body);
    expect(out).not.toContain("\x1b");
    expect(out).toContain("ab  cred"); // CSI 剥掉后 tab 展开为两空格
    expect(out).toContain("red");
    expect(out.split("\n").length).toBe(2);
  });
});

describe("D3b 时长与格式化", () => {
  test("毫秒 < 1s 显示 ms，>= 1s 显示 s（一位小数）", () => {
    expect(formatDuration(12)).toBe("12ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(12_340)).toBe("12.3s");
  });

  test("成功记录：单行头 + 缩进正文，正文超限有省略提示", () => {
    const lines = formatToolCall(
      rec({ output: Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n") }),
      100,
      { maxLines: 3 },
    );
    expect(lines[0]).toContain("read_file");
    expect(lines[0]).toContain("✓");
    expect(lines[0]).toContain("12ms");
    const text = lines.join("\n");
    expect(text).toContain("line0");
    expect(text).toContain("line2");
    expect(text).not.toContain("line3");
    expect(text).toContain("行未显示");
  });

  test("失败记录：✗ + 摘要来自 stderr", () => {
    const lines = formatToolCall(
      rec({ name: "shell", ok: false, output: "$ false\n[stderr] boom\n[exit 1]" }),
      100,
    );
    expect(lines[0]).toContain("✗");
    expect(lines[0]).toContain("boom");
    expect(lines[0]).toContain("exit 1");
  });

  test("单行头不超过给定宽度（CJK 安全）", () => {
    const lines = formatToolCall(
      rec({ name: "shell", args: `{"command":"${"很长的中文命令".repeat(6)}"}` }),
      60,
    );
    expect(displayWidth(lines[0]!)).toBeLessThanOrEqual(60);
  });

  test("失败摘要很长时单行头仍不超宽（simplify 审查回归）", () => {
    const lines = formatToolCall(
      rec({ name: "shell", ok: false, output: `[stderr] ${"x".repeat(300)}\n[exit 1]` }),
      80,
    );
    expect(displayWidth(lines[0]!)).toBeLessThanOrEqual(80);
  });
});

describe("D3c Console 缓存与紧凑失败展示", () => {
  test("成功不打印正文（v0.2.2 的清爽不回归）", () => {
    const { ui, out } = captureConsole({ compact: true });
    ui.toolHeader("read_file", '{"path":"a.txt"}');
    ui.toolResult("hello\nworld", 2, true);
    expect(out()).toContain("read_file");
    expect(out()).not.toContain("hello");
  });

  test("失败追加至多 3 行正文 + /last 提示，仍带 ✗", () => {
    const { ui, out } = captureConsole({ compact: true });
    ui.toolHeader("shell", '{"command":"false"}');
    ui.toolResult("$ false\n[stderr] boom\nsecond\nthird\nfourth\n[exit 1]", 2, false);
    const text = out();
    expect(text).toContain("✗");
    expect(text).toContain("boom");
    expect(text).toContain("/last");
    expect(text.split("\n").length).toBeLessThanOrEqual(6);
  });

  test("缓存按时间顺序保存，recentToolCalls 返回最新在前", () => {
    const { ui } = captureConsole({ compact: true });
    for (const n of ["a", "b", "c"]) {
      ui.toolHeader(n, "{}");
      ui.toolResult("ok", 2, true);
    }
    const recent = ui.recentToolCalls(2);
    expect(recent.map((r) => r.name)).toEqual(["c", "b"]);
    expect(ui.recentToolCalls().length).toBe(3);
  });

  test("缓存上限 20 条（最旧的被挤出）", () => {
    const { ui } = captureConsole({ compact: true });
    for (let i = 0; i < MAX_TOOL_HISTORY + 5; i++) {
      ui.toolHeader(`t${i}`, "{}");
      ui.toolResult("ok", 2, true);
    }
    const all = ui.recentToolCalls(MAX_TOOL_HISTORY + 5);
    expect(all.length).toBe(MAX_TOOL_HISTORY);
    expect(all[0]!.name).toBe(`t${MAX_TOOL_HISTORY + 4}`);
    expect(all.at(-1)!.name).toBe("t5");
  });

  test("缓存记录耗时与完整输出（供 /last 回看）", () => {
    const { ui } = captureConsole({ compact: true });
    ui.toolHeader("read_file", '{"path":"a.txt"}');
    ui.toolResult("第一行\n第二行", 2, true);
    const [r] = ui.recentToolCalls(1);
    expect(r!.output).toContain("第二行");
    expect(r!.ok).toBe(true);
    expect(r!.ms).toBeGreaterThanOrEqual(0);
  });

  test("详情模式也进缓存（/last 不依赖显示模式）", () => {
    const { ui, out } = captureConsole({ compact: false });
    ui.toolHeader("read_file", '{"path":"a.txt"}');
    ui.toolResult("hello", 2, true);
    expect(out()).toContain("hello"); // 详情模式正文上屏
    expect(ui.recentToolCalls(1)[0]!.name).toBe("read_file");
  });
});
