/**
 * tui/editHistory.ts — 输入框的 kill ring 与撤销栈（issue #79）。
 *
 * 两件事分开：
 *  - **kill ring**：Ctrl+K/U/W、Alt+D、Ctrl+Backspace 删掉的文本进环；Ctrl+Y 粘回最近一条，
 *    Alt+Y 在「刚 yank 过」之后循环更早的记录（替换刚插入的那段）。空删除不进环。
 *  - **撤销栈**：插入/删除/yank 之前压一份 {text, cursor}，Ctrl+_ 弹栈恢复。
 *
 * 纯状态容器，不碰终端：调用方（composerInput）负责在改缓冲前后调用 record/push。
 */

/** 撤销栈深度：够覆盖「手滑删了一段又改了几句」，又不至于把整场会话留在内存里。 */
export const UNDO_LIMIT = 100;
/** kill ring 深度。 */
export const KILL_RING_LIMIT = 30;

export interface BufSnapshot {
  text: string;
  cursor: number;
}

export class EditHistory {
  private readonly kills: string[] = [];
  private readonly undos: BufSnapshot[] = [];
  /** 上一次 yank 插入的文本与位置（Alt+Y 用它做「替换刚插入的那段」）。 */
  private lastYank: { text: string; start: number; end: number } | null = null;
  /** 当前 yank-pop 在环里的位置（从环尾往前数）；null = 不在 yank-pop 链上。 */
  private yankIndex: number | null = null;

  /** 最近一次删除的文本；空串 = 环空。 */
  get lastKill(): string | null {
    return this.kills.length === 0 ? null : (this.kills[this.kills.length - 1] as string);
  }

  get killCount(): number {
    return this.kills.length;
  }

  get undoDepth(): number {
    return this.undos.length;
  }

  /** 记一条删除；空删除不进环（也不打断 yank-pop 链）。 */
  pushKill(text: string): void {
    if (text === "") return;
    this.kills.push(text);
    if (this.kills.length > KILL_RING_LIMIT) this.kills.splice(0, this.kills.length - KILL_RING_LIMIT);
    this.yankIndex = null;
    this.lastYank = null;
  }

  /** 压一份撤销快照（改缓冲**之前**调用）。 */
  pushUndo(snapshot: BufSnapshot): void {
    this.undos.push({ text: snapshot.text, cursor: snapshot.cursor });
    if (this.undos.length > UNDO_LIMIT) this.undos.splice(0, this.undos.length - UNDO_LIMIT);
  }

  /** 弹一份撤销快照；空栈返回 null。 */
  popUndo(): BufSnapshot | null {
    return this.undos.pop() ?? null;
  }

  /**
   * 记录一次 yank：`start` 是插入起点，`text` 是插入内容。
   * 之后 Alt+Y 会把 `[start, start+text.length)` 换成环里更早的一条。
   */
  noteYank(start: number, text: string): void {
    this.lastYank = { text, start, end: start + Array.from(text).length };
    this.yankIndex = this.kills.length - 1;
  }

  /**
   * 取环里「更早一条」的删除文本（环绕）；不在 yank 链上返回 null。
   *
   * 返回的 `range` 是当前缓冲里要被替换的区间（码点下标），调用方据此替换。
   */
  nextYankPop(): { text: string; range: { start: number; end: number } } | null {
    const yank = this.lastYank;
    if (!yank || this.yankIndex === null || this.kills.length === 0) return null;
    const next = (this.yankIndex - 1 + this.kills.length) % this.kills.length;
    this.yankIndex = next;
    const text = this.kills[next] as string;
    this.lastYank = { text, start: yank.start, end: yank.start + Array.from(text).length };
    return { text, range: { start: yank.start, end: yank.end } };
  }

  /** 任何非 yank 的编辑都应打断 yank-pop 链。 */
  breakYank(): void {
    this.lastYank = null;
    this.yankIndex = null;
  }

  /** 清空（提交/清空缓冲后调用，避免跨消息误 yank）。 */
  reset(): void {
    this.breakYank();
  }
}
