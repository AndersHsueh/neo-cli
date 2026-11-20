import { readdirSync, readFileSync } from "node:fs";

/**
 * 进程组终止原语（issue #75，#87 抽出共用）。
 *
 * `detached: true`（setsid）让子进程自成一组（pgid = pid），
 * 杀的时候打 `-pid`，`sh -c` 派生的孙进程一并收掉。
 *
 * #28 后台 shell 与 #87 监视共用这一份，对外语义不变。
 */

/** 只依赖终止用到的字段，测试可以塞任何结构相同的 proc。 */
export interface GroupKillable {
  kill(signal?: number): void;
  pid?: number;
}

/**
 * 向进程组发信号。返回 false 表示组已不存在（ESRCH）；其它错误（EPERM 等）照常抛出。
 */
export function signalGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ESRCH") return false;
    throw e;
  }
}

/**
 * 进程组里是否还有非僵尸成员。
 *
 * killAll 的同步等待里事件循环被 Bun.sleepSync 挡住，已退出的 shell 会一直是
 * 僵尸，此时 `kill(-pid, 0)` 仍成功，每个任务都会空等满约 200ms。先看 /proc：
 * 只剩僵尸就视为组已空（issue #75 复审 §4c）。/proc 不可用时退回信号探测。
 */
export function groupHasNonZombie(pgid: number): boolean {
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${name}/stat`, "utf8");
      } catch {
        continue;
      }
      const rparen = stat.lastIndexOf(")");
      if (rparen < 0) continue;
      const rest = stat.slice(rparen + 2).split(" ");
      const state = rest[0];
      const pgrp = Number(rest[2]);
      if (pgrp === pgid && state !== "Z") return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** 进程组是否还有活着的成员（ESRCH / 只剩僵尸 = 否）。 */
export function groupAlive(pid: number): boolean {
  try {
    if (!signalGroup(pid, 0)) return false;
  } catch {
    // EPERM 等：组还在，只是我们发不了信号。
    return true;
  }
  return groupHasNonZombie(pid);
}

/**
 * 按进程组终止（issue #75）：先 SIGTERM 整组，再升级 SIGKILL。
 *
 * 只杀 shell 本身不够 —— `sh -c '… & wait'` 派生的孙进程不在 shell 的 pid 上，
 * 会继续跑、继续写盘。调用方用 `detached: true` 让进程自成一组（pgid = pid），
 * 这里打 `-pid` 才能连孙进程一起收掉。
 *
 * `sync: true` 用于「之后进程就退出了」的路径（会话退出 / cleanupEphemeral）：
 * 异步的 setTimeout 升级根本来不及跑，必须同步轮询等组消失再 SIGKILL。
 */
export function terminateProcessGroup(proc: GroupKillable, opts: { sync: boolean }): void {
  const pid = typeof proc.pid === "number" && proc.pid > 0 ? proc.pid : null;
  if (pid === null) {
    // 测试里的假 proc 没有 pid：保持原行为，只杀它自己。
    try {
      proc.kill(9);
    } catch {
      /* 已退出 */
    }
    return;
  }
  let groupGone = false;
  try {
    groupGone = !signalGroup(pid, "SIGTERM");
  } catch {
    // EPERM 等：组还在但我们发不了信号，退回到只杀 shell 本身。
    try {
      proc.kill(9);
    } catch {
      /* 已退出 */
    }
  }

  if (!groupGone) {
    if (opts.sync) {
      // 同步轮询最多约 200ms，仍在就 SIGKILL 整组。
      for (let waited = 0; waited < 200; waited += 20) {
        if (!groupAlive(pid)) break;
        Bun.sleepSync(20);
      }
      if (groupAlive(pid)) {
        try {
          signalGroup(pid, "SIGKILL");
        } catch {
          /* 发不了信号：交给下面的兜底 */
        }
      }
    } else {
      const timer = setTimeout(() => {
        try {
          signalGroup(pid, "SIGKILL");
        } catch {
          /* 发不了信号：交给下面的兜底 */
        }
      }, 500);
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  // 兜底：shell 本身（例如它已脱离原进程组）。
  try {
    proc.kill(9);
  } catch {
    /* 已退出 */
  }
}
