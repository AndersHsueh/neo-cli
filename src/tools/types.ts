/**
 * 工具层基础类型与注册表 —— 故意做成零内部依赖的叶子模块。
 *
 * 为什么单独拆出来：task 工具需要构造 Agent，而 Agent 又 import 工具集，
 * 直接放在 index.ts 会形成 task → agent → tools/index → task 的循环依赖。
 * 把类型与注册表下沉到叶子模块后，依赖链变成：
 *   types.ts（叶子）← agent.ts ← task.ts ← index.ts（组合根）
 * 循环消失，且 agent.ts 对工具层的依赖只剩类型与注册表，更干净。
 */
import type { ToolSpec } from "../llm.ts";
import type { Config } from "../config.ts";
import type { AskUserAnswer, AskUserRequest } from "../ui/askUser.ts";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * 宿主代理暴露给工具的最小能力面（结构化类型，Agent 隐式满足，无需 import）。
 * 定义成接口而非直接引用 Agent：types.ts 是叶子模块，
 * 反向依赖 agent.ts 会复活 task → agent → tools 的循环依赖。
 */
export interface CompactHost {
  /** 登记一次上下文压缩请求；宿主在安全时机（工具循环收口）统一执行。 */
  requestCompact(): void;
}

/** 写文件检查点（P0-4）。结构化类型，避免工具层反向依赖 checkpoint 模块。 */
export interface CheckpointSink {
  beforeWrite(path: string, op: string): unknown;
}

export interface ToolCtx {
  cfg: Config;
  /** 敏感操作审批，返回 true 才执行。 */
  approve: (tool: string, detail: string) => Promise<boolean>;
  /**
   * 写盘前的检查点入口（可选）。write_file / edit_file 在审批通过后调用；
   * 不传 = 不做快照（测试裸 ctx / 子代理未接线时）。
   */
  checkpoint?: CheckpointSink;
  /**
   * 宿主代理（可选，测试的裸 ctx 可不传）。compact_ctx 用它登记压缩请求。
   */
  host?: CompactHost;
  /** 取消信号（Ctrl+C）。 */
  signal?: AbortSignal;
  /** plan 模式（只读）：禁止一切写盘副作用，包括工具输出落盘。 */
  readOnly?: boolean;
  /** 由 agent 注入，让工具能观察取消。 */
  onNotice?: (msg: string) => void;
  /**
   * 长任务进度上报（可选）。
   * task 工具用它把子代理的轮次进度推进到主循环的 spinner 上，
   * 否则子代理运行的几分钟里终端会显得像死掉了。
   */
  onProgress?: (msg: string) => void;
  /**
   * 向用户提问（v0.4.1 B2，仅交互 TUI 注入）。ask_user 工具用它打开模态；
   * 不传 = 非交互环境，工具会明确报错。
   */
  askUser?: (req: AskUserRequest) => Promise<AskUserAnswer>;
  /** 强制关闭当前提问模态（宿主 abort 时用）。 */
  cancelAskUser?: () => void;
}

export interface ToolImpl {
  spec: ToolSpec;
  /** 是否属于敏感操作（需要审批）。 */
  sensitive: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string> | string;
}

export interface DispatchResult {
  ok: boolean;
  output: string;
  truncated: boolean;
}
