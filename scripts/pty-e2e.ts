#!/usr/bin/env bun
/**
 * scripts/pty-e2e.ts — 真 PTY 端到端断言（v0.2.4 及以后可复用）。
 *
 * 场景：S1 流式 ● 前缀 / S2 /last 回看 / S3 窄终端宽度 / S4 --resume 回放 /
 *       S5 Tab 补全 @ 文件 / S6 Tab 补全 / 命令 / S7 Ctrl+J 多行 / S8 @ 引用送达模型 /
 *       S9 补全后光标在行尾 / S10 连按 Tab 遍历首轮候选。
 *
 * 输入约定（v0.2.4 起）：Enter = `\r`，Ctrl+J = `\n`。run.type() 写「一行 + Enter(\r)」；
 * 需要发 Ctrl+J 或精确控制换行时用 run.write() 写原始字节。
 *
 * 为什么必须用真 PTY：neo 的交互渲染（readline、spinner、紧凑工具行的
 * `\r\x1b[2K` 覆盖、COLUMNS 宽度）只有在 TTY 下才走不同分支；管道里的
 * 输出是块级渲染，测不到这些行为。这里用系统 `script(1)` 起一个真 PTY，
 * 跑真实的 neo 进程，再断言**屏幕最终内容**。
 *
 * 关键实现：
 *  - 最小屏幕缓冲（Screen）：\r 回行首、\x1b[2K 清行、\n 换行、宽字符占 2 列。
 *    只有这样才能正确解释「工具行原地覆盖」，而不是把每个写片段拼成一条长串。
 *  - waitFor(cond, timeout)：写一行 → 等条件满足 → 再写下一行，不用 sleep 猜时序。
 *  - fake-llm 用 PORT=0 由内核分配端口（读 READY 行拿实际端口），永远不会
 *    和本机其它进程/上一次残留的测试服务撞端口。
 *  - 每个场景独立临时目录 + 独立 neo 进程；结束（含失败）都杀进程、删临时目录。
 *
 * 用法：
 *   bun run scripts/pty-e2e.ts                 # 跑全部场景
 *   bun run scripts/pty-e2e.ts s1 s4           # 只跑名字含 s1/s4 的场景（调试用）
 *   bun run scripts/pty-e2e.ts s5 s7           # 只跑 v0.2.4 输入层场景
 *   bun run scripts/pty-e2e.ts s9 s10          # 只跑 Tab 循环/光标回归场景
 *   KEEP_TMP=1 bun run scripts/pty-e2e.ts      # 保留临时目录并在结尾打印路径
 *   NEO_ENTRY=/path/to/src/index.ts bun run scripts/pty-e2e.ts
 *                                              # 覆盖被测入口（用于「改动前」红态对照）
 *
 * 退出码：全部 PASS → 0，否则 → 1。
 */
import { closeSync, constants as fsConstants, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";

// 纯函数、无副作用：与 neo 渲染层使用同一套「显示列」规则（CJK/全角算 2 列）。
import { displayWidth } from "../src/ui/theme.ts";

/** 本脚本统一用 stdin/stderr/stdout 全 pipe 的进程形态。 */
type Proc = Subprocess<"pipe" | "ignore", "pipe", "pipe">;

/* ------------------------------------------------------------------ */
/* 常量与环境                                                          */
/* ------------------------------------------------------------------ */

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const FAKE_LLM = join(ROOT, "scripts/fake-llm.ts");
const NEO_ENTRY = process.env["NEO_ENTRY"]
  ? resolve(process.env["NEO_ENTRY"])
  : join(ROOT, "src", "index.ts");
const BUN = process.execPath;
const KEEP_TMP = process.env["KEEP_TMP"] === "1";
const IS_DARWIN = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

/** 默认终端尺寸（S3 会改成 60 列）。给 PTY 一个真实 winsize，避免 columns=0 回落。 */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 40;

/** 单次等待的默认上限；fake-llm 是本地即时响应，15s 足够宽松。 */
const WAIT_DEFAULT_MS = 15_000;

const SCRIPT_BIN = Bun.which("script") ?? "/usr/bin/script";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 最小屏幕缓冲                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把 PTY 字节流解释成「屏幕最终内容」。
 *
 * 只实现断言需要的子集：
 *   - \r → 回到行首；\n → 下一行；\b → 左移；\t → 下一个 8 列制表位
 *   - CSI: K（清行，0/1/2）、J（清屏）、A/B/C/D/E/F/G/H/f/d（光标）、
 *     P/@/X（删/插/擦字符）；m/h/l/s/u 等装饰序列直接忽略
 *   - OSC 序列整体跳过
 * 不做自动折行（PTY 的折行不产生换行字节）——因此宽行会保持为一条逻辑行，
 * 正好方便 S3 用 displayWidth 断言「逻辑行超宽」。
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
    if (w === 0) return; // 零宽字符不占列
    this.ensureRow(this.row);
    const row = this.rows[this.row] as string[];
    for (let k = 0; k < w; k++) {
      const c = this.col + k;
      while (row.length < c) row.push(" ");
      row[c] = k === 0 ? glyph : ""; // 宽字符占位：第二列留空，join 时只出现一次
    }
    this.col += w;
    // 防御异常控制流造成的列号爆炸（正常输出不会触发）
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
      if (bel === -1 && st === -1) return s.length - i; // 序列未收全，下一块再续
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
    if (next === "(" || next === ")") return 3; // 字符集选择
    return 2;
  }

  private applyCsi(paramsRaw: string, final: string): void {
    // DEC 私有序列（?2004h 等）不改变屏幕内容
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
        } else {
          if (row.length > this.col) row.length = this.col;
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
        // m（颜色）、h/l（模式）、s/u（保存/恢复）等不影响可见文本
        return;
    }
  }

  /** 屏幕所有行（去掉行尾空白；宽字符占位已合并）。 */
  lines(): string[] {
    return this.rows.map((row) => row.join("").replace(/\s+$/, ""));
  }

  text(): string {
    return this.lines().join("\n");
  }

  lastNonEmptyLine(): string {
    const lines = this.lines();
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = (lines[i] ?? "").trim();
      if (l !== "") return l;
    }
    return "";
  }

  cursorLine(): string {
    return (this.rows[this.row] ?? []).join("");
  }
}

/* ------------------------------------------------------------------ */
/* 进程管理                                                            */
/* ------------------------------------------------------------------ */

const liveProcs = new Set<ProcHandle>();

interface ProcHandle {
  proc: Proc;
  label: string;
}

interface FakeServer {
  proc: Proc;
  handle: ProcHandle;
  port: number;
  scenario: string;
  stderr: string;
  stop: () => Promise<void>;
}

interface NeoRun {
  proc: Proc;
  handle: ProcHandle;
  screen: Screen;
  stderr: string;
  exitCode: number | null;
  /** 原样写字节（不补换行）；Ctrl+J 多行等精确输入用这个。 */
  write: (text: string) => Promise<void>;
  /** 写一行并回车（自动补 Enter = \r；v0.2.4 起 \n 会被当成 Ctrl+J 续行）。 */
  type: (line: string) => Promise<void>;
  /** 等 neo 进程退出（默认 10s）。 */
  waitExit: (timeoutMs?: number) => Promise<number>;
  /** 幂等清理：没退出就 SIGTERM，再不行 SIGKILL。 */
  close: () => Promise<void>;
}

function shellQuote(s: string): string {
  // POSIX 单引号转义：把内部单引号替换成 '\'' 序列
  return "'" + s.replace(/'/g, "'\\''") + "'";
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

interface ProcHandle {
  proc: Proc;
  label: string;
}

async function stopFake(fake: FakeServer): Promise<void> {
  liveProcs.delete(fake.handle);
  try {
    fake.proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  await Promise.race([fake.proc.exited, sleep(2000)]);
}

/** 从进程 stdout 逐行读，直到匹配 READY 行；失败时带上 stderr。 */
async function waitFakeReady(fake: FakeServer, timeoutMs = 8000): Promise<number> {
  const decoder = new TextDecoder();
  const reader = fake.proc.stdout.getReader();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`等待 fake-llm READY 超时（${timeoutMs}ms）`);
      // 计时器用 resolve(null) 而不是 reject：reader.read() 先赢时不能让计时器变成未处理拒绝。
      const timedOut = sleep(remaining).then(() => null);
      const next = await Promise.race([reader.read(), timedOut]);
      if (next === null) throw new Error(`等待 fake-llm READY 超时（${timeoutMs}ms）`);
      if (next.done) {
        throw new Error(`fake-llm 未输出 READY 就退出了。stderr:\n${fake.stderr.trim() || "(空)"}`);
      }
      buffer += decoder.decode(next.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        const m = /FAKE_LLM_READY port=(\d+)/.exec(line);
        if (m) return Number(m[1]);
        if (line.trim() !== "") fake.stderr += `${line}\n`;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** 启动 fake-llm：PORT=0 → 内核分配端口，彻底规避端口冲突。 */
async function startFake(
  scenario: "tool-then-answer" | "narration" | "resume" | "echo-ref",
): Promise<FakeServer> {
  const proc = Bun.spawn([BUN, "run", FAKE_LLM], {
    cwd: ROOT,
    env: { ...cleanBaseEnv(), PORT: "0", SCENARIO: scenario },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const handle: ProcHandle = { proc, label: `fake-llm(${scenario})` };
  const fake: FakeServer = { proc, handle, port: 0, scenario, stderr: "", stop: async () => {} };
  void drainStderr(proc, (t) => (fake.stderr += t));
  liveProcs.add(handle);
  fake.port = await waitFakeReady(fake);
  fake.stop = async () => stopFake(fake);
  return fake;
}

async function drainStderr(proc: Proc, push: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of proc.stderr) push(decoder.decode(chunk as Uint8Array, { stream: true }));
  } catch {
    /* 进程退出时流关闭，忽略 */
  }
}

/** 继承父进程环境（PATH/LANG 等），但清掉所有 NEO 前缀变量与 COLUMNS/LINES，避免宿主环境串味。 */
function cleanBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("NEO_")) continue;
    if (k === "COLUMNS" || k === "LINES") continue;
    env[k] = v;
  }
  return env;
}

interface RunDirs {
  root: string;
  work: string;
  sessions: string;
  mailbox: string;
  home: string;
}

async function makeDirs(parent: string, name: string): Promise<RunDirs> {
  const root = join(parent, name);
  const dirs: RunDirs = {
    root,
    work: join(root, "work"),
    sessions: join(root, "sessions"),
    mailbox: join(root, "mailbox"),
    home: join(root, "home"),
  };
  for (const d of [dirs.work, dirs.sessions, dirs.mailbox, dirs.home]) {
    await mkdir(d, { recursive: true });
  }
  return dirs;
}

interface NeoOptions {
  fake: FakeServer;
  dirs: RunDirs;
  args?: string[];
  cols?: number;
  rows?: number;
  /** 用于日志与临时文件命名。 */
  name: string;
}

/**
 * 用系统 script(1) 起一个真 PTY 跑 neo。
 *
 * 平台差异封装在这里：
 *  - macOS:  /bin/sh -c 'cat <fifo> | script -q /dev/null /bin/sh <wrapper>'
 *  - Linux:  /bin/sh -c 'cat <fifo> | script -qec "<wrapper>" /dev/null'
 *
 * 为什么不用 Bun.spawn 的 stdin:"pipe" 直接喂 script：
 *   Bun 的 stdio pipe 实际是 socketpair；macOS 的 script(1) 启动时会对
 *   stdin 做 tcgetattr/ioctl，遇到 socket 直接报
 *   `script: tcgetattr/ioctl: Operation not supported on socket` 并退出。
 * 因此这里用命名管道（FIFO）作输入源，再经 `cat fifo | script` 让 script
 * 拿到的是真正的 pipe(2)。写入端用 O_NONBLOCK 打开、按行写入。
 *
 * wrapper 负责在 PTY 内先 `stty cols/rows`（winsize 必须是真实 ioctl，
 * 只设 COLUMNS 环境变量时 Bun 的 process.stdout.columns 仍是 0）再 exec neo。
 * 同时把 COLUMNS/LINES 也传进去，双保险。
 */
async function startNeo(opts: NeoOptions): Promise<NeoRun> {
  const { fake, dirs, name } = opts;
  const cols = opts.cols ?? DEFAULT_COLS;
  const rows = opts.rows ?? DEFAULT_ROWS;
  // --name 用唯一值：既隔离信箱身份，也作为兜底清理时 pkill -f 的匹配串
  //（此时别处同名 neo 不会被误杀）。
  const runId = `ptye2e-${name}-${Math.random().toString(36).slice(2, 8)}`;
  const args = ["--name", runId, ...(opts.args ?? [])];

  const wrapper = join(dirs.root, `run-neo-${name}.sh`);
  const fifo = join(dirs.root, `stdin-${name}.fifo`);
  const mkfifo = Bun.which("mkfifo") ?? "/usr/bin/mkfifo";
  const cat = Bun.which("cat") ?? "/bin/cat";

  try {
    await rm(fifo, { force: true });
  } catch {
    /* ignore */
  }
  const fifoRes = Bun.spawnSync([mkfifo, fifo], { stdout: "ignore", stderr: "pipe" });
  if (fifoRes.exitCode !== 0) {
    throw new Error(`创建 FIFO 失败：${fifoRes.stderr.toString() || fifo}`);
  }

  const wrapperBody = [
    "#!/bin/sh",
    `# 由 scripts/pty-e2e.ts 生成：PTY winsize 必须先于 neo 启动设置好`,
    `stty cols ${cols} rows ${rows} 2>/dev/null || true`,
    `exec ${shellQuote(BUN)} run ${shellQuote(NEO_ENTRY)} ${args.map(shellQuote).join(" ")}`.trimEnd(),
    "",
  ].join("\n");
  await writeFile(wrapper, wrapperBody, { mode: 0o755 });

  const inner = IS_DARWIN
    ? `${shellQuote(cat)} ${shellQuote(fifo)} | ${shellQuote(SCRIPT_BIN)} -q /dev/null /bin/sh ${shellQuote(wrapper)}`
    : IS_LINUX
      ? `${shellQuote(cat)} ${shellQuote(fifo)} | ${shellQuote(SCRIPT_BIN)} -qec ${shellQuote(`/bin/sh ${shellQuote(wrapper)}`)} /dev/null`
      : (() => {
          throw new Error(`不支持的平台：${process.platform}（本脚本依赖系统 script(1)）`);
        })();

  const env: Record<string, string> = {
    ...cleanBaseEnv(),
    HOME: dirs.home,
    NEO_BASE_URL: `http://127.0.0.1:${fake.port}/v1`,
    NEO_MODEL: "fake-model",
    NEO_API_KEY: "k",
    NEO_MEMORY_DISABLE: "1",
    NEO_SESSIONS_DIR: dirs.sessions,
    NEO_MAILBOX_DIR: dirs.mailbox,
    COLUMNS: String(cols),
    LINES: String(rows),
    TERM: "xterm-256color",
  };

  const proc = Bun.spawn(["/bin/sh", "-c", inner], {
    cwd: dirs.work,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  // cat 打开 FIFO 读端后，这里的 O_NONBLOCK 写端才会成功；用重试覆盖启动竞争。
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

  const handle: ProcHandle = { proc, label: `neo(${name})` };
  const run: NeoRun = {
    proc,
    handle,
    screen: new Screen(),
    stderr: "",
    exitCode: null,
    write: async (text: string) => {
      try {
        await writeFifo(writerFd, text);
      } catch {
        /* 进程已退出：由 waitFor 的提前退出检查统一报错 */
      }
    },
    type: async (line: string) => {
      try {
        // v0.2.4：\r 才是 Enter；\n 已被 Ctrl+J 多行语义占用。
        await writeFifo(writerFd, `${line}\r`);
      } catch {
        /* 进程已退出：由 waitFor 的提前退出检查统一报错 */
      }
    },
    waitExit: async (timeoutMs = 10_000) => {
      // 先关写端：cat 收到 EOF 后退出，`cat | script` 管道才有机会收口。
      closeWriter();
      const timedOut = sleep(timeoutMs).then(() => null);
      const code = await Promise.race([proc.exited, timedOut]);
      if (code === null) throw new Error(`等待 neo 退出超时（${timeoutMs}ms）`);
      run.exitCode = code;
      return code;
    },
    close: async () => {
      closeWriter();
      if (run.exitCode === null) await killProc(proc);
      // 兜底清理：shell 被信号打断时，管道里的 cat/script/neo 可能成为孤儿。
      // 三个模式都含本次运行独有的临时路径/名字，不会误伤其它 neo 进程。
      for (const pattern of [wrapper, fifo, runId]) {
        try {
          Bun.spawnSync(["pkill", "-f", pattern], { stdout: "ignore", stderr: "ignore" });
        } catch {
          /* pkill 不可用也不影响主流程 */
        }
      }
      liveProcs.delete(handle);
    },
  };
  liveProcs.add(handle);
  proc.exited.then((code) => {
    run.exitCode = code;
  });

  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of proc.stdout) run.screen.feed(decoder.decode(chunk as Uint8Array, { stream: true }));
    } catch {
      /* 进程结束时流关闭 */
    }
  })();
  void drainStderr(proc, (t) => (run.stderr += t));

  return run;
}

/* ------------------------------------------------------------------ */
/* FIFO 写入端                                                         */
/* ------------------------------------------------------------------ */

/** 等 cat 打开读端后打开 FIFO 写端（O_NONBLOCK 下无读端时 open 返回 ENXIO）。 */
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

/** 写一行到 FIFO；缓冲区满（EAGAIN）时短暂重试。 */
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

/* ------------------------------------------------------------------ */
/* 等待与断言                                                          */
/* ------------------------------------------------------------------ */

class CheckError extends Error {
  /** 失败时的屏幕（由最先知道 run 的调用方挂上，供 main 打印快照）。 */
  screen?: Screen;
  /** neo 的 stderr（PTY 里看不到的启动/崩溃信息）。 */
  stderr?: string;

  constructor(
    message: string,
    readonly focus: string[] = [],
    screen?: Screen,
    stderr?: string,
  ) {
    super(message);
    this.name = "CheckError";
    if (screen) this.screen = screen;
    if (stderr !== undefined) this.stderr = stderr;
  }
}

/** 给任意错误补上屏幕与 stderr，保证失败时一定有诊断信息。 */
function attachScreen(e: unknown, screen: Screen, stderr?: string): unknown {
  if (e instanceof CheckError) {
    if (!e.screen) e.screen = screen;
    if (e.stderr === undefined && stderr !== undefined) e.stderr = stderr;
  }
  return e;
}

/**
 * 轮询等待条件成立。
 * 不 sleep 猜时序：每 25ms 检查一次，条件一满足立刻返回；
 * neo 提前退出或超时则抛错（带原因），由场景层打印屏幕快照。
 */
async function waitFor(
  cond: () => boolean,
  opts: { label: string; timeoutMs?: number; run?: NeoRun },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (opts.run && opts.run.exitCode !== null) {
      throw new CheckError(
        `neo 在等待「${opts.label}」时提前退出（code ${opts.run.exitCode}）`,
        [opts.label],
        opts.run.screen,
      );
    }
    if (Date.now() > deadline) {
      throw new CheckError(`等待超时（${timeoutMs}ms）：${opts.label}`, [], opts.run?.screen);
    }
    await sleep(25);
  }
}

/** 轮询一段时间，条件成立返回 true、超时返回 false（用于「先试 A 再回退 B」）。 */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

/** 屏幕回到空闲提示符：最后一条非空行就是 `❯`。 */
function promptReady(screen: Screen): boolean {
  return screen.lastNonEmptyLine().trim() === "❯";
}

/** 屏幕上最后一个提示符行（`❯ ...`，含用户已敲入的内容）。 */
function lastPromptLine(screen: Screen): string | null {
  const lines = screen.lines();
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? "").trimEnd();
    if (t.startsWith("❯")) return t;
  }
  return null;
}

/**
 * 清空 readline 行缓冲（Tab 场景收尾用，避免 `/exit` 被追加到残留输入后面）。
 * 先试 Ctrl+U(0x15)；bun readline 不支持时退化为退格 0x7f（S9 已实测 Ctrl+U 可用）。
 * 返回实际生效的方式，供输出/报告标注。
 */
async function clearInputLine(run: NeoRun): Promise<string> {
  await run.write("\x15");
  if (await waitUntil(() => lastPromptLine(run.screen)?.trim() === "❯", 800)) return "Ctrl+U";
  await run.write("\x7f".repeat(40));
  await waitFor(() => lastPromptLine(run.screen)?.trim() === "❯", {
    label: "退格清空行缓冲",
    run,
    timeoutMs: 5000,
  });
  return "退格 ×40";
}

async function waitPrompt(run: NeoRun, label = "等待 neo 交互提示符"): Promise<void> {
  await waitFor(() => promptReady(run.screen), { label, run, timeoutMs: 20_000 });
}

/** 屏幕快照：失败时打印锚点前后各 20 行（锚点 = 最后命中 focus 的行，否则最后非空行）。 */
function printSnapshot(screen: Screen, focus: string[] = []): void {
  const lines = screen.lines();
  let lastNonEmpty = 0;
  for (let i = 0; i < lines.length; i++) if ((lines[i] ?? "").trim() !== "") lastNonEmpty = i;

  let anchor = lastNonEmpty;
  if (focus.length > 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i] ?? "";
      if (focus.some((f) => l.includes(f))) {
        anchor = i;
        break;
      }
    }
  }

  const start = Math.max(0, anchor - 20);
  const end = Math.min(lines.length, anchor + 21);
  console.log(`  ── 屏幕快照（第 ${start + 1}~${end} 行 / 共 ${lines.length} 行；>> 为锚点）──`);
  if (lines.length === 0) {
    console.log("  (屏幕为空)");
    return;
  }
  for (let i = start; i < end; i++) {
    const marker = i === anchor ? ">>" : "  ";
    const text = (lines[i] ?? "").replace(/\t/g, "  ");
    console.log(`${marker} ${String(i + 1).padStart(3, " ")}│${text}`);
  }
}

/** PTY_E2E_VERBOSE=1 时把 PASS 场景的屏幕也打出来（人工复核用，默认安静）。 */
function maybeDumpScreen(screen: Screen): void {
  if (process.env["PTY_E2E_VERBOSE"] !== "1") return;
  console.log("  ── 屏幕（PASS，供人工复核）──");
  printSnapshot(screen, []);
}

/** 在屏幕里找一条满足条件的行。 */
function findLine(
  screen: Screen,
  pred: (line: string) => boolean,
): { index: number; line: string } | null {
  const lines = screen.lines();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (pred(line)) return { index: i, line };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 场景                                                                */
/* ------------------------------------------------------------------ */

/**
 * 所有场景都加 `--auto off`：
 * 规则分类器会把「读一下 a.txt」判成 fast 档，applyTier 会把 cfg.baseUrl
 * 重置回 settings.json 里的真实 provider —— 离线 fake-llm 就被绕过了。
 * 测试必须隔离分类器，否则会偷偷访问真实网络、结果不可复现。
 */
const BASE_ARGS = ["--auto", "off"];

async function scenarioS1(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s1-narration");
  await writeFile(join(dirs.work, "a.txt"), "hello\n", "utf8");
  const fake = await startFake("narration");
  const run = await startNeo({ fake, dirs, name: "s1", args: BASE_ARGS, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  try {
    await waitPrompt(run);
    await run.type("读一下 a.txt");

    // 两轮「正文 + 工具」都会产出正文；第二段是 v0.2.3 D1 的回归点。
    await waitFor(() => run.screen.text().includes("先看看这个文件。"), {
      label: "屏幕出现第一段正文「先看看这个文件。」",
      run,
    });
    await waitFor(() => run.screen.text().includes("第二次说明。"), {
      label: "屏幕出现第二段正文「第二次说明。」",
      run,
    });

    // 断言：两段正文都必须带行首 ● 前缀（不是「出现过 ●」而是「每段都在 ● 行里」）。
    for (const target of ["先看看这个文件。", "第二次说明。"]) {
      const hit = findLine(
        run.screen,
        (l) => l.trimStart().startsWith("●") && l.includes(target),
      );
      if (!hit) {
        throw new CheckError(
          `正文「${target}」所在行缺少行首 ● 前缀（流式状态泄漏回归）`,
          ["●", target],
          run.screen,
        );
      }
    }

    maybeDumpScreen(run.screen);
    await waitPrompt(run, "narration 回放结束、回到提示符");
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

async function scenarioS2(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s2-last");
  await writeFile(join(dirs.work, "a.txt"), "hello\n", "utf8");
  const fake = await startFake("tool-then-answer");
  const run = await startNeo({
    fake,
    dirs,
    name: "s2",
    args: [...BASE_ARGS, "--yes", "--no-reasoning"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.type("读一下 a.txt");
    await waitFor(() => run.screen.text().includes("读完了：内容是 hello。"), {
      label: "第一轮完整结束（出现最终正文）",
      run,
    });
    await waitPrompt(run, "第一轮结束、回到提示符");

    // 基线：/last 之前已经滚过去的行。终答本身也含「hello」，
    // 所以必须只检查 /last 之后**新增**的行，否则会假阳性。
    const baseline = run.screen.lines().length;
    await run.type("/last");
    const newAfterLast = (): string => run.screen.lines().slice(baseline).join("\n");
    await waitFor(
      () => /1\s+hello/.test(newAfterLast()) || newAfterLast().includes("未知命令 /last"),
      { label: "/last 打印出 read_file 的完整输出（含行号 1 与 hello）", run },
    );
    if (newAfterLast().includes("未知命令 /last")) {
      throw new CheckError("/last 命令未实现（neo 回复「未知命令 /last」）", ["/last"], run.screen);
    }
    if (!/1\s+hello/.test(newAfterLast())) {
      throw new CheckError("/last 输出里没有 read_file 的完整正文（行号 1 + hello）", ["hello"], run.screen);
    }

    maybeDumpScreen(run.screen);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

async function scenarioS3(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s3-narrow");
  // 故意不创建 a.txt：让 read_file 失败，从而验证错误摘要的宽度与可读性。
  const fake = await startFake("tool-then-answer");
  const run = await startNeo({
    fake,
    dirs,
    name: "s3",
    args: [...BASE_ARGS, "--yes", "--no-reasoning"],
    cols: 60,
    rows: 40,
  });
  try {
    await waitPrompt(run);
    await run.type("读一下 a.txt");

    // 失败工具行（紧凑模式最终状态行：⚡ read_file ... ✗ 错误摘要）
    // 注意：窄终端下工具名本身可能被截成 `read_fi…`，所以只认 ⚡ + ✗ 两个稳定标记。
    await waitFor(
      () => findLine(run.screen, (l) => l.includes("⚡") && l.includes("✗")) !== null,
      { label: "窄终端下出现失败工具行（⚡ … ✗）", run },
    );
    // 失败详情的锚点行（v0.2.3 D3 会补「文件不存在 …」与 /last 提示）
    await waitFor(() => run.screen.text().includes("文件不存在"), {
      label: "失败详情包含「文件不存在」",
      run,
    });

    const hit = findLine(run.screen, (l) => l.includes("⚡") && l.includes("✗"));
    if (!hit) throw new CheckError("未找到失败工具行", ["read_file"], run.screen);
    const width = displayWidth(hit.line);
    if (width > 60) {
      throw new CheckError(`窄终端（60 列）下工具行超宽：displayWidth=${width}`, ["✗"], run.screen);
    }
    // 错误摘要不能被截成空串：✗ 之后必须还有可见文字。
    if (!/✗\s*\S/.test(hit.line)) {
      throw new CheckError("错误摘要被截成空串（✗ 后没有可见文字）", ["✗"], run.screen);
    }

    maybeDumpScreen(run.screen);
    await waitPrompt(run, "窄终端场景结束、回到提示符");
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

async function runResumeRound(
  fake: FakeServer,
  dirs: RunDirs,
  name: string,
  extraArgs: string[],
  opts: { expectReplay: boolean },
): Promise<void> {
  const run = await startNeo({
    fake,
    dirs,
    name,
    args: [...BASE_ARGS, "--yes", "--no-reasoning", ...extraArgs],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    if (opts.expectReplay) {
      // 恢复后立刻回放；red 态（改动前）只会打印「已恢复会话」，这里会超时失败。
      await waitFor(
        () => run.screen.text().includes("读一下 a.txt") && run.screen.text().includes("读完了：内容是 hello。"),
        { label: "--resume 屏幕回放上一轮问答（用户行 + 助手行）", run, timeoutMs: 12_000 },
      );
      await waitPrompt(run, "--resume 回放后回到提示符");
      maybeDumpScreen(run.screen);
    } else {
      await waitPrompt(run);
      await run.type("读一下 a.txt");
      await waitFor(() => run.screen.text().includes("读完了：内容是 hello。"), {
        label: "第一轮生成会话（出现最终正文）",
        run,
      });
      await waitPrompt(run, "第一轮结束、回到提示符（会话已落盘）");
    }
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
  }
}

async function scenarioS4(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s4-resume");
  await writeFile(join(dirs.work, "a.txt"), "hello\n", "utf8");
  const fake = await startFake("tool-then-answer");
  try {
    // 第一轮：生成并落盘会话（同一 NEO_SESSIONS_DIR）。
    await runResumeRound(fake, dirs, "s4-first", [], { expectReplay: false });
    // 第二轮：--resume 启动，断言屏幕回放上一轮问答。
    // --resume 必须放在参数最后：它后面没有值时才能取默认 "last"。
    await runResumeRound(fake, dirs, "s4-resume", ["--resume"], { expectReplay: true });
  } finally {
    await fake.stop();
  }
}

/* ------------------------------------------------------------------ */
/* v0.2.4 输入层场景：Tab 补全 / @ 引用 / Ctrl+J 多行                   */
/* ------------------------------------------------------------------ */

/** 会话目录里最新的 .json（S7 用它断言落盘的 user 消息）。 */
function latestSessionFile(dir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const path = join(dir, f);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
}

/** S5：`@a` + Tab → 插入 `@a.txt`；提交后出现 `· 已引用 1 个文件`。 */
async function scenarioS5(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s5-tab-file");
  await writeFile(join(dirs.work, "a.txt"), "alpha\n", "utf8");
  await mkdir(join(dirs.work, "src", "ui"), { recursive: true });
  await writeFile(join(dirs.work, "src", "ui", "console.ts"), "// 占位：让 @ 补全的索引里有层级目录\n", "utf8");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s5",
    args: [...BASE_ARGS, "--yes", "--no-reasoning"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    // 输入 `@a` 后按 Tab：@ 文件补全应把 token 替换成 `@a.txt`（单候选，没有候选提示行）。
    await run.write("@a\t");
    await waitFor(() => findLine(run.screen, (l) => /❯\s*@a\.txt/.test(l)) !== null, {
      label: "Tab 后行缓冲出现补全结果 @a.txt",
      run,
    });
    await run.write("\r");
    await waitFor(() => run.screen.text().includes("· 已引用 1 个文件"), {
      label: "提交后屏幕出现「· 已引用 1 个文件」",
      run,
    });
    await waitFor(() => run.screen.text().includes("会话恢复测试答案。"), {
      label: "引用轮完成（fake-llm 回包）",
      run,
    });
    await waitPrompt(run, "S5 结束、回到提示符");
    maybeDumpScreen(run.screen);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** S6：`/las` + Tab → 插入 `/last`；提交后不得出现「未知命令」。 */
async function scenarioS6(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s6-tab-command");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s6",
    args: [...BASE_ARGS, "--yes", "--no-reasoning"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    // `/las` 只有一个模糊候选（/last），因此不会有「N 个候选」提示行可依赖。
    await run.write("/las\t");
    await waitFor(() => findLine(run.screen, (l) => /❯\s*\/last\b/.test(l)) !== null, {
      label: "Tab 后行缓冲出现补全结果 /last",
      run,
    });
    await run.write("\r");
    // 等待命令处理完、提示符回来；然后断言没有「未知命令」。
    await waitPrompt(run, "提交补全出的 /last 后回到提示符");
    if (run.screen.text().includes("未知命令")) {
      throw new CheckError("补全出的 /last 提交后被判为未知命令", ["未知命令", "/last"], run.screen);
    }
    maybeDumpScreen(run.screen);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** S7：Ctrl+J 续行（提示符 `… `）→ Enter 提交一条含 \n 的 user 消息。 */
async function scenarioS7(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s7-multiline");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s7",
    args: [...BASE_ARGS, "--yes", "--no-reasoning"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    // Ctrl+J = 0x0A：续行（不是提交）。必须等提示符切换后再发下一行：
    // 两行若挤在同一个 stdin 分块里，newlineKindFromBytes 只能看到最后一个换行字节。
    await run.write("第一行\n");
    await waitFor(() => run.screen.lastNonEmptyLine().trim() === "…", {
      label: "Ctrl+J 后续行提示符变为 …",
      run,
    });
    // Enter = 0x0D：提交拼接后的单条消息。
    await run.write("第二行\r");
    await waitFor(() => run.screen.text().includes("… 第二行"), {
      label: "续行提示符下出现「… 第二行」",
      run,
    });
    await waitFor(() => run.screen.text().includes("会话恢复测试答案。"), {
      label: "多行消息送达模型并收到回复",
      run,
    });
    await waitPrompt(run, "多行 turn 结束、回到提示符");

    // 会话 JSON：user 消息必须是含 \n 的一条（不是两条独立消息）。
    const file = latestSessionFile(dirs.sessions);
    if (!file) throw new CheckError("会话目录里没有 json 文件（persist 未落盘）", ["第一行"], run.screen);
    const raw = readFileSync(file, "utf8");
    let content: unknown;
    try {
      const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }> };
      const users = (parsed.messages ?? []).filter((m) => m.role === "user");
      content = users.at(-1)?.content;
    } catch (e) {
      throw new CheckError(`会话 JSON 解析失败：${(e as Error).message}`, ["第一行"], run.screen);
    }
    if (content !== "第一行\n第二行") {
      throw new CheckError(
        `会话 JSON 的 user 消息不是「第一行\\n第二行」（实际 ${JSON.stringify(content)}）`,
        ["第一行", "第二行"],
        run.screen,
      );
    }
    // JSON.stringify 会把真实换行转义成两个字符 \n —— 原文里应能直接看到转义形式。
    if (!raw.includes("第一行\\n第二行")) {
      throw new CheckError("会话 JSON 原文里没有转义形式的第一行\\n第二行", ["第一行"], run.screen);
    }

    maybeDumpScreen(run.screen);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** S8：`@a.txt` 提交后，模型收到的 user 消息里必须带引用分隔标记（fake-llm 回 REF_OK）。 */
async function scenarioS8(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s8-ref-delivery");
  await writeFile(join(dirs.work, "a.txt"), "alpha\n", "utf8");
  const fake = await startFake("echo-ref");
  const run = await startNeo({
    fake,
    dirs,
    name: "s8",
    args: [...BASE_ARGS, "--yes", "--no-reasoning"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    // 手工输入 @a.txt（不依赖 Tab 补全），提交时 expandReferences 会把内容附在 user 消息末尾。
    await run.type("@a.txt");
    await waitFor(
      () => run.screen.text().includes("REF_OK") || run.screen.text().includes("REF_MISS"),
      { label: "模型回应引用检测结果（REF_OK / REF_MISS）", run },
    );
    if (!run.screen.text().includes("REF_OK")) {
      throw new CheckError("模型收到 REF_MISS：@ 引用内容没有随消息送达", ["REF_MISS"], run.screen);
    }
    await waitPrompt(run, "S8 结束、回到提示符");
    maybeDumpScreen(run.screen);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** S9：Tab 补全后光标必须留在行尾（再输入 X 应得到 `@a.txtX`，而不是 `X@a.txt`）。 */
async function scenarioS9(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s9-cursor-after-tab");
  await writeFile(join(dirs.work, "a.txt"), "alpha\n", "utf8");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s9",
    args: [...BASE_ARGS, "--yes", "--no-reasoning"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    // @a + Tab：单候选 @a.txt（光标应在行尾，即 cursor=6）。
    await run.write("@a\t");
    await waitFor(
      () => {
        const line = lastPromptLine(run.screen);
        return line !== null && line.includes("@a.txt");
      },
      { label: "Tab 后行缓冲出现 @a.txt", run },
    );
    // 继续输入 X：光标若被 rl.prompt() 归零，屏幕会出现「X@a.txt」而不是「@a.txtX」。
    await run.write("X");
    await waitFor(
      () => {
        const line = lastPromptLine(run.screen);
        return line !== null && /❯\s*@a\.txtX\s*$/.test(line);
      },
      { label: "Tab 后继续输入 X 落在行尾（❯ @a.txtX）", run, timeoutMs: 5000 },
    );
    const lineAfterX = lastPromptLine(run.screen) ?? "";
    if (/❯\s*X@a\.txt/.test(lineAfterX)) {
      throw new CheckError(`补全后光标被重置到行首：屏幕出现「${lineAfterX}」`, ["X@a.txt"], run.screen);
    }

    // 清行：Ctrl+U 优先，不支持时退格回退（helper 内处理）。
    const clearMethod = await clearInputLine(run);
    console.log(`  · 清行方式：${clearMethod}${clearMethod === "Ctrl+U" ? "（Ctrl+U 可用）" : "（Ctrl+U 不可用，已回退退格）"}`);

    // 清空后重新走引用流程，确认清行没有破坏后续输入。
    await run.type("@a.txt");
    await waitFor(() => run.screen.text().includes("· 已引用 1 个文件"), {
      label: "清行后重新提交 @a.txt 触发引用",
      run,
    });
    await waitFor(() => run.screen.text().includes("会话恢复测试答案。"), {
      label: "引用轮完成（fake-llm 回包）",
      run,
    });
    await waitPrompt(run, "S9 结束、回到提示符");
    maybeDumpScreen(run.screen);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** S10：连按 Tab 必须在**首轮候选集**里循环（不能第二按就重新搜索、候选集缩小）。 */
async function scenarioS10(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s10-tab-cycle");
  const expected = ["@alpha1.txt", "@alpha2.txt", "@alpha3.txt"];
  for (const name of ["alpha1.txt", "alpha2.txt", "alpha3.txt"]) {
    await writeFile(join(dirs.work, name), `${name}\n`, "utf8");
  }
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s10",
    args: [...BASE_ARGS, "--yes", "--no-reasoning"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.write("@alpha");
    await waitFor(() => lastPromptLine(run.screen)?.includes("@alpha") === true, {
      label: "输入 @alpha 后提示符行可见",
      run,
    });

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const prev = lastPromptLine(run.screen);
      await run.write("\t");
      await waitFor(
        () => {
          const line = lastPromptLine(run.screen);
          return line !== null && line !== prev && /@alpha\d\.txt/.test(line);
        },
        { label: `第 ${i + 1} 次 Tab 后行缓冲切换到新的候选`, run, timeoutMs: 5000 },
      );
      const line = lastPromptLine(run.screen) ?? "";
      const m = /❯\s*(@\S+)/.exec(line);
      seen.push(m?.[1] ?? `<无法解析：${line}>`);
    }

    if (new Set(seen).size !== 3) {
      throw new CheckError(
        `连按 Tab 没有遍历到 3 个互不相同的候选：${JSON.stringify(seen)}`,
        ["@alpha"],
        run.screen,
      );
    }
    const expectedSet = new Set(expected);
    for (const got of seen) {
      if (!expectedSet.has(got)) {
        throw new CheckError(
          `第 ${seen.indexOf(got) + 1} 次 Tab 得到的候选「${got}」不在首轮候选集 [${expected.join(", ")}] 内`,
          ["@alpha"],
          run.screen,
        );
      }
    }

    // 多候选首次 Tab 的提示行：应含「3 个文件候选」。提示行可能被重绘擦掉，
    // 这里只要它曾经出现在屏幕缓冲里即可（不要求顺序/具体候选文案）。
    if (!run.screen.text().includes("3 个文件候选")) {
      throw new CheckError(
        "多候选提示行缺失：屏幕缓冲里没有「3 个文件候选」（第一次 Tab 应打印候选提示）",
        ["候选", "@alpha"],
        run.screen,
      );
    }

    maybeDumpScreen(run.screen);
    // 不提交候选，直接退出；但必须先清空行缓冲，否则 /exit 会被追加成
    // `@alpha3.txt/exit` 当普通消息发出去，进程永远不退出。
    const clearMethod = await clearInputLine(run);
    console.log(`  · 退出前清行方式：${clearMethod}${clearMethod === "Ctrl+U" ? "（Ctrl+U 可用）" : "（Ctrl+U 不可用，已回退退格）"}`);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

interface Scenario {
  /** 场景 id（也可用于命令行过滤，如 s1/s2）。 */
  id: string;
  title: string;
  fn: (tmpRoot: string) => Promise<void>;
  /** 失败快照的锚点文本。 */
  focus: string[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "s1",
    title: "S1 narration：两轮正文都有行首 ● 前缀",
    fn: scenarioS1,
    focus: ["●", "先看看这个文件。", "第二次说明。"],
  },
  {
    id: "s2",
    title: "S2 /last：回看 read_file 的完整输出",
    fn: scenarioS2,
    focus: ["/last", "hello", "read_file"],
  },
  {
    id: "s3",
    title: "S3 窄终端（COLUMNS=60）：工具行不超宽、错误摘要非空",
    fn: scenarioS3,
    focus: ["read_file", "✗", "文件不存在"],
  },
  {
    id: "s4",
    title: "S4 --resume：回放上一轮问答",
    fn: scenarioS4,
    focus: ["回放", "读一下 a.txt", "读完了：内容是 hello。"],
  },
  {
    id: "s5",
    title: "S5 Tab 补全 @ 文件：插入 @a.txt 并触发引用",
    fn: scenarioS5,
    focus: ["@a.txt", "已引用"],
  },
  {
    id: "s6",
    title: "S6 Tab 补全 / 命令：/las → /last",
    fn: scenarioS6,
    focus: ["/last", "未知命令"],
  },
  {
    id: "s7",
    title: "S7 Ctrl+J 多行：一条含 \\n 的 user 消息",
    fn: scenarioS7,
    focus: ["… 第二行", "第一行"],
  },
  {
    id: "s8",
    title: "S8 @ 引用送达模型：REF_OK",
    fn: scenarioS8,
    focus: ["REF_OK", "@a.txt"],
  },
  {
    id: "s9",
    title: "S9 补全后光标在行尾：@a.txt + X → @a.txtX",
    fn: scenarioS9,
    focus: ["@a.txtX", "@a.txt", "已引用"],
  },
  {
    id: "s10",
    title: "S10 连按 Tab 遍历首轮候选：alpha1/2/3",
    fn: scenarioS10,
    focus: ["@alpha", "候选"],
  },
];

function selected(argv: string[]): Scenario[] {
  const wanted = argv.filter((a) => !a.startsWith("-")).map((a) => a.toLowerCase());
  if (wanted.length === 0) return SCENARIOS;
  return SCENARIOS.filter((s) => wanted.some((w) => s.id === w || s.title.toLowerCase().includes(w)));
}

async function main(): Promise<number> {
  const picked = selected(process.argv.slice(2));
  if (picked.length === 0) {
    console.log(`未匹配到场景。可用：${SCENARIOS.map((s) => s.id).join(", ")}`);
    return 2;
  }

  console.log("── neo PTY E2E ──");
  console.log(`平台      ${process.platform} / bun ${Bun.version}`);
  console.log(`被测入口  ${NEO_ENTRY}`);
  console.log(`fake-llm  ${FAKE_LLM}`);
  console.log(`场景      ${picked.map((s) => s.id).join(", ")}`);
  console.log("");

  const tmpRoot = await mkdtemp(join(tmpdir(), "neo-pty-e2e-"));
  const results: Array<{ scenario: Scenario; ok: boolean; ms: number; error?: string }> = [];

  const cleanup = async (): Promise<void> => {
    for (const item of [...liveProcs]) {
      await killProc(item.proc);
      liveProcs.delete(item);
    }
  };
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    for (const scenario of picked) {
      const started = Date.now();
      console.log(`▶ ${scenario.id} ${scenario.title}`);
      try {
        await scenario.fn(tmpRoot);
        const ms = Date.now() - started;
        console.log(`  PASS ${scenario.id}（${ms}ms）\n`);
        results.push({ scenario, ok: true, ms });
      } catch (e) {
        const ms = Date.now() - started;
        const err = e instanceof Error ? e.message : String(e);
        console.log(`  FAIL ${scenario.id}（${ms}ms）`);
        console.log(`  原因：${err}`);
        if (e instanceof CheckError && e.screen) {
          printSnapshot(e.screen, e.focus.length > 0 ? e.focus : scenario.focus);
        }
        if (e instanceof CheckError && e.stderr && e.stderr.trim() !== "") {
          console.log(`  ── neo stderr ──`);
          for (const line of e.stderr.trim().split("\n").slice(-20)) console.log(`  ${line}`);
        }
        console.log("");
        results.push({ scenario, ok: false, ms, error: err });
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
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.scenario.id}  ${r.scenario.title}${r.ok ? "" : ` — ${r.error}`}`);
  }
  console.log(`  ${passed} passed / ${failed} failed`);

  return failed === 0 ? 0 : 1;
}

process.exit(await main());
