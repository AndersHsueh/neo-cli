/**
 * ACP 后续规格（issue #80）：斜杠命令广告、会话档位、上下文用量。
 *
 * 从 `server.ts` 拆出来的纯映射层：只做「neo 的既有概念 → ACP 协议对象」，
 * 不碰连接、不碰 Agent 装配。这样 server.ts 只负责注册方法与排队通知，
 * 本文件可被单测直接调用。
 *
 * 三条硬口径：
 *  1. 命令清单**只来自** `src/input/commands.ts` 的 COMMANDS —— 不发明新命令，
 *     也不过滤（ACP 客户端把广告的命令直接当 `/xxx` 发回来，少一条就是少一条）；
 *  2. 档位只用 neo 已有的四个名字（ask / auto-edit / auto-all / plan），
 *     不引入 Claude 的 acceptEdits / bypassPermissions 之类；
 *  3. 用量是**真实计量**：`used` 由 `estimateTokens(messages, 当前工具规格)` 算出，
 *     `size` 是 `cfg.contextWindow`，不编数字。
 */
import type { AvailableCommand, SessionMode, SessionModeState, UsageUpdate } from "@agentclientprotocol/sdk";
import { COMMANDS } from "../input/commands.ts";
import { estimateTokens, type Message, type ToolSpec } from "../llm.ts";
import type { PermissionMode } from "../agent/types.ts";

/** 合法档位（顺序即客户端展示顺序，与 `/mode` 选择器一致）。 */
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto-edit", "auto-all", "plan"];

/** 档位说明：与 `/mode` 选择器的 hint 同一措辞，客户端不必自己编。 */
const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: "写文件/执行命令都需批准",
  "auto-edit": "自动批准写文件，命令仍需批准",
  "auto-all": "全部自动批准（慎用）",
  plan: "只读，禁止一切写操作",
};

/** 把任意输入收窄成合法档位；不合法（含 Claude 的 acceptEdits 等）返回 null。 */
export function asPermissionMode(value: unknown): PermissionMode | null {
  if (typeof value !== "string") return null;
  return (PERMISSION_MODES as readonly string[]).includes(value) ? (value as PermissionMode) : null;
}

/** 斜杠命令广告：COMMANDS 一对一的 `{name, description}`，不多不少。 */
export function availableCommands(): AvailableCommand[] {
  return COMMANDS.map((c) => ({ name: c.name, description: c.description }));
}

/** `session/new` / `session/load` 响应里的 modes 字段。 */
export function modeState(current: PermissionMode): SessionModeState {
  const availableModes: SessionMode[] = PERMISSION_MODES.map((id) => ({
    id,
    name: id,
    description: MODE_DESCRIPTIONS[id],
  }));
  return { currentModeId: current, availableModes };
}

/**
 * `usage_update` 的载荷。
 *
 * `used` 必须落在 `[0, size]`：estimateTokens 是启发式估算，长会话里可能超过窗口
 * （真实请求会先被压缩/截断），而 ACP 客户端拿它画进度条 —— 超窗口的百分比没有意义。
 * 因此只做**上界钳制**，不放大、不补零。
 */
export function usageOf(messages: Message[], tools: ToolSpec[], contextWindow: number): UsageUpdate {
  const size = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 0;
  const raw = estimateTokens(messages, tools);
  const used = size === 0 ? 0 : Math.min(Math.max(Math.floor(raw), 0), size);
  return { used, size };
}
