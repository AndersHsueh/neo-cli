/**
 * 生命周期 hooks 的类型与配置解析（issue #3）。
 *
 * 定位（硬约束）：hooks 是**用户自配的生命周期脚本**，不是权限系统。
 *  - 它只能「阻断」或「放行到既有审批流程」，永远不能把调用升级为免审批；
 *  - 它不参与 decidePermission 的判定，plan 模式的拒绝发生在 hook 之前，
 *    hook 连被调用的机会都没有（见 agent/loop.ts 的调用点）。
 *
 * 为什么解析放在叶子模块：config.ts 只做「读 settings 的 hooks 段 → 结构化」，
 * 执行器（runner.ts）依赖进程/超时，测试与 config 都不想拉进来。
 */
import type { PermissionMode } from "../agent/types.ts";

/** 三个事件。PreToolUse 可阻断；PostToolUse / TurnEnd 默认不阻断（onFailure 可配）。 */
export type HookEvent = "PreToolUse" | "PostToolUse" | "TurnEnd";

export const HOOK_EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "TurnEnd"];

/** 失败策略：continue = 记诊断后继续（默认）；block = 把失败升级为阻断。 */
export type HookOnFailure = "continue" | "block";

export interface HookDef {
  event: HookEvent;
  /** shell 命令（经平台 shell 执行，与 shell 工具同一套解析）。 */
  command: string;
  /** 工具名匹配：精确名、`mcp__*` 这类前缀通配，或 `/regex/`。缺省 = 全部工具。 */
  matcher?: string;
  /** 超时秒数（默认 30，上限 600）。 */
  timeout: number;
  /** 仅 PostToolUse / TurnEnd 有意义；PreToolUse 恒按 block 语义（非 0 即阻断）。 */
  onFailure: HookOnFailure;
  /** 来源标注（`settings.hooks.PreToolUse[2]`），诊断与 /hooks 用。 */
  origin: string;
}

export interface HooksConfig {
  /** 是否启用。缺省 false —— 不配就是零开销，也不会有人被意外阻断。 */
  enabled: boolean;
  /** 是否把 hook 的执行情况（阻断/失败/超时）打到 UI。默认 true。 */
  verbose: boolean;
  /** 按事件分组的定义（保持配置顺序 = 执行顺序）。 */
  hooks: Record<HookEvent, HookDef[]>;
  /** 解析期告警（写错的条目已被丢弃，这里说明为什么）。 */
  warnings: string[];
}

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 30;
export const MAX_HOOK_TIMEOUT_SECONDS = 600;

export function emptyHooksConfig(): HooksConfig {
  return {
    enabled: false,
    verbose: true,
    hooks: { PreToolUse: [], PostToolUse: [], TurnEnd: [] },
    warnings: [],
  };
}

/** 该配置下是否有任何一条 hook（enabled 且至少一条）。 */
export function hasAnyHook(cfg: HooksConfig): boolean {
  if (!cfg.enabled) return false;
  return HOOK_EVENTS.some((e) => cfg.hooks[e].length > 0);
}

/**
 * 工具名匹配。
 *
 * 支持三种写法，覆盖验收要求的 `shell` / `write_file` / `mcp__*`：
 *  - 精确：`shell`；
 *  - 通配：只认末尾 `*`（`mcp__*`、`mcp__fs__*`），不做通用 glob ——
 *    hook 的 matcher 是「挑哪些工具」，不是路径匹配，多一套 glob 语法只会多一类静默失配；
 *  - 正则：`/^mcp__/` 形态（两侧斜杠），给需要复杂条件的用户留出口。
 *
 * 缺省（undefined / 空串）= 匹配全部工具。
 */
export function matchTool(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined) return true;
  const m = matcher.trim();
  if (m === "") return true;
  if (m.length >= 2 && m.startsWith("/") && m.endsWith("/")) {
    try {
      return new RegExp(m.slice(1, -1)).test(tool);
    } catch {
      // 正则写错：按「不匹配」处理，解析期已经给过 warning。
      return false;
    }
  }
  if (m.endsWith("*")) return tool.startsWith(m.slice(0, -1));
  return tool === m;
}

function asTimeout(raw: unknown, where: string, warnings: string[]): number {
  if (raw === undefined || raw === null) return DEFAULT_HOOK_TIMEOUT_SECONDS;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    warnings.push(`${where}.timeout 不是正数（${String(raw)}），已用默认 ${DEFAULT_HOOK_TIMEOUT_SECONDS}s。`);
    return DEFAULT_HOOK_TIMEOUT_SECONDS;
  }
  if (n > MAX_HOOK_TIMEOUT_SECONDS) {
    warnings.push(`${where}.timeout=${n}s 超过上限 ${MAX_HOOK_TIMEOUT_SECONDS}s，已截到上限。`);
    return MAX_HOOK_TIMEOUT_SECONDS;
  }
  return n;
}

function asOnFailure(raw: unknown, where: string, warnings: string[]): HookOnFailure {
  if (raw === undefined || raw === null) return "continue";
  const v = String(raw).trim().toLowerCase();
  if (v === "continue" || v === "block") return v;
  warnings.push(`${where}.onFailure="${String(raw)}" 不是 continue/block，已按 continue 处理。`);
  return "continue";
}

/**
 * 解析 settings.hooks。
 *
 * 形状（两种都接受，与 mcpServers 的容错哲学一致）：
 *   "hooks": {
 *     "enabled": true,
 *     "PreToolUse":  [ { "command": "...", "matcher": "shell", "timeout": 10 } ],
 *     "PostToolUse": [ { "command": "...", "matcher": "/^(write_file|edit_file)$/", "onFailure": "block" } ],
 *     "TurnEnd":     [ { "command": "..." } ]
 *   }
 *
 * 容错原则：**单条写错只丢这一条 + 一条可读 warning，绝不让 CLI 起不来**。
 * 这与 mcpServers 的处理同口径 —— 配置错误是用户的问题，不该变成启动失败。
 */
export function parseHooksConfig(raw: unknown): HooksConfig {
  const cfg = emptyHooksConfig();
  if (raw === undefined || raw === null) return cfg;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    cfg.warnings.push("settings.hooks 必须是对象，已忽略该段。");
    return cfg;
  }
  const obj = raw as Record<string, unknown>;
  cfg.enabled = obj["enabled"] === true;
  if (obj["verbose"] !== undefined) cfg.verbose = obj["verbose"] !== false;

  for (const event of HOOK_EVENTS) {
    const list = obj[event];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      cfg.warnings.push(`settings.hooks.${event} 必须是数组，已忽略。`);
      continue;
    }
    list.forEach((item, i) => {
      const where = `settings.hooks.${event}[${i}]`;
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        cfg.warnings.push(`${where} 不是对象，已跳过。`);
        return;
      }
      const it = item as Record<string, unknown>;
      const command = typeof it["command"] === "string" ? it["command"].trim() : "";
      if (command === "") {
        cfg.warnings.push(`${where} 缺少 command，已跳过。`);
        return;
      }
      const matcherRaw = it["matcher"];
      let matcher: string | undefined;
      if (typeof matcherRaw === "string") {
        const m = matcherRaw.trim();
        if (m.length >= 2 && m.startsWith("/") && m.endsWith("/")) {
          try {
            new RegExp(m.slice(1, -1));
          } catch (e) {
            cfg.warnings.push(`${where}.matcher 正则非法（${(e as Error).message}），已跳过该条。`);
            return;
          }
        }
        matcher = m === "" ? undefined : m;
      } else if (matcherRaw !== undefined && matcherRaw !== null) {
        cfg.warnings.push(`${where}.matcher 必须是字符串，已按「匹配全部工具」处理。`);
      }
      cfg.hooks[event].push({
        event,
        command,
        ...(matcher !== undefined ? { matcher } : {}),
        timeout: asTimeout(it["timeout"], where, cfg.warnings),
        onFailure: asOnFailure(it["onFailure"], where, cfg.warnings),
        origin: where,
      });
    });
  }

  // 未声明任何事件却 enabled:true —— 不是错误，但值得说一句（用户可能拼错了事件名）。
  if (cfg.enabled && !HOOK_EVENTS.some((e) => cfg.hooks[e].length > 0)) {
    cfg.warnings.push(
      `settings.hooks 已启用但没有任何有效条目（事件名只认 ${HOOK_EVENTS.join(" / ")}）。`,
    );
  }
  return cfg;
}

/* ------------------------------------------------------------------ */
/* 事件载荷（stdin JSON）                                              */
/* ------------------------------------------------------------------ */

/** 所有事件共有的字段。 */
export interface HookPayloadBase {
  event: HookEvent;
  session_id: string;
  cwd: string;
  /** 当前生效的权限模式（ask / auto-edit / auto-all / plan）。 */
  mode: PermissionMode;
  /** 是否为 task 子代理里的调用（子代理同样触发 Pre/PostToolUse）。 */
  subagent: boolean;
  /** 本轮序号（会话内递增，从 1 开始）。 */
  turn: number;
}

export interface PreToolUsePayload extends HookPayloadBase {
  event: "PreToolUse";
  tool_name: string;
  /** 已解析的工具参数（JSON 解析失败时为原始字符串）。 */
  tool_input: unknown;
}

export interface PostToolUsePayload extends HookPayloadBase {
  event: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  /** 工具是否成功。 */
  ok: boolean;
  /** 结果摘要（截断到 2000 字符；完整输出可能含密钥，不适合外传）。 */
  result: string;
  /** 结果是否被截断。 */
  truncated: boolean;
}

export interface TurnEndPayload extends HookPayloadBase {
  event: "TurnEnd";
  /** 本轮统计（与 TurnStats 同口径的摘要）。 */
  turn_stats: {
    finish_reason: string | null;
    tool_calls: number;
    iterations: number;
    aborted: boolean;
    had_error: boolean;
    error_message: string | null;
  };
}

export type HookPayload = PreToolUsePayload | PostToolUsePayload | TurnEndPayload;

/* ------------------------------------------------------------------ */
/* 执行结果                                                            */
/* ------------------------------------------------------------------ */

export type HookOutcomeKind =
  /** 退出码 0：放行。 */
  | "ok"
  /** 退出码 2：阻断（reason 来自 stdout/stderr 或 JSON 的 reason 字段）。 */
  | "block"
  /** 超时被杀。 */
  | "timeout"
  /** 其它非 0 退出码 / 崩溃 / 命令不存在。 */
  | "error"
  /** 被用户 abort 打断。 */
  | "aborted";

export interface HookOutcome {
  hook: HookDef;
  kind: HookOutcomeKind;
  /** 退出码；超时/abort/启动失败时为 null。 */
  code: number | null;
  /** 阻断原因（kind=block）或诊断信息（kind=error/timeout）。 */
  reason: string;
  /** stdout 尾部（诊断用，已截断）。 */
  stdout: string;
  /** stderr 尾部（诊断用，已截断）。 */
  stderr: string;
  durationMs: number;
}

/** 一次事件分发的汇总。 */
export interface HookDispatchResult {
  /** 是否被阻断（PreToolUse 的 block，或 Post/TurnEnd 上 onFailure=block 的失败）。 */
  blocked: boolean;
  /** 阻断原因（回给模型/用户）。 */
  reason: string;
  /** 全部执行结果（含放行的），供 /hooks 与诊断使用。 */
  outcomes: HookOutcome[];
}
