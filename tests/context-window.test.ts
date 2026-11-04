/**
 * v0.4.1 A2：上下文窗口解析 / env 事实持久化 / 模型元数据探测。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { arch, hostname, platform } from "node:os";
import { join } from "node:path";

import {
  isContextOverflowError,
  parseContextLimitFromError,
  resolveContextWindow,
} from "../src/contextWindow.ts";
import {
  currentModelCapabilityView,
  detectAndRecordModelWindow,
  formatCapabilityGapHint,
  formatModelWindowLines,
  readModelContext,
  recordModelContext,
  resolveAndApplyModelWindow,
} from "../src/env/modelWindows.ts";
import { loadEnv, machineKeyOf, readSnapshot, snapshotFile, writeSnapshot } from "../src/env/probe.ts";
import type { EnvStatic } from "../src/env/types.ts";
import type { Config } from "../src/config.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-ctxwin-"));
const OLD_HOME = process.env["NEO_ENV_HOME"];

beforeAll(() => {
  process.env["NEO_ENV_HOME"] = SANDBOX;
});

afterAll(() => {
  if (OLD_HOME === undefined) delete process.env["NEO_ENV_HOME"];
  else process.env["NEO_ENV_HOME"] = OLD_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
});

function makeCfg(over: Partial<Config> = {}): Config {
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "m1",
    modelTier: "default",
    contextWindow: 100_000,
    contextWindowSource: "config",
    env: {},
    cwd: SANDBOX,
    ...over,
  } as unknown as Config;
}

function writeBaseSnapshot(cfg: Config): string {
  const key = machineKeyOf(hostname(), platform(), arch());
  const file = snapshotFile(SANDBOX, key, cfg.env);
  const snap = {
    version: 1,
    collectedAt: new Date().toISOString(),
    machineKey: key,
    shell: { path: "/bin/bash", kind: "bash", login: false, source: "env", version: null },
  };
  writeSnapshot(file, snap as unknown as EnvStatic);
  return file;
}

describe("parseContextLimitFromError", () => {
  test("常见错误文案", () => {
    expect(parseContextLimitFromError("This model's maximum context length is 128000 tokens")).toBe(128_000);
    expect(parseContextLimitFromError("context window is 200k tokens")).toBe(200_000);
    expect(parseContextLimitFromError("maximum context length: 131,072")).toBe(131_072);
    expect(parseContextLimitFromError("maximum context length is 1m tokens")).toBe(1_000_000);
  });

  test("输出预算错误不当作上下文窗口", () => {
    expect(parseContextLimitFromError("max_tokens is 8192")).toBeNull();
    expect(isContextOverflowError(Object.assign(new Error("max_tokens is 8192"), { status: 400 }))).toBe(false);
  });

  test("isContextOverflowError 只认 4xx 上下文类错误", () => {
    const e = (msg: string, status?: number): Error => Object.assign(new Error(msg), { status });
    expect(isContextOverflowError(e("maximum context length is 128000 tokens", 400))).toBe(true);
    expect(isContextOverflowError(e("prompt is too long: 300000 tokens", 400))).toBe(true);
    expect(isContextOverflowError(e("maximum context length is 128000 tokens", 500))).toBe(false);
    expect(isContextOverflowError(e("invalid api key", 401))).toBe(false);
    expect(isContextOverflowError(e("context length exceeded", 400))).toBe(true);
    expect(isContextOverflowError(null)).toBe(false);
  });
});

describe("resolveContextWindow", () => {
  test("env 探测值优先于配置；无 env 用配置；配置缺失用 known", () => {
    const env = {
      contextWindow: 128_000,
      source: "overflow_error" as const,
      updatedAt: "t",
    };
    expect(resolveContextWindow(512_000, "glm-5.3-flash", env)).toMatchObject({
      tokens: 128_000,
      source: "overflow_error",
    });
    expect(resolveContextWindow(512_000, "glm-5.3-flash")).toMatchObject({
      tokens: 512_000,
      source: "config",
    });
    expect(resolveContextWindow(0, "deepseek-v3").source).toBe("known");
  });
});

describe("env 模型窗口事实", () => {
  test("record → read → apply → lines", () => {
    const cfg = makeCfg();
    writeBaseSnapshot(cfg);
    recordModelContext(cfg, {
      contextWindow: 128_000,
      source: "overflow_error",
      evidence: "server error",
    });
    const info = readModelContext(cfg);
    expect(info?.contextWindow).toBe(128_000);
    expect(info?.source).toBe("overflow_error");

    const resolved = resolveAndApplyModelWindow(cfg);
    expect(resolved.tokens).toBe(128_000);
    expect(cfg.contextWindow).toBe(128_000);
    expect(cfg.contextWindowSource).toBe("overflow_error");

    const lines = formatModelWindowLines(cfg).join("\n");
    expect(lines).toContain("128,000");
    // P2：每行都带五项能力；这条记录只有窗口，其余一律「未知」。
    expect(lines).toContain("能力上限 max_output_tokens 未知");
    expect(lines).toContain("vision 未知");
    expect(lines).toContain("tools 未知");
    expect(lines).toContain("reasoning 未知");

    // /env refresh（force）重写静态快照时不能抹掉 models 事实。
    const refreshed = loadEnv({ cfg, persist: true, force: true, home: SANDBOX });
    expect(refreshed).not.toBeNull();
    expect(readSnapshot(refreshed!.snapshotPath)?.models?.["p1|m1"]?.contextWindow).toBe(128_000);
  });

  test("切模型时用 configuredContextWindow 兜底，不沿用上一个模型的探测值", () => {
    const cfg = makeCfg({ contextWindow: 128_000, configuredContextWindow: 500_000, model: "m2" });
    const r = resolveAndApplyModelWindow(cfg);
    expect(r.tokens).toBe(500_000);
    expect(r.source).toBe("config");
    expect(cfg.contextWindow).toBe(500_000);
  });

  /**
   * P2：formatModelWindowLines 五项能力展示。
   * 用独立 model 名，避免与上面用例共享 p1|m1 的记录。
   */
  test("P2 展示五项：手写 settings 优先于探测值", () => {
    const cfg = makeCfg({
      model: "caps-1",
      contextWindow: 200_000,
      // settings 手写：vision 说没有、reasoning 说有；tools 没填 → 用探测值。
      providers: [{ name: "p1", vision: false, reasoning: true }],
    } as unknown as Partial<Config>);
    writeBaseSnapshot(cfg);
    recordModelContext(cfg, {
      contextWindow: 131_072,
      maxOutputTokens: 32_768,
      vision: true,
      tools: true,
      reasoning: false,
      source: "models_api",
    });

    // 窗口走 resolveContextWindow 的解析结果：先解析，再展示（与 /env、/context 同路径）。
    resolveAndApplyModelWindow(cfg);
    const line = formatModelWindowLines(cfg).find((l) => l.includes("p1|caps-1")) ?? "";
    expect(line).toContain("131,072 tokens");
    expect(line).toContain("能力上限 max_output_tokens 32,768 tokens");
    expect(line).toContain("vision 否"); // 手写 false 压过探测 true
    expect(line).toContain("tools 是"); // 手写未填 → 探测值
    expect(line).toContain("reasoning 是"); // 手写 true 压过探测 false
  });

  test("P2 旧快照缺字段不炸，五项回落未知", () => {
    const cfg = makeCfg({ model: "caps-legacy" });
    writeBaseSnapshot(cfg);
    recordModelContext(cfg, { contextWindow: 64_000, source: "overflow_error" });
    const line = formatModelWindowLines(cfg).find((l) => l.includes("p1|caps-legacy")) ?? "";
    expect(line).toContain("能力上限 max_output_tokens 未知");
    expect(line).toContain("vision 未知");
    expect(line).toContain("tools 未知");
    expect(line).toContain("reasoning 未知");
  });

  test("P2 maxOutputTokens 不误用 cfg.maxTokens", () => {
    const cfg = makeCfg({ model: "caps-budget", maxTokens: 4096 } as unknown as Partial<Config>);
    writeBaseSnapshot(cfg);
    recordModelContext(cfg, { contextWindow: 64_000, source: "models_api" });
    const line = formatModelWindowLines(cfg).find((l) => l.includes("p1|caps-budget")) ?? "";
    expect(line).toContain("能力上限 max_output_tokens 未知");
    expect(line).toContain("请求预算 max_tokens 4,096");
    expect(line).not.toContain("max_output_tokens 4,096");
    const hint = formatCapabilityGapHint(cfg);
    expect(hint).toContain("未探测到");
    expect(hint).toContain("max_output_tokens");
    expect(hint).toContain("请求预算");
  });

  test("手写 max_output_tokens 作为能力上限展示，请求预算仍分开", () => {
    const cfg = makeCfg({
      model: "caps-manual-out",
      maxTokens: 64,
      providers: [{ name: "p1", maxOutputTokens: 32_768, vision: false }],
    } as unknown as Partial<Config>);
    writeBaseSnapshot(cfg);
    recordModelContext(cfg, { contextWindow: 64_000, source: "models_api" });
    resolveAndApplyModelWindow(cfg);
    expect(currentModelCapabilityView(cfg).maxOutputTokens).toBe("32,768 tokens");
    const line = formatModelWindowLines(cfg).find((l) => l.includes("p1|caps-manual-out")) ?? "";
    expect(line).toContain("能力上限 max_output_tokens 32,768 tokens");
    expect(line).toContain("请求预算 max_tokens 64");
    expect(line).not.toContain("max_output_tokens 64");
    // 上限已手写；vision 已手写 false。tools/reasoning 仍未知，提示里不再提输出上限。
    const hint = formatCapabilityGapHint(cfg) ?? "";
    expect(hint).toContain("未探测到");
    expect(hint).not.toContain("max_output_tokens");
    expect(hint).toContain("tools");
  });

  test("P2 currentModelCapabilityView 与 formatModelWindowLines 同口径", () => {
    const cfg = makeCfg({ model: "caps-view", contextWindow: 100_000 });
    writeBaseSnapshot(cfg);
    recordModelContext(cfg, {
      contextWindow: 131_072,
      maxOutputTokens: 8_192,
      vision: "unknown",
      tools: true,
      reasoning: false,
      source: "models_api",
    });
    resolveAndApplyModelWindow(cfg);
    const view = currentModelCapabilityView(cfg);
    expect(view.contextWindow).toBe("131,072 tokens");
    expect(view.maxOutputTokens).toBe("8,192 tokens");
    expect(view.vision).toBe("未知");
    expect(view.tools).toBe("是");
    expect(view.reasoning).toBe("否");
  });

  test("/models 元数据探测并落盘", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.endsWith("/models")) {
          return Response.json({
            object: "list",
            data: [
              { id: "other", context_length: 999_999 },
              { id: "m1", context_length: 131_072, max_tokens: 8192 },
            ],
          });
        }
        return new Response("nope", { status: 404 });
      },
    });
    try {
      const cfg = makeCfg({ baseUrl: `http://127.0.0.1:${server.port}/v1` });
      writeBaseSnapshot(cfg);
      const info = await detectAndRecordModelWindow(cfg);
      expect(info?.contextWindow).toBe(131_072);
      expect(readModelContext(cfg)?.source).toBe("models_api");
      resolveAndApplyModelWindow(cfg);
      expect(cfg.contextWindow).toBe(131_072);
    } finally {
      server.stop(true);
    }
  });
});
