/**
 * 兼容入口。
 *
 * 循环实现在 `src/agent/loop.ts`。测试、task 工具和文档里的 `src/agent.ts`
 * 继续从这里导入，避免一次拆分改掉所有调用点。
 */
export {
  Agent,
  renderFinal,
  type AgentEvent,
  type AgentIO,
  type AgentOptions,
  type PermissionMode,
  type TurnStats,
} from "./agent/loop.ts";
export { toolNames } from "./tools/index.ts";
export { renderPlan, type PlanDraft, type PlanSnapshot } from "./agent/plan-mode.ts";
export { c } from "./ui/theme.ts";
