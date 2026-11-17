/**
 * ACP 一轮 prompt 的收口（issue #60，PRD §2.8 / 复审 R8、R9、第三轮 N2）。
 *
 * 从 `session.ts` 拆出来的纯逻辑：给定 `send()` 与几个回调，决定这一轮回什么
 * stopReason、何时排空通知与落盘、失败时抛什么。不碰 Agent / 进程，便于单测注入。
 */
import { RequestError } from "@agentclientprotocol/sdk";
import type { TurnStats } from "../agent/types.ts";

/**
 * `session/prompt` 的 stopReason（与 ACP v1 的 `StopReason` 对齐）。
 *
 * 只有「正常终止」才走这里；引擎失败（hadError / emptyResponse / 抛出的非取消异常）
 * 必须变成 JSON-RPC 错误，不得伪装成 `end_turn`（R9）。
 */
export type AcpStopReason = "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal";

export interface AcpTurnDeps {
  /** 跑一轮（生产里是 `agent.send`）。 */
  send(text: string): Promise<TurnStats>;
  /** 等通知队列排空：prompt 的响应必须晚于本轮全部 `session/update`。 */
  flush?: () => Promise<void>;
  /** 会话落盘（内部已吞异常）。 */
  persist(): void;
  /** 本轮是否被 `session/cancel` / dispose 取消。 */
  cancelled(): boolean;
  maxToolIterations: number;
  /** 最后一次模型响应是否是「无工具调用的正文」收口（N2：用满迭代但已作答不算撞上限）。 */
  answeredLastIteration(): boolean;
}

/**
 * 把一轮的 stats 映射成 stopReason。顺序有讲究：
 *  1. 取消优先 —— 取消不是错误，也不是「正常结束」；
 *  2. 工具迭代上限**排在 hadError 之前**：撞上限时 `sendTurn` 的收口兜底常同时置
 *     hadError（「循环结束却没有最终正文」），客户端该看到 `max_turn_requests`；
 *     但最后一轮已正常作答时不算撞上限（N2）；
 *  3. `length` 截断 → `max_tokens`；
 *  4. `content_filter` / `refusal` → `refusal`；
 *  5. 其余 hadError / emptyResponse → 抛错（空响应的 finishReason 可能是 `stop`）。
 */
function stopReasonOf(stats: TurnStats, deps: AcpTurnDeps): AcpStopReason {
  if (deps.cancelled() || stats.aborted) return "cancelled";
  const hitIterationLimit =
    stats.iterations >= deps.maxToolIterations && stats.toolCalls > 0 && !deps.answeredLastIteration();
  if (hitIterationLimit) return "max_turn_requests";
  if (stats.finishReason === "length") return "max_tokens";
  if (stats.finishReason === "content_filter" || stats.finishReason === "refusal") return "refusal";
  if (stats.hadError || stats.emptyResponse) {
    throw new Error(stats.errorMessage ?? "模型本轮没有产出可用结果（引擎报告失败）");
  }
  return "end_turn";
}

/** 跑一轮：无论成功、失败还是抛错，都先排空通知、再落盘，最后返回或抛出。 */
export async function runAcpTurn(text: string, deps: AcpTurnDeps): Promise<AcpStopReason> {
  let stats: TurnStats;
  try {
    stats = await deps.send(text);
  } finally {
    await deps.flush?.();
    deps.persist();
  }
  return stopReasonOf(stats, deps);
}

/** server 侧：非 RequestError 的异常统一转成 -32603（R9：不得伪装 end_turn）。 */
export function acpPromptError(e: unknown): RequestError {
  if (e instanceof RequestError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return RequestError.internalError(undefined, `本轮失败：${message}`);
}
