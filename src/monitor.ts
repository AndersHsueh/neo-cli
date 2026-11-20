/**
 * issue #87：事件驱动监视的纯逻辑（解析、上限、文案、包装）。
 *
 * 任务表与进程生命周期在 monitors.ts；本文件不碰进程、不写 settings。
 */
import { parseInterval, formatInterval } from "./loop.ts";

export const DEFAULT_MONITOR_TIMEOUT_MS = 300_000;
export const MAX_MONITOR_TIMEOUT_MS = 30 * 60_000;
export const ONESHOT_MAX_MONITOR_TIMEOUT_MS = 10 * 60_000;
export const MAX_RUNNING_MONITORS = 5;
export const MONITOR_BUFFER_MAX_LINES = 200;
export const MONITOR_BUFFER_MAX_BYTES = 32 * 1024;
export const INJECTION_MAX_LINES = 50;
export const INJECTION_MAX_BYTES = 8 * 1024;

export const MONITOR_QUEUE_ORIGIN = "monitor" as const;

export type MonitorStatus = "running" | "exited" | "cancelled" | "timed_out";

export interface MonitorJobView {
  id: string;
  status: MonitorStatus;
  remainingMs: number;
  flushedCount: number;
  command: string;
  description: string;
}

export type ParsedMonitorCommand =
  | { kind: "list" }
  | { kind: "stop"; id: string }
  | { kind: "start"; command: string; timeoutMs: number }
  | { kind: "error"; message: string };

export const MONITOR_USAGE =
  "用法：/monitor [--for <时长>] <命令> · /monitor 查看 · /monitor stop <id|all>";

export function formatMonitorTimeout(ms: number): string {
  return formatInterval(ms);
}

/** 列表用的剩余时限：3m20s / 45s / 1h2m。 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`;
  return `${s}s`;
}

export function summarizeCommand(command: string, limit = 60): string {
  return command.length > limit ? `${command.slice(0, limit)}…` : command;
}

export function wrapMonitorEvent(id: string, body: string): string {
  return `<监视事件 id="${id}">\n${body}\n</监视事件>`;
}

export function parseMonitorTimeoutMs(
  raw: unknown,
  opts: { oneshot: boolean },
): { ok: true; timeoutMs: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    const timeoutMs = DEFAULT_MONITOR_TIMEOUT_MS;
    const cap = opts.oneshot ? ONESHOT_MAX_MONITOR_TIMEOUT_MS : MAX_MONITOR_TIMEOUT_MS;
    if (timeoutMs > cap) {
      return { ok: false, error: opts.oneshot ? "-p 时限最长 10 分钟" : "时限超过上限 30 分钟" };
    }
    return { ok: true, timeoutMs };
  }
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, error: "timeout_ms 无效（必须是正数）" };
  }
  if (raw <= 0) {
    return { ok: false, error: "timeout_ms 无效（必须是正数）" };
  }
  const timeoutMs = Math.round(raw);
  const cap = opts.oneshot ? ONESHOT_MAX_MONITOR_TIMEOUT_MS : MAX_MONITOR_TIMEOUT_MS;
  if (timeoutMs > cap) {
    return {
      ok: false,
      error: opts.oneshot ? "时限超过上限 10 分钟（-p 最长 10 分钟）" : "时限超过上限 30 分钟",
    };
  }
  return { ok: true, timeoutMs };
}

/**
 * 解析 `/monitor` 的参数（命令后面那一段，已 trim）。
 */
export function parseMonitorCommand(arg: string): ParsedMonitorCommand {
  const text = arg.trim();
  if (text === "") return { kind: "list" };

  const tokens = tokenize(text);
  const head = (tokens[0] ?? "").toLowerCase();
  if (head === "stop") {
    const id = tokens[1];
    if (!id) {
      return {
        kind: "error",
        message: `请指定要取消的 id 或 all。用法：/monitor stop <id> · /monitor stop all`,
      };
    }
    return { kind: "stop", id };
  }

  let timeoutMs: number | undefined;
  let rest = tokens;

  if (rest[0] === "--for") {
    const dur = rest[1];
    if (!dur) return { kind: "error", message: `缺少时长。${MONITOR_USAGE}` };
    const parsed = parseInterval(dur);
    if (parsed === null) {
      return { kind: "error", message: `时长无法识别（"${dur}"），支持 30s / 2m / 1h / 纯数字秒。${MONITOR_USAGE}` };
    }
    timeoutMs = parsed;
    rest = rest.slice(2);
  } else if (rest[0] && rest[0] !== "--" && parseInterval(rest[0]) !== null) {
    timeoutMs = parseInterval(rest[0])!;
    rest = rest.slice(1);
  }

  if (rest[0] === "--") rest = rest.slice(1);
  const command = rest.join(" ").trim();
  if (!command) {
    return { kind: "error", message: `缺少命令。${MONITOR_USAGE}` };
  }

  if (timeoutMs !== undefined) {
    const checked = parseMonitorTimeoutMs(timeoutMs, { oneshot: false });
    if (!checked.ok) return { kind: "error", message: checked.error };
    return { kind: "start", command, timeoutMs: checked.timeoutMs };
  }
  return { kind: "start", command, timeoutMs: DEFAULT_MONITOR_TIMEOUT_MS };
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t !== "");
}

export function monitorStatusLabel(status: MonitorStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "exited":
      return "已退出";
    case "cancelled":
      return "已取消";
    case "timed_out":
      return "已结束";
  }
}

/** `/monitor` 列表（纯函数，便于单测）。 */
export function formatMonitorJobs(views: MonitorJobView[], _now = 0): string[] {
  if (views.length === 0) {
    return [
      "当前没有监视。用法：/monitor [--for <时长>] <命令> 启动；模型可用 monitor 工具。",
    ];
  }
  const lines = views.map((v) => {
    const cmd = summarizeCommand(v.description || v.command);
    return `  ${v.id}  ${monitorStatusLabel(v.status)}  剩余 ${formatRemaining(v.remainingMs)}  已回流 ${v.flushedCount} 条  ${cmd}`;
  });
  lines.push("/monitor stop <id> 取消一条 · /monitor stop all 全部停止");
  return lines;
}

export function startSuccessLine(id: string, timeoutMs: number, command: string): string {
  return `已开始监视 ${id} · 时限 ${formatMonitorTimeout(timeoutMs)} · ${summarizeCommand(command)}`;
}

export function formatMonitorUiBlock(opts: {
  id: string;
  title: string;
  lines: string[];
  notices: string[];
}): string {
  const parts = [`监视  ${opts.id}  ${opts.title}`, ...opts.lines, ...opts.notices];
  return parts.join("\n");
}

/**
 * 把一条监视注入插到已排队用户消息前面。
 * 已排队的非用户项（mailbox 等）保持在前。
 */
export function insertBeforeQueuedUser<T extends { origin: string }>(queue: T[], item: T): void {
  const i = queue.findIndex((q) => q.origin === "user");
  if (i === -1) queue.push(item);
  else queue.splice(i, 0, item);
}

export interface PendingLine {
  text: string;
  at: number;
  bytes: number;
}

export interface PackedMonitorBlock {
  id: string;
  title: string;
  lines: string[];
  notices: string[];
  dropped: number;
  body: string;
}

/**
 * 把多条监视的待发送行打成一次注入：总计最多 50 行 / 8KB，超限留最新。
 * 通知（到期 / 退出 / 取消 / 二进制告警）不计入上限、不得丢。
 */
export function packInjection(jobs: Array<{
  id: string;
  title: string;
  pending: PendingLine[];
  dropped: number;
  notices: string[];
}>): PackedMonitorBlock[] {
  const tagged: Array<{ id: string; line: PendingLine }> = [];
  for (const job of jobs) {
    for (const line of job.pending) tagged.push({ id: job.id, line });
  }
  tagged.sort((a, b) => a.line.at - b.line.at || a.id.localeCompare(b.id));

  let kept = tagged;
  const extraDropped = new Map<string, number>();
  const overLines = kept.length > INJECTION_MAX_LINES;
  let totalBytes = kept.reduce((n, t) => n + t.line.bytes, 0);
  const overBytes = totalBytes > INJECTION_MAX_BYTES;
  if (overLines || overBytes) {
    const newestFirst = [...kept].reverse();
    const selected: typeof tagged = [];
    let bytes = 0;
    for (const item of newestFirst) {
      if (selected.length >= INJECTION_MAX_LINES) break;
      if (bytes + item.line.bytes > INJECTION_MAX_BYTES) break;
      selected.push(item);
      bytes += item.line.bytes;
    }
    selected.reverse();
    const selectedSet = new Set(selected);
    for (const item of kept) {
      if (!selectedSet.has(item)) {
        extraDropped.set(item.id, (extraDropped.get(item.id) ?? 0) + 1);
      }
    }
    kept = selected;
  }

  const byId = new Map<string, PendingLine[]>();
  for (const item of kept) {
    const arr = byId.get(item.id) ?? [];
    arr.push(item.line);
    byId.set(item.id, arr);
  }

  const blocks: PackedMonitorBlock[] = [];
  for (const job of jobs) {
    const lines = (byId.get(job.id) ?? []).map((l) => l.text);
    const dropped = job.dropped + (extraDropped.get(job.id) ?? 0);
    const parts: string[] = [];
    if (dropped > 0) parts.push(`（已丢弃较早的 ${dropped} 行）`);
    parts.push(...lines);
    parts.push(...job.notices);
    if (parts.length === 0) continue;
    blocks.push({
      id: job.id,
      title: job.title,
      lines,
      notices: job.notices,
      dropped,
      body: parts.join("\n"),
    });
  }
  return blocks;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isBinaryChunk(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

/** 按到达顺序把完整行切出，不完整行留在 leftover。 */
export function splitCompleteLines(leftover: string, chunk: string): { lines: string[]; leftover: string } {
  const combined = leftover + chunk;
  const parts = combined.split("\n");
  const leftoverNext = parts.pop() ?? "";
  return { lines: parts, leftover: leftoverNext };
}

export function capPendingLines(pending: PendingLine[], maxLines = MONITOR_BUFFER_MAX_LINES, maxBytes = MONITOR_BUFFER_MAX_BYTES): number {
  let dropped = 0;
  while (pending.length > maxLines) {
    pending.shift();
    dropped += 1;
  }
  let bytes = pending.reduce((n, l) => n + l.bytes, 0);
  while (pending.length > 0 && bytes > maxBytes) {
    const gone = pending.shift();
    bytes -= gone?.bytes ?? 0;
    dropped += 1;
  }
  return dropped;
}
