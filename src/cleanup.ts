/**
 * 会话资源清理的唯一真源（issue #40）。
 *
 * 背景：`shutdown()` 有一份完整清单，而 `-p` 一次性分支与 `args.rest` 非交互分支
 * 只收 MCP —— 于是 `-p` 里起的后台 shell / 后台子代理 / 语言服务器在进程退出后
 * 变成孤儿（CI 里反复起 `-p` 会累积，后台 shell 可能一直占端口）。
 *
 * 这里把清单抽成一处，三条退出路径共用。顺序是硬约束：
 *  1. 先停「会再拉起子进程」的驱动（loop / drive）—— 否则清理过程中它们还能排新轮；
 *  2. 再取消后台子代理、杀后台 shell、关语言服务器（都是子进程）；
 *  3. 再关 MCP（子进程）；
 *  4. 最后关信箱（停 tick + 释放 .alive 锁）。
 * 记忆冲刷与 persist 属于「保存」而不是「清理」，留在调用方（它们要 await，且
 * 位置相对退出码/JSON 输出有语义），不塞进这里。
 *
 * 依赖用结构类型注入：单测可以传可观测的假对象断言调用顺序，无需真子进程。
 */

/** `/loop` 定时器：退出前必须停，否则残留在进程退出路径上。 */
export interface DisposableLoop {
  dispose(): void;
}

/** 自动续跑（`/drive`）：退出前必须停，否则还会往已退出的会话里排轮。 */
export interface StoppableDrive {
  stop(): void;
}

/** 后台子代理任务表（issue #16）。 */
export interface CancellableTasks {
  cancelAll(): void;
}

/** 后台长驻 shell（issue #28）。 */
export interface KillableShells {
  killAll(): void;
}

/** 语言服务器（issue #23）。 */
export interface ClosableLspServers {
  closeAll(): void;
}

/** MCP 客户端（v0.1.x）。 */
export interface ClosableMcp {
  closeAll(): void;
}

export interface EphemeralDeps {
  /** 停循环定时器（issue #25）。 */
  loop?: DisposableLoop | null;
  /** 停自动续跑（issue #24）。 */
  drive?: StoppableDrive | null;
  /** 取消后台子代理（issue #16）；未接线时为 null。 */
  tasks?: CancellableTasks | null;
  /** 杀后台 shell（issue #28）。 */
  shells?: KillableShells | null;
  /** 关语言服务器（issue #23）。 */
  lsp?: ClosableLspServers | null;
  /** 关 MCP 子进程。 */
  mcp?: ClosableMcp | null;
  /** 关信箱（停 tick + 释放 .alive）。 */
  closeMailbox?: (() => void) | null;
}

/** 单个清理动作失败不阻止后续清理：孤儿进程比「清理干净」更要紧。 */
function safe(label: string, fn: () => void): void {
  try {
    fn();
  } catch {
    // 清理失败不阻止退出；label 留给调试时定位（不打印，避免污染 -p 的 stdout）
    void label;
  }
}

/**
 * 收掉本会话拉起的所有临时资源（幂等：各子系统的 close/kill 自身幂等）。
 *
 * 同步执行 —— 所有被调方都是同步的（kill(9) / abort / close），
 * 这样 `-p` 的异常路径也能在 `throw` 之前调用它。
 */
export function cleanupEphemeral(deps: EphemeralDeps): void {
  // 1) 先停驱动，避免清理过程中又排新轮 / 起新子进程。
  if (deps.loop) safe("loop", () => deps.loop!.dispose());
  if (deps.drive) safe("drive", () => deps.drive!.stop());
  // 2) 子进程：子代理 → 后台 shell → 语言服务器。
  if (deps.tasks) safe("tasks", () => deps.tasks!.cancelAll());
  if (deps.shells) safe("shells", () => deps.shells!.killAll());
  if (deps.lsp) safe("lsp", () => deps.lsp!.closeAll());
  // 3) MCP 子进程。
  if (deps.mcp) safe("mcp", () => deps.mcp!.closeAll());
  // 4) 信箱最后关：前面若有清理动作会写 state，信箱还开着才不会丢。
  if (deps.closeMailbox) safe("mailbox", deps.closeMailbox);
}
