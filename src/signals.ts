/**
 * 会话级致命信号（issue #75）。
 *
 * `backgroundShells.start()` 用 `detached: true`（setsid）让 shell 自成进程组，
 * 终端的 SIGINT / SIGHUP / SIGTERM 不再自动传到子进程。调用方必须先回收
 * （`cleanupEphemeral` / `killAll` / ACP `dispose`），再按 130 / 129 / 143 退出。
 */
export const EXIT_BY_SIGNAL = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const;

export type FatalSignal = keyof typeof EXIT_BY_SIGNAL;

export interface FatalSignalHandlers {
  cleanup: () => void;
  /** 默认处理 SIGINT、SIGHUP、SIGTERM。 */
  signals?: FatalSignal[];
  /**
   * 返回 `"continue"` 时不在这里退出（例如 structured `-p` 的 SIGINT 只 `agent.cancel()`，
   * 走原有 aborted → 130 收口）。其余情况必须 `"exit"`。
   */
  onSignal?: (sig: FatalSignal) => "exit" | "continue";
}

/** 安装致命信号处理器。返回卸载函数（幂等）。 */
export function installFatalSignalHandlers(opts: FatalSignalHandlers): () => void {
  const signals: FatalSignal[] = opts.signals ?? ["SIGINT", "SIGHUP", "SIGTERM"];
  let handled = false;
  const handlers = new Map<FatalSignal, () => void>();
  for (const sig of signals) {
    const fn = (): void => {
      const mode = opts.onSignal?.(sig) ?? "exit";
      if (mode === "continue") return;
      if (handled) return;
      handled = true;
      try {
        opts.cleanup();
      } catch {
        /* 清理失败也要退 */
      }
      process.exit(EXIT_BY_SIGNAL[sig]);
    };
    handlers.set(sig, fn);
    process.on(sig, fn);
  }
  return () => {
    for (const [sig, fn] of handlers) process.off(sig, fn);
    handlers.clear();
  };
}
