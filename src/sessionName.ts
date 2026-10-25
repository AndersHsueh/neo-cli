/**
 * sessionName.ts — 会话代号的随机选择（v0.3.1，纯逻辑）。
 *
 * 规则（用户 2026-10-26 拍板）：
 *  - 显式 --name 最高优先级（撞名交给 identity.pickUniqueName 加后缀）；
 *  - resume 有旧名 → 保留，绝不随机；
 *  - 否则从《黑客帝国》角色池里随机取「未被存活会话占用」的；
 *    撞名不后缀，换下一个候选；
 *  - 池全被占用 → 随机挑一个角色，交给 pickUniqueName 加后缀（如 Trinity-2）。
 *
 * rng 注入让单测可固定序列；本模块无 IO。
 */

export const NEO_ROLE_POOL = [
  "neo",
  "Trinity",
  "Morpheus",
  "Cypher",
  "Niobe",
  "Seraph",
  "Oracle",
  "Switch",
  "Tank",
  "Link",
  "Ghost",
  "Keymaker",
] as const;


export interface ChooseNameInput {
  /** --name 显式指定。 */
  explicit?: string | null;
  /** resume 命中的旧 profile.name。 */
  previous?: string | null;
  /** 存活会话已占用的名字（调用方用 takenAliveNames 生成）。 */
  taken: ReadonlySet<string>;
  /** 随机源；默认 Math.random。 */
  rng?: () => number;
  /** 候选池（测试可注入小池）。 */
  pool?: readonly string[];
}

export interface ChosenName {
  name: string;
  source: "explicit" | "resume" | "random" | "fallback";
}

/** [0,n) 的随机下标；rng 返回 1 / 越界时也保证不越界。 */
function pickIndex(rng: () => number, n: number): number {
  if (n <= 0) return 0;
  const v = Math.floor(rng() * n);
  return Math.min(n - 1, Math.max(0, Number.isFinite(v) ? v : 0));
}

/** 从池中随机取一个未被占用的名字；全占返回 null。 */
export function pickUnusedRole(
  taken: ReadonlySet<string>,
  rng: () => number = Math.random,
  pool: readonly string[] = NEO_ROLE_POOL,
): string | null {
  const free = pool.filter((n) => !taken.has(n));
  if (free.length === 0) return null;
  return free[pickIndex(rng, free.length)] ?? null;
}

/**
 * 选择会话名。返回值可能是池内角色，也可能来自 explicit/previous；
 * 唯一性由调用方交给 identity.pickUniqueName 处理（fallback 会因此拿到 -2 后缀）。
 */
export function chooseSessionName(input: ChooseNameInput): ChosenName | null {
  const explicit = input.explicit?.trim();
  if (explicit) return { name: explicit, source: "explicit" };
  const previous = input.previous?.trim();
  if (previous) return { name: previous, source: "resume" };

  const pool = input.pool ?? NEO_ROLE_POOL;
  const rng = input.rng ?? Math.random;
  const free = pickUnusedRole(input.taken, rng, pool);
  if (free !== null) return { name: free, source: "random" };
  if (pool.length === 0) return null;
  const fallback = pool[pickIndex(rng, pool.length)];
  return fallback === undefined ? null : { name: fallback, source: "fallback" };
}
