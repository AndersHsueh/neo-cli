/** #65 signed /fork contract. All persistence is sandboxed. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { createSession, loadSession, saveSession, type SessionMeta } from "../src/session.ts";
import { forkSession, forkBusyReason } from "../src/cli/forkSession.ts";
import { dispatchCommand } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commandContext.ts";
import { loadConfig } from "../src/config.ts";
import { Agent } from "../src/agent.ts";
import { Mailbox } from "../src/mailbox/store.ts";
import { openMailboxIdentity } from "../src/sessionName.ts";
import { releaseAlive, sessionLiveness } from "../src/mailbox/identity.ts";
import { captureConsole } from "./helpers.ts";
import { printSessions } from "../src/cli/sessions.ts";
import { CheckpointStore } from "../src/checkpoint.ts";
import { RewindLog } from "../src/rewind.ts";
import { SESSION_START_SOURCES } from "../src/hooks/types.ts";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "neo-fork65-"));
  for (const k of Object.keys(process.env)) if (k.startsWith("NEO_")) delete process.env[k];
  Object.assign(process.env, { HOME: dir, USERPROFILE: dir, NEO_SESSIONS_DIR: join(dir, "sessions"), NEO_MAILBOX_DIR: join(dir, "mailbox") });
});
afterEach(() => {
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

function settings(base = "http://127.0.0.1:9/v1"): string {
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({
    default_provider: "fake", providers: [{ provider_name: "fake", provider_type: "openai", base_url: base,
      api_key: "test", default_model_name: "fake-model", fast_model_name: "fake-model", balanced_model_name: "fake-model",
      deep_reasoning_model_name: "fake-model", max_tokens: 64, context_window: 100000 }],
    memory: { enabled: false }, retry: { max_attempts: 1, base_delay_ms: 1 },
  }));
  return path;
}
function context() {
  settings();
  const cfg = loadConfig({}, { settingsDir: dir });
  const meta = createSession(cfg.model, dir).meta;
  const { ui, lines } = captureConsole();
  const agent = new Agent({ cfg, system: "system", io: { approve: async () => true } });
  agent.messages.push({ role: "user", content: "parent question" }, { role: "assistant", content: "parent answer" });
  const mailbox = new Mailbox({ sessionId: meta.id });
  openMailboxIdentity({ root: mailbox.root, sessionId: meta.id, cwd: dir, mode: "ask", explicit: "Parent" });
  const ctx = { agent, cfg, meta, ui, mailbox, checkpoints: new CheckpointStore({ cwd: dir, sessionId: meta.id }),
    memory: { flush: async () => {}, setSessionId: () => {} }, selectDeps: {}, shutdown: () => {},
  } as unknown as CommandContext;
  return { ctx, lines };
}

test("#65 --fork requires --resume or --continue, including -p", () => {
  expect(parseArgs(["--fork"]).badArgs).toBe(true);
  for (const args of [["--resume", "old"], ["--continue"]]) {
    const parsed = parseArgs([...args, "--fork", "-p", "next"]);
    expect(parsed.badArgs).toBe(false);
    expect(parsed.fork).toBe(true);
    expect(parsed.print).toBe("next");
    expect(parsed.rest).toEqual([]);
  }
});

test("#65 copy is detached, strips system, freezes jobs, re-persists images; no mailbox/backups", () => {
  const meta = createSession("model", dir).meta;
  meta.todos = [{ content: "todo", status: "pending", activeForm: "doing" }];
  meta.rewind = [{ index: 0, prompt: "old", at: "now", messagesBefore: 1, checkpointSeqs: [3] }];
  meta.outputStyle = "Learning";
  meta.backgroundTasks = [{ id: "bg-1", status: "running", kind: "task", prompt: "job", tier: "fast", startedAt: 1 }];
  const messages = [{ role: "system" as const, content: "private system" }, { role: "user" as const,
    content: [{ type: "image_url" as const, image_url: { url: "data:image/png;base64,YQ==" } }] }];
  saveSession(messages, meta);
  const before = readFileSync(meta.path, "utf8");
  const fork = forkSession(meta, loadSession(meta.id)!.messages, "model", dir);
  expect(fork.meta.id).not.toBe(meta.id);
  expect(fork.meta.forkedFrom).toBe(meta.id);
  expect(fork.meta.outputStyle).toBe("Learning");
  expect(fork.meta.todos).toEqual(meta.todos);
  expect(fork.meta.rewind![0]!.checkpointSeqs).toEqual([]);
  expect(fork.meta.backgroundTasks![0]!.status).toBe("interrupted");
  expect(meta.backgroundTasks[0]!.status).toBe("running");
  fork.meta.todos![0]!.content = "changed";
  expect(meta.todos[0]!.content).toBe("todo");
  const raw = readFileSync(fork.meta.path, "utf8");
  expect(raw).not.toContain("private system");
  expect(raw).toContain(`attachments/${fork.meta.id}/img-0.png`);
  expect(raw).not.toContain(`attachments/${meta.id}/`);
  expect(readFileSync(meta.path, "utf8")).toBe(before);
  expect(existsSync(join(dir, "mailbox", fork.meta.id))).toBe(false);
  expect(existsSync(join(dir, ".neo", "backups", fork.meta.id))).toBe(false);
});

for (const busy of [ { turnActive: true }, { wikiRunning: true }, { backgroundTasks: [{ status: "running" }] },
  { shells: [{ status: "running" }] }, { loopRunning: true }, { driveRunning: true } ]) {
  test(`#65 rejects busy ${JSON.stringify(busy)}`, () => {
    expect(forkBusyReason(busy)).toMatch(/先|查看/);
  });
}
test("#65 finished background work is not busy", () => {
  expect(forkBusyReason({ shells: [{ status: "done" }], backgroundTasks: [{ status: "interrupted" }] })).toBeNull();
});

test("#65 /fork switches immediately, preserves parent name/mail, releases parent alive; one success line", async () => {
  const { ctx, lines } = context();
  const old = ctx.meta.id;
  const profile = readFileSync(join(ctx.mailbox!.root, old, "profile.json"), "utf8");
  const calls: string[] = [];
  ctx.agent.runSessionStart = async (source) => { calls.push(source); return { blocked: false, reason: "", context: "", continue: false }; };
  ctx.onNameChange = (name) => calls.push(name);
  ctx.onMailboxRekey = () => calls.push("identity switched");
  ctx.cfg.outputStyle = "Learning";
  ctx.agent.mode = "auto-edit";
  await dispatchCommand("/fork", ctx);
  expect(ctx.meta.id).not.toBe(old);
  expect(ctx.meta.forkedFrom).toBe(old);
  expect(ctx.mailbox!.sessionId).toBe(ctx.meta.id);
  expect(ctx.agent.opt.sessionId).toBe(ctx.meta.id);
  expect(ctx.agent.mode).toBe("auto-edit");
  expect(ctx.cfg.outputStyle).toBe("Learning");
  expect(loadSession(old)!.meta.outputStyle).toBe("Learning");
  expect(readFileSync(join(ctx.mailbox!.root, old, "profile.json"), "utf8")).toBe(profile);
  expect(sessionLiveness(ctx.mailbox!.root, old)).not.toBe("running");
  expect(sessionLiveness(ctx.mailbox!.root, ctx.meta.id)).toBe("running");
  expect(ctx.mailbox!.profile().name).toMatch(/^Neo#/);
  expect(calls).toContain("fork");
  expect(calls).not.toContain("Stop");
  expect(lines.join("\n")).toContain(`已分叉 → ${ctx.meta.id}（源自 ${old}）`);
  expect(lines.join("\n")).not.toContain("parent answer");
  const parent = readFileSync(loadSession(old)!.meta.path, "utf8");
  await dispatchCommand("/clear", ctx);
  expect(ctx.cfg.outputStyle).toBe("Learning");
  expect(readFileSync(loadSession(old)!.meta.path, "utf8")).toBe(parent);
  releaseAlive(ctx.mailbox!.root, ctx.meta.id);
});

test("#65 rejects extra /fork arguments and /ps running, without changing identity", async () => {
  const { ctx, lines } = context();
  const old = ctx.meta.id;
  await dispatchCommand("/fork name or prompt", ctx);
  expect(ctx.meta.id).toBe(old);
  expect(lines.join("\n")).toContain("用法");
  ctx.shells = { list: () => [{ status: "running" }] as never, kill: () => 0 };
  await dispatchCommand("/fork", ctx);
  expect(ctx.meta.id).toBe(old);
  expect(lines.join("\n")).toContain("/ps");
  releaseAlive(ctx.mailbox!.root, old);
});

test("#65 sessions lineage and fork hook source", () => {
  const meta = createSession("m", dir).meta;
  meta.forkedFrom = "parent-id";
  saveSession([], meta);
  const { ui, lines } = captureConsole();
  printSessions(ui);
  expect(lines.join("\n")).toContain("分叉自 parent-id");
  expect(SESSION_START_SOURCES).toContain("fork");
});

test("#65 checkpoint rebinding never reuses parent code backups, copied rewind excludes old seqs", () => {
  const store = new CheckpointStore({ cwd: dir, sessionId: "parent" });
  const path = join(dir, "code.txt");
  writeFileSync(path, "before");
  store.beforeWrite(path, "write_file");
  store.fork("child");
  expect(store.list()).toEqual([]);
  expect(store.dir).toBe(join(dir, ".neo", "backups", "child"));
  writeFileSync(path, "after fork");
  store.beforeWrite(path, "write_file");
  writeFileSync(path, "new");
  const log = new RewindLog();
  const turn = log.beginTurn({ prompt: "new", messagesLength: 2, checkpointSeqBefore: 0 });
  log.endTurn(turn, store.list().map(e => e.seq));
  log.rewind({ target: "last", mode: "code", store, conversation: { length: () => 3, truncate: () => {} } });
  expect(readFileSync(path, "utf8")).toBe("after fork");
});

test("#65 --resume --fork -p succeeds with live parent, only child receives prompt/hooks; settings/parent untouched", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "fake-model" }] });
    requests.push(await req.json() as typeof requests[number]);
    return new Response('data: {"choices":[{"delta":{"content":"child reply"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const path = settings(`http://127.0.0.1:${server.port}/v1`);
    const mark = join(dir, "hooks.jsonl");
    const hook = join(dir, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ncat >> '${mark}'\nprintf '\n' >> '${mark}'\n`, { mode: 0o755 });
    const s = JSON.parse(readFileSync(path, "utf8"));
    s.hooks = { enabled: true, SessionStart: [{ command: hook }], UserPromptSubmit: [{ command: hook }] };
    writeFileSync(path, JSON.stringify(s));
    const settingsBefore = readFileSync(path, "utf8");
    const meta = createSession("fake-model", dir).meta;
    meta.outputStyle = "Learning";
    saveSession([{ role: "user", content: "old prompt" }, { role: "assistant", content: "old reply" }], meta);
    const parentBefore = readFileSync(meta.path, "utf8");
    openMailboxIdentity({ root: process.env.NEO_MAILBOX_DIR!, sessionId: meta.id, cwd: dir, mode: "ask", explicit: "Parent" });
    const alivePath = join(process.env.NEO_MAILBOX_DIR!, meta.id, ".alive");
    const aliveBefore = readFileSync(alivePath, "utf8");
    const profilePath = join(process.env.NEO_MAILBOX_DIR!, meta.id, "profile.json");
    const profileBefore = readFileSync(profilePath, "utf8");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), "--resume", meta.id, "--fork", "-p", "new prompt", "--auto", "off"],
      { cwd: dir, env: process.env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain("child reply");
    expect(readFileSync(meta.path, "utf8")).toBe(parentBefore);
    expect(readFileSync(alivePath, "utf8")).toBe(aliveBefore);
    expect(readFileSync(profilePath, "utf8")).toBe(profileBefore);
    expect(readFileSync(path, "utf8")).toBe(settingsBefore);
    const children = readdirSync(process.env.NEO_SESSIONS_DIR!).filter(f => f.endsWith(".json") && f !== `${meta.id}.json`);
    expect(children).toHaveLength(1);
    const child = JSON.parse(readFileSync(join(process.env.NEO_SESSIONS_DIR!, children[0]!), "utf8"));
    expect(child.meta.forkedFrom).toBe(meta.id);
    expect(child.meta.outputStyle).toBe("Learning");
    expect(child.messages.map((m: { content: unknown }) => m.content)).toContain("new prompt");
    const hooks = readFileSync(mark, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(hooks.map(h => [h.hook_event_name, h.source].filter(Boolean))).toEqual([["SessionStart", "fork"], ["UserPromptSubmit"]]);
    expect(requests.at(-1)!.messages.map(m => m.content)).toContain("old prompt");
  } finally { server.stop(true); }
}, 20000);
