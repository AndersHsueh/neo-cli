/**
 * distill.ts — 记忆提炼器（v0.2 记忆激活 §7.6.3 / §7.6.4）。
 *
 * 纯函数层：构造 prompt、解析 JSON、按硬规则校验 op。真正调用 LLM 的在 capture.ts，
 * 这样校验规则可以脱离网络单测（prompt 之外的第二道闸）。
 *
 * 关键取舍：提炼器只看到「用户说了什么 + 助手最终结论 + 工具名/成败/路径」，
 * 不接收工具原始输出 —— 既控 token，也避免网页/文件内容构成间接注入污染长期记忆。
 */
import type { Message } from "../llm.ts";
import { validatePageName } from "../wiki/write.ts";
import { redactPII, type PIIMode } from "./pii.ts";
import type { TurnRecord } from "./journal.ts";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface MemoryInventoryItem {
  scope: "project" | "user";
  page: string;
  summary: string;
  updated: string;
}

export interface DistillOp {
  scope: "project" | "user";
  action: "create" | "append";
  page: string;
  summary: string;
  body: string;
  confidence: number;
  inferred: boolean;
  evidence: string;
  /** 可选：被本 op 推翻的旧结论原文（出现在页面中时标注「更正」）。 */
  supersedes?: string;
}

export interface DistillInput {
  record: TurnRecord;
  inventory: MemoryInventoryItem[];
  maxOps: number;
  minConfidence: number;
  minInferredConfidence: number;
}

export interface DroppedOp {
  index: number;
  reason: string;
}

export interface ValidateResult {
  ops: DistillOp[];
  dropped: DroppedOp[];
}

/** 只拦密钥类 PII；邮箱/普通联系方式允许进记忆（用户画像可能需要）。 */
const SECRET_PII: PIIMode[] = ["openai-key", "github-pat", "jwt", "aws-key", "slack-token"];

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `你是 neo 的「记忆提炼器」。你的唯一职责：从一轮对话记录里提炼出值得长期保存的事实，
并按严格 JSON 输出。你不与用户对话，不解释，不输出 JSON 以外的任何文字。

判断标准（宁缺毋滥）：
- 值得记：决策及其理由、踩坑的根因与修法、项目约定、架构事实、进度状态、用户长期偏好/习惯/环境、可复用方法论。
- 不要记：寒暄、一次性查询、工具原始输出、猜测、仅本轮有效的临时状态、密钥与隐私。

作用域规则：
- project：本项目的具体事实（模块、文件、命令、决策、坑）。不写用户个人信息。
- user：跨项目的「这个人」的稳定信息（身份/角色、沟通与代码偏好、环境、经验）。
  推断出来的内容必须 inferred=true，且置信度要求更高；不得推断健康/政治/宗教/财务等敏感类别。

落页规则：
- 优先 append 到清单里已有的页；确无可归处才 create（一次最多 1 个 create）。
- page 必须是合法 Markdown 页名（中文短语，如 踩坑-热键系统.md / 偏好-沟通.md）。
- body 写具体、可执行的事实，20~1500 字，不要复述整段对话。
- evidence 必须引用本轮用户原话或助手结论中的片段（用「」括起来），不得编造。
- 如果新事实推翻了页面里的旧结论，填 supersedes 为旧结论原文片段（可选）。`;

function formatRecord(rec: TurnRecord): string {
  const lines = [
    `【本轮记录】kind=${rec.kind} turn=${rec.turn} time=${rec.ts}`,
    `用户：${rec.user || "（无）"}`,
    `助手结论：${rec.answer || "（无）"}`,
  ];
  if (rec.tools.length > 0) {
    lines.push(`工具调用：${rec.tools.map((t) => `${t.name}${t.ok ? "" : "(失败)"}${t.digest ? `:${t.digest}` : ""}`).join("; ")}`);
  }
  if (rec.filesTouched.length > 0) lines.push(`涉及文件：${rec.filesTouched.join(", ")}`);
  if (rec.hintScope) lines.push(`用户显式指定作用域：${rec.hintScope}`);
  return lines.join("\n");
}

function formatInventory(items: MemoryInventoryItem[]): string {
  if (items.length === 0) return "（记忆库为空）";
  const project = items.filter((i) => i.scope === "project");
  const user = items.filter((i) => i.scope === "user");
  const render = (list: MemoryInventoryItem[]): string =>
    list
      .map((i) => `- [${i.scope}] ${i.page} | ${i.summary || "（无摘要）"} | 更新 ${i.updated}`)
      .join("\n");
  const parts: string[] = [];
  if (project.length > 0) parts.push(`项目记忆页：\n${render(project)}`);
  if (user.length > 0) parts.push(`用户记忆页：\n${render(user)}`);
  return parts.join("\n\n");
}

/** 构造提炼请求消息（system + user）。 */
export function buildDistillMessages(input: DistillInput): Message[] {
  const { record, inventory, maxOps, minConfidence, minInferredConfidence } = input;
  const schema = `输出格式（严格 JSON，无代码围栏）：
{"ops":[
  {"scope":"project|user","action":"create|append","page":"页名.md",
   "summary":"一句话摘要（≤80字）","body":"具体事实（20-1500字）",
   "confidence":0.0-1.0,"inferred":false,
   "evidence":"「用户原话或助手结论片段」","supersedes":"可选：旧结论原文"}
]}`;

  const rules = [
    `最多输出 ${maxOps} 条 op；没有值得记的就输出 {"ops":[]}。`,
    `事实类 confidence ≥ ${minConfidence}；推断类（inferred=true）confidence ≥ ${minInferredConfidence}，且必须写清推断依据。`,
    `create 只用于清单里不存在的页；page 不存在清单里却用 append 会被丢弃。`,
    `body 中不要包含任何密钥、token、密码。`,
  ].join("\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        formatRecord(record),
        "",
        "【现有记忆页清单】",
        formatInventory(inventory),
        "",
        "【规则】",
        rules,
        "",
        "【输出 schema】",
        schema,
      ].join("\n"),
    },
  ];
}

/** 解析失败后的纠正提示（追加到对话，重试一次）。 */
export function repairMessage(): Message {
  return {
    role: "user",
    content: "上一次输出不是合法 JSON。请只输出一个 JSON 对象（形如 {\"ops\":[...]}），不要任何解释或代码围栏。",
  };
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** 从模型文本中提取 JSON 对象（容忍代码围栏与前后噪音）。 */
export function parseDistillJson(text: string): { ops: unknown[]; error: string | null } {
  const flat = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = flat.indexOf("{");
  const end = flat.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return { ops: [], error: "输出中没有 JSON 对象" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(flat.slice(start, end + 1));
  } catch (e) {
    return { ops: [], error: `JSON 解析失败：${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ops: [], error: "JSON 顶层不是对象" };
  }
  const ops = (parsed as { ops?: unknown }).ops;
  if (!Array.isArray(ops)) return { ops: [], error: "JSON 缺少 ops 数组" };
  return { ops, error: null };
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function evidenceSupported(evidence: string, sources: string[]): boolean {
  const hay = sources.join("\n");
  if (!hay) return false;
  // 优先检查「」/"" 引号内的片段
  const quoted = [...evidence.matchAll(/[「"“]([^」"”]{4,})[」"”]/g)].map((m) => m[1] ?? "");
  for (const q of quoted) {
    if (hay.includes(q)) return true;
  }
  // 兜底：evidence 中任意 4 字窗口出现在原文中
  const text = evidence.replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  const windows = text.split(/[\s]+/).filter((w) => w.length >= 4);
  for (const w of windows) {
    if (hay.includes(w)) return true;
    for (let i = 0; i + 4 <= w.length; i++) {
      if (hay.includes(w.slice(i, i + 4))) return true;
    }
  }
  return false;
}

function containsSecret(...texts: string[]): boolean {
  return texts.some((t) => redactPII(t, { modes: SECRET_PII }).total > 0);
}

/**
 * 按硬规则校验并归一化 op 列表。
 * 每个被丢弃的 op 都带原因（供 /memory why 审计）；顺序保持不变。
 */
export function validateDistillOps(raw: unknown[], input: DistillInput): ValidateResult {
  const { record, inventory, maxOps, minConfidence, minInferredConfidence } = input;
  const ops: DistillOp[] = [];
  const dropped: DroppedOp[] = [];
  const sources = [record.user, record.answer];
  const existing = new Map(inventory.map((i) => [`${i.scope}/${i.page}`, i]));
  // create 上限按作用域各 1 个：项目级/用户级可以在同一轮各新建一页（跨作用域不冲突）
  const createsByScope: Record<"project" | "user", number> = { project: 0, user: 0 };

  const limit = Math.min(raw.length, maxOps);
  for (let idx = 0; idx < limit; idx++) {
    const item = raw[idx];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      dropped.push({ index: idx, reason: "op 不是对象" });
      continue;
    }
    const o = item as Record<string, unknown>;

    const scope = o["scope"];
    if (scope !== "project" && scope !== "user") {
      dropped.push({ index: idx, reason: `scope 非法：${String(scope)}` });
      continue;
    }
    const action = o["action"];
    if (action !== "create" && action !== "append") {
      dropped.push({ index: idx, reason: `action 非法：${String(action)}` });
      continue;
    }
    const page = isStr(o["page"]) ? o["page"].trim() : "";
    const nameErr = validatePageName(page);
    if (nameErr) {
      dropped.push({ index: idx, reason: `页名非法：${nameErr}` });
      continue;
    }
    const body = isStr(o["body"]) ? o["body"].trim() : "";
    if (body.length < 20 || body.length > 1500) {
      dropped.push({ index: idx, reason: `body 长度 ${body.length} 不在 20~1500` });
      continue;
    }
    const summary = isStr(o["summary"]) ? o["summary"].trim() : "";
    if (summary.length < 2 || summary.length > 200) {
      dropped.push({ index: idx, reason: `summary 长度 ${summary.length} 不在 2~200` });
      continue;
    }
    const confidence = typeof o["confidence"] === "number" ? o["confidence"] : Number.NaN;
    const inferred = o["inferred"] === true;
    const floor = inferred ? minInferredConfidence : minConfidence;
    if (!Number.isFinite(confidence) || confidence < floor) {
      dropped.push({
        index: idx,
        reason: `confidence ${Number.isFinite(confidence) ? confidence : "非法"} < 门槛 ${floor}${inferred ? "(推断)" : ""}`,
      });
      continue;
    }
    const evidence = isStr(o["evidence"]) ? o["evidence"].trim() : "";
    if (!evidence) {
      dropped.push({ index: idx, reason: "缺少 evidence" });
      continue;
    }
    if (!evidenceSupported(evidence, sources)) {
      dropped.push({ index: idx, reason: "evidence 无法在本轮原文中找到" });
      continue;
    }
    if (containsSecret(body, summary)) {
      dropped.push({ index: idx, reason: "内容含密钥类敏感串" });
      continue;
    }

    const key = `${scope}/${page}`;
    const exists = existing.has(key);
    if (action === "append" && !exists) {
      dropped.push({ index: idx, reason: `append 目标页不存在于清单：${key}` });
      continue;
    }
    if (action === "create" && exists) {
      dropped.push({ index: idx, reason: `create 目标页已存在：${key}` });
      continue;
    }
    if (action === "create") {
      if (createsByScope[scope] >= 1) {
        dropped.push({ index: idx, reason: `${scope} 作用域本轮 create 超过 1 个` });
        continue;
      }
      createsByScope[scope]++;
    }
    if (record.hintScope && scope !== record.hintScope) {
      dropped.push({ index: idx, reason: `与用户显式作用域 ${record.hintScope} 不符` });
      continue;
    }

    const supersedes = isStr(o["supersedes"]) ? o["supersedes"].trim() : undefined;
    ops.push({
      scope,
      action,
      page,
      summary,
      body,
      confidence,
      inferred,
      evidence,
      ...(supersedes ? { supersedes } : {}),
    });
  }

  if (raw.length > limit) {
    for (let idx = limit; idx < raw.length; idx++) {
      dropped.push({ index: idx, reason: `超过本轮 ops 上限 ${maxOps}` });
    }
  }
  return { ops, dropped };
}
