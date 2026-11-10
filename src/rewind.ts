/**
 * 按轮次回滚（issue #27 `/rewind`）。
 *
 * 与单文件检查点（`/undo`）的分工：
 *  - `/undo [n]`：按**操作条目**倒序恢复文件，只动代码；
 *  - `/rewind`：按**用户轮次**聚合 —— 回到「我发那句话之前」，可分别恢复代码 / 对话 / 两者。
 *    跨会话消息 / 状态通知 / loop·drive 注入的轮次只内部记账、不进列表与编号（issue #42）；
 *    回滚用户轮次时，它们产生的文件检查点会一并恢复。
 *
 * 边界（与 Claude Code 同口径）：只覆盖本会话里 **write_file / edit_file** 落盘过的文件；
 * shell 改的文件不跟踪；不做版本控制替代。
 *
 * 这个模块只放纯逻辑（轮次表 + 恢复决策），文件恢复交给 `CheckpointStore.undoSeqs`，
 * 对话截断交给调用方注入的 `conversation`，因此可以完全单测。
 */

export type RewindMode = "code" | "conversation" | "both";

/** 轮次来源：human = 用户亲自发的；auto = 跨会话消息 / 通知 / loop·drive 注入（issue #42）。 */
export type RewindTurnSource = "human" | "auto";

export interface RewindTurn {
  /** 该轮在**记录表**里的序号（内部用；用户可见编号由 list() 按用户轮次重排）。 */
  index: number;
  /** 用户提示（截断展示用；原始文本保留前 200 字符）。 */
  prompt: string;
  at: string;
  /** 该轮开始前的 messages 长度（对话回滚的截断点）。 */
  messagesBefore: number;
  /** 该轮内产生的检查点 seq（代码回滚的目标）。 */
  checkpointSeqs: number[];
  /** 轮次来源；旧会话没有该字段 = 用户轮次。 */
  source?: RewindTurnSource;
}

export interface PendingTurn {
  prompt: string;
  at: string;
  messagesBefore: number;
  checkpointSeqBefore: number;
  source: RewindTurnSource;
}

export interface RewindResult {
  /** 被丢弃的**用户轮次**数（用户可见）。 */
  turnsRemoved: number;
  /** 一并丢弃的自动轮次数（其文件检查点会随用户轮次一起恢复）。 */
  autoTurnsRemoved: number;
  messagesRemoved: number;
  filesRestored: number;
  filesSkipped: number;
  notes: string[];
}

export interface RewindDeps {
  /** 文件回滚（CheckpointStore.undoSeqs 的窄接口）。 */
  store: { undoSeqs(seqs: number[]): Array<{ restored: "content" | "deleted" | "skipped"; reason?: string }> };
  /** 对话截断（Agent.messages 的窄接口）。 */
  conversation: { length(): number; truncate(n: number): void };
}

/** 本会话最多保留多少轮快照（老会话/长会话不无限增长）。 */
export const MAX_REWIND_TURNS = 50;

/** 是否用户轮次（旧会话记录没有 source 字段 → 按用户轮次兼容）。 */
function isHumanTurn(turn: RewindTurn): boolean {
  return (turn.source ?? "human") === "human";
}

export class RewindLog {
  private records: RewindTurn[];
  private pending: PendingTurn | null = null;
  private readonly now: () => Date;

  constructor(opts: { records?: RewindTurn[]; now?: () => Date } = {}) {
    this.records = [...(opts.records ?? [])];
    this.now = opts.now ?? (() => new Date());
  }

  get turns(): readonly RewindTurn[] {
    return this.records;
  }

  /** 轮次开始（drain 里在 agent.send 之前调用）。 */
  beginTurn(input: {
    prompt: string;
    messagesLength: number;
    checkpointSeqBefore: number;
    /** 缺省 human；跨会话 / 通知 / loop·drive 注入传 auto（issue #42）。 */
    source?: RewindTurnSource;
  }): PendingTurn {
    this.pending = {
      prompt: input.prompt.slice(0, 200),
      at: this.now().toISOString(),
      messagesBefore: input.messagesLength,
      checkpointSeqBefore: input.checkpointSeqBefore,
      source: input.source ?? "human",
    };
    return this.pending;
  }

  /**
   * 轮次结束（drain 的 finally 里调用）：把本轮新产生的检查点 seq 归到这一轮。
   * 没有 beginTurn（例如命令路径/异常早退）时返回 null，不记账。
   */
  endTurn(pending: PendingTurn | null, checkpointSeqs: number[]): RewindTurn | null {
    if (!pending) return null;
    this.pending = null;
    const record: RewindTurn = {
      index: this.records.length,
      prompt: pending.prompt,
      at: pending.at,
      messagesBefore: pending.messagesBefore,
      checkpointSeqs: [...new Set(checkpointSeqs)].sort((a, b) => a - b),
      source: pending.source,
    };
    this.records.push(record);
    if (this.records.length > MAX_REWIND_TURNS) {
      // 只保留最近 N 轮；索引重排，保证 `/rewind <n>` 连续。
      this.records = this.records.slice(-MAX_REWIND_TURNS).map((r, i) => ({ ...r, index: i }));
    }
    return record;
  }

  /**
   * 用户可见轮次（issue #42）：只含用户亲自发的轮次，index 重排为连续的用户序号。
   * 自动轮只在内部记账 / `serialize()` 里保留 —— 回滚用户轮次时要连带恢复它们产生的文件检查点。
   */
  list(): RewindTurn[] {
    let i = 0;
    return this.records
      .filter(isHumanTurn)
      .map((r) => ({ ...r, index: i++, checkpointSeqs: [...r.checkpointSeqs] }));
  }

  /** 可持久化到 session meta 的纯数据（含自动轮，见 list() 注释）。 */
  serialize(): RewindTurn[] {
    return this.records.map((r) => ({ ...r, checkpointSeqs: [...r.checkpointSeqs] }));
  }

  /**
   * 回滚到「某个轮次开始之前」。
   *
   * - `target`: 轮次下标；`"last"` = 最近一轮（最常见的「刚才那句」）。
   * - `mode`:
   *   - `both`：先恢复文件，再把对话截到该轮开始前，并丢弃这些轮次记录；
   *   - `code`：只恢复文件；对话保留 → 轮次记录保留但清空其 checkpointSeqs
   *     （文件已回到旧状态，不能再用同一批快照重复回滚）；
   *   - `conversation`：只截断对话并丢弃这些轮次记录（文件不动；仍可用 `/undo` 逐条退）。
   */
  rewind(opts: { target: number | "last"; mode: RewindMode } & RewindDeps): RewindResult {
    const result: RewindResult = {
      turnsRemoved: 0,
      autoTurnsRemoved: 0,
      messagesRemoved: 0,
      filesRestored: 0,
      filesSkipped: 0,
      notes: [],
    };
    // 目标只认用户轮次（issue #42）：自动轮不当回滚目标，但会随 doomed 一起被丢弃并恢复文件。
    const human = this.records.filter(isHumanTurn);
    if (human.length === 0) {
      result.notes.push("本会话还没有可回滚的轮次（只算用户轮次，跨会话/自动注入不算）");
      return result;
    }
    const target = opts.target === "last" ? human.length - 1 : opts.target;
    if (!Number.isInteger(target) || target < 0 || target >= human.length) {
      result.notes.push(`用户轮次 ${String(opts.target)} 不存在（可用范围 0–${human.length - 1}）`);
      return result;
    }
    const targetPos = this.records.indexOf(human[target]!);
    const doomed = this.records.slice(targetPos);
    result.turnsRemoved = doomed.filter(isHumanTurn).length;
    result.autoTurnsRemoved = doomed.length - result.turnsRemoved;

    // ---- 1. 代码：先恢复文件（从新到旧由 store 负责） ----
    if (opts.mode === "code" || opts.mode === "both") {
      const seqs = doomed.flatMap((t) => t.checkpointSeqs);
      if (seqs.length === 0) {
        result.notes.push("这些轮次没有产生文件检查点（只改了对话之外的东西）");
      } else {
        for (const r of opts.store.undoSeqs(seqs)) {
          if (r.restored === "skipped") result.filesSkipped += 1;
          else result.filesRestored += 1;
        }
      }
    }

    // ---- 2. 对话：截到最早一轮开始之前 ----
    if (opts.mode === "conversation" || opts.mode === "both") {
      const boundary = doomed[0]!.messagesBefore;
      const current = opts.conversation.length();
      if (boundary < current) {
        opts.conversation.truncate(boundary);
        result.messagesRemoved = current - boundary;
      }
    }

    // ---- 3. 轮次表 ----
    if (opts.mode === "code") {
      // 只退代码：保留对话 → 轮次记录留着，但快照已用掉，清空 seqs 防重复回滚。
      for (const t of doomed) t.checkpointSeqs = [];
    } else {
      this.records = this.records.slice(0, targetPos).map((r, i) => ({ ...r, index: i }));
    }
    return result;
  }
}
