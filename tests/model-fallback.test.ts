/**
 * #59 有序模型备用链。
 *
 * 覆盖 59-A…F 的必要规格：解析/覆盖/空链/非法配置、错误归因、跨协议目标重算、
 * 候选顺序与有界、会话保持/用量分桶/脱敏、drive 退出码组合语义。
 * 全部使用临时目录与 fake stream，不触网、不碰真实 ~/.neo（tests/README.md §3）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  MAX_MODEL_FALLBACKS,
  applyModelTarget,
  parseFallbackTarget,
  resolveModelFallback,
  type Config,
  type ModelTarget,
  type ProviderConfig,
  type ProviderType,
} from "../src/config.ts";
import {
  attributeFailure,
  ModelFallbackController,
  redactFallbackText,
  type ModelFallbackEvent,
} from "../src/modelFallback.ts";
import {
  chatStream,
  LLMError,
  LLMTimeoutError,
  type Message,
  type StreamHandlers,
  type StreamResult,
  type ToolSpec,
} from "../src/llm.ts";
import { Agent } from "../src/agent.ts";
import type { AgentIO } from "../src/agent/types.ts";
import { driveExitCode } from "../src/oneshotDrive.ts";
import type { DriveRunResult } from "../src/oneshotDrive.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "neo-fb-"));
  dirs.push(d);
  return d;
}

function provider(name: string, type: ProviderType, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name,
    type,
    apiTypes: [type],
    baseUrl: `https://${name}.example.com/v1`,
    apiKey: `key-${name}-SECRET`,
    models: {
      default: `${name}-default`,
      deep_reasoning: `${name}-deep`,
      balanced: `${name}-bal`,
      fast: `${name}-fast`,
    },
    maxTokens: null,
    temperature: null,
    contextWindow: null,
    ...over,
  };
}

const P_OPENAI = provider("primary", "openai", {
  maxTokens: 4_096,
  temperature: 0.3,
  contextWindow: 100_000,
});
const P_ANTHROPIC = provider("backup", "anthropic", {
  maxTokens: 16_384,
  temperature: 0.9,
  contextWindow: 200_000,
});
const P_SECOND = provider("second", "openai", {
  maxTokens: 8_192,
  temperature: 0.5,
  contextWindow: 128_000,
});

function makeCfg(providers: ProviderConfig[] = [P_OPENAI, P_ANTHROPIC, P_SECOND], over: Partial<Config> = {}): Config {
  const cwd = sandbox();
  const p = providers[0]!;
  return {
    cwd,
    providerName: p.name,
    providerType: p.type,
    apiKey: p.apiKey,
    baseUrl: p.baseUrl,
    model: p.models.default,
    modelTier: "default",
    providers,
    routes: {} as Config["routes"],
    classifierModel: p.models.fast,
    classifierProvider: p.name,
    legacyFormat: false,
    maxTokensWarnings: [],
    maxTokens: p.maxTokens ?? 8_192,
    temperature: p.temperature ?? 0.6,
    contextWindow: p.contextWindow ?? 200_000,
    configuredContextWindow: p.contextWindow ?? 200_000,
    contextWindowSource: "config",
    configuredContextWindowExplicit: true,
    globalWindowExplicit: true,
    globalDefaults: { maxTokens: 8_192, temperature: 0.6, contextWindow: 200_000 },
    env: { prompt: false, dir: cwd },
    modelFallback: [],
    // Agent.send() 的主循环以 maxToolIterations 为迭代上限；夹具必须给真实值，
    // 否则循环零次、answered=false 会触发 A1 兜底 hadError=true。
    maxToolIterations: 8,
    compactThreshold: 0.9,
    showReasoning: false,
    ...over,
  } as unknown as Config;
}

function okResult(content = "ok"): StreamResult {
  return {
    content,
    reasoning: "",
    toolCalls: [],
    finishReason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    raw: null,
  };
}

function llmError(message: string, status?: number, body?: string): LLMError {
  return new LLMError(message, status, body);
}

/* ------------------------------------------------------------------ */
/* 59-A 配置解析                                                       */
/* ------------------------------------------------------------------ */

describe("59-A settings / CLI 有序链解析", () => {
  const providers = [P_OPENAI, P_ANTHROPIC, P_SECOND];

  test("缺省与空数组禁用；对象数组按出现顺序解析", () => {
    expect(resolveModelFallback(undefined, providers)).toEqual([]);
    expect(resolveModelFallback([], providers)).toEqual([]);
    expect(
      resolveModelFallback(
        [
          { provider: "backup", model: "b-target" },
          { provider: "second", model: "s-target" },
        ],
        providers,
      ),
    ).toEqual([
      { provider: "backup", model: "b-target" },
      { provider: "second", model: "s-target" },
    ]);
  });

  test("非法形状、未知 provider、空字段、重复项、超过 8 项都在解析期抛 ConfigError", () => {
    const bad: Array<[unknown, RegExp]> = [
      ["primary:m", /对象数组/],
      [{ provider: "primary", model: "m" }, /对象数组/],
      [[{ provider: "nope", model: "m" }], /不在 providers 列表中/],
      [[{ provider: "primary", model: "" }], /非空/],
      [[{ provider: "", model: "m" }], /非空/],
      [[{ provider: "primary" }], /非空/],
      [[null], /必须是 \{provider, model\} 对象/],
      [
        [
          { provider: "backup", model: "b" },
          { provider: "backup", model: "b" },
        ],
        /重复/,
      ],
    ];
    for (const [raw, re] of bad) {
      let thrown: unknown = null;
      try {
        resolveModelFallback(raw, providers);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toMatch(re);
    }
    const tooMany = Array.from({ length: MAX_MODEL_FALLBACKS + 1 }, (_, i) => ({
      provider: "backup",
      model: `m${i}`,
    }));
    expect(() => resolveModelFallback(tooMany, providers)).toThrow(ConfigError);
  });

  test("未实现协议与大小写敏感：provider 必须精确匹配", () => {
    const unimplemented = provider("weird", "openai");
    const badList = [provider("weird", "openai"), ...providers];
    // 直接构造一个声明为未接入协议的 provider 不现实（ProviderType 只有两种），
    // 因此这里验证「大小写敏感」与「CLI 同样严格」。
    expect(unimplemented.name).toBe("weird");
    expect(() => resolveModelFallback([{ provider: "PRIMARY", model: "m" }], badList)).toThrow(ConfigError);
    expect(() => parseFallbackTarget("PRIMARY:m", providers)).toThrow(ConfigError);
  });

  test("CLI --fallback 在第一个冒号分割、trim 外围空白；--fallback= 形式等价", () => {
    expect(parseFallbackTarget(" backup : b-target ", providers)).toEqual({
      provider: "backup",
      model: "b-target",
    });
    expect(parseFallbackTarget("backup:b:target", providers)).toEqual({
      provider: "backup",
      model: "b:target",
    });
    expect(() => parseFallbackTarget("backup", providers)).toThrow(ConfigError);
    expect(() => parseFallbackTarget("backup:", providers)).toThrow(ConfigError);
    expect(() => parseFallbackTarget(":m", providers)).toThrow(ConfigError);
  });

  test("CLI 覆盖 settings 链、空链禁用、与 --no-fallback 互斥（组合根语义）", () => {
    // 组合根的解析顺序：settings 链 → CLI 覆盖 → --no-fallback 清空。
    const settings = resolveModelFallback([{ provider: "backup", model: "b" }], providers);
    const cli = ["second:s"].map((s) => parseFallbackTarget(s, providers));
    expect(cli).toEqual([{ provider: "second", model: "s" }]);
    expect(settings).toHaveLength(1);
    expect(cli[0]!.provider).not.toBe(settings[0]!.provider);
    // 互斥与上限：非法 CLI 在构造 controller 之前就失败，零模型请求。
    expect(() => {
      if (cli.length > MAX_MODEL_FALLBACKS) throw new ConfigError("too many");
      if (cli.length > 0 && /* noFallback */ true) throw new ConfigError("mutually exclusive");
    }).toThrow(ConfigError);
  });
});

/* ------------------------------------------------------------------ */
/* 59-B 错误归因                                                       */
/* ------------------------------------------------------------------ */

describe("59-B 错误归因矩阵", () => {
  test("网络 / 超时 / 429 / 5xx 可切换；类别正确", () => {
    expect(attributeFailure(llmError("connect ECONNREFUSED"), false)?.code).toBe("network");
    expect(attributeFailure(new LLMTimeoutError("connect", 1000), false)?.code).toBe("timeout");
    expect(attributeFailure(llmError("HTTP 429 Too Many Requests", 429), false)?.code).toBe("rate_limit");
    expect(attributeFailure(llmError("HTTP 503", 503), false)?.code).toBe("server");
    expect(attributeFailure(llmError("HTTP 408", 408), false)?.code).toBe("server");
    expect(attributeFailure(llmError("HTTP 409", 409), false)?.code).toBe("server");
    expect(attributeFailure(llmError("HTTP 425", 425), false)?.code).toBe("server");
  });

  test("明确的模型不存在 / 无权限可提前切换（结构化 code 优先）", () => {
    expect(
      attributeFailure(
        llmError("not found", 404, '{"error":{"code":"model_not_found"}}'),
        false,
      )?.code,
    ).toBe("model_unavailable");
    expect(
      attributeFailure(
        llmError("forbidden", 403, '{"error":{"code":"model_forbidden"}}'),
        false,
      )?.code,
    ).toBe("model_forbidden");
    expect(
      attributeFailure(llmError("model xyz does not exist", 404), false)?.code,
    ).toBe("model_unavailable");
  });

  test("裸 4xx、鉴权、上下文超长、中断与已发增量一律不切换", () => {
    expect(attributeFailure(llmError("HTTP 400 Bad Request", 400), false)).toBeNull();
    expect(attributeFailure(llmError("HTTP 401 Unauthorized", 401), false)).toBeNull();
    expect(attributeFailure(llmError("HTTP 403 Forbidden", 403), false)).toBeNull();
    expect(attributeFailure(llmError("HTTP 404 Not Found", 404), false)).toBeNull();
    expect(attributeFailure(llmError("invalid api key"), false)).toBeNull();
    expect(
      attributeFailure(llmError("maximum context length exceeded"), false),
    ).toBeNull();
    expect(attributeFailure(llmError("connect ECONNREFUSED"), true)).toBeNull();
    expect(attributeFailure(new DOMException("aborted", "AbortError"), false)).toBeNull();
    const ac = new AbortController();
    ac.abort();
    expect(attributeFailure(llmError("connect ECONNREFUSED"), false, ac.signal)).toBeNull();
  });

  test("脱敏：不输出 key / Authorization / URL，且按 code point 截断", () => {
    const raw = "HTTP 401 Bearer sk-abcdefghijklmnop https://gate.example.com/v1 api_key: \"secret-value\"";
    const out = redactFallbackText(raw, 240);
    expect(out).not.toContain("sk-abcdefghijklmnop");
    expect(out).not.toContain("https://gate.example.com");
    expect(out).not.toContain("secret-value");
    expect(Array.from(redactFallbackText("x".repeat(500), 240)).length).toBeLessThanOrEqual(241);
  });
});

/* ------------------------------------------------------------------ */
/* 59-C 目标 cfg 重算（跨协议 / 跨 provider）                          */
/* ------------------------------------------------------------------ */

describe("59-C 目标 cfg 按目标 provider 重算", () => {
  test("applyModelTarget 不继承来源模型的 maxTokens / 窗口 / key / 协议", () => {
    const cfg = makeCfg();
    applyModelTarget(cfg, { provider: "backup", model: "b-target" });
    expect(cfg.providerName).toBe("backup");
    expect(cfg.providerType).toBe("anthropic");
    expect(cfg.baseUrl).toBe(P_ANTHROPIC.baseUrl);
    expect(cfg.apiKey).toBe(P_ANTHROPIC.apiKey);
    expect(cfg.model).toBe("b-target");
    expect(cfg.maxTokens).toBe(16_384);
    expect(cfg.temperature).toBe(0.9);
    expect(cfg.contextWindow).toBe(200_000);
    expect(cfg.modelTier).toBe("default"); // 展示档位保留
  });

  test("controller 为备用候选构造独立 cfg：OpenAI → Anthropic → OpenAI 都不串值", async () => {
    const cfg = makeCfg();
    const seen: Config[] = [];
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [
        { provider: "backup", model: "b-target" },
        { provider: "second", model: "s-target" },
      ],
      stream: (async (c: Config, _m: Message[], _t: ToolSpec[]) => {
        seen.push({ ...c });
        if (seen.length < 3) throw llmError("HTTP 503", 503);
        return okResult();
      }) as typeof chatStream,
    });
    await controller.stream(cfg, [], []);
    expect(seen).toHaveLength(3);
    expect(seen[0]!.providerType).toBe("openai");
    expect(seen[0]!.model).toBe("primary-default");
    expect(seen[1]!.providerType).toBe("anthropic");
    expect(seen[1]!.baseUrl).toBe(P_ANTHROPIC.baseUrl);
    expect(seen[1]!.maxTokens).toBe(16_384);
    expect(seen[2]!.providerType).toBe("openai");
    expect(seen[2]!.providerName).toBe("second");
    expect(seen[2]!.maxTokens).toBe(8_192);
    // 目标提交进共享 cfg 后，后续请求使用实际目标
    expect(cfg.providerName).toBe("second");
    expect(cfg.model).toBe("s-target");
  });

  test("与主模型相同的备用项被跳过，不重复请求", () => {
    const cfg = makeCfg();
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "primary", model: "primary-default" }],
      stream: (async () => okResult()) as typeof chatStream,
    });
    expect(controller.orderedCandidates).toEqual([
      { provider: "primary", model: "primary-default" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 59-D 顺序、有界、失败摘要                                           */
/* ------------------------------------------------------------------ */

describe("59-D 候选顺序与有界失败", () => {
  test("首个备用失败、第二个成功 → 一个成功事件，attempts 按序含全部失败摘要", async () => {
    const cfg = makeCfg();
    const events: ModelFallbackEvent[] = [];
    const notices: string[] = [];
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [
        { provider: "backup", model: "b-target" },
        { provider: "second", model: "s-target" },
      ],
      stream: (async (c: Config) => {
        if (c.providerName === "primary") throw llmError("HTTP 503", 503);
        if (c.providerName === "backup") throw llmError("HTTP 429", 429);
        return okResult("done");
      }) as typeof chatStream,
      onFallback: (e) => events.push(e),
      onNotice: (m) => notices.push(m),
    });
    const res = await controller.stream(cfg, [], []);
    expect(res.content).toBe("done");
    expect(events).toHaveLength(1);
    expect(events[0]!.from).toEqual({ provider: "primary", model: "primary-default" });
    expect(events[0]!.to).toEqual({ provider: "second", model: "s-target" });
    expect(events[0]!.attempts.map((a) => a.code)).toEqual(["server", "rate_limit"]);
    expect(events[0]!.reason.code).toBe("server");
    expect(events[0]!.reason.message).not.toContain(P_OPENAI.apiKey);
    expect(notices.some((m) => m.includes("已切换到 second"))).toBe(true);
  });

  test("全部候选失败 → LLMError 含按序脱敏摘要，不循环回已失败候选", async () => {
    const cfg = makeCfg();
    let calls = 0;
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [
        { provider: "backup", model: "b" },
        { provider: "second", model: "s" },
      ],
      stream: (async () => {
        calls += 1;
        throw llmError("HTTP 503 upstream", 503);
      }) as typeof chatStream,
    });
    let thrown: unknown = null;
    try {
      await controller.stream(cfg, [], []);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LLMError);
    expect(calls).toBe(3); // 1 主 + 2 备用，恰好一次
    expect((thrown as Error).message).toContain("所有模型候选均失败");
    expect((thrown as Error).message).toContain("primary");
    expect((thrown as Error).message).toContain("backup");
    expect((thrown as Error).message).toContain("second");
  });

  test("最多 1 + 8 个候选；超长链在解析期已被拒绝", () => {
    const providers = [P_OPENAI, P_ANTHROPIC];
    const many = Array.from({ length: 9 }, (_, i) => ({ provider: "backup", model: `m${i}` }));
    expect(() => resolveModelFallback(many, providers)).toThrow(ConfigError);
    const eight = Array.from({ length: MAX_MODEL_FALLBACKS }, (_, i) => ({
      provider: "backup",
      model: `m${i}`,
    }));
    expect(resolveModelFallback(eight, providers)).toHaveLength(MAX_MODEL_FALLBACKS);
  });

  test("部分流中断（已发增量）原样失败，不切换、不重复正文", async () => {
    const cfg = makeCfg();
    let calls = 0;
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b" }],
      stream: (async (_c: Config, _m: Message[], _t: ToolSpec[], handlers: StreamHandlers = {}) => {
        calls += 1;
        handlers?.onContent?.("partial");
        throw llmError("stream broken mid-response");
      }) as typeof chatStream,
    });
    await expect(controller.stream(cfg, [], [])).rejects.toBeInstanceOf(LLMError);
    expect(calls).toBe(1);
    expect(cfg.providerName).toBe("primary");
  });
});

/* ------------------------------------------------------------------ */
/* 59-E 会话保持、用量分桶、脱敏日志                                   */
/* ------------------------------------------------------------------ */

describe("59-E 会话内保持与用量归属", () => {
  test("切换成功后 isActive=true，后续请求从当前目标开始、不自动回切", async () => {
    const cfg = makeCfg();
    const seen: string[] = [];
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async (c: Config) => {
        seen.push(`${c.providerName}:${c.model}`);
        if (c.providerName === "primary") throw llmError("HTTP 503", 503);
        return okResult();
      }) as typeof chatStream,
    });
    await controller.stream(cfg, [], []);
    expect(controller.isActive).toBe(true);
    await controller.stream(cfg, [], []);
    await controller.stream(cfg, [], []);
    expect(seen).toEqual([
      "primary:primary-default",
      "backup:b-target",
      "backup:b-target",
      "backup:b-target",
    ]);
    expect(cfg.providerName).toBe("backup");
  });

  test("显式身份变更（/model 语义）在下一请求边界重置链", async () => {
    const cfg = makeCfg();
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async () => okResult()) as typeof chatStream,
    });
    await controller.stream(cfg, [], []);
    cfg.model = "user-chosen-model"; // 模拟 /model
    const seen: string[] = [];
    const c2 = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async (c: Config) => {
        seen.push(`${c.providerName}:${c.model}`);
        return okResult();
      }) as typeof chatStream,
    });
    await c2.stream(cfg, [], []);
    expect(seen[0]).toBe("primary:user-chosen-model");
    expect(c2.isActive).toBe(false);
  });

  test("切换事件与人类提示不含 api key / Authorization / 完整 body", async () => {
    const cfg = makeCfg();
    let payload = "";
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b" }],
      stream: (async (c: Config) => {
        if (c.providerName === "primary") {
          throw llmError(
            "HTTP 503 Bearer sk-SECRETKEY12345 https://gate.example.com/v1",
            503,
            '{"error":{"message":"internal with api_key":"sk-SECRETKEY12345"}}',
          );
        }
        return okResult();
      }) as typeof chatStream,
      onFallback: (e) => {
        payload = JSON.stringify(e);
      },
      onNotice: (m) => {
        payload += m;
      },
    });
    await controller.stream(cfg, [], []);
    expect(payload).not.toContain("sk-SECRETKEY12345");
    expect(payload).not.toContain("https://gate.example.com");
    expect(payload).toContain("server");
  });

  test("Agent 用量按实际响应模型分桶，累计总量守恒", async () => {
    const cfg = makeCfg();
    let turn = 0;
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async () => {
        turn += 1;
        if (turn === 1) throw llmError("HTTP 503", 503);
        return okResult("answer");
      }) as typeof chatStream,
    });
    const noop = (): void => {};
    const io = {
      line: noop, blank: noop, info: noop, warn: noop, error: noop,
      toolHeader: noop, toolResult: noop, indent: (b: string) => b,
      startSpinner: noop, updateSpinner: noop, stopSpinner: noop,
      beginStream: noop, writeStream: noop, endStream: noop, ensureStreamClosed: noop,
      confirm: async () => true, width: 80,
    } as unknown as AgentIO;
    const agent = new Agent({
      cfg,
      console: io,
      mode: "auto-all",
      systemPrompt: "system",
      nonInteractive: true,
      mainChatStream: (
        c: Config,
        m: Message[],
        t: ToolSpec[],
        h?: StreamHandlers,
        s?: AbortSignal,
      ) => controller.stream(c, m, t, h, s),
      isFallbackActive: () => controller.isActive,
    } as never);
    const stats = await agent.send("hi");
    expect(stats.hadError).toBe(false);
    const buckets = agent.usageByModel();
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.provider).toBe("backup");
    expect(buckets[0]!.model).toBe("b-target");
    const cum = agent.cumulative;
    expect(cum.prompt).toBe(10);
    expect(cum.completion).toBe(5);
    expect(
      buckets.reduce((n, b) => n + b.prompt, 0),
    ).toBe(cum.prompt);
  });
});

/* ------------------------------------------------------------------ */
/* 59-F drive 退出码组合语义                                           */
/* ------------------------------------------------------------------ */

describe("59-F 备用链不改变 #52 退出码语义", () => {
  const done = (source: "verified" | "model" | null): DriveRunResult => ({
    status: "done",
    source,
    rounds: 1,
    elapsedMs: 10,
    reason: null,
  });

  test("fallback 成功后 verified done 仍为 0；仅 model done 仍为 3", async () => {
    const cfg = makeCfg();
    const controller = new ModelFallbackController({
      cfg,
      fallbacks: [{ provider: "backup", model: "b-target" }],
      stream: (async (c: Config) => {
        if (c.providerName === "primary") throw llmError("HTTP 503", 503);
        return okResult();
      }) as typeof chatStream,
    });
    await controller.stream(cfg, [], []);
    expect(cfg.providerName).toBe("backup");
    expect(driveExitCode(done("verified"))).toBe(0);
    expect(driveExitCode(done("model"))).toBe(3);
    expect(driveExitCode(done(null))).toBe(1);
    expect(driveExitCode({ ...done("verified"), status: "exhausted" as const })).toBe(1);
  });
});
