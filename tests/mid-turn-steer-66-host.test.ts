/**
 * #66 运行中转向（宿主 / 交互层）—— 已签合同：/workspace/neo-cli-issue-66-signed-contract.md。
 *
 * 覆盖：可注入判定（第 3、4 条）、宿主队列与计数（12、15）、↑ 只收回未注入条目（15）、
 * 取消文案（10、11、18）、空 Enter / Ctrl+X Ctrl+S（13、16）、不做 /steer --steer（17）、
 * /help 与文档（18、19）、-p / ACP 不接线（21），以及真实组合根回归。
 * 补签（/workspace/neo-cli-issue-66-signed-contract-amendment.md）：合成消息不可注入（1）、第一条阻断即止
 * 且同轮后续切点不再注入（2）、只看 stdin 是否为 TTY（stdin 非 TTY / 管道每行各自成轮；stdin 是 TTY 而 stdout 非 TTY 走 readline 时仍注入）（4）、静默展开 + 写入后
 * 才执行可见副作用（5）。
 * 真实组合根与 readline 都在沙箱子进程里跑，不碰真实 ~/.neo。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Composer, type ComposerDeps } from "../src/tui/composer.ts";
import { COMMANDS } from "../src/input/commands.ts";
import { helpText } from "../src/cli/help.ts";
import { parseArgs } from "../src/cli/args.ts";
import { stripAnsi } from "../src/tui/ansi.ts";

const ROOT = join(import.meta.dir, "..");
type Q = import("../src/cli/repl.ts").QueueItem;
const steerMod = () => import("../src/cli/midTurnSteer.ts");

const item = (text: string, over: Partial<Q> = {}): Q => ({ text, attachments: [], origin: "user", ...over });

describe("#66 可注入判定（第 3、4 条）", () => {
  test("只有真人 origin user、非 loop、非 shell、不以 / 或 ! 开头的条目可注入", async () => {
    const { isSteerable } = await steerMod();
    expect(isSteerable(item("改成只看第一行"))).toBe(true);
    expect(isSteerable(item("/todos"))).toBe(false);
    expect(isSteerable(item("/fork"))).toBe(false);
    expect(isSteerable(item("!ls"))).toBe(false);
    expect(isSteerable(item("ls", { shell: true }))).toBe(false);
    expect(isSteerable(item("tick", { loop: true }))).toBe(false);
    expect(isSteerable(item("frame", { origin: "mailbox" }))).toBe(false);
    expect(isSteerable(item("notice", { origin: "notice" }))).toBe(false);
    expect(isSteerable(item("event", { origin: "monitor" }))).toBe(false);
  });

  test("补签 1：enqueueUserTurn 排进来的合成消息（/技能名、MCP prompt）带标记、不可注入；不按文本前缀识别", async () => {
    const { isSteerable } = await steerMod();
    expect(isSteerable(item("技能正文……", { synthetic: true }))).toBe(false);
    expect(isSteerable(item("技能正文……"))).toBe(true);
    const repl = readFileSync(join(ROOT, "src/cli/repl.ts"), "utf8");
    const at = repl.indexOf("enqueueUserTurn: (text) =>");
    expect(at).toBeGreaterThan(-1);
    expect(repl.slice(at, at + 400)).toContain("synthetic: true");
  });
});

describe("#66 宿主控制器", () => {
  function harness(queue: Q[], tty = true) {
    let changes = 0;
    const expanded: string[] = [];
    const committed: string[] = [];
    const h = {
      queue,
      tty,
      get changes() { return changes; },
      expanded,
      committed,
      deps: {
        queue: () => queue,
        interactive: () => h.tty,
        prepare: async (q: Q) => {
          expanded.push(q.text);
          return { text: `${q.text}#x`, images: [] as string[], commit: () => { committed.push(q.text); } };
        },
        onQueueChange: () => { changes++; },
      },
    };
    return h;
  }

  test("轮外不取条目；轮内一次取走全部可注入条目（原序），claim 摘除并触发计数刷新", async () => {
    const { SteerController } = await steerMod();
    const h = harness([item("/todos"), item("A"), item("tick", { loop: true }), item("B")]);
    const c = new SteerController(h.deps);
    expect(await c.poll()).toEqual([]);
    c.beginTurn();
    const got = await c.poll();
    expect(got.map((g) => g.text)).toEqual(["A#x", "B#x"]);
    expect(got[0]!.claim()).toBe(true);
    expect(h.queue.map((q) => q.text)).toEqual(["/todos", "tick", "B"]);
    expect(h.changes).toBe(1);
    // 已被 ↑ 收回（不在队列里）的条目 claim 失败，不会二次注入。
    h.queue.splice(h.queue.findIndex((q) => q.text === "B"), 1);
    expect(got[1]!.claim()).toBe(false);
    c.endTurn();
  });

  test("补签 2：碰到第一条阻断即止——阻断条与其后条目留队；本轮后续切点一律不再取；其后条目不标阻断，下一轮仍按原序可注入", async () => {
    const { SteerController } = await steerMod();
    const h = harness([item("A"), item("BLOCKED"), item("C")]);
    const c = new SteerController(h.deps);
    c.beginTurn();
    const first = await c.poll();
    expect(first[0]!.claim()).toBe(true);
    first[1]!.block("policy");
    expect(h.queue.map((q) => q.text)).toEqual(["BLOCKED", "C"]);
    expect(h.queue[0]!.steerBlocked).toBe(true);
    expect(h.queue[1]!.steerBlocked).toBeUndefined();
    // 同一轮后续切点：不论旧条目还是新排队的条目都不再注入。
    expect(await c.poll()).toEqual([]);
    h.queue.push(item("D"));
    expect(await c.poll()).toEqual([]);
    c.endTurn();
    // 被阻断条仍在队首时（例如插进来的别的轮），它是屏障：其后条目不得越过它注入。
    c.beginTurn();
    expect(await c.poll()).toEqual([]);
    c.endTurn();
    // drain 取出被阻断条作为新一轮后，其后条目按原序可注入到那一轮。
    h.queue.shift();
    c.beginTurn();
    expect((await c.poll()).map((g) => g.text)).toEqual(["C#x", "D#x"]);
    c.endTurn();
  });

  test("补签 5：取条目时只做静默展开（UPS 看到的是展开后文本）；副作用仅在 claim 成功（确定写入）后执行一次；阻断/被 ↑ 收回的不执行", async () => {
    const { SteerController } = await steerMod();
    const h = harness([item("OK"), item("GONE"), item("BLOCKED")]);
    const c = new SteerController(h.deps);
    c.beginTurn();
    const got = await c.poll();
    expect(got.map((g) => g.text)).toEqual(["OK#x", "GONE#x", "BLOCKED#x"]);
    expect(h.committed).toEqual([]);
    expect(got[0]!.claim()).toBe(true);
    expect(h.committed).toEqual(["OK"]);
    h.queue.splice(h.queue.findIndex((q) => q.text === "GONE"), 1); // ↑ 收回
    expect(got[1]!.claim()).toBe(false);
    got[2]!.block("policy");
    expect(h.committed).toEqual(["OK"]);
    c.endTurn();
  });

  test("补签 4：stdin 非 TTY（管道）时不做运行中注入；TTY 时语义不变", async () => {
    const { SteerController } = await steerMod();
    const h = harness([item("A")], false);
    const c = new SteerController(h.deps);
    c.beginTurn();
    expect(await c.poll()).toEqual([]);
    expect(h.expanded).toEqual([]);
    h.tty = true;
    expect((await c.poll()).map((g) => g.text)).toEqual(["A#x"]);
    c.endTurn();
  });

  test("补签 5：prepareUserLine 静默展开，commit 时才打印已引用/已发送图片并记 touched paths（一次）", async () => {
    const { prepareUserLine } = await import("../src/cli/expandUserLine.ts");
    const work = mkdtempSync(join(tmpdir(), "neo-steer66-expand-"));
    try {
      writeFileSync(join(work, "a.txt"), "hello-quiet\n");
      const lines: string[] = [];
      const touched: string[][] = [];
      const ui = new Proxy({}, { get: () => (...a: unknown[]) => { lines.push(a.map(String).join(" ")); } });
      const fakeS = {
        cfg: { cwd: work, safeMode: false } as unknown,
        ui,
        agent: { noteTouchedPaths: (p: string[]) => { touched.push([...p]); } } as unknown,
        mcpManager: { connectedServerNames: () => [], readResource: async () => { throw new Error("no mcp"); } },
      } as unknown as Parameters<typeof prepareUserLine>[0];
      const p = await prepareUserLine(fakeS, "看 @a.txt", []);
      expect(p.text).toContain("hello-quiet");
      expect(lines).toEqual([]);
      expect(touched).toEqual([]);
      p.commit();
      expect(lines.join("\n")).toContain("已引用 1 个文件");
      expect(touched.length).toBe(1);
      p.commit();
      expect(touched.length).toBe(1);
      expect(lines.filter((l) => l.includes("已引用")).length).toBe(1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("取消文案：注入前沿用「已请求取消本轮」（不覆盖），注入后换成不回滚文案；新轮复位", async () => {
    const { SteerController, STEERED_CANCEL_NOTICE } = await steerMod();
    expect(STEERED_CANCEL_NOTICE).toBe("已中断（不回滚，转向已写入本轮）");
    const h = harness([item("A")]);
    const c = new SteerController(h.deps);
    c.beginTurn();
    expect(c.cancelNotice()).toBeUndefined();
    (await c.poll())[0]!.claim();
    expect(c.cancelNotice()).toBe(STEERED_CANCEL_NOTICE);
    c.endTurn();
    c.beginTurn();
    expect(c.cancelNotice()).toBeUndefined();
  });

  test("↑ 只收回未注入条目：注入后的条目已离队，收回的是最近一条仍在队列的真人输入", async () => {
    const { SteerController, recallQueuedUser } = await steerMod();
    const h = harness([item("A"), item("frame", { origin: "mailbox" })]);
    const c = new SteerController(h.deps);
    c.beginTurn();
    (await c.poll())[0]!.claim();
    expect(recallQueuedUser(h.queue)).toBeNull();
    h.queue.push(item("late"));
    expect(recallQueuedUser(h.queue)?.text).toBe("late");
    expect(h.queue.map((q) => q.text)).toEqual(["frame"]);
  });
});

/* ---------------- composer（Esc / Ctrl+C / 空 Enter） ---------------- */

function composer(over: Partial<ComposerDeps> = {}) {
  const submitted: string[] = [];
  let cancels = 0;
  let flushed = 0;
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, isRaw: false });
  const deps: ComposerDeps = {
    stdin,
    stdout: { write: () => {}, columns: 100, rows: 24 },
    columns: () => 100,
    rows: () => 24,
    getStatus: () => ({ version: "0", model: "m", tier: "default", mode: "ask", branch: null, ctxUsage: 0, elapsedMs: 0, active: true, tokensTotal: 0 }),
    getTitle: () => "neo",
    commands: COMMANDS,
    files: () => [],
    onSubmit: (t) => submitted.push(t),
    onCancelTurn: () => { cancels++; },
    onExit: () => {},
    onFlushQueue: () => { flushed++; },
    now: () => 1_000_000,
    ...over,
  } as ComposerDeps;
  const c = new Composer(deps);
  c.start();
  return { c, submitted, get cancels() { return cancels; }, get flushed() { return flushed; } };
}

describe("#66 composer 交互（第 12、13、16、18 条）", () => {
  test("注入前 Esc：沿用「已请求取消本轮」", () => {
    const h = composer({ onCancelTurn: () => undefined });
    h.c.setBusy(true);
    h.c.handleKey(undefined, { name: "escape", sequence: "\x1b" });
    expect(h.c.noticeText).toBe("已请求取消本轮");
    h.c.stop();
  });

  test("注入后 Esc：宿主返回的不回滚文案替换默认文案", () => {
    const h = composer({ onCancelTurn: () => "已中断（不回滚，转向已写入本轮）" });
    h.c.setBusy(true);
    h.c.handleKey(undefined, { name: "escape", sequence: "\x1b" });
    expect(h.c.noticeText).toBe("已中断（不回滚，转向已写入本轮）");
    h.c.stop();
  });

  test("注入后 busy Ctrl+C：同一套语义（cancel 一次），提示里能看出不回滚", () => {
    let cancels = 0;
    const h = composer({ onCancelTurn: () => { cancels++; return "已中断（不回滚，转向已写入本轮）"; } });
    h.c.setBusy(true);
    h.c.handleKey(undefined, { name: "c", ctrl: true });
    expect(cancels).toBe(1);
    expect(stripAnsi(h.c.noticeText ?? "")).toContain("已中断（不回滚，转向已写入本轮）");
    h.c.stop();
  });

  test("busy 有字 Enter 只提交入队，不取消；空 Enter 既不取消也不强制注入", () => {
    const h = composer();
    h.c.setBusy(true);
    h.c.handleKey(undefined, { name: "return", sequence: "\r" });
    expect(h.submitted).toEqual([]);
    expect(h.cancels).toBe(0);
    expect(h.flushed).toBe(0);
    for (const ch of "改路") h.c.handleKey(ch, { ch, name: ch });
    h.c.handleKey(undefined, { name: "return", sequence: "\r" });
    expect(h.submitted).toEqual(["改路"]);
    expect(h.cancels).toBe(0);
    h.c.stop();
  });
});

/* ---------------- 文案 / 文档 / 接线边界 ---------------- */

describe("#66 /help 与文档（第 18、19 条）", () => {
  test("/help 的 ESC 行与第 10、11 条一致（不再写死「不回滚历史」）", () => {
    const esc = stripAnsi(helpText()).split("\n").find((l) => l.trim().startsWith("ESC"))!;
    expect(esc).not.toContain("运行中取消本轮（不回滚历史）");
    expect(esc).toContain("回滚");
    expect(esc).toContain("转向");
  });

  test("README 写清 /btw、运行中转向、轮末队列的分工", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const at = readme.indexOf("运行中转向");
    expect(at).toBeGreaterThan(-1);
    const sec = readme.slice(at, at + 4000);
    for (const k of ["/btw", "不入历史", "工具", "轮末", "/loop", "#87", "!", "已中断（不回滚，转向已写入本轮）", "已请求取消本轮",
      "第一条", "技能", "MCP prompt", "/review", "/plan", "/tier", "TTY", "管道", "已引用"]) {
      expect(sec).toContain(k);
    }
  });
});

describe("#66 接线边界（第 17、20、21 条）", () => {
  test("不做 /steer、--steer", () => {
    expect(COMMANDS.some((c) => c.name === "/steer" || c.name === "steer")).toBe(false);
    const parsed = parseArgs(["--steer"]) as unknown as Record<string, unknown>;
    expect("steer" in parsed).toBe(false);
    expect(parsed.rest).toEqual(["--steer"]);
    expect(readFileSync(join(ROOT, "src/cli/args.ts"), "utf8")).not.toContain("--steer");
  });

  test("-p、ACP、子代理不接 pollSteer；只有交互 REPL 接线", () => {
    const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
    expect(src("src/cli/oneshot.ts")).not.toContain("pollSteer");
    expect(src("src/cli/sessionStart.ts")).not.toContain("pollSteer");
    expect(src("src/tools/task.ts")).not.toContain("pollSteer");
    for (const f of readdirSync(join(ROOT, "src/acp"))) expect(src(`src/acp/${f}`)).not.toContain("pollSteer");
    expect(src("src/cli/repl.ts")).toContain("pollSteer");
  });

  test("readline 路径的 Esc / Ctrl+C 与 composer 共用同一取消入口", () => {
    const il = readFileSync(join(ROOT, "src/cli/inputLayer.ts"), "utf8");
    const readlinePart = il.slice(il.indexOf("createInterface({"));
    expect(readlinePart).toContain("cancelNotice");
    expect(readlinePart).not.toContain("中断不回滚：跑了几十轮工具的进展不该被一次误按丢掉");
  });
});

/* ---------------- 真实组合根 / readline 子进程 ---------------- */

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "neo-steer66-"));
});
afterEach(() => {
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("NEO_")) out[k] = v;
  return {
    ...out,
    HOME: dir,
    USERPROFILE: dir,
    NEO_SESSIONS_DIR: join(dir, "sessions"),
    NEO_MAILBOX_DIR: join(dir, "mailbox"),
    NEO_LOG_DIR: join(dir, "logs"),
    NEO_MEMORY_DISABLE: "1",
    ...extra,
  };
}
function settings(base: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    ...extra,
    default_provider: "fake", providers: [{ provider_name: "fake", provider_type: "openai", base_url: base,
      api_key: "test", default_model_name: "fake-model", fast_model_name: "fake-model", balanced_model_name: "fake-model",
      deep_reasoning_model_name: "fake-model", max_tokens: 64, context_window: 100000 }],
    memory: { enabled: false }, retry: { max_attempts: 1, base_delay_ms: 1 },
  }));
}

test("#66 真实 REPL：切点注入/非可注入条目留队/注入前后取消/↑/busy Ctrl+X Ctrl+S/后台子代理/补签 1、2、4、5", async () => {
  // UPS hook：记录每次提交的 prompt（JSON 行），含 BLOCKME 则 exit 2 阻断。
  const mark = join(dir, "ups-prompts.jsonl");
  const hook = join(dir, "ups.sh");
  writeFileSync(hook, `#!/bin/sh\nin=$(cat)\nprintf '%s\\n' "$in" >> '${mark}'\ncase "$in" in *BLOCKME*) echo "steer policy says no" >&2; exit 2;; esac\nexit 0\n`, { mode: 0o755 });
  settings("http://127.0.0.1:9/v1", { hooks: { enabled: true, UserPromptSubmit: [{ command: hook }] } });
  const proc = Bun.spawn(["bun", join(import.meta.dir, "fixtures/mid-turn-steer-runtime.ts")], {
    cwd: dir, env: childEnv({ STEER66_UPS_MARK: mark }), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect({ code, err: err.split("\n").filter((l) => /Error|assert|✖/.test(l)).join("\n") }).toEqual({ code: 0, err: "" });
  expect(out).toContain("steer-runtime-ok");
}, 30_000);

test("#66 补签 4：readline 管道（非 TTY）不做运行中注入，每行各自作为 drain 轮", async () => {
  writeFileSync(join(dir, "a.txt"), "hello\n");
  const fake = Bun.spawn(["bun", "run", join(ROOT, "scripts/fake-llm.ts")], {
    cwd: ROOT, env: childEnv({ PORT: "0", SCENARIO: "steer" }), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = fake.stdout.getReader();
    let ready = "";
    while (!/FAKE_LLM_READY port=(\d+)/.test(ready)) {
      const { value, done } = await reader.read();
      if (done) break;
      ready += new TextDecoder().decode(value);
    }
    const port = /FAKE_LLM_READY port=(\d+)/.exec(ready)?.[1];
    expect(port).toBeDefined();
    settings(`http://127.0.0.1:${port}/v1`);
    const neo = Bun.spawn(["bun", "run", join(ROOT, "src/index.ts"), "--yes", "--no-reasoning", "--auto", "off", "--name", `steer-rl-${process.pid}`], {
      cwd: dir, env: childEnv({ NO_COLOR: "1" }), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    neo.stdin.write("读一下 a.txt\nSTEER 改成只看第一行\n");
    neo.stdin.flush();
    let out = "";
    const outReader = neo.stdout.getReader();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !/STEER_SEEN|STEER_MISS/.test(out)) {
      const r = await Promise.race([outReader.read(), Bun.sleep(500).then(() => null)]);
      if (r === null) continue;
      if (r.done) break;
      out += new TextDecoder().decode(r.value);
    }
    neo.stdin.end();
    await Promise.race([neo.exited, Bun.sleep(5000)]);
    neo.kill();
    expect(out).toContain("读完了");
    expect(out).toContain("STEER_MISS");
    expect(out).not.toContain("STEER_SEEN");
  } finally {
    fake.kill();
  }
}, 40_000);
