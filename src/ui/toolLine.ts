/**
 * ui/toolLine.ts — 紧凑工具调用行的纯格式化逻辑（可单测，无 IO）。
 *
 * 交互模式下默认只显示一行：` ⚡ name args .`，`.`/`..`/`...` 循环表示运行中；
 * 下一个工具调用覆盖同一行；完成后尾标变为 ✓ / ✗。详情显示由
 * settings.json 的 `toolcall_info_details` 控制（默认 false）。
 */
import { displayWidth } from "./theme.ts";

export type ToolLineStatus = "running" | "ok" | "error";

export interface ToolLineSegments {
  name: string;
  args: string;
  /** 尾标：运行中的点 / ✓ / ✗ + 错误摘要。 */
  tail: string;
}

/** dots: 0 → ".", 1 → "..", 2 → "...". */
export function dotsText(dots: number): string {
  const n = ((Math.trunc(dots) % 3) + 3) % 3;
  return ".".repeat(n + 1);
}

export function nextDots(dots: number): number {
  return (Math.trunc(dots) + 1) % 3;
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
}

/** 按显示宽度截断（theme.truncate 按 code unit，CJK 会超宽）。 */
function truncateDisplay(s: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return "";
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/**
 * 把工具调用压缩成不超过 width 列的单行片段。
 * 调用方负责着色（颜色转义不占显示宽度）与首尾空格。
 */
export function toolLineSegments(opts: {
  name: string;
  args: string;
  width: number;
  dots?: number;
  status?: ToolLineStatus;
  errorText?: string;
}): ToolLineSegments {
  const width = Math.max(20, Math.trunc(opts.width));
  const status = opts.status ?? "running";
  const prefix = " ⚡ ";
  const rawTail =
    status === "running"
      ? dotsText(opts.dots ?? 0)
      : status === "ok"
        ? "✓"
        : `✗ ${firstLine(opts.errorText ?? "")}`.trimEnd();
  // 失败摘要不能把整行撑爆：给 name/args 至少预留 8 列。
  const tail = truncateDisplay(rawTail, Math.max(4, width - displayWidth(prefix) - 10));
  const room = Math.max(8, width - displayWidth(prefix) - displayWidth(tail) - 2);
  let name = opts.name;
  let args = (opts.args ?? "").replace(/\s+/g, " ").trim();

  if (displayWidth(name) + (args ? 1 + displayWidth(args) : 0) > room) {
    const nameRoom = Math.min(displayWidth(name), Math.max(8, Math.floor(room * 0.5)));
    name = truncateDisplay(name, nameRoom);
    const argsRoom = Math.max(0, room - displayWidth(name) - 1);
    args = argsRoom > 0 ? truncateDisplay(args, argsRoom) : "";
  }
  return { name, args, tail };
}
