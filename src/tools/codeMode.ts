/**
 * 实验性 Code Mode（issue #71）：`run_js` 工具 —— 让模型写一段 JavaScript，
 * 在一次模型往返里完成多次工具调用。
 *
 * 形态 A：与逐个 tool call **并存**，不替换整张工具表。默认关闭。
 *
 * 硬约束（与 issue 绑定口径一致）：
 *  - 只接 JavaScript。TS 语法不翻译，直接语法错误。
 *  - 本进程 `AsyncFunction`，只注入 `tools` 与 `console`；**不做沙箱**
 *    （不删/不冻 process / Bun / globalThis，不用 ShadowRealm）。
 *  - 脚本里的每次工具调用都走既有 `dispatch` → `gateTool`（审批 + Pre/Post hooks），
 *    并补打 `tool_start` / `tool_end`（形状与顶层事件一致）。
 *  - `run_js` 自身在 `decidePermission` 里与 `shell` 同桶（见 agent/policy.ts）。
 *  - 回给模型的只有 return 值 + 捕获的 console，再走 `limitOutput`。
 *  - 墙钟默认 10 分钟（含审批等待）；确认框等待中超时也必须干净收尾。
 *  - 内部调用次数上限对齐 `cfg.maxToolIterations`。
 *  - `Promise.all` 只对 `isParallelizable === true` 的工具真正并行，其余串行。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { ToolSpec } from "../llm.ts";
import { dispatch, isParallelizable, toolNames, toolSpecs } from "./index.ts";
import type { ToolCtx, ToolImpl } from "./types.ts";
import { ToolError, gateTool, notExecuted } from "./types.ts";

export const CODE_MODE_TOOL_NAME = "run_js";

/** 墙钟默认值：10 分钟（含审批等待）。 */
export const CODE_MODE_TIMEOUT_MS = 10 * 60 * 1000;

/** 被墙钟超时 abort 的信号。runScript 用它区分超时与 Ctrl+C。 */
const timedOutSignals = new WeakSet<AbortSignal>();


/** 开关环境变量。`=0` 在任何情况下都赢。 */
export const CODE_MODE_ENV = "NEO_EXPERIMENTAL_CODE_MODE";

/**
 * 脚本里**不可见**的工具（即使主清单里有）。
 *
 *  - run_js：禁止递归（脚本里再跑脚本会把审批、超时、次数上限全部套娃）。
 *  - task / compact_ctx / ask_user / submit_plan / exit_plan_mode：派生、压缩宿主、
 *    TUI 提问与规划控制套在脚本里，审批与生命周期都说不清（P1 不做）。
 */
export const CODE_MODE_EXCLUDED_TOOLS: readonly string[] = [
  CODE_MODE_TOOL_NAME,
  "task",
  "compact_ctx",
  "ask_user",
  "submit_plan",
  "exit_plan_mode",
];

/**
 * 用户级 settings 的规范路径。只有**实际载入的是这份文件**时，
 * `experimental.code_mode: true` 才可能打开开关。
 *
 * 为什么不能只看 settings 里的布尔：`loadConfig` 对 settings 是「候选路径里第一份
 * 存在的文件全赢」，工作区 `./settings.json` 排在用户级之前 —— 克隆来的仓库
 * 写一个 true 就能打开实验开关。所以判定必须同时看**实际载入路径**。
 */
export function userSettingsPath(): string {
  return join(process.env["HOME"] || process.env["USERPROFILE"] || homedir(), ".neo", "settings.json");
}

/**
 * 开关是否打开（只看开关本身，不看入口）。
 *
 * 优先级：`NEO_EXPERIMENTAL_CODE_MODE=0` 强制关 > `=1` 强制开 >
 * 用户级 settings 的 `experimental.code_mode === true`。
 */
export function codeModeEnabled(cfg: Config): boolean {
  const env = (process.env[CODE_MODE_ENV] ?? "").trim();
  if (env === "0") return false;
  if (env === "1") return true;
  if (cfg.experimental?.codeMode !== true) return false;
  const loaded = cfg.settingsPath;
  if (loaded === null || loaded === undefined || loaded === "") return false;
  return resolve(loaded) === resolve(userSettingsPath());
}

/**
 * 本轮是否**暴露** `run_js`：开关打开 + 只开交互 TUI。
 *
 * `-p`（即使带 `-y`）、ACP、规划态、子代理、wiki worker（allowlist）都不暴露。
 * `nonInteractive` 由宿主显式给（提示词侧）；Agent 侧用 `agent.nonInteractive`。
 */
export function codeModeExposed(
  cfg: Config,
  opts: { nonInteractive: boolean; isSubagent: boolean; planning: boolean },
): boolean {
  if (!codeModeEnabled(cfg)) return false;
  if (opts.nonInteractive) return false;
  if (opts.isSubagent) return false;
  if (opts.planning) return false;
  return true;
}

/** 提示词 / `/tools` 用的「Code Mode 已开启」判据（交互 TUI 口径）。 */
export function codeModeVisibleForPrompt(cfg: Config, nonInteractive: boolean): boolean {
  return codeModeExposed(cfg, { nonInteractive, isSubagent: false, planning: false });
}

/** 脚本可调用的工具名（含已注册未装入的 mcp__*）：供提示词/测试检视。 */
export function codeModeScriptToolNames(cfg: Config): string[] {
  return scriptToolNames(cfg, toolSpecs(cfg).map((s) => s.function.name));
}

/**
 * 脚本里可调用的工具名（顺序沿用注册表顺序）。
 *
 * = 本轮 `toolSpecsFor()` 的名字 + 已注册但尚未装入的 `mcp__*`（issue #68 的
 * 「直接点名即执行并装入」路径），去掉 run_js 自身与排除名单。
 */
export function scriptToolNames(cfg: Config, visible: readonly string[]): string[] {
  const set = new Set(visible);
  for (const n of toolNames(cfg)) {
    if (n.startsWith("mcp__")) set.add(n);
  }
  return toolNames(cfg).filter((n) => set.has(n) && !CODE_MODE_EXCLUDED_TOOLS.includes(n));
}

/* ------------------------------------------------------------------ */
/* 运行器                                                              */
/* ------------------------------------------------------------------ */

interface ExecutedCall {
  name: string;
  ok: boolean;
  executed: boolean;
}

interface RunOutcome {
  ok: boolean;
  return?: unknown;
  console?: string;
  error?: string;
  executed: ExecutedCall[];
}

/** 内部工具调用的「宿主」：脚本里看到的就是这个对象的属性。 */
type ScriptTools = Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;

/**
 * 跑一段脚本。返回给模型的 payload（由 run_js 的 execute 序列化）。
 *
 * 注意：**不**在这里做输出截断 —— 截断统一由 dispatch → limitOutput 负责。
 */
export async function runScript(
  code: string,
  ctx: ToolCtx,
  visibleNames: readonly string[],
): Promise<RunOutcome> {
  const executed: ExecutedCall[] = [];
  const logs: string[] = [];
  const cfg = ctx.cfg;
  const maxCalls = Math.max(1, Number(cfg.maxToolIterations) || 1);

  // 墙钟由 execute 侧 withCodeModeClock 挂上（含首次审批等待）。
  // 这里只消费 ctx.signal，并让脚本里的裸 await 在 abort 时立刻落地。
  const innerCtx: ToolCtx = {
    ...ctx,
    onEvent: ctx.onEvent
      ? (e) => {
          if (e.type === "tool_start" || e.type === "tool_end") ctx.onEvent?.(e);
        }
      : undefined,
  };
  const signal = innerCtx.signal ?? new AbortController().signal;

  // 中止时让脚本的 await 立刻落地（否则 `await new Promise(() => {})` 会永远挂住）。
  const abortPromise = new Promise<never>((_, reject) => {
    const fail = (): void => reject(abortError(timedOutSignals.has(signal)));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  // 防止它被 reject 成未处理拒绝。
  abortPromise.catch(() => {});

  let calls = 0;
  const callTool = makeCallTool();
  const tools: ScriptTools = {};
  for (const name of visibleNames) {
    tools[name] = async (args: Record<string, unknown> = {}): Promise<unknown> => {
      if (signal.aborted) throw abortError(timedOutSignals.has(signal));
      calls += 1;
      if (calls > maxCalls) {
        // 超限是脚本自己的错，不是中止：抛普通错误，让脚本能 catch 到并收尾。
        throw new Error(
          `内部工具调用次数超过上限（max_tool_iterations=${maxCalls}），已中止脚本`,
        );
      }
      return callTool(name, args, innerCtx, executed, signal);
    };
  }

  const consoleProxy = makeScriptConsole(logs);

  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    // 本进程 AsyncFunction：不沙箱、不翻译 TS。只注入 tools 与 console。
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    fn = new AsyncFunction("tools", "console", wrapScript(code));
  } catch (e) {
    return { ok: false, error: `语法错误：${(e as Error).message}`, executed };
  }

  try {
    const value = await Promise.race([fn(tools, consoleProxy), abortPromise]);
    return finish(true, value, logs, executed, undefined);
  } catch (e) {
    if (signal.aborted) {
      return finish(false, undefined, logs, executed, abortMessage(timedOutSignals.has(signal)));
    }
    // 脚本自己的错误（含次数超限、内部工具失败）：原样回给模型。
    // 次数超限的文案里已带 max_tool_iterations，测试与模型都靠它识别。
    return finish(false, undefined, logs, executed, `未捕获异常：${(e as Error).message ?? String(e)}`);
  }
}

/**
 * 给 run_js 整段执行（含首次审批等待）挂上墙钟。
 * 超时会 abort 合并后的信号；若调用方与 execute 共享同一个 ctx 对象，
 * 会把 ctx.signal 指到该信号，让挂起的 confirm 能干净 settle。
 */
async function withCodeModeClock(
  ctx: ToolCtx,
  fn: (inner: ToolCtx, timedOut: () => boolean) => Promise<string>,
): Promise<string> {
  const wall = new AbortController();
  let timedOut = false;
  const timeoutMs = codeModeTimeoutMs(ctx.cfg);
  const timer = setTimeout(() => {
    timedOut = true;
    timedOutSignals.add(wall.signal);
    wall.abort();
  }, timeoutMs);
  const outer = ctx.signal;
  const onOuterAbort = (): void => wall.abort();
  if (outer) {
    if (outer.aborted) wall.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  const prevSignal = ctx.signal;
  ctx.signal = wall.signal;
  const inner: ToolCtx = {
    ...ctx,
    signal: wall.signal,
    approve: (tool, detail) =>
      new Promise<boolean>((resolve, reject) => {
        const onAbort = (): void => resolve(false);
        if (wall.signal.aborted) {
          onAbort();
          return;
        }
        wall.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(ctx.approve(tool, detail)).then(
          (v) => {
            wall.signal.removeEventListener("abort", onAbort);
            resolve(v);
          },
          (e) => {
            wall.signal.removeEventListener("abort", onAbort);
            reject(e);
          },
        );
      }),
  };
  try {
    return await fn(inner, () => timedOut);
  } finally {
    ctx.signal = prevSignal;
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }
}

/** 墙钟超时：默认 10 分钟；测试用 cfg 上的非公开字段把它调短（不做成模型可见参数）。 */
function codeModeTimeoutMs(cfg: Config): number {
  const raw = (cfg as unknown as Record<string, unknown>)["__codeModeTimeoutMs"];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return CODE_MODE_TIMEOUT_MS;
}

function abortError(timedOut: boolean): Error {
  const err = new Error(abortMessage(timedOut));
  err.name = "AbortError";
  return err;
}

function abortMessage(timedOut: boolean): string {
  return timedOut
    ? "run_js 超时（墙钟上限，含审批等待），已中止"
    : "run_js 已被中止（Ctrl+C / 本轮取消）";
}

/**
 * 把用户代码交给 AsyncFunction 当函数体。始终原样使用，不做表达式包装。
 */
function wrapScript(code: string): string {
  // 始终当作 async 函数体：用户用 return 交回结果；多语句 / throw 也能跑。
  // 不要把「没有 return」的脚本包进 `return (...)` —— 那会把多语句或 throw 弄成非法语法。
  return code;
}

/**
 * 一次内部工具调用：调度闸门 + dispatch + tool_start / tool_end。
 *
 * 调度是**每段脚本一份** FIFO：
 *  - `isParallelizable` 的工具可以彼此真正并行（Promise.all 能重叠）；
 *  - 非 parallelizable 的工具是屏障：轮到它时等在途调用结束，独占执行，
 *    期间不让其它调用（包括可并行的）开始。避免确认框抢 stdin。
 */

function makeCallTool() {
  type Job = { parallel: boolean; start: () => void };
  const queue: Job[] = [];
  let runningSerial = 0;
  let runningParallel = 0;

  const pump = (): void => {
    if (runningSerial > 0) return;
    while (queue.length > 0) {
      const next = queue[0]!;
      if (next.parallel) {
        queue.shift();
        runningParallel += 1;
        next.start();
        continue;
      }
      if (runningParallel > 0) break;
      queue.shift();
      runningSerial += 1;
      next.start();
      break;
    }
  };

  const schedule = <T,>(parallel: boolean, fn: () => Promise<T>, signal: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError(timedOutSignals.has(signal)));
        return;
      }
      const job: Job = {
        parallel,
        start: () => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              if (parallel) runningParallel -= 1;
              else runningSerial -= 1;
              pump();
            });
        },
      };
      queue.push(job);
      pump();
    });

  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolCtx,
    executed: ExecutedCall[],
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (signal.aborted) throw abortError(false);
    const callId = `run_js_${name}_${Math.random().toString(36).slice(2, 10)}`;
    const argsJson = safeJson(args);
    ctx.onEvent?.({
      type: "tool_start",
      data: { name, args: argsJson, call_id: callId, paths: [] },
    });
    let result;
    try {
      result = await dispatch(name, argsJson, ctx);
    } catch (e) {
      // dispatch 只在 AbortError 时抛出。
      ctx.onEvent?.({
        type: "tool_end",
        data: {
          name,
          ok: false,
          truncated: false,
          call_id: callId,
          output: "",
          status: "failure",
          paths: [],
        },
      });
      throw e;
    }
    const status = result.executed === false ? "not_executed" : result.ok ? "success" : "failure";
    ctx.onEvent?.({
      type: "tool_end",
      data: {
        name,
        ok: result.ok,
        truncated: result.truncated,
        call_id: callId,
        output: result.output,
        status,
        paths: [],
      },
    });
    executed.push({ name, ok: result.ok, executed: result.executed !== false });
    if (!result.ok) {
      // 失败也把文本交给脚本：模型可以在脚本里判断/重试，而不是整段崩掉。
      const err = new Error(result.output);
      err.name = "ToolCallError";
      throw err;
    }
    return result.output;
  };

  return async (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolCtx,
    executed: ExecutedCall[],
    signal: AbortSignal,
  ): Promise<unknown> => {
    return schedule(isParallelizable(name), () => invoke(name, args, ctx, executed, signal), signal);
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return "{}";
  }
}

/** 脚本里的 console：只收集文本，不写宿主 stdout（否则会撕碎 TUI）。 */
function makeScriptConsole(logs: string[]): Record<string, (...a: unknown[]) => void> {
  const push = (level: string, args: unknown[]): void => {
    const text = args.map(formatLogArg).join(" ");
    logs.push(level === "log" ? text : `[${level}] ${text}`);
  };
  return {
    log: (...a: unknown[]) => push("log", a),
    info: (...a: unknown[]) => push("info", a),
    warn: (...a: unknown[]) => push("warn", a),
    error: (...a: unknown[]) => push("error", a),
    debug: (...a: unknown[]) => push("debug", a),
  };
}

function formatLogArg(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function finish(
  ok: boolean,
  value: unknown,
  logs: string[],
  executed: ExecutedCall[],
  error: string | undefined,
): RunOutcome {
  const out: RunOutcome = { ok, executed };
  if (ok) {
    const serialized = serializeReturn(value);
    if (serialized !== undefined) out.return = serialized;
  }
  if (logs.length > 0) out.console = logs.join("\n");
  if (error !== undefined) out.error = error;
  return out;
}

/** return 值的 JSON 可序列化形式；不可序列化时退回字符串描述。 */
function serializeReturn(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return JSON.parse(s) as unknown;
  } catch {
    return String(value);
  }
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

export const runJsTool: ToolImpl = {
  // 敏感：审批走 gateTool；但光标 sensitive 不够 —— decidePermission 里 run_js
  // 必须与 shell 同桶（否则 auto-edit 会免问放行整段 JS，见 agent/policy.ts）。
  sensitive: true,
  kind: "capability",
  // 不可并行：脚本内部会串行弹审批，与相邻工具并发只会抢 stdin。
  parallelizable: false,
  spec: {
    type: "function",
    function: {
      name: CODE_MODE_TOOL_NAME,
      description:
        "实验性 Code Mode：执行一段 JavaScript，在一次调用里完成多次工具调用（循环/条件/把上一步结果喂给下一步）。" +
        "脚本用 `await tools.<工具名>({...参数})` 调工具（名字与工具清单一致，含 mcp__*），" +
        "用 `return` 交回结果、用 `console.log` 输出日志；回给模型的只有 return 值与 console 输出。" +
        "只接受 JavaScript（TypeScript 语法会直接报语法错误）。每次内部工具调用照走审批与 hooks；" +
        "墙钟上限 10 分钟，内部调用次数上限为 max_tool_iterations。",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "要执行的 JavaScript 函数体。示例：`const t = await tools.read_file({ path: \"a.ts\" }); console.log(t.length); return t;`",
          },
        },
        required: ["code"],
      },
    },
  },
  async execute(args, ctx) {
    const code = String(args["code"] ?? "");
    if (code.trim() === "") throw new ToolError("code 为空");
    const detail = `Code Mode 执行 JavaScript（内部工具调用照走审批）：\n${code}`;
    return withCodeModeClock(ctx, async (inner, timedOut) => {
      const denied = await gateTool(inner, CODE_MODE_TOOL_NAME, args, detail);
      if (denied !== null) {
        // 超时发生在首次确认框等待中：回 JSON 失败，而不是 notExecuted 抛错。
        if (inner.signal?.aborted) {
          return JSON.stringify({ ok: false, error: abortMessage(timedOut()), executed: [] });
        }
        notExecuted(denied);
      }
      const visible = scriptToolNames(inner.cfg, visibleToolNamesForScript(inner));
      const outcome = await runScript(code, inner, visible);
      // 结果一律以 JSON 对象回给模型（ok/return/console/error/executed），
      // 失败也是正常返回而不是 ToolError：脚本跑过、副作用可能已发生，
      // 走异常通道会被 dispatch 当成「没执行」，把已发生的事情说反。
      return JSON.stringify(outcome);
    });
  },
};

/**
 * 脚本可见集的来源：宿主（Agent）能给出本轮 `toolSpecsFor()` 就用它，
 * 否则退回注册表全量（测试裸 ctx / 非 Agent 宿主）。
 */
function visibleToolNamesForScript(ctx: ToolCtx): string[] {
  const host = ctx.host as { toolSpecsFor?: () => ToolSpec[] } | undefined;
  if (host && typeof host.toolSpecsFor === "function") {
    try {
      return host.toolSpecsFor().map((s) => s.function.name);
    } catch {
      /* 宿主异常：退回注册表全量 */
    }
  }
  return toolSpecs(ctx.cfg).map((s) => s.function.name);
}

/** Code Mode 用法段（提示词与 `/tools` 共用同一份文案）。 */
export function codeModePromptSection(): string {
  return `- run_js（实验性 Code Mode）：执行一段 JavaScript，在一次调用里完成多次工具调用。写法：\`const t = await tools.read_file({ path: "a.ts" }); console.log(t.length); return t;\`。工具名与「可用工具」一致（含 mcp__*），每次内部调用照走审批与 hooks；回给模型的只有 return 值与 console 输出（内部输出默认不进上下文）。墙钟上限 10 分钟，内部调用次数上限为 max_tool_iterations。只接受 JavaScript，TypeScript 语法会直接报语法错误。`;
}
