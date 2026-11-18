/**
 * 轮末按需后台 wiki 维护（issue #53）。
 *
 * 一段工作结束且**确实有 wiki 活**时，后台起一次 fast 档 worker 做 ingest / 体检收口，
 * 做完即退。不常驻第二会话、不走 hooks、不阻塞主循环，失败只降级。
 *
 * 「有活」的三个来源（Leo 拍板 1：先代码侧 lint，落页上真有可修问题才起 worker）：
 *  1. 本阶段显式 remember 过 → 对本阶段落页做一次代码侧 lint；
 *  2. raw/ 相对上次 ingest 快照有增删（只做增量，单次 ≤ AUTO_INGEST_MAX_FILES）；
 *  3. 上面 lint 在本阶段落页上发现 broken / nosummary / nostamp。
 * 都没有 → 零模型调用，直接返回。
 *
 * 互斥：worker 运行期间暂停 CaptureEngine 出队（记录已在 journal，结束后接着处理）；
 * 期间再触发只置一个 pending 标记，worker 结束后合并成 1 次再判。
 * 跨进程：worker 的 wiki_write 每次 withLock(journalDir/.write.lock)，超时静默放弃本轮。
 *
 * 本模块不碰 console、不碰 Agent：通知与派发都由组合根注入（见 src/cli/sessionStart.ts）。
 */
import { join } from "node:path";

import type { Config } from "../config.ts";
import { WikiLockBusyError } from "./locks.ts";
import { lintWiki, type LintIssue, type LintResult } from "../wiki/lint.ts";
import { resolveWikiLayout, type WikiLayout } from "../wiki/paths.ts";
import {
  AUTO_INGEST_MAX_FILES,
  buildIngestPrompt,
  loadIngestTemplate,
  rawDelta,
  readIngestState,
  writeIngestState,
  type RawDelta,
} from "../wiki/ingest.ts";
import { appendLog } from "../wiki/write.ts";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 自动增量编译的单次文件上限：超过只提示 /ingest（首次/全量必须手动）。单源在 wiki/ingest.ts。 */
export { AUTO_INGEST_MAX_FILES };

/**
 * worker 可见的工具（职责收窄，不是安全边界）。
 * 编译与体检只需要「读 + 检索 + 写回 wiki」，shell / write_file 一律不给。
 */
export const WIKI_WORKER_TOOLS: readonly string[] = [
  "wiki_search",
  "wiki_write",
  "read_file",
  "list_dir",
  "glob",
  "grep",
];

/** worker 墙钟上限（5 分钟）：超时按失败降级，不重试。 */
export const WIKI_WORKER_TIMEOUT_MS = 300_000;

/** worker 内 wiki_write 的写锁等待上限：超时放弃这一轮，下一轮再判。 */
export const WIKI_WORKER_LOCK_TIMEOUT_MS = 5_000;

/** 交给 worker 修的问题类型（orphan / lowlinks 不是「修一页」能解决的，永不派）。 */
const FIXABLE_KINDS = new Set<LintIssue["kind"]>(["broken", "nosummary", "nostamp"]);

/* ------------------------------------------------------------------ */
/* 纯判定                                                              */
/* ------------------------------------------------------------------ */

export interface MaintenanceSignals {
  /** 本轮被用户中止。 */
  aborted: boolean;
  /** 本轮处于规划态（/plan）：只读，不写 wiki。 */
  planning: boolean;
  /** cfg.memory.enabled。 */
  memoryEnabled: boolean;
  /** cfg.memory.autoMaintain !== false。 */
  autoMaintain: boolean;
  /** 有 wiki 骨架（resolveWikiLayout 非 null）。 */
  hasSkeleton: boolean;
  /** 已有 worker 在跑（只置 pending，不再派第二个）。 */
  workerRunning: boolean;
  /** raw/ 相对上次 ingest 快照的变化。 */
  raw: RawDelta;
  /** 代码侧 lint 收窄到本阶段落页后的问题。 */
  lintIssues: LintIssue[];
}

export interface MaintenanceDecision {
  /** 增量编译（只含本次要处理的 raw）。 */
  ingest?: { added: string[]; removed: string[] };
  /** 交给 worker 修的体检问题。 */
  lintFix?: LintIssue[];
  /** 给用户的一行提示（含「/ingest」）。 */
  hint?: string;
}

/**
 * 轮末判定：任一门不过 → null；否则按「ingest / lintFix / hint」组合出决策。
 * hint 可与 lintFix 同时出现（有活要干，但 raw 那部分得用户手动跑）。
 */
export function decideMaintenance(s: MaintenanceSignals): MaintenanceDecision | null {
  if (s.aborted || s.planning) return null;
  if (!s.memoryEnabled || !s.autoMaintain) return null;
  if (!s.hasSkeleton || s.workerRunning) return null;

  const out: MaintenanceDecision = {};
  if (s.raw.kind === "incremental") {
    if (s.raw.added.length <= AUTO_INGEST_MAX_FILES) {
      out.ingest = { added: [...s.raw.added], removed: [...s.raw.removed] };
    } else {
      out.hint = `raw 有 ${s.raw.added.length} 份新增待编译（超过自动上限 ${AUTO_INGEST_MAX_FILES}），用 /ingest 手动编译`;
    }
  } else if (s.raw.kind === "needsFull") {
    out.hint = `raw 有 ${s.raw.pending} 份待编译（${s.raw.reason}），用 /ingest 手动编译`;
  }
  if (s.lintIssues.length > 0) out.lintFix = [...s.lintIssues];

  if (!out.ingest && !out.lintFix && !out.hint) return null;
  return out;
}

/**
 * 把全库 lint 结果收窄到「本阶段落过的页」。
 *
 * 只取 broken / nosummary / nostamp：
 *  - nosummary / nostamp：issue.page 就是出问题的页，必须在 pages 里；
 *  - broken：issue.page 是**被引用的目标**，要看 detail（引用者列表）里有没有本阶段落页。
 */
export function issuesOnPages(r: LintResult, pages: readonly string[]): LintIssue[] {
  if (pages.length === 0) return [];
  const want = new Set(pages);
  const out: LintIssue[] = [];
  for (const i of r.issues) {
    if (!FIXABLE_KINDS.has(i.kind)) continue;
    if (i.kind === "broken") {
      const srcs = (i.detail ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      if (srcs.some((s) => want.has(s))) out.push(i);
      continue;
    }
    if (want.has(i.page)) out.push(i);
  }
  return out;
}

/** 单条问题的修法说明（给 worker 看，不含任何对话正文）。 */
function fixHint(i: LintIssue): string {
  switch (i.kind) {
    case "nosummary":
      return "缺 `## 摘要` —— 在标题下补一节 `## 摘要`（2–4 句，写清这页在讲什么）";
    case "nostamp":
      return "缺日期戳 —— 补一行 `> 最后更新:YYYY-MM-DD`（用今天）";
    case "broken":
      return `断链 —— 目标页 \`${i.page}\` 不存在：改成指向已有页的链接，或删掉这条链接`;
    default:
      return "按 wiki 规范修正";
  }
}

/**
 * 体检收口任务描述：只含目录、页名与问题类型/修法，**不含任何对话正文**。
 * 要求 worker 只用 wiki_write 改这些页（它本来也只有白名单工具）。
 */
export function buildLintFixPrompt(layout: WikiLayout, issues: LintIssue[]): string {
  const lines: string[] = [];
  lines.push("你是 wiki 体检收口子代理。任务：只修下面列出的体检问题，不做别的整理。");
  lines.push("");
  lines.push(`- 主题页目录：<pages> = ${layout.pagesDir}`);
  lines.push("");
  lines.push("## 待修问题");
  lines.push("");
  for (const i of issues) {
    const who = i.kind === "broken" ? `[[${i.page}]]（被 ${i.detail ?? "?"} 引用）` : i.page;
    lines.push(`- ${i.kind}: ${who} —— ${fixHint(i)}`);
  }
  lines.push("");
  lines.push("## 约束");
  lines.push("");
  lines.push("- 只用 `wiki_write` 改上面这些页（先 read_file 读现状，再整页写回）；不要新建页、不要改 raw。");
  lines.push("- 只补/改问题涉及的最小范围，不要重写正文、不要改动无关段落。");
  lines.push("- 改完直接给一行结论（修了哪些页），不要复述页面内容。");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* 装配依赖                                                            */
/* ------------------------------------------------------------------ */

/** 维护器需要的记忆端口（MemoryBridge 满足它）。 */
export interface MaintainerMemoryPort {
  flush(timeoutMs?: number): Promise<void>;
  takePhaseSignals(): { explicitCount: number; touchedPages: string[] };
  pauseCapture(): void;
  resumeCapture(): void;
  /** flush 超时后捕获仍在处理（提炼还持着写锁）；可选，缺省视为空闲。 */
  captureBusy?(): boolean;
}

export interface WikiMaintainerDeps {
  cfg: Config;
  memory: MaintainerMemoryPort;
  /** 派发后台任务（组合根接 BackgroundTasks.launch，kind:"wiki"）。 */
  launch: (job: { label: string; run: (signal: AbortSignal) => Promise<string> }) =>
    | { ok: true; id: string }
    | { ok: false; error: string };
  /** 真正干活：跑一次 fast 档 worker（生产实现见 src/cli/sessionStart.ts）。 */
  runWorker: (prompt: string, signal: AbortSignal) => Promise<string>;
  /** 一行 dim 回执（组合根接 ui.info）。 */
  notice: (msg: string) => void;
  /** worker 墙钟上限，缺省 WIKI_WORKER_TIMEOUT_MS。 */
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ */
/* 维护器                                                              */
/* ------------------------------------------------------------------ */

export class WikiMaintainer {
  private readonly deps: WikiMaintainerDeps;
  private busy = false;
  /** worker 跑期间又被触发过（合并成 1 次）。 */
  private pending = false;
  private lastTurn: { aborted: boolean; planning: boolean } | null = null;
  /** 上一轮因锁忙放弃的落页：留到下一轮再判。 */
  private carryPages: string[] = [];
  /** hint 每会话只提示一次。 */
  private hinted = false;
  private idleWaiters: Array<() => void> = [];

  constructor(deps: WikiMaintainerDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.busy;
  }

  /** 等当前 worker 结束（pending 的再判会另起一轮，不在此等待）。测试用。 */
  async idle(): Promise<void> {
    if (!this.busy) return;
    await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  /**
   * 轮末入口（fire-and-forget：调用方 `void` 掉即可，不得阻塞主循环）。
   * 内部所有异常都收敛在这里 —— 维护失败只降级，不冒到主循环。
   */
  async onTurnSettled(t: { aborted: boolean; planning: boolean }): Promise<void> {
    const cfg = this.deps.cfg;
    // 门先过：连信号都不取（否则会把本阶段信号丢掉）。
    if (!cfg.memory.enabled || cfg.memory.autoMaintain === false) return;
    if (t.aborted || t.planning) return;

    if (this.busy) {
      this.pending = true;
      this.lastTurn = t;
      return;
    }

    try {
      await this.deps.memory.flush();
    } catch {
      /* flush 超时/失败：继续判 —— 落到 journal 的记录下一轮还会处理 */
    }
    // flush 期间可能被另一次触发抢先起了 worker。
    if (this.busy) {
      this.pending = true;
      this.lastTurn = t;
      return;
    }
    // 捕获还在提炼（flush 按超时返回了）：worker 只在捕获空闲时起，本轮不取信号，下一轮再判。
    if (this.deps.memory.captureBusy?.()) return;

    const layout = resolveWikiLayout(cfg.cwd);
    if (!layout) {
      // 没有骨架：取走信号丢弃，避免下一轮把它们当成「本阶段」的活。
      this.deps.memory.takePhaseSignals();
      return;
    }

    const phase = this.deps.memory.takePhaseSignals();
    const pages = [...new Set([...this.carryPages, ...phase.touchedPages])];
    this.carryPages = [];

    let lintIssues: LintIssue[] = [];
    if (phase.explicitCount > 0 || pages.length > 0) {
      // 代码侧 lint（零模型成本）：只有落页上真有可修问题才起 worker。
      lintIssues = issuesOnPages(lintWiki(layout.pagesDir), pages);
    }

    const decision = decideMaintenance({
      aborted: t.aborted,
      planning: t.planning,
      memoryEnabled: cfg.memory.enabled,
      autoMaintain: true,
      hasSkeleton: true,
      // 走到这里 busy 必为 false（上面两次提前返回已挡掉），显式传 false 让收窄可见。
      workerRunning: false,
      raw: rawDelta(layout),
      lintIssues,
    });
    if (!decision) return;

    if (decision.hint && !this.hinted) {
      this.hinted = true;
      this.deps.notice(`· ${decision.hint}`);
    }
    if (!decision.ingest && !decision.lintFix) return;

    const ingestCount = decision.ingest?.added.length ?? 0;
    const lintCount = decision.lintFix?.length ?? 0;
    const parts: string[] = [];
    if (ingestCount > 0) parts.push(`ingest ${ingestCount} 份`);
    if (lintCount > 0) parts.push(`lint ${lintCount} 项`);
    const label = `wiki 维护：${parts.join(" · ")}`;

    this.busy = true;
    this.deps.memory.pauseCapture();
    const r = this.deps.launch({
      label,
      run: (signal) => this.runJob({ layout, decision, pages, signal }),
    });
    if (!r.ok) {
      // 派发失败：复位，落页留到下一轮（不丢活）。
      this.busy = false;
      this.deps.memory.resumeCapture();
      this.carryPages = pages;
      this.wakeIdle();
      return;
    }
    // 不等 worker：这就是「后台」的全部含义。
  }

  /* ---------------------------------------------------------------- */

  /** worker 主体：超时/取消合并成一个 signal，成功才写快照与 log。 */
  private async runJob(args: {
    layout: WikiLayout;
    decision: MaintenanceDecision;
    pages: string[];
    signal: AbortSignal;
  }): Promise<string> {
    const { layout, decision, pages } = args;
    const timeoutMs = this.deps.timeoutMs ?? WIKI_WORKER_TIMEOUT_MS;
    const ctrl = new AbortController();
    let timedOut = false;
    let aborted = false;
    const onOuterAbort = (): void => {
      aborted = true;
      ctrl.abort();
    };
    if (args.signal.aborted) onOuterAbort();
    else args.signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    // 定时器不该拖住进程退出（会话退出时 worker 随 cancelAll 取消）。
    (timer as unknown as { unref?: () => void }).unref?.();

    const prompt = this.buildPrompt(layout, decision);
    try {
      await this.deps.runWorker(prompt, ctrl.signal);
      return this.onSuccess(layout, decision, pages);
    } catch (e) {
      if (e instanceof WikiLockBusyError) {
        // 锁忙不是失败：静默放弃本轮，落页留到下一轮再判（任务记为 done）。
        this.carryPages = pages;
        return "wiki 维护已跳过（写锁被占用，下一轮再判）";
      }
      const reason = timedOut ? "超时" : aborted ? "取消" : ((e as Error)?.message ?? String(e));
      this.deps.notice(`· wiki 维护失败（已降级）：${reason}`);
      try {
        appendLog(layout, "wiki", `自动维护失败（已降级）：${reason}`);
      } catch {
        /* log 写不进去也不能再抛 */
      }
      throw e instanceof Error ? e : new Error(reason);
    } finally {
      clearTimeout(timer);
      args.signal.removeEventListener("abort", onOuterAbort);
      this.busy = false;
      this.deps.memory.resumeCapture();
      const again = this.pending;
      const turn = this.lastTurn;
      this.pending = false;
      this.lastTurn = null;
      this.wakeIdle();
      if (again && turn) {
        // 合并成 1 次：用最近一次触发的入参再判一轮（不 await，避免自等待）。
        void this.onTurnSettled(turn).catch(() => {});
      }
    }
  }

  /** 成功收尾：写快照（不 finishIngest）、登 log、打回执。 */
  private onSuccess(layout: WikiLayout, decision: MaintenanceDecision, pages: string[]): string {
    const parts: string[] = [];
    if (decision.ingest) {
      const { added, removed } = decision.ingest;
      // 只把「本次计划内的增删」记进快照：worker 跑期间新增的 raw 不能被当成已编译。
      const prev = readIngestState(layout)?.lastRawFiles ?? [];
      const next = [...new Set([...prev, ...added])].filter((f) => !removed.includes(f)).sort();
      try {
        writeIngestState(layout, next);
      } catch {
        /* 快照写失败：下一轮会再判一次增量，不会丢活 */
      }
      if (added.length > 0) {
        try {
          appendLog(layout, "ingest", `自动增量编译 ${added.length} 份 raw`);
        } catch {
          /* 同上 */
        }
        parts.push(`ingest ${added.length} 份`);
      }
    }
    if (decision.lintFix && decision.lintFix.length > 0) {
      const k = decision.lintFix.length;
      let left = 0;
      try {
        left = issuesOnPages(lintWiki(layout.pagesDir), pages).length;
      } catch {
        left = 0;
      }
      try {
        appendLog(layout, "lint", `自动体检：本阶段 ${k} 项，剩 ${left} 项`);
      } catch {
        /* 同上 */
      }
      parts.push(`lint 剩 ${left} 项`);
    }
    const text = parts.length > 0 ? `wiki 维护：${parts.join(" · ")}` : "wiki 维护：无变更";
    this.deps.notice(`· ${text}`);
    return text;
  }

  /** 组装 worker 任务：ingest 部分（增量）+ 体检部分，只含任务参数。 */
  private buildPrompt(layout: WikiLayout, decision: MaintenanceDecision): string {
    const blocks: string[] = [];
    if (decision.ingest) {
      let template = "";
      try {
        template = loadIngestTemplate();
      } catch {
        template = "你是 wiki 编译子代理。任务：把 raw/ 里的新素材编译进 wiki/ 主题页。";
      }
      blocks.push(
        buildIngestPrompt(
          layout,
          {
            mode: "incremental",
            reason: "自动增量（轮末后台维护）",
            needsAnnounce: false,
            files: decision.ingest.added,
            removed: decision.ingest.removed,
            allRawFiles: [],
          },
          template,
        ),
      );
    }
    if (decision.lintFix && decision.lintFix.length > 0) {
      blocks.push(buildLintFixPrompt(layout, decision.lintFix));
    }
    return blocks.join("\n\n---\n\n");
  }

  private wakeIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}

/** worker 的写锁目录（与 CaptureEngine 同一把锁：journalDir/.write.lock）。 */
export function wikiWorkerLockDir(cfg: Config): string {
  return join(cfg.memory.journalDir, ".write.lock");
}
