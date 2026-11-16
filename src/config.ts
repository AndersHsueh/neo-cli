/**
 * 配置加载。
 *
 * 结构（settings.json）：
 *   default_provider     使用哪个 provider（对应 providers[].provider_name）
 *   default_model_tier   使用哪个模型档位
 *   providers[]          每个 provider 一段独立配置
 *   其余全局字段         与 provider 无关的运行时参数
 *
 * 优先级（从低到高）：settings.example.json → ./settings.json → 环境变量 → CLI 覆盖。
 * 环境变量：NEO_PROVIDER / NEO_TIER / NEO_API_KEY / NEO_BASE_URL / NEO_MODEL。
 *
 * 兼容性：仍能读旧版扁平格式（api-key / OpenAI / model_name 位于顶层），
 * 自动折算成一个名为 legacy 的 provider 并给出警告。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type { EnvConfig } from "./env/types.ts";
import type { ShellConfig } from "./shell.ts";
import { parseHooksConfig } from "./hooks/types.ts";
import { DEFAULT_SELECTION_CONFIG, TIER_ORDER, type PromptSelectionConfig } from "./prompt/select.ts";

import {
  DEFAULT_MAILBOX_CONFIG,
  resolveMailboxConfig,
  type InboundPolicy,
  type MailboxConfig,
} from "./mailbox/types.ts";

import {
  API_TYPE_PREFERENCE,
  ConfigError,
  DEFAULT_RETRY_CONFIG,
  IMPLEMENTED_PROVIDER_TYPES,
  MODEL_TIERS,
  TIER_FIELD,
  isImplemented,
  isModelTier,
  resolveLspConfig,
  resolveModelFallback,
  resolveOutputProbe,
  resolveParallelToolCalls,
  resolveRepoMapConfig,
  type Config,
  type McpServerConfig,
  type MemoryConfig,
  type ModelTier,
  type PasteConfig,
  type ProviderConfig,
  type ProviderType,
  type Raw,
  type RetryConfig,
  type RouteConfig,
  bool,
  boolOrUndef,
  num,
  numOrNull,
  str,
  windowSourceFor,
  normalizeBaseUrl,
} from "./config/types.ts";

// 公共 API 以拆分前 src/config.ts 的导出为准；Raw、TIER_FIELD、num/bool/str 等解析辅助只在配置模块内部使用，不再导出。
export {
  API_TYPE_PREFERENCE,
  ConfigError,
  DEFAULT_LSP,
  DEFAULT_OUTPUT_PROBE,
  DEFAULT_PARALLEL_TOOL_CALLS,
  DEFAULT_REPO_MAP,
  DEFAULT_RETRY_CONFIG,
  IMPLEMENTED_PROVIDER_TYPES,
  MAX_MODEL_FALLBACKS,
  MODEL_TIERS,
  applyModelTarget,
  isImplemented,
  isModelTier,
  normalizeBaseUrl,
  normalizeTierName,
  parseFallbackTarget,
  resolveLspConfig,
  resolveModelFallback,
  resolveOutputProbe,
  resolveParallelToolCalls,
  resolveRepoMapConfig,
  tierChoiceLabel,
  tierDisplayName,
} from "./config/types.ts";
export type {
  Config,
  LspConfig,
  LspServerConfig,
  McpHttpServerConfig,
  McpServerBase,
  McpServerConfig,
  McpSseServerConfig,
  McpStdioServerConfig,
  MemoryConfig,
  ModelTarget,
  ModelTier,
  OutputProbeSettings,
  ParallelToolCallsMode,
  PasteConfig,
  ProviderConfig,
  ProviderType,
  RepoMapConfig,
  RetryConfig,
  RouteConfig,
} from "./config/types.ts";

/**
 * 解析 settings.shell（v0.4.0 平台适配层）。
 *
 * 只做形状校验：路径是否可执行由 shell.ts 在运行时探测（配置写错不崩，
 * 回退到自动探测并给出 warnings）。全缺省 = undefined（纯自动探测）。
 */
function resolveShellConfig(raw: unknown): ShellConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Raw;
  const out: ShellConfig = {};
  const path = r["path"];
  if (typeof path === "string" && path.trim() !== "") out.path = path.trim();
  if (typeof r["login"] === "boolean") out.login = r["login"];
  const args = r["args"];
  if (Array.isArray(args)) {
    const clean = args.filter((a): a is string => typeof a === "string");
    if (clean.length > 0) out.args = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 解析 settings.system_prompt（issue #20）。非法值一律回落默认，不报错：
 * 这是优化项，配置写错不能拖垮启动。比例夹在 0.05–0.3，避免 0 或 1 让预算失去意义。
 */
function resolveSystemPromptConfig(raw: unknown): PromptSelectionConfig {
  const out: PromptSelectionConfig = { ...DEFAULT_SELECTION_CONFIG };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Raw;
  const mode = r["selection_mode"];
  if (mode === "budget-first" || mode === "context-gated") out.selectionMode = mode;
  const ratio = r["system_budget_ratio"];
  if (typeof ratio === "number" && Number.isFinite(ratio)) {
    out.systemBudgetRatio = Math.min(0.3, Math.max(0.05, ratio));
  }
  const maxTier = r["max_tier"];
  if (typeof maxTier === "string" && (TIER_ORDER as readonly string[]).includes(maxTier)) {
    out.maxTier = maxTier as PromptSelectionConfig["maxTier"];
  }
  const unknown = r["unknown_window_budget"];
  if (typeof unknown === "number" && Number.isFinite(unknown) && unknown > 0) {
    out.unknownWindowBudget = Math.floor(unknown);
  }
  if (typeof r["trust_known_window"] === "boolean") out.trustKnownWindow = r["trust_known_window"];
  return out;
}

/**
 * 解析 settings.env（v0.4.0 平台适配层）。
 *
 * 默认全开：enabled=true、TTL 12h、注入提示词、写用户级 wiki 页。
 * -p/非交互模式是否落盘由组合根决定，不在此处。
 */
function resolveEnvConfig(raw: unknown): EnvConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Raw;
  const out: EnvConfig = {};
  if (typeof r["enabled"] === "boolean") out.enabled = r["enabled"];
  if (typeof r["probe_ttl_hours"] === "number" && Number.isFinite(r["probe_ttl_hours"])) {
    out.probeTtlHours = Math.max(0, r["probe_ttl_hours"]);
  }
  if (typeof r["prompt"] === "boolean") out.prompt = r["prompt"];
  if (typeof r["wiki_page"] === "boolean") out.wikiPage = r["wiki_page"];
  const dir = r["dir"];
  if (typeof dir === "string" && dir.trim() !== "") out.dir = dir.trim();
  if (typeof r["models_probe_timeout_ms"] === "number" && Number.isFinite(r["models_probe_timeout_ms"])) {
    // 与 modelWindows.modelsProbeTimeoutMs 同一夹取范围：过小会假阴性，过大拖住后台探测。
    out.modelsProbeTimeoutMs = Math.min(60_000, Math.max(250, Math.floor(r["models_probe_timeout_ms"])));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 解析 settings.mcpServers（issue #2）。
 *
 * 两种写法都接受，因为用户手上多半已经有一份 Claude Desktop / Cursor 的配置：
 *  1. 对象：{ "fs": { "command": "npx", "args": [...] } } —— 键即 server 名；
 *  2. 数组：[{ "name": "fs", "command": "npx", ... }] —— 与 providers 一致的风格。
 *
 * 容错原则：**单个 server 写错只丢这一个，不让整个 CLI 起不来**。
 * 缺 command / 名字非法 / 名字重复 → 跳过该条并记一条 warning（由调用方打印）。
 * 这不是「静默忽略」：warnings 会经 /mcp 与启动提示暴露出来。
 */
export function parseMcpServers(raw: unknown): { servers: McpServerConfig[]; warnings: string[] } {
  const servers: McpServerConfig[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const entries: Array<[string | null, unknown]> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) entries.push([null, item]);
  } else if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw as Raw)) entries.push([k, v]);
  } else if (raw !== undefined && raw !== null) {
    warnings.push("mcpServers 必须是对象或数组，已忽略该段。");
    return { servers, warnings };
  }

  for (const [keyName, item] of entries) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      warnings.push(`mcpServers${keyName ? `.${keyName}` : ""} 不是对象，已跳过。`);
      continue;
    }
    const r = item as Raw;
    const name = str(r["name"], keyName ?? "").trim();
    if (!name) {
      warnings.push("mcpServers 有一条缺少 name，已跳过。");
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      // 名字会进工具名（mcp__<server>__<tool>），带点/斜杠会让模型与日志都难认。
      warnings.push(`mcpServers.${name} 名字非法（只允许字母/数字/_/-），已跳过。`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`mcpServers.${name} 重名，已跳过后面那条。`);
      continue;
    }
    // issue #29：传输层先看 `transport`，兼容 `type` 别名（Claude Code 的写法）。
    // issue #29：先判传输再看 command —— http 条目没有 command，顺序反了会误报「缺少 command」。
    // issue #44：sse 与 http 字段形状相同（url / headers），只有协议形态不同，共用这段解析。
    const transport = str(r["transport"], str(r["type"], "stdio")).trim().toLowerCase();
    if (transport === "http" || transport === "sse") {
      const url = str(r["url"], "").trim();
      if (!url) {
        warnings.push(`mcpServers.${name} 的 transport="${transport}" 缺少 url，已跳过。`);
        continue;
      }
      if (!/^https?:\/\//i.test(url)) {
        warnings.push(`mcpServers.${name} 的 url 必须是 http(s) 绝对地址（得到 "${url}"），已跳过。`);
        continue;
      }
      const headersRaw = r["headers"];
      const headers: Record<string, string> = {};
      if (typeof headersRaw === "object" && headersRaw !== null && !Array.isArray(headersRaw)) {
        for (const [k, v] of Object.entries(headersRaw as Raw)) {
          if (v === null || v === undefined) continue;
          headers[k] = String(v);
        }
      }
      seen.add(name);
      const enabled = bool(r["enabled"], true);
      servers.push(
        transport === "sse"
          ? { name, transport: "sse", url, headers, enabled }
          : { name, transport: "http", url, headers, enabled },
      );
      continue;
    }
    if (transport !== "stdio") {
      // 未知传输：给一句明确的话，而不是「连不上」。
      warnings.push(
        `mcpServers.${name} 的 transport="${transport}" 暂不支持（支持 stdio / http / sse），已跳过。`,
      );
      continue;
    }
    const command = str(r["command"], "").trim();
    if (!command) {
      warnings.push(`mcpServers.${name} 缺少 command，已跳过。`);
      continue;
    }
    const argsRaw = r["args"];
    const args = Array.isArray(argsRaw) ? argsRaw.map((a) => String(a)) : [];
    const envRaw = r["env"];
    const env: Record<string, string> = {};
    if (typeof envRaw === "object" && envRaw !== null && !Array.isArray(envRaw)) {
      for (const [k, v] of Object.entries(envRaw as Raw)) {
        if (v === null || v === undefined) continue;
        env[k] = String(v);
      }
    }
    const cwdRaw = str(r["cwd"], "").trim();
    seen.add(name);
    servers.push({
      name,
      transport: "stdio",
      command,
      args,
      env,
      cwd: cwdRaw === "" ? undefined : cwdRaw,
      enabled: bool(r["enabled"], true),
    });
  }
  return { servers, warnings };
}

/** paste.* 解析：settings.json > 内置默认（3 行 / 300 字符 / 8MB）。 */
function resolvePasteConfig(raw: Raw | undefined): PasteConfig {
  const r = raw ?? {};
  return {
    foldLines: num(r["fold_lines"], 3),
    foldChars: num(r["fold_chars"], 300),
    imageMaxBytes: num(r["image_max_bytes"], 8_388_608),
  };
}

/**
 * 跨会话消息配置（PRD v1.2 §4.6）。settings.json 顶层 snake_case 键；
 * 未配置项取 PRD 裁决默认值（watchdog 120s / 心跳 120s 判死 / 自动 turn 20）。
 */
function resolveMailboxSettings(raw: Raw): MailboxConfig {
  return resolveMailboxConfig({
    autoTurnLimit: num(raw["cross_session_auto_turn_limit"], DEFAULT_MAILBOX_CONFIG.autoTurnLimit),
    heartbeatMs: num(raw["cross_session_heartbeat_ms"], DEFAULT_MAILBOX_CONFIG.heartbeatMs),
    deadAfterMs: num(raw["cross_session_dead_after_ms"], DEFAULT_MAILBOX_CONFIG.deadAfterMs),
    progressTimeoutMs: num(raw["cross_session_progress_timeout_ms"], DEFAULT_MAILBOX_CONFIG.progressTimeoutMs),
    watchdogIntervalS: num(raw["cross_session_watchdog_interval_s"], DEFAULT_MAILBOX_CONFIG.watchdogIntervalS),
  });
}

function resolveInboundPolicy(raw: unknown): InboundPolicy | "auto" {
  return raw === "accept" || raw === "hold" || raw === "refuse" ? raw : "auto";
}

/**
 * 额外技能目录（v0.4.1 B3）：settings.skills_extra_paths + NEO_SKILLS_PATHS。
 * 只做去空白/去重；路径展开由 skills.ts 负责（需要 cfg.cwd 解析相对路径）。
 */
export function parseSkillsExtraPaths(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
    }
  }
  const envRaw = env["NEO_SKILLS_PATHS"];
  if (envRaw) {
    const sep = process.platform === "win32" ? ";" : ":";
    for (const p of envRaw.split(sep)) {
      if (p.trim() !== "") out.push(p.trim());
    }
  }
  return [...new Set(out)];
}

/**
 * LLM 重试/超时配置（P0-1）。settings.json `retry` 段，snake_case 键。
 *
 * 下限保护：max_attempts ≥1，超时 ≥1000ms —— 配成 0 会让所有请求立刻失败，
 * 这不是一个可以用配置表达的意图，直接兜底到合理值。
 */
export function resolveRetryConfig(raw: unknown): RetryConfig {
  const r = (raw ?? {}) as Raw;
  const d = DEFAULT_RETRY_CONFIG;
  return {
    maxAttempts: Math.max(1, Math.floor(num(r["max_attempts"], d.maxAttempts))),
    baseDelayMs: Math.max(0, Math.floor(num(r["base_delay_ms"], d.baseDelayMs))),
    connectTimeoutMs: Math.max(1000, Math.floor(num(r["connect_timeout_ms"], d.connectTimeoutMs))),
    streamIdleTimeoutMs: Math.max(1000, Math.floor(num(r["stream_idle_timeout_ms"], d.streamIdleTimeoutMs))),
  };
}

function readJson(path: string): Raw | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Raw;
  } catch (e) {
    throw new ConfigError(`配置文件解析失败 ${path}: ${(e as Error).message}`);
  }
}

/** provider 显式写了窗口 = config；回落到全局默认时只有顶层显式配置才算 config，否则是兜底 default。 */

/* ------------------------------------------------------------------ */
/* provider 解析                                                       */
/* ------------------------------------------------------------------ */

/**
 * 解析 provider 声明的协议：`api_type`（字符串或数组）优先，缺省回落旧字段 `provider_type`。
 * 结果去重并按 API_TYPE_PREFERENCE 排序 —— 声明了两种就是「两种都可用，优先 anthropic」，
 * 与数组里写的先后无关。
 */
function parseApiTypes(apiType: unknown, providerType: unknown, where: string): ProviderType[] {
  const rawList: unknown[] =
    apiType === undefined || apiType === null ? [] : Array.isArray(apiType) ? apiType : [apiType];
  if (rawList.length === 0) {
    const legacy = str(providerType, "");
    if (!legacy) throw new ConfigError(`${where} 缺少 api_type（可填 "anthropic"、"openai" 或两者的数组）。`);
    rawList.push(legacy);
  }
  const seen = new Set<ProviderType>();
  for (const v of rawList) {
    if (v !== "openai" && v !== "anthropic") {
      throw new ConfigError(
        `${where} 的 api_type 含 ${JSON.stringify(v)}，不是已知协议。可用：openai、anthropic。`,
      );
    }
    seen.add(v);
  }
  return API_TYPE_PREFERENCE.filter((t) => seen.has(t));
}

/** 某 provider 在指定协议下的 base_url。 */
export function providerBaseUrl(p: ProviderConfig, type: ProviderType): string {
  return p.baseUrls?.[type] ?? p.baseUrl;
}

/** 解析 providers 数组。字段缺失时抛出可定位的错误，而不是静默用空值。 */
function parseProviders(raw: unknown): ProviderConfig[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError("settings.json 缺少 providers 数组，或它不是数组。");
  }
  if (raw.length === 0) {
    throw new ConfigError("providers 数组为空，至少需要一个 provider。");
  }

  return raw.map((entry, i): ProviderConfig => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`providers[${i}] 不是对象。`);
    }
    const p = entry as Raw;
    const where = `providers[${i}]`;

    const name = str(p["provider_name"], "");
    if (!name) throw new ConfigError(`${where} 缺少 provider_name。`);

    const apiTypes = parseApiTypes(p["api_type"], p["provider_type"], `${where}（${name}）`);
    const type = apiTypes[0]!;

    const sharedUrl = normalizeBaseUrl(str(p["base_url"], str(p["OpenAI"], "")));
    const baseUrls: Partial<Record<ProviderType, string>> = {};
    for (const t of apiTypes) {
      const own = normalizeBaseUrl(str(p[`${t}_base_url`], ""));
      const url = own || sharedUrl;
      if (!url) {
        throw new ConfigError(
          `${where}（${name}）缺少 base_url（或 ${t}_base_url）：api_type 含 ${t}，需要它的端点地址。`,
        );
      }
      baseUrls[t] = url;
    }
    const baseUrl = baseUrls[type]!;

    const apiKey = str(p["api_key"], str(p["api-key"], ""));

    // 四个档位：缺失的档位回落到 default_model_name，再回落到任意已填档位
    const fallbackModel =
      str(p["default_model_name"], "") ||
      str(p["deep_reasoning_model_name"], "") ||
      str(p["balanced_model_name"], "") ||
      str(p["fast_model_name"], "");
    const models = {} as Record<ModelTier, string>;
    for (const tier of MODEL_TIERS) {
      models[tier] = str(p[TIER_FIELD[tier]], fallbackModel);
    }
    if (!fallbackModel) {
      throw new ConfigError(`${where}（${name}）的四个模型档位全部为空，至少要填 default_model_name。`);
    }

    return {
      name,
      type,
      apiTypes,
      baseUrl,
      baseUrls,
      apiKey,
      models,
      maxTokens: numOrNull(p["max_tokens"]),
      temperature: numOrNull(p["temperature"]),
      contextWindow: numOrNull(p["context_window"]),
      vision: boolOrUndef(p["vision"]),
      tools: boolOrUndef(p["tools"]),
      reasoning: boolOrUndef(p["reasoning"]),
      maxOutputTokens: numOrNull(p["max_output_tokens"]),
      outputProbe: resolveOutputProbe(p["probe_max_output_tokens"]),
    };
  });
}

/**
 * 旧版扁平格式 → ProviderConfig。
 * 旧字段：api-key / OpenAI / model_name。折算后四个档位共用同一模型。
 */
function providerFromLegacy(raw: Raw): ProviderConfig | null {
  const baseUrl = normalizeBaseUrl(str(raw["OpenAI"], ""));
  const model = str(raw["model_name"], "");
  if (!baseUrl && !model) return null;

  return {
    name: "legacy",
    type: "openai",
    baseUrl: baseUrl || "https://api.openai.com/v1",
    apiKey: str(raw["api-key"], ""),
    models: {
      default: model,
      deep_reasoning: model,
      balanced: model,
      fast: model,
    },
    maxTokens: numOrNull(raw["max_tokens"]),
    temperature: numOrNull(raw["temperature"]),
    contextWindow: numOrNull(raw["context_window"]),
    vision: boolOrUndef(raw["vision"]),
    tools: boolOrUndef(raw["tools"]),
    reasoning: boolOrUndef(raw["reasoning"]),
    maxOutputTokens: numOrNull(raw["max_output_tokens"]),
    outputProbe: resolveOutputProbe(raw["probe_max_output_tokens"]),
  };
}

/* ------------------------------------------------------------------ */
/* 载入                                                                */
/* ------------------------------------------------------------------ */

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const here = process.cwd();
  // v0.4.0：Windows 上 URL.pathname 是 /C:/... 形态，必须用 fileURLToPath 还原盘符路径。
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  const candidates = [
    join(here, "settings.json"),
    join(pkgRoot, "settings.json"),
    join(homedir(), ".neo", "settings.json"),
  ];
  const found = candidates.find((p) => existsSync(p)) ?? null;
  const raw = found ? (readJson(found) ?? {}) : {};
  const dflt = readJson(join(pkgRoot, "settings.example.json")) ?? {};

  // providers 是数组，无法用 {...a, ...b} 浅合并，必须按「本地优先」逐级判定。
  // 关键顺序：本地 settings.json 的旧版字段必须优先于模板的 providers。
  // 否则用户拿着旧配置会静默套用 settings.example.json 的示例密钥与地址 ——
  // 不报错，但请求全打到别人的网关上，这种失败极难排查。
  let providers: ProviderConfig[];
  let legacyFormat = false;
  const localList = raw["providers"];
  const localLegacy = providerFromLegacy(raw);
  const tplList = dflt["providers"];
  const tplLegacy = providerFromLegacy(dflt);

  if (localList !== undefined) {
    providers = parseProviders(localList);
  } else if (localLegacy) {
    providers = [localLegacy];
    legacyFormat = true;
  } else if (tplList !== undefined) {
    providers = parseProviders(tplList);
  } else if (tplLegacy) {
    providers = [tplLegacy];
    legacyFormat = true;
  } else {
    throw new ConfigError(
      `未在 ${found ?? "任何搜索路径"} 找到可用的 provider 配置。` +
        `请参考 settings.example.json 写一份 settings.json。`,
    );
  }

  // 默认 provider：环境变量 > settings.json > 列表第一项。
  // 不从模板回落 —— 模板的 "example" 是示例名，本地 providers 里通常没有这个名字，
  // 回落它会让 picked 静默退化成列表第一项，掩盖配置错误。
  const defProviderName = str(
    process.env["NEO_PROVIDER"],
    str(raw["default_provider"], providers[0]?.name ?? ""),
  );
  const picked =
    providers.find((p) => p.name === defProviderName) ?? providers[0];
  if (!picked) throw new ConfigError("没有可用的 provider。");

  // 默认档位
  const tierRaw = str(
    process.env["NEO_TIER"],
    str(raw["default_model_tier"], str(dflt["default_model_tier"], "default")),
  );
  const tier: ModelTier = isModelTier(tierRaw) ? tierRaw : "default";

  // 全局默认（provider 未覆盖时使用）
  const gMax = num(raw["max_tokens"], num(dflt["max_tokens"], 8192));
  const gTemp = num(raw["temperature"], num(dflt["temperature"], 0.6));
  const gCtx = num(raw["context_window"], num(dflt["context_window"], 200_000));
  // 窗口值是否由用户显式写过：provider 级或 settings 顶层。都没写时 gCtx 来自模板/内置 200,000，
  // 只是兜底，不是事实——选系统提示词档位时不能当成已证实窗口（issue #20）。
  const ctxExplicit = picked.contextWindow != null || typeof raw["context_window"] === "number";

  // ---- 档位路由 ----
  // 未显式配置时，每个档位都指向当前 provider 的对应模型（即旧的单provider 行为）。
  // 同样不从模板回落 model_routes：模板里的 provider 名（"example"）与本地无关，
  // 混进来会凭空造出一条指向不存在 provider 的路由，或直接抛错。
  const rawRoutes = raw["model_routes"] as Raw | undefined;
  const routes = {} as Record<ModelTier, RouteConfig>;
  for (const t of MODEL_TIERS) {
    const entry = rawRoutes?.[t];
    if (entry !== undefined && typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const r = entry as Raw;
      const rProvider = str(r["provider"], "");
      if (!rProvider) {
        throw new ConfigError(`model_routes.${t} 缺少 provider 字段。`);
      }
      if (!providers.some((p) => p.name === rProvider)) {
        throw new ConfigError(
          `model_routes.${t}.provider = "${rProvider}" 不在 providers 列表中。` +
            `已配置：${providers.map((p) => p.name).join(", ")}`,
        );
      }
      routes[t] = {
        provider: rProvider,
        model: str(r["model"], ""),
        fallbackAllowed: bool(r["fallback_allowed"], true),
      };
    } else if (entry !== undefined && typeof entry === "string") {
      // 简写形式："fast": "ipsa" 等价于 {provider:"ipsa", model:null}
      const name = entry as string;
      if (!providers.some((p) => p.name === name)) {
        throw new ConfigError(`model_routes.${t} = "${name}" 不在 providers 列表中。`);
      }
      routes[t] = { provider: name, model: null, fallbackAllowed: true };
    } else {
      routes[t] = { provider: picked.name, model: null, fallbackAllowed: true };
    }
  }

  // 分类器固定绑在外部指定的 provider 上 —— 不能让它用自己的分类结果选自己
  //
  // 注意：classifier_provider 是「身份」字段，不能从模板回落。
  // 模板里写的是示例值 "example"，本地配置若没写这一项就回落模板，
  // 会得到一个不在本地 providers 列表里的名字，直接把启动卡死。
  // 这与 providers 的处理是同一个道理：身份字段只认本地，模板只提供可调参数。
  const classifierProvider = str(
    process.env["NEO_CLASSIFIER_PROVIDER"],
    str(raw["classifier_provider"], str(raw["default_provider"], picked.name)),
  );
  const clsProv = providers.find((p) => p.name === classifierProvider);
  if (!clsProv) {
    throw new ConfigError(
      `classifier_provider = "${classifierProvider}" 不在 providers 列表中。` +
        `已配置：${providers.map((p) => p.name).join(", ")}`,
    );
  }
  // 同理，模型名也不从模板取 —— 模板值是 "your-fast-model-id" 这种占位符，
  // 落到真实请求里就是一次必然失败的调用。缺省用该 provider 的 fast 模型。
  const classifierModel = str(
    process.env["NEO_CLASSIFIER_MODEL"],
    str(raw["classifier_model_name"], clsProv.models["fast"]),
  );

  const cfg: Config = {
    providerName: picked.name,
    providerType: picked.type,
    // 环境变量优先级最高
    apiKey: str(process.env["NEO_API_KEY"], picked.apiKey),
    baseUrl: normalizeBaseUrl(str(process.env["NEO_BASE_URL"], picked.baseUrl)),
    modelTier: tier,
    model: str(process.env["NEO_MODEL"], routeModel(routes[tier], providers, tier)),
    providers,
    routes,
    classifierModel,
    classifierProvider,
    legacyFormat,
    /** max_tokens 配置体检结果（issue #21 A）；启动块逐条 ui.warn，空数组 = 无告警。 */
    maxTokensWarnings: auditMaxTokens(providers),

    maxTokens: picked.maxTokens ?? gMax,
    temperature: picked.temperature ?? gTemp,
    contextWindow: picked.contextWindow ?? gCtx,
    configuredContextWindow: picked.contextWindow ?? gCtx,
    contextWindowSource: ctxExplicit ? "config" : "default",
    configuredContextWindowExplicit: ctxExplicit,
    globalWindowExplicit: typeof raw["context_window"] === "number",
    globalDefaults: { maxTokens: gMax, temperature: gTemp, contextWindow: gCtx },
    compactThreshold: num(raw["compact_threshold"], num(dflt["compact_threshold"], 0.75)),
    maxToolIterations: num(raw["max_tool_iterations"], num(dflt["max_tool_iterations"], 80)),
    toolOutputLimit: num(raw["tool_output_limit"], num(dflt["tool_output_limit"], 30_000)),
    retry: resolveRetryConfig(raw["retry"]),
    parallelToolCalls: resolveParallelToolCalls(raw["parallel_tool_calls"]),
    theme: str(raw["theme"], str(dflt["theme"], "matrix")),
    showReasoning: bool(raw["show_reasoning"], bool(dflt["show_reasoning"], true)),
    // 兼容用户手写的连字符键名；项目惯例仍是 snake_case。
    toolcallInfoDetails: bool(
      raw["toolcall_info_details"],
      bool(raw["toolcall-info-details"], false),
    ),
    cwd: here,
    settingsPath: found,
    skillsStore: str(raw["skills_store"], join(homedir(), ".neo", "skills")),
    skillsExtraPaths: parseSkillsExtraPaths(raw["skills_extra_paths"]),
    memory: resolveMemoryConfig(raw["memory"] as Raw | undefined),
    shell: resolveShellConfig(raw["shell"]),
    // MCP 只认本地 settings.json：模板里的示例 server 不该在用户机器上被启动。
    mcpServers: parseMcpServers(raw["mcpServers"]).servers,
    // hooks 同理只认本地：模板里的示例 hook 不该在用户机器上被执行。
    hooks: parseHooksConfig(raw["hooks"]),
    env: resolveEnvConfig(raw["env"]),
    systemPrompt: resolveSystemPromptConfig(raw["system_prompt"]),
    paste: resolvePasteConfig(raw["paste"] as Raw | undefined),
    repoMap: resolveRepoMapConfig(raw["repo_map"]),
    lsp: resolveLspConfig(raw["lsp"]).config,
    lspWarnings: resolveLspConfig(raw["lsp"]).warnings,
    modelFallback: resolveModelFallback(raw["model_fallback"], providers),
    mailbox: resolveMailboxSettings(raw),
    crossSessionInbound: resolveInboundPolicy(raw["cross_session_inbound"]),
    ...overrides,
  };

  if (overrides.cwd && !isAbsolute(overrides.cwd)) cfg.cwd = resolve(here, overrides.cwd);
  return cfg;
}

/**
 * 解析 settings.memory.* 段（v0.2 记忆激活；规格 §7.9）。
 *
 * 优先级：环境变量 > settings.json > 内置默认。
 *  - NEO_MEMORY_DISABLE=1 → enabled=false
 *  - NEO_MEMORY_DIR=<路径> → userLevelDir（旧目录，仅供 /memory migrate 与 profile 兼容读取）
 *  - NEO_USER_WIKI_DIR=<路径> → userWikiDir
 *  - NEO_MEMORY_JOURNAL_DIR=<路径> → journalDir
 *
 * v0.1.12 清理：旧字段解析全部移除；settings.json 里的未知 memory 键静默忽略。
 */
function resolveMemoryConfig(raw: Raw | undefined): MemoryConfig {
  const r = raw ?? {};
  const envDisable = process.env["NEO_MEMORY_DISABLE"] === "1";
  const envDir = process.env["NEO_MEMORY_DIR"];
  const envUserWiki = process.env["NEO_USER_WIKI_DIR"];
  const envJournal = process.env["NEO_MEMORY_JOURNAL_DIR"];

  // 旧用户级目录：只用于 /memory migrate 与旧 profile.md 兼容读取
  const userLevelDirRaw = envDir ?? str(r["user_level_dir"], join(homedir(), ".neo", "memorys"));
  const userLevelDir = isAbsolute(userLevelDirRaw) ? userLevelDirRaw : resolve(userLevelDirRaw);

  const userWikiRaw = envUserWiki ?? str(r["user_wiki_dir"], join(homedir(), ".neo", "wiki"));
  const userWikiDir = isAbsolute(userWikiRaw) ? userWikiRaw : resolve(userWikiRaw);
  const memJournalRaw = envJournal ?? str(r["journal_dir"], join(homedir(), ".neo", "memory", "journal"));
  const journalDir = isAbsolute(memJournalRaw) ? memJournalRaw : resolve(memJournalRaw);

  const recallRaw = (r["auto_recall"] ?? {}) as Raw;
  const autoRecall = {
    enabled: bool(recallRaw["enabled"], true),
    maxTokens: num(recallRaw["max_tokens"], 900),
    projectPages: num(recallRaw["project_pages"], 2),
    userPages: num(recallRaw["user_pages"], 1),
  };

  const captureRaw = (r["auto_capture"] ?? {}) as Raw;
  const modeRaw = str(captureRaw["mode"], "boundary");
  const mode: "off" | "boundary" | "every_turn" =
    modeRaw === "off" || modeRaw === "every_turn" ? modeRaw : "boundary";
  const autoCapture = {
    enabled: bool(captureRaw["enabled"], true),
    mode,
    modelTier: str(captureRaw["model_tier"], "fast"),
    maxOpsPerTurn: num(captureRaw["max_ops_per_turn"], 2),
    maxPagesPerSession: num(captureRaw["max_pages_per_session"], 8),
    minConfidence: num(captureRaw["min_confidence"], 0.65),
    minInferredConfidence: num(captureRaw["min_inferred_confidence"], 0.75),
    journalRetentionDays: num(captureRaw["journal_retention_days"], 7),
    flushTimeoutMs: num(captureRaw["flush_timeout_ms"], 3000),
  };

  return {
    enabled: !envDisable && bool(r["enabled"], true),
    userLevelDir,
    userWikiDir,
    journalDir,
    autoRecall,
    autoCapture,
    quiet: bool(r["quiet"], false),
  };
}

/* ------------------------------------------------------------------ */
/* max_tokens 配置体检（issue #21 A）                                    */
/* ------------------------------------------------------------------ */

/**
 * 逐 provider 体检 max_tokens 是否明显不合理，返回人类可读的告警文案。
 *
 * 两条判据（都要求比较双方非 null —— 瘦网关没声明就不猜）：
 *  1. max_tokens ≥ context_window：输出预算 ≥ 上下文窗口，网关/模型几乎必然拒绝
 *     （issue #21 的原始事故：512000/512000）；
 *  2. max_tokens > max_output_tokens：超过已声明的模型单次输出上限。
 *
 * 只告警不改配置：用户配的是意图，neo 不替用户改文件；网关的真实上限是运行时事实，
 * 由 llm.ts 的上限学习（v0.4.75）与不透明 400 降级（本版 B）兜底。
 * 正常配置不误报：模板默认 8192 / 200000 两条都不命中。
 */
export function auditMaxTokens(providers: ProviderConfig[]): string[] {
  const out: string[] = [];
  for (const p of providers) {
    if (p.maxTokens == null) continue;
    if (p.contextWindow != null && p.maxTokens >= p.contextWindow) {
      out.push(
        `max_tokens 配置告警：provider "${p.name}" 的 max_tokens=${p.maxTokens.toLocaleString()} ≥ context_window=${p.contextWindow.toLocaleString()}。` +
          `max_tokens 是本次请求的输出预算，不是上下文窗口；这个值几乎必然被网关/模型拒绝，建议改小（如 8192）。`,
      );
      continue; // 同一 provider 只报最直接的一条，第二条是重复信号
    }
    if (p.maxOutputTokens != null && p.maxTokens > p.maxOutputTokens) {
      out.push(
        `max_tokens 配置告警：provider "${p.name}" 的 max_tokens=${p.maxTokens.toLocaleString()} > max_output_tokens=${p.maxOutputTokens.toLocaleString()}（已声明的模型单次输出上限）。` +
          `这个值会被网关/模型拒绝，建议改到上限以内。`,
      );
    }
  }
  return out;
}

/** 解析某档位在路由表下的实际模型名。route.model 为空则取该 provider 的同名档位。 */
function routeModel(
  route: RouteConfig,
  providers: ProviderConfig[],
  tier: ModelTier,
): string {
  if (route.model) return route.model;
  const p = providers.find((x) => x.name === route.provider);
  return p?.models[tier] ?? "unknown";
}

/**
 * 把当前配置切到指定档位对应的目标 {provider, model}。
 *
 * 这是跨供应商调度的关键：档位不是「当前 provider 下的模型名」，
 * 而是「provider + model」的绑定。切档可能连带换供应商。
 *
 * 降级策略：目标 provider 的协议若未接入，按 fallbackAllowed 决定
 * 是静默回落 default 档还是报错。默认允许回落 —— 整个设计的地基是
 * 「default 永远能调通」，所以它必须承担兜底职责。
 */
export function applyTier(
  cfg: Config,
  tier: ModelTier,
): { ok: true; degraded: boolean; note?: string } | { ok: false; error: string } {
  const route = cfg.routes[tier];
  if (!route) return { ok: false, error: `未知档位 ${tier}` };

  const target = cfg.providers.find((p) => p.name === route.provider);
  if (!target) return { ok: false, error: `档位 ${tier} 指向不存在的 provider "${route.provider}"` };

  if (!isImplemented(target.type)) {
    if (!route.fallbackAllowed) {
      return {
        ok: false,
        error:
          `档位 ${tier} → ${target.name}（${target.type} 协议未接入），` +
          `且该路由设置了 fallback_allowed: false。`,
      };
    }
    if (tier === "default") {
      return {
        ok: false,
        error: `default 档位指向未接入的 ${target.name}，无更低档可降。`,
      };
    }
    // 降级到 default
    const defRoute = cfg.routes["default"];
    const defProv = cfg.providers.find((p) => p.name === defRoute.provider);
    if (!defProv || !isImplemented(defProv.type)) {
      return {
        ok: false,
        error: `档位 ${tier} 不可用，且 default 档位也不可用，无法降级。`,
      };
    }
    cfg.modelTier = "default";
    cfg.providerName = defProv.name;
    cfg.providerType = defProv.type;
    cfg.apiKey = defProv.apiKey;
    cfg.baseUrl = defProv.baseUrl;
    cfg.model = routeModel(defRoute, cfg.providers, "default");
    cfg.maxTokens = defProv.maxTokens ?? cfg.globalDefaults.maxTokens;
    cfg.temperature = defProv.temperature ?? cfg.globalDefaults.temperature;
    cfg.contextWindow = defProv.contextWindow ?? cfg.globalDefaults.contextWindow;
    cfg.configuredContextWindow = cfg.contextWindow;
    cfg.contextWindowSource = windowSourceFor(cfg, defProv.contextWindow);
    cfg.configuredContextWindowExplicit = cfg.contextWindowSource === "config";
    return {
      ok: true,
      degraded: true,
      note: `档位 ${tier} 指向 ${target.name}（${target.type} 未接入），已降级到 default / ${defProv.name}`,
    };
  }

  cfg.modelTier = tier;
  cfg.providerName = target.name;
  cfg.providerType = target.type;
  cfg.apiKey = target.apiKey;
  cfg.baseUrl = target.baseUrl;
  cfg.model = routeModel(route, cfg.providers, tier);
  cfg.maxTokens = target.maxTokens ?? cfg.globalDefaults.maxTokens;
  cfg.temperature = target.temperature ?? cfg.globalDefaults.temperature;
  cfg.contextWindow = target.contextWindow ?? cfg.globalDefaults.contextWindow;
  cfg.configuredContextWindow = cfg.contextWindow;
  cfg.contextWindowSource = windowSourceFor(cfg, target.contextWindow);
  cfg.configuredContextWindowExplicit = cfg.contextWindowSource === "config";
  return { ok: true, degraded: false };
}

/** 某档位当前是否可用（目标 provider 已接入）。分类器据此避免推荐不可用的档。 */
export function tierAvailable(cfg: Config, tier: ModelTier): boolean {
  const route = cfg.routes[tier];
  if (!route) return false;
  const p = cfg.providers.find((x) => x.name === route.provider);
  return p !== undefined && isImplemented(p.type);
}

/** 某档位的路由描述，供 /tier 展示。 */
export function describeRoute(cfg: Config, tier: ModelTier): string {
  const route = cfg.routes[tier];
  if (!route) return "未配置";
  const p = cfg.providers.find((x) => x.name === route.provider);
  const model = routeModel(route, cfg.providers, tier);
  const okTag = p && isImplemented(p.type) ? "" : " (未接入)";
  return `${route.provider} / ${model}${okTag}`;
}

/**
 * 切换 provider。会重算 model / baseUrl / apiKey 及该 provider 覆盖的运行时参数。
 *
 * 档位保持不变，但 model 改为「该 provider 在当前档位下的模型」。
 * 注意这与 applyTier 不同：applyTier 是「档位决定 provider」，
 * 这里是「provider 决定模型」—— 手动指定供应商时应当听用户的，不走路由表。
 */
export function switchProvider(cfg: Config, name: string): { ok: true } | { ok: false; error: string } {
  const target = cfg.providers.find((p) => p.name === name);
  if (!target) {
    const names = cfg.providers.map((p) => p.name).join(", ");
    return { ok: false, error: `未找到 provider "${name}"。可用：${names || "（无）"}` };
  }

  // 先校验再赋值：未接入的协议必须原样留在当前 provider 上，不能先切过去再报错
  if (!isImplemented(target.type)) {
    return {
      ok: false,
      error:
        `provider "${target.name}" 声明为 ${target.type} 协议，但请求层尚未接入。` +
        `已实现的协议：${IMPLEMENTED_PROVIDER_TYPES.join(", ")}。` +
        `切换已取消，仍在使用 ${cfg.providerName}。`,
    };
  }

  const g = cfg.globalDefaults;
  cfg.providerName = target.name;
  cfg.providerType = target.type;
  cfg.apiKey = target.apiKey;
  cfg.baseUrl = target.baseUrl;
  cfg.model = target.models[cfg.modelTier];
  // provider 没覆盖的项回落到全局默认，而不是沿用上一个 provider 的值
  cfg.maxTokens = target.maxTokens ?? g.maxTokens;
  cfg.temperature = target.temperature ?? g.temperature;
  cfg.contextWindow = target.contextWindow ?? g.contextWindow;
  cfg.configuredContextWindow = cfg.contextWindow;
  cfg.contextWindowSource = windowSourceFor(cfg, target.contextWindow);
  cfg.configuredContextWindowExplicit = cfg.contextWindowSource === "config";

  return { ok: true };
}

/**
 * 切换模型档位。走路由表，可能连带换供应商。
 * 返回降级信息供调用方提示。
 */
export function switchTier(
  cfg: Config,
  tier: ModelTier,
): { ok: true; degraded: boolean; note?: string } | { ok: false; error: string } {
  return applyTier(cfg, tier);
}

/** 脱敏展示 key，只保留头尾。 */
export function maskKey(k: string): string {
  if (!k) return "<未设置>";
  if (k.length <= 12) return "*".repeat(k.length);
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}
