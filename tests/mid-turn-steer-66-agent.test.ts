/**
 * #66 运行中转向（Agent 层）—— 已签合同：/workspace/neo-cli-issue-66-signed-contract.md。
 *
 * 覆盖【注入边界】1–5、【hooks / #87 / 子代理】6、7、9、【取消语义】10、11 在 Agent 层的部分：
 *  - 切点 = pollInbox 那一处（工具批次回填 + compact 之后、下一次请求之前）；首次请求前 / 终答轮不注入；
 *  - 一个切点取走全部条目、按原序各一条 user、只发一次后续请求；
 *  - 顺序 inbox → background → 转向；另起回调 pollSteer（不复用 pollInbox）；
 *  - 每条注入跑一次 UserPromptSubmit（绕开 ensureUserPromptSubmit 缓存），不 beginUserTurn；
 *  - UPS 阻断：不入历史、留在宿主队列、原因可见；前面已放行的照常注入；
 *  - 注入前取消沿用 rollbackOnAbort；注入后取消只停不删；
 *  - 子代理循环不接收主会话转向。
 * 全部 fake chatStream，不触网、不写真实 home。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentIO } from "../src/agent.ts";
import { parseHooksConfig } from "../src/hooks/index.ts";
import type { Config } from "../src/config.ts";
import { contentText, type Message, type StreamResult, type ToolCall } from "../src/llm.ts";
import { runSubagent } from "../src/tools/task.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-steer66-agent-"));
writeFileSync(join(SANDBOX, "a.txt"), "hello-steer\n", "utf8");
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

function makeCfg(over: Partial<Config> = {}): Config {
  const provider = {
    name: "p1", type: "openai" as const, baseUrl: "http://localhost:0", apiKey: "k",
    models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
    maxTokens: 100, temperature: 0.3, contextWindow: 100_000,
  };
  const route = { provider: "p1", model: null, fallbackAllowed: true };
  return {
    providerName: "p1", providerType: "openai", apiKey: "k", baseUrl: "http://localhost:0",
    modelTier: "default", model: "m", providers: [provider],
    routes: { default: route, deep_reasoning: route, balanced: route, fast: route },
    classifierModel: "x", classifierProvider: "p1", legacyFormat: false,
    maxTokens: 100, temperature: 0.3, contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8, maxToolIterations: 20, toolOutputLimit: 30_000, theme: "matrix",
    showReasoning: false, cwd: SANDBOX, settingsPath: null, skillsStore: join(SANDBOX, "skills"),
    hooks: parseHooksConfig(undefined),
    memory: {
      enabled: false, userLevelDir: join(SANDBOX, "mem"), userWikiDir: join(SANDBOX, "wiki"),
      journalDir: join(SANDBOX, "journal"),
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false, mode: "off" as const, modelTier: "fast", maxOpsPerTurn: 2, maxPagesPerSession: 8,
        minConfidence: 0.65, minInferredConfidence: 0.75, journalRetentionDays: 7, flushTimeoutMs: 3000,
      },
      quiet: true,
    },
    ...over,
  } as unknown as Config;
}

interface SpyIO extends AgentIO { warns: string[]; errors: string[] }
function spyIO(): SpyIO {
  const warns: string[] = [];
  const errors: string[] = [];
  const io: AgentIO = {
    line() {}, blank() {}, info() {}, warn(m: string) { warns.push(m); }, error(m: string) { errors.push(m); },
    toolHeader() {}, toolResult() {},
    indent(body: string, prefix = "│ ") { return body.split("\n").map((l) => prefix + l).join("\n"); },
    startSpinner() {}, updateSpinner() {}, stopSpinner() {}, beginStream() {}, writeStream() {}, endStream() {},
    ensureStreamClosed() {}, async confirm() { return true; }, width: 100,
  };
  return Object.assign(io, { warns, errors }) as SpyIO;
}

function result(over: Partial<StreamResult> = {}): StreamResult {
  return { content: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null, ...over } as StreamResult;
}
let callSeq = 0;
function readCall(): ToolCall {
  return { id: `call_${callSeq++}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } };
}
const toolStep = (): Partial<StreamResult> => ({ content: "", toolCalls: [readCall()], finishReason: "tool_calls" });

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** 宿主侧假队列：claim 时摘除、block 时留下并记原因。 */
interface FakeSteer { text: string; images?: string[]; claimed: boolean; blocked: string | null }
function steerSource(items: FakeSteer[], log: string[] = []) {
  let polls = 0;
  return {
    get polls() { return polls; },
    queue: items,
    poll: () => {
      polls++;
      log.push("steer");
      return items
        .filter((i) => !i.claimed && i.blocked === null)
        .map((i) => ({
          text: i.text,
          images: i.images ?? [],
          claim: () => {
            if (i.claimed) return false;
            i.claimed = true;
            return true;
          },
          block: (reason: string) => {
            i.blocked = reason;
          },
        }));
    },
  };
}
const fs = (text: string, images?: string[]): FakeSteer => ({ text, images, claimed: false, blocked: null });

type Step = Partial<StreamResult> | ((messages: Message[]) => Partial<StreamResult> | Promise<Partial<StreamResult>>);
function setup(steps: Step[], agentOver: Record<string, unknown> = {}, hooksRaw?: Record<string, unknown>) {
  const io = spyIO();
  const seen: Message[][] = [];
  let i = 0;
  const agent: Agent = new Agent({
    cfg: makeCfg(),
    console: io,
    mode: "auto-all",
    systemPrompt: "sys",
    ...(hooksRaw ? { hooks: parseHooksConfig({ enabled: true, ...hooksRaw }) } : {}),
    chatStream: async (_cfg: Config, messages: Message[]) => {
      seen.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      const step = steps[i++];
      if (!step) throw new Error(`fake chatStream 脚本耗尽（第 ${i} 次）`);
      return result(typeof step === "function" ? await step(messages) : step);
    },
    ...agentOver,
  } as ConstructorParameters<typeof Agent>[0]);
  return { agent, io, seen };
}

const userTexts = (ms: Message[]): string[] => ms.filter((m) => m.role === "user").map((m) => contentText(m.content) ?? "");

let serial = 0;
function script(body: string): string {
  const path = join(SANDBOX, `h${serial++}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}
/** 记录每次 UPS 的 prompt；prompt 含 BLOCKME 时以 exit 2 阻断。 */
function upsHook(mark: string): { command: string } {
  return {
    command: script(
      `in=$(cat)\nprintf '%s\\n' "$in" >> '${mark}'\ncase "$in" in *BLOCKME*) printf 'steer policy says no'; exit 2;; esac\nexit 0`,
    ),
  };
}
function upsPrompts(mark: string): string[] {
  try {
    return readFileSync(mark, "utf8").trim().split("\n").filter(Boolean).map((l) => String((JSON.parse(l) as { prompt?: unknown }).prompt ?? ""));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */

test("#66-1 切点注入出现在下一次请求的 messages 里，位于已回填的工具结果之后；工具照常执行", async () => {
  const src = steerSource([fs("STEER 改成只看第一行")]);
  const { agent, seen } = setup([toolStep(), { content: "done" }], { pollSteer: src.poll });
  const stats = await agent.send("读 a.txt");
  expect(stats.aborted).toBe(false);
  expect(seen.length).toBe(2);
  const second = seen[1]!;
  const toolIdx = second.findIndex((m) => m.role === "tool");
  expect(toolIdx).toBeGreaterThan(0);
  expect(contentText(second[toolIdx]!.content)).toContain("hello-steer");
  const after = second.slice(toolIdx + 1).filter((m) => m.role === "user");
  expect(after.map((m) => contentText(m.content))).toEqual(["STEER 改成只看第一行"]);
  expect(src.queue[0]!.claimed).toBe(true);
  // 注入写入本轮历史（不是临时消息）。
  expect(userTexts(agent.messages)).toEqual(["读 a.txt", "STEER 改成只看第一行"]);
});

test("#66-2 toolCalls===0：首次请求前与没有工具的终答轮都不注入，条目留给轮末 drain", async () => {
  const src = steerSource([fs("STEER later")]);
  const { agent, seen } = setup([{ content: "direct answer" }], { pollSteer: src.poll });
  await agent.send("hi");
  expect(seen.length).toBe(1);
  expect(src.polls).toBe(0);
  expect(src.queue[0]!.claimed).toBe(false);
  expect(userTexts(seen[0]!)).toEqual(["hi"]);
});

test("#66-3 多条同切点按原序各一条 user，只引发一次后续请求", async () => {
  const src = steerSource([fs("STEER one"), fs("STEER two"), fs("STEER three")]);
  const { agent, seen } = setup([toolStep(), { content: "done" }], { pollSteer: src.poll });
  await agent.send("go");
  expect(seen.length).toBe(2);
  expect(src.polls).toBe(1);
  const second = seen[1]!;
  const toolIdx = second.findIndex((m) => m.role === "tool");
  expect(second.slice(toolIdx + 1).filter((m) => m.role === "user").map((m) => contentText(m.content))).toEqual([
    "STEER one",
    "STEER two",
    "STEER three",
  ]);
});

test("#66-4 切点顺序 inbox → background → 转向；转向走独立回调 pollSteer", async () => {
  const log: string[] = [];
  const src = steerSource([fs("STEER after bg")], log);
  let inboxCalls = 0;
  const { agent, seen } = setup([toolStep(), { content: "done" }], {
    pollInbox: () => { inboxCalls++; log.push("inbox"); return inboxCalls === 1 ? ["INBOX frame"] : []; },
    pollBackground: () => { log.push("background"); return log.filter((l) => l === "background").length === 2 ? ["BG result"] : []; },
    pollSteer: src.poll,
  });
  await agent.send("go");
  // 首次请求前：background 照旧（无工具限制），inbox 与转向都不跑。
  expect(log.slice(0, 1)).toEqual(["background"]);
  expect(log.slice(1)).toEqual(["inbox", "background", "steer"]);
  const second = seen[1]!;
  const toolIdx = second.findIndex((m) => m.role === "tool");
  expect(second.slice(toolIdx + 1).filter((m) => m.role === "user").map((m) => contentText(m.content))).toEqual([
    "INBOX frame",
    "BG result",
    "STEER after bg",
  ]);
});

test("#66-5 附件图片随转向发送：text part 在前，image_url 随后（与 drain 同规则）", async () => {
  const src = steerSource([fs("STEER 看图", ["data:image/png;base64,AAAA"])]);
  const { agent, seen } = setup([toolStep(), { content: "done" }], { pollSteer: src.poll });
  await agent.send("go");
  const steerMsg = seen[1]!.filter((m) => m.role === "user").at(-1)!;
  expect(Array.isArray(steerMsg.content)).toBe(true);
  expect(steerMsg.content).toEqual([
    { type: "text", text: "STEER 看图" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]);
});

test("#66-6 每条注入各跑一次 UserPromptSubmit（不走幂等缓存），不 beginUserTurn、不重新分类/召回、Stop 只一次", async () => {
  const mark = join(SANDBOX, `ups-${serial++}`);
  const stopMark = join(SANDBOX, `stop-${serial++}`);
  const src = steerSource([fs("STEER a"), fs("STEER b")]);
  let classify = 0;
  let recall = 0;
  const { agent, seen } = setup(
    [toolStep(), { content: "done" }],
    {
      pollSteer: src.poll,
      classifier: { name: "spy", classify: async () => { classify++; return null; } },
      memory: {
        recall: async () => { recall++; return null; },
        capture: () => {}, flush: async () => {},
      },
    },
    {
      UserPromptSubmit: [upsHook(mark)],
      Stop: [{ command: script(`cat >/dev/null\necho stop >> '${stopMark}'\nexit 0`) }],
    },
  );
  let begins = 0;
  const origBegin = agent.beginUserTurn.bind(agent);
  agent.beginUserTurn = ((p?: string) => { begins++; return origBegin(p); }) as typeof agent.beginUserTurn;
  await agent.send("first");
  expect(upsPrompts(mark)).toEqual(["first", "STEER a", "STEER b"]);
  expect(begins).toBe(1); // 只有 send 自己开的那一次
  expect(classify).toBeLessThanOrEqual(1);
  expect(recall).toBeLessThanOrEqual(1);
  expect(readFileSync(stopMark, "utf8").trim().split("\n")).toEqual(["stop"]);
  expect(seen.length).toBe(2);
});

test("#66-7 UPS 阻断：该条不入本轮历史、留在队列（block 原因可见），前面已放行的照常注入；补签 2：碰到第一条阻断即止，其后不注入也不跑 UPS", async () => {
  const mark = join(SANDBOX, `ups-${serial++}`);
  const src = steerSource([fs("STEER ok"), fs("STEER BLOCKME please"), fs("STEER after block")]);
  const { agent, io, seen } = setup(
    [toolStep(), { content: "done" }],
    { pollSteer: src.poll },
    { UserPromptSubmit: [upsHook(mark)] },
  );
  await agent.send("first");
  expect(seen.length).toBe(2);
  const users = userTexts(seen[1]!);
  expect(users).toContain("STEER ok");
  expect(users.some((t) => t.includes("BLOCKME"))).toBe(false);
  expect(userTexts(agent.messages).some((t) => t.includes("BLOCKME"))).toBe(false);
  expect(src.queue[0]!.claimed).toBe(true);
  expect(src.queue[1]!.claimed).toBe(false);
  expect(src.queue[1]!.blocked).toContain("steer policy says no");
  expect(io.warns.join("\n")).toContain("steer policy says no");
  // 补签 2：阻断条之后的条目留在队列、不标阻断、本轮不注入（也不提前跑 UPS）。
  expect(src.queue[2]!.claimed).toBe(false);
  expect(src.queue[2]!.blocked).toBeNull();
  expect(users).not.toContain("STEER after block");
  expect(upsPrompts(mark)).toEqual(["first", "STEER ok", "STEER BLOCKME please"]);
});

test("#66-8 注入前取消：沿用 rollbackOnAbort 回滚本轮，未注入的条目留在队列", async () => {
  const src = steerSource([fs("STEER pending")]);
  let agentRef: Agent | null = null;
  const { agent } = setup(
    [
      () => {
        agentRef!.cancel();
        throw abortError();
      },
    ],
    { pollSteer: src.poll },
  );
  agentRef = agent;
  agent.messages.push({ role: "user", content: "old q" }, { role: "assistant", content: "old a" });
  const before = agent.messages.length;
  const stats = await agent.send("typo input", { rollbackOnAbort: true });
  expect(stats.aborted).toBe(true);
  expect(agent.messages.length).toBe(before);
  expect(src.queue[0]!.claimed).toBe(false);
});

test("#66-9 注入后取消：只停不删，工具结果与转向文字保留；未注入条目不丢", async () => {
  const src = steerSource([fs("STEER injected")]);
  let agentRef: Agent | null = null;
  const { agent } = setup(
    [
      toolStep(),
      () => {
        // 下一次请求进行中用户又敲了一条，随后按 Esc。
        src.queue.push(fs("STEER typed after"));
        agentRef!.cancel();
        throw abortError();
      },
    ],
    { pollSteer: src.poll },
  );
  agentRef = agent;
  const stats = await agent.send("读 a.txt", { rollbackOnAbort: true });
  expect(stats.aborted).toBe(true);
  expect(userTexts(agent.messages)).toEqual(["读 a.txt", "STEER injected"]);
  expect(agent.messages.some((m) => m.role === "tool" && (contentText(m.content) ?? "").includes("hello-steer"))).toBe(true);
  expect(src.queue[1]!.claimed).toBe(false);
});

test("#66-10 claim 失败（条目已被 ↑ 收回）就不注入", async () => {
  const src = steerSource([fs("STEER recalled")]);
  const { agent, seen } = setup([toolStep(), { content: "done" }], {
    pollSteer: () => src.poll().map((it) => ({ ...it, claim: () => false })),
  });
  await agent.send("go");
  expect(userTexts(seen[1]!)).toEqual(["go"]);
});

test("#66-11 子代理循环不接收主会话转向（pollSteer 不透传给 task 子代理）", async () => {
  let polls = 0;
  let step = 0;
  const seenSub: Message[][] = [];
  const main = new Agent({
    cfg: makeCfg(),
    console: spyIO(),
    mode: "auto-all",
    systemPrompt: "main",
    pollSteer: () => { polls++; return [{ text: "STEER main only", images: [], claim: () => true, block: () => {} }]; },
    chatStream: async (_c: Config, messages: Message[]) => {
      seenSub.push(JSON.parse(JSON.stringify(messages)) as Message[]);
      step++;
      return result(step === 1 ? toolStep() : { content: "sub report" });
    },
  } as ConstructorParameters<typeof Agent>[0]);
  const ctx: ToolCtx = { cfg: makeCfg(), approve: async () => true };
  const out = await runSubagent(main, "子任务：读 a.txt", undefined, ctx);
  expect(out).toContain("sub report");
  expect(polls).toBe(0);
  expect(JSON.stringify(seenSub)).not.toContain("STEER main only");
});

test("#66-12 没接 pollSteer（-p / ACP / 子代理）时行为不变", async () => {
  const { agent, seen } = setup([toolStep(), { content: "done" }]);
  await agent.send("go");
  expect(userTexts(seen[1]!)).toEqual(["go"]);
});
