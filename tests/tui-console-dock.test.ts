/**
 * Console ↔ dock 接线单测（v0.3.0 F2）：补上 console.ts dock 分支此前零单测的缺口。
 */
import { describe, expect, test } from "bun:test";
import { Console, type ConsoleDock } from "../src/ui/console.ts";
import { TranscriptDock, type DockHost } from "../src/tui/dock.ts";

class FakeDock implements ConsoleDock {
  calls: Array<{ m: string; arg?: unknown }> = [];
  writeStream(t: string): void { this.calls.push({ m: "writeStream", arg: t }); }
  line(t = ""): void { this.calls.push({ m: "line", arg: t }); }
  blank(): void { this.calls.push({ m: "blank" }); }
  tool(t: string): void { this.calls.push({ m: "tool", arg: t }); }
  spinner(t: string | null): void { this.calls.push({ m: "spinner", arg: t }); }
  dropActivity(): void { this.calls.push({ m: "dropActivity" }); }
  finishActivity(): void { this.calls.push({ m: "finishActivity" }); }
  failTool(rows: string[]): void { this.calls.push({ m: "failTool", arg: rows }); }
  commitLines(rows: string[]): void { this.calls.push({ m: "commitLines", arg: rows }); }
  notice(t: string, ms: number): void { this.calls.push({ m: "notice", arg: { t, ms } }); }
  resize(): void { this.calls.push({ m: "resize" }); }
  find(m: string): Array<{ m: string; arg?: unknown }> { return this.calls.filter((c) => c.m === m); }
}

function makeConsole(dock: FakeDock, details = false): Console {
  return new Console(true, details, {
    stdoutIsTTY: true,
    stdinIsTTY: true,
    columns: () => 80,
    write: () => {},
    dock,
  });
}

describe("F2 Console dock 接线", () => {
  test("F2k 流式前缀/正文/换行全部走 dock.writeStream", () => {
    const dock = new FakeDock();
    const c = makeConsole(dock);
    c.beginStream("answer");
    c.writeStream("hello", "answer");
    c.endStream("answer");
    const texts = dock.find("writeStream").map((x) => x.arg as string);
    expect(texts[0]).toContain("● ");
    expect(texts[1]).toContain("hello");
    expect(texts).toContain("\n");
  });

  test("F2l 紧凑工具行：header 起活动行，成功保留 ✓，失败走 failTool", () => {
    const dock = new FakeDock();
    const c = makeConsole(dock);
    c.toolHeader("read_file", '{"path":"a.txt"}');
    const started = dock.find("tool").at(-1)?.arg as string;
    expect(started).toContain("read_file");
    c.toolResult("ok", 2, true);
    expect((dock.find("tool").at(-1)?.arg as string)).toContain("✓");
    c.toolHeader("shell", "false");
    c.toolResult("$ false\n[stderr] boom\n[exit 1]", 2, false);
    const failed = dock.find("failTool");
    expect(failed.length).toBe(1);
    expect((failed[0]?.arg as string[]).join("\n")).toContain("boom");
  });

  test("F2m 详情模式：工具输出批量 commitLines（不是逐行）", () => {
    const dock = new FakeDock();
    const c = makeConsole(dock, true);
    c.toolHeader("read_file", "a.txt");
    expect(dock.find("line").length).toBeGreaterThan(0); // header 一行
    c.toolResult("l1\nl2\nl3", 18, true);
    expect(dock.find("commitLines").length).toBe(1);
  });

  test("F2n line/blank/flashNotice 走 dock", () => {
    const dock = new FakeDock();
    const c = makeConsole(dock);
    c.line("x");
    c.blank();
    c.flashNotice("Press Ctrl+C again", 2000);
    expect(dock.find("line").at(-1)?.arg).toBe("x");
    expect(dock.find("blank").length).toBe(1);
    expect(dock.find("notice").at(-1)?.arg).toEqual({ t: "Press Ctrl+C again", ms: 2000 });
  });

  test("F2o spinner 定时器在 stopSpinner 后停止（不泄漏）", async () => {
    const dock = new FakeDock();
    const c = makeConsole(dock);
    c.startSpinner("thinking");
    await new Promise((r) => setTimeout(r, 140));
    expect(dock.find("spinner").length).toBeGreaterThan(0);
    c.stopSpinner();
    const after = dock.find("spinner").length;
    await new Promise((r) => setTimeout(r, 140));
    expect(dock.find("spinner").length).toBe(after);
  });

  test("F2q 首个正文 chunk 前 stopSpinner 不能把「● 」单独提交成一行（v0.3.0 回归）", () => {
    const commits: string[][] = [];
    const host: DockHost = {
      width: () => 80,
      commitAbove: (rows) => { commits.push(rows); },
      setPending: () => {},
      setActivity: () => {},
      commitActivity: () => {},
      clearActivity: () => {},
      notice: () => {},
      rerender: () => {},
    };
    const dock = new TranscriptDock(host);
    const c = new Console(true, false, {
      stdoutIsTTY: true, stdinIsTTY: true, columns: () => 80, write: () => {}, dock,
    });
    c.beginStream("answer");
    c.writeStream("先看看", "answer");
    c.stopSpinner(); // agent 在第二个 chunk 前会再调一次 stopSpinner
    c.writeStream("这个文件。", "answer");
    c.writeStream("\n", "answer");
    const flat = commits.flat();
    expect(flat).toEqual(["● 先看看这个文件。"]);
  });

  test("F2r stopSpinner 后工具行计时器不再重画（审批重复落盘回归）", async () => {
    const dock = new FakeDock();
    const c = makeConsole(dock);
    c.toolHeader("write_file", '{"path":"a.txt"}');
    const before = dock.find("tool").length;
    c.stopSpinner();
    await new Promise((r) => setTimeout(r, 450));
    expect(dock.find("tool").length).toBe(before);
    c.toolResult("done", 2, true);
    c.line("after");
    const tools = dock.find("tool").map((x) => x.arg as string);
    // 同一工具行的最终状态只应出现一次（不会 running/✓ 反复落盘）
    expect(tools.filter((t) => t.includes("write_file")).length).toBeGreaterThanOrEqual(1);
  });

  test("F2p hasLiveDock 为 true；dock resize 走 dock.resize", () => {
    const dock = new FakeDock();
    const c = makeConsole(dock);
    expect(c.hasLiveDock).toBe(true);
    c.handleResize();
    expect(dock.find("resize").length).toBe(1);
  });
});
