/**
 * mcp.test.ts — MCP 客户端接入（issue #2）。
 *
 * 覆盖 issue 的四条验收：
 *  1. 配置 stdio server 后模型可见并调用 MCP 工具（tools/list → 注册 → tools/call）；
 *  2. MCP 工具走与内置写/执行工具同一审批路径（approve / decidePermission）；
 *  3. 命名规范 mcp__<server>__<tool>，inputSchema 原样透传；
 *  4. 连接失败 / 坏命令给可读错误且不拖垮主循环（其余 server 照常）。
 *
 * 全部用仓库内的假 stdio server（tests/fixtures/mcp-server.ts）：无网络、无外部依赖。
 * 注意 bun test 单进程共享模块表：每个用例结束必须 closeAll() 注销工具，
 * 否则 mcp__* 会残留到其它测试文件（registerTool 重名会抛错）。
 *
 * 运行：bun test tests/mcp.test.ts
 */
import { describe, expect, test, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMcpServers, type McpStdioServerConfig } from "../src/config.ts";
import { McpManager, formatCallResult } from "../src/mcp/client.ts";
import { StdioRpc } from "../src/mcp/jsonrpc.ts";
import { makeMcpTool, mcpToolName, parseMcpToolName, isMcpTool } from "../src/mcp/tool.ts";
import { dispatch, toolNames } from "../src/tools/index.ts";
import { decidePermission } from "../src/agent/policy.ts";
import { PLAN_VISIBLE_TOOLS, filterPlanTools } from "../src/agent/plan-mode.ts";
import { dispatchCommand, wireCommands } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commands.ts";
import type { Config } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import type { McpServerState } from "../src/mcp/client.ts";
import { captureConsole } from "./helpers.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-mcp-test-"));
const FIXTURE = join(import.meta.dir, "fixtures", "mcp-server.ts");

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

/** 假 server 的启动配置。args 里带 mode，用来驱动不同失败路径。 */
function server(name: string, mode = "ok", over: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    name,
    transport: "stdio",
    command: process.execPath, // bun 本体：测试环境一定有，且不依赖 PATH
    args: [FIXTURE, `--mode=${mode}`, `--name=${name}`],
    env: {},
    enabled: true,
    ...over,
  };
}

/** 每个用例自己持有的 manager，afterEach 统一收掉（避免工具残留 + 子进程泄漏）。 */
let managers: McpManager[] = [];
function track(m: McpManager): McpManager {
  managers.push(m);
  return m;
}
afterEach(() => {
  for (const m of managers) {
    try {
      m.closeAll();
    } catch {
      /* 已关闭 */
    }
  }
  managers = [];
});

/** 最小 ToolCtx：审批结果由测试决定，其余字段够工具跑就行。 */
function makeCtx(approve: boolean, seen: Array<{ tool: string; detail: string }> = []): ToolCtx {
  return {
    cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as unknown as Config,
    approve: async (tool, detail) => {
      seen.push({ tool, detail });
      return approve;
    },
  };
}

function makeCmdCtx(ui: ReturnType<typeof captureConsole>["ui"], states: McpServerState[]): CommandContext {
  return {
    agent: {} as CommandContext["agent"],
    ui,
    cfg: { cwd: SANDBOX } as Config,
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "s1", model: "m", cwd: SANDBOX } as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
    mcp: () => states,
  };
}

/* ------------------------------------------------------------------ */
/* a. 配置解析                                                         */
/* ------------------------------------------------------------------ */

describe("a. mcpServers 配置解析", () => {
  test("对象形态（Claude Desktop 风格）键即 server 名", () => {
    const { servers, warnings } = parseMcpServers({
      fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    });
    expect(warnings).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("fs");
    expect(servers[0]?.transport).toBe("stdio");
    const first = servers[0] as { command?: string; args?: string[] };
    expect(first.command).toBe("npx");
    expect(first.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(servers[0]?.enabled).toBe(true); // 缺省启用
  });

  test("数组形态 + env/cwd/enabled 全部保留", () => {
    const { servers } = parseMcpServers([
      { name: "gh", command: "node", args: ["s.js"], env: { TOKEN: "t" }, cwd: "/tmp", enabled: false },
    ]);
    expect(servers[0]).toMatchObject({
      name: "gh",
      transport: "stdio",
      command: "node",
      env: { TOKEN: "t" },
      cwd: "/tmp",
      enabled: false,
    });
  });

  test("单条写错只丢这一条，并给出可读 warning（不让整个 CLI 起不来）", () => {
    const { servers, warnings } = parseMcpServers({
      good: { command: "npx" },
      noCommand: { args: ["x"] },
      "bad.name": { command: "npx" },
      http: { command: "x", transport: "http" },
    });
    expect(servers.map((s) => s.name)).toEqual(["good"]);
    expect(warnings.join("\n")).toContain("noCommand 缺少 command");
    expect(warnings.join("\n")).toContain("bad.name 名字非法");
    expect(warnings.join("\n")).toContain("transport=\"http\" 缺少 url");
  });

  test("issue #29：http 传输解析 url / headers / enabled，兼容 type 别名", () => {
    const { servers, warnings } = parseMcpServers({
      gh: {
        type: "http",
        url: "https://api.example.com/mcp/",
        headers: { Authorization: "Bearer t", "X-Env": "dev" },
      },
      off: { transport: "http", url: "https://x.example.com/mcp", enabled: false },
    });
    expect(warnings).toEqual([]);
    expect(servers.map((s) => s.transport)).toEqual(["http", "http"]);
    expect(servers[0]).toMatchObject({
      name: "gh",
      url: "https://api.example.com/mcp/",
      headers: { Authorization: "Bearer t", "X-Env": "dev" },
      enabled: true,
    });
    expect(servers[1]?.enabled).toBe(false);
  });

  test("issue #29：http 缺 url / 非 http(s) → 各自 warning 并跳过", () => {
    const { servers, warnings } = parseMcpServers({
      noUrl: { transport: "http" },
      badUrl: { transport: "http", url: "ftp://x" },
    });
    expect(servers).toEqual([]);
    const text = warnings.join("\n");
    expect(text).toContain("noUrl 的 transport=\"http\" 缺少 url");
    expect(text).toContain("必须是 http(s) 绝对地址");
  });

  test("issue #44：sse 传输能解析（不再 warning 跳过）", () => {
    const { servers, warnings } = parseMcpServers({
      legacy: { transport: "sse", url: "https://x.example.com/sse" },
    });
    expect(warnings).toEqual([]);
    expect(servers.map((s) => s.transport)).toEqual(["sse"]);
  });

  test("重名只保留第一条；非对象/非数组整段忽略并 warning", () => {
    const dup = parseMcpServers([
      { name: "a", command: "x" },
      { name: "a", command: "y" },
    ]);
    expect(dup.servers).toHaveLength(1);
    expect((dup.servers[0] as { command?: string })?.command).toBe("x");
    expect(dup.warnings.join("")).toContain("重名");

    const bad = parseMcpServers("nope");
    expect(bad.servers).toEqual([]);
    expect(bad.warnings.join("")).toContain("必须是对象或数组");
  });
});

/* ------------------------------------------------------------------ */
/* b. 命名规范                                                         */
/* ------------------------------------------------------------------ */

describe("b. 工具命名 mcp__<server>__<tool>", () => {
  test("拼名与反解互逆", () => {
    const n = mcpToolName("fs", "read_file");
    expect(n).toBe("mcp__fs__read_file");
    expect(parseMcpToolName(n)).toEqual({ server: "fs", tool: "read_file" });
    expect(isMcpTool(n)).toBe(true);
  });

  test("工具名里带下划线/点也能正确反解（只按第一个 __ 切）", () => {
    expect(parseMcpToolName("mcp__gh__create_issue")).toEqual({ server: "gh", tool: "create_issue" });
    expect(parseMcpToolName("mcp__fs__a.b")).toEqual({ server: "fs", tool: "a.b" });
  });

  test("非 MCP 工具与残缺名返回 null", () => {
    for (const n of ["read_file", "mcp__", "mcp__fs", "mcp__fs__", "mcp____x"]) {
      expect(parseMcpToolName(n)).toBeNull();
      expect(isMcpTool(n)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* c. 连接 + 列出 + 调用（验收 1）                                     */
/* ------------------------------------------------------------------ */

describe("c. 连接、列出工具、调用工具", () => {
  test("connectAll 注册 mcp__* 工具，inputSchema 原样透传", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    const n = await m.connectAll();
    expect(n).toBe(4); // echo / fail / add / empty

    const names = toolNames();
    expect(names).toContain("mcp__fake__echo");
    expect(names).toContain("mcp__fake__add");

    const st = m.statuses()[0];
    expect(st?.status).toBe("connected");
    expect(st?.serverInfo?.name).toBe("fake");
    expect(st?.tools).toHaveLength(4);

    // schema 透传：模型必须看到远端真实的参数定义
    const impl = (await import("../src/tools/index.ts")).TOOLS.find(
      (t) => t.spec.function.name === "mcp__fake__add",
    );
    const params = impl?.spec.function.parameters as Record<string, unknown>;
    expect(params["type"]).toBe("object");
    expect((params["properties"] as Record<string, unknown>)["a"]).toEqual({ type: "number" });
    expect(params["required"]).toEqual(["a", "b"]);
    // 描述带 server 前缀，模型能看出这是外部工具
    expect(impl?.spec.function.description).toContain("[MCP:fake]");
  });

  test("经 dispatch 调用：参数透传、结果转文本", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();

    const r = await dispatch("mcp__fake__echo", JSON.stringify({ text: "你好" }), makeCtx(true));
    expect(r.ok).toBe(true);
    expect(r.output).toBe("echo:你好");

    const sum = await dispatch("mcp__fake__add", JSON.stringify({ a: 2, b: 40 }), makeCtx(true));
    expect(sum.ok).toBe(true);
    expect(sum.output).toBe("42");
  });

  test("isError=true 转成可读工具错误（不抛到主循环）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();

    const r = await dispatch("mcp__fake__fail", "{}", makeCtx(true));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("远端拒绝了这次调用");
    // 关键：dispatch 返回结果而不是抛错 —— 主循环拿到的是「错误: …」继续跑
    expect(r.output.startsWith("错误:")).toBe(true);
  });

  test("空 content 给明确提示而不是空字符串", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    const r = await dispatch("mcp__fake__empty", "{}", makeCtx(true));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("返回空结果");
  });

  test("closeAll 注销工具并幂等", async () => {
    const m = new McpManager([server("fake")], { connectTimeoutMs: 10_000 });
    await m.connectAll();
    expect(toolNames()).toContain("mcp__fake__echo");
    m.closeAll();
    expect(toolNames()).not.toContain("mcp__fake__echo");
    m.closeAll(); // 幂等：不抛错
  });

  test("server 的 stderr 不污染协议；stdout 非 JSON 行被容忍（noisy 模式）", async () => {
    const m = track(new McpManager([server("noisy", "noisy")], { connectTimeoutMs: 10_000 }));
    const n = await m.connectAll();
    expect(n).toBe(4);
    expect(m.statuses()[0]?.status).toBe("connected");
  });
});

/* ------------------------------------------------------------------ */
/* d. 审批路径（验收 2）                                               */
/* ------------------------------------------------------------------ */

describe("d. 与内置工具同一审批路径", () => {
  test("工具标 sensitive，且 execute 先审批后调用", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    const impl = (await import("../src/tools/index.ts")).TOOLS.find(
      (t) => t.spec.function.name === "mcp__fake__echo",
    );
    expect(impl?.sensitive).toBe(true);
    expect(impl?.kind).toBe("capability");
  });

  test("用户拒绝 → 不执行，返回拒绝说明", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    const seen: Array<{ tool: string; detail: string }> = [];
    const r = await dispatch("mcp__fake__echo", JSON.stringify({ text: "x" }), makeCtx(false, seen));
    // 没执行 → ok:false（issue #3 收口：被拒绝的调用不能伪装成成功执行，
    // 否则 PostToolUse 会收到一次「从未发生的调用」）。
    expect(r.ok).toBe(false);
    expect(r.output).toContain("用户拒绝");
    // 审批框里要能看清调了什么
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tool).toBe("mcp__fake__echo");
    expect(seen[0]?.detail).toContain("fake/echo");
    expect(seen[0]?.detail).toContain('"text":"x"');
  });

  test("decidePermission：plan 模式一律拒绝，ask 模式需确认", () => {
    expect(decidePermission("plan", "mcp__fake__echo")).toEqual({ allow: false, reason: "plan" });
    expect(decidePermission("ask", "mcp__fake__echo")).toEqual({ allow: false, reason: "needs-confirm" });
    // auto-all 与内置写工具同口径放行
    expect(decidePermission("auto-all", "mcp__fake__echo")).toEqual({ allow: true });
  });

  test("plan 模式下 MCP 工具对模型不可见（filterPlanTools 过滤掉）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    const specs = (await import("../src/tools/index.ts")).TOOLS.map((t) => t.spec);
    const visible = filterPlanTools(specs).map((s) => s.function.name);
    expect(visible).not.toContain("mcp__fake__echo");
    expect(PLAN_VISIBLE_TOOLS).not.toContain("mcp__fake__echo");
  });

  test("plan 模式经 Agent 的 approve 注入被拒（端到端同一条闸门）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    // 复刻 loop.ts makeCtx 的 approve 实现：decidePermission(plan) → 拒绝
    const ctx: ToolCtx = {
      cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as unknown as Config,
      readOnly: true,
      approve: async (tool) => decidePermission("plan", tool).allow,
    };
    const r = await dispatch("mcp__fake__echo", JSON.stringify({ text: "x" }), ctx);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("用户拒绝");
  });
});

/* ------------------------------------------------------------------ */
/* e. 失败路径（验收 4）                                               */
/* ------------------------------------------------------------------ */

describe("e. 失败可读、不拖垮主循环", () => {
  test("坏命令（不存在的可执行文件）：error 状态含 server 名与原因，其余 server 照常", async () => {
    const m = track(
      new McpManager(
        [
          server("broken", "ok", { command: "definitely-not-a-real-binary-xyz", args: [] }),
          server("fake"),
        ],
        { connectTimeoutMs: 10_000, requestTimeoutMs: 10_000 },
      ),
    );
    const n = await m.connectAll(); // 不抛错
    expect(n).toBe(4); // 只有 fake 的工具

    const [broken, ok] = m.statuses();
    expect(broken?.status).toBe("error");
    expect(broken?.error).toContain('"broken"');
    expect(broken?.error).toContain("连接失败");
    expect(ok?.status).toBe("connected");
  });

  test("server 启动即崩（crash 模式）：错误里带 stderr 尾巴", async () => {
    const m = track(new McpManager([server("crasher", "crash")], { connectTimeoutMs: 10_000 }));
    const n = await m.connectAll();
    expect(n).toBe(0);
    const st = m.statuses()[0];
    expect(st?.status).toBe("error");
    expect(st?.error).toContain("crasher");
    expect(st?.error).toContain("模拟启动即崩");
  });

  test("握手超时（slow 模式）：超时被收敛成 error，不无限等", async () => {
    const m = track(
      new McpManager([server("slowpoke", "slow")], { connectTimeoutMs: 300, requestTimeoutMs: 300 }),
    );
    const n = await m.connectAll();
    expect(n).toBe(0);
    const st = m.statuses()[0];
    expect(st?.status).toBe("error");
    expect(st?.error).toContain("超时");
  });

  test("全部 server 都失败时 connectAll 仍返回 0 而不抛错", async () => {
    const m = track(
      new McpManager([server("a", "ok", { command: "no-such-bin-1", args: [] }), server("b", "crash")], {
        connectTimeoutMs: 5_000,
      }),
    );
    await expect(m.connectAll()).resolves.toBe(0);
    expect(m.statuses().every((s) => s.status === "error")).toBe(true);
  });

  test("未连接的 server 上调用工具 → 可读错误", async () => {
    const m = track(new McpManager([server("gone", "ok", { command: "no-such-bin-2", args: [] })]));
    await m.connectAll();
    // 手工造一个指向未连接 server 的工具，验证调用侧的兜底文案
    const impl = makeMcpTool({
      server: "gone",
      info: { name: "echo" },
      call: async () => {
        throw new Error('MCP server "gone" 未连接或连接已断开，请用 /mcp 查看状态');
      },
    });
    await expect(impl.execute({ text: "x" }, makeCtx(true))).rejects.toThrow(/未连接或连接已断开/);
  });

  test("enabled:false 的 server 不启动，状态为 disabled", async () => {
    const m = track(new McpManager([server("off", "ok", { enabled: false })]));
    const n = await m.connectAll();
    expect(n).toBe(0);
    expect(m.statuses()[0]?.status).toBe("disabled");
  });
});

/* ------------------------------------------------------------------ */
/* f. 协议层细节                                                       */
/* ------------------------------------------------------------------ */

describe("f. JSON-RPC 客户端", () => {
  test("服务端错误码转成 RpcError（带 code）", async () => {
    const rpc = new StdioRpc({
      command: process.execPath,
      args: [FIXTURE],
      env: {},
      requestTimeoutMs: 5_000,
    });
    rpc.start();
    try {
      await rpc.request("initialize", {});
      await expect(rpc.request("tools/call", { name: "nope", arguments: {} })).rejects.toThrow(
        /未知工具: nope/,
      );
    } finally {
      rpc.close();
    }
  });

  test("进程退出让在途请求立刻失败（不等超时）", async () => {
    const rpc = new StdioRpc({
      command: process.execPath,
      args: [FIXTURE, "--mode=crash"],
      env: {},
      requestTimeoutMs: 10_000,
    });
    rpc.start();
    const started = Date.now();
    await expect(rpc.request("initialize", {})).rejects.toThrow(/已退出|已关闭/);
    expect(Date.now() - started).toBeLessThan(5_000); // 远小于 10s 超时
    rpc.close();
  });

  test("formatCallResult：resource 文本取出、图片计数提示", () => {
    expect(
      formatCallResult("s", "t", {
        content: [
          { type: "text", text: "a" },
          { type: "resource", resource: { uri: "file:///x", text: "b" } },
          { type: "image", data: "..." },
        ],
      }),
    ).toBe("a\nb\n[1 个图片结果未展示：文本工具结果不支持图片]");
  });
});

/* ------------------------------------------------------------------ */
/* g. /mcp 命令                                                        */
/* ------------------------------------------------------------------ */

describe("g. /mcp 状态入口", () => {
  test("列出 server / 状态 / 工具数 / 错误", async () => {
    wireCommands();
    const cap = captureConsole();
    const states: McpServerState[] = [
      { name: "fs", status: "connected", tools: ["mcp__fs__read_file", "mcp__fs__write_file"] },
      { name: "gh", status: "error", tools: [], error: 'MCP server "gh" 连接失败（npx）：ENOENT' },
      { name: "off", status: "disabled", tools: [] },
    ];
    await dispatchCommand("/mcp", makeCmdCtx(cap.ui, states));
    const out = cap.out();
    expect(out).toContain("fs");
    expect(out).toContain("已连接");
    expect(out).toContain("2 个工具");
    expect(out).toContain("mcp__fs__read_file");
    expect(out).toContain("gh");
    expect(out).toContain("ENOENT");
    expect(out).toContain("已禁用");
    expect(out).toContain("mcp__<server>__<tool>");
  });

  test("没有配置时明说而不是显示空表", async () => {
    wireCommands();
    const cap = captureConsole();
    await dispatchCommand("/mcp", makeCmdCtx(cap.ui, []));
    expect(cap.out()).toContain("没有配置 MCP server");
  });

  test("进程未接 MCP（ctx.mcp 缺失）时给出配置指引", async () => {
    wireCommands();
    const cap = captureConsole();
    const ctx = makeCmdCtx(cap.ui, []);
    delete (ctx as { mcp?: unknown }).mcp;
    await dispatchCommand("/mcp", ctx);
    expect(cap.out()).toContain("没有接入 MCP");
  });
});

/* ------------------------------------------------------------------ */
/* h. 独立验收修复轮：审批链 / 命名 / 分界碰撞 / 清理                    */
/* ------------------------------------------------------------------ */

import { Agent } from "../src/agent.ts";
import type { AgentIO } from "../src/agent.ts";
import type { Message, StreamResult, ToolCall } from "../src/llm.ts";
import { computeMcpNames, nameFor, MCP_NAME_PATTERN, sanitizeSegment, shortHash } from "../src/mcp/tool.ts";
import { collectReviewDiff } from "../src/review.ts";
import { mkdirSync, writeFileSync } from "node:fs";

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

function agentCfg(cwd: string): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [],
    routes: {},
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.9,
    maxToolIterations: 10,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    toolcallInfoDetails: false,
    parallelToolCalls: "off",
    cwd,
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
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
  } as unknown as Config;
}

function tc(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** 脚本化流：第一轮发 tool_calls，第二轮收尾。 */
function scriptedStream(calls: ToolCall[]): (cfg: Config, m: Message[]) => Promise<StreamResult> {
  let round = 0;
  return async () => {
    round++;
    if (round === 1) {
      return { content: "", reasoning: "", toolCalls: calls, finishReason: "tool_calls", usage: null, raw: null } as StreamResult;
    }
    return { content: "done", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null } as StreamResult;
  };
}

describe("h1. 审批链：auto-edit 需确认 / auto-all 放行 / plan 拒绝", () => {
  test("decidePermission 四档对 MCP 工具的口径", () => {
    expect(decidePermission("auto-edit", "mcp__fs__write_file")).toEqual({ allow: false, reason: "needs-confirm" });
    expect(decidePermission("auto-edit", "write_file")).toEqual({ allow: true });
    expect(decidePermission("auto-all", "mcp__fs__write_file")).toEqual({ allow: true });
    expect(decidePermission("plan", "mcp__fs__write_file")).toEqual({ allow: false, reason: "plan" });
    expect(decidePermission("ask", "mcp__fs__write_file")).toEqual({ allow: false, reason: "needs-confirm" });
  });

  test("auto-edit 下真实 Agent 循环里 MCP 工具要用户确认（拒绝则远端不被调用）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    let asked = 0;
    const io = { ...silentIO(), confirm: async () => { asked++; return false; } } as AgentIO;
    const agent = new Agent({
      cfg: agentCfg(SANDBOX), console: io, mode: "auto-edit", systemPrompt: "sys",
      chatStream: scriptedStream([tc("c1", "mcp__fake__echo", { text: "x" })]),
    });
    await agent.send("go");
    expect(asked).toBe(1);
    const toolMsg = agent.messages.find((x) => x.role === "tool");
    expect(String(toolMsg?.content)).toContain("用户拒绝");
  });

  test("auto-all 下 MCP 工具直接放行（不弹确认）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    let asked = 0;
    const io = { ...silentIO(), confirm: async () => { asked++; return true; } } as AgentIO;
    const agent = new Agent({
      cfg: agentCfg(SANDBOX), console: io, mode: "auto-all", systemPrompt: "sys",
      chatStream: scriptedStream([tc("c1", "mcp__fake__echo", { text: "hi" })]),
    });
    await agent.send("go");
    expect(asked).toBe(0);
    const toolMsg = agent.messages.find((x) => x.role === "tool");
    expect(String(toolMsg?.content)).toContain("echo:hi");
  });

  test("plan 模式：MCP 工具被拒且不弹确认（连问都不问）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    let asked = 0;
    const io = { ...silentIO(), confirm: async () => { asked++; return true; } } as AgentIO;
    const agent = new Agent({
      cfg: agentCfg(SANDBOX), console: io, mode: "plan", systemPrompt: "sys",
      chatStream: scriptedStream([tc("c1", "mcp__fake__echo", { text: "x" })]),
    });
    await agent.send("go");
    expect(asked).toBe(0);
    const toolMsg = agent.messages.find((x) => x.role === "tool");
    expect(String(toolMsg?.content)).toContain("用户拒绝");
  });

  test("子代理：MCP 工具在清单里可见，且审批口径与主代理一致（auto-edit 仍要问）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    const { runSubagent } = await import("../src/tools/task.ts");
    let subAsked = 0;
    // 主代理 auto-edit：子代理继承 mode。确认回调在子代理里走 SilentConsole → 委托主 console.confirm。
    // 主代理自己的流脚本是空的（它不发起调用），子代理的流由 runSubagent 透传同一注入点。
    const main = new Agent({
      cfg: agentCfg(SANDBOX), console: { ...silentIO(), confirm: async () => { subAsked++; return false; } } as AgentIO,
      mode: "auto-edit", systemPrompt: "sys",
      chatStream: scriptedStream([tc("c1", "mcp__fake__echo", { text: "sub" })]),
    });
    // 子代理的工具清单必须包含 MCP 工具（排除表只管 task/compact_ctx/… 这些宿主绑定工具）。
    expect(main.toolSpecsFor().map((s) => s.function.name)).toContain("mcp__fake__echo");
    const ctx: ToolCtx = {
      cfg: agentCfg(SANDBOX),
      approve: async () => true,
    };
    // 子代理要跑起来，档位必须可解析：补一条 default 路由（否则 applyTier 直接拒）。
    // 这是测试脚手架的缺口，不是产品行为 —— 真实 cfg 一定有 routes。
    const mainCfg = agentCfg(SANDBOX);
    mainCfg.routes = {
      default: { provider: "p1", model: "m-default", fallbackAllowed: true },
    } as Config["routes"];
    mainCfg.providers = [{ name: "p1", type: "openai" }] as Config["providers"];
    (main as unknown as { opt: { cfg: Config } }).opt.cfg = mainCfg;
    let report = "";
    try {
      report = await runSubagent(main, "跑一下 MCP 工具", undefined, ctx);
    } catch (e) {
      report = (e as Error).message;
    }
    // 子代理看不到 mcp 工具时不会发起调用；能看到则必然经过审批（被拒 → 计数 1）
    expect(report.length).toBeGreaterThan(0);
    expect(subAsked).toBe(1);
  });

  test("/review 期间 MCP 工具不可执行（借用只读闸门）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    const repo = join(SANDBOX, "review-repo");
    mkdirSync(repo, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.email", "t@e.com"], { cwd: repo });
    Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: repo });
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    Bun.spawnSync(["git", "add", "-A"], { cwd: repo });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: repo });
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    expect(collectReviewDiff(repo).ok).toBe(true);

    let asked = 0;
    let modeAtSend = "";
    const agent = new Agent({
      cfg: agentCfg(repo), console: { ...silentIO(), confirm: async () => { asked++; return true; } } as AgentIO,
      mode: "auto-all", systemPrompt: "sys",
      chatStream: scriptedStream([tc("c1", "mcp__fake__echo", { text: "x" })]),
    });
    const origSend = agent.send.bind(agent);
    (agent as unknown as { send: (t: string) => Promise<unknown> }).send = async (t: string) => {
      modeAtSend = agent.mode;
      return origSend(t);
    };
    wireCommands();
    const cap = captureConsole();
    await dispatchCommand("/review", makeCmdCtx(cap.ui, []).agent === undefined
      ? { ...makeCmdCtx(cap.ui, []), agent, cfg: agentCfg(repo) }
      : { ...makeCmdCtx(cap.ui, []), agent, cfg: agentCfg(repo) });
    expect(modeAtSend).toBe("plan");
    expect(asked).toBe(0); // plan 分支不问
    const toolMsg = agent.messages.find((x) => x.role === "tool");
    expect(String(toolMsg?.content)).toContain("用户拒绝");
    expect(agent.mode).toBe("auto-all"); // finally 恢复
  });
});

describe("h2. 命名合法化与碰撞", () => {
  test("点号/斜杠/空格/中文都映射成合法名，且满足 ^[a-zA-Z0-9_-]{1,64}$", () => {
    for (const [s, t] of [["fs", "files.read"], ["fs", "a/b c"], ["服务", "工具"], ["fs", "x".repeat(200)]]) {
      const n = nameFor(s!, t!);
      expect(MCP_NAME_PATTERN.test(n)).toBe(true);
      expect(n.length).toBeLessThanOrEqual(64);
    }
    // 无信息损失 → 朴素名（可读性最好）；有损失（`.` 被清洗）→ 带哈希
    expect(nameFor("fs", "read_file")).toBe("mcp__fs__read_file");
    expect(nameFor("fs", "files.read")).not.toBe("mcp__fs__files_read");
    expect(nameFor("fs", "files.read")).toMatch(/^mcp__fs__files_read__[0-9a-f]{8}$/);
  });

  test("映射稳定：同输入同输出（无状态、无自增计数）", () => {
    expect(nameFor("fs", "files.read")).toBe(nameFor("fs", "files.read"));
    expect(nameFor("fs", "x".repeat(200))).toBe(nameFor("fs", "x".repeat(200)));
    expect(shortHash("a\0b")).toBe(shortHash("a\0b"));
    expect(sanitizeSegment("a.b/c")).toBe("a_b_c");
  });

  test("超长名截断 + 哈希后缀，不同长名不撞", () => {
    const a = nameFor("fs", "x".repeat(200) + "A");
    const b = nameFor("fs", "x".repeat(200) + "B");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(MCP_NAME_PATTERN.test(a)).toBe(true);
  });

  test("分界碰撞：server 名或工具名含 __ 时两边都带哈希（不靠先后）", () => {
    const names = computeMcpNames([
      { server: "a__b", tool: "c" },
      { server: "a", tool: "b__c" },
    ]);
    const n1 = names.get("a__b\u0000c")!;
    const n2 = names.get("a\u0000b__c")!;
    expect(n1).not.toBe(n2);
    for (const n of [n1, n2]) {
      expect(MCP_NAME_PATTERN.test(n)).toBe(true);
      expect(n.length).toBeLessThanOrEqual(64);
    }
    // 有歧义就谁都不占朴素名：两个都带哈希后缀
    expect(n1).not.toBe("mcp__a__b__c");
    expect(n2).not.toBe("mcp__a__b__c");
    // 重复的 pair 不影响结果（幂等）
    expect(computeMcpNames([{ server: "a__b", tool: "c" }]).get("a__b\u0000c")).toBe(n1);
  });

  test("tools/call 用远端原始工具名（注册名只是本地别名）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    const impl = makeMcpTool({
      server: "fake", info: { name: "echo" }, name: "mcp__fake__echo_alias",
      call: async (toolName, args) => `${toolName}:${String(args["text"])}`,
    });
    expect(impl.spec.function.name).toBe("mcp__fake__echo_alias");
    await expect(impl.execute({ text: "v" }, makeCtx(true))).resolves.toBe("echo:v");
  });

  test("注册失败的工具不进 tools（不算可用），并记进 rejected", async () => {
    // 先占住 mcp__fake__echo 这个名字，让 server 的工具注册失败
    const { registerTool: reg } = await import("../src/tools/index.ts");
    const un = reg({
      sensitive: false,
      spec: { type: "function", function: { name: "mcp__fake__echo", description: "占位", parameters: {} } },
      execute: async () => "",
    });
    try {
      const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
      const n = await m.connectAll();
      expect(n).toBe(3); // 4 个里 1 个注册失败
      const st = m.statuses()[0]!;
      expect(st.tools).not.toContain("mcp__fake__echo");
      expect(st.rejected?.[0]?.remote).toBe("echo");
      expect(st.rejected?.[0]?.reason).toContain("已注册");
    } finally {
      un();
    }
  });

  test("合法化折叠：files.read 与 files_read 撞名时由哈希拆开，且与顺序/集合无关", () => {
    const names = computeMcpNames([
      { server: "fs", tool: "files.read" },
      { server: "fs", tool: "files_read" },
    ]);
    const a = names.get("fs\u0000files.read")!;
    const b = names.get("fs\u0000files_read")!;
    expect(a).not.toBe(b);
    expect(MCP_NAME_PATTERN.test(a)).toBe(true);
    expect(MCP_NAME_PATTERN.test(b)).toBe(true);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    // 有损的那个（files.read）必须带哈希；无损失的（files_read）保留朴素名。
    // 关键：这**不**取决于顺序 —— files.read 无论何时都带哈希，files_read 无论何时
    // 都是朴素名，所以两者各自的名字与同批还有谁无关。
    expect(a).toMatch(/^mcp__fs__files_read__[0-9a-f]{8}$/);
    expect(b).toBe("mcp__fs__files_read");
    // 集合无关：单独出现时名字也不变
    expect(computeMcpNames([{ server: "fs", tool: "files.read" }]).get("fs\u0000files.read")).toBe(a);
    expect(computeMcpNames([{ server: "fs", tool: "files_read" }]).get("fs\u0000files_read")).toBe(b);
  });

  test("超长 server 名不会把 tool 段挤空（两个不同工具不能撞成同一个名字）", () => {
    const longServer = "s".repeat(60);
    const a = nameFor(longServer, "read");
    const b = nameFor(longServer, "write");
    expect(a).not.toBe(b);
    for (const n of [a, b]) {
      expect(MCP_NAME_PATTERN.test(n)).toBe(true);
      expect(n.length).toBeLessThanOrEqual(64);
    }
  });

  test("非 ASCII 名：信息不丢，不同原名不落成同名", () => {
    const names = computeMcpNames([
      { server: "fs", tool: "中文" },
      { server: "fs", tool: "日本語" },
      { server: "服务", tool: "工具" },
      { server: "服务", tool: "工具2" },
    ]);
    const got = [...names.values()];
    expect(new Set(got).size).toBe(4); // 四个不同原名 → 四个不同注册名
    for (const n of got) {
      expect(MCP_NAME_PATTERN.test(n)).toBe(true);
      expect(n.length).toBeLessThanOrEqual(64);
    }
    // 单个中文名也带哈希（清洗成 `_` 是信息损失，必须靠哈希区分）
    expect(names.get("fs\u0000中文")).not.toBe("mcp__fs____");
  });

  test("顺序无关：交换分配顺序后逐 pair 名称相等", () => {
    const pairs = [
      { server: "a__b", tool: "c" },
      { server: "a", tool: "b__c" },
      { server: "fs", tool: "files.read" },
      { server: "fs", tool: "files_read" },
      { server: "fs", tool: "中文" },
      { server: "fs", tool: "x".repeat(200) },
      { server: "fs", tool: "x".repeat(200) + "A" },
      { server: "plain", tool: "ok" },
    ];
    const fwd = computeMcpNames(pairs);
    const rev = computeMcpNames([...pairs].reverse());
    const shuffled = computeMcpNames([pairs[3]!, pairs[7]!, pairs[0]!, pairs[5]!, pairs[2]!, pairs[6]!, pairs[1]!, pairs[4]!]);
    for (const p of pairs) {
      const k = `${p.server}\u0000${p.tool}`;
      expect(fwd.get(k)).toBe(rev.get(k)!);
      expect(fwd.get(k)).toBe(shuffled.get(k)!);
    }
    // 同时保证整批唯一
    expect(new Set(fwd.values()).size).toBe(pairs.length);
  });

  test("顺序无关（端到端）：两个 server 连接顺序互换，注册名逐 pair 相等", async () => {
    async function namesOf(order: string[]): Promise<Record<string, string>> {
      const m = track(new McpManager(order.map((n) => server(n)), { connectTimeoutMs: 10_000 }));
      await m.connectAll();
      const out: Record<string, string> = {};
      for (const st of m.statuses()) {
        for (const e of st.toolEntries ?? []) out[`${st.name}/${e.remote}`] = e.name;
      }
      m.closeAll();
      return out;
    }
    const a = await namesOf(["srvone", "srvtwo"]);
    const b = await namesOf(["srvtwo", "srvone"]);
    expect(Object.keys(a).length).toBe(8); // 两个 server × 4 个工具
    expect(b).toEqual(a);
    expect(new Set(Object.values(a)).size).toBe(8);
  });

  test("makeMcpTool 拒绝非法注册名（不让非法名进请求体）", () => {
    expect(() =>
      makeMcpTool({
        server: "fs",
        info: { name: "files.read" },
        name: "mcp__fs__files.read",
        call: async () => "",
      }),
    ).toThrow(/不合法/);
  });

  test("连接失败时已注册的工具被回滚（不会留下「状态 error 但工具可调」）", async () => {
    // 先正常连一个 server 占住注册表，再让第二个 server 握手超时。
    // 关键断言：超时 server 的工具不在注册表里，状态是 error。
    const m = track(
      new McpManager([server("slowone", "slow")], { connectTimeoutMs: 300, requestTimeoutMs: 300 }),
    );
    const n = await m.connectAll();
    expect(n).toBe(0);
    const st = m.statuses()[0]!;
    expect(st.status).toBe("error");
    expect(st.tools).toEqual([]);
    expect(toolNames().filter((x) => x.startsWith("mcp__slowone__"))).toEqual([]);
  });

  test("/mcp 把注册失败的工具标为不可用，而不是列成可用", async () => {
    wireCommands();
    const cap = captureConsole();
    const states: McpServerState[] = [
      {
        name: "fs", status: "connected", tools: ["mcp__fs__read_file"],
        toolEntries: [{ name: "mcp__fs__read_file", remote: "read_file" }],
        rejected: [{ remote: "write_file", name: "mcp__fs__write_file", reason: "工具 mcp__fs__write_file 已注册" }],
      },
    ];
    await dispatchCommand("/mcp", makeCmdCtx(cap.ui, states));
    const out = cap.out();
    expect(out).toContain("注册失败 1 个");
    expect(out).toContain("不可用");
    expect(out).toContain("mcp__fs__write_file");
  });
});

describe("h3. 清理（-p 路径）", () => {
  test("closeAll 后工具注销、子进程退出（可测的清理函数）", async () => {
    const m = new McpManager([server("fake")], { connectTimeoutMs: 10_000 });
    await m.connectAll();
    expect(toolNames()).toContain("mcp__fake__echo");
    m.closeAll();
    expect(toolNames()).not.toContain("mcp__fake__echo");
    expect(m.toolCount()).toBe(0);
    m.closeAll(); // 幂等
  });

  test("closeAll 真的杀掉子进程（不是只注销工具）", async () => {
    const m = track(new McpManager([server("fake")], { connectTimeoutMs: 10_000 }));
    await m.connectAll();
    // 通过私有 live 表拿到 pid：清理函数必须让子进程退出，否则 -p 会留孤儿 node。
    const live = (m as unknown as { live: Map<string, { rpc: { pid: number | null } }> }).live;
    const pid = live.get("fake")?.rpc.pid ?? null;
    expect(pid).toBeGreaterThan(0);
    m.closeAll();
    // 给内核一点时间回收；kill(pid, 0) 抛错 = 进程已不存在
    await Bun.sleep(120);
    let alive = true;
    try {
      process.kill(pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
