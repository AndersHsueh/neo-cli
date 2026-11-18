/**
 * Agent 循环：user → LLM → tool_calls → 执行 → 回填 → LLM → …
 *
 * 上下文控制：
 *  - 每轮前估算 token，超阈值触发压缩（把旧消息总结成一条摘要）。
 *  - reasoning_content 不入历史，避免思维链污染后续轮次。
 *
 * 本文件只负责循环。类型在 types.ts，预算提示在 steer.ts，权限判定在 policy.ts，
 * 压缩切分在 compact.ts。新增一种宿主能力走 AgentOptions 回调，不要把具体模块 import 进来。
 */
import { chatStream, estimateTokens, type Message, type ToolSpec, type Usage } from "../llm.ts";
import type { Classifier } from "../classifier/index.ts";
import { applyTier, type Config } from "../config.ts";
import { toolSpecs, TOOL_NAMES_EXCLUDED_FOR_SUBAGENT } from "../tools/index.ts";
import {
  McpLoadState,
  TOOL_SEARCH_NAME,
  classifyMcpTools,
  isAlwaysLoadServer,
  toolSearchEnabled,
} from "../mcp/toolSearch.ts";
import { ToolError } from "../tools/types.ts";
import { CODE_MODE_TOOL_NAME, codeModeExposed } from "../tools/codeMode.ts";
import { formatModelLine } from "../prompt/modelLine.ts";
import { isRecallMessage } from "../memory/port.ts";
import { applyCompaction, planCompaction } from "./compact.ts";
import { CompactBlockedError } from "./lifecycle.ts";
import {
  PlanSession,
  PLAN_CONTROL_TOOLS,
  effectivePermissionMode,
  filterPlanTools,
  implementationMessage,
  type PlanDraft,
  type PlanSnapshot,
} from "./plan-mode.ts";
import type {
  AgentIO,
  AgentOptions,
  PermissionMode,
  TurnStats,
  UsageBucket,
} from "./types.ts";
import type { RuleMatch } from "../rules/index.ts";
import type { CompactTrigger } from "../hooks/index.ts";
import { hasAnyHook } from "../hooks/index.ts";

import { sendTurn } from "./sendTurn.ts";
import {
  writeTurnLog,
  trimOldToolOutputs,
  emitMemoryCapture,
  budgetMessage,
  noteTouchedPaths,
  toolPathsFor,
  noteToolPaths,
  emitAssistantMessageEvent,
  buildScopedRulesMessage,
  syncScopedRulesMessage,
  dropScopedRulesMessage,
  dropTransientMessage,
  settleToolOutcome,
  makeCtx,
  runHooks,
  emitTurnEndHooks,
  requestPlanApproval
} from "./loopSupport.ts";
import {
  beginUserTurn,
  endUserTurn,
  ensureUserPromptSubmit,
  runPreCompact,
  runSessionStart,
  runStopHooks,
  submitUserPrompt,
  type UserTurnState,
} from "./lifecycle.ts";
export { CompactBlockedError } from "./lifecycle.ts";

export type {
  AgentEvent,
  AgentIO,
  AgentOptions,
  AssistantMessageEventData,
  PermissionMode,
  ToolEndEventData,
  ToolEventStatus,
  ToolStartEventData,
  TurnStats,
} from "./types.ts";
export { renderFinal } from "./render.ts";

export class Agent {
  messages: Message[] = [];
  mode: PermissionMode;
  /** 连续工具失败计数。分类器用它判断当前档位是否撑不住。 */
  consecutiveFailures = 0;
  /**
   * 距上次产出事实的 capability 调用数（2026-10-26）。
   *
   * 只数 capability（shell / send_message / task / use_skill），evidence 一出现就清零。
   * 这是「手段是否已升格成目标」的**唯一可数信号**：跑偏的会话每一步都有真实进展，
   * 心跳满格方向全错，只有「连续几次没产出关于目标的事实」能把它抓出来。
   *
   * 注意：计数本身不拦人，只喂给 budgetMessage 让模型看见。后台默默计数、
   * 到阈值才提示，等于模型全程无感 —— 那和 isStuck 没区别，只是换了判据。
   */
  capabilityStreak = 0;
  /**
   * compact_ctx 工具登记的压缩请求。
   * 工具执行点不是安全切点（assistant(tool_calls) 与 tool 结果尚未配对完），
   * 只能置标记，等工具循环收口后由 runCompactIfRequested() 统一执行。
   */
  compactRequested = false;
  abort: AbortController | null = null;
  totalPrompt = 0;
  totalCompletion = 0;
  totalReasoning = 0;
  /** #59：按实际提供响应的 provider|model 分桶（累计总量仍用上面三个字段）。 */
  usageBuckets: UsageBucket[] = [];
  lastStats: TurnStats | null = null;
  /** 轮次序号：记忆捕获的审计键（会话内递增，不跨会话）。 */
  turnSeq = 0;
  /** 诊断日志的轮次计数（v0.4.1 A1；与记忆 turnSeq 解耦）。 */
  turnCounter = 0;
  /** 最近一次压缩的前后 tokens（只用于本轮诊断日志）。 */
  lastCompact: { beforeTokens: number; afterTokens: number } | null = null;
  /**
   * 交互式规划工作流（issue #14）。null = 不在规划态。
   * 与 `mode` 分开存：`mode` 是只读闸门，这里是「先设计再动手」的会话态。
   */
  planSession: PlanSession | null = null;
  /**
   * 是否有请求在途（issue #20 收尾）。
   *
   * 在途时禁止改写 messages[0]：messages 是**活引用**，工具循环的每次迭代
   * （streamFn 直接收 this.messages）、以及失败重试/降级重发，都会把同一份
   * 数组再发一次 —— 中途改写会让**同一轮里**前面的请求带旧提示词、后面的
   * 请求带新提示词。
   *
   * 窗口 / 模型 / 会话名的变化统一在下一个请求边界生效
   * （send() 开头的 refreshSystemPrompt）。探针回调、切模型、溢出校正
   * 都只改状态，不在流式期间动提示词。
   */
  requestInFlight = false;
  /** 本会话已触达的路径（cwd 相对 POSIX，issue #17）。 */
  touchedPaths = new Set<string>();
  /** 本会话实际注入过的 scoped 规则（/context 展示用）。 */
  loadedRules: RuleMatch[] = [];
  /** 当前在历史里的 scoped 规则临时消息（命中集合变化/轮末时摘除）。 */
  scopedRulesMsg: Message | null = null;
  /**
   * #64：当前这条**真实用户输入**的生命周期额度（UserPromptSubmit 是否已发、
   * Stop 是否已续跑一次）。null = 下一条 `send()` 视为新的真实用户输入。
   * 宿主（drive/loop/`-p`/ACP）用 `beginUserTurn()` 显式声明同一条输入的内部轮。
   */
  userTurn: UserTurnState | null = null;
  /**
   * MCP 工具按需发现（issue #68）：本会话已装入上下文的 MCP 工具名。
   *
   * 只活在内存里 —— 工具表是**进程级全局表**（ACP 一进程可有多会话），
   * 所以「装了什么」必须挂在会话上，不能靠从全局表注销实现。
   * 生命周期：成功压缩、`reset()`（/clear）、会话结束即丢；不写 session meta，
   * resume 回来只保留 alwaysLoad 的工具（需要再搜一次）。
   */
  private mcpLoaded = new McpLoadState();

  constructor(readonly opt: AgentOptions) {
    this.mode = opt.mode;
    this.messages = [{ role: "system", content: opt.systemPrompt }];
    // 规划态由宿主显式开启（/plan）。--plan / /mode plan 不设 planBaseMode，
    // 因此只读闸门不会顺带把会话拖进交互规划工作流。
    if (opt.planBaseMode) this.planSession = new PlanSession(opt.planBaseMode);
    // issue #68：子代理派生时拷贝父会话当时的已加载集合（新 Set，变更不写回父会话）。
    if (opt.mcpLoaded) this.mcpLoaded = opt.mcpLoaded.copy();
  }

  /* ---------------- 交互式规划工作流（issue #14） ---------------- */

  /** 是否处于规划态（澄清中 / 已提交方案）。 */
  get planning(): boolean {
    return this.planSession?.active === true;
  }

  /** 规划态快照；不在规划态返回 null。 */
  get plan(): PlanSnapshot | null {
    return this.planSession?.snapshot() ?? null;
  }

  /** 当前生效的权限模式：规划态恒为 "plan"（借用只读闸门）。 */
  get effectiveMode(): PermissionMode {
    return effectivePermissionMode(this.mode, this.planning);
  }

  /**
   * 进入规划态。base = 进入前的权限模式，确认后切回它。
   * 已在规划态时只更新 base，不重置已提交的方案（重复 /plan 不该丢方案）。
   */
  enterPlan(base: PermissionMode = this.mode): PlanSnapshot {
    if (this.planSession?.active) {
      this.mode = base;
    } else {
      this.planSession = new PlanSession(base);
      this.mode = base;
    }
    return this.emitPlan();
  }

  /** 模型调用 submit_plan：方案进入「待确认」。 */
  submitPlan(draft: PlanDraft): PlanSnapshot {
    if (!this.planSession?.active) throw new Error("当前不在规划态，不能提交方案");
    this.planSession.submit(draft);
    return this.emitPlan();
  }

  /** 用户要求改方案：回到澄清态，保留上一版。 */
  revisePlan(): PlanSnapshot {
    if (!this.planSession?.active) throw new Error("当前不在规划态");
    this.planSession.revise();
    return this.emitPlan();
  }

  /**
   * 用户确认方案 → 离开规划态，权限模式切回进入前的那个，写操作从此放行。
   * 返回 null 表示本来就不在规划态。
   */
  approvePlan(): PlanSnapshot | null {
    const s = this.planSession;
    if (!s?.active) return null;
    const draft = s.draft;
    s.approve();
    this.mode = s.baseMode;
    this.planSession = null;
    this.opt.onEvent?.({ type: "plan", data: { phase: "implementing", baseMode: s.baseMode, draft, revisions: s.revisions } });
    // 把已确认的方案钉进历史：模型下一轮看得见「按这份方案做」，不会自由发挥。
    this.messages.push({ role: "system", content: implementationMessage(draft) });
    return { phase: "implementing", baseMode: s.baseMode, draft, revisions: s.revisions };
  }

  /** 放弃规划态：不切模式、不注入实施提示，直接回到进入前的权限模式。 */
  cancelPlan(): void {
    const s = this.planSession;
    if (!s?.active) return;
    this.mode = s.baseMode;
    this.planSession = null;
    this.opt.onEvent?.({ type: "plan", data: { phase: "implementing", baseMode: s.baseMode, draft: s.draft, revisions: s.revisions } });
  }

  emitPlan(): PlanSnapshot {
    const snap = this.planSession!.snapshot();
    this.opt.onEvent?.({ type: "plan", data: snap });
    return snap;
  }

  /** LLM 流式函数：注入优先，缺省真实实现。 */
  get streamFn(): typeof chatStream {
    return this.opt.chatStream ?? chatStream;
  }

  /**
   * #59：主 Agent 请求专用入口。组合根注入 ModelFallbackController.stream；
   * 未注入时与 streamFn 完全一致（子代理、测试、compact/judge 不受影响）。
   */
  get mainStreamFn(): typeof chatStream {
    return this.opt.mainChatStream ?? this.streamFn;
  }

  get classifier(): Classifier | undefined {
    return this.opt.classifier;
  }

  /** 当前生效配置。子代理（task 工具）据此派生浅拷贝，避免共享可变状态。 */
  get config(): Config {
    return this.opt.cfg;
  }

  /** 测试注入的流式函数（若有）。子代理透传同一注入点，保证测试可脚本化。 */
  get injectedStreamFn(): typeof chatStream | undefined {
    return this.opt.chatStream;
  }

  /** 输出层。子代理的静音实现把 confirm/warn 委托到这里。 */
  get io(): AgentIO {
    return this.opt.console;
  }

  get stats(): TurnStats | null {
    return this.lastStats;
  }

  get toolFailureStreak(): number {
    return this.consecutiveFailures;
  }

  get cumulative(): { prompt: number; completion: number; reasoning: number } {
    return { prompt: this.totalPrompt, completion: this.totalCompletion, reasoning: this.totalReasoning };
  }

  /** #59：逐 provider|model 的用量分桶，按实际提供响应的目标记账。 */
  usageByModel(): UsageBucket[] {
    return this.usageBuckets.map((b) => ({ ...b }));
  }

  /** 只更新分桶，不动累计总量（主循环在 send() 末尾统一累加总量）。 */
  addToBucket(usage: Usage, provider: string, model: string): void {
    let bucket = this.usageBuckets.find((b) => b.provider === provider && b.model === model);
    if (!bucket) {
      bucket = { provider, model, prompt: 0, completion: 0, reasoning: 0 };
      this.usageBuckets.push(bucket);
    }
    bucket.prompt += usage.prompt_tokens ?? 0;
    bucket.completion += usage.completion_tokens ?? 0;
    bucket.reasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;
  }

  /**
   * 把一次**外部单次请求**的 usage 计入本会话累计（issue #50）。
   *
   * `/drive` 的模型判断、压缩摘要这类请求不经过主循环的 `res.usage` 记账路径，
   * 由调用方显式回报；否则 `/cost` 会少算这部分成本。
   * #59：同时按调用时的实际 provider|model 记分桶。
   */
  recordUsage(usage: Usage): void {
    this.totalPrompt += usage.prompt_tokens ?? 0;
    this.totalCompletion += usage.completion_tokens ?? 0;
    this.totalReasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;
    this.addToBucket(usage, this.opt.cfg.providerName, this.opt.cfg.model);
  }

  get historyLength(): number {
    // 不含 system
    return Math.max(0, this.messages.length - 1);
  }

  /**
   * 旁支提问（issue #61）：基于当前上下文回答一个独立问题，**不入历史、不调工具**。
   *
   * 三条硬约束：
   *  - **不入历史**：请求走 `this.messages` 的**快照**（`[...this.messages]`），
   *    绝不 push 回主 messages —— 它是活引用（工具循环/失败重试/降级重发都复用同一份），
   *    push 会污染主上下文，并随 session 落盘。
   *  - **不调工具**：`tools` 传空数组，模型只能纯文本回答。
   *  - **不打断主轮次**：独立的一次请求，不碰主循环的在途状态。
   */
  async askSide(question: string): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
    // 召回注入的临时 system 消息只对主循环有效，不带进旁支快照。
    const snapshot = [...this.messages].filter((m) => !isRecallMessage(m));
    snapshot.push({ role: "user", content: question });
    try {
      const res = await this.streamFn(this.opt.cfg, snapshot, [], {});
      // 记账：旁支请求不经过主循环的 usage 结算，不显式记则 /cost 会少算。
      if (res.usage) this.recordUsage(res.usage);
      const answer = (res.content ?? "").trim();
      if (answer === "") return { ok: false, error: "模型返回了空回答" };
      return { ok: true, answer };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg || "模型调用失败" };
    }
  }

  /** 最近一次压缩的前后 token（/context 展示用）。 */
  get lastCompactionInfo(): { beforeTokens: number; afterTokens: number } | null {
    return this.lastCompact;
  }

  /**
   * 本代理可用的工具集。
   *
   * 只有子代理（task 工具，isSubagent=true）才应用排除表：
   * task 结构性禁止递归派生；compact_ctx / remember / send_message / list_peers
   * 绑定主代理宿主的闭包或信箱身份，子代理调用会产生归属混乱。
   * 主代理必须拿到全量工具 —— v0.2.0 曾把排除表误用于主代理，导致运行时
   * 注册的工具（task/wiki/remember/send_message/list_peers）从未出现在模型工具清单里。
   */
  toolSpecsFor(): ToolSpec[] {
    const all = toolSpecs(this.opt.cfg);
    // 实验性 Code Mode（issue #71）：默认关闭，且只开交互 TUI。
    // -p / ACP（都设 nonInteractive）、规划态、子代理、wiki worker 一律不暴露。
    // 关闭时这里只是多一次纯函数判定，清单与今日逐项相同。
    const codeMode = codeModeExposed(this.opt.cfg, {
      nonInteractive: this.opt.nonInteractive === true,
      isSubagent: this.opt.isSubagent === true,
      planning: this.planning,
    });
    const gate = (specs: ToolSpec[]): ToolSpec[] =>
      codeMode ? specs : specs.filter((s) => s.function.name !== CODE_MODE_TOOL_NAME);
    // 逐次白名单（issue #53）：最后一道过滤，名单外的工具连 schema 都不给。
    const narrow = (specs: ToolSpec[]): ToolSpec[] => {
      const allow = this.opt.toolAllowlist;
      return allow ? specs.filter((s) => allow.includes(s.function.name)) : specs;
    };
    // 规划态（issue #14）：只给只读工具 + 提交/退出方案两个控制工具。
    // 写盘/执行类工具从清单里摘掉，模型不会「先试着调一下再被拒」。
    // issue #68：规划态同样不暴露 MCP 与 tool_search（白名单里本来就没有它们）。
    if (this.planning) return narrow(gate(filterPlanTools(all)));
    // 非规划态不把规划控制工具交给模型：平时调不通，留在清单里只会诱使误调。
    // 主代理仍拿其余全量工具（含运行时注册的 task/wiki/remember 等）。
    // v0.2.0 曾把子代理排除表误用于主代理，导致那些工具从未出现。
    const withoutPlan = all.filter((s) => !PLAN_CONTROL_TOOLS.includes(s.function.name));
    const base = this.opt.isSubagent
      ? withoutPlan.filter((s) => !TOOL_NAMES_EXCLUDED_FOR_SUBAGENT.includes(s.function.name))
      : withoutPlan;
    return narrow(this.deferMcpSpecs(gate(base)));
  }

  /**
   * MCP 工具按需发现（issue #68）：按本会话的已加载集合裁剪 MCP schema。
   *
   * 只裁 **MCP** 工具（`mcp__*`）：第一方工具始终全量，含 `tool_search` 本身。
   * 未启用延迟加载时原样返回（今日行为），连 `tool_search` 也不加 ——
   * 没有目录可搜的工具留在清单里只会诱使模型搜空气。
   *
   * 保留的 MCP 工具 = alwaysLoad（server 级配置）+ 本会话已装入的。
   */
  private deferMcpSpecs(specs: ToolSpec[]): ToolSpec[] {
    const cfg = this.opt.cfg;
    if (!toolSearchEnabled(cfg, specs)) {
      return specs.filter((s) => s.function.name !== TOOL_SEARCH_NAME);
    }
    const loaded = new Set(this.mcpLoaded.snapshot());
    const keep = new Set<string>();
    for (const t of classifyMcpTools(cfg, specs)) {
      if (t.alwaysLoad || loaded.has(t.name)) keep.add(t.name);
    }
    return specs.filter((s) => {
      const name = s.function.name;
      if (!name.startsWith("mcp__")) return true;
      if (keep.has(name)) return true;
      // 名字反解不出 server 的 mcp__* 不归我们延迟（保持可见，宁可多花 token）。
      return !classifyMcpTools(cfg, [s]).some((t) => t.server !== null);
    });
  }

  /** issue #68：把一个 MCP 工具记进本会话的已加载集合（tool_search / 直接点名都走这里）。 */
  markMcpLoaded(name: string): boolean {
    return this.mcpLoaded.mark(name);
  }

  /** issue #68：本会话已装入上下文的 MCP 工具名（/tools、/context、子代理拷贝用）。 */
  mcpLoadedNames(): string[] {
    return this.mcpLoaded.snapshot();
  }

  /** issue #68：当前是否启用 MCP 延迟加载（/tools 文案与目录节共用同一判据）。 */
  get mcpDeferralActive(): boolean {
    return toolSearchEnabled(this.opt.cfg, toolSpecs(this.opt.cfg));
  }

  /** issue #68：该 server 的工具是否常驻（alwaysLoad）。 */
  isMcpServerAlwaysLoad(server: string): boolean {
    return isAlwaysLoadServer(this.opt.cfg, server);
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** compact_ctx 工具经 ctx.host 调用：只登记，不执行。 */
  requestCompact(): void {
    this.compactRequested = true;
  }

  /**
   * 消费压缩标记。在安全切点调用（工具循环收口、下一轮请求之前）。
   * 返回压缩结果；未登记过请求时返回 null。
   */
  async runCompactIfRequested(): Promise<{ beforeTokens: number; afterTokens: number } | null> {
    if (!this.compactRequested) return null;
    this.compactRequested = false;
    try {
      const r = await this.compactNow();
      this.opt.console.info(
        `已按模型请求压缩上下文（${r.beforeTokens} → ${r.afterTokens} tokens 估算）`,
      );
      return r;
    } catch (e) {
      // 压缩失败不终止本轮：如实告知模型，它可自行决定是否重试或放弃。
      this.opt.console.warn(`compact_ctx 执行失败：${(e as Error).message}`);
      this.messages.push({
        role: "system",
        content: `compact_ctx 执行失败：${(e as Error).message}`,
      });
      return null;
    }
  }

  /** 当前会话名，供子代理身份句使用；宿主未提供时为 null（回退 neo）。 */
  get sessionName(): string | null {
    return this.opt.getSessionName?.() ?? null;
  }

  /**
   * 按当前配置整体重建系统提示词（档位、会话名、模型行、项目记忆一并刷新）。
   * 宿主未提供 renderSystemPrompt（子代理/测试）时无事可做。
   * 只替换 messages[0]：必须在请求边界调用，不要在流式响应进行中改写。
   *
   * 在途请求期间调用是**安全无副作用**的：直接返回，不改写 messages[0]
   * （见 requestInFlight）。落下的更新不会丢 —— 下一次请求边界必然按当前
   * cfg 重渲染（PromptManager 的指纹含窗口/来源，cfg 一变指纹就变）。
   */
  refreshSystemPrompt(): void {
    // 请求在途：改写 messages[0] 会让同一轮里的请求带不同的系统提示词。
    if (this.requestInFlight) return;
    const render = this.opt.renderSystemPrompt;
    if (!render) return;
    const sys = this.messages[0];
    if (!sys || sys.role !== "system") return;
    sys.content = render();
  }

  /**
   * 模型 / provider 切换后同步系统提示词。
   * 有宿主渲染器就整体重建（窗口变了档位也要重选）；否则只改写「模型」那一行。
   */
  noteModelChange(cfg: Config): void {
    if (this.opt.renderSystemPrompt) {
      this.refreshSystemPrompt();
      return;
    }
    const sys = this.messages[0];
    if (!sys || sys.role !== "system") return;
    // system 消息恒为 string（结构性约束）；类型扩宽后此处显式收窄
    const current = typeof sys.content === "string" ? sys.content : "";
    const line = formatModelLine(cfg);
    if (/- 模型：[^\n]*/.test(current)) {
      sys.content = current.replace(/- 模型：[^\n]*/, line);
    } else {
      sys.content = `${current}\n\n## 环境\n\n${line}\n`;
    }
  }

  reset(keepSystem = true): void {
    const sys = this.messages[0];
    this.messages = keepSystem && sys?.role === "system" ? [sys] : [];
    // issue #68：/clear 是一次真实的会话重来 —— 已装入的 MCP 工具跟着丢，
    // 只留 alwaysLoad（它们由配置决定，不在这里）。
    this.mcpLoaded.clear();
  }

  /**
   * 压缩核心。把当前非 system 消息替换为一段摘要，原地重写 this.messages。
   *
   * 约束：只能在「历史处于安全切点」时调用 —— 消息序列满足
   * assistant(tool_calls) 与 tool 结果严格配对（如轮次边界、/compact 命令）。
   * 工具循环中途调用会拆散配对，下一轮请求会被服务端以协议错误拒绝。
   * 抛错式：失败向上传，由调用方决定如何呈现。
   */
  async compactNow(
    opts: { from?: number; compactTrigger?: CompactTrigger } = {},
  ): Promise<{ beforeTokens: number; afterTokens: number }> {
    // #64：PreCompact 必须在任何破坏历史/快照的动作之前跑（含 planCompaction 的
    // 切分与摘要请求）。拒绝 → 抛专用错误，调用方原样保留历史与 lastCompact。
    if (!this.abort || (!this.userTurn && this.abort.signal.aborted)) this.abort = new AbortController();
    const signal = this.abort.signal;
    const pre = await this.runPreCompact(opts.compactTrigger ?? "manual");
    signal.throwIfAborted();
    if (pre.blocked) throw new CompactBlockedError(pre.reason);
    const plan = planCompaction(this.messages, opts);
    const budget = Math.min(12_000, Math.floor(this.opt.cfg.contextWindow * 0.2));
    // 附加上下文只喂摘要器：拼在摘要提示之后，不落历史。
    const prompt = pre.context === "" ? plan.prompt : `${plan.prompt}\n\n【hook 附加指令】\n${pre.context}`;
    const res = await this.streamFn(
      { ...this.opt.cfg, maxTokens: budget, temperature: 0.2 },
      [
        { role: "system", content: "你是压缩器，只输出结构化摘要。" },
        { role: "user", content: prompt },
      ],
      [],
      {},
      signal,
    );
    signal.throwIfAborted();
    if (!res.content.trim()) {
      throw new ToolError("压缩器返回了空摘要");
    }

    // 压缩请求本身也花 token：计入累计，否则 /cost 与真实账单对不上（P0-2）。
    if (res.usage) {
      this.totalPrompt += res.usage.prompt_tokens ?? 0;
      this.totalCompletion += res.usage.completion_tokens ?? 0;
      this.totalReasoning += res.usage.completion_tokens_details?.reasoning_tokens ?? 0;
      this.addToBucket(res.usage, this.opt.cfg.providerName, this.opt.cfg.model);
    }

    // v0.2 记忆激活 §7.6.1 T2：压缩前捕获摘要 —— 历史即将被替换，
    // 这轮对话的信息价值最高（决策/踩坑很可能只在这一轮里出现过）。
    this.turnSeq += 1;
    try {
      this.opt.memory?.captureCompact(res.content.trim(), this.turnSeq);
    } catch {
      // 记忆失败不影响压缩
    }

    this.messages = applyCompaction(this.messages, res.content.trim(), plan);
    // issue #68：压缩成功落地后，已装入的 MCP 工具跟着丢（发现它们的消息已被摘要替换，
    // 模型需要重新搜索）。**只在这里清** —— PreCompact 阻断与压缩失败都在上面抛错，
    // 走不到这一行，历史与已加载集合都原样保留。
    this.mcpLoaded.clear();
    // issue #39：压缩把 head 换成 1 条摘要，后续消息整体前移 —— 通知宿主平移轮次下标。
    // issue #46：定点压缩时 head 之前还有 kept 段，被删区间与摘要位置都要跟着后移。
    // 区间取 applyCompaction 的真实形状：system(0) + kept + 摘要 + tail。
    try {
      const removedFrom = 1 + plan.kept.length;
      this.opt.onCompacted?.({
        removedFrom,
        removedTo: removedFrom + plan.head.length - 1,
        summaryIndex: removedFrom,
      });
    } catch {
      // 下标平移失败不影响压缩本身
    }
    const afterTokens = estimateTokens(this.messages);
    this.lastCompact = { beforeTokens: plan.convoTokens, afterTokens };
    this.opt.onEvent?.({ type: "compact", data: { beforeTokens: plan.convoTokens, afterTokens } });
    return { beforeTokens: plan.convoTokens, afterTokens };
  }

  /**
   * 压缩入口（薄壳，保持旧契约）：太短或失败返回 false，不抛错。
   * /compact 命令与自动压缩走这里；工具触发的压缩走 compactNow + 标记收口。
   */
  async compact(opts: { from?: number; compactTrigger?: CompactTrigger } = {}): Promise<boolean> {
    try {
      await this.compactNow(opts);
      return true;
    } catch {
      return false;
    }
  }

  /** 上下文使用率 0..1。 */
  contextUsage(): number {
    // issue #68：与**实际发出去的**工具清单同口径（延迟且未装入的 MCP 不算），
    // 否则压缩点会虚高，模型没用到那么多上下文却被提前压缩。
    const used = estimateTokens(this.messages, this.toolSpecsFor());
    return used / this.opt.cfg.contextWindow;
  }

  /**
   * 轮次开始时的自动分类。
   *
   * 只在这里做，不在工具循环内部做。原因：跨 provider 的对话历史需要格式转换，
   * 一个轮次里反复切换供应商会让转换次数和出错概率都上升。
   * 代价是「工具报错立刻升档」做不到 —— 改为记录失败数，下轮生效。这个代价值得付。
   */
  async classifyTurn(
    userInput: string,
  ): Promise<TurnStats["tierSwitch"]> {
    const cls = this.opt.classifier;
    if (!cls) return null;
    // #59：备用链保持期间自动分类不得把模型切走（会话内保持）。
    if (this.opt.isFallbackActive?.()) return null;

    const cfg = this.opt.cfg;
    const before = cfg.modelTier;

    const decision = await cls.classify(
      userInput,
      before,
      this.contextUsage(),
      this.consecutiveFailures,
    );
    if (!decision || decision.tier === before) {
      // 即便没切档，失败计数也该清零 —— 下一轮是新任务
      this.consecutiveFailures = 0;
      return null;
    }

    const r = applyTier(cfg, decision.tier);
    if (!r.ok) {
      this.opt.console.warn(`分类结果无法应用：${r.error}`);
      this.consecutiveFailures = 0;
      return null;
    }

    this.noteModelChange(cfg);
    this.consecutiveFailures = 0;
    const switchInfo: NonNullable<TurnStats["tierSwitch"]> = {
      from: before,
      to: cfg.modelTier,
      reason: decision.reason,
      ...(r.degraded && r.note ? { degraded: r.note } : {}),
    };
    // v0.4.2：切档在请求前发生，UI 也必须在这一刻知道 —— 不能等 turn 结束才提示。
    this.opt.onEvent?.({ type: "tier_switch", data: switchInfo });
    return switchInfo;
  }

  /** /context 用：本会话已加载的路径作用域规则（含命中原因）。 */
  get activeRules(): RuleMatch[] {
    return this.loadedRules;
  }
  /* ---------------- 生命周期 hooks（issue #3） ---------------- */

  /** hooks 配置（组合根注入；不传 = 无 hooks）。 */
  get hooksConfig(): import("../hooks/types.ts").HooksConfig | undefined {
    return this.opt.hooks;
  }
  /** 是否配了任何 hook（/hooks 与启动提示用）。 */
  get hooksActive(): boolean {
    const h = this.opt.hooks;
    return h !== undefined && hasAnyHook(h);
  }

  /**
   * 发送一条用户消息并跑完整个 agent 循环。
   * 多模态输入（PRD §5.4）：{text, images} → content 组装为 ContentPart[]
   * （text part 在前，image_url parts 随后）；纯文本退化为 string，不破坏现有 provider。
   * 分类器只吃文本（PRD §5.5：图片结构性排除）。
   */
  async send(
    userInput: string | { text: string; images: string[] },
    opts: { rollbackOnAbort?: boolean } = {},
  ): Promise<TurnStats> {
    const ownsBoundary = this.userTurn === null;
    if (ownsBoundary) this.beginUserTurn();
    this.abort = this.userTurn!.controller;
    try {
      return await sendTurn.call(this, userInput, opts);
    } finally {
      if (ownsBoundary) this.endUserTurn();
    }
  }

  writeTurnLog = writeTurnLog;
  trimOldToolOutputs = trimOldToolOutputs;
  emitMemoryCapture = emitMemoryCapture;
  budgetMessage = budgetMessage;
  noteTouchedPaths = noteTouchedPaths;
  toolPathsFor = toolPathsFor;
  noteToolPaths = noteToolPaths;
  emitAssistantMessageEvent = emitAssistantMessageEvent;
  buildScopedRulesMessage = buildScopedRulesMessage;
  syncScopedRulesMessage = syncScopedRulesMessage;
  dropScopedRulesMessage = dropScopedRulesMessage;
  dropTransientMessage = dropTransientMessage;
  settleToolOutcome = settleToolOutcome;
  makeCtx = makeCtx;
  runHooks = runHooks;
  emitTurnEndHooks = emitTurnEndHooks;
  requestPlanApproval = requestPlanApproval;

  /* ---------------- 生命周期 hooks（#64） ---------------- */
  // 会话/用户边界上的四个事件。**不在 constructor 触发 SessionStart**：
  // 构造 Agent 不等于会话开始，宿主必须显式调用 runSessionStart。
  runSessionStart = runSessionStart;
  runStopHooks = runStopHooks;
  runPreCompact = runPreCompact;
  /** 宿主声明「接下来是一条真实用户输入」（内部轮沿用同一份额度）。 */
  beginUserTurn = beginUserTurn;
  /** 一条真实用户输入的生命周期结束。 */
  endUserTurn = endUserTurn;
  /** 显式入口（-p / ACP）在发请求前提交 UserPromptSubmit，幂等。 */
  submitUserPrompt = submitUserPrompt;
  /** sendTurn 在分类器之前补发 UserPromptSubmit（幂等）。 */
  ensureUserPromptSubmit = ensureUserPromptSubmit;
}
