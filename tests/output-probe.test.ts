/**
 * issue #8：输出上限（max_output_tokens）边界探测。
 *
 * A 免费证据入账：请求 400/422 文案解析出精确上限 → 空字段写回 + env 事实（无需开关）。
 * B 受控主动探测：阶梯翻倍、只认可解析的精确上限；不透明 400 / 上下文超长 / 鉴权 / 5xx 一律不猜。
 * C 防空转：7 天 memo、手写优先、max_attempts 严格生效、非法配置回落默认关闭。
 *
 * 全部本地假网关与纯函数；settings.json 与 env 快照都写在临时沙箱，绝不碰真实配置。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, hostname, platform, tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type Config, type ProviderConfig } from "../src/config.ts";
import {
  DEFAULT_OUTPUT_PROBE,
  OUTPUT_PROBE_MEMO_TTL_DAYS,
  applyProbeOutcome,
  persistLearnedOutputLimit,
  probeCandidates,
  readOutputProbeMemo,
  resolveOutputProbe,
  runOutputProbe,
  shouldRunOutputProbe,
  type OutputProbeSettings,
  type ProbeOutcome,
} from "../src/env/outputProbe.ts";
import {
  chat,
  LLMError,
  resetLearnedMaxTokens,
  resetMaxTokensLimitLearnedHandler,
  setMaxTokensLimitLearnedHandler,
} from "../src/llm.ts";
import { machineKeyOf, snapshotFile, writeSnapshot } from "../src/env/probe.ts";
import type { EnvStatic } from "../src/env/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-output-probe-"));
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
  resetLearnedMaxTokens();
  resetMaxTokensLimitLearnedHandler();
});

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

let seq = 0;

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

function readSettings(path: string): { providers: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(path, "utf8")) as { providers: Record<string, unknown>[] };
}

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
    outputProbe: resolveOutputProbe(entry["probe_max_output_tokens"]),
  };
}

function makeCfg(over: Partial<Config> & { providers?: ProviderConfig[] } = {}): Config {
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

function settings(): OutputProbeSettings {
  return { ...DEFAULT_OUTPUT_PROBE, enabled: true };
}

/** 依次返回/抛出预设结果的假 request。 */
function scripted(plan: Array<unknown | Error>): {
  request: (candidate: number) => Promise<unknown>;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    calls,
    request: async (candidate: number) => {
      calls.push(candidate);
      const next = plan.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/* ------------------------------------------------------------------ */
/* C1：配置解析                                                        */
/* ------------------------------------------------------------------ */

describe("C1 配置解析：非法形状回落默认关闭，不抛错", () => {
  test("未配置 → undefined（= 默认关闭，与今天行为一致）", () => {
    expect(resolveOutputProbe(undefined)).toBeUndefined();
  });

  test("true / false 简写", () => {
    expect(resolveOutputProbe(true)).toEqual({ ...DEFAULT_OUTPUT_PROBE, enabled: true });
    expect(resolveOutputProbe(false)).toEqual({ ...DEFAULT_OUTPUT_PROBE, enabled: false });
  });

  test("对象：缺 enabled 视为开启，其余字段覆盖默认", () => {
    expect(resolveOutputProbe({})).toEqual({ ...DEFAULT_OUTPUT_PROBE, enabled: true });
    expect(
      resolveOutputProbe({ max_attempts: 5, start: 4_096, cap: 65_536 }),
    ).toEqual({ enabled: true, maxAttempts: 5, start: 4_096, cap: 65_536 });
  });

  test("越界值夹紧：max_attempts 1–8、start ≥256、cap < start 时以 start 为准", () => {
    expect(resolveOutputProbe({ max_attempts: 0 })!.maxAttempts).toBe(1);
    expect(resolveOutputProbe({ max_attempts: 99 })!.maxAttempts).toBe(8);
    expect(resolveOutputProbe({ start: 100 })!.start).toBe(256);
    const s = resolveOutputProbe({ start: 32_768, cap: 8_192 })!;
    expect(s.cap).toBe(32_768);
  });

  test("非法形状（字符串/数组/数字）→ undefined，不抛错", () => {
    expect(resolveOutputProbe("yes")).toBeUndefined();
    expect(resolveOutputProbe([1, 2])).toBeUndefined();
    expect(resolveOutputProbe(42)).toBeUndefined();
    expect(resolveOutputProbe(null)).toBeUndefined();
  });

  test("loadConfig 把两种写法都解析到 provider.outputProbe", () => {
    // loadConfig 只从 cwd / 包根 / ~/.neo 搜 settings.json，所以用临时 cwd（既有测试同款做法）。
    const load = (entry: Record<string, unknown>) => {
      const path = writeSettings([entry]);
      const dir = path.slice(0, path.lastIndexOf("/"));
      const prev = process.cwd();
      try {
        process.chdir(dir);
        return loadConfig();
      } finally {
        process.chdir(prev);
      }
    };
    expect(load(providerEntry({ probe_max_output_tokens: true })).providers[0]!.outputProbe?.enabled).toBe(true);
    expect(
      load(providerEntry({ probe_max_output_tokens: { enabled: false, max_attempts: 2 } })).providers[0]!
        .outputProbe,
    ).toEqual({ ...DEFAULT_OUTPUT_PROBE, enabled: false, maxAttempts: 2 });
    expect(load(providerEntry()).providers[0]!.outputProbe).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* B1：阶梯                                                             */
/* ------------------------------------------------------------------ */

describe("B1 阶梯：从 start 翻倍，受 cap 与 max_attempts 双重限制", () => {
  test("默认 3 档：8192 / 16384 / 32768", () => {
    expect(probeCandidates(settings())).toEqual([8_192, 16_384, 32_768]);
  });

  test("max_attempts=1 只试 start", () => {
    expect(probeCandidates({ ...settings(), maxAttempts: 1 })).toEqual([8_192]);
  });

  test("cap 截断：start=8192 cap=20000 → 8192 / 16384", () => {
    expect(probeCandidates({ ...settings(), cap: 20_000 })).toEqual([8_192, 16_384]);
  });

  test("start === cap 时只有一档", () => {
    expect(probeCandidates({ ...settings(), start: 4_096, cap: 4_096, maxAttempts: 4 })).toEqual([4_096]);
  });
});

/* ------------------------------------------------------------------ */
/* B2：探测判定                                                        */
/* ------------------------------------------------------------------ */

describe("B2 探测判定：只认可解析的精确上限，其余不猜", () => {
  test("阶梯顶全部成功 → lower_bound（不写配置的由调用方决定）", async () => {
    const { request, calls } = scripted([{ content: "ok" }, { content: "ok" }, { content: "ok" }]);
    const r = await runOutputProbe({ settings: settings(), request });
    expect(r.outcome).toBe("lower_bound");
    if (r.outcome !== "lower_bound") throw new Error("期望 lower_bound");
    expect(r.atLeast).toBe(32_768);
    expect(calls).toEqual([8_192, 16_384, 32_768]);
  });

  test("中途 400 明说上限 → found，且立即停止", async () => {
    const { request, calls } = scripted([
      { content: "ok" },
      { content: "ok" },
      new LLMError("max tokens > 24576", 400, "max tokens > 24576"),
    ]);
    const r = await runOutputProbe({ settings: settings(), request });
    expect(r.outcome).toBe("found");
    if (r.outcome !== "found") throw new Error("期望 found");
    expect(r.limit).toBe(24_576);
    expect(calls).toEqual([8_192, 16_384, 32_768]);
  });

  test("第一档就明说上限 → found，只发一次请求", async () => {
    const { request, calls } = scripted([new LLMError("max tokens > 4096", 400)]);
    const r = await runOutputProbe({ settings: settings(), request });
    expect(r.outcome).toBe("found");
    if (r.outcome !== "found") throw new Error("期望 found");
    expect(r.limit).toBe(4_096);
    expect(calls.length).toBe(1);
  });

  test("不透明 400 → inconclusive(opaque)，不归因、不继续试", async () => {
    const { request, calls } = scripted([
      { content: "ok" },
      new LLMError("request was rejected by an internal MaaS component", 400),
    ]);
    const r = await runOutputProbe({ settings: settings(), request });
    expect(r.outcome).toBe("inconclusive");
    if (r.outcome !== "inconclusive") throw new Error("期望 inconclusive");
    expect(r.reason).toBe("opaque");
    expect(calls.length).toBe(2);
  });

  test("上下文超长 / 鉴权 / 5xx 各自中止并给出原因", async () => {
    for (const [err, reason] of [
      [new LLMError("context length exceeded: 200000", 400), "context"],
      [new LLMError("unauthorized", 401), "auth"],
      [new LLMError("upstream boom", 503), "other"],
    ] as const) {
      const { request } = scripted([err]);
      const r = await runOutputProbe({ settings: settings(), request });
      expect(r.outcome).toBe("inconclusive");
      if (r.outcome !== "inconclusive") throw new Error("期望 inconclusive");
      expect(r.reason).toBe(reason);
    }
  });

  test("max_attempts 严格生效：请求次数不超过配置", async () => {
    const { request, calls } = scripted([{ content: "ok" }, { content: "ok" }]);
    const r = await runOutputProbe({ settings: { ...settings(), maxAttempts: 2 }, request });
    expect(r.outcome).toBe("lower_bound");
    expect(calls).toEqual([8_192, 16_384]);
  });
});

/* ------------------------------------------------------------------ */
/* C2：是否该探（7 天 memo + 手写优先）                                 */
/* ------------------------------------------------------------------ */

describe("C2 是否该探：关闭 / 已声明 / 近期探过 / 该探", () => {
  const at = new Date("2026-11-09T00:00:00Z");

  test("开关关闭 → disabled", () => {
    expect(
      shouldRunOutputProbe({
        settings: { ...DEFAULT_OUTPUT_PROBE },
        outputLimitDeclared: false,
        now: at,
      }).run,
    ).toBe(false);
  });

  test("已手写上限 → declared", () => {
    expect(
      shouldRunOutputProbe({ settings: settings(), outputLimitDeclared: true, now: at }),
    ).toEqual({ run: false, reason: "declared" });
  });

  test("7 天内探过 → recent", () => {
    const memo = { at: "2026-11-08T00:00:00Z", outcome: "inconclusive" as const };
    expect(shouldRunOutputProbe({ settings: settings(), outputLimitDeclared: false, memo, now: at })).toEqual({
      run: false,
      reason: "recent",
    });
  });

  test("超过 7 天 → 再探", () => {
    const memo = { at: "2026-10-01T00:00:00Z", outcome: "inconclusive" as const };
    expect(shouldRunOutputProbe({ settings: settings(), outputLimitDeclared: false, memo, now: at })).toEqual({
      run: true,
      reason: "ok",
    });
  });

  test("没有任何 memo → 该探", () => {
    expect(shouldRunOutputProbe({ settings: settings(), outputLimitDeclared: false, now: at }).run).toBe(true);
  });

  test("TTL 常量是 7 天（口径写死在测试里，改常量要先改这里）", () => {
    expect(OUTPUT_PROBE_MEMO_TTL_DAYS).toBe(7);
  });
});

/* ------------------------------------------------------------------ */
/* B3：结果落地（写回 + env 事实 + memo）                              */
/* ------------------------------------------------------------------ */

describe("B3 结果落地：只有 found 才写配置，且只写空字段", () => {
  const found = (limit: number): ProbeOutcome => ({
    outcome: "found",
    limit,
    attempts: [{ candidate: 16_384, ok: false, kind: "limit", limit }],
  });

  test("found + 空字段 → 写 max_output_tokens，并记 env 事实与 memo", () => {
    const settingsPath = writeSettings([providerEntry({ max_tokens: 8_192 })]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    writeBaseSnapshot(cfg);

    const r = applyProbeOutcome(cfg, found(32_768));
    expect(r.written).toEqual(["max_output_tokens"]);

    const prov = readSettings(settingsPath).providers[0]!;
    expect(prov["max_output_tokens"]).toBe(32_768);
    expect(prov["max_tokens"]).toBe(8_192); // 预算不被改

    expect(readOutputProbeMemo(cfg)).toMatchObject({ outcome: "found", limit: 32_768 });
  });

  test("found + 已手写上限 → skipped，不覆盖", () => {
    const settingsPath = writeSettings([providerEntry({ max_output_tokens: 16_384 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ max_output_tokens: 16_384 }))],
    });
    writeBaseSnapshot(cfg);

    const r = applyProbeOutcome(cfg, found(32_768));
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBe(16_384);
  });

  test("inconclusive → 不写配置，只记 memo", () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    writeBaseSnapshot(cfg);

    const r = applyProbeOutcome(cfg, {
      outcome: "inconclusive",
      reason: "opaque",
      attempts: [{ candidate: 8_192, ok: false, kind: "opaque" }],
    });
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBeUndefined();
    expect(readOutputProbeMemo(cfg)).toMatchObject({ outcome: "inconclusive", reason: "opaque" });
  });

  test("lower_bound → 不写配置，memo 记 atLeast", () => {
    const settingsPath = writeSettings([providerEntry()]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    writeBaseSnapshot(cfg);

    const r = applyProbeOutcome(cfg, {
      outcome: "lower_bound",
      atLeast: 32_768,
      attempts: [{ candidate: 32_768, ok: true }],
    });
    expect(r.written).toEqual([]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBeUndefined();
    expect(readOutputProbeMemo(cfg)).toMatchObject({ outcome: "lower_bound", atLeast: 32_768 });
  });
});

/* ------------------------------------------------------------------ */
/* A：免费证据入账                                                     */
/* ------------------------------------------------------------------ */

describe("A 免费证据入账：请求报错里学到的上限直接落盘", () => {
  test("空字段 → 写 max_output_tokens + env 事实（source=error_evidence）", () => {
    const settingsPath = writeSettings([providerEntry({ max_tokens: 8_192 })]);
    const cfg = makeCfg({ settingsPath, providers: [provFrom(providerEntry())] });
    writeBaseSnapshot(cfg);

    const r = persistLearnedOutputLimit(cfg, 24_576, "max tokens > 24576");
    expect(r.written).toEqual(["max_output_tokens"]);
    expect(readSettings(settingsPath).providers[0]!["max_output_tokens"]).toBe(24_576);
    expect(readSettings(settingsPath).providers[0]!["max_tokens"]).toBe(8_192);
  });

  test("已手写 → 不覆盖", () => {
    const settingsPath = writeSettings([providerEntry({ max_output_tokens: 65_536 })]);
    const cfg = makeCfg({
      settingsPath,
      providers: [provFrom(providerEntry({ max_output_tokens: 65_536 }))],
    });
    writeBaseSnapshot(cfg);

    const r = persistLearnedOutputLimit(cfg, 24_576, "max tokens > 24576");
    expect(r.written).toEqual([]);
  });

  test("llm 学到上限时回调监听器（chat 路径），并在 reset 后不再回调", async () => {
    const seen: number[] = [];
    setMaxTokensLimitLearnedHandler((e) => seen.push(e.limit));

    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
          return new Response("nope", { status: 404 });
        }
        calls += 1;
        if (calls === 1) {
          return Response.json({ error: { message: "max tokens > 4096" } }, { status: 400 });
        }
        await req.text();
        return Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        });
      },
    });
    try {
      const cfg = makeCfg({
        baseUrl: `http://127.0.0.1:${server.port}`,
        providers: [provFrom(providerEntry({ base_url: `http://127.0.0.1:${server.port}` }))],
      });
      await chat(cfg, [{ role: "user", content: "hi" }]);
      expect(seen).toEqual([4_096]);
    } finally {
      server.stop(true);
    }

    resetMaxTokensLimitLearnedHandler();
    const before = seen.length;
    expect(before).toBe(1);
  });
});
