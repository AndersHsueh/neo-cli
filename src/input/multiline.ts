/**
 * input/multiline.ts — 多行输入的 continuation 状态机（v0.2.4 C4，纯逻辑）。
 *
 * 与触发方式解耦：M0 探针若证明 `Ctrl+J` 可拦截就用它，否则退到「行尾 `\``」触发，
 * 两种触发都只是「往状态机里 append 一次」，状态机本身不变。
 *
 * 为什么用 continuation 而不是往 readline 行缓冲塞 `\n`：
 * readline 的光标/刷新是为单行设计的，塞换行后宽度计算与历史行为不可控；
 * 暂存已完成的整行、只在提交时拼接，能让 readline 始终只面对单行。
 */

export interface Continuation {
  /** 已暂存的行（不含正在编辑的那一行）。 */
  lines: string[];
}

export function emptyContinuation(): Continuation {
  return { lines: [] };
}

/** 追加一行（不可变）。 */
export function appendContinuation(c: Continuation, line: string): Continuation {
  return { lines: [...c.lines, line] };
}

export function isActiveContinuation(c: Continuation): boolean {
  return c.lines.length > 0;
}

/** 续行提示符：`… `（调用方自行着色）。 */
export function continuationPrompt(c: Continuation): string {
  return isActiveContinuation(c) ? "… " : "❯ ";
}

/** 提交：暂存行 + 当前行用 `\n` 拼接。 */
export function finishContinuation(c: Continuation, last: string): string {
  return [...c.lines, last].join("\n");
}

/**
 * 行尾反斜杠模式（探针不可用时的回退触发）：
 * 单反斜杠结尾表示续行并剥掉它；双反斜杠是转义，不算续行。
 */
export function stripContinuationMarker(line: string): { text: string; cont: boolean } {
  if (line.endsWith("\\\\")) return { text: line, cont: false };
  if (line.endsWith("\\")) return { text: line.slice(0, -1), cont: true };
  return { text: line, cont: false };
}

/**
 * 从 stdin 原始字节判断这次提交是 Ctrl+J(0x0A) 还是 Enter(0x0D)。
 *
 * 为什么不用 keypress：实测 bun 1.3.13 下 keypress 与 line 事件的先后不可靠
 * （同一次回车，二者顺序随分块变化）。stdin 的 data 事件比 readline 的处理更早，
 * 用 prependListener 记下「最近一次换行字节」再在 line 事件里读，才稳。
 * 只认缓冲区里最后一个换行字节；没有换行返回 null（方向键等不应影响判定）。
 */
export function newlineKindFromBytes(bytes: Uint8Array): "lf" | "cr" | null {
  const kinds = newlineKindsFromBytes(bytes);
  return kinds.length > 0 ? kinds[kinds.length - 1]! : null;
}

/**
 * 按块解析换行种类队列（顺序扫描，CRLF 只算一个 Enter）。
 *
 * 为什么需要队列：一个 stdin 数据块可能产生**多个 line 事件**（事件循环忙时按键被合并），
 * 而旧实现只记「块里最后一个换行」，导致第一个 line 被误判；CRLF 的末字节是 LF，
 * 旧实现会把粘贴 CRLF 文本的 Enter 误判成 Ctrl+J。每个 line 事件 shift 一个，
 * 队空时按 Enter 处理（见 index.ts）。
 */
export function newlineKindsFromBytes(bytes: Uint8Array): Array<"lf" | "cr"> {
  const out: Array<"lf" | "cr"> = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x0d) {
      out.push("cr");
      if (bytes[i + 1] === 0x0a) i++; // CRLF = 一个 Enter
    } else if (b === 0x0a) {
      out.push("lf");
    }
  }
  return out;
}
