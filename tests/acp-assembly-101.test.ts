/**
 * issue #101：ACP 会话装配与 CLI 对齐（指令文件 / 嵌套注入 / 保持 #17 /
 * mcpLoaded / 有序备用链 / 上下文与输出溢出写回）。
 *
 * 锁住已签切面：先把「CLI 有、ACP 也必须有」和「ACP 有意不接」写成表；
 * 再按 pickInstructionFile 测指令文件，而不是「四个文件都进永久段」。
 * 形态：同进程调用 createAcpSession（等效会话装配）；禁止 mock.module，
 * 不触网（溢出写回的 /models 只用本进程假网关），不读真实 ~/.neo。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAcpSession, type CreateAcpSessionOptions } from "../src/acp/session.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { formatAlwaysOnRules } from "../src/rules/index.ts";
import { discoverProjectRules } from "../src/rules/index.ts";
import { LLMError, type StreamHandlers, type StreamResult, type chatStream } from "../src/llm.ts";
import { makeMcpTool } from "../src/mcp/tool.ts";
import { dispatch, registerTool } from "../src/tools/index.ts";
import { resetEnvCache } from "../src/env/probe.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-acp-101-")));
const sessionsDir = join(SANDBOX, "sessions");
const homeDir = join(SANDBOX, "home");
mkdirSync(join(homeDir, ".neo"), { recursive: true });

const ISOLATED_ENV: Record<string, string> = {
  HOME: homeDir,
  NEO_ENV_HOME: homeDir,
  NEO_SESSIONS_DIR: sessionsDir,
  NEO_MAILBOX_DIR: join(SANDBOX, "mailbox"),
  NEO_MEMORY_DIR: join(SANDBOX, "memory"),
  NEO_USER_WIKI_DIR: join(SANDBOX, "wiki"),
  NEO_MEMORY_JOURNAL_DIR: join(SANDBOX, "journal"),
  NEO_TMP_DIR: join(SANDBOX, "tmp"),
  NEO_MEMORY_DISABLE: "1",
};

const savedEnv: Record<string, string | undefined> = {};
for (const key of Object.keys(ISOLATED_ENV)) savedEnv[key] = process.env[key];
for (const key of ["NEO_API_KEY", "NEO_BASE_URL", "NEO_PROVIDER", "NEO_MODEL", "NEO_TIER"]) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}
Object.assign(process.env, ISOLATED_ENV);

let caseSeq = 0;
const unregisters: Array<() => void> = [];
const openSessions: Array<{ dispose: () => void }> = [];

afterEach(() => {
  while (openSessions.length > 0) {
    const s = openSessions.pop();
    try {
      s?.dispose();
    } catch {
      /* 单测清理 */
    }
  }
  while (unregisters.length > 0) {
    try {
      unregisters.pop()?.();
    } catch {
      /* 单测清理 */
    }
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  rmSync(SANDBOX, { recursive: true, force: true });
});

type SettingsOver = {
  modelFallback?: Array<{ provider: string; model: string }>;
  extraProviders?: Record<string, unknown>[];
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  maxTokens?: number;
  mcp?: Record<string, unknown>;
};

function providerEntry(name: string, model: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    provider_name: name,
    provider_type: "openai",
    base_url: over.base_url ?? "http://127.0.0.1:9/v1",
    api_key: over.api_key ?? "test",
    default_model_name: model,
    deep_reasoning_model_name: model,
    balanced_model_name: model,
    fast_model_name: model,
    max_tokens: over.max_tokens ?? 64,
    temperature: 0,
  };
  if (over.context_window !== undefined) {
    if (over.context_window !== null) entry.context_window = over.context_window;
  } else {
    entry.context_window = 100_000;
  }
  if (over.max_output_tokens !== undefined && over.max_output_tokens !== null) {
    entry.max_output_tokens = over.max_output_tokens;
  }
  for (const [k, v] of Object.entries(over)) {
    if (k === "context_window" || k === "max_output_tokens" || k === "base_url" || k === "api_key" || k === "max_tokens") continue;
    entry[k] = v;
  }
  return entry;
}

function writeSettings(dir: string, over: SettingsOver = {}): string {
  const providers = [
    providerEntry("fake", "fake-model", {
      context_window: over.contextWindow === undefined ? 100_000 : over.contextWindow,
      max_output_tokens: over.maxOutputTokens ?? null,
      max_tokens: over.maxTokens ?? 64,
    }),
    ...(over.extraProviders ?? []),
  ];
  const raw: Record<string, unknown> = {
    default_provider: "fake",
    default_model_tier: "default",
    classifier_provider: "fake",
    classifier_model_name: "fake-model",
    providers,
    retry: { max_attempts: 1, base_delay_ms: 1, connect_timeout_ms: 1_000, stream_idle_timeout_ms: 1_000 },
    memory: {
      enabled: false,
      user_level_dir: join(SANDBOX, "memory"),
      user_wiki_dir: join(SANDBOX, "wiki"),
      journal_dir: join(SANDBOX, "journal"),
    },
    env: { enabled: false, prompt: false, wiki_page: false },
    skills_store: join(SANDBOX, "skills"),
    agents_store: join(SANDBOX, "agents"),
  };
  if (over.modelFallback) raw.model_fallback = over.modelFallback;
  if (over.mcp) raw.mcp = over.mcp;
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify(raw, null, 2), "utf8");
  return path;
}

function project(over: SettingsOver = {}): string {
  const dir = join(SANDBOX, `p${caseSeq++}`);
  mkdirSync(dir, { recursive: true });
  writeSettings(dir, over);
  return dir;
}

function loadIsolatedConfig(cwd: string): Config {
  const cfg = loadConfig({ cwd }, { settingsDir: cwd });
  cfg.cwd = cwd;
  cfg.memory.enabled = false;
  if (cfg.env) {
    cfg.env.enabled = false;
    cfg.env.prompt = false;
    cfg.env.wikiPage = false;
  }
  return cfg;
}

function writeRel(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function initFakeGit(root: string): void {
  mkdirSync(join(root, ".git"), { recursive: true });
}

function writeAlwaysOnRule(root: string, name: string, body: string): void {
  writeRel(root, `.neo/rules/${name}.md`, body);
}

function sysText(agent: { messages: Array<{ content?: unknown }> }): string {
  const system = agent.messages[0]?.content;
  return typeof system === "string" ? system : "";
}

/** 测试注入 chatStream：实现必须把它交给 Agent.opt.chatStream 与 ModelFallbackController。 */
type SessionOpts = CreateAcpSessionOptions & { chatStream?: typeof chatStream };

async function openSession(opts: SessionOpts) {
  while (openSessions.length > 0) {
    try {
      openSessions.pop()?.dispose();
    } catch {
      /* 同一测试里再开会话前先释放，避免运行时工具重名注册 */
    }
  }
  const session = await createAcpSession(opts as CreateAcpSessionOptions);
  openSessions.push(session);
  return session;
}

function okResult(content = "ok"): StreamResult {
  return {
    content,
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    raw: null,
  };
}

function llmError(message: string, status?: number): LLMError {
  return new LLMError(message, status);
}

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
  let stderr = "";
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return (orig as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { result: fn(), stderr };
  } finally {
    process.stderr.write = orig;
  }
}

async function captureStderrAsync<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = "";
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return (orig as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr };
  } finally {
    process.stderr.write = orig;
  }
}

function readSessionSource(): string {
  return readFileSync(join(import.meta.dir, "../src/acp/session.ts"), "utf8");
}

function readCliSource(): string {
  return readFileSync(join(import.meta.dir, "../src/cli/sessionStart.ts"), "utf8");
}

function mcpCatalogOf(text: string): string {
  const start = text.indexOf("## MCP 工具目录");
  if (start < 0) return "";
  const rest = text.slice(start);
  const cut = rest.indexOf("\n## ", 1);
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

function serveModels(entry: Record<string, unknown>): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [entry] });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

function registerFakeMcp(server: string, tools: Array<{ name: string; description: string }>): string[] {
  const names: string[] = [];
  for (const t of tools) {
    const marker = `schema-marker-${server}-${t.name}`;
    const impl = makeMcpTool({
      server,
      info: {
        name: t.name,
        description: t.description,
        inputSchema: {
          type: "object",
          properties: { payload: { type: "string", description: marker.repeat(8) } },
          required: ["payload"],
        },
      },
      call: async (_remote, args) => `called:${server}/${t.name}:${String(args["payload"] ?? "")}`,
    });
    unregisters.push(registerTool(impl));
    names.push(impl.spec.function.name);
  }
  return names;
}

function manyWidgets(n: number): Array<{ name: string; description: string }> {
  return Array.from({ length: n }, (_, i) => {
    const id = String(i).padStart(2, "0");
    return { name: `widget_${id}`, description: `Widget number ${id} helper for catalogs and search` };
  });
}

/* ------------------------------------------------------------------ */
/* 1. 差异表                                                           */
/* ------------------------------------------------------------------ */

/** CLI 有、ACP 也必须有的装配项。删掉任一必须项时本表测试应当失败。 */
const REQUIRED_ACP_ASSEMBLY = [
  {
    id: "instruction-files",
    needles: ["loadSessionInstructionMemory"],
    reason: "项目指令必须走同一 helper（pickInstructionFile 优先级，含 CLAUDE.md 与祖先），不得另开旁路",
  },
  {
    id: "nested-injection",
    needles: ["nestedAgentsPrompt", "collectNestedInstructionFiles", "formatNestedAgentsBlock", "composePermanentMemory"],
    reason: "嵌套指令按需注入必须复用 CLI 同一套 helper，每目录走 pickInstructionFile",
  },
  {
    id: "always-on-rules-17",
    needles: ["formatAlwaysOnRules"],
    reason: "换 helper 后 #17 无 paths 规则仍必须并入永久项目记忆段，丢掉即漂移",
  },
  {
    id: "mcp-loaded",
    needles: ["mcpLoaded", "mcpLoadedNames"],
    reason: "刷新系统提示时必须传入已装入集合，否则目录会把已装入工具仍标成尚未装入",
  },
  {
    id: "fallback-chain",
    needles: ["ModelFallbackController", "mainChatStream", "isFallbackActive"],
    reason: "配置了 model_fallback 时 ACP 必须接上有序备用链，不得静默失效",
  },
  {
    id: "overflow-writeback",
    needles: ["onContextLimit", "writeBackContextLimit", "onOutputLimit", "writeBackOutputLimit", "recordModelContext"],
    reason: "上下文/输出撞墙写回必须与 CLI 同一组回调，只补空字段",
  },
] as const;

/** ACP 有意不接的项（每条带理由）。本单不得把它们接上。 */
const INTENTIONAL_ACP_OMISSIONS = [
  {
    id: "mailbox",
    mustNot: ["makeSendMessageTool", "makeListPeersTool", "openMailbox", "pollInbox"],
    reason: "跨会话信箱是编辑器宿主不需要的 CLI 能力，ACP 默认关且不注册 send_message / list_peers",
  },
  {
    id: "ask_user",
    mustNot: ["makeAskUserTool"],
    reason: "编辑器没有 TUI 提问模态，ask_user 不注册到 ACP",
  },
  {
    id: "tui-components",
    mustNot: ["createComposer", "createDock", "createRepl", "src/tui/"],
    reason: "ACP 宿主是编辑器而不是 TUI，不装配 composer / dock / REPL",
  },
  {
    id: "background-subagents",
    mustNot: ["pollBackground", "BackgroundTasks", "new BackgroundTasks"],
    reason: "后台子代理与结果回注入是 CLI 会话循环能力，ACP 首期不接",
  },
  {
    id: "worktree-tools-85",
    mustNot: ["makeWorktreeTools"],
    reason: "issue #85：ACP 不注册 worktree 进出工具",
  },
  {
    id: "monitor-hidden-100",
    mustNot: [],
    must: ['excludeTools: ["monitor"]', "monitor: false"],
    reason: "issue #100：monitor 暂不向 ACP 暴露；本单不得回退该口径",
  },
] as const;

describe("#101 差异表：CLI/ACP 装配必须项与有意不接项", () => {
  test("必须项被删掉时失败；有意不接项仍锁在 ACP 之外", () => {
    const acp = readSessionSource();
    const cli = readCliSource();
    expect(cli).toContain("loadSessionInstructionMemory");
    expect(cli).toContain("nestedAgentsPrompt");
    expect(cli).toContain("formatAlwaysOnRules");
    expect(cli).toContain("mcpLoadedNames");
    expect(cli).toContain("fallbackController");
    expect(cli).toContain("mainChatStream");
    expect(cli).toContain("onContextLimit");
    expect(cli).toContain("onOutputLimit");

    const missing: string[] = [];
    for (const row of REQUIRED_ACP_ASSEMBLY) {
      const absent = row.needles.filter((n) => !acp.includes(n));
      if (absent.length > 0) missing.push(`${row.id} 缺少 ${absent.join(", ")}（${row.reason}）`);
    }
    expect(missing).toEqual([]);

    const leaked: string[] = [];
    for (const row of INTENTIONAL_ACP_OMISSIONS) {
      for (const n of row.mustNot) {
        if (acp.includes(n)) leaked.push(`${row.id} 不应出现 ${n}（${row.reason}）`);
      }
      if ("must" in row) {
        for (const n of row.must ?? []) {
          if (!acp.includes(n)) leaked.push(`${row.id} 必须保留 ${n}（${row.reason}）`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 指令文件                                                         */
/* ------------------------------------------------------------------ */

describe("#101 指令文件（pickInstructionFile，不拼接）", () => {
  test("cwd 只有 CLAUDE.md 时，永久项目记忆段含其内容（因为它被选中）", async () => {
    const cwd = project();
    writeRel(cwd, "CLAUDE.md", "CLAUDE-ONLY-MARKER");
    const session = await openSession({ cfg: loadIsolatedConfig(cwd), cwd, onText: () => undefined });
    const text = sysText(session.agent);
    expect(text).toContain("CLAUDE-ONLY-MARKER");
    expect(text).toContain("## 项目记忆");
  });

  test("同目录同时有 AGENTS.md 与 CLAUDE.md 时只进入 AGENTS.md，不拼接 CLAUDE.md", async () => {
    const cwd = project();
    writeRel(cwd, "AGENTS.md", "AGENTS-WINS-MARKER");
    writeRel(cwd, "CLAUDE.md", "CLAUDE-MUST-NOT-CONCAT");
    const session = await openSession({ cfg: loadIsolatedConfig(cwd), cwd, onText: () => undefined });
    const text = sysText(session.agent);
    expect(text).toContain("AGENTS-WINS-MARKER");
    expect(text).not.toContain("CLAUDE-MUST-NOT-CONCAT");
  });

  test("子目录 AGENTS.md / NEO.md / .neo.md / CLAUDE.md 在触达后按每目录取一个注入", async () => {
    const cwd = project();
    writeRel(cwd, "AGENTS.md", "ROOT-PERM-SHOULD-STAY-PERMANENT");
    writeRel(cwd, "packages/foo/AGENTS.md", "FOO-AGENTS-MARKER");
    writeRel(cwd, "packages/bar/NEO.md", "BAR-NEO-MARKER");
    writeRel(cwd, "packages/baz/.neo.md", "BAZ-NEO-MD-MARKER");
    writeRel(cwd, "packages/qux/CLAUDE.md", "QUX-CLAUDE-MARKER");
    writeRel(cwd, "packages/foo/a.ts", "a");
    writeRel(cwd, "packages/bar/b.ts", "b");
    writeRel(cwd, "packages/baz/c.ts", "c");
    writeRel(cwd, "packages/qux/d.ts", "d");
    const session = await openSession({ cfg: loadIsolatedConfig(cwd), cwd, onText: () => undefined });
    const fn = session.agent.opt.nestedAgentsPrompt;
    expect(fn).toBeTypeOf("function");
    const cases: Array<[string, string]> = [
      ["packages/foo/a.ts", "FOO-AGENTS-MARKER"],
      ["packages/bar/b.ts", "BAR-NEO-MARKER"],
      ["packages/baz/c.ts", "BAZ-NEO-MD-MARKER"],
      ["packages/qux/d.ts", "QUX-CLAUDE-MARKER"],
    ];
    for (const [touched, marker] of cases) {
      const block = fn!([touched]);
      expect(block, `触达 ${touched} 应注入`).not.toBeNull();
      expect(block!.text).toContain(marker);
      expect(block!.text).toContain("## 嵌套项目指令");
      expect(block!.text).not.toContain("ROOT-PERM-SHOULD-STAY-PERMANENT");
    }
    expect(fn!(["README.md"])).toBeNull();
  });

  test("git 工作树内祖先指令每层取一个，进入永久段", async () => {
    const repo = project();
    initFakeGit(repo);
    writeRel(repo, "AGENTS.md", "GIT-ROOT-AGENTS-MARKER");
    writeRel(repo, "CLAUDE.md", "GIT-ROOT-CLAUDE-MUST-NOT");
    const cwd = join(repo, "packages", "foo");
    mkdirSync(cwd, { recursive: true });
    writeSettings(cwd);
    writeRel(cwd, "CLAUDE.md", "CWD-CLAUDE-MARKER");
    const session = await openSession({ cfg: loadIsolatedConfig(cwd), cwd, onText: () => undefined });
    const text = sysText(session.agent);
    expect(text).toContain("CWD-CLAUDE-MARKER");
    expect(text).toContain("GIT-ROOT-AGENTS-MARKER");
    expect(text).not.toContain("GIT-ROOT-CLAUDE-MUST-NOT");
  });
});

/* ------------------------------------------------------------------ */
/* 3. #17 保持                                                         */
/* ------------------------------------------------------------------ */

describe("#101 保持 #17 无 paths 规则并入", () => {
  test("换 helper 后永久段仍含 formatAlwaysOnRules 输出", async () => {
    const cwd = project();
    writeRel(cwd, "AGENTS.md", "PERM-AGENTS");
    writeAlwaysOnRule(cwd, "base", "ALWAYS-ON-RULE-MARKER：无 paths 的会话规则");
    const session = await openSession({ cfg: loadIsolatedConfig(cwd), cwd, onText: () => undefined });
    const expected = formatAlwaysOnRules(discoverProjectRules(cwd));
    expect(expected).toContain("ALWAYS-ON-RULE-MARKER");
    const text = sysText(session.agent);
    expect(text).toContain("PERM-AGENTS");
    expect(text).toContain("ALWAYS-ON-RULE-MARKER");
    expect(text).toContain("项目规则（每会话加载");
    expect(text).toContain(expected.trim());
  });

  test("safeMode 为真时指令文件不加载，且不借机改变 #17 既有行为", async () => {
    const cwd = project();
    writeRel(cwd, "AGENTS.md", "SAFE-MODE-MUST-NOT-LOAD");
    writeAlwaysOnRule(cwd, "base", "SAFE-MODE-ALWAYS-ON-KEPT");
    const cfg = loadIsolatedConfig(cwd);
    cfg.safeMode = true;
    const session = await openSession({ cfg, cwd, onText: () => undefined });
    const text = sysText(session.agent);
    expect(text).not.toContain("SAFE-MODE-MUST-NOT-LOAD");
    // ACP 既有口径：safeMode 只约束指令文件，#17 仍并入。不得顺手关掉。
    expect(text).toContain("SAFE-MODE-ALWAYS-ON-KEPT");
    expect(text).toContain("项目规则（每会话加载");
    const nested = session.agent.opt.nestedAgentsPrompt;
    expect(nested).toBeTypeOf("function");
    writeRel(cwd, "pkg/AGENTS.md", "NESTED-SAFE-MUST-NOT");
    writeRel(cwd, "pkg/x.ts", "x");
    expect(nested!(["pkg/x.ts"])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 4. mcpLoaded                                                       */
/* ------------------------------------------------------------------ */

describe("#101 mcpLoaded 传入刷新路径", () => {
  test("tool_search 装入后，下一轮系统提示目录不再把它标成尚未装入", async () => {
    const cwd = project({
      mcp: { tool_search: true, tool_search_threshold: 3 },
    });
    const cfg = loadIsolatedConfig(cwd);
    // 会话启动时不要拉真实 MCP 子进程：先建会话，再往 cfg / 注册表里塞假工具。
    const session = await openSession({ cfg, cwd, onText: () => undefined });
    registerFakeMcp("big", manyWidgets(10));
    cfg.mcp = { ...(cfg.mcp ?? {}), toolSearch: true, toolSearchThreshold: 3 };
    cfg.mcpServers = [
      {
        name: "big",
        transport: "stdio",
        command: "true",
        args: [],
        env: {},
        enabled: true,
      },
    ];
    session.agent.refreshSystemPrompt();
    const before = mcpCatalogOf(sysText(session.agent));
    expect(before).toMatch(/尚未装入上下文/);
    expect(before).toContain("- mcp__big__widget_00：");

    const searched = await dispatch(
      "tool_search",
      JSON.stringify({ query: "widget_00" }),
      session.agent.makeCtx(new AbortController().signal),
    );
    expect(searched.ok !== false || searched.output.includes("widget_00")).toBe(true);
    expect(session.agent.mcpLoadedNames()).toContain("mcp__big__widget_00");

    session.agent.refreshSystemPrompt();
    const after = mcpCatalogOf(sysText(session.agent));
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toContain("- mcp__big__widget_00：");
    expect(after).toContain("- mcp__big__widget_01：");
    expect(after).toMatch(/尚未装入上下文/);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 备用链                                                           */
/* ------------------------------------------------------------------ */

function fallbackSettings(): SettingsOver {
  return {
    modelFallback: [{ provider: "backup", model: "backup-model" }],
    extraProviders: [providerEntry("backup", "backup-model")],
  };
}

describe("#101 ACP 有序备用链装配与会话行为", () => {
  test("空链不建 controller，主请求走默认/注入的 chatStream", async () => {
    const cwd = project();
    const cfg = loadIsolatedConfig(cwd);
    expect(cfg.modelFallback ?? []).toHaveLength(0);
    const seen: string[] = [];
    const stream = (async (c: Config) => {
      seen.push(`${c.providerName}:${c.model}`);
      return okResult("empty-chain");
    }) as typeof chatStream;
    const session = await openSession({ cfg, cwd, onText: () => undefined, chatStream: stream });
    expect(session.agent.opt.mainChatStream).toBeUndefined();
    expect(session.agent.opt.isFallbackActive).toBeUndefined();
    const r = await session.prompt("hello");
    expect(r.stopReason).toBe("end_turn");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.startsWith("fake:"))).toBe(true);
    expect(cfg.providerName).toBe("fake");
  });

  test("首个候选失败且未发增量、第二个成功后，cfg 切到后者且不写回 settings，后续主请求不再回切", async () => {
    const cwd = project(fallbackSettings());
    const cfg = loadIsolatedConfig(cwd);
    expect(cfg.modelFallback.length).toBeGreaterThan(0);
    const settingsBefore = readFileSync(join(cwd, "settings.json"), "utf8");
    const seen: string[] = [];
    const stream = (async (c: Config) => {
      seen.push(`${c.providerName}:${c.model}`);
      if (c.providerName === "fake") throw llmError("HTTP 503 upstream", 503);
      return okResult(`from-${c.providerName}`);
    }) as typeof chatStream;
    const chunks: string[] = [];
    const { result, stderr } = await captureStderrAsync(async () => {
      const session = await openSession({ cfg, cwd, onText: (t) => chunks.push(t), chatStream: stream });
      expect(session.agent.opt.mainChatStream).toBeTypeOf("function");
      expect(session.agent.opt.isFallbackActive).toBeTypeOf("function");
      const r = await session.prompt("first");
      return { session, r };
    });
    expect(result.r.stopReason).toBe("end_turn");
    expect(cfg.providerName).toBe("backup");
    expect(cfg.model).toBe("backup-model");
    expect(result.session.agent.opt.isFallbackActive!()).toBe(true);
    expect(stderr).toMatch(/\[(?:acp)\]?\s*\[fallback\]|\[fallback\]/);
    expect(stderr).toContain("[fallback]");
    expect(chunks.join("")).not.toMatch(/\[fallback\]/);
    const settingsAfterFirst = readFileSync(join(cwd, "settings.json"), "utf8");
    expect(settingsAfterFirst).toBe(settingsBefore);
    expect(JSON.parse(settingsAfterFirst).model_fallback).toEqual([{ provider: "backup", model: "backup-model" }]);
    expect(JSON.parse(settingsAfterFirst).default_provider).toBe("fake");

    seen.length = 0;
    const second = await result.session.prompt("second");
    expect(second.stopReason).toBe("end_turn");
    expect(cfg.providerName).toBe("backup");
    expect(seen.some((s) => s.startsWith("fake:"))).toBe(false);
    expect(seen.some((s) => s.startsWith("backup:"))).toBe(true);
    expect(readFileSync(join(cwd, "settings.json"), "utf8")).toBe(settingsBefore);
  });

  test("已发出流式增量后不得再切", async () => {
    const cwd = project(fallbackSettings());
    const cfg = loadIsolatedConfig(cwd);
    let calls = 0;
    const stream = (async (_c: Config, _m: unknown, _t: unknown, handlers: StreamHandlers = {}) => {
      calls += 1;
      handlers.onContent?.("partial");
      throw llmError("HTTP 503 after increment", 503);
    }) as typeof chatStream;
    const session = await openSession({ cfg, cwd, onText: () => undefined, chatStream: stream });
    let thrown = false;
    try {
      await session.prompt("go");
    } catch {
      thrown = true;
    }
    expect(thrown || calls === 1).toBe(true);
    expect(calls).toBe(1);
    expect(cfg.providerName).toBe("fake");
    expect(cfg.model).toBe("fake-model");
  });

  test("compact 等非主路径走 streamFn 而不是 mainChatStream", async () => {
    const cwd = project(fallbackSettings());
    const cfg = loadIsolatedConfig(cwd);
    const seen: string[] = [];
    const stream = (async (c: Config) => {
      seen.push(`${c.providerName}:${c.model}`);
      if (c.providerName === "fake") throw llmError("HTTP 503", 503);
      return okResult("should-not-be-used-by-compact");
    }) as typeof chatStream;
    const session = await openSession({ cfg, cwd, onText: () => undefined, chatStream: stream });
    expect(session.agent.opt.mainChatStream).toBeTypeOf("function");
    expect(session.agent.opt.chatStream).toBe(stream);
    expect(session.agent.streamFn).toBe(stream);
    expect(session.agent.mainStreamFn).not.toBe(session.agent.streamFn);

    session.agent.messages.push({ role: "user", content: "keep some history for compact" });
    session.agent.messages.push({ role: "assistant", content: "ok" });
    const compactOk = await session.agent.compact();
    // compact 走 raw stream：主模型 503 应失败，不得经 controller 切到 backup。
    expect(compactOk).toBe(false);
    expect(cfg.providerName).toBe("fake");
    expect(seen.every((s) => s.startsWith("fake:"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 溢出写回                                                         */
/* ------------------------------------------------------------------ */

describe("#101 溢出写回走同一组 CLI 回调，说明只在 stderr", () => {
  test("onContextLimit：空字段被补上，已有用户值不被覆盖；说明不进协议文本", async () => {
    const emptyDir = project({ contextWindow: null });
    const emptyCfg = loadIsolatedConfig(emptyDir);
    const chunks: string[] = [];
    const emptySession = await openSession({ cfg: emptyCfg, cwd: emptyDir, onText: (t) => chunks.push(t) });
    expect(emptySession.agent.opt.onContextLimit).toBeTypeOf("function");
    const { stderr } = captureStderr(() => {
      emptySession.agent.opt.onContextLimit!(128_000, emptyCfg.model);
    });
    const afterEmpty = JSON.parse(readFileSync(join(emptyDir, "settings.json"), "utf8")) as {
      providers: Array<{ context_window?: number }>;
    };
    expect(afterEmpty.providers[0]?.context_window).toBe(128_000);
    expect(chunks.join("")).not.toMatch(/context_window|已从网关|写回/);
    void stderr;

    const filledDir = project({ contextWindow: 50_000 });
    const filledCfg = loadIsolatedConfig(filledDir);
    const filledSession = await openSession({ cfg: filledCfg, cwd: filledDir, onText: (t) => chunks.push(t) });
    filledSession.agent.opt.onContextLimit!(128_000, filledCfg.model);
    const afterFilled = JSON.parse(readFileSync(join(filledDir, "settings.json"), "utf8")) as {
      providers: Array<{ context_window?: number }>;
    };
    expect(afterFilled.providers[0]?.context_window).toBe(50_000);
  });

  test("onOutputLimit：空字段由网关补上；已有值与 max_tokens / completion_tokens 不得充当上限；说明只在 stderr", async () => {
    const gw = serveModels({
      id: "fake-model",
      max_output_tokens: 32_768,
    });
    try {
      const emptyDir = project({ maxOutputTokens: null, maxTokens: 64 });
      const raw = JSON.parse(readFileSync(join(emptyDir, "settings.json"), "utf8")) as {
        providers: Array<Record<string, unknown>>;
      };
      raw.providers[0]!.base_url = gw.url;
      writeFileSync(join(emptyDir, "settings.json"), JSON.stringify(raw, null, 2), "utf8");
      const emptyCfg = loadIsolatedConfig(emptyDir);
      const chunks: string[] = [];
      const session = await openSession({ cfg: emptyCfg, cwd: emptyDir, onText: (t) => chunks.push(t) });
      expect(session.agent.opt.onOutputLimit).toBeTypeOf("function");
      const { stderr } = await captureStderrAsync(async () => {
        session.agent.opt.onOutputLimit!(emptyCfg.model);
        for (let i = 0; i < 40; i++) {
          const cur = JSON.parse(readFileSync(join(emptyDir, "settings.json"), "utf8")) as {
            providers: Array<{ max_output_tokens?: number; max_tokens?: number }>;
          };
          if (cur.providers[0]?.max_output_tokens === 32_768) break;
          await Bun.sleep(25);
        }
      });
      const after = JSON.parse(readFileSync(join(emptyDir, "settings.json"), "utf8")) as {
        providers: Array<{ max_output_tokens?: number; max_tokens?: number }>;
      };
      expect(after.providers[0]?.max_output_tokens).toBe(32_768);
      expect(after.providers[0]?.max_tokens).toBe(64);
      expect(after.providers[0]?.max_output_tokens).not.toBe(64);
      expect(stderr).toMatch(/已从网关 \/models 补上|max_output_tokens/);
      expect(chunks.join("")).not.toMatch(/已从网关|max_output_tokens|\[fallback\]/);
    } finally {
      gw.stop();
    }

    const thin = serveModels({ id: "fake-model" });
    try {
      const thinDir = project({ maxOutputTokens: null, maxTokens: 64 });
      const raw = JSON.parse(readFileSync(join(thinDir, "settings.json"), "utf8")) as {
        providers: Array<Record<string, unknown>>;
      };
      raw.providers[0]!.base_url = thin.url;
      writeFileSync(join(thinDir, "settings.json"), JSON.stringify(raw, null, 2), "utf8");
      const thinCfg = loadIsolatedConfig(thinDir);
      const session = await openSession({ cfg: thinCfg, cwd: thinDir, onText: () => undefined });
      await session.agent.opt.onOutputLimit!(thinCfg.model);
      await Bun.sleep(200);
      const after = JSON.parse(readFileSync(join(thinDir, "settings.json"), "utf8")) as {
        providers: Array<{ max_output_tokens?: number; max_tokens?: number }>;
      };
      expect(after.providers[0]?.max_output_tokens).toBeUndefined();
      expect(after.providers[0]?.max_tokens).toBe(64);
    } finally {
      thin.stop();
    }

    const kept = serveModels({ id: "fake-model", max_output_tokens: 32_768 });
    try {
      const keptDir = project({ maxOutputTokens: 4096, maxTokens: 64 });
      const raw = JSON.parse(readFileSync(join(keptDir, "settings.json"), "utf8")) as {
        providers: Array<Record<string, unknown>>;
      };
      raw.providers[0]!.base_url = kept.url;
      writeFileSync(join(keptDir, "settings.json"), JSON.stringify(raw, null, 2), "utf8");
      const keptCfg = loadIsolatedConfig(keptDir);
      const session = await openSession({ cfg: keptCfg, cwd: keptDir, onText: () => undefined });
      await session.agent.opt.onOutputLimit!(keptCfg.model);
      await Bun.sleep(200);
      const after = JSON.parse(readFileSync(join(keptDir, "settings.json"), "utf8")) as {
        providers: Array<{ max_output_tokens?: number; max_tokens?: number }>;
      };
      expect(after.providers[0]?.max_output_tokens).toBe(4096);
      expect(after.providers[0]?.max_tokens).toBe(64);
    } finally {
      kept.stop();
    }
  });
});
