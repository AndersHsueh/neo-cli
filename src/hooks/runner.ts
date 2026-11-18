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
import { StringDecoder } from "node:string_decoder";
import { getShell, prepareShellInvocation } from "../shell.ts";
import type { Config } from "../config.ts";
import {
  HOOK_CONTEXT_FIELD_LIMIT,
  HOOK_DIAGNOSTIC_BUFFER_LIMIT,
  HOOK_SEMANTIC_OUTPUT_LIMIT,
  matchReason,
  matchTool,
  matchTrigger,
  type CompactTrigger,
  type HookDef,
  type HookDispatchResult,
  type HookEvent,
  type HookOutcome,
  type HookPayload,
  type HookAdditionalContext,
  type HookSemanticOutput,
  type HooksConfig,
  type NotificationReason,
  type StopBlockRequest,
} from "./types.ts";

/** 诊断里保留的 stdout/stderr 尾部长度。 */
const TAIL_LIMIT = 800;

/** 回给模型的阻断原因上限（太长会挤掉上下文）。 */
const REASON_LIMIT = 2000;

/**
 * #64 B1：需要**语义载荷**（而不是诊断尾部）的事件。
 *
 * 这四个事件的退出码 0 输出是给宿主消费的结构化结果（附加上下文 / Stop 续跑请求），
 * 必须用完整原文解析，再按字段限长。旧四事件（PreToolUse / PostToolUse / TurnEnd /
 * Notification）只消费诊断尾部，行为不变。
 */
const SEMANTIC_EVENTS: readonly HookEvent[] = ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact"];

interface CapturedOutput {
  raw: string;
  reason: string;
  diagnostic: string;
  overflow: boolean;
}

/**
 * 新生命周期输出保留有界完整载荷，同时流式维护真正的诊断尾部。
 * 旧四事件不传limit，保留原有完整JSON失败原因契约，不引入新上限。
 * 超限只丢弃语义缓冲，仍解码/排空流以保留末尾诊断和真实退出码。
 */
function captureOutput(limit?: number) {
  const decoder = new StringDecoder("utf8");
  let raw = "";
  let bytes = 0;
  let overflow = false;
  let prefix = "";
  let view = "";
  let pendingWhitespace = "";
  let viewLength = 0;
  let result: CapturedOutput | undefined;

  const append = (text: string): void => {
    if (!overflow) raw += text;
    if (prefix.length < REASON_LIMIT) prefix = (prefix + text).trimStart().slice(0, REASON_LIMIT);
    // 保留末尾空白待下一块；EOF时舍弃，等价于原先全文trim后再tail。
    const content = text.trimEnd();
    if (content) {
      const next = viewLength === 0 ? content.trimStart() : pendingWhitespace + content;
      viewLength = Math.min(TAIL_LIMIT + 1, viewLength + next.length);
      view = (view + next).slice(-TAIL_LIMIT);
      pendingWhitespace = "";
    }
    pendingWhitespace = (pendingWhitespace + text.slice(content.length)).slice(-TAIL_LIMIT);
  };

  return {
    push(chunk: Buffer): void {
      if (limit !== undefined && !overflow) {
        bytes += chunk.length;
        if (bytes > limit) { overflow = true; raw = ""; }
      }
      append(decoder.write(chunk));
    },
    finish(): CapturedOutput {
      if (result) return result;
      append(decoder.end());
      result = {
        raw,
        reason: overflow ? prefix : raw,
        diagnostic: (viewLength > TAIL_LIMIT ? "…" : "") + view,
        overflow,
      };
      return result;
    },
  };
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
 * 匹配对象随事件而变，刻意分开写（见 types.ts 的 matchReason 注释）：
 *  - PreToolUse / PostToolUse：工具名；
 *  - Notification：触发原因（`reason`，缺省 = 全部原因）；
 *  - PreCompact（#64）：压缩来源（`trigger`，缺省 = 全部来源）；
 *  - TurnEnd / SessionStart / Stop（#64）：无匹配对象，恒匹配。
 */
export function hookMatches(
  hook: HookDef,
  tool: string | null,
  reason: NotificationReason | null = null,
  trigger: CompactTrigger | null = null,
): boolean {
  switch (hook.event) {
    case "Notification":
      // 没给原因（不该发生）时按不匹配处理：宁可少发一条通知，也不误发。
      return reason !== null && matchReason(hook.matcher, reason);
    case "PreCompact":
      // 没给来源（不该发生）时按不匹配处理：压缩是破坏性动作，宁可不跑。
      return trigger !== null && matchTrigger(hook.matcher, trigger);
    case "TurnEnd":
    case "SessionStart":
    case "Stop":
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
 * 分发一个事件时可额外指定「匹配对象」（#64）。
 *
 * 旧签名把 `reason` 放在最后，为了不破坏既有调用点，新增的 `trigger` 走这个
 * 可选对象；两者互斥（Notification 用 reason，PreCompact 用 trigger）。
 */
export interface DispatchMatchOptions {
  /** PreCompact 的匹配对象（manual / auto）。 */
  trigger?: CompactTrigger;
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
  } else if (payload.event === "PreCompact") {
    // #64：压缩来源是 PreCompact 的 matcher 对象，同样给一份环境变量。
    env["NEO_HOOK_TRIGGER"] = payload.trigger;
  } else if (payload.event === "SessionStart") {
    env["NEO_HOOK_SOURCE"] = payload.source;
  } else if (payload.event !== "TurnEnd" && payload.event !== "Stop" && payload.event !== "UserPromptSubmit") {
    env["NEO_HOOK_TOOL"] = payload.tool_name;
  }

  const spawnFn = opts.spawnFn ?? spawn;
  // #64 B1：生命周期事件要保留完整语义载荷，所以接收阶段就按上限判限。
  const wantsSemantic = SEMANTIC_EVENTS.includes(payload.event);

  return await new Promise<HookOutcome>((resolve) => {
    let settled = false;
    // 仅新生命周期载荷设接收上限；诊断尾部独立更新，旧四事件契约不变。
    const outSink = captureOutput(wantsSemantic ? HOOK_SEMANTIC_OUTPUT_LIMIT : undefined);
    const errSink = captureOutput(wantsSemantic ? HOOK_DIAGNOSTIC_BUFFER_LIMIT : undefined);
    let timedOut = false;
    let aborted = false;
    let child: ReturnType<typeof spawn>;

    const finish = (kind: HookOutcome["kind"], code: number | null, reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const stdout = outSink.finish();
      const stderr = errSink.finish();
      const outcome: HookOutcome = {
        ...base,
        kind,
        code,
        reason,
        stdout: stdout.diagnostic,
        stderr: stderr.diagnostic,
        durationMs: Date.now() - started,
      };
      if (stdout.overflow || stderr.overflow) outcome.outputTruncated = true;
      if (wantsSemantic && kind === "ok") {
        outcome.semantic = { raw: stdout.raw, overflow: stdout.overflow };
      }
      resolve(outcome);
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

    // 诊断尾部与语义载荷各走一个有界接收器；超限后仍继续读管道（不杀进程），
    // 否则 exit 2 会被「被终止」吞掉，放过本该阻断的 UPS / PreCompact。
    child.stdout?.on("data", (d: Buffer) => {
      outSink.push(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      errSink.push(d);
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
        finish("block", 2, extractReason(outSink.finish().reason, errSink.finish().reason, "hook 以退出码 2 阻断，但没有给出原因"));
        return;
      }
      finish(
        "error",
        c,
        extractReason(outSink.finish().reason, errSink.finish().reason, `hook 以退出码 ${c} 失败（未提供原因）`),
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

/**
 * 解析退出码 0 的 hook 输出里的「附加上下文」（#64）。
 *
 * 两种写法都接受：
 *  - 纯文本 stdout → 整段就是附加上下文；
 *  - JSON `{"additionalContext": "..."}` → **只取该字段**，不把原 JSON 串再注入一次
 *    （否则模型会同时看到 `{"additionalContext":...}` 和正文，等于重复注入）。
 *
 * 半截 JSON 退化成纯文本；合法对象字段类型不对则忽略上下文，均不抛错。
 * 纯文本是默认路径 —— hook 作者写 `echo "注意：..."` 就该生效，不必先学 JSON。
 *
 * #64 B1：入参是**完整语义载荷**（`HookOutcome.semantic.raw`），不是诊断尾部。
 * 超限（`overflow`）时直接返回空上下文并标记 `overflow` —— 截断载荷既不能解析，
 * 也不能降格成纯文本注入。
 *
 * #64 B1 自修：**先完整 parse，再按字段限长**。`additionalContext` 与纯文本两条路径
 * 都受 `HOOK_CONTEXT_FIELD_LIMIT`（32000 字符）约束 —— 1 MiB 的合法 JSON 里塞 30 万字
 * 正文一样会挤爆主模型/摘要器。裁剪保留前 N 字符并标记 `truncated`（调用方留诊断）。
 */
export function parseHookOutput(semantic: HookSemanticOutput | undefined): HookAdditionalContext {
  if (semantic === undefined) return { text: "", from: "text" };
  if (semantic.overflow) return { text: "", from: "json", overflow: true };
  const out = semantic.raw.trim();
  if (out === "") return { text: "", from: "text" };
  if (out.startsWith("{")) {
    try {
      const obj = JSON.parse(out) as Record<string, unknown>;
      const ctx = obj["additionalContext"];
      if (typeof ctx === "string") return limitContext(ctx.trim(), "json");
      // 合法 JSON 但没有 additionalContext（例如 Stop 的 decision/reason）：
      // 这不是附加上下文，别把结构化输出当正文塞给模型。未知字段再大也一样。
      return { text: "", from: "json" };
    } catch {
      // 不是合法 JSON：按纯文本处理（不能崩会话）
    }
  }
  return limitContext(out, "text");
}

/** 字段级限长：纯文本与 JSON additionalContext 共用同一条上限。 */
function limitContext(text: string, from: "text" | "json"): HookAdditionalContext {
  if (text.length <= HOOK_CONTEXT_FIELD_LIMIT) return { text, from };
  return { text: text.slice(0, HOOK_CONTEXT_FIELD_LIMIT), from, truncated: true };
}

/**
 * 解析退出码 0 的 Stop 输出（#64）：只有 `{"decision":"block","reason":"<非空>"}`
 * 才请求续跑。普通 stdout（哪怕写着 "please continue"）、`{"decision":"block"}`
 * 无 reason、半截 JSON 一律不续跑 —— 续跑会多花一次模型请求，误判的代价不对称。
 *
 * #64 B1：入参是**完整语义载荷**（`HookOutcome.semantic.raw`）。先解析再按
 * REASON_LIMIT 限长 —— 否则 1000 字出头的合法 reason 会在诊断截断后连 JSON
 * 包装都保不住，续跑被静默吞掉。超限时标记 `overflow` 且不续跑（诊断由调用方显示）。
 */
export function parseStopOutput(semantic: HookSemanticOutput | undefined): StopBlockRequest {
  if (semantic === undefined) return { block: false, reason: "" };
  if (semantic.overflow) return { block: false, reason: "", overflow: true };
  const out = semantic.raw.trim();
  if (!out.startsWith("{")) return { block: false, reason: "" };
  try {
    const obj = JSON.parse(out) as Record<string, unknown>;
    if (obj["decision"] !== "block") return { block: false, reason: "" };
    const reason = obj["reason"];
    if (typeof reason !== "string") return { block: false, reason: "" };
    const text = reason.trim();
    if (text === "") return { block: false, reason: "" };
    if (text.length <= REASON_LIMIT) return { block: true, reason: text };
    return { block: true, reason: text.slice(0, REASON_LIMIT), truncated: true };
  } catch {
    return { block: false, reason: "" };
  }
}

/** #64 B1：语义载荷超限时给人看的一句话（诊断，不是语义）。 */
export function describeSemanticOverflow(event: HookEvent, hook: HookDef): string {
  return `${event} hook（${hook.origin}）的输出超过语义载荷上限 ${HOOK_SEMANTIC_OUTPUT_LIMIT} 字节，已忽略其语义（不注入上下文、不续跑）。`;
}

/**
 * #64 B1 自修：字段被裁剪时的诊断。
 *
 * 与「整段载荷超限」分开说：这里语义是可信的，只是正文太长被截到上限，
 * 用户需要知道「hook 生效了，但只喂了前 N 字符」。
 */
export function describeContextTruncation(event: HookEvent, hook: HookDef): string {
  return `${event} hook（${hook.origin}）的附加上下文超过字段上限 ${HOOK_CONTEXT_FIELD_LIMIT} 字符，已截断（只注入前 ${HOOK_CONTEXT_FIELD_LIMIT} 字符）。`;
}

/** #64 B1 自修：Stop reason 被裁剪时的诊断（仍然续跑，只是理由变短）。 */
export function describeReasonTruncation(event: HookEvent, hook: HookDef): string {
  return `${event} hook（${hook.origin}）的续跑理由超过 ${REASON_LIMIT} 字符，已截断（续跑请求不变）。`;
}

/** 该事件下所有匹配的 hook（保持配置顺序）。 */
export function hooksFor(
  cfg: HooksConfig,
  event: HookEvent,
  tool: string | null,
  reason: NotificationReason | null = null,
  trigger: CompactTrigger | null = null,
): HookDef[] {
  if (!cfg.enabled) return [];
  return cfg.hooks[event].filter((h) => hookMatches(h, tool, reason, trigger));
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
  match: DispatchMatchOptions = {},
): Promise<HookDispatchResult> {
  const list = hooksFor(cfg, event, tool, reason, match.trigger ?? null);
  const outcomes: HookOutcome[] = [];
  if (list.length === 0) return { blocked: false, reason: "", outcomes };

  for (const hook of list) {
    const r = await runHook(hook, payload, runtime, opts);
    outcomes.push(r);
    if (r.kind === "aborted") break;
    // 通知永不阻断：退出码 2 与 onFailure=block 都不生效，失败只留给调用方做诊断。
    if (event === "Notification") continue;
    // #64：SessionStart 失败只诊断 —— 会话已经开始，把它当阻断等于让用户开不了工。
    // 退出码 2 在这里同样降级为诊断（runSessionStart 会把原因显示出来）。
    if (event === "SessionStart") continue;
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
  const label =
    hook.event === "Notification" ? "reason" : hook.event === "PreCompact" ? "trigger" : "matcher";
  const extra =
    hook.event === "PreToolUse" || hook.event === "Notification" || hook.event === "SessionStart" || hook.event === "Stop"
      ? ""
      : ` · onFailure=${hook.onFailure}`;
  return `${hook.event} · ${label}=${hook.matcher ?? "*"} · timeout=${hook.timeout}s${extra} · ${hook.command}`;
}

/** 诊断行：把一次 outcome 转成给人看的一句话。 */
export function describeOutcome(o: HookOutcome): string {
  const where = `${o.hook.event} hook（${o.hook.origin}）${o.outputTruncated ? "（输出超过接收上限，诊断仅保留尾部）" : ""}`;
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
