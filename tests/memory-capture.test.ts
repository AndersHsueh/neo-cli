/**
 * 记忆写链路（v0.2 记忆激活 M2）：提炼校验 → 合并落页 → 捕获引擎。
 *
 * 覆盖规格 §7.6：ops 硬校验、去重、冲突更正、推断分流、journal 先落盘、
 * 失败降级、锁占用、会话页面上限。全部用 fake chatStream，不触网。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type Config } from "../src/config.ts";
import type { StreamResult } from "../src/llm.ts";
import type { Message } from "../src/llm.ts";
import { validateDistillOps, parseDistillJson, buildDistillMessages } from "../src/memory/distill.ts";
import type { DistillOp, MemoryInventoryItem } from "../src/memory/distill.ts";
import { applyOps, appendToSection, collectInventory, isDuplicate, USER_FACT_HEADING, USER_INFER_HEADING } from "../src/memory/merge.ts";
import { CaptureEngine, buildTurnRecord, shouldCapture } from "../src/memory/capture.ts";
import { makeRememberTool } from "../src/tools/memory.ts";
import type { TurnCaptureInput } from "../src/memory/port.ts";
import { ensureScopeLayout } from "../src/memory/layout.ts";
import { readAudit, pendingRecords, localDate } from "../src/memory/journal.ts";
import { todayStamp } from "../src/wiki/write.ts";

let SANDBOX = "";
let CWD = "";
let USER_ROOT = "";
let JOURNAL = "";

function makeCfg(): Config {
  const cfg = loadConfig();
  cfg.cwd = CWD;
  cfg.memory = {
    ...cfg.memory,
    enabled: true,
    quiet: true,
    userWikiDir: USER_ROOT,
    journalDir: JOURNAL,
    // 测试绝不能碰真实 ~/.neo/memorys：migrate 会在 userLevelDir 写 .migrated-v2
    userLevelDir: join(SANDBOX, "legacy-memorys"),
    autoCapture: {
      ...cfg.memory.autoCapture,
      enabled: true,
      mode: "boundary",
      maxOpsPerTurn: 2,
      maxPagesPerSession: 8,
      minConfidence: 0.65,
      minInferredConfidence: 0.75,
      journalRetentionDays: 7,
      flushTimeoutMs: 3000,
    },
  };
  return cfg;
}

function fakeResult(content: string): StreamResult {
  return { content, reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: {} };
}

function jsonOps(ops: unknown[]): StreamResult {
  return fakeResult(JSON.stringify({ ops }));
}

const PROJECT_PAGE = "踩坑-旧坑.md";
const USER_PAGE = "偏好-沟通.md";

function seedWiki(): void {
  const project = ensureScopeLayout("project", CWD);
  const user = ensureScopeLayout("user", CWD, USER_ROOT);
  writeFileSync(
    join(project.pagesDir, PROJECT_PAGE),
    `# 踩坑-旧坑\n\n## 摘要\n\n旧的坑\n\n> 最后更新:${todayStamp()}\n\n## 正文\n\n旧内容\n`,
    "utf8",
  );
  writeFileSync(
    join(user.pagesDir, USER_PAGE),
    `# 偏好-沟通\n\n## 摘要\n\n沟通偏好\n\n> 最后更新:${todayStamp()}\n\n## 事实（用户明确表达）\n\n- 中文回答\n\n## 推断（待确认）\n\n`,
    "utf8",
  );
}

function inventory(): MemoryInventoryItem[] {
  const project = ensureScopeLayout("project", CWD);
  const user = ensureScopeLayout("user", CWD, USER_ROOT);
  return collectInventory({ project, user });
}

function op(over: Partial<DistillOp> = {}): DistillOp {
  return {
    scope: "project",
    action: "create",
    page: "决策-测试决策.md",
    summary: "测试决策摘要",
    body: "这是一个足够长的决策正文，包含理由与实现路径。",
    confidence: 0.9,
    inferred: false,
    evidence: "用户说「我们决定采用方案 B」",
    ...over,
  };
}

function rec(over: Partial<import("../src/memory/journal.ts").TurnRecord> = {}): import("../src/memory/journal.ts").TurnRecord {
  return {
    v: 1,
    id: `test-${Math.random().toString(16).slice(2)}`,
    ts: new Date().toISOString(),
    sessionId: "sess-1",
    cwd: CWD,
    kind: "turn",
    turn: 1,
    user: "我们决定采用方案 B，因为性能更好",
    answer: "好的，采用方案 B",
    tools: [],
    filesTouched: [],
    ...over,
  };
}

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-capture-"));
  JOURNAL = join(SANDBOX, "memory", "journal");
  USER_ROOT = join(SANDBOX, "user-wiki");
  mkdirSync(join(SANDBOX, "memory"), { recursive: true });
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例独立 cwd + 独立 journal（含去重哈希/审计/锁），避免用例间串味
  const dir = mkdtempSync(join(SANDBOX, "case-"));
  CWD = join(dir, "proj");
  rmSync(JOURNAL, { recursive: true, force: true });
  mkdirSync(JOURNAL, { recursive: true });
  seedWiki();
});

/* ------------------------------------------------------------------ */
/* 提炼校验                                                            */
/* ------------------------------------------------------------------ */

describe("A distill 校验规则", () => {
  const input = () => ({
    record: rec(),
    inventory: inventory(),
    maxOps: 2,
    minConfidence: 0.65,
    minInferredConfidence: 0.75,
  });

  test("A1 合法 op 通过校验", () => {
    const r = validateDistillOps([{ ...op(), supersedes: undefined }], input());
    expect(r.ops.length).toBe(1);
    expect(r.dropped).toEqual([]);
  });

  test("A2 置信度门槛：事实 0.65 / 推断 0.75", () => {
    const lowFact = validateDistillOps([op({ confidence: 0.6 })], input());
    expect(lowFact.ops.length).toBe(0);
    expect(lowFact.dropped[0]?.reason).toContain("confidence");

    const lowInfer = validateDistillOps(
      [op({ scope: "user", page: USER_PAGE, action: "append", confidence: 0.7, inferred: true })],
      input(),
    );
    expect(lowInfer.ops.length).toBe(0);

    const okInfer = validateDistillOps(
      [op({ scope: "user", page: USER_PAGE, action: "append", confidence: 0.8, inferred: true })],
      input(),
    );
    expect(okInfer.ops.length).toBe(1);
  });

  test("A3 页名/长度/摘要非法一律丢弃", () => {
    expect(validateDistillOps([op({ page: "没有后缀" })], input()).ops.length).toBe(0);
    expect(validateDistillOps([op({ page: "log.md" })], input()).ops.length).toBe(0);
    expect(validateDistillOps([op({ body: "太短" })], input()).ops.length).toBe(0);
    expect(validateDistillOps([op({ summary: "" })], input()).ops.length).toBe(0);
  });

  test("A4 evidence 必须能在本轮原文中找到", () => {
    const bad = validateDistillOps([op({ evidence: "「这句话根本不存在于原文」" })], input());
    expect(bad.ops.length).toBe(0);
    expect(bad.dropped[0]?.reason).toContain("evidence");
    // 4 字窗口兜底匹配
    const ok = validateDistillOps([op({ evidence: "采用方案 B" })], input());
    expect(ok.ops.length).toBe(1);
  });

  test("A5 append 目标必须存在于清单；create 目标必须不存在", () => {
    const appendMissing = validateDistillOps(
      [op({ action: "append", page: "决策-不存在.md" })],
      input(),
    );
    expect(appendMissing.ops.length).toBe(0);
    const createExisting = validateDistillOps(
      [op({ action: "create", page: PROJECT_PAGE })],
      input(),
    );
    expect(createExisting.ops.length).toBe(0);
    const appendExisting = validateDistillOps(
      [op({ action: "append", page: PROJECT_PAGE })],
      input(),
    );
    expect(appendExisting.ops.length).toBe(1);
  });

  test("A6 每轮 ops 上限与单轮 create 上限", () => {
    const many = validateDistillOps([op(), op({ page: "决策-二.md" }), op({ page: "决策-三.md" })], input());
    expect(many.ops.length).toBeLessThanOrEqual(2);
    expect(many.dropped.some((d) => d.reason.includes("上限"))).toBe(true);

    // 同一作用域两个 create → 只留一个；跨作用域各一个 create 合法
    const twoCreates = validateDistillOps([op(), op({ page: "决策-二.md" })], input());
    expect(twoCreates.ops.length).toBe(1);
    expect(twoCreates.dropped[0]?.reason).toContain("create");
    const crossScope = validateDistillOps(
      [op(), op({ scope: "user", page: "偏好-新.md", summary: "用户新偏好", body: "用户跨项目偏好内容，需要足够长才能通过校验。" })],
      input(),
    );
    expect(crossScope.ops.length).toBe(2);
  });

  test("A7 密钥类内容直接丢弃；普通邮箱保留", () => {
    const secret = validateDistillOps(
      [op({ body: "token 是 sk-abcdefghijklmnopqrstuvwxyz012345 不要外传" })],
      input(),
    );
    expect(secret.ops.length).toBe(0);
    expect(secret.dropped[0]?.reason).toContain("密钥");
  });

  test("A8 hintScope 覆盖：与用户显式作用域不符的 op 被丢弃", () => {
    const r = validateDistillOps([op({ scope: "user", page: USER_PAGE, action: "append" })], {
      ...input(),
      record: rec({ hintScope: "project" }),
    });
    expect(r.ops.length).toBe(0);
    expect(r.dropped[0]?.reason).toContain("作用域");
  });

  test("A9 parseDistillJson 容忍围栏与噪音", () => {
    expect(parseDistillJson('前言\n```json\n{"ops":[]}\n```\n后记').error).toBeNull();
    expect(parseDistillJson("完全没有 JSON").error).not.toBeNull();
    expect(parseDistillJson('{"foo":1}').error).not.toBeNull();
  });

  test("A10 buildDistillMessages 包含记录与清单，且不包含工具原始输出", () => {
    const msgs = buildDistillMessages(input());
    const text = msgs.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(text).toContain("我们决定采用方案 B");
    expect(text).toContain(PROJECT_PAGE);
    expect(text).toContain("最多输出 2 条");
  });
});

/* ------------------------------------------------------------------ */
/* 合并落页                                                            */
/* ------------------------------------------------------------------ */

describe("B merge 落页规则", () => {
  const ctx = () => ({
    project: ensureScopeLayout("project", CWD),
    user: ensureScopeLayout("user", CWD, USER_ROOT),
    sessionId: "sess-1",
    date: todayStamp(),
    journalDir: JOURNAL,
  });

  test("B1 create 项目页：写页 + INDEX 同步 + log 登记", () => {
    const r = applyOps([op()], ctx());
    expect(r.applied.length).toBe(1);
    expect(r.applied[0]?.status).toBe("created");
    const project = ensureScopeLayout("project", CWD);
    const text = readFileSync(join(project.pagesDir, "决策-测试决策.md"), "utf8");
    expect(text).toContain("## 摘要");
    expect(text).toContain("> 来源:session sess-1");
    expect(readFileSync(join(project.pagesDir, "INDEX.md"), "utf8")).toContain("[[决策-测试决策]]");
    expect(readFileSync(join(project.pagesDir, "log.md"), "utf8")).toContain("自动记忆");
  });

  test("B2 append 项目页：追加推理与依据 + INDEX 摘要刷新", () => {
    const r = applyOps([op({ action: "append", page: PROJECT_PAGE })], ctx());
    expect(r.applied[0]?.status).toBe("appended");
    const project = ensureScopeLayout("project", CWD);
    const text = readFileSync(join(project.pagesDir, PROJECT_PAGE), "utf8");
    expect(text).toContain("## 推理与依据");
    expect(text).toContain("这是一个足够长的决策正文");
    // append 也要同步 INDEX（修 v0.1 缺口）
    const index = readFileSync(join(project.pagesDir, "INDEX.md"), "utf8");
    expect(index).toContain(PROJECT_PAGE.replace(/\.md$/, ""));
  });

  test("B3 用户级事实/推断分流", () => {
    const r = applyOps(
      [
        op({ scope: "user", page: USER_PAGE, action: "append", body: "用户明确要求中文回答并先给结论", confidence: 0.9 }),
        op({
          scope: "user",
          page: USER_PAGE,
          action: "append",
          body: "从提问方式推测偏好简短回答",
          confidence: 0.8,
          inferred: true,
        }),
      ],
      ctx(),
    );
    expect(r.applied.length).toBe(2);
    const user = ensureScopeLayout("user", CWD, USER_ROOT);
    const text = readFileSync(join(user.pagesDir, USER_PAGE), "utf8");
    const factIdx = text.indexOf(USER_FACT_HEADING);
    const inferIdx = text.indexOf(USER_INFER_HEADING);
    expect(factIdx).toBeGreaterThanOrEqual(0);
    expect(inferIdx).toBeGreaterThan(factIdx);
    expect(text).toContain("中文回答并先给结论");
    expect(text).toContain("（推断 ");
    // 事实在事实段内、推断在推断段内
    expect(text.slice(factIdx, inferIdx)).toContain("中文回答并先给结论");
    expect(text.slice(inferIdx)).toContain("偏好简短回答");
  });

  test("B4 去重：相同内容第二次不再写入", () => {
    const first = applyOps([op()], ctx());
    expect(first.applied[0]?.status).toBe("created");
    const second = applyOps([op({ action: "append", page: "决策-测试决策.md" })], ctx());
    expect(second.applied[0]?.status).toBe("deduped");
    const project = ensureScopeLayout("project", CWD);
    const text = readFileSync(join(project.pagesDir, "决策-测试决策.md"), "utf8");
    expect(text.split("这是一个足够长的决策正文").length - 1).toBe(1);
  });

  test("B5 supersedes 命中 → 追加更正行", async () => {
    const project = ensureScopeLayout("project", CWD);
    writeFileSync(
      join(project.pagesDir, "决策-旧结论.md"),
      `# 决策-旧结论\n\n## 摘要\n\n旧结论\n\n> 最后更新:${todayStamp()}\n\n## 正文\n\n模版用方案 A\n`,
      "utf8",
    );
    const inv = collectInventory({ project, user: null });
    expect(inv.some((i) => i.page === "决策-旧结论.md")).toBe(true);
    const r = applyOps(
      [
        op({
          action: "append",
          page: "决策-旧结论.md",
          body: "改由方案 B 承担，原因是 A 的延迟不可接受。",
          supersedes: "模版用方案 A",
        }),
      ],
      ctx(),
    );
    expect(r.applied[0]?.status).toBe("appended");
    const text = readFileSync(join(project.pagesDir, "决策-旧结论.md"), "utf8");
    expect(text).toContain("> 更正");
    expect(text).toContain("模版用方案 A");
  });

  test("B6 append 目标不存在时降级 create，不丢信息", () => {
    const r = applyOps([op({ action: "append", page: "决策-新页.md" })], ctx());
    expect(r.applied[0]?.status).toBe("created");
  });

  test("B7 页面超限转续页", () => {
    const project = ensureScopeLayout("project", CWD);
    const big = "填充内容".repeat(2000);
    writeFileSync(
      join(project.pagesDir, "决策-大页.md"),
      `# 决策-大页\n\n## 摘要\n\n大页\n\n> 最后更新:${todayStamp()}\n\n## 正文\n\n${big}\n`,
      "utf8",
    );
    const r = applyOps(
      [op({ action: "append", page: "决策-大页.md", summary: "续写", body: "续页内容" })],
      ctx(),
    );
    expect(r.applied[0]?.status).toBe("split");
    expect(existsSync(join(project.pagesDir, "决策-大页-续1.md"))).toBe(true);
  });

  test("B8 isDuplicate 子串与相似度", () => {
    expect(isDuplicate("同一句话重复", "前缀 同一句话重复 后缀")).toBe(true);
    expect(isDuplicate("完全不同的一段内容", "另一段内容")).toBe(false);
  });

  test("B9 appendToSection 段末插入并刷新日期戳", () => {
    const src = "# 页\n\n## 事实（用户明确表达）\n\n- 一\n\n## 其他\n\n- x\n\n> 最后更新:2020-01-01\n";
    const out = appendToSection(src, USER_FACT_HEADING, "- 二", "2026-10-20");
    expect(out.indexOf("- 一")).toBeLessThan(out.indexOf("- 二"));
    expect(out.indexOf("- 二")).toBeLessThan(out.indexOf("## 其他"));
    expect(out).toContain("最后更新:2026-10-20");
  });
});

/* ------------------------------------------------------------------ */
/* TurnRecord 构造与价值判定                                            */
/* ------------------------------------------------------------------ */

describe("C capture 入口判定", () => {
  const meta = { sessionId: "s", cwd: "/tmp/x", date: "2026-10-20", ts: "2026-10-20T10:00:00.000Z" };

  test("C1 从消息构造记录：过滤召回消息、识别工具成败与文件", () => {
    const messages: Message[] = [
      { role: "system", content: "【记忆召回·自动】历史召回" },
      { role: "user", content: "帮我修 hotkeys" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "1", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "src/hotkeys.ts", old_string: "a", new_string: "b" }) } },
          { id: "2", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "bun test" }) } },
        ],
      },
      { role: "tool", tool_call_id: "1", name: "edit_file", content: "已修改" },
      { role: "tool", tool_call_id: "2", name: "shell", content: "错误: 命令失败" },
      { role: "assistant", content: "修好了：热键挂到 input 流。" },
    ];
    const r = buildTurnRecord({ kind: "turn", messages, turn: 1 }, meta);
    expect(r.user).toBe("帮我修 hotkeys");
    expect(r.answer).toContain("修好了");
    expect(r.filesTouched).toEqual(["src/hotkeys.ts"]);
    const edit = r.tools.find((t) => t.name === "edit_file");
    const shell = r.tools.find((t) => t.name === "shell");
    expect(edit?.ok).toBe(true);
    expect(shell?.ok).toBe(false);
    expect(r.tools.length).toBe(2);
  });

  test("C2 脱敏：密钥不进 journal", () => {
    const messages: Message[] = [
      { role: "user", content: "key 是 sk-abcdefghijklmnopqrstuvwxyz012345" },
      { role: "assistant", content: "收到" },
    ];
    const r = buildTurnRecord({ kind: "turn", messages, turn: 1 }, meta);
    expect(r.user).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(r.user).toContain("[REDACTED");
  });

  test("C3 价值判定：工具≥2 / 文件 / 长文 / 信号词 / 纯寒暄不捕获", () => {
    const base = { tools: [], filesTouched: [], user: "你好", answer: "你好" };
    expect(shouldCapture({ kind: "turn", messages: [], turn: 1 }, rec(base), "boundary")).toBe(false);
    expect(shouldCapture({ kind: "turn", messages: [], turn: 1 }, rec({ ...base, tools: [{ name: "a", ok: true, digest: "" }, { name: "b", ok: true, digest: "" }] }), "boundary")).toBe(true);
    expect(shouldCapture({ kind: "turn", messages: [], turn: 1 }, rec({ ...base, filesTouched: ["a.ts"] }), "boundary")).toBe(true);
    expect(shouldCapture({ kind: "turn", messages: [], turn: 1 }, rec({ ...base, user: "决定用 B 方案，因为延迟低" }), "boundary")).toBe(true);
    expect(shouldCapture({ kind: "turn", messages: [], turn: 1 }, rec(base), "every_turn")).toBe(true);
    expect(shouldCapture({ kind: "turn", messages: [], turn: 1 }, rec(base), "off")).toBe(false);
    expect(shouldCapture({ kind: "aborted", messages: [], turn: 1 }, rec(base), "every_turn")).toBe(false);
    expect(shouldCapture({ kind: "compact", messages: [], turn: 1, summary: "摘要" }, rec(), "boundary")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* CaptureEngine 端到端（fake LLM）                                     */
/* ------------------------------------------------------------------ */

describe("D CaptureEngine", () => {
  function engineWith(responses: Array<StreamResult | Error>, opts: { mode?: "both" | "project" } = {}) {
    let i = 0;
    const calls: Message[][] = [];
    const engine = new CaptureEngine({
      cfg: makeCfg(),
      cwd: CWD,
      sessionId: "sess-1",
      scopeMode: opts.mode ?? "both",
      streamFn: async (_cfg, messages) => {
        calls.push(messages);
        const next = responses[Math.min(i, responses.length - 1)];
        i++;
        if (next instanceof Error) throw next;
        return next ?? fakeResult('{"ops":[]}');
      },
      now: () => new Date("2026-10-20T10:00:00.000Z"),
    });
    return { engine, calls };
  }

  const turnMessages = (): Message[] => [
    { role: "user", content: "我们决定采用方案 B 并修改了实现" },
    { role: "assistant", content: "已按方案 B 修改 src/agent.ts。" },
  ];

  test("D1 正常捕获：journal 先落盘 → 提炼 → 落页 → 审计", async () => {
    const { engine } = engineWith([
      jsonOps([
        {
          scope: "project",
          action: "create",
          page: "决策-方案B.md",
          summary: "采用方案 B",
          body: "采用方案 B，因为性能更好，已修改 src/agent.ts。",
          confidence: 0.9,
          inferred: false,
          evidence: "用户说「我们决定采用方案 B」",
        },
      ]),
    ]);
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 1 });
    await engine.flush(3000);
    const project = ensureScopeLayout("project", CWD);
    const text = readFileSync(join(project.pagesDir, "决策-方案B.md"), "utf8");
    expect(text).toContain("采用方案 B");
    const audits = readAudit(JOURNAL, 5);
    expect(audits.at(-1)?.status).toBe("applied");
    expect(audits.at(-1)?.applied).toBe(1);
    // journal 已落盘（先于提炼）
    expect(pendingRecords(JOURNAL, { limit: 10 }).length).toBe(0);
  });

  test("D2 非法 JSON：重试一次后放弃，审计 failed，不落页", async () => {
    const { engine, calls } = engineWith([fakeResult("不是 JSON"), fakeResult("还不是 JSON")]);
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 1 });
    await engine.flush(3000);
    expect(calls.length).toBe(2);
    const audits = readAudit(JOURNAL, 5);
    expect(audits.at(-1)?.status).toBe("failed");
    expect(existsSync(join(ensureScopeLayout("project", CWD).pagesDir, "决策-方案B.md"))).toBe(false);
  });

  test("D3 LLM 抛错：静默失败，不阻塞", async () => {
    const { engine } = engineWith([new Error("network down"), new Error("network down")]);
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 1 });
    await engine.flush(3000);
    expect(readAudit(JOURNAL, 5).at(-1)?.status).toBe("failed");
  });

  test("D4 重复捕获：第二次 deduped，不重复写", async () => {
    const opJson = {
      scope: "project",
      action: "create",
      page: "决策-去重.md",
      summary: "去重测试",
      body: "同一段需要去重的内容，长度足够通过校验。",
      confidence: 0.9,
      inferred: false,
      evidence: "我们决定采用方案 B",
    };
    const { engine } = engineWith([jsonOps([opJson]), jsonOps([{ ...opJson, action: "append" }])]);
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 1 });
    await engine.flush(3000);
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 2 });
    await engine.flush(3000);
    const text = readFileSync(join(ensureScopeLayout("project", CWD).pagesDir, "决策-去重.md"), "utf8");
    expect(text.split("同一段需要去重的内容").length - 1).toBe(1);
    const audits = readAudit(JOURNAL, 10);
    expect(audits.some((a) => a.status === "applied" || a.status === "partial")).toBe(true);
  });

  test("D5 -p 单次模式（project scope）：不写用户级", async () => {
    const { engine } = engineWith(
      [
        jsonOps([
          {
            scope: "user",
            action: "create",
            page: "偏好-新偏好.md",
            summary: "用户偏好",
            body: "用户在测试中表达了新的偏好内容，长度足够。",
            confidence: 0.9,
            inferred: false,
            evidence: "我们决定采用方案 B",
          },
        ]),
      ],
      { mode: "project" },
    );
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 1 });
    await engine.flush(3000);
    // 提炼器仍可能给出 user op，但 project scope 下 merge 无 user 布局 → dropped
    const user = ensureScopeLayout("user", CWD, USER_ROOT);
    expect(existsSync(join(user.pagesDir, "偏好-新偏好.md"))).toBe(false);
  });

  test("D6 锁被占用：写 skipped 审计（回执不空等）、journal 保留可重试", async () => {
    const { engine } = engineWith([jsonOps([])]);
    const lockDir = join(JOURNAL, ".write.lock");
    mkdirSync(lockDir, { recursive: true });
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 1 });
    await engine.flush(3000);
    // 先释放锁，再断言（断言失败时不能把锁留给后续用例）
    rmSync(lockDir, { recursive: true, force: true });
    // 锁冲突给一条 skipped 回执，记录仍留在 journal 供下次重试
    const audits = readAudit(JOURNAL, 5);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.status).toBe("deferred");
    expect(audits[0]?.reasons[0]).toContain("写锁被占用");
    expect(pendingRecords(JOURNAL, { limit: 10 }).length).toBe(1);
  });

  test("D7 会话页面上限：超过 max_pages_per_session 后 skipped", async () => {
    const cfg = makeCfg();
    cfg.memory.autoCapture.maxPagesPerSession = 1;
    let i = 0;
    const engine = new CaptureEngine({
      cfg,
      cwd: CWD,
      sessionId: "sess-1",
      scopeMode: "both",
      streamFn: async () =>
        jsonOps([
          {
            scope: "project",
            action: "create",
            page: `决策-上限${i++}.md`,
            summary: "上限测试",
            body: "用于测试会话页面上限的内容，长度足够通过校验。",
            confidence: 0.9,
            inferred: false,
            evidence: "我们决定采用方案 B",
          },
        ]),
      now: () => new Date("2026-10-20T10:00:00.000Z"),
    });
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 1 });
    await engine.flush(3000);
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 2 });
    await engine.flush(3000);
    const audits = readAudit(JOURNAL, 10);
    expect(audits.some((a) => a.status === "skipped" && a.reasons.join().includes("上限"))).toBe(true);
  });

  test("D8 compact 捕获：摘要落页", async () => {
    const { engine } = engineWith([
      jsonOps([
        {
          scope: "project",
          action: "create",
          page: "进度-压缩摘要.md",
          summary: "压缩摘要",
          body: "压缩前的对话摘要，包含关键决策与改动文件路径信息。",
          confidence: 0.9,
          inferred: false,
          evidence: "对话摘要",
        },
      ]),
    ]);
    engine.captureCompact("对话摘要：决定了方案 B；改了 src/agent.ts。", 1);
    await engine.flush(3000);
    expect(existsSync(join(ensureScopeLayout("project", CWD).pagesDir, "进度-压缩摘要.md"))).toBe(true);
  });

  test("D9 explicit 捕获：跳过价值判定直接写入", async () => {
    const { engine } = engineWith([
      jsonOps([
        {
          scope: "user",
          action: "append",
          page: USER_PAGE,
          summary: "用户偏好中文",
          body: "用户偏好中文回答，并且希望先给结论再给依据。",
          confidence: 0.9,
          inferred: false,
          evidence: "用户显式要求记住",
        },
      ]),
    ]);
    engine.captureExplicit("请记住：以后都用中文回答", 1, "user");
    await engine.flush(3000);
    const user = ensureScopeLayout("user", CWD, USER_ROOT);
    const text = readFileSync(join(user.pagesDir, USER_PAGE), "utf8");
    expect(text).toContain("用户偏好中文回答");
  });

  test("D10 journal 记录在提炼前已存在（崩溃可恢复）", () => {
    const { engine } = engineWith([fakeResult('{"ops":[]}')]);
    engine.capture({ kind: "turn", messages: turnMessages(), turn: 1 });
    // 不 flush：journal 已落盘
    const date = localDate(new Date("2026-10-20T10:00:00.000Z"));
    const path = join(JOURNAL, `${date}.jsonl`);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"kind":"turn"');
    void engine.flush(3000);
  });

  test("D12 空轮/中断轮也留审计（不再静默）", async () => {
    const { engine } = engineWith([fakeResult('{"ops":[]}')]);
    engine.capture({ kind: "turn", messages: [{ role: "user", content: "继续" }], turn: 1 });
    engine.capture({ kind: "aborted", messages: [], turn: 2 });
    await engine.flush(1000);
    const audits = engine.recentAudit(5);
    expect(audits.some((a) => a.status === "skipped" && a.reasons[0] === "价值判定未通过")).toBe(true);
    expect(audits.some((a) => a.status === "skipped" && a.reasons[0] === "aborted 轮次不提炼")).toBe(true);
  });

  test("D11 显式 remember：append 目标缺失 → 自动 create 并回执 applied", async () => {
    const { engine } = engineWith([
      jsonOps([
        {
          scope: "user",
          action: "append",
          page: "偏好-交付物版本管理.md",
          summary: "交付物版本保留偏好",
          body: "用户要求每一版报价都保留，绝不主动删除，清理由用户手动做。",
          inferred: false,
          evidence: "",
        },
      ]),
    ]);
    const receipt = engine.captureExplicit("请记住：每一版报价都保留，不能主动删", 1, "user");
    expect(receipt).not.toBeNull();
    const audit = await receipt!.done;
    expect(audit.status).toBe("applied");
    expect(audit.applied).toBe(1);
    const user = ensureScopeLayout("user", CWD, USER_ROOT);
    expect(existsSync(join(user.pagesDir, "偏好-交付物版本管理.md"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* remember 工具 / 清单 / flush 超时                                     */
/* ------------------------------------------------------------------ */

describe("E remember 工具与边界", () => {
  test("E1 合法调用转发 scope；短文本抛 ToolError", async () => {
    const calls: Array<{ body: string; scope?: "project" | "user" }> = [];
    const tool = makeRememberTool({
      remember: (body, scope) => {
        calls.push({ body, ...(scope ? { scope } : {}) });
        return Promise.resolve("已登记");
      },
    });
    const ctx = { cfg: makeCfg(), approve: async () => true };
    const r = await tool.execute(
      { text: "这个结论值得长期记住，因为每次发布都会用到", scope: "project" },
      ctx,
    );
    expect(r).toBe("已登记");
    expect(calls.length).toBe(1);
    expect(calls[0]?.scope).toBe("project");
    await expect(tool.execute({ text: "太短" }, ctx)).rejects.toThrow(/太短/);
    await expect(tool.execute({ text: "长度足够的记忆内容", scope: "bogus" }, ctx)).rejects.toThrow(/scope/);
  });

  test("E2 collectInventory 覆盖双库且遵守 limit", () => {
    const project = ensureScopeLayout("project", CWD);
    writeFileSync(
      join(project.pagesDir, "踩坑-清单A.md"),
      `# 踩坑-清单A\n\n## 摘要\n\nA 摘要\n\n> 最后更新:${todayStamp()}\n`,
      "utf8",
    );
    const user = ensureScopeLayout("user", CWD, USER_ROOT);
    const all = collectInventory({ project, user });
    expect(all.some((i) => i.scope === "project" && i.page === "踩坑-清单A.md")).toBe(true);
    expect(all.some((i) => i.scope === "user" && i.page === USER_PAGE)).toBe(true);
    const limited = collectInventory({ project, user }, 1);
    expect(limited.length).toBe(1);
  });

  test("E3 flush 超时：提炼挂起时 flush 按超时返回，不阻塞", async () => {
    const engine = new CaptureEngine({
      cfg: makeCfg(),
      cwd: CWD,
      sessionId: "s",
      scopeMode: "both",
      // 永不 resolve：模拟网络挂起
      streamFn: () => new Promise<StreamResult>(() => {}),
      now: () => new Date("2026-10-20T10:00:00.000Z"),
    });
    engine.capture({
      kind: "turn",
      messages: [
        { role: "user", content: "我们决定采用方案 B" },
        { role: "assistant", content: "好" },
      ],
      turn: 1,
    });
    const t0 = Date.now();
    await engine.flush(80);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
