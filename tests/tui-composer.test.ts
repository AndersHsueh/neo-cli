/**
 * tui/composer.ts 单测（v0.3.0 C1/C2/C4/B4 的纯逻辑面）。
 *
 * 真 TTY 行为由 scripts/pty-e2e.ts 的 S11~S14 断言；这里用假 stdin/stdout
 * 直接驱动 handleKey() 与 compose()，锁住「输入/多行/历史/补全/审批/选择/双 Ctrl+C」。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Composer, type ComposerDeps, type ComposerStatus } from "../src/tui/composer.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { TitleAnimator } from "../src/tui/title.ts";
import { displayWidth } from "../src/ui/theme.ts";

interface Harness {
  composer: Composer;
  out: () => string;
  submitted: Array<{ text: string; attachments: unknown[] }>;
  exits: number;
  cancels: number;
  setNow: (t: number) => void;
}

function makeHarness(overrides: Partial<ComposerDeps> = {}): Harness {
  const chunks: string[] = [];
  let now = 1_000_000;
  let submitted: Array<{ text: string; attachments: unknown[] }> = [];
  let exits = 0;
  let cancels = 0;
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & {
    setRawMode: (v: boolean) => void;
    isRaw: boolean;
    isTTY: boolean;
  };
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  (stdin as unknown as { isRaw: boolean }).isRaw = false;
  const status: ComposerStatus = {
    model: "deepseek-flash",
    tier: "balanced",
    mode: "ask",
    branch: "main",
    ctxUsage: 0.42,
    elapsedMs: 42_000,
    active: true,
    tokensTotal: 12_300,
  };
  const deps: ComposerDeps = {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: { write: (s: string) => chunks.push(s), columns: 100, rows: 24 },
    columns: () => 100,
    rows: () => 24,
    getStatus: () => status,
    getTitle: () => "neo · test",
    commands: COMMANDS,
    files: () => ["a.txt", "src/console.ts"],
    onSubmit: (text, attachments) => submitted.push({ text, attachments }),
    onExit: () => { exits += 1; },
    onCancelTurn: () => { cancels += 1; },
    pasteText: (text) => ({ chip: `[Pasted text #1 ${text.length} chars]`, attachment: { kind: "text", text } }),
    now: () => now,
    ...overrides,
  };
  const composer = new Composer(deps);
  composer.start();
  return {
    composer,
    out: () => chunks.join(""),
    submitted,
    get exits() { return exits; },
    get cancels() { return cancels; },
    setNow: (t: number) => { now = t; },
  } as Harness;
}

function special(h: Harness, key: { name?: string; ch?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }): void {
  h.composer.handleKey(key.ch, key);
}

function typeText(h: Harness, text: string): void {
  for (const ch of text) h.composer.handleKey(ch, { ch, name: ch });
}

describe("C1 输入框渲染", () => {
  test("C1a 初始帧：上下横线 + 提示符 + 状态行 + 顶线标题", () => {
    const h = makeHarness();
    const f = h.composer.compose();
    const all = f.rows.join("\n");
    expect(all).toContain("neo · test");
    expect(all).toContain("❯");
    expect(all).toContain("deepseek-flash");
    expect(all).toContain("main");
    expect(all).toContain("42%");
    expect(f.rows.filter((r) => r.includes("─")).length).toBeGreaterThanOrEqual(2);
    h.composer.stop();
  });

  test("C1b 输入文字与光标反显；中文按显示列", () => {
    try {
      const h = makeHarness();
      typeText(h, "你好 abc");
      const f = h.composer.compose();
      const input = f.rows.find((r) => r.includes("❯")) ?? "";
      expect(input).toContain("你好 abc");
      // 光标在行尾：反显空格（无色环境下表现为行尾多一个空格）
      expect(input.endsWith(" ")).toBe(true);
      // 光标列 = 前缀 2 + 显示列（你好=4、空格=1、abc=3）
      expect(f.cursorCol).toBe(2 + 8);
      h.composer.stop();
    } finally {
      // noop
    }
  });

  test("C1c 空输入显示 placeholder", () => {
    const h = makeHarness();
    const f = h.composer.compose();
    expect(f.rows.join("\n")).toContain("输入消息");
    h.composer.stop();
  });

  test("C1d Ctrl+J 换行：输入行变两行，不提交", () => {
    const h = makeHarness();
    typeText(h, "first");
    special(h, { name: "enter", sequence: "\n" });
    typeText(h, "second");
    expect(h.submitted.length).toBe(0);
    const f = h.composer.compose();
    const text = f.rows.join("\n");
    expect(text).toContain("first");
    expect(text).toContain("second");
    h.composer.stop();
  });

  test("C1e Enter 提交：onSubmit 收到全文，buffer 清空", () => {
    const h = makeHarness();
    typeText(h, "hello world");
    special(h, { name: "return", sequence: "\r" });
    expect(h.submitted).toEqual([{ text: "hello world", attachments: [] }]);
    expect(h.composer.text).toBe("");
    h.composer.stop();
  });

  test("C1f 行尾反斜杠 + Enter 变成续行而不是提交", () => {
    const h = makeHarness();
    typeText(h, "abc\\");
    special(h, { name: "return", sequence: "\r" });
    expect(h.submitted.length).toBe(0);
    expect(h.composer.text).toBe("abc\n");
    h.composer.stop();
  });
});

describe("C2 编辑 / 历史", () => {
  test("C2a 退格一次删一个汉字", () => {
    const h = makeHarness();
    typeText(h, "你好");
    special(h, { name: "backspace" });
    expect(h.composer.text).toBe("你");
    h.composer.stop();
  });

  test("C2b ↑ 取历史、↓ 回到草稿", () => {
    const h = makeHarness();
    typeText(h, "one");
    special(h, { name: "return", sequence: "\r" });
    typeText(h, "two");
    special(h, { name: "return", sequence: "\r" });
    special(h, { name: "up" });
    expect(h.composer.text).toBe("two");
    special(h, { name: "up" });
    expect(h.composer.text).toBe("one");
    special(h, { name: "down" });
    expect(h.composer.text).toBe("two");
    h.composer.stop();
  });

  test("C2c home/end/delete 在行内生效", () => {
    const h = makeHarness();
    typeText(h, "abc");
    special(h, { name: "home" });
    typeText(h, "X");
    expect(h.composer.text).toBe("Xabc");
    special(h, { name: "end" });
    special(h, { name: "delete" });
    expect(h.composer.text).toBe("Xabc");
    h.composer.stop();
  });
});

describe("C4 补全 / 粘贴 / 审批 / 选择", () => {
  test("C4a @ 文件 Tab 补全插入候选并给出提示", () => {
    const h = makeHarness();
    typeText(h, "@a");
    special(h, { name: "tab" });
    expect(h.composer.text).toBe("@a.txt");
    h.composer.stop();
  });

  test("C4b 多候选连按 Tab 在同一批里循环", () => {
    const h = makeHarness();
    typeText(h, "@");
    special(h, { name: "tab" });
    const first = h.composer.text;
    special(h, { name: "tab" });
    const second = h.composer.text;
    expect(second).not.toBe(first);
    special(h, { name: "tab" });
    expect(h.composer.text).toBe(first);
    h.composer.stop();
  });

  test("C4c 粘贴小文本直接进多行 buffer，大文本折叠为 chip", () => {
    const h = makeHarness();
    special(h, { name: "paste-start" });
    h.composer.handleKey("a", { ch: "a", name: "a" });
    h.composer.handleKey("\n", { ch: "\n", name: "enter", sequence: "\n" });
    h.composer.handleKey("b", { ch: "b", name: "b" });
    special(h, { name: "paste-end" });
    expect(h.composer.text).toBe("a\nb");
    h.composer.stop();

    const h2 = makeHarness({ paste: { foldLines: 2, foldChars: 10 } });
    special(h2, { name: "paste-start" });
    for (const ch of "0123456789abcdef") h2.composer.handleKey(ch, { ch, name: ch });
    special(h2, { name: "paste-end" });
    expect(h2.composer.text).toContain("[Pasted text #1");
    h2.composer.stop();
  });

  test("C4d 审批模态：问题显示、Enter 返回 y、Esc 返回空串", async () => {
    const h = makeHarness();
    const p = h.composer.ask("允许 write_file？");
    expect(h.composer.compose().rows.join("\n")).toContain("允许 write_file");
    typeText(h, "y");
    special(h, { name: "return", sequence: "\r" });
    expect(await p).toBe("y");

    const p2 = h.composer.ask("再问一次？");
    special(h, { name: "escape" });
    expect(await p2).toBe("");
    h.composer.stop();
  });

  test("C4e 选择菜单：↓ + Enter 返回第二项，Esc 返回 null", async () => {
    const h = makeHarness();
    const p = h.composer.choose("选一个", [
      { label: "first", value: 1 },
      { label: "second", value: 2 },
    ]);
    expect(h.composer.compose().rows.join("\n")).toContain("选一个");
    special(h, { name: "down" });
    special(h, { name: "return", sequence: "\r" });
    expect(await p).toBe(2);

    const p2 = h.composer.choose("再选", [{ label: "x", value: "x" }]);
    special(h, { name: "escape" });
    expect(await p2).toBe(null);
    h.composer.stop();
  });

  test("C4e2 选择菜单 initial 定位当前项（Enter 不回到第一项）", async () => {
    const h = makeHarness();
    const p = h.composer.choose(
      "选一个",
      [
        { label: "first", value: 1 },
        { label: "second", value: 2 },
        { label: "third", value: 3 },
      ],
      2,
    );
    special(h, { name: "return", sequence: "\r" });
    expect(await p).toBe(3);
    h.composer.stop();
  });

  test("C4f 忙碌时 Ctrl+C 取消本轮；双 Ctrl+C 退出", () => {
    const h = makeHarness();
    h.composer.setBusy(true);
    h.setNow(1_000_000);
    special(h, { name: "c", ctrl: true });
    expect(h.cancels).toBe(1);
    expect(h.exits).toBe(0);
    h.setNow(1_001_000);
    special(h, { name: "c", ctrl: true });
    expect(h.exits).toBe(1);
    h.composer.stop();
  });

  test("C4g 粘贴态下 Ctrl+C 退出粘贴而不是被吞掉", () => {
    const h = makeHarness();
    special(h, { name: "paste-start" });
    h.composer.handleKey("x", { ch: "x", name: "x" });
    special(h, { name: "c", ctrl: true });
    expect(h.composer.text).toBe("");
    h.composer.stop();
  });
});

describe("C4h 粘贴丢包兜底（v0.3.0）", () => {
  test("C4h 只收到 paste-start、没有 paste-end：idle 超时后自动收尾，按键不被吞", async () => {
    const h = makeHarness({ pasteIdleMs: 30 });
    special(h, { name: "paste-start" });
    h.composer.handleKey("粘", { ch: "粘", name: undefined });
    await new Promise((r) => setTimeout(r, 80));
    expect(h.composer.text).toBe("粘");
    // 之后的普通按键必须恢复正常插入（而不是继续被当作粘贴吞掉）
    typeText(h, "x");
    expect(h.composer.text).toBe("粘x");
    h.composer.stop();
  });
});

describe("C4i 模态粘贴 / 审批 Ctrl+C / suspend（v0.3.0 质量审查补充）", () => {
  test("C4i 审批态粘贴不会用 y 代答：整段进 ask buffer，主缓冲不残留", async () => {
    const h = makeHarness();
    const p = h.composer.ask("允许执行？");
    special(h, { name: "paste-start" });
    for (const key of [
      { ch: "y", name: "y" },
      { ch: "\r", name: "return", sequence: "\r" },
      { ch: "l", name: "l" },
      { ch: "s", name: "s" },
      { ch: "\r", name: "return", sequence: "\r" },
    ]) {
      h.composer.handleKey(key.ch, key);
    }
    special(h, { name: "paste-end" });
    // 粘贴内容整体进审批 buffer；Enter 才提交 → 答案不是单个 "y"
    special(h, { name: "return", sequence: "\r" });
    const answer = await p;
    expect(answer).toContain("ls");
    expect(answer.trim()).not.toBe("y");
    expect(h.composer.text).toBe("");
    h.composer.stop();
  });

  test("C4j 审批态 Ctrl+C = 拒绝 + 取消本轮；再按一次退出", async () => {
    const h = makeHarness();
    h.composer.setBusy(true);
    const p = h.composer.ask("允许？");
    special(h, { name: "c", ctrl: true });
    expect(await p).toBe("");
    expect(h.cancels).toBe(1);
    h.setNow(1_000_500);
    special(h, { name: "c", ctrl: true });
    expect(h.exits).toBe(1);
    h.composer.stop();
  });

  test("C4k Esc 清空后 ↓ 不会复活草稿", () => {
    const h = makeHarness();
    typeText(h, "abc");
    special(h, { name: "up" }); // 无历史：仅记录 draft
    special(h, { name: "escape" });
    expect(h.composer.text).toBe("");
    special(h, { name: "down" });
    expect(h.composer.text).toBe("");
    h.composer.stop();
  });

  test("C4l suspend 后按键被忽略，resume 后恢复", () => {
    const h = makeHarness();
    h.composer.suspend();
    expect(h.composer.isSuspended).toBe(true);
    typeText(h, "abc");
    expect(h.composer.text).toBe("");
    h.composer.resume();
    expect(h.composer.isSuspended).toBe(false);
    typeText(h, "ok");
    expect(h.composer.text).toBe("ok");
    h.composer.stop();
  });
});


describe("C1e Agent 标题视图（v0.3.1）", () => {
  test("C1e TitleView 普通名 + busy 后缀", () => {
    const h = makeHarness({ getTitle: () => ({ prefix: "Agent", text: "Trinity", matrix: false }) });
    expect(h.composer.compose().rows.join("\n")).toContain("Agent: Trinity");
    h.composer.setBusy(true);
    expect(h.composer.compose().rows.join("\n")).toContain("Agent: Trinity · 运行中");
    h.composer.stop();
  });

  test("C1e N E O 用 Matrix 绿（#00FF41）渲染", () => {
    const prevNo = process.env["NO_COLOR"];
    const prevForce = process.env["FORCE_COLOR"];
    delete process.env["NO_COLOR"];
    process.env["FORCE_COLOR"] = "1";
    try {
      const h = makeHarness({ getTitle: () => ({ prefix: "Agent", text: "N E O", matrix: true }) });
      const rows = h.composer.compose().rows.join("\n");
      expect(rows).toContain("Agent:");
      expect(rows).toContain("\x1b[38;2;0;255;65mN E O\x1b[0m");
      h.composer.stop();
    } finally {
      if (prevNo === undefined) delete process.env["NO_COLOR"];
      else process.env["NO_COLOR"] = prevNo;
      if (prevForce === undefined) delete process.env["FORCE_COLOR"];
      else process.env["FORCE_COLOR"] = prevForce;
    }
  });

  test("C1e TitleAnimator 接入 composer；窄终端标题不超宽", () => {
    const h = makeHarness({ columns: () => 30, stdout: { write: () => {}, columns: 30, rows: 24 } });
    const anim = new TitleAnimator({ rng: () => 0.5 });
    anim.setName("Morpheus");
    h.composer.setTitleAnimator(anim);
    const rows = h.composer.compose().rows;
    expect(rows.join("\n")).toContain("Agent: Morpheus");
    for (const r of rows) expect(displayWidth(r)).toBeLessThanOrEqual(30);
    h.composer.stop();
  });
});
