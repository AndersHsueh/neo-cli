/**
 * issue #53：交互会话轮末按需后台 wiki 维护。
 *
 * 覆盖（方案 /workspace/neo-53-plan/plan.md 第 6 节 1–11，按 Leo 拍板调整）：
 *  W1  普通轮无活：decideMaintenance=null，不派 worker、零模型调用
 *  W2  aborted / 规划态 / 记忆关闭 / 无骨架 / auto_maintain=false 都不触发
 *  W3  有快照 + raw 新增 1 份：worker 启动，onTurnSettled 不等 worker；结束后快照更新、log 有 ingest
 *  W4  无快照 / 超上限 / 超 1 周：不派 worker，只一条 dim 提示（每会话一次）
 *  W5  remember 落页缺摘要 → 起 worker，prompt 只含该页体检问题、无对话正文；无问题不起
 *  W6  互斥：worker 跑时 CaptureEngine 暂停出队；同一记录只处理一次（见 memory-capture M 组）
 *  W7  worker 在跑再触发：不派第二个，结束后只再判一次；/ingest 单飞拒绝
 *  W8  白名单：schema 只剩名单内工具；调 shell / write_file 回「未知工具」且不落盘
 *  W9  worker 抛错 / 超时 / 取消：降级 dim + log，快照不更新，主会话不注入
 *  W10 -p 与 ACP 不构造 maintainer
 *  W11 P1：/ingest 子代理失败不 finishIngest
 *  W12 锁：worker 的 wiki_write 在锁被占时超时放弃；锁忙放弃本轮、下一轮再判
 *  W13 配置：memory.auto_maintain 默认 true，可关
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentIO } from "../src/agent.ts";
import { loadConfig, type Config, type ModelTier } from "../src/config.ts";
import { contentText, type Message, type StreamResult, type ToolCall, type ToolSpec } from "../src/llm.ts";
import {
  AUTO_INGEST_MAX_FILES,
  WIKI_WORKER_TOOLS,
  WikiMaintainer,
  buildLintFixPrompt,
  decideMaintenance,
  issuesOnPages,
  type MaintenanceSignals,
  type MaintainerMemoryPort,
  type WikiMaintainerDeps,
} from "../src/memory/wikiMaintainer.ts";
import { WikiLockBusyError } from "../src/memory/locks.ts";
import { lintWiki } from "../src/wiki/lint.ts";
import { readIngestState, writeIngestState, rawDelta } from "../src/wiki/ingest.ts";
import { resolveWikiLayout, type WikiLayout } from "../src/wiki/paths.ts";
import { BackgroundTasks } from "../src/tools/background.ts";
import { runSubagent } from "../src/tools/task.ts";
import { toolCallRejection } from "../src/tools/index.ts";
import { wikiWriteTool } from "../src/tools/wiki.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import { captureConsole } from "./helpers.ts";

const ROOT = mkdtempSync(join(tmpdir(), "neo-wiki-maint-"));
let seq = 0;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const STAMP = "2026-11-19";
const GOOD_PAGE = (name: string): string =>
  `# ${name}\n\n## 摘要\n\n一句话\n\n> 最后更新:${STAMP}\n\n## 正文\n\n内容\n`;
const NO_SUMMARY_PAGE = (name: string): string =>
  `# ${name}\n\n> 最后更新:${STAMP}\n\n## 正文\n\n这是本轮讨论里用户说的秘密正文以外的页面内容\n`;

interface Proj {
  cwd: string;
  layout: WikiLayout;
  journal: string;
}

/** 新项目沙箱：带 wiki 骨架（.neo/wiki/wiki + raw）。 */
function newProject(opts: { skeleton?: boolean } = {}): Proj {
  seq += 1;
  const cwd = join(ROOT, `p${seq}`);
  const journal = join(ROOT, `j${seq}`);
  mkdirSync(journal, { recursive: true });
  if (opts.skeleton !== false) {
    mkdirSync(join(cwd, ".neo", "wiki", "wiki"), { recursive: true });
    mkdirSync(join(cwd, ".neo", "wiki", "raw"), { recursive: true });
    writeFileSync(join(cwd, ".neo", "wiki", "wiki", "INDEX.md"), "# INDEX\n", "utf8");
    writeFileSync(join(cwd, ".neo", "wiki", "wiki", "log.md"), "# log\n", "utf8");
  } else {
    mkdirSync(cwd, { recursive: true });
  }
  const layout = resolveWikiLayout(cwd) ?? {
    pagesDir: join(cwd, ".neo", "wiki", "wiki"),
    rawDir: join(cwd, ".neo", "wiki", "raw"),
    kind: "neo" as const,
  };
  return { cwd, layout, journal };
}

function addRaw(p: Proj, rel: string): void {
  const f = join(p.layout.rawDir, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, "素材", "utf8");
}

function makeCfg(p: Proj, over: { enabled?: boolean; autoMaintain?: boolean } = {}): Config {
  return {
    cwd: p.cwd,
    memory: {
      enabled: over.enabled ?? true,
      autoMaintain: over.autoMaintain ?? true,
      journalDir: p.journal,
      userWikiDir: join(ROOT, "uw"),
      userLevelDir: join(ROOT, "ul"),
      quiet: true,
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false,
        mode: "off",
        modelTier: "fast",
        maxOpsPerTurn: 2,
        maxPagesPerSession: 8,
        minConfidence: 0.65,
        minInferredConfidence: 0.75,
        journalRetentionDays: 7,
        flushTimeoutMs: 3000,
      },
    },
  } as unknown as Config;
}

interface FakeMemory extends MaintainerMemoryPort {
  explicit: number;
  touched: string[];
  paused: number;
  resumed: number;
  flushes: number;
}

function fakeMemory(): FakeMemory {
  const m: FakeMemory = {
    explicit: 0,
    touched: [],
    paused: 0,
    resumed: 0,
    flushes: 0,
    async flush() {
      m.flushes += 1;
    },
    takePhaseSignals() {
      const out = { explicitCount: m.explicit, touchedPages: [...m.touched] };
      m.explicit = 0;
      m.touched = [];
      return out;
    },
    pauseCapture() {
      m.paused += 1;
    },
    resumeCapture() {
      m.resumed += 1;
    },
  };
  return m;
}

interface Deferred {
  prompt: string;
  signal: AbortSignal;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

/** 组装一个 maintainer：真 BackgroundTasks（kind:"wiki"）+ 可控 runWorker。 */
function harness(p: Proj, over: Partial<WikiMaintainerDeps> & { cfg?: Config } = {}) {
  const memory = fakeMemory();
  const notices: string[] = [];
  const workers: Deferred[] = [];
  const bg = new BackgroundTasks({
    run: () => Promise.reject(new Error("wiki 任务不该走默认 run")),
  });
  const launches: string[] = [];
  const deps: WikiMaintainerDeps = {
    cfg: over.cfg ?? makeCfg(p),
    memory,
    launch: (job) => {
      launches.push(job.label);
      const r = bg.launch({
        kind: "wiki",
        prompt: job.label,
        run: job.run,
        ctx: { cfg: over.cfg ?? makeCfg(p), approve: async () => false },
      });
      return r.ok ? { ok: true, id: r.job.id } : { ok: false, error: r.error };
    },
    runWorker: (prompt, signal) =>
      new Promise<string>((resolve, reject) => {
        workers.push({ prompt, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    notice: (m) => notices.push(m),
    ...over,
  };
  const maint = new WikiMaintainer(deps);
  return { maint, memory, notices, workers, bg, launches };
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: 超时");
    await tick(5);
  }
}

const baseSignals = (over: Partial<MaintenanceSignals> = {}): MaintenanceSignals => ({
  aborted: false,
  planning: false,
  memoryEnabled: true,
  autoMaintain: true,
  hasSkeleton: true,
  workerRunning: false,
  raw: { kind: "none" },
  lintIssues: [],
  ...over,
});

/* ------------------------------------------------------------------ */
/* W1 / W2：纯判定与门                                                   */
/* ------------------------------------------------------------------ */

describe("W1/W2 decideMaintenance 门与无活判定（#53）", () => {
  test("#53 W1 普通轮（无 remember、无落页、raw 无增删）→ null", () => {
    expect(decideMaintenance(baseSignals())).toBeNull();
  });

  test("#53 W2 aborted / 规划态 / 记忆关闭 / auto_maintain=false / 无骨架 / worker 在跑 → null", () => {
    const work = {
      raw: { kind: "incremental" as const, added: ["a.md"], removed: [] },
      lintIssues: [{ kind: "nosummary" as const, page: "x.md" }],
    };
    expect(decideMaintenance(baseSignals(work))).not.toBeNull();
    for (const gate of [
      { aborted: true },
      { planning: true },
      { memoryEnabled: false },
      { autoMaintain: false },
      { hasSkeleton: false },
      { workerRunning: true },
    ]) {
      expect(decideMaintenance(baseSignals({ ...work, ...gate }))).toBeNull();
    }
  });

  test("#53 W1 增量 ≤ 上限 → ingest；lint 问题 → lintFix；二者可并存", () => {
    const d = decideMaintenance(
      baseSignals({
        raw: { kind: "incremental", added: ["a.md"], removed: ["old.md"] },
        lintIssues: [{ kind: "nostamp", page: "x.md" }],
      }),
    );
    expect(d?.ingest).toEqual({ added: ["a.md"], removed: ["old.md"] });
    expect(d?.lintFix?.length).toBe(1);
    expect(d?.hint).toBeUndefined();
  });

  test("#53 W4 needsFull / 超上限 → 只有 hint（含 /ingest），不 ingest", () => {
    const full = decideMaintenance(baseSignals({ raw: { kind: "needsFull", pending: 3, reason: "无 ingest 快照" } }));
    expect(full?.ingest).toBeUndefined();
    expect(full?.hint).toContain("/ingest");
    const many = Array.from({ length: AUTO_INGEST_MAX_FILES + 1 }, (_, i) => `f${i}.md`);
    const over = decideMaintenance(baseSignals({ raw: { kind: "incremental", added: many, removed: [] } }));
    expect(over?.ingest).toBeUndefined();
    expect(over?.hint).toContain("/ingest");
    const atCap = many.slice(0, AUTO_INGEST_MAX_FILES);
    expect(decideMaintenance(baseSignals({ raw: { kind: "incremental", added: atCap, removed: [] } }))?.ingest?.added.length).toBe(
      AUTO_INGEST_MAX_FILES,
    );
  });
});

/* ------------------------------------------------------------------ */
/* rawDelta                                                             */
/* ------------------------------------------------------------------ */

describe("rawDelta（#53）", () => {
  test("#53 无快照：raw 空 → none；有文件 → needsFull", () => {
    const p = newProject();
    expect(rawDelta(p.layout).kind).toBe("none");
    addRaw(p, "a.md");
    const d = rawDelta(p.layout);
    expect(d.kind).toBe("needsFull");
    if (d.kind === "needsFull") {
      expect(d.pending).toBe(1);
      expect(d.reason).toContain("快照");
    }
  });

  test("#53 有快照：增删 → incremental；无变化 → none；快照超 1 周且有变化 → needsFull", () => {
    const p = newProject();
    addRaw(p, "a.md");
    addRaw(p, "old.md");
    writeIngestState(p.layout, ["a.md", "old.md"]);
    expect(rawDelta(p.layout).kind).toBe("none");
    addRaw(p, "sub/b.md");
    rmSync(join(p.layout.rawDir, "old.md"));
    const d = rawDelta(p.layout);
    expect(d).toEqual({ kind: "incremental", added: ["sub/b.md"], removed: ["old.md"] });
    const later = Date.now() + 8 * 24 * 3600 * 1000;
    const stale = rawDelta(p.layout, later);
    expect(stale.kind).toBe("needsFull");
    if (stale.kind === "needsFull") expect(stale.reason).toContain("1 周");
  });
});

/* ------------------------------------------------------------------ */
/* issuesOnPages / buildLintFixPrompt                                   */
/* ------------------------------------------------------------------ */

describe("代码侧 lint 收窄到本阶段落页（#53）", () => {
  test("#53 W5 只取本阶段落页上的 broken / nosummary / nostamp", () => {
    const p = newProject();
    writeFileSync(join(p.layout.pagesDir, "决策-新.md"), NO_SUMMARY_PAGE("决策-新") + "\n见 [[不存在的页]]\n", "utf8");
    writeFileSync(join(p.layout.pagesDir, "旧页.md"), "# 旧页\n\n无摘要无戳\n", "utf8");
    const r = lintWiki(p.layout.pagesDir);
    const mine = issuesOnPages(r, ["决策-新.md"]);
    const kinds = mine.map((i) => `${i.kind}:${i.page}`).sort();
    expect(kinds).toEqual(["broken:不存在的页", "nosummary:决策-新.md"]);
    // 旧页的问题不在本阶段 → 不交给 worker；orphan / lowlinks 永不交给 worker
    expect(mine.some((i) => i.page === "旧页.md")).toBe(false);
    expect(mine.some((i) => i.kind === "orphan" || i.kind === "lowlinks")).toBe(false);
  });

  test("#53 W5 lint prompt 只含页名与问题，不含对话正文", () => {
    const p = newProject();
    const prompt = buildLintFixPrompt(p.layout, [{ kind: "nosummary", page: "决策-新.md" }]);
    expect(prompt).toContain("决策-新.md");
    expect(prompt).toContain("## 摘要");
    expect(prompt).toContain(p.layout.pagesDir);
    expect(prompt).toContain("wiki_write");
  });
});

/* ------------------------------------------------------------------ */
/* WikiMaintainer：轮末触发                                              */
/* ------------------------------------------------------------------ */

describe("WikiMaintainer 轮末触发（#53）", () => {
  test("#53 W1 普通轮：不派 worker、不调用 runWorker、不暂停捕获", async () => {
    const p = newProject();
    const h = harness(p);
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    expect(h.launches.length).toBe(0);
    expect(h.workers.length).toBe(0);
    expect(h.memory.paused).toBe(0);
    expect(h.notices.length).toBe(0);
  });

  test("#53 W2 aborted / 规划态 / 记忆关闭 / auto_maintain=false / 无骨架 → 不触发", async () => {
    const cases: Array<{ p: Proj; cfg?: Config; turn: { aborted: boolean; planning: boolean } }> = [];
    const mk = (skeleton = true) => {
      const p = newProject({ skeleton });
      if (skeleton) {
        addRaw(p, "a.md");
        writeIngestState(p.layout, []);
      }
      return p;
    };
    const p1 = mk();
    cases.push({ p: p1, turn: { aborted: true, planning: false } });
    const p2 = mk();
    cases.push({ p: p2, turn: { aborted: false, planning: true } });
    const p3 = mk();
    cases.push({ p: p3, cfg: makeCfg(p3, { enabled: false }), turn: { aborted: false, planning: false } });
    const p4 = mk();
    cases.push({ p: p4, cfg: makeCfg(p4, { autoMaintain: false }), turn: { aborted: false, planning: false } });
    const p5 = mk(false);
    cases.push({ p: p5, turn: { aborted: false, planning: false } });
    for (const c of cases) {
      const h = harness(c.p, c.cfg ? { cfg: c.cfg } : {});
      h.memory.explicit = 1;
      h.memory.touched = ["x.md"];
      await h.maint.onTurnSettled(c.turn);
      expect(h.launches.length).toBe(0);
      expect(h.workers.length).toBe(0);
    }
  });

  test("#53 W3 有快照 + raw 新增 1 份：worker 启动，onTurnSettled 先返回；结束后快照更新、log 有 ingest", async () => {
    const p = newProject();
    addRaw(p, "a.md");
    writeIngestState(p.layout, ["a.md"]);
    addRaw(p, "new.md");
    const h = harness(p);
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    // 返回时 worker 还没结束：主循环不等
    expect(h.maint.running).toBe(true);
    expect(h.memory.flushes).toBe(1);
    expect(h.memory.paused).toBe(1);
    await until(() => h.workers.length === 1);
    expect(h.workers[0]!.prompt).toContain("new.md");
    expect(h.workers[0]!.prompt).toContain("增量");
    expect(readIngestState(p.layout)!.lastRawFiles).toEqual(["a.md"]);
    // /tasks 可见、kind:"wiki"
    const views = h.bg.list();
    expect(views.length).toBe(1);
    expect(views[0]!.kind).toBe("wiki");

    h.workers[0]!.resolve("编译完成");
    await h.maint.idle();
    expect(h.maint.running).toBe(false);
    expect(h.memory.resumed).toBe(1);
    expect(readIngestState(p.layout)!.lastRawFiles).toEqual(["a.md", "new.md"]);
    const log = readFileSync(join(p.layout.pagesDir, "log.md"), "utf8");
    expect(log).toMatch(/\] ingest \|/);
    expect(h.notices.some((n) => n.includes("wiki 维护") && n.includes("ingest 1"))).toBe(true);
    // collectFinished 不把 wiki 任务注入主会话
    expect(h.bg.collectFinished()).toEqual([]);
  });

  test("#53 W4 无快照：不派 worker，只一条 dim 提示；同会话不重复提示", async () => {
    const p = newProject();
    addRaw(p, "a.md");
    addRaw(p, "b.md");
    const h = harness(p);
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    expect(h.launches.length).toBe(0);
    expect(h.notices.length).toBe(1);
    expect(h.notices[0]).toContain("/ingest");
  });

  test("#53 W4 增量超上限：不派 worker，只提示 /ingest", async () => {
    const p = newProject();
    writeIngestState(p.layout, []);
    for (let i = 0; i <= AUTO_INGEST_MAX_FILES; i++) addRaw(p, `f${i}.md`);
    const h = harness(p);
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    expect(h.launches.length).toBe(0);
    expect(h.notices.length).toBe(1);
    expect(h.notices[0]).toContain("/ingest");
  });

  test("#53 W5 remember 落页缺摘要 → 起 worker，prompt 只含这一页问题；落页无问题 → 不起", async () => {
    const p = newProject();
    writeFileSync(join(p.layout.pagesDir, "决策-新.md"), NO_SUMMARY_PAGE("决策-新"), "utf8");
    writeFileSync(join(p.layout.pagesDir, "旧页.md"), "# 旧页\n\n无摘要\n", "utf8");
    const h = harness(p);
    h.memory.explicit = 1;
    h.memory.touched = ["决策-新.md"];
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await until(() => h.workers.length === 1);
    const prompt = h.workers[0]!.prompt;
    expect(prompt).toContain("决策-新.md");
    expect(prompt).not.toContain("旧页");
    expect(prompt).not.toContain("增量模式");
    h.workers[0]!.resolve("已补摘要");
    await h.maint.idle();
    const log = readFileSync(join(p.layout.pagesDir, "log.md"), "utf8");
    expect(log).toMatch(/\] lint \|/);

    // 落页没有问题：代码侧 lint 过一遍即止，零模型调用
    const q = newProject();
    writeFileSync(join(q.layout.pagesDir, "决策-好.md"), GOOD_PAGE("决策-好"), "utf8");
    const h2 = harness(q);
    h2.memory.explicit = 1;
    h2.memory.touched = ["决策-好.md"];
    await h2.maint.onTurnSettled({ aborted: false, planning: false });
    expect(h2.launches.length).toBe(0);
    expect(h2.workers.length).toBe(0);
  });

  test("#53 W6 flush 后捕获仍在处理（提炼未完）：本轮不起 worker、不取走信号，下一轮再判", async () => {
    const p = newProject();
    writeFileSync(join(p.layout.pagesDir, "决策-新.md"), NO_SUMMARY_PAGE("决策-新"), "utf8");
    let busy = true;
    const h = harness(p);
    h.memory.captureBusy = () => busy;
    h.memory.touched = ["决策-新.md"];
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    expect(h.launches.length).toBe(0);
    expect(h.memory.touched).toEqual(["决策-新.md"]);
    busy = false;
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await until(() => h.workers.length === 1);
    expect(h.workers[0]!.prompt).toContain("决策-新.md");
    h.workers[0]!.resolve("ok");
    await h.maint.idle();
  });

  test("#53 W7 worker 在跑时再触发两次：不派第二个；结束后只再判一次（跑期间新增的 raw 不被误记为已编译）", async () => {
    const p = newProject();
    writeIngestState(p.layout, []);
    addRaw(p, "a.md");
    const h = harness(p);
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await until(() => h.workers.length === 1);
    addRaw(p, "b.md");
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    expect(h.launches.length).toBe(1);
    expect(h.memory.flushes).toBe(1);
    h.workers[0]!.resolve("ok");
    // 快照只记本次计划内的 a.md；pending 合并成 1 次再判 → 发现 b.md → 第二个 worker
    await until(() => h.launches.length === 2);
    expect(h.memory.flushes).toBe(2);
    expect(h.workers[1]!.prompt).toContain("b.md");
    expect(readIngestState(p.layout)!.lastRawFiles).toEqual(["a.md"]);
    h.workers[1]!.resolve("ok");
    await h.maint.idle();
    expect(readIngestState(p.layout)!.lastRawFiles).toEqual(["a.md", "b.md"]);
    expect(h.launches.length).toBe(2);
    expect(h.memory.flushes).toBe(2);
  });

  test("#53 W9 worker 抛错：降级 dim + log，快照不更新，collectFinished 不含 wiki 任务", async () => {
    const p = newProject();
    writeIngestState(p.layout, []);
    addRaw(p, "a.md");
    const h = harness(p);
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await until(() => h.workers.length === 1);
    h.workers[0]!.reject(new Error("模型 500"));
    await h.maint.idle();
    expect(h.notices.some((n) => n.includes("wiki 维护失败（已降级）") && n.includes("模型 500"))).toBe(true);
    expect(readIngestState(p.layout)!.lastRawFiles).toEqual([]);
    expect(readFileSync(join(p.layout.pagesDir, "log.md"), "utf8")).toContain("自动维护失败");
    expect(h.bg.collectFinished()).toEqual([]);
    // 任务状态由 BackgroundTasks 在自己的 promise 链里落定，比 idle() 晚一个微任务。
    await until(() => h.bg.list()[0]!.status === "error");
    expect(h.bg.list()[0]!.status).toBe("error");
    expect(h.memory.resumed).toBe(1);
  });

  test("#53 W9 worker 超时：降级提示含「超时」，快照不更新", async () => {
    const p = newProject();
    writeIngestState(p.layout, []);
    addRaw(p, "a.md");
    const h = harness(p, { timeoutMs: 40 });
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await h.maint.idle();
    expect(h.notices.some((n) => n.includes("已降级") && n.includes("超时"))).toBe(true);
    expect(readIngestState(p.layout)!.lastRawFiles).toEqual([]);
  });

  test("#53 W9 /tasks cancel 取消 worker：降级提示含「取消」，快照不更新", async () => {
    const p = newProject();
    writeIngestState(p.layout, []);
    addRaw(p, "a.md");
    const h = harness(p);
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await until(() => h.workers.length === 1);
    expect(h.bg.cancel("all")).toBe(1);
    await h.maint.idle();
    expect(h.notices.some((n) => n.includes("已降级") && n.includes("取消"))).toBe(true);
    expect(readIngestState(p.layout)!.lastRawFiles).toEqual([]);
    expect(h.maint.running).toBe(false);
  });

  test("#53 W12 锁忙（WikiLockBusyError）：静默放弃本轮，不报错、快照不更新；落页留到下一轮再判", async () => {
    const p = newProject();
    writeFileSync(join(p.layout.pagesDir, "决策-新.md"), NO_SUMMARY_PAGE("决策-新"), "utf8");
    const h = harness(p);
    h.memory.touched = ["决策-新.md"];
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await until(() => h.workers.length === 1);
    h.workers[0]!.reject(new WikiLockBusyError("记忆写锁被占用"));
    await h.maint.idle();
    expect(h.notices.some((n) => n.includes("失败"))).toBe(false);
    expect(readFileSync(join(p.layout.pagesDir, "log.md"), "utf8")).not.toContain("自动维护失败");
    // 下一轮：没有新落页信号，也要把上一轮留下的页再判一次
    await h.maint.onTurnSettled({ aborted: false, planning: false });
    await until(() => h.workers.length === 2);
    expect(h.workers[1]!.prompt).toContain("决策-新.md");
    h.workers[1]!.resolve("ok");
    await h.maint.idle();
  });
});

/* ------------------------------------------------------------------ */
/* BackgroundTasks kind:"wiki"                                           */
/* ------------------------------------------------------------------ */

describe("BackgroundTasks kind:wiki（#53）", () => {
  const ctx = (): ToolCtx => ({ cfg: { cwd: "/tmp" } as unknown as Config, approve: async () => true });

  test("#53 wiki 任务不占 3 个并发名额、不注入、不落盘；/tasks 可见并带 wiki 标签", async () => {
    const bg = new BackgroundTasks({ run: () => new Promise<string>(() => {}) });
    let release: (v: string) => void = () => {};
    const w = bg.launch({
      kind: "wiki",
      prompt: "wiki 维护：ingest 1 份",
      ctx: ctx(),
      run: () => new Promise<string>((r) => (release = r)),
    });
    expect(w.ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(bg.launch({ prompt: `t${i}`, ctx: ctx() }).ok).toBe(true);
    expect(bg.launch({ prompt: "t4", ctx: ctx() }).ok).toBe(false);
    release("done");
    await tick();
    expect(bg.collectFinished()).toEqual([]);
    const { serializeJobs } = await import("../src/tools/background.ts");
    expect(serializeJobs(bg.rawJobs()).some((j) => j.prompt.startsWith("wiki 维护"))).toBe(false);

    const { dispatchCommand, wireCommands } = await import("../src/cli/commands.ts");
    wireCommands();
    const cap = captureConsole();
    await dispatchCommand("/tasks", {
      cfg: { cwd: "/tmp" } as unknown as Config,
      ui: cap.ui,
      tasks: { list: () => bg.list(), cancel: () => 0 },
    } as unknown as Parameters<typeof dispatchCommand>[1]);
    const text = cap.out();
    expect(text).toContain("wiki 维护：ingest 1 份");
    expect(text).toContain("[wiki]");
  });
});

/* ------------------------------------------------------------------ */
/* W8 白名单（schema + dispatch）                                        */
/* ------------------------------------------------------------------ */

function agentCfg(cwd: string): Config {
  const provider = {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: { default: "m-default", deep_reasoning: "m-deep", balanced: "m-bal", fast: "m-fast" } as Record<ModelTier, string>,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
  const route = { provider: "p1", model: null, fallbackAllowed: true };
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: "default",
    model: "m-default",
    providers: [provider],
    routes: { default: route, deep_reasoning: route, balanced: route, fast: route },
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 80,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    cwd,
    settingsPath: null,
    skillsStore: join(cwd, "skills"),
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 1000 },
    memory: {
      enabled: false,
      autoMaintain: true,
      userLevelDir: join(cwd, "mem"),
      userWikiDir: join(cwd, "uw"),
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

function silentIO(): AgentIO & { confirms: number } {
  const io = {
    confirms: 0,
    line(): void {},
    blank(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    toolHeader(): void {},
    toolResult(): void {},
    indent: (b: string) => b,
    startSpinner(): void {},
    updateSpinner(): void {},
    stopSpinner(): void {},
    beginStream(): void {},
    writeStream(): void {},
    endStream(): void {},
    ensureStreamClosed(): void {},
    async confirm(): Promise<boolean> {
      io.confirms += 1;
      return true;
    },
    width: 100,
  };
  return io as AgentIO & { confirms: number };
}

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function result(over: Partial<StreamResult>): StreamResult {
  return { content: "", reasoning: "", toolCalls: [], finishReason: "stop", usage: null, raw: null, ...over } as StreamResult;
}

describe("W8 白名单：schema 与 dispatch 两层（#53）", () => {
  test("#53 toolCallRejection：名单外拒绝（未知工具），名单内与无策略放行；deny 可复用（#84）", () => {
    expect(toolCallRejection("read_file", { allow: WIKI_WORKER_TOOLS })).toBeNull();
    expect(toolCallRejection("shell", { allow: WIKI_WORKER_TOOLS })).toContain("未知工具");
    expect(toolCallRejection("shell", {})).toBeNull();
    expect(toolCallRejection("remember", { deny: ["remember"] })).toContain("未知工具");
  });

  test("#53 W8 worker schema 只有白名单工具；调 shell / write_file 回「未知工具」，文件未被改", async () => {
    const cwd = join(ROOT, `w8-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const target = join(cwd, "evil.txt");
    const seenTools: string[][] = [];
    let step = 0;
    let toolMsgs: string[] = [];
    const stream = async (_c: Config, messages: Message[], tools: ToolSpec[]): Promise<StreamResult> => {
      seenTools.push(tools.map((t) => t.function.name));
      step += 1;
      if (step === 1) {
        return result({
          toolCalls: [
            tc("shell", { command: `echo x > ${target}` }),
            tc("write_file", { path: target, content: "x" }),
          ],
          finishReason: "tool_calls",
        });
      }
      toolMsgs = messages.filter((m) => m.role === "tool").map((m) => contentText(m.content) ?? "");
      return result({ content: "完成" });
    };
    const io = silentIO();
    const main = new Agent({ cfg: agentCfg(cwd), console: io, mode: "auto-all", systemPrompt: "main", chatStream: stream });
    const out = await runSubagent(main, "整理 wiki", "fast", { cfg: agentCfg(cwd), approve: async () => false }, undefined, undefined, {
      toolAllowlist: WIKI_WORKER_TOOLS,
      approve: async () => false,
    });
    expect(out).toContain("完成");
    for (const names of seenTools) {
      for (const n of names) expect(WIKI_WORKER_TOOLS).toContain(n);
      expect(names).toContain("read_file");
    }
    expect(toolMsgs.length).toBe(2);
    for (const t of toolMsgs) expect(t).toContain("未知工具");
    expect(existsSync(target)).toBe(false);
    expect(io.confirms).toBe(0);
  });

  test("#53 不传 allowlist 时子代理工具集不变（回归）", async () => {
    const cwd = join(ROOT, `w8b-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    let names: string[] = [];
    const stream = async (_c: Config, _m: Message[], tools: ToolSpec[]): Promise<StreamResult> => {
      names = tools.map((t) => t.function.name);
      return result({ content: "ok" });
    };
    const main = new Agent({ cfg: agentCfg(cwd), console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: stream });
    await runSubagent(main, "看看", "fast", { cfg: agentCfg(cwd), approve: async () => true });
    expect(names).toContain("shell");
    expect(names).toContain("write_file");
  });

  test("#53 failOnError：子代理 hadError 时 runSubagent 抛错（不当成功返回）", async () => {
    const cwd = join(ROOT, `w8c-${Date.now()}`);
    mkdirSync(cwd, { recursive: true });
    const stream = async (): Promise<StreamResult> => {
      throw new Error("上游 500");
    };
    const main = new Agent({ cfg: agentCfg(cwd), console: silentIO(), mode: "auto-all", systemPrompt: "main", chatStream: stream });
    await expect(
      runSubagent(main, "编译", "fast", { cfg: agentCfg(cwd), approve: async () => true }, undefined, undefined, { failOnError: true }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* W12 wiki_write 加锁（只在 ctx.wikiWriteLock 存在时）                    */
/* ------------------------------------------------------------------ */

describe("W12 worker 的 wiki_write 加锁（#53）", () => {
  test("#53 锁被占：wiki_write 等到超时 → 调 onTimeout 并抛错，页面不写", async () => {
    const p = newProject();
    const lockDir = join(p.journal, ".write.lock");
    mkdirSync(lockDir, { recursive: true });
    let timedOut = 0;
    const ctx: ToolCtx = {
      cfg: makeCfg(p),
      approve: async () => false,
      wikiWriteLock: { dir: lockDir, timeoutMs: 60, onTimeout: () => (timedOut += 1) },
    };
    const args = { action: "create", page: "锁测试.md", content: GOOD_PAGE("锁测试"), log_title: "锁被占时不写入" };
    await expect(Promise.resolve().then(() => wikiWriteTool.execute(args, ctx))).rejects.toThrow(/锁/);
    expect(timedOut).toBe(1);
    expect(existsSync(join(p.layout.pagesDir, "锁测试.md"))).toBe(false);
    rmSync(lockDir, { recursive: true, force: true });
  });

  test("#53 锁空闲：worker 的 wiki_write 正常写入并释放锁；无 wikiWriteLock 时行为不变", async () => {
    const p = newProject();
    const lockDir = join(p.journal, ".write.lock");
    const ctx: ToolCtx = {
      cfg: makeCfg(p),
      approve: async () => false,
      wikiWriteLock: { dir: lockDir, timeoutMs: 500 },
    };
    const out = await Promise.resolve(
      wikiWriteTool.execute(
        { action: "create", page: "锁测试.md", content: GOOD_PAGE("锁测试"), log_title: "锁空闲时正常写入" },
        ctx,
      ),
    );
    expect(String(out)).toContain("锁测试");
    expect(existsSync(lockDir)).toBe(false);
    const plain = await Promise.resolve(
      wikiWriteTool.execute(
        { action: "create", page: "无锁.md", content: GOOD_PAGE("无锁"), log_title: "无锁时行为不变" },
        { cfg: makeCfg(p), approve: async () => false },
      ),
    );
    expect(String(plain)).toContain("无锁");
  });
});

/* ------------------------------------------------------------------ */
/* W7 /ingest 单飞 + W11 P1 失败不 finishIngest                           */
/* ------------------------------------------------------------------ */

describe("/ingest 单飞与失败收口（#53）", () => {
  test("#53 W7 后台 wiki 维护在跑时 /ingest 拒绝并提示，不派子代理", async () => {
    const p = newProject();
    addRaw(p, "a.md");
    const { dispatchCommand, wireCommands } = await import("../src/cli/commands.ts");
    wireCommands();
    const cap = captureConsole();
    let calls = 0;
    const cfg = agentCfg(p.cwd);
    const main = new Agent({
      cfg,
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: async () => {
        calls += 1;
        return result({ content: "x" });
      },
    });
    await dispatchCommand("/ingest", {
      agent: main,
      cfg,
      ui: cap.ui,
      wikiMaintainer: { running: true },
    } as unknown as Parameters<typeof dispatchCommand>[1]);
    expect(cap.out()).toContain("后台");
    expect(cap.out()).toContain("wiki 维护");
    expect(calls).toBe(0);
    expect(readIngestState(p.layout)).toBeNull();
  });

  test("#53 W11 P1 /ingest 子代理失败：不 finishIngest、不登 ingest log", async () => {
    const p = newProject();
    addRaw(p, "a.md");
    const { dispatchCommand, wireCommands } = await import("../src/cli/commands.ts");
    wireCommands();
    const cap = captureConsole();
    const cfg = agentCfg(p.cwd);
    const main = new Agent({
      cfg,
      console: silentIO(),
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: async () => {
        throw new Error("上游 500");
      },
    });
    await dispatchCommand("/ingest", { agent: main, cfg, ui: cap.ui } as unknown as Parameters<typeof dispatchCommand>[1]);
    expect(readIngestState(p.layout)).toBeNull();
    expect(readFileSync(join(p.layout.pagesDir, "log.md"), "utf8")).not.toMatch(/\] ingest \|/);
    expect(cap.out()).toContain("失败");
  });
});

/* ------------------------------------------------------------------ */
/* W10 -p / ACP 不构造；repl 轮末接线                                       */
/* ------------------------------------------------------------------ */

describe("W10 接线范围（#53）", () => {
  const src = (rel: string): string => readFileSync(join(import.meta.dir, "..", rel), "utf8");

  test("#53 W10 -p（oneshot）与 ACP 不引用 WikiMaintainer；repl 轮末触发；sessionStart 只在交互会话构造", () => {
    expect(src("src/cli/oneshot.ts")).not.toMatch(/wikiMaintainer|WikiMaintainer/);
    for (const f of ["src/acp/session.ts", "src/acp/agent.ts"]) {
      if (existsSync(join(import.meta.dir, "..", f))) expect(src(f)).not.toMatch(/wikiMaintainer|WikiMaintainer/);
    }
    expect(src("src/cli/repl.ts")).toMatch(/wikiMaintainer\??\.onTurnSettled/);
    const start = src("src/cli/sessionStart.ts");
    expect(start).toMatch(/new WikiMaintainer/);
    expect(start).toMatch(/print === null|print !== null/);
  });
});

/* ------------------------------------------------------------------ */
/* W13 配置                                                              */
/* ------------------------------------------------------------------ */

describe("W13 memory.auto_maintain（#53）", () => {
  const saved = process.env["NEO_MEMORY_DISABLE"];
  beforeEach(() => {
    delete process.env["NEO_MEMORY_DISABLE"];
  });
  afterAll(() => {
    if (saved === undefined) delete process.env["NEO_MEMORY_DISABLE"];
    else process.env["NEO_MEMORY_DISABLE"] = saved;
  });

  test("#53 W13 默认 true；settings memory.auto_maintain=false 关闭", () => {
    const dir = join(ROOT, `cfg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const example = JSON.parse(readFileSync(join(import.meta.dir, "..", "settings.example.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...example, memory: {} }), "utf8");
    expect(loadConfig({}, { settingsDir: dir }).memory.autoMaintain).toBe(true);
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ ...example, memory: { auto_maintain: false } }), "utf8");
    expect(loadConfig({}, { settingsDir: dir }).memory.autoMaintain).toBe(false);
  });
});
