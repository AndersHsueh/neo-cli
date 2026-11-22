/**
 * 启动时 model / provider / endpoint 必须是同一套绑定。
 *
 * 回归：default_provider 已是 minimax、档位是 balanced，但 model_routes.balanced
 * 仍指向另一个供应商的 glm-5.3-flash 时，旧实现会把 minimax 的 endpoint
 * 和路由里的模型名拼在一起，启动屏出现从未配置过的组合。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, tierDisplayName } from "../src/config.ts";
import { banner, hostOf } from "../src/ui/theme.ts";

const made: string[] = [];
const prevCwd = process.cwd();
const prevEnv = {
  NEO_PROVIDER: process.env["NEO_PROVIDER"],
  NEO_MODEL: process.env["NEO_MODEL"],
  NEO_TIER: process.env["NEO_TIER"],
  NEO_BASE_URL: process.env["NEO_BASE_URL"],
  NEO_API_KEY: process.env["NEO_API_KEY"],
};

afterEach(() => {
  process.chdir(prevCwd);
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function loadFrom(settings: Record<string, unknown>) {
  const dir = join(tmpdir(), `neo-startup-model-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings), "utf8");
  made.push(dir);
  process.chdir(dir);
  return loadConfig();
}

const twoProviders = {
  default_provider: "minimax",
  default_model_tier: "balanced",
  providers: [
    {
      provider_name: "ipsa",
      provider_type: "openai",
      base_url: "https://ipsapro.isoftstone.com/thor/v1",
      api_key: "k-ipsa",
      default_model_name: "deepseek-flash",
      balanced_model_name: "deepseek-flash",
      deep_reasoning_model_name: "glm-5.3-flash",
    },
    {
      provider_name: "minimax",
      provider_type: "anthropic",
      base_url: "https://api.minimaxi.com/anthropic",
      api_key: "k-minimax",
      default_model_name: "MiniMax-M3",
      balanced_model_name: "MiniMax-M2.7",
      fast_model_name: "MiniMax-M2.7-highspeed",
    },
  ],
  model_routes: {
    default: { provider: "ipsa", model: "deepseek-flash" },
    balanced: { provider: "ipsa", model: "glm-5.3-flash" },
    fast: { provider: "ipsa", model: "deepseek-flash" },
    deep_reasoning: { provider: "ipsa", model: "glm-5.3-flash", fallback_allowed: true },
  },
};

describe("启动配置：provider / model / endpoint 同源", () => {
  test("default_provider 与陈旧 model_routes 分歧时，启动跟 default_provider，不用另一家的模型名", () => {
    const cfg = loadFrom(twoProviders);
    expect(cfg.providerName).toBe("minimax");
    expect(cfg.modelTier).toBe("balanced");
    expect(cfg.model).toBe("MiniMax-M2.7");
    expect(hostOf(cfg.baseUrl)).toBe("api.minimaxi.com");
    expect(cfg.model).not.toBe("glm-5.3-flash");
  });

  test("启动屏三字段与 cfg 一致，不会显示 minimax + glm-5.3-flash", () => {
    const cfg = loadFrom(twoProviders);
    const text = banner({
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      providerName: cfg.providerName,
      modelTier: tierDisplayName(cfg.modelTier),
      columns: 80,
      cwd: cfg.cwd,
      toolCount: 0,
      mcpServerCount: 0,
    });
    expect(text).toContain("minimax");
    expect(text).toContain("MiniMax-M2.7");
    expect(text).toContain("api.minimaxi.com");
    expect(text).not.toContain("glm-5.3-flash");
  });

  test("未写 default_provider 时，按当前档位的 model_routes 整组绑定", () => {
    const { default_provider: _, providers, ...rest } = twoProviders;
    const cfg = loadFrom({
      ...rest,
      default_model_tier: "balanced",
      // 列表第一项是 minimax，路由指向 ipsa：若误用「第一项供应商 + 路由模型」会再拼出旧 bug。
      providers: [providers[1], providers[0]],
    });
    expect(cfg.providerName).toBe("ipsa");
    expect(cfg.model).toBe("glm-5.3-flash");
    expect(hostOf(cfg.baseUrl)).toBe("ipsapro.isoftstone.com");
  });

  test("路由与 default_provider 同供应商时，显式 route.model 生效", () => {
    const cfg = loadFrom({
      default_provider: "minimax",
      default_model_tier: "balanced",
      providers: twoProviders.providers,
      model_routes: {
        balanced: { provider: "minimax", model: "MiniMax-M3" },
      },
    });
    expect(cfg.providerName).toBe("minimax");
    expect(cfg.model).toBe("MiniMax-M3");
    expect(hostOf(cfg.baseUrl)).toBe("api.minimaxi.com");
  });

  test("NEO_MODEL 仍覆盖档位解析出的模型名", () => {
    process.env["NEO_MODEL"] = "explicit-model";
    const cfg = loadFrom(twoProviders);
    expect(cfg.providerName).toBe("minimax");
    expect(cfg.model).toBe("explicit-model");
    expect(hostOf(cfg.baseUrl)).toBe("api.minimaxi.com");
  });
});
