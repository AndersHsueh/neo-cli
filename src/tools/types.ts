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

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolCtx {
  cfg: Config;
  /** 敏感操作审批，返回 true 才执行。 */
  approve: (tool: string, detail: string) => Promise<boolean>;
  /** 取消信号（Ctrl+C）。 */
  signal?: AbortSignal;
  /** 由 agent 注入，让工具能观察取消。 */
  onNotice?: (msg: string) => void;
  /**
   * 长任务进度上报（可选）。
   * task 工具用它把子代理的轮次进度推进到主循环的 spinner 上，
   * 否则子代理运行的几分钟里终端会显得像死掉了。
   */
  onProgress?: (msg: string) => void;
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
