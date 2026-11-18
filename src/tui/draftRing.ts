/**
 * tui/draftRing.ts — Ctrl+C 清空草稿后的会话内召回环（issue #79 P0.4）。
 *
 * 语义：
 *  - 输入框非空（或有附件 / 处于 shell 模式）时 Ctrl+C 把整份草稿推进环，再清空；
 *  - 空框按 ↑ 时 LIFO 弹出最近一份（文本、光标、附件拷贝、shell 模式），**不提交**；
 *  - 上限 10 条，超出丢最旧；
 *  - Esc 清空**不进环**（C4k 语义不回退），所以 Esc 掉的内容不会被 ↑ 复活。
 */

/** 会话内最多保留几份被 Ctrl+C 清掉的草稿。 */
export const DRAFT_RING_LIMIT = 10;

export interface DraftSnapshot {
  text: string;
  cursor: number;
  attachments: unknown[];
  shellMode: boolean;
}

export class DraftRing {
  private readonly items: DraftSnapshot[] = [];

  get size(): number {
    return this.items.length;
  }

  /** 推进一份草稿（附件存拷贝，避免与输入框共享引用被后续清空误伤）。 */
  push(d: DraftSnapshot): void {
    this.items.push({
      text: d.text,
      cursor: d.cursor,
      attachments: d.attachments.slice(),
      shellMode: d.shellMode,
    });
    if (this.items.length > DRAFT_RING_LIMIT) {
      this.items.splice(0, this.items.length - DRAFT_RING_LIMIT);
    }
  }

  /** LIFO 弹出最近一份；空环返回 null。 */
  pop(): DraftSnapshot | null {
    return this.items.pop() ?? null;
  }

  clear(): void {
    this.items.length = 0;
  }
}
