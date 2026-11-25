/**
 * mcp-tool-search-68.test.ts — MCP 工具按需发现（issue #68）。
 *
 * 验收（方案 §5 + Leo 拍板收紧）：
 *  1. auto 且可延迟 MCP 数低于阈值：全量 schema，无 tool_search。
 *  2. 达到阈值或 tool_search=true：第一方 + alwaysLoad + 已加载 MCP + tool_search；
 *     未加载 MCP 不得带完整 inputSchema。tool_search=false 即使工具很多也全量装入。
 *  3. tool_search 命中后写入本会话已加载集合，同一 agent loop 下一次模型请求可调用；
 *     空查询/无命中返回明确空结果且不装入。默认最多 5、上限 10。大小写不敏感匹配名字/描述。
 *  4. 直接点名已注册未装入的 mcp__*：审批并执行，同时加入已加载集合（含与 search 同批并行）。
 *     未注册名字明确失败。审批 / sensitive 不放宽。
 *  5. 已加载集合只在会话内存；成功压缩、/clear、会话结束即丢；resume/新会话只留 alwaysLoad。
 *     PreCompact 阻断不得清集合。alwaysLoad 是 server 级，不做按工具名单。
 *  6. 子代理拷贝父会话当时已加载集合并自带 tool_search，不写回父会话，不塞全部 MCP schema。
 *     wiki worker 不扩权。规划态不暴露 MCP / tool_search。
 *  7. /mcp 仍全量；/tools 与 /context 区分已装入和仅目录。#20 dry-run 用实际发送的 specs。
 *     用量/压缩估计与 toolSpecsFor() 同口径。
 *  8. OpenAI 兼容与 Anthropic 都把 tool_search 当普通工具，不走厂商专用 API。
 *
 * 运行：bun test tests/mcp-tool-search-68.test.ts
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import { loadConfig, parseMcpServers, type Config } from "../src/config.ts";
import { parseHooksConfig } from "../src/hooks/index.ts";
import { estimateTokens, type StreamResult, type ToolCall, type ToolSpec } from "../src/llm.ts";
import { buildAnthropicBody, toAnthropicTools } from "../src/anthropicWire.ts";
import { makeMcpTool } from "../src/mcp/tool.ts";
import { WIKI_WORKER_TOOLS } from "../src/memory/wikiMaintainer.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { dispatch, registerTool, toolNames, toolSpecs } from "../src/tools/index.ts";
import { runSubagent } from "../src/tools/task.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import { dispatchCommand, wireCommands } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commands.ts";
import { PromptManager } from "../src/prompt/manager.ts";
import { countSystemTokens } from "../src/prompt/tokens.ts";
import { captureConsole } from "./helpers.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-68-mcp-search-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

const unregisters: Array<() => void> = [];
afterEach(() => {
  for (const un of unregisters.splice(0)) {
    try {
      un();
    } catch {
      /* already gone */
    }
  }
});

function silentIO(): AgentIO {
  return {
    line(): void {},
    blank(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    toolHeader(): void {},
    toolResult(): void {},
    indent(body: string, prefix = "│ "): string {
      return body.split("\n").map((l) => prefix + l).join("\n");
    },
    startSpinner(): void {},
    updateSpinner(): void {},
    stopSpinner(): void {},
    beginStream(): void {},
    writeStream(): void {},
    endStream(): void {},
    ensureStreamClosed(): void {},
    async confirm(): Promise<boolean> {
      return true;
    },
    width: 100,
  };
}

function baseCfg(over: Record<string, unknown> = {}): Config {
  const cwd = SANDBOX;
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [
      {
        name: "p1",
        type: "openai",
        baseUrl: "http://localhost:0",
        apiKey: "k",
        models: { default: "m-default", deep_reasoning: "m-deep", balanced: "m-bal", fast: "m-fast" },
        maxTokens: 100,
        temperature: 0.3,
        contextWindow: 100_000,
      },
    ],
    routes: {
      default: { provider: "p1", model: null, fallbackAllowed: true },
      deep_reasoning: { provider: "p1", model: null, fallbackAllowed: true },
      balanced: { provider: "p1", model: null, fallbackAllowed: true },
      fast: { provider: "p1", model: null, fallbackAllowed: true },
    },
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.9,
    maxToolIterations: 20,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    parallelToolCalls: "off",
    cwd,
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
    hooks: parseHooksConfig(undefined),
    memory: {
      enabled: false,
      userLevelDir: join(cwd, "mem"),
      userWikiDir: join(cwd, "wiki"),
      journalDir: join(cwd, "journal"),
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false,
        mode: "off" as const,
        modelTier: "fast",
        maxOpsPerTurn: 2,
        maxPagesPerSession: 8,
        minConfidence: 0.65,
        minInferredConfidence: 0.75,
        journalRetentionDays: 7,
        flushTimeoutMs: 3000,
      },
      quiet: true,
    },
    mcpServers: [],
    ...over,
  } as unknown as Config;
}

function mcpCfg(cfg: Config): { toolSearch?: unknown; toolSearchThreshold?: unknown } {
  return ((cfg as unknown as { mcp?: { toolSearch?: unknown; toolSearchThreshold?: unknown } }).mcp ?? {});
}

function alwaysLoadOf(server: object | undefined): boolean | undefined {
  return (server as { alwaysLoad?: boolean } | undefined)?.alwaysLoad;
}

/** 注册一组假 MCP 工具（不拉子进程）。schema 故意偏大，便于区分「装入 / 未装入」。 */
function registerFakeMcp(
  server: string,
  tools: Array<{ name: string; description: string; marker?: string }>,
): string[] {
  const names: string[] = [];
  for (const t of tools) {
    const marker = t.marker ?? `schema-marker-${server}-${t.name}`;
    const impl = makeMcpTool({
      server,
      info: {
        name: t.name,
        description: t.description,
        inputSchema: {
          type: "object",
          properties: {
            payload: { type: "string", description: marker.repeat(8) },
          },
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

function serversFor(names: { big?: boolean; core?: boolean }): Config["mcpServers"] {
  const out: NonNullable<Config["mcpServers"]> = [];
  if (names.big !== false) {
    out.push({
      name: "big",
      transport: "stdio",
      command: "true",
      args: [],
      env: {},
      enabled: true,
    } as Config["mcpServers"] extends (infer T)[] | undefined ? T : never);
  }
  if (names.core) {
    out.push({
      name: "core",
      transport: "stdio",
      command: "true",
      args: [],
      env: {},
      enabled: true,
      alwaysLoad: true,
    } as Config["mcpServers"] extends (infer T)[] | undefined ? T : never);
  }
  return out;
}

function manyBig(n: number): Array<{ name: string; description: string }> {
  return Array.from({ length: n }, (_, i) => {
    const id = String(i).padStart(2, "0");
    return {
      name: `widget_${id}`,
      description: `Widget number ${id} helper for catalogs and search`,
    };
  });
}

function namesOf(specs: ToolSpec[]): string[] {
  return specs.map((s) => s.function.name);
}

function specOf(specs: ToolSpec[], name: string): ToolSpec | undefined {
  return specs.find((s) => s.function.name === name);
}

function schemaText(spec: ToolSpec | undefined): string {
  return JSON.stringify(spec?.function.parameters ?? {});
}

function hasFullSchema(spec: ToolSpec | undefined, marker: string): boolean {
  return schemaText(spec).includes(marker.repeat(8));
}

function makeAgent(cfg: Config, stream?: Agent["opt"] extends { chatStream?: infer S } ? S : never, hooks?: Config["hooks"]): Agent {
  return new Agent({
    cfg,
    console: silentIO(),
    mode: "auto-all",
    systemPrompt: "sys",
    hooks,
    chatStream: stream as never,
  });
}

function toolCtx(agent: Agent, approve = true, seen: Array<{ tool: string; detail: string }> = []): ToolCtx {
  return {
    cfg: agent.opt.cfg,
    approve: async (tool, detail) => {
      seen.push({ tool, detail });
      return approve;
    },
    host: agent,
  };
}

function tc(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function scripted(rounds: Array<{ calls?: ToolCall[]; content?: string }>, seenTools: ToolSpec[][]): NonNullable<ConstructorParameters<typeof Agent>[0]["chatStream"]> {
  let i = 0;
  return async (_cfg, _messages, tools) => {
    seenTools.push(tools ?? []);
    const step = rounds[Math.min(i, rounds.length - 1)] ?? { content: "done" };
    i++;
    if (step.calls && step.calls.length > 0) {
      return { content: "", reasoning: "", toolCalls: step.calls, finishReason: "tool_calls", usage: null, raw: null } as StreamResult;
    }
    return { content: step.content ?? "done", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null } as StreamResult;
  };
}

/** 系统提示里的 MCP 目录短节（不含「可用工具」那行名字清单）。 */
function mcpCatalogOf(text: string): string {
  const start = text.indexOf("## MCP 工具目录");
  if (start < 0) return "";
  const rest = text.slice(start);
  const cut = rest.indexOf("\n## ", 1);
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

/** 往历史里垫消息，直到 usage 落在 [minUsage, maxUsage]（相对 contextWindow）。 */
function padHistory(agent: Agent, minUsage: number, maxUsage = Number.POSITIVE_INFINITY): void {
  const window = agent.opt.cfg.contextWindow;
  const usage = (): number => estimateTokens(agent.messages, agent.toolSpecsFor()) / window;
  let i = 0;
  while (usage() < minUsage && i < 400) {
    const remain = Math.max(40, Math.floor((minUsage - usage()) * window * 2));
    const size = Math.min(1_200, remain);
    agent.messages.push({ role: i % 2 ? "assistant" : "user", content: `old ${i} ` + "x".repeat(size) });
    i++;
  }
  while (usage() > maxUsage && agent.messages.length > 2) {
    const last = agent.messages[agent.messages.length - 1]!;
    if (typeof last.content !== "string") break;
    if (last.content.length <= 8) {
      agent.messages.pop();
      continue;
    }
    last.content = last.content.slice(0, Math.max(8, Math.floor(last.content.length * 0.7)));
  }
}

function writeSettings(dir: string, extra: Record<string, unknown> = {}): void {
  const example = JSON.parse(readFileSync(join(import.meta.dir, "..", "settings.example.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...example, ...extra }), "utf8");
}

function cmdCtx(agent: Agent, ui: ReturnType<typeof captureConsole>["ui"], vis?: CommandContext["toolVisibility"]): CommandContext {
  return {
    agent,
    ui,
    cfg: agent.opt.cfg,
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "s1", model: "m", cwd: SANDBOX } as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
    mcp: () =>
      (agent.opt.cfg.mcpServers ?? []).map((s) => ({
        name: s.name,
        transport: s.transport,
        status: "connected" as const,
        tools: toolNames(agent.opt.cfg).filter((n) => n.startsWith(`mcp__${s.name}__`)),
        toolEntries: toolNames(agent.opt.cfg)
          .filter((n) => n.startsWith(`mcp__${s.name}__`))
          .map((n) => ({ name: n, remote: n.split("__").slice(2).join("__") })),
      })),
    toolVisibility: vis,
  };
}

/* ------------------------------------------------------------------ */
/* C 配置                                                              */
/* ------------------------------------------------------------------ */

describe("#68 C 配置解析", () => {
  test("#68 C1 默认 mcp.tool_search=auto、阈值为 10；不认 ENABLE_TOOL_SEARCH", () => {
    const dir = join(SANDBOX, `cfg-default-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeSettings(dir);
    const cfg = loadConfig({}, { settingsDir: dir });
    expect(mcpCfg(cfg).toolSearch).toBe("auto");
    expect(mcpCfg(cfg).toolSearchThreshold).toBe(10);
    const saved = process.env["ENABLE_TOOL_SEARCH"];
    process.env["ENABLE_TOOL_SEARCH"] = "false";
    try {
      const again = loadConfig({}, { settingsDir: dir });
      expect(mcpCfg(again).toolSearch).toBe("auto");
    } finally {
      if (saved === undefined) delete process.env["ENABLE_TOOL_SEARCH"];
      else process.env["ENABLE_TOOL_SEARCH"] = saved;
    }
  });

  test("#68 C2 settings 可强制 true / false，并可改阈值", () => {
    const dir = join(SANDBOX, `cfg-force-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeSettings(dir, { mcp: { tool_search: true, tool_search_threshold: 3 } });
    const on = loadConfig({}, { settingsDir: dir });
    expect(mcpCfg(on).toolSearch).toBe(true);
    expect(mcpCfg(on).toolSearchThreshold).toBe(3);
    writeSettings(dir, { mcp: { tool_search: false } });
    const off = loadConfig({}, { settingsDir: dir });
    expect(mcpCfg(off).toolSearch).toBe(false);
    expect(mcpCfg(off).toolSearchThreshold).toBe(10);
  });

  test("#68 C3 mcpServers.alwaysLoad 按 server 解析，缺省不是 true", () => {
    const { servers, warnings } = parseMcpServers({
      core: { command: "npx", args: ["-y", "x"], alwaysLoad: true },
      big: { command: "npx", args: ["-y", "y"] },
    });
    expect(warnings).toEqual([]);
    const core = servers.find((s) => s.name === "core");
    const big = servers.find((s) => s.name === "big");
    expect(alwaysLoadOf(core)).toBe(true);
    expect(alwaysLoadOf(big) === true).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* T 阈值与装入清单                                                      */
/* ------------------------------------------------------------------ */

describe("#68 T 阈值与可见清单", () => {
  test("#68 T1 auto 且可延迟数低于阈值：全量 schema，无 tool_search", () => {
    const mcpNames = registerFakeMcp("big", manyBig(9));
    const cfg = baseCfg({
      mcp: { toolSearch: "auto", toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    const specs = agent.toolSpecsFor();
    const ns = namesOf(specs);
    expect(ns).not.toContain("tool_search");
    for (const n of mcpNames) {
      expect(ns).toContain(n);
      expect(hasFullSchema(specOf(specs, n), `schema-marker-big-${n.replace("mcp__big__", "")}`)).toBe(true);
    }
  });

  test("#68 T2 auto 达到阈值：未加载 MCP 无完整 schema，清单含 tool_search 与第一方", () => {
    const mcpNames = registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: "auto", toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    const specs = agent.toolSpecsFor();
    const ns = namesOf(specs);
    expect(ns).toContain("tool_search");
    expect(ns).toContain("read_file");
    for (const n of mcpNames) {
      expect(hasFullSchema(specOf(specs, n), `schema-marker-big-${n.replace("mcp__big__", "")}`)).toBe(false);
    }
  });

  test("#68 T3 tool_search=true 即使只有少量 MCP 也延迟；false 即使很多也全量", () => {
    const few = registerFakeMcp("big", manyBig(2));
    const cfgOn = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const on = makeAgent(cfgOn).toolSpecsFor();
    expect(namesOf(on)).toContain("tool_search");
    for (const n of few) {
      expect(hasFullSchema(specOf(on, n), `schema-marker-big-${n.replace("mcp__big__", "")}`)).toBe(false);
    }
    for (const un of unregisters.splice(0)) un();
    const many = registerFakeMcp("big", manyBig(12));
    const cfgOff = baseCfg({
      mcp: { toolSearch: false, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const off = makeAgent(cfgOff).toolSpecsFor();
    expect(namesOf(off)).not.toContain("tool_search");
    for (const n of many) {
      expect(hasFullSchema(specOf(off, n), `schema-marker-big-${n.replace("mcp__big__", "")}`)).toBe(true);
    }
  });

  test("#68 T4 alwaysLoad server 的工具始终带完整 schema，且不计入可延迟数量", () => {
    registerFakeMcp("core", [
      { name: "ping", description: "Core ping always loaded" },
      { name: "status", description: "Core status always loaded" },
    ]);
    const deferred = registerFakeMcp("big", manyBig(9));
    const cfg = baseCfg({
      mcp: { toolSearch: "auto", toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true, core: true }),
    });
    // 可延迟 9 < 10，即使 core 有 2 个 alwaysLoad，也不该启用延迟。
    const specs = makeAgent(cfg).toolSpecsFor();
    expect(namesOf(specs)).not.toContain("tool_search");
    expect(hasFullSchema(specOf(specs, "mcp__core__ping"), "schema-marker-core-ping")).toBe(true);
    expect(hasFullSchema(specOf(specs, deferred[0]!), "schema-marker-big-widget_00")).toBe(true);
  });

  test("#68 T5 达到阈值时 alwaysLoad 仍在清单，延迟项不在", () => {
    registerFakeMcp("core", [{ name: "ping", description: "Core ping always loaded" }]);
    const deferred = registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: "auto", toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true, core: true }),
    });
    const specs = makeAgent(cfg).toolSpecsFor();
    expect(namesOf(specs)).toContain("tool_search");
    expect(hasFullSchema(specOf(specs, "mcp__core__ping"), "schema-marker-core-ping")).toBe(true);
    expect(hasFullSchema(specOf(specs, deferred[0]!), "schema-marker-big-widget_00")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* S 搜索工具                                                          */
/* ------------------------------------------------------------------ */

describe("#68 S tool_search", () => {
  test("#68 S1 按名字/描述大小写不敏感匹配，命中写入已加载集合，空查询与无命中不装入", async () => {
    registerFakeMcp("big", [
      ...manyBig(10),
      { name: "echo_text", description: "Echo TEXT payload for tests" },
      { name: "list_issues", description: "List GitHub issues in the current repo" },
    ]);
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    const ctx = toolCtx(agent);

    const empty = await dispatch("tool_search", JSON.stringify({ query: "" }), ctx);
    expect(empty.output).toMatch(/没有?命中|无命中|空/);
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__echo_text"), "schema-marker-big-echo_text")).toBe(false);

    const miss = await dispatch("tool_search", JSON.stringify({ query: "zzzz-no-such-tool" }), ctx);
    expect(miss.output).toMatch(/没有?命中|无命中|0 个/);
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__echo_text"), "schema-marker-big-echo_text")).toBe(false);

    const byName = await dispatch("tool_search", JSON.stringify({ query: "ECHO_TEXT" }), ctx);
    expect(byName.output).toContain("mcp__big__echo_text");
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__echo_text"), "schema-marker-big-echo_text")).toBe(true);

    const byDesc = await dispatch("tool_search", JSON.stringify({ query: "github" }), ctx);
    expect(byDesc.output).toContain("mcp__big__list_issues");
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__list_issues"), "schema-marker-big-list_issues")).toBe(true);
  });

  test("#68 S2 默认最多装入 5 个，limit 上限 10，不设累计上限", async () => {
    registerFakeMcp("big", manyBig(16));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    const ctx = toolCtx(agent);
    const first = await dispatch("tool_search", JSON.stringify({ query: "widget" }), ctx);
    const loadedAfterFirst = namesOf(agent.toolSpecsFor()).filter((n) => n.startsWith("mcp__big__"));
    expect(loadedAfterFirst).toHaveLength(5);
    expect(first.output).toContain("mcp__big__widget_00");

    const capped = await dispatch("tool_search", JSON.stringify({ query: "widget", limit: 99 }), ctx);
    expect(capped.output.split("mcp__big__").length - 1).toBeLessThanOrEqual(10);
    // 累计可继续装入（无总上限）：再搜尚未装入的编号。
    const before = namesOf(agent.toolSpecsFor()).filter((n) => n.startsWith("mcp__big__")).length;
    await dispatch("tool_search", JSON.stringify({ query: "widget_15" }), ctx);
    const after = namesOf(agent.toolSpecsFor()).filter((n) => n.startsWith("mcp__big__")).length;
    expect(after).toBeGreaterThan(before);
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_15"), "schema-marker-big-widget_15")).toBe(true);
  });

  test("#68 S3 同一 agent loop 搜索命中后，下一次模型请求即可调用", async () => {
    registerFakeMcp("big", [...manyBig(10), { name: "echo_text", description: "Echo TEXT payload for tests" }]);
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const seenTools: ToolSpec[][] = [];
    const agent = makeAgent(
      cfg,
      scripted(
        [
          { calls: [tc("c1", "tool_search", { query: "echo_text" })] },
          { calls: [tc("c2", "mcp__big__echo_text", { payload: "hi" })] },
          { content: "done" },
        ],
        seenTools,
      ),
    );
    await agent.send("go");
    expect(namesOf(seenTools[0] ?? [])).toContain("tool_search");
    expect(hasFullSchema(specOf(seenTools[0] ?? [], "mcp__big__echo_text"), "schema-marker-big-echo_text")).toBe(false);
    expect(hasFullSchema(specOf(seenTools[1] ?? [], "mcp__big__echo_text"), "schema-marker-big-echo_text")).toBe(true);
    const toolMsg = agent.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(toolMsg.some((t) => t.includes("called:big/echo_text:hi"))).toBe(true);
  });

  test("#68 S4 目录短节含注册名与约 80 字截断描述，不含完整 schema", () => {
    const long = "L".repeat(200);
    registerFakeMcp("big", [
      ...manyBig(10),
      { name: "echo_text", description: long },
    ]);
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    const text = `${buildSystemPrompt(cfg)}\n${String(agent.messages[0]?.content ?? "")}`;
    expect(text).toContain("mcp__big__echo_text");
    expect(text).toContain("L".repeat(80));
    expect(text).not.toContain("L".repeat(120));
    expect(text).not.toContain("schema-marker-big-echo_text".repeat(8));
  });

  test("#68 S5 目录短节按当前会话已加载集合，已装入的工具不再写成尚未装入", async () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const beforeCat = mcpCatalogOf(buildSystemPrompt(cfg));
    expect(beforeCat).toContain("- mcp__big__widget_00：");
    expect(beforeCat).toContain("- mcp__big__widget_01：");
    expect(beforeCat).toMatch(/尚未装入上下文/);
    expect(beforeCat).not.toContain("schema-marker-big-widget_00".repeat(8));

    const agent = makeAgent(cfg);
    await dispatch("tool_search", JSON.stringify({ query: "widget_00" }), toolCtx(agent));
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(true);
    const after = buildSystemPrompt(cfg, { mcpLoaded: new Set(agent.mcpLoadedNames()) });
    const afterCat = mcpCatalogOf(after);
    expect(afterCat.length).toBeGreaterThan(0);
    expect(afterCat).not.toContain("- mcp__big__widget_00：");
    expect(afterCat).toContain("- mcp__big__widget_01：");
    expect(afterCat).toMatch(/尚未装入上下文/);
    expect(after).not.toContain("schema-marker-big-widget_00".repeat(8));
    expect(after).not.toContain("schema-marker-big-widget_01".repeat(8));
    // 未传已加载集合时仍按空集合（与 S4 / 新会话一致），不得悄悄用别的会话状态。
    expect(mcpCatalogOf(buildSystemPrompt(cfg))).toContain("- mcp__big__widget_00：");
  });
});

/* ------------------------------------------------------------------ */
/* D 直接点名                                                          */
/* ------------------------------------------------------------------ */

describe("#68 D 直接点名未装入的已注册工具", () => {
  test("#68 D1 直接点名：走审批并执行，同时加入已加载集合；拒绝也仍要先问", async () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const deniedSeen: Array<{ tool: string; detail: string }> = [];
    const agent = makeAgent(cfg);
    const denied = await dispatch("mcp__big__widget_03", JSON.stringify({ payload: "nope" }), toolCtx(agent, false, deniedSeen));
    expect(deniedSeen.some((s) => s.tool === "mcp__big__widget_03")).toBe(true);
    expect(String(denied.output)).toMatch(/拒绝|未执行|cancel/i);

    const seen: Array<{ tool: string; detail: string }> = [];
    const ok = await dispatch("mcp__big__widget_03", JSON.stringify({ payload: "yes" }), toolCtx(agent, true, seen));
    expect(seen.some((s) => s.tool === "mcp__big__widget_03")).toBe(true);
    expect(ok.output).toContain("called:big/widget_03:yes");
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_03"), "schema-marker-big-widget_03")).toBe(true);
  });

  test("#68 D2 同批并行 search + 直接点名：点名可执行且两者都进入已加载集合", async () => {
    registerFakeMcp("big", [...manyBig(10), { name: "echo_text", description: "Echo TEXT payload for tests" }]);
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const seenTools: ToolSpec[][] = [];
    const agent = makeAgent(
      cfg,
      scripted(
        [
          {
            calls: [
              tc("c1", "tool_search", { query: "echo_text" }),
              tc("c2", "mcp__big__widget_07", { payload: "p" }),
            ],
          },
          { content: "done" },
        ],
        seenTools,
      ),
    );
    await agent.send("go");
    const results = agent.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(results.some((t) => t.includes("未知工具"))).toBe(false);
    expect(results.some((t) => t.includes("mcp__big__echo_text") || t.includes("echo_text"))).toBe(true);
    expect(results.some((t) => t.includes("called:big/widget_07:p"))).toBe(true);
    const after = agent.toolSpecsFor();
    expect(hasFullSchema(specOf(after, "mcp__big__echo_text"), "schema-marker-big-echo_text")).toBe(true);
    expect(hasFullSchema(specOf(after, "mcp__big__widget_07"), "schema-marker-big-widget_07")).toBe(true);
    expect(hasFullSchema(specOf(after, "mcp__big__widget_09"), "schema-marker-big-widget_09")).toBe(false);
  });

  test("#68 D3 未注册/编造的名字明确失败，不得被当成延迟工具", async () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    const r = await dispatch("mcp__big__does_not_exist", JSON.stringify({ payload: "x" }), toolCtx(agent));
    expect(r.output).toMatch(/未知工具/);
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__does_not_exist"), "schema-marker")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* L 已加载集合生命周期                                                  */
/* ------------------------------------------------------------------ */

describe("#68 L 已加载集合生命周期", () => {
  test("#68 L1 成功压缩后丢掉非 alwaysLoad 的已加载项", async () => {
    registerFakeMcp("core", [{ name: "ping", description: "Core ping always loaded" }]);
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true, core: true }),
    });
    const agent = makeAgent(cfg, async () => ({
      content: "摘要：一段足够长的压缩结果。".repeat(3),
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
    }) as StreamResult);
    await dispatch("tool_search", JSON.stringify({ query: "widget_00" }), toolCtx(agent));
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(true);
    for (let i = 0; i < 16; i++) {
      agent.messages.push({ role: i % 2 ? "assistant" : "user", content: `old ${i} ` + "history ".repeat(30) });
    }
    const ok = await agent.compact();
    expect(ok).toBe(true);
    const specs = agent.toolSpecsFor();
    expect(hasFullSchema(specOf(specs, "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(false);
    expect(hasFullSchema(specOf(specs, "mcp__core__ping"), "schema-marker-core-ping")).toBe(true);
    expect(namesOf(specs)).toContain("tool_search");
  });

  test("#68 L2 PreCompact 阻断（exit2）不得清已加载集合", async () => {
    registerFakeMcp("big", manyBig(10));
    const hookPath = join(SANDBOX, "precompact-block.sh");
    writeFileSync(hookPath, "#!/bin/sh\ncat >/dev/null\nprintf 'keep loaded'\nexit 2\n", { mode: 0o755 });
    const hooks = parseHooksConfig({ enabled: true, PreCompact: [{ command: hookPath }] });
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg, async () => ({
      content: "不应发出去",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
    }) as StreamResult, hooks);
    await dispatch("tool_search", JSON.stringify({ query: "widget_01" }), toolCtx(agent));
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_01"), "schema-marker-big-widget_01")).toBe(true);
    const before = JSON.stringify(agent.messages);
    const ok = await agent.compact();
    expect(ok).toBe(false);
    expect(JSON.stringify(agent.messages)).toBe(before);
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_01"), "schema-marker-big-widget_01")).toBe(true);
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_09"), "schema-marker-big-widget_09")).toBe(false);
  });

  test("#68 L3 /clear（reset）丢掉已加载项，只留 alwaysLoad", async () => {
    registerFakeMcp("core", [{ name: "ping", description: "Core ping always loaded" }]);
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true, core: true }),
    });
    const agent = makeAgent(cfg);
    await dispatch("tool_search", JSON.stringify({ query: "widget_02" }), toolCtx(agent));
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_02"), "schema-marker-big-widget_02")).toBe(true);
    agent.reset();
    const specs = agent.toolSpecsFor();
    expect(hasFullSchema(specOf(specs, "mcp__big__widget_02"), "schema-marker-big-widget_02")).toBe(false);
    expect(hasFullSchema(specOf(specs, "mcp__core__ping"), "schema-marker-core-ping")).toBe(true);
  });

  test("#68 L4 新会话/resume 不持久化已加载集合，只留 alwaysLoad；两会话互不共享", async () => {
    registerFakeMcp("core", [{ name: "ping", description: "Core ping always loaded" }]);
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true, core: true }),
    });
    const a = makeAgent(cfg);
    await dispatch("tool_search", JSON.stringify({ query: "widget_04" }), toolCtx(a));
    expect(hasFullSchema(specOf(a.toolSpecsFor(), "mcp__big__widget_04"), "schema-marker-big-widget_04")).toBe(true);
    const b = makeAgent(cfg);
    const specs = b.toolSpecsFor();
    expect(hasFullSchema(specOf(specs, "mcp__big__widget_04"), "schema-marker-big-widget_04")).toBe(false);
    expect(hasFullSchema(specOf(specs, "mcp__core__ping"), "schema-marker-core-ping")).toBe(true);
    await dispatch("tool_search", JSON.stringify({ query: "widget_05" }), toolCtx(b));
    expect(hasFullSchema(specOf(a.toolSpecsFor(), "mcp__big__widget_05"), "schema-marker-big-widget_05")).toBe(false);
  });

  test("#68 L5 自动压缩成功后，当轮实际请求不再含非 alwaysLoad schema", async () => {
    registerFakeMcp("core", [{ name: "ping", description: "Core ping always loaded" }]);
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true, core: true }),
      compactThreshold: 0.3,
      contextWindow: 8_000,
      maxTokens: 100,
    });
    const mainTools: ToolSpec[][] = [];
    let compactCalls = 0;
    const agent = new Agent({
      cfg,
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      // 压缩器走 chatStream；主流走 mainChatStream，互不混用，才能断言「当轮实际请求」。
      chatStream: async () => {
        compactCalls++;
        return {
          content: "摘要：一段足够长的压缩结果。".repeat(3),
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
          raw: null,
        } as StreamResult;
      },
      mainChatStream: async (_cfg, _messages, tools) => {
        mainTools.push(tools ?? []);
        return {
          content: "ok after auto compact",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
          raw: null,
        } as StreamResult;
      },
    });
    await dispatch("tool_search", JSON.stringify({ query: "widget_00" }), toolCtx(agent));
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(true);
    padHistory(agent, 0.35);
    expect(agent.messages.length).toBeGreaterThan(6);
    const stats = await agent.send("new question after threshold compact");
    expect(stats.hadError).toBe(false);
    expect(compactCalls).toBeGreaterThan(0);
    expect(mainTools.length).toBeGreaterThan(0);
    const sent = mainTools[0]!;
    expect(hasFullSchema(specOf(sent, "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(false);
    expect(namesOf(sent).some((n) => n.startsWith("mcp__big__"))).toBe(false);
    expect(hasFullSchema(specOf(sent, "mcp__core__ping"), "schema-marker-core-ping")).toBe(true);
    expect(namesOf(sent)).toContain("tool_search");
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(false);
  });

  test("#68 L6 近窗压缩成功后，当轮实际请求不再含非 alwaysLoad schema", async () => {
    registerFakeMcp("core", [{ name: "ping", description: "Core ping always loaded" }]);
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true, core: true }),
      // 阈值路径不触发，只走「tokens + maxTokens > 0.98 * window」。
      compactThreshold: 0.999,
      contextWindow: 8_000,
      maxTokens: 1_000,
    });
    const mainTools: ToolSpec[][] = [];
    let compactCalls = 0;
    const agent = new Agent({
      cfg,
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "sys",
      chatStream: async () => {
        compactCalls++;
        return {
          content: "摘要：一段足够长的压缩结果。".repeat(3),
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
          raw: null,
        } as StreamResult;
      },
      mainChatStream: async (_cfg, _messages, tools) => {
        mainTools.push(tools ?? []);
        return {
          content: "ok after near-window compact",
          reasoning: "",
          toolCalls: [],
          finishReason: "stop",
          usage: null,
          raw: null,
        } as StreamResult;
      },
    });
    await dispatch("tool_search", JSON.stringify({ query: "widget_00" }), toolCtx(agent));
    expect(hasFullSchema(specOf(agent.toolSpecsFor(), "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(true);
    // tokens ∈ (0.98*window - maxTokens, compactThreshold*window] = (6840, 7992]
    padHistory(agent, (0.98 * 8_000 - 1_000) / 8_000 + 0.002, 0.999);
    const usage = estimateTokens(agent.messages, agent.toolSpecsFor()) / cfg.contextWindow;
    expect(usage).toBeLessThanOrEqual(cfg.compactThreshold);
    expect(estimateTokens(agent.messages, agent.toolSpecsFor()) + cfg.maxTokens).toBeGreaterThan(cfg.contextWindow * 0.98);
    expect(agent.messages.length).toBeGreaterThan(6);
    const stats = await agent.send("new question after near-window compact");
    expect(stats.hadError).toBe(false);
    expect(compactCalls).toBeGreaterThan(0);
    expect(mainTools.length).toBeGreaterThan(0);
    const sent = mainTools[0]!;
    expect(hasFullSchema(specOf(sent, "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(false);
    expect(namesOf(sent).some((n) => n.startsWith("mcp__big__"))).toBe(false);
    expect(hasFullSchema(specOf(sent, "mcp__core__ping"), "schema-marker-core-ping")).toBe(true);
    expect(namesOf(sent)).toContain("tool_search");
  });
});

/* ------------------------------------------------------------------ */
/* E 入口与子代理                                                       */
/* ------------------------------------------------------------------ */

describe("#68 E 入口覆盖", () => {
  test("#68 E1 子代理拷贝父会话已加载集合并自带 tool_search，不写回，不塞全部 schema", async () => {
    registerFakeMcp("big", manyBig(12));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const parent = makeAgent(cfg);
    await dispatch("tool_search", JSON.stringify({ query: "widget_00" }), toolCtx(parent));
    const seenTools: ToolSpec[][] = [];
    parent.opt.chatStream = scripted([{ content: "sub done" }], seenTools);
    const report = await runSubagent(parent, "只读一下子代理工具清单", undefined, toolCtx(parent));
    expect(report.length).toBeGreaterThan(0);
    expect(seenTools.length).toBeGreaterThan(0);
    const childSpecs = seenTools[0] ?? [];
    expect(namesOf(childSpecs)).toContain("tool_search");
    expect(hasFullSchema(specOf(childSpecs, "mcp__big__widget_00"), "schema-marker-big-widget_00")).toBe(true);
    expect(hasFullSchema(specOf(childSpecs, "mcp__big__widget_11"), "schema-marker-big-widget_11")).toBe(false);

    // 子代理再搜索不应写回父会话。
    const childOnly = makeAgent(cfg, scripted([{ calls: [tc("s", "tool_search", { query: "widget_11" })] }, { content: "ok" }], []), undefined);
    // 用独立 agent 无法证明 runSubagent 隔离；再跑一个会搜索的子代理并检查父清单。
    const moreTools: ToolSpec[][] = [];
    parent.opt.chatStream = scripted(
      [{ calls: [tc("s", "tool_search", { query: "widget_11" })] }, { content: "ok" }],
      moreTools,
    );
    await runSubagent(parent, "搜索 widget_11", undefined, toolCtx(parent));
    expect(hasFullSchema(specOf(parent.toolSpecsFor(), "mcp__big__widget_11"), "schema-marker-big-widget_11")).toBe(false);
    expect(childOnly).toBeDefined();
  });

  test("#68 E2 规划态不暴露 MCP 与 tool_search", () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    agent.enterPlan();
    const ns = namesOf(agent.toolSpecsFor());
    expect(ns).not.toContain("tool_search");
    expect(ns.some((n) => n.startsWith("mcp__"))).toBe(false);
  });

  test("#68 E3 wiki worker 白名单不扩权（不含 tool_search / mcp__）", () => {
    expect(WIKI_WORKER_TOOLS).not.toContain("tool_search");
    expect(WIKI_WORKER_TOOLS.some((n) => n.startsWith("mcp__"))).toBe(false);
    expect(WIKI_WORKER_TOOLS).toEqual([
      "wiki_search",
      "wiki_write",
      "read_file",
      "list_dir",
      "glob",
      "grep",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* U /tools /context /mcp 与用量口径                                      */
/* ------------------------------------------------------------------ */

describe("#68 U 命令与用量口径", () => {
  test("#68 U1 /mcp 仍列出全部；/tools 与 /context 区分已装入和仅目录", async () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    await dispatch("tool_search", JSON.stringify({ query: "widget_00" }), toolCtx(agent));
    wireCommands();
    const mcpCap = captureConsole();
    await dispatchCommand("/mcp", cmdCtx(agent, mcpCap.ui));
    const mcpOut = mcpCap.out();
    expect(mcpOut).toContain("mcp__big__widget_00");
    expect(mcpOut).toContain("mcp__big__widget_09");

    const toolsCap = captureConsole();
    await dispatchCommand("/tools", cmdCtx(agent, toolsCap.ui));
    const toolsOut = toolsCap.out();
    expect(toolsOut).toMatch(/已装入|装入上下文/);
    expect(toolsOut).toMatch(/仅目录|仅在目录|未装入/);
    expect(toolsOut).toContain("mcp__big__widget_00");
    expect(toolsOut).toContain("mcp__big__widget_09");

    const ctxCap = captureConsole();
    await dispatchCommand(
      "/context",
      cmdCtx(agent, ctxCap.ui, () => ({
        names: namesOf(agent.toolSpecsFor()),
        hidden: [],
        total: toolNames(cfg).length,
        trimmed: false,
        fits: true,
        cost: 1,
        budget: 1000,
      })),
    );
    const ctxOut = ctxCap.out();
    expect(ctxOut).toMatch(/已装入|仅目录|目录/);
    expect(ctxOut).toMatch(/dry-run 未启用/);
  });

  test("#68 U2 #20 dry-run 按实际发送的 specs 计量，不把未装入 MCP schema 算进去", () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
      contextWindow: 200_000,
    });
    const pm = new PromptManager({ mailbox: false, askUser: false, sessionName: "t" });
    const vis = pm.currentVisibility(cfg);
    const candidates = [...vis.names, ...vis.hidden];
    // 未装入的延迟 MCP 不得进入 #20 候选集（否则 dry-run 仍按全量 schema 计量）。
    expect(candidates.some((n) => n.startsWith("mcp__big__"))).toBe(false);
    expect(candidates).toContain("read_file");
    expect(toolSpecs(cfg).some((s) => s.function.name.startsWith("mcp__big__"))).toBe(true);
  });

  test("#68 U3 contextUsage 与压缩估计使用 toolSpecsFor()，与请求同口径", () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const agent = makeAgent(cfg);
    agent.messages.push({ role: "user", content: "hello usage" });
    const expected = estimateTokens(agent.messages, agent.toolSpecsFor()) / cfg.contextWindow;
    const inflated = estimateTokens(agent.messages, toolSpecs(cfg)) / cfg.contextWindow;
    expect(inflated).toBeGreaterThan(expected);
    expect(agent.contextUsage()).toBeCloseTo(expected, 10);
  });

  test("#68 U4 PromptManager 选档按实际将发送的 specs 计开销，不把未装入 MCP schema 算进去", async () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const pm = new PromptManager({ mailbox: false, askUser: false, sessionName: "t" });
    const fresh = makeAgent(cfg);
    const sentSpecs = fresh.toolSpecsFor();
    const fullSpecs = toolSpecs(cfg);
    expect(sentSpecs.some((s) => s.function.name.startsWith("mcp__big__"))).toBe(false);
    expect(fullSpecs.some((s) => s.function.name.startsWith("mcp__big__"))).toBe(true);

    const rendered = pm.render(cfg);
    // issue #104：fits=false 时估计开销按收窄后的 schema 计，正文也是收窄后的。
    // fits=true 时 runtimeToolNames 为 null，仍按实际将发送的全量候选计。
    const runtimeNames = pm.runtimeToolNames(cfg);
    const accounted = runtimeNames
      ? sentSpecs.filter((s) => runtimeNames.includes(s.function.name))
      : sentSpecs;
    const withSent = countSystemTokens([rendered.text], accounted).tokens;
    const withFull = countSystemTokens([rendered.text], fullSpecs).tokens;
    expect(withFull).toBeGreaterThan(withSent);
    expect(rendered.selection.estimatedSystemTokens).toBe(withSent);

    // #20 dry-run 仍按新会话第一轮发送集，不因本测试随后装入而把 MCP schema 算进候选。
    const vis = pm.currentVisibility(cfg);
    const candidates = [...vis.names, ...vis.hidden];
    expect(candidates.some((n) => n.startsWith("mcp__big__"))).toBe(false);
    expect(candidates).toContain("read_file");

    const agent = makeAgent(cfg);
    await dispatch("tool_search", JSON.stringify({ query: "widget_00" }), toolCtx(agent));
    const loadedRendered = pm.render(cfg, { mcpLoaded: agent.mcpLoadedNames() });
    const loadedNames = pm.runtimeToolNames(cfg, { mcpLoaded: agent.mcpLoadedNames() });
    const loadedBase = agent.toolSpecsFor();
    const loadedAccounted = loadedNames
      ? loadedBase.filter((s) => loadedNames.includes(s.function.name))
      : loadedBase;
    const withLoaded = countSystemTokens([loadedRendered.text], loadedAccounted).tokens;
    expect(loadedRendered.selection.estimatedSystemTokens).toBe(withLoaded);
    // 装入的 schema 若仍放得进可见集，开销上升；放不进则请求里没有它（issue #104）。
    const loadedTool = agent.mcpLoadedNames()[0];
    const sentLoaded = loadedNames === null || (loadedTool !== undefined && loadedNames.includes(loadedTool));
    if (sentLoaded) expect(withLoaded).toBeGreaterThan(withSent);
    else expect(loadedNames).not.toContain(loadedTool);
    // 再问一次不带已加载集合的 render / currentVisibility，仍是第一轮口径（不要搞坏 U2）。
    const again = pm.render(cfg);
    expect(again.selection.estimatedSystemTokens).toBe(withSent);
    const vis2 = pm.currentVisibility(cfg);
    expect([...vis2.names, ...vis2.hidden].some((n) => n.startsWith("mcp__big__"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* P 协议：普通工具，非厂商 API                                           */
/* ------------------------------------------------------------------ */

describe("#68 P 协议形态", () => {
  test("#68 P1 tool_search 在 OpenAI 兼容与 Anthropic 路径都是普通 function / input_schema 工具", async () => {
    registerFakeMcp("big", manyBig(10));
    const cfg = baseCfg({
      mcp: { toolSearch: true, toolSearchThreshold: 10 },
      mcpServers: serversFor({ big: true }),
    });
    const seenTools: ToolSpec[][] = [];
    const agent = makeAgent(cfg, scripted([{ content: "ok" }], seenTools));
    await agent.send("ping");
    const tools = seenTools[0] ?? [];
    const ts = specOf(tools, "tool_search");
    expect(ts).toBeDefined();
    expect(ts?.type).toBe("function");
    expect(ts?.function.name).toBe("tool_search");
    const anth = toAnthropicTools([ts!]);
    expect(anth).toHaveLength(1);
    expect(anth[0]?.["name"]).toBe("tool_search");
    expect(anth[0]?.["input_schema"]).toEqual(ts!.function.parameters);
    expect(Object.keys(anth[0] ?? {})).not.toContain("type");
    const body = buildAnthropicBody(
      { model: "m", maxTokens: 100, temperature: 0, parallel: false },
      [{ role: "user", content: "x" }],
      [ts!],
      false,
    );
    const encoded = body["tools"] as Array<Record<string, unknown>>;
    expect(encoded[0]?.["name"]).toBe("tool_search");
    expect(JSON.stringify(body)).not.toMatch(/tool_search_tool|deferred_tools|deferred_tool/);
    const srcLlm = readFileSync(join(import.meta.dir, "../src/llm.ts"), "utf8");
    const srcAnth = readFileSync(join(import.meta.dir, "../src/anthropicWire.ts"), "utf8");
    expect(srcLlm).not.toMatch(/ENABLE_TOOL_SEARCH|tool_search_tool_20|deferred_tools/);
    expect(srcAnth).not.toMatch(/ENABLE_TOOL_SEARCH|tool_search_tool_20|deferred_tools/);
    expect(agent.opt.cfg.providerType).toBe("openai");
  });
});
