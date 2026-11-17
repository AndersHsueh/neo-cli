/**
 * ACP 工具事件映射（issue #60，PRD §2.9–§2.11）。
 *
 * 数据源是现有 `AgentEvent`（`src/agent/types.ts`）：
 *  - `tool_start` → `sessionUpdate: "tool_call"`（`toolCallId` 直接用 `call_id`）；
 *  - `tool_end`   → `sessionUpdate: "tool_call_update"`（`success`→completed，
 *    `failure`/`not_executed`→failed）。
 *
 * 写作类工具（write_file / edit_file）的 `tool_call_update` 要带 `type: "diff"` 的 content，
 * 而 `oldText` 必须是**写盘前**的内容 —— 等 `tool_end` 再读就已经是新内容了。
 * 所以 `tool_start` 时就把旧内容快照下来（读不到/新文件 → null）。
 *
 * 本文件只做纯映射，不发通知也不碰权限：发送由 `src/acp/server.ts` 负责。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolCallContent, ToolCallLocation, ToolKind, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { ToolEndEventData, ToolStartEventData } from "../agent/types.ts";

/** PRD §2.9 的 kind 映射表（ACP `ToolKind`）。 */
const KIND_BY_TOOL: Record<string, ToolKind> = {
  read_file: "read",
  list_dir: "read",
  glob: "search",
  grep: "search",
  lsp: "search",
  web_fetch: "fetch",
  web_search: "fetch",
  use_skill: "read",
  write_file: "edit",
  edit_file: "edit",
  shell: "execute",
  shell_output: "execute",
  task: "other",
  todo_write: "think",
  submit_plan: "think",
  exit_plan_mode: "think",
};

/** 工具名 → ACP `ToolKind`。MCP 外部工具与未知工具一律 `other`。 */
export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "other";
  return KIND_BY_TOOL[name] ?? "other";
}

/** 写作类工具：它们的 `tool_call_update` 必须带 diff（PRD §2.10）。 */
export function isWriteTool(name: string): boolean {
  return name === "write_file" || name === "edit_file";
}

/** `tool_end` 的 status 映射：`not_executed` 与 `failure` 都是 failed。 */
export function toolStatus(status: ToolEndEventData["status"]): ToolCallStatus {
  return status === "success" ? "completed" : "failed";
}

/** 从工具参数里取绝对路径（`path` 字段；没有就返回 null）。 */
export function pathOfArgs(argsJson: string, cwd: string): string | null {
  try {
    const parsed: unknown = argsJson.trim() === "" ? {} : JSON.parse(argsJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const raw = (parsed as Record<string, unknown>)["path"];
    if (typeof raw !== "string" || raw.trim() === "") return null;
    return resolve(cwd, raw);
  } catch {
    return null;
  }
}

/** 写盘前的旧内容快照：读不到（新文件 / 读取失败）→ null。 */
export function snapshotOldText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 写作类工具的 `tool_call` 通知体（PRD §2.9）。 */
export interface ToolCallStart {
  toolCallId: string;
  title: string;
  name: string;
  kind: ToolKind;
  status: ToolCallStatus;
  locations?: ToolCallLocation[];
}

export function toolCallStartOf(data: ToolStartEventData, cwd: string): ToolCallStart {
  const kind = toolKind(data.name);
  const path = isWriteTool(data.name) ? pathOfArgs(data.args, cwd) : null;
  return {
    toolCallId: data.call_id,
    // title 里带工具名：编辑器列表里要能看出「调了什么」。
    title: `${data.name} ${previewArgs(data.args)}`.trim(),
    name: data.name,
    kind,
    status: "pending",
    ...(path ? { locations: [{ path }] } : {}),
  };
}

/** 写作类工具的 `tool_call_update` 通知体（PRD §2.10：diff + locations）。 */
export interface ToolCallEnd {
  toolCallId: string;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawOutput?: string;
}

/**
 * `tool_end` → `tool_call_update`。
 *
 * `oldText` 由调用方在 `tool_start` 时采集（`snapshotOldText`）后传进来；
 * 这里只在工具真的成功执行时给出 diff —— 被拒绝/失败时旧内容没变，给 diff 等于撒谎。
 */
export function toolCallEndOf(
  data: ToolEndEventData,
  cwd: string,
  oldText: string | null | undefined,
  /** tool_start 时的原始 args。tool_end.paths 是 cwd 相对路径，且工作区外会被丢掉，不能用来拼 diff。 */
  argsJson?: string,
): ToolCallEnd {
  const status = toolStatus(data.status);
  const path = isWriteTool(data.name) ? pathOfArgs(argsJson ?? lastArgsOf(data), cwd) : null;
  const base: ToolCallEnd = { toolCallId: data.call_id, status, rawOutput: data.output };

  if (path && status === "completed") {
    return {
      ...base,
      content: [{ type: "diff", path, oldText: oldText ?? null, newText: snapshotOldText(path) ?? "" }],
      locations: [{ path }],
    };
  }
  if (path) {
    // 写工具没成功：仍然告诉编辑器「本来要改这个文件」，但不伪造 diff。
    return { ...base, locations: [{ path }], content: [{ type: "content", content: { type: "text", text: data.output } }] };
  }
  return {
    ...base,
    content: [{ type: "content", content: { type: "text", text: data.output } }],
  };
}

/**
 * `tool_end` 事件里没有原始参数，只有 paths（组合根 clipPaths 后的路径）。
 * 写作类工具只有一个目标文件，取第一个绝对路径即可。
 */
function lastArgsOf(data: ToolEndEventData): string {
  const first = data.paths[0];
  return first ? JSON.stringify({ path: first }) : "";
}

/** 参数摘要（与 TUI 的预览同口径：单行、截断）。 */
function previewArgs(argsJson: string): string {
  const flat = argsJson.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}
