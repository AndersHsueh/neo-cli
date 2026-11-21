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
import { closeSync, constants as fsConstants, existsSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";

// 纯函数、无副作用：与 neo 渲染层使用同一套「显示列」规则（CJK/全角算 2 列）。
import { displayWidth } from "../src/ui/theme.ts";
import { VERSION } from "../src/cli/version.ts";

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
  scenario:
    | "tool-then-answer"
    | "narration"
    | "resume"
    | "echo-ref"
    | "slow"
    | "slow-500"
    | "slow-800"
    | "write-then-answer"
    | "ask-user"
    | "steer",
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
  /** 是否自动加 --name（默认 true；resume 场景传 false 以测「无 --name 时保留旧名」）。 */
  autoName?: boolean;
  /** 启动 1.5s 后把 PTY 改窄（测 resize 下帧/输入框不串行）。 */
  resizeToCols?: number;
  /** 启动前在临时 cwd 里写 settings.json（默认用 PTY_SETTINGS）。false = 不写（#88 向导）。 */
  settings?: Record<string, unknown> | false;
  /** 启动前在临时 cwd 里写项目记忆文件（AGENTS.md 内容）。 */
  agentsMd?: string;
  /** 额外环境变量，后写覆盖默认值。 */
  extraEnv?: Record<string, string>;
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
  const args = [...(opts.autoName === false ? [] : ["--name", runId]), ...(opts.args ?? [])];

  const wrapper = join(dirs.root, `run-neo-${name}.sh`);
  const fifo = join(dirs.root, `stdin-${name}.fifo`);
  const mkfifo = Bun.which("mkfifo") ?? "/usr/bin/mkfifo";
  const cat = Bun.which("cat") ?? "/bin/cat";

  // 确定性配置写到临时 cwd：config.loadConfig 的第一优先级就是 <cwd>/settings.json。
  // #88：settings === false 时不写，好测「没有候选文件」的初次使用向导。
  if (opts.settings !== false) {
    await writeFile(
      join(dirs.work, "settings.json"),
      JSON.stringify(opts.settings ?? PTY_SETTINGS, null, 2),
      "utf8",
    );
  }
  // issue #18 S22：项目记忆文件必须早于 neo 启动落盘，否则启动时找不到。
  if (opts.agentsMd !== undefined) {
    await writeFile(join(dirs.work, "AGENTS.md"), opts.agentsMd, "utf8");
  }

  try {
    await rm(fifo, { force: true });
  } catch {
    /* ignore */
  }
  const fifoRes = Bun.spawnSync([mkfifo, fifo], { stdout: "ignore", stderr: "pipe" });
  if (fifoRes.exitCode !== 0) {
    throw new Error(`创建 FIFO 失败：${fifoRes.stderr.toString() || fifo}`);
  }

  const resizeLine =
    opts.resizeToCols !== undefined
      ? `( sleep 1.5; stty cols ${opts.resizeToCols} rows ${rows} < /dev/tty 2>/dev/null ) &`
      : "";
  const wrapperBody = [
    "#!/bin/sh",
    `# 由 scripts/pty-e2e.ts 生成：PTY winsize 必须先于 neo 启动设置好`,
    `stty cols ${cols} rows ${rows} 2>/dev/null || true`,
    resizeLine,
    `exec ${shellQuote(BUN)} run ${shellQuote(NEO_ENTRY)} ${args.map(shellQuote).join(" ")}`.trimEnd(),
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
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
    // issue #18：启动诊断日志落到本次运行的临时 HOME 下，S22 才能断言
    // 「诊断确实进了日志通道」而不是进了 TUI（不设会写到真实 ~/.neo/logs）。
    NEO_LOG_DIR: join(dirs.home, ".neo", "logs"),
    COLUMNS: String(cols),
    LINES: String(rows),
    TERM: "xterm-256color",
    ...opts.extraEnv,
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

/** v0.3.0 场景用的断言助手（失败时带上屏幕快照）。 */
function check(cond: boolean, msg: string, screen?: Screen): void {
  if (!cond) throw new CheckError(msg, [], screen);
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

/** 屏幕回到空闲输入状态。
 *  v0.3.0 起 TTY 用底部 live 帧：输入行含 `❯`，最后一行是状态行（含 `ctx`）；
 *  忙碌时顶线标题带「运行中」。旧版（非 TTY / 回退）仍是单独一行 `❯`。 */
function promptReady(screen: Screen): boolean {
  const last = screen.lastNonEmptyLine().trim();
  if (last === "❯") return true;
  const lines = screen.lines();
  const hasInput = lines.some((l) => l.trim().startsWith("❯"));
  return hasInput && last.includes("ctx ") && !screen.text().includes("运行中");
}

/** 屏幕上最后一个提示符行（`❯ ...`，含用户已敲入的内容；v0.3.0 的输入行也以 ❯ 开头）。 */
function lastPromptLine(screen: Screen): string | null {
  const lines = screen.lines();
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = (lines[i] ?? "").trimEnd();
    if (t.trimStart().startsWith("❯")) return t;
  }
  return null;
}

/** 输入行是否为空（v0.3.0 空输入会显示 placeholder）。 */
function inputEmpty(screen: Screen): boolean {
  const line = lastPromptLine(screen);
  if (line === null) return false;
  const t = line.trim();
  return t === "❯" || t.includes("输入消息");
}

/**
 * 清空 readline 行缓冲（Tab 场景收尾用，避免 `/exit` 被追加到残留输入后面）。
 * 先试 Ctrl+U(0x15)；bun readline 不支持时退化为退格 0x7f（S9 已实测 Ctrl+U 可用）。
 * 返回实际生效的方式，供输出/报告标注。
 */
async function clearInputLine(run: NeoRun): Promise<string> {
  await run.write("\x15");
  if (await waitUntil(() => inputEmpty(run.screen), 800)) return "Ctrl+U";
  await run.write("\x7f".repeat(40));
  await waitFor(() => inputEmpty(run.screen), {
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

/**
 * v0.4.0 平台适配层：PTY 场景必须与「开发机根目录的 settings.json」解耦。
 *
 * 之前 S16 断言菜单里的路由提示为 glm-5.3-flash —— 那是本机 settings.json 的
 * provider 配置。macOS 根目录有 settings.json 时能过；Ubuntu/CI 检出没有
 * （settings.json 已 gitignore）就会回落到 settings.example.json，菜单显示
 * example / your-model-id → S16 红。这里在临时 cwd 写一份确定性配置，
 * 让 PTY 验收在任何机器上同构。
 */
const PTY_SETTINGS = {
  default_provider: "pty-fake",
  default_model_tier: "default",
  classifier_provider: "pty-fake",
  classifier_model_name: "glm-5.3-flash",
  providers: [
    {
      provider_name: "pty-fake",
      provider_type: "openai",
      base_url: "http://127.0.0.1:1/v1",
      api_key: "k",
      default_model_name: "glm-5.3-flash",
      deep_reasoning_model_name: "glm-5.3-glacier",
      balanced_model_name: "glm-5.3-balanced",
      fast_model_name: "glm-5.3-flash",
    },
  ],
  model_routes: { default: "pty-fake" },
  memory: { enabled: false },
};

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
    // 注意：v0.3.0 的 live 帧在底部，/last 的输出会插到帧上方，
    // 之前的行数 baseline 不再等于「新增行」的起点；直接对全屏断言。
    await run.type("/last");
    const newAfterLast = (): string => run.screen.text();
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

/**
 * 读本次运行的启动诊断日志（issue #18：诊断只写 `<NEO_LOG_DIR>/boot/<day>.jsonl`）。
 * 返回解析后的条目；目录/文件不存在返回空数组（启动没写诊断也是合法状态）。
 */
function readBootLog(dirs: RunDirs): Array<{ kind: string; message: string }> {
  const dir = join(dirs.home, ".neo", "logs", "boot");
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: Array<{ kind: string; message: string }> = [];
  for (const name of names) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as { kind: string; message: string });
      } catch {
        /* 半行（进程被杀时）忽略 */
      }
    }
  }
  return out;
}

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
    // v0.3.0：多行不再切换「… 」提示符，而是输入框内出现第二行（对齐两个空格）。
    await waitFor(
      () => {
        const lines = run.screen.lines();
        const at = lines.findIndex((l) => l.startsWith("❯ 第一行"));
        // 空输入行在屏幕缓冲里被去掉行尾空白 → 第二行表现为「紧接着的空白行」
        return at >= 0 && (lines[at + 1] ?? "").trim() === "" && lines.length > at + 2;
      },
      { label: "Ctrl+J 后输入框出现第二行", run },
    );
    // Enter = 0x0D：提交拼接后的单条消息。
    // 第二行与 Enter 同一批写入：提交后输入框即清空，不再断言「第二行」停在框内；
    // 多行语义由后面的会话 JSON「第一行\n第二行」断言兜底。
    await run.write("第二行\r");
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
/* v0.3.0 常驻状态条 + 自绘输入框场景                                  */
/* ------------------------------------------------------------------ */

/** 状态行 = 帧最后一条含 ctx 与分隔符的非空行。 */
function statusLineOf(screen: Screen): string | null {
  const lines = screen.lines();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] ?? "").trimEnd();
    if (l.includes("ctx ") && l.includes("·")) return l;
  }
  return null;
}

/** 顶线标题行（最后一条含 Agent: 的横线）。 */
function titleLineOf(screen: Screen): string | null {
  const lines = screen.lines();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] ?? "").trimEnd();
    if (l.trim().startsWith("─") && l.includes("Agent:")) return l;
  }
  return null;
}

/** 顶线标题里的显示名（Agent: <name>）。 */
function titleNameOf(screen: Screen): string | null {
  const line = titleLineOf(screen);
  if (!line) return null;
  return line
    .replace(/^─+/, "")
    .replace(/─+$/, "")
    .trim()
    .replace(/^Agent:\s*/, "")
    .trim();
}

/** 在 work 目录造一个真 git 仓库（main 分支），用于状态条分支字段断言。 */
function initGitRepo(cwd: string): void {
  const run = (args: string[]): void => {
    const r = Bun.spawnSync(args, { cwd, stdout: "ignore", stderr: "ignore" });
    if (r.exitCode !== 0) throw new CheckError(`git 初始化失败：${args.join(" ")}`);
  };
  run(["git", "init", "-q"]);
  run(["git", "symbolic-ref", "HEAD", "refs/heads/main"]);
  run(["git", "config", "user.email", "pty@example.com"]);
  run(["git", "config", "user.name", "pty"]);
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "init"]);
}

/** S11：状态条常驻 / 忙碌态 / 排队输入。 */
async function scenarioS11(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s11-statusline");
  await writeFile(join(dirs.work, "a.txt"), "hello\n", "utf8");
  initGitRepo(dirs.work);
  const fake = await startFake("slow");
  const run = await startNeo({
    fake,
    dirs,
    name: "s11",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    const s0 = statusLineOf(run.screen);
    check(s0 !== null, "初始状态行缺失", run.screen);
    check(s0!.includes("fake-model"), `状态行缺 model：${s0}`, run.screen);
    check(s0!.includes("default"), `状态行缺 tier：${s0}`, run.screen);
    check(s0!.includes("ctx "), `状态行缺 ctx：${s0}`, run.screen);
    check(s0!.includes("⎇ main"), `状态行缺 git 分支：${s0}`, run.screen);
    check(s0!.includes("tok"), `状态行缺 tok：${s0}`, run.screen);

    await run.type("第一问");
    await waitFor(() => run.screen.text().includes("运行中"), {
      label: "turn 进行中顶线出现「运行中」",
      run,
      timeoutMs: 8000,
    });
    check(statusLineOf(run.screen) !== null, "turn 进行中状态行消失", run.screen);
    await waitFor(() => /0:0[1-9]/.test(statusLineOf(run.screen) ?? ""), {
      label: "状态条的本轮时长在递增（不是一直 0:00）",
      run,
      timeoutMs: 8000,
    });

    // 忙碌中输入并回车 → 排队（状态行出现「排队」）
    await run.type("排队消息");
    await waitFor(() => (statusLineOf(run.screen) ?? "").includes("排队"), {
      label: "忙碌时提交的消息进入排队（状态行有提示）",
      run,
      timeoutMs: 6000,
    });

    // 两轮慢回答都要完成；排队消息必须以「❯ 排队消息」进入历史
    await waitFor(
      () => (run.screen.text().match(/慢回答完成。/g) ?? []).length >= 2,
      { label: "两轮都完成（含排队消息）", run, timeoutMs: 25_000 },
    );
    await waitPrompt(run, "两轮结束、回到提示符");
    check(
      run.screen.lines().some((l) => l.startsWith("❯ 排队消息")),
      "排队消息没有作为用户行进入历史",
      run.screen,
    );
    check(statusLineOf(run.screen) !== null, "turn 结束后状态行消失", run.screen);
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

/** S12：输入框视觉 + 中文/emoji + 退格按整字。 */
async function scenarioS12(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s12-inputbox");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s12",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    // 上横线 + 下横线都在
    const ruleCount = run.screen.lines().filter((l) => /^─+/.test(l.trim())).length;
    check(ruleCount >= 2, `输入框横线缺失（找到 ${ruleCount} 条）`, run.screen);
    check(statusLineOf(run.screen) !== null, "输入框下没有状态行", run.screen);

    const typed = "中文输入 😀 test";
    await run.type(typed);
    await waitFor(() => run.screen.lines().some((l) => l.trimStart().startsWith(`❯ ${typed}`)), {
      label: "中文/emoji 输入上屏",
      run,
      timeoutMs: 8000,
    });
    const row = run.screen.lines().find((l) => l.trimStart().startsWith(`❯ ${typed}`)) ?? "";
    check(displayWidth(row.trimEnd()) <= DEFAULT_COLS, `输入行超宽：${displayWidth(row)} 列`, run.screen);
    check(!row.includes("\ufffd"), "输入行出现替换字符（UTF-8 解码坏了）", run.screen);

    // 中文退格：一次只删一个字
    await run.write("\x15"); // Ctrl+U 清行
    await waitFor(() => inputEmpty(run.screen), { label: "Ctrl+U 清行", run, timeoutMs: 5000 });
    await run.write("你好");
    await waitFor(() => run.screen.lines().some((l) => l.trimStart().startsWith("❯ 你好")), {
      label: "中文上屏",
      run,
    });
    await run.write("\x7f"); // Backspace
    await waitFor(
      () =>
        run.screen.lines().some((l) => l.trimStart().startsWith("❯ 你")) &&
        !run.screen.lines().some((l) => l.trimStart().startsWith("❯ 你好")),
      { label: "退格一次只删一个汉字", run, timeoutMs: 5000 },
    );
    // 宽字符压力：60 个 emoji（=120 列）必须折进输入框、不把帧行撑超宽
    await run.write("\x15");
    await waitFor(() => inputEmpty(run.screen), { label: "清行（emoji 压力前）", run, timeoutMs: 5000 });
    await run.write("😀".repeat(60));
    await waitFor(() => run.screen.text().includes("😀"), { label: "emoji 输入上屏", run, timeoutMs: 8000 });
    const emojiLines = run.screen.lines();
    const top = emojiLines.findLastIndex((l) => l.trim().startsWith("─") && l.includes("Agent:"));
    const bottom = emojiLines.findIndex((l, i) => i > top && l.trim().startsWith("─") && !l.includes("Agent:"));
    check(top >= 0 && bottom > top, "emoji 输入后找不到输入框边界", run.screen);
    for (const l of emojiLines.slice(top, bottom + 1)) {
      check(displayWidth(l.trimEnd()) <= DEFAULT_COLS, `emoji 输入行超宽（${displayWidth(l)} 列）`, run.screen);
    }
    // 清行后退出
    await run.write("\x15");
    await waitFor(() => inputEmpty(run.screen), { label: "退出前清行", run, timeoutMs: 5000 });
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

/** S13：输入框多行滚动（超过可视行数时只显示窗口，框/状态行仍在）。 */
async function scenarioS13(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s13-input-scroll");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s13",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.write("L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10");
    await waitFor(() => run.screen.text().includes("L10"), { label: "10 行输入已进入缓冲", run });
    const lines = run.screen.lines();
    const top = lines.findLastIndex((l) => l.includes("Agent:") && l.trim().startsWith("─"));
    const bottom = lines.findIndex((l, i) => i > top && l.trim().startsWith("─") && !l.includes("Agent:"));
    check(top >= 0 && bottom > top, "多行输入时输入框横线找不到", run.screen);
    check(bottom - top - 1 <= 8, `输入区可视行数超过 8（${bottom - top - 1}）`, run.screen);
    check(lines.some((l) => l.includes("L1")), "滚动后第一行仍应可回看（窗口只滚动，不丢内容）", run.screen);
    check(statusLineOf(run.screen) !== null, "多行输入时状态行丢失", run.screen);
    await run.write("\x1b"); // Esc 清空输入
    await waitFor(() => inputEmpty(run.screen), { label: "Esc 清空多行输入", run, timeoutMs: 5000 });
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

/** S14：审批模态在输入框上方展示问题，y/N 生效且输入框不消失。 */
async function scenarioS14(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s14-approval");
  const fake = await startFake("write-then-answer");
  const run = await startNeo({
    fake,
    dirs,
    name: "s14",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.type("写一个文件");
    await waitFor(
      () => run.screen.text().includes("write_file") && run.screen.text().includes("新建文件"),
      { label: "审批问题显示在输入框上方", run, timeoutMs: 10_000 },
    );
    const during = run.screen.lines();
    check(during.some((l) => l.trimStart().startsWith("?")), "审批态输入提示符缺少 `?`", run.screen);
    check(during.some((l) => l.trimStart().startsWith("❯")), "审批态输入框被卸载（找不到 ❯）", run.screen);
    check(statusLineOf(run.screen) !== null, "审批态状态行消失", run.screen);
    await run.write("y\r");
    await waitFor(() => run.screen.text().includes("写完了。"), {
      label: "批准后工具执行并收到最终回答",
      run,
      timeoutMs: 10_000,
    });
    await waitPrompt(run, "审批轮结束、回到提示符");
    check(readFileSync(join(dirs.work, "a.txt"), "utf8") === "written by neo\n", "write_file 未按批准写入", run.screen);
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

/** S15：运行中把 PTY 从 100 列改到 60 列，帧/状态行仍不超宽、不串行。 */
async function scenarioS15(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s15-resize");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s15",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    resizeToCols: 60,
  });
  try {
    await waitPrompt(run);
    const lastTop = (): string | null => {
      const lines = run.screen.lines();
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i] ?? "";
        if (l.trim().startsWith("─") && l.includes("Agent:")) return l;
      }
      return null;
    };
    // 不猜时序：等后台 stty 真的把 PTY 切到 60 列、输入框按新宽度重画
    await waitFor(() => {
      const t = lastTop();
      return t !== null && displayWidth(t) <= 60;
    }, { label: "PTY 已切到 60 列并重画输入框", run, timeoutMs: 8000 });
    await run.type("这是一段用于测试终端从一百列缩到六十列之后输入框重绘是否串行的中文内容");
    await waitFor(() => run.screen.text().includes("这是一段用于测试"), {
      label: "resize 后输入仍正常上屏",
      run,
      timeoutMs: 8000,
    });
    // 屏幕是流式字节的切片：等 live 帧完整（顶线 + 状态行都在）再断言，避免撞上重画中途。
    await waitFor(
      () => {
        const t = lastTop();
        return t !== null && displayWidth(t) <= 60 && statusLineOf(run.screen) !== null;
      },
      { label: "resize 后 live 帧完整（60 列）", run, timeoutMs: 8000 },
    );
    const lines = run.screen.lines();
    // 只看 live 帧（最后一条顶线到状态行），历史行可能保留 resize 前的宽度
    const top = lines.findLastIndex((l) => l.trim().startsWith("─") && l.includes("Agent:"));
    check(top >= 0, "resize 后找不到输入框顶线", run.screen);
    const frame = lines.slice(top);
    for (const l of frame) {
      check(displayWidth(l.trimEnd()) <= 60, `resize 后帧行超宽（${displayWidth(l)} 列）：${l}`, run.screen);
    }
    check(statusLineOf(run.screen) !== null, "resize 后状态行丢失", run.screen);
    // 提交这一条（fake=resume 立即回），确认交互没坏
    await run.write("\r");
    await waitFor(() => run.screen.text().includes("会话恢复测试答案。"), {
      label: "resize 后仍能完成一轮问答",
      run,
      timeoutMs: 10_000,
    });
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

/** S16：选择菜单在 live 帧里渲染，↓/Enter 生效，Esc 取消。 */
async function scenarioS16(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s16-select");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s16",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.type("/tier");
    await waitFor(() => run.screen.text().includes("切换到哪个档位？"), {
      label: "/tier 打开档位选择菜单",
      run,
      timeoutMs: 8000,
    });
    check(run.screen.text().includes("glm-5.3-flash"), "菜单里缺少各档位路由提示", run.screen);
    check(statusLineOf(run.screen) !== null, "选择菜单时状态行丢失", run.screen);
    await run.write("\x1b[B"); // ↓
    await sleep(120);
    await run.write("\r"); // Enter
    await waitFor(() => run.screen.text().includes("档位 →"), {
      label: "选择后档位切换生效",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "档位切换后回到提示符");
    check(statusLineOf(run.screen) !== null, "菜单关闭后状态行丢失", run.screen);

    // 再开一次，Esc 取消
    await run.type("/tier");
    await waitFor(() => run.screen.text().includes("切换到哪个档位？"), {
      label: "第二次打开档位菜单",
      run,
    });
    await run.write("\x1b"); // Esc
    await waitFor(() => run.screen.text().includes("已取消。"), {
      label: "Esc 取消选择",
      run,
      timeoutMs: 8000,
    });
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

/** S17：双 Ctrl+C 退出（第一次提示，第二次真的退出）。 */
async function scenarioS17(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s17-ctrlc");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s17",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.write("\x03"); // Ctrl+C #1
    await waitFor(() => run.screen.text().includes("再按 Ctrl+C 退出"), {
      label: "第一次 Ctrl+C 显示确认提示",
      run,
      timeoutMs: 5000,
    });
    await run.write("\x03"); // Ctrl+C #2（2s 内）
    const code = await run.waitExit(8000);
    check(code === 0, `双 Ctrl+C 退出码不是 0（${code}）`, run.screen);
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** S18：--resume 真续接（同 session-id/文件/名字）+ 活进程拒绝 + /resume 列表隐藏运行中。 */
async function scenarioS18(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s18-resume");
  const fake = await startFake("resume");
  const countSessions = (): number =>
    readdirSync(dirs.sessions).filter((f) => f.endsWith(".json")).length;
  const newestId = (): string | null => {
    const p = latestSessionFile(dirs.sessions);
    return p ? (p.split("/").pop() ?? "").replace(/\.json$/, "") : null;
  };

  // 1) 会话 A：显式名字 Trinity，落盘会话文件 + 邮箱 profile
  const a = await startNeo({ fake, dirs, name: "s18-a", autoName: false, args: [...BASE_ARGS, "--name", "Trinity"], cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  let aId: string | null = null;
  try {
    await waitPrompt(a);
    await a.type("会话A的问题");
    await waitFor(() => a.screen.text().includes("会话恢复测试答案。"), { label: "A 轮完成", run: a });
    await waitPrompt(a, "A 回到提示符");
    aId = newestId();
    check(aId !== null, "A 没有落盘会话文件", a.screen);
    const profile = JSON.parse(readFileSync(join(dirs.mailbox, aId!, "profile.json"), "utf8")) as { name?: string | null };
    check(profile.name === "Trinity", `A 的 profile 名字不是 Trinity：${JSON.stringify(profile.name)}`, a.screen);
    await a.type("/exit");
    await a.waitExit();
  } finally {
    await a.close();
  }
  const filesAfterA = countSessions();

  // 2) --resume last：沿用同一 session-id/文件/名字
  const b = await startNeo({ fake, dirs, name: "s18-b", autoName: false, args: [...BASE_ARGS, "--resume", "last"], cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  try {
    await waitPrompt(b);
    await waitFor(() => b.screen.text().includes("已恢复会话"), { label: "B 恢复会话", run: b, timeoutMs: 10_000 });
    check(b.screen.text().includes(aId!), `B 恢复的不是 A 的 session-id（期望 ${aId}）`, b.screen);
    await b.type("恢复后的新问题");
    await waitFor(() => b.screen.text().includes("会话恢复测试答案。"), { label: "B 轮完成", run: b });
    await waitPrompt(b, "B 回到提示符");
    await b.type("/exit");
    await b.waitExit();
  } finally {
    await b.close();
  }
  check(countSessions() === filesAfterA, "真续接失败：--resume 产生了新的会话文件", b.screen);
  const profileB = JSON.parse(readFileSync(join(dirs.mailbox, aId!, "profile.json"), "utf8")) as { name?: string | null };
  check(profileB.name === "Trinity", `真续接后名字被改：${JSON.stringify(profileB.name)}`, b.screen);

  // 3) 活进程：C 占住会话；D 的 /resume 列表不得出现 C；E 显式 --resume C 必须拒绝
  const c = await startNeo({ fake, dirs, name: "s18-c", autoName: false, args: [...BASE_ARGS, "--name", "LiveTank"], cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  let cId: string | null = null;
  const d: Awaited<ReturnType<typeof startNeo>>[] = [];
  try {
    await waitPrompt(c);
    await c.type("占住这个会话");
    await waitFor(() => c.screen.text().includes("会话恢复测试答案。"), { label: "C 轮完成", run: c });
    await waitPrompt(c, "C 回到提示符");
    cId = newestId();
    check(cId !== null && cId !== aId, "C 的 session-id 获取失败", c.screen);

    const dRun = await startNeo({ fake, dirs, name: "s18-d", autoName: false, args: [...BASE_ARGS, "--name", "Helper"], cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    d.push(dRun);
    await waitPrompt(dRun);
    await dRun.type("/resume");
    await waitFor(() => dRun.screen.text().includes("恢复哪个会话？"), { label: "D 打开 /resume 列表", run: dRun, timeoutMs: 10_000 });
    check(dRun.screen.text().includes(aId!), "D 的 /resume 列表缺少可恢复的 A", dRun.screen);
    check(!dRun.screen.text().includes(cId!), "D 的 /resume 列表列出了运行中的 C", dRun.screen);
    await dRun.write("\x1b"); // Esc 取消
    await waitFor(() => dRun.screen.text().includes("已取消。"), { label: "D 取消恢复", run: dRun });
    await dRun.type("/exit");
    await dRun.waitExit();

    const e = await startNeo({ fake, dirs, name: "s18-e", autoName: false, args: [...BASE_ARGS, "--resume", cId!], cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
    d.push(e);
    await waitFor(() => e.screen.text().includes("另一个进程"), {
      label: "--resume 运行中会话报错",
      run: e,
      timeoutMs: 10_000,
    });
    const code = await e.waitExit(10_000);
    check(code === 2, `--resume 运行中会话退出码应为 2（实际 ${code}）`, e.screen);
  } finally {
    for (const r of d) await r.close();
    await c.close();
    await fake.stop();
  }
}

/** S19：显式代号 + Agent 静态标题 + /rename neo 仍显示 Agent: neo + busy 后缀。 */
async function scenarioS19(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s19-agent-title");
  const fake = await startFake("slow-800");
  const run = await startNeo({
    fake,
    dirs,
    name: "s19",
    autoName: false,
    // 先用确定名字起会话；默认 Neo#N 由 session-name 单测覆盖。
    args: [...BASE_ARGS, "--name", "Trinity"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    const title0 = titleLineOf(run.screen);
    check(title0 !== null, "新会话顶线没有 Agent 标题", run.screen);
    const name0 = titleNameOf(run.screen) ?? "";
    check(name0 === "Trinity", `顶线名字应为显式 Trinity：${JSON.stringify(name0)}（${title0}）`, run.screen);

    // /rename neo：标题静态为 Agent: neo（无 Mr.Anderson 动画）
    await run.type("/rename neo");
    await waitFor(() => run.screen.text().includes("本会话名字 → neo"), {
      label: "/rename neo 成功提示",
      run,
      timeoutMs: 8000,
    });
    await waitFor(() => titleLineOf(run.screen)?.includes("Agent: neo") ?? false, {
      label: "/rename neo 后标题变为 Agent: neo",
      run,
      timeoutMs: 8000,
    });

    // busy 后缀照常拼接
    await run.type("你好");
    await waitFor(() => run.screen.text().includes("运行中"), { label: "busy 时出现运行中", run, timeoutMs: 8000 });
    await waitFor(() => titleLineOf(run.screen)?.includes("运行中") ?? false, {
      label: "busy 后缀拼在 Agent 标题后",
      run,
      timeoutMs: 8000,
    });
    await waitFor(() => run.screen.text().includes("慢回答完成。"), { label: "回答完成", run, timeoutMs: 15_000 });
    await waitPrompt(run, "回到提示符");

    // 再改名离开 neo：标题立即同步为 Trinity
    await run.type("/rename Trinity");
    await waitFor(() => titleNameOf(run.screen) === "Trinity", {
      label: "改名 Trinity 后标题精确同步（不是 Trinity-2）",
      run,
      timeoutMs: 8000,
    });
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

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * #64 生命周期 hooks 的 TTY 场景夹具：把 hook 事件名追加到 marks 文件。
 *
 * 为什么必须走真 PTY：hook 的触发顺序（SessionStart → UserPromptSubmit → …）
 * 与「阻断是否可见」都是事件时序问题，fake IO 测不出真实 TTY 下的顺序与渲染。
 */
async function hooksFixture(
  tmpRoot: string,
  name: string,
  events: string[],
  extra: Record<string, unknown> = {},
): Promise<{ dirs: RunDirs; mark: string; settings: Record<string, unknown> }> {
  const dirs = await makeDirs(tmpRoot, name);
  await writeFile(join(dirs.work, "a.txt"), "hello\n", "utf8");
  const mark = join(dirs.root, "marks.txt");
  const rec = join(dirs.root, "rec.sh");
  await writeFile(rec, `#!/bin/sh\ncat >/dev/null\necho $NEO_HOOK_EVENT >> '${mark}'\n`, { mode: 0o755 });
  const hooks: Record<string, unknown> = { enabled: true };
  for (const ev of events) hooks[ev] = [{ command: rec }];
  return {
    dirs,
    mark,
    settings: {
      ...PTY_SETTINGS,
      providers: [{ ...(PTY_SETTINGS.providers[0] as Record<string, unknown>) }],
      ...extra,
      hooks,
    },
  };
}

/** 读 marks 文件（不存在 = 空）。 */
async function readMarks(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter((l) => l !== "");
  } catch {
    return [];
  }
}

/**
 * #64 S31：交互 new 会话的事件顺序 + 阻断可见。
 *
 * 断言：SessionStart 先于 UserPromptSubmit；阻断原因在屏幕上可见；
 * 阻断后回到提示符（会话没挂），且不产生任何模型请求（fake-llm 无正文输出）。
 */
async function scenarioS31(tmpRoot: string): Promise<void> {
  const { dirs, mark, settings } = await hooksFixture(tmpRoot, "s31-hooks", ["SessionStart", "UserPromptSubmit"]);
  const block = join(dirs.root, "block.sh");
  await writeFile(block, `#!/bin/sh\ncat >/dev/null\necho UserPromptSubmit >> '${mark}'\necho 'S31 阻断原因可见' >&2\nexit 2\n`, { mode: 0o755 });
  (settings["hooks"] as Record<string, unknown>)["UserPromptSubmit"] = [{ command: block }];
  const fake = await startFake("tool-then-answer");
  const run = await startNeo({ fake, dirs, name: "s31", args: BASE_ARGS, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, settings });
  try {
    await waitPrompt(run);
    await run.type("被阻断的输入");
    await waitFor(() => run.screen.text().includes("S31 阻断原因可见"), {
      label: "屏幕出现 UserPromptSubmit 的阻断原因",
      run,
    });
    // 阻断后仍能继续交互（会话没挂）：再发一条 /hooks 看得到全部新事件。
    await waitPrompt(run, "阻断后回到提示符");
    const events = await readMarks(mark);
    check(events[0] === "SessionStart", `首个事件应为 SessionStart，实际 ${events.join(",")}`, run.screen);
    check(
      events.filter((e) => e === "UserPromptSubmit").length === 1,
      `UserPromptSubmit 应恰好一次，实际 ${events.join(",")}`,
      run.screen,
    );
    await run.type("/hooks");
    await waitFor(() => run.screen.text().includes("PreCompact"), {
      label: "/hooks 列出 PreCompact",
      run,
    });
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

/**
 * #64 S32：`--resume` 会话只触发 SessionStart 一次，回放历史不算用户提交。
 */
async function scenarioS32(tmpRoot: string): Promise<void> {
  const { dirs, mark, settings } = await hooksFixture(tmpRoot, "s32-hooks", ["SessionStart", "UserPromptSubmit"]);
  const fake = await startFake("tool-then-answer");
  const first = await startNeo({
    fake,
    dirs,
    name: "s32-a",
    autoName: false,
    args: [...BASE_ARGS, "--name", "HooksResume"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    settings,
  });
  let sessionId: string | null = null;
  try {
    await waitPrompt(first);
    await first.type("读一下 a.txt");
    await waitFor(() => first.screen.text().includes("读完了：内容是 hello。"), {
      label: "首轮完成",
      run: first,
    });
    await waitPrompt(first, "首轮结束");
    sessionId = (() => {
      const p = latestSessionFile(dirs.sessions);
      return p ? (p.split("/").pop() ?? "").replace(/\.json$/, "") : null;
    })();
    await first.type("/exit");
    await first.waitExit();
  } finally {
    await first.close();
  }
  check(sessionId !== null, "首轮会话应已落盘", first.screen);
  const before = (await readMarks(mark)).length;
  const resumed = await startNeo({
    fake,
    dirs,
    name: "s32-b",
    autoName: false,
    args: [...BASE_ARGS, "--resume", sessionId!],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    settings,
  });
  try {
    await waitPrompt(resumed);
    const after = await readMarks(mark);
    check(
      after.length === before + 1 && after.at(-1) === "SessionStart",
      `resume 只应新增一次 SessionStart，实际新增 ${after.slice(before).join(",") || "无"}`,
      resumed.screen,
    );
    await resumed.type("/exit");
    await resumed.waitExit();
  } catch (e) {
    throw attachScreen(e, resumed.screen, resumed.stderr);
  } finally {
    await resumed.close();
    await fake.stop();
  }
}

/**
 * #64 S33：Stop 续跑在真实 TTY 下只发生一次，且 TurnEnd/Notification 各一次。
 */
async function scenarioS33(tmpRoot: string): Promise<void> {
  const { dirs, mark, settings } = await hooksFixture(tmpRoot, "s33-hooks", ["Stop", "TurnEnd", "Notification"]);
  const stop = join(dirs.root, "stop.sh");
  await writeFile(stop, `#!/bin/sh\ncat >/dev/null\necho Stop >> '${mark}'\necho '{"decision":"block","reason":"S33 再确认一次"}'\n`, {
    mode: 0o755,
  });
  (settings["hooks"] as Record<string, unknown>)["Stop"] = [{ command: stop }];
  const fake = await startFake("tool-then-answer");
  const run = await startNeo({ fake, dirs, name: "s33", args: BASE_ARGS, cols: DEFAULT_COLS, rows: DEFAULT_ROWS, settings });
  try {
    await waitPrompt(run);
    await run.type("读一下 a.txt");
    await waitFor(() => run.screen.text().includes("读完了：内容是 hello。"), {
      label: "首轮完成",
      run,
    });
    await waitPrompt(run, "续跑结束后回到提示符");
    const events = await readMarks(mark);
    check(events.filter((e) => e === "TurnEnd").length === 1, `TurnEnd 应一次，实际 ${events.join(",")}`, run.screen);
    check(
      events.filter((e) => e === "Notification").length === 1,
      `Notification 应一次，实际 ${events.join(",")}`,
      run.screen,
    );
    check(events.filter((e) => e === "Stop").length === 2, `Stop 应两次（原轮 + 一次续跑），实际 ${events.join(",")}`, run.screen);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** #64 真实交互 drive 内部轮共用额度，clear 单独触发 SessionStart。 */
async function scenarioS34(tmpRoot: string): Promise<void> {
  const {dirs,mark,settings}=await hooksFixture(tmpRoot,"s34-hooks",["UserPromptSubmit","TurnEnd"]);
  const stop=join(dirs.root,"stop.sh");
  const start=join(dirs.root,"start.sh");
  await writeFile(stop,`#!/bin/sh\ncat >/dev/null\necho Stop >> '${mark}'\necho '{"decision":"block","reason":"核对一次"}'\n`,{mode:0o755});
  await writeFile(start,`#!/bin/sh\ncat >/dev/null\necho "SessionStart:$NEO_HOOK_SOURCE" >> '${mark}'\n`,{mode:0o755});
  Object.assign(settings["hooks"] as Record<string,unknown>,{Stop:[{command:stop}],SessionStart:[{command:start}]});
  const fake=await startFake("tool-then-answer");
  const run=await startNeo({fake,dirs,name:"s34",args:BASE_ARGS,cols:DEFAULT_COLS,rows:DEFAULT_ROWS,settings});
  try {
    await waitPrompt(run);
    await run.type("/drive --max 2 false -- 再核对");
    await waitFor(()=>run.screen.text().includes("已启动自动续跑"),{label:"启动 drive",run});
    await waitPrompt(run);
    await run.type("读一下 a.txt");
    await waitFor(()=> readFileSync(mark,"utf8").split("\n").filter(e=>e==="TurnEnd").length===3,{label:"原输入与 drive 两轮结束",run});
    await waitPrompt(run);
    const events=await readMarks(mark);
    check(events.filter(e=>e==="UserPromptSubmit").length===1,`drive 内部轮重复提交：${events}`,run.screen);
    check(events.filter(e=>e==="Stop").length===4,`Stop 额度被重置：${events}`,run.screen);
    await run.type("/clear");
    await waitFor(()=> readFileSync(mark,"utf8").split("\n").includes("SessionStart:clear"),{label:"clear 生命周期事件",run});
    check((await readMarks(mark)).filter(e=>e.startsWith("SessionStart:")).length===2,"clear 应恰好一次",run.screen);
    await waitPrompt(run);
    await run.type("/exit");
    await run.waitExit();
  } catch(e) {throw attachScreen(e,run.screen,run.stderr);}
  finally {await run.close();await fake.stop();}
}

interface Scenario {
  /** 场景 id（也可用于命令行过滤，如 s1/s2）。 */
  id: string;
  title: string;
  fn: (tmpRoot: string) => Promise<void>;
  /** 失败快照的锚点文本。 */
  focus: string[];
  /** 启动前在临时 cwd 里写 settings.json（默认用 PTY_SETTINGS）。 */
  settings?: Record<string, unknown>;
  /** 启动前在临时 cwd 里写项目记忆文件（AGENTS.md 内容）。 */
  agentsMd?: string;
}

/** S22：启动降噪 + 输出顺序（issue #18）。 */
async function scenarioS22(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s22-boot-noise");
  const fake = await startFake("tool-then-answer");
  const run = await startNeo({
    fake,
    dirs,
    name: "s22",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    // 五项能力全空 → 会走「首次使用 … 将探测模型能力」分支（这正是要静音的那句）。
    settings: {
      ...PTY_SETTINGS,
      providers: [{ ...(PTY_SETTINGS.providers[0] as Record<string, unknown>) }],
    },
    agentsMd: "# S22 项目记忆\n\n- 这条记忆只用于启动顺序断言。\n",
  });
  try {
    await waitPrompt(run);
    // 探测是异步的：等它落定（写日志/写回都在这之后），再看屏幕。
    await Bun.sleep(1500);
    const text = run.screen.text();
    check(!text.includes("首次使用"), "启动 TUI 不应出现「首次使用 … 将探测模型能力」", run.screen);
    check(!text.includes("将探测"), "启动 TUI 不应出现前置探测提示", run.screen);
    check(!text.includes("未探测到"), "启动 TUI 不应出现「未探测到」能力诊断", run.screen);
    // 无 shell 警告时：记忆提示紧邻、且启动段里不该出现警告行。
    checkBootOrder(run.screen, { expectWarning: false });

    // 诊断没消失，只是换了通道：日志里必须能看到前置探测提示与「未探测到」缺口。
    const bootLog = readBootLog(dirs);
    const kinds = bootLog.map((e) => e.kind);
    check(kinds.includes("probe-intent"), `启动诊断日志应有 probe-intent（实际：${kinds.join(",")}）`, run.screen);
    check(
      bootLog.some((e) => e.kind === "probe-intent" && e.message.includes("将探测")),
      "日志里的前置探测提示应保留「将探测」原文",
      run.screen,
    );
    check(
      bootLog.some((e) => e.kind === "capability-gap" && e.message.includes("未探测到")),
      "日志里应保留「未探测到」能力缺口诊断",
      run.screen,
    );
    // 日志是纯文本通道：不能带颜色转义（否则 grep 不干净）。
    check(!bootLog.some((e) => e.message.includes("\x1b")), "启动诊断日志不应含 ANSI 转义", run.screen);

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

/**
 * S22b：**有 shell 解析告警**时的启动顺序（issue #18 独立验收 MUST FIX 1）。
 *
 * settings.shell.path 指向不存在的路径 → shell.ts 回退到其它候选并产出 warnings。
 * 要求：警告仍然可见，但**不能**插在「真实 shell 状态行」与「项目记忆提示」之间。
 *
 * 隔离：settings 写在本次运行的临时 cwd（config 第一优先级），HOME 也是临时目录，
 * 不读也不写宿主机的 settings/密钥/模型配置。
 */
async function scenarioS22b(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s22b-shell-warning");
  const fake = await startFake("tool-then-answer");
  const run = await startNeo({
    fake,
    dirs,
    name: "s22b",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    settings: {
      ...PTY_SETTINGS,
      // 不存在的路径：必然触发「指定的 shell 不可执行 … 已回退到其它候选」
      shell: { path: "/nonexistent/issue18-shell" },
      providers: [{ ...(PTY_SETTINGS.providers[0] as Record<string, unknown>) }],
    },
    agentsMd: "# S22b 项目记忆\n\n- 有 shell 告警时的启动顺序断言。\n",
  });
  try {
    await waitPrompt(run);
    await Bun.sleep(1500);
    const text = run.screen.text();
    check(!text.includes("首次使用"), "启动 TUI 不应出现「首次使用 … 将探测模型能力」", run.screen);
    check(!text.includes("未探测到"), "启动 TUI 不应出现「未探测到」能力诊断", run.screen);
    // 关键断言：警告可见 + 记忆提示紧邻真实 shell 行。
    checkBootOrder(run.screen, { expectWarning: true });

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

/**
 * S22 系列：**严格**定位真实启动 shell 状态行（issue #18 独立验收 MUST FIX 2）。
 *
 * 不能用 `includes("shell ")`：shell 解析告警（「指定的 shell 不可执行…」）、
 * `/help` 输出里的 `shell` 字样都会命中，造成假阳性。
 * （issue #83 之后 banner 不再整行平铺工具名，但告警与 /help 仍可能含 shell。）
 * 真实状态行由 index.ts 输出为 `  shell <path>（<kind>…）`，所以按行首格式匹配：
 * 行首两个空格 + `shell ` + 绝对路径 + 全角括号。只取**启动段**（输入框顶部分隔线之前）
 * 里的第一条，后续命令输出一律不算启动锚点。
 */
const BOOT_SHELL_LINE = /^ {2}shell \/[^（]*（/;

/**
 * 启动段的行：新 banner 的稳定锚点之后，到含 `Agent:` 的输入框顶部分隔线之前。
 *
 * issue #83：启动段定位从 `M.A.T.R.I.X` 改到新卡片锚点。旧标题与字符雨横幅已去掉；
 * 有框时顶行带圆角 `╭`，首行同时含品牌名 `neo` 与 package.json 版本号。
 * 窄终端（< 40 列）退化成无框纯文本，这时靠「同时含 neo 与版本号」定位。
 * 框线里仍有 `─`，所以仍然不能用「第一条横线」当边界。
 * 屏幕是滚动缓冲：banner 已滚出时退回整屏。
 */
function isStartupBannerAnchor(line: string): boolean {
  // 圆角框顶行是最稳的视觉锚点（默认 80 列 / PTY 100 列都会画框）。
  if (line.includes("╭")) return true;
  // 无框退化：品牌名 + 版本号，避免单独匹配 "neo" 误伤其它行。
  return line.includes("neo") && line.includes(VERSION);
}

function bootSegmentRange(screen: Screen): { from: number; to: number; lines: string[] } {
  const lines = screen.lines();
  const start = lines.findIndex((l) => isStartupBannerAnchor(l));
  const from = start >= 0 ? start : 0;
  const end = lines.findIndex((l, i) => i > from && l.includes("Agent:"));
  const to = end >= 0 ? end : lines.length;
  return { from, to, lines: lines.slice(from, to) };
}

/** 启动段里第一条真实 shell 状态行的下标（相对整屏）；没有返回 -1。 */
function bootShellLineIndex(screen: Screen): number {
  const { from, lines } = bootSegmentRange(screen);
  const rel = lines.findIndex((l) => BOOT_SHELL_LINE.test(l));
  return rel < 0 ? -1 : from + rel;
}

/**
 * S22c：**系统提示词放不下预算**时的一次性提示（issue #20 收尾第 0 步）。
 *
 * 窗口配成 8K（预算 1,024）而系统提示词 + 工具 schema 远超它。要求：
 *  1. 提示在启动段里可见；
 *  2. 排在「项目记忆提示」之后 —— 不许打断 issue #18 的紧邻关系；
 *  3. 同时落进启动诊断日志（kind=prompt-budget）—— TUI 与日志两个通道都有。
 */
async function scenarioS22c(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s22c-over-budget");
  const fake = await startFake("tool-then-answer");
  const run = await startNeo({
    fake,
    dirs,
    name: "s22c",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    settings: {
      ...PTY_SETTINGS,
      // 8K 窗口：预算 1,024，装不下系统提示词 + 工具 schema。
      providers: [
        { ...(PTY_SETTINGS.providers[0] as Record<string, unknown>), context_window: 8_192 },
      ],
    },
    agentsMd: "# S22c 项目记忆\n\n- 这条记忆只用于启动顺序断言。\n",
  });
  try {
    await waitPrompt(run);
    await Bun.sleep(1500);
    const text = run.screen.text();
    const lines = run.screen.lines();
    check(text.includes("系统提示词放不下预算"), "小窗口下应提示系统提示词放不下预算", run.screen);
    // 一次性：同一状态只说一次（同一 provider|model|窗口）。
    check(
      lines.filter((l) => l.includes("系统提示词放不下预算")).length === 1,
      "超预算提示只应出现一次",
      run.screen,
    );
    const memIdx = lines.findLastIndex((l) => l.includes("已加载项目记忆"));
    const budgetIdx = lines.findIndex((l) => l.includes("系统提示词放不下预算"));
    check(memIdx >= 0, "启动段应有项目记忆提示", run.screen);
    check(budgetIdx > memIdx, "超预算提示必须排在记忆提示之后（不得打断紧邻）", run.screen);
    // TUI 与日志两个通道都有：诊断不丢。
    const bootLog = readBootLog(dirs);
    check(
      bootLog.some((e) => e.kind === "prompt-budget"),
      `启动诊断日志应有 prompt-budget（实际：${bootLog.map((e) => e.kind).join(",")}）`,
      run.screen,
    );
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

/**
 * S22 共用断言：真实 shell 状态行 → 项目记忆提示**紧邻**（下一非空行）→ 告警（若有）在记忆之后。
 * `expectWarning` 决定是否要求启动段里出现 shell 解析告警（有/无告警两种启动都要过）。
 */
function checkBootOrder(screen: Screen, opts: { expectWarning: boolean }): void {
  const lines = screen.lines();
  const seg = bootSegmentRange(screen).lines;
  const shellIdx = bootShellLineIndex(screen);
  check(shellIdx >= 0, "启动段应有真实 shell 状态行（行首 `  shell /…（`）", screen);

  const memIdx = lines.findLastIndex((l) => l.includes("已加载项目记忆"));
  check(memIdx > shellIdx, "记忆提示必须在真实 shell 状态行之后", screen);
  const nextNonEmpty = lines.slice(shellIdx + 1).find((l) => l.trim() !== "") ?? "";
  check(
    nextNonEmpty.includes("已加载项目记忆"),
    `记忆提示必须紧接真实 shell 状态行下方（实际下一非空行：${nextNonEmpty}）`,
    screen,
  );
  check(lines.filter((l) => l.includes("已加载项目记忆")).length === 1, "记忆提示只能出现一次", screen);

  // 启动段里必须恰好一条 shell 状态行：多出来的多半是误匹配（告警/工具名）。
  const shellLines = seg.filter((l) => BOOT_SHELL_LINE.test(l));
  check(shellLines.length === 1, `启动段应只有一条 shell 状态行（实际 ${shellLines.length} 条）`, screen);

  const warnIdx = seg.findIndex((l) => l.includes("指定的 shell 不可执行"));
  if (opts.expectWarning) {
    check(warnIdx >= 0, "有 shell 配置告警时，告警行必须仍然可见", screen);
    const segShell = seg.findIndex((l) => BOOT_SHELL_LINE.test(l));
    const segMem = seg.findIndex((l) => l.includes("已加载项目记忆"));
    check(segMem > segShell, "启动段内记忆提示必须在 shell 状态行之后", screen);
    check(warnIdx > segMem, "shell 告警必须排在记忆提示之后（不得打断紧邻）", screen);
    check(
      !seg.some((l) => l.includes("指定的 shell 不可执行") && BOOT_SHELL_LINE.test(l)),
      "告警行不得被当成 shell 状态行",
      screen,
    );
  } else {
    check(warnIdx < 0, "无 shell 配置告警时，启动段不应出现 shell 告警行", screen);
  }
}

/** S20：ask_user 提问模态（v0.4.1 B2）——问题/选项可见，↓+Enter 回答并回给模型。 */
async function scenarioS20(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s20-ask-user");
  const fake = await startFake("ask-user");
  const run = await startNeo({
    fake,
    dirs,
    name: "s20",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.type("请问我一个问题");
    await waitFor(() => run.screen.text().includes("选哪个报价方案？"), {
      label: "ask_user 问题可见",
      run,
      timeoutMs: 10_000,
    });
    const screen = run.screen.text();
    check(screen.includes("方案 A"), "选项 A 未显示", run.screen);
    check(screen.includes("方案 B"), "选项 B 未显示", run.screen);
    check(screen.includes("其他（自行输入）"), "自定义输入入口未显示", run.screen);
    check(statusLineOf(run.screen) !== null, "提问态状态行丢失", run.screen);
    await run.write("\x1b[B"); // ↓ → 方案 B
    await sleep(120);
    await run.write("\r"); // Enter
    await waitFor(() => run.screen.text().includes("回答：方案 B"), {
      label: "回答提交进 scrollback",
      run,
      timeoutMs: 8_000,
    });
    await waitFor(() => run.screen.text().includes("ANSWER_OK"), {
      label: "模型收到回答并继续",
      run,
      timeoutMs: 10_000,
    });
    await waitPrompt(run, "提问结束后回到提示符");
    check(statusLineOf(run.screen) !== null, "提问结束后状态行丢失", run.screen);
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S21：/goal 目标锚（2026-10-26）——设置/查看/清除，且目标真的进了模型请求。
 *
 * 断言分两层：
 *  - 命令层：/goal 无参数显示当前目标；/goal <文本> 有成功提示；/goal clear 清除。
 *  - 协议层：目标原文出现在模型的 system 提示里（fake-llm 把收到的 messages 落盘，
 *    这里读回来断言）。只测命令回显不测注入，等于没测到这个功能的目的。
 */
async function scenarioS21(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s21-goal-anchor");
  // tool-then-answer：第 1 轮调 read_file，第 2 轮给答案 —— 这样才有「工具调用」
  // 这个注入点（预算 + 目标提示只在工具批次之后、下一次请求之前注入）。
  const fake = await startFake("tool-then-answer");
  const run = await startNeo({
    fake,
    dirs,
    name: "s21",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);

    // 1) 未设置时查看：应提示尚未设置
    await run.type("/goal");
    await waitFor(() => run.screen.text().includes("尚未设置目标锚"), {
      label: "/goal 无目标时提示尚未设置",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "查看空目标后回到提示符");

    // 2) 设置目标
    const goal = "找出这篇博客的作者";
    await run.type(`/goal ${goal}`);
    await waitFor(() => run.screen.text().includes("目标锚已设置"), {
      label: "/goal 设置成功提示",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "设置目标后回到提示符");

    // 3) 再查看：应回显目标原文
    await run.type("/goal");
    await waitFor(() => run.screen.text().includes(goal), {
      label: "/goal 查看回显目标原文",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "查看目标后回到提示符");

    // 4) 跑一轮带工具调用的 turn：证明目标存在时主流程照常工作
    //    （目标提示是临时 system 消息，注入/摘除若有 bug 会在这里炸掉或卡住）
    await run.type("读一下 a.txt");
    await waitFor(() => run.screen.text().includes("读完了：内容是 hello。"), {
      label: "带工具的 turn 完成",
      run,
      timeoutMs: 15_000,
    });
    await waitPrompt(run, "turn 结束后回到提示符");

    // 5) 清除
    await run.type("/goal clear");
    await waitFor(() => run.screen.text().includes("目标锚已清除"), {
      label: "/goal clear 清除成功提示",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "清除目标后回到提示符");

    // 6) 清除后再查看：回到「尚未设置」
    await run.type("/goal");
    await waitFor(() => run.screen.text().includes("尚未设置目标锚"), {
      label: "清除后 /goal 回到尚未设置",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "清除后查看回到提示符");

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

/**
 * S23（issue #30）：输入框 `!` shell 模式（含权限确认 + 执行后继续输入）。
 *
 * 空缓冲键入 `!` → 前缀变 `! `、占位变「shell 命令」；输入命令回车 → 走既有权限确认
 * （ask 模式）→ 回答 y 后 shell 真正执行；执行完输入框回普通态，**并且还能继续输入**
 * —— 最后一步同时用于核查 issue #34 的「跑完 shell 后输入失效」猜想。
 */
async function scenarioS23(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s23-shell-input-mode");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s23",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);

    // 1) 空缓冲键入 `!`：进入 shell 模式（占位文案变化）
    await run.write("!");
    await waitFor(() => run.screen.text().includes("shell 命令"), {
      label: "键入 ! 后进入 shell 模式（占位变为 shell 命令）",
      run,
      timeoutMs: 5000,
    });

    // 2) 输入命令回车 → 权限确认问句（ask 模式）
    await run.type("echo NEO_SHELL_MODE_OK");
    await waitFor(() => run.screen.text().includes("shell — 执行"), {
      label: "shell 命令先走权限确认",
      run,
      timeoutMs: 8000,
    });

    // 3) 回答 y → 真正执行（出现 `$ echo ...` 行说明走的是 runShell，不是纯回显）
    await run.type("y");
    await waitFor(() => run.screen.text().includes("$ echo NEO_SHELL_MODE_OK"), {
      label: "确认后 shell 真正执行",
      run,
      timeoutMs: 10_000,
    });

    // 4) 执行完回普通输入态，并且还能继续输入（斜杠命令必须走命令路径）
    await waitPrompt(run, "shell 执行后回到提示符");
    await run.type("/todos");
    await waitFor(() => run.screen.text().includes("暂无待办"), {
      label: "shell 执行后普通输入仍然可用",
      run,
      timeoutMs: 8000,
    });
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S24（issue #25）：`/loop` 定时循环提示。
 *
 * 用 1h 间隔（启动即跑第一拍、测试期间不会再有第二拍）保证确定性：
 * 状态查询 → 启动 → 注入的拍以 `❯ <提示>` 出现 → 已跑 1 次 → 停止 → 无循环。
 */
async function scenarioS24(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s24-loop");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s24",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);

    // 1) 未启动时无循环
    await run.type("/loop");
    await waitFor(() => run.screen.text().includes("当前没有循环"), {
      label: "/loop 无参时提示当前没有循环",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "/loop 状态后回到提示符");

    // 2) 启动 1h 循环（立刻跑第一拍）
    await run.type("/loop 1h 看一下日志");
    await waitFor(() => run.screen.text().includes("已启动循环"), {
      label: "/loop 1h <提示> 启动成功",
      run,
      timeoutMs: 8000,
    });

    // 3) 注入的拍以用户行出现
    await waitFor(() => run.screen.text().includes("❯ 看一下日志"), {
      label: "循环注入的提示出现在会话里",
      run,
      timeoutMs: 15_000,
    });

    // 4) 状态能看到已跑次数
    await waitPrompt(run, "循环第一拍结束后回到提示符");
    await run.type("/loop");
    await waitFor(() => run.screen.text().includes("已跑 1 次"), {
      label: "/loop 状态显示已跑 1 次",
      run,
      timeoutMs: 8000,
    });

    // 5) 停止后回到无循环
    await run.type("/loop stop");
    await waitFor(() => run.screen.text().includes("已停止循环"), {
      label: "/loop stop 停止成功",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "停止循环后回到提示符");
    await run.type("/loop");
    await waitFor(() => run.screen.text().includes("当前没有循环"), {
      label: "停止后 /loop 再次显示无循环",
      run,
      timeoutMs: 8000,
    });
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S25（issue #31）：`/` 渐进式命令菜单。
 *
 * 行首 `/` 自动出菜单（左名/右说明）→ 输入过滤 → Tab 接受不执行 → Enter 执行；
 * 全程不得再出现旧的「N 个命令候选」单行 hint。
 */
async function scenarioS25(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s25-command-menu");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s25",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);

    // 1) 行首 `/` 自动开菜单（能看到命令说明）
    await run.write("/");
    await waitFor(() => run.screen.text().includes("清空上下文"), {
      label: "键入 / 后自动打开命令菜单（含短说明）",
      run,
      timeoutMs: 8000,
    });

    // 2) 边打边过滤
    await run.type("tod");
    await waitFor(() => run.screen.text().includes("/todos"), {
      label: "输入 tod 后菜单过滤到 /todos",
      run,
      timeoutMs: 8000,
    });

    // 3) Tab 只接受不执行：输入框应变成 /todos
    await run.write("\t");
    await waitFor(() => run.screen.text().includes("❯ /todos"), {
      label: "Tab 接受高亮项写入输入框",
      run,
      timeoutMs: 8000,
    });

    // 4) Enter 执行
    await run.type("");
    await waitFor(() => run.screen.text().includes("暂无待办"), {
      label: "Enter 执行高亮命令 /todos",
      run,
      timeoutMs: 8000,
    });

    // 5) 旧 hint 不再出现
    if (run.screen.text().includes("个命令候选")) {
      const err = new CheckError("仍出现旧「N 个命令候选」hint", ["/todos", "暂无待办"]);
      err.screen = run.screen;
      throw err;
    }
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S26（issue #16）：后台子代理任务面板的空态。
 *
 * 完整后台链路要等子代理真的跑起来（依赖 fake LLM 的 task 场景），此处只断言
 * `/tasks` 在无任务时的明确空态，以及不破坏输入框。
 */
async function scenarioS26(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s26-tasks");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s26",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.type("/tasks");
    await waitFor(() => run.screen.text().includes("没有后台任务"), {
      label: "/tasks 无任务时提示空态",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "/tasks 后回到提示符");
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S27（issue #28）：`/ps` 后台 shell 面板的空态。
 *
 * 完整后台链路需要真实长进程，PTY 场景只锁「无后台命令时的明确空态」与输入框不被破坏。
 */
async function scenarioS27(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s27-ps");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s27",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.type("/ps");
    await waitFor(() => run.screen.text().includes("没有后台命令"), {
      label: "/ps 无后台命令时提示空态",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "/ps 后回到提示符");
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S28（issue #27）：`/rewind` 空态。
 *
 * 完整回滚链路需要先跑真实轮次 + 文件改动；PTY 只锁「还没有轮次时的明确空态」。
 */
async function scenarioS28(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s28-rewind");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s28",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.type("/rewind");
    await waitFor(() => run.screen.text().includes("还没有可回滚的轮次"), {
      label: "/rewind 无轮次时提示空态",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "/rewind 后回到提示符");
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S29（issue #24）：`/drive` 目标驱动自动续跑的启动 / 状态 / 停止。
 *
 * 不发真实轮次（那需要跑完整 turn + 检查命令），只锁命令层：空态 → 启动 → 状态 → 停止。
 */
async function scenarioS29(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s29-drive");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s29",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);

    // 1) 空态
    await run.type("/drive");
    await waitFor(() => run.screen.text().includes("没有正在进行的自动续跑"), {
      label: "/drive 无任务时提示空态",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "/drive 空态后回到提示符");

    // 2) 启动（检查命令用 true，便于确定性）
    await run.type("/drive --max 2 true -- 再检查一次");
    await waitFor(() => run.screen.text().includes("已启动自动续跑"), {
      label: "/drive 启动成功",
      run,
      timeoutMs: 8000,
    });
    await waitFor(() => run.screen.text().includes("已自动推进 0/2 轮"), {
      label: "/drive 状态显示轮次",
      run,
      timeoutMs: 5000,
    });

    // 3) 停止
    await run.type("/drive stop");
    await waitFor(() => run.screen.text().includes("已停止自动续跑"), {
      label: "/drive stop 停止成功",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "停止后回到提示符");
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S30（issue #47）：空闲连按两次 Esc 打开 rewind 菜单。
 *
 * 覆盖：打开菜单 → 选轮次 → 选模式 → 执行；Esc 取消；单 Esc 语义不变（清空输入）。
 * 轮次来自真实一轮对话（fake-llm 的 resume 场景，不调工具）。
 */
async function scenarioS30(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s30-rewind-menu");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s30",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);

    // 0) 单 Esc 语义回归：输入框有内容时 Esc = 清空（不能打开菜单）
    await run.write("abc");
    await waitFor(() => (lastPromptLine(run.screen) ?? "").includes("abc"), {
      label: "输入 abc",
      run,
      timeoutMs: 5000,
    });
    await run.write("\x1b");
    await waitFor(() => inputEmpty(run.screen), { label: "单 Esc 清空输入（语义不变）", run, timeoutMs: 5000 });
    check(!run.screen.text().includes("回滚到哪一轮之前"), "清空输入的单 Esc 误开了 rewind 菜单", run.screen);

    // 1) 跑一轮对话，产生一个用户轮次
    await run.type("读一下 a.txt");
    await waitFor(() => run.screen.text().includes("会话恢复测试答案。"), {
      label: "第一轮完成",
      run,
      timeoutMs: 15_000,
    });
    await waitPrompt(run, "第一轮后回到提示符");

    // 2) 空闲 + 空输入框：连按两次 Esc 打开菜单
    // 两次 Esc 分开写、留足间隔：同批写入会被 readline 解析成「Alt+Esc」单个事件。
    await run.write("\x1b\x1b");
    await waitFor(() => run.screen.text().includes("回滚到哪一轮之前？"), {
      label: "连按两次 Esc 打开 rewind 菜单",
      run,
      timeoutMs: 8000,
    });
    check(run.screen.text().includes("读一下 a.txt"), "菜单里没有列出用户轮次", run.screen);

    // 3) 选轮次（Enter 选第一条）→ 进入模式菜单
    await run.write("\r");
    await waitFor(() => run.screen.text().includes("回滚什么？"), {
      label: "选轮次后进入模式菜单",
      run,
      timeoutMs: 8000,
    });
    check(run.screen.text().includes("代码 + 对话"), "模式菜单缺少默认项", run.screen);

    // 4) Esc 取消模式菜单 → 回提示符，且没有执行回滚
    await run.write("\x1b");
    await waitFor(() => run.screen.text().includes("已取消"), {
      label: "Esc 取消 rewind 菜单",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "取消后回到提示符");
    check(!run.screen.text().includes("已回滚"), "取消后不应执行回滚", run.screen);

    // 5) 再开一次，走完整链路：选轮次 → 选模式 → 执行
    await run.write("\x1b\x1b");
    await waitFor(() => run.screen.text().includes("回滚到哪一轮之前？"), {
      label: "第二次打开 rewind 菜单",
      run,
      timeoutMs: 8000,
    });
    await run.write("\r"); // 选轮次
    await waitFor(() => run.screen.text().includes("回滚什么？"), { label: "第二次进入模式菜单", run });
    await run.write("\r"); // 选默认 both
    await waitFor(() => run.screen.text().includes("已回滚"), {
      label: "选模式后执行回滚",
      run,
      timeoutMs: 10_000,
    });
    await waitPrompt(run, "回滚后回到提示符");

    // 6) 回滚后轮次表已清空：再开菜单应提示空态
    await run.write("\x1b\x1b");
    await waitFor(() => run.screen.text().includes("还没有可回滚的轮次"), {
      label: "回滚后菜单提示空态",
      run,
      timeoutMs: 8000,
    });
    await waitPrompt(run, "空态后回到提示符");

    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}


/** S35（issue #90）：空闲 Ctrl+O 打开 transcript 视图；Esc 与第二次 Ctrl+O 关闭。 */
async function scenarioS35(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s35-transcript-toggle");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s35",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.write("\x0f"); // Ctrl+O
    await waitFor(
      () => run.screen.text().includes("本会话还没有记录") && run.screen.text().includes("/ 搜索"),
      { label: "空闲 Ctrl+O 打开空会话 transcript 视图", run, timeoutMs: 8000 },
    );
    check(!run.screen.text().includes("将在 v0.3.1 提供"), "不应再出现 v0.3.1 占位提示", run.screen);
    check(statusLineOf(run.screen) !== null, "视图打开时状态行应仍可见", run.screen);
    check(run.screen.lines().some((l) => l.includes("❯")), "视图打开时输入框应仍可见", run.screen);

    await run.write("\x1b"); // Esc 关闭
    await waitFor(
      () => inputEmpty(run.screen) && !run.screen.text().includes("本会话还没有记录"),
      { label: "Esc 关闭视图并回到输入框", run, timeoutMs: 8000 },
    );

    await run.write("\x0f");
    await waitFor(() => run.screen.text().includes("本会话还没有记录"), {
      label: "再次 Ctrl+O 打开视图",
      run,
      timeoutMs: 8000,
    });
    await run.write("\x0f");
    await waitFor(() => !run.screen.text().includes("本会话还没有记录"), {
      label: "第二次 Ctrl+O 关闭视图",
      run,
      timeoutMs: 8000,
    });
    check(inputEmpty(run.screen), "关闭后应回到空输入框", run.screen);
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

/** S36（issue #90）：在已有会话上打开视图，/ 或 Ctrl+F 搜索并跳到命中。 */
async function scenarioS36(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s36-transcript-search");
  const fake = await startFake("resume");
  const run = await startNeo({
    fake,
    dirs,
    name: "s36",
    args: BASE_ARGS,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  });
  try {
    await waitPrompt(run);
    await run.type("UNIQUE_ALPHA 请看这里");
    await waitFor(() => run.screen.text().includes("会话恢复测试答案。"), {
      label: "假会话已落入历史",
      run,
      timeoutMs: 15_000,
    });
    await waitPrompt(run, "一轮结束后回到提示符");
    await run.write("\x0f");
    await waitFor(
      () =>
        run.screen.text().includes("UNIQUE_ALPHA 请看这里") &&
        run.screen.text().includes("会话恢复测试答案。") &&
        run.screen.text().includes("/ 搜索") &&
        !run.screen.text().includes("将在 v0.3.1 提供"),
      { label: "Ctrl+O 打开含历史的 transcript 视图", run, timeoutMs: 8000 },
    );
    await run.write("/");
    await waitFor(() => run.screen.lines().some((l) => l.trim() === "/"), {
      label: "视图内 / 进入搜索（空查询行）",
      run,
      timeoutMs: 5000,
    });
    await run.write("UNIQUE_ALPHA");
    await waitFor(() => run.screen.lines().some((l) => l.trim() === "/UNIQUE_ALPHA"), {
      label: "搜索查询行可见，且能跳到用户行命中",
      run,
      timeoutMs: 8000,
    });
    await run.write("\x1b"); // 退出搜索（与下一键隔开，避免 Esc 与 Ctrl+F 被合成 Meta+F）
    await waitFor(
      () =>
        run.screen.text().includes("/ 搜索") &&
        !run.screen.lines().some((l) => l.trim() === "/UNIQUE_ALPHA" || l.trim() === "/"),
      { label: "Esc 退出搜索后查询行消失", run, timeoutMs: 5000 },
    );
    await run.write("\x06"); // Ctrl+F 再进搜索
    await waitFor(
      () => run.screen.lines().some((l) => l.trim() === "/"),
      { label: "Ctrl+F 别名再次进入搜索（空查询行 / 可见）", run, timeoutMs: 5000 },
    );
    maybeDumpScreen(run.screen);
    await run.write("\x1b"); // 退出搜索
    await run.write("\x1b"); // 关闭视图
    await waitFor(
      () => inputEmpty(run.screen) && !run.screen.text().includes("会话记录"),
      { label: "Esc 关视图回到输入框", run, timeoutMs: 8000 },
    );
    await run.type("/exit");
    await run.waitExit();
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

async function scenarioS37(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s37-first-use-onboard");
  const fake = await startFake("narration");
  const typedKey = "sk-pty88-secret";
  const run = await startNeo({
    fake,
    dirs,
    name: "s37",
    args: BASE_ARGS,
    settings: false,
    // 环境变量不得跳过向导；会话稍后仍可被 env 覆盖，但文件必须是刚输入的值。
    extraEnv: { NEO_API_KEY: "env-should-not-be-written" },
  });
  try {
    await waitFor(() => run.screen.text().includes("请输入 base_url"), { label: "base_url 提示", run });
    await run.type(`http://127.0.0.1:${fake.port}/v1`);
    await waitFor(() => run.screen.text().includes("请输入 api_key"), { label: "api_key 提示", run });
    await run.type(typedKey);
    await waitFor(() => run.screen.text().includes("请选择协议"), { label: "协议提示", run });
    const afterKey = run.screen.text();
    check(!afterKey.includes(typedKey), "api_key 不得在屏幕上以明文出现", run.screen);
    check(afterKey.includes("*"), "api_key 输入应回显 *", run.screen);
    await run.type("1");
    await waitFor(() => run.screen.text().includes("请为 default 选择模型"), { label: "default 模型", run });
    await run.type("");
    await waitFor(() => run.screen.text().includes("请为 balance 选择模型"), { label: "balance 模型", run });
    await run.type("");
    await waitFor(() => run.screen.text().includes("请为 fast 选择模型"), { label: "fast 模型", run });
    await run.type("");
    await waitFor(() => run.screen.text().includes("请为 deep 选择模型"), { label: "deep 模型", run });
    await run.type("");
    await waitFor(() => run.screen.text().includes("max_output_tokens"), { label: "max_output_tokens", run });
    await run.type("4096");
    await waitFor(() => run.screen.text().includes("已写入"), { label: "已写入配置", run });
    await waitPrompt(run);
    const text = run.screen.text();
    check(!text.includes(typedKey), "整场会话屏幕不得出现明文 api_key", run.screen);
    check(!run.stderr.includes(typedKey), "stderr 不得出现明文 api_key", run.screen);
    const dest = join(dirs.home, ".neo", "settings.json");
    check(existsSync(dest), "成功后应写入 HOME/.neo/settings.json", run.screen);
    check((statSync(dest).mode & 0o777) === 0o600, "写入文件权限应为 0600", run.screen);
    check(!existsSync(join(dirs.work, "settings.json")), "不应写工作区 settings.json", run.screen);
    const raw = JSON.parse(readFileSync(dest, "utf8")) as {
      default_provider?: string;
      classifier_model_name?: string;
      providers?: Array<Record<string, unknown>>;
    };
    check(raw.default_provider === "default", "default_provider 应为 default", run.screen);
    const prov = raw.providers?.[0] ?? {};
    if (prov["api_key"] !== typedKey) {
      throw new CheckError("写出的 api_key 不是用户刚输入的值", ["api_key"], run.screen);
    }
    check(prov["max_tokens"] === 8192, "max_tokens 应保持 8192", run.screen);
    check(prov["max_output_tokens"] === 4096, "max_output_tokens 应为用户确认的 4096", run.screen);
    // api_key 已与 typedKey 比较；typedKey 不是环境变量里的 env-should-not-be-written。
    maybeDumpScreen(run.screen);
    await run.type("/exit");
    const code = await run.waitExit();
    check(code === 0, `向导完成后 /exit 退出码应为 0（实际 ${code}）`, run.screen);
  } catch (e) {
    throw attachScreen(e instanceof Error ? new CheckError(e.message, ["已写入", "请输入 base_url"], run.screen, run.stderr) : e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/**
 * S38 #88：探测失败时不写文件，用户选择退出后进程以 2 结束。
 */
async function scenarioS38(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s38-first-use-probe-fail");
  const fake = await startFake("narration");
  const typedKey = "sk-pty88-fail-secret";
  const run = await startNeo({
    fake,
    dirs,
    name: "s38",
    args: BASE_ARGS,
    settings: false,
  });
  try {
    await waitFor(() => run.screen.text().includes("请输入 base_url"), { label: "base_url 提示", run });
    await run.type("http://127.0.0.1:9/v1");
    await waitFor(() => run.screen.text().includes("请输入 api_key"), { label: "api_key 提示", run });
    await run.type(typedKey);
    await waitFor(() => run.screen.text().includes("请选择协议"), { label: "协议提示", run });
    check(!run.screen.text().includes(typedKey), "api_key 不得在屏幕上以明文出现", run.screen);
    await run.type("1");
    await waitFor(() => run.screen.text().includes("探测失败") || run.screen.text().includes("重试或退出"), {
      label: "探测失败并询问重试",
      run,
    });
    await run.type("q");
    const code = await run.waitExit();
    check(code === 2, `探测失败退出码应为 2（实际 ${code}）`, run.screen);
    check(!existsSync(join(dirs.home, ".neo", "settings.json")), "探测失败不得写入 settings.json", run.screen);
    check(!run.screen.text().includes(typedKey), "失败路径屏幕不得出现明文 api_key", run.screen);
    check(!run.stderr.includes(typedKey), "失败路径 stderr 不得出现明文 api_key", run.screen);
    maybeDumpScreen(run.screen);
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}


/**
 * S39 #70：`--safe-mode` 启动提示「干净配置」，自定义 hooks/MCP/技能/项目记忆未加载。
 * 临时 HOME + cwd 里准备了 hooks / MCP / 技能 / AGENTS.md / 路径规则，用以证明它们没被加载。
 */
async function scenarioS39(tmpRoot: string): Promise<void> {
  const { dirs, mark, settings } = await hooksFixture(
    tmpRoot,
    "s39-safe-mode",
    ["SessionStart"],
    {
      mcpServers: { canary: { command: "echo", args: ["mcp-should-not-start"] } },
      lsp: { enabled: true, servers: [{ command: "false", args: [] }] },
      repo_map: { enabled: true },
      memory: { enabled: true },
    },
  );
  await writeFile(join(dirs.work, "AGENTS.md"), "# Agents\nSAFE_MODE_CANARY_AGENTS_70\n", "utf8");
  await mkdir(join(dirs.work, "skills", "safe-mode-canary"), { recursive: true });
  await writeFile(
    join(dirs.work, "skills", "safe-mode-canary", "SKILL.md"),
    "---\nname: safe-mode-canary\ndescription: SAFE_MODE_CANARY_SKILL_70\n---\n\n# Canary\n",
    "utf8",
  );
  await mkdir(join(dirs.work, ".neo", "rules"), { recursive: true });
  await writeFile(join(dirs.work, ".neo", "rules", "always.md"), "SAFE_MODE_CANARY_RULE_70\n", "utf8");
  const settingsPath = join(dirs.work, "settings.json");
  const fake = await startFake("narration");
  const run = await startNeo({
    fake,
    dirs,
    name: "s39",
    args: [...BASE_ARGS, "--safe-mode"],
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    settings,
  });
  try {
    await waitPrompt(run);
    const settingsBefore = readFileSync(settingsPath);
    const settingsStat = statSync(settingsPath);
    const boot = run.screen.text();
    check(boot.includes("当前为干净配置，自定义项未加载"), "启动应提示干净配置", run.screen);
    check(!boot.includes("已加载项目记忆"), "不应加载 AGENTS.md", run.screen);
    check(!boot.includes("hooks：已加载"), "不应加载 hooks", run.screen);
    check(!boot.includes("MCP：已接入"), "不应接入 MCP", run.screen);
    await run.type("/hooks");
    await waitPrompt(run);
    check(run.screen.text().includes("未加载"), "/hooks 应显示未加载", run.screen);
    check(!run.screen.text().includes("rec.sh"), "/hooks 不应列出 hook 命令", run.screen);
    await run.type("/mcp");
    await waitPrompt(run);
    check(run.screen.text().includes("未加载"), "/mcp 应显示未加载", run.screen);
    check(!run.screen.text().includes("mcp-should-not-start"), "/mcp 不应显示未加载的 server 命令", run.screen);
    await run.type("/skills");
    await waitPrompt(run);
    check(run.screen.text().includes("未加载"), "/skills 应显示未加载", run.screen);
    check(!run.screen.text().includes("safe-mode-canary"), "/skills 不应列出技能", run.screen);
    await run.type("/context");
    await waitPrompt(run);
    const ctx = run.screen.text();
    check(ctx.includes("当前为干净配置，自定义项未加载"), "/context 应重复干净配置提示", run.screen);
    check(ctx.includes("未加载"), "/context 应标明自定义面未加载", run.screen);
    const marks = await readMarks(mark);
    check(marks.length === 0, `SessionStart hook 不应执行（实际 ${marks.join(",") || "空"}）`, run.screen);
    const afterStat = statSync(settingsPath);
    check(afterStat.mtimeMs === settingsStat.mtimeMs, "不应改写工作区 settings.json", run.screen);
    check(readFileSync(settingsPath).equals(settingsBefore), "settings.json 内容不应变化", run.screen);
    maybeDumpScreen(run.screen);
    await run.type("/exit");
    const code = await run.waitExit();
    check(code === 0, `/exit 退出码应为 0（实际 ${code}）`, run.screen);
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** #66 S40：忙碌中有字 Enter → ❯ 上屏 + ⇥ 1 排队 → 工具切点自动注入（计数下降）→ 同一轮改路，不另起一轮。 */
async function scenarioS40(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s40-mid-turn-steer");
  await writeFile(join(dirs.work, "a.txt"), "hello\n", "utf8");
  const fake = await startFake("steer");
  const run = await startNeo({ fake, dirs, name: "s40", args: BASE_ARGS, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  try {
    await waitPrompt(run);
    await run.type("读一下 a.txt");
    await waitFor(() => run.screen.text().includes("运行中"), { label: "首轮进行中", run, timeoutMs: 8000 });
    await run.type("STEER 改成只看第一行");
    await waitFor(() => (statusLineOf(run.screen) ?? "").includes("⇥ 1 排队"), {
      label: "忙碌时有字 Enter 先入队（⇥ 1 排队）",
      run,
      timeoutMs: 6000,
    });
    check(run.screen.lines().some((l) => l.startsWith("❯ STEER 改成只看第一行")), "转向应按现有 ❯ 上屏", run.screen);
    await waitFor(() => run.screen.text().includes("STEER_SEEN n=1"), { label: "转向在工具切点注入本轮", run, timeoutMs: 15_000 });
    await waitPrompt(run, "本轮结束、回到提示符");
    const text = run.screen.text();
    check(!text.includes("STEER_MISS"), "转向不应退化成轮末新一轮", run.screen);
    check((text.match(/STEER_SEEN/g) ?? []).length === 1, "注入只引发一次后续请求", run.screen);
    check(!(statusLineOf(run.screen) ?? "").includes("排队"), "注入后排队计数应下降为 0", run.screen);
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

/** #66 S41：转向注入后按 Esc → 只停不删，文案换成「已中断（不回滚，转向已写入本轮）」。 */
async function scenarioS41(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s41-steer-cancel");
  await writeFile(join(dirs.work, "a.txt"), "hello\n", "utf8");
  const fake = await startFake("steer");
  const run = await startNeo({ fake, dirs, name: "s41", args: BASE_ARGS, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  try {
    await waitPrompt(run);
    await run.type("读一下 a.txt");
    await waitFor(() => run.screen.text().includes("运行中"), { label: "首轮进行中", run, timeoutMs: 8000 });
    await run.type("STEER HOLD 等一下");
    await waitFor(() => (statusLineOf(run.screen) ?? "").includes("⇥ 1 排队"), { label: "转向入队", run, timeoutMs: 6000 });
    await waitFor(() => !(statusLineOf(run.screen) ?? "").includes("排队"), { label: "转向已注入（计数下降）", run, timeoutMs: 10_000 });
    check(run.screen.text().includes("运行中"), "注入后的请求应仍在进行（HOLD）", run.screen);
    await run.write("\x1b");
    await waitFor(() => run.screen.text().includes("已中断（不回滚，转向已写入本轮）"), {
      label: "注入后取消显示不回滚文案",
      run,
      timeoutMs: 6000,
    });
    await waitPrompt(run, "取消后回到提示符");
    check(!run.screen.text().includes("STEER_SEEN"), "HOLD 请求被取消，不应产出回答", run.screen);
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

/** #63 S42：交互 TTY 下 `--add-dir ./a ./b`（多余位置参数）→ 用法错误 2，提示每个目录各写一次。 */
async function scenarioS42(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s42-add-dir-positional");
  await mkdir(join(dirs.work, "a"), { recursive: true });
  await mkdir(join(dirs.work, "b"), { recursive: true });
  const fake = await startFake("narration");
  const run = await startNeo({ fake, dirs, name: "s42", args: [...BASE_ARGS, "--add-dir", "./a", "./b"] });
  try {
    await waitFor(() => run.screen.text().includes("每个目录各写一次 --add-dir"), {
      label: "交互 TTY 下多余位置参数报用法错误",
      timeoutMs: 15_000,
    });
    const code = await run.waitExit();
    check(code === 2, `位置参数用法错误退出码应为 2（实际 ${code}）`, run.screen);
    check(!promptReady(run.screen), "用法错误不应进入交互提示符", run.screen);
    check(readdirSync(dirs.sessions).length === 0, "用法错误不应创建会话", run.screen);
    maybeDumpScreen(run.screen);
  } catch (e) {
    throw attachScreen(e, run.screen, run.stderr);
  } finally {
    await run.close();
    await fake.stop();
  }
}

/** #63 S42b：交互 TTY 下 -p 同样适用位置参数规则；无多余位置参数的 -p 照常跑完。 */
async function scenarioS42b(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s42b-add-dir-positional-p");
  await mkdir(join(dirs.work, "a"), { recursive: true });
  await mkdir(join(dirs.work, "b"), { recursive: true });
  const fake = await startFake("resume");
  const bad = await startNeo({ fake, dirs, name: "s42b-bad", args: [...BASE_ARGS, "-p", "q", "--add-dir", "./a", "./b"] });
  try {
    await waitFor(() => bad.screen.text().includes("每个目录各写一次 --add-dir"), {
      label: "交互 TTY + -p 下多余位置参数报用法错误",
      timeoutMs: 15_000,
    });
    const code = await bad.waitExit();
    check(code === 2, `-p + 多余位置参数退出码应为 2（实际 ${code}）`, bad.screen);
    check(readdirSync(dirs.sessions).length === 0, "用法错误不应创建会话", bad.screen);
  } catch (e) {
    throw attachScreen(e, bad.screen, bad.stderr);
  } finally {
    await bad.close();
  }
  const ok = await startNeo({ fake, dirs, name: "s42b-ok", args: [...BASE_ARGS, "-p", "q", "--add-dir", "./a"] });
  try {
    const code = await ok.waitExit();
    check(code === 0, `-p + 单个 --add-dir 应正常退出 0（实际 ${code}）`, ok.screen);
    check(!ok.screen.text().includes("每个目录各写一次 --add-dir"), "无多余位置参数不应报位置参数错", ok.screen);
    maybeDumpScreen(ok.screen);
  } catch (e) {
    throw attachScreen(e, ok.screen, ok.stderr);
  } finally {
    await ok.close();
    await fake.stop();
  }
}

/** #63 S43：/add-dir 加入 → 不带参数列出 → /cd 换主根清空额外根并列出被清掉的根。 */
async function scenarioS43(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s43-add-dir-cd");
  const shared = join(dirs.root, "shared");
  await mkdir(join(shared, "inner"), { recursive: true });
  await writeFile(join(shared, "shared-file.ts"), "export const SHARED_MARK = 1;\n", "utf8");
  const fake = await startFake("narration");
  const run = await startNeo({ fake, dirs, name: "s43", args: BASE_ARGS, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  try {
    await waitPrompt(run);
    await run.type("/add-dir ../shared ../nope");
    await waitFor(() => run.screen.text().includes("已加入 1 个，失败 1 个；当前额外根："), {
      label: "/add-dir 部分失败：每条失败一行 + 汇总",
      run,
      timeoutMs: 8000,
    });
    check(run.screen.text().includes("✖ ../nope：目录不存在"), "失败路径单独一行", run.screen);
    await run.type("/add-dir");
    await waitFor(() => run.screen.text().includes("主根"), { label: "/add-dir 无参列出主根与额外根", run, timeoutMs: 6000 });
    await run.type("/cd ../shared/inner");
    await waitFor(() => run.screen.text().includes("已清空本会话额外工作根 1 个"), {
      label: "/cd 换主根清空额外根并列出",
      run,
      timeoutMs: 8000,
    });
    check(run.screen.text().includes("（/cd 换主根会清空额外根；/cd - 不恢复）"), "清空提示带口径说明", run.screen);
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

/** #63 S44：忙碌时 /add-dir 排队，不中轮注入；轮末作为独立命令执行。 */
async function scenarioS44(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s44-add-dir-busy");
  await mkdir(join(dirs.root, "shared"), { recursive: true });
  const fake = await startFake("slow");
  const run = await startNeo({ fake, dirs, name: "s44", args: BASE_ARGS, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  try {
    await waitPrompt(run);
    await run.type("第一问");
    await waitFor(() => run.screen.text().includes("运行中"), { label: "首轮进行中", run, timeoutMs: 8000 });
    await run.type("/add-dir ../shared");
    await waitFor(() => (statusLineOf(run.screen) ?? "").includes("⇥ 1 排队"), {
      label: "忙碌时 /add-dir 入队",
      run,
      timeoutMs: 6000,
    });
    check(!run.screen.text().includes("已加入 1 个"), "忙碌时 /add-dir 不应立刻生效", run.screen);
    await waitFor(() => run.screen.text().includes("已加入 1 个，失败 0 个"), {
      label: "轮末作为独立命令执行",
      run,
      timeoutMs: 15_000,
    });
    const text = run.screen.text();
    const answerAt = text.indexOf("慢回答完成。");
    check(answerAt >= 0 && answerAt < text.indexOf("已加入 1 个"), "/add-dir 应在本轮回答之后才执行", run.screen);
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

/** #63 S45：-c 主根相同恢复额外根；-C 换主根续聊则不恢复并给一行说明。 */
async function scenarioS45(tmpRoot: string): Promise<void> {
  const dirs = await makeDirs(tmpRoot, "s45-add-dir-resume");
  await mkdir(join(dirs.root, "shared"), { recursive: true });
  const shared = realpathSync(join(dirs.root, "shared"));
  await mkdir(join(dirs.work, "sub"), { recursive: true });
  const fake = await startFake("narration");
  try {
    const first = await startNeo({ fake, dirs, name: "s45-a", args: [...BASE_ARGS, "--add-dir", "../shared"] });
    try {
      await waitPrompt(first);
      await first.type("/add-dir");
      await waitFor(() => first.screen.text().includes(shared), { label: "启动 --add-dir 进入额外根", run: first, timeoutMs: 6000 });
      await first.type("/exit");
      await first.waitExit();
    } catch (e) {
      throw attachScreen(e, first.screen, first.stderr);
    } finally {
      await first.close();
    }
    const again = await startNeo({ fake, dirs, name: "s45-b", args: [...BASE_ARGS, "-c"] });
    try {
      await waitPrompt(again);
      await again.type("/add-dir");
      await waitFor(() => again.screen.text().includes(shared), { label: "-c 主根相同恢复额外根", run: again, timeoutMs: 6000 });
      await again.type("/exit");
      await again.waitExit();
    } catch (e) {
      throw attachScreen(e, again.screen, again.stderr);
    } finally {
      await again.close();
    }
    const moved = await startNeo({ fake, dirs, name: "s45-c", args: [...BASE_ARGS, "-C", "sub", "-c"] });
    try {
      await waitPrompt(moved);
      await waitFor(() => moved.screen.text().includes("不恢复"), { label: "换主根续聊不恢复额外根并说明", run: moved, timeoutMs: 6000 });
      await moved.type("/add-dir");
      await waitFor(() => moved.screen.text().includes("当前没有额外工作根"), { label: "额外根为空", run: moved, timeoutMs: 6000 });
      maybeDumpScreen(moved.screen);
      await moved.type("/exit");
      await moved.waitExit();
    } catch (e) {
      throw attachScreen(e, moved.screen, moved.stderr);
    } finally {
      await moved.close();
    }
  } finally {
    await fake.stop();
  }
}

/** #85：工作目录做成 git 仓库；settings.json 被 gitignore 并列入 .worktreeinclude，新建托管树时随之拷入。 */
async function makeWorktreeRepo(tmpRoot: string, name: string): Promise<RunDirs> {
  const dirs = await makeDirs(tmpRoot, name);
  await writeFile(join(dirs.work, ".gitignore"), "settings.json\n.neo/\n", "utf8");
  await writeFile(join(dirs.work, ".worktreeinclude"), "settings.json\n", "utf8");
  await writeFile(join(dirs.work, "README.md"), "S85\n", "utf8");
  await writeFile(join(dirs.work, "settings.json"), JSON.stringify(PTY_SETTINGS, null, 2), "utf8");
  initGitRepo(dirs.work);
  return dirs;
}

/** #85 S46：--worktree 启动 → /worktree 提示 → exit 回主检出 → 非隔离态 exit 拒绝 → 会话中 create。 */
async function scenarioS46(tmpRoot: string): Promise<void> {
  const dirs = await makeWorktreeRepo(tmpRoot, "s46-worktree-session");
  const work = realpathSync(dirs.work);
  const fake = await startFake("narration");
  const run = await startNeo({ fake, dirs, name: "s46", args: [...BASE_ARGS, "--worktree", "feat"] });
  try {
    await waitPrompt(run);
    check(run.screen.text().includes("已创建 worktree feat"), "--worktree 启动新建托管树", run.screen);
    await run.type("/worktree");
    await waitFor(() => run.screen.text().includes("可用：list | create <name> | enter <name> | exit | remove <name> [--force]"), {
      label: "/worktree 无子命令提示可用子命令",
      run,
      timeoutMs: 6000,
    });
    await run.type("/worktree exit");
    await waitFor(() => run.screen.text().includes("已退出 worktree feat"), { label: "/worktree exit 回到 mainRoot", run, timeoutMs: 8000 });
    check(run.screen.text().includes(work), "exit 后主根是主检出", run.screen);
    await run.type("/worktree exit");
    await waitFor(() => run.screen.text().includes("当前不在托管 worktree 会话里"), {
      label: "非隔离态 exit 拒绝",
      run,
      timeoutMs: 6000,
    });
    await run.type("/worktree create beta");
    await waitFor(() => run.screen.text().includes("已创建 worktree beta"), { label: "会话中 create", run, timeoutMs: 8000 });
    check(existsSync(join(work, ".neo", "worktrees", "feat")), "exit 不删树", run.screen);
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

/** #85 S47：续聊恢复隔离；显式 -c --worktree 不走自动回到记录树的例外。 */
async function scenarioS47(tmpRoot: string): Promise<void> {
  const dirs = await makeWorktreeRepo(tmpRoot, "s47-worktree-resume");
  const fake = await startFake("narration");
  try {
    const first = await startNeo({ fake, dirs, name: "s47-a", args: BASE_ARGS });
    try {
      await waitPrompt(first);
      await first.type("/worktree create feat");
      await waitFor(() => first.screen.text().includes("已创建 worktree feat"), { label: "会话中 create feat", run: first, timeoutMs: 8000 });
      await first.type("/exit");
      await first.waitExit();
    } catch (e) {
      throw attachScreen(e, first.screen, first.stderr);
    } finally {
      await first.close();
    }
    const explicit = await startNeo({ fake, dirs, name: "s47-b", args: [...BASE_ARGS, "-c", "--worktree", "other"] });
    try {
      await waitPrompt(explicit);
      check(explicit.screen.text().includes("已创建 worktree other"), "显式 --worktree 先按 #9 进入该树", explicit.screen);
      check(!explicit.screen.text().includes("续聊恢复隔离"), "显式 --worktree 不走自动回到记录树", explicit.screen);
      await explicit.type("/exit");
      await explicit.waitExit();
    } catch (e) {
      throw attachScreen(e, explicit.screen, explicit.stderr);
    } finally {
      await explicit.close();
    }
    const again = await startNeo({ fake, dirs, name: "s47-c", args: [...BASE_ARGS, "-c"] });
    try {
      await waitPrompt(again);
      await waitFor(() => again.screen.text().includes("已回到 worktree other（续聊恢复隔离）"), {
        label: "-c 三条件满足回到记录的树",
        run: again,
        timeoutMs: 6000,
      });
      await again.type("/worktree exit");
      await waitFor(() => again.screen.text().includes("已退出 worktree other"), { label: "续聊后可 exit", run: again, timeoutMs: 8000 });
      maybeDumpScreen(again.screen);
      await again.type("/exit");
      await again.waitExit();
    } catch (e) {
      throw attachScreen(e, again.screen, again.stderr);
    } finally {
      await again.close();
    }
  } finally {
    await fake.stop();
  }
}

/** #85 S48：忙碌时 /worktree create 按 #66 排队，轮末作为独立命令执行。 */
async function scenarioS48(tmpRoot: string): Promise<void> {
  const dirs = await makeWorktreeRepo(tmpRoot, "s48-worktree-busy");
  const fake = await startFake("slow");
  const run = await startNeo({ fake, dirs, name: "s48", args: BASE_ARGS, cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  try {
    await waitPrompt(run);
    await run.type("第一问");
    await waitFor(() => run.screen.text().includes("运行中"), { label: "首轮进行中", run, timeoutMs: 8000 });
    await run.type("/worktree create feat");
    await waitFor(() => (statusLineOf(run.screen) ?? "").includes("⇥ 1 排队"), { label: "忙碌时 /worktree 入队", run, timeoutMs: 6000 });
    check(!run.screen.text().includes("已创建 worktree feat"), "忙碌时 /worktree 不应立刻生效", run.screen);
    await waitFor(() => run.screen.text().includes("已创建 worktree feat"), { label: "轮末作为独立命令执行", run, timeoutMs: 15_000 });
    const text = run.screen.text();
    check(text.indexOf("慢回答完成。") >= 0 && text.indexOf("慢回答完成。") < text.indexOf("已创建 worktree feat"), "/worktree 应在本轮回答之后才执行", run.screen);
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

const SCENARIOS: Scenario[] = [
  {id:"s42", title:"#63 交互 TTY：--add-dir 多余位置参数报用法错误 2",fn:scenarioS42,focus:["每个目录各写一次 --add-dir"]},
  {id:"s42b", title:"#63 交互 TTY：-p 同样报多余位置参数错；单个 --add-dir 的 -p 照常",fn:scenarioS42b,focus:["每个目录各写一次 --add-dir"]},
  {id:"s43", title:"#63 /add-dir 加入/列出，/cd 换主根清空额外根",fn:scenarioS43,focus:["已加入","已清空本会话额外工作根"]},
  {id:"s44", title:"#63 忙碌时 /add-dir 排队到轮末执行",fn:scenarioS44,focus:["排队","已加入"]},
  {id:"s45", title:"#63 -c 恢复额外根；换主根续聊不恢复",fn:scenarioS45,focus:["不恢复","额外工作根"]},
  {id:"s46", title:"#85 --worktree 启动后 exit 回主检出；/worktree 提示；会话中 create",fn:scenarioS46,focus:["已退出 worktree","可用：list"]},
  {id:"s47", title:"#85 续聊恢复隔离；显式 -c --worktree 不走例外",fn:scenarioS47,focus:["续聊恢复隔离","已创建 worktree other"]},
  {id:"s48", title:"#85 忙碌时 /worktree create 排队到轮末执行",fn:scenarioS48,focus:["排队","已创建 worktree feat"]},
  {id:"s34", title:"#64 drive 内部轮共享额度与 clear 生命周期",fn:scenarioS34,focus:["已启动自动续跑","上下文已清空"]},
  {id:"s35", title:"#90 Ctrl+O 打开/Esc 关闭/再次 Ctrl+O 关闭 transcript 视图",fn:scenarioS35,focus:["本会话还没有记录","/ 搜索"]},
  {id:"s36", title:"#90 视图内 / 或 Ctrl+F 搜索并跳到命中",fn:scenarioS36,focus:["UNIQUE_ALPHA","会话恢复测试答案。"]},
  {id:"s37", title:"#88 初次使用向导：测通后写入 ~/.neo/settings.json 并正常启动",fn:scenarioS37,focus:["请输入 base_url","请输入 api_key","已写入"]},
  {id:"s38", title:"#88 探测失败不写文件并退出 2",fn:scenarioS38,focus:["探测失败","重试或退出"]},
  {id:"s39", title:"#70 --safe-mode 启动提示干净配置，自定义项未加载",fn:scenarioS39,focus:["当前为干净配置，自定义项未加载","未加载"]},
  {id:"s40", title:"#66 运行中转向：排队计数 → 工具切点注入 → 同轮改路",fn:scenarioS40,focus:["STEER_SEEN","排队","STEER 改成只看第一行"]},
  {id:"s41", title:"#66 转向注入后 Esc：只停不删，不回滚文案",fn:scenarioS41,focus:["已中断（不回滚，转向已写入本轮）","STEER HOLD"]},
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
  {
    id: "s11",
    title: "S11 状态条常驻：字段/时长递增/忙碌排队/分支",
    fn: scenarioS11,
    focus: ["ctx ", "运行中", "排队"],
  },
  {
    id: "s12",
    title: "S12 输入框视觉：中文/emoji/退格整字",
    fn: scenarioS12,
    focus: ["❯ 中文输入", "❯ 你"],
  },
  {
    id: "s13",
    title: "S13 输入框多行滚动：窗口/横线/状态行",
    fn: scenarioS13,
    focus: ["L10", "Agent:"],
  },
  {
    id: "s14",
    title: "S14 审批模态：问题可见/输入框不消失/写入生效",
    fn: scenarioS14,
    focus: ["write_file", "写完了。"],
  },
  {
    id: "s15",
    title: "S15 resize：100→60 列后帧不超宽/不串行",
    fn: scenarioS15,
    focus: ["这是一段用于测试", "Agent:"],
  },
  {
    id: "s16",
    title: "S16 选择菜单：↓/Enter 生效、Esc 取消、状态行在",
    fn: scenarioS16,
    focus: ["切换到哪个档位", "档位 →"],
  },
  {
    id: "s17",
    title: "S17 双 Ctrl+C：第一次提示、第二次退出",
    fn: scenarioS17,
    focus: ["再按 Ctrl+C 退出"],
  },
  {
    id: "s18",
    title: "S18 --resume 真续接 + 活进程拒绝 + 列表隐藏",
    fn: scenarioS18,
    focus: ["已恢复会话", "另一个进程"],
  },
  {
    id: "s19",
    title: "S19 显式代号 + Agent 静态标题 + /rename neo",
    fn: scenarioS19,
    focus: ["Agent:", "neo"],
  },
  {
    id: "s20",
    title: "S20 askUser：问题/选项/回答/模型继续",
    fn: scenarioS20,
    focus: ["选哪个报价方案", "回答：方案 B", "ANSWER_OK"],
  },
  {
    id: "s21",
    title: "S21 /goal 目标锚：设置/查看/清除，且设目标时带工具 turn 正常",
    fn: scenarioS21,
    focus: ["目标锚已设置", "找出这篇博客的作者", "读完了：内容是 hello。"],
  },
  {
    id: "s22",
    title: "S22 启动降噪：无探测诊断；banner → shell → 项目记忆提示（紧邻且一次）",
    fn: scenarioS22,
    focus: ["neo", "shell ", "已加载项目记忆"],
  },
  {
    id: "s22b",
    title: "S22b 有 shell 配置告警：告警可见但不打断「shell 行 → 项目记忆提示」紧邻",
    fn: scenarioS22b,
    focus: ["neo", "已加载项目记忆", "指定的 shell 不可执行"],
  },
  {
    id: "s22c",
    title: "S22c 小窗口：系统提示词放不下预算时给一次性提示（排在记忆提示之后，日志里也有）",
    fn: scenarioS22c,
    focus: ["neo", "已加载项目记忆", "系统提示词放不下预算"],
  },
  {
    id: "s23",
    title: "S23 输入框 ! shell 模式：进入/执行/回显/退出",
    fn: scenarioS23,
    focus: ["shell 命令", "NEO_SHELL_MODE_OK", "! echo NEO_SHELL_MODE_OK"],
  },
  {
    id: "s24",
    title: "S24 /loop 定时循环：启动/注入/状态/停止",
    fn: scenarioS24,
    focus: ["已启动循环", "❯ 看一下日志", "已跑 1 次"],
  },
  {
    id: "s25",
    title: "S25 / 渐进式命令菜单：自动打开/过滤/Tab 接受/Enter 执行",
    fn: scenarioS25,
    focus: ["清空上下文", "/todos", "暂无待办"],
  },
  {
    id: "s26",
    title: "S26 /tasks 后台子代理面板：空态",
    fn: scenarioS26,
    focus: ["没有后台任务"],
  },
  {
    id: "s27",
    title: "S27 /ps 后台 shell 面板：空态",
    fn: scenarioS27,
    focus: ["没有后台命令"],
  },
  {
    id: "s28",
    title: "S28 /rewind 按轮次回滚：空态",
    fn: scenarioS28,
    focus: ["还没有可回滚的轮次"],
  },
  {
    id: "s29",
    title: "S29 /drive 目标驱动续跑：空态/启动/状态/停止",
    fn: scenarioS29,
    focus: ["没有正在进行的自动续跑", "已启动自动续跑", "已停止自动续跑"],
  },
  {
    id: "s30",
    title: "S30 Esc Esc 打开 rewind 菜单：选轮次/选模式/执行/取消",
    fn: scenarioS30,
    focus: ["回滚到哪一轮之前？", "回滚什么？", "已回滚"],
  },
  {
    id: "s31",
    title: "#64 交互 new：SessionStart 先于 UserPromptSubmit，阻断原因可见",
    fn: scenarioS31,
    focus: ["S31 阻断原因可见", "SessionStart", "PreCompact"],
  },
  {
    id: "s32",
    title: "#64 --resume：只触发 SessionStart，回放历史不算用户提交",
    fn: scenarioS32,
    focus: ["SessionStart", "读完了：内容是 hello。"],
  },
  {
    id: "s33",
    title: "#64 Stop 续跑一次：TurnEnd/Notification 各一次",
    fn: scenarioS33,
    focus: ["读完了：内容是 hello。", "Stop", "TurnEnd"],
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
