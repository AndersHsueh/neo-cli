/**
 * tui/keys.ts — raw keypress → 语义动作归一化 + bracketed paste 状态机（v0.3.0 K1）。
 *
 * 纯逻辑，无 IO：输入是 `emitKeypressEvents` 给的对象形状，输出是 composer 可直接消费的
 * KeyAction；粘贴态由调用方先问 `PasteMachine.active` 再决定走 feed 还是 mapKey。
 *
 * M0 实测（docs/v0.3.0-tui-prd[done].md §2 P1、docs/v0.2.4-m0-probes[done].md P3/P4）：
 *  - Ctrl+J(0x0A) 到达时 `{name:"enter", sequence:"\n", ctrl:false}`，Enter(0x0D) 是
 *    `{name:"return", sequence:"\r"}` —— **换行/提交必须看 sequence，不能看 name**。
 *  - UTF-8 `中` 以 `{ch:"中", name:undefined}` 到达，按 name 过滤会把中文整片丢掉。
 *  - Tab 在下游 readline 会字面插入 `\t`；键层只给 tab 动作，绝不产生 insert("\t")。
 *  - bracketed paste 以 `paste-start` / 内容键 / `paste-end` 到达。
 *
 * 纪律：本模块不做任何终端/状态副作用；Ctrl+C 等「信号语义」由调用方兜底（见 PasteMachine）。
 */

export interface RawKey {
  ch?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
  paste?: boolean;
}

export type KeyAction =
  | { type: "insert"; text: string }
  | { type: "submit" }
  | { type: "newline" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "word-left" }
  | { type: "word-right" }
  | { type: "kill-end" }
  | { type: "kill-start" }
  | { type: "kill-word" }
  | { type: "tab" }
  | { type: "escape" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  | { type: "ctrl-o" }
  | { type: "ctrl-v" }
  | { type: "page-up" }
  | { type: "page-down" }
  | { type: "paste-start" }
  | { type: "paste-end" };

/** 控制字符（含 Tab / LF / CR / DEL）；粘贴区间之外一律不可插入。 */
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * 可插入文本判定。
 *
 * 只认 `ch`（**不看 name**：UTF-8 字符的 name 可能是 undefined）；
 * ctrl/meta 组合、控制字符返回 null。空格与 UTF-8 原样保留，多字符块（IME/粘贴块）整体返回。
 */
export function insertableText(k: RawKey): string | null {
  if (k.ctrl || k.meta) return null;
  const ch = k.ch;
  if (typeof ch !== "string" || ch.length === 0) return null;
  if (CONTROL.test(ch)) return null;
  return ch;
}

/** 单键归一化。返回 null 表示本键无输入层语义（调用方可忽略）。 */
export function mapKey(k: RawKey): KeyAction | null {
  // 1) Ctrl+J：M0 实测 sequence 是 "\n"（name 仍是 "enter"）——必须最先判。
  if (k.sequence === "\n") return { type: "newline" };

  // 2) 换行组合键：Shift+Enter（Kitty 协议）/ Ctrl+Enter / Alt+Enter。
  //    必须在 sequence "\r" 的提交判定之前 —— 否则它们会被当成提交。
  const enterName = k.name === "return" || k.name === "enter";
  if (enterName && k.shift === true) return { type: "newline" };
  if (enterName && (k.ctrl === true || k.meta === true)) return { type: "newline" };

  // 3) Enter(0x0D) = 提交（无修饰）。
  if (k.sequence === "\r" && !k.ctrl && !k.meta && k.shift !== true) return { type: "submit" };
  if (k.name === "return" && !k.ctrl && !k.meta && !k.shift) return { type: "submit" };

  // 4) 保守：name=enter 但 sequence 不是 "\n"（\n 已在上面拦下）也按提交。
  if (k.name === "enter" && !k.ctrl && !k.meta && k.shift !== true) return { type: "submit" };

  // 5) Ctrl 组合键（信号语义由调用方兜底，这里只做编辑器语义）。
  if (k.ctrl) {
    switch (k.name) {
      case "o": return { type: "ctrl-o" };
      case "c": return { type: "ctrl-c" };
      case "d": return { type: "ctrl-d" };
      case "v": return { type: "ctrl-v" };
      case "j": return { type: "newline" };
      case "a": return { type: "home" };
      case "e": return { type: "end" };
      case "k": return { type: "kill-end" };
      case "u": return { type: "kill-start" };
      case "w": return { type: "kill-word" };
      case "left": return { type: "word-left" };
      case "right": return { type: "word-right" };
      default: break;
    }
  }

  // 6) Alt/⌥ + ←/→（macOS 终端常见）同样按词移动。
  if (k.meta && k.name === "left") return { type: "word-left" };
  if (k.meta && k.name === "right") return { type: "word-right" };

  // 7) 无修饰（或未识别的修饰组合）的命名键。
  switch (k.name) {
    case "tab": return { type: "tab" };
    case "escape": return { type: "escape" };
    case "up": return { type: "up" };
    case "down": return { type: "down" };
    case "left": return { type: "left" };
    case "right": return { type: "right" };
    case "home": return { type: "home" };
    case "end": return { type: "end" };
    case "delete": return { type: "delete" };
    case "backspace": return { type: "backspace" };
    case "pageup": return { type: "page-up" };
    case "pagedown": return { type: "page-down" };
    case "paste-start": return { type: "paste-start" };
    case "paste-end": return { type: "paste-end" };
    default: break;
  }

  // 8) 其余可打印字符（含 name=undefined 的 UTF-8）。
  const text = insertableText(k);
  return text === null ? null : { type: "insert", text };
}

/**
 * bracketed paste 状态机（纯判定）。
 *
 * 调用方约定：`active` 为真时把按键交给 `feed`，为假时走 `mapKey`。
 * 粘贴区间内**任何内容都按字面文本收**，只把 `\r` / `\r\n` 归一成 `\n`：
 *  - `mapKey` 的「Ctrl+J=换行 / Enter=提交」在这里**不生效**（否则粘贴文本会被拆成提交）；
 *  - 遇到 Ctrl+C 返回 `"ignore"` 且**不结束粘贴**、也不产生 ctrl-c —— 中止语义由调用方
 *    先查 `active` 后自行处理（M0 结论：粘贴期间信号键不能下发给编辑器）；
 *  - `paste-end` 结束；粘贴区间内再遇到 `paste-start`（异常嵌套）按 ignore 处理。
 */
export class PasteMachine {
  private isActive = false;

  get active(): boolean {
    return this.isActive;
  }

  start(): void {
    this.isActive = true;
  }

  reset(): void {
    this.isActive = false;
  }

  feed(k: RawKey): { kind: "text"; text: string } | { kind: "end" } | { kind: "ignore" } {
    if (!this.isActive) return { kind: "ignore" };
    if (k.name === "paste-end") {
      this.isActive = false;
      return { kind: "end" };
    }
    if (k.name === "paste-start") return { kind: "ignore" };
    // Ctrl+C 等修饰键：不产生文本、不结束粘贴，由调用方兜底。
    if (k.ctrl || k.meta) return { kind: "ignore" };

    const raw = k.ch ?? k.sequence;
    if (typeof raw !== "string" || raw.length === 0) return { kind: "ignore" };

    // \r\n 先整体归一，避免一次粘贴里的 CRLF 变成两个换行。
    const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return { kind: "text", text };
  }
}
