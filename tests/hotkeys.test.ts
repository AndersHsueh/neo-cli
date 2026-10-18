/**
 * 热键系统测试：HotkeyRouter 按键映射、doubleStrike 双击窗口、
 * Agent.send 的 rollbackOnAbort 回滚。
 *
 * Agent 测试通过 AgentOptions.chatStream 注入假实现 ——
 * 不用 mock.module：bun test 单进程共享模块表，mock 会泄漏到其它测试文件。
 *
 * 运行：bun test tests/hotkeys.test.ts
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { HotkeyRouter, doubleStrike } from "../src/hotkeys.ts";
import { Agent, type AgentOptions } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import type { StreamResult } from "../src/llm.ts";
import type { Console } from "../src/ui/console.ts";

/* ------------------------------------------------------------------ */
/* HotkeyRouter                                                        */
/* ------------------------------------------------------------------ */

/** 伪造一个带 input 流的 readline，直接 emit keypress 模拟按键。 */
function makeFakeRl(): { rl: EventEmitter; input: EventEmitter; emitKey: (k: object) => void } {
  const rl = new EventEmitter() as EventEmitter & { input?: EventEmitter };
  const input = new EventEmitter();
  (rl as { input?: EventEmitter }).input = input;
  const emitKey = (k: object) => rl.emit("keypress", "", k);
  return { rl, input, emitKey };
}

describe("HotkeyRouter", () => {
  test("escape 触发注册的处理函数", () => {
    const { rl, input, emitKey } = makeFakeRl();
    const router = new HotkeyRouter();
    router.attach(rl as never, input as never);
    let hits = 0;
    router.on("escape", () => hits++);
    emitKey({ name: "escape", ctrl: false, meta: false, shift: false });
    expect(hits).toBe(1);
  });

  test("方向键映射到各自的名字", () => {
    const { rl, input, emitKey } = makeFakeRl();
    const router = new HotkeyRouter();
    router.attach(rl as never, input as never);
    const hits: string[] = [];
    router.on("up", () => hits.push("up"));
    router.on("down", () => hits.push("down"));
    router.on("left", () => hits.push("left"));
    router.on("right", () => hits.push("right"));
    emitKey({ name: "up", ctrl: false, meta: false, shift: false });
    emitKey({ name: "down", ctrl: false, meta: false, shift: false });
    emitKey({ name: "left", ctrl: false, meta: false, shift: false });
    emitKey({ name: "right", ctrl: false, meta: false, shift: false });
    expect(hits).toEqual(["up", "down", "left", "right"]);
  });

  test("ctrl/meta 组合不触发（信号语义归 SIGINT，不归 keypress）", () => {
    const { rl, input, emitKey } = makeFakeRl();
    const router = new HotkeyRouter();
    router.attach(rl as never, input as never);
    let hits = 0;
    router.on("escape", () => hits++);
    emitKey({ name: "escape", ctrl: true, meta: false, shift: false });
    emitKey({ name: "escape", ctrl: false, meta: true, shift: false });
    expect(hits).toBe(0);
  });

  test("未注册的键不触发任何 handler", () => {
    const { rl, input, emitKey } = makeFakeRl();
    const router = new HotkeyRouter();
    router.attach(rl as never, input as never);
    let hits = 0;
    router.on("escape", () => hits++);
    emitKey({ name: "a", ctrl: false, meta: false, shift: false });
    emitKey({ name: "f5", ctrl: false, meta: false, shift: false });
    expect(hits).toBe(0);
  });

  test("detach 后不再触发", () => {
    const { rl, input, emitKey } = makeFakeRl();
    const router = new HotkeyRouter();
    router.attach(rl as never, input as never);
    let hits = 0;
    router.on("escape", () => hits++);
    router.detach();
    emitKey({ name: "escape", ctrl: false, meta: false, shift: false });
    expect(hits).toBe(0);
  });

  test("on 返回的取消函数能移除单个 handler", () => {
    const { rl, input, emitKey } = makeFakeRl();
    const router = new HotkeyRouter();
    router.attach(rl as never, input as never);
    let hits = 0;
    const off = router.on("escape", () => hits++);
    off();
    emitKey({ name: "escape", ctrl: false, meta: false, shift: false });
    expect(hits).toBe(0);
  });

  test("同一键注册多个 handler 全部触发", () => {
    const { rl, input, emitKey } = makeFakeRl();
    const router = new HotkeyRouter();
    router.attach(rl as never, input as never);
    let a = 0;
    let b = 0;
    router.on("escape", () => a++);
    router.on("escape", () => b++);
    emitKey({ name: "escape", ctrl: false, meta: false, shift: false });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* doubleStrike                                                        */
/* ------------------------------------------------------------------ */

describe("doubleStrike", () => {
  test("窗口内两次调用执行一次 action", () => {
    let fired = 0;
    const flashes: string[] = [];
    const strike = doubleStrike(() => fired++, {
      windowMs: 2000,
      notice: "Press Ctrl+C again to exit",
      flash: (t) => flashes.push(t),
    });
    strike();
    strike();
    expect(fired).toBe(1);
    expect(flashes).toEqual(["Press Ctrl+C again to exit"]);
  });

  test("窗口超时后重新武装，第二次不执行", async () => {
    let fired = 0;
    const strike = doubleStrike(() => fired++, {
      windowMs: 30,
      notice: "n",
      flash: () => {},
    });
    strike();
    await new Promise((r) => setTimeout(r, 50));
    strike();
    expect(fired).toBe(0);
  });

  test("三次调用 = 执行一次 + 重新武装", async () => {
    let fired = 0;
    const strike = doubleStrike(() => fired++, {
      windowMs: 30,
      notice: "n",
      flash: () => {},
    });
    strike();
    strike(); // 执行
    await new Promise((r) => setTimeout(r, 50)); // 超时解除
    strike(); // 重新武装
    strike(); // 执行
    expect(fired).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Agent.send 回滚                                                     */
/* ------------------------------------------------------------------ */

interface ConsoleLike {
  info(msg?: string): void;
  warn(msg?: string): void;
  error(msg?: string): void;
  line(s?: string): void;
  blank(): void;
  kv(k: string, v: string): void;
  statusBar(f: Array<[string, string]>): void;
  toolHeader(n: string, a: string): void;
  toolResult(b: string, m?: number): void;
  startSpinner(t: string): void;
  stopSpinner(f?: string): void;
  beginStream(k: string): void;
  writeStream(t: string, k: string): void;
  endStream(k: string): void;
  ensureStreamClosed(k: string): void;
  indent(b: string): string;
  width: number;
  confirm(q: string): Promise<boolean>;
}

function quietConsole(): Console {
  return {
    info() {}, warn() {}, error() {}, line() {}, blank() {}, kv() {}, statusBar() {},
    toolHeader() {}, toolResult() {}, startSpinner() {}, stopSpinner() {},
    beginStream() {}, writeStream() {}, endStream() {}, ensureStreamClosed() {},
    indent: (s: string) => s, width: 100, confirm: async () => true,
  } as unknown as Console;
}

/**
 * 构造带注入 chatStream 的 Agent。
 * impl 在每次「LLM 请求」时被调用，可经返回的 ref.cancel() 触发取消。
 */
function makeAgent(
  impl: (handlers: { onContent?: (d: string) => void }) => Promise<Partial<StreamResult>>,
): { agent: Agent; cancel: () => void } {
  const cfg = loadConfig({ apiKey: "x" });
  const opts: AgentOptions = {
    cfg,
    console: quietConsole(),
    mode: "auto-all",
    systemPrompt: "sys",
    chatStream: async (_cfg, _msgs, _tools, handlers) => {
      const r = await impl(handlers as { onContent?: (d: string) => void });
      return {
        content: "", reasoning: "", toolCalls: [], finishReason: null, usage: null, raw: null,
        ...r,
      } as StreamResult;
    },
  };
  const agent = new Agent(opts);
  return { agent, cancel: () => agent.cancel() };
}

describe("Agent.send rollbackOnAbort", () => {
  test("abort 后历史截回本轮开始前，user 消息一并移除", async () => {
    const { agent, cancel } = makeAgent(async (handlers) => {
      handlers.onContent?.("部分回答…");
      cancel(); // 流式中途取消（模拟用户按 ESC）
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    const before = agent.messages.length;
    const stats = await agent.send("这条要被回滚", { rollbackOnAbort: true });

    expect(stats.aborted).toBe(true);
    expect(agent.messages.length).toBe(before);
    const texts = agent.messages.map((m) => String(m.content ?? ""));
    expect(texts.some((t) => t.includes("这条要被回滚"))).toBe(false);
  });

  test("不开启 rollbackOnAbort 时，半截历史保留（Ctrl+C 语义）", async () => {
    const { agent, cancel } = makeAgent(async (handlers) => {
      handlers.onContent?.("部分回答…");
      cancel();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    const before = agent.messages.length;
    const stats = await agent.send("这条要保留");

    expect(stats.aborted).toBe(true);
    expect(agent.messages.length).toBe(before + 1);
    const texts = agent.messages.map((m) => String(m.content ?? ""));
    expect(texts.some((t) => t.includes("这条要保留"))).toBe(true);
  });

  test("正常完成不触发回滚，历史完整", async () => {
    const { agent } = makeAgent(async (handlers) => {
      handlers.onContent?.("完整回答");
      return { content: "完整回答", finishReason: "stop" };
    });

    const before = agent.messages.length;
    const stats = await agent.send("正常问题", { rollbackOnAbort: true });

    expect(stats.aborted).toBe(false);
    expect(agent.messages.length).toBe(before + 2); // user + assistant
    expect(stats.finishReason).toBe("stop");
  });
});
