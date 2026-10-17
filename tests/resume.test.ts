/**
 * /resume 交互恢复的单元测试。
 *
 * 覆盖两块纯逻辑（不发起 LLM 请求）：
 *  1. applyRestored —— 恢复消息的组装规则（保留当前 system，过滤历史里的 system）
 *  2. 持久化重定向 —— Object.assign(meta, full.meta) 后 persist 写入目标会话文件，
 *     且原会话文件不被破坏
 *
 * 会话目录经 NEO_SESSIONS_DIR 注入沙箱，不碰用户真实的 ~/.neo/sessions。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyRestored,
  createSession,
  saveSession,
  loadSession,
  listSessions,
} from "../src/session.ts";
import type { Message } from "../src/llm.ts";

const SANDBOX = join(tmpdir(), `neo-resume-test-${Date.now()}`);

beforeAll(() => {
  process.env["NEO_SESSIONS_DIR"] = SANDBOX;
  mkdirSync(SANDBOX, { recursive: true });
});

afterAll(() => {
  delete process.env["NEO_SESSIONS_DIR"];
  rmSync(SANDBOX, { recursive: true, force: true });
});

function msg(role: Message["role"], content: string): Message {
  return { role, content };
}

/** 复刻 index.ts persist() 的落盘逻辑，供重定向断言用。 */
function persistLike(messages: Message[], meta: Parameters<typeof saveSession>[1]): void {
  const copy = messages.filter((m) => m.role !== "system");
  meta.turns = copy.filter((m) => m.role === "user").length;
  saveSession(copy, meta);
}

describe("applyRestored", () => {
  test("保留当前 system，过滤 restored 中的 system", () => {
    const sys = msg("system", "current-sys");
    const restored = [
      msg("system", "old-sys"),
      msg("user", "hi"),
      msg("assistant", "yo"),
    ];
    const out = applyRestored(sys, restored);
    expect(out.length).toBe(3);
    expect(out[0]?.role).toBe("system");
    expect(out[0]?.content).toBe("current-sys");
    expect(out.slice(1).every((m) => m.role !== "system")).toBe(true);
  });

  test("无 system 时只保留 restored 的非 system 消息", () => {
    const out = applyRestored(undefined, [msg("user", "hi"), msg("system", "s")]);
    expect(out.length).toBe(1);
    expect(out[0]?.content).toBe("hi");
  });

  test("保留 tool 消息与 tool_calls（agent 循环依赖它们）", () => {
    const restored: Message[] = [
      msg("user", "q"),
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "grep", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", name: "grep", content: "result" },
    ];
    const out = applyRestored(msg("system", "s"), restored);
    expect(out.length).toBe(4);
    expect(out[2]?.tool_calls?.[0]?.function.name).toBe("grep");
    expect(out[3]?.role).toBe("tool");
  });
});

describe("resume 持久化重定向", () => {
  test("恢复后写入目标会话文件，原会话内容不丢、当前会话文件不动", () => {
    // 历史会话 A：两轮对话
    const a = createSession("model-a", "/tmp/a");
    saveSession([msg("user", "q1"), msg("assistant", "a1")], a.meta);
    // 当前会话 B：一轮
    const b = createSession("model-b", "/tmp/b");
    saveSession([msg("user", "q2")], b.meta);
    const bId = b.meta.id; // Object.assign 会原地改写 b.meta（这正是重定向机制本身），先快照

    // 模拟 /resume a：handleCommand 拿到的 meta 是 sess.meta 的同一引用
    const full = loadSession(a.meta.id);
    expect(full).not.toBeNull();
    expect(full!.messages.length).toBe(2);
    const meta = b.meta;
    Object.assign(meta, full!.meta, { model: "model-c" });
    const messages = applyRestored(msg("system", "sys"), full!.messages);
    messages.push(msg("user", "q2")); // 恢复后的新一轮对话
    persistLike(messages, meta);

    // 目标会话被续写：原 2 条 + 新 1 条，model 已同步
    const after = loadSession(a.meta.id);
    expect(after?.messages.length).toBe(3);
    expect(after?.messages[0]?.content).toBe("q1");
    expect(after?.messages[2]?.content).toBe("q2");
    expect(after?.meta.model).toBe("model-c");
    expect(after?.meta.turns).toBe(2);
    // 当前会话文件未被改动
    const bAfter = loadSession(bId);
    expect(bAfter?.messages.length).toBe(1);
    expect(bAfter?.meta.model).toBe("model-b");
  });

  test("loadSession 支持 id 片段匹配（与 --resume 一致）", () => {
    const s = createSession("m", "/tmp");
    saveSession([msg("user", "x")], s.meta);
    const frag = s.meta.id.slice(-6);
    const full = loadSession(frag);
    expect(full?.meta.id).toBe(s.meta.id);
  });

  test("loadSession 对不存在的 id 返回 null", () => {
    expect(loadSession("no-such-id-zzz")).toBeNull();
  });

  test("listSessions 能看到沙箱内全部会话", () => {
    const list = listSessions(20);
    expect(list.length).toBe(3);
  });
});
