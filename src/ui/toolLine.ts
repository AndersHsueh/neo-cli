/**
 * ui/toolLine.ts — 紧凑工具调用行的纯格式化逻辑（可单测，无 IO）。
 *
 * 交互模式下默认只显示一行：` ⚡ name args .`，`.`/`..`/`...` 循环表示运行中；
 * 下一个工具调用覆盖同一行；完成后尾标变为 ✓ / ✗。详情显示由
 * settings.json 的 `toolcall_info_details` 控制（默认 false）。
 *
 * v0.2.3：单行文本的拼装与尾标着色收敛到这里（`toolLineText` / `paintTail`），
 * console 的原地刷新与 `/last` 的回看共享同一份实现，避免三处各写一遍。
 */
import { c, displayWidth, truncate } from "./theme.ts";

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

/** 折成单行：换行/制表/连续空白一律压成一个空格。 */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function firstLine(s: string): string {
  return oneLine(s.split("\n")[0] ?? "");
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
  // 失败摘要不能把整行撑爆：摘要最多占一半宽度，name/args 至少各留 8 列。
  // （v0.2.3 实测：只按 width-13 限高的旧算法在长路径错误下会把 read_file 压成 "read_fi…"）
  const tailCap = Math.max(12, Math.min(width - displayWidth(prefix) - 16, Math.floor(width * 0.5)));
  const tail = truncate(rawTail, tailCap);
  const room = Math.max(8, width - displayWidth(prefix) - displayWidth(tail) - 2);
  let name = opts.name;
  let args = oneLine(opts.args ?? "");

  if (displayWidth(name) + (args ? 1 + displayWidth(args) : 0) > room) {
    const nameRoom = Math.min(displayWidth(name), Math.max(8, Math.floor(room * 0.5)));
    name = truncate(name, nameRoom);
    const argsRoom = Math.max(0, room - displayWidth(name) - 1);
    args = argsRoom > 0 ? truncate(args, argsRoom) : "";
  }
  return { name, args, tail };
}

/** 尾标三态着色（运行中按 tier / ✓ / ✗）。 */
export function paintTail(
  seg: ToolLineSegments,
  status: ToolLineStatus,
  tier = "balanced",
): string {
  return status === "ok" ? c.ok(seg.tail) : status === "error" ? c.err(seg.tail) : c.tier(tier, seg.tail);
}

/** 单行工具文本：` ⚡ name args tail`（⚡ 按 tier 着色；tail 由调用方着色）。 */
export function toolLineText(seg: ToolLineSegments, tail: string, tier = "balanced"): string {
  return ` ${c.tier(tier, "⚡")} ${c.bright(seg.name)}` + (seg.args ? ` ${c.dim(seg.args)}` : "") + ` ${tail}`;
}
