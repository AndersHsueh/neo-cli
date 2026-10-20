/**
 * port.ts — Agent 与记忆服务之间的唯一契约（v0.2 记忆激活 §7.8.1）。
 *
 * 为什么单独放在叶子模块：
 *  - agent.ts 只依赖本文件里的类型与标记常量，不 import src/memory 的实现，
 *    依赖方向保持 index.ts（组合根）→ memory/bridge → memory/*；
 *  - 测试可以用 fake MemoryPort 注入 Agent，无需真实记忆库。
 *
 * 本文件**不得** import src/memory 的任何实现模块（避免循环依赖）。
 */
import type { Message } from "../llm.ts";

/** 召回消息的固定标记。用于：临时消息摘除、compact 过滤、审计与测试断言。 */
export const RECALL_MARKER = "【记忆召回·自动】";

/** 是否为本轮临时注入的记忆召回消息。 */
export function isRecallMessage(m: Message | undefined): boolean {
  if (!m || m.role !== "system") return false;
  const text = typeof m.content === "string" ? m.content : "";
  return text.startsWith(RECALL_MARKER);
}

/** 召回 trace（供 /memory why 与测试断言）。 */
export interface RecallTraceHit {
  scope: "project" | "user";
  page: string;
  score: number;
}

export interface RecallTrace {
  terms: string[];
  hits: RecallTraceHit[];
  tokens: number;
  injected: boolean;
}

/** 一轮对话的捕获输入（Agent 在轮末/压缩前构造）。 */
export interface TurnCaptureInput {
  kind: "turn" | "compact" | "explicit" | "aborted";
  /** 从 turnStart 起截取的消息（含临时消息，实现侧负责过滤）。 */
  messages: Message[];
  turn: number;
  stats?: {
    toolCalls: number;
    iterations: number;
    aborted: boolean;
    finishReason: string | null;
  };
  /** kind=compact 时携带压缩摘要。 */
  summary?: string;
}

export interface MemoryPort {
  /** 启动注入：用户画像摘要（无用户库/无画像返回 null）。 */
  startup(): Promise<{ message: Message; tokens: number } | null>;
  /** 每轮开始前的自动召回（scope 由实现按 -p/交互模式决定）。 */
  recall(input: string): Promise<{ message: Message; trace: RecallTrace } | null>;
  /** 轮末捕获（fire-and-forget：不得阻塞或抛错到调用方）。 */
  capture(input: TurnCaptureInput): void;
  /** 压缩前捕获（摘要即将替换历史，信息价值最高）。 */
  captureCompact(summary: string, turn: number): void;
  /** 会话退出前冲刷写队列（带超时）。 */
  flush(timeoutMs?: number): Promise<void>;
}
