#!/usr/bin/env bun
/**
 * scripts/tui-probe.ts — v0.3.0 TUI（底部 live 帧 + 自绘输入框）M0 探针。
 *
 * 要回答的问题（决定实现路线，而不是验证某个已成形的功能）：
 *   P1 按键：真 PTY + raw mode + emitKeypressEvents 下，Ctrl+O / Ctrl+J / Enter /
 *           UTF-8 / 方向键 / bracketed paste 到底以什么 keypress 形态到达？
 *   P2 帧：自绘「顶部横线 + 输入行 + 底部横线 + 状态行」的 live 帧，
 *           用「上移 N 行 + \x1b[0J 清到屏尾 + 整帧重画」能否在输入、多行、
 *           高度变化、历史行滚动时保持屏幕一致？
 *   P3 交错：agent 流式输出（异步写）与输入同时发生时，帧重画是否吞输入/串行？
 *   P4 收尾：退出后 raw mode / bracketed paste / 光标是否恢复（stty 实证）。
 *
 * 用法：
 *   bun run scripts/tui-probe.ts              # 全部
 *   bun run scripts/tui-probe.ts p1 p2        # 只跑指定
 *   KEEP_TMP=1 bun run scripts/tui-probe.ts   # 保留临时目录
 *   VERBOSE=1 bun run scripts/tui-probe.ts    # 打印每个场景屏幕
 *
 * 退出码：全 PASS → 0，任一 FAIL → 1。
 *
 * PTY 拉起方式复制自 scripts/pty-e2e.ts（macOS `script(1)` 不接受 Bun socketpair，
 * 必须 mkfifo + cat fifo | script；winsize 必须在 PTY 内 stty）。Screen 亦同源。
 */
import { closeSync, constants as fsConstants, openSync, readFileSync, writeSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { appendFileSync } from "node:fs";
import type { Subprocess } from "bun";
import { displayWidth } from "../src/ui/theme.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SELF = join(ROOT, "scripts", "tui-probe.ts");
const BUN = process.execPath;
const SCRIPT_BIN = Bun.which("script") ?? "/usr/bin/script";
const MKFIFO = Bun.which("mkfifo") ?? "/usr/bin/mkfifo";
const KEEP_TMP = process.env["KEEP_TMP"] === "1";
const VERBOSE = process.env["VERBOSE"] === "1";
const COLS = 100;
const ROWS = 40;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 最小屏幕缓冲（与 scripts/pty-e2e.ts 同源；只解释断言需要的子集）      */
/* ------------------------------------------------------------------ */

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
      if (ch === "\r") { this.col = 0; i += 1; continue; }
      if (ch === "\n") { this.row += 1; this.col = 0; this.ensureRow(this.row); i += 1; continue; }
      if (ch === "\b") { if (this.col > 0) this.col -= 1; i += 1; continue; }
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

  private ensureRow(r: number): void { while (this.rows.length <= r) this.rows.push([]); }

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
    if (next === "7") { this.saved = { row: this.row, col: this.col }; return 2; }
    if (next === "8") {
      if (this.saved) { this.row = this.saved.row; this.col = this.saved.col; this.ensureRow(this.row); }
      return 2;
    }
    if (next === "(" || next === ")") return 3;
    return 2;
  }

  private applyCsi(paramsRaw: string, final: string): void {
    if (paramsRaw.startsWith("?")) return; // 私有模式（2004/25 等）不改变文本
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
        if (mode === 2) { this.rows[this.row] = []; this.col = 0; }
        else if (mode === 1) { for (let c = 0; c < Math.min(this.col, row.length); c++) row[c] = " "; }
        else { if (row.length > this.col) row.length = this.col; }
        return;
      }
      case "J": {
        const mode = params[0] ?? 0;
        if (mode === 2) { this.rows = [[]]; this.row = 0; this.col = 0; }
        else if (mode === 1) {
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
      case "A": this.row = Math.max(0, this.row - n(0, 1)); return;
      case "B": this.row += n(0, 1); this.ensureRow(this.row); return;
      case "C": this.col += n(0, 1); return;
      case "D": this.col = Math.max(0, this.col - n(0, 1)); return;
      case "E": this.row += n(0, 1); this.col = 0; this.ensureRow(this.row); return;
      case "F": this.row = Math.max(0, this.row - n(0, 1)); this.col = 0; return;
      case "G": this.col = Math.max(0, n(0, 1) - 1); return;
      case "H":
      case "f":
        this.row = Math.max(0, n(0, 1) - 1);
        this.col = Math.max(0, n(1, 1) - 1);
        this.ensureRow(this.row);
        return;
      case "d": this.row = Math.max(0, n(0, 1) - 1); this.ensureRow(this.row); return;
      case "P": { const row = this.rows[this.row] ?? []; row.splice(this.col, n(0, 1)); return; }
      case "@": { const row = this.rows[this.row] ?? []; row.splice(this.col, 0, ...Array.from({ length: n(0, 1) }, () => " ")); return; }
      case "X": {
        const row = this.rows[this.row] ?? [];
        for (let c = this.col; c < Math.min(row.length, this.col + n(0, 1)); c++) row[c] = " ";
        return;
      }
      default: return; // m / h / l / s / u 不影响可见文本
    }
  }

  lines(): string[] { return this.rows.map((row) => row.join("").replace(/\s+$/, "")); }
  text(): string { return this.lines().join("\n"); }
  lastNonEmptyLine(): string {
    const lines = this.lines();
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = (lines[i] ?? "").trim();
      if (l !== "") return l;
    }
    return "";
  }
  nonEmptyLines(): string[] { return this.lines().filter((l) => l.trim() !== ""); }
  /** 当前光标位置（0-based）。 */
  cursor(): { row: number; col: number } { return { row: this.row, col: this.col }; }
}

/* ------------------------------------------------------------------ */
/* 子程序侧（--child）：raw mode + keypress + 极简 live 帧               */
/* ------------------------------------------------------------------ */

interface KeyInfo { ch: string | undefined; name: string | undefined; ctrl: boolean; meta: boolean; shift: boolean; sequence: string | undefined; paste: boolean | undefined }

function childLog(o: Record<string, unknown>): void {
  const p = process.env["PROBE_LOG"];
  if (!p) return;
  appendFileSync(p, JSON.stringify(o) + "\n");
}

function childCaps(): Record<string, unknown> {
  return {
    isTTY: process.stdin.isTTY,
    setRawMode: typeof process.stdin.setRawMode,
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    isRaw: (process.stdin as unknown as { isRaw?: boolean }).isRaw,
  };
}

function childInit(): void {
  const stdin = process.stdin as unknown as { setRawMode?: (v: boolean) => void };
  stdin.setRawMode?.(true);
  emitKeypressEvents(process.stdin);
  process.stdout.write("\x1b[?2004h"); // 打开 bracketed paste
  process.stdout.write("\x1b[?25l"); // hide cursor（帧自己定位光标）
}

function childFinish(extra: Record<string, unknown> = {}): void {
  const stdin = process.stdin as unknown as { setRawMode?: (v: boolean) => void; isRaw?: boolean };
  process.stdout.write("\x1b[?25h\x1b[?2004l");
  stdin.setRawMode?.(false);
  childLog({ done: true, isRawAfter: stdin.isRaw, ...extra });
  process.stdout.write("\r\nDONE\r\n");
  setTimeout(() => process.exit(0), 30);
}

/** P1：纯按键记录。READY 后由驱动侧逐段写入字节，Ctrl+C 收尾。 */
function childKeys(): void {
  childLog({ caps: childCaps() });
  process.stdout.write("READY\r\n");
  process.stdin.prependListener("data", (b: Buffer) => childLog({ dataHex: [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ") }));
  process.stdin.on("keypress", (ch: string | undefined, key: KeyInfo) => {
    childLog({ ch, name: key.name, ctrl: key.ctrl, meta: key.meta, shift: key.shift, seq: key.sequence, paste: key.paste });
    if (key.ctrl && key.name === "c") childFinish({ finish: "ctrl+c" });
  });
}

/**
 * P2/P3：极简 live 帧。
 *   ────────────
 *   > 输入（可多行）
 *   ────────────
 *   status
 * 每帧：光标上移到帧首 → \r\x1b[0J 清到屏尾 → 整帧重写 → 光标回到输入位置。
 * 提交：同样先清帧，把提交行写到帧原来的位置（进入 scrollback），再重画帧。
 */
function makeFrame(opts: { status?: string; interleave?: boolean } = {}): {
  render: () => void; commit: (line: string) => void; onKey: (key: KeyInfo, ch: string | undefined) => boolean;
} {
  let text = "";
  let pos = 0; // code point 下标
  let cursorFrameRow = 0;
  let cursorFrameCol = 0;
  let frameRows = 1;
  const cols = (): number => Math.max(20, process.stdout.columns || 80);
  const status = opts.status ?? "status: ready";

  /** 按显示列折行；prefix 只在第一行出现，续行用空格对齐。 */
  const visualLines = (): { text: string; start: number; end: number }[] => {
    const cps = [...text];
    const contentW = Math.max(4, cols() - 2);
    if (cps.length === 0) return [{ text: "", start: 0, end: 0 }];
    // 先按逻辑换行切，再按显示宽度折行（与生产 buffer 同一口径）。
    const logical: { text: string; start: number; end: number }[] = [];
    let cur: { text: string; start: number } = { text: "", start: 0 };
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i] as string;
      if (cp === "\n") {
        logical.push({ ...cur, end: i });
        cur = { text: "", start: i + 1 };
      } else {
        cur.text += cp;
      }
    }
    logical.push({ ...cur, end: cps.length });
    const out: { text: string; start: number; end: number }[] = [];
    for (const log of logical) {
      const chars = [...log.text];
      if (chars.length === 0) {
        out.push({ text: "", start: log.start, end: log.end });
        continue;
      }
      let i = 0;
      while (i < chars.length) {
        let w = 0;
        let j = i;
        while (j < chars.length) {
          const cw = displayWidth(chars[j] as string);
          if (w + cw > contentW && j > i) break;
          w += cw;
          j += 1;
        }
        out.push({ text: chars.slice(i, j).join(""), start: log.start + i, end: log.start + j });
        i = j;
      }
    }
    return out;
  };

  const eraseFrame = (): void => {
    if (cursorFrameRow > 0) process.stdout.write(`\x1b[${cursorFrameRow}A`);
    process.stdout.write("\r\x1b[0J");
  };

  const render = (): void => {
    const lines = visualLines();
    let cursorLine = lines.findIndex((l) => pos >= l.start && pos < l.end);
    if (cursorLine === -1) cursorLine = lines.length - 1; // 光标在全文末尾
    const line = lines[cursorLine] ?? { start: 0, end: 0, text: "" };
    const col = 2 + displayWidth([...line.text].slice(0, Math.max(0, pos - line.start)).join(""));
    const w = cols();
    const top = "─".repeat(w);
    const bottom = "─".repeat(w);
    const body = lines.map((l, idx) => `${idx === 0 ? "> " : "  "}${l.text}`);
    const rows = [top, ...body, bottom, status];
    eraseFrame();
    process.stdout.write(rows.join("\r\n"));
    frameRows = rows.length;
    cursorFrameRow = 1 + cursorLine;
    cursorFrameCol = Math.min(col, w);
    const up = rows.length - 1 - cursorFrameRow;
    if (up > 0) process.stdout.write(`\x1b[${up}A`);
    process.stdout.write(`\r\x1b[${cursorFrameCol + 1}G`);
  };

  const commit = (line: string): void => {
    eraseFrame();
    process.stdout.write(`❯ ${line}\r\n`);
    // 提交后光标在新行行首：下一次 render 的 eraseFrame 不能再按旧帧内行号上移，
    // 否则会把刚写进 scrollback 的提交行擦掉（探针第一次跑就踩到了）。
    cursorFrameRow = 0;
    cursorFrameCol = 0;
    render();
  };

  const onKey = (key: KeyInfo, ch: string | undefined): boolean => {
    const cps = [...text];
    if (key.ctrl && key.name === "c") { childFinish({ finish: "ctrl+c" }); return true; }
    // 实测（v0.2.4 M0 P4）：Ctrl+J 的 key.sequence 是 "\n"（name 仍是 enter、ctrl=false），
    // Enter 是 "\r"。所以换行判定看 sequence，不看 name/ctrl —— 这正是生产要复用的规则。
    if (key.sequence === "\n") { cps.splice(pos, 0, "\n"); text = cps.join(""); pos += 1; render(); return true; }
    if (key.name === "return" || key.sequence === "\r") { commit(text); text = ""; pos = 0; render(); return true; }
    if (key.ctrl && key.name === "u") { cps.splice(0, pos); text = cps.join(""); pos = 0; render(); return true; }
    if (key.name === "backspace") { if (pos > 0) { cps.splice(pos - 1, 1); text = cps.join(""); pos -= 1; render(); } return true; }
    if (key.name === "delete") { if (pos < cps.length) { cps.splice(pos, 1); text = cps.join(""); render(); } return true; }
    if (key.name === "left") { if (pos > 0) pos -= 1; render(); return true; }
    if (key.name === "right") { if (pos < cps.length) pos += 1; render(); return true; }
    if (key.name === "home") { pos = 0; render(); return true; }
    if (key.name === "end") { pos = cps.length; render(); return true; }
    if (key.ctrl && key.name === "o") { childLog({ notice: "ctrl+o" }); return true; }
    if (ch && !key.ctrl && !key.meta && ch.length > 0 && ch !== "\t") {
      // 粘贴期间也逐字进入缓冲（探针只验证事件形态；生产会整体折叠）
      cps.splice(pos, 0, ch);
      text = cps.join("");
      pos += 1;
      render();
      return true;
    }
    return false;
  };

  return { render, commit, onKey };
}

function childFrame(interleave: boolean): void {
  childLog({ caps: childCaps() });
  const f = makeFrame({ status: "STATUS | model · tier · ctx", interleave });
  f.render();
  process.stdout.write("READY\r\n");
  process.stdin.prependListener("data", (b: Buffer) => childLog({ dataHex: [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ") }));
  process.stdin.on("keypress", (ch: string | undefined, key: KeyInfo) => {
    childLog({ ch, name: key.name, ctrl: key.ctrl, seq: key.sequence, paste: key.paste });
    f.onKey(key, ch);
  });
  if (interleave) {
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      f.commit(`agent line ${n} 中文内容`);
      if (n >= 12) clearInterval(t);
    }, 40);
    t.unref?.();
  }
}

/* ------------------------------------------------------------------ */
/* 驱动侧：PTY 拉起 + 断言                                             */
/* ------------------------------------------------------------------ */

interface ProcHandle { proc: Subprocess<"ignore", "pipe", "pipe">; label: string }
const live = new Set<ProcHandle>();

async function killProc(proc: ProcHandle["proc"], graceMs = 1500): Promise<void> {
  try { proc.kill("SIGTERM"); } catch { /* gone */ }
  const exited = await Promise.race([proc.exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!exited) {
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    await Promise.race([proc.exited, sleep(800)]);
  }
}

function shellQuote(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }

async function openFifoWriter(path: string, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return openSync(path, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENXIO" && code !== "ENOENT") throw e;
      if (Date.now() > deadline) throw new Error(`打开 FIFO 写端超时：${path}`);
      await sleep(20);
    }
  }
}

async function writeFifo(fd: number, data: string): Promise<void> {
  const buf = Buffer.from(data, "utf8");
  let offset = 0;
  const deadline = Date.now() + 2000;
  while (offset < buf.length) {
    try { offset += writeSync(fd, buf, offset, buf.length - offset); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") throw e;
      if (Date.now() > deadline) throw new Error("写 FIFO 超时");
      await sleep(5);
    }
  }
}

interface Session {
  screen: Screen;
  write: (s: string) => Promise<void>;
  waitText: (needle: string, timeoutMs?: number) => Promise<void>;
  waitChildExit: (timeoutMs?: number) => Promise<void>;
  close: () => Promise<void>;
  tmp: string;
  fifoFd: number;
}

let sessionSeq = 0;
async function startSession(tmpRoot: string, childCase: string, opts: { post?: string } = {}): Promise<Session> {
  sessionSeq += 1;
  const dir = join(tmpRoot, `${childCase}-${sessionSeq}`);
  await mkdir(dir, { recursive: true });
  const fifo = join(dir, "input.fifo");
  const wrapper = join(dir, "wrapper.sh");
  const log = join(dir, "child.jsonl");
  const mk = Bun.spawnSync([MKFIFO, fifo], { stdout: "ignore", stderr: "pipe" });
  if (mk.exitCode !== 0) throw new Error(`mkfifo 失败：${mk.stderr.toString()}`);
  const post = opts.post ? `\n${opts.post}` : "";
  await writeFile(
    wrapper,
    `#!/bin/sh\nstty cols ${COLS} rows ${ROWS}\n` +
      `PROBE_LOG=${shellQuote(log)} ${shellQuote(BUN)} run ${shellQuote(SELF)} --child ${shellQuote(childCase)}\n` +
      `echo "CHILD_EXIT=$?"${post}\n`,
    "utf8",
  );
  const inner =
    process.platform === "darwin"
      ? `cat ${shellQuote(fifo)} | ${SCRIPT_BIN} -q /dev/null /bin/sh ${shellQuote(wrapper)}`
      : `${SCRIPT_BIN} -q -e -c ${shellQuote(`/bin/sh ${shellQuote(wrapper)}`)} /dev/null < ${shellQuote(fifo)}`;
  const proc = Bun.spawn(["/bin/sh", "-c", inner], {
    cwd: ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PROBE_LOG: log },
  });
  const handle: ProcHandle = { proc, label: childCase };
  live.add(handle);
  const screen = new Screen();
  void (async (): Promise<void> => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stdout) screen.feed(dec.decode(chunk as Uint8Array, { stream: true }));
    } catch { /* closed */ }
  })();
  let stderrText = "";
  void (async (): Promise<void> => {
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stderr) stderrText += dec.decode(chunk as Uint8Array, { stream: true });
    } catch { /* closed */ }
  })();
  const fifoFd = await openFifoWriter(fifo);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { closeSync(fifoFd); } catch { /* ignore */ }
    await killProc(proc);
    live.delete(handle);
  };
  return {
    screen,
    tmp: dir,
    fifoFd,
    write: (s: string) => writeFifo(fifoFd, s),
    waitText: async (needle: string, timeoutMs = 12000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (screen.text().includes(needle)) return;
        if (Date.now() > deadline) {
          throw new Error(`等待「${needle}」超时。stderr=${stderrText.slice(-400)}`);
        }
        await sleep(25);
      }
    },
    waitChildExit: async (timeoutMs = 12000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (screen.text().includes("CHILD_EXIT=")) return;
        if (Date.now() > deadline) throw new Error("等待子进程退出超时");
        await sleep(25);
      }
    },
    close,
  };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch { return []; }
}

class CheckError extends Error {
  constructor(message: string, readonly screen?: Screen) { super(message); this.name = "CheckError"; }
}
function check(cond: boolean, msg: string, screen?: Screen): void {
  if (!cond) throw new CheckError(msg, screen);
}

/** P1：按键形态。 */
async function probeKeys(tmp: string): Promise<void> {
  const s = await startSession(tmp, "keys");
  try {
    await s.waitText("READY");
    // 中文、Ctrl+O、Ctrl+J、Enter、方向键、退格、bracketed paste
    await s.write("a");
    await sleep(80);
    await s.write("中");
    await sleep(80);
    await s.write("\x0f"); // Ctrl+O
    await sleep(80);
    await s.write("\n"); // Ctrl+J（raw 下 LF）
    await s.write("\r"); // Enter
    await s.write("\x1b[A"); // ↑
    await s.write("\x7f"); // Backspace
    await s.write("\x1b[200~p1\r\np2中\x1b[201~"); // bracketed paste
    await sleep(250);
    await s.write("\x03"); // Ctrl+C 收尾
    await s.waitChildExit();
    const log = readJsonl(join(s.tmp, "child.jsonl"));
    const caps = log.find((l) => l["caps"]) as Record<string, unknown> | undefined;
    check(caps !== undefined, "缺少 caps 证据", s.screen);
    check((caps!["caps"] as Record<string, unknown>)["isTTY"] === true, "子进程没吃到 TTY", s.screen);
    check((caps!["caps"] as Record<string, unknown>)["setRawMode"] === "function", "bun 无 setRawMode", s.screen);
    check((caps!["caps"] as Record<string, unknown>)["isRaw"] === true, "raw mode 未生效", s.screen);

    // UTF-8 字符的 keypress 没有 name（key.name === undefined 被 JSON 省略），
    // 不能按 "name" in l 过滤，否则中文会被误判为「没到达」。
    const keys = log.filter((l) => !("caps" in l) && !("dataHex" in l) && !("done" in l));
    const has = (name: string, ctrl?: boolean): boolean => keys.some((k) => k["name"] === name && (ctrl === undefined || k["ctrl"] === ctrl));
    check(has("o", true), "Ctrl+O 没有作为 keypress 到达", s.screen);
    check(keys.some((k) => k["ch"] === "\u000f" && k["ctrl"] === true), "Ctrl+O 的 0x0f 未到达", s.screen);
    const ctrlJ = keys.find((k) => k["ctrl"] === false && k["seq"] === "\n");
    check(ctrlJ !== undefined, "Ctrl+J 的 \\n keypress 缺失", s.screen);
    const enter = keys.find((k) => k["seq"] === "\r");
    check(enter !== undefined, "Enter 的 \\r keypress 缺失", s.screen);
    check(has("up"), "方向键 ↑ 未解析", s.screen);
    check(has("backspace") || keys.some((k) => k["seq"] === "\x7f"), "Backspace 未解析", s.screen);
    const cjk = keys.find((k) => k["ch"] === "中");
    check(cjk !== undefined, `UTF-8 中文未作为单个 keypress 到达（keys=${JSON.stringify(keys)}）`, s.screen);
    check(has("paste-start"), "bracketed paste 起始未被识别", s.screen);
    check(has("paste-end"), "bracketed paste 结束未被识别", s.screen);
    if (VERBOSE) console.log(s.screen.text());
  } finally { await s.close(); }
}

/** P2：live 帧基本行为。 */
async function probeFrame(tmp: string): Promise<void> {
  const s = await startSession(tmp, "frame");
  try {
    await s.waitText("READY");
    await s.write("hello 中文");
    await sleep(150);
    check(s.screen.text().includes("> hello 中文"), `输入未上屏：\n${s.screen.text()}`, s.screen);
    await s.write("\r"); // 提交 → 进入上方 scrollback
    await sleep(120);
    const t1 = s.screen.text();
    check(t1.includes("❯ hello 中文"), "提交行未进入上方历史", s.screen);
    check(t1.split("\n").filter((l) => l.startsWith("───")).length >= 2, "帧的上下横线缺失/被覆盖", s.screen);
    check(t1.includes("STATUS | model"), "状态行缺失", s.screen);
    // 多行输入（Ctrl+J）→ 帧长高；再退格删回 → 帧变矮且无残影
    await s.write("line1");
    await s.write("\n");
    await s.write("line2");
    await sleep(150);
    check(s.screen.text().includes("> line1"), "多行第一行缺失", s.screen);
    check(s.screen.text().includes("  line2"), "多行第二行未对齐", s.screen);
    await s.write("\x7f".repeat(5)); // 删掉 line2
    await s.write("\x7f".repeat(5)); // 删掉换行 + line1
    await sleep(150);
    const after = s.screen.nonEmptyLines();
    const strayLine2 = after.filter((l) => l.trim() === "line2");
    check(strayLine2.length === 0, "帧长高后缩短留下残影（line2 仍可见）", s.screen);
    await s.write("\r"); // 清掉剩余半行输入（变成一条历史），避免污染滚动断言
    // 滚动：连提 30 行，帧应保持完整、上方历史可见
    for (let i = 0; i < 30; i++) await s.write(`commit-${String(i).padStart(2, "0")}\r`);
    await sleep(300);
    const t2 = s.screen.text();
    check(t2.includes("❯ commit-29"), "最后一次提交丢失", s.screen);
    check(t2.includes("❯ commit-00"), "滚动后较早的提交行丢失（应留在 scrollback）", s.screen);
    check(t2.includes("STATUS | model"), "滚动后状态行丢失", s.screen);
    const cur = s.screen.cursor();
    check(cur.row > 0, "滚动后光标坐标异常", s.screen);
    await s.write("\x03");
    await s.waitChildExit();
    if (VERBOSE) console.log(s.screen.text());
  } finally { await s.close(); }
}

/** P3：异步输出与输入交错。 */
async function probeInterleave(tmp: string): Promise<void> {
  const s = await startSession(tmp, "frame-interleave");
  try {
    await s.waitText("READY");
    await s.write("typ");
    await sleep(120);
    await s.write("ing");
    await sleep(400); // 期间 agent line 持续提交
    await s.write(" 中文");
    await sleep(120);
    const t = s.screen.text();
    check(t.includes("> typing 中文"), `交错时输入被吞/覆盖：\n${t}`, s.screen);
    check(t.includes("agent line 12 中文内容"), "异步输出未写进历史", s.screen);
    check(t.includes("STATUS | model"), "交错时状态行丢失", s.screen);
    await s.write("\r");
    await sleep(120);
    check(s.screen.text().includes("❯ typing 中文"), "交错后提交行丢失", s.screen);
    await s.write("\x03");
    await s.waitChildExit();
    if (VERBOSE) console.log(s.screen.text());
  } finally { await s.close(); }
}

/** P4：退出后终端模式恢复（stty 实证）。 */
async function probeRestore(tmp: string): Promise<void> {
  const s = await startSession(tmp, "frame", { post: "stty -a | head -3" });
  try {
    await s.waitText("READY");
    await s.write("abc");
    await sleep(100);
    await s.write("\x03");
    await s.waitChildExit();
    // 等 stty 输出落屏
    const deadline = Date.now() + 4000;
    while (!s.screen.text().includes("icanon") && Date.now() < deadline) await sleep(25);
    const t = s.screen.text();
    check(t.includes("DONE"), "子进程未正常收尾", s.screen);
    check(t.includes("CHILD_EXIT=0"), "子进程非 0 退出", s.screen);
    check(t.includes("icanon"), `raw mode 未恢复（stty 里没有 icanon）：\n${t.slice(-1200)}`, s.screen);
    check(!/-icanon/.test(t), `raw mode 未恢复（stty 仍显示 -icanon）：\n${t.slice(-1200)}`, s.screen);
    if (VERBOSE) console.log(t.slice(-1500));
  } finally { await s.close(); }
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function runChild(c: string): Promise<void> {
  childInit();
  switch (c) {
    case "keys": childKeys(); break;
    case "frame": childFrame(false); break;
    case "frame-interleave": childFrame(true); break;
    default: process.stderr.write(`unknown child case: ${c}\n`); process.exit(2);
  }
  // 保活：由 keypress/计时器驱动
  await new Promise<void>(() => {});
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--child") {
    await runChild(argv[1] ?? "");
    return 0;
  }
  const probes: Array<{ id: string; title: string; fn: (tmp: string) => Promise<void> }> = [
    { id: "p1", title: "P1 按键形态（Ctrl+O/Ctrl+J/Enter/UTF-8/方向键/bracketed paste）", fn: probeKeys },
    { id: "p2", title: "P2 live 帧（输入/提交/多行/高度变化/滚动）", fn: probeFrame },
    { id: "p3", title: "P3 异步输出与输入交错", fn: probeInterleave },
    { id: "p4", title: "P4 退出后终端模式恢复（stty）", fn: probeRestore },
  ];
  const wanted = argv.filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase());
  const picked = wanted.length === 0 ? probes : probes.filter((p) => wanted.includes(p.id));
  if (picked.length === 0) {
    console.log(`未匹配。可用：${probes.map((p) => p.id).join(", ")}`);
    return 2;
  }
  const tmpRoot = await mkdtemp(join(tmpdir(), "neo-tui-probe-"));
  console.log("── neo TUI M0 probe ──");
  console.log(`bun   ${Bun.version} / ${process.platform}`);
  console.log(`PTY   ${COLS}×${ROWS}`);
  console.log(`临时  ${tmpRoot}`);
  console.log("");
  let passed = 0;
  const results: Array<{ id: string; ok: boolean; ms: number; err?: string }> = [];
  try {
    for (const p of picked) {
      const started = Date.now();
      console.log(`▶ ${p.id} ${p.title}`);
      try {
        await p.fn(tmpRoot);
        const ms = Date.now() - started;
        console.log(`  PASS ${p.id}（${ms}ms）\n`);
        passed += 1;
        results.push({ id: p.id, ok: true, ms });
      } catch (e) {
        const ms = Date.now() - started;
        const err = e instanceof Error ? e.message : String(e);
        console.log(`  FAIL ${p.id}（${ms}ms）\n  ${err}\n`);
        if (e instanceof CheckError && e.screen) {
          const lines = e.screen.lines();
          const start = Math.max(0, lines.length - 30);
          console.log("  ── 屏幕尾部 ──");
          for (let i = start; i < lines.length; i++) console.log(`  ${String(i + 1).padStart(3)}│${lines[i]}`);
          console.log("");
        }
        results.push({ id: p.id, ok: false, ms, err });
      }
    }
  } finally {
    for (const h of [...live]) await killProc(h.proc);
    if (KEEP_TMP) console.log(`临时目录已保留：${tmpRoot}`);
    else await rm(tmpRoot, { recursive: true, force: true });
  }
  const failed = results.length - passed;
  console.log("── 汇总 ──");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id}${r.ok ? "" : ` — ${r.err}`}`);
  console.log(`  ${passed} passed / ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

process.exit(await main());
