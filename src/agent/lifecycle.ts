/**
 * Agent 生命周期 hooks 支持（#64）：SessionStart / UserPromptSubmit / Stop / PreCompact。
 *
 * 为什么单独一个模块：这四个事件是**会话/用户边界**上的，不是工具边界上的。
 * 它们的调用点分散在宿主（会话启动）、回合入口（sendTurn）、压缩入口（compactNow），
 * 塞进 loopSupport 会把「工具链上的 hook」和「会话边界的 hook」混成一坨，
 * 也让 loopSupport 继续变长。这里只做三件事：
 *
 *  1. 统一构造载荷并走 `runHooks`（超时/进程组回收/诊断沿用既有实现，不重写）；
 *  2. 集中解析退出码 0 的输出（纯文本 / JSON additionalContext / Stop 的 block+reason），
 *     避免「原 JSON 串被重复注入」这类每个调用点各写一遍的坑；
 *  3. 守住两条边界：**子代理不触发**这四类事件（防递归），**plan 只读**不执行
 *     （`runHooks` 里已有，这里不重复判定）。
 *
 * 本模块**不**决定「什么时候调用」—— 那是宿主与 sendTurn/compactNow 的事。
 * 宿主负责真实输入边界，sendTurn 与 compactNow 分别负责终止和压缩切点。
 */
import type { Message } from "../llm.ts";
import {
  describeContextTruncation,
  describeReasonTruncation,
  describeSemanticOverflow,
  parseHookOutput,
  parseStopOutput,
  type CompactTrigger,
  type HookOutcome,
  type SessionStartSource,
  type StopBlockRequest,
} from "../hooks/index.ts";
import { SESSION_START_SOURCES } from "../hooks/index.ts";
import type { Agent } from "./loop.ts";

/** 一次生命周期 hook 调用的结果。 */
export interface LifecycleHookResult {
  /** 是否要求阻断（SessionStart 恒为 false —— 失败只诊断）。 */
  blocked: boolean;
  /** 阻断原因 / 诊断文本。 */
  reason: string;
  /** 退出码 0 给出的附加上下文（已解析，纯文本或 JSON 的 additionalContext）。 */
  context: string;
  /** Stop 专用：是否请求续跑（只有 JSON decision:block + 非空 reason 才为 true）。 */
  continue: boolean;
}

/** 非交互 stdout 是结果/协议通道；hook 诊断只能走 stderr。 */
export function reportLifecycle(agent: Agent, message: string): void {
  if (agent.opt.nonInteractive) console.error(message);
  else agent.opt.console.warn(message);
}

const EMPTY: LifecycleHookResult = { blocked: false, reason: "", context: "", continue: false };

/** 子代理不触发会话/用户事件（#64 硬约束：防递归）。 */
function skipForSubagent(agent: Agent): boolean {
  return agent.opt.isSubagent === true;
}

/**
 * 把附加上下文并进历史尾部（作为一条 system 消息）。
 *
 * 为什么不进 user 消息：hook 的附加上下文是**宿主/用户配置的指令**，不是用户说的话。
 * 混进 user 会让模型以为用户刚说了这句话，也会污染 `/rewind` 的轮次边界。
 * 空文本不注入 —— 不留空 system 消息。
 */
function appendLifecycleContext(agent: Agent, text: string): Message | null {
  const t = text.trim();
  if (t === "") return null;
  const msg: Message = { role: "system", content: t };
  agent.messages.push(msg);
  return msg;
}

/**
 * SessionStart（#64）。
 *
 * 只认 new / resume / clear / fork —— 没有 ENV_FILE（与竞品的差异，见 README）。
 * 非法来源直接抛错，**不静默当成 new**：宿主传错值时应该立刻发现，
 * 而不是让用户的 hook 在错误的语义下跑一遍。
 *
 * 失败只诊断：会话已经开始，把 SessionStart 的失败当阻断等于让用户开不了工。
 * 因此 `blocked` 恒为 false；退出码 2 的原因也走 `reason` 显示出来。
 *
 * 附加上下文随后主模型可见（`appendLifecycleContext`），由调用方决定是否注入。
 * **不在 constructor 触发**：构造 Agent 不等于会话开始，宿主必须显式调用。
 */
export async function runSessionStart(
  this: Agent,
  source: SessionStartSource,
): Promise<LifecycleHookResult> {
  if (!SESSION_START_SOURCES.includes(source)) {
    throw new Error(
      `未知的 SessionStart 来源：${String(source)}（只认 ${SESSION_START_SOURCES.join(" / ")}）`,
    );
  }
  if (skipForSubagent(this)) return EMPTY;

  if (!this.abort || this.abort.signal.aborted) this.abort = new AbortController();
  const r = await this.runHooks("SessionStart", null, { source }, this.abort?.signal);
  // dispatchHooks 对 SessionStart 恒不阻断；这里再兜一层，语义写在类型上。
  const context = collectContext(this, r.outcomes);
  if (context !== "") appendLifecycleContext(this, context);
  return { blocked: false, reason: r.reason, context, continue: false };
}

/**
 * UserPromptSubmit（#64）。
 *
 * 只对**真实用户输入**调用：`-p` 一次输入一次、ACP 每次 `session/prompt` 一次、
 * 交互每条输入一次。内部 drive/loop 轮与 Stop 续跑不得调用（否则递归）。
 *
 * 退出码 2 = 阻断。调用方必须在**写主历史与任何首模型请求之前**调用它
 * （含分类器等预模型调用），否则用户输入会先漏发出去再被拦。
 * 附加上下文只在放行时注入，且只注入一次。
 */
async function runUserPromptSubmit(
  this: Agent,
  prompt: string,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return EMPTY;

  const r = await this.runHooks("UserPromptSubmit", null, { prompt }, this.abort?.signal);
  if (r.blocked) return { blocked: true, reason: r.reason, context: "", continue: false };
  const context = collectContext(this, r.outcomes);
  if (context !== "") appendLifecycleContext(this, context);
  return { blocked: false, reason: "", context, continue: false };
}

/**
 * Stop（#64）。
 *
 * 只在模型**正常终止**时调用，不是每次工具迭代之后。是否续跑由 hook 的
 * 退出码 0 输出决定：只有 `{"decision":"block","reason":"<非空>"}` 才算请求，
 * 普通 stdout 一律不续跑（见 runner.ts 的 parseStopOutput）。
 *
 * **退出码 2 在这里不等于续跑**（与 PreToolUse 的阻断语义刻意不同）：
 * Stop 的「阻断」意味着再花一次模型请求，误判代价不对称。所以只有
 * JSON decision:block + 非空 reason 才续跑；exit2 的普通 stdout、无 reason、
 * 半截 JSON 一律不续 —— 原因只进诊断（`reason` 字段由调用方显示）。
 * 退出码失败（超时/崩溃/非 0 非 2）同样只诊断，失败理由不得变成续跑理由。
 *
 * `alreadyContinued` 表示本轮已经续跑过一次 —— 传进载荷让 hook 自己知道，
 * 也由调用方据此拒绝第二次续跑（每条用户输入最多一次）。
 * 本函数**不**执行续跑，只回答「要不要续、为什么」。
 */
export async function runStopHooks(
  this: Agent,
  alreadyContinued = false,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return EMPTY;

  const r = await this.runHooks("Stop", null, { stop_hook_active: alreadyContinued }, this.abort?.signal);
  const request: StopBlockRequest = lastStopRequest(this, r.outcomes);
  // 诊断文本：exit2 / 失败 / 无 reason 的 block 都留下可读原因，但都不续跑。
  const diagnostic = r.reason !== "" ? r.reason : firstOutcomeReason(r.outcomes);
  return {
    blocked: request.block,
    reason: request.block ? request.reason : diagnostic,
    context: "",
    continue: request.block,
  };
}

/**
 * 压缩被 PreCompact hook 拒绝（#64）。
 *
 * 与「压缩失败」刻意分成两个类型：拒绝是**用户的明确决定**，调用方必须
 * 原样保留历史与快照、明确告知用户、并且**不得**退化为 trimOldToolOutputs
 * 或上下文溢出恢复路径（那两条都会破坏历史）。普通失败（太短、摘要器空）
 * 仍走 ToolError，旧行为不变。
 */
export class CompactBlockedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CompactBlockedError";
  }
}

/**
 * PreCompact（#64）。
 *
 * 必须在**任何破坏历史的动作之前**调用（摘要请求、快照、裁剪都算）。
 * 退出码 2 = 拒绝压缩：调用方原样保留历史与 `lastCompact`，并明确告知用户，
 * 不得退化为 trimOldToolOutputs 或上下文溢出恢复路径（那两条都会破坏历史）。
 *
 * 附加上下文**只给摘要器**，不落历史 —— 所以这里不调 `appendLifecycleContext`。
 */
export async function runPreCompact(
  this: Agent,
  trigger: CompactTrigger,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return EMPTY;

  const r = await this.runHooks(
    "PreCompact",
    null,
    { trigger, message_count: Math.max(0, this.messages.length - 1) },
    this.abort?.signal,
    null,
    { trigger },
  );
  if (r.blocked) {
    // 原因必须可见：拒绝压缩是用户的决定，不能静默变成「压缩失败」。
    reportLifecycle(this, `PreCompact hook 拒绝了本次压缩（${trigger}）：${r.reason}`);
    return { blocked: true, reason: r.reason, context: "", continue: false };
  }
  const context = collectContext(this, r.outcomes);
  return { blocked: false, reason: "", context, continue: false };
}

/**
 * 把多条 hook 的附加上下文拼成一段（保持配置顺序，空段丢弃）。
 *
 * #64 B1：只消费**语义载荷**（`outcome.semantic`，完整原文），不消费诊断尾部。
 * 超限的 hook 不贡献上下文，但必须留下诊断 —— 否则用户看到「hook 跑了却没生效」
 * 却不知道为什么。
 *
 * #64 B1 自修：字段级裁剪（`truncated`）同样留诊断 —— 语义可信但正文被截，
 * 用户要知道「只喂了前 N 字符」。
 */
function collectContext(agent: Agent, outcomes: HookOutcome[]): string {
  const parts: string[] = [];
  for (const o of outcomes) {
    if (o.kind !== "ok") continue;
    const parsed = parseHookOutput(o.semantic);
    if (parsed.overflow) {
      reportLifecycle(agent, describeSemanticOverflow(o.hook.event, o.hook));
      continue;
    }
    if (parsed.truncated) reportLifecycle(agent, describeContextTruncation(o.hook.event, o.hook));
    if (parsed.text !== "") parts.push(parsed.text);
  }
  return parts.join("\n\n");
}

/**
 * 取最后一条「请求续跑」的 Stop 输出（多条 hook 时后者覆盖前者，与执行顺序一致）。
 *
 * #64 B1：同样只消费语义载荷。超限的 Stop 输出无法判断 decision/reason，
 * 既不续跑也不当成「明确不续跑」—— 必须显式诊断，不能让 Stop 静默失效。
 * reason 被裁剪到 2000 字符时仍续跑，但留一条诊断。
 */
function lastStopRequest(agent: Agent, outcomes: HookOutcome[]): StopBlockRequest {
  let request: StopBlockRequest = { block: false, reason: "" };
  for (const o of outcomes) {
    if (o.kind !== "ok") continue;
    const parsed = parseStopOutput(o.semantic);
    if (parsed.overflow) {
      reportLifecycle(agent, describeSemanticOverflow(o.hook.event, o.hook));
      continue;
    }
    if (parsed.truncated) reportLifecycle(agent, describeReasonTruncation(o.hook.event, o.hook));
    if (parsed.block) request = parsed;
  }
  return request;
}

/** 取第一条非 ok 的诊断理由（exit2 / 失败 / 超时），用于「不续跑但要说清为什么」。 */
function firstOutcomeReason(outcomes: Array<{ kind: string; reason: string }>): string {
  for (const o of outcomes) {
    if (o.kind !== "ok" && o.reason !== "") return o.reason;
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* 真实用户输入的生命周期状态（#64）                                    */
/* ------------------------------------------------------------------ */

/**
 * 一条真实用户输入的生命周期额度。
 *
 * 为什么需要它：`sendTurn` 是**所有**轮次的入口 —— 交互输入、`-p` 输入、
 * ACP `session/prompt`、以及 drive/loop 的内部续跑、Stop 续跑都走它。
 * 但 UserPromptSubmit 与 Stop 额度只属于**真实用户输入**：
 *  - 内部轮不得再发 UserPromptSubmit（否则一次用户输入触发 N 次）；
 *  - 内部轮不得重置 Stop 额度（否则 drive 每轮都能续跑，预算被无限放大）。
 *
 * 所以宿主在发起一条真实用户输入前调 `beginUserTurn()`，之后的内部 `send()`
 * 沿用同一份额度；`sendTurn` 结束时按 `endUserTurn()` 收口。
 * 这是纯状态，不改 drive/loop 的业务行为 —— 它们照旧决定发几轮。
 */
export interface UserTurnState {
  /** 这条用户输入是否已用掉唯一一次 Stop 续跑。 */
  stopContinued: boolean;
  controller: AbortController;
  result?: LifecycleHookResult;
  contextMessage?: Message | null;
  /** 这条用户输入的原文（UPS 载荷用；宿主可提前声明）。 */
  prompt?: string;
  /** #66：运行中转向各自 UPS 的附加上下文（临时，随 endUserTurn 摘除）。 */
  steerContext?: Message[];
}

function newUserTurnState(): UserTurnState {
  return { stopContinued: false, controller: new AbortController() };
}

/**
 * 宿主声明「接下来是一条真实用户输入」。返回本次调用的额度对象。
 *
 * 不传 prompt 时只是重置额度（等价于 `resetUserTurn()`）；传了 prompt 且
 * 宿主希望立刻提交 UPS（`-p` / ACP 的显式入口）时用 `submitUserPrompt()`。
 */
export function beginUserTurn(this: Agent, prompt?: string): UserTurnState {
  endUserTurn.call(this);
  this.userTurn = newUserTurnState();
  this.abort = this.userTurn.controller;
  if (prompt !== undefined) this.userTurn.prompt = prompt;
  return this.userTurn;
}

/** 一条真实用户输入的生命周期结束（宿主在 send 返回后调用）。 */
export function endUserTurn(this: Agent): void {
  if (this.userTurn?.contextMessage) {
    this.dropTransientMessage(this.userTurn.contextMessage);
    this.userTurn.contextMessage = null;
  }
  for (const m of this.userTurn?.steerContext?.splice(0) ?? []) this.dropTransientMessage(m);
  this.userTurn = null;
}

/**
 * 在真实用户输入边界提交 UserPromptSubmit（#64）。
 *
 * 供 `-p` / ACP 这类**显式入口**调用：它们在发请求前就要知道「被阻断了」，
 * 以便映射成非零退出码 / 合法 JSON-RPC 响应。交互式 `send()` 不需要先调它 ——
 * `sendTurn` 会在分类器之前自动补发（`ensureUserPromptSubmit`）。
 *
 * 幂等：同一条用户输入只发一次（缓存完整结果，包括阻断）。
 */
export async function submitUserPrompt(
  this: Agent,
  prompt: string,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return EMPTY;
  if (this.userTurn === null) beginUserTurn.call(this, prompt);
  return ensureUserPromptSubmit.call(this, prompt);
}

/**
 * 必要时补发 UserPromptSubmit（sendTurn 在分类器之前调用）。
 *
 * 已发过（宿主提前提交 / 内部轮）时直接放行，不重复执行 hook。
 * 阻断时**不写历史、不发任何模型请求**（含分类器），并留下可见原因。
 */
export async function ensureUserPromptSubmit(
  this: Agent,
  prompt: string,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return EMPTY;
  const state = this.userTurn ?? (this.userTurn = newUserTurnState());
  if (state.result) {
    if (state.result.context && !state.contextMessage) {
      state.contextMessage = appendLifecycleContext(this, state.result.context);
    }
    return state.result;
  }
  state.result = await runUserPromptSubmit.call(this, state.prompt ?? prompt);
  if (state.result.context) state.contextMessage = this.messages.at(-1) ?? null;
  return state.result;
}

/**
 * #66：运行中转向的 UserPromptSubmit —— 每条注入各跑一次（#64「交互每条输入一次」）。
 *
 * 刻意不走 `ensureUserPromptSubmit`：那份缓存属于本轮发起时的那条输入，复用它等于
 * 让转向绕过用户策略。也不 `beginUserTurn`：不重置 Stop 额度、不另开边界。
 * 附加上下文与本轮那条同口径：临时 system 消息，轮末随 `endUserTurn` 摘除。
 */
export async function runSteerPromptSubmit(
  this: Agent,
  prompt: string,
): Promise<LifecycleHookResult> {
  if (skipForSubagent(this)) return EMPTY;
  const r = await this.runHooks("UserPromptSubmit", null, { prompt }, this.abort?.signal);
  if (r.blocked) return { blocked: true, reason: r.reason, context: "", continue: false };
  const context = collectContext(this, r.outcomes);
  const msg = context === "" ? null : appendLifecycleContext(this, context);
  if (msg && this.userTurn) (this.userTurn.steerContext ??= []).push(msg);
  return { blocked: false, reason: "", context, continue: false };
}
