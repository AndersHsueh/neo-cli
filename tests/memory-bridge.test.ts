/**
 * 记忆读链路 + Agent 集成 + 跨会话 E2E（v0.2 记忆激活 M1/M2）。
 *
 * 覆盖规格 §7.7：R0 画像注入、R1 每轮召回、临时消息生命周期（成功/abort/压缩过滤）、
 * -p 单次模式只用项目级、跨 cwd 的用户级共享/项目级隔离、双作用域工具。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type Config } from "../src/config.ts";
import { Agent } from "../src/agent.ts";
import { createMemoryBridge, type MemoryBridge } from "../src/memory/bridge.ts";
import { ensureScopeLayout } from "../src/memory/layout.ts";
import { RECALL_MARKER } from "../src/memory/port.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { registerTool, dispatch } from "../src/tools/index.ts";
import { registerWikiTools } from "../src/tools/wiki.ts";
import type { Message, StreamResult } from "../src/llm.ts";
import { syncIndex, todayStamp } from "../src/wiki/write.ts";

let SANDBOX = "";
let CWD = "";
let CWD2 = "";
let USER_ROOT = "";
let JOURNAL = "";

/** wiki 工具注册表：本文件内全局复用，afterAll 清理（bun test 单进程共享模块表）。 */
const wikiTools = { unregister: null as null | (() => void) };
function ensureWikiTools(): void {
  if (!wikiTools.unregister) wikiTools.unregister = registerWikiTools(registerTool);
}

interface SilentUi {
  line(): void;
  blank(): void;
  info(): void;
  warn(): void;
  error(): void;
  toolHeader(): void;
  toolResult(): void;
  indent(s: string): string;
  startSpinner(): void;
  updateSpinner(): void;
  stopSpinner(): void;
  beginStream(): void;
  writeStream(): void;
  endStream(): void;
  ensureStreamClosed(): void;
  confirm(): Promise<boolean>;
}

const ui: SilentUi = {
  line: () => {},
  blank: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  toolHeader: () => {},
  toolResult: () => {},
  indent: (s) => s,
  startSpinner: () => {},
  updateSpinner: () => {},
  stopSpinner: () => {},
  beginStream: () => {},
  writeStream: () => {},
  endStream: () => {},
  ensureStreamClosed: () => {},
  confirm: async () => true,
};

function makeCfg(cwd: string): Config {
  const cfg = loadConfig();
  cfg.cwd = cwd;
  cfg.memory = {
    ...cfg.memory,
    enabled: true,
    quiet: true,
    userWikiDir: USER_ROOT,
    journalDir: JOURNAL,
    // 测试绝不能碰真实 ~/.neo/memorys：migrate 会在 userLevelDir 写 .migrated-v2
    userLevelDir: join(SANDBOX, "legacy-memorys"),
    autoCapture: { ...cfg.memory.autoCapture, enabled: true, mode: "boundary" },
    autoRecall: { ...cfg.memory.autoRecall, enabled: true },
  };
  return cfg;
}

function bridge(cwd: string, mode: "interactive" | "oneshot" = "interactive"): MemoryBridge {
  return createMemoryBridge({
    cfg: makeCfg(cwd),
    cwd,
    sessionId: `sess-${Math.random().toString(16).slice(2, 8)}`,
    mode,
    captureEnabled: true,
    streamFn: async () => ({ content: '{"ops":[]}', reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: {} }),
  });
}

function writePage(cwd: string, scope: "project" | "user", name: string, title: string, summary: string, body: string): string {
  const layout = ensureScopeLayout(scope, cwd, USER_ROOT);
  const path = join(layout.pagesDir, name);
  writeFileSync(
    path,
    `# ${title}\n\n## 摘要\n\n${summary}\n\n> 最后更新:${todayStamp()}\n\n## 正文\n\n${body}\n`,
    "utf8",
  );
  // 真实写入链路会同步 INDEX；测试直接写文件时补上，保证系统提示/索引断言有意义
  syncIndex(layout, name.replace(/\.md$/, ""), summary);
  return path;
}

function fakeStream(content: string): StreamResult {
  return { content, reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: {} };
}

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-bridge-"));
  JOURNAL = join(SANDBOX, "journal");
  USER_ROOT = join(SANDBOX, "user-wiki");
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  const dir = mkdtempSync(join(SANDBOX, "case-"));
  CWD = join(dir, "proj-a");
  CWD2 = join(dir, "proj-b");
  rmSync(JOURNAL, { recursive: true, force: true });
  mkdirSync(JOURNAL, { recursive: true });
  rmSync(USER_ROOT, { recursive: true, force: true });
  rmSync(join(SANDBOX, "legacy-memorys"), { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* R0 启动画像注入                                                      */
/* ------------------------------------------------------------------ */

describe("A R0 用户画像注入", () => {
  test("A1 有画像页：注入摘要 + 事实要点，带来源与推断提示", async () => {
    const user = ensureScopeLayout("user", CWD, USER_ROOT);
    writeFileSync(
      join(user.pagesDir, "用户画像.md"),
      [
        "# 用户画像",
        "",
        "## 摘要",
        "",
        "资深后端工程师，偏好直接给结论",
        "",
        `> 最后更新:${todayStamp()}`,
        "> 来源:session legacy · 自动归纳",
        "",
        "## 事实（用户明确表达）",
        "",
        "- 使用 macOS + zsh",
        "- 中文沟通",
        "",
        "## 推断（待确认）",
        "",
        "- （推断 2026-10-20 · 置信 0.7）可能偏好短回答",
        "",
      ].join("\n"),
      "utf8",
    );
    const r = await bridge(CWD).startup();
    expect(r).not.toBeNull();
    expect(r!.message.role).toBe("system");
    const text = String(r!.message.content);
    expect(text.startsWith("## 用户画像")).toBe(true);
    expect(text).toContain("资深后端工程师");
    expect(text).toContain("macOS + zsh");
    expect(text).toContain("推断内容不得当作硬性要求");
    expect(r!.tokens).toBeLessThanOrEqual(220);
  });

  test("A2 无画像 → null（不阻塞）", async () => {
    expect(await bridge(CWD).startup()).toBeNull();
  });

  test("A3 -p 单次模式不注入用户级画像", async () => {
    ensureScopeLayout("user", CWD, USER_ROOT);
    writePage(CWD, "user", "用户画像.md", "用户画像", "偏好直接给结论", "- 中文");
    expect(await bridge(CWD, "oneshot").startup()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* R1 自动召回                                                          */
/* ------------------------------------------------------------------ */

describe("B R1 自动召回", () => {
  test("B1 项目优先两桶 + 标记前缀", async () => {
    writePage(CWD, "project", "踩坑-热键.md", "踩坑-热键", "热键要挂 input 流", "热键挂错对象导致不触发。");
    writePage(CWD, "user", "偏好-沟通.md", "偏好-沟通", "沟通偏好", "偏好先给结论。");
    const r = await bridge(CWD).recall("热键不触发 偏好沟通");
    expect(r).not.toBeNull();
    const text = String(r!.message.content);
    expect(text.startsWith(RECALL_MARKER)).toBe(true);
    expect(text.indexOf("[项目]")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("[用户]")).toBeGreaterThan(text.indexOf("[项目]"));
    expect(r!.trace.injected).toBe(true);
    expect(r!.trace.hits[0]?.scope).toBe("project");
  });

  test("B2 无命中 → null，不注入", async () => {
    writePage(CWD, "project", "踩坑-热键.md", "踩坑-热键", "热键要挂 input 流", "热键挂错对象。");
    expect(await bridge(CWD).recall("量子纠缠 波函数")).toBeNull();
  });

  test("B3 -p 单次模式只查项目级", async () => {
    writePage(CWD, "project", "踩坑-热键.md", "踩坑-热键", "热键要挂 input 流", "热键挂错对象。");
    writePage(CWD, "user", "偏好-沟通.md", "偏好-沟通", "沟通偏好", "偏好先给结论。");
    const oneshot = await bridge(CWD, "oneshot").recall("偏好 沟通 结论");
    expect(oneshot).toBeNull();
    const interactive = await bridge(CWD).recall("偏好 沟通 结论");
    expect(interactive).not.toBeNull();
  });

  test("B4 记忆关闭 → 不召回", async () => {
    writePage(CWD, "project", "踩坑-热键.md", "踩坑-热键", "热键要挂 input 流", "热键挂错对象。");
    const cfg = makeCfg(CWD);
    cfg.memory.enabled = false;
    const b = createMemoryBridge({
      cfg,
      cwd: CWD,
      sessionId: "s",
      mode: "interactive",
      captureEnabled: false,
      streamFn: async () => fakeStream('{"ops":[]}'),
    });
    expect(await b.recall("热键")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Agent 集成：注入 / 摘除 / 回滚 / 捕获                                 */
/* ------------------------------------------------------------------ */

describe("C Agent 集成", () => {
  function makeAgent(cwd: string, responses: Array<StreamResult | Error>): {
    agent: Agent;
    seen: Message[][];
  } {
    const seen: Message[][] = [];
    let i = 0;
    const memory = bridge(cwd);
    const agent = new Agent({
      cfg: makeCfg(cwd),
      console: ui as never,
      mode: "auto-all",
      systemPrompt: "你是测试助手",
      memory,
      chatStream: async (_cfg, messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        const next = responses[Math.min(i, responses.length - 1)];
        i++;
        if (next instanceof Error) throw next;
        return next ?? fakeStream("ok");
      },
    });
    return { agent, seen };
  }

  test("C1 召回注入为临时消息，轮末摘除，不进历史", async () => {
    writePage(CWD, "project", "踩坑-热键.md", "踩坑-热键", "热键要挂 input 流", "热键挂错对象导致不触发。");
    const { agent, seen } = makeAgent(CWD, [fakeStream("按此修复即可。")]);
    await agent.send("热键不触发怎么修");
    const firstReq = seen[0]!.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(firstReq).toContain(RECALL_MARKER);
    expect(firstReq).toContain("踩坑-热键");
    // 轮末摘除：历史里不再有召回消息
    expect(agent.messages.some((m) => typeof m.content === "string" && m.content.startsWith(RECALL_MARKER))).toBe(false);
  });

  test("C2 abort + rollback：召回消息随本轮一起回滚", async () => {
    writePage(CWD, "project", "踩坑-热键.md", "踩坑-热键", "热键要挂 input 流", "热键挂错对象导致不触发。");
    let agentRef: Agent | null = null;
    const seen: Message[][] = [];
    const agent = new Agent({
      cfg: makeCfg(CWD),
      console: ui as never,
      mode: "auto-all",
      systemPrompt: "你是测试助手",
      memory: bridge(CWD),
      chatStream: async (_cfg, messages) => {
        seen.push(messages.map((m) => ({ ...m })));
        agentRef?.cancel();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    agentRef = agent;
    const stats = await agent.send("热键坏了", { rollbackOnAbort: true });
    expect(stats.aborted).toBe(true);
    // 历史回到 system 一条（召回与 user 都被回滚）
    expect(agent.messages.length).toBe(1);
  });

  test("C3 压缩输入过滤召回消息", async () => {
    const { agent, seen } = makeAgent(CWD, [
      fakeStream("<摘要占位>"),
    ]);
    writePage(CWD, "project", "踩坑-热键.md", "踩坑-热键", "热键要挂 input 流", "热键挂错对象导致不触发。");
    // 构造足够长的历史以便压缩
    agent.messages.push(
      { role: "user", content: "历史问题一" },
      { role: "assistant", content: "历史回答一" },
      { role: "user", content: "历史问题二" },
      { role: "assistant", content: "历史回答二" },
      { role: "user", content: "历史问题三" },
      { role: "assistant", content: "历史回答三" },
    );
    await agent.compact();
    const compactReq = seen.at(-1)!.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(compactReq).not.toContain(RECALL_MARKER);
  });

  test("C4 轮末捕获：假提炼器返回 op → 落页 + 审计", async () => {
    const seen: Message[][] = [];
    let call = 0;
    const memory = createMemoryBridge({
      cfg: makeCfg(CWD),
      cwd: CWD,
      sessionId: "sess-c4",
      mode: "interactive",
      captureEnabled: true,
      streamFn: async (_cfg, messages) =>
        fakeStream(
          JSON.stringify({
            ops: [
              {
                scope: "project",
                action: "create",
                page: "决策-集成.md",
                summary: "集成测试决策",
                body: "这是一个由 Agent 集成测试产生的决策，内容长度足够通过校验。",
                confidence: 0.9,
                inferred: false,
                evidence: "「我们决定采用方案 B」",
              },
            ],
          }),
        ),
    });
    const agent = new Agent({
      cfg: makeCfg(CWD),
      console: ui as never,
      mode: "auto-all",
      systemPrompt: "你是测试助手",
      memory,
      chatStream: async (_cfg, messages) => {
        seen.push(messages);
        call++;
        if (call === 1) {
          return {
            content: "",
            reasoning: "",
            finishReason: "stop",
            usage: null,
            raw: {},
            toolCalls: [
              { id: "1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/x.ts", content: "x" }) } },
            ],
          };
        }
        const system = messages[0] && typeof messages[0].content === "string" ? messages[0].content : "";
        if (system.includes("记忆提炼器")) {
          return fakeStream(
            JSON.stringify({
              ops: [
                {
                  scope: "project",
                  action: "create",
                  page: "决策-集成.md",
                  summary: "集成测试决策",
                  body: "这是一个由 Agent 集成测试产生的决策，内容长度足够通过校验。",
                  confidence: 0.9,
                  inferred: false,
                  evidence: "「我们决定采用方案 B」",
                },
              ],
            }),
          );
        }
        if (messages.some((m) => m.role === "tool")) return fakeStream("已写入 src/x.ts，采用方案 B。");
        return fakeStream("好的");
      },
    });
    await agent.send("我们决定采用方案 B 并修一下");
    await memory.flush(3000);
    const project = ensureScopeLayout("project", CWD);
    expect(existsSync(join(project.pagesDir, "决策-集成.md"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 跨会话 / 跨 cwd E2E                                                  */
/* ------------------------------------------------------------------ */

describe("D 跨会话与跨 cwd", () => {
  function captureBridge(cwd: string, ops: unknown[]): MemoryBridge {
    return createMemoryBridge({
      cfg: makeCfg(cwd),
      cwd,
      sessionId: "sess-writer",
      mode: "interactive",
      captureEnabled: true,
      streamFn: async () => fakeStream(JSON.stringify({ ops })),
    });
  }

  test("D1 会话 A 写入 → 会话 B 召回（项目级）", async () => {
    const bA = captureBridge(CWD, [
      {
        scope: "project",
        action: "create",
        page: "决策-跨会话.md",
        summary: "跨会话决策",
        body: "会话 A 做出的跨会话可召回决策，内容足够长。",
        confidence: 0.9,
        inferred: false,
        evidence: "用户显式要求记住",
      },
    ]);
    await bA.remember("请记住：会话 A 决定采用方案 B", "project");
    await bA.flush(3000);
    expect(existsSync(join(ensureScopeLayout("project", CWD).pagesDir, "决策-跨会话.md"))).toBe(true);

    // 会话 B（同 cwd）：能召回
    const bB = bridge(CWD);
    const recalled = await bB.recall("跨会话 决策 方案");
    expect(recalled).not.toBeNull();
    expect(String(recalled!.message.content)).toContain("决策-跨会话");
  });

  test("D2 用户级跨 cwd 共享；项目级不串项目", async () => {
    // 项目 A 写入项目页 + 用户页
    const bA = captureBridge(CWD, [
      {
        scope: "project",
        action: "create",
        page: "踩坑-A专属.md",
        summary: "A 专属坑",
        body: "项目 A 独有的内部细节，不应出现在项目 B，内容足够长。",
        confidence: 0.9,
        inferred: false,
        evidence: "用户显式要求记住",
      },
      {
        scope: "user",
        action: "create",
        page: "偏好-异步.md",
        summary: "偏好异步沟通",
        body: "用户偏好异步沟通并先给结论，这是跨项目稳定偏好。",
        confidence: 0.9,
        inferred: false,
        evidence: "用户显式要求记住",
      },
    ]);
    await bA.remember("请记住：项目 A 的坑与我的偏好");
    await bA.flush(3000);

    // 项目 B 会话：用户级可见，项目 A 的页不可见
    const bB = bridge(CWD2);
    const userRecall = await bB.recall("异步沟通 偏好 结论");
    expect(userRecall).not.toBeNull();
    expect(String(userRecall!.message.content)).toContain("偏好-异步");
    const projectRecall = await bB.recall("A专属 坑");
    expect(projectRecall).toBeNull();
  });

  test("D3 单次模式（-p）写用户级被拒", async () => {
    const b = bridge(CWD, "oneshot");
    expect(await b.remember("请记住我的偏好：先给结论", "user")).toContain("单次模式");
  });
});

/* ------------------------------------------------------------------ */
/* 双作用域工具与系统提示                                               */
/* ------------------------------------------------------------------ */

describe("E 工具与系统提示", () => {

  test("E1 wiki_write scope=user → 写入用户库；wiki_search scope=both 带标签", async () => {
    writePage(CWD, "project", "踩坑-项目坑.md", "踩坑-项目坑", "项目坑摘要", "项目坑正文。");
    const cfg = makeCfg(CWD);
    const ctx = { cfg, approve: async () => true };
    ensureWikiTools();
    const created = await dispatch(
      "wiki_write",
      JSON.stringify({
        action: "create",
        page: "偏好-测试.md",
        scope: "user",
        content: `# 偏好-测试\n\n## 摘要\n\n用户测试偏好\n\n> 最后更新:${todayStamp()}\n`,
        log_title: "测试用户页",
      }),
      ctx,
    );
    expect(created.ok).toBe(true);
    expect(existsSync(join(ensureScopeLayout("user", CWD, USER_ROOT).pagesDir, "偏好-测试.md"))).toBe(true);

    const searched = await dispatch("wiki_search", JSON.stringify({ query: "用户测试偏好" }), ctx);
    expect(searched.ok).toBe(true);
    expect(searched.output).toContain("[用户]");
  });

  test("E2 系统提示注入双库索引，项目在前", () => {
    writePage(CWD, "project", "踩坑-项目坑.md", "踩坑-项目坑", "项目坑摘要", "项目坑正文。");
    writePage(CWD, "user", "偏好-沟通.md", "偏好-沟通", "沟通偏好", "先给结论。");
    const prompt = buildSystemPrompt(makeCfg(CWD));
    expect(prompt).toContain("## 记忆库");
    const projIdx = prompt.indexOf("项目记忆（");
    const userIdx = prompt.indexOf("用户记忆（");
    expect(projIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(projIdx);
    expect(prompt).toContain("先查项目级");
  });
});

/* ------------------------------------------------------------------ */
/* 作用域守卫 / 恢复 / 开关                                              */
/* ------------------------------------------------------------------ */

describe("G 作用域守卫与恢复", () => {
  test("G1 -p scopeMode=project：系统提示/工具都不碰用户级", async () => {
    writePage(CWD, "project", "踩坑-项目.md", "踩坑-项目", "项目摘要", "项目正文。");
    writePage(CWD, "user", "偏好-用户.md", "偏好-用户", "用户偏好摘要", "用户偏好正文。");
    const cfg = makeCfg(CWD);
    cfg.memory.scopeMode = "project";
    const prompt = buildSystemPrompt(cfg);
    expect(prompt).not.toContain("用户记忆（");
    const ctx = { cfg, approve: async () => true };
    ensureWikiTools();
    const search = await dispatch("wiki_search", JSON.stringify({ query: "用户偏好" }), ctx);
    expect(search.output).not.toContain("[用户]");
    const write = await dispatch(
      "wiki_write",
      JSON.stringify({
        action: "create",
        page: "偏好-禁止.md",
        scope: "user",
        content: `# 偏好-禁止\n\n## 摘要\n\nx\n\n> 最后更新:${todayStamp()}\n`,
        log_title: "x",
      }),
      ctx,
    );
    expect(write.ok).toBe(false);
    expect(write.output).toContain("单次模式");
  });

  test("G2 plan 模式（captureEnabled=false）：remember 与 capture 都不写", async () => {
    const b = createMemoryBridge({
      cfg: makeCfg(CWD),
      cwd: CWD,
      sessionId: "s",
      mode: "interactive",
      captureEnabled: false,
      streamFn: async () => fakeStream('{"ops":[]}'),
    });
    expect(await b.remember("请记住这个结论，它很重要")).toContain("不可用");
    b.capture({ kind: "turn", messages: [{ role: "user", content: "决定采用方案 B" }, { role: "assistant", content: "好" }], turn: 1 });
    await b.flush(1000);
    const project = ensureScopeLayout("project", CWD);
    const pages = readFileSync(join(project.pagesDir, "INDEX.md"), "utf8");
    expect(pages).not.toContain("决策-");
  });

  test("G3 启动恢复未处理 journal → 重新提炼落页", async () => {
    const { appendTurn } = await import("../src/memory/journal.ts");
    const record = {
      v: 1 as const,
      id: "recover-1",
      ts: new Date().toISOString(),
      sessionId: "old-session",
      cwd: CWD,
      kind: "turn" as const,
      turn: 1,
      user: "我们决定采用方案 B，因为性能更好",
      answer: "好的，采用方案 B",
      tools: [],
      filesTouched: [],
    };
    appendTurn(JOURNAL, record);
    let calls = 0;
    const b = createMemoryBridge({
      cfg: makeCfg(CWD),
      cwd: CWD,
      sessionId: "new-session",
      mode: "interactive",
      captureEnabled: true,
      streamFn: async () => {
        calls++;
        return fakeStream(
          JSON.stringify({
            ops: [
              {
                scope: "project",
                action: "create",
                page: "决策-恢复.md",
                summary: "恢复测试",
                body: "从崩溃遗留 journal 恢复出来的决策内容，长度足够。",
                confidence: 0.9,
                inferred: false,
                evidence: "「我们决定采用方案 B」",
              },
            ],
          }),
        );
      },
    });
    b.recoverPending();
    await b.flush(3000);
    expect(calls).toBeGreaterThan(0);
    expect(existsSync(join(ensureScopeLayout("project", CWD).pagesDir, "决策-恢复.md"))).toBe(true);
  });

  test("G4 autoCapture.mode=off：捕获入口直接跳过", async () => {
    const cfg = makeCfg(CWD);
    cfg.memory.autoCapture.mode = "off";
    let calls = 0;
    const b = createMemoryBridge({
      cfg,
      cwd: CWD,
      sessionId: "s",
      mode: "interactive",
      captureEnabled: true,
      streamFn: async () => {
        calls++;
        return fakeStream('{"ops":[]}');
      },
    });
    b.capture({ kind: "turn", messages: [{ role: "user", content: "决定采用方案 B" }, { role: "assistant", content: "好" }], turn: 1 });
    b.captureCompact("压缩摘要：决定采用方案 B。", 1);
    await b.flush(1000);
    expect(calls).toBe(0);
  });

  test("G5 autoRecall.enabled=false：不召回", async () => {
    writePage(CWD, "project", "踩坑-开关.md", "踩坑-开关", "开关摘要", "开关正文。");
    const cfg = makeCfg(CWD);
    cfg.memory.autoRecall.enabled = false;
    const b = createMemoryBridge({
      cfg,
      cwd: CWD,
      sessionId: "s",
      mode: "interactive",
      captureEnabled: true,
      streamFn: async () => fakeStream('{"ops":[]}'),
    });
    expect(await b.recall("踩坑 开关")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 命令面                                                              */
/* ------------------------------------------------------------------ */

describe("F 命令面", () => {
  test("F1 status / list / forget / lint / why", () => {
    writePage(CWD, "project", "踩坑-待删.md", "踩坑-待删", "待删摘要", "待删正文。");
    const b = bridge(CWD);
    expect(b.status()).toContain("记忆：开启");
    expect(b.list("project")).toContain("踩坑-待删");
    expect(b.why()).toContain("上次召回：无");
    const del = b.forget("project", "踩坑-待删.md");
    expect(del).toContain("已删除");
    expect(existsSync(join(ensureScopeLayout("project", CWD).pagesDir, "踩坑-待删.md"))).toBe(false);
    writePage(CWD, "project", "踩坑-体检.md", "踩坑-体检", "体检摘要", "体检正文。");
    const linted = b.lint();
    expect(linted).toContain("用户");
    // schema 文件 AGENTS.md 被豁免，不应报缺摘要/日期戳
    expect(linted).not.toContain("缺摘要");
    const migrated = b.migrate();
    expect(migrated).toContain("用户库");
  });

  test("F2 migrate：legacy profile → 用户画像 + raw 归档 + 标记，幂等且不动旧数据", () => {
    const legacy = join(SANDBOX, "legacy-memorys");
    mkdirSync(join(legacy, "raw"), { recursive: true });
    writeFileSync(join(legacy, "profile.md"), "资深工程师\n偏好中文结论先行\n", "utf8");
    writeFileSync(
      join(legacy, "raw", "2026-10-16_neo_abc12345.md"),
      "---\ndate: 2026-10-16\ncwd: /x\nsummary: exit\n---\n",
      "utf8",
    );
    const b = bridge(CWD);
    const first = b.migrate();
    expect(first).toContain("已迁移 profile.md");
    const user = ensureScopeLayout("user", CWD, USER_ROOT);
    const profile = readFileSync(join(user.pagesDir, "用户画像.md"), "utf8");
    expect(profile).toContain("资深工程师");
    expect(profile).toContain("事实（用户明确表达）");
    expect(readFileSync(join(user.pagesDir, "INDEX.md"), "utf8")).toContain("[[用户画像]]");
    expect(existsSync(join(user.rawDir, "legacy-memorys.md"))).toBe(true);
    expect(readFileSync(join(user.rawDir, "legacy-memorys.md"), "utf8")).toContain("abc12345");
    expect(existsSync(join(legacy, ".migrated-v2"))).toBe(true);
    // 旧数据未被删除
    expect(existsSync(join(legacy, "profile.md"))).toBe(true);
    expect(existsSync(join(legacy, "raw", "2026-10-16_neo_abc12345.md"))).toBe(true);
    // 幂等：第二次不再重复迁移
    const second = b.migrate();
    expect(second).toContain("已存在");
  });
});

afterAll(() => {
  wikiTools.unregister?.();
  wikiTools.unregister = null;
});
