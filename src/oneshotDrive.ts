/**
 * `-p` 无人值守长跑（issue #51，来源 #24 非目标）。
 *
 * 口径见 `docs/oneshot-drive-prd[done].md`（§0 是硬口径）。三条铁律：
 *
 *  1. **不新增 max-turns**。已有三层不同轴的上限：
 *     `max_tool_iterations`（单轮内工具迭代，默认 80）×
 *     `--max N`（驱动轮次，默认 5，夹紧 1–20，与 `/drive` 同口径）×
 *     `--max-minutes M`（墙钟，默认 30，夹紧 1–240，本单新增）。
 *  2. **必须显式 `-y`**：无人值守没有人类点确认，缺了就是用法错误（exit 2）。
 *  3. **来源不混写**：检查命令 exit 0 才是 `verified`；模型判断只能是 `model`。
 *
 * 本模块只放纯逻辑（参数解析 / 退出码 / 摘要），跑检查命令与问模型由调用方注入，
 * 与 `src/drive.ts` 的 `DriveManager` 同一分工。
 */

/** 墙钟上限默认值（分钟）。 */
export const DEFAULT_MAX_MINUTES = 30;
/** 墙钟上限夹紧上界（分钟）。 */
export const MAX_MAX_MINUTES = 240;
/** 驱动轮次默认值（与 `/drive` 同口径）。 */
export const DEFAULT_MAX_ROUNDS = 5;

/** 解析后的 `-p --drive` 规格。 */
export interface OneShotDriveSpec {
  /** 检查命令；空串 = 没有检查命令（只靠 judge）。 */
  check: string;
  /** 模型判断标准；不给 = 不启用模型判断。 */
  judge?: { criteria: string };
  /** 驱动轮次上限（1–20）。 */
  maxRounds: number;
  /** 墙钟上限（1–240 分钟）。 */
  maxMinutes: number;
}

export interface ParsedDriveArgs {
  ok: true;
  spec: OneShotDriveSpec;
  /** 是否显式给了 `-y`（无人值守必须为 true）。 */
  autoApprove: boolean;
}

export interface DriveArgsError {
  ok: false;
  error: string;
}

/**
 * 从完整 argv 里解析 `--drive` 相关参数。
 *
 * 返回 `null` = 命令行里没有 `--drive`（普通 `-p`，行为完全不变）。
 * 这样调用方只需判断 `!== null`，不必自己区分「没启用」与「解析失败」。
 */
export function parseDriveArgs(argv: readonly string[]): ParsedDriveArgs | DriveArgsError | null {
  let check: string | null = null;
  let judge: string | null = null;
  let maxRaw: string | null = null;
  let maxMinutesRaw: string | null = null;
  let autoApprove = false;
  let sawDrive = false;

  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] ?? "";
    switch (v) {
      case "--drive": {
        sawDrive = true;
        const next = argv[i + 1];
        // `--drive` 后面紧跟另一个 flag 或结束 → 没有检查命令（只靠 --judge）。
        if (next !== undefined && !next.startsWith("-")) {
          check = next;
          i += 1;
        } else {
          check = "";
        }
        break;
      }
      case "--judge":
        judge = argv[++i] ?? "";
        break;
      case "--max":
        maxRaw = argv[++i] ?? "";
        break;
      case "--max-minutes":
        maxMinutesRaw = argv[++i] ?? "";
        break;
      case "-y":
      case "--yes":
        autoApprove = true;
        break;
      default:
        break;
    }
  }

  // 完全没有 --drive / --judge：普通 -p，不接管（行为完全不变）。
  // 注意：`--drive` 后面没跟命令（sawDrive=true, check=""）仍算「启用」，走下面的条件校验。
  if (!sawDrive && judge === null) return null;

  const criteria = (judge ?? "").trim();
  const checkCmd = (check ?? "").trim();
  if (checkCmd === "" && criteria === "") {
    return {
      ok: false,
      error: "缺少完成条件：给 --drive \"<检查命令>\"（退出码 0 = 达成）或 --judge \"<标准>\"（模型判断）",
    };
  }
  if (!autoApprove) {
    return {
      ok: false,
      error: "-p --drive 无人值守需要 -y（自动批准所有操作）；没有人类可以点确认，缺 -y 直接拒绝启动",
    };
  }

  const maxRounds = parseClamped(maxRaw, DEFAULT_MAX_ROUNDS, 1, 20);
  if (maxRounds === null) {
    return { ok: false, error: `--max 必须是 1–20 的整数（收到 "${maxRaw}"）` };
  }
  const maxMinutes = parseClamped(maxMinutesRaw, DEFAULT_MAX_MINUTES, 1, MAX_MAX_MINUTES);
  if (maxMinutes === null) {
    return { ok: false, error: `--max-minutes 必须是 1–${MAX_MAX_MINUTES} 的整数（收到 "${maxMinutesRaw}"）` };
  }

  return {
    ok: true,
    autoApprove,
    spec: {
      check: checkCmd,
      ...(criteria !== "" ? { judge: { criteria } } : {}),
      maxRounds,
      maxMinutes,
    },
  };
}

/**
 * 解析并夹紧数值参数。
 *
 * 未给（null）→ 默认值；给了但不是整数 → `null`（调用方转成用法错误）。
 * 数值本身按 PRD 口径**夹紧**到 [lo, hi]（`--max 0` → 1，`--max 999` → 20）。
 * 刻意**不**把非数字静默替换成默认值：CI 里 `--max abc` 应该立刻失败，
 * 而不是跑满 5 轮才发现参数写错了。
 */
function parseClamped(raw: string | null, fallback: number, lo: number, hi: number): number | null {
  if (raw === null) return fallback;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

/** `-p --drive` 的终态。 */
export type DriveRunStatus = "done" | "exhausted" | "idle-stop" | "timeout";

export interface DriveRunResult {
  status: DriveRunStatus;
  /** 达成来源；未达成为 null（摘要里写 none，绝不冒充 verified）。 */
  source: "verified" | "model" | null;
  /** 已自动推进的轮数（不含首轮）。 */
  rounds: number;
  elapsedMs: number;
  reason: string | null;
}

/**
 * 终态 → 退出码（#52 冻结契约）。
 *
 * 检查命令成功（verified done）= 0；仅模型判断达成（model done）= 3；
 * 其它终态与没有来源的防御性 done = 1。SIGINT 130 与用法错误 2 由调用方在各自路径处理，
 * 不经过这里 —— 它们不是「驱动跑完」的结果。
 */
export function driveExitCode(result: DriveRunResult): number {
  if (result.status !== "done") return 1;
  if (result.source === "verified") return 0;
  if (result.source === "model") return 3;
  return 1;
}

/**
 * 结束时的 stderr 一行结构化摘要（PRD §2.4）。
 *
 * 格式固定为 `[drive] status=<s> source=<s> rounds=<n> elapsed=<n>s`，
 * 便于 CI 用 grep/正则消费。source 未达成时写 `none`。
 */
export function formatDriveSummary(result: DriveRunResult): string {
  const seconds = Math.max(0, Math.round(result.elapsedMs / 1000));
  return `[drive] status=${result.status} source=${result.source ?? "none"} rounds=${result.rounds} elapsed=${seconds}s`;
}
