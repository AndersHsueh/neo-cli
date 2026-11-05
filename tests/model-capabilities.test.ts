/**
 * P1：模型能力探测（/models 元数据）+ settings 手写能力声明 + 旧快照兼容。
 *
 * 覆盖点：
 *  - 解析：窗口 / 输出上限 / vision·tools·reasoning 三态；
 *  - 缺字段 → "unknown"（不是 false）；
 *  - settings 手写的 vision/tools/reasoning 权威，探测不覆盖；
 *  - 旧快照（没有新字段）读取不炸，合并后回落到 unknown。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectAndRecordModelWindow,
  detectModelCapabilitiesFromModelsApi,
  detectModelWindowFromModelsApi,
  mergeModelCapabilities,
  modelsProbeTimeoutMs,
  readModelContext,
  recordModelContext,
} from "../src/env/modelWindows.ts";
import { machineKeyOf, snapshotFile, writeSnapshot } from "../src/env/probe.ts";
import type { EnvStatic } from "../src/env/types.ts";
import type { Config } from "../src/config.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-modelcaps-"));
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

/** 起一个只回 /models 的假网关，返回 {port, stop}。 */
function serveModels(entry: Record<string, unknown>): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "other", context_length: 999_999 }, entry] });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { port: Number(server.port), stop: () => server.stop(true) };
}

describe("detectModelCapabilitiesFromModelsApi", () => {
  test("完整元数据：窗口 / 输出上限 / 三项能力都解析出来", async () => {
    const s = serveModels({
      id: "m1",
      context_length: 131_072,
      max_output_tokens: 32_768,
      vision: true,
      tools: true,
      reasoning: false,
    });
    try {
      const cfg = makeCfg({ baseUrl: `http://127.0.0.1:${s.port}/v1` });
      const caps = await detectModelCapabilitiesFromModelsApi(cfg);
      expect(caps).not.toBeNull();
      expect(caps!.contextWindow).toBe(131_072);
      expect(caps!.maxOutputTokens).toBe(32_768);
      expect(caps!.vision).toBe(true);
      expect(caps!.tools).toBe(true);
      expect(caps!.reasoning).toBe(false);
      expect(caps!.evidence).toContain("/models");
    } finally {
      s.stop();
    }
  });

  test("嵌套在 capabilities/limits 里也能取到", async () => {
    const s = serveModels({
      id: "m1",
      capabilities: { vision: true, tools: "false", reasoning: true },
      limits: { max_context_length: 200_000, max_completion_tokens: 8_192 },
    });
    try {
      const cfg = makeCfg({ baseUrl: `http://127.0.0.1:${s.port}/v1` });
      const caps = await detectModelCapabilitiesFromModelsApi(cfg);
      expect(caps!.contextWindow).toBe(200_000);
      expect(caps!.maxOutputTokens).toBe(8_192);
      expect(caps!.vision).toBe(true);
      expect(caps!.tools).toBe(false);
      expect(caps!.reasoning).toBe(true);
    } finally {
      s.stop();
    }
  });

  test("modalities 数组推断 vision", async () => {
    const s = serveModels({ id: "m1", context_window: 128_000, modalities: ["text", "image"] });
    try {
      const cfg = makeCfg({ baseUrl: `http://127.0.0.1:${s.port}/v1` });
      const caps = await detectModelCapabilitiesFromModelsApi(cfg);
      expect(caps!.vision).toBe(true);
      expect(caps!.tools).toBe("unknown");
    } finally {
      s.stop();
    }
  });

  test("缺字段 → unknown，不是 false", async () => {
    const s = serveModels({ id: "m1", context_window: 128_000 });
    try {
      const cfg = makeCfg({ baseUrl: `http://127.0.0.1:${s.port}/v1` });
      const caps = await detectModelCapabilitiesFromModelsApi(cfg);
      expect(caps!.maxOutputTokens).toBeNull();
      expect(caps!.vision).toBe("unknown");
      expect(caps!.tools).toBe("unknown");
      expect(caps!.reasoning).toBe("unknown");
    } finally {
      s.stop();
    }
  });

  test("不可达 / 无该模型条目 → null（静默）", async () => {
    const cfg = makeCfg({ baseUrl: "http://127.0.0.1:1/v1" });
    expect(await detectModelCapabilitiesFromModelsApi(cfg)).toBeNull();
    expect(await detectModelWindowFromModelsApi(cfg)).toBeNull();

    const s = serveModels({ id: "not-m1", context_window: 1_000 });
    try {
      const cfg2 = makeCfg({ baseUrl: `http://127.0.0.1:${s.port}/v1` });
      expect(await detectModelCapabilitiesFromModelsApi(cfg2)).toBeNull();
    } finally {
      s.stop();
    }
  });

  test("探测超时可配置：未设置用 5s，settings 覆盖并夹取", () => {
    expect(modelsProbeTimeoutMs(makeCfg())).toBe(5_000);
    expect(modelsProbeTimeoutMs(makeCfg({ env: { modelsProbeTimeoutMs: 8_000 } }))).toBe(8_000);
    expect(modelsProbeTimeoutMs(makeCfg({ env: { modelsProbeTimeoutMs: 10 } }))).toBe(250);
    expect(modelsProbeTimeoutMs(makeCfg({ env: { modelsProbeTimeoutMs: 999_999 } }))).toBe(60_000);
  });

  test("短超时对挂起的 /models 返回 null，不把请求拖到默认 5s", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise(() => {
          /* 一直不回，用来验证超时真的接到了 fetch */
        });
      },
    });
    try {
      const cfg = makeCfg({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        env: { modelsProbeTimeoutMs: 300 },
      });
      const t0 = Date.now();
      expect(await detectModelCapabilitiesFromModelsApi(cfg)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      server.stop(true);
    }
  });

  test("detectModelWindowFromModelsApi 仍是窗口薄包装", async () => {
    const s = serveModels({ id: "m1", context_length: 131_072, max_output_tokens: 4_096 });
    try {
      const cfg = makeCfg({ baseUrl: `http://127.0.0.1:${s.port}/v1` });
      expect(await detectModelWindowFromModelsApi(cfg)).toBe(131_072);
    } finally {
      s.stop();
    }
  });
});

describe("detectAndRecordModelWindow 写入扩展字段", () => {
  test("落盘包含 maxOutputTokens 与三项能力", async () => {
    const s = serveModels({
      id: "m1",
      context_length: 131_072,
      max_output_tokens: 16_384,
      vision: true,
      tools: true,
      reasoning: true,
    });
    try {
      const cfg = makeCfg({ baseUrl: `http://127.0.0.1:${s.port}/v1` });
      writeBaseSnapshot(cfg);
      const info = await detectAndRecordModelWindow(cfg);
      expect(info?.contextWindow).toBe(131_072);
      expect(info?.maxOutputTokens).toBe(16_384);
      expect(info?.vision).toBe(true);

      const stored = readModelContext(cfg);
      expect(stored?.source).toBe("models_api");
      expect(stored?.maxOutputTokens).toBe(16_384);
      expect(stored?.tools).toBe(true);
      expect(stored?.reasoning).toBe(true);
    } finally {
      s.stop();
    }
  });
});

describe("mergeModelCapabilities：settings 手写优先", () => {
  const detected = {
    contextWindow: 128_000,
    source: "models_api" as const,
    updatedAt: "t",
    vision: false as const,
    tools: true as const,
    reasoning: "unknown" as const,
  };

  test("手写值覆盖探测值", () => {
    const merged = mergeModelCapabilities(
      { vision: true, tools: false, reasoning: true },
      detected,
    );
    expect(merged).toEqual({ vision: true, tools: false, reasoning: true });
  });

  test("未填的字段用探测值，探测也没有则 unknown", () => {
    const merged = mergeModelCapabilities({ vision: true }, detected);
    expect(merged.vision).toBe(true);
    expect(merged.tools).toBe(true);
    expect(merged.reasoning).toBe("unknown");
    expect(mergeModelCapabilities(undefined, null)).toEqual({
      vision: "unknown",
      tools: "unknown",
      reasoning: "unknown",
    });
  });

  test("手写 false 不会被探测的 true 覆盖", () => {
    const merged = mergeModelCapabilities({ tools: false }, detected);
    expect(merged.tools).toBe(false);
  });
});

describe("旧快照兼容", () => {
  test("没有新字段的旧记录读取不炸，合并后回落 unknown", () => {
    const cfg = makeCfg({ model: "legacy-model" });
    writeBaseSnapshot(cfg);
    // 模拟 v0.4.1 时期写下的记录：只有窗口字段。
    recordModelContext(cfg, {
      contextWindow: 64_000,
      source: "overflow_error",
      evidence: "old",
    });
    const info = readModelContext(cfg);
    expect(info?.contextWindow).toBe(64_000);
    expect(info?.maxOutputTokens).toBeUndefined();
    expect(info?.vision).toBeUndefined();

    const merged = mergeModelCapabilities(undefined, info);
    expect(merged).toEqual({ vision: "unknown", tools: "unknown", reasoning: "unknown" });
  });
});
