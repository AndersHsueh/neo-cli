/**
 * #77：`-p --json-schema` 的结构化输出（读 schema、抽 JSON、校验、格式化诊断）。
 *
 * 只做 harness 层校验：不把 schema 写进每一轮请求的 `response_format` / `text.format`
 * （网关未必支持，且会把中间进度也塑成终态）。只校验**进程级最终答案**。
 *
 * 抽取规则偏严：先整段 `JSON.parse`；失败时仅当 trim 后的全文是**单个**围栏时再解一次。
 * 不在长叙述里扫描第一个 `{` —— 那容易把进度或示例当成终态。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

/** P1 固定 2 次回喂（共 3 次尝试），不可配。 */
export const MAX_SCHEMA_FEEDBACK = 2;

/** 读入并编译好的 schema。`validate` 返回 true 表示实例合规。 */
export interface CompiledSchema {
  validate(value: unknown): boolean;
  /** 不合规时的诊断（已格式化、可直接回喂或写 stderr）。 */
  errors(value: unknown): string;
}

export type LoadSchemaResult =
  | { ok: true; schema: CompiledSchema }
  | { ok: false; error: string };

/** 2020-12 系（含 2019-09）走 Ajv2020；其余（draft-07 与未声明）走默认 Ajv。 */
function is2020Dialect(uri: string): boolean {
  return uri.includes("2020-12") || uri.includes("2019-09");
}

/**
 * 编译 JSON Schema。
 *
 * `strict: false` 让未知关键字当注解而不是编译错误；不注册 ajv-formats，
 * 因此 `format` 只作注解、不强制（与「format 当注解」的口径一致）。
 * 声明了无法识别的 `$schema` 时 Ajv 会抛错 —— 视为非法 schema。
 */
function compileSchema(doc: unknown): CompiledSchema {
  const declared = (doc as { $schema?: unknown } | null)?.$schema;
  const uri = typeof declared === "string" ? declared : "";
  const ajv = is2020Dialect(uri)
    ? new Ajv2020({ strict: false, validateFormats: false, allErrors: true })
    : new Ajv({ strict: false, validateFormats: false, allErrors: true });
  const validate = ajv.compile(doc as object);
  return {
    validate: (value: unknown): boolean => validate(value) === true,
    errors: (value: unknown): string => {
      validate(value);
      const list = validate.errors ?? [];
      if (list.length === 0) return "（校验器未给出细节）";
      return list
        .map((e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? "不合规"}`)
        .join("；");
    },
  };
}

/**
 * 从旗标取值读 schema：trim 后以 `{` / `[` 开头当 inline JSON，否则当路径
 * （`@path` 去掉 `@`；相对 `cwd`，缺省 `process.cwd()`）。
 *
 * 缺值、读不到、JSON 解析失败、或不是可编译的 JSON Schema 都返回错误，
 * 由调用方按用法错误 2 收口（一次模型请求都不发）。
 */
export function loadJsonSchema(raw: string, cwd?: string | null): LoadSchemaResult {
  const spec = raw.trim();
  if (spec === "") return { ok: false, error: "--json-schema 需要一个 JSON Schema（inline 或文件路径）" };

  let text = spec;
  if (!spec.startsWith("{") && !spec.startsWith("[")) {
    const path = spec.startsWith("@") ? spec.slice(1).trim() : spec;
    if (path === "") return { ok: false, error: "--json-schema 的 @ 后面需要一个文件路径" };
    const base = cwd && cwd.trim() !== "" ? cwd : process.cwd();
    const full = isAbsolute(path) ? path : resolve(base, path);
    try {
      text = readFileSync(full, "utf8");
    } catch (e) {
      return { ok: false, error: `--json-schema 读不到 schema 文件 ${full}：${(e as Error).message}` };
    }
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `--json-schema 不是合法 JSON：${(e as Error).message}` };
  }
  try {
    return { ok: true, schema: compileSchema(doc) };
  } catch (e) {
    return { ok: false, error: `--json-schema 不是可编译的 JSON Schema：${(e as Error).message}` };
  }
}

/** 匹配「全文就是一个围栏」：可选 json 语言标记，围栏外不能有别的字符。 */
const SINGLE_FENCE_RE = /^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * 从最终答案里抽 JSON 值。
 *
 * 整段 `JSON.parse`（允许前后空白）；失败时仅当全文是单个 ```json / ``` 围栏时再解一次。
 * 围栏外还有叙述、多个围栏、半段 JSON 一律返回 null（交给回喂）。
 */
export function extractJsonValue(answer: string): { ok: true; value: unknown } | { ok: false } {
  const whole = answer.trim();
  if (whole === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(whole) };
  } catch {
    /* 落到围栏判定 */
  }
  const fenced = SINGLE_FENCE_RE.exec(whole);
  if (!fenced) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(fenced[1]!.trim()) };
  } catch {
    return { ok: false };
  }
}

export type SchemaCheck =
  | { ok: true; value: unknown }
  | { ok: false; diagnostic: string };

/** 抽取 + 校验。空答案、抽不出、不合规都算失败，`diagnostic` 可直接回喂给模型。 */
export function checkAgainstSchema(schema: CompiledSchema, answer: string): SchemaCheck {
  if (answer.trim() === "") {
    return { ok: false, diagnostic: "最终答案为空：必须只输出符合 JSON Schema 的 JSON 值。" };
  }
  const extracted = extractJsonValue(answer);
  if (!extracted.ok) {
    return {
      ok: false,
      diagnostic:
        "最终答案不是可解析的 JSON：必须只输出符合 JSON Schema 的 JSON 值，" +
        "不要包叙述文字，也不要输出多个代码围栏。",
    };
  }
  if (!schema.validate(extracted.value)) {
    return { ok: false, diagnostic: `最终答案不符合 JSON Schema：${schema.errors(extracted.value)}` };
  }
  return { ok: true, value: extracted.value };
}

/** 回喂给模型的一条后续用户消息（只作提示，不写进请求的 API 字段）。 */
export function feedbackMessage(diagnostic: string): string {
  return (
    `上一轮最终答案没有通过 JSON Schema 校验：${diagnostic}\n` +
    "请只输出一个符合该 schema 的 JSON 值（不要叙述、不要多个代码围栏）。"
  );
}
