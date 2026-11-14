/**
 * #37 stream-json v1：统一信封、事件载荷、截断/脱敏工具与独立 JSONL writer。
 *
 * 本模块是 stream-json 唯一的外部 schema 映射与序列化边界（架构 §1.2、§3.6–§3.9）：
 *  - stdout 只由 JsonlWriter 写入，一行一个 JSON object，绝不输出数组括号、逗号、
 *    banner、ANSI 控制字节或人类诊断文本；诊断只走 stderr。
 *  - 内部逻辑事件（text/reasoning/turn_end/compact/plan/tier_switch）不在这里
 *    产生另一套公开事件；assistant_message 只发完整响应，不含 reasoning/thinking/raw。
 *  - 正常流程与已捕获失败恰好一个 result；result 写成功后拒绝后续任何事件。
 *  - EPIPE / 其它 stdout 写失败是「恰好一个 result」的唯一物理例外：立即 closed、
 *    触发 onClosed 取消钩子、不再写任何 stdout（含 result），stderr 只发一条诊断。
 *  - 退出码语义不属于本模块：#52 的 driveExitCode() 是 result.exit_code 的唯一来源，
 *    由组合根在下一阶段接线时传入。
 *
 * 运行时零第三方依赖；所有跨模块引用都是 type-only import，编译后完全擦除。
 */
// 说明：ModelTarget 的权威定义/导出在 config.ts（架构 §2.2、§3.3）。
// modelFallback.ts 只把它作为 type import 使用、并未 re-export，直接
// `import type { ModelTarget } from "./modelFallback.ts"` 会触发 TS2305。
// 这里从 config.ts 导入并顺带对外 re-export，使 streamJson.ts 成为 v1 schema 单一入口。
import type { ModelTarget } from "./config.ts";
import type { UsageBucket } from "./agent/types.ts";

export type { ModelTarget };

/* ------------------------------------------------------------------ *
 * 常量（架构 §3.6、§3.8）
 * ------------------------------------------------------------------ */

export const STREAM_JSON_SCHEMA_VERSION = "1.0" as const;

/** 工具 arguments/output 每个载荷的 Unicode code point 上限。 */
export const TOOL_TEXT_MAX_CODE_POINTS = 4000;
/** fallback reason / attempts 每条 message 的 code point 上限。 */
export const FALLBACK_REASON_MAX_CODE_POINTS = 240;
/** 普通 error / drive reason 的 code point 上限。 */
export const REASON_MAX_CODE_POINTS = 500;
/** paths 最多条数。 */
export const PATHS_MAX_ENTRIES = 32;
/** 单个 path 的 code point 上限。 */
export const PATH_MAX_CODE_POINTS = 512;
/** JSON 递归脱敏的最深容器层数，防止病态输入。 */
export const REDACT_MAX_DEPTH = 6;
/** 敏感值替换占位符。 */
export const REDACTED_VALUE = "[REDACTED]";
/** stdout 关闭时唯一的 stderr 诊断文本（不含换行）。 */
export const STDOUT_CLOSED_DIAGNOSTIC = "[stream-json] stdout closed; aborting";
/** flush 默认有界等待上限（毫秒）。 */
export const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

/* ------------------------------------------------------------------ *
 * v1 schema 类型（架构 §3.7 事件表，逐字段定稿）
 * ------------------------------------------------------------------ */

export type StreamEventType =
  | "init"
  | "turn_started"
  | "assistant_message"
  | "tool_started"
  | "tool_finished"
  | "model_fallback"
  | "drive_finished"
  | "error"
  | "result";

/** 被限长（且可能对 JSON 载荷脱敏）的文本；original_chars 按 Unicode code point 计。 */
export interface ClippedText {
  text: string;
  truncated: boolean;
  /** 原始文本（脱敏与截断之前）的 Unicode code point 数。 */
  original_chars: number;
}

export interface StreamInitData {
  provider: string;
  model: string;
  model_tier: string;
  output_format: "stream-json";
  drive: boolean;
}

export interface StreamTurnStartedData {
  turn: number;
  provider: string;
  model: string;
}

export interface StreamToolCall {
  call_id: string;
  name: string;
  arguments: ClippedText;
}

/** 完整模型响应；不含 reasoning / thinking_blocks / raw response / 签名思考块。 */
export interface StreamAssistantMessageData {
  turn: number;
  provider: string;
  model: string;
  content: string;
  tool_calls: StreamToolCall[];
  finish_reason: string | null;
  /** 恒为 finish_reason === "length"，由 writer 强制覆盖。 */
  truncated: boolean;
}

export interface StreamToolStartedData {
  turn: number;
  call_id: string;
  name: string;
  arguments: ClippedText;
  paths: string[];
}

export type StreamToolStatus = "success" | "failure" | "not_executed";

export interface StreamToolFinishedData {
  turn: number;
  call_id: string;
  name: string;
  status: StreamToolStatus;
  output: ClippedText;
  paths: string[];
}

export interface StreamFallbackReason {
  code: string;
  message: string;
}

/** #59 FallbackFailure 的公开投影：把 target 展平为 provider/model。 */
export interface StreamFallbackAttempt {
  provider: string;
  model: string;
  code: string;
  message: string;
}

export interface StreamModelFallbackData {
  from: ModelTarget;
  to: ModelTarget;
  reason: StreamFallbackReason;
  attempts: StreamFallbackAttempt[];
}

export type StreamDriveStatus = "done" | "exhausted" | "idle-stop" | "timeout";
export type StreamDriveSource = "verified" | "model" | null;

export interface StreamDriveFinishedData {
  status: StreamDriveStatus;
  source: StreamDriveSource;
  rounds: number;
  elapsed_ms: number;
  reason: string | null;
}

export type StreamErrorCode =
  | "model_error"
  | "agent_error"
  | "usage_error"
  | "internal_error";

export interface StreamErrorData {
  code: StreamErrorCode;
  message: string;
  provider: string | null;
  model: string | null;
}

/** 整个进程会话累计用量，含 drive 多轮及辅助请求。 */
export interface StreamUsageSummary {
  prompt: number;
  completion: number;
  reasoning: number;
  by_model: UsageBucket[];
}

export interface StreamResultDrive {
  status: StreamDriveStatus;
  source: StreamDriveSource;
  rounds: number;
  elapsed_ms: number;
}

export type StreamResultStatus =
  | "completed"
  | "model_done"
  | "failed"
  | "aborted"
  | "usage_error";

/** 由 #52 driveExitCode() 与组合根优先级产生的 0/1/2/3/130。 */
export type StreamResultExitCode = 0 | 1 | 2 | 3 | 130;

export interface StreamResultData {
  status: StreamResultStatus;
  exit_code: StreamResultExitCode;
  provider: string | null;
  model: string | null;
  usage: StreamUsageSummary;
  drive: StreamResultDrive | null;
  error: string | null;
}

/** type → data 的严格映射；每个 data 恒为 JSON object，不允许 null/数组/缺省。 */
export interface StreamEventData {
  init: StreamInitData;
  turn_started: StreamTurnStartedData;
  assistant_message: StreamAssistantMessageData;
  tool_started: StreamToolStartedData;
  tool_finished: StreamToolFinishedData;
  model_fallback: StreamModelFallbackData;
  drive_finished: StreamDriveFinishedData;
  error: StreamErrorData;
  result: StreamResultData;
}

/** 一行一个信封；seq 由唯一 writer 从 1 起严格 +1 分配。 */
export interface StreamEnvelope<T extends StreamEventType = StreamEventType> {
  schema_version: "1.0";
  type: T;
  session_id: string | null;
  seq: number;
  /** new Date().toISOString()，UTC RFC 3339 / ISO 8601。 */
  timestamp: string;
  data: StreamEventData[T];
}

/* ------------------------------------------------------------------ *
 * 截断 / 脱敏工具（下一阶段 CLI 接线复用；架构 §3.8）
 * ------------------------------------------------------------------ */

/** 忽略大小写匹配 api[-_]?key|authorization|token|secret|password|cookie|credential。 */
const SENSITIVE_KEY_RE =
  /(?:api[-_]?key|authorization|token|secret|password|cookie|credential)/i;

/**
 * 对自由文本里可明确识别的秘密形态做尽力脱敏。
 * 这只是 best-effort 归一，不是通用秘密扫描器；不宣称能识别任意形态秘密。
 */
const SECRET_FORM_REPLACERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/https?:\/\/[^\s"'<>]+/g, "[URL]"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, REDACTED_VALUE],
  [/\bsk-[A-Za-z0-9_-]{8,}/gi, REDACTED_VALUE],
  [
    /"?(?:authorization|api[-_]?key|token|secret|password|cookie|credential)"?\s*[:=]\s*"[^"]*"/gi,
    REDACTED_VALUE,
  ],
];

/** 运行时判定：非 null、非数组的普通对象。 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 用 unknown 参数避开 strict 下对已定型字段比较 undefined 的 TS2367。 */
function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function countCodePoints(text: string): number {
  return Array.from(typeof text === "string" ? text : String(text ?? "")).length;
}

/** 按 Unicode code point 截断；不使用 UTF-16 `.length`。 */
export function clipCodePoints(text: string, max: number): string {
  const source = typeof text === "string" ? text : String(text ?? "");
  const limit = Math.max(0, Math.floor(finiteNumber(max, 0)));
  const points = Array.from(source);
  return points.length > limit ? points.slice(0, limit).join("") : source;
}

export function isSensitiveKey(key: string): boolean {
  const source = typeof key === "string" ? key : String(key ?? "");
  return SENSITIVE_KEY_RE.test(source);
}

/**
 * 递归脱敏；depth 从 1 起，容器层超过 REDACT_MAX_DEPTH 后整体打码。
 * 键名命中敏感词时整个值替换为 "[REDACTED]"，不再向下递归。
 *
 * 深度上限的本意是防病态输入，不能变成放行通道：超限子树若原样返回，
 * 第 7 层及更深的 {token:"..."} 会直接进入 stdout。信息损失可接受，安全优先。
 */
export function redactJsonValue(value: unknown, depth: number = 1): unknown {
  if (depth > REDACT_MAX_DEPTH) return REDACTED_VALUE;
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactJsonValue(item, depth + 1));
  }
  if (isJsonObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactJsonValue(child, depth + 1);
    }
    return result;
  }
  return value;
}

/** 只把 JSON 对象/数组当作结构化载荷；自由文本与 JSON 基本类型不做再序列化。 */
function tryParseStructured(
  raw: string,
): { ok: true; value: unknown } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false };
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

function safeStringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

export interface ClipTextOptions {
  /** 上限（code point），默认 4000。 */
  max?: number;
  /** 工具层 DispatchResult.truncated 已为 true 时透传，不隐藏既有截断。 */
  alreadyTruncated?: boolean;
  /** 是否对可解析为 JSON 的载荷做递归脱敏，默认 true。 */
  redactJson?: boolean;
}

/**
 * 统一工具载荷处理：JSON 载荷递归脱敏后再序列化，随后按 code point 限长；
 * 非 JSON 自由文本 / shell 命令只做长度限制。
 */
export function clipText(raw: string, options: ClipTextOptions = {}): ClippedText {
  const source = typeof raw === "string" ? raw : "";
  const max = Math.max(
    0,
    Math.floor(finiteNumber(options.max ?? TOOL_TEXT_MAX_CODE_POINTS, TOOL_TEXT_MAX_CODE_POINTS)),
  );
  const originalChars = countCodePoints(source);
  let processed = source;

  if (options.redactJson !== false) {
    const parsed = tryParseStructured(source);
    if (parsed.ok && (Array.isArray(parsed.value) || isJsonObject(parsed.value))) {
      const serialized = safeStringify(redactJsonValue(parsed.value, 1));
      if (serialized !== null) processed = serialized;
    }
  }

  const points = Array.from(processed);
  const clipped = points.length > max;
  return {
    // text 仍按脱敏后文本裁切，保证不破坏 JSON 结构。
    text: clipped ? points.slice(0, max).join("") : processed,
    // truncated 忠实表示「原始载荷未原样完整呈现」：工具层已截断、原始超限、
    // 或脱敏后再序列化仍超限，任一为真即为 true，不因敏感值被压短而漏报。
    truncated: options.alreadyTruncated === true || originalChars > max || clipped,
    original_chars: originalChars,
  };
}

/** 工具 arguments：结构化载荷脱敏 + 4000 code point 限长。 */
export function clipToolArguments(raw: string): ClippedText {
  return clipText(raw);
}

/**
 * 工具 output：除本次 JSONL 截断外，透传 DispatchResult.truncated，
 * 保证 `truncated = 原工具层截断 || 本次 JSONL 截断`。
 */
export function clipToolOutput(
  output: string,
  dispatchTruncated: boolean = false,
): ClippedText {
  return clipText(output, { alreadyTruncated: dispatchTruncated });
}

function redactSecretForms(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_FORM_REPLACERS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 普通 error / drive reason：尽力脱敏 + ≤500 code points。 */
export function clipReason(text: string, max: number = REASON_MAX_CODE_POINTS): string {
  const source = typeof text === "string" ? text : String(text ?? "");
  return clipCodePoints(redactSecretForms(source), max);
}

/** fallback reason / attempts message：≤240 code points。 */
export function clipFallbackReason(text: string): string {
  return clipReason(text, FALLBACK_REASON_MAX_CODE_POINTS);
}

/** 转成 cwd 相对 POSIX 路径；不依赖 node:path，规避 Windows 分隔符差异。 */
export function normalizePath(path: string, cwd?: string): string {
  let result = String(path ?? "").trim().replace(/\\/g, "/");
  if (cwd) {
    const base = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (base !== "" && result === base) {
      result = ".";
    } else if (base !== "" && result.startsWith(`${base}/`)) {
      result = result.slice(base.length + 1);
    }
  }
  result = result.replace(/\/{2,}/g, "/");
  while (result.startsWith("./")) result = result.slice(2);
  return result;
}

/** ≤32 条、每条 ≤512 code points 的 cwd 相对 POSIX 路径。 */
export function clipPaths(
  paths: readonly string[] | null | undefined,
  cwd?: string,
): string[] {
  if (!Array.isArray(paths)) return [];
  const result: string[] = [];
  for (const raw of paths) {
    if (result.length >= PATHS_MAX_ENTRIES) break;
    if (typeof raw !== "string") continue;
    const normalized = clipCodePoints(normalizePath(raw, cwd), PATH_MAX_CODE_POINTS);
    if (normalized !== "") result.push(normalized);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 事件载荷归一：白名单投影，保证 data 恰好是契约字段（无额外泄漏）
 * ------------------------------------------------------------------ */

function normalizeClippedText(value: unknown): ClippedText {
  const source: Record<string, unknown> = isJsonObject(value) ? value : {};
  const text = typeof source.text === "string" ? source.text : String(source.text ?? "");
  const chars = countCodePoints(text);
  return {
    text: clipCodePoints(text, TOOL_TEXT_MAX_CODE_POINTS),
    truncated:
      source.truncated === true || chars > TOOL_TEXT_MAX_CODE_POINTS,
    original_chars: Math.max(0, Math.floor(finiteNumber(source.original_chars, chars))),
  };
}

function normalizeModelTarget(value: unknown): ModelTarget {
  const source: Record<string, unknown> = isJsonObject(value) ? value : {};
  return {
    provider: String(source.provider ?? ""),
    model: String(source.model ?? ""),
  };
}

function normalizeDriveStatus(value: unknown): StreamDriveStatus {
  return value === "done" ||
    value === "exhausted" ||
    value === "idle-stop" ||
    value === "timeout"
    ? value
    : "exhausted";
}

function normalizeDriveSource(value: unknown): StreamDriveSource {
  return value === "verified" || value === "model" ? value : null;
}

function normalizeToolStatus(value: unknown): StreamToolStatus {
  return value === "success" || value === "failure" || value === "not_executed"
    ? value
    : "failure";
}

function normalizeErrorCode(value: unknown): StreamErrorCode {
  return value === "model_error" ||
    value === "agent_error" ||
    value === "usage_error" ||
    value === "internal_error"
    ? value
    : "internal_error";
}

function normalizeResultStatus(value: unknown): StreamResultStatus {
  return value === "completed" ||
    value === "model_done" ||
    value === "failed" ||
    value === "aborted" ||
    value === "usage_error"
    ? value
    : "failed";
}

function normalizeExitCode(value: unknown): StreamResultExitCode {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 130
    ? value
    : 1;
}

function normalizeUsageBucket(value: unknown): UsageBucket {
  const source: Record<string, unknown> = isJsonObject(value) ? value : {};
  return {
    provider: String(source.provider ?? ""),
    model: String(source.model ?? ""),
    prompt: finiteNumber(source.prompt),
    completion: finiteNumber(source.completion),
    reasoning: finiteNumber(source.reasoning),
  };
}

/** 把调用方传入的 data 投影为契约字段集合；同时施加所有限长/脱敏兜底。 */
function normalizeEventData<T extends StreamEventType>(
  type: T,
  data: StreamEventData[T],
  cwd?: string,
): StreamEventData[T] {
  switch (type) {
    case "init": {
      const d = data as unknown as StreamInitData;
      return {
        provider: String(d.provider ?? ""),
        model: String(d.model ?? ""),
        model_tier: String(d.model_tier ?? ""),
        output_format: "stream-json",
        drive: d.drive === true,
      } as unknown as StreamEventData[T];
    }
    case "turn_started": {
      const d = data as unknown as StreamTurnStartedData;
      return {
        turn: finiteNumber(d.turn),
        provider: String(d.provider ?? ""),
        model: String(d.model ?? ""),
      } as unknown as StreamEventData[T];
    }
    case "assistant_message": {
      const d = data as unknown as StreamAssistantMessageData;
      const finishReason: string | null = isNullish(d.finish_reason)
        ? null
        : String(d.finish_reason);
      const calls: StreamToolCall[] = Array.isArray(d.tool_calls) ? d.tool_calls : [];
      return {
        turn: finiteNumber(d.turn),
        provider: String(d.provider ?? ""),
        model: String(d.model ?? ""),
        content: typeof d.content === "string" ? d.content : String(d.content ?? ""),
        tool_calls: calls.map((call) => ({
          call_id: String(call?.call_id ?? ""),
          name: String(call?.name ?? ""),
          arguments: normalizeClippedText(call?.arguments),
        })),
        finish_reason: finishReason,
        truncated: finishReason === "length",
      } as unknown as StreamEventData[T];
    }
    case "tool_started": {
      const d = data as unknown as StreamToolStartedData;
      return {
        turn: finiteNumber(d.turn),
        call_id: String(d.call_id ?? ""),
        name: String(d.name ?? ""),
        arguments: normalizeClippedText(d.arguments),
        paths: clipPaths(d.paths, cwd),
      } as unknown as StreamEventData[T];
    }
    case "tool_finished": {
      const d = data as unknown as StreamToolFinishedData;
      return {
        turn: finiteNumber(d.turn),
        call_id: String(d.call_id ?? ""),
        name: String(d.name ?? ""),
        status: normalizeToolStatus(d.status),
        output: normalizeClippedText(d.output),
        paths: clipPaths(d.paths, cwd),
      } as unknown as StreamEventData[T];
    }
    case "model_fallback": {
      const d = data as unknown as StreamModelFallbackData;
      const reason: Record<string, unknown> = isJsonObject(d.reason) ? d.reason : {};
      const attempts: unknown[] = Array.isArray(d.attempts) ? d.attempts : [];
      return {
        from: normalizeModelTarget(d.from),
        to: normalizeModelTarget(d.to),
        reason: {
          code: String(reason.code ?? ""),
          message: clipFallbackReason(String(reason.message ?? "")),
        },
        attempts: attempts.map((raw) => {
          const item: Record<string, unknown> = isJsonObject(raw) ? raw : {};
          return {
            provider: String(item.provider ?? ""),
            model: String(item.model ?? ""),
            code: String(item.code ?? ""),
            message: clipFallbackReason(String(item.message ?? "")),
          };
        }),
      } as unknown as StreamEventData[T];
    }
    case "drive_finished": {
      const d = data as unknown as StreamDriveFinishedData;
      return {
        status: normalizeDriveStatus(d.status),
        source: normalizeDriveSource(d.source),
        rounds: finiteNumber(d.rounds),
        elapsed_ms: finiteNumber(d.elapsed_ms),
        reason: isNullish(d.reason) ? null : clipReason(String(d.reason)),
      } as unknown as StreamEventData[T];
    }
    case "error": {
      const d = data as unknown as StreamErrorData;
      return {
        code: normalizeErrorCode(d.code),
        message: clipReason(String(d.message ?? "")),
        provider: nullableString(d.provider),
        model: nullableString(d.model),
      } as unknown as StreamEventData[T];
    }
    case "result": {
      const d = data as unknown as StreamResultData;
      const usage: Record<string, unknown> = isJsonObject(d.usage) ? d.usage : {};
      const byModel: unknown[] = Array.isArray(usage.by_model) ? usage.by_model : [];
      const drive: Record<string, unknown> | null = isJsonObject(d.drive)
        ? d.drive
        : null;
      return {
        status: normalizeResultStatus(d.status),
        exit_code: normalizeExitCode(d.exit_code),
        provider: nullableString(d.provider),
        model: nullableString(d.model),
        usage: {
          prompt: finiteNumber(usage.prompt),
          completion: finiteNumber(usage.completion),
          reasoning: finiteNumber(usage.reasoning),
          by_model: byModel.map(normalizeUsageBucket),
        },
        drive:
          drive === null
            ? null
            : {
                status: normalizeDriveStatus(drive.status),
                source: normalizeDriveSource(drive.source),
                rounds: finiteNumber(drive.rounds),
                elapsed_ms: finiteNumber(drive.elapsed_ms),
              },
        error: nullableString(d.error),
      } as unknown as StreamEventData[T];
    }
    default:
      return data;
  }
}

/* ------------------------------------------------------------------ *
 * JSONL writer（架构 §3.1、§3.9）
 * ------------------------------------------------------------------ */

/** 可注入的 stdout 抽象；write 返回 false 表示流内部缓冲，需等待 drain。 */
export interface JsonlSink {
  write(chunk: string): boolean;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface JsonlWriterOptions {
  /** 正常运行时为 SessionMeta.id；会话创建前的用法错误为 null。 */
  sessionId?: string | null;
  /** 默认 process.stdout；测试可注入最小实现。 */
  stdout?: JsonlSink;
  /** 默认写 process.stderr；测试可注入收集函数。 */
  stderr?: (line: string) => void;
  /** stdout 关闭/写失败时触发，组合根接入 agent.cancel()；本阶段不接线。 */
  onClosed?: (error: unknown) => void;
  /** 有界 flush 上限（毫秒），默认 2000。 */
  flushTimeoutMs?: number;
  /** 注入时钟，便于测试稳定断言 timestamp。 */
  now?: () => Date;
  /** 用于把 paths 归一化为 cwd 相对 POSIX 路径。 */
  cwd?: string;
}

interface ProcessStdoutLike {
  write(chunk: string): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

function createStdoutSink(): JsonlSink {
  const stdout = process.stdout as unknown as ProcessStdoutLike;
  return {
    write: (chunk: string): boolean => stdout.write(chunk),
    on: (event: string, listener: (...args: unknown[]) => void): unknown =>
      stdout.on(event, listener as (...args: any[]) => void),
    removeListener: (event: string, listener: (...args: unknown[]) => void): unknown =>
      stdout.removeListener(event, listener as (...args: any[]) => void),
  };
}

function defaultStderr(line: string): void {
  try {
    const stderr = process.stderr as unknown as { write(chunk: string): unknown };
    stderr.write(line);
  } catch {
    /* 诊断通道本身失效时不抛，保证收口继续 */
  }
}

/**
 * 独立 JSONL writer：所有事件经同一实例同步编号，一行一个信封。
 *
 * 不做退出码判断；不另起异步并发写。write() 返回 false 时只记录「需等待 drain」，
 * 由流内部缓冲保持顺序，flush() 有界等待 drain / error / 超时。
 */
export class JsonlWriter {
  private seqValue = 0;
  private resultEmittedValue = false;
  private closedValue = false;
  private needsDrain = false;
  private diagnosticEmitted = false;
  private sessionIdValue: string | null;
  private readonly sink: JsonlSink;
  private readonly writeStderr: (line: string) => void;
  private readonly now: () => Date;
  private readonly flushTimeoutMs: number;
  private readonly cwd?: string;
  private drainWaiters: Array<() => void> = [];
  private readonly boundOnDrain: (...args: unknown[]) => void;
  private readonly boundOnError: (...args: unknown[]) => void;

  /** stdout 关闭/写失败时触发的取消钩子（组合根接入 agent.cancel()）。 */
  onClosed?: (error: unknown) => void;

  constructor(options: JsonlWriterOptions = {}) {
    this.sessionIdValue = options.sessionId ?? null;
    this.sink = options.stdout ?? createStdoutSink();
    this.writeStderr = options.stderr ?? defaultStderr;
    this.now = options.now ?? (() => new Date());
    this.flushTimeoutMs = Math.max(
      0,
      Math.floor(
        finiteNumber(options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS, DEFAULT_FLUSH_TIMEOUT_MS),
      ),
    );
    this.cwd = options.cwd;
    this.onClosed = options.onClosed;

    this.boundOnDrain = (): void => {
      this.needsDrain = false;
      this.resolveDrainWaiters();
    };
    this.boundOnError = (...args: unknown[]): void => {
      this.closeWithError(args[0]);
    };

    // 常驻监听：EPIPE 通常以异步 error 事件到达；drain 用于解除 backpressure。
    this.sink.on?.("drain", this.boundOnDrain);
    this.sink.on?.("error", this.boundOnError);
  }

  get isClosed(): boolean {
    return this.closedValue;
  }

  get isResultEmitted(): boolean {
    return this.resultEmittedValue;
  }

  get currentSeq(): number {
    return this.seqValue;
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  /** 会话在首个事件之前才创建时补齐 session_id；之后不应再改。 */
  setSessionId(id: string | null): void {
    this.sessionIdValue = id;
  }

  /** 低层统一入口；result 走 emitResult 以强制单出口。 */
  emit<T extends StreamEventType>(type: T, data: StreamEventData[T]): boolean {
    if (type === "result") {
      return this.emitResult(data as unknown as StreamResultData);
    }
    return this.writeEnvelope(type, data);
  }

  emitInit(data: StreamInitData): boolean {
    return this.emit("init", data);
  }

  emitTurnStarted(data: StreamTurnStartedData): boolean {
    return this.emit("turn_started", data);
  }

  emitAssistantMessage(data: StreamAssistantMessageData): boolean {
    return this.emit("assistant_message", data);
  }

  emitToolStarted(data: StreamToolStartedData): boolean {
    return this.emit("tool_started", data);
  }

  emitToolFinished(data: StreamToolFinishedData): boolean {
    return this.emit("tool_finished", data);
  }

  emitModelFallback(data: StreamModelFallbackData): boolean {
    return this.emit("model_fallback", data);
  }

  emitDriveFinished(data: StreamDriveFinishedData): boolean {
    return this.emit("drive_finished", data);
  }

  emitError(data: StreamErrorData): boolean {
    return this.emit("error", data);
  }

  /** 正常与已捕获失败的最后一条；写成功后拒绝后续任何事件，重复调用不产生第二行。 */
  emitResult(data: StreamResultData): boolean {
    if (this.closedValue || this.resultEmittedValue) return false;
    const wrote = this.writeEnvelope("result", data);
    if (wrote) this.resultEmittedValue = true;
    return wrote;
  }

  /**
   * EPIPE / 其它 stdout 写失败：立即置 closed、只发一条 stderr 诊断、触发取消钩子。
   * 此后所有 emit（含 emitResult）都不再写 stdout。
   */
  closeWithError(error: unknown): void {
    if (this.closedValue) return;
    this.closedValue = true;
    if (!this.diagnosticEmitted) {
      this.diagnosticEmitted = true;
      try {
        this.writeStderr(`${STDOUT_CLOSED_DIAGNOSTIC}\n`);
      } catch {
        /* stderr 也失效时静默，不能阻断收口 */
      }
    }
    this.needsDrain = false;
    this.resolveDrainWaiters();
    const hook = this.onClosed;
    this.onClosed = undefined;
    if (hook) {
      try {
        hook(error);
      } catch {
        /* 取消钩子异常不得影响收口 */
      }
    }
  }

  /** 有界等待：write 返回 false 后等 drain / error / 超时，绝不无限等待。 */
  async flush(): Promise<void> {
    if (this.closedValue || !this.needsDrain) return;
    if (!this.sink.on) {
      // 无可监听的流：没有 drain 可等，直接收口（写入已按顺序交给 sink）。
      this.needsDrain = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        const idx = this.drainWaiters.indexOf(finish);
        if (idx >= 0) this.drainWaiters.splice(idx, 1);
        resolve();
      };
      this.drainWaiters.push(finish);
      timer = setTimeout(() => {
        this.needsDrain = false;
        finish();
      }, this.flushTimeoutMs);
      // 竞态复查：drain / error 可能已在注册之前发生。
      if (this.closedValue || !this.needsDrain) finish();
    });
  }

  /** 移除常驻监听（组合根退出前可调用；不改变 closed / result 状态）。 */
  dispose(): void {
    this.sink.removeListener?.("drain", this.boundOnDrain);
    this.sink.removeListener?.("error", this.boundOnError);
    this.resolveDrainWaiters();
  }

  private writeEnvelope<T extends StreamEventType>(
    type: T,
    data: StreamEventData[T],
  ): boolean {
    if (this.closedValue || this.resultEmittedValue) return false;
    // data 恒为 JSON object，不接受 null / 数组 / 缺省。
    if (!isJsonObject(data)) return false;

    const normalized = normalizeEventData(type, data, this.cwd);
    const envelope: StreamEnvelope<T> = {
      schema_version: STREAM_JSON_SCHEMA_VERSION,
      type,
      session_id: this.sessionIdValue,
      seq: this.seqValue + 1,
      timestamp: this.now().toISOString(),
      data: normalized,
    };

    const serialized = JSON.stringify(envelope);
    if (typeof serialized !== "string") return false;
    const line = `${serialized}\n`;

    let accepted: boolean;
    try {
      accepted = this.sink.write(line);
    } catch (error) {
      this.closeWithError(error);
      return false;
    }
    this.seqValue += 1;
    if (accepted === false) this.needsDrain = true;
    return true;
  }

  private resolveDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) waiter();
  }
}
