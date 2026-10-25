/**
 * tui-keys.test.ts — v0.3.0 K1：raw keypress → 语义动作归一化 + bracketed paste 状态机（纯逻辑）。
 *
 * 规格：docs/v0.3.0-tui-prd[done].md §6 K1；按键事实来自 M0 探针 P1/P3/P4
 * （docs/v0.2.4-m0-probes[done].md 与 docs/v0.3.0-tui-prd[done].md §2）：
 *  - Ctrl+J(0x0A) → `{name:"enter", sequence:"\n", ctrl:false}`；Enter(0x0D) → `{name:"return", sequence:"\r"}`。
 *    换行语义必须看 sequence，不能看 name。
 *  - UTF-8 `中` → `{ch:"中", name:undefined}`（绝不能按 name 过滤）。
 *  - Tab 默认会字面插入 `\t`，键层必须映射成 tab 动作、不产生 insert。
 *  - bracketed paste 以 paste-start / 内容键 / paste-end 到达。
 */
import { describe, expect, test } from "bun:test";

import {
  mapKey,
  insertableText,
  PasteMachine,
  type KeyAction,
  type RawKey,
} from "../src/tui/keys.ts";

const act = (k: RawKey): KeyAction | null => mapKey(k);

describe("K1a Ctrl+J vs Enter", () => {
  test("K1a Ctrl+J（sequence \\n，name 仍是 enter）→ newline", () => {
    // M0 P4 实测原始事件
    expect(act({ ch: "\n", name: "enter", sequence: "\n", ctrl: false })).toEqual({
      type: "newline",
    });
  });

  test("K1a 只给 sequence \\n（没有 name）也判 newline", () => {
    expect(act({ sequence: "\n" })).toEqual({ type: "newline" });
    expect(act({ name: "enter", sequence: "\n" })).toEqual({ type: "newline" });
  });

  test("K1a Enter（sequence \\r，name return）→ submit", () => {
    expect(act({ ch: "\r", name: "return", sequence: "\r", ctrl: false })).toEqual({
      type: "submit",
    });
    expect(act({ sequence: "\r" })).toEqual({ type: "submit" });
  });

  test("K1a 无 sequence 的 return（非修饰键）→ submit", () => {
    expect(act({ name: "return" })).toEqual({ type: "submit" });
    expect(act({ name: "return", shift: false, ctrl: false, meta: false })).toEqual({
      type: "submit",
    });
  });

  test("K1a name=enter 但 sequence 不是 \\n → 保守 submit", () => {
    expect(act({ name: "enter" })).toEqual({ type: "submit" });
    expect(act({ name: "enter", sequence: "\r" })).toEqual({ type: "submit" });
  });

  test("K1a shift+return → newline（Kitty 协议），shift+enter 同义", () => {
    expect(act({ name: "return", shift: true })).toEqual({ type: "newline" });
    expect(act({ name: "return", shift: true, sequence: "\r" })).toEqual({ type: "newline" });
  });

  test("K1a ctrl+return / alt+return = newline（qwen/Claude 同款多行键位）", () => {
    expect(act({ name: "return", ctrl: true })).toEqual({ type: "newline" });
    expect(act({ name: "return", meta: true })).toEqual({ type: "newline" });
    expect(act({ name: "return", ctrl: true, sequence: "\r" })).toEqual({ type: "newline" });
  });
});

describe("K1b 可插入文本", () => {
  test("K1b UTF-8 中文：name=undefined 也必须能插入", () => {
    expect(insertableText({ ch: "中", name: undefined })).toBe("中");
    expect(act({ ch: "中" })).toEqual({ type: "insert", text: "中" });
  });

  test("K1b 普通 ASCII / 大写 / 空格", () => {
    expect(act({ ch: "a", name: "a" })).toEqual({ type: "insert", text: "a" });
    expect(act({ ch: "A", shift: true, name: "A" })).toEqual({ type: "insert", text: "A" });
    expect(act({ ch: " " })).toEqual({ type: "insert", text: " " });
  });

  test("K1b 多字符块（粘贴/IME 一次给多字符）原样返回", () => {
    expect(act({ ch: "abc" })).toEqual({ type: "insert", text: "abc" });
    expect(act({ ch: "你好" })).toEqual({ type: "insert", text: "你好" });
  });

  test("K1b 控制字符一律不插入（\\t 必须排除）", () => {
    expect(insertableText({ ch: "\t", name: "tab" })).toBeNull();
    expect(insertableText({ ch: "\n", name: "enter" })).toBeNull();
    expect(insertableText({ ch: "\r" })).toBeNull();
    expect(insertableText({ ch: "\x01" })).toBeNull();
    expect(insertableText({ ch: "\x1b" })).toBeNull();
    expect(insertableText({ ch: "\x7f", name: "backspace" })).toBeNull();
  });

  test("K1b ctrl/meta 组合不产生文本", () => {
    expect(insertableText({ ch: "a", ctrl: true })).toBeNull();
    expect(insertableText({ ch: "π", meta: true })).toBeNull();
    expect(act({ ch: "a", meta: true })).toBeNull();
    expect(act({ ch: "a", ctrl: true })).toBeNull();
  });

  test("K1b 空 ch / 只给 name 的功能键不插入", () => {
    expect(insertableText({})).toBeNull();
    expect(insertableText({ ch: "" })).toBeNull();
    expect(insertableText({ name: "f1" })).toBeNull();
    expect(act({})).toBeNull();
    expect(act({ name: "f1" })).toBeNull();
  });
});

describe("K1c 编辑键与导航键", () => {
  test("K1c Tab 是动作，不插入字面 \\t", () => {
    expect(act({ ch: "\t", name: "tab" })).toEqual({ type: "tab" });
    expect(act({ name: "tab" })).toEqual({ type: "tab" });
  });

  test("K1c Escape", () => {
    expect(act({ name: "escape", sequence: "\x1b" })).toEqual({ type: "escape" });
  });

  test("K1c 方向键 / home / end / delete / backspace", () => {
    const table: Array<[string, KeyAction]> = [
      ["up", { type: "up" }],
      ["down", { type: "down" }],
      ["left", { type: "left" }],
      ["right", { type: "right" }],
      ["home", { type: "home" }],
      ["end", { type: "end" }],
      ["delete", { type: "delete" }],
      ["backspace", { type: "backspace" }],
    ];
    for (const [name, expected] of table) {
      expect(act({ name, sequence: `\x1b[${name}` })).toEqual(expected);
      expect(act({ name })).toEqual(expected);
    }
  });

  test("K1c pageup / pagedown 映射到 page-up / page-down", () => {
    expect(act({ name: "pageup" })).toEqual({ type: "page-up" });
    expect(act({ name: "pagedown" })).toEqual({ type: "page-down" });
  });
});

describe("K1d Ctrl/Meta 组合", () => {
  test("K1d Ctrl+O / Ctrl+C / Ctrl+D / Ctrl+V", () => {
    expect(act({ ch: "\x0f", name: "o", ctrl: true })).toEqual({ type: "ctrl-o" });
    expect(act({ name: "c", ctrl: true })).toEqual({ type: "ctrl-c" });
    expect(act({ name: "d", ctrl: true })).toEqual({ type: "ctrl-d" });
    expect(act({ name: "v", ctrl: true })).toEqual({ type: "ctrl-v" });
  });

  test("K1d Ctrl+J（ctrl 标志为 true 的形态）→ newline，不是 ctrl 动作", () => {
    expect(act({ name: "j", ctrl: true })).toEqual({ type: "newline" });
  });

  test("K1d Ctrl+A / E / K / U / W 编辑语义", () => {
    expect(act({ name: "a", ctrl: true })).toEqual({ type: "home" });
    expect(act({ name: "e", ctrl: true })).toEqual({ type: "end" });
    expect(act({ name: "k", ctrl: true })).toEqual({ type: "kill-end" });
    expect(act({ name: "u", ctrl: true })).toEqual({ type: "kill-start" });
    expect(act({ name: "w", ctrl: true })).toEqual({ type: "kill-word" });
  });

  test("K1d Ctrl/Alt + ←/→ 按词移动", () => {
    expect(act({ name: "left", ctrl: true })).toEqual({ type: "word-left" });
    expect(act({ name: "right", ctrl: true })).toEqual({ type: "word-right" });
    expect(act({ name: "left", meta: true })).toEqual({ type: "word-left" });
    expect(act({ name: "right", meta: true })).toEqual({ type: "word-right" });
  });

  test("K1d 未定义的 ctrl 组合返回 null（不误插控制字符）", () => {
    expect(act({ ch: "\x0c", name: "l", ctrl: true })).toBeNull();
  });
});

describe("K1e paste 边界动作", () => {
  test("K1e paste-start / paste-end 映射", () => {
    expect(act({ name: "paste-start" })).toEqual({ type: "paste-start" });
    expect(act({ name: "paste-end" })).toEqual({ type: "paste-end" });
  });
});

describe("K1f PasteMachine", () => {
  test("K1f 未激活时 feed 返回 ignore", () => {
    const pm = new PasteMachine();
    expect(pm.active).toBe(false);
    expect(pm.feed({ ch: "a" })).toEqual({ kind: "ignore" });
    expect(pm.feed({ name: "paste-end" })).toEqual({ kind: "ignore" });
  });

  test("K1f start 激活；内容按字面文本收；paste-end 结束", () => {
    const pm = new PasteMachine();
    pm.start();
    expect(pm.active).toBe(true);
    expect(pm.feed({ ch: "a" })).toEqual({ kind: "text", text: "a" });
    expect(pm.feed({ ch: "中", name: undefined })).toEqual({ kind: "text", text: "中" });
    expect(pm.feed({ ch: " " })).toEqual({ kind: "text", text: " " });
    expect(pm.feed({ name: "paste-end" })).toEqual({ kind: "end" });
    expect(pm.active).toBe(false);
  });

  test("K1f 粘贴内 \\r / \\n 统一归一为 \\n；\\r\\n 不产生两个换行", () => {
    const pm = new PasteMachine();
    pm.start();
    expect(pm.feed({ ch: "\r", name: "return", sequence: "\r" })).toEqual({
      kind: "text",
      text: "\n",
    });
    expect(pm.feed({ ch: "\n", name: "enter", sequence: "\n" })).toEqual({
      kind: "text",
      text: "\n",
    });
    expect(pm.feed({ ch: "\r\n" })).toEqual({ kind: "text", text: "\n" });
    // 没有 ch 时回退 sequence
    expect(pm.feed({ sequence: "\r" })).toEqual({ kind: "text", text: "\n" });
  });

  test("K1f 跨多键：每个键一段文本，调用方按序拼接", () => {
    const pm = new PasteMachine();
    pm.start();
    const out: string[] = [];
    for (const ch of ["h", "e", "l", "l", "o"]) {
      const r = pm.feed({ ch });
      if (r.kind === "text") out.push(r.text);
    }
    expect(out.join("")).toBe("hello");
  });

  test("K1f 粘贴内 Tab 按字面 \\t 收（与普通按键语义不同）", () => {
    const pm = new PasteMachine();
    pm.start();
    expect(pm.feed({ ch: "\t", name: "tab" })).toEqual({ kind: "text", text: "\t" });
  });

  test("K1f 粘贴内 Ctrl+C 返回 ignore 且不结束粘贴（由调用方兜底）", () => {
    const pm = new PasteMachine();
    pm.start();
    expect(pm.feed({ ch: "\x03", name: "c", ctrl: true })).toEqual({ kind: "ignore" });
    expect(pm.active).toBe(true);
    expect(pm.feed({ ch: "x" })).toEqual({ kind: "text", text: "x" });
  });

  test("K1f 嵌套 paste-start 忽略、无文本键忽略", () => {
    const pm = new PasteMachine();
    pm.start();
    expect(pm.feed({ name: "paste-start" })).toEqual({ kind: "ignore" });
    expect(pm.feed({ name: "tab" })).toEqual({ kind: "ignore" });
    expect(pm.feed({})).toEqual({ kind: "ignore" });
    expect(pm.active).toBe(true);
  });

  test("K1f reset 立即回到非激活", () => {
    const pm = new PasteMachine();
    pm.start();
    expect(pm.active).toBe(true);
    pm.reset();
    expect(pm.active).toBe(false);
    expect(pm.feed({ ch: "a" })).toEqual({ kind: "ignore" });
  });
});

describe("K1g 换行组合键（v0.3.0 补充）", () => {
  test("K1g Alt+Enter / Ctrl+Enter = 换行，不提交", () => {
    expect(mapKey({ name: "return", sequence: "\r", meta: true })).toEqual({ type: "newline" });
    expect(mapKey({ name: "return", sequence: "\r", ctrl: true })).toEqual({ type: "newline" });
    expect(mapKey({ name: "enter", sequence: "\r", meta: true })).toEqual({ type: "newline" });
  });

  test("K1h 无修饰 Enter 仍是提交（不能被组合键规则误伤）", () => {
    expect(mapKey({ name: "return", sequence: "\r", meta: false, ctrl: false })).toEqual({ type: "submit" });
    expect(mapKey({ name: "return", sequence: "\r" })).toEqual({ type: "submit" });
  });
});
