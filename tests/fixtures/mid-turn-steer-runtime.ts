/**
 * #66 运行中转向：真实组合根回归（bootstrap → startSession → createRepl → drain）。
 * 只由沙箱化的 tests/mid-turn-steer-66-host.test.ts 拉起；模型请求走进程内假 stream。
 */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "../../src/cli/bootstrap.ts";
import { startSession } from "../../src/cli/sessionStart.ts";
import { createRepl } from "../../src/cli/repl.ts";
import { STEERED_CANCEL_NOTICE, recallQueuedUser } from "../../src/cli/midTurnSteer.ts";
import { contentText, type Message, type StreamResult } from "../../src/llm.ts";
import { stripAnsi } from "../../src/tui/ansi.ts";

process.argv = [process.argv[0]!, "neo", "--auto", "off"];
const boot = await bootstrap();
assert.notEqual(typeof boot, "number");
if (typeof boot === "number") process.exit(boot);
const s = await startSession(boot);
const repl = createRepl(s);
const agent = s.agent;
writeFileSync(join(s.cfg.cwd, "a.txt"), "hello-steer\n");
// 补签 4：运行中注入只在 stdin 是 TTY 时生效；本夹具 stdin 是 ignore，按需模拟 TTY / 管道。
const setTTY = (v: boolean): void => {
  Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true, writable: true });
};
setTTY(true);
const uiLines: string[] = [];
const origLine = s.ui.line.bind(s.ui);
s.ui.line = (text?: string): void => {
  uiLines.push(stripAnsi(text ?? ""));
  origLine(text);
};

type Step = (messages: Message[]) => Partial<StreamResult> | Promise<Partial<StreamResult>>;
const script: Step[] = [];
let requests = 0;
const fake = async (_cfg: unknown, messages: Message[]): Promise<StreamResult> => {
  requests++;
  const step = script.shift();
  if (!step) throw new Error(`script exhausted at request ${requests}`);
  const r = await step(JSON.parse(JSON.stringify(messages)) as Message[]);
  return { content: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null, ...r } as StreamResult;
};
(agent.opt as { mainChatStream?: unknown }).mainChatStream = fake;
(agent.opt as { chatStream?: unknown }).chatStream = fake;

let seq = 0;
const toolStep = (): Partial<StreamResult> => ({
  toolCalls: [{ id: `c${seq++}`, type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
  finishReason: "tool_calls",
});
const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });
const usersAfterTool = (ms: Message[]): string[] => {
  const t = ms.map((m) => m.role).lastIndexOf("tool");
  return ms.slice(t + 1).filter((m) => m.role === "user").map((m) => contentText(m.content) ?? "");
};
const userTexts = (ms: Message[]): string[] => ms.filter((m) => m.role === "user").map((m) => contentText(m.content) ?? "");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---- R1：切点注入（含 @ 展开）；非真人/斜杠/!/shell/loop/mailbox/notice/monitor 不走此路 ----
const rewindBefore = s.rewindLog.list().length;
repl.queue.push(
  { text: "读 a.txt", attachments: [], origin: "user" },
  { text: "/todos", attachments: [], origin: "user" },
  { text: "!true", attachments: [], origin: "user" },
  { text: "true", attachments: [], origin: "user", shell: true },
  { text: "LOOP tick", attachments: [], origin: "user", loop: true },
  { text: "MAILBOX frame", attachments: [], origin: "mailbox", from: "peer" },
  { text: "NOTICE frame", attachments: [], origin: "notice", from: "peer" },
  { text: "MONITOR event", attachments: [], origin: "monitor" },
  { text: "STEER one @a.txt", attachments: [], origin: "user" },
  { text: "STEER two", attachments: [], origin: "user" },
);
let r1Queue: string[] = [];
script.push(
  () => toolStep(),
  async (ms) => {
    const injected = usersAfterTool(ms);
    assert.equal(injected.length, 2, `injected=${JSON.stringify(injected)}`);
    assert.ok(injected[0]!.startsWith("STEER one"));
    assert.ok(injected[0]!.includes("hello-steer"), "@ 引用应按 drain 同规则展开");
    assert.equal(injected[1], "STEER two");
    r1Queue = repl.queue.map((q) => q.text);
    // busy 下 Ctrl+X Ctrl+S（onFlushQueue → runDrainSafely）仍是空操作。
    const before = requests;
    repl.runDrainSafely();
    await tick();
    assert.equal(requests, before);
    assert.deepEqual(repl.queue.map((q) => q.text), r1Queue);
    repl.queue.splice(0); // 剩余条目不在本夹具里执行
    return { content: "R1 done" };
  },
);
await repl.drain();
assert.deepEqual(r1Queue, ["/todos", "!true", "true", "LOOP tick", "MAILBOX frame", "NOTICE frame", "MONITOR event"]);
assert.equal(s.rewindLog.list().length, rewindBefore + 1, "转向算在本轮那条 rewind 记账里");
assert.deepEqual(userTexts(agent.messages).slice(-3).map((t) => t.split("\n")[0]), ["读 a.txt", "STEER one @a.txt", "STEER two"]);

// ---- R2：注入前取消 → 回滚本轮，未注入的转向留在队列、轮末作为新轮 ----
let r2Notice: string | undefined = "unset";
script.push(
  () => {
    agent.cancel();
    r2Notice = repl.steer.cancelNotice();
    throw abortError();
  },
  (ms) => {
    assert.ok(!userTexts(ms).includes("R2 typo"), "注入前取消应回滚本轮");
    assert.equal(userTexts(ms).at(-1), "STEER residue");
    return { content: "R2 new turn" };
  },
);
repl.queue.push({ text: "R2 typo", attachments: [], origin: "user" }, { text: "STEER residue", attachments: [], origin: "user" });
await repl.drain();
assert.equal(r2Notice, undefined);

// ---- R3：注入后取消 → 只停不删；↑ 只收回未注入条目；Esc 不误杀后台子代理 ----
let bgSignal: AbortSignal | null = null;
let finishBg: (v: string) => void = () => {};
const job = s.backgroundTasks!.launch({
  prompt: "bg task",
  ctx: { cfg: s.cfg, approve: async () => false },
  run: (signal) => {
    bgSignal = signal;
    return new Promise<string>((resolve) => { finishBg = resolve; });
  },
});
assert.equal(job.ok, true);
let r3Notice: string | undefined;
script.push(
  () => toolStep(),
  (ms) => {
    assert.deepEqual(usersAfterTool(ms), ["STEER R3"]);
    repl.submitUserLine("STEER late", []);
    const recalled = recallQueuedUser(repl.queue);
    assert.equal(recalled?.text, "STEER late", "↑ 只收回未注入条目");
    repl.submitUserLine("STEER late", []);
    agent.cancel();
    r3Notice = repl.steer.cancelNotice();
    throw abortError();
  },
  (ms) => {
    const users = userTexts(ms);
    assert.ok(users.includes("R3 first") && users.includes("STEER R3"), "注入后取消不回滚");
    assert.ok(ms.some((m) => m.role === "tool" && (contentText(m.content) ?? "").includes("hello-steer")), "工具结果保留");
    assert.equal(users.at(-1), "STEER late");
    return { content: "R3 new turn" };
  },
);
repl.queue.push({ text: "R3 first", attachments: [], origin: "user" }, { text: "STEER R3", attachments: [], origin: "user" });
await repl.drain();
assert.equal(r3Notice, STEERED_CANCEL_NOTICE);
assert.equal((bgSignal as AbortSignal | null)?.aborted, false, "Esc 不误杀后台子代理");
finishBg("bg ok");
s.backgroundTasks!.cancel("all");
assert.equal(script.length, 0);

// ---- R4（补签 2、5）：第一条阻断即止；本轮后续切点不再注入；UPS 看到展开后文本；副作用只对确定写入的条目 ----
writeFileSync(join(s.cfg.cwd, "p4.txt"), "pass-content\n");
writeFileSync(join(s.cfg.cwd, "b4.txt"), "blocked-content\n");
const upsMark = process.env.STEER66_UPS_MARK!;
const upsPrompts = (): string[] => {
  try {
    return readFileSync(upsMark, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => String((JSON.parse(l) as { prompt?: unknown }).prompt ?? ""));
  } catch {
    return [];
  }
};
const refLines = (from: number): number => uiLines.slice(from).filter((l) => l.includes("已引用")).length;
const r4LineStart = uiLines.length;
const r4UpsStart = upsPrompts().length;
script.push(
  () => toolStep(),
  (ms) => {
    const injected = usersAfterTool(ms);
    assert.equal(injected.length, 1, `injected=${JSON.stringify(injected)}`);
    assert.ok(injected[0]!.startsWith("STEER pass") && injected[0]!.includes("pass-content"));
    assert.deepEqual(repl.queue.map((q) => q.text), ["STEER BLOCKME @b4.txt", "STEER after"]);
    assert.equal(repl.queue[0]!.steerBlocked, true);
    assert.equal(repl.queue[1]!.steerBlocked, undefined, "阻断条之后的条目不标阻断");
    assert.ok(agent.touchedPaths.has("p4.txt"), "确定写入的条目记 touched path");
    assert.ok(!agent.touchedPaths.has("b4.txt"), "被阻断条目不记 touched path");
    assert.equal(refLines(r4LineStart), 1, `已引用提示只对写入的条目打一次：${JSON.stringify(uiLines.slice(r4LineStart))}`);
    repl.queue.push({ text: "STEER late4", attachments: [], origin: "user" });
    return toolStep();
  },
  (ms) => {
    assert.deepEqual(usersAfterTool(ms), [], "同轮后续切点不再注入");
    return { content: "R4 done" };
  },
  (ms) => {
    assert.equal(userTexts(ms).at(-1), "STEER after", "阻断条作为新轮被 UPS 再拦下后，其后条目各自按序成轮");
    return { content: "R4 after" };
  },
  (ms) => {
    assert.equal(userTexts(ms).at(-1), "STEER late4");
    return { content: "R4 late" };
  },
);
repl.queue.push(
  { text: "R4 first", attachments: [], origin: "user" },
  { text: "STEER pass @p4.txt", attachments: [], origin: "user" },
  { text: "STEER BLOCKME @b4.txt", attachments: [], origin: "user" },
  { text: "STEER after", attachments: [], origin: "user" },
);
await repl.drain();
assert.equal(script.length, 0);
const blockedUps = upsPrompts().slice(r4UpsStart).filter((p) => p.includes("BLOCKME"));
assert.equal(blockedUps.length, 2, `blocked UPS=${JSON.stringify(blockedUps)}`);
assert.ok(blockedUps[0]!.includes("blocked-content"), "运行中 UPS 看到的是展开后文本");
assert.equal(blockedUps[0], blockedUps[1], "运行中 UPS 与 drain 看到同一份展开文本");

// ---- R5（补签 1）：/技能名 排进来的合成消息不可注入，等轮末自成一轮 ----
mkdirSync(join(s.cfg.cwd, "skills", "demo66"), { recursive: true });
writeFileSync(join(s.cfg.cwd, "skills", "demo66", "SKILL.md"), "---\nname: demo66\ndescription: demo skill 66\n---\n\nDEMO66_BODY\n");
script.push(
  () => toolStep(),
  (ms) => {
    assert.deepEqual(usersAfterTool(ms), [], "合成消息不在切点注入");
    assert.equal(repl.queue.length, 1);
    assert.equal(repl.queue[0]!.synthetic, true);
    return { content: "R5 done" };
  },
  (ms) => {
    assert.ok((userTexts(ms).at(-1) ?? "").includes("DEMO66_BODY"), "合成消息自成一轮");
    return { content: "R5 skill" };
  },
);
repl.queue.push({ text: "/demo66", attachments: [], origin: "user" }, { text: "R5 first", attachments: [], origin: "user" });
await repl.drain();
assert.equal(script.length, 0);

// ---- R0（补签 4）：stdin 非 TTY 时不做运行中注入，每行各自成轮 ----
setTTY(false);
script.push(
  () => toolStep(),
  (ms) => {
    assert.deepEqual(usersAfterTool(ms), [], "非 TTY 不注入");
    return { content: "R0 done" };
  },
  (ms) => {
    assert.equal(userTexts(ms).at(-1), "STEER r0");
    return { content: "R0 own turn" };
  },
);
repl.queue.push({ text: "R0 first", attachments: [], origin: "user" }, { text: "STEER r0", attachments: [], origin: "user" });
await repl.drain();
assert.equal(script.length, 0);
s.cleanupEphemeralResources();
console.log("steer-runtime-ok");
