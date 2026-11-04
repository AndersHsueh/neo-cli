/**
 * tui/dock.ts 单测（v0.3.0 F2）：用假宿主收集语义调用，不碰真实终端。
 */
import { describe, expect, test } from "bun:test";
import { TranscriptDock, type DockHost } from "../src/tui/dock.ts";
import { displayWidth } from "../src/ui/theme.ts";

interface Call { kind: string; arg?: unknown }

function makeHost(width = 20): { host: DockHost; calls: Call[]; pending: () => string[]; activity: () => { text: string | null; persist: boolean } } {
  const calls: Call[] = [];
  let pendingRows: string[] = [];
  let act: { text: string | null; persist: boolean } = { text: null, persist: false };
  const host: DockHost = {
    width: () => width,
    commitAbove: (rows) => { calls.push({ kind: "commit", arg: rows }); pendingRows = []; },
    setPending: (rows) => { calls.push({ kind: "pending", arg: rows }); pendingRows = rows; },
    setActivity: (text, persist) => { calls.push({ kind: "activity", arg: { text, persist } }); act = { text, persist }; },
    commitActivity: () => { calls.push({ kind: "commitActivity" }); act = { text: null, persist: false }; },
    clearActivity: () => { calls.push({ kind: "clearActivity" }); act = { text: null, persist: false }; },
    notice: (text, ms) => calls.push({ kind: "notice", arg: { text, ms } }),
    rerender: () => calls.push({ kind: "rerender" }),
  };
  return { host, calls, pending: () => pendingRows, activity: () => act };
}

describe("F2 TranscriptDock", () => {
  test("F2a 流式完整行提交，半行留在 pending", () => {
    const { host, calls, pending } = makeHost(20);
    const dock = new TranscriptDock(host);
    dock.writeStream("hello");
    expect(pending()).toEqual(["hello"]);
    dock.writeStream(" world\nnext");
    const commit = calls.find((c) => c.kind === "commit");
    expect(commit?.arg).toEqual(["hello world"]);
    expect(pending()).toEqual(["next"]);
    expect(dock.pendingText).toBe("next");
  });

  test("F2b 长行按宽度折行后提交", () => {
    const { host, calls } = makeHost(10);
    const dock = new TranscriptDock(host);
    dock.writeStream("一二三四五六七八九十十一\n");
    const rows = calls.filter((c) => c.kind === "commit").flatMap((c) => c.arg as string[]);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => displayWidth(r) <= 10)).toBe(true);
  });

  test("F2c line() 先把 pending 落定再写目标行", () => {
    const { host, calls } = makeHost(20);
    const dock = new TranscriptDock(host);
    dock.writeStream("streaming");
    dock.line("committed");
    const commits = calls.filter((c) => c.kind === "commit").map((c) => c.arg);
    expect(commits).toEqual([["streaming"], ["committed"]]);
    expect(dock.pendingText).toBe("");
  });

  test("F2d blank() 提交空行", () => {
    const { host, calls } = makeHost(20);
    const dock = new TranscriptDock(host);
    dock.blank();
    expect(calls.filter((c) => c.kind === "commit").map((c) => c.arg)).toEqual([[""]]);
  });

  test("F2e 工具行是 persist transient：普通输出前提交", () => {
    const { host, calls, activity } = makeHost(20);
    const dock = new TranscriptDock(host);
    dock.tool("⚡ read_file a.txt ✓");
    expect(activity()).toEqual({ text: "⚡ read_file a.txt ✓", persist: true });
    dock.line("after");
    expect(calls.some((c) => c.kind === "commitActivity")).toBe(true);
    expect(calls.filter((c) => c.kind === "commit").map((c) => c.arg)).toEqual([["after"]]);
  });

  test("F2f spinner 是 non-persist transient：收尾即丢弃", () => {
    const { host, calls } = makeHost(20);
    const dock = new TranscriptDock(host);
    dock.spinner("⠋ thinking");
    dock.finishActivity();
    expect(calls.some((c) => c.kind === "clearActivity")).toBe(true);
    expect(calls.some((c) => c.kind === "commitActivity")).toBe(false);
  });

  test("F2g 工具失败：活动行落历史 + 详情行", () => {
    const { host, calls } = makeHost(40);
    const dock = new TranscriptDock(host);
    dock.tool("⚡ shell false ✗");
    dock.failTool(["  │ error: nope", "  （完整输出：/last）"]);
    expect(calls.some((c) => c.kind === "commitActivity")).toBe(true);
    const commits = calls.filter((c) => c.kind === "commit").map((c) => c.arg);
    // failTool 批量提交：一次 commitAbove 带两行
    expect(commits).toEqual([["  │ error: nope", "  （完整输出：/last）"]]);
  });

  test("F2i 无换行长行按 240 字符软断，pending 不会无限增长", () => {
    const { host, calls, pending } = makeHost(40);
    const dock = new TranscriptDock(host);
    dock.writeStream("x".repeat(1000));
    expect(dock.pendingText.length).toBeLessThanOrEqual(240);
    expect(calls.filter((c) => c.kind === "commit").length).toBeGreaterThan(0);
    expect(pending().length).toBeGreaterThan(0);
  });

  test("F2i2 软断后 pending 保留颜色上下文（否则超过 240 字符就掉色）", () => {
    const { host } = makeHost(40);
    const dock = new TranscriptDock(host);
    // 300 个红色字符：必然触发 trimPending 软断
    dock.writeStream("\x1b[31m" + "x".repeat(300));
    // 剩余 pending 必须继续是红色 —— 切点前的 active SGR 要补回到剩余部分开头
    expect(dock.pendingText.startsWith("\x1b[31m")).toBe(true);
    // 追加的文本也延续同一颜色上下文
    dock.writeStream("MORE");
    expect(dock.pendingText.endsWith("MORE")).toBe(true);
    expect(dock.pendingText.startsWith("\x1b[31m")).toBe(true);
  });

  test("F2i3 软断点落在 reset 之后：pending 不该被染色", () => {
    const { host } = makeHost(40);
    const dock = new TranscriptDock(host);
    // 红色段 300 字符后 reset，再跟 100 个无色字符；软断切在红色段内，
    // 剩余部分应从红色继续，直到遇到原串里的 \x1b[0m 才恢复无色。
    dock.writeStream("\x1b[31m" + "x".repeat(300) + "\x1b[0m" + "y".repeat(100));
    const p = dock.pendingText;
    expect(p.startsWith("\x1b[31m")).toBe(true);
    expect(p).toContain("\x1b[0m");
    // reset 之后的部分不带颜色前缀
    const afterReset = p.slice(p.indexOf("\x1b[0m") + 4);
    expect(afterReset).toBe("y".repeat(100));
  });

  test("F2j commitLines 批量提交（一次 commitAbove）", () => {
    const { host, calls } = makeHost(20);
    const dock = new TranscriptDock(host);
    dock.commitLines(["a", "", "b"]);
    const commits = calls.filter((c) => c.kind === "commit");
    expect(commits.length).toBe(1);
    expect((commits[0]?.arg as string[]).length).toBe(3);
  });

  test("F2h resize 后 pending 按新宽度重排（宽度可变的宿主）", () => {
    let width = 20;
    const calls: Call[] = [];
    let pendingRows: string[] = [];
    const host: DockHost = {
      width: () => width,
      commitAbove: (rows) => calls.push({ kind: "commit", arg: rows }),
      setPending: (rows) => { calls.push({ kind: "pending", arg: rows }); pendingRows = rows; },
      setActivity: () => {},
      commitActivity: () => {},
      clearActivity: () => {},
      notice: () => {},
      rerender: () => calls.push({ kind: "rerender" }),
    };
    const dock = new TranscriptDock(host);
    dock.writeStream("一二三四五六七八九十");
    expect(pendingRows.length).toBe(1); // 20 列放得下 10 个 CJK
    width = 8;
    dock.resize();
    expect(calls.some((c) => c.kind === "rerender")).toBe(true);
    expect(pendingRows.length).toBeGreaterThan(1);
    expect(pendingRows.every((r) => displayWidth(r) <= 8)).toBe(true);
  });
});
