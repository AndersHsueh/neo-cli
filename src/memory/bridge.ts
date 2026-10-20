/**
 * bridge.ts — 记忆服务外壳（v0.2 记忆激活 §7.8.1）。
 *
 * 组合根只与 MemoryBridge 打交道；Agent 只依赖 MemoryPort 接口。
 * 本文件负责：
 *  - 读取链路：启动画像注入（R0）、每轮召回（R1）、人工检索（/memory recall）；
 *  - 写入链路：把 Agent 的捕获输入交给 CaptureEngine；
 *  - 命令面：status / list / why / forget / migrate / lint；
 *  - -p 单次模式：**只用项目级记忆**（服务器脚本场景，避免混入操作员个人记忆）。
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { chatStream, estimateTokens, type Message } from "../llm.ts";
import { appendLog, removeIndexRow, syncIndex, todayStamp, writeAtomic } from "../wiki/write.ts";
import { lintWiki, formatLintReport } from "../wiki/lint.ts";
import type { WikiLayout } from "../wiki/paths.ts";
import type { MemoryPort, RecallTrace, TurnCaptureInput } from "./port.ts";
import { buildRecall, extractPageSummary, recallMessage, toTrace } from "./recall.ts";
import { CaptureEngine } from "./capture.ts";
import {
  ensureScopeLayout,
  isInside,
  resolveScopeLayout,
} from "./layout.ts";
import { readAudit } from "./journal.ts";
import { USER_FACT_HEADING, USER_INFER_HEADING } from "./merge.ts";

export type MemorySessionMode = "interactive" | "oneshot";

export interface MemoryBridgeOptions {
  cfg: Config;
  cwd: string;
  sessionId: string;
  mode: MemorySessionMode;
  /** plan 模式禁止写入（/remember 也会被拒），召回仍可用。 */
  captureEnabled: boolean;
  streamFn?: typeof chatStream;
  onNotice?: (msg: string) => void;
  onDebug?: (msg: string) => void;
}

const SCHEMA_SKIP = new Set(["INDEX.md", "index.md", "log.md", "AGENTS.md"]);

export class MemoryBridge implements MemoryPort {
  private readonly engine: CaptureEngine;
  private lastTrace: RecallTrace | null = null;
  private lastRecallText: string | null = null;
  /** 显式记忆的轮次计数（审计用；与 Agent 的 turn 序号独立）。 */
  private explicitTurn = 0;

  constructor(private readonly opts: MemoryBridgeOptions) {
    this.engine = new CaptureEngine({
      cfg: opts.cfg,
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      streamFn: opts.streamFn ?? chatStream,
      scopeMode: opts.mode === "oneshot" ? "project" : "both",
      ...(opts.onNotice ? { onNotice: opts.onNotice } : {}),
      ...(opts.onDebug ? { onDebug: opts.onDebug } : {}),
    });
  }

  /* ------------------------------------------------------------------ */
  /* 读取链路                                                            */
  /* ------------------------------------------------------------------ */

  /** R0：启动注入用户画像摘要（-p 单次模式不读用户级）。 */
  async startup(): Promise<{ message: Message; tokens: number } | null> {
    const mem = this.opts.cfg.memory;
    if (!mem.enabled || this.opts.mode === "oneshot") return null;
    const profile = this.readProfile();
    if (!profile) return null;
    const text = this.renderProfile(profile.content, profile.path);
    const tokens = estimateTokens([{ role: "system", content: text }]);
    return { message: { role: "system", content: text }, tokens };
  }

  /** R1：每轮开始前的自动召回。返回 null = 无命中/未启用，不注入。 */
  async recall(input: string): Promise<{ message: Message; trace: RecallTrace } | null> {
    const cfg = this.opts.cfg;
    const mem = cfg.memory;
    if (!mem.enabled || !mem.autoRecall.enabled) return null;

    const projectOnly = this.opts.mode === "oneshot";
    const layouts = {
      project: resolveScopeLayout("project", this.opts.cwd),
      user: projectOnly ? null : resolveScopeLayout("user", this.opts.cwd, mem.userWikiDir),
    };
    if (!layouts.project && !layouts.user) return null;

    const result = buildRecall(layouts, input, {
      projectPages: mem.autoRecall.projectPages,
      userPages: mem.autoRecall.userPages,
      maxTokens: mem.autoRecall.maxTokens,
      projectOnly,
    });
    const trace = toTrace(result);
    this.lastTrace = trace;
    if (!result.text) {
      this.lastRecallText = null;
      return null;
    }
    this.lastRecallText = result.text;
    return { message: recallMessage(result.text), trace };
  }

  /** 启动时恢复上次进程遗留的 journal（有界，非阻塞）。 */
  recoverPending(): void {
    this.engine.recoverPending();
  }

  /* ------------------------------------------------------------------ */
  /* 写入链路                                                            */
  /* ------------------------------------------------------------------ */

  capture(input: TurnCaptureInput): void {
    if (!this.writeAllowed()) return;
    this.engine.capture(input);
  }

  captureCompact(summary: string, turn: number): void {
    if (!this.writeAllowed()) return;
    this.engine.captureCompact(summary, turn);
  }

  /** 显式记忆（remember 工具 / /remember）。 */
  remember(body: string, hintScope?: "project" | "user"): string {
    if (!this.writeAllowed()) return "记忆写入当前不可用（plan 模式或记忆已关闭）。";
    if (this.opts.mode === "oneshot" && hintScope === "user") {
      return "单次模式（-p）只用项目级记忆，不能写用户级。";
    }
    this.explicitTurn += 1;
    // -p：即使 scope=auto 也强制项目级（否则提炼器可能判成 user，随后被合并器丢弃）
    const effective = this.opts.mode === "oneshot" ? "project" : hintScope;
    this.engine.captureExplicit(body, this.explicitTurn, effective);
    return hintScope
      ? `已登记到${hintScope === "user" ? "用户" : "项目"}记忆，稍后写入。`
      : "已登记到记忆，稍后由提炼器判断归属。";
  }

  async flush(timeoutMs?: number): Promise<void> {
    await this.engine.flush(timeoutMs);
  }

  /* ------------------------------------------------------------------ */
  /* 命令面                                                              */
  /* ------------------------------------------------------------------ */

  status(): string {
    const mem = this.opts.cfg.memory;
    const project = resolveScopeLayout("project", this.opts.cwd);
    const user = resolveScopeLayout("user", this.opts.cwd, mem.userWikiDir);
    const lines: string[] = [];
    lines.push(
      `记忆：${mem.enabled ? "开启" : "关闭"}（模式 ${this.opts.mode} · ` +
        `捕获 ${mem.autoCapture.enabled ? mem.autoCapture.mode : "off"} · ` +
        `召回 ${mem.autoRecall.enabled ? "on" : "off"}）`,
    );
    lines.push(`项目库：${project ? `${project.pagesDir}（${this.countPages(project)} 页）` : "未创建（首次写入时自动建）"}`);
    lines.push(`用户库：${user ? `${user.pagesDir}（${this.countPages(user)} 页）` : `${mem.userWikiDir}（未创建）`}`);
    const pending = this.engine.pendingCount;
    lines.push(`journal：${mem.journalDir}${pending > 0 ? `（${pending} 条待处理）` : ""}`);
    const audit = readAudit(mem.journalDir, 1)[0];
    if (audit) {
      lines.push(`最近写入：turn ${audit.turn} ${audit.status} +${audit.applied}（${audit.ts.slice(0, 19).replace("T", " ")}）`);
    }
    return lines.join("\n");
  }

  list(scope: "project" | "user" | "all" = "all"): string {
    const mem = this.opts.cfg.memory;
    const layouts: Array<["project" | "user", WikiLayout | null]> = [];
    if (scope !== "user") layouts.push(["project", resolveScopeLayout("project", this.opts.cwd)]);
    if (scope !== "project") layouts.push(["user", resolveScopeLayout("user", this.opts.cwd, mem.userWikiDir)]);
    const lines: string[] = [];
    for (const [name, layout] of layouts) {
      if (!layout) {
        lines.push(`[${name}] 未创建`);
        continue;
      }
      lines.push(`[${name}] ${layout.pagesDir}`);
      const pages = this.pageFiles(layout);
      if (pages.length === 0) lines.push("  （空）");
      for (const f of pages) {
        const text = this.readPage(layout, f) ?? "";
        const inferred = (text.match(/（推断/g) ?? []).length;
        lines.push(`  - ${f}｜${extractPageSummary(text).slice(0, 60)}${inferred > 0 ? `｜推断 ${inferred}` : ""}`);
      }
    }
    return lines.join("\n");
  }

  /** 人工检索（/memory recall），双桶 + 项目优先。 */
  recallForHuman(query: string): string {
    const mem = this.opts.cfg.memory;
    const projectOnly = this.opts.mode === "oneshot";
    const layouts = {
      project: resolveScopeLayout("project", this.opts.cwd),
      user: projectOnly ? null : resolveScopeLayout("user", this.opts.cwd, mem.userWikiDir),
    };
    const r = buildRecall(layouts, query, {
      projectPages: 5,
      userPages: 5,
      maxTokens: 2000,
      projectOnly,
    });
    if (!r.text) return `无命中：${query}`;
    return r.text;
  }

  /** 上次召回/写入的决策明细。 */
  why(): string {
    const mem = this.opts.cfg.memory;
    const lines: string[] = [];
    const audits = readAudit(mem.journalDir, 5).reverse();
    if (audits.length === 0) lines.push("尚无写入记录。");
    else {
      lines.push("最近写入：");
      for (const a of audits) {
        lines.push(
          `  #${a.turn} ${a.kind} → ${a.status}（写入 ${a.applied} / 丢弃 ${a.dropped}，${a.ms}ms）` +
            (a.reasons.length > 0 ? `\n      原因：${a.reasons.join("；")}` : ""),
        );
      }
    }
    if (this.lastTrace) {
      lines.push(
        `上次召回：${this.lastTrace.injected ? "已注入" : "未注入"}（${this.lastTrace.tokens} tokens）` +
          ` 关键词：${this.lastTrace.terms.join(", ") || "无"}`,
      );
      for (const h of this.lastTrace.hits) lines.push(`  [${h.scope}] ${h.page} score=${h.score}`);
    } else {
      lines.push("上次召回：无（本会话尚未触发）");
    }
    if (this.lastRecallText) lines.push(`召回全文：${this.lastRecallText.slice(0, 200)}…`);
    return lines.join("\n");
  }

  /** 删除某页记忆（同时删 INDEX 行 + log 登记）。 */
  forget(scope: "project" | "user", page: string): string {
    if (!this.writeAllowed()) return "plan 模式禁止删除记忆。";
    const mem = this.opts.cfg.memory;
    const layout = resolveScopeLayout(scope, this.opts.cwd, mem.userWikiDir);
    if (!layout) return `${scope} 记忆库不存在。`;
    if (!/^[^/\\]+\.md$/.test(page)) return `页名非法：${page}`;
    const target = join(layout.pagesDir, page);
    if (!isInside(layout.pagesDir, target)) return "页名越界。";
    if (!existsSync(target)) return `页面不存在：${page}`;
    try {
      rmSync(target);
      removeIndexRow(layout, page.replace(/\.md$/, ""));
      appendLog(layout, "wiki", `记忆删除：${scope}/${page}`);
      return `已删除 ${scope}/${page}`;
    } catch (e) {
      return `删除失败：${(e as Error).message}`;
    }
  }

  /**
   * 旧用户级记忆（~/.neo/memorys + profile.md）迁移到用户 wiki（幂等、非破坏）。
   * v0.1.12 清理后旧实现已删除，仅保留这条数据迁移路径。
   */
  migrate(): string {
    if (!this.writeAllowed()) return "plan 模式禁止迁移。";
    const mem = this.opts.cfg.memory;
    const lines: string[] = [];
    const user = ensureScopeLayout("user", this.opts.cwd, mem.userWikiDir);
    lines.push(`用户库：${user.pagesDir}`);

    // 1) profile.md → 用户画像.md
    const legacyProfile = join(mem.userLevelDir, "profile.md");
    const profilePage = join(user.pagesDir, "用户画像.md");
    if (existsSync(legacyProfile) && !existsSync(profilePage)) {
      const raw = readFileSync(legacyProfile, "utf8").trim();
      const summary = raw.split("\n").map((l) => l.trim()).find((l) => l) ?? "由旧 profile 迁移";
      const body = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => (l.startsWith("-") ? l : `- ${l}`))
        .join("\n");
      writeAtomic(
        profilePage,
        [
          "# 用户画像",
          "",
          "## 摘要",
          "",
          summary.slice(0, 120),
          "",
          `> 最后更新:${todayStamp()}`,
          "> 来源:legacy profile.md 迁移",
          "",
          USER_FACT_HEADING,
          "",
          body || "- （旧 profile 为空）",
          "",
          USER_INFER_HEADING,
          "",
        ].join("\n"),
      );
      // 迁移页同样要进 INDEX / log：否则 /memory list 与召回看不到它
      syncIndex(user, "用户画像", summary.slice(0, 120));
      appendLog(user, "wiki", "迁移：profile.md → 用户画像.md");
      lines.push(`已迁移 profile.md → 用户画像.md（${raw.length} 字）`);
    } else if (existsSync(profilePage)) {
      lines.push("用户画像.md 已存在，跳过 profile 迁移");
    } else {
      lines.push("无 profile.md，跳过");
    }

    // 2) ~/.neo/memorys/raw/*.md → raw/legacy-memorys.md（归档，不逐条建页）
    const legacyRaw = join(mem.userLevelDir, "raw");
    const archive = join(user.rawDir, "legacy-memorys.md");
    if (existsSync(legacyRaw) && !existsSync(archive)) {
      let files: string[] = [];
      try {
        files = readdirSync(legacyRaw).filter((f) => f.endsWith(".md")).sort();
      } catch {
        files = [];
      }
      const rows = files.map((f) => {
        const text = readFileSync(join(legacyRaw, f), "utf8");
        const summary = /^summary:\s*(.*)$/m.exec(text)?.[1] ?? "";
        const cwd = /^cwd:\s*(.*)$/m.exec(text)?.[1] ?? "";
        return `- ${f}｜${summary.slice(0, 120)}｜cwd=${cwd}`;
      });
      writeAtomic(
        archive,
        [
          "# 旧用户级记忆归档（~/.neo/memorys/raw）",
          "",
          `> 迁移时间:${todayStamp()}。原级索引信噪比过低，仅归档备查，不进入主题页。`,
          "",
          ...(rows.length > 0 ? rows : ["- （空）"]),
          "",
        ].join("\n"),
      );
      lines.push(`已归档旧 raw 索引 ${files.length} 条 → raw/legacy-memorys.md`);
    } else if (existsSync(archive)) {
      lines.push("legacy-memorys.md 已存在，跳过归档");
    } else {
      lines.push("无旧 raw 索引，跳过");
    }

    // 3) 迁移标记（不删旧数据）
    try {
      mkdirSync(mem.userLevelDir, { recursive: true });
      writeFileSync(
        join(mem.userLevelDir, ".migrated-v2"),
        JSON.stringify({ at: new Date().toISOString(), userWikiDir: mem.userWikiDir }) + "\n",
        "utf8",
      );
      lines.push(`已写迁移标记 ${join(mem.userLevelDir, ".migrated-v2")}（旧数据未删除）`);
    } catch (e) {
      lines.push(`迁移标记写入失败：${(e as Error).message}`);
    }
    lines.push("记忆管线的自动写入从本版本起只使用 .neo/wiki 与 ~/.neo/wiki。");
    return lines.join("\n");
  }

  /** 用户级 wiki 轻量体检（复用项目 lint，独立入口，不并进 /wiki-lint）。 */
  lint(): string {
    const mem = this.opts.cfg.memory;
    const user = resolveScopeLayout("user", this.opts.cwd, mem.userWikiDir);
    if (!user) return `用户记忆库未创建：${mem.userWikiDir}`;
    const r = lintWiki(user.pagesDir);
    const s = r.summary;
    const total = s.broken + s.orphans + s.lowlinks + s.nosummary + s.nostamp;
    return `${formatLintReport(r)}\n${total === 0 ? "用户记忆体检通过。" : `共 ${total} 项待处理`}`;
  }

  /** 最近审计（测试/命令用）。 */
  recentAudit(limit = 5) {
    return readAudit(this.opts.cfg.memory.journalDir, limit);
  }

  get lastRecallTrace(): RecallTrace | null {
    return this.lastTrace;
  }

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  private writeAllowed(): boolean {
    return this.opts.cfg.memory.enabled && this.opts.captureEnabled;
  }

  private pageFiles(layout: WikiLayout): string[] {
    try {
      return readdirSync(layout.pagesDir)
        .filter((f) => f.endsWith(".md") && !SCHEMA_SKIP.has(f))
        .sort();
    } catch {
      return [];
    }
  }

  private countPages(layout: WikiLayout): number {
    return this.pageFiles(layout).length;
  }

  private readPage(layout: WikiLayout, page: string): string | null {
    try {
      return readFileSync(join(layout.pagesDir, page), "utf8");
    } catch {
      return null;
    }
  }

  private readProfile(): { content: string; path: string } | null {
    const mem = this.opts.cfg.memory;
    const user = resolveScopeLayout("user", this.opts.cwd, mem.userWikiDir);
    if (user) {
      const p = join(user.pagesDir, "用户画像.md");
      if (existsSync(p)) return { content: readFileSync(p, "utf8"), path: p };
    }
    // 兼容：尚未迁移的旧 profile.md 仍可作为画像来源
    const legacy = join(mem.userLevelDir, "profile.md");
    if (existsSync(legacy)) return { content: readFileSync(legacy, "utf8"), path: legacy };
    return null;
  }

  /** 把画像页渲染为注入块：摘要 + 事实要点，token 预算 ≤200。 */
  private renderProfile(content: string, path: string): string {
    // 画像常驻注入的硬预算：200 token（PRD §7.7.1；与旧 profileTokensLimit 无关）
    const budget = 200;
    const sections: string[] = [];
    const summary = extractPageSummary(content);
    if (summary) sections.push(summary);
    // 抽取「事实」段 bullet
    const factMatch = /^## 事实（用户明确表达）\s*\n([\s\S]*?)(?=\n## |\n*$)/m.exec(content);
    if (factMatch?.[1]) {
      const bullets = factMatch[1]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("-"))
        .slice(0, 12);
      if (bullets.length > 0) sections.push(bullets.join("\n"));
    }
    const inferredCount = (content.match(/（推断/g) ?? []).length;
    if (inferredCount > 0) sections.push(`（另有 ${inferredCount} 条推断待确认，仅作背景。）`);

    let body = sections.join("\n\n").trim();
    // token 截断：逐行收缩
    let lines = body.split("\n");
    while (lines.length > 1 && estimateTokens([{ role: "system", content: lines.join("\n") }]) > budget) {
      lines = lines.slice(0, -1);
    }
    body = lines.join("\n");
    if (!body) body = "（画像为空）";

    return [
      "## 用户画像",
      "",
      body,
      "",
      `> 来源：${path}（自动记忆；推断内容不得当作硬性要求）`,
    ].join("\n");
  }
}

/** 组合根工厂。 */
export function createMemoryBridge(opts: MemoryBridgeOptions): MemoryBridge {
  return new MemoryBridge(opts);
}

