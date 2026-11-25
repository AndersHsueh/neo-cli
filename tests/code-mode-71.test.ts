/**
 * issue #71：实验性 Code Mode（`run_js`）—— 先红后绿。
 *
 * 锁定 Leo 拍板 8 点 + issue 评论绑定口径（基线 v0.4.94 / a7b237e）：
 *  1. 形态 A：新增第一方工具 `run_js`，与逐个 tool call 并存，不替换整张表。
 *  2. 只接 JavaScript；API 为 `await tools.read_file({ path })`，名字与注册名一致
 *     （含 `mcp__*`）。不模仿 Claude 的 `$` / `edit()`，不翻译 TypeScript。
 *  3. 本进程 AsyncFunction。只注入 `tools` 与 `console`，不把 ctx / Agent / 内部
 *     对象交给脚本。不要 ShadowRealm 或删冻宿主全局。
 *  4. 可见集 = 本轮 toolSpecsFor() + 已注册未装入的 mcp__*，去掉 run_js 自身；
 *     不暴露 task / compact_ctx / ask_user / submit_plan / exit_plan_mode。
 *     tool_search 若在清单里可调，走 #68 既有路径。
 *  5. 内部调用走既有 dispatch → gateTool，并补打 tool_start / tool_end。
 *     必须改 decidePermission，让 run_js 与 shell 同桶；只标 sensitive 不够。
 *  6. 回给模型的只有 return + console，再走 limitOutput。墙钟 10 分钟（含审批
 *     等待）；确认框等待中超时必须干净中止。内部次数上限对齐 max_tool_iterations。
 *     Promise.all 只对 isParallelizable 的工具真正并行。Ctrl+C 能中止。
 *  7. 默认关。NEO_EXPERIMENTAL_CODE_MODE=1 开启，=0 永远赢。settings 只在实际
 *     载入路径是 ~/.neo/settings.json 且 experimental.code_mode === true 时可以开。
 *     工作区 / 启动目录 / pkgRoot/settings.json 写了也不能开。不要为这个键改分层合并。
 *  8. 只开交互 TUI（enabled && !nonInteractive && !isSubagent && !planning）。
 *     -p（即使带 -y）、ACP、规划态、子代理、wiki worker 都不暴露。不改 src/acp/*。
 *
 * 开启后 /tools 与提示词「可用工具」行也要列 run_js，不要只改 CONDITIONAL_TOOL_NAMES。
 * 关闭时零行为差。
 *
 * —— 实现契约（本测试锁死，供 neo 对照）——
 *  - 工具名 `run_js`，参数对象含字符串字段 `code`（hook 可读 tool_input.code）。
 *  - Config 解析 settings 的 `experimental.code_mode` 为 `experimental.codeMode`，
 *    但开启判定还要看 `settingsPath` 是否等于 `join(homedir(), ".neo", "settings.json")`。
 *  - 墙钟默认 10 * 60 * 1000 ms。测试通过 cfg 上的非公开字段 `__codeModeTimeoutMs`
 *    把超时调短；不得把它做成模型可见参数。
 *  - `dispatch("run_js", …)` 的 output 必须能解析出一个 JSON 对象（允许前后有
 *    limitOutput 截断提示），字段：
 *      ok: boolean
 *      return?: 脚本 return 值的 JSON 可序列化形式
 *      console?: 捕获的 console 文本
 *      error?: 未捕获异常 / 语法错误 / 超时 / 中止的说明
 *      executed?: Array<{ name: string, ok: boolean, executed: boolean }>
 *  - 产品不做沙箱，不宣称与 Claude Code 兼容。
 *
 * 运行：bun test tests/code-mode-71.test.ts
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Agent, type AgentEvent, type AgentIO, type ToolEndEventData, type ToolStartEventData } from "../src/agent.ts";
import { decidePermission } from "../src/agent/policy.ts";
import { dispatchCommand, type CommandContext } from "../src/cli/commands.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { parseHooksConfig } from "../src/hooks/index.ts";
import type { StreamResult, ToolCall, ToolSpec } from "../src/llm.ts";
import { makeMcpTool } from "../src/mcp/tool.ts";
import { WIKI_WORKER_TOOLS } from "../src/memory/wikiMaintainer.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { Composer, type ComposerDeps, type ComposerStatus } from "../src/tui/composer.ts";
import {
  dispatch,
  isParallelizable,
  mainToolNames,
  registerTool,
} from "../src/tools/index.ts";
import type { ToolCtx, ToolImpl } from "../src/tools/types.ts";
import { captureConsole } from "./helpers.ts";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "neo-71-code-mode-"));
const made: string[] = [SANDBOX];
const unregisters: Array<() => void> = [];

const prevCodeModeEnv = process.env["NEO_EXPERIMENTAL_CODE_MODE"];
delete process.env["NEO_EXPERIMENTAL_CODE_MODE"];

afterAll(() => {
  if (prevCodeModeEnv === undefined) delete process.env["NEO_EXPERIMENTAL_CODE_MODE"];
  else process.env["NEO_EXPERIMENTAL_CODE_MODE"] = prevCodeModeEnv;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env["NEO_EXPERIMENTAL_CODE_MODE"];
  for (const un of unregisters.splice(0)) {
    try {
      un();
    } catch {
      /* already gone */
    }
  }
});

function tempDir(prefix = "neo-71-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** 串行化会改 process.env / cwd / pkgRoot/settings.json 的测试，避免互相踩踏。 */
let gate: Promise<void> = Promise.resolve();
async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  let release!: () => void;
  const prev = gate;
  gate = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function withEnv(updates: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  await withLock(async () => {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(updates)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
}

function silentIO(): AgentIO {
  return {
    line(): void {},
    blank(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    toolHeader(): void {},
    toolResult(): void {},
    indent(body: string, prefix = "│ "): string {
      return body.split("\n").map((l) => prefix + l).join("\n");
    },
    startSpinner(): void {},
    updateSpinner(): void {},
    stopSpinner(): void {},
    beginStream(): void {},
    writeStream(): void {},
    endStream(): void {},
    ensureStreamClosed(): void {},
    async confirm(): Promise<boolean> {
      return true;
    },
    width: 100,
  };
}

function baseCfg(over: Record<string, unknown> = {}): Config {
  const cwd = SANDBOX;
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [
      {
        name: "p1",
        type: "openai",
        baseUrl: "http://localhost:0",
        apiKey: "k",
        models: { default: "m-default", deep_reasoning: "m-deep", balanced: "m-bal", fast: "m-fast" },
        maxTokens: 100,
        temperature: 0.3,
        contextWindow: 100_000,
      },
    ],
    routes: {
      default: { provider: "p1", model: null, fallbackAllowed: true },
      deep_reasoning: { provider: "p1", model: null, fallbackAllowed: true },
      balanced: { provider: "p1", model: null, fallbackAllowed: true },
      fast: { provider: "p1", model: null, fallbackAllowed: true },
    },
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.9,
    maxToolIterations: 20,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    parallelToolCalls: "readonly",
    cwd,
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
    hooks: parseHooksConfig(undefined),
    env: { prompt: false },
    repoMap: { enabled: false },
    memory: {
      enabled: false,
      userLevelDir: join(cwd, "mem"),
      userWikiDir: join(cwd, "wiki"),
      journalDir: join(cwd, "journal"),
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false,
        mode: "off" as const,
        modelTier: "fast",
        maxOpsPerTurn: 2,
        maxPagesPerSession: 8,
        minConfidence: 0.65,
        minInferredConfidence: 0.75,
        journalRetentionDays: 7,
        flushTimeoutMs: 3000,
      },
      quiet: true,
    },
    mcpServers: [],
    ...over,
  } as unknown as Config;
}

function enabledCfg(over: Record<string, unknown> = {}): Config {
  return baseCfg({
    settingsPath: join(homedir(), ".neo", "settings.json"),
    experimental: { codeMode: true },
    ...over,
  });
}

function makeAgent(
  cfg: Config,
  over: Partial<ConstructorParameters<typeof Agent>[0]> = {},
): Agent {
  return new Agent({
    cfg,
    console: silentIO(),
    mode: "auto-all",
    systemPrompt: "sys",
    ...over,
  });
}

function namesOf(specs: ToolSpec[]): string[] {
  return specs.map((s) => s.function.name);
}

function availableLine(text: string): string {
  const line = text.split("\n").find((l) => l.startsWith("可用工具：")) ?? "";
  return line;
}

function hasCodeModeSection(text: string): boolean {
  return /Code Mode|run_js|tools\.read_file/i.test(text) &&
    (text.includes("run_js") && (/Code Mode/i.test(text) || text.includes("await tools.")));
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* continue */
    }
    return null;
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const mid = tryParse(trimmed.slice(start, end + 1));
    if (mid) return mid;
  }
  return null;
}

function parseRunJs(output: string): Record<string, unknown> {
  const obj = extractJsonObject(output);
  if (!obj) throw new Error(`run_js 输出无法解析为 JSON 对象：${output.slice(0, 500)}`);
  return obj;
}

function toolCtx(
  cfg: Config,
  over: Partial<ToolCtx> = {},
  approveLog: Array<{ tool: string; detail: string }> = [],
): ToolCtx {
  return {
    cfg,
    approve: async (tool, detail) => {
      approveLog.push({ tool, detail });
      return true;
    },
    ...over,
  };
}

function tc(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function scripted(rounds: Array<{ calls?: ToolCall[]; content?: string }>): NonNullable<
  ConstructorParameters<typeof Agent>[0]["chatStream"]
> {
  let i = 0;
  return async () => {
    const step = rounds[Math.min(i, rounds.length - 1)] ?? { content: "done" };
    i++;
    if (step.calls && step.calls.length > 0) {
      return {
        content: "",
        reasoning: "",
        toolCalls: step.calls,
        finishReason: "tool_calls",
        usage: null,
        raw: null,
      } as StreamResult;
    }
    return {
      content: step.content ?? "done",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
    } as StreamResult;
  };
}

function writeSettings(dir: string, extra: Record<string, unknown> = {}): string {
  const example = JSON.parse(readFileSync(join(PKG_ROOT, "settings.example.json"), "utf8")) as Record<string, unknown>;
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ ...example, ...extra }), "utf8");
  return path;
}

function cmdCtx(agent: Agent, ui: ReturnType<typeof captureConsole>["ui"]): CommandContext {
  return {
    agent,
    ui,
    cfg: agent.opt.cfg,
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "s71", model: "m", cwd: agent.opt.cfg.cwd } as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
  } as CommandContext;
}

function registerFakeMcp(server: string, remote: string, call: (args: Record<string, unknown>) => string): string {
  const impl = makeMcpTool({
    server,
    info: {
      name: remote,
      description: `fake ${server}/${remote}`,
      inputSchema: {
        type: "object",
        properties: { payload: { type: "string", description: `marker-${server}-${remote}`.repeat(8) } },
        required: ["payload"],
      },
    },
    call: async (_remote, args) => call(args),
  });
  unregisters.push(registerTool(impl));
  return impl.spec.function.name;
}

function registerProbe(name: string, opts: { parallelizable?: boolean; sensitive?: boolean; execute: ToolImpl["execute"] }): void {
  unregisters.push(
    registerTool({
      spec: {
        type: "function",
        function: { name, description: `probe ${name}`, parameters: { type: "object", properties: {} } },
      },
      sensitive: opts.sensitive ?? false,
      kind: "evidence",
      ...(opts.parallelizable ? { parallelizable: true } : {}),
      execute: opts.execute,
    }),
  );
}

async function runJs(cfg: Config, code: string, over: Partial<ToolCtx> = {}, approveLog?: Array<{ tool: string; detail: string }>) {
  const ctx = toolCtx(cfg, over, approveLog);
  return dispatch("run_js", JSON.stringify({ code }), ctx);
}


function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | undefined)?.name === "AbortError";
}

async function expectAborted(p: Promise<unknown>): Promise<void> {
  let settled: { ok: true; value: unknown } | { ok: false; error: unknown };
  try {
    settled = { ok: true, value: await p };
  } catch (error) {
    settled = { ok: false, error };
  }
  expect(settled.ok).toBe(false);
  if (!settled.ok) expect(isAbortError(settled.error)).toBe(true);
}

function makeComposer(): Composer {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream & {
    setRawMode: (v: boolean) => void;
    isRaw: boolean;
    isTTY: boolean;
  };
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  (stdin as unknown as { isRaw: boolean }).isRaw = false;
  const status: ComposerStatus = {
    version: "0.4.94",
    model: "deepseek-flash",
    tier: "balanced",
    mode: "ask",
    branch: "main",
    ctxUsage: 0.1,
    elapsedMs: 0,
    active: true,
    tokensTotal: 0,
  };
  const deps: ComposerDeps = {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: { write: () => {}, columns: 100, rows: 24 },
    columns: () => 100,
    rows: () => 24,
    getStatus: () => status,
    getTitle: () => "neo · test",
    commands: COMMANDS,
    files: () => [],
    onSubmit: () => {},
    onExit: () => {},
  };
  const composer = new Composer(deps);
  composer.start();
  return composer;
}

/* ------------------------------------------------------------------ */
/* 关闭时零行为差                                                      */
/* ------------------------------------------------------------------ */

describe("#71 默认关闭", () => {
  test("缺省 toolSpecsFor / mainToolNames / 提示词都没有 run_js，也没有 Code Mode 段", () => {
    const cfg = baseCfg();
    const agent = makeAgent(cfg);
    expect(namesOf(agent.toolSpecsFor())).not.toContain("run_js");
    expect(mainToolNames(cfg)).not.toContain("run_js");
    const text = buildSystemPrompt(cfg);
    expect(availableLine(text)).not.toContain("run_js");
    expect(text).not.toMatch(/Code Mode/i);
    expect(text).not.toContain("await tools.");
  });

  test("缺省 /tools 不列 run_js", async () => {
    const cap = captureConsole();
    const agent = makeAgent(baseCfg());
    await dispatchCommand("/tools", cmdCtx(agent, cap.ui));
    expect(cap.out()).not.toContain("run_js");
  });

  test("decidePermission 对既有工具的口径不变", () => {
    expect(decidePermission("auto-all", "shell")).toEqual({ allow: true });
    expect(decidePermission("auto-edit", "write_file")).toEqual({ allow: true });
    expect(decidePermission("auto-edit", "shell")).toEqual({ allow: false, reason: "needs-confirm" });
    expect(decidePermission("plan", "read_file")).toEqual({ allow: false, reason: "plan" });
    expect(decidePermission("ask", "read_file")).toEqual({ allow: false, reason: "needs-confirm" });
  });
});

/* ------------------------------------------------------------------ */
/* 权限：必须与 shell 同桶                                              */
/* ------------------------------------------------------------------ */

describe("#71 decidePermission 与 shell 同桶", () => {
  test("ask / auto-edit 要确认，auto-all 放行，plan 拒绝", () => {
    expect(decidePermission("ask", "run_js")).toEqual({ allow: false, reason: "needs-confirm" });
    expect(decidePermission("auto-edit", "run_js")).toEqual({ allow: false, reason: "needs-confirm" });
    expect(decidePermission("auto-all", "run_js")).toEqual({ allow: true });
    expect(decidePermission("plan", "run_js")).toEqual({ allow: false, reason: "plan" });
  });

  test("对照：只标 sensitive 而不改 policy 时 auto-edit 会放行；实现必须改 policy", () => {
    // 锁住「auto-edit 对 run_js 不自动放行」。若只把工具标成 sensitive，
    // 旧 decidePermission 会因为「不是 shell、不是 mcp__」而 allow:true。
    const autoEditRunJs = decidePermission("auto-edit", "run_js");
    const autoEditShell = decidePermission("auto-edit", "shell");
    expect(autoEditRunJs).toEqual(autoEditShell);
    expect(autoEditRunJs).toEqual({ allow: false, reason: "needs-confirm" });
  });
});

/* ------------------------------------------------------------------ */
/* 开关：环境变量与 settings 硬测                                       */
/* ------------------------------------------------------------------ */

describe("#71 开关", () => {
  test("NEO_EXPERIMENTAL_CODE_MODE=1 在交互、非 plan、非子代理下进入清单", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      const agent = makeAgent(baseCfg());
      expect(namesOf(agent.toolSpecsFor())).toContain("run_js");
    });
  });

  test("NEO_EXPERIMENTAL_CODE_MODE=0 覆盖用户 settings 的 true，强制关", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "0" }, () => {
      const agent = makeAgent(enabledCfg());
      expect(namesOf(agent.toolSpecsFor())).not.toContain("run_js");
    });
  });

  test("仅当 settingsPath 是 ~/.neo/settings.json 且 experimental.codeMode === true 才开", () => {
    const on = makeAgent(enabledCfg());
    expect(namesOf(on.toolSpecsFor())).toContain("run_js");

    const wrongPath = makeAgent(
      baseCfg({
        settingsPath: join(SANDBOX, "settings.json"),
        experimental: { codeMode: true },
      }),
    );
    expect(namesOf(wrongPath.toolSpecsFor())).not.toContain("run_js");

    const userPathNoFlag = makeAgent(
      baseCfg({
        settingsPath: join(homedir(), ".neo", "settings.json"),
        experimental: { codeMode: false },
      }),
    );
    expect(namesOf(userPathNoFlag.toolSpecsFor())).not.toContain("run_js");
  });

  test("loadConfig：工作区 ./settings.json 写了 experimental.code_mode 也不能开", async () => {
    await withLock(async () => {
      const dir = tempDir("neo-71-ws-");
      writeSettings(dir, { experimental: { code_mode: true } });
      const cfg = loadConfig({}, { settingsDir: dir });
      expect(resolve(cfg.settingsPath ?? "")).toBe(resolve(join(dir, "settings.json")));
      expect(namesOf(makeAgent(cfg).toolSpecsFor())).not.toContain("run_js");
    });
  });

  test("loadConfig：启动目录 settings.json 写了也不能开", async () => {
    await withLock(async () => {
      const spawn = tempDir("neo-71-spawn-");
      const here = tempDir("neo-71-here-");
      writeSettings(spawn, { experimental: { code_mode: true } });
      const prev = process.cwd();
      try {
        process.chdir(spawn);
        const cfg = loadConfig({}, { settingsDir: here });
        expect(resolve(cfg.settingsPath ?? "")).toBe(resolve(join(spawn, "settings.json")));
        expect(namesOf(makeAgent(cfg).toolSpecsFor())).not.toContain("run_js");
      } finally {
        process.chdir(prev);
      }
    });
  });

  test("loadConfig：pkgRoot/settings.json 写了也不能开（且不改分层合并）", async () => {
    await withLock(async () => {
      const pkgSettings = join(PKG_ROOT, "settings.json");
      expect(existsSync(pkgSettings)).toBe(false);
      const constructed = makeAgent(
        baseCfg({
          settingsPath: pkgSettings,
          experimental: { codeMode: true },
        }),
      );
      expect(namesOf(constructed.toolSpecsFor())).not.toContain("run_js");

      writeFileSync(pkgSettings, JSON.stringify({
        ...JSON.parse(readFileSync(join(PKG_ROOT, "settings.example.json"), "utf8")),
        experimental: { code_mode: true },
        _neo71_probe: "pkg-root-should-not-enable",
      }), "utf8");
      const prevCwd = process.cwd();
      const empty = tempDir("neo-71-empty-");
      try {
        process.chdir(empty);
        const cfg = loadConfig({}, { settingsDir: empty });
        expect(resolve(cfg.settingsPath ?? "")).toBe(resolve(pkgSettings));
        expect(namesOf(makeAgent(cfg).toolSpecsFor())).not.toContain("run_js");
      } finally {
        process.chdir(prevCwd);
        rmSync(pkgSettings, { force: true });
      }
      expect(existsSync(pkgSettings)).toBe(false);
    });
  });

  test("loadConfig：实际载入 ~/.neo/settings.json 且 experimental.code_mode === true 可以开", async () => {
    await withEnv({}, async () => {
      const fakeHome = tempDir("neo-71-home-");
      const empty = tempDir("neo-71-home-cwd-");
      mkdirSync(join(fakeHome, ".neo"), { recursive: true });
      const userPath = join(fakeHome, ".neo", "settings.json");
      writeFileSync(
        userPath,
        JSON.stringify({
          ...JSON.parse(readFileSync(join(PKG_ROOT, "settings.example.json"), "utf8")),
          experimental: { code_mode: true },
        }),
        "utf8",
      );
      const prevHome = process.env["HOME"];
      const prevCwd = process.cwd();
      try {
        process.env["HOME"] = fakeHome;
        process.chdir(empty);
        const cfg = loadConfig({}, { settingsDir: empty });
        expect(resolve(cfg.settingsPath ?? "")).toBe(resolve(userPath));
        expect(namesOf(makeAgent(cfg).toolSpecsFor())).toContain("run_js");
      } finally {
        process.chdir(prevCwd);
        if (prevHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = prevHome;
      }
    });
  });
});

/* ------------------------------------------------------------------ */
/* 入口：只开交互 TUI                                                  */
/* ------------------------------------------------------------------ */

describe("#71 只开交互 TUI", () => {
  test("开启后 toolSpecsFor 有 run_js，且不替换其它工具", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      const off = namesOf(makeAgent(baseCfg()).toolSpecsFor()).filter((n) => n !== "run_js");
      const on = namesOf(makeAgent(baseCfg()).toolSpecsFor());
      expect(on).toContain("run_js");
      expect(on).toContain("read_file");
      expect(on).toContain("shell");
      for (const n of off) expect(on).toContain(n);
    });
  });

  test("开启后 /tools 与提示词「可用工具」行列出 run_js，并出现用法段", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      // 窗口来源缺省是不可信的，预算落到 unknownWindowBudget，#104 会收窄工具行。
      // 这里要验的是 Code Mode 打开时的正常会话，给一个可信的 100k 窗口。
      const cfg = baseCfg({ contextWindowSource: "config" });
      const agent = makeAgent(cfg);
      const cap = captureConsole();
      await dispatchCommand("/tools", cmdCtx(agent, cap.ui));
      expect(cap.out()).toContain("run_js");
      // 不要只改 CONDITIONAL_TOOL_NAMES：否则 mainToolNames 会把 run_js 滤掉，
      // /tools 与提示词都看不见。
      const text = buildSystemPrompt(cfg, { mailbox: false, askUser: false });
      expect(availableLine(text)).toContain("run_js");
      expect(hasCodeModeSection(text)).toBe(true);
      // 交互 TUI bootstrap 显式传入 nonInteractive: false；缺省改为 fail-closed。
      const pm = new PromptManager({ nonInteractive: false });
      expect(availableLine(pm.render(cfg).text)).toContain("run_js");
      expect(hasCodeModeSection(pm.render(cfg).text)).toBe(true);
    });
  });

  test("开启后 PromptManager 缺省 / 省略 nonInteractive 为 fail-closed：不列 run_js，也没有用法段", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      const cfg = baseCfg();
      const omitted = new PromptManager();
      expect(availableLine(omitted.render(cfg).text)).not.toContain("run_js");
      expect(hasCodeModeSection(omitted.render(cfg).text)).toBe(false);
      const partial = new PromptManager({ mailbox: false, askUser: false });
      expect(availableLine(partial.render(cfg).text)).not.toContain("run_js");
      expect(hasCodeModeSection(partial.render(cfg).text)).toBe(false);
    });
  });

  test("nonInteractive（-p，即使相当于 -y / auto-all）不暴露", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      const agent = makeAgent(baseCfg(), { nonInteractive: true, mode: "auto-all" });
      expect(namesOf(agent.toolSpecsFor())).not.toContain("run_js");
      const text = buildSystemPrompt(baseCfg(), { nonInteractive: true } as never);
      expect(availableLine(text)).not.toContain("run_js");
    });
  });

  test("规划态不暴露", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      const agent = makeAgent(baseCfg(), { planBaseMode: "ask" });
      agent.enterPlan("ask");
      expect(agent.planning).toBe(true);
      expect(namesOf(agent.toolSpecsFor())).not.toContain("run_js");
    });
  });

  test("关闭时规划态 /tools 不列 run_js（不得走全量 toolNames 把 run_js 漏出来）", async () => {
    const agent = makeAgent(baseCfg(), { planBaseMode: "ask" });
    agent.enterPlan("ask");
    expect(agent.planning).toBe(true);
    const cap = captureConsole();
    await dispatchCommand("/tools", cmdCtx(agent, cap.ui));
    expect(cap.out()).not.toContain("run_js");
  });

  test("开启后规划态 /tools 与 toolSpecsFor 都不列 run_js", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const agent = makeAgent(baseCfg(), { planBaseMode: "ask" });
      agent.enterPlan("ask");
      expect(agent.planning).toBe(true);
      expect(namesOf(agent.toolSpecsFor())).not.toContain("run_js");
      const cap = captureConsole();
      await dispatchCommand("/tools", cmdCtx(agent, cap.ui));
      expect(cap.out()).not.toContain("run_js");
    });
  });

  test("子代理不暴露", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      const agent = makeAgent(baseCfg(), { isSubagent: true });
      expect(namesOf(agent.toolSpecsFor())).not.toContain("run_js");
    });
  });

  test("wiki worker 白名单不含 run_js；即使 env=1 加 allowlist 也不暴露", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      expect(WIKI_WORKER_TOOLS).not.toContain("run_js");
      const agent = makeAgent(baseCfg(), { toolAllowlist: WIKI_WORKER_TOOLS });
      expect(namesOf(agent.toolSpecsFor())).not.toContain("run_js");
    });
  });

  test("ACP 已 nonInteractive:true，共享 toolSpecsFor 入口条件即可排除（不改 src/acp/*）", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      // 与 src/acp/session.ts 相同：new Agent({ nonInteractive: true })
      const agent = makeAgent(baseCfg(), { nonInteractive: true });
      expect(namesOf(agent.toolSpecsFor())).not.toContain("run_js");
    });
  });
});

/* ------------------------------------------------------------------ */
/* 脚本 API 与执行                                                     */
/* ------------------------------------------------------------------ */

describe("#71 脚本 API 与执行", () => {
  test("await tools.read_file({ path }) 可用；内部走 dispatch/gateTool；run_js 自身先按 shell 口径审批", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const dir = tempDir("neo-71-read-");
      const file = join(dir, "hello.txt");
      writeFileSync(file, "hello-71", "utf8");
      const cfg = enabledCfg({ cwd: dir });
      const approveLog: Array<{ tool: string; detail: string }> = [];
      const hookLog: string[] = [];
      const res = await runJs(
        cfg,
        `const text = await tools.read_file({ path: ${JSON.stringify(file)} });
         return text;`,
        {
          preToolUse: async (tool) => {
            hookLog.push(`pre:${tool}`);
            return null;
          },
        },
        approveLog,
      );
      expect(res.executed).not.toBe(false);
      const payload = parseRunJs(res.output);
      expect(payload["ok"]).toBe(true);
      expect(String(payload["return"])).toContain("hello-71");
      expect(approveLog.some((a) => a.tool === "run_js" && a.detail.includes("tools.read_file"))).toBe(true);
      expect(hookLog).toContain("pre:read_file");
    });
  });

  test("只注入 tools 与 console；脚本里没有被注入的 ctx / Agent / host", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const res = await runJs(
        enabledCfg(),
        `return {
           typeof_tools: typeof tools,
           typeof_console: typeof console,
           typeof_ctx: typeof ctx,
           typeof_agent: typeof agent,
           typeof_host: typeof host,
         };`,
      );
      const payload = parseRunJs(res.output);
      expect(payload["ok"]).toBe(true);
      const ret = payload["return"] as Record<string, string>;
      expect(ret["typeof_tools"]).toBe("object");
      expect(ret["typeof_console"]).toBe("object");
      expect(ret["typeof_ctx"]).toBe("undefined");
      expect(ret["typeof_agent"]).toBe("undefined");
      expect(ret["typeof_host"]).toBe("undefined");
    });
  });

  test("回填只有 return + console，走 limitOutput；内部输出默认不进模型上下文", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const dir = tempDir("neo-71-io-");
      const marker = `SECRET_MARKER_71_${"X".repeat(40)}`;
      const file = join(dir, "secret.txt");
      writeFileSync(file, marker, "utf8");
      const cfg = enabledCfg({ cwd: dir, toolOutputLimit: 400 });
      const res = await runJs(
        cfg,
        `const hidden = await tools.read_file({ path: ${JSON.stringify(file)} });
         console.log("visible-log");
         return "ret-" + "Y".repeat(800);`,
      );
      expect(res.output).toContain("visible-log");
      expect(res.output).toContain("ret-");
      expect(res.output).not.toContain(marker);
      expect(res.truncated || res.output.includes("tool_output_limit")).toBe(true);
    });
  });

  test("未捕获异常：ok:false + 已执行摘要，先发生的副作用不回滚", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const dir = tempDir("neo-71-exc-");
      const file = join(dir, "side.txt");
      const cfg = enabledCfg({ cwd: dir });
      const res = await runJs(
        cfg,
        `await tools.write_file({ path: ${JSON.stringify(file)}, content: "written-before-throw" });
         throw new Error("boom-71");`,
      );
      const payload = parseRunJs(res.output);
      expect(payload["ok"]).toBe(false);
      expect(String(payload["error"] ?? "")).toContain("boom-71");
      const executed = payload["executed"] as Array<{ name: string; ok: boolean; executed: boolean }>;
      expect(Array.isArray(executed)).toBe(true);
      const write = executed.find((c) => c.name === "write_file");
      expect(write).toBeDefined();
      expect(write!.ok).toBe(true);
      expect(write!.executed).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("written-before-throw");
    });
  });

  test("非法 JS 与 TypeScript 语法明确失败，不翻译 TS", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const bad = await runJs(enabledCfg(), "const = ;");
      const badPayload = parseRunJs(bad.output);
      expect(badPayload["ok"]).toBe(false);
      expect(String(badPayload["error"] ?? bad.output).length).toBeGreaterThan(0);

      const ts = await runJs(enabledCfg(), "const x: number = 1; return x;");
      const tsPayload = parseRunJs(ts.output);
      expect(tsPayload["ok"]).toBe(false);
      expect(String(tsPayload["error"] ?? ts.output)).toMatch(/Unexpected|Syntax|TypeScript|类型|语法/i);
    });
  });

  test("禁止调用 run_js 自身；排除名单不可见且调用失败", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const vis = await runJs(
        enabledCfg(),
        `return {
           run_js: typeof tools.run_js,
           task: typeof tools.task,
           compact_ctx: typeof tools.compact_ctx,
           ask_user: typeof tools.ask_user,
           submit_plan: typeof tools.submit_plan,
           exit_plan_mode: typeof tools.exit_plan_mode,
         };`,
      );
      const types = (parseRunJs(vis.output)["return"] ?? {}) as Record<string, string>;
      expect(types["run_js"]).toBe("undefined");
      expect(types["task"]).toBe("undefined");
      expect(types["compact_ctx"]).toBe("undefined");
      expect(types["ask_user"]).toBe("undefined");
      expect(types["submit_plan"]).toBe("undefined");
      expect(types["exit_plan_mode"]).toBe("undefined");

      const rec = await runJs(enabledCfg(), `return await tools.run_js({ code: "return 1" });`);
      expect(parseRunJs(rec.output)["ok"]).toBe(false);
    });
  });

  test("未装入已注册的 mcp__* 从脚本点名调用，走 #68 既有路径并装入", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const name = registerFakeMcp("cm71", "echo", (args) => `echoed:${String(args["payload"] ?? "")}`);
      const cfg = enabledCfg({
        mcpServers: [
          { name: "cm71", transport: "stdio", command: "true", args: [], env: {}, enabled: true, alwaysLoad: false },
        ],
        mcp: { toolSearch: true, toolSearchThreshold: 1 },
      });
      const agent = makeAgent(cfg);
      expect(namesOf(agent.toolSpecsFor())).not.toContain(name);
      const res = await dispatch(
        "run_js",
        JSON.stringify({
          code: `return await tools[${JSON.stringify(name)}]({ payload: "from-script" });`,
        }),
        { ...toolCtx(cfg), host: agent },
      );
      const payload = parseRunJs(res.output);
      expect(payload["ok"]).toBe(true);
      expect(String(payload["return"])).toContain("echoed:from-script");
      expect(namesOf(agent.toolSpecsFor())).toContain(name);
    });
  });
});

/* ------------------------------------------------------------------ */
/* 超时、次数上限、并行、事件、中止                                    */
/* ------------------------------------------------------------------ */

describe("#71 超时 / 上限 / 并行 / 事件 / Ctrl+C", () => {
  test("确认框等待中超时必须干净中止，不留下卡住的确认框", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const ac = new AbortController();
      let confirmOpen = false;
      let confirmSettled = false;
      const cfg = enabledCfg({ __codeModeTimeoutMs: 80 });
      const ctx: ToolCtx = {
        cfg,
        signal: ac.signal,
        approve: (tool) =>
          new Promise<boolean>((resolve) => {
            if (tool !== "run_js") {
              resolve(true);
              return;
            }
            confirmOpen = true;
            const settle = () => {
              if (confirmSettled) return;
              confirmSettled = true;
              confirmOpen = false;
              resolve(false);
            };
            ac.signal.addEventListener("abort", settle);
            cfg; // keep
            // 若实现超时后能中止共享 AbortSignal 或否则 settle 确认框，才算干净。
            const extra = (ctx.signal ?? ac.signal);
            extra.addEventListener("abort", settle);
          }),
      };
      const started = Date.now();
      // 与 execute 共用同一个 ctx 对象：超时会把 ctx.signal 换成墙钟信号，
      // 上面 approve 里监听的 ctx.signal 才能被干净 settle。
      const res = await dispatch("run_js", JSON.stringify({ code: "return 1;" }), ctx);
      expect(Date.now() - started).toBeLessThan(5_000);
      const payload = parseRunJs(res.output);
      expect(payload["ok"]).toBe(false);
      expect(String(payload["error"] ?? res.output)).toMatch(/超时|timeout|Abort/i);
      expect(confirmOpen).toBe(false);
      expect(confirmSettled).toBe(true);
    });
  });

  test("内部调用次数上限对齐 max_tool_iterations", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      let calls = 0;
      registerProbe("cm71_count", {
        parallelizable: true,
        execute: async () => {
          calls += 1;
          return `n=${calls}`;
        },
      });
      const cfg = enabledCfg({ maxToolIterations: 3 });
      const res = await runJs(
        cfg,
        `const out = [];
         for (let i = 0; i < 10; i++) out.push(await tools.cm71_count({}));
         return out;`,
      );
      const payload = parseRunJs(res.output);
      expect(payload["ok"]).toBe(false);
      expect(calls).toBe(3);
      expect(String(payload["error"] ?? res.output)).toMatch(/max_tool_iterations|上限|iteration/i);
    });
  });

  test("Promise.all：parallelizable 可并行；非 parallelizable / 需审批的串行", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const events: string[] = [];
      let releaseA!: () => void;
      const heldA = new Promise<void>((r) => {
        releaseA = r;
      });
      let bStartedWhileAHeld = false;
      registerProbe("cm71_par_a", {
        parallelizable: true,
        execute: async () => {
          events.push("+a");
          await heldA;
          events.push("-a");
          return "a";
        },
      });
      registerProbe("cm71_par_b", {
        parallelizable: true,
        execute: async () => {
          events.push("+b");
          events.push("-b");
          return "b";
        },
      });
      registerProbe("cm71_ser", {
        parallelizable: false,
        sensitive: true,
        execute: async () => {
          events.push("+s");
          events.push("-s");
          return "s";
        },
      });

      const cfg = enabledCfg();
      // 并行：b 应在 a 仍挂起时就能启动。
      const parP = runJs(
        cfg,
        `return await Promise.all([tools.cm71_par_a({}), tools.cm71_par_b({})]);`,
      );
      const waitUntil = Date.now() + 2_000;
      while (!events.includes("+b") && Date.now() < waitUntil) {
        await Bun.sleep(10);
      }
      expect(events).toContain("+a");
      expect(events).toContain("+b");
      releaseA();
      const par = await parP;
      expect(parseRunJs(par.output)["ok"]).toBe(true);

      events.length = 0;
      let releaseS!: () => void;
      const heldS = new Promise<void>((r) => {
        releaseS = r;
      });
      // 重新挂上 ser：开始后卡住，并行伙伴不得在此时启动。
      unregisters.pop()?.();
      registerProbe("cm71_ser", {
        parallelizable: false,
        sensitive: true,
        execute: async () => {
          events.push("+s");
          await heldS;
          events.push("-s");
          return "s";
        },
      });
      registerProbe("cm71_par_c", {
        parallelizable: true,
        execute: async () => {
          if (events.includes("+s") && !events.includes("-s")) bStartedWhileAHeld = true;
          events.push("+c");
          events.push("-c");
          return "c";
        },
      });
      const serP = runJs(
        cfg,
        `return await Promise.all([tools.cm71_ser({}), tools.cm71_par_c({})]);`,
      );
      const wait2 = Date.now() + 2_000;
      while (!events.includes("+s") && Date.now() < wait2) await Bun.sleep(10);
      await Bun.sleep(40);
      expect(events.includes("+c")).toBe(false);
      expect(bStartedWhileAHeld).toBe(false);
      releaseS();
      const ser = await serP;
      expect(parseRunJs(ser.output)["ok"]).toBe(true);
      expect(events.indexOf("+s")).toBeLessThan(events.indexOf("+c"));
    });
  });

  test("内部调用补打 tool_start / tool_end", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const dir = tempDir("neo-71-ev-");
      const file = join(dir, "e.txt");
      writeFileSync(file, "event-71", "utf8");
      const events: AgentEvent[] = [];
      const cfg = enabledCfg({ cwd: dir });
      const agent = makeAgent(cfg, {
        chatStream: scripted([
          {
            calls: [
              tc("c-run", "run_js", {
                code: `return await tools.read_file({ path: ${JSON.stringify(file)} });`,
              }),
            ],
          },
          { content: "done" },
        ]),
        onEvent: (e) => events.push(e),
      });
      await agent.send("run");
      const starts = events.filter((e) => e.type === "tool_start").map((e) => (e.data as ToolStartEventData).name);
      const ends = events.filter((e) => e.type === "tool_end").map((e) => (e.data as ToolEndEventData).name);
      expect(starts).toContain("run_js");
      expect(starts).toContain("read_file");
      expect(ends).toContain("run_js");
      expect(ends).toContain("read_file");
      const innerEnd = events.find((e) => e.type === "tool_end" && (e.data as ToolEndEventData).name === "read_file");
      expect(innerEnd).toBeDefined();
      expect((innerEnd!.data as ToolEndEventData).ok).toBe(true);
    });
  });

  test("Ctrl+C（AbortSignal）能中止脚本", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, async () => {
      const ac = new AbortController();
      const cfg = enabledCfg();
      const p = runJs(cfg, "await new Promise(() => {});", { signal: ac.signal });
      await Bun.sleep(30);
      ac.abort();
      const res = await p;
      const payload = parseRunJs(res.output);
      expect(payload["ok"]).toBe(false);
      expect(String(payload["error"] ?? res.output)).toMatch(/Abort|取消|中止|Ctrl/i);
    });
  });

  test("run_js 本身不可并行", async () => {
    await withEnv({ NEO_EXPERIMENTAL_CODE_MODE: "1" }, () => {
      expect(isParallelizable("run_js")).toBe(false);
    });
  });
});


/* ------------------------------------------------------------------ */
/* P2：生产 Console.confirm 必须响应 AbortSignal                         */
/* ------------------------------------------------------------------ */

describe("#71 P2 production Console.confirm 响应 AbortSignal", () => {
  test("无 signal 时用户 Yes/No 行为不变", async () => {
    const cap = captureConsole({ stdinIsTTY: true });
    cap.ui.setAsker(async () => "y");
    expect(await cap.ui.confirm("允许执行？")).toBe(true);
    cap.ui.setAsker(async () => "n");
    expect(await cap.ui.confirm("允许执行？")).toBe(false);
  });

  test("signal 保持开放时用户 Yes/No 仍有效", async () => {
    const ac = new AbortController();
    const cap = captureConsole({ stdinIsTTY: true });
    cap.ui.setAsker(async () => "yes");
    expect(await cap.ui.confirm("允许执行？", ac.signal)).toBe(true);
    cap.ui.setAsker(async () => "N");
    expect(await cap.ui.confirm("允许执行？", ac.signal)).toBe(false);
  });

  test("已中止的 signal 不调用 asker，并以 abort 语义结束（不是用户说 No）", async () => {
    const ac = new AbortController();
    ac.abort();
    const cap = captureConsole({ stdinIsTTY: true });
    let called = 0;
    cap.ui.setAsker(async () => {
      called += 1;
      return "y";
    });
    await expectAborted(cap.ui.confirm("允许执行？", ac.signal));
    expect(called).toBe(0);
  });

  test("等待中 signal 中止时 confirm 以 abort 语义结束并释放 asker，不是当作用户说 No", async () => {
    const ac = new AbortController();
    const cap = captureConsole({ stdinIsTTY: true });
    let asked = false;
    let lateResolve: ((v: string) => void) | undefined;
    cap.ui.setAsker(() => {
      asked = true;
      return new Promise<string>((resolve) => {
        lateResolve = resolve;
      });
    });
    const p = cap.ui.confirm("允许执行？", ac.signal);
    for (let i = 0; i < 40 && !asked; i++) await new Promise((r) => setTimeout(r, 5));
    expect(asked).toBe(true);
    ac.abort();
    await expectAborted(p);
    lateResolve?.("y");
    await Promise.resolve();
  }, 2000);

  test("makeCtx 把 signal 传给 ui.confirm；中止时生产确认框以 abort 语义结束", async () => {
    const ac = new AbortController();
    const cap = captureConsole({ stdinIsTTY: true });
    let asked = false;
    cap.ui.setAsker(() => {
      asked = true;
      return new Promise<string>(() => {});
    });
    const agent = makeAgent(baseCfg(), { console: cap.ui, mode: "ask" });
    const p = agent.makeCtx(ac.signal).approve("run_js", "return 1;");
    for (let i = 0; i < 40 && !asked; i++) await new Promise((r) => setTimeout(r, 5));
    expect(asked).toBe(true);
    ac.abort();
    await expectAborted(p);
  }, 2000);

  test("生产 TUI ask 模态：confirm 等待中 abort 必须关掉 [y/N]、askState 不残留", async () => {
    const composer = makeComposer();
    try {
      const cap = captureConsole({ stdinIsTTY: true });
      cap.ui.setAsker((q, signal) => composer.ask(q, signal));
      const ac = new AbortController();
      const p = cap.ui.confirm("允许执行？", ac.signal);
      for (let i = 0; i < 40 && composer.mode !== "ask"; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(composer.mode).toBe("ask");
      expect(composer.askState).not.toBeNull();
      ac.abort();
      await expectAborted(p);
      expect(composer.mode).toBe("normal");
      expect(composer.askState).toBeNull();
    } finally {
      composer.stop();
    }
  }, 2000);
});

/* ------------------------------------------------------------------ */
/* 文档：残余风险必须写明                                              */
/* ------------------------------------------------------------------ */

describe("#71 文档", () => {
  test("用户可见文档写明残余风险、默认关闭、开关、只限交互 TUI、与 Claude 不兼容，且不把沙箱列为待办", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    const extraFiles = ["docs/code-mode.md", "docs/code_mode.md", "docs/experimental-code-mode.md"];
    let extra = "";
    for (const f of extraFiles) {
      const p = join(PKG_ROOT, f);
      if (existsSync(p)) extra += "\n" + readFileSync(p, "utf8");
    }
    const text = `${readme}\n${extra}`;
    expect(text).toMatch(/process\.env/);
    expect(text).toMatch(/密钥|API key|secret/i);
    expect(text).toMatch(/绕过|宿主 API|host API/i);
    expect(text).toMatch(/NEO_EXPERIMENTAL_CODE_MODE/);
    expect(text).toMatch(/默认关|默认关闭|默认不启用/);
    expect(text).toMatch(/交互 TUI|交互式 TUI|-p/);
    expect(text).toMatch(/Claude/);
    expect(text).toMatch(/不兼容|并不兼容|没有兼容|并非兼容/);
    expect(text).not.toMatch(/待办[^\n]{0,40}沙箱|沙箱[^\n]{0,40}待办|TODO[^\n]{0,40}sandbox/i);
  });
});
