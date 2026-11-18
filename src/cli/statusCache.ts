/**
 * cli/statusCache.ts — getStatus() 里昂贵字段的 TTL 缓存（issue #76）。
 *
 * 状态行每帧都会问一次 getStatus()；其中两件事不该按帧重复做：
 *  - `getBranch()` 要 spawn 一次 git；
 *  - `ctxUsage()` 要遍历 messages 统计 token。
 *
 * 这里给两者各自一份「时间窗口缓存」：窗口内直接返回上次的值，超过 TTL 才重算。
 * 两个字段**各自计时**，只读其中一个不会顺带刷新另一个的时钟。
 *
 * 注意：这不改变 getBranch 自身的永久 cwd 缓存语义（git.ts 的「会话中途切分支
 * 不在本版范围」），只是把「每帧问一次」降成「每 TTL 问一次」。
 */

/** 字段缓存窗口：500ms，与 repl.ctxUsage 既有节流口径一致。 */
export const STATUS_FIELD_TTL_MS = 500;

export interface ThrottledStatusFieldsDeps<TBranch> {
  getBranch: () => TBranch;
  ctxUsage: () => number;
  /** 时钟注入（测试用）；默认 Date.now。 */
  now?: () => number;
  /** 覆盖默认 TTL（测试用）。 */
  ttlMs?: number;
}

export interface ThrottledStatusFields<TBranch> {
  branch: () => TBranch;
  ctxUsage: () => number;
}

/** 单个字段的 TTL 缓存槽：第一次调用即计算，之后按各自的时间戳判断是否过期。 */
function makeSlot<T>(compute: () => T, now: () => number, ttlMs: number): () => T {
  let cached: T;
  let computedAt = Number.NEGATIVE_INFINITY;
  let valid = false;
  return (): T => {
    const t = now();
    if (!valid || t - computedAt >= ttlMs) {
      cached = compute();
      computedAt = t;
      valid = true;
    }
    return cached;
  };
}

/**
 * 包一层 getStatus 用的节流字段。返回值形状与 getStatus 里要填的两个键同名，
 * 便于直接展开进状态对象。
 */
export function createThrottledStatusFields<TBranch>(
  deps: ThrottledStatusFieldsDeps<TBranch>,
): ThrottledStatusFields<TBranch> {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? STATUS_FIELD_TTL_MS;
  return {
    branch: makeSlot(deps.getBranch, now, ttlMs),
    ctxUsage: makeSlot(deps.ctxUsage, now, ttlMs),
  };
}
