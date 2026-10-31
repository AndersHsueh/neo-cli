/**
 * Agent 子系统的公开面。
 *
 * 宿主和测试优先从 `src/agent.ts` 导入（历史路径）。新代码可以从这里导入。
 */
export {
  Agent,
  renderFinal,
  type AgentEvent,
  type AgentIO,
  type AgentOptions,
  type PermissionMode,
  type TurnStats,
} from "./loop.ts";
export { decidePermission, type PermissionDecision } from "./policy.ts";
export { CAPABILITY_STREAK_LIMIT, budgetMessage, readGoalSafe } from "./steer.ts";
export { planCompaction, applyCompaction } from "./compact.ts";
