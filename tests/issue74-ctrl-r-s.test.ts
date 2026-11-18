/**
 * issue #74：输入框 Ctrl+R 历史反向检索与 Ctrl+S 草稿暂存（不含 Vim / #79）。
 *
 * 真 TTY 流控不在本文件覆盖；这里用假 stdin/stdout 直接驱动 handleKey()/compose()，
 * 锁住检索、取消、无匹配、多次 Ctrl+R、暂存/恢复（光标、粘贴 chip、shell 模式）以及
 * 对现有 ↑ 历史与 #76 空闲 tickTimer 的回归。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { Composer, type ComposerDeps, type ComposerStatus } from "../src/tui/composer.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { mapKey } from "../src/tui/keys.ts";

interface Harness {
  composer: Composer;
  submitted: Array<{ text: string; attachments: unknown[] }>;
  shellCommands: string[];
}

function makeHarness(overrides: Partial<ComposerDeps> = {}): Harness {
  const submitted: Array<{ text: string; attachments: unknown[] }> = [];
  const shellCommands: string[] = [];
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  (stdin as unknown as { isRaw: boolean }).isRaw = false;
  const status: ComposerStatus = {
    version: "0.4.90",
    model: "deepseek-flash",
    tier: "balanced",
    mode: "ask",
    branch: "main",
    ctxUsage: 0.2,
    elapsedMs: 1000,
    active: false,
    tokensTotal: 100,
  };
  const deps: ComposerDeps = {
    stdin,
    stdout: { write: () => {}, columns: 100, rows: 24 },
    columns: () => 100,
    rows: () => 24,
    getStatus: () => status,
    getTitle: () => "neo · test",
    commands: COMMANDS,
    files: () => ["a.txt"],
    onSubmit: (text, attachments) => submitted.push({ text, attachments }),
    onShellCommand: (cmd) => shellCommands.push(cmd),
    onCancelTurn: () => {},
    onExit: () => {},
    pasteText: (text) => ({
      chip: `[Pasted text #1 ${text.length} chars]`,
      attachment: { kind: "text", text },
    }),
    now: () => 1_000_000,
    ...overrides,
  };
  const composer = new Composer(deps);
  composer.start();
  return { composer, submitted, shellCommands };
}

function special(
  h: Harness,
  key: { name?: string; ch?: string; ctrl?: boolean; sequence?: string },
): void {
  h.composer.handleKey(key.ch, key);
}

function typeText(h: Harness, text: string): void {
  for (const ch of text) h.composer.handleKey(ch, { ch, name: ch });
}

function enter(h: Harness): void {
  special(h, { name: "return", sequence: "\r" });
}

function esc(h: Harness): void {
  special(h, { name: "escape" });
}

function ctrlR(h: Harness): void {
  special(h, { name: "r", ctrl: true, sequence: "\x12" });
}

function ctrlS(h: Harness): void {
  special(h, { name: "s", ctrl: true, sequence: "\x13" });
}

function frame(h: Harness): string {
  return h.composer.compose().rows.join("\n");
}

function inputLine(h: Harness): string {
  return h.composer.compose().rows.find((r) => r.startsWith("❯ ") || r.startsWith("! ")) ?? "";
}

function submitLine(h: Harness, text: string): void {
  typeText(h, text);
  enter(h);
}

function seedHistory(h: Harness): void {
  submitLine(h, "alpha");
  submitLine(h, "beta one");
  submitLine(h, "gamma");
  submitLine(h, "beta two");
}

describe("issue #74 键位映射", () => {
  test("#74 mapKey：Ctrl+R → ctrl-r，Ctrl+S → ctrl-s，不插入控制字符", () => {
    expect(mapKey({ name: "r", ctrl: true, sequence: "\x12" })).toEqual({ type: "ctrl-r" });
    expect(mapKey({ name: "s", ctrl: true, sequence: "\x13" })).toEqual({ type: "ctrl-s" });
  });
});

describe("issue #74 Ctrl+R 历史反向检索", () => {
  test("#74a Ctrl+R 打开反向检索；输入查询时按子串匹配最新历史", () => {
    const h = makeHarness();
    seedHistory(h);
    expect(h.composer.tickTimer).toBeNull();
    ctrlR(h);
    expect(frame(h)).toContain("反向检索");
    expect(h.submitted).toEqual([
      { text: "alpha", attachments: [] },
      { text: "beta one", attachments: [] },
      { text: "gamma", attachments: [] },
      { text: "beta two", attachments: [] },
    ]);
    // 打开检索不得启动 #76 的空闲 tick。
    expect(h.composer.tickTimer).toBeNull();
    typeText(h, "beta");
    expect(h.composer.text).toBe("beta two");
    expect(frame(h)).toContain("反向检索");
    expect(frame(h)).toContain("beta");
    h.composer.stop();
  });

  test("#74b 多次 Ctrl+R 在同一查询下向更早的匹配跳；到头停留在最旧匹配", () => {
    const h = makeHarness();
    seedHistory(h);
    ctrlR(h);
    typeText(h, "beta");
    expect(h.composer.text).toBe("beta two");
    ctrlR(h);
    expect(h.composer.text).toBe("beta one");
    ctrlR(h);
    expect(h.composer.text).toBe("beta one");
    h.composer.stop();
  });

  test("#74c Enter 把当前匹配填回输入框并退出检索，不提交", () => {
    const h = makeHarness();
    seedHistory(h);
    const before = h.submitted.length;
    ctrlR(h);
    typeText(h, "beta");
    ctrlR(h); // 选中更早的 "beta one"
    enter(h);
    expect(h.composer.text).toBe("beta one");
    expect(h.submitted.length).toBe(before);
    expect(frame(h)).not.toContain("反向检索");
    // 退出后按键回到普通编辑：追加进正文，而不是改查询。
    typeText(h, "!");
    expect(h.composer.text).toBe("beta one!");
    expect(h.submitted.length).toBe(before);
    h.composer.stop();
  });

  test("#74d Esc 取消检索、恢复打开前的草稿，不提交、不清空", () => {
    const h = makeHarness();
    seedHistory(h);
    const before = h.submitted.length;
    typeText(h, "draft text");
    ctrlR(h);
    typeText(h, "beta");
    expect(h.composer.text).toBe("beta two");
    esc(h);
    expect(h.composer.text).toBe("draft text");
    expect(h.submitted.length).toBe(before);
    expect(frame(h)).not.toContain("反向检索");
    h.composer.stop();
  });

  test("#74e 无匹配时给出提示；Enter 退出检索且不提交，草稿保留", () => {
    const h = makeHarness();
    seedHistory(h);
    const before = h.submitted.length;
    typeText(h, "keep me");
    ctrlR(h);
    typeText(h, "zzz-no-such");
    expect(frame(h)).toContain("无匹配");
    expect(h.submitted.length).toBe(before);
    enter(h);
    expect(h.composer.text).toBe("keep me");
    expect(h.submitted.length).toBe(before);
    expect(frame(h)).not.toContain("反向检索");
    h.composer.stop();
  });

  test("#74f 空查询时反复 Ctrl+R 按时间从新到旧遍历全部历史", () => {
    const h = makeHarness();
    seedHistory(h);
    ctrlR(h);
    expect(h.composer.text).toBe("beta two");
    ctrlR(h);
    expect(h.composer.text).toBe("gamma");
    ctrlR(h);
    expect(h.composer.text).toBe("beta one");
    ctrlR(h);
    expect(h.composer.text).toBe("alpha");
    ctrlR(h);
    expect(h.composer.text).toBe("alpha");
    h.composer.stop();
  });

  test("#74g 检索查询退格后重新匹配；空历史打开检索不抛、无匹配", () => {
    const h = makeHarness();
    seedHistory(h);
    ctrlR(h);
    typeText(h, "betaz");
    expect(frame(h)).toContain("无匹配");
    special(h, { name: "backspace" });
    expect(h.composer.text).toBe("beta two");
    expect(frame(h)).not.toContain("无匹配");
    h.composer.stop();

    const empty = makeHarness();
    ctrlR(empty);
    expect(frame(empty)).toContain("反向检索");
    expect(frame(empty)).toContain("无匹配");
    esc(empty);
    expect(empty.composer.text).toBe("");
    expect(empty.submitted).toEqual([]);
    empty.composer.stop();
  });

  test("#74h 退出检索后现有 ↑ 前缀历史浏览仍可用", () => {
    const h = makeHarness();
    seedHistory(h);
    ctrlR(h);
    typeText(h, "gamma");
    enter(h);
    expect(h.composer.text).toBe("gamma");
    special(h, { name: "escape" }); // 清空已填入的匹配，避免前缀过滤挡住其它条目
    expect(h.composer.text).toBe("");
    special(h, { name: "up" });
    expect(h.composer.text).toBe("beta two");
    special(h, { name: "up" });
    expect(h.composer.text).toBe("gamma");
    special(h, { name: "up" });
    expect(h.composer.text).toBe("beta one");
    h.composer.stop();
  });

  test("#74n 历史有重复条目时，多次 Ctrl+R 仍能走到更早的同一文本，不在首个重复处打转", () => {
    const h = makeHarness();
    submitLine(h, "same");
    submitLine(h, "other");
    submitLine(h, "same");
    ctrlR(h);
    expect(h.composer.text).toBe("same");
    ctrlR(h);
    expect(h.composer.text).toBe("other");
    ctrlR(h);
    expect(h.composer.text).toBe("same");
    ctrlR(h);
    expect(h.composer.text).toBe("same");
    h.composer.stop();
  });

  test("#74o 从 shell 模式打开检索并接受普通历史后，回到普通态且不带走原附件", () => {
    const h = makeHarness();
    submitLine(h, "plain history");
    typeText(h, "!");
    typeText(h, "echo draft");
    h.composer.attachments.push({ kind: "image", name: "nope.png" });
    ctrlR(h);
    typeText(h, "plain");
    enter(h);
    expect(h.composer.text).toBe("plain history");
    expect(h.composer.shellMode).toBe(false);
    expect(inputLine(h).startsWith("❯ ")).toBe(true);
    expect(h.composer.attachments).toEqual([]);
    expect(h.shellCommands).toEqual([]);
    expect(h.submitted).toEqual([{ text: "plain history", attachments: [] }]);
    h.composer.stop();
  });
});

describe("issue #74 Ctrl+S 草稿暂存", () => {
  test("#74i 非空草稿暂存后输入框为空；空框再按 Ctrl+S 恢复文本与光标，不提交", () => {
    const h = makeHarness();
    typeText(h, "hello world");
    special(h, { name: "home" });
    special(h, { name: "right" });
    special(h, { name: "right" });
    special(h, { name: "right" });
    expect(h.composer.buf.cursor).toBe(3);
    const before = h.submitted.length;
    ctrlS(h);
    expect(h.composer.text).toBe("");
    expect(h.composer.buf.cursor).toBe(0);
    expect(inputLine(h).startsWith("❯ ")).toBe(true);
    expect(frame(h)).toContain("输入消息");
    expect(h.submitted.length).toBe(before);
    expect(h.composer.shellMode).toBe(false);
    ctrlS(h);
    expect(h.composer.text).toBe("hello world");
    expect(h.composer.buf.cursor).toBe(3);
    expect(h.submitted.length).toBe(before);
    h.composer.stop();
  });

  test("#74j 单槽暂存：再次暂存覆盖上一份；空槽上 Ctrl+S 是空操作", () => {
    const h = makeHarness();
    ctrlS(h);
    expect(h.composer.text).toBe("");
    expect(h.submitted).toEqual([]);

    typeText(h, "first draft");
    ctrlS(h);
    typeText(h, "second draft");
    ctrlS(h);
    expect(h.composer.text).toBe("");
    ctrlS(h);
    expect(h.composer.text).toBe("second draft");
    expect(h.submitted).toEqual([]);
    h.composer.stop();
  });

  test("#74k 恢复粘贴文本 chip 与图片 chip，附件一起回来", () => {
    const h = makeHarness({ paste: { foldLines: 2, foldChars: 10 } });
    typeText(h, "see ");
    special(h, { name: "paste-start" });
    for (const ch of "0123456789abcdef") h.composer.handleKey(ch, { ch, name: ch });
    special(h, { name: "paste-end" });
    expect(h.composer.text).toContain("[Pasted text #1");
    expect(h.composer.attachments).toEqual([{ kind: "text", text: "0123456789abcdef" }]);

    h.composer.attachments.push({ kind: "image", name: "shot.png" });
    h.composer.buf.insert("[Image #1]");
    typeText(h, " please");
    const savedText = h.composer.text;
    const savedCursor = h.composer.buf.cursor;
    const savedAtt = structuredClone(h.composer.attachments);

    ctrlS(h);
    expect(h.composer.text).toBe("");
    expect(h.composer.attachments).toEqual([]);
    ctrlS(h);
    expect(h.composer.text).toBe(savedText);
    expect(h.composer.buf.cursor).toBe(savedCursor);
    expect(h.composer.attachments).toEqual(savedAtt);
    expect(h.composer.text).toContain("[Pasted text #1");
    expect(h.composer.text).toContain("[Image #1]");
    expect(h.submitted).toEqual([]);
    h.composer.stop();
  });

  test("#74l 暂存 shell 模式命令；恢复后仍是 shell 模式（含光标）", () => {
    const h = makeHarness();
    typeText(h, "!echo hi");
    expect(h.composer.shellMode).toBe(true);
    expect(inputLine(h).startsWith("! ")).toBe(true);
    expect(h.composer.text).toBe("echo hi");
    special(h, { name: "left" });
    special(h, { name: "left" });
    const cursor = h.composer.buf.cursor;
    expect(cursor).toBe("echo hi".length - 2);

    ctrlS(h);
    expect(h.composer.text).toBe("");
    expect(h.composer.shellMode).toBe(false);
    expect(inputLine(h).startsWith("❯ ")).toBe(true);
    expect(h.shellCommands).toEqual([]);

    ctrlS(h);
    expect(h.composer.shellMode).toBe(true);
    expect(h.composer.text).toBe("echo hi");
    expect(h.composer.buf.cursor).toBe(cursor);
    expect(inputLine(h).startsWith("! ")).toBe(true);
    // 「shell 命令」只是空框占位（见 composer composeInput + tests/shell-input-mode.test.ts），
    // 恢复后正文非空，不能再用占位符判断模式。
    expect(h.shellCommands).toEqual([]);
    expect(h.submitted).toEqual([]);

    // 恢复后仍按 shell 模式提交。
    enter(h);
    expect(h.shellCommands).toEqual(["echo hi"]);
    expect(h.submitted).toEqual([]);
    expect(h.composer.shellMode).toBe(false);
    h.composer.stop();
  });

  test("#74m 暂存/恢复后 ↑ 历史与空闲 tickTimer 不被破坏", () => {
    const h = makeHarness();
    seedHistory(h);
    typeText(h, "temp");
    ctrlS(h);
    expect(h.composer.text).toBe("");
    expect(h.composer.tickTimer).toBeNull();
    ctrlS(h);
    expect(h.composer.text).toBe("temp");
    special(h, { name: "escape" });
    expect(h.composer.text).toBe("");
    special(h, { name: "up" });
    expect(h.composer.text).toBe("beta two");
    special(h, { name: "up" });
    expect(h.composer.text).toBe("gamma");
    expect(h.composer.tickTimer).toBeNull();
    h.composer.stop();
  });
});
