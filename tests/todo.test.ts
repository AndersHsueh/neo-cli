/**
 * todo.test.ts — issue #10：结构化待办（TodoWrite 类会话 checklist）。
 *
 * 覆盖四件事：
 *  1. 纯逻辑：normalizeTodos 的校验（整表、单 in_progress、空 content、非法 status）；
 *  2. 工具：todo_write 写入/整表替换，回执人可读清单在前；
 *  3. 会话持久化：saveSession → loadSession 后 meta.todos 仍在（临时 NEO_SESSIONS_DIR）；
 *  4. 与压缩解耦：applyCompaction 只换 messages，meta.todos 不受影响。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyCompaction, planCompaction } from "../src/agent/compact.ts";
import { implementedCommandNames } from "../src/cli/commands.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { createSession, loadSession, saveSession, type SessionMeta } from "../src/session.ts";
import { TOOL_NAMES_EXCLUDED_FOR_SUBAGENT } from "../src/tools/index.ts";
import {
  formatTodos,
  makeTodoWriteTool,
  normalizeTodos,
  todosSummary,
  type TodoItem,
} from "../src/tools/todo.ts";
import type { Message } from "../src/llm.ts";

const DIR = mkdtempSync(join(tmpdir(), "neo-todo-"));
process.env["NEO_SESSIONS_DIR"] = DIR;

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  delete process.env["NEO_SESSIONS_DIR"];
});

const item = (content: string, status: TodoItem["status"], id?: string): Record<string, unknown> =>
  id === undefined ? { content, status } : { content, status, id };

describe("T1 normalizeTodos 校验", () => {
  test("T1 合法整表：保留顺序，缺 id 自动生成且唯一", () => {
    const out = normalizeTodos([
      item("读代码", "completed"),
      item("写模块", "in_progress"),
      item("跑测试", "pending"),
      item("跳过的事", "cancelled"),
    ]);
    expect(out.map((t) => t.status)).toEqual(["completed", "in_progress", "pending", "cancelled"]);
    expect(out.map((t) => t.content)).toEqual(["读代码", "写模块", "跑测试", "跳过的事"]);
    expect(new Set(out.map((t) => t.id)).size).toBe(4);
    for (const t of out) expect(t.id.length).toBeGreaterThan(0);
  });

  test("T1 显式 id 原样保留", () => {
    const out = normalizeTodos([item("a", "pending", "keep-me")]);
    expect(out[0]?.id).toBe("keep-me");
  });

  test("T1 拒绝两个 in_progress", () => {
    expect(() => normalizeTodos([item("a", "in_progress"), item("b", "in_progress")])).toThrow(
      /最多一项 in_progress/,
    );
  });

  test("T1 拒绝空 content / 非法 status / 非数组 / 重复 id", () => {
    expect(() => normalizeTodos([item("   ", "pending")])).toThrow(/content 不能为空/);
    expect(() => normalizeTodos([{ content: "a", status: "doing" }])).toThrow(/status 非法/);
    expect(() => normalizeTodos([{ content: "a" }])).toThrow(/status 非法/);
    expect(() => normalizeTodos("nope")).toThrow(/必须是数组/);
    expect(() => normalizeTodos([item("a", "pending", "x"), item("b", "pending", "x")])).toThrow(
      /id 重复/,
    );
  });

  test("T1 空数组合法（清空）", () => {
    expect(normalizeTodos([])).toEqual([]);
  });
});

describe("T2 formatTodos / todosSummary", () => {
  const items = normalizeTodos([
    item("读代码", "completed"),
    item("写模块", "in_progress"),
    item("跑测试", "pending"),
    item("不做", "cancelled"),
  ]);

  test("T2 清单含标记与进度", () => {
    const s = formatTodos(items);
    expect(s.split("\n")[0]).toBe("待办 1/4");
    expect(s).toContain("[x] 读代码");
    expect(s).toContain("[>] 写模块");
    expect(s).toContain("[ ] 跑测试");
    expect(s).toContain("[-] 不做");
    expect(formatTodos([])).toBe("");
  });

  test("T2 摘要分母排除 cancelled", () => {
    expect(todosSummary(items)).toBe("✓1/3");
    expect(todosSummary([])).toBeNull();
    expect(todosSummary(normalizeTodos([item("a", "cancelled")]))).toBeNull();
    expect(todosSummary(normalizeTodos([item("a", "completed"), item("b", "pending")]))).toBe("✓1/2");
  });
});

describe("T3 todo_write 工具", () => {
  function makeTool(): { tool: ReturnType<typeof makeTodoWriteTool>; state: { items: TodoItem[]; saves: number } } {
    const state = { items: [] as TodoItem[], saves: 0 };
    const tool = makeTodoWriteTool({
      get: () => state.items,
      set: (v) => {
        state.items = v;
      },
      persist: () => {
        state.saves += 1;
      },
    });
    return { tool, state };
  }

  test("T3 写入后会话态与回执正确（人可读清单在前）", async () => {
    const { tool, state } = makeTool();
    const out = await tool.execute(
      { todos: [item("读代码", "completed"), item("写模块", "in_progress")] },
      {} as never,
    );
    expect(state.items.length).toBe(2);
    expect(state.items[1]?.status).toBe("in_progress");
    expect(state.saves).toBe(1);
    // 第一行是人可读摘要，清单在 JSON 之前
    const lines = out.split("\n");
    expect(lines[0]).toContain("已更新待办");
    expect(out.indexOf("[x] 读代码")).toBeGreaterThan(0);
    expect(out.indexOf("[x] 读代码")).toBeLessThan(out.indexOf("[" + "{"));
    expect(out).toContain("进行中：写模块");
  });

  test("T3 整表替换：第二次提交的清单覆盖第一次", async () => {
    const { tool, state } = makeTool();
    await tool.execute({ todos: [item("a", "pending"), item("b", "pending")] }, {} as never);
    const out = await tool.execute({ todos: [item("a", "completed")] }, {} as never);
    expect(state.items.map((t) => t.content)).toEqual(["a"]);
    expect(state.items[0]?.status).toBe("completed");
    expect(out).not.toContain("b");
  });

  test("T3 两个 in_progress 抛错且不改会话态", async () => {
    const { tool, state } = makeTool();
    await tool.execute({ todos: [item("a", "pending")] }, {} as never);
    expect(() =>
      tool.execute({ todos: [item("a", "in_progress"), item("b", "in_progress")] }, {} as never),
    ).toThrow(/最多一项 in_progress/);
    expect(state.items.map((t) => t.content)).toEqual(["a"]);
  });

  test("T3 空数组 = 清空", async () => {
    const { tool, state } = makeTool();
    await tool.execute({ todos: [item("a", "pending")] }, {} as never);
    const out = await tool.execute({ todos: [] }, {} as never);
    expect(state.items).toEqual([]);
    expect(out).toContain("待办已清空");
    expect(out).toContain("[]");
  });

  test("T3 spec：名字/必填/kind/不并行/子代理不可见", () => {
    const { tool } = makeTool();
    expect(tool.spec.function.name).toBe("todo_write");
    expect(tool.spec.function.parameters.required).toEqual(["todos"]);
    expect(tool.spec.function.description).toContain("in_progress");
    expect(tool.kind).toBe("neither");
    expect(tool.sensitive).toBe(false);
    expect(tool.parallelizable).toBeUndefined();
    expect(TOOL_NAMES_EXCLUDED_FOR_SUBAGENT).toContain("todo_write");
  });
});

describe("T4 会话持久化与压缩解耦", () => {
  let meta: SessionMeta;

  beforeEach(() => {
    meta = createSession("test-model", DIR).meta;
  });

  test("T4 saveSession → loadSession 后 meta.todos 仍在", () => {
    const todos = normalizeTodos([item("读代码", "completed"), item("写模块", "in_progress")]);
    meta.todos = todos;
    saveSession([{ role: "user", content: "hi" }], meta);

    const loaded = loadSession(meta.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.meta.todos).toEqual(todos);
    expect(loaded?.meta.todos?.[1]?.status).toBe("in_progress");
  });

  test("T4 旧会话没有 todos 字段 = undefined（兼容）", () => {
    saveSession([{ role: "user", content: "hi" }], meta);
    const loaded = loadSession(meta.id);
    expect(loaded?.meta.todos).toBeUndefined();
  });

  test("T4 压缩只换 messages，meta.todos 不受影响", () => {
    const todos = normalizeTodos([item("a", "completed"), item("b", "in_progress")]);
    meta.todos = todos;

    const messages: Message[] = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 8 }, (_, i): Message => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      })),
    ];
    const plan = planCompaction(messages);
    const compacted = applyCompaction(messages, "摘要正文", plan);

    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted.some((m) => typeof m.content === "string" && m.content.includes("摘要正文"))).toBe(true);
    // 清单独立于对话摘要：压缩前后同一份
    expect(meta.todos).toEqual(todos);
    expect(formatTodos(meta.todos ?? [])).toContain("[>] b");
  });
});

describe("T5 /todos 命令接线", () => {
  test("T5 COMMANDS 含 todos，且 handleCommand 有对应 case", () => {
    expect(COMMANDS.map((c) => c.name)).toContain("todos");
    expect(implementedCommandNames()).toContain("todos");
  });
});
