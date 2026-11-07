/**
 * bootDiagnostics.ts — 启动期诊断的**通道分流**（issue #18）。
 *
 * 背景：启动 TUI 里塞了太多「诊断」——前置能力探测提示、五项能力「未探测到」、
 * 探测写回结果。它们对排障有用，但每次启动都刷在输入框上方，用户读到的是噪音。
 *
 * 分流规则（本模块是唯一实现，index.ts 只调用，不自己拼文案）：
 *  - 诊断 → **日志**：`<NEO_LOG_DIR 或 ~/.neo/logs>/boot/<YYYY-MM-DD>.jsonl`，
 *    一行一条 JSON（与 turnDiagnostics 的 turns/*.jsonl 同根、同保留期口径）；
 *  - TUI 只保留**结果**：真正写进 settings.json 的字段（「已补进 …」）和
 *    生效的上下文窗口（「模型上下文窗口：…」）—— 这两句是「我替你改了什么」，
 *    属于结果而不是诊断，留在 TUI 有价值。
 *
 * 关键约束：写日志失败绝不影响启动（诊断是增强项），也绝不回落到 TUI。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { turnLogRoot } from "./turnDiagnostics.ts";

/** 一条启动诊断。`kind` 是稳定枚举，日志消费方按它过滤。 */
export interface BootDiagnostic {
  /** 前置探测提示（「首次使用 … 将探测模型能力…」/「仍有未声明能力…」）。 */
  kind:
    | "probe-intent"
    | "capability-gap"
    | "probe-writeback"
    | "model-window"
    | "prompt-budget";
  /** 纯文本（不含 ANSI）：日志要能 grep，不能带颜色转义。 */
  message: string;
}

/** 日志根目录：与轮次日志同根（NEO_LOG_DIR 可覆盖，测试/多环境隔离）。 */
export function bootLogRoot(env: NodeJS.ProcessEnv = process.env): string {
  return turnLogRoot(env);
}

function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 当日启动诊断文件（`<root>/boot/<YYYY-MM-DD>.jsonl`）。 */
export function bootLogFile(now: Date = new Date(), root = bootLogRoot()): string {
  return join(root, "boot", `${dayKey(now)}.jsonl`);
}

/**
 * 写一条启动诊断。返回落盘路径；失败返回 null（不抛、不回落 TUI）。
 */
export function logBootDiagnostic(
  d: BootDiagnostic,
  opts: { now?: Date; root?: string } = {},
): string | null {
  const now = opts.now ?? new Date();
  const root = opts.root ?? bootLogRoot();
  const file = bootLogFile(now, root);
  try {
    mkdirSync(join(root, "boot"), { recursive: true, mode: 0o700 });
    const entry = { version: 1, ts: now.toISOString(), kind: d.kind, message: d.message };
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** 前置探测提示的文案（首次使用 / 仍有未声明能力）。纯函数，便于单测。 */
export function formatProbeIntent(provider: string, model: string, missing: string[]): string {
  return missing.length === 5
    ? `首次使用 ${provider}/${model}：为保障效果，将探测模型能力（上下文窗口 / 输出上限 / 视觉 / 工具 / 推理）并补进 settings.json 的空字段。`
    : `${provider}/${model} 仍有未声明能力（${missing.join("、")}），将探测并只补空字段（已手写的值，含 false，不会被覆盖）。`;
}

/** 写回结果文案（TUI 保留：这是「改了什么」，不是诊断）。 */
export function formatWritebackNotice(written: string[]): string {
  return `已补进 settings.json：${written.join("、")}（手写值不会被覆盖）`;
}

/** 上下文窗口文案（TUI 保留：这是本次生效的窗口）。 */
export function formatWindowNotice(tokens: number, source: string): string {
  return `模型上下文窗口：${tokens.toLocaleString()} tokens（${source}）`;
}

/** 「未探测到」诊断的日志前缀：日志里要能一眼看出这是 gap 而不是写回。 */
export function formatGapLogLine(hint: string): string {
  return `能力缺口：${hint}`;
}

/**
 * 「系统提示词放不下预算」的文案（issue #20 收尾）。
 *
 * **归类：TUI 保留 + 写日志**，与本模块其余诊断不同 —— 它不是「网关缺了什么字段」
 * 这类无当下动作的诊断，而是**当前配置的直接后果**：系统提示词塞不进预算，
 * 模型的可用上下文被提示词吃掉一大块。用户当下就能补救（换窗口更大的模型 /
 * 在 settings 手写 context_window），不提示的话他只会觉得「这模型好笨」。
 *
 * 纯函数（便于单测）；不含 ANSI。
 */
export function formatOverBudgetNotice(sel: {
  window: number | null;
  source: string | undefined;
  estimatedSystemTokens: number | null;
  budget: number;
}): string {
  const win =
    sel.window !== null
      ? `${sel.window.toLocaleString()} tokens（${sel.source ?? "来源未知"}）`
      : "窗口未知";
  const cost =
    sel.estimatedSystemTokens !== null ? sel.estimatedSystemTokens.toLocaleString() : "?";
  return (
    `系统提示词放不下预算：上下文窗口 ${win}，系统提示词估计 ${cost} > 预算 ${sel.budget.toLocaleString()}。` +
    `可换用窗口更大的模型，或在 settings 手写 context_window。`
  );
}

/* ------------------------------------------------------------------ */
/* 启动输出顺序（issue #18）                                            */
/* ------------------------------------------------------------------ */

/** 启动时 banner 之后的固定输出块：shell 状态行 / 项目记忆提示 / shell 解析告警。 */
export interface BootLines {
  /** 真实 shell 状态行（`  shell /bin/bash（bash，登录 shell）`）。 */
  shell: string;
  /** 项目记忆提示；没有项目记忆文件时为 null（不输出）。 */
  memory: string | null;
  /** shell 解析告警（可能为空）。 */
  warnings: string[];
}

/**
 * 启动块的行顺序（唯一实现，index.ts 只负责按序输出）。
 *
 * 顺序：**shell 状态行 → 项目记忆提示 → shell 告警**。
 * 为什么告警排在记忆之后：记忆提示必须紧邻真实 shell 状态行的下一行（用户先看清
 * 「在哪跑、用什么 shell」，再看到「带了哪份项目记忆」）；告警插在中间会打断这个
 * 紧邻关系（#18 独立验收 MUST FIX 1）。告警仍然可见，只是不占紧邻位。
 */
export function bootLines(b: BootLines): Array<{ kind: "shell" | "memory" | "warning"; text: string }> {
  const out: Array<{ kind: "shell" | "memory" | "warning"; text: string }> = [
    { kind: "shell", text: b.shell },
  ];
  if (b.memory) out.push({ kind: "memory", text: b.memory });
  for (const w of b.warnings) out.push({ kind: "warning", text: w });
  return out;
}
