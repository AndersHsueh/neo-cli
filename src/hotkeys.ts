/**
 * 用户按键的唯一入口。
 *
 * M0 探针实证（docs/select-component-m0-probes.md §1）：bun 与 node 都把
 * keypress 事件发在 input 流（stdin）上，而不是 readline 实例上——历史上
 * 挂在 rl 上导致所有热键从未生效过。因此 attach 监听 input。
 *
 * 职责划分：
 *  - Ctrl+C / Ctrl+D 走 SIGINT/SIGHUP 信号语义，不经这里；
 *  - 其余按键（ESC、方向键…）走这里。以后加新热键只需一行 on("up", …)。
 */
import type { Interface as RLInterface } from "node:readline";
import { emitKeypressEvents } from "node:readline";
import { EventEmitter } from "node:events";

export type HotkeyKey =
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "tab";

interface KeyInfo {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export class HotkeyRouter {
  private handlers = new Map<HotkeyKey, Array<() => void>>();
  private input: NodeJS.ReadableStream | null = null;
  private keypressHandler: ((ch: string, key: KeyInfo | undefined) => void) | null = null;

  /** 挂到 readline 实例上。input 为其输入流（通常是 process.stdin）。重复 attach 会先摘掉旧的。 */
  attach(rl: RLInterface, input: NodeJS.ReadableStream): void {
    this.detach();
    emitKeypressEvents(input, rl);
    this.keypressHandler = (ch, key) => {
      if (!key) return; // 粘贴块等无 key 信息的输入
      const mapped = this.mapKey(key);
      if (!mapped) return;
      for (const h of this.handlers.get(mapped) ?? []) h();
    };
    // M0 实证：keypress 发在 input 上（readline 内部也是这么干的）
    (input as EventEmitter).on("keypress", this.keypressHandler);
    this.input = input;
  }

  detach(): void {
    if (this.input && this.keypressHandler) {
      (this.input as EventEmitter).off("keypress", this.keypressHandler);
    }
    this.input = null;
    this.keypressHandler = null;
  }

  /** 注册处理函数。返回取消注册的函数。 */
  on(key: HotkeyKey, handler: () => void): () => void {
    const list = this.handlers.get(key) ?? [];
    list.push(handler);
    this.handlers.set(key, list);
    return () => {
      const cur = this.handlers.get(key) ?? [];
      const i = cur.indexOf(handler);
      if (i !== -1) cur.splice(i, 1);
    };
  }

  private mapKey(k: KeyInfo): HotkeyKey | null {
    // Ctrl 组合键属于信号语义（SIGINT 等），这里只认修饰键为空的方向键与 ESC
    if (k.ctrl || k.meta) return null;
    switch (k.name) {
      case "escape": return "escape";
      case "up": return "up";
      case "down": return "down";
      case "left": return "left";
      case "right": return "right";
      case "enter":
      case "return": // M0 实证：真实回车的 keypress name 是 "return"（bun/node 一致）
        return "enter";
      case "tab": return "tab";
      default: return null;
    }
  }
}

/**
 * 双击确认：第一次调用武装并闪现提示，windowMs 内第二次调用才执行 action。
 * 超时自动解除武装。返回的是「单次按键处理函数」。
 */
export function doubleStrike(
  action: () => void,
  opts: {
    windowMs: number;
    /** 第一次按下时闪现的文字。 */
    notice: string;
    /** 展示提示的回调（通常闪现橙色一行）。 */
    flash: (text: string, ms: number) => void;
  },
): () => void {
  let armed = false;
  let timer: Timer | null = null;
  return () => {
    if (armed) {
      armed = false;
      if (timer) { clearTimeout(timer); timer = null; }
      action();
      return;
    }
    armed = true;
    opts.flash(opts.notice, opts.windowMs);
    timer = setTimeout(() => {
      armed = false;
      timer = null;
    }, opts.windowMs);
    timer.unref?.();
  };
}
