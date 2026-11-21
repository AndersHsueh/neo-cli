/**
 * issue #69：交互 `/cd` 切换会话工作目录（保留对话）。
 *
 * 先红后绿。覆盖 Leo 拍板收紧点：相对路径与 `~`、同根不刷新、失败全不变
 *（含 persist / 必做改挂失败）、新根无记忆文件则清空、persist 已发生、
 * `/cd -`（无上一根拒绝、失败不写入上一根槽）、飞行中子代理拒绝、
 * 不调用 `process.chdir`、PromptManager 指纹含 cwd。另覆最小目录补全。
 *
 * 运行：bun test tests/cd-workdir-69.test.ts
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  changeSessionCwd,
  cwdSwitchBusyReason,
  listCdCompletions,
  resolveCdTarget,
  type CwdSwitchDeps,
  type PreviousCwdSlot,
} from "../src/cli/cdWorkdir.ts";
import { dispatchCommand, type CommandContext } from "../src/cli/commands.ts";
import { helpText } from "../src/cli/help.ts";
import type { Config } from "../src/config.ts";
import { COMMANDS, knownSlashCommand } from "../src/input/commands.ts";
import * as identity from "../src/mailbox/identity.ts";
import { Mailbox } from "../src/mailbox/store.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import { createSession, loadSession, saveSession, type SessionMeta } from "../src/session.ts";
import type { Message } from "../src/llm.ts";
import { captureConsole } from "./helpers.ts";

const made: string[] = [];
const prevSessionsDir = process.env["NEO_SESSIONS_DIR"];
const sessionsRoot = realpathSync(mkdtempSync(join(tmpdir(), "neo-69-sessions-")));
made.push(sessionsRoot);
process.env["NEO_SESSIONS_DIR"] = sessionsRoot;

afterAll(() => {
  if (prevSessionsDir === undefined) delete process.env["NEO_SESSIONS_DIR"];
  else process.env["NEO_SESSIONS_DIR"] = prevSessionsDir;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

function makeCfg(cwd: string, over: Partial<Config> = {}): Config {
  return {
    cwd,
    model: "m-69",
    providerName: "test",
    modelTier: "balanced",
    toolOutputLimit: 30_000,
    contextWindow: 200_000,
    contextWindowSource: "models_api",
    env: { prompt: false },
    repoMap: { enabled: false },
    ...over,
  } as unknown as Config;
}

interface Slot {
  value: string | null;
  setCount: number;
}
function slot(initial: string | null = null): PreviousCwdSlot & Slot {
  const s: Slot = { value: initial, setCount: 0 };
  return {
    get: () => s.value,
    set: (v) => {
      s.value = v;
      s.setCount += 1;
    },
    get value() {
      return s.value;
    },
    set value(v) {
      s.value = v;
    },
    get setCount() {
      return s.setCount;
    },
    set setCount(n) {
      s.setCount = n;
    },
  };
}

interface Harness {
  a: string;
  b: string;
  cfg: Config;
  meta: SessionMeta;
  messages: Message[];
  promptManager: PromptManager;
  persistCalls: number;
  persistImpl: (messages: Message[], meta: SessionMeta) => void;
  fileIndexCwd: string;
  fileIndexCalls: number;
  memoryCwd: string;
  memoryCalls: number;
  mailbox: Mailbox | null;
  mailboxRoot: string | null;
  checkpointCwd: string;
  checkpointCalls: number;
  rulesCwd: string;
  rulesCalls: number;
  lspCalls: number;
  lspImpl: (cfg: Config) => void | Promise<void>;
  previous: ReturnType<typeof slot>;
  deps: CwdSwitchDeps;
}

function makeHarness(opts: { agentsA?: string; mailbox?: boolean } = {}): Harness {
  const root = tempDir("neo-69-proj-");
  mkdirSync(join(root, "proj-a"), { recursive: true });
  mkdirSync(join(root, "proj-b"), { recursive: true });
  const a = realpathSync(join(root, "proj-a"));
  const b = realpathSync(join(root, "proj-b"));
  writeFileSync(join(a, "AGENTS.md"), "RULES-FROM-A-MARKER\n", "utf8");
  if (opts.agentsA !== undefined) writeFileSync(join(a, "AGENTS.md"), opts.agentsA, "utf8");
  writeFileSync(join(a, "a-only.txt"), "a", "utf8");
  writeFileSync(join(b, "b-only.txt"), "b", "utf8");
  mkdirSync(join(b, "sub"), { recursive: true });

  const cfg = makeCfg(a);
  const sess = createSession(cfg.model, a);
  const promptManager = new PromptManager({ mailbox: false, askUser: false, sessionName: "cd69" });
  promptManager.setProjectMemory({ path: join(a, "AGENTS.md"), text: "RULES-FROM-A-MARKER\n" });
  const messages: Message[] = [
    { role: "system", content: promptManager.render(cfg).text },
    { role: "user", content: "HISTORY-USER-MARKER keep me" },
    { role: "assistant", content: "HISTORY-ASSISTANT-MARKER keep me" },
  ];
  saveSession(messages, sess.meta);

  const previous = slot(null);
  const h = {
    a,
    b,
    cfg,
    meta: sess.meta,
    messages,
    promptManager,
    persistCalls: 0,
    persistImpl: (msgs: Message[], meta: SessionMeta) => {
      saveSession(msgs, meta);
    },
    fileIndexCwd: a,
    fileIndexCalls: 0,
    memoryCwd: a,
    memoryCalls: 0,
    mailbox: null as Mailbox | null,
    mailboxRoot: null as string | null,
    checkpointCwd: a,
    checkpointCalls: 0,
    rulesCwd: a,
    rulesCalls: 0,
    lspCalls: 0,
    lspImpl: (_cfg: Config) => {},
    previous,
    deps: {} as CwdSwitchDeps,
  };

  if (opts.mailbox) {
    const mailboxRoot = tempDir("neo-69-mbox-");
    identity.createIdentity({
      root: mailboxRoot,
      sessionId: sess.meta.id,
      cwd: a,
      name: "cd69",
      mode: "ask",
    });
    h.mailbox = new Mailbox({ root: mailboxRoot, sessionId: sess.meta.id });
    h.mailboxRoot = mailboxRoot;
  }

  h.deps = {
    cfg: h.cfg,
    meta: h.meta,
    messages: h.messages,
    persist: (msgs, meta) => {
      h.persistCalls += 1;
      h.persistImpl(msgs, meta);
    },
    promptManager: h.promptManager,
    refreshSystemPrompt: () => {
      const sys = h.messages[0];
      if (sys && sys.role === "system") sys.content = h.promptManager.render(h.cfg).text;
    },
    previousCwd: h.previous,
    fileIndex: {
      setCwd: (cwd) => {
        h.fileIndexCalls += 1;
        h.fileIndexCwd = cwd;
      },
    },
    memory: {
      setCwd: (cwd) => {
        h.memoryCalls += 1;
        h.memoryCwd = cwd;
      },
    },
    mailbox: h.mailbox
      ? {
          setCwd: (cwd) => {
            // 生产实现应写在 Mailbox.setCwd；测试里若已落地就走真方法。
            const box = h.mailbox as Mailbox & { setCwd?: (cwd: string) => void };
            if (typeof box.setCwd === "function") box.setCwd(cwd);
            else throw new Error("Mailbox.setCwd 尚未实现");
          },
        }
      : null,
    checkpoints: {
      rebind: (cwd) => {
        h.checkpointCalls += 1;
        h.checkpointCwd = cwd;
      },
    },
    replaceRules: (cwd) => {
      h.rulesCalls += 1;
      h.rulesCwd = cwd;
    },
    restartLsp: (cfg) => {
      h.lspCalls += 1;
      return h.lspImpl(cfg);
    },
  };
  return h;
}

function snapshotState(h: Harness) {
  return {
    cfgCwd: h.cfg.cwd,
    metaCwd: h.meta.cwd,
    diskCwd: loadSession(h.meta.id)?.meta.cwd ?? null,
    fileIndexCwd: h.fileIndexCwd,
    fileIndexCalls: h.fileIndexCalls,
    memoryCwd: h.memoryCwd,
    memoryCalls: h.memoryCalls,
    checkpointCwd: h.checkpointCwd,
    checkpointCalls: h.checkpointCalls,
    rulesCwd: h.rulesCwd,
    rulesCalls: h.rulesCalls,
    persistCalls: h.persistCalls,
    previous: h.previous.get(),
    previousSets: h.previous.setCount,
    historyUser: h.messages[1]?.content,
    historyAssistant: h.messages[2]?.content,
    memoryText: (h.promptManager as unknown as { memory?: { text?: string; path?: string } }).memory?.text,
    processCwd: process.cwd(),
    mailboxCwd: h.mailbox?.profile().cwd,
  };
}

describe("声明与帮助（issue #69）", () => {
  test("COMMANDS 登记 /cd，knownSlashCommand 能识别", () => {
    expect(COMMANDS.some((c) => c.name === "cd")).toBe(true);
    expect(knownSlashCommand("/cd ../other")).toBe("cd");
    expect(knownSlashCommand("  /cd")).toBe("cd");
  });

  test("帮助说明 /cd，并区分 -C、shell.cwd、#63/#9/#54", () => {
    const text = helpText();
    expect(text).toContain("/cd");
    expect(text).toContain("-C");
    // #63 落地：/cd 清空额外根写成现在时，不再是「未来口径」。
    expect(text).not.toMatch(/未来 \/cd 成功后应清空/);
    expect(text).toContain("/cd 成功换主根会清空本会话额外根");
  });
});

describe("resolveCdTarget：路径语义", () => {
  test("相对路径相对当前会话 cwd，不是 process.cwd()", () => {
    const root = tempDir("neo-69-rel-");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(join(root, "b"), { recursive: true });
    const a = realpathSync(join(root, "a"));
    const b = realpathSync(join(root, "b"));
    const third = tempDir("neo-69-proc-");
    const prev = process.cwd();
    process.chdir(third);
    try {
      const r = resolveCdTarget(a, "../b");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.path).toBe(b);
    } finally {
      process.chdir(prev);
    }
  });

  test("支持 ~ 与 ~/（home 可注入，不碰用户真家目录）", () => {
    const home = tempDir("neo-69-home-");
    mkdirSync(join(home, "proj"), { recursive: true });
    const proj = realpathSync(join(home, "proj"));
    const cur = tempDir("neo-69-cur-");
    const homeOnly = resolveCdTarget(cur, "~", { home });
    expect(homeOnly.ok).toBe(true);
    if (homeOnly.ok) expect(homeOnly.path).toBe(realpathSync(home));
    const nested = resolveCdTarget(cur, "~/proj", { home });
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.path).toBe(proj);
  });

  test("软链存 realpath，不把逻辑路径当根", () => {
    const root = tempDir("neo-69-link-");
    mkdirSync(join(root, "real"), { recursive: true });
    const real = realpathSync(join(root, "real"));
    const link = join(root, "link");
    symlinkSync(real, link);
    const cur = tempDir("neo-69-link-cur-");
    const r = resolveCdTarget(cur, link);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(real);
      expect(r.path).not.toBe(link);
    }
  });

  test("目标是文件、不存在、悬空软链（realpath 失败）都拒绝；空目录成功", () => {
    const root = tempDir("neo-69-fail-");
    mkdirSync(join(root, "cur"), { recursive: true });
    mkdirSync(join(root, "empty"), { recursive: true });
    const cur = realpathSync(join(root, "cur"));
    const empty = realpathSync(join(root, "empty"));
    const file = join(root, "a.txt");
    const missing = join(root, "nope");
    const dangling = join(root, "dangling");
    writeFileSync(file, "x", "utf8");
    symlinkSync(join(root, "missing-target"), dangling);

    const asFile = resolveCdTarget(cur, file);
    expect(asFile.ok).toBe(false);
    if (!asFile.ok) expect(asFile.error.length).toBeGreaterThan(0);

    const noent = resolveCdTarget(cur, missing);
    expect(noent.ok).toBe(false);

    const dang = resolveCdTarget(cur, dangling);
    expect(dang.ok).toBe(false);

    const okEmpty = resolveCdTarget(cur, empty);
    expect(okEmpty.ok).toBe(true);
    if (okEmpty.ok) expect(okEmpty.path).toBe(empty);
  });
});

describe("PromptManager 指纹含 cwd", () => {
  test("只改 cfg.cwd 就会重算，缓存不得吐出旧目录树", () => {
    const a = tempDir("neo-69-fp-a-");
    const b = tempDir("neo-69-fp-b-");
    writeFileSync(join(a, "ONLY-A-TREE.txt"), "a", "utf8");
    writeFileSync(join(b, "ONLY-B-TREE.txt"), "b", "utf8");
    const cfg = makeCfg(a);
    const m = new PromptManager({ mailbox: false, askUser: false, sessionName: "fp" });
    const first = m.render(cfg);
    expect(first.text).toContain(a);
    expect(first.text).toContain("ONLY-A-TREE.txt");
    cfg.cwd = b;
    const second = m.render(cfg);
    expect(second).not.toBe(first);
    expect(second.text).toContain(b);
    expect(second.text).toContain("ONLY-B-TREE.txt");
    expect(second.text).not.toContain("ONLY-A-TREE.txt");
  });
});

describe("changeSessionCwd", () => {
  test("相对路径换根：工具侧状态、meta persist、项目记忆、历史保留；不 process.chdir", async () => {
    const h = makeHarness();
    writeFileSync(join(h.b, "AGENTS.md"), "RULES-FROM-B-MARKER\n", "utf8");
    const prevProc = process.cwd();
    const chdir = spyOn(process, "chdir");
    const r = await changeSessionCwd("../proj-b", h.deps);
    expect(chdir).not.toHaveBeenCalled();
    chdir.mockRestore();
    expect(process.cwd()).toBe(prevProc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unchanged).toBe(false);
    expect(r.cwd).toBe(h.b);
    expect(h.cfg.cwd).toBe(h.b);
    expect(h.meta.cwd).toBe(h.b);
    expect(h.persistCalls).toBeGreaterThanOrEqual(1);
    expect(loadSession(h.meta.id)?.meta.cwd).toBe(h.b);
    expect(loadSession(h.meta.id)?.meta.id).toBe(h.meta.id);
    expect(h.fileIndexCwd).toBe(h.b);
    expect(h.memoryCwd).toBe(h.b);
    expect(h.checkpointCwd).toBe(h.b);
    expect(h.rulesCwd).toBe(h.b);
    const sys = String(h.messages[0]?.content ?? "");
    expect(sys).toContain("RULES-FROM-B-MARKER");
    expect(sys).not.toContain("RULES-FROM-A-MARKER");
    expect(h.messages[1]?.content).toBe("HISTORY-USER-MARKER keep me");
    expect(h.messages[2]?.content).toBe("HISTORY-ASSISTANT-MARKER keep me");
    expect(h.previous.get()).toBe(h.a);
  });

  test("同根（含经软链 realpath 相同）成功提示不刷新", async () => {
    const h = makeHarness();
    const link = join(h.a, "..", "alias-a");
    symlinkSync(h.a, link);
    const before = snapshotState(h);
    const r = await changeSessionCwd(link, h.deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.unchanged).toBe(true);
      expect(r.cwd).toBe(h.a);
    }
    const after = snapshotState(h);
    expect(after.cfgCwd).toBe(before.cfgCwd);
    expect(after.metaCwd).toBe(before.metaCwd);
    expect(after.diskCwd).toBe(before.diskCwd);
    expect(after.fileIndexCalls).toBe(before.fileIndexCalls);
    expect(after.memoryCalls).toBe(before.memoryCalls);
    expect(after.checkpointCalls).toBe(before.checkpointCalls);
    expect(after.rulesCalls).toBe(before.rulesCalls);
    expect(after.persistCalls).toBe(before.persistCalls);
    expect(after.previous).toBe(before.previous);
    expect(after.previousSets).toBe(before.previousSets);
  });

  test("目标不存在：明确失败，侧状态全部不变", async () => {
    const h = makeHarness();
    const before = snapshotState(h);
    const r = await changeSessionCwd("does-not-exist", h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    expect(snapshotState(h)).toEqual(before);
  });

  test("persist 失败则 cwd 与所有侧状态仍停在旧根（含磁盘 meta）", async () => {
    const h = makeHarness();
    writeFileSync(join(h.b, "AGENTS.md"), "RULES-FROM-B-MARKER\n", "utf8");
    h.persistImpl = () => {
      throw new Error("disk full");
    };
    const before = snapshotState(h);
    const r = await changeSessionCwd(h.b, h.deps);
    expect(r.ok).toBe(false);
    const after = snapshotState(h);
    expect(after.cfgCwd).toBe(before.cfgCwd);
    expect(after.metaCwd).toBe(before.metaCwd);
    expect(after.diskCwd).toBe(h.a);
    expect(after.fileIndexCwd).toBe(h.a);
    expect(after.memoryCwd).toBe(h.a);
    expect(after.checkpointCwd).toBe(h.a);
    expect(after.rulesCwd).toBe(h.a);
    expect(after.previous).toBe(null);
    const sys = String(h.messages[0]?.content ?? "");
    expect(sys).toContain("RULES-FROM-A-MARKER");
    expect(sys).not.toContain("RULES-FROM-B-MARKER");
  });

  test("必做改挂失败（FileIndex.setCwd 抛错）则整次失败且侧状态全部不变，含已 persist 的 meta 回退", async () => {
    const h = makeHarness();
    writeFileSync(join(h.b, "AGENTS.md"), "RULES-FROM-B-MARKER\n", "utf8");
    h.deps.fileIndex = {
      setCwd: () => {
        throw new Error("index boom");
      },
    };
    const before = snapshotState(h);
    const r = await changeSessionCwd(h.b, h.deps);
    expect(r.ok).toBe(false);
    expect(h.cfg.cwd).toBe(h.a);
    expect(h.meta.cwd).toBe(h.a);
    expect(loadSession(h.meta.id)?.meta.cwd).toBe(h.a);
    expect(h.memoryCwd).toBe(before.memoryCwd);
    expect(h.checkpointCwd).toBe(before.checkpointCwd);
    expect(h.rulesCwd).toBe(before.rulesCwd);
    expect(h.previous.get()).toBe(null);
    const sys = String(h.messages[0]?.content ?? "");
    expect(sys).toContain("RULES-FROM-A-MARKER");
    expect(sys).not.toContain("RULES-FROM-B-MARKER");
  });

  test("新根没有 AGENTS.md/NEO.md/.neo.md 则项目记忆段清空，不能沿用旧文", async () => {
    const h = makeHarness();
    expect(existsSync(join(h.b, "AGENTS.md"))).toBe(false);
    const r = await changeSessionCwd(h.b, h.deps);
    expect(r.ok).toBe(true);
    const sys = String(h.messages[0]?.content ?? "");
    expect(sys).not.toContain("RULES-FROM-A-MARKER");
    expect(sys).not.toContain("项目记忆（来自");
  });

  test("更新 meta.cwd 后能按同一 id 读到新目录；不改 session id、不搬文件", async () => {
    const h = makeHarness();
    const oldPath = h.meta.path;
    const id = h.meta.id;
    const r = await changeSessionCwd(h.b, h.deps);
    expect(r.ok).toBe(true);
    const loaded = loadSession(id);
    expect(loaded).not.toBeNull();
    expect(loaded?.meta.id).toBe(id);
    expect(loaded?.meta.path).toBe(oldPath);
    expect(loaded?.meta.cwd).toBe(h.b);
    expect(existsSync(oldPath)).toBe(true);
  });

  test("/cd - 回到上一根；无上一根时拒绝；失败的 /cd 不写入上一根槽", async () => {
    const h = makeHarness();
    writeFileSync(join(h.b, "AGENTS.md"), "RULES-FROM-B-MARKER\n", "utf8");
    const noPrev = await changeSessionCwd("-", h.deps);
    expect(noPrev.ok).toBe(false);
    if (!noPrev.ok) expect(noPrev.error.length).toBeGreaterThan(0);
    expect(h.cfg.cwd).toBe(h.a);
    expect(h.previous.get()).toBe(null);

    expect((await changeSessionCwd(h.b, h.deps)).ok).toBe(true);
    expect(h.cfg.cwd).toBe(h.b);
    expect(h.previous.get()).toBe(h.a);

    const failed = await changeSessionCwd("missing-dir", h.deps);
    expect(failed.ok).toBe(false);
    expect(h.previous.get()).toBe(h.a);
    expect(h.cfg.cwd).toBe(h.b);

    const back = await changeSessionCwd("-", h.deps);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.unchanged).toBe(false);
      expect(back.cwd).toBe(h.a);
    }
    expect(h.cfg.cwd).toBe(h.a);
    expect(h.previous.get()).toBe(h.b);
  });

  test("飞行中子代理 / wiki worker / 本轮 turn 拒绝换根，状态不变", async () => {
    const h = makeHarness();
    const before = snapshotState(h);
    h.deps.busyReason = "后台子代理任务正在运行，不能切换工作目录";
    const r = await changeSessionCwd(h.b, h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("后台子代理");
    expect(snapshotState(h)).toEqual(before);
  });

  test("LSP 重启失败只警告、不回滚已成功的换根", async () => {
    const h = makeHarness();
    h.lspImpl = () => {
      throw new Error("lsp down");
    };
    const r = await changeSessionCwd(h.b, h.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings?.some((w) => w.includes("LSP 重启失败"))).toBe(true);
    expect(h.cfg.cwd).toBe(h.b);
    expect(loadSession(h.meta.id)?.meta.cwd).toBe(h.b);
    expect(h.lspCalls).toBe(1);
  });

  test("LSP 重启返回 rejected Promise 时，警告在返回值里且不回滚", async () => {
    const h = makeHarness();
    h.lspImpl = () => Promise.reject(new Error("lsp async down"));
    const r = await changeSessionCwd(h.b, h.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings?.some((w) => w.includes("LSP 重启失败") && w.includes("lsp async down"))).toBe(true);
    expect(h.cfg.cwd).toBe(h.b);
    expect(h.meta.cwd).toBe(h.b);
    expect(loadSession(h.meta.id)?.meta.cwd).toBe(h.b);
    expect(h.lspCalls).toBe(1);
  });

  test("信箱 profile.cwd 随成功换根更新", async () => {
    const h = makeHarness({ mailbox: true });
    expect(h.mailbox?.profile().cwd).toBe(h.a);
    const r = await changeSessionCwd(h.b, h.deps);
    expect(r.ok).toBe(true);
    expect(h.mailbox?.profile().cwd).toBe(h.b);
  });
});

describe("cwdSwitchBusyReason", () => {
  test("空闲为 null；running 任务、wiki worker、turnActive 都要拦截", () => {
    expect(cwdSwitchBusyReason({})).toBeNull();
    expect(cwdSwitchBusyReason({ backgroundTasks: [{ status: "done", kind: "task" }] })).toBeNull();
    expect(cwdSwitchBusyReason({ backgroundTasks: [{ status: "interrupted", kind: "task" }] })).toBeNull();
    const task = cwdSwitchBusyReason({ backgroundTasks: [{ status: "running", kind: "task" }] });
    expect(task).not.toBeNull();
    expect(String(task)).toMatch(/后台|子代理|任务/);
    const wiki = cwdSwitchBusyReason({ wikiRunning: true });
    expect(wiki).not.toBeNull();
    expect(String(wiki)).toMatch(/wiki/i);
    const turn = cwdSwitchBusyReason({ turnActive: true });
    expect(turn).not.toBeNull();
    expect(String(turn)).toMatch(/turn|本轮|循环/);
  });
});

describe("最小目录补全", () => {
  test("列出 /cd 参数下当前层目录，不扫整树", () => {
    const root = tempDir("neo-69-comp-");
    mkdirSync(join(root, "alpha"), { recursive: true });
    mkdirSync(join(root, "ab-dir"), { recursive: true });
    mkdirSync(join(root, "alpha", "deep-should-not-list"), { recursive: true });
    writeFileSync(join(root, "alpha.txt"), "file", "utf8");
    const all = listCdCompletions(root, "");
    expect(all.some((p) => p.includes("alpha"))).toBe(true);
    expect(all.some((p) => p.includes("ab-dir"))).toBe(true);
    expect(all.some((p) => p.includes("deep-should-not-list"))).toBe(false);
    expect(all.some((p) => p.includes("alpha.txt"))).toBe(false);
    const filtered = listCdCompletions(root, "ab");
    expect(filtered.some((p) => p.includes("ab-dir"))).toBe(true);
    expect(filtered.some((p) => p === "alpha" || p.endsWith("/alpha") || p.endsWith("/alpha/"))).toBe(false);
  });
});

describe("dispatchCommand 接线", () => {
  test("/cd 无参只打印当前会话 cwd，不改状态", async () => {
    const h = makeHarness();
    const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
    const before = snapshotState(h);
    const ctx = makeCmdCtx(h, cap.ui);
    await dispatchCommand("/cd", ctx);
    const out = cap.out();
    expect(out).not.toMatch(/未知命令/);
    expect(out).toContain(h.a);
    expect(snapshotState(h)).toEqual(before);
    expect(h.cfg.cwd).toBe(h.a);
  });

  test("/cd 成功走命令分发后 cfg 与 meta 已换根", async () => {
    const h = makeHarness();
    writeFileSync(join(h.b, "AGENTS.md"), "RULES-FROM-B-MARKER\n", "utf8");
    const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
    await dispatchCommand(`/cd ${h.b}`, makeCmdCtx(h, cap.ui));
    expect(h.cfg.cwd).toBe(h.b);
    expect(loadSession(h.meta.id)?.meta.cwd).toBe(h.b);
    expect(cap.out()).not.toMatch(/未知命令/);
  });

  test("/cd 异步 LSP 失败时命令处理把警告打给用户，且已换根", async () => {
    const h = makeHarness();
    h.lspImpl = () => Promise.reject(new Error("lsp async down"));
    const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
    await dispatchCommand(`/cd ${h.b}`, makeCmdCtx(h, cap.ui));
    expect(h.cfg.cwd).toBe(h.b);
    expect(loadSession(h.meta.id)?.meta.cwd).toBe(h.b);
    const out = cap.out();
    expect(out).toMatch(/LSP 重启失败/);
    expect(out).toContain("lsp async down");
    expect(out).not.toMatch(/未知命令/);
  });
});

function makeCmdCtx(h: Harness, ui: CommandContext["ui"]): CommandContext {
  const agent = {
    messages: h.messages,
    refreshSystemPrompt: h.deps.refreshSystemPrompt,
    planning: false,
    mode: "ask",
  };
  return {
    agent,
    ui,
    cfg: h.cfg,
    memory: { setCwd: h.deps.memory?.setCwd } as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: h.meta,
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: h.mailbox,
    checkpoints: { rebind: h.deps.checkpoints?.rebind } as CommandContext["checkpoints"],
    promptManager: h.promptManager,
    persistSession: h.deps.persist,
    previousCwd: h.previous,
    fileIndex: h.deps.fileIndex,
    turnActive: false,
    restartLsp: h.deps.restartLsp,
  } as unknown as CommandContext;
}
