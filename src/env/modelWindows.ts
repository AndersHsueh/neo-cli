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
  const resolved = resolveContextWindow(fallback, cfg.model, info);
  cfg.contextWindow = resolved.tokens;
  cfg.contextWindowSource = resolved.source;
  return resolved;
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

/** 输出上限字段名（与 context_window 区分：这是单次生成的上限，不是输入窗口）。 */
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

async function fetchModelEntry(cfg: Config): Promise<Record<string, unknown> | null> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/models`;
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(2_500) });
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
 * 只读、2.5s 超时，任何异常都吞掉（探测失败不能影响会话）。
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
 * 为什么不写回 settings：P1 只做「读」，探测结果进 env 快照；
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

/** 给 `/env` 展示用的可读行（失败返回空数组）。 */
export function formatModelWindowLines(cfg: Config): string[] {
  const models = readModelContexts(cfg);
  const entries = Object.entries(models);
  if (entries.length === 0) return [];
  return entries.map(([key, info]) => {
    const win = info.contextWindow ? `${info.contextWindow.toLocaleString()} tokens` : "未知";
    const obs = info.observedMaxPromptTokens ? ` · 观测最大 prompt ${info.observedMaxPromptTokens.toLocaleString()}` : "";
    return `${key}  ${win}  [${info.source}]${obs}`;
  });
}
