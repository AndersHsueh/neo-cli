/**
 * 模型上下文窗口的探测 / 持久化（v0.4.1 A2）。
 *
 * 设计：
 *  - 事实源与 v0.4.0 环境探测一致：~/.neo/env/<machineKey>.json 的 `models` 字段；
 *  - 探测途径两条：`/models` 元数据（若网关给）+ 上下文溢出错误文案里解析上限；
 *  - 启动时同步读缓存并覆盖配置值（配置可能配错/模型可能被路由换掉）；
 *  - `/env refresh` 与首次启动可异步刷新，失败静默（不影响会话）。
 *
 * 本模块会 import env/probe（读写快照），但 config 只在运行时调用本模块，
 * 不反向 import 本模块到 probe，避免循环。
 */
import { arch, homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { CapabilityFlag, ModelContextInfo } from "./types.ts";
import { resolveContextWindow, type ResolvedWindow } from "../contextWindow.ts";
import {
  envRoot,
  loadEnv,
  machineKeyOf,
  readSnapshot,
  resetEnvCache,
  snapshotFile,
  writeSnapshot,
} from "./probe.ts";

export function modelKey(provider: string, model: string): string {
  return `${provider}|${model}`;
}

function envHome(): string {
  // 测试注入点：与 NEO_SESSIONS_DIR / NEO_MEMORY_DIR 同一惯例。
  return process.env["NEO_ENV_HOME"] ?? homedir();
}

function currentSnapshotPath(cfg: Config): string {
  const key = machineKeyOf(hostname(), platform(), arch());
  return snapshotFile(envHome(), key, cfg.env);
}

export function readModelContexts(cfg: Config): Record<string, ModelContextInfo> {
  try {
    return readSnapshot(currentSnapshotPath(cfg))?.models ?? {};
  } catch {
    return {};
  }
}

export function readModelContext(
  cfg: Config,
  provider = cfg.providerName,
  model = cfg.model,
): ModelContextInfo | null {
  return readModelContexts(cfg)[modelKey(provider, model)] ?? null;
}

/**
 * 按 env 缓存解析当前模型窗口并写回 cfg。
 * 返回解析结果，供 /context 与启动提示使用。
 */
export function resolveAndApplyModelWindow(cfg: Config): ResolvedWindow {
  const info = readModelContext(cfg);
  // 用「配置原值」而非当前值做 fallback：cfg.contextWindow 可能已被上一个模型的
  // env 事实覆盖，不能拿它冒充新模型的配置窗口（/model 切换场景）。
  const fallback = cfg.configuredContextWindow ?? cfg.contextWindow;
  // 配置值是否显式：config.ts 在加载/切换 provider 时记下；已被探测覆盖过的会话里它仍保持这次配置的来源。
  const explicit = cfg.configuredContextWindowExplicit ?? true;
  const resolved = resolveContextWindow(fallback, cfg.model, info, explicit);
  cfg.contextWindow = resolved.tokens;
  cfg.contextWindowSource = resolved.source;
  return resolved;
}

/* ------------------------------------------------------------------ */
/* P4：切换模型后刷新能力视图                                          */
/* ------------------------------------------------------------------ */

/**
 * 切换模型/provider/档位后的统一收尾（GitHub #5 P4）。
 *
 * 为什么需要：`/model` `/provider` `/tier` 只改了 cfg.model 等字段，
 * cfg.contextWindow 仍是**旧模型**解析出来的值 —— 紧接着的 `/context` `/env`
 * 会展示上一个模型的窗口，压缩阈值也按错的窗口算。
 *
 * 两段式：
 *  1. 同步：立刻按 env 缓存/settings 手写解析并写回 cfg（`/context` 马上正确）；
 *  2. 异步：fire-and-forget 探测一次 `/models` 元数据（撞墙/首次才探测的口径不变，
 *     这里只是「换了模型就补一次事实」），完成后**再解析一次** cfg。
 *     失败静默 —— 探测是增强项，不能拖慢首 token，也不能影响会话。
 *
 * 返回同步阶段的结果，供调用方展示。
 */
export function refreshCapabilitiesAfterModelSwitch(cfg: Config): ResolvedWindow {
  const applied = resolveAndApplyModelWindow(cfg);
  // 探测期间用户可能又切了模型：回调里比对 key，避免把旧探测结果套到新模型上。
  const key = modelKey(cfg.providerName, cfg.model);
  void detectAndRecordModelWindow(cfg)
    .then((info) => {
      if (!info) return;
      if (modelKey(cfg.providerName, cfg.model) !== key) return;
      resolveAndApplyModelWindow(cfg);
    })
    .catch(() => {
      /* 探测失败不影响会话 */
    });
  return applied;
}

/** 记录/更新一个模型的窗口事实（合并进静态快照，不影响其它字段）。 */
export function recordModelContext(
  cfg: Config,
  info: Omit<ModelContextInfo, "updatedAt"> & { updatedAt?: string },
): void {
  try {
    const file = currentSnapshotPath(cfg);
    let snap = readSnapshot(file);
    if (!snap) {
      // 首次没有快照时先走一次环境探测（10ms 量级），失败就算了。
      loadEnv({ cfg, persist: true, home: envHome() });
      snap = readSnapshot(file);
    }
    if (!snap) return;
    const models: Record<string, ModelContextInfo> = { ...(snap.models ?? {}) };
    models[modelKey(cfg.providerName, cfg.model)] = {
      ...info,
      updatedAt: info.updatedAt ?? new Date().toISOString(),
    };
    writeSnapshot(file, { ...snap, models });
    resetEnvCache();
  } catch {
    // 持久化失败不阻塞会话；下一次探测/溢出会重试。
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/** 从 /models 返回体里尽力找窗口元数据（字段名因网关而异）。 */
function windowFromModelEntry(entry: Record<string, unknown>): number | null {
  const direct = ["context_window", "context_length", "max_context_length", "max_model_len", "max_input_tokens", "n_ctx", "context"];
  for (const k of direct) {
    const n = num(entry[k]);
    if (n !== null) return n;
  }
  for (const nested of ["meta", "metadata", "capabilities", "limits"]) {
    const v = entry[nested];
    if (typeof v === "object" && v !== null) {
      const got = windowFromModelEntry(v as Record<string, unknown>);
      if (got !== null) return got;
    }
  }
  return null;
}

/**
 * 输出上限字段名（与 context_window 区分：这是单次生成的上限，不是输入窗口）。
 *
 * 这里的 `max_tokens` 只可能出现在 /models 模型卡片上，表示网关声明的生成上限。
 * 它不是请求体里的预算，也不是 usage.completion_tokens。后两者禁止写进能力上限（#6）。
 */
function outputFromModelEntry(entry: Record<string, unknown>): number | null {
  const direct = ["max_output_tokens", "max_completion_tokens", "max_output", "output_token_limit", "max_tokens"];
  for (const k of direct) {
    const n = num(entry[k]);
    if (n !== null) return n;
  }
  for (const nested of ["meta", "metadata", "capabilities", "limits"]) {
    const v = entry[nested];
    if (typeof v === "object" && v !== null) {
      const got = outputFromModelEntry(v as Record<string, unknown>);
      if (got !== null) return got;
    }
  }
  return null;
}

/**
 * 把元数据里的布尔能力字段归一成三态。
 * 认 true/false、"true"/"false"、1/0、yes/no；其余（含缺失）= "unknown"。
 * 注意：只有明确写了 false 才算「确认不支持」，缺失一律 unknown。
 */
function flag(v: unknown): CapabilityFlag {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : "unknown";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "yes" || s === "1" || s === "supported") return true;
    if (s === "false" || s === "no" || s === "0" || s === "unsupported") return false;
  }
  return "unknown";
}

/** 在 entry 及其常见嵌套层里按字段名列表找第一个存在的值（找到就返回，哪怕是 false）。 */
function pickField(entry: Record<string, unknown>, names: string[]): unknown {
  for (const k of names) {
    if (entry[k] !== undefined) return entry[k];
  }
  for (const nested of ["meta", "metadata", "capabilities", "limits", "features"]) {
    const v = entry[nested];
    if (typeof v === "object" && v !== null) {
      const obj = v as Record<string, unknown>;
      for (const k of names) {
        if (obj[k] !== undefined) return obj[k];
      }
    }
  }
  return undefined;
}

function capabilityFromModelEntry(entry: Record<string, unknown>): {
  vision: CapabilityFlag;
  tools: CapabilityFlag;
  reasoning: CapabilityFlag;
} {
  const modalities = pickField(entry, ["modalities", "input_modalities"]);
  let vision = flag(pickField(entry, ["vision", "supports_vision", "image_input", "image"]));
  if (vision === "unknown" && Array.isArray(modalities)) {
    // OpenAI 风格：modalities: ["text","image"] —— 出现 image 即支持，否则确认不支持。
    vision = modalities.some((m) => typeof m === "string" && /image|vision/i.test(m));
  }
  return {
    vision,
    tools: flag(pickField(entry, ["tools", "supports_tools", "tool_calling", "function_calling", "tool_use"])),
    reasoning: flag(pickField(entry, ["reasoning", "supports_reasoning", "is_reasoning", "thinking"])),
  };
}

/** 探测结果：窗口与输出上限各自独立，可能只有其一。 */
export interface DetectedModelCapabilities {
  contextWindow: number | null;
  maxOutputTokens: number | null;
  vision: CapabilityFlag;
  tools: CapabilityFlag;
  reasoning: CapabilityFlag;
  /** 元数据来源 URL，写进 evidence 便于排障。 */
  evidence: string;
}

/** `/models` 能力探测的默认超时。2.5s 对慢企业网关冷启动偏紧，放宽到 5s。 */
export const DEFAULT_MODELS_PROBE_TIMEOUT_MS = 5_000;

/**
 * 本次探测用的超时。settings `env.models_probe_timeout_ms` 可覆盖；
 * 夹在 250ms～60s，避免 0 变成「立即失败」或一个挂死的后台请求。
 */
export function modelsProbeTimeoutMs(cfg: Config): number {
  const v = cfg.env?.modelsProbeTimeoutMs;
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(60_000, Math.max(250, Math.floor(v)));
  }
  return DEFAULT_MODELS_PROBE_TIMEOUT_MS;
}

async function fetchModelEntry(cfg: Config): Promise<Record<string, unknown> | null> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/models`;
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(modelsProbeTimeoutMs(cfg)) });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: unknown };
    const list = Array.isArray(json.data) ? json.data : [];
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (entry["id"] !== cfg.model) continue;
      return entry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 向 provider 的 /models 端点探测当前模型的完整能力。返回 null = 不可达/无该模型条目。
 * 只读，默认 5s 超时（`env.models_probe_timeout_ms` 可覆盖），任何异常都吞掉
 * （探测失败不能影响会话）。
 */
export async function detectModelCapabilitiesFromModelsApi(
  cfg: Config,
): Promise<DetectedModelCapabilities | null> {
  const entry = await fetchModelEntry(cfg);
  if (!entry) return null;
  return {
    contextWindow: windowFromModelEntry(entry),
    maxOutputTokens: outputFromModelEntry(entry),
    ...capabilityFromModelEntry(entry),
    evidence: `${cfg.baseUrl.replace(/\/$/, "")}/models`,
  };
}

/**
 * 向 provider 的 /models 端点探测当前模型窗口。返回 null = 无元数据/不可达。
 * 薄包装，保留给只关心窗口的调用方。
 */
export async function detectModelWindowFromModelsApi(cfg: Config): Promise<number | null> {
  return (await detectModelCapabilitiesFromModelsApi(cfg))?.contextWindow ?? null;
}

/**
 * 探测并记录当前模型能力；返回记录（没有探测结果返回 null）。
 * 若探测值与当前 cfg 不符，调用方决定是否更新 cfg。
 */
export async function detectAndRecordModelWindow(cfg: Config): Promise<ModelContextInfo | null> {
  const caps = await detectModelCapabilitiesFromModelsApi(cfg);
  if (!caps) return null;
  const info: ModelContextInfo = {
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutputTokens,
    vision: caps.vision,
    tools: caps.tools,
    reasoning: caps.reasoning,
    source: "models_api",
    updatedAt: new Date().toISOString(),
    evidence: caps.evidence,
  };
  recordModelContext(cfg, info);
  return info;
}

/**
 * 合并能力事实：settings 手写的 vision/tools/reasoning 权威，探测值只补空缺。
 *
 * 写回策略见 env/modelCaps.ts（P3）：只补**空缺**字段，手写值（含 false）永不覆盖。
 * 用户显式填过的字段永远优先，避免一次网关元数据抖动就改掉用户的判断。
 */
export function mergeModelCapabilities(
  config: { vision?: boolean; tools?: boolean; reasoning?: boolean } | undefined,
  detected: ModelContextInfo | null,
): { vision: CapabilityFlag; tools: CapabilityFlag; reasoning: CapabilityFlag } {
  const pick = (manual: boolean | undefined, probed: CapabilityFlag | undefined): CapabilityFlag =>
    manual === true || manual === false ? manual : (probed ?? "unknown");
  return {
    vision: pick(config?.vision, detected?.vision),
    tools: pick(config?.tools, detected?.tools),
    reasoning: pick(config?.reasoning, detected?.reasoning),
  };
}

/** 数值缺失时的占位（与窗口行既有文案一致）。 */
export const UNKNOWN_LABEL = "未知";

/** 三态能力 → 展示文案（全文统一：是/否/未知）。 */
export function formatCapabilityFlag(v: CapabilityFlag | undefined): string {
  if (v === true) return "是";
  if (v === false) return "否";
  return UNKNOWN_LABEL;
}

function formatTokens(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? `${v.toLocaleString()} tokens`
    : UNKNOWN_LABEL;
}

/** 当前 provider 在 settings 里手写的能力声明（未填 = undefined）。 */
export function manualCapabilitiesOf(cfg: Config): {
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  /** 手写的能力上限。与请求预算 cfg.maxTokens 无关。 */
  maxOutputTokens?: number | null;
} | undefined {
  const p = cfg.providers?.find((x) => x.name === cfg.providerName);
  if (!p) return undefined;
  return {
    vision: p.vision,
    tools: p.tools,
    reasoning: p.reasoning,
    maxOutputTokens: p.maxOutputTokens,
  };
}

/**
 * 能力上限的展示值：手写 `max_output_tokens` 优先，其次 env 探测值。
 * 两者都没有 = null。绝不回落到请求预算 `cfg.maxTokens`。
 */
function declaredOutputLimit(
  manual: { maxOutputTokens?: number | null } | undefined,
  info: ModelContextInfo | null,
): number | null {
  const hand = num(manual?.maxOutputTokens);
  if (hand !== null) return hand;
  return num(info?.maxOutputTokens);
}

/** 一个模型的五项能力展示值（全部已归一成可打印字符串）。 */
export interface ModelCapabilityView {
  contextWindow: string;
  maxOutputTokens: string;
  vision: string;
  tools: string;
  reasoning: string;
}

/**
 * 把一条模型事实 + settings 手写声明合成展示值（P2）。
 *
 * 口径：
 *  - contextWindow 由调用方传入（已按 resolveContextWindow 解析过，含 source）；
 *  - maxOutputTokens：手写 settings 优先，否则只认 ModelContextInfo.maxOutputTokens。
 *    绝不回落到 cfg.maxTokens，那是「本次请求要多少输出」，不是模型能力上限；
 *  - vision/tools/reasoning 走 mergeModelCapabilities：手写优先，探测补空缺，
 *    二者皆无 = 未知。
 */
export function buildModelCapabilityView(
  info: ModelContextInfo | null,
  manual: { vision?: boolean; tools?: boolean; reasoning?: boolean; maxOutputTokens?: number | null } | undefined,
  contextWindow: number | null | undefined,
): ModelCapabilityView {
  const merged = mergeModelCapabilities(manual, info);
  return {
    contextWindow: formatTokens(contextWindow),
    maxOutputTokens: formatTokens(declaredOutputLimit(manual, info)),
    vision: formatCapabilityFlag(merged.vision),
    tools: formatCapabilityFlag(merged.tools),
    reasoning: formatCapabilityFlag(merged.reasoning),
  };
}

/**
 * 探测/手写之后仍然空着的能力，给 `/context` 与 `/env` 的一行提示。
 *
 * 没有缺口返回 null。文案必须让人分清：
 *  - `max_output_tokens` 是能力上限，网关没给就不能当成已经学会；
 *  - 请求预算 `max_tokens` 是另一回事，提示里点名，避免用户拿预算数字去填上限。
 * 手写值（含 vision/tools/reasoning 的 false）不算缺口。
 */
export function formatCapabilityGapHint(cfg: Config): string | null {
  const info = readModelContext(cfg);
  const manual = manualCapabilitiesOf(cfg);
  const missing: string[] = [];
  if (declaredOutputLimit(manual, info) === null) missing.push("max_output_tokens");
  const merged = mergeModelCapabilities(manual, info);
  for (const key of ["vision", "tools", "reasoning"] as const) {
    const hand = manual?.[key];
    if (hand === true || hand === false) continue;
    if (merged[key] === "unknown") missing.push(key);
  }
  if (missing.length === 0) return null;
  const ceiling = missing.includes("max_output_tokens")
    ? "max_output_tokens 是能力上限，请在 settings 手写；它和请求预算 max_tokens 不是同一个字段。"
    : "请在 settings 手写这些能力（false 也算已声明，不会被覆盖）。";
  return `未探测到：${missing.join("、")}。网关未提供这些能力。${ceiling}`;
}

/** 当前模型的能力展示（/context 用）；窗口取 cfg 当前生效值。 */
export function currentModelCapabilityView(cfg: Config): ModelCapabilityView {
  return buildModelCapabilityView(
    readModelContext(cfg),
    manualCapabilitiesOf(cfg),
    cfg.contextWindow,
  );
}

/** 给 `/env` 展示用的可读行（失败返回空数组）。每行含五项能力。 */
export function formatModelWindowLines(cfg: Config): string[] {
  const models = readModelContexts(cfg);
  const entries = Object.entries(models);
  if (entries.length === 0) return [];
  const currentKey = modelKey(cfg.providerName, cfg.model);
  return entries.map(([key, info]) => {
    // 当前模型：窗口用已解析的生效值（可能是配置兜底），手写能力参与合并；
    // 其它模型：只有 env 事实，没有手写声明可套。
    const isCurrent = key === currentKey;
    const manual = isCurrent ? manualCapabilitiesOf(cfg) : undefined;
    const view = buildModelCapabilityView(
      info,
      manual,
      isCurrent ? cfg.contextWindow : info.contextWindow,
    );
    const obs = info.observedMaxPromptTokens
      ? ` · 观测最大 prompt ${info.observedMaxPromptTokens.toLocaleString()}`
      : "";
    // 请求预算只对当前模型有意义（cfg.maxTokens 是这次会话的请求参数，不是模型卡片）。
    const budget =
      isCurrent && typeof cfg.maxTokens === "number" && Number.isFinite(cfg.maxTokens)
        ? ` · 请求预算 max_tokens ${cfg.maxTokens.toLocaleString()}`
        : "";
    return (
      `${key}  ${view.contextWindow}  [${info.source}]${obs}` +
      ` · 能力上限 max_output_tokens ${view.maxOutputTokens}` +
      budget +
      ` · vision ${view.vision}` +
      ` · tools ${view.tools}` +
      ` · reasoning ${view.reasoning}`
    );
  });
}
