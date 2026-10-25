/**
 * select<T> —— 行内选择组件（PRD: docs/select-component-prd[done].md）
 *
 * 分层：纯状态机 reduce()（bun test 直测的文本 oracle）
 *       → 渲染 select()（有界行内重绘，只碰自己的块，不违反 append-only）
 *
 * 设计决策（PRD §3）：
 *  - 到顶/到底 clamp 不循环：可预测，与 gh 等主流 CLI 一致；
 *  - enter/esc 不进 reducer —— 终止事件，由 select() 的 Promise 直接 resolve；
 *  - 终态定格不擦除：确认 ❯ 留在所选项、取消全变暗，会话记录可读。
 *
 * M0 探针结论（docs/select-component-m0-probes[done].md）落点：
 *  - C5 清理用手段B（rl.line 赋空 + _refreshLine），经 deps.clearLine 注入，select 不直接摸 readline；
 *  - keypress 实际发在 stdin 上（hotkeys.ts 存量 bug），修复在 hotkeys.ts，本文件照常消费 router。
 */
import type { HotkeyKey } from "../hotkeys";
import { c, displayWidth, truncate } from "./theme";

/** 状态机状态：cursor = 当前指向的选项下标；scroll = 可见窗口起始下标。 */
export interface SelectState {
  cursor: number;
  scroll: number;
}

export type SelectAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "goto"; index: number }
  | { type: "resize"; viewportRows: number };

/**
 * 纯函数状态转移。
 *
 * - 可见窗口为 [scroll, scroll + viewportRows)；cursor 移动后越出窗口则 scroll 跟随滑动。
 * - up/down 在 0 与 optionCount - 1 处 clamp。
 * - goto 供未来数字直选复用（v1 不接线），越界下标同样 clamp。
 * - resize 只重算 scroll（窗口缩小时把 cursor 拉回可见范围），cursor 不动。
 * - optionCount <= 0 时调用方不应调 select（现有调用方都有空列表分支）；
 *   这里防御性返回零态，1 选项时正常显示。
 */
export function reduce(
  s: SelectState,
  a: SelectAction,
  optionCount: number,
  viewportRows: number,
): SelectState {
  if (optionCount <= 0) return { cursor: 0, scroll: 0 };
  const rows = Math.max(1, viewportRows);

  let cursor = s.cursor;
  switch (a.type) {
    case "up":
      cursor = Math.max(0, cursor - 1);
      break;
    case "down":
      cursor = Math.min(optionCount - 1, cursor + 1);
      break;
    case "goto":
      cursor = Math.min(optionCount - 1, Math.max(0, a.index));
      break;
    case "resize":
      break; // cursor 不动，scroll 在下方统一重算
  }

  let scroll = s.scroll;
  if (cursor < scroll) {
    scroll = cursor; // 上移越出窗口顶 → 窗口上滑
  } else if (cursor >= scroll + rows) {
    scroll = cursor - rows + 1; // 下移越出窗口底 → 窗口下滑
  }
  // resize 缩窗后旧 scroll 可能把 cursor 挤出界，或窗口大于选项数 → 夹回合法范围
  scroll = Math.min(scroll, Math.max(0, optionCount - rows));
  scroll = Math.max(0, scroll);

  return { cursor, scroll };
}

/* ------------------------------------------------------------------ */
/* 组件主体                                                            */
/* ------------------------------------------------------------------ */

const MAX_VIEWPORT = 10;

export interface SelectOption<T> {
  label: string; // 主文本（渲染前按终端宽度截断，C6）
  hint?: string; // 右侧暗色提示，如 "当前" / "12轮"
  value: T; // 选中后返回的载荷（会话 id、模型 id…）
}

export interface SelectDeps {
  /** HotkeyRouter 的结构化子集，便于测试注入假 router */
  router: { on(key: HotkeyKey, fn: () => void): () => void };
  isTTY?: boolean; // 默认 process.stdin.isTTY
  columns?: () => number; // 默认取 out.columns ?? 80
  /** 输出与 resize 事件源；默认 process.stdout。测试注入收集器（PRD §8 测试 3） */
  out?: {
    write(s: string): unknown;
    on(ev: "resize", fn: () => void): unknown;
    off(ev: "resize", fn: () => void): unknown;
  };
  /** 初始 cursor（PRD D8：/model 定位当前模型；§4.1 未列，实现补充） */
  initial?: number;
  /**
   * select 激活状态变化回调（C9/C11）。
   * active=true 时第二参携带取消函数（resolve null 并定格终态）——
   * SIGINT 处理器据此在 select 期间把 Ctrl+C 路由为「取消选择」而非武装退出；
   * active=false 时 cancel 为 undefined，调用方应清掉持有的引用。
   */
  onActiveChange?: (active: boolean, cancel?: () => void) => void;
  /** 非 TTY 回退用问句函数（即 ui.asker） */
  asker?: (q: string) => Promise<string>;
  /**
   * TTY 下的展示函数（v0.3.0）：由 composer 在自己的 live 帧里渲染菜单。
   * 提供后跳过本文件的行内自绘（不再直接写 stdout），select 只做语义收敛。
   */
  present?: <T>(
    question: string,
    options: SelectOption<T>[],
    initial?: number,
  ) => Promise<T | null>;
  /** C5 行缓冲清理（M0 §2 手段B：rl.line="" + _refreshLine），由持有 readline 的一方注入 */
  clearLine?: () => void;
  /**
   * 打开宽限窗毫秒数（默认 50）。bun 实证：提交行的回车，其 keypress 在 line
   * 事件之后才派发（node 反序）——不设窗会把「打开菜单的那次回车」当成确认，
   * 自动选中第一条。残留事件与打开同 tick，人手反应 ≥200ms，50ms 落在两者之间。
   * 测试注入 0 关闭、大值模拟残留。
   */
  graceMs?: number;
}


type FinalMode =
  | { mode: "active" }
  | { mode: "confirm"; index: number }
  | { mode: "cancel" };

/** 非 TTY 回退（D5）：编号列表 + asker + Number 校验，失败即 null（F8 语义照抄）。 */
async function fallbackNumeric<T>(
  question: string,
  options: SelectOption<T>[],
  deps: SelectDeps,
): Promise<T | null> {
  const out = deps.out ?? process.stdout;
  out.write(`${question}\n`);
  options.forEach((o, i) => out.write(`  ${i + 1}) ${o.label}${o.hint ? `  ${o.hint}` : ""}\n`));
  if (!deps.asker) return null;
  const a = await deps.asker("❯ ");
  const n = Number(a.trim());
  return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1]!.value : null;
}

/**
 * 行内选择：↑↓ 移动、回车确认、esc 取消。
 *
 * 调用方职责（C1）：进入前 stopSpinner()/blank()，select 存续期间不得有其他输出写入。
 * 返回 null = esc / Ctrl+C / 非 TTY 下取消或非法输入。
 */
export async function select<T>(
  question: string,
  options: SelectOption<T>[],
  deps: SelectDeps,
): Promise<T | null> {
  if (options.length === 0) return null;
  const isTTY = deps.isTTY ?? process.stdin.isTTY;
  if (!isTTY) return fallbackNumeric(question, options, deps);
  if (deps.present) return deps.present(question, options, deps.initial);
  if (!deps.router) return fallbackNumeric(question, options, deps);

  const out = deps.out ?? process.stdout;
  const cols = (): number =>
    Math.max(20, deps.columns?.() ?? (out as { columns?: number }).columns ?? 80);
  const viewport = Math.min(options.length, MAX_VIEWPORT);

  // 初始状态：cursor 夹进合法范围，resize 语义顺便把 scroll 算对
  const initialCursor = Math.min(Math.max(0, deps.initial ?? 0), options.length - 1);
  let state = reduce(
    { cursor: initialCursor, scroll: 0 },
    { type: "resize", viewportRows: viewport },
    options.length,
    viewport,
  );
  let final: FinalMode = { mode: "active" };

  const renderLines = (f: FinalMode): string[] => {
    const w = cols();
    const lines: string[] = [c.bold(question)];
    const end = Math.min(state.scroll + viewport, options.length);
    for (let i = state.scroll; i < end; i++) {
      const o = options[i]!;
      const isMarked = f.mode === "confirm" ? i === f.index : i === state.cursor;
      const bright = f.mode !== "cancel" && isMarked;
      const avail = w - 2; // "❯ " 前缀占 2 列
      // hint 截断到半宽：hint 过长会挤压 label、破坏「行不折行」的宽度数学（C6）
      const hint = o.hint ? truncate(o.hint, Math.max(4, Math.floor(w / 2))) : undefined;
      const hintW = hint ? displayWidth(hint) + 2 : 0;
      const labelMax = Math.max(4, avail - hintW);
      const label = truncate(o.label, labelMax);
      let line = `${bright ? c.accent("❯") : " "} ${bright ? c.bold(label) : c.dim(label)}`;
      if (hint) {
        const pad = Math.max(1, labelMax - displayWidth(label));
        line += `${" ".repeat(pad)}  ${c.dim(hint)}`;
      }
      lines.push(line);
    }
    return lines;
  };

  const paint = (f: FinalMode, first: boolean): void => {
    const lines = renderLines(f);
    let s = "";
    if (!first) s += `\x1b[${lines.length - 1}A`; // 光标在块末行尾，上移回问题行
    s += lines.map((l, i) => `\x1b[2K\r${l}${i < lines.length - 1 ? "\n" : ""}`).join("");
    out.write(s);
  };

  let resolveRef: ((v: T | null) => void) | null = null;
  const finish = (value: T | null): void => {
    if (resolveRef === null) return; // 已结束（enter/esc 竞态防护）
    final = value === null ? { mode: "cancel" } : { mode: "confirm", index: state.cursor };
    paint(final, false);
    out.write("\n"); // 光标落到块下一行，主流继续 append-only
    const r = resolveRef;
    resolveRef = null;
    r(value);
  };

  const repaint = (): void => paint(final, false);
  const onResize = (): void => {
    state = reduce(state, { type: "resize", viewportRows: viewport }, options.length, viewport);
    repaint();
  };

  // 宽限窗：窗内的按键视为「打开动作的残留事件」，一律忽略（见 SelectDeps.graceMs 注释）
  const graceMs = deps.graceMs ?? 50;
  const openedAt = Date.now();
  const stale = (): boolean => Date.now() - openedAt < graceMs;

  const offs: Array<() => void> = [
    deps.router.on("up", () => {
      if (stale()) return;
      state = reduce(state, { type: "up" }, options.length, viewport);
      repaint();
    }),
    deps.router.on("down", () => {
      if (stale()) return;
      state = reduce(state, { type: "down" }, options.length, viewport);
      repaint();
    }),
    deps.router.on("enter", () => {
      if (stale()) return;
      finish(options[state.cursor]!.value);
    }),
    deps.router.on("escape", () => {
      if (stale()) return;
      finish(null);
    }),
  ];
  out.on("resize", onResize);

  deps.onActiveChange?.(true, () => finish(null)); // C9：把取消函数交给 SIGINT 协调方
  try {
    paint({ mode: "active" }, true);
    return await new Promise<T | null>((resolve) => {
      resolveRef = resolve;
    });
  } finally {
    // C3：进出必须干净——handler、resize、激活标志、行缓冲（C5）全部收尾
    for (const f of offs) f();
    out.off("resize", onResize);
    deps.onActiveChange?.(false);
    deps.clearLine?.();
  }
}
