/** 会话组合对象上跨文件可变的字段。其余字段由 bootstrap/startSession 的返回值推断。 */
import type { Composer } from "../tui/composer.ts";
import type { Agent } from "../agent.ts";
import type { BackgroundTasks } from "../tools/background.ts";
import type { DriveManager } from "../drive.ts";
import type { LoopScheduler } from "../loop.ts";
import type { WikiMaintainer } from "../memory/wikiMaintainer.ts";
import type { CwdSwitchDeps } from "./cdWorkdir.ts";

export type SharedMut = {
  composerRef: Composer | null;
  sessionLabel: string | null;
  /** #37 stream-json：由 writer 的 onClosed 钩子置位（EPIPE/写失败），是「无 result」的唯一物理例外。 */
  stdoutClosed: boolean;
  /** #37 stream-json：每次 agent.send 前的 turn_started 与全部 onEvent 映射共用的 turn 号。 */
  turnNo: number;
  mailboxTick: ReturnType<typeof setInterval> | null;
  /**
   * 信箱心跳定时器（与空闲 tick 独立，turn 进行中也刷新）。closeMailbox() 清掉后置 null。
   * 放在共享对象上而不是 bootstrap 的局部变量：读方必须拿到实时值，不能是返回时的快照。
   */
  heartbeatTick: ReturnType<typeof setInterval> | null;
  /** 信箱资源是否已释放（closeMailbox 幂等标记）。同上，读方拿实时值。 */
  mailboxClosed: boolean;
  /** 上次 watchdog 检查时间（P1 与 idle tick 共用）。 */
  lastWatchdogAt: number;
  /** 上次因流式输出刷新 last_progress_at 的时间（节流，避免每个 chunk 写盘）。 */
  lastStreamProgressAt: number;
  bootBlockPrinted: boolean;
  /** 后台子代理任务表（issue #16）：Agent 构造时要注入轮询闭包，实例在 Agent 之后创建。 */
  backgroundTasks: BackgroundTasks | null;
  /** 当前 turn 的 mailbox 触发者；只有它才允许 send_message 自动补 reply_to。 */
  activeTurnFrom: string | null;
  agent: Agent | null;
  drive?: DriveManager | null;
  loopScheduler?: LoopScheduler | null;
  /** 轮末后台 wiki 维护（issue #53）：只有交互会话构造，-p / ACP 恒为 null。 */
  wikiMaintainer?: WikiMaintainer | null;
  cleanupEphemeralResources?: () => void;
  /** #85：交互 REPL 给 enter_worktree / exit_worktree 补上与 /cd 相同的侧状态（/cd - 槽、FileIndex、规则、LSP）。 */
  worktreeToolDeps?: () => Partial<CwdSwitchDeps>;
};
