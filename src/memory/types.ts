/**
 * types.ts — 记忆子系统的错误类型（叶子模块，零内部依赖）。
 *
 * v0.1.12 清理：原 MemoryEntry / IngestEngine / ProfileSlice / RecallQuery 等
 * 类型随 deprecated 实现（recordIndex/profile/ingest/reindex/redact/forget）
 * 一并删除；记忆条目的真实形状由 wiki 页面（Markdown + 摘要/日期戳）承载。
 */

export type MemoryErrorCode =
  | "schema_invalid" // 字段/结构校验失败（锁路径、越界写入等）
  | "permission_denied" // 目录无写权限
  | "raw_concurrent_modify"; // 锁被持有 / 等待锁超时

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
