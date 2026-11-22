/**
 * tui/statusLine.ts — issue #57 自定义状态区。
 *
 * 从获胜的那一份 settings.json 顶层 `statusLine` 读一条 shell 命令，
 * 把会话 JSON 从 stdin 喂给它，把退出码 0 的 stdout 画在输入框与内置状态行之间。
 *
 * 这不是 hook 事件：禁止走 hook 执行器，也不登记进 hooks 配置段。
 * 只复用 getShell / prepareShellInvocation 与「独立 spawn + 进程组 SIGKILL、
 * 失败变结果」的底座。超时默认 2s、上限 10s，不用 hooks 的 600 / 30 / 10。
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { getShell, prepareShellInvocation } from "../shell.ts";
import type { Config, StatusLineConfig } from "../config/types.ts";
import { estimateTokens, type Message, type ToolSpec } from "../llm.ts";
import { truncateAnsi } from "./ansi.ts";

export const STATUSLINE_DEBOUNCE_MS = 300;
export const STATUSLINE_DEFAULT_TIMEOUT_SEC = 2;
export const STATUSLINE_MAX_TIMEOUT_SEC = 10;
export const STATUSLINE_MAX_PADDING = 8;
export const STATUSLINE_MIN_REFRESH_INTERVAL_SEC = 1;
export const STATUSLINE_MAX_LINES = 5;
export const STATUSLINE_STDOUT_LIMIT = 8192;

export type { StatusLineConfig };

export interface ParseStatusLineResult {
  config: StatusLineConfig | null;
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** 解析 settings.json 顶层 statusLine。业务不放进 config.ts。 */
export function parseStatusLine(raw: unknown): ParseStatusLineResult {
  if (raw === undefined || raw === null) return { config: null, warnings: [] };
  if (!isPlainObject(raw)) return { config: null, warnings: [] };

  const warnings: string[] = [];
  const command = typeof raw["command"] === "string" ? raw["command"].trim() : "";
  if (command === "") return { config: null, warnings: [] };

  const typeRaw = raw["type"];
  if (typeRaw !== undefined && typeRaw !== "command") {
    warnings.push(`statusLine.type 不支持 "${String(typeRaw)}"，已忽略该段。`);
    return { config: null, warnings };
  }

  let padding = 0;
  if (raw["padding"] !== undefined) {
    const n = asInt(raw["padding"]);
    if (n === null || n < 0) {
      padding = 0;
      warnings.push("statusLine.padding 非法，已回退为 0。");
    } else {
      padding = Math.min(n, STATUSLINE_MAX_PADDING);
    }
  }

  let refreshInterval: number | null = null;
  if (raw["refreshInterval"] !== undefined) {
    const n = asInt(raw["refreshInterval"]);
    if (n !== null && n >= STATUSLINE_MIN_REFRESH_INTERVAL_SEC) refreshInterval = n;
  }

  let timeout = STATUSLINE_DEFAULT_TIMEOUT_SEC;
  if (raw["timeout"] !== undefined) {
    const n = asInt(raw["timeout"]);
    if (n === null || n <= 0) {
      timeout = STATUSLINE_DEFAULT_TIMEOUT_SEC;
      warnings.push("statusLine.timeout 非法或过小，已回退为 2 秒。");
    } else {
      timeout = Math.min(n, STATUSLINE_MAX_TIMEOUT_SEC);
    }
  }

  return { config: { command, padding, refreshInterval, timeout }, warnings };
}

/** 供 loadConfig 展开，避免把解析写进 config.ts。 */
export function statusLineConfigFields(raw: unknown): {
  statusLine: StatusLineConfig | null;
  statusLineWarnings: string[];
} {
  const r = parseStatusLine(raw);
  return { statusLine: r.config, statusLineWarnings: r.warnings };
}

export interface StatusLineIsolation {
  name: string;
  path: string;
  branch: string | null;
  origin: string;
}

export interface StatusLinePayloadInput {
  modelId: string;
  cwd: string;
  projectDir: string;
  addedDirs: readonly string[];
  sessionId: string;
  version: string;
  contextWindow: number;
  messages: Message[];
  tools: ToolSpec[];
  sessionName?: string | null;
  outputStyle?: string | null;
  isolation?: StatusLineIsolation | null;
  gitWorktreeName?: string | null;
  thinking?: { type: "enabled" | "disabled" };
}

const DEFAULT_NAME_RE = /^Neo#([1-9]\d*)$/;

export function isPlaceholderSessionName(name: string | null | undefined): boolean {
  return typeof name === "string" && DEFAULT_NAME_RE.test(name);
}

function usedRemainingPercent(used: number, size: number): { used: number; remaining: number } {
  const ratio = size > 0 && Number.isFinite(used) ? used / size : 0;
  const usedPct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return { used: usedPct, remaining: Math.max(0, 100 - usedPct) };
}

/** 组 stdin JSON：只填能诚实给出的官方字段名，没有的省略。 */
export function buildStatusLinePayload(input: StatusLinePayloadInput): Record<string, unknown> {
  const used = estimateTokens(input.messages, input.tools);
  const pct = usedRemainingPercent(used, input.contextWindow);
  const workspace: Record<string, unknown> = {
    current_dir: input.cwd,
    project_dir: input.projectDir,
    added_dirs: [...input.addedDirs],
  };
  if (input.gitWorktreeName) workspace["git_worktree"] = input.gitWorktreeName;

  const payload: Record<string, unknown> = {
    model: { id: input.modelId, display_name: input.modelId },
    cwd: input.cwd,
    workspace,
    session_id: input.sessionId,
    version: input.version,
    context_window: {
      context_window_size: input.contextWindow,
      used_percentage: pct.used,
      remaining_percentage: pct.remaining,
    },
  };

  const sessionName = (input.sessionName ?? "").trim();
  if (sessionName !== "" && !isPlaceholderSessionName(sessionName)) {
    payload["session_name"] = sessionName;
  }

  const style = (input.outputStyle ?? "").trim();
  if (style !== "" && style.toLowerCase() !== "default") {
    payload["output_style"] = { name: style };
  }

  if (input.isolation) {
    const wt: Record<string, unknown> = {
      name: input.isolation.name,
      path: input.isolation.path,
      original_cwd: input.isolation.origin,
    };
    if (input.isolation.branch) wt["branch"] = input.isolation.branch;
    payload["worktree"] = wt;
  }

  if (input.thinking?.type === "enabled") {
    payload["thinking"] = { enabled: true };
  }

  return payload;
}

export function formatStatusLineRows(stdout: string, width: number, padding: number): string[] {
  const padN = Math.max(0, Math.min(STATUSLINE_MAX_PADDING, Math.floor(padding)));
  const pad = " ".repeat(padN);
  let lines = stdout.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.every((l) => l.trim() === "")) return [];
  lines = lines.slice(0, STATUSLINE_MAX_LINES);
  const limit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  return lines.map((line) => truncateAnsi(pad + line, limit));
}

export function shouldLaunchStatusLine(opts: {
  interactiveTTY: boolean;
  printMode: boolean;
  acp: boolean;
  safeMode: boolean;
  config: StatusLineConfig | null;
}): boolean {
  if (!opts.config) return false;
  if (opts.safeMode || opts.printMode || opts.acp || !opts.interactiveTTY) return false;
  return true;
}

export type StatusLineSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

function killStatusLineProcess(child: ChildProcess): void {
  const pid = child.pid;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else if (typeof pid === "number" && pid > 0) process.kill(-pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

interface RunResult {
  ok: boolean;
  stdout: string;
  aborted: boolean;
}

function runStatusLineCommand(opts: {
  command: string;
  cwd: string;
  payload: unknown;
  timeoutMs: number;
  columns: number;
  rows: number;
  shellConfig?: Pick<Config, "shell"> | Config;
  spawnFn?: StatusLineSpawnFn;
  signal?: AbortSignal;
}): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    let invocation: ReturnType<typeof prepareShellInvocation>;
    try {
      const spec = getShell(opts.shellConfig);
      invocation = prepareShellInvocation(spec, opts.command);
    } catch {
      finish({ ok: false, stdout: "", aborted: false });
      return;
    }

    const env: Record<string, string | undefined> = { ...invocation.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("NEO_HOOK_")) delete env[key];
    }
    env["COLUMNS"] = String(Math.max(0, Math.floor(opts.columns)));
    env["LINES"] = String(Math.max(0, Math.floor(opts.rows)));

    const spawnFn = opts.spawnFn ?? spawn;
    let child: ChildProcess;
    try {
      child = spawnFn(invocation.argv[0]!, invocation.argv.slice(1), {
        cwd: opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch {
      finish({ ok: false, stdout: "", aborted: false });
      return;
    }

    let kept = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;

    const onAbort = (): void => {
      aborted = true;
      killStatusLineProcess(child);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killStatusLineProcess(child);
    }, Math.max(1, opts.timeoutMs));

    child.stdout?.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (kept.length < STATUSLINE_STDOUT_LIMIT) {
        const room = STATUSLINE_STDOUT_LIMIT - kept.length;
        kept = Buffer.concat([kept, buf.subarray(0, room)]);
      }
      // 超出部分继续读掉，避免堵死管道。
    });
    child.stderr?.on("data", () => {
      // 排空 stderr，不进 TUI。
    });
    child.on("error", () => {
      finish({ ok: false, stdout: "", aborted });
    });
    child.on("close", (code) => {
      if (aborted) {
        finish({ ok: false, stdout: "", aborted: true });
        return;
      }
      if (timedOut || code !== 0) {
        finish({ ok: false, stdout: "", aborted: false });
        return;
      }
      finish({ ok: true, stdout: kept.toString("utf8"), aborted: false });
    });

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${JSON.stringify(opts.payload)}\n`);
    } catch {
      /* hook 同口径：不读 stdin 就退出不算错 */
    }
  });
}

export interface StatusLineControllerDeps {
  getSettings: () => StatusLineConfig | null;
  buildPayload: () => Record<string, unknown>;
  getCwd: () => string;
  getSize: () => { columns: number; rows: number };
  getShellConfig: () => Pick<Config, "shell"> | Config;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  clearSchedule?: (id: unknown) => void;
  spawnFn?: StatusLineSpawnFn;
  onUpdate?: () => void;
}

export interface StatusLineController {
  start(): void;
  requestRefresh(): void;
  setSize(columns: number, rows: number): void;
  visibleRows(width: number): string[];
  isRunning(): boolean;
  dispose(): void;
}

export function createStatusLineController(deps: StatusLineControllerDeps): StatusLineController {
  void deps.now;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    (t as unknown as { unref?: () => void }).unref?.();
    return t;
  });
  const clearSchedule = deps.clearSchedule ?? ((id: unknown) => {
    if (id !== undefined && id !== null) clearTimeout(id as NodeJS.Timeout);
  });

  let debounceId: unknown = null;
  let intervalId: unknown = null;
  let runAbort: AbortController | null = null;
  let running = false;
  let lastStdout: string | null = null;
  let lastPadding = 0;
  let disposed = false;
  let started = false;
  let columns = 80;
  let rows = 24;
  let seq = 0;

  const sizeNow = (): void => {
    const s = deps.getSize();
    columns = s.columns;
    rows = s.rows;
  };

  const notify = (): void => {
    deps.onUpdate?.();
  };

  const clearDebounce = (): void => {
    if (debounceId !== null) {
      clearSchedule(debounceId);
      debounceId = null;
    }
  };

  const abortRun = (): void => {
    runAbort?.abort();
  };

  const runNow = (): void => {
    if (disposed) return;
    const settings = deps.getSettings();
    if (!settings) return;
    const thisSeq = ++seq;
    abortRun();
    const ac = new AbortController();
    runAbort = ac;
    running = true;
    sizeNow();
    const payload = deps.buildPayload();
    const cwd = deps.getCwd();
    const padding = settings.padding;
    void runStatusLineCommand({
      command: settings.command,
      cwd,
      payload,
      timeoutMs: settings.timeout * 1000,
      columns,
      rows,
      shellConfig: deps.getShellConfig(),
      spawnFn: deps.spawnFn,
      signal: ac.signal,
    }).then((r) => {
      if (disposed || thisSeq !== seq) return;
      running = false;
      if (runAbort === ac) runAbort = null;
      if (r.aborted) return; // 保留上一趟成功输出
      if (r.ok) {
        const rowsOut = formatStatusLineRows(r.stdout, columns, padding);
        if (rowsOut.length === 0) {
          lastStdout = null;
        } else {
          lastStdout = r.stdout;
          lastPadding = padding;
        }
      } else {
        lastStdout = null;
      }
      notify();
    }).catch(() => {
      if (disposed || thisSeq !== seq) return;
      running = false;
      if (runAbort === ac) runAbort = null;
      lastStdout = null;
      notify();
    });
  };

  const armInterval = (): void => {
    if (intervalId !== null) {
      clearSchedule(intervalId);
      intervalId = null;
    }
    const settings = deps.getSettings();
    const sec = settings?.refreshInterval;
    if (!sec) return;
    const ms = sec * 1000;
    const tick = (): void => {
      intervalId = null;
      if (disposed) return;
      runNow();
      intervalId = schedule(tick, ms);
    };
    intervalId = schedule(tick, ms);
  };

  return {
    start(): void {
      if (disposed || started) return;
      started = true;
      sizeNow();
      runNow();
      armInterval();
    },
    requestRefresh(): void {
      if (disposed || !deps.getSettings()) return;
      clearDebounce();
      debounceId = schedule(() => {
        debounceId = null;
        runNow();
      }, STATUSLINE_DEBOUNCE_MS);
    },
    setSize(nextCols: number, nextRows: number): void {
      columns = nextCols;
      rows = nextRows;
      // 只按新宽度裁剪上次成功输出，不立刻重跑。
      notify();
    },
    visibleRows(width: number): string[] {
      if (lastStdout === null) return [];
      return formatStatusLineRows(lastStdout, width, lastPadding);
    },
    isRunning(): boolean {
      return running;
    },
    dispose(): void {
      disposed = true;
      clearDebounce();
      if (intervalId !== null) {
        clearSchedule(intervalId);
        intervalId = null;
      }
      abortRun();
      running = false;
    },
  };
}
