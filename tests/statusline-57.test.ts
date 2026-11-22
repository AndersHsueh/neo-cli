/**
 * issue #57：settings.statusLine 自定义状态区（已签合同）。
 *
 * 覆盖合同「测试面」1–9：配置解析、stdin JSON、防抖、取消在途、超时杀组、
 * 非 0 / 空输出、多行与 ANSI / 8KiB 排空、未配置与 --safe-mode、以及
 * -p / 非 TTY / ACP 不跑命令。现有 renderStatus 单行契约由 tui-status 与
 * issue76 测试继续锁住，本文件不改那些断言。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { applySafeMode } from "../src/cli/safeMode.ts";
import { helpText } from "../src/cli/help.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { estimateTokens, type Message, type ToolSpec } from "../src/llm.ts";
import { VERSION } from "../src/cli/version.ts";
import {
  STATUSLINE_DEBOUNCE_MS,
  STATUSLINE_DEFAULT_TIMEOUT_SEC,
  STATUSLINE_MAX_LINES,
  STATUSLINE_MAX_PADDING,
  STATUSLINE_MAX_TIMEOUT_SEC,
  STATUSLINE_STDOUT_LIMIT,
  buildStatusLinePayload,
  createStatusLineController,
  formatStatusLineRows,
  parseStatusLine,
  shouldLaunchStatusLine,
  type StatusLinePayloadInput,
} from "../src/tui/statusLine.ts";

const sandboxes: string[] = [];
function sandbox(name: string): string {
  const root = mkdtempSync(join(tmpdir(), name));
  sandboxes.push(root);
  return root;
}
afterAll(() => {
  for (const s of sandboxes) rmSync(s, { recursive: true, force: true });
});

function writeSettings(dir: string, body: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        default_provider: "local",
        providers: [
          {
            provider_name: "local",
            provider_type: "openai",
            base_url: "http://127.0.0.1:9/v1",
            api_key: "k",
            default_model_name: "m",
          },
        ],
        ...body,
      },
      null,
      2,
    ),
  );
  return path;
}

function loadIn(dir: string): Config {
  const prevHome = process.env["HOME"];
  const prevUser = process.env["USERPROFILE"];
  const prevCwd = process.cwd();
  process.env["HOME"] = dir;
  process.env["USERPROFILE"] = dir;
  process.chdir(dir);
  try {
    return loadConfig();
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    if (prevUser === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = prevUser;
    process.chdir(prevCwd);
  }
}

const FORBIDDEN_TOP = [
  "transcript_path",
  "rate_limits",
  "prompt_cache",
  "cost",
  "vim",
  "effort",
  "fast_mode",
  "exceeds_200k_tokens",
  "prompt_id",
];

describe("#57 parseStatusLine 配置解析", () => {
  test("整段缺省 / 空 command / 缺 command：视为未配置，不告警", () => {
    for (const raw of [undefined, null, {}, { type: "command" }, { command: "" }, { command: "   " }]) {
      const r = parseStatusLine(raw);
      expect(r.config).toBeNull();
      expect(r.warnings).toEqual([]);
    }
  });

  test("type 缺省但有 command 视为 command；默认 padding 0、timeout 2、无定时器", () => {
    const r = parseStatusLine({ command: "echo hi" });
    expect(r.warnings).toEqual([]);
    expect(r.config).toEqual({
      command: "echo hi",
      padding: 0,
      refreshInterval: null,
      timeout: STATUSLINE_DEFAULT_TIMEOUT_SEC,
    });
    expect(STATUSLINE_DEFAULT_TIMEOUT_SEC).toBe(2);
  });

  test("未知 type：告警一次，视为未配置", () => {
    const r = parseStatusLine({ type: "prompt", command: "echo hi" });
    expect(r.config).toBeNull();
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/type|未知|不支持/);
  });

  test("padding 上限 8；非法值当 0 并告警", () => {
    expect(STATUSLINE_MAX_PADDING).toBe(8);
    const ok = parseStatusLine({ command: "echo", padding: 8 });
    expect(ok.config?.padding).toBe(8);
    expect(ok.warnings).toEqual([]);
    const over = parseStatusLine({ command: "echo", padding: 9 });
    expect(over.config?.padding).toBe(8);
    const bad = parseStatusLine({ command: "echo", padding: -1 });
    expect(bad.config?.padding).toBe(0);
    expect(bad.warnings.length).toBe(1);
    const typ = parseStatusLine({ command: "echo", padding: "wide" });
    expect(typ.config?.padding).toBe(0);
    expect(typ.warnings.length).toBe(1);
  });

  test("refreshInterval 最小 1；未设或非法则不设定时器", () => {
    expect(parseStatusLine({ command: "echo", refreshInterval: 5 }).config?.refreshInterval).toBe(5);
    expect(parseStatusLine({ command: "echo", refreshInterval: 1 }).config?.refreshInterval).toBe(1);
    expect(parseStatusLine({ command: "echo", refreshInterval: 0 }).config?.refreshInterval).toBeNull();
    expect(parseStatusLine({ command: "echo", refreshInterval: 0.5 }).config?.refreshInterval).toBeNull();
    expect(parseStatusLine({ command: "echo", refreshInterval: "fast" }).config?.refreshInterval).toBeNull();
    expect(parseStatusLine({ command: "echo" }).config?.refreshInterval).toBeNull();
  });

  test("timeout 默认 2、上限 10；非法或过小回退默认并告警一次", () => {
    expect(STATUSLINE_MAX_TIMEOUT_SEC).toBe(10);
    expect(parseStatusLine({ command: "echo", timeout: 10 }).config?.timeout).toBe(10);
    expect(parseStatusLine({ command: "echo", timeout: 3 }).config?.timeout).toBe(3);
    const over = parseStatusLine({ command: "echo", timeout: 11 });
    expect(over.config?.timeout).toBe(10);
    const small = parseStatusLine({ command: "echo", timeout: 0 });
    expect(small.config?.timeout).toBe(2);
    expect(small.warnings.length).toBe(1);
    const bad = parseStatusLine({ command: "echo", timeout: "soon" });
    expect(bad.config?.timeout).toBe(2);
    expect(bad.warnings.length).toBe(1);
  });
});

describe("#57 stdin JSON", () => {
  const tools: ToolSpec[] = [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }];
  const messages: Message[] = [
    { role: "system", content: "you are neo" },
    { role: "user", content: "hello from the session" },
  ];
  const base: StatusLinePayloadInput = {
    modelId: "deepseek-flash",
    cwd: "/tmp/session-cwd",
    projectDir: "/tmp/project-dir",
    addedDirs: [],
    sessionId: "sess-57",
    version: "0.4.99",
    contextWindow: 200_000,
    messages,
    tools,
  };

  test("必给字段都在；百分比与 estimateTokens / contextWindow 同一口径；不用 tokensTotal", () => {
    const payload = buildStatusLinePayload(base) as Record<string, any>;
    expect(payload.model.id).toBe("deepseek-flash");
    expect(payload.model.display_name).toBe("deepseek-flash");
    expect(payload.cwd).toBe("/tmp/session-cwd");
    expect(payload.workspace.current_dir).toBe("/tmp/session-cwd");
    expect(payload.workspace.project_dir).toBe("/tmp/project-dir");
    expect(payload.workspace.added_dirs).toEqual([]);
    expect(payload.session_id).toBe("sess-57");
    expect(payload.version).toBe("0.4.99");
    expect(payload.version).toBe(VERSION);
    expect(payload.context_window.context_window_size).toBe(200_000);
    const used = estimateTokens(messages, tools);
    const usedPct = Math.max(0, Math.min(100, Math.round((used / 200_000) * 100)));
    expect(payload.context_window.used_percentage).toBe(usedPct);
    expect(payload.context_window.remaining_percentage).toBe(Math.max(0, 100 - usedPct));
    const cw = payload.context_window as Record<string, unknown>;
    expect(cw["total_tokens"]).toBeUndefined();
    expect(cw["total_input_tokens"]).toBeUndefined();
    expect(cw["total_output_tokens"]).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/tokensTotal/);
  });

  test("有额外根时 added_dirs 正确；无隔离绑定没有 worktree（含只换根）", () => {
    const payload = buildStatusLinePayload({
      ...base,
      addedDirs: ["/tmp/extra-a", "/tmp/extra-b"],
      isolation: null,
    }) as Record<string, any>;
    expect(payload.workspace.added_dirs).toEqual(["/tmp/extra-a", "/tmp/extra-b"]);
    expect(payload.worktree).toBeUndefined();
  });

  test("隔离绑定时给出 worktree.name/path/branch/original_cwd，没有 original_branch", () => {
    const payload = buildStatusLinePayload({
      ...base,
      isolation: {
        name: "feat",
        path: "/repo/.neo/worktrees/feat",
        branch: "neo/feat",
        origin: "/repo",
      },
    }) as Record<string, any>;
    expect(payload.worktree).toEqual({
      name: "feat",
      path: "/repo/.neo/worktrees/feat",
      branch: "neo/feat",
      original_cwd: "/repo",
    });
    expect(payload.worktree.original_branch).toBeUndefined();
  });

  test("明确省略项不得出现；Default / 缺省没有 output_style；Neo#N 不出现在 session_name", () => {
    const a = buildStatusLinePayload({ ...base, sessionName: "Neo#3", outputStyle: "Default" }) as Record<string, any>;
    expect(a.session_name).toBeUndefined();
    expect(a.output_style).toBeUndefined();
    expect(a.cost).toBeUndefined();
    expect(a.workspace.repo).toBeUndefined();
    for (const k of FORBIDDEN_TOP) expect(a[k]).toBeUndefined();
    const text = JSON.stringify(a);
    expect(text).not.toContain("transcript_path");
    expect(text).not.toContain("total_cost_usd");
    expect(text).not.toContain("original_branch");

    const b = buildStatusLinePayload({
      ...base,
      sessionName: "Anders",
      outputStyle: "Concise",
      thinking: { type: "enabled" },
      gitWorktreeName: "feat",
    }) as Record<string, any>;
    expect(b.session_name).toBe("Anders");
    expect(b.output_style).toEqual({ name: "Concise" });
    expect(b.thinking).toEqual({ enabled: true });
    expect(b.workspace.git_worktree).toBe("feat");

    const c = buildStatusLinePayload({ ...base, thinking: { type: "disabled" }, outputStyle: "" }) as Record<string, any>;
    expect(c.thinking).toBeUndefined();
    expect(c.output_style).toBeUndefined();
    expect(c.workspace.git_worktree).toBeUndefined();
  });
});

describe("#57 formatStatusLineRows 多行与 ANSI", () => {
  test("最多 5 行且丢底部；去掉末尾空行；padding 加在左侧", () => {
    expect(STATUSLINE_MAX_LINES).toBe(5);
    const stdout = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "", ""].join("\n");
    const rows = formatStatusLineRows(stdout, 80, 2);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe("  L1");
    expect(rows[4]).toBe("  L5");
    expect(rows.join("\n")).not.toContain("L6");
  });

  test("按显示列截断，SGR 不把宽度算爆，截断后收口 SGR", () => {
    const red = "\x1b[31m你好世界\x1b[0m";
    const rows = formatStatusLineRows(red, 6, 0); // 你好世界 = 8 列，截到 6
    expect(rows).toHaveLength(1);
    expect(rows[0]!.includes("\x1b[31m")).toBe(true);
    expect(rows[0]!.endsWith("\x1b[0m") || rows[0]!.includes("\x1b[0m")).toBe(true);
    // 显示列不超过预算（剥 SGR 后）
    const stripped = rows[0]!.replace(/\x1b\[[0-9;]*m/g, "");
    expect([...stripped].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)).toBeLessThanOrEqual(6);
  });

  test("只含空白的 stdout 得到空行列表", () => {
    expect(formatStatusLineRows("   \n\n", 80, 0)).toEqual([]);
    expect(formatStatusLineRows("", 80, 0)).toEqual([]);
  });
});

describe("#57 shouldLaunchStatusLine 与 --safe-mode / 非交互", () => {
  const configured = { command: "echo hi", padding: 0, refreshInterval: null, timeout: 2 };

  test("未配置、safe-mode、-p、非 TTY、ACP 都不该启动", () => {
    const ok = { interactiveTTY: true, printMode: false, acp: false, safeMode: false, config: configured };
    expect(shouldLaunchStatusLine(ok)).toBe(true);
    expect(shouldLaunchStatusLine({ ...ok, config: null })).toBe(false);
    expect(shouldLaunchStatusLine({ ...ok, safeMode: true })).toBe(false);
    expect(shouldLaunchStatusLine({ ...ok, printMode: true })).toBe(false);
    expect(shouldLaunchStatusLine({ ...ok, interactiveTTY: false })).toBe(false);
    expect(shouldLaunchStatusLine({ ...ok, acp: true })).toBe(false);
  });

  test("loadConfig 读出 statusLine；applySafeMode 显式跳过", () => {
    const dir = sandbox("neo-57-safe-");
    writeSettings(dir, { statusLine: { type: "command", command: "echo CUSTOM-SL-57" } });
    const cfg = loadIn(dir);
    expect(cfg.statusLine?.command).toBe("echo CUSTOM-SL-57");
    applySafeMode(cfg);
    expect(cfg.safeMode).toBe(true);
    expect(cfg.statusLine == null).toBe(true);
    expect(shouldLaunchStatusLine({
      interactiveTTY: true,
      printMode: false,
      acp: false,
      safeMode: true,
      config: cfg.statusLine ?? null,
    })).toBe(false);
  });

  test("源码不调用 runHook，也不把 statusLine 登记进 hooks", () => {
    const src = readFileSync(join(import.meta.dir, "../src/tui/statusLine.ts"), "utf8");
    expect(src).not.toMatch(/\brunHook\b/);
    expect(src).not.toMatch(/settings\.hooks/);
  });
});

describe("#57 /help 与 README 必须写清的口径", () => {
  test("帮助文本覆盖布局、安全模式、JSON 口径、不做 /statusline", () => {
    const text = helpText();
    expect(text).toMatch(/statusLine/);
    expect(text).toContain("第一份存在的文件全赢");
    expect(text).toMatch(/热重载/);
    expect(text).toMatch(/输入框与内置状态行之间/);
    expect(text).toMatch(/不替换内置行/);
    expect(text).not.toMatch(/官方是替换内置行/);
    expect(text).toMatch(/status line/);
    expect(text).toMatch(/--safe-mode/);
    expect(text).toMatch(/失败|超时/);
    expect(text).toMatch(/300ms/);
    expect(text).toMatch(/\/cd/);
    expect(text).toMatch(/最多 5 行|最多5行/);
    expect(text).toMatch(/8KiB|8 KiB|8192/);
    expect(text).toMatch(/estimateTokens|同一口径|同一套公式/);
    expect(text).toMatch(/project_dir/);
    expect(text).toMatch(/不提供 \/statusline|没有 \/statusline|不注册 \/statusline/);
    expect(text).toMatch(/不是沙箱/);
    // --safe-mode 列举要写上 status line
    const safe = text.slice(text.indexOf("--safe-mode"), text.indexOf("--safe-mode") + 800);
    expect(safe.toLowerCase()).toMatch(/status line|statusline|状态行/);
  });

  test("README 覆盖同样口径，不承诺社区脚本开箱即用", () => {
    const text = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
    expect(text).toMatch(/statusLine/);
    expect(text).toContain("第一份存在的文件全赢");
    expect(text).toMatch(/热重载/);
    expect(text).toMatch(/输入框与内置状态行之间/);
    expect(text).toMatch(/不替换内置行/);
    expect(text).not.toMatch(/官方是替换内置行/);
    expect(text).toMatch(/--safe-mode/);
    expect(text).toMatch(/300ms/);
    expect(text).toMatch(/\/cd/);
    expect(text).toMatch(/最多 5 行|最多5行/);
    expect(text).toMatch(/8KiB|8 KiB|8192/);
    expect(text).toMatch(/estimateTokens|同一口径|同一套公式/);
    expect(text).toMatch(/project_dir/);
    expect(text).toMatch(/不提供 \/statusline|没有 \/statusline|不注册 \/statusline/);
    expect(text).toMatch(/不是沙箱/);
    expect(text).not.toMatch(/ccstatusline|starship-claude/);
    expect(text).not.toMatch(/开箱即用/);
  });
});

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

function makeClock() {
  let now = 0;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clear: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms: number) {
      const target = now + ms;
      while (true) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
        if (due.length === 0) {
          now = target;
          return;
        }
        const t = due[0]!;
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
        now = t.at;
        t.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

function countingSpawn(calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv; cwd?: string }>, inner: SpawnFn = spawn): SpawnFn {
  return (cmd, args, opts) => {
    calls.push({
      argv: [cmd, ...args],
      env: (opts.env ?? {}) as NodeJS.ProcessEnv,
      cwd: typeof opts.cwd === "string" ? opts.cwd : undefined,
    });
    return inner(cmd, args, opts);
  };
}

const payloadOnce: StatusLinePayloadInput = {
  modelId: "m",
  cwd: process.cwd(),
  projectDir: process.cwd(),
  addedDirs: [],
  sessionId: "s",
  version: VERSION,
  contextWindow: 1000,
  messages: [],
  tools: [],
};

describe("#57 控制器：防抖、取消在途、失败隔离", () => {
  test("会话开始那一次立刻跑；300ms 内多次事件只跑一次", async () => {
    const dir = sandbox("neo-57-debounce-");
    const script = join(dir, "sl.sh");
    writeFileSync(script, "#!/bin/sh\necho RUN\n", { mode: 0o755 });
    const calls: Array<{ argv: string[] }> = [];
    const clock = makeClock();
    const ctl = createStatusLineController({
      getSettings: () => ({ command: script, padding: 0, refreshInterval: null, timeout: 2 }),
      buildPayload: () => buildStatusLinePayload({ ...payloadOnce, cwd: dir, projectDir: dir }),
      getCwd: () => dir,
      getSize: () => ({ columns: 80, rows: 24 }),
      getShellConfig: () => ({ cwd: dir } as Config),
      now: clock.now,
      schedule: clock.schedule,
      clearSchedule: clock.clear,
      spawnFn: countingSpawn(calls),
    });
    ctl.start(); // 立刻跑，不走防抖
    await clock.advance(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBe(1);
    ctl.requestRefresh();
    ctl.requestRefresh();
    ctl.requestRefresh();
    await clock.advance(STATUSLINE_DEBOUNCE_MS - 1);
    expect(calls.length).toBe(1);
    await clock.advance(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.length).toBe(2);
    expect(STATUSLINE_DEBOUNCE_MS).toBe(300);
    ctl.dispose();
  });

  test("进行中又来新事件：杀掉上一趟再跑；自定义区保留上一趟成功输出", async () => {
    const dir = sandbox("neo-57-cancel-");
    const slow = join(dir, "slow.sh");
    const fast = join(dir, "fast.sh");
    const flag = join(dir, "which");
    writeFileSync(flag, "slow");
    writeFileSync(
      slow,
      `#!/bin/sh\ntrap '' TERM\nsleep 30\necho SLOW\n`,
      { mode: 0o755 },
    );
    writeFileSync(fast, "#!/bin/sh\necho FAST\n", { mode: 0o755 });
    writeFileSync(
      join(dir, "run.sh"),
      `#!/bin/sh\nif grep -q fast "$1"; then echo FAST; else exec "$2"; fi\n`,
      { mode: 0o755 },
    );
    let mode: "slow" | "fast" = "slow";
    const ctl = createStatusLineController({
      getSettings: () => ({
        command: mode === "slow" ? slow : fast,
        padding: 0,
        refreshInterval: null,
        timeout: 10,
      }),
      buildPayload: () => buildStatusLinePayload({ ...payloadOnce, cwd: dir, projectDir: dir }),
      getCwd: () => dir,
      getSize: () => ({ columns: 80, rows: 24 }),
      getShellConfig: () => ({ cwd: dir } as Config),
    });
    // 先跑一趟成功的 FAST，留下成功输出
    mode = "fast";
    ctl.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(ctl.visibleRows(80).some((l) => l.includes("FAST"))).toBe(true);
    // 再跑 SLOW（在途），期间应仍显示 FAST；随后改 FAST 并刷新，应杀掉 SLOW 并显示新 FAST
    mode = "slow";
    ctl.requestRefresh();
    await new Promise((r) => setTimeout(r, 50));
    expect(ctl.isRunning()).toBe(true);
    expect(ctl.visibleRows(80).some((l) => l.includes("FAST"))).toBe(true);
    expect(ctl.visibleRows(80).some((l) => l.includes("SLOW"))).toBe(false);
    mode = "fast";
    ctl.requestRefresh();
    await new Promise((r) => setTimeout(r, 250));
    expect(ctl.visibleRows(80).some((l) => l.includes("FAST"))).toBe(true);
    expect(ctl.visibleRows(80).some((l) => l.includes("SLOW"))).toBe(false);
    ctl.dispose();
  });

  test("超时：杀进程组，自定义区空，不抛进调用方", async () => {
    const dir = sandbox("neo-57-timeout-");
    const script = join(dir, "hang.sh");
    // 子进程再派生一个 sleep，验证杀的是进程组
    writeFileSync(
      script,
      "#!/bin/sh\nsleep 30 &\nwait\necho NEVER\n",
      { mode: 0o755 },
    );
    const ctl = createStatusLineController({
      getSettings: () => ({ command: script, padding: 0, refreshInterval: null, timeout: 1 }),
      buildPayload: () => buildStatusLinePayload({ ...payloadOnce, cwd: dir, projectDir: dir }),
      getCwd: () => dir,
      getSize: () => ({ columns: 80, rows: 24 }),
      getShellConfig: () => ({ cwd: dir } as Config),
    });
    ctl.start();
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 1600));
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5000);
    expect(ctl.isRunning()).toBe(false);
    expect(ctl.visibleRows(80)).toEqual([]);
    ctl.dispose();
  });

  test("非 0 退出 / 空输出：自定义区空", async () => {
    const dir = sandbox("neo-57-fail-");
    const fail = join(dir, "fail.sh");
    const empty = join(dir, "empty.sh");
    writeFileSync(fail, "#!/bin/sh\necho nope >&2\nexit 3\n", { mode: 0o755 });
    writeFileSync(empty, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const ctl = createStatusLineController({
      getSettings: () => ({ command: fail, padding: 0, refreshInterval: null, timeout: 2 }),
      buildPayload: () => buildStatusLinePayload({ ...payloadOnce, cwd: dir, projectDir: dir }),
      getCwd: () => dir,
      getSize: () => ({ columns: 80, rows: 24 }),
      getShellConfig: () => ({ cwd: dir } as Config),
    });
    ctl.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(ctl.visibleRows(80)).toEqual([]);
    ctl.dispose();

    const ctl2 = createStatusLineController({
      getSettings: () => ({ command: empty, padding: 0, refreshInterval: null, timeout: 2 }),
      buildPayload: () => buildStatusLinePayload({ ...payloadOnce, cwd: dir, projectDir: dir }),
      getCwd: () => dir,
      getSize: () => ({ columns: 80, rows: 24 }),
      getShellConfig: () => ({ cwd: dir } as Config),
    });
    ctl2.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(ctl2.visibleRows(80)).toEqual([]);
    ctl2.dispose();
  });

  test("stdin 写一行 JSON 后关闭；设置 COLUMNS/LINES；不套 NEO_HOOK_*；cwd 是会话主根", async () => {
    const dir = sandbox("neo-57-stdin-");
    const out = join(dir, "got.json");
    const envf = join(dir, "env.txt");
    const script = join(dir, "read.sh");
    writeFileSync(
      script,
      `#!/bin/sh\ncat > "${out}"\nprintf 'cols=%s lines=%s hook=%s cwd=%s\\n' "$COLUMNS" "$LINES" "\${NEO_HOOK_EVENT-}" "$(pwd)" > "${envf}"\necho OK\n`,
      { mode: 0o755 },
    );
    const ctl = createStatusLineController({
      getSettings: () => ({ command: script, padding: 0, refreshInterval: null, timeout: 2 }),
      buildPayload: () => buildStatusLinePayload({
        ...payloadOnce,
        cwd: dir,
        projectDir: "/tmp/project-dir",
        sessionId: "sess-stdin",
      }),
      getCwd: () => dir,
      getSize: () => ({ columns: 120, rows: 30 }),
      getShellConfig: () => ({ cwd: dir } as Config),
    });
    ctl.start();
    await new Promise((r) => setTimeout(r, 250));
    expect(ctl.visibleRows(80).some((l) => l.includes("OK"))).toBe(true);
    const raw = readFileSync(out, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    const json = JSON.parse(lines[0]!);
    expect(json.session_id).toBe("sess-stdin");
    expect(json.workspace.project_dir).toBe("/tmp/project-dir");
    const env = readFileSync(envf, "utf8");
    expect(env).toContain("cols=120");
    expect(env).toContain("lines=30");
    expect(env).toContain("hook=");
    expect(env).not.toMatch(/hook=\S/);
    expect(resolve(env.match(/cwd=(\S+)/)?.[1] ?? "")).toBe(resolve(dir));
    ctl.dispose();
  });

  test("8KiB 截断后仍排空管道，进程能退出", async () => {
    expect(STATUSLINE_STDOUT_LIMIT).toBe(8192);
    const dir = sandbox("neo-57-8k-");
    const script = join(dir, "big.py");
    writeFileSync(
      script,
      "#!/usr/bin/env python3\nimport sys\nsys.stdout.buffer.write(b'A'*9000)\nsys.stdout.buffer.flush()\nsys.stdout.buffer.write(b'B'*4000)\nsys.stdout.buffer.flush()\n",
      { mode: 0o755 },
    );
    const ctl = createStatusLineController({
      getSettings: () => ({ command: script, padding: 0, refreshInterval: null, timeout: 5 }),
      buildPayload: () => buildStatusLinePayload({ ...payloadOnce, cwd: dir, projectDir: dir }),
      getCwd: () => dir,
      getSize: () => ({ columns: 80, rows: 24 }),
      getShellConfig: () => ({ cwd: dir } as Config),
    });
    const t0 = Date.now();
    ctl.start();
    await new Promise((r) => setTimeout(r, 800));
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(ctl.isRunning()).toBe(false);
    const rows = ctl.visibleRows(80);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.join("")).toContain("A");
    expect(rows.join("")).not.toContain("B");
    ctl.dispose();
  });

  test("终端宽度变化只按新宽度裁剪上次成功输出，不立刻重跑", async () => {
    const dir = sandbox("neo-57-resize-");
    const script = join(dir, "wide.sh");
    writeFileSync(script, "#!/bin/sh\necho ABCDEFGHIJKLMNOPQRSTUVWXYZ\n", { mode: 0o755 });
    const calls: Array<{ argv: string[] }> = [];
    const ctl = createStatusLineController({
      getSettings: () => ({ command: script, padding: 0, refreshInterval: null, timeout: 2 }),
      buildPayload: () => buildStatusLinePayload({ ...payloadOnce, cwd: dir, projectDir: dir }),
      getCwd: () => dir,
      getSize: () => ({ columns: 80, rows: 24 }),
      getShellConfig: () => ({ cwd: dir } as Config),
      spawnFn: countingSpawn(calls),
    });
    ctl.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.length).toBe(1);
    const wide = ctl.visibleRows(80).join("");
    expect(wide).toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    ctl.setSize(8, 24);
    const narrow = ctl.visibleRows(8).join("");
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(calls.length).toBe(1);
    ctl.dispose();
  });
});
