/**
 * capture.ts — 自动记忆捕获编排（v0.2 记忆激活 §7.6）。
 *
 * 链路：价值判定 → TurnRecord 落 journal（先落盘）→ 队列 → fast 档提炼
 *       → 硬规则校验 → 合并落页 → 审计 → 一行 dim 提示。
 *
 * 三条铁律：
 *  1. 先 journal 后 LLM：崩溃/超时都不丢原始素材，下次 flush 可重试；
 *  2. 任何失败只降级：绝不向 Agent 抛错、绝不阻塞用户输入；
 *  3. 不喂工具原始输出：只给用户话 + 助手结论 + 工具名/成败/路径（防注入、控 token）。
 */
import type { Config } from "../config.ts";
import { applyTier, isModelTier } from "../config.ts";
import { chatStream, contentText, type Message } from "../llm.ts";
import { join } from "node:path";
import { isRecallMessage, type TurnCaptureInput } from "./port.ts";
import {
  appendAudit,
  appendTurn,
  cleanupJournal,
  localDate,
  newRecordId,
  pendingRecords,
  readAudit,
  type AuditEntry,
  type TurnRecord,
  type TurnToolUse,
} from "./journal.ts";
import {
  buildDistillMessages,
  parseDistillJson,
  repairMessage,
  validateDistillOps,
} from "./distill.ts";
import { applyOps, collectInventory } from "./merge.ts";
import { ensureScopeLayout } from "./layout.ts";
import { releaseLock, tryAcquireLock } from "./locks.ts";
import { redactPII } from "./pii.ts";

/* ------------------------------------------------------------------ */
/* 依赖与选项                                                          */
/* ------------------------------------------------------------------ */

export interface CaptureDeps {
  cfg: Config;
  cwd: string;
  sessionId: string;
  /** 注入 LLM 流式函数（测试可脚本化；生产用 chatStream）。 */
  streamFn: typeof chatStream;
  /** both = 交互模式（项目+用户）；project = -p 单次模式（只用项目级记忆）。 */
  scopeMode: "both" | "project";
  onNotice?: (msg: string) => void;
  onDebug?: (msg: string) => void;
  now?: () => Date;
}

/** 价值判定信号词：出现即认为本轮值得沉淀（决策/坑/约定/偏好）。 */
const SIGNAL_WORDS =
  /(决定|方案|结论|约定|规范|以后|记住|不要再|默认|坑|根因|解决|修复|偏好|习惯|架构|设计|选择|采用)/;

const SKIP_TOOL_OUTPUT_PREFIX = /^(错误:|工具执行失败:|未知工具:|工具 .* 的参数不是合法 JSON)/;

/* ------------------------------------------------------------------ */
/* 一轮消息 → TurnRecord                                               */
/* ------------------------------------------------------------------ */

function flatten(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function toolDigest(name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawArgs || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return "";
  }
  const pick = (keys: string[]): string => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const detail =
    pick(["path", "file_path", "target", "command", "pattern", "query", "name", "prompt", "url"]) ||
    "";
  return flatten(detail, 120);
}

function touchedFiles(name: string, rawArgs: string): string[] {
  if (name !== "write_file" && name !== "edit_file") return [];
  try {
    const parsed: unknown = JSON.parse(rawArgs || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const p = (parsed as Record<string, unknown>)["path"];
    return typeof p === "string" && p.trim() ? [p.trim()] : [];
  } catch {
    return [];
  }
}

/** 从本轮消息构造 TurnRecord（已脱敏）。不包含临时召回消息。 */
export function buildTurnRecord(
  input: TurnCaptureInput,
  meta: { sessionId: string; cwd: string; date: string; ts: string },
  hintScope?: "project" | "user",
): TurnRecord {
  const msgs = input.messages.filter((m) => !isRecallMessage(m));

  let user = "";
  for (const m of msgs) {
    if (m.role !== "user") continue;
    const t = contentText(m.content) ?? "";
    if (t.trim()) user = flatten(t, 600);
  }

  let answer = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "assistant") continue;
    const t = contentText(m.content) ?? "";
    if (t.trim()) {
      answer = flatten(t, 2000);
      break;
    }
  }

  if (input.summary) answer = flatten(input.summary, 2000);

  const tools: TurnToolUse[] = [];
  const files: string[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.role !== "assistant" || !m.tool_calls?.length) continue;
    for (const call of m.tool_calls) {
      const name = call.function.name;
      // 找对应的 tool 结果，用输出前缀判断成败（dispatch 的失败输出有固定前缀）
      let ok = true;
      for (let j = i + 1; j < msgs.length; j++) {
        const r = msgs[j];
        if (!r || r.role !== "tool" || r.tool_call_id !== call.id) continue;
        const out = contentText(r.content) ?? "";
        ok = !SKIP_TOOL_OUTPUT_PREFIX.test(out.trim());
        break;
      }
      tools.push({ name, ok, digest: toolDigest(name, call.function.arguments) });
      files.push(...touchedFiles(name, call.function.arguments));
    }
  }

  const userSafe = redactPII(user).text;
  const answerSafe = redactPII(answer).text;

  return {
    v: 1,
    id: newRecordId(),
    ts: meta.ts,
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    kind: input.kind,
    turn: input.turn,
    user: userSafe,
    answer: answerSafe,
    tools: tools.slice(0, 12),
    filesTouched: [...new Set(files)].slice(0, 20),
    ...(hintScope ? { hintScope } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 价值判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * 是否值得捕获（零 LLM 成本的前置过滤）。
 * 返回 true 才落 journal；abort 轮直接 false（只调试可见，不提炼）。
 */
export function shouldCapture(
  input: TurnCaptureInput,
  rec: TurnRecord,
  mode: "off" | "boundary" | "every_turn",
): boolean {
  if (input.kind === "aborted") return false;
  if (mode === "off") return false;
  if (input.kind !== "turn") return true; // compact / explicit 一律捕获
  if (!rec.user) return false;

  if (mode === "every_turn") return rec.user.length > 0;
  if (rec.tools.length >= 2) return true;
  if (rec.filesTouched.length >= 1) return true;
  if (rec.user.length >= 80 && rec.answer.length >= 300) return true;
  if (SIGNAL_WORDS.test(rec.user) || SIGNAL_WORDS.test(rec.answer)) return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* 引擎                                                                */
/* ------------------------------------------------------------------ */

export class CaptureEngine {
  private queue: TurnRecord[] = [];
  private running: Promise<void> | null = null;
  /** 本会话已触碰的页面（max_pages_per_session 的上限依据）。 */
  private pagesTouched = new Set<string>();
  private lastNotice = "";

  constructor(private readonly deps: CaptureDeps) {}

  get pendingCount(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  get lastNoticeText(): string {
    return this.lastNotice;
  }

  /* ---------------- 入口 ---------------- */

  capture(input: TurnCaptureInput): void {
    try {
      const m = this.deps.cfg.memory;
      if (!m.enabled || !m.autoCapture.enabled) return;
      const now = this.deps.now?.() ?? new Date();
      const rec = buildTurnRecord(input, {
        sessionId: this.deps.sessionId,
        cwd: this.deps.cwd,
        date: localDate(now),
        ts: now.toISOString(),
      });
      if (!shouldCapture(input, rec, m.autoCapture.mode)) return;
      this.enqueueJournaled(rec);
    } catch (e) {
      this.debug(`capture 入口失败：${(e as Error).message}`);
    }
  }

  captureCompact(summary: string, turn: number): void {
    try {
      const m = this.deps.cfg.memory;
      if (!m.enabled || !m.autoCapture.enabled || m.autoCapture.mode === "off") return;
      const now = this.deps.now?.() ?? new Date();
      const rec = buildTurnRecord(
        { kind: "compact", messages: [], turn, summary },
        {
          sessionId: this.deps.sessionId,
          cwd: this.deps.cwd,
          date: localDate(now),
          ts: now.toISOString(),
        },
      );
      this.enqueueJournaled(rec);
    } catch (e) {
      this.debug(`compact 捕获失败：${(e as Error).message}`);
    }
  }

  /** 显式记忆（remember 工具 / /remember）：跳过价值判定。 */
  captureExplicit(body: string, turn: number, hintScope?: "project" | "user"): void {
    try {
      const m = this.deps.cfg.memory;
      if (!m.enabled) return;
      const now = this.deps.now?.() ?? new Date();
      const rec: TurnRecord = {
        v: 1,
        id: newRecordId(),
        ts: now.toISOString(),
        sessionId: this.deps.sessionId,
        cwd: this.deps.cwd,
        kind: "explicit",
        turn,
        user: redactPII(body).text.slice(0, 600),
        answer: "（用户显式要求记住这条信息）",
        tools: [],
        filesTouched: [],
        ...(hintScope ? { hintScope } : {}),
      };
      this.enqueueJournaled(rec);
    } catch (e) {
      this.debug(`显式记忆失败：${(e as Error).message}`);
    }
  }

  /** 启动恢复：把上次进程遗留的未处理 journal 重新入队（有界）。 */
  recoverPending(limit = 5): void {
    try {
      const dir = this.deps.cfg.memory.journalDir;
      cleanupJournal(dir, this.deps.cfg.memory.autoCapture.journalRetentionDays);
      for (const rec of pendingRecords(dir, {
        retentionDays: this.deps.cfg.memory.autoCapture.journalRetentionDays,
        limit,
      })) {
        this.kick(rec);
      }
    } catch (e) {
      this.debug(`journal 恢复失败：${(e as Error).message}`);
    }
  }

  /* ---------------- 队列 ---------------- */

  private enqueueJournaled(rec: TurnRecord): void {
    try {
      appendTurn(this.deps.cfg.memory.journalDir, rec);
    } catch (e) {
      this.debug(`journal 写入失败（继续内存队列）：${(e as Error).message}`);
    }
    this.queue.push(rec);
    void this.kickQueue();
  }

  private async kickQueue(): Promise<void> {
    if (this.running) return;
    this.running = (async () => {
      for (;;) {
        const rec = this.queue.shift();
        if (!rec) break;
        await this.process(rec);
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = null;
      if (this.queue.length > 0) void this.kickQueue();
    }
  }

  /** 从恢复路径直接入队（不再重复写 journal）。 */
  private kick(rec: TurnRecord): void {
    this.queue.push(rec);
    void this.kickQueue();
  }

  /** 等队列清空（带超时；退出/flush 用）。 */
  async flush(timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? this.deps.cfg.memory.autoCapture.flushTimeoutMs;
    const deadline = Date.now() + timeout;
    while ((this.running || this.queue.length > 0) && Date.now() < deadline) {
      await Promise.race([
        this.running ?? Promise.resolve(),
        new Promise((r) => setTimeout(r, 30)),
      ]);
    }
  }

  /* ---------------- 单条处理 ---------------- */

  private async process(rec: TurnRecord): Promise<void> {
    const started = Date.now();
    const cfg = this.deps.cfg;
    const mem = cfg.memory;
    const journalDir = mem.journalDir;

    if (rec.kind === "aborted") {
      this.audit({ rec, status: "skipped", applied: 0, dropped: 0, reasons: ["aborted 轮次不提炼"], ms: 0 });
      return;
    }
    if (this.pagesTouched.size >= mem.autoCapture.maxPagesPerSession) {
      this.audit({
        rec,
        status: "skipped",
        applied: 0,
        dropped: 0,
        reasons: [`本会话页面写入已达上限 ${mem.autoCapture.maxPagesPerSession}`],
        ms: 0,
      });
      return;
    }

    // 跨进程写锁（journalDir 下全局一把）：拿不到就留 journal 下次再试。
    // staleMs=2min：持锁进程崩溃/被退出时留下的锁会被自动清理，否则记忆写入会永久卡死。
    const lockDir = join(mem.journalDir, ".write.lock");
    const lock = tryAcquireLock(lockDir, { staleMs: 120_000 });
    if (!lock) {
      // 不写审计：留 journal 下次 flush/启动再试。写 failed 会消耗重试次数，
      // 两个会话并发时可能把记录永久放弃。
      this.debug("记忆写锁被占用，本轮回退到 journal 等待下次处理");
      return;
    }

    try {
      const project = ensureScopeLayout("project", this.deps.cwd);
      const user =
        this.deps.scopeMode === "both"
          ? ensureScopeLayout("user", this.deps.cwd, mem.userWikiDir)
          : null;
      const inventory = collectInventory({ project, user });
      const messages = buildDistillMessages({
        record: rec,
        inventory,
        maxOps: mem.autoCapture.maxOpsPerTurn,
        minConfidence: mem.autoCapture.minConfidence,
        minInferredConfidence: mem.autoCapture.minInferredConfidence,
      });

      const raw = await this.callDistiller(messages);
      if (raw === null) {
        this.audit({ rec, status: "failed", applied: 0, dropped: 0, reasons: ["提炼调用失败或输出非法"], ms: Date.now() - started });
        return;
      }
      const { ops, dropped } = validateDistillOps(raw, {
        record: rec,
        inventory,
        maxOps: mem.autoCapture.maxOpsPerTurn,
        minConfidence: mem.autoCapture.minConfidence,
        minInferredConfidence: mem.autoCapture.minInferredConfidence,
      });

      if (ops.length === 0) {
        this.audit({
          rec,
          status: "dropped",
          applied: 0,
          dropped: dropped.length,
          reasons: dropped.slice(0, 10).map((d) => `op#${d.index}: ${d.reason}`),
          ms: Date.now() - started,
        });
        return;
      }

      const merged = applyOps(ops, {
        project,
        user,
        sessionId: this.deps.sessionId,
        date: localDate(new Date(rec.ts)),
        journalDir,
      });
      for (const a of merged.applied) this.pagesTouched.add(`${a.scope}/${a.page}`);
      const reasons = merged.dropped.slice(0, 10).map((d) => `merge#${d.index}: ${d.reason}`);
      const status = merged.applied.length === 0 ? "dropped" : merged.dropped.length > 0 ? "partial" : "applied";
      this.audit({
        rec,
        status,
        applied: merged.applied.length,
        dropped: dropped.length + merged.dropped.length,
        reasons,
        ms: Date.now() - started,
      });

      if (merged.applied.length > 0) this.notice(rec, merged.applied);
    } catch (e) {
      this.debug(`捕获处理失败：${(e as Error).message}`);
      this.audit({
        rec,
        status: "failed",
        applied: 0,
        dropped: 0,
        reasons: [(e as Error).message],
        ms: Date.now() - started,
      });
    } finally {
      releaseLock(lock);
    }
  }

  /** 调 fast 档提炼；非法 JSON 重试一次。返回原始 ops 数组或 null。 */
  private async callDistiller(messages: Message[]): Promise<unknown[] | null> {
    const cfg = this.deps.cfg;
    const fastCfg: Config = { ...cfg };
    const tier = cfg.memory.autoCapture.modelTier;
    if (isModelTier(tier)) applyTier(fastCfg, tier);
    fastCfg.maxTokens = Math.min(fastCfg.maxTokens, 1024);
    fastCfg.temperature = 0.2;

    const signal = AbortSignal.timeout(30_000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const msgs =
        attempt === 0 ? messages : [...messages, repairMessage()];
      try {
        const res = await this.deps.streamFn(fastCfg, msgs, [], {}, signal);
        const parsed = parseDistillJson(res.content);
        if (parsed.error === null) return parsed.ops;
        this.debug(`提炼输出非法（第 ${attempt + 1} 次）：${parsed.error}`);
      } catch (e) {
        this.debug(`提炼调用失败（第 ${attempt + 1} 次）：${(e as Error).message}`);
      }
    }
    return null;
  }

  private notice(rec: TurnRecord, applied: { scope: string; page: string; status: string }[]): void {
    const cfg = this.deps.cfg;
    if (cfg.memory.quiet || !this.deps.onNotice) return;
    const project = applied.filter((a) => a.scope === "project");
    const user = applied.filter((a) => a.scope === "user");
    const parts: string[] = [];
    if (project.length > 0) {
      parts.push(`项目 +${project.length}（${project.map((a) => a.page.replace(/\.md$/, "")).join("、")}）`);
    }
    if (user.length > 0) {
      const hasInfer = rec.kind === "turn" && user.length > 0;
      parts.push(`用户 +${user.length}${hasInfer ? "（含推断）" : ""}（${user.map((a) => a.page.replace(/\.md$/, "")).join("、")}）`);
    }
    if (parts.length === 0) return;
    this.lastNotice = `记忆 ${parts.join(" · ")}`;
    this.deps.onNotice(`· ${this.lastNotice}`);
  }

  private audit(input: {
    rec: TurnRecord;
    status: AuditEntry["status"];
    applied: number;
    dropped: number;
    reasons: string[];
    ms: number;
  }): void {
    try {
      appendAudit(this.deps.cfg.memory.journalDir, {
        ts: new Date().toISOString(),
        id: input.rec.id,
        sessionId: input.rec.sessionId,
        turn: input.rec.turn,
        kind: input.rec.kind,
        status: input.status,
        applied: input.applied,
        dropped: input.dropped,
        reasons: input.reasons.slice(0, 10),
        ms: input.ms,
      });
    } catch (e) {
      this.debug(`审计写入失败：${(e as Error).message}`);
    }
  }

  private debug(msg: string): void {
    if (this.deps.onDebug) this.deps.onDebug(msg);
    else if (process.env["NEO_DEBUG"]) console.error(`[memory] ${msg}`);
  }

  /** 最近审计（/memory why 用）。 */
  recentAudit(limit = 5): AuditEntry[] {
    return readAudit(this.deps.cfg.memory.journalDir, limit);
  }
}
