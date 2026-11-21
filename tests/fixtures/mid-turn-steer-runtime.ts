/**
 * #66 运行中转向：真实组合根回归（bootstrap → startSession → createRepl → drain）。
 * 只由沙箱化的 tests/mid-turn-steer-66-host.test.ts 拉起；模型请求走进程内假 stream。
 */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "../../src/cli/bootstrap.ts";
import { startSession } from "../../src/cli/sessionStart.ts";
import { createRepl } from "../../src/cli/repl.ts";
import { STEERED_CANCEL_NOTICE, recallQueuedUser } from "../../src/cli/midTurnSteer.ts";
import { contentText, type Message, type StreamResult } from "../../src/llm.ts";

process.argv = [process.argv[0]!, "neo", "--auto", "off"];
const boot = await bootstrap();
assert.notEqual(typeof boot, "number");
if (typeof boot === "number") process.exit(boot);
const s = await startSession(boot);
const repl = createRepl(s);
const agent = s.agent;
writeFileSync(join(s.cfg.cwd, "a.txt"), "hello-steer\n");

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
s.cleanupEphemeralResources();
console.log("steer-runtime-ok");
