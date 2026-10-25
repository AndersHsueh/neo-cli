/**
 * ui/toolLog.ts — 工具调用历史与回看格式化（v0.2.3 D3，纯逻辑，可单测）。
 *
 * 背景：v0.2.2 的紧凑模式下工具正文不再上屏，下一次调用又用 `\r\x1b[2K` 覆盖 ——
 * 信息一旦滚过就永久丢失。本模块做三件事：
 *  1. 把最近 N 次调用的完整输出留在内存里，供 `/last` 回看；
 *  2. 失败时从 `shell` 的拼接格式里正确挑出 stderr 与 `[exit N]`，
 *     而不是被第一行 `$ cmd` 挤掉唯一有用信息；
 *  3. 工具正文的「缩进 + 限高 + 省略提示」只有一份实现，console 与 `/last` 共用。
 */
import { shellMarks } from "../tools/shellMarks.ts";
import { c, displayWidth, truncate } from "./theme.ts";
import { oneLine, paintTail, toolLineSegments, toolLineText } from "./toolLine.ts";

/** 内存里保留的调用条数（只存引用，不复制正文；20 条 × 上游限流后的输出）。 */
export const MAX_TOOL_HISTORY = 20;
/** `/last` 默认展示的行数。 */
export const LAST_MAX_LINES = 40;
/** 紧凑模式失败详情最多补几行（失败罕见，信息量最大）。 */
export const FAILURE_DETAIL_LINES = 3;

export interface ToolCallRecord {
  name: string;
  args: string;
  ok: boolean;
  /** 执行耗时（ms）。 */
  ms: number;
  /** 工具完整输出（上游 dispatch 已按 tool_output_limit 限流过，这里不再二次截断）。 */
  output: string;
  /** 记录时间戳。 */
  at: number;
}

export function formatDuration(ms: number): string {
  const n = Math.max(0, Math.trunc(ms));
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

/**
 * 清洗工具输出里的控制序列：保留换行，剥掉 SGR/CSI/C0，tab 展开为两空格。
 *
 * 工具输出是外部数据（stderr 里可能有 `ESC[2J` 清屏、`ESC[K` 清行），
 * 直接回显会破坏整个屏幕；宽度计算也会把它们算成占位。
 */
export function sanitizeOutput(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI（含 SGR/清屏/光标）
    .replace(/\x1b[@-_]/g, "") // 其余 ESC 双字符序列
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\t/g, "  ");
}

/**
 * 从工具输出里提炼失败摘要与详情行。
 *
 * `shell` 的输出形如：`$ cmd\nstdout\n[stderr] ...\n[exit 1]` ——
 * 第一行永远是命令本身，取首行等于什么也没说。这里优先取 stderr，
 * 并把 exit code 拼进单行摘要。
 */
export function summarizeFailure(
  body: string,
  opts: { maxLines?: number } = {},
): { tail: string; detail: string[] } {
  const maxLines = Math.max(1, opts.maxLines ?? FAILURE_DETAIL_LINES);
  const lines = sanitizeOutput(body).split("\n");
  const nonEmpty = lines.map((l) => l.trimEnd()).filter((l) => l.trim() !== "");

  const exitMatch = shellMarks.exitRe.exec(nonEmpty.at(-1) ?? "");
  const exitTag = exitMatch ? ` ${shellMarks.exit(Number(exitMatch[1]))}` : "";
  const stderrAt = nonEmpty.findIndex((l) => l.startsWith(shellMarks.stderrPrefix));
  const candidates =
    stderrAt >= 0
      ? [nonEmpty[stderrAt]!.slice(shellMarks.stderr.length), ...nonEmpty.slice(stderrAt + 1)].filter(
          (l) => l.trim() !== "" && !shellMarks.exitRe.test(l),
        )
      : nonEmpty.filter((l) => !shellMarks.exitRe.test(l) && !l.startsWith(shellMarks.cmdPrefix));

  const detail = candidates.slice(0, maxLines);
  const first = detail[0] ?? "工具执行失败";
  // 工具层抛出的错误正文本身常以「错误: 」开头，别再套一层变成「错误: 错误:」
  const cleaned = oneLine(first.replace(/^错误[:：]\s*/, "")) || "工具执行失败";
  return { tail: `错误: ${cleaned}${exitTag}`, detail };
}

export interface OutputLinesOptions {
  maxLines: number;
  width: number;
  /** 每行前缀，例如 "│ " / "  │ "。 */
  margin: string;
  /** 省略行是否附带总行数（`/last` 需要，实时输出不需要）。 */
  totalHint?: boolean;
}

/**
 * 工具正文的统一渲染：缩进 + 按行限高 + 省略提示。
 * 返回已着色的行（颜色由本函数负责，调用方直接 print）。
 */
export function formatOutputLines(body: string, opts: OutputLinesOptions): string[] {
  const lines = sanitizeOutput(body).split("\n");
  const maxLines = Math.max(1, opts.maxLines);
  const room = Math.max(8, opts.width - displayWidth(opts.margin) - 2);
  const out = lines
    .slice(0, maxLines)
    .map((l) => c.dim(opts.margin) + c.muted(truncate(l, room)));
  if (lines.length > maxLines) {
    const tail = opts.totalHint
      ? `… 还有 ${lines.length - maxLines} 行未显示（共 ${lines.length} 行）`
      : `… 还有 ${lines.length - maxLines} 行未显示`;
    out.push(c.dim(opts.margin) + c.dim(tail));
  }
  return out;
}

/**
 * 把一条调用记录渲染成多行（供 `/last` 使用）。
 * 失败摘要与紧凑行共用同一套宽度收敛，保证单行头不超宽。
 */
export function formatToolCall(
  rec: ToolCallRecord,
  width: number,
  opts: { maxLines?: number } = {},
): string[] {
  const maxLines = Math.max(1, opts.maxLines ?? LAST_MAX_LINES);
  const w = Math.max(20, Math.trunc(width));
  const summary = rec.ok ? null : summarizeFailure(rec.output);
  const duration = formatDuration(rec.ms);
  // 先扣掉尾部时长，再让工具行按剩余宽度收敛 name/args（含失败的半宽摘要上限）
  const seg = toolLineSegments({
    name: rec.name,
    args: rec.args,
    width: Math.max(20, w - displayWidth(duration) - 2),
    status: rec.ok ? "ok" : "error",
    errorText: summary?.tail ?? "",
  });
  const head = toolLineText(seg, paintTail(seg, rec.ok ? "ok" : "error") + c.dim(` ${duration}`));
  return [head, ...formatOutputLines(rec.output, { maxLines, width: w, margin: "  │ ", totalHint: true })];
}
