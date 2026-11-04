/**
 * 权限策略与压缩切点。
 *
 * 工具审批和 `!cmd` 共用 decidePermission。这里锁住四档模式，
 * 避免入口和循环各写一套之后再次分叉。
 */
import { describe, expect, test } from "bun:test";

import { decidePermission } from "../src/agent/policy.ts";
import { applyCompaction, planCompaction } from "../src/agent/compact.ts";
import { CAPABILITY_STREAK_LIMIT, budgetMessage } from "../src/agent/steer.ts";
import type { Message } from "../src/llm.ts";

describe("decidePermission", () => {
  test("auto-all 放行 shell", () => {
    expect(decidePermission("auto-all", "shell")).toEqual({ allow: true });
  });

  test("auto-edit 放行写文件，shell 仍要问", () => {
    expect(decidePermission("auto-edit", "write_file")).toEqual({ allow: true });
    expect(decidePermission("auto-edit", "shell")).toEqual({ allow: false, reason: "needs-confirm" });
  });

  test("plan 拒绝一切", () => {
    expect(decidePermission("plan", "read_file")).toEqual({ allow: false, reason: "plan" });
    expect(decidePermission("plan", "shell")).toEqual({ allow: false, reason: "plan" });
  });

  test("ask 一律询问", () => {
    expect(decidePermission("ask", "read_file")).toEqual({ allow: false, reason: "needs-confirm" });
  });
});

describe("planCompaction", () => {
  function user(text: string): Message {
    return { role: "user", content: text };
  }
  function assistant(text: string): Message {
    return { role: "assistant", content: text };
  }

  test("历史太短时拒绝压缩", () => {
    expect(() =>
      planCompaction([
        { role: "system", content: "sys" },
        user("hi"),
        assistant("ok"),
      ]),
    ).toThrow(/太短/);
  });

  test("切点落在 user 之前，不拆开相邻轮次", () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      user("u1"),
      assistant("a1"),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
      user("u4"),
      assistant("a4"),
    ];
    const plan = planCompaction(messages);
    expect(plan.head.length).toBeGreaterThan(0);
    expect(plan.tail[0]?.role).toBe("user");
    expect(plan.head.length + plan.tail.length).toBe(messages.length - 1);

    const next = applyCompaction(messages, "摘要", plan);
    expect(next[0]?.role).toBe("system");
    expect(next[1]?.role).toBe("user");
    expect(String(next[1]?.content)).toContain("摘要");
    expect(next.slice(2)).toEqual(plan.tail);
  });
});

describe("budgetMessage", () => {
  test("有目标且手段计数达到阈值时回锚", () => {
    const msg = budgetMessage(3, 20, "找出作者", CAPABILITY_STREAK_LIMIT);
    const text = String(msg.content);
    expect(text).toContain("找出作者");
    expect(text).toContain("已超过");
    expect(text).toContain(String(CAPABILITY_STREAK_LIMIT));
  });

  test("没有目标时不报手段计数", () => {
    const msg = budgetMessage(2, 20, null, CAPABILITY_STREAK_LIMIT);
    expect(String(msg.content)).not.toContain("扩展手段");
  });

  // attempt 是「第几次请求」（调用方传 iter + 1，iter 从 0 起），本次请求本身还没消耗预算。
  // 旧实现用 remaining = max - attempt，首轮就报「剩余 79/80」、末轮报「仅剩 0 次」，
  // 模型据此提前收手 —— 这里把口径钉死。
  test("剩余次数把本次请求算在内（首轮 = 上限）", () => {
    const text = String(budgetMessage(1, 80, null, 0).content);
    expect(text).toContain("已用 0");
    expect(text).toContain("剩余 80");
  });

  test("末轮剩余 1 次而不是 0 次", () => {
    const text = String(budgetMessage(80, 80, null, 0).content);
    expect(text).toContain("已用 79");
    expect(text).toContain("剩余 1");
    expect(text).toContain("仅剩 1 次");
  });
});
