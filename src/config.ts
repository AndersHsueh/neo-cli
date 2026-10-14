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

/**
 * 已实现的 provider 协议类型。
 *
 * anthropic 尚未接入请求层。配置里可以先写上（占位、规划用），
 * 但一旦真被选中就会明确报错 —— 不能静默按 openai 协议发请求，
 * 两者鉴权头与响应结构都不兼容。
 */
export type ProviderType = "openai" | "anthropic";

/** 真正实现了请求层适配的类型。其余为「已声明但未接入」。 */
export const IMPLEMENTED_PROVIDER_TYPES: readonly ProviderType[] = ["openai"];

export function isImplemented(type: ProviderType): boolean {
  return IMPLEMENTED_PROVIDER_TYPES.includes(type);
}

/** 模型档位。取值决定用 provider 下的哪个 *_model_name 字段。 */
export type ModelTier = "default" | "deep_reasoning" | "balanced" | "fast";

export const MODEL_TIERS: readonly ModelTier[] = [
  "default",
  "deep_reasoning",
  "balanced",
  "fast",
];

const TIER_FIELD: Record<ModelTier, string> = {
  default: "default_model_name",
  deep_reasoning: "deep_reasoning_model_name",
  balanced: "balanced_model_name",
  fast: "fast_model_name",
};

export function isModelTier(v: string): v is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(v);
}

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  /** 四个档位各自对应的模型 ID。 */
  models: Record<ModelTier, string>;
  /** 该 provider 的运行时参数；缺省时回落到全局值。 */
  maxTokens: number | null;
  temperature: number | null;
  contextWindow: number | null;
}

/** 档位 → 目标 {provider, model} 的绑定。跨供应商调度靠这个。 */
export interface RouteConfig {
  provider: string;
  model: string | null;
  /** 目标 provider 的协议未接入时，是否允许静默降级。 */
  fallbackAllowed: boolean;
}

export interface Config {
  /** 当前选中的 provider（已解析为具体值）。 */
  providerName: string;
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  /** 当前档位。 */
  modelTier: ModelTier;
  /** 由档位解析出的实际模型 ID。 */
  model: string;
  /** 全部 provider，供 /provider 展示与切换。 */
  providers: ProviderConfig[];
  /**
   * 档位路由表：tier → {provider, model}。
   * 与 provider 内的 models 正交 —— 档位可以指向任意 provider 的任意模型。
   */
  routes: Record<ModelTier, RouteConfig>;
  /** 分类器自己用的模型与 provider（固定外部指定，避免循环依赖）。 */
  classifierModel: string;
  classifierProvider: string;
  /** 本次启动是否使用了旧版扁平配置。 */
  legacyFormat: boolean;

  maxTokens: number;
  temperature: number;
  contextWindow: number;
  /** 顶层全局默认。provider 未覆盖某项时用它，切换 provider 时据此回滚。 */
  globalDefaults: { maxTokens: number; temperature: number; contextWindow: number };
  compactThreshold: number;
  maxToolIterations: number;
  toolOutputLimit: number;
  theme: string;
  showReasoning: boolean;
  /** 透传给服务端的思考开关；不设则不下发该字段，由服务端自行决定。 */
  thinking?: { type: "enabled" | "disabled" };
  cwd: string;
  settingsPath: string | null;
}

type Raw = Record<string, unknown>;

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export { ConfigError };

function readJson(path: string): Raw | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Raw;
  } catch (e) {
    throw new ConfigError(`配置文件解析失败 ${path}: ${(e as Error).message}`);
  }
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function str(v: unknown, d: string): string {
  return typeof v === "string" && v.length > 0 ? v : d;
}

export function normalizeBaseUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------ */
/* provider 解析                                                       */
/* ------------------------------------------------------------------ */

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

    const typeRaw = str(p["provider_type"], "");
    if (!typeRaw) throw new ConfigError(`${where}（${name}）缺少 provider_type。`);
    const type = typeRaw as ProviderType;
    if (type !== "openai" && type !== "anthropic") {
      throw new ConfigError(
        `${where}（${name}）的 provider_type = "${typeRaw}" 不是已知协议。` +
          `可用：openai、anthropic。`,
      );
    }

    const baseUrl = normalizeBaseUrl(str(p["base_url"], str(p["OpenAI"], "")));
    if (!baseUrl) {
      throw new ConfigError(`${where}（${name}）缺少 base_url。`);
    }

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
      baseUrl,
      apiKey,
      models,
      maxTokens: numOrNull(p["max_tokens"]),
      temperature: numOrNull(p["temperature"]),
      contextWindow: numOrNull(p["context_window"]),
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
  };
}

/* ------------------------------------------------------------------ */
/* 载入                                                                */
/* ------------------------------------------------------------------ */

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const here = process.cwd();
  const pkgRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");

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

  // 默认 provider：settings.json > example 模板 > 列表第一项
  const defProviderName = str(
    process.env["NEO_PROVIDER"],
    str(raw["default_provider"], str(dflt["default_provider"], providers[0]?.name ?? "")),
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

  // ---- 档位路由 ----
  // 未显式配置时，每个档位都指向当前 provider 的对应模型（即旧的单 provider 行为）。
  const rawRoutes = (raw["model_routes"] ?? dflt["model_routes"]) as Raw | undefined;
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
  const classifierProvider = str(
    process.env["NEO_CLASSIFIER_PROVIDER"],
    str(
      raw["classifier_provider"],
      str(dflt["classifier_provider"], str(raw["default_provider"], str(dflt["default_provider"], picked.name))),
    ),
  );
  const clsProv = providers.find((p) => p.name === classifierProvider);
  if (!clsProv) {
    throw new ConfigError(
      `classifier_provider = "${classifierProvider}" 不在 providers 列表中。` +
        `已配置：${providers.map((p) => p.name).join(", ")}`,
    );
  }
  const classifierModel = str(
    process.env["NEO_CLASSIFIER_MODEL"],
    str(raw["classifier_model_name"], str(dflt["classifier_model_name"], clsProv.models["fast"])),
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

    maxTokens: picked.maxTokens ?? gMax,
    temperature: picked.temperature ?? gTemp,
    contextWindow: picked.contextWindow ?? gCtx,
    globalDefaults: { maxTokens: gMax, temperature: gTemp, contextWindow: gCtx },
    compactThreshold: num(raw["compact_threshold"], num(dflt["compact_threshold"], 0.75)),
    maxToolIterations: num(raw["max_tool_iterations"], num(dflt["max_tool_iterations"], 40)),
    toolOutputLimit: num(raw["tool_output_limit"], num(dflt["tool_output_limit"], 30_000)),
    theme: str(raw["theme"], str(dflt["theme"], "matrix")),
    showReasoning: bool(raw["show_reasoning"], bool(dflt["show_reasoning"], true)),
    cwd: here,
    settingsPath: found,
    ...overrides,
  };

  if (overrides.cwd && !isAbsolute(overrides.cwd)) cfg.cwd = resolve(here, overrides.cwd);
  return cfg;
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
