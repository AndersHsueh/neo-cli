/**
 * Agent 的公开契约。
 *
 * 循环实现、压缩、权限都依赖这里的类型，但类型本身不依赖它们。
 * 新增一种宿主能力时，加在 AgentOptions 上，不要把具体模块 import 进循环。
 */
import type { chatStream, Message, ToolSpec } from "../llm.ts";
import type { Config, ModelTier } from "../config.ts";
import type { RuleMatch } from "../rules/index.ts";
import type { Classifier } from "../classifier/index.ts";
import type { AskUserAnswer, AskUserRequest } from "../ui/askUser.ts";
import type { MemoryPort } from "../memory/port.ts";
import type { CheckpointSink } from "../tools/types.ts";
import type { HooksConfig } from "../hooks/types.ts";

export type PermissionMode = "ask" | "auto-edit" | "auto-all" | "plan";

/**
 * Agent 对输出层的最小依赖面。
 *
 * 抽成接口而非直接用 Console 类，是为了让子代理能注入静音实现 ——
 * 子代理的流式输出若直接写终端，会与 readline 管理的光标打架。
 * TS 结构化类型下 Console 自动满足本接口，Console 本体零改动。
 */
export interface AgentIO {
  line(s?: string): void;
  blank(): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  toolHeader(name: string, argsPreview: string): void;
  toolResult(body: string, maxLines?: number, ok?: boolean): void;
  /** 统一缩进（纯格式化，无副作用）。 */
  indent(body: string, prefix?: string): string;
  startSpinner(text: string): void;
  updateSpinner(text: string): void;
  stopSpinner(finalLine?: string): void;
  beginStream(kind: "reasoning" | "answer" | "tool-args"): void;
  writeStream(text: string, kind: "reasoning" | "answer" | "tool-args"): void;
  endStream(kind?: "reasoning" | "answer" | "tool-args", newline?: boolean): void;
  /** 关闭当前打开的流式块（kind 由 Console 自己记录，调用方不再猜）。 */
  ensureStreamClosed(): void;
  /** 与 Console 共享的输出通道（正文经 StreamFormatter 写入时用）。 */
  writeRaw?(s: string): void;
  confirm(question: string): Promise<boolean>;
  readonly width: number;
}

export interface AgentEvent {
  type:
    | "text"
    | "reasoning"
    | "tool_start"
    | "tool_end"
    | "turn_end"
    | "error"
    | "compact"
    | "tier_switch"
    | "aborted"
    /** 规划态变化（issue #14）：data = PlanSnapshot。 */
    | "plan";
  data?: unknown;
}

export interface AgentOptions {
  cfg: Config;
  /** 输出层。主代理传 Console，子代理输出静音（confirm/warn 可委托主 console）。 */
  console: AgentIO;
  mode: PermissionMode;
  systemPrompt: string;
  /**
   * 重渲染完整系统提示词（issue #20）。提供时，模型切换/rename/探针完成/超限校正
   * 都经由它整体重建 messages[0]（含档位重选与项目记忆）；不提供（子代理、测试）则沿用旧行为。
   */
  renderSystemPrompt?: () => string;
  /** 当前会话名（信箱代号）；子代理身份句「你是 X 派出的子代理」用它。缺省/null 回退 neo。 */
  getSessionName?: () => string | null;
  onEvent?: (e: AgentEvent) => void;
  /** 分类器。为 undefined 时不做自动分类。 */
  classifier?: Classifier;
  /**
   * 后台子代理结果注入点（issue #16）。每次请求前调用；返回的文本块作为 user 消息
   * 追加进历史（一次性，宿主负责取走即清）。不传 = 没有后台任务能力。
   */
  pollBackground?: () => string[];
  /**
   * 路径作用域规则（issue #17）：从一次工具调用参数里提取触达路径（返回 cwd 相对）。
   * 由组合根注入，loop 不 import rules 模块（本文件头纪律）。
   */
  toolPathsOf?: (toolName: string, argsJson: string) => string[];
  /**
   * 路径作用域规则（issue #17）：按本会话已触达路径生成「本轮注入文本」与命中记录。
   * 返回 null = 没有命中；不传 = 该能力整体关闭（子代理/测试默认）。
   */
  scopedRulesPrompt?: (touched: string[]) => { text: string; matches: RuleMatch[] } | null;
  /**
   * LLM 流式函数注入点，默认用真实 chatStream。
   * 测试用：避免 mock.module 全局污染其它测试文件（bun test 单进程共享模块表）。
   */
  chatStream?: typeof chatStream;
  /**
   * 记忆端口（v0.2 记忆激活 §7.8.1）。不传 = 无记忆（子代理/task 默认如此）。
   * 记忆是增强项：任何调用失败都不得影响主流程。
   */
  memory?: MemoryPort;
  /**
   * 跨会话消息注入点（PRD v1.2 §4.4 P1）。
   * 只在「本轮已有工具批次结束」的下一次迭代、自动 compact 之后调用；
   * 返回已框架化的 user 内容。回调由组合根注入，agent 不 import 信箱模块。
   */
  pollInbox?: () => string[];
  /**
   * 是否为 task 工具派生的子代理。
   * 只有子代理才应用 TOOL_NAMES_EXCLUDED_FOR_SUBAGENT 过滤；
   * 主代理必须能看到全部运行时注册工具（task / wiki_* / remember / send_message / list_peers）。
   */
  isSubagent?: boolean;
  /**
   * 非交互单次模式（-p）：即使 stdout 是 TTY 也用块级渲染，不逐 chunk 流式输出。
   * 否则 `neo -p` 在真终端里会喷出 spinner/ANSI，脚本与日志都难读。
   */
  nonInteractive?: boolean;
  /**
   * 写文件检查点（P0-4）。主代理由组合根注入会话级 CheckpointStore；
   * 子代理沿用父代理的实例（写入仍记在同一个会话下）。
   */
  checkpoint?: CheckpointSink;
  /**
   * 会话 id（v0.4.1 A1）：只用于轮次诊断日志定位；不传时日志记 "unknown"。
   */
  sessionId?: string;
  /**
   * 上下文窗口探测回调（v0.4.1 A2）：从服务端溢出错误里解析到真实窗口时调用，
   * 组合根负责持久化到 env 事实文件；agent 已先同步更新 cfg.contextWindow。
   */
  onContextLimit?: (tokens: number, model: string) => void;
  /**
   * 压缩生效回调（issue #39）：`applyCompaction` 把 `messages[removedFrom..removedTo]`
   * 换成 1 条摘要（落在 `summaryIndex`）之后调用一次。
   * 组合根用 `RewindLog.noteCompaction` 平移已有轮次的 `messagesBefore`，
   * 否则 `/rewind` 的对话回滚会截到错误位置或静默不回滚。
   * 只在压缩**实际生效后**调用；压缩失败/被跳过时不调。
   */
  onCompacted?: (rec: { removedFrom: number; removedTo: number; summaryIndex: number }) => void;
  /**
   * 输出撞墙回调（P3 / #6）：本轮第一次 `finish_reason === "length"` 时调用。
   * 空正文、非空截断正文、工具轮上的 length 都算同一次命中。
   * 组合根只探测 `/models` 并补 settings 的空字段；不得把本次
   * `usage.completion_tokens` 或请求预算 `max_tokens` 写成能力上限。
   * 同步返回 void —— 探测在后台跑，绝不阻断重试。
   */
  onOutputLimit?: (model: string) => void;
  /**
   * 每轮开始前刷新上下文窗口（v0.4.1 A2）：/model、/tier 切模型后从 env 缓存
   * 重新解析当前模型窗口，避免沿用上一个模型的值。
   */
  refreshContextWindow?: () => void;
  /** 向用户提问（v0.4.1 B2）：仅交互 TUI 注入；ask_user 工具使用。 */
  askUser?: (req: AskUserRequest) => Promise<AskUserAnswer>;
  /** 强制关闭提问模态（用户 abort 时）。 */
  cancelAskUser?: () => void;
  /**
   * 交互式规划工作流（issue #14）：进入规划态前的权限模式。
   *
   * 只由 `/plan` 命令设置（`--plan` / `/mode plan` 是只读闸门，不走这里）。
   * 规划态期间 effective mode 恒为 "plan"，工具清单收窄到只读集合；
   * 用户确认后由宿主调 Agent.approvePlan() 切回这个模式。
   */
  planBaseMode?: PermissionMode;
  /**
   * 模型提交方案后请宿主提示用户确认（issue #14）。
   *
   * 由 exit_plan_mode 触发：宿主负责把「方案待确认」这件事摆到用户眼前
   * （例如提示去 `/plan approve` 开始实施或 `/plan revise` 修改）。
   * 循环**不会**在这里自动批准 —— 批准是用户的动作，不是宿主的。
   */
  requestPlanApproval?: () => void;
  /**
   * 目标锚读取（2026-10-26）。每轮请求前调用一次，结果写进临时 system 提示。
   *
   * 为什么是回调而不是字段：循环不 import mailbox（避免循环依赖），
   * 且目标可能在会话中途被 /goal 改写，每轮现取才能跟上。
   * 返回 null = 未设目标，此时提示退化为纯预算（与旧行为一致）。
   */
  readGoal?: () => string | null;
  /**
   * 生命周期 hooks（issue #3）。会话启动时由组合根从 settings.hooks 解析一次。
   *
   * 不传 = 无 hooks（子代理默认继承主代理的配置，见 task.ts）。
   * 语义硬约束：hooks 只能**阻断**或放行到既有审批流程，永远不能放宽权限 ——
   * 所以 PreToolUse 在 decidePermission 之后、真正执行之前调用：
   * plan 模式下的拒绝发生在 hook 之前，hook 连被调用的机会都没有。
   */
  hooks?: HooksConfig;
}

export interface TurnStats {
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  iterations: number;
  finishReason: string | null;
  aborted: boolean;
  /** 本轮是否发生 LLM 错误（`-p --output-format json` 的退出码依据）。 */
  hadError: boolean;
  /** 人类可读的错误原因；无错误为 null。 */
  errorMessage: string | null;
  /**
   * 空正文终态（v0.4.1 A1）：模型连续两轮没有输出正文。
   * 这类轮次没有 assistant 消息，必须按错误处理，不能报 ok。
   */
  emptyResponse: boolean;
  /** 轮末上下文使用率 0..1（估算值），写诊断日志用。 */
  contextUsage: number;
  /** 本轮因分类而发生的档位切换，无则 null。 */
  tierSwitch: { from: ModelTier; to: ModelTier; reason: string; degraded?: string } | null;
}

/** 给测试和将来的宿主看的循环表面。Agent 类隐式满足它。 */
export interface AgentHost {
  messages: Message[];
  mode: PermissionMode;
  readonly classifier: Classifier | undefined;
  readonly config: Config;
  readonly injectedStreamFn: typeof chatStream | undefined;
  readonly io: AgentIO;
  readonly stats: TurnStats | null;
  readonly toolFailureStreak: number;
  readonly cumulative: { prompt: number; completion: number; reasoning: number };
  readonly historyLength: number;
  readonly lastCompactionInfo: { beforeTokens: number; afterTokens: number } | null;
  toolSpecsFor(): ToolSpec[];
  cancel(): void;
  requestCompact(): void;
  noteModelChange(cfg: Config): void;
  refreshSystemPrompt(): void;
  reset(keepSystem?: boolean): void;
  compactNow(opts?: { from?: number }): Promise<{ beforeTokens: number; afterTokens: number }>;
  compact(opts?: { from?: number }): Promise<boolean>;
  contextUsage(): number;
  send(
    userInput: string | { text: string; images: string[] },
    opts?: { rollbackOnAbort?: boolean },
  ): Promise<TurnStats>;
}
