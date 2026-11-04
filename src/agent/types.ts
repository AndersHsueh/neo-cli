/**
 * Agent 的公开契约。
 *
 * 循环实现、压缩、权限都依赖这里的类型，但类型本身不依赖它们。
 * 新增一种宿主能力时，加在 AgentOptions 上，不要把具体模块 import 进循环。
 */
import type { chatStream, Message, ToolSpec } from "../llm.ts";
import type { Config, ModelTier } from "../config.ts";
import type { Classifier } from "../classifier/index.ts";
import type { AskUserAnswer, AskUserRequest } from "../ui/askUser.ts";
import type { MemoryPort } from "../memory/port.ts";
import type { CheckpointSink } from "../tools/types.ts";

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
    | "aborted";
  data?: unknown;
}

export interface AgentOptions {
  cfg: Config;
  /** 输出层。主代理传 Console，子代理输出静音（confirm/warn 可委托主 console）。 */
  console: AgentIO;
  mode: PermissionMode;
  systemPrompt: string;
  onEvent?: (e: AgentEvent) => void;
  /** 分类器。为 undefined 时不做自动分类。 */
  classifier?: Classifier;
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
   * 输出撞墙回调（P3）：`finish_reason === "length"` 且正文为空时调用一次，
   * 组合根负责探测模型输出上限并补进 settings 的空字段。
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
   * 目标锚读取（2026-10-26）。每轮请求前调用一次，结果写进临时 system 提示。
   *
   * 为什么是回调而不是字段：循环不 import mailbox（避免循环依赖），
   * 且目标可能在会话中途被 /goal 改写，每轮现取才能跟上。
   * 返回 null = 未设目标，此时提示退化为纯预算（与旧行为一致）。
   */
  readGoal?: () => string | null;
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
  reset(keepSystem?: boolean): void;
  compactNow(): Promise<{ beforeTokens: number; afterTokens: number }>;
  compact(): Promise<boolean>;
  contextUsage(): number;
  send(
    userInput: string | { text: string; images: string[] },
    opts?: { rollbackOnAbort?: boolean },
  ): Promise<TurnStats>;
}
