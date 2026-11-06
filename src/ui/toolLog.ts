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
import { clock, fixed1Raw } from "./format.ts";
import { shellMarks } from "../tools/shellMarks.ts";
import { c, displayWidth, truncate } from "./theme.ts";
import { isCardTool, oneLine, paintTail, toolCardRows, toolLineSegments, toolLineText } from "./toolLine.ts";

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

/**
 * 耗时：<1s 用 ms，<1min 用一位小数 s，<1h 用 `m:ss`，其余 `h:mm:ss`。
 *
 * 档位边界必须「进位即升档」（纪律与实现在 ui/format.ts）：
 * 59_950ms 的 toFixed(1) 是 "60.0"、3_599_950ms 是 "3600.0"，若原样输出会得到
 * "60.0s"/"3600.0s" —— 既跨了档（宽度多 1~2 列，`/last` 单行头抖动），
 * 又与下一档的 "1:00"/"1:00:00" 表达同一时长却不同写法。
 */
export function formatDuration(ms: number): string {
  const n = Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : 0;
  if (n < 1_000) return `${n}ms`;
  if (n < 60_000) {
    const s = fixed1Raw(n / 1_000);
    return s === "60.0" ? "1:00" : `${s}s`; // 59_950~59_999 进位到 60.0 → 升分钟档
  }
  return clock(n / 1_000);
}

/**
 * 清洗工具输出里的控制序列：保留换行，剥掉 SGR/CSI/OSC/DCS/C0，tab 展开为两空格。
 *
 * 工具输出是外部数据（stderr 里可能有 `ESC[2J` 清屏、`ESC[K` 清行），
 * 直接回显会破坏整个屏幕；宽度计算也会把它们算成占位。
 *
 * v0.4.46：旧实现只有 `\x1b[@-_]` 一条通用转义，它只吃掉「ESC + 一个字符」。
 * OSC（`\x1b]0;title\x07`）、DCS/SOS/PM/APC（`\x1bP...\x1b\\`）都是
 * 「ESC + 引导符 + 正文 + 终止符」的多字符序列，于是引导符被吃掉、**正文残留**
 * （`\x1b]0;title\x07` → "0;title"）。这类序列在真实 stderr 里很常见：
 * 带颜色的工具会发 OSC 8 超链接（`\x1b]8;;URL\x1b\\文字\x1b]8;;\x1b\\`），
 * 终端标题同理。剥法照抄 tui/ansi.ts 的 stripAnsi（那条纪律早就写对了）。
 */
export function sanitizeOutput(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "") // OSC（标题/超链接）：正文整体剥掉（未终止则吃到结尾）
    .replace(/\x1b[P^_X][^\x1b]*(?:\x1b\\|$)/g, "") // DCS/SOS/PM/APC：正文整体剥掉
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI（含 SGR/清屏/光标）
    .replace(/\x1b[@-_]/g, "") // 其余 ESC 双字符序列
    .replace(/\x1b/g, "") // 裸 ESC：不构成合法转义，但同样不可见、且会污染终端状态
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
 * 失败详情行（实时紧凑路径与 /last 之外共用）：
 * 缩进 + 限高 + 「完整输出：/last」提示。
 */
export function failureDetailRows(
  summary: ReturnType<typeof summarizeFailure>,
  width: number,
): string[] {
  const rows = formatOutputLines(summary.detail.join("\n"), {
    maxLines: FAILURE_DETAIL_LINES,
    width,
    margin: "  │ ",
  });
  rows.push(c.dim("  （完整输出：/last）"));
  return rows;
}

// ---------- 工具卡片效果行（v0.4.59 P0） ----------

/** `已创建 /path（12 字符，3 行）` / `已覆盖 …` —— write_file 的返回格式。 */
const WRITE_FILE_RE = /^(已创建|已覆盖)\s+(.+?)（(\d+) 字符，(\d+) 行）$/;
/** `已修改 /path（N 处）` —— edit_file 的返回格式。 */
const EDIT_FILE_RE = /^已修改\s+(.+?)（(\d+) 处）$/;

/**
 * 从工具结果里提炼卡片的「效果行」——**只读真实输出，解析不到就返回空串**。
 *
 *  - shell：`[exit N]` 末行（成功显示 `退出码 0`，失败交给失败摘要）；
 *  - write_file / edit_file：工具输出里的真实行数/处数（**不编加减行**：
 *    当前工具协议没有统一的 diff 摘要，只有「N 行」「N 处」）；
 *  - remember / wiki_write：工具自己给的落页回执首句。
 *
 * 为什么不做 diff 统计：输出里没有 old/new 全文，凭 args 里的字符串猜加减行
 * 就是假数据。等工具协议补了统一 diff 摘要（`+a -b`）再在这里加一条正则即可。
 */
export function toolCardEffect(name: string, output: string, ok: boolean): string {
  const text = sanitizeOutput(output ?? "");
  if (name === "shell") {
    const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
    const m = shellMarks.exitRe.exec(lines.at(-1) ?? "");
    if (!m) return "";
    const code = Number(m[1]);
    return ok ? `退出码 ${code}` : `退出码 ${code}（非零）`;
  }
  if (name === "write_file") {
    const m = WRITE_FILE_RE.exec(oneLine(text));
    if (!m) return "";
    return `${m[1]} · ${m[3]} 字符 · ${m[4]} 行`;
  }
  if (name === "edit_file") {
    const m = EDIT_FILE_RE.exec(oneLine(text));
    if (!m) return "";
    return `替换 ${m[2]} 处`;
  }
  if (name === "remember" || name === "wiki_write") {
    const first = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
    return first === "" ? "" : truncate(oneLine(first), 60);
  }
  return "";
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
  // v0.4.59：写/执行类工具在 /last 里也先给卡片效果行（与实时卡片同口径）
  const effect = isCardTool(rec.name) ? toolCardEffect(rec.name, rec.output, rec.ok) : "";
  const card = effect === "" ? [] : toolCardRows({ name: rec.name, subject: "", effect, width: w, status: rec.ok ? "ok" : "error" });
  return [head, ...card, ...formatOutputLines(rec.output, { maxLines, width: w, margin: "  │ ", totalHint: true })];
}
