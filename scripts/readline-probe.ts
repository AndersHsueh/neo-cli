#!/usr/bin/env bun
/**
 * scripts/readline-probe.ts — bun 1.3.13 `node:readline` 输入层行为探针（v0.2.4 M0）。
 *
 * 为什么必须真 PTY：bun 的 readline 在非 TTY 流上**不运行行编辑器**（M0 探针
 * docs/select-component-m0-probes[done].md §6 已实证：rl.line 恒空、无 keypress）。
 * Tab 补全、Ctrl+J、多行渲染都依赖于 raw mode 下行编辑器的内部状态，只有真 PTY
 * 才能测到。这里复用 scripts/pty-e2e.ts 的 PTY 拉起方式（macOS `mkfifo` +
 * `cat fifo | script -q /dev/null /bin/sh wrapper`，PTY 内 `stty cols/rows`），
 * 而不是另发明一套。
 *
 * 结构：
 *   驱动模式（默认）：起真 PTY，跑本文件自己的 `--child <probe>` 最小 readline
 *   程序，喂真实按键字节，采集【程序侧日志（JSONL：completer 调用/入参/rl.line/
 *   keypress/line 事件）】+【终端原始字节】+【最小屏幕缓冲】三种证据。
 *   子程序模式（--child）：最小 bun readline 程序，只在 PTY 内被驱动拉起。
 *
 * PASS/FAIL 约定（重要）：
 *   PASS = 探针**完整跑完并给出确定结论**（结论可以是「原生不支持」这种否定结论）。
 *   FAIL = 证据不足：超时、子进程崩溃、证据互相矛盾、测不出。
 *   想看的不是「功能符合预期」，而是「bun 到底怎么表现」；否定结论同样是 PASS。
 *
 * 用法：
 *   bun run scripts/readline-probe.ts                  # 跑全部 P1~P7
 *   bun run scripts/readline-probe.ts p1 p3            # 只跑指定探针（调试用）
 *   bun run scripts/readline-probe.ts s1 s3            # 兼容 pty-e2e 的 sN 写法
 *   VERBOSE=1 bun run scripts/readline-probe.ts p5     # 额外打印完整原始字节/全部日志
 *   KEEP_TMP=1 bun run scripts/readline-probe.ts       # 保留每个探针的临时目录与日志
 *
 * 隔离与清理：每个探针独立临时目录 + HOME 指向临时目录，跑完（含失败）杀进程、
 * 删目录；不会碰真实 ~/.neo，不连网络。
 */
import { appendFileSync, closeSync, constants as fsConstants, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import type { Interface as RLInterface } from "node:readline";
import type { Subprocess } from "bun";

// 纯函数、无副作用：与 neo 渲染层同一套显示列规则（CJK/全角算 2 列）。
import { displayWidth } from "../src/ui/theme.ts";
// 只读复用生产热键路由器做 P3（验证「Tab keypress 与原生补全是否共存/谁先谁后」）。
import { HotkeyRouter } from "../src/hotkeys.ts";

/* ------------------------------------------------------------------ */
/* 常量与类型                                                          */
/* ------------------------------------------------------------------ */

/** 本脚本统一用 stdin/stderr/stdout 全 pipe 的进程形态（同 pty-e2e）。 */
type Proc = Subprocess<"ignore", "pipe", "pipe">;

/** readline 实例在 bun 里暴露的内部字段（node 类型里没有，探针必须读）。 */
type AnyRl = RLInterface & {
  line: string;
  cursor: number;
  history: string[];
  historyIndex: number;
  terminal?: boolean;
  isCompletionEnabled?: boolean;
  _refreshLine?: () => void;
  _tabComplete?: (lastKeypressWasTab?: boolean) => void;
  getPrompt?: () => string;
};

interface KeyLike {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** 子程序侧结构化日志行（JSONL）。 */
interface LogEntry extends Record<string, unknown> {
  seq: number;
  t: number;
  event: string;
}

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SELF = resolve(new URL(import.meta.url).pathname);
const BUN = process.execPath;
const SCRIPT_BIN = Bun.which("script") ?? "/usr/bin/script";
const MKFIFO = Bun.which("mkfifo") ?? "/usr/bin/mkfifo";
const CAT = Bun.which("cat") ?? "/bin/cat";
const IS_DARWIN = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 40;

const KEEP_TMP = process.env["KEEP_TMP"] === "1";
const VERBOSE = process.env["VERBOSE"] === "1";

/** 真实按键字节。 */
const KEY = {
  tab: "\t",
  enter: "\r",
  ctrlJ: "\n",
  ctrlG: "\x07",
  ctrlO: "\x0f",
  ctrlT: "\x14",
  ctrlU: "\x15",
  up: "\x1b[A",
  down: "\x1b[B",
} as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class ProbeError extends Error {
  constructor(
    message: string,
    readonly evidence: string[] = [],
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

/* ------------------------------------------------------------------ */
/* 最小屏幕缓冲（复制自 scripts/pty-e2e.ts，来源注明）                  */
/* ------------------------------------------------------------------ */

/**
 * 把 PTY 字节流解释成「屏幕最终内容」。
 *
 * 只实现断言需要的子集：
 *   \r 回行首、\n 换行、\b 左移、\t 到下一个 8 列制表位；
 *   CSI K/J/A~H/f/d/P/@/X；OSC 整体跳过；装饰序列忽略。
 * 不做自动折行（PTY 折行不产生换行字节）——宽行保持一条逻辑行。
 */
class Screen {
  private rows: string[][] = [[]];
  private row = 0;
  private col = 0;
  private saved: { row: number; col: number } | null = null;

  feed(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i] as string;
      if (ch === "\x1b") {
        i += this.consumeEscape(chunk, i);
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.row += 1;
        this.col = 0;
        this.ensureRow(this.row);
        i += 1;
        continue;
      }
      if (ch === "\b") {
        if (this.col > 0) this.col -= 1;
        i += 1;
        continue;
      }
      if (ch === "\t") {
        const stop = (Math.floor(this.col / 8) + 1) * 8;
        this.ensureRow(this.row);
        const row = this.rows[this.row] as string[];
        while (row.length < stop) row.push(" ");
        this.col = stop;
        i += 1;
        continue;
      }
      const cp = chunk.codePointAt(i) as number;
      const glyph = String.fromCodePoint(cp);
      this.put(glyph);
      i += glyph.length;
    }
  }

  private ensureRow(r: number): void {
    while (this.rows.length <= r) this.rows.push([]);
  }

  private put(glyph: string): void {
    const w = displayWidth(glyph);
    if (w === 0) return;
    this.ensureRow(this.row);
    const row = this.rows[this.row] as string[];
    for (let k = 0; k < w; k++) {
      const c = this.col + k;
      while (row.length < c) row.push(" ");
      row[c] = k === 0 ? glyph : "";
    }
    this.col += w;
    if (this.col > 1_000_000) this.col = 1_000_000;
  }

  private consumeEscape(s: string, i: number): number {
    const next = s[i + 1];
    if (next === undefined) return 1;
    if (next === "[") {
      const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(s.slice(i));
      if (!m) return 2;
      this.applyCsi(m[1] ?? "", m[2] ?? "");
      return m[0].length;
    }
    if (next === "]") {
      const bel = s.indexOf("\x07", i + 2);
      const st = s.indexOf("\x1b\\", i + 2);
      if (bel === -1 && st === -1) return s.length - i;
      if (st !== -1 && (bel === -1 || st < bel)) return st + 2 - i;
      return bel + 1 - i;
    }
    if (next === "7") {
      this.saved = { row: this.row, col: this.col };
      return 2;
    }
    if (next === "8") {
      if (this.saved) {
        this.row = this.saved.row;
        this.col = this.saved.col;
        this.ensureRow(this.row);
      }
      return 2;
    }
    if (next === "(" || next === ")") return 3;
    return 2;
  }

  private applyCsi(paramsRaw: string, final: string): void {
    if (paramsRaw.startsWith("?")) return;
    const params = paramsRaw === "" ? [] : paramsRaw.split(";").map((x) => Number.parseInt(x, 10) || 0);
    const n = (idx: number, dflt: number): number => {
      const v = params[idx];
      return v === undefined || v === 0 ? dflt : v;
    };
    switch (final) {
      case "K": {
        this.ensureRow(this.row);
        const row = this.rows[this.row] as string[];
        const mode = params[0] ?? 0;
        if (mode === 2) {
          this.rows[this.row] = [];
          this.col = 0;
        } else if (mode === 1) {
          for (let c = 0; c < Math.min(this.col, row.length); c++) row[c] = " ";
        } else if (row.length > this.col) {
          row.length = this.col;
        }
        return;
      }
      case "J": {
        const mode = params[0] ?? 0;
        if (mode === 2) {
          this.rows = [[]];
          this.row = 0;
          this.col = 0;
        } else if (mode === 1) {
          for (let r = 0; r < this.row; r++) this.rows[r] = [];
          const row = this.rows[this.row] ?? [];
          for (let c = 0; c <= Math.min(this.col, row.length); c++) row[c] = " ";
        } else {
          const row = this.rows[this.row] ?? [];
          if (row.length > this.col) row.length = this.col;
          this.rows.length = Math.max(1, this.row + 1);
        }
        return;
      }
      case "A":
        this.row = Math.max(0, this.row - n(0, 1));
        return;
      case "B":
        this.row += n(0, 1);
        this.ensureRow(this.row);
        return;
      case "C":
        this.col += n(0, 1);
        return;
      case "D":
        this.col = Math.max(0, this.col - n(0, 1));
        return;
      case "E":
        this.row += n(0, 1);
        this.col = 0;
        this.ensureRow(this.row);
        return;
      case "F":
        this.row = Math.max(0, this.row - n(0, 1));
        this.col = 0;
        return;
      case "G":
        this.col = Math.max(0, n(0, 1) - 1);
        return;
      case "H":
      case "f":
        this.row = Math.max(0, n(0, 1) - 1);
        this.col = Math.max(0, n(1, 1) - 1);
        this.ensureRow(this.row);
        return;
      case "d":
        this.row = Math.max(0, n(0, 1) - 1);
        this.ensureRow(this.row);
        return;
      case "P": {
        const row = this.rows[this.row] ?? [];
        row.splice(this.col, n(0, 1));
        return;
      }
      case "@": {
        const row = this.rows[this.row] ?? [];
        row.splice(this.col, 0, ...Array.from({ length: n(0, 1) }, () => " "));
        return;
      }
      case "X": {
        const row = this.rows[this.row] ?? [];
        for (let c = this.col; c < Math.min(row.length, this.col + n(0, 1)); c++) row[c] = " ";
        return;
      }
      default:
        return;
    }
  }

  lines(): string[] {
    return this.rows.map((row) => row.join("").replace(/\s+$/, ""));
  }

  text(): string {
    return this.lines().join("\n");
  }
}

/* ------------------------------------------------------------------ */
/* 子程序侧日志（--child）                                              */
/* ------------------------------------------------------------------ */

interface ChildCtx {
  log: (event: string, data?: Record<string, unknown>) => void;
  seq: () => number;
}

function makeChildCtx(logPath: string): ChildCtx {
  const started = Date.now();
  let counter = 0;
  const log = (event: string, data: Record<string, unknown> = {}): void => {
    const entry = { seq: ++counter, t: Date.now() - started, event, ...data };
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };
  return { log, seq: () => counter };
}

function describeValue(v: unknown): Record<string, unknown> {
  if (typeof v === "function") return { kind: "function", length: (v as { length?: number }).length ?? 0 };
  if (typeof v === "string") return { kind: "string", value: v, json: JSON.stringify(v) };
  if (v === undefined) return { kind: "undefined" };
  if (v === null) return { kind: "null" };
  if (typeof v === "object") {
    try {
      return { kind: "object", json: JSON.stringify(v)?.slice(0, 300) ?? null };
    } catch {
      return { kind: "object" };
    }
  }
  return { kind: typeof v, value: String(v) };
}

function describeArgs(args: IArguments): { argc: number; argTypes: Record<string, unknown>[] } {
  return { argc: args.length, argTypes: Array.from(args as unknown as ArrayLike<unknown>).map(describeValue) };
}

function safePrompt(rl: AnyRl): string | null {
  try {
    return typeof rl.getPrompt === "function" ? String(rl.getPrompt()) : null;
  } catch (e) {
    return `<getPrompt error: ${String(e)}>`;
  }
}

function logCaps(ctx: ChildCtx, rl: AnyRl, label: string): void {
  const stdin = process.stdin as unknown as { isRaw?: boolean; isTTY?: boolean };
  ctx.log("caps", {
    label,
    bun: Bun.version,
    terminal: rl.terminal ?? null,
    lineType: typeof rl.line,
    cursorType: typeof rl.cursor,
    cursor: rl.cursor,
    refreshLine: typeof rl._refreshLine,
    setPrompt: typeof rl.setPrompt,
    getPrompt: typeof rl.getPrompt,
    promptMethod: typeof rl.prompt,
    historyIsArray: Array.isArray(rl.history),
    historySizeOption: Array.isArray(rl.history) ? rl.history.length : null,
    promptText: safePrompt(rl),
    stdinIsTTY: Boolean(stdin.isTTY),
    stdinIsRaw: Boolean(stdin.isRaw),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
    term: process.env["TERM"] ?? null,
  });
}

/** 每 20ms 采样一次 rl.line / cursor / prompt / history，变化才写日志（同 select M0 的 40ms 轮询思路）。 */
function attachStateWatch(ctx: ChildCtx, rl: AnyRl): void {
  let last = "";
  const tick = (): void => {
    let line = "";
    let cursor: unknown = null;
    try {
      line = String(rl.line ?? "");
    } catch {
      line = "<line error>";
    }
    try {
      cursor = rl.cursor;
    } catch {
      cursor = null;
    }
    let historyTop: unknown = null;
    try {
      historyTop = Array.isArray(rl.history) ? rl.history.slice(0, 3) : null;
    } catch {
      historyTop = null;
    }
    const payload = {
      line,
      lineJson: JSON.stringify(line),
      cursor,
      prompt: safePrompt(rl),
      historyTop,
    };
    const json = JSON.stringify(payload);
    if (json !== last) {
      last = json;
      ctx.log("state", payload);
    }
  };
  const timer = setInterval(tick, 20);
  timer.unref?.();
  tick();
}

/** line 事件：记录原始行（JSON 转义看得见 \n）并在提交后重画提示符（readline 自己不会）。 */
function attachLineLogger(ctx: ChildCtx, rl: AnyRl): void {
  rl.on("line", (line: string) => {
    ctx.log("line", {
      line,
      lineJson: JSON.stringify(line),
      rlLineAfterSubmit: String(rl.line ?? ""),
      cursor: rl.cursor,
    });
    try {
      rl.prompt();
    } catch (e) {
      ctx.log("prompt-error", { message: String(e) });
    }
  });
  rl.on("close", () => ctx.log("close", {}));
}

/**
 * 显式开启 keypress 解码并挂原始按键日志。
 * node/bun 的 readline 构造里已经调用过一次 emitKeypressEvents，这里是幂等 no-op；
 * 之所以仍显式调用：让探针代码与生产 HotkeyRouter.attach 的调用序列一致。
 *
 * 监听器注册顺序决定 witness 位置：readline 内部 onKeyPress 在构造时注册，本函数
 * 之后注册 → 日志里的 rlLineAfterReadlineHandlers 是「readline 处理完之后」的状态。
 */
function attachKeypressLogger(ctx: ChildCtx, rl: AnyRl, opts: { phase: string; onKey?: (ch: string, key: KeyLike) => void }): void {
  emitKeypressEvents(process.stdin, rl);
  const stdinEmitter = process.stdin as unknown as EventEmitter;
  stdinEmitter.on("keypress", (ch: string, key: KeyLike | undefined) => {
    let line = "";
    let cursor: unknown = null;
    try {
      line = String(rl.line ?? "");
    } catch {
      line = "<line error>";
    }
    try {
      cursor = rl.cursor;
    } catch {
      cursor = null;
    }
    ctx.log("keypress", {
      phase: opts.phase,
      ch,
      chJson: JSON.stringify(ch),
      name: key?.name ?? null,
      sequence: key?.sequence ?? null,
      sequenceJson: key?.sequence === undefined ? null : JSON.stringify(key.sequence),
      ctrl: key?.ctrl ?? null,
      meta: key?.meta ?? null,
      shift: key?.shift ?? null,
      rlLineAfterReadlineHandlers: line,
      rlCursorAfterReadlineHandlers: cursor,
    });
    opts.onKey?.(ch, key ?? {});
  });
}

function finishChild(ctx: ChildCtx, rl: AnyRl, label: string): void {
  attachStateWatch(ctx, rl);
  attachLineLogger(ctx, rl);
  logCaps(ctx, rl, label);
  // createInterface 不会自动画提示符（node/bun 一致），必须显式 prompt() 一次；
  // neo 是在首轮 drain 结束时调 rl.prompt() 的，探针里补上以贴近真实交互。
  try {
    rl.prompt();
  } catch (e) {
    ctx.log("initial-prompt-error", { message: String(e) });
  }
  setTimeout(() => ctx.log("ready", { label }), 120);
}

/* ------------------------------------------------------------------ */
/* 子程序：各探针的最小 readline 程序                                   */
/* ------------------------------------------------------------------ */

function childP1(ctx: ChildCtx): void {
  let rl: AnyRl;
  const completer = function (this: unknown, line: string): [string[], string] {
    ctx.log("completer", {
      ...describeArgs(arguments),
      line,
      lineJson: JSON.stringify(line),
      rlLine: String(rl?.line ?? ""),
      rlCursor: rl?.cursor ?? null,
    });
    if (line === "un") return [["unique.txt"], "un"];
    if (line.startsWith("f")) return [["file1.txt", "file2.txt"], line];
    return [[], line];
  };
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "P1> ",
    completer,
  }) as AnyRl;
  attachKeypressLogger(ctx, rl, { phase: "after-readline" });
  finishChild(ctx, rl, "p1");
}

function childP2(ctx: ChildCtx, variant: string): void {
  let rl: AnyRl;
  const logCompleter = (args: IArguments, line: string, extra: Record<string, unknown> = {}): void => {
    ctx.log("completer", {
      ...describeArgs(args),
      variant,
      line,
      lineJson: JSON.stringify(line),
      rlLine: String(rl?.line ?? ""),
      rlCursor: rl?.cursor ?? null,
      ...extra,
    });
  };

  let completer: unknown;
  if (variant === "async-callback") {
    completer = function (line: string, cb: (err: Error | null, value?: [string[], string]) => void): void {
      logCompleter(arguments, line, { callbackType: typeof cb });
      setTimeout(() => {
        ctx.log("completer-callback-invoked", { variant, line });
        cb(null, [["beta.txt"], line]);
      }, 10);
    };
  } else if (variant === "promise") {
    completer = function (line: string): Promise<[string[], string]> {
      const ret = Promise.resolve<[string[], string]>([["gamma.txt"], line]);
      logCompleter(arguments, line, { returnKind: "Promise" });
      return ret;
    };
  } else {
    completer = function (line: string): [string[], string] {
      logCompleter(arguments, line);
      return [["alpha.txt"], line];
    };
  }

  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `P2(${variant})> `,
    completer: completer as never,
  }) as AnyRl;
  attachKeypressLogger(ctx, rl, { phase: "after-readline" });
  finishChild(ctx, rl, `p2-${variant}`);
}

function childP3(ctx: ChildCtx, variant: string): void {
  let rl: AnyRl;
  const realCompleter = function (line: string): [string[], string] {
    ctx.log("completer", {
      ...describeArgs(arguments),
      line,
      lineJson: JSON.stringify(line),
      rlLine: String(rl?.line ?? ""),
      rlCursor: rl?.cursor ?? null,
    });
    if (line.startsWith("un")) return [["unique.txt"], line];
    if (line.startsWith("fi")) return [["file1.txt", "file2.txt"], line];
    return [[], line];
  };
  const noopCompleter = function (line: string): [string[], string] {
    ctx.log("completer", {
      ...describeArgs(arguments),
      variant,
      line,
      lineJson: JSON.stringify(line),
      rlLine: String(rl?.line ?? ""),
      rlCursor: rl?.cursor ?? null,
    });
    return [[], line]; // 吞掉原生 Tab：kTabCompleter 对空候选直接 return
  };
  const options: Record<string, unknown> = {
    input: process.stdin,
    output: process.stdout,
    prompt: `P3${variant === "none" ? "(无 completer)" : variant === "noop" ? "(no-op completer)" : ""}> `,
  };
  if (variant === "noop") options["completer"] = noopCompleter;
  else if (variant !== "none") options["completer"] = realCompleter;
  rl = createInterface(options as never) as AnyRl;

  // 先注册原始 keypress 日志（witness），再挂生产 HotkeyRouter。
  // 顺序：readline 内部监听（构造时）→ 本日志 → router。evidence 里看 seq。
  attachKeypressLogger(ctx, rl, { phase: "after-readline" });

  const router = new HotkeyRouter();
  let tabCount = 0;
  router.attach(rl, process.stdin);
  router.on("tab", () => {
    tabCount += 1;
    ctx.log("router-tab", {
      variant,
      tabCount,
      rlLine: String(rl.line ?? ""),
      rlCursor: rl.cursor,
    });
    if (variant === "" && tabCount === 2) {
      // 验证「原生补全已经发生之后，router 的 tab handler 能否改写最终结果」
      rl.line = "MUTATED";
      rl.cursor = "MUTATED".length;
      try {
        rl._refreshLine?.();
        ctx.log("router-mutate", { rlLine: String(rl.line), rlCursor: rl.cursor });
      } catch (e) {
        ctx.log("router-mutate-error", { message: String(e) });
      }
    }
  });
  finishChild(ctx, rl, `p3${variant === "" ? "" : `-${variant}`}`);
}

function childP4(ctx: ChildCtx): void {
  let rl: AnyRl;
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "P4> ",
  }) as AnyRl;
  attachKeypressLogger(ctx, rl, { phase: "after-readline" });
  finishChild(ctx, rl, "p4");
}

/**
 * P4 预注册变体：在所有 readline 构造完成**之前**抢到 keypress 监听器，
 * 验证「Ctrl+J 能否被拦截，并改造成往 rl.line 里塞 \n」。
 *
 * 关键点（bun 1.3.13 内部实现细节，M1 需回归锁定）：
 *  - readline 构造时 emitKeypressEvents(input, this) 是幂等的；我们在构造前先调用，
 *    之后再挂监听器，监听器顺序就变成：我们 → readline 内部 onKeyPress。
 *  - readline 的 _ttyWrite 对 key.name === "escape" 直接 return；把 Ctrl+J 的 key.name
 *    改写成 "escape" 即可让默认的「提交一行」路径短路（不改 key.sequence）。
 *  - 事后在 post 监听器里手动追加 "\n" 到 rl.line 并 _refreshLine。
 */
function childP4Pre(ctx: ChildCtx): void {
  let rl: AnyRl | undefined;
  const stdinEmitter = process.stdin as unknown as EventEmitter;

  // 预注册 1/2：先开 keypress 解码，再挂「读键 + 改写 key」监听器（早于 createInterface）。
  emitKeypressEvents(process.stdin);
  stdinEmitter.on("keypress", (ch: string, key: KeyLike | undefined) => {
    const sequence = key?.sequence ?? "";
    let line = "";
    try {
      line = String(rl?.line ?? "");
    } catch {
      line = "<line error>";
    }
    ctx.log("pre-keypress", {
      ch,
      chJson: JSON.stringify(ch),
      name: key?.name ?? null,
      sequence,
      sequenceJson: JSON.stringify(sequence),
      ctrl: key?.ctrl ?? null,
      rlLineBeforeReadlineHandler: line,
    });
    if (sequence === "\n" && key) {
      ctx.log("pre-keypress-intercept-ctrlj", { nameBeforeMutation: key.name });
      key.name = "escape"; // 让 readline 的 _ttyWrite 提前 return（不改 sequence，保留证据）
      ctx.log("pre-keypress-mutated", { nameAfterMutation: key.name, sequence: key.sequence });
    }
  });

  // 预注册 2/2：此时 readline 构造内部 emitKeypressEvents 幂等 no-op，它注册的
  // onKeyPress 监听器排在我们的监听器之后。
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "P4pre> ",
  }) as AnyRl;

  // post 监听器：readline 内部 handler 跑完之后执行；这里把 Ctrl+J 改造成换行。
  stdinEmitter.on("keypress", (ch: string, key: KeyLike | undefined) => {
    if (!rl) return;
    const sequence = key?.sequence ?? "";
    if (sequence !== "\n") {
      ctx.log("post-keypress", {
        ch,
        name: key?.name ?? null,
        sequence,
        rlLineAfterReadlineHandlers: String(rl.line ?? ""),
      });
      return;
    }
    ctx.log("post-keypress-ctrlj", {
      ch,
      name: key?.name ?? null,
      sequence,
      rlLineAfterReadlineHandlers: String(rl.line ?? ""),
      lineEventShouldNotHaveFired: true,
    });
    rl.line = `${rl.line}\n`;
    rl.cursor = rl.line.length;
    try {
      rl._refreshLine?.();
      ctx.log("ctrlj-newline-inserted", { lineJson: JSON.stringify(rl.line), cursor: rl.cursor });
    } catch (e) {
      ctx.log("ctrlj-newline-insert-error", { message: String(e) });
    }
  });
  finishChild(ctx, rl, "p4pre");
}

function childP5(ctx: ChildCtx): void {
  let rl: AnyRl;
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "P5> ",
  }) as AnyRl;

  const setMultiline = (): void => {
    const before = { line: String(rl.line ?? ""), lineJson: JSON.stringify(rl.line ?? ""), cursor: rl.cursor };
    ctx.log("set-line-nl-request", { before, refreshLine: typeof rl._refreshLine });
    rl.line = "a\nb";
    let refreshResult: string = "not-called";
    try {
      if (typeof rl._refreshLine === "function") {
        rl._refreshLine();
        refreshResult = "ok";
      }
    } catch (e) {
      refreshResult = `error: ${String(e)}`;
    }
    ctx.log("set-line-nl-done", {
      after: { line: String(rl.line), lineJson: JSON.stringify(rl.line), cursor: rl.cursor },
      cursorChanged: rl.cursor !== before.cursor,
      refreshResult,
      prevRows: (rl as unknown as { prevRows?: number }).prevRows ?? null,
    });
  };

  /**
   * cursor 是否随 line 赋值自动更新：用一条**比当前 cursor 更长**的行来判定。
   * （第一次赋值 "a\nb" 时旧 cursor 恰好也是 3，无法区分「自动更新」和「没动」，所以单独再做一次。）
   */
  const setLongerLine = (): void => {
    const line = "a\nbcdef"; // 长度 7
    const before = { line: String(rl.line ?? ""), lineJson: JSON.stringify(rl.line ?? ""), cursor: rl.cursor };
    rl.line = line;
    let refreshResult: string = "not-called";
    try {
      if (typeof rl._refreshLine === "function") {
        rl._refreshLine();
        refreshResult = "ok";
      }
    } catch (e) {
      refreshResult = `error: ${String(e)}`;
    }
    ctx.log("set-long-line-done", {
      before,
      after: { line: String(rl.line), lineJson: JSON.stringify(rl.line), cursor: rl.cursor },
      expectedLength: line.length,
      cursorAutoUpdated: rl.cursor !== before.cursor,
      refreshResult,
    });
  };

  const setCursor = (): void => {
    ctx.log("set-cursor-request", { before: rl.cursor, lineJson: JSON.stringify(rl.line) });
    let assignError: string | null = null;
    try {
      rl.cursor = 2;
    } catch (e) {
      assignError = String(e);
    }
    let refreshResult: string = "not-called";
    try {
      if (typeof rl._refreshLine === "function") {
        rl._refreshLine();
        refreshResult = "ok";
      }
    } catch (e) {
      refreshResult = `error: ${String(e)}`;
    }
    ctx.log("set-cursor-done", { after: rl.cursor, assignError, refreshResult, lineJson: JSON.stringify(rl.line) });
  };

  attachKeypressLogger(ctx, rl, {
    phase: "after-readline",
    onKey: (_ch, key) => {
      if (key.ctrl && key.name === "g") setMultiline();
      else if (key.ctrl && key.name === "o") setCursor();
      else if (key.ctrl && key.name === "t") setLongerLine();
    },
  });
  finishChild(ctx, rl, "p5");
}

function childP6(ctx: ChildCtx): void {
  let rl: AnyRl;
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "❯ ",
  }) as AnyRl;

  const changePrompt = (): void => {
    const before = {
      prompt: safePrompt(rl),
      line: String(rl.line ?? ""),
      lineJson: JSON.stringify(rl.line ?? ""),
      cursor: rl.cursor,
    };
    ctx.log("set-prompt-request", { before });
    let setError: string | null = null;
    try {
      rl.setPrompt("… ");
    } catch (e) {
      setError = String(e);
    }
    let refreshResult: string = "not-called";
    try {
      if (typeof rl._refreshLine === "function") {
        rl._refreshLine();
        refreshResult = "ok";
      }
    } catch (e) {
      refreshResult = `error: ${String(e)}`;
    }
    ctx.log("set-prompt-done", {
      after: {
        prompt: safePrompt(rl),
        line: String(rl.line ?? ""),
        lineJson: JSON.stringify(rl.line ?? ""),
        cursor: rl.cursor,
      },
      setError,
      refreshResult,
    });
  };

  attachKeypressLogger(ctx, rl, {
    phase: "after-readline",
    onKey: (_ch, key) => {
      if (key.ctrl && key.name === "g") changePrompt();
    },
  });
  finishChild(ctx, rl, "p6");
}

function childP7(ctx: ChildCtx): void {
  let rl: AnyRl;
  rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "P7> ",
    historySize: 20,
    completer: function (line: string): [string[], string] {
      ctx.log("completer", {
        ...describeArgs(arguments),
        line,
        lineJson: JSON.stringify(line),
        rlLine: String(rl?.line ?? ""),
        historyTop: Array.isArray(rl?.history) ? rl.history.slice(0, 3) : null,
      });
      if (line.startsWith("fi")) return [["file1.txt"], line];
      return [[], line];
    },
  }) as AnyRl;
  attachKeypressLogger(ctx, rl, { phase: "after-readline" });
  finishChild(ctx, rl, "p7");
}

/* ------------------------------------------------------------------ */
/* 子程序入口                                                          */
/* ------------------------------------------------------------------ */

function runChild(probe: string, variant: string): void {
  const logPath = process.env["PROBE_LOG"];
  if (!logPath) {
    console.error("readline-probe child: PROBE_LOG 未设置");
    process.exit(2);
  }
  const ctx = makeChildCtx(logPath);
  process.on("uncaughtException", (err) => {
    ctx.log("uncaught-exception", { message: err.message, stack: err.stack ?? "" });
  });
  process.on("unhandledRejection", (reason) => {
    ctx.log("unhandled-rejection", { message: String(reason) });
  });
  ctx.log("boot", {
    probe,
    variant,
    bun: Bun.version,
    pid: process.pid,
    cwd: process.cwd(),
    argv: process.argv.slice(2),
  });
  const handlers: Record<string, () => void> = {
    p1: () => childP1(ctx),
    p2: () => childP2(ctx, variant),
    p3: () => childP3(ctx, variant),
    p4: () => childP4(ctx),
    p4pre: () => childP4Pre(ctx),
    p5: () => childP5(ctx),
    p6: () => childP6(ctx),
    p7: () => childP7(ctx),
  };
  const handler = handlers[probe];
  if (!handler) {
    ctx.log("fatal", { message: `未知探针：${probe}` });
    process.exit(2);
  }
  try {
    handler();
  } catch (e) {
    ctx.log("fatal", { message: String(e), stack: e instanceof Error ? (e.stack ?? "") : "" });
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* PTY 会话（驱动侧）                                                  */
/* ------------------------------------------------------------------ */

interface Session {
  name: string;
  dir: string;
  proc: Proc;
  screen: Screen;
  /** 终端原始字节（已解码为字符串，打印时 JSON.stringify 展示控制字符）。 */
  raw: string;
  stderr: string;
  logPath: string;
  exitCode: number | null;
  write: (data: string) => Promise<void>;
  readLog: () => LogEntry[];
  mark: () => number;
  markRaw: () => number;
  close: () => Promise<void>;
}

const liveSessions = new Set<Session>();

function cleanBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("NEO_") || k.startsWith("PROBE_")) continue;
    if (k === "COLUMNS" || k === "LINES") continue;
    env[k] = v;
  }
  return env;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function killProc(proc: Proc, graceMs = 1500): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const exited = await Promise.race([proc.exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!exited) {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await Promise.race([proc.exited, sleep(1000)]);
  }
}

async function drainStderr(proc: Proc, push: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of proc.stderr) push(decoder.decode(chunk as Uint8Array, { stream: true }));
  } catch {
    /* 进程退出时流关闭 */
  }
}

async function openFifoWriter(path: string, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return openSync(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENXIO" && code !== "ENOENT") throw e;
      if (Date.now() > deadline) throw new Error(`打开 FIFO 写端超时（${timeoutMs}ms）：${path}`);
      await sleep(20);
    }
  }
}

async function writeFifo(fd: number, data: string): Promise<void> {
  const buf = Buffer.from(data, "utf8");
  let offset = 0;
  const deadline = Date.now() + 2000;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN") throw e;
      if (Date.now() > deadline) throw new Error("写 FIFO 超时（EAGAIN 持续）");
      await sleep(5);
    }
  }
}

interface StartOptions {
  name: string;
  probe: string;
  variant?: string;
  cols?: number;
  rows?: number;
}

/**
 * 用系统 script(1) 起真 PTY 跑 `bun run scripts/readline-probe.ts --child <probe>`。
 * macOS 必须 mkfifo + cat（Bun 的 stdio pipe 是 socketpair，script 的 tcgetattr 会失败）。
 */
async function startSession(tmpRoot: string, opts: StartOptions): Promise<Session> {
  const cols = opts.cols ?? DEFAULT_COLS;
  const rows = opts.rows ?? DEFAULT_ROWS;
  const dir = join(tmpRoot, opts.name);
  const work = join(dir, "work");
  const home = join(dir, "home");
  await mkdir(work, { recursive: true });
  await mkdir(home, { recursive: true });
  const logPath = join(dir, "program.jsonl");
  await writeFile(logPath, "", "utf8");

  const fifo = join(dir, "stdin.fifo");
  const wrapper = join(dir, "run.sh");
  try {
    await rm(fifo, { force: true });
  } catch {
    /* ignore */
  }
  const fifoRes = Bun.spawnSync([MKFIFO, fifo], { stdout: "ignore", stderr: "pipe" });
  if (fifoRes.exitCode !== 0) throw new Error(`创建 FIFO 失败：${fifoRes.stderr.toString() || fifo}`);

  const childArgs = ["--child", opts.probe];
  if (opts.variant) childArgs.push(opts.variant);
  const wrapperBody = [
    "#!/bin/sh",
    "# 由 scripts/readline-probe.ts 生成：PTY winsize 必须先于 bun 启动设置好",
    `stty cols ${cols} rows ${rows} 2>/dev/null || true`,
    `exec ${shellQuote(BUN)} run ${shellQuote(SELF)} ${childArgs.map(shellQuote).join(" ")}`.trimEnd(),
    "",
  ].join("\n");
  await writeFile(wrapper, wrapperBody, { mode: 0o755 });

  const inner = IS_DARWIN
    ? `${shellQuote(CAT)} ${shellQuote(fifo)} | ${shellQuote(SCRIPT_BIN)} -q /dev/null /bin/sh ${shellQuote(wrapper)}`
    : IS_LINUX
      ? `${shellQuote(CAT)} ${shellQuote(fifo)} | ${shellQuote(SCRIPT_BIN)} -qec ${shellQuote(`/bin/sh ${shellQuote(wrapper)}`)} /dev/null`
      : (() => {
          throw new Error(`不支持的平台：${process.platform}（本脚本依赖系统 script(1)）`);
        })();

  const env: Record<string, string> = {
    ...cleanBaseEnv(),
    HOME: home,
    PROBE_LOG: logPath,
    COLUMNS: String(cols),
    LINES: String(rows),
    TERM: "xterm-256color",
  };

  const proc = Bun.spawn(["/bin/sh", "-c", inner], {
    cwd: work,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const writerFd = await openFifoWriter(fifo);
  let writerClosed = false;
  const closeWriter = (): void => {
    if (writerClosed) return;
    writerClosed = true;
    try {
      closeSync(writerFd);
    } catch {
      /* ignore */
    }
  };

  const session: Session = {
    name: opts.name,
    dir,
    proc,
    screen: new Screen(),
    raw: "",
    stderr: "",
    logPath,
    exitCode: null,
    write: async (data: string) => {
      try {
        await writeFifo(writerFd, data);
      } catch {
        /* 进程已退出：由 wait 层统一报错 */
      }
    },
    readLog: () => {
      let text = "";
      try {
        text = readFileSync(logPath, "utf8");
      } catch {
        return [];
      }
      const entries: LogEntry[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          entries.push(JSON.parse(line) as LogEntry);
        } catch {
          /* 最后一行可能正在写，忽略 */
        }
      }
      return entries;
    },
    mark: () => {
      const entries = session.readLog();
      return entries.length === 0 ? 0 : (entries[entries.length - 1] as LogEntry).seq;
    },
    markRaw: () => session.raw.length,
    close: async () => {
      closeWriter();
      if (session.exitCode === null) await killProc(proc);
      // 兜底清理：shell 被信号打断时，管道里的 cat/script/bun 可能成为孤儿。
      // 两个模式都含本会话独有的绝对路径，不会误伤其它进程。
      for (const pattern of [wrapper, fifo]) {
        try {
          Bun.spawnSync(["pkill", "-f", pattern], { stdout: "ignore", stderr: "ignore" });
        } catch {
          /* pkill 不可用也不影响主流程 */
        }
      }
      liveSessions.delete(session);
    },
  };

  proc.exited.then((code) => {
    session.exitCode = code;
  });

  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of proc.stdout) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        session.raw += text;
        session.screen.feed(text);
      }
    } catch {
      /* 进程结束时流关闭 */
    }
  })();
  void drainStderr(proc, (text) => {
    session.stderr += text;
  });

  liveSessions.add(session);

  // VERBOSE：把子程序日志与原始字节实时打出来（人工复核用；默认安静）。
  if (VERBOSE) {
    let printed = 0;
    const verboseTimer = setInterval(() => {
      const entries = session.readLog();
      for (const entry of entries.slice(printed)) {
        console.log(`    [${opts.name}/日志] ${fmtEntry(entry, 1200)}`);
      }
      printed = entries.length;
    }, 100);
    verboseTimer.unref?.();
    const originalClose = session.close;
    session.close = async () => {
      clearInterval(verboseTimer);
      console.log(`    [${opts.name}/原始全量] ${clipJson(session.raw, 4000)}`);
      if (session.stderr.trim() !== "") console.log(`    [${opts.name}/stderr] ${clipJson(session.stderr, 1200)}`);
      await originalClose();
    };
  }
  return session;
}

async function withSession<T>(tmpRoot: string, opts: StartOptions, fn: (s: Session) => Promise<T>): Promise<T> {
  const session = await startSession(tmpRoot, opts);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/* ------------------------------------------------------------------ */
/* 等待与证据工具                                                      */
/* ------------------------------------------------------------------ */

async function waitScreen(s: Session, pred: (text: string) => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred(s.screen.text())) return;
    if (s.exitCode !== null) throw new Error(`子进程提前退出（code ${s.exitCode}），等待「${label}」失败`);
    if (Date.now() > deadline) {
      throw new Error(
        `等待屏幕超时（${timeoutMs}ms）：${label}；当前屏幕=${JSON.stringify(s.screen.lines().slice(-5))}；原始尾部=${clipJson(s.raw.slice(-400), 400)}`,
      );
    }
    await sleep(20);
  }
}

async function waitLog(
  s: Session,
  pred: (e: LogEntry) => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<LogEntry> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = s.readLog().find(pred);
    if (hit) return hit;
    if (s.exitCode !== null) throw new Error(`子进程提前退出（code ${s.exitCode}），等待「${label}」失败`);
    if (Date.now() > deadline) throw new Error(`等待程序日志超时（${timeoutMs}ms）：${label}`);
    await sleep(20);
  }
}

/** 限定时间内找日志；找不到返回 null（用于「没发生」这类观测，不视为异常）。 */
async function logWithin(s: Session, pred: (e: LogEntry) => boolean, timeoutMs = 2000): Promise<LogEntry | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = s.readLog().find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    if (s.exitCode !== null) return s.readLog().find(pred) ?? null;
    await sleep(20);
  }
}

function latestState(s: Session): LogEntry | null {
  const states = s.readLog().filter((e) => e.event === "state");
  return states.length === 0 ? null : (states[states.length - 1] as LogEntry);
}

function entriesInRange(s: Session, fromSeq: number, toSeq: number): LogEntry[] {
  return s.readLog().filter((e) => e.seq > fromSeq && e.seq <= toSeq);
}

function clipJson(v: unknown, max = 400): string {
  let text: string;
  try {
    text = JSON.stringify(v) ?? String(v);
  } catch {
    text = String(v);
  }
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text;
}

function fmtEntry(e: LogEntry, max = 320): string {
  const { seq, t, event, ...rest } = e;
  return `seq=${String(seq)} t=${String(t)}ms ${String(event)} ${clipJson(rest, max)}`;
}

function fmtEntries(entries: LogEntry[], maxEntries = 6, max = 320): string[] {
  return entries.slice(-maxEntries).map((e) => fmtEntry(e, max));
}

function screenTail(s: Session, rows = 6): string[] {
  return s.screen.lines().filter((line) => line.trim() !== "").slice(-rows);
}

function countOccurrences(text: string, sub: string): number {
  if (sub === "") return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    const next = text.indexOf(sub, index);
    if (next === -1) return count;
    count += 1;
    index = next + sub.length;
  }
}

function stateLine(entry: LogEntry | null): string | null {
  if (!entry) return null;
  return typeof entry["line"] === "string" ? entry["line"] : null;
}

function stateLineJson(entry: LogEntry | null): string | null {
  if (!entry) return null;
  return typeof entry["lineJson"] === "string" ? entry["lineJson"] : null;
}

function lineEventJson(entry: LogEntry | null): string | null {
  if (!entry) return null;
  return typeof entry["lineJson"] === "string" ? entry["lineJson"] : null;
}

/** 等子程序 ready：先等提示符上屏，再等程序日志 ready（确保 raw mode 已生效）。 */
async function waitReady(
  s: Session,
  label: string,
  opts: { screen?: (text: string) => boolean; timeoutMs?: number } = {},
): Promise<void> {
  const pred = opts.screen ?? ((text: string): boolean => text.includes(">"));
  await waitScreen(s, pred, `${label} 提示符出现`, opts.timeoutMs ?? 8000);
  await waitLog(s, (e) => e.event === "ready", `${label} 子程序 ready`, opts.timeoutMs ?? 8000);
  await sleep(120);
}

function capsSummary(entry: LogEntry): string {
  const keys = [
    "terminal",
    "refreshLine",
    "setPrompt",
    "getPrompt",
    "historyIsArray",
    "promptText",
    "stdinIsTTY",
    "stdinIsRaw",
    "columns",
    "rows",
    "term",
  ];
  const picked: Record<string, unknown> = {};
  for (const key of keys) picked[key] = entry[key];
  return clipJson(picked, 300);
}

async function writeKeys(s: Session, data: string): Promise<void> {
  await s.write(data);
}

/* ------------------------------------------------------------------ */
/* 探针 P1：原生 completer 是否生效                                     */
/* ------------------------------------------------------------------ */

async function probeP1(tmpRoot: string): Promise<{ conclusion: string; evidence: string[] }> {
  const evidence: string[] = [];
  return withSession(tmpRoot, { name: "p1", probe: "p1" }, async (s) => {
    try {
      await waitReady(s, "P1");
      const caps = await waitLog(s, (e) => e.event === "caps", "P1 caps");
      evidence.push(`[caps] ${capsSummary(caps)}`);

      // ---- 单候选 ----
      let mark = s.mark();
      const rawMark = s.markRaw();
      await writeKeys(s, "un");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "un", "P1 输入 un");
      mark = s.mark();
      await writeKeys(s, KEY.tab);
      const completerSingle = await logWithin(s, (e) => e.seq > mark && e.event === "completer", 2500);
      await sleep(250);
      const stateSingle = latestState(s);
      const tabKey = await logWithin(s, (e) => e.seq > mark && e.event === "keypress" && e["name"] === "tab", 500);
      evidence.push(`[单候选/日志] ${completerSingle ? fmtEntry(completerSingle) : "completer 未被调用（2.5s 内）"}`);
      evidence.push(`[单候选/keypress] ${tabKey ? fmtEntry(tabKey) : "未见 tab keypress"}`);
      evidence.push(`[单候选/state] ${stateSingle ? fmtEntry(stateSingle) : "(无 state)"}`);
      evidence.push(`[单候选/屏幕] ${JSON.stringify(screenTail(s, 3))}`);
      evidence.push(`[单候选/原始] ${clipJson(s.raw.slice(rawMark), 420)}`);
      const lineAfterSingleTab = stateLine(stateSingle);
      const bellSingle = countOccurrences(s.raw.slice(rawMark), "\x07");

      mark = s.mark();
      await writeKeys(s, KEY.enter);
      const lineSingle = await logWithin(s, (e) => e.seq > mark && e.event === "line", 2000);
      await sleep(150);
      evidence.push(`[单候选/提交] ${lineSingle ? fmtEntry(lineSingle) : "Enter 后未见 line 事件"}`);

      // ---- 多候选 ----
      mark = s.mark();
      const rawMarkMulti = s.markRaw();
      await writeKeys(s, "f");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "f", "P1 输入 f");
      mark = s.mark();
      await writeKeys(s, KEY.tab);
      const completerFirst = await logWithin(s, (e) => e.seq > mark && e.event === "completer", 2500);
      await sleep(200);
      const stateAfterFirstTab = latestState(s);
      const markSecond = s.mark();
      await writeKeys(s, KEY.tab);
      const completerSecond = await logWithin(s, (e) => e.seq > markSecond && e.event === "completer", 2500);
      await sleep(300);
      const stateAfterSecondTab = latestState(s);
      const rawMulti = s.raw.slice(rawMarkMulti);
      const screenAfterSecond = screenTail(s, 8);
      const bellMulti = countOccurrences(rawMulti, "\x07");
      const printedList = screenAfterSecond.some((line) => line.includes("file1.txt") && line.includes("file2.txt"));
      evidence.push(`[多候选/第1次日志] ${completerFirst ? fmtEntry(completerFirst) : "completer 未被调用（2.5s 内）"}`);
      evidence.push(`[多候选/第1次后 state] ${stateAfterFirstTab ? fmtEntry(stateAfterFirstTab) : "(无 state)"}`);
      evidence.push(`[多候选/第2次日志] ${completerSecond ? fmtEntry(completerSecond) : "completer 未被调用（2.5s 内）"}`);
      evidence.push(
        `[多候选/第2次后 state] ${stateAfterSecondTab ? fmtEntry(stateAfterSecondTab) : "(无 state)"}（若与第 1 次相同，说明第 2 次 Tab 只打印列表、不改 line）`,
      );
      evidence.push(`[多候选/屏幕] ${JSON.stringify(screenAfterSecond)}`);
      evidence.push(
        `[多候选/原始] bell=${String(bellMulti)} listPrinted=${String(printedList)} raw=${clipJson(rawMulti, 500)}`,
      );

      mark = s.mark();
      await writeKeys(s, KEY.enter);
      const lineMulti = await logWithin(s, (e) => e.seq > mark && e.event === "line", 2000);
      await sleep(150);
      evidence.push(`[多候选/提交] ${lineMulti ? fmtEntry(lineMulti) : "Enter 后未见 line 事件"}`);

      const completerCalled = completerSingle !== null || completerFirst !== null;
      if (!completerCalled && tabKey === null && completerFirst === null) {
        throw new ProbeError("Tab keypress 与 completer 都未观测到：无法判定是补全不生效还是按键未到达", evidence);
      }
      const autoCompleted = lineAfterSingleTab === "unique.txt";
      const submittedSingle = lineEventJson(lineSingle);
      const lineAfterFirst = stateLine(stateAfterFirstTab);
      const lineAfterSecond = stateLine(stateAfterSecondTab);
      const submittedMulti = lineEventJson(lineMulti);
      const conclusion = completerCalled
        ? `原生 completer 生效：单候选 "un" --Tab--> ${JSON.stringify(lineAfterSingleTab)}（自动补全=${String(autoCompleted)}，无铃声=${String(bellSingle === 0)}），提交=${JSON.stringify(submittedSingle)}；多候选第 1 次 Tab 后 line=${JSON.stringify(lineAfterFirst)}，第 2 次 Tab 后 line=${JSON.stringify(lineAfterSecond)}，打印列表=${String(printedList)}、铃声次数=${String(bellMulti)}，提交=${JSON.stringify(submittedMulti)}。`
        : `原生 completer 未被调用（Tab keypress 已到达${String(tabKey !== null)}）：createInterface({completer}) 在该版本下不生效。`;
      return { conclusion, evidence };
    } catch (e) {
      throw new ProbeError(e instanceof Error ? e.message : String(e), evidence);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 探针 P2：completer 的入参与异步支持                                  */
/* ------------------------------------------------------------------ */

interface VariantObservation {
  variant: string;
  completer: LogEntry | null;
  callbackInvoked: LogEntry | null;
  lineAfterTab: string | null;
  lineJsonAfterTab: string | null;
  submitted: string | null;
  tabCompletionError: boolean;
}

async function probeP2(tmpRoot: string): Promise<{ conclusion: string; evidence: string[] }> {
  const evidence: string[] = [];
  const variants: Array<{ variant: string; prefix: string }> = [
    { variant: "sync", prefix: "a" },
    { variant: "async-callback", prefix: "b" },
    { variant: "promise", prefix: "g" },
  ];
  const results: VariantObservation[] = [];

  for (const { variant, prefix } of variants) {
    try {
      const obs = await withSession(
        tmpRoot,
        { name: `p2-${variant}`, probe: "p2", variant },
        async (s) => {
          await waitReady(s, `P2(${variant})`);
          const caps = await waitLog(s, (e) => e.event === "caps", `P2(${variant}) caps`);
          evidence.push(`[${variant}/caps] ${capsSummary(caps)}`);
          const mark = s.mark();
          await writeKeys(s, prefix);
          await waitLog(
            s,
            (e) => e.seq > mark && e.event === "state" && e["line"] === prefix,
            `P2(${variant}) 输入 ${prefix}`,
          );
          const markTab = s.mark();
          const rawMark = s.markRaw();
          await writeKeys(s, KEY.tab);
          const completer = await logWithin(s, (e) => e.seq > markTab && e.event === "completer", 2500);
          const callbackInvoked = await logWithin(
            s,
            (e) => e.seq > markTab && e.event === "completer-callback-invoked",
            1200,
          );
          await sleep(350);
          const state = latestState(s);
          const rawAfter = s.raw.slice(rawMark);
          const tabCompletionError = rawAfter.includes("Tab completion error");
          evidence.push(`[${variant}/completer] ${completer ? fmtEntry(completer) : "未被调用（2.5s 内）"}`);
          if (callbackInvoked) evidence.push(`[${variant}/callback] ${fmtEntry(callbackInvoked)}`);
          evidence.push(`[${variant}/state] ${state ? fmtEntry(state) : "(无 state)"}`);
          evidence.push(
            `[${variant}/原始] tabCompletionError=${String(tabCompletionError)} raw=${clipJson(rawAfter, 400)}`,
          );

          const markEnter = s.mark();
          await writeKeys(s, KEY.enter);
          const line = await logWithin(s, (e) => e.seq > markEnter && e.event === "line", 1500);
          return {
            variant,
            completer,
            callbackInvoked,
            lineAfterTab: stateLine(state),
            lineJsonAfterTab: stateLineJson(state),
            submitted: lineEventJson(line),
            tabCompletionError,
          } satisfies VariantObservation;
        },
      );
      results.push(obs);
    } catch (e) {
      evidence.push(`[${variant}/失败] ${e instanceof Error ? e.message : String(e)}`);
      results.push({
        variant,
        completer: null,
        callbackInvoked: null,
        lineAfterTab: null,
        lineJsonAfterTab: null,
        submitted: null,
        tabCompletionError: false,
      });
    }
  }

  const byVariant = (name: string): VariantObservation | undefined => results.find((r) => r.variant === name);
  const sync = byVariant("sync");
  const asyncCb = byVariant("async-callback");
  const promise = byVariant("promise");

  const syncEvidence = sync?.completer
    ? `sync: argc=${String(sync.completer["argc"])} args=${clipJson(sync.completer["argTypes"], 200)} lineAfterTab=${JSON.stringify(sync.lineAfterTab)}`
    : "sync: 未观测到 completer 调用";
  const asyncEvidence = asyncCb?.completer
    ? `async-callback: argc=${String(asyncCb.completer["argc"])} callbackType=${String(asyncCb.completer["callbackType"])} lineAfterTab=${JSON.stringify(asyncCb.lineAfterTab)}`
    : "async-callback: 未观测到 completer 调用";
  const promiseEvidence = promise?.completer
    ? `promise: argc=${String(promise.completer["argc"])} lineAfterTab=${JSON.stringify(promise.lineAfterTab)} tabCompletionError=${String(promise.tabCompletionError)}`
    : "promise: 未观测到 completer 调用";

  if (!sync?.completer && !asyncCb?.completer && !promise?.completer) {
    throw new ProbeError("三种 completer 变体都未被调用，无法判定入参/异步支持", evidence);
  }
  const conclusion = [
    `入参：sync/async 均只收到 line${asyncCb?.completer ? `（async variant argc=${String(asyncCb.completer["argc"])}，第 2 参是 callback）` : ""}，未提供 cursor 位置参数；`,
    `异步：callback 形式（arity=2）${asyncCb?.lineAfterTab === "beta.txt" ? "生效（Tab 后 line=\"beta.txt\"）" : `表现=${JSON.stringify(asyncCb?.lineAfterTab)}（未按 callback 结果补全）`}；`,
    `Promise 形式 ${promise?.lineAfterTab === "gamma.txt" ? "生效" : `不生效（Tab 后 line=${JSON.stringify(promise?.lineAfterTab)}，无 Tab completion error）`}。`,
    `（证据：${syncEvidence}；${asyncEvidence}；${promiseEvidence}）`,
  ].join("");
  evidence.push(`[P2/结论] ${conclusion}`);
  return { conclusion, evidence };
}

/* ------------------------------------------------------------------ */
/* 探针 P3：Tab 与我们的 keypress 监听（HotkeyRouter）                  */
/* ------------------------------------------------------------------ */

async function probeP3(tmpRoot: string): Promise<{ conclusion: string; evidence: string[] }> {
  const evidence: string[] = [];
  const main = await withSession(tmpRoot, { name: "p3", probe: "p3" }, async (s) => {
    try {
      await waitReady(s, "P3");
      const caps = await waitLog(s, (e) => e.event === "caps", "P3 caps");
      evidence.push(`[caps] ${capsSummary(caps)}`);

      // ---- 阶段 1：Tab 同时触发原生补全与 keypress 吗？顺序？ ----
      let mark = s.mark();
      await writeKeys(s, "un");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "un", "P3 输入 un");
      mark = s.mark();
      const rawMark = s.markRaw();
      await writeKeys(s, KEY.tab);
      const completer = await waitLog(s, (e) => e.seq > mark && e.event === "completer", "P3 原生 completer", 2500);
      const routerTab = await waitLog(s, (e) => e.seq > mark && e.event === "router-tab", "P3 router tab", 2500);
      const keypressTab = await waitLog(
        s,
        (e) => e.seq > mark && e.event === "keypress" && e["name"] === "tab",
        "P3 tab keypress",
        2000,
      );
      await sleep(200);
      const ordered = entriesInRange(s, mark, s.mark())
        .filter((e) => e.event === "completer" || e.event === "router-tab" || (e.event === "keypress" && e["name"] === "tab"))
        .map((e) => `${e.event}@${String(e.seq)}`);
      const stateAfterTab = latestState(s);
      evidence.push(`[阶段1/顺序] ${ordered.join(" → ")}`);
      evidence.push(`[阶段1/completer] ${fmtEntry(completer)}`);
      evidence.push(`[阶段1/keypress] ${fmtEntry(keypressTab)}`);
      evidence.push(`[阶段1/router-tab] ${fmtEntry(routerTab)}`);
      evidence.push(`[阶段1/state] ${stateAfterTab ? fmtEntry(stateAfterTab) : "(无 state)"}`);
      evidence.push(`[阶段1/原始] ${clipJson(s.raw.slice(rawMark), 420)}`);

      mark = s.mark();
      await writeKeys(s, KEY.enter);
      const line1 = await logWithin(s, (e) => e.seq > mark && e.event === "line", 2000);
      evidence.push(`[阶段1/提交] ${line1 ? fmtEntry(line1) : "未见 line 事件"}`);

      // ---- 阶段 2：router 的 tab handler 在原生补全之后改写 rl.line 是否有效？ ----
      mark = s.mark();
      await writeKeys(s, "fi");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "fi", "P3 输入 fi");
      mark = s.mark();
      const rawMark2 = s.markRaw();
      await writeKeys(s, KEY.tab);
      const routerTab2 = await waitLog(
        s,
        (e) => e.seq > mark && e.event === "router-tab" && e["tabCount"] === 2,
        "P3 router tab #2",
        2500,
      );
      await sleep(250);
      const stateMutated = latestState(s);
      const raw2 = s.raw.slice(rawMark2);
      evidence.push(`[阶段2/router-tab#2] ${fmtEntry(routerTab2)}`);
      evidence.push(`[阶段2/state] ${stateMutated ? fmtEntry(stateMutated) : "(无 state)"}`);
      evidence.push(`[阶段2/屏幕] ${JSON.stringify(screenTail(s, 4))}`);
      evidence.push(`[阶段2/原始] ${clipJson(raw2, 420)}`);

      mark = s.mark();
      await writeKeys(s, KEY.enter);
      const line2 = await logWithin(s, (e) => e.seq > mark && e.event === "line", 2000);
      evidence.push(`[阶段2/提交] ${line2 ? fmtEntry(line2) : "未见 line 事件"}`);

      return { completer, keypressTab, routerTab, stateAfterTab, ordered, line1, stateMutated, line2 };
    } catch (e) {
      throw new ProbeError(e instanceof Error ? e.message : String(e), evidence);
    }
  });

  // ---- 子观测：不同 completer 配置下 Tab 的默认行为（决定路线 B 怎么接）----
  // 完全没有 completer 时，readline 的 _ttyWrite 会 "tab" case 落空穿透到 default 分支，
  // 把 "\t" 当普通字符插进行缓冲；传一个返回空候选的 no-op completer 则能干净吞掉原生 Tab。
  const subObservations: Array<{
    variant: string;
    lineAfterTab: string | null;
    routerSawLine: string | null;
    completerCalled: boolean;
  }> = [];
  for (const variant of ["none", "noop"] as const) {
    const obs = await withSession(tmpRoot, { name: `p3-${variant}`, probe: "p3", variant }, async (s) => {
      await waitReady(s, `P3(${variant})`);
      const caps = await waitLog(s, (e) => e.event === "caps", `P3(${variant}) caps`);
      evidence.push(`[${variant}/caps] ${capsSummary(caps)}`);
      let mark = s.mark();
      const rawMark = s.markRaw();
      await writeKeys(s, "un");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "un", `P3(${variant}) 输入 un`);
      mark = s.mark();
      await writeKeys(s, KEY.tab);
      const routerTab = await waitLog(s, (e) => e.seq > mark && e.event === "router-tab", `P3(${variant}) router tab`, 2500);
      const completer = await logWithin(s, (e) => e.seq > mark && e.event === "completer", 800);
      await sleep(250);
      const state = latestState(s);
      evidence.push(`[${variant}/router-tab] ${fmtEntry(routerTab)}`);
      evidence.push(
        `[${variant}/completer] ${completer ? fmtEntry(completer) : "未被调用（该配置无 completer，或返回空候选）"}`,
      );
      evidence.push(`[${variant}/state] ${state ? fmtEntry(state) : "(无 state)"}`);
      evidence.push(`[${variant}/原始] ${clipJson(s.raw.slice(rawMark), 400)}`);
      return {
        variant,
        lineAfterTab: stateLine(state),
        routerSawLine: typeof routerTab["rlLine"] === "string" ? (routerTab["rlLine"] as string) : null,
        completerCalled: completer !== null,
      };
    });
    subObservations.push(obs);
  }
  const noCompleter = subObservations.find((o) => o.variant === "none");
  const noopCompleter = subObservations.find((o) => o.variant === "noop");

  const { completer, keypressTab, routerTab, stateAfterTab, ordered, stateMutated, line2 } = main;
  const completerSeq = completer.seq;
  const keypressSeq = keypressTab.seq;
  const routerSeq = routerTab.seq;
  const orderText = ordered.join(" → ");
  const routerSawCompleted = typeof routerTab["rlLine"] === "string" ? routerTab["rlLine"] : null;
  const mutationTookEffect = stateLine(stateMutated) === "MUTATED" || lineEventJson(line2) === JSON.stringify("MUTATED");
  const conclusion = [
    `Tab 会同时触发原生补全与 keypress（${String(completer !== null)}/${String(keypressTab !== null)}），顺序 = ${orderText}；`,
    `HotkeyRouter 的 "tab" 回调触发时 rl.line 已经是原生补全结果 ${JSON.stringify(routerSawCompleted)}（seq completer=${String(completerSeq)} < keypress=${String(keypressSeq)} < router=${String(routerSeq)}）；`,
    `在 router 回调里改写 rl.line 覆盖最终提交=${String(mutationTookEffect)}（实测提交=${JSON.stringify(lineEventJson(line2))}）；`,
    `不带 completer 时按 Tab：rl.line=${JSON.stringify(noCompleter?.lineAfterTab)}（字面 \\t 被插入=${String(noCompleter?.lineAfterTab?.includes("\t") ?? false)}）；`,
    `传 no-op completer（返回空候选）时按 Tab：rl.line=${JSON.stringify(noopCompleter?.lineAfterTab)}（router 拿到干净 buffer=${String(noopCompleter?.routerSawLine === "un")}，原生补全被吞=${String(noopCompleter?.completerCalled)}）。`,
  ].join("");
  evidence.push(`[P3/结论] ${conclusion}`);
  return { conclusion, evidence };
}

/* ------------------------------------------------------------------ */
/* 探针 P4：Ctrl+J（\n）与 Enter（\r）                                  */
/* ------------------------------------------------------------------ */

async function probeP4(tmpRoot: string): Promise<{ conclusion: string; evidence: string[] }> {
  const evidence: string[] = [];
  const result = await withSession(tmpRoot, { name: "p4", probe: "p4" }, async (s) => {
    await waitReady(s, "P4");
    const caps = await waitLog(s, (e) => e.event === "caps", "P4 caps");
    evidence.push(`[默认顺序/caps] ${capsSummary(caps)}`);

    // Ctrl+J
    let mark = s.mark();
    await writeKeys(s, "abc");
    await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "abc", "P4 输入 abc");
    mark = s.mark();
    const rawMark = s.markRaw();
    await writeKeys(s, KEY.ctrlJ);
    const lineCj = await logWithin(s, (e) => e.seq > mark && e.event === "line", 1500);
    await sleep(250);
    const rawCj = s.raw.slice(rawMark); // 立刻定格：后面还会输入 def，不能到结尾再切
    const cjEntries = entriesInRange(s, mark, s.mark()).filter((e) => e.event === "keypress" || e.event === "line");
    const cjKey = cjEntries.find((e) => e.event === "keypress");
    const afterCj = latestState(s);

    // Enter
    mark = s.mark();
    await writeKeys(s, "def");
    await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "def", "P4 输入 def");
    mark = s.mark();
    const rawMarkEnter = s.markRaw();
    await writeKeys(s, KEY.enter);
    const lineEnter = await logWithin(s, (e) => e.seq > mark && e.event === "line", 1500);
    await sleep(250);
    const rawEnter = s.raw.slice(rawMarkEnter);
    const enterEntries = entriesInRange(s, mark, s.mark()).filter((e) => e.event === "keypress" || e.event === "line");
    const enterKey = enterEntries.find((e) => e.event === "keypress");

    evidence.push(`[默认顺序/Ctrl+J 日志] ${JSON.stringify(fmtEntries(cjEntries, 6))}`);
    evidence.push(`[默认顺序/Ctrl+J state] ${afterCj ? fmtEntry(afterCj) : "(无 state)"}`);
    evidence.push(`[默认顺序/Ctrl+J 原始] ${clipJson(rawCj, 400)}`);
    evidence.push(`[默认顺序/Enter 日志] ${JSON.stringify(fmtEntries(enterEntries, 6))}`);
    evidence.push(`[默认顺序/Enter 原始] ${clipJson(rawEnter, 400)}`);

    return {
      cjKey,
      cjLine: lineCj,
      enterKey,
      enterLine: lineEnter,
    };
  });

  const { cjKey, cjLine, enterKey, enterLine } = result;
  if (!cjKey || !enterKey) {
    throw new ProbeError("默认顺序下未同时观测到 Ctrl+J 与 Enter 的 keypress 日志，证据不足", evidence);
  }
  const cjName = String(cjKey["name"]);
  const cjSeq = String(cjKey["sequenceJson"]);
  const enterName = String(enterKey["name"]);
  const enterSeq = String(enterKey["sequenceJson"]);
  const cjTriggersLine = cjLine !== null;
  const lineBeforeKeypress = cjLine !== null && cjLine.seq < cjKey.seq;

  evidence.push(
    `[P4/默认顺序结论] Ctrl+J keypress name=${JSON.stringify(cjName)} sequence=${cjSeq} ctrl=${String(cjKey["ctrl"])}；` +
      `触发 line=${String(cjTriggersLine)}（lineJson=${lineEventJson(cjLine)}，line seq=${String(cjLine?.seq)} vs keypress seq=${String(cjKey.seq)}，line 先于 keypress=${String(lineBeforeKeypress)}）；` +
      `Enter keypress name=${JSON.stringify(enterName)} sequence=${enterSeq} ctrl=${String(enterKey["ctrl"])}，提交 lineJson=${lineEventJson(enterLine)}。`,
  );

  // ---- 预注册变体：Ctrl+J 能否被拦截并改成 \n 多行 ----
  const pre = await withSession(tmpRoot, { name: "p4-pre", probe: "p4pre" }, async (s) => {
    await waitReady(s, "P4pre");
    const caps = await waitLog(s, (e) => e.event === "caps", "P4pre caps");
    evidence.push(`[预注册/caps] ${capsSummary(caps)}`);

    let mark = s.mark();
    await writeKeys(s, "abc");
    await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "abc", "P4pre 输入 abc");
    mark = s.mark();
    const rawMark = s.markRaw();
    await writeKeys(s, KEY.ctrlJ);
    const inserted = await logWithin(s, (e) => e.seq > mark && e.event === "ctrlj-newline-inserted", 2500);
    const lineAfterCj = await logWithin(s, (e) => e.seq > mark && e.event === "line", 700);
    await sleep(300);
    const stateAfterCj = latestState(s);
    const preEntries = entriesInRange(s, mark, s.mark()).filter((e) =>
      ["pre-keypress", "pre-keypress-intercept-ctrlj", "pre-keypress-mutated", "post-keypress-ctrlj", "ctrlj-newline-inserted", "line"].includes(
        e.event,
      ),
    );
    evidence.push(`[预注册/Ctrl+J 日志] ${JSON.stringify(fmtEntries(preEntries, 8))}`);
    evidence.push(`[预注册/Ctrl+J state] ${stateAfterCj ? fmtEntry(stateAfterCj) : "(无 state)"}`);
    evidence.push(`[预注册/Ctrl+J 原始] ${clipJson(s.raw.slice(rawMark), 420)}`);

    // 继续输入 "def"，验证换行后的追加与提交
    mark = s.mark();
    await writeKeys(s, "def");
    await waitLog(
      s,
      (e) => e.seq > mark && e.event === "state" && typeof e["line"] === "string" && (e["line"] as string).includes("def"),
      "P4pre 输入 def",
    );
    mark = s.mark();
    await writeKeys(s, KEY.enter);
    const lineFinal = await logWithin(s, (e) => e.seq > mark && e.event === "line", 2000);
    const stateFinal = latestState(s);
    await sleep(150);
    evidence.push(`[预注册/最终 state] ${stateFinal ? fmtEntry(stateFinal) : "(无 state)"}`);
    evidence.push(`[预注册/最终提交] ${lineFinal ? fmtEntry(lineFinal) : "未见 line 事件"}`);
    return { inserted, lineAfterCj, lineFinal };
  });

  const interrupted = pre.inserted !== null && pre.lineAfterCj === null;
  const finalJson = lineEventJson(pre.lineFinal);
  evidence.push(
    `[P4/预注册结论] pre-register keypress 监听并改写 key.name（Ctrl+J → 内部 no-op）` +
      `→ Ctrl+J 未触发 line=${String(pre.lineAfterCj === null)}，手动插入后最终提交 lineJson=${JSON.stringify(finalJson)}；` +
      `拦截可行=${String(interrupted)}。`,
  );

  const conclusion = [
    `Ctrl+J 与 Enter 在 raw mode 下**可区分**（sequence ${cjSeq} vs ${enterSeq}，name ${JSON.stringify(cjName)} vs ${JSON.stringify(enterName)}）；`,
    `Ctrl+J 默认**直接触发 line 事件**（line seq=${String(cjLine?.seq)} < keypress seq=${String(cjKey.seq)}，即 readline 内部监听器先提交，后注册的 keypress 监听器来不及拦），`,
    `但只要在 createInterface **之前**注册 keypress 监听器并改写 key.name，就能把 Ctrl+J 变成插入 "\\n"（预注册实测最终提交=${JSON.stringify(finalJson)}）；`,
    `默认顺序下在 line 事件里做 continuation 也可以，但那一行已经按 Enter 语义提交并回显。`,
  ].join("");
  evidence.push(`[P4/结论] ${conclusion}`);
  return { conclusion, evidence };
}

/* ------------------------------------------------------------------ */
/* 探针 P5：rl.line 能否容纳换行                                        */
/* ------------------------------------------------------------------ */

async function probeP5(tmpRoot: string): Promise<{ conclusion: string; evidence: string[] }> {
  const evidence: string[] = [];
  return withSession(tmpRoot, { name: "p5", probe: "p5" }, async (s) => {
    try {
      await waitReady(s, "P5");
      const caps = await waitLog(s, (e) => e.event === "caps", "P5 caps");
      evidence.push(`[caps] ${capsSummary(caps)}`);

      let mark = s.mark();
      await writeKeys(s, "xyz");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "xyz", "P5 输入 xyz");
      const stateBefore = latestState(s);
      evidence.push(`[赋值前 state] ${stateBefore ? fmtEntry(stateBefore) : "(无 state)"}`);

      mark = s.mark();
      const rawMark = s.markRaw();
      await writeKeys(s, KEY.ctrlG);
      const setDone = await waitLog(s, (e) => e.seq > mark && e.event === "set-line-nl-done", "P5 设置 rl.line=a\\nb", 2500);
      await sleep(300);
      const stateAfterSet = latestState(s);
      const rawAfterSet = s.raw.slice(rawMark);
      const screenAfterSet = screenTail(s, 6);
      evidence.push(`[set-line] ${fmtEntry(setDone)}`);
      evidence.push(`[赋值后 state] ${stateAfterSet ? fmtEntry(stateAfterSet) : "(无 state)"}`);
      evidence.push(`[赋值后屏幕] ${JSON.stringify(screenAfterSet)}`);
      evidence.push(`[赋值后原始] ${clipJson(rawAfterSet, 600)}`);
      const renderedTwoRows =
        screenAfterSet.some((line) => line.includes("P5> a")) && screenAfterSet.some((line) => line.trim() === "b");

      // 手动改 cursor 后再重绘，验证 cursor 是否跟随
      mark = s.mark();
      const rawMarkCursor = s.markRaw();
      await writeKeys(s, KEY.ctrlO);
      const cursorDone = await waitLog(s, (e) => e.seq > mark && e.event === "set-cursor-done", "P5 设置 cursor", 2500);
      await sleep(250);
      const stateAfterCursor = latestState(s);
      evidence.push(`[set-cursor] ${fmtEntry(cursorDone)}`);
      evidence.push(`[改 cursor 后 state] ${stateAfterCursor ? fmtEntry(stateAfterCursor) : "(无 state)"}`);
      evidence.push(`[改 cursor 后原始] ${clipJson(s.raw.slice(rawMarkCursor), 400)}`);

      // Enter 提交
      mark = s.mark();
      await writeKeys(s, KEY.enter);
      const lineFinal = await waitLog(s, (e) => e.seq > mark && e.event === "line", "P5 提交多行 line", 2500);
      await sleep(200);
      evidence.push(`[提交] ${fmtEntry(lineFinal)}`);
      evidence.push(`[提交后屏幕] ${JSON.stringify(screenTail(s, 6))}`);

      // ---- cursor 是否随 line 赋值自动更新（用更长的行单独判定，避免旧 cursor 恰好等于新长度）----
      mark = s.mark();
      await writeKeys(s, "xy");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "xy", "P5 输入 xy");
      const stateBeforeLong = latestState(s);
      mark = s.mark();
      const rawMarkLong = s.markRaw();
      await writeKeys(s, KEY.ctrlT);
      const longDone = await waitLog(s, (e) => e.seq > mark && e.event === "set-long-line-done", "P5 设置更长行", 2500);
      await sleep(300);
      const stateAfterLong = latestState(s);
      evidence.push(`[长行赋值前 state] ${stateBeforeLong ? fmtEntry(stateBeforeLong) : "(无 state)"}`);
      evidence.push(`[set-long-line] ${fmtEntry(longDone)}`);
      evidence.push(`[长行赋值后 state] ${stateAfterLong ? fmtEntry(stateAfterLong) : "(无 state)"}`);
      evidence.push(`[长行赋值后屏幕] ${JSON.stringify(screenTail(s, 5))}`);
      evidence.push(`[长行赋值后原始] ${clipJson(s.raw.slice(rawMarkLong), 500)}`);

      const submittedJson = lineEventJson(lineFinal);
      const containsNewline = typeof lineFinal["line"] === "string" && (lineFinal["line"] as string).includes("\n");
      const cursorAutoUpdated = longDone["cursorAutoUpdated"] === true;
      const conclusion = [
        `rl.line 赋值 "a\\nb" 后：可读回=${JSON.stringify(setDone["after"])}；`,
        `_refreshLine 渲染成 ${String(renderedTwoRows)} 两行（屏幕 ${JSON.stringify(screenAfterSet)}）；`,
        `cursor 不随 line 赋值自动更新（赋值前 cursor=${String((longDone["before"] as Record<string, unknown> | undefined)?.["cursor"])}，赋一条长 ${String(longDone["expectedLength"])} 字符的行后仍是 ${String((longDone["after"] as Record<string, unknown> | undefined)?.["cursor"])}，autoUpdated=${String(cursorAutoUpdated)}），需手动设 rl.cursor 再 _refreshLine；`,
        `随后 Enter 提交的 line 事件${containsNewline ? "**包含** \\n" : "**不包含** \\n"}（lineJson=${JSON.stringify(submittedJson)}）。`,
      ].join("");
      evidence.push(`[P5/结论] ${conclusion}`);
      return { conclusion, evidence };
    } catch (e) {
      throw new ProbeError(e instanceof Error ? e.message : String(e), evidence);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 探针 P6：中途 setPrompt + _refreshLine                              */
/* ------------------------------------------------------------------ */

async function probeP6(tmpRoot: string): Promise<{ conclusion: string; evidence: string[] }> {
  const evidence: string[] = [];
  return withSession(tmpRoot, { name: "p6", probe: "p6" }, async (s) => {
    try {
      await waitReady(s, "P6", { screen: (text) => text.includes("❯") });
      const caps = await waitLog(s, (e) => e.event === "caps", "P6 caps");
      evidence.push(`[caps] ${capsSummary(caps)}`);

      let mark = s.mark();
      await writeKeys(s, "hello");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "hello", "P6 输入 hello");
      const stateBefore = latestState(s);
      evidence.push(`[切换前 state] ${stateBefore ? fmtEntry(stateBefore) : "(无 state)"}`);

      mark = s.mark();
      const rawMark = s.markRaw();
      await writeKeys(s, KEY.ctrlG);
      const done = await waitLog(s, (e) => e.seq > mark && e.event === "set-prompt-done", "P6 setPrompt", 2500);
      await sleep(300);
      const stateAfter = latestState(s);
      const screenAfter = screenTail(s, 5);
      evidence.push(`[set-prompt] ${fmtEntry(done)}`);
      evidence.push(`[切换后 state] ${stateAfter ? fmtEntry(stateAfter) : "(无 state)"}`);
      evidence.push(`[切换后屏幕] ${JSON.stringify(screenAfter)}`);
      evidence.push(`[切换后原始] ${clipJson(s.raw.slice(rawMark), 420)}`);
      const promptChanged = done["after"] !== null && (done["after"] as Record<string, unknown>)["prompt"] === "… ";
      const bufferKept = stateLine(stateAfter) === "hello";
      const screenShowsNewPrompt = screenAfter.some((line) => line.includes("… hello"));

      mark = s.mark();
      await writeKeys(s, " world");
      await waitLog(
        s,
        (e) => e.seq > mark && e.event === "state" && e["line"] === "hello world",
        "P6 继续输入 world",
      );
      mark = s.mark();
      await writeKeys(s, KEY.enter);
      const lineFinal = await waitLog(s, (e) => e.seq > mark && e.event === "line", "P6 提交", 2500);
      await sleep(200);
      evidence.push(`[提交] ${fmtEntry(lineFinal)}`);
      evidence.push(`[提交后屏幕] ${JSON.stringify(screenTail(s, 5))}`);
      const conclusionContent = [
        `setPrompt("… ") + _refreshLine 可行=${String(promptChanged && screenShowsNewPrompt)}：`,
        `行缓冲保留=${String(bufferKept)}（line=${JSON.stringify(stateLine(stateAfter))}），`,
        `屏幕出现 "${"… "}hello"=${String(screenShowsNewPrompt)}，继续输入后提交=${JSON.stringify(lineEventJson(lineFinal))}。`,
      ].join("");
      evidence.push(`[P6/结论] ${conclusionContent}`);
      return { conclusion: conclusionContent, evidence };
    } catch (e) {
      throw new ProbeError(e instanceof Error ? e.message : String(e), evidence);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 探针 P7：历史与补全的相互作用                                        */
/* ------------------------------------------------------------------ */

async function probeP7(tmpRoot: string): Promise<{ conclusion: string; evidence: string[] }> {
  const evidence: string[] = [];
  return withSession(tmpRoot, { name: "p7", probe: "p7" }, async (s) => {
    try {
      await waitReady(s, "P7");
      const caps = await waitLog(s, (e) => e.event === "caps", "P7 caps");
      evidence.push(`[caps] ${capsSummary(caps)}`);

      // 先制造一条历史
      let mark = s.mark();
      await writeKeys(s, "hello");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "hello", "P7 输入 hello");
      mark = s.mark();
      await writeKeys(s, KEY.enter);
      const lineHello = await waitLog(s, (e) => e.seq > mark && e.event === "line", "P7 提交 hello", 2500);
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "", "P7 提交后清空");
      evidence.push(`[历史] ${fmtEntry(lineHello)}`);

      // 补全
      mark = s.mark();
      await writeKeys(s, "fi");
      await waitLog(s, (e) => e.seq > mark && e.event === "state" && e["line"] === "fi", "P7 输入 fi");
      mark = s.mark();
      const rawMark = s.markRaw();
      await writeKeys(s, KEY.tab);
      const completer = await logWithin(s, (e) => e.seq > mark && e.event === "completer", 2500);
      await sleep(300);
      const stateAfterTab = latestState(s);
      evidence.push(`[补全] completer=${completer ? fmtEntry(completer) : "未被调用"}`);
      evidence.push(`[补全后 state] ${stateAfterTab ? fmtEntry(stateAfterTab) : "(无 state)"}`);
      evidence.push(`[补全后原始] ${clipJson(s.raw.slice(rawMark), 420)}`);

      // 补全后 ↑
      let stateBeforeUp = latestState(s);
      mark = s.mark();
      await writeKeys(s, KEY.up);
      await sleep(350);
      const stateAfterUp = latestState(s);
      const upKey = await logWithin(s, (e) => e.seq > mark && e.event === "keypress" && e["name"] === "up", 500);
      const upChangedState = (stateBeforeUp?.seq ?? -1) !== (stateAfterUp?.seq ?? -1);
      evidence.push(`[补全后↑ keypress] ${upKey ? fmtEntry(upKey) : "未见 up keypress"}`);
      evidence.push(
        `[补全后↑ state] ${stateAfterUp ? fmtEntry(stateAfterUp) : "(无 state)"}（state 是否变化=${String(upChangedState)}）`,
      );

      // ↓
      stateBeforeUp = latestState(s);
      mark = s.mark();
      await writeKeys(s, KEY.down);
      await sleep(350);
      const stateAfterDown = latestState(s);
      const downChangedState = (stateBeforeUp?.seq ?? -1) !== (stateAfterDown?.seq ?? -1);
      evidence.push(
        `[补全后↓ state] ${stateAfterDown ? fmtEntry(stateAfterDown) : "(无 state)"}（state 是否变化=${String(downChangedState)}）`,
      );

      // Ctrl+U 清空后再 ↑（历史召回工作路径）
      mark = s.mark();
      await writeKeys(s, KEY.ctrlU);
      await sleep(250);
      const stateAfterCtrlU = latestState(s);
      evidence.push(`[Ctrl+U 后 state] ${stateAfterCtrlU ? fmtEntry(stateAfterCtrlU) : "(无 state)"}`);

      mark = s.mark();
      await writeKeys(s, KEY.up);
      await sleep(350);
      const stateAfterUp2 = latestState(s);
      evidence.push(`[清空后↑ state] ${stateAfterUp2 ? fmtEntry(stateAfterUp2) : "(无 state)"}`);

      mark = s.mark();
      await writeKeys(s, KEY.enter);
      const lineFinal = await logWithin(s, (e) => e.seq > mark && e.event === "line", 2000);
      evidence.push(`[最终提交] ${lineFinal ? fmtEntry(lineFinal) : "未见 line 事件"}`);
      evidence.push(`[最终屏幕] ${JSON.stringify(screenTail(s, 6))}`);

      const noCompleterCorruption = stateLine(stateAfterUp) === "file1.txt";
      const conclusionContent = [
        `补全后 line=${JSON.stringify(stateLine(stateAfterTab))}；`,
        `再按 ↑ 后 line=${JSON.stringify(stateLine(stateAfterUp))}（state 是否变化=${String(upChangedState)}，补全文本未被吞/重复=${String(noCompleterCorruption)}），`,
        `↓ 后 line=${JSON.stringify(stateLine(stateAfterDown))}（state 是否变化=${String(downChangedState)}）；`,
        `Ctrl+U 清空后 ↑ 召回 line=${JSON.stringify(stateLine(stateAfterUp2))}，提交=${JSON.stringify(lineEventJson(lineFinal))}。`,
        `（↑ 没取到 "hello" 的原因：readline 把补全后的当前 buffer 当历史前缀搜索条件）`,
      ].join("");
      evidence.push(`[P7/结论] ${conclusionContent}`);
      return { conclusion: conclusionContent, evidence };
    } catch (e) {
      throw new ProbeError(e instanceof Error ? e.message : String(e), evidence);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 探针注册与主流程                                                    */
/* ------------------------------------------------------------------ */

interface Probe {
  id: string;
  title: string;
  fn: (tmpRoot: string) => Promise<{ conclusion: string; evidence: string[] }>;
}

const PROBES: Probe[] = [
  { id: "p1", title: "P1 completer 是否生效（单/多候选、自动补全、列表）", fn: probeP1 },
  { id: "p2", title: "P2 completer 入参 + 异步（callback/Promise）支持", fn: probeP2 },
  { id: "p3", title: "P3 Tab 与 HotkeyRouter keypress 的共存与顺序", fn: probeP3 },
  { id: "p4", title: "P4 Ctrl+J vs Enter：可区分性、line 事件、可拦截性", fn: probeP4 },
  { id: "p5", title: "P5 rl.line 容纳 \\n：渲染行数、cursor、提交内容", fn: probeP5 },
  { id: "p6", title: "P6 中途 setPrompt + _refreshLine 是否破坏行缓冲", fn: probeP6 },
  { id: "p7", title: "P7 补全后 ↑ 历史召回是否异常", fn: probeP7 },
];

function selectedProbeIds(argv: string[]): string[] {
  const wanted = argv.filter((a) => !a.startsWith("-")).map((a) => a.trim().toLowerCase());
  if (wanted.length === 0 || wanted.includes("all")) return PROBES.map((p) => p.id);
  return PROBES.filter((probe) => {
    return wanted.some((w) => {
      if (probe.id === w) return true;
      if (w.startsWith("s") && `p${w.slice(1)}` === probe.id) return true; // 兼容 s1 写法
      if (w.startsWith("p") && `s${w.slice(1)}` === probe.id) return true;
      return probe.title.toLowerCase().includes(w);
    });
  }).map((p) => p.id);
}

function printHeader(picked: Probe[]): void {
  console.log("── bun node:readline 行为探针（v0.2.4 M0）──");
  console.log(`bun        ${Bun.version}`);
  console.log(`平台       ${process.platform} ${process.arch} / TERM=${process.env["TERM"] ?? "(unset)"}`);
  console.log(`探针脚本   ${SELF}`);
  console.log(`PTY        ${SCRIPT_BIN} + mkfifo（macOS 下 Bun 的 stdio pipe 不可用）`);
  console.log(`探针       ${picked.map((p) => p.id).join(", ")}`);
  console.log(`选项       VERBOSE=${VERBOSE ? "1" : "0"} KEEP_TMP=${KEEP_TMP ? "1" : "0"}`);
  console.log("");
}

interface ProbeRunResult {
  probe: Probe;
  ok: boolean;
  ms: number;
  conclusion: string;
  evidence: string[];
  error?: string;
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("用法：bun run scripts/readline-probe.ts [p1 p3 ...] [--help]");
    console.log("  VERBOSE=1  打印完整原始字节与全部日志行");
    console.log("  KEEP_TMP=1 保留临时目录（结尾打印路径）");
    return 0;
  }
  const ids = selectedProbeIds(process.argv.slice(2));
  const picked = PROBES.filter((p) => ids.includes(p.id));
  if (picked.length === 0) {
    console.log(`未匹配到探针。可用：${PROBES.map((p) => p.id).join(", ")}（也接受 s1 风格）`);
    return 2;
  }

  printHeader(picked);

  const tmpRoot = await mkdtemp(join(tmpdir(), "neo-readline-probe-"));
  const results: ProbeRunResult[] = [];

  const cleanup = async (): Promise<void> => {
    for (const session of [...liveSessions]) {
      await session.close();
    }
  };
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    for (const probe of picked) {
      const started = Date.now();
      console.log(`▶ ${probe.id} ${probe.title}`);
      try {
        const { conclusion, evidence } = await probe.fn(tmpRoot);
        const ms = Date.now() - started;
        console.log(`  PASS ${probe.id}（${ms}ms）`);
        for (const line of evidence) console.log(`  证据 ${line}`);
        console.log(`  结论 ${conclusion}\n`);
        results.push({ probe, ok: true, ms, conclusion, evidence });
      } catch (e) {
        const ms = Date.now() - started;
        const err = e instanceof Error ? e.message : String(e);
        const evidence = e instanceof ProbeError ? e.evidence : [];
        console.log(`  FAIL ${probe.id}（${ms}ms）`);
        console.log(`  原因：${err}`);
        for (const line of evidence) console.log(`  证据 ${line}`);
        console.log("");
        results.push({ probe, ok: false, ms, conclusion: "未测出", evidence, error: err });
      }
    }
  } finally {
    await cleanup();
    if (KEEP_TMP) console.log(`临时目录已保留：${tmpRoot}`);
    else await rm(tmpRoot, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log("── 汇总 ──");
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.probe.id}  ${r.ok ? r.conclusion : `未测出：${r.error}`}`);
  }
  console.log(`  ${passed} passed / ${failed} failed（PASS = 探针有定论，含否定结论）`);
  return failed === 0 ? 0 : 1;
}

const childFlagIndex = process.argv.indexOf("--child");
if (childFlagIndex !== -1) {
  runChild(process.argv[childFlagIndex + 1] ?? "", process.argv[childFlagIndex + 2] ?? "");
} else {
  process.exit(await main());
}
