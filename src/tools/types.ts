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
import type { PlanDraft } from "../agent/plan-mode.ts";

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

/**
 * 规划态宿主能力（issue #14）。结构化类型，避免工具层反向依赖 agent/plan-mode.ts。
 * 只有处于规划态的主代理会满足它；其余宿主（子代理 / 测试裸 ctx）不传。
 */
export interface PlanHost {
  /** 提交方案：进入「待用户确认」。 */
  submitPlan(draft: PlanDraft): unknown;
  /** 请求开始实施：宿主负责切回进入前的权限模式并注入实施提示。 */
  requestPlanApproval(): unknown;
  /** 当前是否仍在规划态。 */
  readonly planning: boolean;
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
  /**
   * 规划态宿主（issue #14，可选）。submit_plan / exit_plan_mode 用它改会话态；
   * 不传 = 当前不在规划态，两个工具会明确报错而不是假装成功。
   */
  planHost?: PlanHost;
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
  /**
   * 生命周期 hooks（issue #3）：PreToolUse 检查。
   *
   * 返回 null = 放行；返回字符串 = 阻断，字符串是回给模型的原因。
   *
   * **不要直接调用它** —— 用 `ctx.gate()`。gate 保证「审批在前、hook 在后」：
   * hook 只能拦，不能放行，顺序颠倒就等于让 hook 成了权限旁路。
   */
  preToolUse?: (tool: string, args: Record<string, unknown>) => Promise<string | null>;
  /**
   * 生命周期 hooks：PostToolUse 通知（工具执行完成后，含成功/失败）。
   *
   * 返回值 = 需要追加到工具结果末尾的诊断（onFailure=block 时非空）：
   * 工具已经跑完、无法撤销，所以「阻断」在这里的定义是**把失败原因交给模型**，
   * 由 dispatch 追加到 tool 结果并标记 ok:false。
   */
  postToolUse?: (
    tool: string,
    args: Record<string, unknown>,
    result: { ok: boolean; output: string; truncated: boolean },
  ) => Promise<string | null>;
}

/**
 * 审批 + PreToolUse 的唯一入口（issue #3）。
 *
 * 为什么要有它：审批散落在各工具实现里（write_file / edit_file / shell / MCP 工具
 * 各自算 detail 再 ctx.approve），而 hook 必须在审批**之后**、真正执行**之前**跑。
 * 如果让 dispatch 层统一调 preToolUse，它必然早于工具内部的审批 ——
 * 用户拒绝时 hook 已经执行过（副作用不可撤回），顺序就错了。
 *
 * 所以把顺序固化成一个函数：先 approve，通过了才跑 hook。
 *  - 无审批的工具（read_file 等）直接调 gate(tool, args)，detail 传空串；
 *  - 有审批的工具把原来的 ctx.approve(...) 换成 gate(...)，语义不变。
 *
 * 返回 null = 放行；返回字符串 = 不执行，字符串是回给模型的原因
 * （用户拒绝 / plan 拒绝 / hook 阻断三种情况，文案各自可读）。
 */
export async function gateTool(
  ctx: ToolCtx,
  tool: string,
  args: Record<string, unknown>,
  detail?: string,
): Promise<string | null> {
  if (detail !== undefined) {
    const ok = await ctx.approve(tool, detail);
    if (!ok) return `用户拒绝了该操作，未执行（${tool}）。`;
  }
  if (ctx.preToolUse) {
    const blocked = await ctx.preToolUse(tool, args);
    if (blocked !== null) return `已被 PreToolUse hook 阻断：${blocked}`;
  }
  return null;
}

/**
 * 工具实现里「没执行」的唯一出口（issue #3 收口）。
 *
 * 为什么不能直接 `return gateTool(...)` 的结果：dispatch 把所有正常返回都当成
 * 「工具执行完成」，随后无条件跑 PostToolUse。而 gateTool 的非 null 返回值恰好
 * 表示**根本没执行**（用户拒绝 / plan 拒绝 / Pre 阻断）—— 直接返回字符串会让
 * 被拒绝、被阻断的调用照样触发 PostToolUse，Post 的载荷还会谎称 ok:true。
 *
 * 所以「没执行」必须走异常通道（ToolError），由 dispatch 的 catch 分支原样回填
 * 原因、且**不跑 Post**。用 ToolError 而不是裸 Error：dispatch 对它的处理是
 * 「错误: <原因>」原样交给模型，与旧行为一致，ok 也仍是 false。
 *
 * 标记用不可枚举 Symbol：dispatch 靠它区分「工具跑过但失败」与「压根没跑」，
 * 不靠文案匹配（文案会随语言/措辞变化）。不导出 Symbol 本身，只导出判定函数。
 */
const NOT_EXECUTED = Symbol("neo.notExecuted");

export function notExecuted(reason: string): never {
  const err = new ToolError(reason);
  Object.defineProperty(err, NOT_EXECUTED, { value: true, enumerable: false });
  throw err;
}

/** 这个 ToolError 是否表示「工具根本没执行」（用户拒绝 / plan 拒绝 / Pre 阻断）。 */
export function isNotExecuted(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[NOT_EXECUTED] === true;
}

/**
 * 工具的手段/目标分层（2026-10-26）。
 *
 * 为什么需要：跑偏的会话不是「不干活」，而是**手段逐步升格成目标**
 * （找出作者 → 拿到答案 → 打通外部连接 → 连 DNS 找出口）。
 * 每步都有真实进展，心跳满格方向全错。这里给工具打标签，
 * 让宿主能数出「连续几次只扩展手段、没产出事实」。
 *
 * - `evidence`：产出关于世界的事实（读文件、搜索、抓网页）。
 * - `capability`：只扩展「能做什么」，不直接产出事实（shell 外联、
 *   发消息找外援、派子代理、加载技能）。
 * - `neither`：交付或管理动作，不参与偏离判定（写文件、记忆、压缩、提问）。
 *
 * 注意 `shell` 归 capability 而非 evidence：它能 `cat` 也能 `curl`，
 * 宿主无法在分类层面区分。规则是「**连续** N 次 capability 无 evidence」，
 * 偶尔用 shell 查东西不会触发，连续用才会 —— 这正是要抓的形态。
 */
export type ToolKind = "evidence" | "capability" | "neither";

export interface ToolImpl {
  spec: ToolSpec;
  /** 是否属于敏感操作（需要审批）。 */
  sensitive: boolean;
  /** 手段/目标分层。缺省视为 "neither"（不参与偏离判定）。 */
  kind?: ToolKind;
  /**
   * 是否可与同批次相邻的其它可并行工具**同时执行**（issue #11）。
   *
   * 缺省 false —— 默认串行是安全侧：新工具忘了标，代价只是慢一点；
   * 标错成 true 的代价是写操作乱序，那不可接受。
   *
   * 只有「纯读、无副作用、不依赖前序工具结果」的工具才该标 true：
   * read_file / list_dir / glob / grep / web_fetch / web_search / wiki_search。
   * 特别注意 use_skill（首次加载会建软链）、compact_ctx（改宿主状态）、
   * remember / wiki_write / send_message（写盘/发消息）都**不是**只读。
   *
   * 注意：该标记只影响**本地调度**。请求体里的 parallel_tool_calls 由
   * cfg.parallelToolCalls 决定（见 src/llm.ts buildBody）。
   */
  parallelizable?: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string> | string;
}

export interface DispatchResult {
  ok: boolean;
  output: string;
  truncated: boolean;
  /**
   * 工具是否**真的被执行过**（issue #3，2026-11-07）。
   *
   * 缺省（undefined）= 执行过 —— 绝大多数结果都是「跑完了，成功或失败」。
   * 只有「没执行」的路径显式置 false：用户拒绝 / plan 拒绝 / PreToolUse 阻断
   * （含 MCP 工具），以及参数非法、未知工具这类**连工具都没进**的调用。
   *
   * 为什么需要它：ok:false 把两种完全不同的情况混在一起 ——
   *  - 工具跑了但失败（edit_file 找不到 old_string）：说明模型的手段有问题，该记失败；
   *  - 根本没跑（用户拒绝）：模型什么都没试过，把这次算成「失败」会让
   *    连续失败计数虚高，进而误触发降档。
   * 主循环据此让连续失败计数对「没执行」保持中性（见 Agent.settleToolOutcome）。
   */
  executed?: boolean;
}
