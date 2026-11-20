/**
 * issue #67 —— MCP 资源与提示词（resources 用 @ 引用、prompts 作为斜杠命令）。
 *
 * 全部用仓库内假 stdio server（tests/fixtures/mcp-catalog-server.ts）或进程内桩：
 * 不连接用户真实 MCP，不写 ~/.neo / ~/.claude。
 *
 * 运行：bun test tests/mcp-resources-prompts-67.test.ts
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchCommand, wireCommands, type CommandContext } from "../src/cli/commands.ts";
import type { Config } from "../src/config.ts";
import type { McpStdioServerConfig } from "../src/config.ts";
import { COMMANDS } from "../src/input/commands.ts";
import {
  completeLine,
  formatCandidateHint,
  type CommandEntry,
} from "../src/input/completion.ts";
import {
  DEFAULT_MAX_BYTES_TOTAL,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_LINES_PER_FILE,
  expandMessageReferences,
  expandReferences,
  isWindowsDrivePath,
  parseMcpResourceRef,
  parseReferences,
} from "../src/input/references.ts";
import { McpManager, type McpServerState } from "../src/mcp/client.ts";
import {
  isMcpAppResource,
  mcpPromptMenuEntries,
  type McpPromptInfo,
  type McpResourceInfo,
} from "../src/mcp/catalog.ts";
import { dispatch, toolNames } from "../src/tools/index.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import { captureConsole, sleep } from "./helpers.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-mcp-67-"));
const FIXTURE = join(import.meta.dir, "fixtures", "mcp-catalog-server.ts");
const OLD_FIXTURE = join(import.meta.dir, "fixtures", "mcp-server.ts");

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

function catalogServer(
  name: string,
  extraArgs: string[] = [],
  over: Partial<McpStdioServerConfig> = {},
): McpStdioServerConfig {
  return {
    name,
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE, `--name=${name}`, ...extraArgs],
    env: {},
    enabled: true,
    ...over,
  };
}

function toolsOnlyServer(name: string, over: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
  return {
    name,
    transport: "stdio",
    command: process.execPath,
    args: [OLD_FIXTURE, `--mode=ok`, `--name=${name}`],
    env: {},
    enabled: true,
    ...over,
  };
}

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

function makeCtx(approve = true): ToolCtx {
  return {
    cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => approve,
  };
}

function makeCmdCtx(
  ui: ReturnType<typeof captureConsole>["ui"],
  over: Partial<CommandContext> = {},
): CommandContext {
  return {
    agent: {} as CommandContext["agent"],
    ui,
    cfg: { cwd: SANDBOX, safeMode: false } as Config,
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: { id: "s1", model: "m", cwd: SANDBOX } as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: { router: { on: () => () => {} }, isTTY: false } as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* a. 握手：capabilities、协议版本、只在声明后 list、方法缺失不拖垮工具   */
/* ------------------------------------------------------------------ */

describe("a. 握手与能力协商", () => {
  test("initialize 仍发 capabilities: {} 且 protocolVersion 为 2024-11-05", async () => {
    const initLog = join(SANDBOX, `init-${Date.now()}.json`);
    const m = track(
      new McpManager([catalogServer("docs", [`--init-log=${initLog}`])], { requestTimeoutMs: 8_000 }),
    );
    await m.connectAll();
    const raw = readFileSync(initLog, "utf8");
    const params = JSON.parse(raw) as Record<string, unknown>;
    expect(params["protocolVersion"]).toBe("2024-11-05");
    expect(params["capabilities"]).toEqual({});
    const caps = params["capabilities"] as Record<string, unknown>;
    expect(caps["prompts"]).toBeUndefined();
    expect(caps["resources"]).toBeUndefined();
    expect(caps["roots"]).toBeUndefined();
    expect(caps["sampling"]).toBeUndefined();
  });

  test("同时暴露 tools+resources+prompts 时清单与计数正确", async () => {
    const m = track(new McpManager([catalogServer("docs")], { requestTimeoutMs: 8_000 }));
    await m.connectAll();
    const st = m.statuses().find((s) => s.name === "docs");
    expect(st?.status).toBe("connected");
    expect(st?.tools.length).toBe(1);
    expect((st?.resources ?? []).length).toBe(4);
    expect((st?.prompts ?? []).length).toBe(2);
    expect(m.connectedResources().some((r) => r.uri === "file://api/authentication")).toBe(true);
    expect(m.connectedPrompts().some((p) => p.name === "summarize" && p.server === "docs")).toBe(true);
  });

  test("只有 tools 的 server 不报错，工具调用仍可用，资源和提示词计 0", async () => {
    const m = track(new McpManager([toolsOnlyServer("fake")], { requestTimeoutMs: 8_000 }));
    const n = await m.connectAll();
    expect(n).toBeGreaterThan(0);
    const st = m.statuses()[0];
    expect(st?.status).toBe("connected");
    expect(st?.tools.length).toBeGreaterThan(0);
    expect(st?.resources ?? []).toEqual([]);
    expect(st?.prompts ?? []).toEqual([]);
    const names = toolNames({ cwd: SANDBOX } as Config);
    expect(names.some((x) => x.includes("fake") && x.includes("echo"))).toBe(true);
    const result = await dispatch("mcp__fake__echo", JSON.stringify({ text: "hi" }), makeCtx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("echo:hi");
  });

  test("未声明 resources/prompts 能力时不打 list，工具握手仍成功", async () => {
    const m = track(
      new McpManager([catalogServer("docs", ["--caps=tools"])], { requestTimeoutMs: 8_000 }),
    );
    await m.connectAll();
    const st = m.statuses()[0];
    expect(st?.status).toBe("connected");
    expect(st?.tools.length).toBe(1);
    expect(st?.resources ?? []).toEqual([]);
    expect(st?.prompts ?? []).toEqual([]);
  });

  test("已声明但方法不存在（-32601）时跳过，不让工具握手失败", async () => {
    const m = track(
      new McpManager(
        [catalogServer("docs", ["--caps=tools,resources,prompts", "--missing-method"])],
        { requestTimeoutMs: 8_000 },
      ),
    );
    await m.connectAll();
    const st = m.statuses()[0];
    expect(st?.status).toBe("connected");
    expect(st?.tools.length).toBe(1);
    expect(st?.resources ?? []).toEqual([]);
    expect(st?.prompts ?? []).toEqual([]);
    const result = await dispatch("mcp__docs__echo", JSON.stringify({ text: "ok" }), makeCtx());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("echo:ok");
  });

  test("list 带 cursor 时跟页并合并", async () => {
    const m = track(
      new McpManager([catalogServer("docs", ["--pages=2"])], { requestTimeoutMs: 8_000 }),
    );
    await m.connectAll();
    const st = m.statuses()[0];
    expect((st?.resources ?? []).length).toBe(4);
    expect((st?.prompts ?? []).length).toBe(2);
  });

  test("页数超上限时截断并告警", async () => {
    const warnings: string[] = [];
    const m = track(
      new McpManager([catalogServer("docs", ["--page-cap-overflow"])], {
        requestTimeoutMs: 8_000,
        onStderr: (_server, line) => warnings.push(line),
      }),
    );
    await m.connectAll();
    const st = m.statuses()[0];
    expect(st?.status).toBe("connected");
    expect((st?.resources ?? []).length).toBeGreaterThan(0);
    expect(
      warnings.some((w) => w.includes("截断") || w.includes("页")) ||
        (st?.warnings ?? []).some((w) => w.includes("截断") || w.includes("页")),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* b. /mcp 计数                                                        */
/* ------------------------------------------------------------------ */

describe("b. /mcp 显示资源数与提示词数", () => {
  test("已连接 server 都报工具数、资源数、提示词数", async () => {
    wireCommands();
    const cap = captureConsole();
    const states: McpServerState[] = [
      {
        name: "docs",
        transport: "stdio",
        status: "connected",
        tools: ["mcp__docs__echo"],
        resources: [
          { uri: "file://api/authentication", name: "Auth" },
          { uri: "issue://123", name: "Issue 123" },
        ],
        prompts: [{ name: "hello" }, { name: "summarize" }],
      },
    ];
    await dispatchCommand("/mcp", makeCmdCtx(cap.ui, { mcp: () => states }));
    const out = cap.out();
    expect(out).toContain("1 个工具");
    expect(out).toContain("2 个资源");
    expect(out).toContain("2 个提示词");
  });

  test("只有工具的 server 写 0，不报错，也不省略字段", async () => {
    wireCommands();
    const cap = captureConsole();
    const states: McpServerState[] = [
      { name: "fake", transport: "stdio", status: "connected", tools: ["mcp__fake__echo"] },
    ];
    await dispatchCommand("/mcp", makeCmdCtx(cap.ui, { mcp: () => states }));
    const out = cap.out();
    expect(out).toContain("1 个工具");
    expect(out).toContain("0 个资源");
    expect(out).toContain("0 个提示词");
    expect(out).not.toContain("失败");
  });
});

/* ------------------------------------------------------------------ */
/* c. @ 引用解析、展开、预算、失败不阻断                                 */
/* ------------------------------------------------------------------ */

describe("c. @ 引用：解析与展开", () => {
  test("Windows 盘符不当 MCP", () => {
    expect(isWindowsDrivePath("C:\\foo")).toBe(true);
    expect(isWindowsDrivePath("C:/foo")).toBe(true);
    expect(isWindowsDrivePath("c:/Users/x")).toBe(true);
    expect(isWindowsDrivePath("github:issue://123")).toBe(false);
    expect(isWindowsDrivePath("docs:file://api/authentication")).toBe(false);
    expect(parseMcpResourceRef("C:\\foo", ["C"])).toBeNull();
    expect(parseMcpResourceRef("C:/foo", ["C"])).toBeNull();
  });

  test("首段能对上已连接 server 时才当 MCP 资源", () => {
    expect(parseMcpResourceRef("docs:file://api/authentication", ["docs"])).toEqual({
      server: "docs",
      uri: "file://api/authentication",
    });
    expect(parseMcpResourceRef("github:issue://123", ["docs"])).toBeNull();
    expect(parseMcpResourceRef("docs", ["docs"])).toBeNull();
    expect(parseMcpResourceRef("docs:", ["docs"])).toBeNull();
  });

  test("提交后把 resources/read 正文附进用户消息，原文 @ 标记保留，附件标明 MCP 资源", async () => {
    const r = await expandMessageReferences("请看 @docs:file://api/authentication", {
      cwd: SANDBOX,
      mcp: {
        connectedServers: ["docs"],
        read: async (server, uri) => ({
          text: `hello from ${server} ${uri}`,
        }),
      },
    });
    expect(r.text.startsWith("请看 @docs:file://api/authentication")).toBe(true);
    expect(r.text).toContain("以下是 @ 引用的 MCP 资源");
    expect(r.text).toContain("MCP 资源");
    expect(r.text).toContain("docs");
    expect(r.text).toContain("file://api/authentication");
    expect(r.text).toContain("hello from docs file://api/authentication");
    expect(r.text).not.toContain("以下是 @ 引用的文件内容");
    expect(r.errors).toEqual([]);
    expect(r.refs.length).toBe(1);
  });

  test("读失败只警告不阻断，原文保留", async () => {
    const r = await expandMessageReferences("请看 @docs:issue://123 继续", {
      cwd: SANDBOX,
      mcp: {
        connectedServers: ["docs"],
        read: async () => {
          throw new Error("读取失败: issue://123");
        },
      },
    });
    expect(r.text).toBe("请看 @docs:issue://123 继续");
    expect(r.refs).toEqual([]);
    expect(r.errors.some((e) => e.includes("@docs:issue://123") && e.includes("失败"))).toBe(true);
  });

  test("未知资源、未连接：警告，保留原文，不阻断", async () => {
    const r = await expandMessageReferences("看 @docs:missing://x 和 @other:file://a", {
      cwd: SANDBOX,
      mcp: {
        connectedServers: ["docs"],
        read: async (_server, uri) => {
          throw new Error(`未知资源: ${uri}`);
        },
      },
    });
    expect(r.text).toBe("看 @docs:missing://x 和 @other:file://a");
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test("二进制/blob 只警告，不把大段 base64 塞进消息", async () => {
    const blob = "A".repeat(400);
    const r = await expandMessageReferences("看 @docs:file://bin", {
      cwd: SANDBOX,
      mcp: {
        connectedServers: ["docs"],
        read: async () => ({ blob, mimeType: "application/octet-stream" }),
      },
    });
    expect(r.text).toBe("看 @docs:file://bin");
    expect(r.text.includes(blob)).toBe(false);
    expect(r.errors.some((e) => e.includes("二进制") || e.includes("blob"))).toBe(true);
  });

  test("一条消息可以同时有文件和资源，附件块分开，预算共用常量", async () => {
    expect(DEFAULT_MAX_FILES).toBe(5);
    expect(DEFAULT_MAX_LINES_PER_FILE).toBe(400);
    expect(DEFAULT_MAX_BYTES_TOTAL).toBe(60_000);
    writeFileSync(join(SANDBOX, "note.ts"), "export const n = 1;\n", "utf8");
    const r = await expandMessageReferences("看 @note.ts 和 @docs:issue://123", {
      cwd: SANDBOX,
      mcp: {
        connectedServers: ["docs"],
        read: async () => ({ text: "issue body\n" }),
      },
    });
    expect(r.text).toContain("以下是 @ 引用的文件内容");
    expect(r.text).toContain("以下是 @ 引用的 MCP 资源");
    expect(r.text).toContain("export const n = 1;");
    expect(r.text).toContain("issue body");
    expect(r.refs.length).toBe(2);
  });

  test("超限截断并警告（文件+资源共用个数上限）", async () => {
    const r = await expandMessageReferences(
      "@docs:issue://1 @docs:issue://2 @docs:issue://3",
      {
        cwd: SANDBOX,
        maxFiles: 2,
        mcp: {
          connectedServers: ["docs"],
          read: async (_s, uri) => ({ text: uri }),
        },
      },
    );
    expect(r.refs.length).toBe(2);
    expect(r.errors.some((e) => e.includes("最多引用") && e.includes("@docs:issue://3"))).toBe(true);
  });

  test("真实 server：@server:uri 走 resources/read", async () => {
    const m = track(new McpManager([catalogServer("docs")], { requestTimeoutMs: 8_000 }));
    await m.connectAll();
    const r = await expandMessageReferences("看 @docs:file://api/authentication", {
      cwd: SANDBOX,
      mcp: {
        connectedServers: m.statuses().filter((s) => s.status === "connected").map((s) => s.name),
        read: (server, uri) => m.readResource(server, uri),
      },
    });
    expect(r.text).toContain("resource-body:docs:file://api/authentication");
    expect(r.errors).toEqual([]);
  });

  test("同步 expandReferences 仍只处理文件，不被 MCP 写法破坏", () => {
    const parsed = parseReferences("看 @docs:file://api/authentication 和 @note.ts");
    expect(parsed.map((p) => p.path)).toEqual(["docs:file://api/authentication", "note.ts"]);
    const r = expandReferences("看 @nope.ts", { cwd: SANDBOX });
    expect(r.text).toBe("看 @nope.ts");
    expect(r.errors.some((e) => e.includes("不存在"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* d. 补全                                                             */
/* ------------------------------------------------------------------ */

const FILES = ["src/a.ts", "src/b.ts", "note.ts", "README.md", "docs-guide.md"];
const MCP_RES: McpResourceInfo[] = [
  { uri: "file://api/authentication", name: "Auth", title: "Authentication", mimeType: "text/plain", server: "docs" },
  { uri: "issue://123", name: "Issue 123", mimeType: "text/plain", server: "docs" },
  { uri: "ui://widget", name: "UI widget", mimeType: "text/html", server: "docs" },
  { uri: "file://app-ui", name: "App UI", mimeType: "text/html;profile=mcp-app", server: "docs" },
  { uri: "issue://1", name: "GH issue", mimeType: "text/plain", server: "github" },
];

function mcpInput(over: Record<string, unknown> = {}) {
  return {
    files: FILES,
    commands: COMMANDS,
    mcp: {
      servers: ["docs", "github"],
      resources: MCP_RES,
      safeMode: false,
      ...over,
    },
  };
}

describe("d. @ 补全", () => {
  test("没有冒号时只出工作区文件，绝不插入资源列表", () => {
    const r = completeLine("@src", mcpInput());
    expect(r).not.toBeNull();
    expect(r!.matches.every((m) => m.startsWith("@src") || m.startsWith("@"))).toBe(true);
    expect(r!.matches.some((m) => m.includes("file://") || m.includes("issue://"))).toBe(false);
    expect(r!.matches).toContain("@src/a.ts");
  });

  test("前缀能唯一对上已连接 server 时，文件候选之后可多一行 @server:，hint 为 MCP server，不倒出资源", () => {
    const r = completeLine("@doc", mcpInput());
    expect(r).not.toBeNull();
    const q = r!.matches.indexOf("@docs:");
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBe(r!.matches.length - 1);
    expect(q).not.toBe(0);
    expect(r!.matches.some((m) => m.includes("file://") || m.includes("issue://"))).toBe(false);
    expect(r!.hintKind === "mixed" || (r!.labels && r!.labels.includes("MCP server"))).toBe(true);
    const hint = formatCandidateHint(r!.hintKind ?? "mixed", r!.matches, 8, r!.labels);
    expect(hint).toContain("MCP server");
    expect(hint).toContain("@docs:");
    expect(hint).toContain("文件候选");
  });

  test("前缀不能唯一对上时不加限定符", () => {
    const r = completeLine("@", mcpInput());
    expect(r!.matches.some((m) => m === "@docs:" || m === "@github:")).toBe(false);
  });

  test("只有 token 已含冒号且冒号前对上已连接 server 时才出资源项，插入值为 @server:uri", () => {
    const r = completeLine("@docs:", mcpInput());
    expect(r!.matches).toContain("@docs:file://api/authentication");
    expect(r!.matches).toContain("@docs:issue://123");
    expect(r!.matches.some((m) => m.includes("github"))).toBe(false);
    expect(r!.matches.some((m) => m === "@src/a.ts")).toBe(false);
    expect(r!.hintKind).toBe("resource");
    const hint = formatCandidateHint("resource", r!.matches, 8, r!.labels);
    expect(hint).toContain("资源候选");
    expect(hint).not.toContain("文件候选");
    expect(r!.labels?.some((l) => l.includes("Auth") || l.includes("Authentication"))).toBe(true);
  });

  test("ui:// 与 mcp-app 资源不进 @ 建议", () => {
    expect(isMcpAppResource({ uri: "ui://widget", mimeType: "text/html" })).toBe(true);
    expect(isMcpAppResource({ uri: "file://app-ui", mimeType: "text/html;profile=mcp-app" })).toBe(true);
    expect(isMcpAppResource({ uri: "file://api/authentication", mimeType: "text/plain" })).toBe(false);
    const r = completeLine("@docs:", mcpInput());
    expect(r!.matches.some((m) => m.includes("ui://"))).toBe(false);
    expect(r!.matches.some((m) => m.includes("app-ui"))).toBe(false);
  });

  test("Windows 盘符走文件路径，不当 MCP", () => {
    const r = completeLine("@C:/note", { files: ["C:/note.ts", "note.ts"], commands: [], mcp: { servers: ["C"], resources: [], safeMode: false } });
    expect(r!.matches.some((m) => m.includes("issue://") || m.endsWith("C:"))).toBe(false);
  });

  test("已断开 server 的资源立刻从补全消失", () => {
    const r = completeLine("@docs:", mcpInput({ servers: ["github"], resources: MCP_RES.filter((x) => x.server === "github") }));
    expect(r!.matches.some((m) => m.startsWith("@docs:"))).toBe(false);
  });

  test("安全模式不出现 MCP 资源补全和限定符", () => {
    const a = completeLine("@doc", mcpInput({ safeMode: true }));
    expect(a!.matches).not.toContain("@docs:");
    const b = completeLine("@docs:", mcpInput({ safeMode: true }));
    expect(b!.matches.some((m) => m.includes("file://") || m.includes("issue://"))).toBe(false);
  });

  test("既有工作区文件 @ 补全不被破坏", () => {
    const r = completeLine("@note", { files: FILES, commands: COMMANDS });
    expect(r!.matches).toContain("@note.ts");
  });
});

/* ------------------------------------------------------------------ */
/* e. / 菜单与分发                                                     */
/* ------------------------------------------------------------------ */

describe("e. MCP prompts 菜单与分发", () => {
  const prompts: Array<McpPromptInfo & { server: string }> = [
    { server: "docs", name: "hello", description: "无参数问好" },
    {
      server: "docs",
      name: "summarize",
      description: "总结一个仓库",
      arguments: [
        { name: "repo", description: "仓库名", required: true },
        { name: "style", required: false },
      ],
    },
    { server: "github", name: "hello", description: "另一个 hello" },
  ];

  test("菜单用 /server:prompt，description 为 MCP · server；不进静态 COMMANDS", () => {
    const entries: CommandEntry[] = mcpPromptMenuEntries(prompts);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "docs:hello", description: expect.stringContaining("MCP · docs") }),
        expect.objectContaining({ name: "docs:summarize" }),
        expect.objectContaining({ name: "github:hello", description: expect.stringContaining("MCP · github") }),
      ]),
    );
    expect(COMMANDS.some((c) => c.name.includes("docs:hello") || c.name === "docs:hello")).toBe(false);
    expect(entries.every((e) => !e.name.startsWith("mcp__"))).toBe(true);
  });

  test("两个 server 的同名 prompt 两条都在，互不覆盖", () => {
    const entries = mcpPromptMenuEntries(prompts);
    expect(entries.filter((e) => e.name.endsWith(":hello")).map((e) => e.name).sort()).toEqual([
      "docs:hello",
      "github:hello",
    ]);
  });

  test("无参数 prompts/get 成功后作为用户消息入队", async () => {
    wireCommands();
    const cap = captureConsole();
    const enqueued: string[] = [];
    const got: Array<{ server: string; name: string; args: Record<string, string> }> = [];
    await dispatchCommand(
      "/docs:hello",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: (t) => enqueued.push(t),
        mcpPrompts: () => prompts,
        mcpGetPrompt: async (server, name, args) => {
          got.push({ server, name, args: args ?? {} });
          return {
            messages: [{ role: "user", content: { type: "text", text: "prompt-body:docs:hello" } }],
          };
        },
      }),
    );
    expect(got).toEqual([{ server: "docs", name: "hello", args: {} }]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toContain("prompt-body:docs:hello");
    expect(cap.out()).toContain("/docs:hello");
  });

  test("参数已写齐则直接 prompts/get，不再问答", async () => {
    wireCommands();
    const cap = captureConsole();
    const enqueued: string[] = [];
    let asked = 0;
    const got: Record<string, string>[] = [];
    await dispatchCommand(
      "/docs:summarize my-repo formal",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: (t) => enqueued.push(t),
        selectDeps: {
          router: { on: () => () => {} },
          isTTY: true,
          asker: async () => {
            asked += 1;
            return "should-not-run";
          },
        } as CommandContext["selectDeps"],
        mcpPrompts: () => prompts,
        mcpGetPrompt: async (_s, _n, args) => {
          got.push(args ?? {});
          return {
            messages: [{ role: "user", content: { type: "text", text: `prompt-body args=${JSON.stringify(args)}` } }],
          };
        },
      }),
    );
    expect(asked).toBe(0);
    expect(got[0]).toEqual({ repo: "my-repo", style: "formal" });
    expect(enqueued[0]).toContain("my-repo");
  });

  test("缺必填参数时非 TTY 报错并列参数，不挂起、不入队", async () => {
    wireCommands();
    const cap = captureConsole({ stdinIsTTY: false });
    const enqueued: string[] = [];
    let asked = 0;
    await dispatchCommand(
      "/docs:summarize",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: (t) => enqueued.push(t),
        selectDeps: {
          router: { on: () => () => {} },
          isTTY: false,
          asker: async () => {
            asked += 1;
            return "nope";
          },
        } as CommandContext["selectDeps"],
        mcpPrompts: () => prompts,
        mcpGetPrompt: async () => {
          throw new Error("should not get");
        },
      }),
    );
    expect(asked).toBe(0);
    expect(enqueued).toEqual([]);
    const out = cap.out();
    expect(out).toMatch(/repo/);
    expect(out).toMatch(/必填|缺少|参数/);
  });

  test("缺必填参数时 TTY 用 ask 收齐再 prompts/get", async () => {
    wireCommands();
    const cap = captureConsole();
    const enqueued: string[] = [];
    const questions: string[] = [];
    await dispatchCommand(
      "/docs:summarize",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: (t) => enqueued.push(t),
        selectDeps: {
          router: { on: () => () => {} },
          isTTY: true,
          asker: async (q: string) => {
            questions.push(q);
            return "neo-cli";
          },
        } as CommandContext["selectDeps"],
        mcpPrompts: () => prompts,
        mcpGetPrompt: async (_s, _n, args) => ({
          messages: [{ role: "user", content: { type: "text", text: `repo=${args?.repo}` } }],
        }),
      }),
    );
    expect(questions.some((q) => q.includes("repo"))).toBe(true);
    expect(enqueued[0]).toContain("repo=neo-cli");
  });

  test("可选参数没给就省略", async () => {
    wireCommands();
    const cap = captureConsole();
    let used: Record<string, string> | undefined;
    await dispatchCommand(
      "/docs:summarize only-repo",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: () => {},
        mcpPrompts: () => prompts,
        mcpGetPrompt: async (_s, _n, args) => {
          used = args;
          return { messages: [{ role: "user", content: { type: "text", text: "ok" } }] };
        },
      }),
    );
    expect(used).toEqual({ repo: "only-repo" });
    expect(used && "style" in used).toBe(false);
  });

  test("prompts/get 失败只警告，不发送空轮次", async () => {
    wireCommands();
    const cap = captureConsole();
    const enqueued: string[] = [];
    await dispatchCommand(
      "/docs:hello",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: (t) => enqueued.push(t),
        mcpPrompts: () => prompts,
        mcpGetPrompt: async () => {
          throw new Error("远端失败");
        },
      }),
    );
    expect(enqueued).toEqual([]);
    expect(cap.out()).toMatch(/失败|警告|远端/);
  });

  test("无限定 /prompt 唯一命中且不与内置/技能冲突则可以跑", async () => {
    wireCommands();
    const cap = captureConsole();
    const enqueued: string[] = [];
    await dispatchCommand(
      "/summarize acme",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: (t) => enqueued.push(t),
        mcpPrompts: () => prompts,
        mcpGetPrompt: async (server, name, args) => ({
          messages: [{ role: "user", content: { type: "text", text: `${server}:${name}:${args?.repo}` } }],
        }),
      }),
    );
    expect(enqueued[0]).toContain("docs:summarize:acme");
  });

  test("无限定 /prompt 有歧义时列出限定名，不要猜、不入队", async () => {
    wireCommands();
    const cap = captureConsole();
    const enqueued: string[] = [];
    await dispatchCommand(
      "/hello",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: (t) => enqueued.push(t),
        mcpPrompts: () => prompts,
        mcpGetPrompt: async () => {
          throw new Error("should not get");
        },
      }),
    );
    expect(enqueued).toEqual([]);
    const out = cap.out();
    expect(out).toContain("/docs:hello");
    expect(out).toContain("/github:hello");
  });

  test("与内置命令撞名：走内置，并指出未触发的限定名", async () => {
    wireCommands();
    const cap = captureConsole();
    const enqueued: string[] = [];
    const builtinPrompts = [...prompts, { server: "docs", name: "mcp", description: "同名提示词" }];
    await dispatchCommand(
      "/mcp",
      makeCmdCtx(cap.ui, {
        enqueueUserTurn: (t) => enqueued.push(t),
        mcp: () => [],
        mcpPrompts: () => builtinPrompts,
        mcpGetPrompt: async () => {
          throw new Error("should not get");
        },
      }),
    );
    expect(enqueued).toEqual([]);
    const out = cap.out();
    expect(out).toMatch(/未触发 MCP 提示词/);
    expect(out).toContain("/docs:mcp");
    expect(out).toContain("没有配置 MCP server");
  });

  test("安全模式不出现 MCP prompts 分发", async () => {
    wireCommands();
    const cap = captureConsole();
    const enqueued: string[] = [];
    await dispatchCommand(
      "/docs:hello",
      makeCmdCtx(cap.ui, {
        cfg: { cwd: SANDBOX, safeMode: true } as Config,
        enqueueUserTurn: (t) => enqueued.push(t),
        mcpPrompts: () => prompts,
        mcpGetPrompt: async () => {
          throw new Error("should not get");
        },
      }),
    );
    expect(enqueued).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* f. list_changed                                                     */
/* ------------------------------------------------------------------ */

describe("f. list_changed 刷新，失败保留上次成功清单", () => {
  test("stdio 收到 list_changed 后刷新资源和提示词", async () => {
    const m = track(
      new McpManager([catalogServer("docs", ["--notify-ms=40"])], { requestTimeoutMs: 8_000 }),
    );
    await m.connectAll();
    expect(m.connectedPrompts().some((p) => p.name === "changelog")).toBe(false);
    const start = Date.now();
    while (Date.now() - start < 2000) {
      if (m.connectedPrompts().some((p) => p.name === "changelog")) break;
      await sleep(30);
    }
    expect(m.connectedResources().some((r) => r.uri === "issue://999")).toBe(true);
    expect(m.connectedPrompts().some((p) => p.name === "changelog")).toBe(true);
  });

  test("刷新失败保留上次成功清单", async () => {
    const m = track(
      new McpManager([catalogServer("docs", ["--notify-ms=40", "--notify-fail"])], {
        requestTimeoutMs: 8_000,
      }),
    );
    await m.connectAll();
    const beforeRes = m.connectedResources().map((r) => r.uri).sort();
    const beforePrompts = m.connectedPrompts().map((p) => p.name).sort();
    expect(beforeRes).toContain("file://api/authentication");
    expect(beforePrompts).toContain("summarize");
    await sleep(250);
    expect(m.connectedResources().map((r) => r.uri).sort()).toEqual(beforeRes);
    expect(m.connectedPrompts().map((p) => p.name).sort()).toEqual(beforePrompts);
  });
});
