/**
 * 启动时把 provider / endpoint / model 收成同一套绑定。
 *
 * 先按当前档位走 model_routes（与 /tier 相同）。若显式写了 default_provider
 * 或 NEO_PROVIDER，且与路由指向的供应商不同，再按 CLI --provider 的语义切换：
 * 档位不变，模型改用该 provider 在此档位下的模型。避免 A 的 endpoint 拼上 B 的模型名。
 * 环境变量与 overrides 里的 model / baseUrl / apiKey 在切换后仍然生效。
 */
import type { Config } from "./types.ts";
import { ConfigError, normalizeBaseUrl, str } from "./types.ts";

type ApplyResult = { ok: true; degraded: boolean; note?: string } | { ok: false; error: string };
type SwitchResult = { ok: true } | { ok: false; error: string };

export function bindStartupProviderModel(
  cfg: Config,
  rawDefaultProvider: unknown,
  overrides: Partial<Config>,
  applyTier: (cfg: Config, tier: Config["modelTier"]) => ApplyResult,
  switchProvider: (cfg: Config, name: string) => SwitchResult,
): void {
  const applied = applyTier(cfg, cfg.modelTier);
  if (!applied.ok) throw new ConfigError(applied.error);
  const explicitProvider = str(process.env["NEO_PROVIDER"], str(rawDefaultProvider, ""));
  if (explicitProvider && explicitProvider !== cfg.providerName) {
    const sw = switchProvider(cfg, explicitProvider);
    if (!sw.ok) throw new ConfigError(sw.error);
  }
  if (process.env["NEO_MODEL"]) cfg.model = process.env["NEO_MODEL"];
  if (overrides.model !== undefined) cfg.model = overrides.model;
  if (process.env["NEO_BASE_URL"]) cfg.baseUrl = normalizeBaseUrl(process.env["NEO_BASE_URL"]);
  if (process.env["NEO_API_KEY"]) cfg.apiKey = process.env["NEO_API_KEY"];
  if (overrides.baseUrl !== undefined) cfg.baseUrl = overrides.baseUrl;
  if (overrides.apiKey !== undefined) cfg.apiKey = overrides.apiKey;
  if (overrides.providerName && overrides.providerName !== cfg.providerName) {
    const sw = switchProvider(cfg, overrides.providerName);
    if (!sw.ok) throw new ConfigError(sw.error);
    if (overrides.model !== undefined) cfg.model = overrides.model;
  }
}
