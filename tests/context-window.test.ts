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
  detectAndRecordModelWindow,
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

    expect(formatModelWindowLines(cfg).join("\n")).toContain("128,000");

    // /env refresh（force）重写静态快照时不能抹掉 models 事实。
    const refreshed = loadEnv({ cfg, persist: true, force: true, home: SANDBOX });
    expect(refreshed).not.toBeNull();
    expect(readSnapshot(refreshed!.snapshotPath)?.models?.["p1|m1"]?.contextWindow).toBe(128_000);
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
