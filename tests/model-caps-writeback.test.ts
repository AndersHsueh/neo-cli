/**
 * P3：撞墙与首次使用探测 + 空字段写回 settings.json（GitHub #5）。
 *
 * 覆盖点：
 *  - 已填字段（含 false / >0 数字）绝不被探测值覆盖；
 *  - 空字段写回 settings.json 且读回一致，`max_tokens` 不被改成 max_output；
 *  - 撞墙写回：context overflow 补空的 context_window，已填的不覆盖；
 *  - 输出撞墙（finish_reason=length）走 agent loop 触发 onOutputLimit；
 *  - 首次使用探测：五项全未填才触发，写回后 settings 出现新字段，且只跑一次。
 *
 * 全部使用临时目录里的假 settings.json —— 仓库根那份真实配置不碰。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";

import {
  isCapabilityUndeclared,
  probeCapabilitiesOnFirstUse,
  resetFirstUseProbeMemo,
  writeBackCapabilities,
  writeBackContextLimit,
  writeBackOutputLimit,
} from "../src/env/modelCaps.ts";
import { machineKeyOf, snapshotFile, writeSnapshot } from "../src/env/probe.ts";
import type { EnvStatic } from "../src/env/types.ts";
import type { Config, ProviderConfig } from "../src/config.ts";
import { Agent } from "../src/agent.ts";
import type { StreamResult } from "../src/llm.ts";
import { captureConsole } from "./helpers.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-modelcaps-p3-"));
const OLD_ENV_HOME = process.env["NEO_ENV_HOME"];

beforeAll(() => {
  process.env["NEO_ENV_HOME"] = SANDBOX;
});

afterAll(() => {
  if (OLD_ENV_HOME === undefined) delete process.env["NEO_ENV_HOME"];
  else process.env["NEO_ENV_HOME"] = OLD_ENV_HOME;
  rmSync(SANDBOX, { recursive: true, force: true });
});

afterEach(() => {
  resetFirstUseProbeMemo();
});

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

let seq = 0;

/** 在沙箱里写一份 settings.json，返回路径。 */
function writeSettings(providers: Record<string, unknown>[]): string {
  seq += 1;
  const dir = join(SANDBOX, `case-${seq}`);
  const path = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ default_provider: "p1", providers }, null, 2)}\n`,
    "utf8",
  );
  return path;
}

function readSettings(path: string): {
  providers: Record<string, unknown>[];
} {
  return JSON.parse(readFileSync(path, "utf8")) as { providers: Record<string, unknown>[] };
}

/** 一个 provider 条目（settings.json 视角，snake_case）。 */
function providerEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_name: "p1",
    provider_type: "openai",
    base_url: "http://127.0.0.1:1/v1",
    api_key: "k",
    default_model_name: "m1",
    ...over,
  };
}

/** 把 settings.json 里的 provider 条目转成内存里的 ProviderConfig。 */
function provFrom(entry: Record<string, unknown>, name = "p1"): ProviderConfig {
  return {
    name,
    type: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    models: { default: "m1", deep_reasoning: "m1", balanced: "m1", fast: "m1" },
    maxTokens: (entry["max_tokens"] as number | undefined) ?? null,
    temperature: null,
    contextWindow: (entry["context_window"] as number | undefined) ?? null,
    vision: entry["vision"] as boolean | undefined,
    tools: entry["tools"] as boolean | undefined,
    reasoning: entry["reasoning"] as boolean | undefined,
    maxOutputTokens: (entry["max_output_tokens"] as number | undefined) ?? null,
  };
}

function makeCfg(
  over: Partial<Config> & { providers?: ProviderConfig[] } = {},
): Config {
  const providers = over.providers ?? [provFrom(providerEntry())];
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://127.0.0.1:1/v1",
    model: "m1",
    modelTier: "default",
    contextWindow: 100_000,
    contextWindowSource: "config",
    maxTokens: 8_192,
    temperature: 0.6,
    compactThreshold: 0.75,
    maxToolIterations: 80,
    toolOutputLimit: 30_000,
    providers,
    env: {},
    cwd: SANDBOX,
    settingsPath: null,
    ...over,
  } as unknown as Config;
}

function writeBaseSnapshot(cfg: Config): void {
  const key = machineKeyOf(hostname(), platform(), arch());
  const file = snapshotFile(SANDBOX, key, cfg.env);
  writeSnapshot(file, {
    version: 1,
    collectedAt: new Date().toISOString(),
    machineKey: key,
    shell: { path: "/bin/bash", kind: "bash", login: false, source: "env", version: null },
  } as unknown as EnvStatic);
}

/** 起一个只回 /models 的假网关。 */
function serveModels(entry: Record<string, unknown>): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [entry] });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return { port: Number(server.port), stop: () => server.stop(true) };
}

/* ------------------------------------------------------------------ */
/* 1. 手写优先                                                         */
/* ------------------------------------------------------------------ */

describe("写回：手写值绝对优先", () => {
  test("已填 vision:false 不会被探测的 true 改掉", () => {
    const settingsPath = writeSettings([providerEntry({ vision: false, max_tokens: 4_096 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ vision: false, max_tokens: 4_096 }))],
    });

    const r = writeBackCapabilities(cfg, {
      contextWindow: 200_000,
      maxOutputTokens: 32_768,
      vision: true,
      tools: true,
      reasoning: true,
    });

    const onDisk = readSettings(settingsPath).providers[0]!;
    expect(onDisk["vision"]).toBe(false);
    expect(r.skipped).toContain("vision");
    // 其余空字段照常补
    expect(onDisk["context_window"]).toBe(200_000);
    expect(onDisk["max_output_tokens"]).toBe(32_768);
    expect(onDisk["tools"]).toBe(true);
    expect(onDisk["reasoning"]).toBe(true);
    // 内存同步：vision 仍是 false
    expect(cfg.providers[0]!.vision).toBe(false);
  });

  test("已填数字（>0）不被覆盖；0 视作未填", () => {
    const settingsPath = writeSettings([
      providerEntry({ context_window: 131_072, max_output_tokens: 0 }),
    ]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ context_window: 131_072, max_output_tokens: 0 }))],
    });

    writeBackCapabilities(cfg, { contextWindow: 999_999, maxOutputTokens: 16_384 });

    const onDisk = readSettings(settingsPath).providers[0]!;
    expect(onDisk["context_window"]).toBe(131_072);
    expect(onDisk["max_output_tokens"]).toBe(16_384);
  });

  test("探测值 unknown 不写", () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });

    const r = writeBackCapabilities(cfg, {
      vision: "unknown",
      tools: "unknown",
      reasoning: "unknown",
    });

    const onDisk = readSettings(settingsPath).providers[0]!;
    expect(onDisk["vision"]).toBeUndefined();
    expect(onDisk["tools"]).toBeUndefined();
    expect(onDisk["reasoning"]).toBeUndefined();
    expect(r.written).toEqual([]);
    expect(r.persisted).toBe(false);
  });

  test("settingsPath 为空 → no-op，但仍同步内存", () => {
    const cfg = makeCfg({ settingsPath: null, providers: [provFrom(providerEntry())] });
    const r = writeBackCapabilities(cfg, { contextWindow: 128_000, vision: true });
    expect(r.persisted).toBe(false);
    expect(r.written).toEqual([]);
    expect(cfg.providers[0]!.contextWindow).toBe(128_000);
    expect(cfg.providers[0]!.vision).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 空字段写回 + 读回一致                                            */
/* ------------------------------------------------------------------ */

describe("写回：空字段落盘且读回一致", () => {
  test("max_output_tokens 写入，max_tokens 保持原值", () => {
    const settingsPath = writeSettings([providerEntry({ max_tokens: 8_192 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ max_tokens: 8_192 }))],
    });

    const r = writeBackCapabilities(cfg, {
      contextWindow: 131_072,
      maxOutputTokens: 65_536,
      vision: true,
      tools: false,
      reasoning: true,
    });

    expect(r.persisted).toBe(true);
    expect(r.written.sort()).toEqual(
      ["context_window", "max_output_tokens", "reasoning", "tools", "vision"].sort(),
    );

    const onDisk = readSettings(settingsPath).providers[0]!;
    expect(onDisk["context_window"]).toBe(131_072);
    expect(onDisk["max_output_tokens"]).toBe(65_536);
    // 请求预算不能被能力上限顶掉
    expect(onDisk["max_tokens"]).toBe(8_192);
    expect(onDisk["vision"]).toBe(true);
    expect(onDisk["tools"]).toBe(false);
    expect(onDisk["reasoning"]).toBe(true);
    // 无关键原样保留
    expect(onDisk["api_key"]).toBe("k");
    expect(onDisk["base_url"]).toBe("http://127.0.0.1:1/v1");

    // 内存同步：本进程不再当「未填」
    const p = cfg.providers[0]!;
    expect(p.contextWindow).toBe(131_072);
    expect(p.maxOutputTokens).toBe(65_536);
    expect(p.tools).toBe(false);
  });

  test("只改当前 provider 那一项，其它 provider 原样", () => {
    const other = providerEntry({ provider_name: "p2", default_model_name: "m2" });
    const settingsPath = writeSettings([providerEntry(), other]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry()), provFrom(other, "p2")],
    });

    writeBackCapabilities(cfg, { contextWindow: 64_000 });

    const list = readSettings(settingsPath).providers;
    expect(list[0]!["context_window"]).toBe(64_000);
    expect(list[1]!["context_window"]).toBeUndefined();
  });

  test("settings.json 不可解析 → 不写盘、不崩，内存仍同步", () => {
    seq += 1;
    const dir = join(SANDBOX, `broken-${seq}`);
    const settingsPath = join(dir, "settings.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(settingsPath, "{ not json", "utf8");
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });

    const r = writeBackCapabilities(cfg, { contextWindow: 128_000 });
    expect(r.persisted).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
    expect(cfg.providers[0]!.contextWindow).toBe(128_000);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 撞墙写回                                                         */
/* ------------------------------------------------------------------ */

describe("撞墙写回", () => {
  test("上下文溢出：空的 context_window 被补上", () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });

    const r = writeBackContextLimit(cfg, 128_000);
    expect(r.written).toEqual(["context_window"]);
    expect(readSettings(settingsPath).providers[0]!["context_window"]).toBe(128_000);
  });

  test("上下文溢出：已填的 context_window 不被覆盖", () => {
    const settingsPath = writeSettings([providerEntry({ context_window: 200_000 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ context_window: 200_000 }))],
    });

    const r = writeBackContextLimit(cfg, 128_000);
    expect(r.written).toEqual([]);
    expect(r.skipped).toContain("context_window");
    expect(readSettings(settingsPath).providers[0]!["context_window"]).toBe(200_000);
  });

  test("输出撞墙：/models 拿到上限 → 补 max_output_tokens", async () => {
    const s = serveModels({ id: "m1", max_output_tokens: 32_768 });
    try {
      const settingsPath = writeSettings([providerEntry({ max_tokens: 8_192 })]);
      const cfg = makeCfg({
        settingsPath,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        providers: [provFrom(providerEntry({ max_tokens: 8_192 }))],
      });

      const r = await writeBackOutputLimit(cfg);
      expect(r.written).toEqual(["max_output_tokens"]);

      const onDisk = readSettings(settingsPath).providers[0]!;
      expect(onDisk["max_output_tokens"]).toBe(32_768);
      expect(onDisk["max_tokens"]).toBe(8_192);
    } finally {
      s.stop();
    }
  });

  test("输出撞墙：探测不到 → 什么都不写", async () => {
    const cfg = makeCfg({ settingsPath: null, baseUrl: "http://127.0.0.1:1/v1" });
    const r = await writeBackOutputLimit(cfg);
    expect(r.written).toEqual([]);
    expect(r.persisted).toBe(false);
  });

  test("agent loop：finish_reason=length 触发 onOutputLimit（只一次）", async () => {
    const cfg = makeCfg({ settingsPath: null });
    let hits = 0;
    let calls = 0;
    const stream = async (): Promise<StreamResult> => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          reasoning: "想了很久",
          toolCalls: [],
          finishReason: "length",
          usage: null,
          raw: null,
        } as StreamResult;
      }
      return {
        content: "答案",
        reasoning: "",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
        raw: null,
      } as StreamResult;
    };

    const agent = new Agent({
      cfg,
      console: captureConsole().ui,
      mode: "auto-all",
      systemPrompt: "s",
      chatStream: stream,
      onOutputLimit: () => {
        hits += 1;
      },
    });

    await agent.send("hi");
    expect(hits).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 首次使用探测                                                     */
/* ------------------------------------------------------------------ */

describe("首次使用探测", () => {
  test("五项全未填 → 触发；写回后 settings 出现新字段", async () => {
    const s = serveModels({
      id: "m1",
      context_length: 131_072,
      max_output_tokens: 16_384,
      vision: true,
      tools: true,
      reasoning: false,
    });
    try {
      const settingsPath = writeSettings([providerEntry()]);
      const cfg = makeCfg({
        settingsPath,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        providers: [provFrom(providerEntry())],
      });
      writeBaseSnapshot(cfg);

      expect(isCapabilityUndeclared(cfg)).toBe(true);
      const r = await probeCapabilitiesOnFirstUse(cfg);

      expect(r.ran).toBe(true);
      expect(r.contextWindow).toBe(131_072);
      expect(r.written.sort()).toEqual(
        ["context_window", "max_output_tokens", "reasoning", "tools", "vision"].sort(),
      );

      const onDisk = readSettings(settingsPath).providers[0]!;
      expect(onDisk["context_window"]).toBe(131_072);
      expect(onDisk["max_output_tokens"]).toBe(16_384);
      expect(onDisk["vision"]).toBe(true);
      expect(onDisk["tools"]).toBe(true);
      expect(onDisk["reasoning"]).toBe(false);

      // 探测完就不再是「未声明」
      expect(isCapabilityUndeclared(cfg)).toBe(false);
    } finally {
      s.stop();
    }
  });

  test("本进程只跑一次", async () => {
    const s = serveModels({ id: "m1", context_length: 131_072 });
    try {
      const settingsPath = writeSettings([providerEntry()]);
      const cfg = makeCfg({
        settingsPath,
        baseUrl: `http://127.0.0.1:${s.port}/v1`,
        providers: [provFrom(providerEntry())],
      });
      writeBaseSnapshot(cfg);

      const first = await probeCapabilitiesOnFirstUse(cfg);
      expect(first.ran).toBe(true);
      // 即便内存被重置成「未填」，本进程的 memo 也拦住第二次
      cfg.providers[0]!.contextWindow = null;
      const second = await probeCapabilitiesOnFirstUse(cfg);
      expect(second.ran).toBe(false);
    } finally {
      s.stop();
    }
  });

  test("任一项已填 → 不触发首次探测", async () => {
    const settingsPath = writeSettings([providerEntry({ vision: false })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ vision: false }))],
    });
    expect(isCapabilityUndeclared(cfg)).toBe(false);
    const r = await probeCapabilitiesOnFirstUse(cfg);
    expect(r.ran).toBe(false);
  });

  test("探测不可达 → 静默返回，不写坏 settings", async () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({
      settingsPath,
      baseUrl: "http://127.0.0.1:1/v1",
      providers: [provFrom(providerEntry())],
    });
    const r = await probeCapabilitiesOnFirstUse(cfg);
    expect(r.ran).toBe(true);
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["context_window"]).toBeUndefined();
  });
});
