/** Agent 回合支持方法：日志、钩子、路径与收尾。 */
import { contentText, type Message, type StreamResult } from "../llm.ts";
import { toolKindOf } from "../tools/index.ts";
import type { ToolCtx } from "../tools/types.ts";
import { appendTurnLog } from "../turnDiagnostics.ts";
import { decidePermission } from "./policy.ts";
import { planModeMessage } from "./plan-mode.ts";
import { budgetMessage as buildBudgetMessage, readGoalSafe } from "./steer.ts";
import type {
  AssistantMessageEventData,
  TurnStats,
} from "./types.ts";
import {
  dispatchHooks,
  describeOutcome,
  hasAnyHook,
  type HookEvent,
  type HookPayload,
  type NotificationReason,
} from "../hooks/index.ts";

import type { Agent } from "./loop.ts";

export function writeTurnLog(this: Agent, stats: TurnStats): void {
    // 没有会话 id = 测试/裸 Agent：不写盘，避免单测污染用户 ~/.neo/logs。
    if (!this.opt.sessionId) return;
    appendTurnLog({
      sessionId: this.opt.sessionId,
      turn: this.turnCounter,
      provider: this.opt.cfg.providerName,
      model: this.opt.cfg.model,
      durationMs: stats.durationMs,
      iterations: stats.iterations,
      toolCalls: stats.toolCalls,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      reasoningTokens: stats.reasoningTokens,
      finishReason: stats.finishReason,
      aborted: stats.aborted,
      hadError: stats.hadError,
      emptyResponse: stats.emptyResponse,
      errorMessage: stats.errorMessage,
      contextWindow: this.opt.cfg.contextWindow,
      contextUsage: stats.contextUsage,
      ...(this.lastCompact
        ? { compaction: { before: this.lastCompact.beforeTokens, after: this.lastCompact.afterTokens } }
        : {}),
    });
  }

  /**
   * 上下文溢出兜底（A2）：压缩不可用时，把最老的一批 tool 输出替换为占位文本。
   * 只动 tool content，不改角色/配对，消息序列仍然合法。
   */
export function trimOldToolOutputs(this: Agent, keepRecent = 6): void {
    const toolIndices: number[] = [];
    this.messages.forEach((m, i) => {
      if (m.role === "tool") toolIndices.push(i);
    });
    const drop = Math.max(0, toolIndices.length - Math.max(0, keepRecent));
    for (let k = 0; k < drop; k++) {
      const idx = toolIndices[k];
      if (idx === undefined) continue;
      const m = this.messages[idx];
      if (!m) continue;
      const before = contentText(m.content)?.length ?? 0;
      m.content = `[旧工具输出已裁剪以适配上下文（原 ${before} 字符）；如需重看请重新调用工具]`;
    }
  }

  /**
   * 轮末捕获入口（§7.6.1 T1 / abort）。
   * fire-and-forget：捕获内部有队列与失败降级，绝不允许异常冒泡到主循环。
   */
export function emitMemoryCapture(this: Agent, turnStart: number, kind: "turn" | "aborted"): void {
    const mem = this.opt.memory;
    if (!mem) return;
    this.turnSeq += 1;
    try {
      mem.capture({
        kind,
        messages: this.messages.slice(turnStart),
        turn: this.turnSeq,
        ...(this.lastStats
          ? {
              stats: {
                toolCalls: this.lastStats.toolCalls,
                iterations: this.lastStats.iterations,
                aborted: this.lastStats.aborted,
                finishReason: this.lastStats.finishReason,
              },
            }
          : {}),
      });
    } catch {
      // 捕获失败静默：记忆不是主流程的一部分
    }
  }

  /**
   * 构造本轮预算 + 目标提示。
   *
   * 每次请求前注入、请求后移除，模型因此始终知道「这是第几次、还剩几次」。
   * 剩余 ≤ 5 时额外给出明确次数并要求收敛 —— 只写「即将耗尽」模型无法判断
   * 还能做几件事，往往会继续探索，最后被硬截断，用户拿到半截答案。
   *
   * 2026-10-26 追加目标锚：只报消耗量不够。跑偏的会话每步都有进展
   * （DNS 解析成功、拿到 IP 都是真的），心跳满格方向全错。把原始目标
   * 每轮摆在这里，是给模型一个「离目标多远」的信号，而不只是「还剩几步」。
   * 目标由用户/宿主写入，模型只读 —— 提示里明确写出这一点，防止它自行重述。
   */
export function budgetMessage(this: Agent, attempt: number, max: number): Message {
    const base = buildBudgetMessage(attempt, max, readGoalSafe(this.opt.readGoal), this.capabilityStreak);
    // 规划态约束（issue #14）：每轮请求前注入、请求后摘除。
    // 不写进系统提示 —— 系统提示是会话级的，进出规划态反复改写会与
    // noteModelChange 的正则改写互相踩。
    const plan = this.planSession?.snapshot();
    if (!plan) return base;
    const text = typeof base.content === "string" ? base.content : "";
    return { role: "system", content: `${text}\n\n${planModeMessage(plan)}` };
  }


  /**
   * 记下本会话触达的路径（issue #17）。归一由宿主完成，这里只去重。
   * 来源：工具参数（read/write/edit/list/glob/grep）+ 用户 `@` 引用。
   */
export function noteTouchedPaths(this: Agent, paths: string[]): void {
    for (const raw of paths) {
      if (raw !== "") this.touchedPaths.add(raw);
    }
  }

  /**
   * #37：取一次工具调用涉及的原始路径值（组合根会交给 clipPaths 归一化）。
   * 未注入 toolPathsOf 时返回空数组；与 noteToolPaths 共用同一提取器，
   * 保证事件里的 paths 与 scoped-rules 触达集合来源一致。
   */
export function toolPathsFor(this: Agent, name: string, argsJson: string): string[] {
    return this.opt.toolPathsOf?.(name, argsJson) ?? [];
  }

export function noteToolPaths(this: Agent, name: string, argsJson: string): void {
    this.noteTouchedPaths(this.toolPathsFor(name, argsJson));
  }

  /**
   * #37：每次完整模型响应成功后发内部 assistant_message 事件。
   *
   * tool_calls 严格按 res.toolCalls 原序，arguments 用原字符串（不解析、不脱敏 ——
   * 脱敏与 4000 code point 截断是 streamJson 边界的职责）。
   * 不含 reasoning / thinkingBlocks / raw / 签名思考块。
   */
export function emitAssistantMessageEvent(this: Agent, res: StreamResult): void {
    const data: AssistantMessageEventData = {
      content: res.content,
      tool_calls: res.toolCalls.map((call) => ({
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      finish_reason: res.finishReason,
    };
    this.opt.onEvent?.({ type: "assistant_message", data });
  }

  /** 本轮要注入的 scoped 规则消息；没配置 / 没触达 / 没命中 → null（并清空已加载记录）。 */
export function buildScopedRulesMessage(this: Agent): Message | null {
    const build = this.opt.scopedRulesPrompt;
    if (!build || this.touchedPaths.size === 0) {
      this.loadedRules = [];
      return null;
    }
    const built = build([...this.touchedPaths]);
    this.loadedRules = built?.matches ?? [];
    return built && built.text !== "" ? { role: "system", content: built.text } : null;
  }

  /**
   * 按当前触达路径同步历史里的 scoped 规则消息：命中集合变了才换，没命中就摘掉。
   * 内容相同不重推 —— 否则每轮都会在历史尾部堆一条一样的 system 消息。
   */
export function syncScopedRulesMessage(this: Agent): void {
    const next = this.buildScopedRulesMessage();
    const nextText = next && typeof next.content === "string" ? next.content : null;
    const curText =
      this.scopedRulesMsg && typeof this.scopedRulesMsg.content === "string"
        ? this.scopedRulesMsg.content
        : null;
    if (nextText === null) {
      this.dropScopedRulesMessage();
      return;
    }
    if (nextText === curText) return;
    this.dropScopedRulesMessage();
    this.messages.push(next!);
    this.scopedRulesMsg = next!;
  }

  /** 摘掉历史里的 scoped 规则临时消息（命中集合变化 / 轮末）。 */
export function dropScopedRulesMessage(this: Agent): void {
    if (this.scopedRulesMsg) this.dropTransientMessage(this.scopedRulesMsg);
    this.scopedRulesMsg = null;
  }

/** 移除临时消息（预算提示 / 重试提示）。按引用比对，避免误删历史里内容相同的消息。 */
export function dropTransientMessage(this: Agent, msg: Message): void {
    const i = this.messages.lastIndexOf(msg);
    if (i !== -1) this.messages.splice(i, 1);
  }

  /**
   * 单次工具结果的记账（issue #11 抽出：串行与并行段共用，保证两条路径口径一致）。
   *
   *  - 连续失败计数：分类器据此判断当前档位是否撑不住。成功即清零，只关心连续失败。
   *  - 手段/目标分层计数（2026-10-26）：evidence 产出即清零，capability 累加，
   *    neither 不影响（交付/管理动作不算漂移）。
   * 并行段内按 tool_calls 原序逐条调用，结果与串行实现逐条等价。
   *
   * ## 「没执行」保持中性（2026-11-07，issue #3）
   *
   * 用户拒绝 / plan 拒绝 / PreToolUse 阻断（含 MCP）的调用 ok 是 false，但工具
   * 一行都没跑 —— 这不是「模型的手段失败了」，而是「这次尝试没被允许」。
   * 旧口径把它算进连续失败，实测「拒绝 3 次 shell → streak=3」，
   * 分类器据此降档，等于用用户的拒绝去惩罚模型。
   *
   * 所以 executed === false 时**既不累加也不清零**：中性。
   *  - 不清零：拒绝不该抹掉此前真实的失败信号（失败 + 拒绝 → 仍是 1）；
   *  - 不累加：拒绝本身也不是失败证据。
   * 真失败（工具跑过但失败）仍累加，成功仍清零 —— 只有「没执行」这一种情况例外。
   *
   * capabilityStreak 不受影响：它数的是「连续扩展手段」，与这次调用是否被允许无关，
   * 保持改前口径（拒绝的 shell 照样算一次 capability）。
   */
export function settleToolOutcome(this: Agent, name: string, ok: boolean, executed = true): void {
    if (executed) {
      if (ok) {
        this.consecutiveFailures = 0;
      } else {
        this.consecutiveFailures++;
      }
    }
    const kind = toolKindOf(name);
    if (kind === "evidence") {
      this.capabilityStreak = 0;
    } else if (kind === "capability") {
      this.capabilityStreak++;
    }
  }

export function makeCtx(this: Agent, signal: AbortSignal): ToolCtx {
    // 规划态借用只读闸门：approve 与 readOnly 都按生效模式判定，
    // 避免「工具清单已收窄、审批却还按旧模式放行」的第二条旁路。
    const mode = this.effectiveMode;
    const ui = this.opt.console;
    return {
      cfg: this.opt.cfg,
      signal,
      host: this,
      checkpoint: this.opt.checkpoint,
      approve: async (tool, detail) => {
        const decision = decidePermission(mode, tool);
        if (decision.allow) return true;
        if (decision.reason === "plan") {
          ui.warn(`plan 模式禁止 ${tool}：${detail}`);
          return false;
        }
        // Notification（issue #56）：在**弹审批框之前**发通知。
        // 顺序是硬约束 —— 用户已经在点确认时通知才来就没有意义了；
        // 也正因为 PreToolUse 在审批之后，通知只能挂在这里，不能挂 hook 链上。
        // 通知失败只进诊断，绝不阻断审批（见 runHooks 的 Notification 分支）。
        await this.runHooks(
          "Notification",
          tool,
          { reason: "permission_prompt", tool_name: tool, tool_input: detail },
          signal,
          "permission_prompt",
        );
        return ui.confirm(`${tool} — ${detail}`);
      },
      onNotice: (m) => ui.info(m),
      onProgress: (m) => ui.updateSpinner(m),
      askUser: this.opt.askUser,
      cancelAskUser: this.opt.cancelAskUser,
      readOnly: mode === "plan",
      // 生命周期 hooks（issue #3）：PreToolUse 由工具层在**审批通过之后**调用
      // （gateTool，见 tools/types.ts）。顺序是硬约束 —— 先权限后 hook，
      // hook 才不可能把调用升级成免审批；plan 模式的拒绝发生在 decidePermission
      // 里，hook 连被调用的机会都没有。
      preToolUse: async (tool, args) => {
        const r = await this.runHooks("PreToolUse", tool, { tool_input: args }, signal);
        if (!r.blocked) return null;
        return r.reason;
      },
      postToolUse: async (tool, args, result) => {
        const r = await this.runHooks(
          "PostToolUse",
          tool,
          {
            tool_input: args,
            ok: result.ok,
            result: result.output.slice(0, 2000),
            truncated: result.truncated,
          },
          signal,
        );
        // onFailure=block：工具已执行、无法撤销，所以「阻断」= 把原因交给模型。
        // dispatch 会把它追加到 tool 结果并标记 ok:false（见 applyPostHook）。
        if (!r.blocked) return null;
        return `[hook PostToolUse failed: ${r.reason}]`;
      },
      planHost: this.planning
        ? {
            planning: true,
            submitPlan: (draft) => this.submitPlan(draft),
            requestPlanApproval: () => this.requestPlanApproval(),
          }
        : undefined,
    };
  }



  /**
   * 执行一个 hook 事件。
   *
   * 三条硬约束都落在这里：
   *  1. **plan 只读**：生效模式为 plan 时一律不执行 —— hook 是用户脚本，
   *     我们无法保证它不写盘，而 plan 是对用户的只读承诺。宁可少跑一次 hook，
   *     也不能让「只读审查」留下副作用。被拒绝的工具调用因此也不会触发 PostToolUse。
   *     Notification 与其它事件同口径：plan 下不跑（plan 下工具被直接拒绝、
   *     根本不会弹审批框，permission_prompt 天然不触发）。
   *  2. **永不抛错**：hook 失败/超时只进诊断，不拖垮主循环。
   *  3. **可读诊断**：阻断原因、失败、超时都经 console.warn 让人看见（verbose 可关）。
   *
   * `reason` 只对 Notification 有意义（matcher 的匹配对象），其它事件传 null。
   */
export async function runHooks(this: Agent, 
    event: HookEvent,
    tool: string | null,
    extra: Record<string, unknown>,
    signal?: AbortSignal,
    reason: NotificationReason | null = null,
  ): Promise<{ blocked: boolean; reason: string }> {
    const cfg = this.opt.hooks;
    if (!cfg || !hasAnyHook(cfg)) return { blocked: false, reason: "" };
    if (this.effectiveMode === "plan") return { blocked: false, reason: "" };

    const base = {
      session_id: this.opt.sessionId ?? "unknown",
      cwd: this.opt.cfg.cwd,
      mode: this.effectiveMode,
      subagent: this.opt.isSubagent === true,
      turn: this.turnCounter,
    };
    const payload = { event, ...base, ...extra } as unknown as HookPayload;

    let r;
    try {
      r = await dispatchHooks(cfg, event, payload, tool, this.opt.cfg, signal ? { signal } : {}, reason);
    } catch (e) {
      // dispatchHooks 内部已收敛，这里只是最后一道保险。
      this.opt.console.warn(`${event} hook 分发异常（已忽略）：${(e as Error).message}`);
      return { blocked: false, reason: "" };
    }

    if (cfg.verbose) {
      for (const o of r.outcomes) {
        if (o.kind === "ok") continue;
        this.opt.console.warn(describeOutcome(o));
      }
    }
    if (r.blocked && tool !== null) {
      this.opt.console.warn(`${event} hook 阻断了 ${tool}：${r.reason}`);
    }
    return { blocked: r.blocked, reason: r.reason };
  }

  /**
   * 轮末 TurnEnd（issue #3）。
   *
   * 只在**主代理**的回合结束时触发：子代理的 send() 也会走到这里，
   * 但子代理的「回合」不是用户眼里的回合 —— 让 TurnEnd 在子代理里也跑，
   * 一次用户请求会触发 N+1 次，且子代理的统计会污染用户的 hook 逻辑。
   * Pre/PostToolUse 则相反：子代理的工具调用同样触发（见 makeCtx）。
   *
   * 返回非 null = 有 onFailure=block 的 TurnEnd hook 失败，字符串是给用户/模型的
   * 诊断（调用方会把它并进 errorMessage 并标 hadError）。
   */
  /**
   * 轮末 TurnEnd（issue #3）+ Notification 的 turn_end（issue #56）。
   *
   * 只在**主代理**的回合结束时触发：子代理的 send() 也会走到这里，
   * 但子代理的「回合」不是用户眼里的回合 —— 让它们在子代理里也跑，
   * 一次用户请求会触发 N+1 次，且子代理的统计会污染用户的 hook 逻辑。
   * Pre/PostToolUse 则相反：子代理的工具调用同样触发（见 makeCtx）。
   *
   * 两个事件并存且独立：TurnEnd 面向模型/统计（可 onFailure=block），
   * Notification 面向「人」（恒不阻断）。通知先发 —— 它是给人看的提醒，
   * 不该被 TurnEnd hook 的失败拖住。
   *
   * 返回非 null = 有 onFailure=block 的 TurnEnd hook 失败，字符串是给用户/模型的
   * 诊断（调用方会把它并进 errorMessage 并标 hadError）。
   */
export async function emitTurnEndHooks(this: Agent, stats: TurnStats): Promise<string | null> {
    if (this.opt.isSubagent) return null;
    await this.runHooks("Notification", null, { reason: "turn_end" }, undefined, "turn_end");
    const r = await this.runHooks("TurnEnd", null, {
      turn_stats: {
        finish_reason: stats.finishReason,
        tool_calls: stats.toolCalls,
        iterations: stats.iterations,
        aborted: stats.aborted,
        had_error: stats.hadError,
        error_message: stats.errorMessage,
      },
    });
    if (!r.blocked) return null;
    return `[hook TurnEnd failed: ${r.reason}]`;
  }

  /**
   * 模型请求开始实施（exit_plan_mode）。
   *
   * 宿主（index.ts）注入的确认回调负责问用户并调 approvePlan()；
   * 没有注入时只发事件，由宿主的事件监听兜底 —— 绝不在这里自动批准，
   * 那等于把「用户确认」这一步删掉。
   */
export function requestPlanApproval(this: Agent): void {
    this.opt.onEvent?.({ type: "plan", data: { ...this.planSession?.snapshot(), requestApproval: true } });
    this.opt.requestPlanApproval?.();
  }
