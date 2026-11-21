/**
 * #66 运行中转向（宿主侧）：REPL 队列 → Agent 切点的桥。
 *
 * 队列是唯一真源：条目只有在 Agent 真正写入本轮历史时（`claim()`）才离队，
 * 所以「计数下降」= 已被本轮吃掉，`↑` 也只可能收回尚未注入的条目。
 * 切点时机、UPS、取消语义都在 Agent 侧（src/agent/midTurnSteer.ts）；这里只回答
 * 「哪些能注入」「怎么展开」「取消时该说哪句」。
 *
 * 补签：
 * - 1：enqueueUserTurn 排进来的合成消息（/技能名、MCP prompt）带 `synthetic` 标记，不可注入。
 * - 2：碰到第一条 UPS 阻断即止。阻断条与其后条目都留在队列；本轮其余切点一律不再注入；
 *   阻断条在队列里时是屏障，其后条目不得越过它注入；其后条目不打阻断标记，阻断条被 drain
 *   取出成轮后，它们仍可按原序注入到那一轮。
 * - 4：只在 stdin 是 TTY 时注入；管道 / 非 TTY 每行各自成 drain 轮。
 * - 5：取条目时只做静默展开（UPS 看到与 drain 相同的展开文本）；可见副作用在 `claim()` 成功
 *   （UPS 放行且确定写入本轮）时执行一次，阻断 / 被 ↑ 收回的结果直接丢弃。
 */
import type { SteerItem } from "../agent/types.ts";
import type { PreparedLine } from "./expandUserLine.ts";
import type { QueueItem } from "./repl.ts";

/**
 * 注入后取消：只停不删，文案要能看出不回滚（合同第 11、18 条）。
 * 注入前取消不在这里定文案：输入框沿用既有的「已请求取消本轮」。
 */
export const STEERED_CANCEL_NOTICE = "已中断（不回滚，转向已写入本轮）";

/**
 * 合同第 3、4 条：真人 origin user、非 loop、非 shell、不以 `/` 或 `!` 开头。
 * 斜杠命令、`!` / shell 模式、`/loop` 拍、mailbox、notice、#87 监视一律等轮末 drain。
 * 本轮 UPS 阻断过的条目也等轮末（届时再跑一次 UPS）。
 */
export function isSteerable(q: QueueItem): boolean {
  if (q.origin !== "user" || q.loop === true || q.shell === true || q.synthetic === true) return false;
  if (q.steerBlocked === true) return false;
  const text = q.text.trimStart();
  return text !== "" && !text.startsWith("/") && !text.startsWith("!");
}

/**
 * issue #79 / 合同第 15 条：`↑` 收回最近一条仍在队列里的真人输入。
 * 已注入的条目早已离队，天然收不回来。
 */
export function recallQueuedUser(queue: QueueItem[]): { text: string; attachments: QueueItem["attachments"] } | null {
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (!item || item.origin !== "user") continue;
    queue.splice(i, 1);
    return { text: item.text, attachments: item.attachments ?? [] };
  }
  return null;
}

export interface SteerControllerDeps {
  queue: () => QueueItem[];
  /** 补签 4：stdin 是否为 TTY（composer 或 readline 交互回退）。false 时不注入。 */
  interactive: () => boolean;
  /** 与 drain 同规则静默展开（@ 引用 / 附件 / 图片）；可见副作用留在 `commit()`。 */
  prepare: (q: QueueItem) => Promise<PreparedLine>;
  /** 队列变化后刷新状态条「⇥ N 排队」。 */
  onQueueChange: () => void;
}

export class SteerController {
  private active = false;
  private injected = 0;
  /** 补签 2：本轮已碰到 UPS 阻断，其余切点一律不再注入。 */
  private halted = false;

  constructor(private readonly deps: SteerControllerDeps) {}

  /** drain 发起一轮 agent turn 前调用：只有 drain 的轮次接受转向。 */
  beginTurn(): void {
    this.active = true;
    this.injected = 0;
    this.halted = false;
  }

  /**
   * 轮次结束。UPS 阻断标记不清：那条要等 drain 把它当新一轮取出（届时再跑 UPS），
   * 在那之前即使又起了别的轮次（mailbox / loop），也不能在中途再试一次。
   */
  endTurn(): void {
    this.active = false;
    this.injected = 0;
    this.halted = false;
  }

  /** 取消时的提示：注入前返回 undefined（调用方沿用原文案），注入后返回不回滚文案。 */
  cancelNotice(): string | undefined {
    return this.injected > 0 ? STEERED_CANCEL_NOTICE : undefined;
  }

  /** 队列里按原序的可注入条目；遇到仍在队列的阻断条即止（屏障，补签 2）。 */
  private pick(): QueueItem[] {
    const out: QueueItem[] = [];
    for (const q of this.deps.queue()) {
      if (q.steerBlocked === true) break;
      if (isSteerable(q)) out.push(q);
    }
    return out;
  }

  /** AgentOptions.pollSteer：切点时取走当时全部可注入条目（原序）。 */
  readonly poll = async (): Promise<SteerItem[]> => {
    if (!this.active || this.halted || !this.deps.interactive()) return [];
    const items: SteerItem[] = [];
    for (const q of this.pick()) {
      const prepared = await this.deps.prepare(q);
      items.push({
        text: prepared.text,
        images: prepared.images,
        claim: () => {
          const queue = this.deps.queue();
          const at = queue.indexOf(q);
          if (at < 0) return false;
          queue.splice(at, 1);
          this.injected++;
          prepared.commit();
          this.deps.onQueueChange();
          return true;
        },
        block: () => {
          q.steerBlocked = true;
          this.halted = true;
        },
      });
    }
    return items;
  };
}
