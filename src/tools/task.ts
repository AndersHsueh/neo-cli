/**
 * task 工具：派生一个子代理，在隔离上下文中完成自包含任务，返回最终报告。
 *
 * 设计要点（详见会话讨论）：
 *  - 子代理 = new Agent(...)，复用主循环的全部机制（预算提示 / 自动 compact / abort）。
 *  - 上下文彻底隔离：专用 system prompt，messages 从零开始；工具集裁掉 task 自身，
 *    结构性禁止递归派生（深度 ≤ 1，无运行时计数）。
 *  - 输出静音：子代理的流式渲染不进终端；但 confirm/warn 委托主 console，
 *    否则 ask 模式下子代理的写操作会被静默拒绝，模型只会看到「用户拒绝了」。
 *  - 档位决策三层：主代理在参数里声明（首选，它对任务性质判断最准）→
 *    规则兜底（零成本确定性）→ 沿用主代理当前档位。
 *    刻意不用 LLM 分类器：为派个任务多一次 LLM 往返不值。
 *  - cfg 浅拷贝：applyTier 是原地改写 cfg（config.ts），共享引用会让主代理
 *    下一轮的档位切换污染正在运行的子代理。
 */
import { Agent, type AgentIO } from "../agent.ts";
import { contentText } from "../llm.ts";
import type { Message } from "../llm.ts";
import { applyTier, normalizeTierName, tierAvailable, type Config, type ModelTier } from "../config.ts";
import { resolveAndApplyModelWindow } from "../env/modelWindows.ts";
import { PLAN_ONLY_TOOL_NAMES, TOOL_NAMES_EXCLUDED_FOR_SUBAGENT, toolSpecs } from "./index.ts";
import {
  McpLoadState,
  TOOL_SEARCH_NAME,
  classifyMcpTools,
  toolSearchEnabled,
} from "../mcp/toolSearch.ts";
import { TIER_ORDER } from "../classifier/types.ts";
import { getEnvForPrompt } from "../env/probe.ts";
import { formatEnvPrompt } from "../env/render.ts";
import { normalizePromptTierRequest, renderSubagentPrompt } from "../prompt/subagent.ts";
import { ToolError, type ToolCtx, type ToolImpl } from "./types.ts";
import {
  SUBAGENT_DESCRIPTION_LIMIT,
  type SubagentStopReason,
} from "../hooks/types.ts";

/** 子代理迭代上限。子代理是单一任务，跑满主代理的 80 次迭代意味着早已跑偏。 */
const SUB_MAX_ITERATIONS = 24;

/**
 * 子代理实际可见的工具 schema（预算与提示词「## 工具」节共用这一份）。
 *
 * 与 `Agent.toolSpecsFor()` 同口径：排除表 → plan-only → 白名单 → MCP 延迟裁剪
 * （issue #68）。MCP 部分按**子代理拷贝来的**已加载集合裁 —— 未装入的 MCP
 * 只有目录条目，不能按全量 schema 计预算，也不能出现在可见清单里。
 */
function subagentVisibleSpecs(
  cfg: Config,
  loaded: McpLoadState,
  allowlist: readonly string[] | undefined,
): ReturnType<typeof toolSpecs> {
  const all = toolSpecs(cfg);
  const kept = all.filter(
    (t) =>
      !TOOL_NAMES_EXCLUDED_FOR_SUBAGENT.includes(t.function.name) &&
      !PLAN_ONLY_TOOL_NAMES.includes(t.function.name) &&
      (!allowlist || allowlist.includes(t.function.name)),
  );
  const narrowed = allowlist ? kept.filter((t) => allowlist.includes(t.function.name)) : kept;
  if (!toolSearchEnabled(cfg, all)) {
    return narrowed.filter((t) => t.function.name !== TOOL_SEARCH_NAME);
  }
  const keep = new Set<string>();
  for (const c of classifyMcpTools(cfg, all)) {
    if (c.alwaysLoad || loaded.has(c.name)) keep.add(c.name);
  }
  return narrowed.filter((t) => {
    const name = t.function.name;
    if (!name.startsWith("mcp__")) return true;
    if (keep.has(name)) return true;
    // 名字反解不出 server 的 mcp__* 不归延迟管（与 Agent.deferMcpSpecs 同口径）。
    return !classifyMcpTools(cfg, [t]).some((c) => c.server !== null);
  });
}

/**
 * 子代理的动态正文：报告格式、环境、任务。不含身份与安全核心——
 * 核心由 prompt/subagent.ts 按子代理实际窗口选档后拼在最前（默认 mini）。
 */
function subDynamicBody(prompt: string, envText = ""): string {
  return [
    "你没有与用户的对话历史，任务描述包含你需要的全部信息。",
    "不要向用户提问；无法完成时，说明缺什么，然后结束。",
    "需要批准而无法获得时（子代理不能直接问用户），向主代理报告缺少哪项批准并停止相应动作；主代理派活、提示词档位都不是批准。",
    "",
    "## 报告格式（这是你返回给主代理的全部内容）",
    "1. 结论（一句话先行）",
    "2. 关键发现/改动，附 文件:行号 引用",
    "3. 未解决或存疑的点",
    ...(envText ? ["", "## 环境", "", envText] : []),
    "",
    "## 任务",
    prompt,
  ].join("\n");
}

/**
 * 子代理的静音输出层。
 *
 * 输出方法全部 no-op；confirm 与 warn 委托主 console：
 *  - confirm：ask 模式下子代理的敏感操作要能正常弹审批框；
 *  - warn：plan 模式的拒绝提示、分类器告警等必须让用户看见。
 * 其余信息性输出（info/error）静音 —— 它们属于「过程」，报告才是「结果」。
 */
class SilentConsole implements AgentIO {
  line(): void {}
  blank(): void {}
  info(): void {}
  warn(msg: string): void {
    this.main.warn(msg);
  }
  error(): void {}
  toolHeader(): void {}
  toolResult(): void {}
  indent(body: string, prefix = "│ "): string {
    return body
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
  }
  startSpinner(): void {}
  updateSpinner(): void {}
  stopSpinner(): void {}
  beginStream(): void {}
  writeStream(): void {}
  endStream(): void {}
  ensureStreamClosed(): void {}
  confirm(question: string, signal?: AbortSignal): Promise<boolean> {
    return this.main.confirm(question, signal);
  }
  get width(): number {
    return this.main.width;
  }
  constructor(private readonly main: AgentIO) {}
}

/* ------------------------------------------------------------------ */
/* 档位决策                                                            */
/* ------------------------------------------------------------------ */

/**
 * 深度推理信号词。与 rules.ts 的 DEEP_STRONG/DEEP_WEAK 同源，
 * 按子代理语义合并 —— 子代理任务由主代理起草，措辞常带动词性描述，
 * 「review/审查/评估/对比」这类弱信号在任务描述里出现时基本是真需求。
 */
const DEEP_WORDS = [
  "架构", "设计", "重构", "根因", "排查", "权衡", "迁移", "选型",
  "design", "architecture", "refactor", "trade-off", "tradeoff",
  "review", "审查", "评估", "对比",
];

/**
 * 机械操作信号词。与 rules.ts 的 FAST_SIGNALS 同源（节选高频项）。
 * 注意顺序：decideSubTier 里深度信号优先于机械信号 ——
 * 主代理起草的任务描述几乎必然带「找/查/列」这类动词，
 * 机械信号的误报率天然偏高，所以先判深度。
 */
const FAST_WORDS = [
  "列一下", "列下", "读一下", "读下", "看一下", "看下", "统计",
  "有多少", "几个", "grep", "找一下", "查一下", "找所有", "列出所有",
  "改个名", "重命名", "格式", "大小", "搜索",
];

interface TierDecision {
  tier: ModelTier;
  source: "declared" | "rule" | "inherit";
  reason: string;
}

function hitWords(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

/**
 * 子代理档位决策。
 *
 * 返回 source: "inherit" 表示沿用主代理当前档位 —— 三种情况：
 *  1. 主代理显式传了 tier: "inherit"；
 *  2. 声明的档位在当前路由下不可用（tierAvailable 为 false）；
 *  3. 未声明且无信号词命中。
 * 此时静默沿用而非报错：子代理是优化层，不能因档位配置问题拖垮任务。
 */
export function decideSubTier(
  prompt: string,
  declared: string | undefined,
  cfg: Config,
): TierDecision {
  const current = cfg.modelTier;
  const available = (t: ModelTier) => tierAvailable(cfg, t);

  // 第一层：主代理声明。它刚写完任务描述，对任务性质判断上下文最完整。
  if (declared && declared !== "inherit") {
    // 接受 deep/bal/fast 等简写；配置路由仍用规范 deep_reasoning。
    const t = normalizeTierName(declared);
    if (t && TIER_ORDER.includes(t)) {
      if (available(t)) {
        const label = declared === t ? declared : `${declared}（${t}）`;
        return { tier: t, source: "declared", reason: `主代理声明 ${label}` };
      }
      return { tier: current, source: "inherit", reason: `声明的 ${t} 不可用，沿用主代理档位` };
    }
    throw new ToolError(
      `无效的 tier "${declared}"。可用值：fast, balanced, default, deep/deep_reasoning, inherit`,
    );
  }

  // 第二层：规则兜底。深度信号优先于机械信号（理由见 FAST_WORDS 注释）。
  // 目标档不可用时直接沿用，不向上找 —— 子代理任务短，升档收益有限，
  // 而误升到付费档是实打实的成本。
  if (hitWords(prompt, DEEP_WORDS) && available("deep_reasoning")) {
    return { tier: "deep_reasoning", source: "rule", reason: "任务含深度推理信号词" };
  }
  if (hitWords(prompt, FAST_WORDS) && available("fast")) {
    return { tier: "fast", source: "rule", reason: "任务为机械读写操作" };
  }

  return { tier: current, source: "inherit", reason: "无信号命中，沿用主代理档位" };
}

/** 供测试与 /why 展示：档位决策的可读描述。 */
export function describeTierDecision(d: TierDecision): string {
  return `[task] 子代理档位 ${d.tier}（${d.source}）：${d.reason}`;
}

/* ------------------------------------------------------------------ */
/* 子代理运行                                                          */
/* ------------------------------------------------------------------ */

/**
 * 子代理运行的可选参数（issue #53 起）。
 *
 * 不传 = 旧行为：全量工具减排除表、审批委托主 console、失败返回文本。
 */
export interface SubagentRunOptions {
  /** 逐次工具白名单：schema 与 dispatch 两层同时收窄（职责收窄，不是安全边界）。 */
  toolAllowlist?: readonly string[];
  /** 子代理审批（不传 = 旧行为：委托主 console）。worker 传恒拒。 */
  approve?: (tool: string, detail: string, signal?: AbortSignal) => Promise<boolean>;
  /** wiki_write 的跨进程写锁（只有后台 wiki 维护 worker 传）。 */
  wikiWriteLock?: ToolCtx["wikiWriteLock"];
  /** true：子代理 stats.aborted 或 hadError 时抛 Error（而不是返回文本）。 */
  failOnError?: boolean;
  /**
   * 后台 `/tasks` 或续跑时传入已有的 `bg-N`。不传则前台在真正打出 Start 时分配 `sg-N`。
   * 不要给前台编假的 `bg-N`。
   */
  jobId?: string;
  /**
   * 是否在父会话打 SubagentStart / SubagentStop。默认 true。
   * wiki 维护 worker 必须传 false：产品上不算子代理，且关闭时不消耗 `sg-N`。
   */
  emitSubagentHooks?: boolean;
}

/** 按父代理实例计数的前台 task_id（`sg-N`）。只在真正打出 Start 时递增。 */
const foregroundSgSeq = new WeakMap<Agent, number>();

function allocateForegroundTaskId(main: Agent): string {
  const n = (foregroundSgSeq.get(main) ?? 0) + 1;
  foregroundSgSeq.set(main, n);
  return `sg-${n}`;
}

function truncateSubagentDescription(prompt: string): string {
  return prompt.length <= SUBAGENT_DESCRIPTION_LIMIT ? prompt : prompt.slice(0, SUBAGENT_DESCRIPTION_LIMIT);
}

/** #86：Stop.reason 决策。aborted 一律 cancelled，即使同时 hadError。 */
export function subagentStopReason(stats: { aborted: boolean; hadError: boolean }): SubagentStopReason {
  if (stats.aborted) return "cancelled";
  if (stats.hadError) return "error";
  return "completed";
}

function isResumeRun(resume?: { messages?: Message[] }): boolean {
  return Boolean(resume?.messages && resume.messages.length > 0);
}

async function emitSubagentHook(
  main: Agent,
  event: "SubagentStart" | "SubagentStop",
  fields: { task_id: string; description: string; reason?: SubagentStopReason },
  signal?: AbortSignal,
): Promise<void> {
  await main.runHooks(
    event,
    null,
    {
      agent_type: "task",
      agent_name: "",
      task_id: fields.task_id,
      description: fields.description,
      ...(event === "SubagentStop" ? { reason: fields.reason } : {}),
    },
    signal,
    null,
    { agentType: "task" },
  );
}

/**
 * 运行一个子代理任务，返回最终报告文本。
 * 由组合根注入主代理引用后装配成 task 工具。
 */
export async function runSubagent(
  main: Agent,
  prompt: string,
  declaredTier: string | undefined,
  ctx: ToolCtx,
  declaredPromptTier?: string,
  /**
   * 续聊（issue #48）：已有的子代理 messages。传了就**接着这份历史跑**，
   * 不再从零 new Agent；不传 = 旧行为（从零起跑）。
   *
   * 只用于 `/tasks chat`，`task` 工具本身永远从零 —— 子代理的隔离性是它的核心契约。
   */
  resume?: {
    /** 已有历史；不传 = 从零起跑（旧行为）。 */
    messages?: Message[];
    /** 跑完把最终 messages 交回去（调用方负责落盘）。 */
    onMessages?: (messages: Message[]) => void;
  },
  /** issue #53：白名单 / 审批 / 写锁 / 失败即抛。不传 = 旧行为。 */
  opts?: SubagentRunOptions,
): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new ToolError("prompt 不能为空 —— 子代理没有主代理的上下文，空任务无法执行");
  }

  const cfg = main.config;
  const decision = decideSubTier(trimmed, declaredTier, cfg);

  // 浅拷贝：applyTier 原地改写 cfg 顶层标量，共享引用会互相污染。
  const subCfg: Config = {
    ...cfg,
    modelTier: decision.tier,
    maxToolIterations: Math.min(SUB_MAX_ITERATIONS, cfg.maxToolIterations),
  };
  const applied = applyTier(subCfg, decision.tier);
  if (!applied.ok) {
    // 决策时 tierAvailable 已通过，到这里失败属于配置在运行间隙被改动 —— 如实上报。
    throw new ToolError(`子代理档位应用失败：${applied.error}`);
  }

  // 子代理可能换了模型：按它自己的 env 事实重新解析窗口与来源，不沿用主代理的值。
  // （applyTier 只改 contextWindow 数值；来源要重算，否则主代理的「已探测」会冒充子模型。）
  resolveAndApplyModelWindow(subCfg);

  const promptTierReq = normalizePromptTierRequest(declaredPromptTier);
  if (promptTierReq === null) {
    throw new ToolError(`无效的 prompt_tier "${declaredPromptTier}"。可用值：auto, standard, full`);
  }

  // v0.4.0 平台适配层：子代理同样会调用 shell，必须知道真实平台/shell（紧凑版，省 token）。
  let subEnvText = "";
  if (cfg.env?.prompt !== false) {
    try {
      const snap = getEnvForPrompt(cfg);
      if (snap) subEnvText = formatEnvPrompt(snap, { compact: true });
    } catch {
      subEnvText = "";
    }
  }
  // issue #68：子代理拷贝父会话**当时**的已加载集合（新 Set，不共享引用）。
  // 理由：父代理已经为这些 schema 付过 token，子代理重搜一遍纯属浪费；
  // 而共享引用会让子代理的搜索写回父会话 —— 隔离性是子代理的核心契约。
  // 自带 tool_search（Agent.toolSpecsFor 在延迟加载启用时总会加上它），
  // 所以子代理仍能自己装入更多，只是那些装入只活在子代理里。
  const subMcpLoaded = new McpLoadState();
  for (const name of main.mcpLoadedNames()) subMcpLoaded.mark(name);

  // 子代理实际可见的工具 schema 计入预算（排除表与 Agent.toolSpecsFor 一致）。
  // issue #53：传了 toolAllowlist 时同样收窄 —— 预算必须按真实可见集算。
  // issue #68：MCP schema 同样按「已装入」收窄 —— 预算不能按全量目录算。
  const subTools = subagentVisibleSpecs(subCfg, subMcpLoaded, opts?.toolAllowlist);
  const subPrompt = renderSubagentPrompt({
    parentSessionName: main.sessionName,
    window: subCfg.contextWindow,
    source: subCfg.contextWindowSource,
    tools: subTools,
    dynamicBody: subDynamicBody(trimmed, subEnvText),
    request: promptTierReq,
    taskText: trimmed,
    config: subCfg.systemPrompt,
  });
  // 要求的档位在子模型窗口里放不下：不降低控制要求，也不硬跑，交回主代理收窄任务。
  if (!subPrompt.selection.fits && subPrompt.requiredTier !== "mini") {
    throw new ToolError(
      `子代理需要 ${subPrompt.requiredTier} 档提示词，但其模型窗口放不下（${subPrompt.selection.reason}）。` +
        `请收窄为只读/短任务，或指定窗口更大的 tier 后重试；不要用更短的提示词绕过控制要求。`,
    );
  }
  // 续聊（issue #48）：有历史就复用它的系统提示词，保证「还是同一个子代理」。
  const resumedSystem = resume?.messages?.find((m) => m.role === "system");
  const effectiveSystemPrompt =
    resumedSystem && typeof resumedSystem.content === "string" ? resumedSystem.content : subPrompt.text;

  const sub = new Agent({
    cfg: subCfg,
    console: new SilentConsole(main.io),
    mode: main.mode,
    systemPrompt: effectiveSystemPrompt,
    chatStream: main.injectedStreamFn,
    isSubagent: true,
    // 子代理的写操作也进父会话的检查点（/undo 能一起恢复）
    checkpoint: ctx.checkpoint,
    // issue #53：白名单与写锁透传（不传 = 旧行为）。
    ...(opts?.toolAllowlist ? { toolAllowlist: opts.toolAllowlist } : {}),
    ...(opts?.wikiWriteLock ? { wikiWriteLock: opts.wikiWriteLock } : {}),
    ...(opts?.approve ? { approve: opts.approve } : {}),
    // 生命周期 hooks（issue #3）：子代理的工具调用同样触发 Pre/PostToolUse ——
    // 子代理是「同一次用户请求里的工具执行」，绕过 hook 等于给 hook 留了一条
    // 结构性旁路（危险命令派给子代理跑就躲过了拦截）。
    // TurnEnd 则在 Agent.emitTurnEndHooks 里按 isSubagent 跳过：
    // 子代理的回合不是用户眼里的回合，一次请求触发 N+1 次没有意义。
    hooks: main.hooksConfig,
    // issue #68：拷贝来的已加载集合（Agent 构造时再 copy 一次，两边都不共享引用）。
    mcpLoaded: subMcpLoaded,
    // 不传 classifier：子代理任务短，内部切档收益趋近于零，
    // 且分类器依赖连续失败计数等主循环状态，子代理里没有意义。
  });

  // abort 链路：父任务被 Ctrl+C 打断时，子代理一并取消。
  const onAbort = () => sub.cancel();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  // 续聊（issue #48）：把已有历史灌进子代理，再追加本轮用户消息。
  // 放在 send 之前 —— send 会把新消息 push 到 messages 末尾，历史必须先就位。
  if (resume?.messages && resume.messages.length > 0) {
    sub.messages = resume.messages.map((m) => ({ ...m }));
  }

  // #86：校验已通过（空 prompt / 档位 / 提示词档位放不下都已在前面抛错）。
  // Start 只在真正派出时打；续跑不打第二次 Start，但结束仍打 Stop。
  // wiki worker 传 emitSubagentHooks: false，既不打 hook 也不消耗 sg-N。
  const description = truncateSubagentDescription(trimmed);
  const emitHooks = opts?.emitSubagentHooks !== false;
  const resumed = isResumeRun(resume);
  let hookStarted = false;
  let taskId = "";
  let stopReason: SubagentStopReason = "error";
  if (emitHooks) {
    if (!resumed) {
      taskId = opts?.jobId ?? allocateForegroundTaskId(main);
      await emitSubagentHook(main, "SubagentStart", { task_id: taskId, description }, ctx.signal);
      hookStarted = true;
    } else {
      taskId = opts?.jobId ?? "";
      hookStarted = true;
    }
  }

  try {
    const stats = await sub.send(trimmed);
    stopReason = subagentStopReason(stats);
    // issue #53：worker 需要「失败就是失败」，不能把中止/出错当成功文本返回。
    if (opts?.failOnError) {
      if (stats.aborted) throw new Error("子代理被取消");
      if (stats.hadError) throw new Error(stats.errorMessage ?? "子代理执行失败");
    }

    // 报告 = 子代理最后一条非空 assistant 正文。
    // 中间轮次的 assistant 消息要么带 tool_calls（内容是给工具的旁白），
    // 要么是空正文 —— 都不该混进报告。
    const body = sub.messages
      .filter((m) => m.role === "assistant" && (contentText(m.content) ?? "").trim() !== "" && !m.tool_calls)
      .map((m) => contentText(m.content) ?? "")
      .pop();
    const report = (body ?? "").trim();
    const usage =
      `— 子代理用量: prompt ${stats.promptTokens} / completion ${stats.completionTokens} tokens, ` +
      `${stats.iterations} 轮, 档位 ${subCfg.modelTier} → ${subCfg.model}（${decision.source}）`;

    if (!report) {
      return `子代理未产出任何报告（finishReason=${stats.finishReason ?? "unknown"}）。${usage}`;
    }
    return `${report}\n\n${usage}`;
  } catch (e) {
    if (stopReason === "error" && (ctx.signal?.aborted === true)) {
      stopReason = "cancelled";
    }
    throw e;
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    // #86：Stop 放在 finally，且只在已经打过 Start（或续跑约定要打 Stop）时成对出现。
    if (hookStarted) {
      try {
        // 子代理被取消时 ctx.signal 已经 aborted；若把它传给 hook，
        // Stop 脚本会立刻被杀掉，调用方就看不到结束事件。
        const stopSignal = ctx.signal?.aborted ? undefined : ctx.signal;
        await emitSubagentHook(main, "SubagentStop", { task_id: taskId, description, reason: stopReason }, stopSignal);
      } catch {
        /* hook 分发已在 runHooks 内收敛，这里再兜一层，不掩盖任务结果 */
      }
    }
    // issue #48：把最终 messages 交回调用方（落盘供续聊）。失败不阻断任务。
    try {
      resume?.onMessages?.(sub.messages);
    } catch {
      /* 落盘是增强项 */
    }
  }
}

/**
 * task 工具定义。deps.run 由组合根注入，避免本模块直接依赖主代理实例。
 */
export function makeTaskTool(deps: {
  run: (prompt: string, tier: string | undefined, ctx: ToolCtx, promptTier?: string) => Promise<string>;
  /**
   * 后台模式（issue #16）。不传 = 只有同步模式（子代理、测试的裸装配）。
   * 传了才允许 `background: true`：立刻返回任务 id，子代理在后台跑。
   */
  background?: {
    launch: (job: { prompt: string; tier?: string; promptTier?: string; ctx: ToolCtx }) =>
      | { ok: true; id: string }
      | { ok: false; error: string };
  };
}): ToolImpl {
  return {
    // 敏感性取决于子代理内部做了什么，task 调用本身不敏感：
    // ask 模式下子代理的写操作会在子代理内部弹审批（confirm 委托主 console），
    // 若这里也标 sensitive，用户要为同一次写操作点两次批准。
    sensitive: false,
    kind: "capability",
    spec: {
      type: "function",
      function: {
        name: "task",
        description:
          "派生一个子代理，在独立上下文中完成一项自包含任务，只把最终报告返回给你。" +
          "适合：大范围代码探索、批量机械读写、跑测试并汇总结果 —— 子代理烧掉的上下文不占用你的窗口。" +
          "任务描述必须自包含：子代理看不到与用户的对话历史。" +
          "tier 参数决定子代理用哪档模型（档位名，实际模型由该档位的路由配置解析）：机械读写用 fast 档（廉价模型）省钱，" +
          "深度推理用 deep（deep_reasoning）档（强推理模型），不确定就留空（自动按任务措辞判断，无信号则沿用当前档位）。",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "自包含的任务描述。包含子代理需要的全部背景、目标与验收标准",
            },
            tier: {
              type: "string",
              enum: ["fast", "balanced", "default", "deep", "deep_reasoning", "inherit"],
              description: "子代理模型档位。机械读写任务选 fast，深度推理选 deep（deep_reasoning）；留空自动判断",
            },
            background: {
              type: "boolean",
              description:
                "true = 后台跑：立刻返回任务 id，子代理在后台探索，完成后结果自动注入本会话（主会话继续推理不阻塞）。" +
                "适合耗时探索/批量读写；需要马上拿到结果才能继续的任务请留空（同步模式）。",
            },
            prompt_tier: {
              type: "string",
              enum: ["auto", "standard", "full"],
              description:
                "子代理的系统提示词详细程度，默认 auto（精简版，省上下文）。写重要文件、高后果操作、长时间自治的任务用 standard；" +
                "边界/授权特别复杂时用 full。这只是约束细化，不增加权限，也不等于用户批准。",
            },
          },
          required: ["prompt"],
        },
      },
    },
    async execute(args, ctx) {
      const prompt = String(args["prompt"] ?? "");
      const tierRaw = args["tier"];
      const tier = typeof tierRaw === "string" && tierRaw.trim() !== "" ? tierRaw.trim() : undefined;
      const label = tier ? `tier=${tier}` : "tier=auto";
      const ptRaw = args["prompt_tier"];
      const promptTier = typeof ptRaw === "string" && ptRaw.trim() !== "" ? ptRaw.trim() : undefined;
      if (args["background"] === true) {
        if (!deps.background) {
          throw new ToolError("当前装配不支持后台子代理（background 未接线）");
        }
        if (!prompt.trim()) throw new ToolError("prompt 不能为空 —— 子代理没有主代理的上下文");
        const launched = deps.background.launch({ prompt, tier, promptTier, ctx });
        if (!launched.ok) throw new ToolError(launched.error);
        return (
          `后台子代理已启动（id=${launched.id}，${label}）。` +
          "主会话可以继续；完成后结果会自动注入。用 /tasks 查看进度，/tasks cancel 取消。"
        );
      }
      ctx.onProgress?.(`子代理运行中（${label}）…`);
      return deps.run(prompt, tier, ctx, promptTier);
    },
  };
}
