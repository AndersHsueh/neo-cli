/**
 * 记忆系统内部类型（PRD docs/memory-prd.md §6.1 / §6.5）。
 *
 * 内部 export 命名空间 `memory.*`；公共 API 入口在 src/memory/index.ts。
 * 涉及用户可见字段的字符串长度/格式校验集中在 schema.ts；本文件只放形状。
 */

import type { Config, MemoryConfig } from "../config.ts";

/* ------------------------------------------------------------------ */
/* MemoryError — §6.5                                                  */
/* ------------------------------------------------------------------ */

export type MemoryErrorCode =
  | "schema_invalid"           // 索引条目字段校验失败
  | "ingest_failed"            // ingest 调用失败
  | "profile_truncated"        // profile 超 500 tokens 截断（仅警告，不抛）
  | "permission_denied"        // 用户级 / 项目级目录无写权限
  | "skills_missing"           // 降级 WARN
  | "raw_concurrent_modify";   // ADD-only 违反

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly cause?: unknown;
  constructor(code: MemoryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "MemoryError";
  }
}

/* ------------------------------------------------------------------ */
/* 索引条目 — 用户级 raw 写入的 frontmatter 形状                         */
/* ------------------------------------------------------------------ */

export interface MemoryEntry {
  /** ISO 日期 YYYY-MM-DD（用户级索引按 date 分文件）。 */
  date: string;
  /** 绝对路径。 */
  cwd: string;
  /** 8 位 hex。 */
  shortId: string;
  /** 用户首条输入前 200 字符（PII 过滤后）。 */
  summary: string;
  /** LLM 推断的 topic（P2 阶段；v0.1 默认空字符串）。 */
  topic?: string;
  /** ISO 时间戳。 */
  createdAt: string;
  /** ISO 时间戳；同 cwd 同日二次会话会更新。 */
  updatedAt?: string;
  /** PII 过滤后被替换的位置（redact 计数）；v0.1 用于 /memory redact。 */
  redactedAt?: string;
  redactedCount?: number;
  /** 任意附加字段；schema 校验放过，但 parser 保留。 */
  [extra: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* ProfileSlice — ensureProfile 返回值                                */
/* ------------------------------------------------------------------ */

/**
 * 注入到 messages[1] 的 ProfileSlice（PRD §约束 31 + Mike P0 #8 拍）。
 * - content: 注入块完整文本（含 ## 用户画像 段 + > 来源 行）
 * - truncatedAt: 截断层级；null = 未截断
 * - estimatedTokens / bytes: 度量信息
 * - cwd / timeRange / sourceEntries: 诊断与可解释性元数据
 */
export interface ProfileSlice {
  /** 注入到 messages[1] 的完整文本（含 ## 用户画像 段 + > 来源 行）。 */
  content: string;
  /** 截断层级：1 / 2 / 3；null 表示没截断。 */
  truncatedAt: 1 | 2 | 3 | null;
  /** 截断前估算 token 数（去每消息单开销）。 */
  estimatedTokens: number;
  /** content 的 UTF-8 字节数。 */
  bytes: number;
  /** 当前 cfg.cwd（用于诊断）；profile 本身是用户级共享，跟 cwd 无关。 */
  cwd: string;
  /** profile 时间范围（v0.1 留空；后续若有 profile 版本机制再补）。 */
  timeRange: { from?: string; to?: string };
  /** 支撑本次内容的 raw 索引条目 shortId 列表（v0.1 留空，profile 不依赖 raw）。 */
  sourceEntries: string[];
}

/* ------------------------------------------------------------------ */
/* RecallQuery / RecallHit — §6 / §A query 路径                          */
/* ------------------------------------------------------------------ */

/**
 * 召回查询（v0.1 design §6）。`type` 决定模型走哪条路径：
 *  - "cwd-prefix"：cwd 命中的索引条目
 *  - "fulltext"：raw 全文模糊匹配
 *  - "tag"：topic 标签匹配（P2）
 */
export interface RecallQuery {
  type: "cwd-prefix" | "fulltext" | "tag";
  cwd?: string;
  text?: string;
  tag?: string;
  limit?: number;
}

export interface RecallHit {
  entry: MemoryEntry;
  /** 召回路径来源，便于生产环境调试与回归。 */
  source: "user-level-raw" | "project-wiki" | "skills-cache";
  /** 命中片段（fulltext 时给，cwd-prefix 给 空串）。 */
  snippet: string;
  /** 评分；v0.1 占位（关键词命中数 / 词频）。 */
  score: number;
}

/* ------------------------------------------------------------------ */
/* IngestEngine — §7.4 #2 测试可注入接口                                */
/* ------------------------------------------------------------------ */

/**
 * ingest 引擎抽象。生产路径用一个 HTTP/SDK 实现（classifier_provider）；
 * 测试路径用一个本地 fake（mock LLM 返回固定 wiki 视图 / 强制失败）。
 *
 * opts.failure 用于 §7.4 测试注入；null 表示正常路径。
 */
export interface IngestOpts {
  /** null = 正常；其余 = 测试期强制某种失败以验证 .ingest-failures 写入。 */
  failure?: "network" | "429" | "unparseable" | "timeout" | "timeout_fast" | null;
  /** 单测 timeout 上限（毫秒），与 cfg.memory.ingest.timeoutMs 取较小。 */
  timeoutMsOverride?: number;
}

export interface IngestResult {
  /** 写入的 wiki 视图相对路径（如 wiki/2026-10-15_index.md）。 */
  wikiPath: string;
  /** 渲染条数（用于 §9.5 召回率统计）。 */
  indexEntries: number;
}

export interface IngestEngine {
  /** 注入器名（用于日志与回归追踪）。 */
  readonly name: string;
  /** 跑一次 ingest。失败 → throw MemoryError code="ingest_failed"。 */
  ingest(cfg: Config, opts?: IngestOpts): Promise<IngestResult>;
}

/* ------------------------------------------------------------------ */
/* 重新导出 Config 里用到的类型                                          */
/* ------------------------------------------------------------------ */

export type { MemoryConfig };