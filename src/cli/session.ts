/** 会话组合对象上跨文件可变的字段。其余字段由 bootstrap/startSession 的返回值推断。 */
import type { Composer } from "../tui/composer.ts";
import type { Agent } from "../agent.ts";
import type { BackgroundTasks } from "../tools/background.ts";
import type { DriveManager } from "../drive.ts";
import type { LoopScheduler } from "../loop.ts";

export type SharedMut = {
  composerRef: Composer | null;
  sessionLabel: string | null;
  stdoutClosed: boolean;
  turnNo: number;
  mailboxTick: ReturnType<typeof setInterval> | null;
  lastWatchdogAt: number;
  lastStreamProgressAt: number;
  bootBlockPrinted: boolean;
  backgroundTasks: BackgroundTasks | null;
  activeTurnFrom: string | null;
  agent: Agent | null;
  drive?: DriveManager | null;
  loopScheduler?: LoopScheduler | null;
  cleanupEphemeralResources?: () => void;
};
