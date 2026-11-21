/**
 * #66 运行中转向（宿主侧）：REPL 队列 → Agent 切点的桥。
 *
 * 队列是唯一真源：条目只有在 Agent 真正写入本轮历史时（`claim()`）才离队，
 * 所以「计数下降」= 已被本轮吃掉，`↑` 也只可能收回尚未注入的条目。
 * 切点时机、UPS、取消语义都在 Agent 侧（src/agent/midTurnSteer.ts）；这里只回答
 * 「哪些能注入」「怎么展开」「取消时该说哪句」。
 */
import type { SteerItem } from "../agent/types.ts";
import type { ResolvedLine } from "../attachments.ts";
import type { QueueItem } from "./repl.ts";

/** 注入前取消：沿用既有文案（合同第 18 条）。 */
export const CANCEL_NOTICE = "已请求取消本轮";
/** 注入后取消：只停不删，文案要能看出不回滚（合同第 11、18 条）。 */
export const STEERED_CANCEL_NOTICE = "已中断（不回滚，转向已写入本轮）";

/**
 * 合同第 3、4 条：真人 origin user、非 loop、非 shell、不以 `/` 或 `!` 开头。
 * 斜杠命令、`!` / shell 模式、`/loop` 拍、mailbox、notice、#87 监视一律等轮末 drain。
 * 本轮 UPS 阻断过的条目也等轮末（届时再跑一次 UPS）。
 */
export function isSteerable(q: QueueItem): boolean {
  if (q.origin !== "user" || q.loop === true || q.shell === true || q.steerBlocked === true) return false;
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
  /** 与 drain 同规则展开（@ 引用 / 附件 / 图片）。 */
  expand: (q: QueueItem) => Promise<ResolvedLine>;
  /** 队列变化后刷新状态条「⇥ N 排队」。 */
  onQueueChange: () => void;
}

export class SteerController {
  private active = false;
  private injected = 0;

  constructor(private readonly deps: SteerControllerDeps) {}

  /** drain 发起一轮 agent turn 前调用：只有 drain 的轮次接受转向。 */
  beginTurn(): void {
    this.active = true;
    this.injected = 0;
  }

  /**
   * 轮次结束。UPS 阻断标记不清：那条要等 drain 把它当新一轮取出（届时再跑 UPS），
   * 在那之前即使又起了别的轮次（mailbox / loop），也不能在中途再试一次。
   */
  endTurn(): void {
    this.active = false;
    this.injected = 0;
  }

  /** 取消时的提示：注入前返回 undefined（调用方沿用原文案），注入后返回不回滚文案。 */
  cancelNotice(): string | undefined {
    return this.injected > 0 ? STEERED_CANCEL_NOTICE : undefined;
  }

  /** AgentOptions.pollSteer：切点时取走当时全部可注入条目（原序）。 */
  readonly poll = async (): Promise<SteerItem[]> => {
    if (!this.active) return [];
    const picked = this.deps.queue().filter(isSteerable);
    const items: SteerItem[] = [];
    for (const q of picked) {
      const resolved = await this.deps.expand(q);
      items.push({
        text: resolved.text,
        images: resolved.images,
        claim: () => {
          const queue = this.deps.queue();
          const at = queue.indexOf(q);
          if (at < 0) return false;
          queue.splice(at, 1);
          this.injected++;
          this.deps.onQueueChange();
          return true;
        },
        block: () => {
          q.steerBlocked = true;
        },
      });
    }
    return items;
  };
}
