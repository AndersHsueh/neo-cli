/**
 * hook 执行器（issue #3）。
 *
 * 契约（写进 README 的同一套）：
 *  - stdin 收一行 JSON（事件名 / session id / cwd / 工具名 / 参数 / 结果摘要 / 权限模式）；
 *  - 环境变量 NEO_HOOK_EVENT / NEO_HOOK_TOOL / NEO_HOOK_SESSION / NEO_HOOK_MODE 可选使用；
 *    Notification 另有 NEO_HOOK_REASON（触发原因）；
 *  - 退出码 0 = 放行；2 = 阻断（stdout/stderr 或 JSON 的 reason 作为原因回给模型）；
 *    其它非 0 = hook 自身出错，按 onFailure 处理（默认 continue + 可读诊断）。
 *    Notification 不适用阻断语义：它只发通知，失败只进诊断（issue #56）。
 *
 * 失败隔离是这一层的核心职责：超时、崩溃、命令不存在都必须变成**可读诊断**，
 * 绝不允许拖垮主循环或挂死会话。所以：
 *  - 每个 hook 独立 spawn，超时用 SIGKILL 打**进程组**（detached + kill(-pid)），
 *    避免 `sh -c 'sleep 100'` 这类子进程变成孤儿；
 *  - 启动失败（shell 不存在）与运行失败分开表述，用户能一眼看出该改什么。
 */
import { spawn } from "node:child_process";
import { getShell, prepareShellInvocation } from "../shell.ts";
import type { Config } from "../config.ts";
import {
  matchReason,
  matchTool,
  type HookDef,
  type HookDispatchResult,
  type HookEvent,
  type HookOutcome,
  type HookPayload,
  type HooksConfig,
  type NotificationReason,
} from "./types.ts";

/** 诊断里保留的 stdout/stderr 尾部长度。 */
const TAIL_LIMIT = 800;

/** 回给模型的阻断原因上限（太长会挤掉上下文）。 */
const REASON_LIMIT = 2000;

function tail(s: string, n = TAIL_LIMIT): string {
  const t = s.trim();
  return t.length <= n ? t : `…${t.slice(-n)}`;
}

/**
 * 从 hook 输出里取原因。
 *
 * 优先认 JSON（`{"reason": "..."}` 或 `{"decision":"block","reason":"..."}`）——
 * 这样 hook 可以在 stdout 上输出结构化信息而不必担心混进日志；
 * 否则用 stdout，再否则用 stderr。三者都空时给一句兜底，不留空原因。
 */
export function extractReason(stdout: string, stderr: string, fallback: string): string {
  const out = stdout.trim();
  if (out.startsWith("{")) {
    try {
      const obj = JSON.parse(out) as Record<string, unknown>;
      const r = obj["reason"] ?? obj["message"];
      if (typeof r === "string" && r.trim() !== "") return r.trim().slice(0, REASON_LIMIT);
    } catch {
      // 不是合法 JSON：按纯文本处理
    }
  }
  const text = out !== "" ? out : stderr.trim();
  if (text !== "") return text.slice(0, REASON_LIMIT);
  return fallback;
}

/**
 * 该事件下这一条 hook 是否匹配本次调用。
 *
 * 三种匹配对象，刻意分开写（见 types.ts 的 matchReason 注释）：
 *  - PreToolUse / PostToolUse：工具名；
 *  - Notification：触发原因（`reason`，缺省 = 全部原因）；
 *  - TurnEnd：无匹配对象，恒匹配。
 */
export function hookMatches(hook: HookDef, tool: string | null, reason: NotificationReason | null = null): boolean {
  switch (hook.event) {
    case "Notification":
      // 没给原因（不该发生）时按不匹配处理：宁可少发一条通知，也不误发。
      return reason !== null && matchReason(hook.matcher, reason);
    case "TurnEnd":
      return true;
    default:
      if (tool === null) return true;
      return matchTool(hook.matcher, tool);
  }
}

export interface RunHookOptions {
  /** 取消信号（Ctrl+C）：abort 时连 hook 一并杀掉。 */
  signal?: AbortSignal;
  /** 注入点（测试用）：默认用真实 spawn。 */
  spawnFn?: typeof spawn;
}

/**
 * 执行单条 hook，永不抛错。
 *
 * 返回值恒为 HookOutcome —— 调用方只看 kind 决定放行/阻断/记诊断。
 */
export async function runHook(
  hook: HookDef,
  payload: HookPayload,
  cfg: Config,
  opts: RunHookOptions = {},
): Promise<HookOutcome> {
  const started = Date.now();
  const base: Omit<HookOutcome, "kind" | "code" | "reason" | "stdout" | "stderr" | "durationMs"> = { hook };

  let invocation: ReturnType<typeof prepareShellInvocation>;
  try {
    const spec = getShell(cfg);
    invocation = prepareShellInvocation(spec, hook.command);
  } catch (e) {
    return {
      ...base,
      kind: "error",
      code: null,
      reason: `hook 无法启动：${(e as Error).message}`,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - started,
    };
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(invocation.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env["NEO_HOOK_EVENT"] = payload.event;
  env["NEO_HOOK_SESSION"] = payload.session_id;
  env["NEO_HOOK_MODE"] = payload.mode;
  if (payload.event === "Notification") {
    // 通知脚本最常按原因分流，单独给一个环境变量，省得每次解析 stdin。
    env["NEO_HOOK_REASON"] = payload.reason;
    if (payload.tool_name !== undefined) env["NEO_HOOK_TOOL"] = payload.tool_name;
  } else if (payload.event !== "TurnEnd") {
    env["NEO_HOOK_TOOL"] = payload.tool_name;
  }

  const spawnFn = opts.spawnFn ?? spawn;

  return await new Promise<HookOutcome>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let child: ReturnType<typeof spawn>;

    const finish = (kind: HookOutcome["kind"], code: number | null, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        ...base,
        kind,
        code,
        reason,
        stdout: tail(stdout),
        stderr: tail(stderr),
        durationMs: Date.now() - started,
      });
    };

    /** 杀整个进程组：detached 起的 shell 是组长，kill(-pid) 连带子进程。 */
    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已经退出：忽略
        }
      }
    };

    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, hook.timeout * 1000);

    try {
      child = spawnFn(invocation.argv[0]!, invocation.argv.slice(1), {
        cwd: cfg.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // detached：让 shell 成为新进程组组长，超时才能整组杀掉（不留孤儿）。
        detached: process.platform !== "win32",
      });
    } catch (e) {
      finish("error", null, `hook 无法启动：${(e as Error).message}`);
      return;
    }

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("error", (e: Error) => {
      // 命令不存在 / 无执行权限：spawn 层直接报错，没有退出码。
      finish("error", null, `hook 无法启动：${e.message}`);
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish("timeout", null, `hook 超时（${hook.timeout}s）已被终止`);
        return;
      }
      if (aborted) {
        finish("aborted", null, "hook 被用户中断");
        return;
      }
      const c = code ?? -1;
      if (c === 0) {
        finish("ok", 0, "");
        return;
      }
      if (c === 2) {
        finish("block", 2, extractReason(stdout, stderr, "hook 以退出码 2 阻断，但没有给出原因"));
        return;
      }
      finish(
        "error",
        c,
        extractReason(stdout, stderr, `hook 以退出码 ${c} 失败（未提供原因）`),
      );
    });

    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    // stdin 写失败（hook 不读 stdin 就退出）不算错误：EPIPE 忽略。
    try {
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${JSON.stringify(payload)}\n`);
    } catch {
      // 同上
    }
  });
}

/** 该事件下所有匹配的 hook（保持配置顺序）。 */
export function hooksFor(
  cfg: HooksConfig,
  event: HookEvent,
  tool: string | null,
  reason: NotificationReason | null = null,
): HookDef[] {
  if (!cfg.enabled) return [];
  return cfg.hooks[event].filter((h) => hookMatches(h, tool, reason));
}

/**
 * 分发一个事件：按顺序执行匹配的 hook，遇到阻断立刻停。
 *
 * 阻断语义：
 *  - PreToolUse：退出码 2 即阻断（恒为阻断语义，与 onFailure 无关）；
 *  - PostToolUse / TurnEnd：只有 `onFailure: "block"` 的 hook 在**失败**（超时/崩溃/
 *    非 0 非 2）时阻断；退出码 2 在这两个事件上同样视为「明确要求阻断」。
 *    默认 continue 时失败只进诊断，不阻断 —— 但绝不静默：outcomes 会带 reason。
 *  - Notification（issue #56）：**恒不阻断**。它是给人看的通知，没有模型要喂回原因；
 *    退出码 2 与 onFailure=block 在这里都不生效，失败只进诊断（outcomes）。
 */
export async function dispatchHooks(
  cfg: HooksConfig,
  event: HookEvent,
  payload: HookPayload,
  tool: string | null,
  runtime: Config,
  opts: RunHookOptions = {},
  reason: NotificationReason | null = null,
): Promise<HookDispatchResult> {
  const list = hooksFor(cfg, event, tool, reason);
  const outcomes: HookOutcome[] = [];
  if (list.length === 0) return { blocked: false, reason: "", outcomes };

  for (const hook of list) {
    const r = await runHook(hook, payload, runtime, opts);
    outcomes.push(r);
    if (r.kind === "aborted") break;
    // 通知永不阻断：退出码 2 与 onFailure=block 都不生效，失败只留给调用方做诊断。
    if (event === "Notification") continue;
    if (r.kind === "block") {
      return { blocked: true, reason: r.reason, outcomes };
    }
    if (r.kind === "error" || r.kind === "timeout") {
      const wantsBlock = event === "PreToolUse" ? false : hook.onFailure === "block";
      if (wantsBlock) {
        return {
          blocked: true,
          reason: `${event} hook 失败（${r.kind === "timeout" ? "超时" : `退出码 ${r.code ?? "?"}`}）：${r.reason}`,
          outcomes,
        };
      }
      // continue：不阻断，但保留诊断（调用方负责显示）。
    }
  }
  return { blocked: false, reason: "", outcomes };
}

/**
 * 一条 hook 的可读描述（/hooks 列表用）。
 *
 * Notification 的 matcher 匹配的是**触发原因**而不是工具名（issue #56），
 * 所以那一栏写 `reason=`；它恒不阻断，也不显示 onFailure。
 */
export function describeHook(hook: HookDef): string {
  const label = hook.event === "Notification" ? "reason" : "matcher";
  const extra = hook.event === "PreToolUse" || hook.event === "Notification" ? "" : ` · onFailure=${hook.onFailure}`;
  return `${hook.event} · ${label}=${hook.matcher ?? "*"} · timeout=${hook.timeout}s${extra} · ${hook.command}`;
}

/** 诊断行：把一次 outcome 转成给人看的一句话。 */
export function describeOutcome(o: HookOutcome): string {
  const where = `${o.hook.event} hook（${o.hook.origin}）`;
  switch (o.kind) {
    case "ok":
      return `${where} 通过（${o.durationMs}ms）`;
    case "block":
      return `${where} 阻断：${o.reason}`;
    case "timeout":
      return `${where} 超时（${o.hook.timeout}s）已被终止`;
    case "error":
      return `${where} 失败：${o.reason}`;
    case "aborted":
      return `${where} 被中断`;
  }
}
