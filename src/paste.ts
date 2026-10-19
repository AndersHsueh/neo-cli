/**
 * paste.ts —— 粘贴拦截状态机（PRD docs/paste-enhancement-prd.md §5.3 + §7 探针结论）。
 *
 * 探针定案（2026-10-19，bun/node 双 runtime 一致）：
 *  - readline 发出 paste-start / paste-end 命名 keypress（code:"[200~"/"[201~"）；
 *  - 粘贴内每个 \n 触发一次 line 提交（多行粘贴被拆成多条消息的根因）；
 *  - paste-end 时刻最后一段仍在 rl.line 缓冲，未提交；paste-end 之后无 flush（时间戳实证）；
 *  - readline 不自带 bracketed paste，需调用方自行启用 \x1b[?2004h/l。
 *
 * 路线：「粘贴期间丢弃 + paste-end 重组」——paste-start 收集 → 期间 line 入栈
 * （C11 同款模式）→ paste-end 取缓冲组装全文 → 超阈值折叠为 chip 或原样保留。
 * 本模块不碰 readline——缓冲读写由持有方注入，状态机可完整单测。
 *
 * M1 已知限制：粘贴发生在光标处，若光标在已打文字中间，chip 会替换整行
 * （含已打文字），原文完整保存在附件 content 里，发送时还原——不丢内容。
 */

/** 折叠阈值（PRD §5.7）。 */
export interface FoldThresholds {
  /**
   * 行数阈值。M1 结构性不生效：readline 行缓冲装不下 \n，含换行必折叠
   * （写回多行会再次逐行提交），本字段为 M2+ 多行缓冲预留。
   */
  foldLines: number;
  /** 单行字符数阈值：≥ 此值折叠。 */
  foldChars: number;
}

/**
 * 折叠判定（纯函数）。
 * 含 \n 必折叠——readline 行缓冲无法容纳换行，这是结构性约束不是策略；
 * 单行超长按 fold_chars 折叠。
 */
export function shouldFold(text: string, t: FoldThresholds): boolean {
  if (text.includes("\n")) return true;
  return text.length >= t.foldChars;
}

/**
 * 粘贴收集器：paste-start 到 paste-end 之间的 line 事件去留判定。
 * index.ts 的 rl.on("line") 在 active 时把 raw 交给 consume()，
 * 返回 true 表示「已收集，勿入队」——与 select 的 C11 丢弃模式同构。
 */
export class PasteCollector {
  active = false;
  private collected: string[] = [];

  start(): void {
    this.active = true;
    this.collected = [];
  }

  /** 粘贴期间的 line 事件 → 收集不提交。返回 true 表示已消费。 */
  consume(raw: string): boolean {
    if (!this.active) return false;
    this.collected.push(raw);
    return true;
  }

  /** 粘贴期间已提交的行数（供 history 定向回滚）。 */
  get count(): number {
    return this.collected.length;
  }

  /**
   * paste-end：交出收集结果。buf = 此刻的 rl.line（最后一段未提交内容，可为空串）。
   * 返回 null 表示纯空粘贴（无内容，调用方无需任何动作——缓冲未被拦截过）。
   */
  end(buf: string): { lines: string[]; tail: string } | null {
    this.active = false;
    const lines = [...this.collected];
    this.collected = [];
    if (lines.length === 0 && !buf) return null;
    return { lines, tail: buf };
  }
}

/**
 * 组装全文（纯函数）：lines 是粘贴期间被拦截的已提交行（首行已含用户先打的字），
 * tail 是 paste-end 时仍在缓冲的末段。无条件 join 保留尾随换行结构。
 */
export function assemblePaste(lines: string[], tail: string): string {
  return [...lines, tail].join("\n");
}
