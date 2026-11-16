/**
 * bootstrap-live-state.test.ts — 启动装配（bootstrap → startSession → createRepl）产出的状态必须是实时、已初始化的值。
 *
 * 背景（v0.4.88 已知未做第 1 条）：v0.4.87 拆分后 bootstrap 末尾用
 * `Object.assign(s, { …, heartbeatTick, mailboxClosed, … })` 把两个 `let` 变量的
 * **当时的值**塞进会话袋；之后 closeMailbox() 只改本地变量，读方从会话袋里读到的
 * 永远是启动时的快照（mailboxClosed=false、heartbeatTick 仍指向已清掉的定时器）。
 *
 * 规格：
 *   L1 closeMailbox() 之后，会话袋上的 mailboxClosed 为 true、heartbeatTick 为 null；
 *   L2 关闭前读到的是真实状态（心跳定时器存在、未关闭）；
 *   L3 createRepl() 之后图片 / 文本粘贴 chip 计数器都从 0 开始。拆分时
 *      `repl.pasteImageCounter = 0;` 被挤进上一行的行尾注释里，从未执行，
 *      首张图片 chip 的编号变成 NaN（undefined += 1）。
 *
 * 用真子进程跑 bootstrap()：它读 process.argv / cwd 下 settings.json / NEO_* 目录，
 * 同进程跑会改全局状态。HOME、会话、信箱、日志全部指到沙箱，不碰真实 ~/.neo。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BOOTSTRAP = join(import.meta.dir, "..", "src", "cli", "bootstrap.ts");
const SESSION_START = join(import.meta.dir, "..", "src", "cli", "sessionStart.ts");
const REPL = join(import.meta.dir, "..", "src", "cli", "repl.ts");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-boot-live-")));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

const SETTINGS = {
  default_provider: "fake",
  default_model_tier: "default",
  classifier_provider: "fake",
  classifier_model_name: "fake-model",
  providers: [
    {
      provider_name: "fake",
      provider_type: "openai",
      // 不会发请求：bootstrap 只装配，不跑 turn。
      base_url: "http://127.0.0.1:9/v1",
      api_key: "test",
      default_model_name: "fake-model",
      deep_reasoning_model_name: "fake-model",
      balanced_model_name: "fake-model",
      fast_model_name: "fake-model",
      max_tokens: 64,
      temperature: 0,
      context_window: 100_000,
    },
  ],
  memory: { enabled: false },
};

const BOOT_PROBE = `
process.argv = [process.argv[0], "neo", "--name", "boot-live-probe"];
const { bootstrap } = await import(${JSON.stringify(BOOTSTRAP)});
const s = await bootstrap();
if (typeof s === "number") {
  console.log("RESULT " + JSON.stringify({ code: s }));
  process.exit(0);
}
const before = { mailbox: s.mailbox !== null, closed: s.mailboxClosed, heartbeat: s.heartbeatTick !== null };
s.closeMailbox();
const after = { closed: s.mailboxClosed, heartbeat: s.heartbeatTick !== null };
console.log("RESULT " + JSON.stringify({ before, after }));
process.exit(0);
`;

const REPL_PROBE = `
process.argv = [process.argv[0], "neo", "--name", "repl-init-probe"];
const { bootstrap } = await import(${JSON.stringify(BOOTSTRAP)});
const { startSession } = await import(${JSON.stringify(SESSION_START)});
const { createRepl } = await import(${JSON.stringify(REPL)});
const boot = await bootstrap();
if (typeof boot === "number") {
  console.log("RESULT " + JSON.stringify({ code: boot }));
  process.exit(0);
}
const s = await startSession(boot);
const repl = createRepl(s);
console.log("RESULT " + JSON.stringify({ text: repl.pasteTextCounter ?? "undefined", image: repl.pasteImageCounter ?? "undefined" }));
s.closeMailbox();
process.exit(0);
`;

// 子进程跑一段探针脚本，取 RESULT 行的 JSON。
function runProbe(script: string): Record<string, unknown> {
  const work = join(SANDBOX, "work");
  const home = join(SANDBOX, "home");
  mkdirSync(work, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(work, "settings.json"), JSON.stringify(SETTINGS, null, 2), "utf8");
  const probe = join(SANDBOX, "probe.ts");
  writeFileSync(probe, script, "utf8");
  const r = Bun.spawnSync([process.execPath, "run", probe], {
    cwd: work,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      LC_ALL: "C",
      NEO_SESSIONS_DIR: join(SANDBOX, "sessions"),
      NEO_MAILBOX_DIR: join(SANDBOX, "mailbox"),
      NEO_MEMORY_DISABLE: "1",
      NEO_LOG_DIR: join(home, ".neo", "logs"),
    },
  });
  const out = r.stdout.toString();
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`probe 没有输出 RESULT（exit ${r.exitCode}）：\n${out}\n${r.stderr.toString()}`);
  return JSON.parse(line.slice("RESULT ".length));
}

describe("启动装配状态", () => {
  test("L1/L2 closeMailbox 后读方看到 mailboxClosed=true、heartbeatTick=null（不是启动时快照）", () => {
    const r = runProbe(BOOT_PROBE);
    expect(r.code).toBeUndefined();
    expect(r.before).toEqual({ mailbox: true, closed: false, heartbeat: true });
    expect(r.after).toEqual({ closed: true, heartbeat: false });
  });

  test("L3 createRepl 后图片与文本粘贴 chip 计数器都从 0 开始", () => {
    const r = runProbe(REPL_PROBE);
    expect(r.code).toBeUndefined();
    expect(r).toEqual({ text: 0, image: 0 });
  });
});
