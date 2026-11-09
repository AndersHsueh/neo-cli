/**
 * issue #30：输入框 `!` shell 模式（composer 状态机单测）。
 *
 * 真 TTY 行为另有 scripts/pty-e2e.ts 的 S23 断言；这里用假 stdin/stdout 直接驱动
 * handleKey()/compose()，锁住「进入/呈现/提交/退出/兼容」五条语义。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { Composer, type ComposerDeps, type ComposerStatus } from "../src/tui/composer.ts";
import { COMMANDS } from "../src/input/commands.ts";

interface Harness {
  composer: Composer;
  submitted: Array<{ text: string; attachments: unknown[] }>;
  shellCommands: string[];
  frame: () => string;
}

function makeHarness(overrides: Partial<ComposerDeps> = {}): Harness {
  const chunks: string[] = [];
  const submitted: Array<{ text: string; attachments: unknown[] }> = [];
  const shellCommands: string[] = [];
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  (stdin as unknown as { isRaw: boolean }).isRaw = false;
  const status: ComposerStatus = {
    version: "0.4.80",
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
    stdout: { write: (s: string) => chunks.push(s), columns: 100, rows: 24 },
    columns: () => 100,
    rows: () => 24,
    getStatus: () => status,
    getTitle: () => "neo · test",
    commands: COMMANDS,
    files: () => ["a.txt"],
    onSubmit: (text, attachments) => submitted.push({ text, attachments }),
    onShellCommand: (cmd) => shellCommands.push(cmd),
    onExit: () => {},
    onCancelTurn: () => {},
    now: () => 1_000_000,
    ...overrides,
  };
  const composer = new Composer(deps);
  composer.start();
  return { composer, submitted, shellCommands, frame: () => composer.compose().rows.join("\n") };
}

function special(h: Harness, key: { name?: string; ch?: string; sequence?: string }): void {
  h.composer.handleKey(key.ch, key);
}

function typeText(h: Harness, text: string): void {
  for (const ch of text) h.composer.handleKey(ch, { ch, name: ch });
}

/** 输入框那一行（首行以 `❯ ` 或 `! ` 开头）。 */
function inputLine(h: Harness): string {
  return h.composer.compose().rows.find((r) => r.startsWith("❯ ") || r.startsWith("! ")) ?? "";
}

describe("issue #30 `!` shell 输入模式", () => {
  test("空缓冲键入 ! → 进入 shell 模式：前缀 ! + shell 占位，! 不进正文", () => {
    const h = makeHarness();
    typeText(h, "!");
    const line = inputLine(h);
    expect(line.startsWith("! ")).toBe(true);
    expect(line).not.toContain("❯");
    expect(h.frame()).toContain("shell 命令");
    // ! 是模式开关：正文仍为空（占位符在，说明 buffer 空）
    typeText(h, "echo hi");
    expect(inputLine(h)).toContain("echo hi");
    h.composer.stop();
  });

  test("shell 模式回车 → onShellCommand 收到原文（无 !），提交后回普通态", () => {
    const h = makeHarness();
    typeText(h, "!echo hi");
    special(h, { name: "return", sequence: "\r" });
    expect(h.shellCommands).toEqual(["echo hi"]);
    expect(h.submitted).toEqual([]);
    // 回到普通态：前缀还原、正文清空
    expect(inputLine(h).startsWith("❯ ")).toBe(true);
    expect(h.frame()).toContain("输入消息");
    h.composer.stop();
  });

  test("空 shell 模式直接回车 → 不执行，退回普通态", () => {
    const h = makeHarness();
    typeText(h, "!");
    special(h, { name: "return", sequence: "\r" });
    expect(h.shellCommands).toEqual([]);
    expect(h.submitted).toEqual([]);
    expect(inputLine(h).startsWith("❯ ")).toBe(true);
    h.composer.stop();
  });

  test("Backspace 删空退出 shell 模式", () => {
    const h = makeHarness();
    typeText(h, "!a");
    special(h, { name: "backspace" }); // 删掉 a，回到空 buffer（仍在 shell 模式）
    expect(inputLine(h).startsWith("! ")).toBe(true);
    special(h, { name: "backspace" }); // 空 buffer 再删 → 退出
    expect(inputLine(h).startsWith("❯ ")).toBe(true);
    h.composer.stop();
  });

  test("非空普通输入中键入 ! → 按字面插入，不切模式", () => {
    const h = makeHarness();
    typeText(h, "ab");
    typeText(h, "!");
    expect(inputLine(h).startsWith("❯ ")).toBe(true);
    expect(inputLine(h)).toContain("ab!");
    h.composer.stop();
  });

  test("Esc（非忙）退出 shell 模式并清空缓冲，不执行", () => {
    const h = makeHarness();
    typeText(h, "!ls -la");
    special(h, { name: "escape" });
    expect(h.shellCommands).toEqual([]);
    expect(inputLine(h).startsWith("❯ ")).toBe(true);
    expect(h.frame()).not.toContain("ls -la");
    h.composer.stop();
  });

  test("shell 模式下 Tab 不触发命令补全（无「个命令候选」hint）", () => {
    const h = makeHarness();
    typeText(h, "!");
    typeText(h, "ti");
    special(h, { name: "tab" });
    expect(h.frame()).not.toContain("个命令候选");
    expect(inputLine(h)).toContain("ti");
    h.composer.stop();
  });

  test("兼容：非 shell 模式提交 `!cmd` 仍走 onSubmit（旧语法不变）", () => {
    const h = makeHarness();
    // 先输入普通文本，再在行首不用模式：! 只在空 buffer 触发模式，所以模拟旧语法要绕过模式
    // —— 用 onShellCommand 未提供时的兜底路径覆盖：这里直接构造无 onShellCommand 的 harness。
    const legacy = makeHarness({ onShellCommand: undefined });
    typeText(legacy, "!");
    typeText(legacy, "echo x");
    special(legacy, { name: "return", sequence: "\r" });
    expect(legacy.submitted).toEqual([{ text: "!echo x", attachments: [] }]);
    expect(legacy.shellCommands).toEqual([]);
    legacy.composer.stop();
    h.composer.stop();
  });
});
