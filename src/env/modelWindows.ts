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
import type { ModelContextInfo } from "./types.ts";
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
  const resolved = resolveContextWindow(cfg.contextWindow, cfg.model, info);
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
      loadEnv({ cfg, persist: true });
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
 * 向 provider 的 /models 端点探测当前模型窗口。返回 null = 无元数据/不可达。
 * 只读、2.5s 超时，任何异常都吞掉。
 */
export async function detectModelWindowFromModelsApi(cfg: Config): Promise<number | null> {
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
      return windowFromModelEntry(entry);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 探测并记录当前模型窗口；返回记录（没有探测结果返回 null）。
 * 若探测值与当前 cfg 不符，调用方决定是否更新 cfg。
 */
export async function detectAndRecordModelWindow(cfg: Config): Promise<ModelContextInfo | null> {
  const tokens = await detectModelWindowFromModelsApi(cfg);
  if (tokens === null) return null;
  const info: ModelContextInfo = {
    contextWindow: tokens,
    source: "models_api",
    updatedAt: new Date().toISOString(),
    evidence: `${cfg.baseUrl.replace(/\/$/, "")}/models`,
  };
  recordModelContext(cfg, info);
  return info;
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
