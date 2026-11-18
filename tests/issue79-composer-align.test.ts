/**
 * issue #79：输入框对齐 Claude Code（外观与编辑能力，不含 Vim）。
 *
 * 覆盖本轮 P0（日常编辑 1–5、外观与模式提示 6–7）以及干净可测的 P1
 *（排队收回 / Ctrl+X Ctrl+S 立即发送、句中 / 补全、提交剥不可见 Unicode）。
 * 不覆盖 Vim、#74 的 Ctrl+R/Ctrl+S 重做、拼写检查、prompt suggestions。
 *
 * 真 TTY 流控不在本文件覆盖；这里用假 stdin/stdout 直接驱动 handleKey()/compose()。
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { Composer, type ComposerDeps, type ComposerStatus } from "../src/tui/composer.ts";
import { TextBuffer } from "../src/tui/buffer.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { mapKey } from "../src/tui/keys.ts";
import { triggerAt } from "../src/input/completion.ts";
import { stripAnsi } from "../src/tui/ansi.ts";
import { palette } from "../src/ui/theme.ts";

interface QueueItem {
  text: string;
  attachments: unknown[];
}

interface Harness {
  composer: Composer;
  submitted: Array<{ text: string; attachments: unknown[] }>;
  shellCommands: string[];
  modes: string[];
  flushed: number;
  status: ComposerStatus;
  queue: QueueItem[];
}

function makeHarness(overrides: Partial<ComposerDeps> = {}): Harness {
  const submitted: Array<{ text: string; attachments: unknown[] }> = [];
  const shellCommands: string[] = [];
  const modes: string[] = [];
  const queue: QueueItem[] = [];
  let flushed = 0;
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
    onCycleMode: (next) => {
      modes.push(next);
      status.mode = next;
    },
    onRecallQueue: () => {
      if (queue.length === 0) return null;
      return queue.pop() ?? null;
    },
    onFlushQueue: () => {
      flushed += 1;
    },
    pasteText: (text) => ({
      chip: `[Pasted text #1 ${text.length} chars]`,
      attachment: { kind: "text", text },
    }),
    now: () => 1_000_000,
    ...overrides,
  };
  const composer = new Composer(deps);
  composer.start();
  return {
    composer,
    submitted,
    shellCommands,
    modes,
    get flushed() {
      return flushed;
    },
    status,
    queue,
  };
}

function special(
  h: Harness,
  key: {
    name?: string;
    ch?: string;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    sequence?: string;
  },
): void {
  h.composer.handleKey(key.ch, key);
}

function typeText(h: Harness, text: string): void {
  for (const ch of [...text]) h.composer.handleKey(ch, { ch, name: ch.length === 1 ? ch : undefined });
}

function enter(h: Harness): void {
  special(h, { name: "return", sequence: "\r" });
}

function ctrl(h: Harness, name: string, sequence?: string): void {
  special(h, { name, ctrl: true, sequence });
}

function meta(h: Harness, name: string, sequence?: string): void {
  special(h, { name, meta: true, sequence });
}

function frame(h: Harness): string {
  return h.composer.compose().rows.join("\n");
}

function visible(h: Harness): string {
  return stripAnsi(frame(h));
}


function firstRgb(line: string): string | null {
  const m = line.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  return m ? `${m[1]},${m[2]},${m[3]}` : null;
}

function rgb(role: keyof typeof palette): string {
  const [r, g, b] = palette[role];
  return `${r},${g},${b}`;
}

function bottomRule(h: Harness): string {
  const rows = h.composer.compose().rows;
  // 输入框底横线是「状态条之前」最后一条横线；compose 末尾还有状态行。
  for (let i = rows.length - 1; i >= 0; i--) {
    const plain = stripAnsi(rows[i] ?? "");
    if (/^─+$/.test(plain)) return rows[i] ?? "";
  }
  return rows[rows.length - 2] ?? "";
}

describe("issue #79 键位映射回归（#74 不得回退）", () => {
  test("#79 Ctrl+R / Ctrl+S 映射保持不变；Ctrl+Enter 仍是换行", () => {
    expect(mapKey({ name: "r", ctrl: true, sequence: "\x12" })).toEqual({ type: "ctrl-r" });
    expect(mapKey({ name: "s", ctrl: true, sequence: "\x13" })).toEqual({ type: "ctrl-s" });
    expect(mapKey({ name: "return", sequence: "\r", ctrl: true })).toEqual({ type: "newline" });
  });
});

describe("issue #79 P0.1 Kill ring 与撤销", () => {
  test("#79a Ctrl+K/U/W 删掉的文本可用 Ctrl+Y 粘回", () => {
    const h = makeHarness();
    typeText(h, "hello world");
    ctrl(h, "w", "\x17");
    expect(h.composer.text).toBe("hello ");
    ctrl(h, "y", "\x19");
    expect(h.composer.text).toBe("hello world");
    expect(h.composer.buf.cursor).toBe("hello world".length);
    h.composer.stop();
  });

  test("#79b Alt+Y 循环删除历史", () => {
    const h = makeHarness();
    typeText(h, "aaa");
    ctrl(h, "u", "\x15");
    typeText(h, "bbb");
    ctrl(h, "u", "\x15");
    ctrl(h, "y", "\x19");
    expect(h.composer.text).toBe("bbb");
    meta(h, "y", "\x1by");
    expect(h.composer.text).toBe("aaa");
    meta(h, "y", "\x1by");
    expect(h.composer.text).toBe("bbb");
    h.composer.stop();
  });

  test("#79c Ctrl+_ 撤销上一次输入编辑（恢复文本和光标）", () => {
    const h = makeHarness();
    typeText(h, "hello world");
    special(h, { name: "left" });
    special(h, { name: "left" });
    const cursor = h.composer.buf.cursor;
    ctrl(h, "w", "\x17");
    expect(h.composer.text).not.toBe("hello world");
    special(h, { name: "_", ctrl: true, sequence: "\x1f" });
    expect(h.composer.text).toBe("hello world");
    expect(h.composer.buf.cursor).toBe(cursor);
    h.composer.stop();
  });

  test("#79a2 Backspace / Delete 不进 kill ring；Ctrl+Y 仍粘回上一次有意的 kill；Ctrl+D 也不进环", () => {
    // Leo 探针：hello world → Ctrl+W 删掉 world → 键入 x → Backspace 修掉 → Ctrl+Y 必须粘回 world，不是 x
    const h = makeHarness();
    typeText(h, "hello world");
    ctrl(h, "w", "\x17");
    expect(h.composer.text).toBe("hello ");
    typeText(h, "x");
    special(h, { name: "backspace" });
    expect(h.composer.text).toBe("hello ");
    ctrl(h, "y", "\x19");
    expect(h.composer.text).toBe("hello world");
    h.composer.stop();

    // Delete 只进撤销栈，不覆盖 kill ring
    const h2 = makeHarness();
    typeText(h2, "hello world");
    ctrl(h2, "w", "\x17");
    typeText(h2, "xy");
    special(h2, { name: "left" });
    special(h2, { name: "delete" });
    expect(h2.composer.text).toBe("hello x");
    ctrl(h2, "y", "\x19");
    expect(h2.composer.text).toBe("hello xworld");
    h2.composer.stop();

    // Ctrl+D 与 Delete 对齐：不进环（也不改成开始进环）
    const h3 = makeHarness();
    typeText(h3, "hello world");
    ctrl(h3, "w", "\x17");
    typeText(h3, "xy");
    special(h3, { name: "left" });
    ctrl(h3, "d");
    expect(h3.composer.text).toBe("hello x");
    ctrl(h3, "y", "\x19");
    expect(h3.composer.text).toBe("hello xworld");
    h3.composer.stop();
  });
});

describe("issue #79 P0.2 词边界与词级编辑", () => {
  test("#79d 字母数字为一词、标点（含 _./）分隔；与 Ctrl/Alt+Left 同一套规则", () => {
    const buf = new TextBuffer("src/tui/keys.ts");
    buf.cursor = buf.length;
    buf.move("word-left", 100);
    expect(buf.cursor).toBe("src/tui/keys.".length); // ts
    buf.move("word-left", 100);
    expect(buf.cursor).toBe("src/tui/keys".length); // .
    buf.move("word-left", 100);
    expect(buf.cursor).toBe("src/tui/".length); // keys

    const under = new TextBuffer("foo_bar");
    under.cursor = under.length;
    under.move("word-left", 100);
    expect(under.cursor).toBe(4); // bar
    under.move("word-left", 100);
    expect(under.cursor).toBe(3); // _
    under.move("word-left", 100);
    expect(under.cursor).toBe(0); // foo
  });

  test("#79e 中日文连续字按词移动；ASCII 与 CJK 之间分词", () => {
    const cjk = new TextBuffer("你好世界");
    cjk.cursor = cjk.length;
    cjk.move("word-left", 100);
    expect(cjk.cursor).toBe(0);

    const jp = new TextBuffer("こんにちは世界");
    jp.cursor = jp.length;
    jp.move("word-left", 100);
    expect(jp.cursor).toBe(5); // 世界
    jp.move("word-left", 100);
    expect(jp.cursor).toBe(0); // こんにちは

    const mixed = new TextBuffer("中文abc词");
    mixed.cursor = mixed.length;
    mixed.move("word-left", 100);
    expect(mixed.cursor).toBe(5); // 词
    mixed.move("word-left", 100);
    expect(mixed.cursor).toBe(2); // abc
    mixed.move("word-left", 100);
    expect(mixed.cursor).toBe(0); // 中文
  });

  test("#79f Ctrl+W 删到上一空白，与 Alt+D / Ctrl+Backspace 的按词删除区分", () => {
    const h = makeHarness();
    typeText(h, "see src/tui/keys.ts");
    ctrl(h, "w", "\x17");
    expect(h.composer.text).toBe("see ");

    typeText(h, "foo_bar");
    // Ctrl+Backspace 按字母数字词删，只吃掉 bar，留下 foo_（与 Ctrl+W 吃整段不同）
    special(h, { name: "backspace", ctrl: true });
    expect(h.composer.text).toBe("see foo_");
    h.composer.stop();
  });

  test("#79g Alt+D 向后按词删除", () => {
    const h = makeHarness();
    typeText(h, "foo_bar baz");
    h.composer.buf.cursor = 0;
    meta(h, "d", "\x1bd");
    expect(h.composer.text).toBe("_bar baz");
    meta(h, "d", "\x1bd");
    expect(h.composer.text).toBe("bar baz");
    h.composer.stop();
  });
});

describe("issue #79 P0.3 Ctrl+P / Ctrl+N 作为 ↑/↓ 别名", () => {
  test("#79h 多行时先在框内移动，到首视觉行再翻历史", () => {
    const h = makeHarness();
    typeText(h, "old-one");
    enter(h);
    typeText(h, "old-two");
    enter(h);
    typeText(h, "line1");
    special(h, { name: "return", ctrl: true, sequence: "\r" });
    typeText(h, "line2");
    expect(h.composer.text).toBe("line1\nline2");
    ctrl(h, "p", "\x10");
    expect(h.composer.text).toBe("line1\nline2");
    expect(h.composer.buf.cursor).toBe(5); // end of line1（首视觉行）
    // 现有 ↑ 历史是前缀搜索，「line1\nline2」匹配不到 old-two。
    // 空框后再用 Ctrl+P / Ctrl+N 验证它们是 ↑/↓ 的历史别名。
    special(h, { name: "escape" });
    expect(h.composer.text).toBe("");
    ctrl(h, "p", "\x10");
    expect(h.composer.text).toBe("old-two");
    ctrl(h, "n", "\x0e");
    expect(h.composer.text).toBe("");
    h.composer.stop();
  });
});

describe("issue #79 P0.4 Ctrl+C 清空草稿可找回", () => {
  test("#79i Ctrl+C 清空后空框按 ↑ 召回原文与光标，不提交；会话内最多 10 条", () => {
    const h = makeHarness();
    typeText(h, "keep-me");
    special(h, { name: "left" });
    const cursor = h.composer.buf.cursor;
    const before = h.submitted.length;
    ctrl(h, "c");
    expect(h.composer.text).toBe("");
    expect(h.submitted.length).toBe(before);
    special(h, { name: "up" });
    expect(h.composer.text).toBe("keep-me");
    expect(h.composer.buf.cursor).toBe(cursor);
    h.composer.stop();
  });

  test("#79j 召回含粘贴 chip 与 shell 模式；Esc 清空仍不能用 ↑ 复活（C4k 不回退）", () => {
    const h = makeHarness({ paste: { foldLines: 2, foldChars: 10 } });
    typeText(h, "!echo ");
    special(h, { name: "paste-start" });
    for (const ch of "0123456789abcdef") h.composer.handleKey(ch, { ch, name: ch });
    special(h, { name: "paste-end" });
    expect(h.composer.shellMode).toBe(true);
    const savedText = h.composer.text;
    const savedAtt = structuredClone(h.composer.attachments);
    ctrl(h, "c");
    expect(h.composer.text).toBe("");
    expect(h.composer.shellMode).toBe(false);
    expect(h.composer.attachments).toEqual([]);
    special(h, { name: "up" });
    expect(h.composer.shellMode).toBe(true);
    expect(h.composer.text).toBe(savedText);
    expect(h.composer.attachments).toEqual(savedAtt);
    expect(h.shellCommands).toEqual([]);

    // Esc 清空走旧语义：不进召回环。召回已弹出上一份后，↑ 不应复活 Esc 清掉的内容。
    special(h, { name: "escape" });
    typeText(h, "abc");
    special(h, { name: "escape" });
    expect(h.composer.text).toBe("");
    special(h, { name: "up" });
    expect(h.composer.text).toBe("");
    h.composer.stop();
  });

  test("#79k 最近 10 条：第 11 份清空后，最早一份不再能召回", () => {
    const h = makeHarness();
    for (let i = 1; i <= 11; i++) {
      typeText(h, `draft-${i}`);
      ctrl(h, "c");
    }
    const recalled: string[] = [];
    for (let i = 0; i < 12; i++) {
      special(h, { name: "up" });
      if (h.composer.text === "") break;
      recalled.push(h.composer.text);
      // Esc 清空不进召回环，才能按 LIFO 继续取下一条。
      special(h, { name: "escape" });
    }
    expect(recalled).toEqual([
      "draft-11",
      "draft-10",
      "draft-9",
      "draft-8",
      "draft-7",
      "draft-6",
      "draft-5",
      "draft-4",
      "draft-3",
      "draft-2",
    ]);
    expect(recalled).not.toContain("draft-1");
    h.composer.stop();
  });
});

describe("issue #79 P0.5 空输入 ? 快捷键帮助", () => {
  test("#79l 空框 ? 打开/关闭帮助；框内已有文字时 ? 是普通字符；不做 Vim；空闲 tick 不常驻", () => {
    const h = makeHarness();
    special(h, { ch: "?", name: "?" });
    const open = visible(h);
    expect(open).toContain("Ctrl+Y");
    expect(open).toContain("Shift+Tab");
    expect(open).toContain("不做 Vim");
    expect(open).not.toMatch(/\bVim 模式\b/);
    expect(h.composer.text).toBe("");
    expect(h.composer.tickTimer).toBeNull();
    expect(h.composer.noticeText).toBeNull();

    special(h, { ch: "?", name: "?" });
    expect(visible(h)).not.toContain("不做 Vim");
    expect(h.composer.text).toBe("");
    expect(h.composer.tickTimer).toBeNull();

    typeText(h, "ok?");
    expect(h.composer.text).toBe("ok?");
    expect(visible(h)).not.toContain("不做 Vim");
    h.composer.stop();
  });
});

describe("issue #79 P0.6 输入框横线强调色随模式变", () => {
  test("#79m 普通 / plan / auto-edit / auto-all / shell 的底横线颜色互不相同", () => {
    const prevForce = process.env.FORCE_COLOR;
    const prevNoColor = process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    try {
      const h = makeHarness();
      const colors: Record<string, string | null> = {};
      for (const mode of ["ask", "plan", "auto-edit", "auto-all"] as const) {
        h.status.mode = mode;
        colors[mode] = firstRgb(bottomRule(h));
      }
      typeText(h, "!");
      colors.shell = firstRgb(bottomRule(h));
      expect(colors.ask).toBe(rgb("dimGreen"));
      expect(colors.plan).toBe(rgb("cyan"));
      expect(colors["auto-edit"]).toBe(rgb("magenta"));
      expect(colors["auto-all"]).toBe(rgb("red"));
      expect(colors.shell).toBe(rgb("amber"));
      const unique = new Set(Object.values(colors));
      expect(unique.size).toBe(5);
      // 状态条展示名 edit / yolo 必须映射到同一套强调色，不用 Claude 的模式名。
      h.composer.exitShellMode();
      h.composer.buf.clear();
      h.status.mode = "edit";
      expect(firstRgb(bottomRule(h))).toBe(rgb("magenta"));
      h.status.mode = "yolo";
      expect(firstRgb(bottomRule(h))).toBe(rgb("red"));
      const plain = visible(h);
      expect(plain).not.toContain("acceptEdits");
      expect(plain).not.toContain("bypassPermissions");
      h.composer.stop();
    } finally {
      if (prevForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForce;
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
    }
  });
});

describe("issue #79 P0.7 Shift+Tab / Alt+M 循环 /mode 档位", () => {
  test("#79n 循环顺序 ask → auto-edit → auto-all → plan → ask；不用 Claude 模式名", () => {
    const h = makeHarness();
    special(h, { name: "tab", shift: true, sequence: "\x1b[Z" });
    special(h, { name: "m", meta: true, sequence: "\x1bm" });
    special(h, { name: "tab", shift: true, sequence: "\x1b[Z" });
    special(h, { name: "tab", shift: true, sequence: "\x1b[Z" });
    expect(h.modes).toEqual(["auto-edit", "auto-all", "plan", "ask"]);
    expect(h.status.mode).toBe("ask");
    expect(visible(h)).not.toContain("default");
    expect(visible(h)).not.toContain("acceptEdits");
    expect(visible(h)).not.toContain("bypassPermissions");
    // 用 hint 提示切换结果，不用 notice()，避免空闲 tick 常驻。
    expect(h.composer.tickTimer).toBeNull();
    expect(h.composer.noticeText).toBeNull();
    h.composer.stop();
  });
});

describe("issue #79 P1.8 排队收回与 Ctrl+X Ctrl+S 立即发送", () => {
  test("#79o 单独 Ctrl+S 仍是 #74 暂存；Ctrl+X 后的 Ctrl+S 才立即发送，不暂存", () => {
    const h = makeHarness();
    typeText(h, "stash-me");
    ctrl(h, "s", "\x13");
    expect(h.composer.text).toBe("");
    expect(h.submitted).toEqual([]);
    expect(h.flushed).toBe(0);
    ctrl(h, "s", "\x13");
    expect(h.composer.text).toBe("stash-me");

    ctrl(h, "x", "\x18");
    ctrl(h, "s", "\x13");
    expect(h.submitted).toEqual([{ text: "stash-me", attachments: [] }]);
    expect(h.flushed).toBe(1);
    expect(h.composer.text).toBe("");
    expect(h.composer.stash).toBeNull();
    h.composer.stop();
  });

  test("#79p ↑ 从输入框首行收回已排队内容，可编辑后再提交", () => {
    const h = makeHarness();
    h.queue.push({ text: "queued-one", attachments: [] });
    h.composer.setQueueCount(1);
    special(h, { name: "up" });
    expect(h.composer.text).toBe("queued-one");
    expect(h.queue).toEqual([]);
    typeText(h, "!");
    enter(h);
    expect(h.submitted).toEqual([{ text: "queued-one!", attachments: [] }]);
    h.composer.stop();
  });
});

describe("issue #79 P1.9 句中 / 命令补全", () => {
  test("#79q 空格后的 /com 出候选；Tab 只插入不执行；路径不误开菜单", () => {
    expect(triggerAt("please /com")).toEqual({
      kind: "command",
      token: "/com",
      query: "com",
      start: "please ".length,
    });
    expect(triggerAt("/tmp/notes.md")).toBeNull();
    expect(triggerAt("see /tmp/notes.md")).toBeNull();
    expect(triggerAt("please /com extra")).toBeNull();

    const h = makeHarness();
    typeText(h, "please /he");
    expect(frame(h)).toContain("/help");
    special(h, { name: "tab" });
    expect(h.composer.text).toBe("please /help");
    expect(h.submitted).toEqual([]);
    enter(h);
    expect(h.submitted).toEqual([{ text: "please /help", attachments: [] }]);
    h.composer.stop();
  });
});

describe("issue #79 P1.10 提交时剥掉不可见 Unicode", () => {
  test("#79r 提交去掉 ZWSP / 双向标记，保留换行与 emoji ZWJ 序列", () => {
    const h = makeHarness();
    const zwj = "👨‍👩‍👧‍👦";
    typeText(h, `hello\u200b ${zwj}\u202e`);
    enter(h);
    expect(h.submitted).toEqual([{ text: `hello ${zwj}`, attachments: [] }]);
    h.composer.stop();
  });
});
