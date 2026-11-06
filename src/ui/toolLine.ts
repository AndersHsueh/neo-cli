/**
 * ui/toolLine.ts — 紧凑工具调用行的纯格式化逻辑（可单测，无 IO）。
 *
 * 交互模式下默认只显示一行：` ⚡ name args .`，`.`/`..`/`...` 循环表示运行中；
 * 下一个工具调用覆盖同一行；完成后尾标变为 ✓ / ✗。详情显示由
 * settings.json 的 `toolcall_info_details` 控制（默认 false）。
 *
 * v0.2.3：单行文本的拼装与尾标着色收敛到这里（`toolLineText` / `paintTail`），
 * console 的原地刷新与 `/last` 的回看共享同一份实现，避免三处各写一遍。
 *
 * v0.4.59（P0 工具卡片）：写/执行类工具（write_file / edit_file / shell / remember /
 * wiki_write）完成后不再只留一行 —— 卡片 = 头行 + 路径/命令行 + 效果行（加减行、
 * 退出码或失败摘要）。头行仍是 `toolLineSegments` 那一套（宽度收敛、尾标三态），
 * 下面两行由 `toolCardRows` 拼装，宽度同样走 `displayWidth` / `truncate`。
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

// ---------- 工具卡片（v0.4.59 P0） ----------

/**
 * 卡片化的工具：写盘 / 执行类 —— 它们的「效果」值得多留两行。
 *
 * 判据是**工具名**而不是 sensitive/kind：read_file 之类只读工具仍然一行就够
 * （P0 明确不要给所有输出加盒子），这里只挑用户真正关心「改了什么、成没成」的。
 */
const CARD_TOOLS = new Set(["write_file", "edit_file", "shell", "remember", "wiki_write"]);

export function isCardTool(name: string): boolean {
  return CARD_TOOLS.has(name);
}

/**
 * 卡片第二行：路径 / 命令行摘要。
 *
 * 入参是 `previewArgs` 压过的**单行 JSON 片段**（可能已被截断），这里按工具挑字段：
 *  - path 类：`path` 值（去掉引号，太长时中间省略，保留文件名）；
 *  - shell：`command` 值（命令比 cwd 更值得看）；
 *  - remember / wiki_write：没有路径可指，返回空串（卡片退化成两行）。
 * 解析不出来（截断在字段中间、JSON 不完整）就返回空串 —— 宁可少一行，不猜内容。
 */
export function cardSubject(name: string, argsPreview: string): string {
  const flat = oneLine(argsPreview ?? "");
  if (!flat) return "";
  const field = name === "shell" ? "command" : "path";
  const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(flat);
  if (!m) return "";
  const value = (m[1] ?? "").replace(/\\(["\\])/g, "$1");
  return oneLine(value);
}

/**
 * 路径的中间省略：`src/very/long/path/file.ts` → `src/…/file.ts`。
 * 只保留「头两段 + 文件名」，因为用户认的是文件名与它所在的大目录。
 */
export function shortenPath(p: string, max = 72): string {
  const s = oneLine(p);
  if (displayWidth(s) <= max) return s;
  const parts = s.split("/");
  if (parts.length <= 2) return truncate(s, max);
  const file = parts.at(-1) ?? "";
  const head = parts.slice(0, 2).join("/");
  const short = `${head}/…/${file}`;
  return displayWidth(short) <= max ? short : truncate(file, max);
}

export interface ToolCardOptions {
  name: string;
  /** 第二行原文（`cardSubject` 的结果）；空串 = 不出这一行。 */
  subject: string;
  /** 第三行效果摘要（`toolCardEffect` 的结果）；空串 = 不出这一行。 */
  effect: string;
  width: number;
  status?: ToolLineStatus;
  tier?: string;
}

/**
 * 卡片行（不含头行）：第二行路径/命令，第三行效果摘要。
 *
 * 两行都按**显示列**收敛到 `width - 2`（前缀 `  ` 占 2 列），
 * 保证卡片在窄终端里既不折行也不撑乱帧宽。返回的行已着色。
 */
export function toolCardRows(opts: ToolCardOptions): string[] {
  const room = Math.max(8, Math.trunc(opts.width) - 2);
  const rows: string[] = [];
  const subject = opts.subject.trim();
  if (subject !== "") rows.push(`  ${c.muted(truncate(subject, room))}`);
  const effect = opts.effect.trim();
  if (effect !== "") {
    const painted = opts.status === "error" ? c.err(truncate(effect, room)) : c.dim(truncate(effect, room));
    rows.push(`  ${painted}`);
  }
  return rows;
}
