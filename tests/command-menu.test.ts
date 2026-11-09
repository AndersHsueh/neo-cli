/**
 * issue #31：`/` 渐进式命令菜单（替换旧的 Tab 循环单行 hint）。
 *
 * 断言：行首 `/` 自动开菜单（左名/右说明）→ 边打边过滤 → 无匹配空态 →
 * ↑↓ 移动高亮（不进历史）→ Tab 接受不执行 → Enter 执行 → Esc 关闭保留文本 →
 * 正常 TUI 里不再出现「N 个命令候选」。
 *
 * 真 TTY 行为另有 scripts/pty-e2e.ts 的 S25；这里用假 stdin/stdout 驱动 compose()/handleKey()。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { Composer, type ComposerDeps, type ComposerStatus } from "../src/tui/composer.ts";
import { COMMANDS } from "../src/input/commands.ts";

interface Harness {
  composer: Composer;
  submitted: string[];
  frame: () => string;
  inputLine: () => string;
}

function makeHarness(): Harness {
  const chunks: string[] = [];
  const submitted: string[] = [];
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
    ctxUsage: 0.1,
    elapsedMs: 1000,
    active: false,
    tokensTotal: 10,
  };
  const deps: ComposerDeps = {
    stdin,
    stdout: { write: (s: string) => chunks.push(s), columns: 100, rows: 24 },
    columns: () => 100,
    rows: () => 24,
    getStatus: () => status,
    getTitle: () => "neo",
    commands: COMMANDS,
    files: () => [],
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    now: () => 1_000_000,
  };
  const composer = new Composer(deps);
  composer.start();
  const frame = (): string => composer.compose().rows.join("\n");
  return {
    composer,
    submitted,
    frame,
    inputLine: () => composer.compose().rows.find((r) => r.startsWith("❯ ")) ?? "",
  };
}

function typeText(h: Harness, text: string): void {
  for (const ch of text) h.composer.handleKey(ch, { ch, name: ch });
}

function special(h: Harness, key: { name?: string; sequence?: string }): void {
  h.composer.handleKey(undefined, key);
}

describe("issue #31 `/` 命令菜单", () => {
  test("行首 `/` 自动开菜单：左命令名 + 右说明，最多 8 行并提示剩余", () => {
    const h = makeHarness();
    typeText(h, "/");
    const f = h.frame();
    expect(f).toContain("/help");
    expect(f).toContain("帮助");
    expect(f).toContain("还有");
    // 行数受控：菜单不会把整个屏幕铺满
    expect(h.composer.compose().rows.length).toBeLessThanOrEqual(24);
    h.composer.stop();
  });

  test("边打边过滤：/ti → 只剩 tier 相关；/zzz → 显式空态", () => {
    const h = makeHarness();
    typeText(h, "/ti");
    expect(h.frame()).toContain("/tier");
    expect(h.frame()).not.toContain("/help");

    typeText(h, "zzz");
    expect(h.frame()).toContain("无匹配");
    h.composer.stop();
  });

  test("↑↓ 移动高亮，不进历史", () => {
    const h = makeHarness();
    typeText(h, "/");
    expect(h.frame()).toContain("❯ /help");
    special(h, { name: "down" });
    expect(h.frame()).toContain("❯ /?");
    special(h, { name: "up" });
    expect(h.frame()).toContain("❯ /help");
    // 缓冲区仍是 "/"，没有被历史改掉
    expect(h.inputLine()).toContain("/");
    h.composer.stop();
  });

  test("Tab 接受高亮项写入缓冲区，不执行", () => {
    const h = makeHarness();
    typeText(h, "/ti");
    special(h, { name: "tab" });
    expect(h.submitted).toEqual([]);
    expect(h.inputLine()).toContain("/tier");
    expect(h.frame()).not.toContain("无匹配");
    h.composer.stop();
  });

  test("Enter 执行高亮项", () => {
    const h = makeHarness();
    typeText(h, "/todos");
    special(h, { name: "return", sequence: "\r" });
    expect(h.submitted).toEqual(["/todos"]);
    h.composer.stop();
  });

  test("Esc 关闭菜单并保留已输入文本", () => {
    const h = makeHarness();
    typeText(h, "/ti");
    expect(h.frame()).toContain("/tier");
    special(h, { name: "escape" });
    expect(h.frame()).not.toContain("/tier");
    expect(h.inputLine()).toContain("/ti");
    h.composer.stop();
  });

  test("正常 TUI 不再出现「N 个命令候选」旧 hint（Tab 走菜单）", () => {
    const h = makeHarness();
    typeText(h, "/");
    special(h, { name: "tab" });
    expect(h.frame()).not.toContain("个命令候选");
    expect(h.inputLine()).toContain("/help");
    h.composer.stop();
  });

  test("命令后带空格（进入参数）→ 菜单关闭", () => {
    const h = makeHarness();
    typeText(h, "/tier ");
    expect(h.frame()).not.toContain("/help");
    h.composer.stop();
  });
});
