/**
 * 会话代号随机选择（v0.3.1 A1/A2）：固定 rng 的候选序、撞名换候选、池耗尽 fallback。
 */
import { describe, expect, test } from "bun:test";
import { chooseSessionName, NEO_ROLE_POOL, pickUnusedRole } from "../src/sessionName.ts";

const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
};

describe("N1 会话代号选择", () => {
  test("N1a 显式 --name 优先于一切", () => {
    expect(chooseSessionName({ explicit: "Jacky", previous: "Trinity", taken: new Set(), rng: seq(0) }))
      .toEqual({ name: "Jacky", source: "explicit" });
  });

  test("N1b resume 旧名保留，绝不随机", () => {
    const rng = (): number => {
      throw new Error("不应调用 rng");
    };
    expect(chooseSessionName({ previous: "Trinity", taken: new Set(), rng }))
      .toEqual({ name: "Trinity", source: "resume" });
  });

  test("N1c 池内随机：按 rng 固定序列取未被占用的候选", () => {
    const taken = new Set(["neo", "Trinity", "Morpheus"]);
    // free = Cypher,Niobe,Seraph,Oracle,Switch,Tank,Link,Ghost,Keymaker；0 → Cypher
    expect(chooseSessionName({ taken, rng: seq(0) })).toEqual({ name: "Cypher", source: "random" });
    // 0.99 → 最后一个 Keymaker
    expect(chooseSessionName({ taken, rng: seq(0.99) })).toEqual({ name: "Keymaker", source: "random" });
  });

  test("N1d 撞名不加后缀、直接换下一个候选（由 free 列表保证）", () => {
    const taken = new Set(["neo"]);
    expect(pickUnusedRole(taken, seq(0))).toBe("Trinity");
    expect(pickUnusedRole(taken, seq(0.5))).toBe("Oracle");
  });

  test("N1e 池全占 → fallback（随机角色，交给上层加后缀）", () => {
    const taken = new Set<string>(NEO_ROLE_POOL);
    expect(chooseSessionName({ taken, rng: seq(0.42) }))
      .toEqual({ name: NEO_ROLE_POOL[Math.floor(0.42 * NEO_ROLE_POOL.length)]!, source: "fallback" });
  });

  test("N1f 空池 + 无显式/旧名 → null", () => {
    expect(chooseSessionName({ taken: new Set(), pool: [] })).toBeNull();
  });

  test("N1g rng=1 / 负数不越界", () => {
    expect(pickUnusedRole(new Set(), () => 1)).toBe(NEO_ROLE_POOL[NEO_ROLE_POOL.length - 1]!);
    expect(pickUnusedRole(new Set(), () => -1)).toBe(NEO_ROLE_POOL[0]);
  });
});
