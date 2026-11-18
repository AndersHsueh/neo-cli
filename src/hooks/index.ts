/**
 * 生命周期 hooks 的对外入口（issue #3）。
 *
 * 组合根（src/index.ts）在启动时 `loadHooksConfig(cfg)` 一次，把结果挂到
 * AgentOptions.hooks 上 —— 会话启动时加载，改配置需重启（与 mcpServers 同口径）。
 */
export {
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  HOOK_EVENTS,
  MAX_HOOK_TIMEOUT_SECONDS,
  NOTIFICATION_REASONS,
  SESSION_START_SOURCES,
  emptyHooksConfig,
  hasAnyHook,
  matchReason,
  matchTool,
  matchTrigger,
  parseHooksConfig,
  type CompactTrigger,
  type HookAdditionalContext,
  type HookDef,
  type HookDispatchResult,
  type HookEvent,
  type HookOnFailure,
  type HookOutcome,
  type HookPayload,
  type HookPayloadBase,
  type HooksConfig,
  type NotificationPayload,
  type NotificationReason,
  type PostToolUsePayload,
  type PreCompactPayload,
  type PreToolUsePayload,
  type SessionStartPayload,
  type SessionStartSource,
  type StopBlockRequest,
  type StopPayload,
  type TurnEndPayload,
  type UserPromptSubmitPayload,
} from "./types.ts";

export {
  describeHook,
  describeOutcome,
  dispatchHooks,
  extractReason,
  hookMatches,
  hooksFor,
  parseHookOutput,
  parseStopOutput,
  runHook,
  type DispatchMatchOptions,
  type RunHookOptions,
} from "./runner.ts";
