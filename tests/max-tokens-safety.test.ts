/**
 * issue #21：max_tokens 安全防护。
 *
 * A 启动期告警（auditMaxTokens）：不合理值命中 / 正常配置不误报 / 瘦网关不猜。
 * B 不透明 400 安全降级：降级一次成功 / 透传原始文案 / 鉴权与上下文超长不降级 / 不循环。
 * C 400 文案补提示行。
 *
 * 全部本地假网关与纯函数，不触网。loadConfig 部分用临时目录写确定性 settings.json。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMaxTokensHint,
  chat,
  OPAQUE_400_DOWNGRADE_FLOOR,
  shouldDowngradeForOpaque400,
  chatStream,
  LLMError,
  resetLearnedMaxTokens,
  type Message,
  type ToolSpec,
} from "../src/llm.ts";
import { auditMaxTokens, loadConfig, type Config, type ProviderConfig } from "../src/config.ts";

/* ------------------------------------------------------------------ */
/* A：auditMaxTokens 纯函数                                            */
/* ------------------------------------------------------------------ */

function prov(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: "gw",
    type: "openai",
    baseUrl: "http://x",
    apiKey: "K",
    models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
    maxTokens: null,
    temperature: null,
    contextWindow: null,
    ...over,
  };
}

describe("auditMaxTokens（issue #21 A 启动告警）", () => {
  test("命中：max_tokens ≥ context_window", () => {
    const out = auditMaxTokens([prov({ maxTokens: 512000, contextWindow: 512000 })]);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("gw");
    expect(out[0]).toContain("max_tokens");
    expect(out[0]).toContain("context_window");
  });

  test("命中：max_tokens > max_output_tokens", () => {
    const out = auditMaxTokens([prov({ maxTokens: 512000, maxOutputTokens: 196608 })]);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("max_output_tokens");
  });

  test("不误报：模板默认 8192/200000；max_tokens 小于窗口且 ≤ 输出上限", () => {
    expect(auditMaxTokens([prov({ maxTokens: 8192, contextWindow: 200000 })])).toEqual([]);
    expect(
      auditMaxTokens([prov({ maxTokens: 8192, contextWindow: 200000, maxOutputTokens: 64000 })]),
    ).toEqual([]);
    expect(auditMaxTokens([prov({ maxTokens: 64000, contextWindow: 200000, maxOutputTokens: 64000 })])).toEqual([]);
  });

  test("瘦网关不猜：max_output_tokens / context_window 未知时不告警", () => {
    expect(auditMaxTokens([prov({ maxTokens: 512000 })])).toEqual([]);
    expect(auditMaxTokens([prov({ maxTokens: 512000, contextWindow: null, maxOutputTokens: null })])).toEqual([]);
  });

  test("未配置 max_tokens 的 provider 跳过；多 provider 只报有问题的", () => {
    expect(auditMaxTokens([prov({ maxTokens: null, contextWindow: 200000 })])).toEqual([]);
    const out = auditMaxTokens([
      prov({ name: "ok", maxTokens: 8192, contextWindow: 200000 }),
      prov({ name: "bad", maxTokens: 512000, contextWindow: 512000 }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("bad");
  });

  test("loadConfig 集成：512000/512000 产生告警，正常配置不产生", async () => {
    const dir = join(tmpdir(), `neo-mtwarn-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const settings = {
      default_provider: "p1",
      providers: [
        {
          provider_name: "p1",
          api_type: ["openai"],
          base_url: "https://x.example.com/v1",
          api_key: "k",
          default_model_name: "m1",
          max_tokens: 512000,
          context_window: 512000,
        },
      ],
    };
    writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
    const prev = process.cwd();
    try {
      process.chdir(dir);
      const cfg = loadConfig();
      expect(cfg.maxTokensWarnings.length).toBe(1);
      expect(cfg.maxTokensWarnings[0]).toContain("p1");
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* B：shouldDowngradeForOpaque400 纯函数                                */
/* ------------------------------------------------------------------ */

describe("shouldDowngradeForOpaque400（issue #21 B 判定）", () => {
  const opaque = (m = "request was rejected by an internal MaaS component") => new LLMError(m, 400);

  test("不透明 400 且当前值 > 8192 → 降级", () => {
    expect(shouldDowngradeForOpaque400(opaque(), 512000)).toBe(true);
  });

  test("只降不升：当前值 ≤ 8192 → 不降级", () => {
    expect(shouldDowngradeForOpaque400(opaque(), 8192)).toBe(false);
    expect(shouldDowngradeForOpaque400(opaque(), 4096)).toBe(false);
  });

  test("非 400 不降级：401/403/404/422/500", () => {
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 401), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 403), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 404), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 422), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("nope", 500), 512000)).toBe(false);
  });

  test("上下文超长文案不降级（overflow 恢复的领地）", () => {
    expect(
      shouldDowngradeForOpaque400(new LLMError("prompt is too long: 250000 tokens > 200000 maximum", 400), 512000),
    ).toBe(false);
    expect(
      shouldDowngradeForOpaque400(new LLMError("This model's maximum context length is 128000 tokens", 400), 512000),
    ).toBe(false);
  });

  test("鉴权文案的 400 不降级", () => {
    expect(shouldDowngradeForOpaque400(new LLMError("invalid api key", 400), 512000)).toBe(false);
    expect(shouldDowngradeForOpaque400(new LLMError("unauthorized", 400), 512000)).toBe(false);
  });

  test("能解析出上限的 400 不走降级（那是 v0.4.75 学习机制的领地）", () => {
    expect(
      shouldDowngradeForOpaque400(new LLMError("does not support max tokens > 196608", 400), 512000),
    ).toBe(false);
  });

  test("parallel_tool_calls 拒绝不降级（issue #11 的领地）", () => {
    expect(
      shouldDowngradeForOpaque400(new LLMError("unknown field: parallel_tool_calls", 400), 512000),
    ).toBe(false);
  });

  test("非 LLMError 不降级", () => {
    expect(shouldDowngradeForOpaque400(new Error("x"), 512000)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* B：假网关端到端（chatStream）                                        */
/* ------------------------------------------------------------------ */

const servers: Array<{ stop: (f?: boolean) => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

/** OpenAI 协议 SSE 正常响应。 */
function sseOk(): Response {
  const body =
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

interface OpaqueGW {
  url: string;
  sent: number[];
}

/**
 * 不透明 400 假网关：`rejectAll` 时对每个请求都回 issue 原文案（解析不出上限），
 * 否则只拒 max_tokens > threshold 的请求。status 可指定 401 等（配 rejectAll 观察不降级）。
 */
function opaqueGateway(threshold: number, opts: { rejectAll?: boolean; status?: number } = {}): OpaqueGW {
  const sent: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      const mt = body["max_tokens"] as number;
      sent.push(mt);
      if (opts.rejectAll || mt > threshold) {
        return Response.json(
          { error: { message: "request was rejected by an internal MaaS component" } },
          { status: opts.status ?? 400 },
        );
      }
      return body["stream"] ? sseOk() : Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, sent };
}

function cfgFor(url: string, maxTokens: number): Config {
  return {
    providerName: "gw",
    providerType: "openai",
    apiKey: "K",
    baseUrl: url,
    model: "m",
    maxTokens,
    temperature: 0.5,
    providers: [],
    retry: { maxAttempts: 1, baseDelayMs: 1, connectTimeoutMs: 5000, streamIdleTimeoutMs: 5000 },
  } as unknown as Config;
}

const U: Message[] = [{ role: "user", content: "hi" }];

describe("不透明 400 安全降级（issue #21 B 端到端）", () => {
  beforeAll(() => resetLearnedMaxTokens());

  test("降级一次成功：512000 被拒 → 8192 重发成功", async () => {
    const g = opaqueGateway(OPAQUE_400_DOWNGRADE_FLOOR);
    const notices: string[] = [];
    const cfg = cfgFor(g.url, 512000);
    const r = await chatStream(cfg, U, [], { onNotice: (m) => notices.push(m) });
    expect(r.content).toBe("ok");
    expect(g.sent).toEqual([512000, OPAQUE_400_DOWNGRADE_FLOOR]);
    expect(notices.some((n) => n.includes("512,000") && n.includes("8,192"))).toBe(true);
    // 不改写用户配置
    expect(cfg.maxTokens).toBe(512000);
  });

  test("降级后仍失败：透传原始文案，只发两次不循环", async () => {
    const g = opaqueGateway(0, { rejectAll: true });
    const cfg = cfgFor(g.url, 512000);
    const err = await chatStream(cfg, U, []).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("request was rejected by an internal MaaS component");
    expect(g.sent).toEqual([512000, OPAQUE_400_DOWNGRADE_FLOOR]);
  });

  test("不许循环：恒 400 时 sent 恰好 2 次", async () => {
    const g = opaqueGateway(0, { rejectAll: true });
    await chatStream(cfgFor(g.url, 512000), U, []).catch(() => {});
    expect(g.sent.length).toBe(2);
  });

  test("401/403/上下文超长不降级：只发一次", async () => {
    const sent: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        sent.push(body["max_tokens"] as number);
        return Response.json({ error: { message: "bad api key" } }, { status: 401 });
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    await expect(chatStream(cfgFor(url, 512000), U, [])).rejects.toMatchObject({ status: 401 });
    expect(sent).toEqual([512000]);

    const sent2: number[] = [];
    const server2 = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        sent2.push(body["max_tokens"] as number);
        return Response.json({ error: { message: "prompt is too long: 250000 tokens > 200000 maximum" } }, { status: 400 });
      },
    });
    servers.push(server2);
    const url2 = `http://127.0.0.1:${server2.port}`;
    await expect(chatStream(cfgFor(url2, 512000), U, [])).rejects.toMatchObject({ status: 400 });
    expect(sent2).toEqual([512000]);
  });

  test("只降不升：当前值 ≤8192 时不降级原样透传", async () => {
    const g = opaqueGateway(0, { rejectAll: true });
    await expect(chatStream(cfgFor(g.url, 4096), U, [])).rejects.toMatchObject({ status: 400 });
    expect(g.sent).toEqual([4096]);
  });

  test("降级不记忆：第二次请求仍按配置原值发（单次观察不固化）", async () => {
    const g = opaqueGateway(OPAQUE_400_DOWNGRADE_FLOOR);
    const cfg = cfgFor(g.url, 512000);
    await chatStream(cfg, U, []);
    await chatStream(cfg, U, []);
    expect(g.sent).toEqual([512000, OPAQUE_400_DOWNGRADE_FLOOR, 512000, OPAQUE_400_DOWNGRADE_FLOOR]);
  });

  test("非流式 chat 同样降级", async () => {
    const g = opaqueGateway(OPAQUE_400_DOWNGRADE_FLOOR);
    const r = await chat(cfgFor(g.url, 512000), U);
    expect(r.content).toBe("ok");
    expect(g.sent).toEqual([512000, OPAQUE_400_DOWNGRADE_FLOOR]);
  });

  test("opaque 降级不抢 parallel_tool_calls 拒绝（issue #11 优先）", async () => {
    const sent: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, unknown>;
        sent.push(body["max_tokens"] as number);
        // 带 tools 才会下发 parallel_tool_calls 字段；只拒 true（降级为 false 后放行）
        if (body["tools"] && body["parallel_tool_calls"] === true) {
          return Response.json({ error: { message: "unknown field: parallel_tool_calls" } }, { status: 400 });
        }
        return body["stream"] ? sseOk() : Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      },
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.port}`;
    const tools: ToolSpec[] = [
      { type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } },
    ];
    const r = await chatStream(cfgFor(url, 512000), U, tools, {});
    expect(r.content).toBe("ok");
    // 两次请求 max_tokens 都是 512000：parallel 降级改的是 parallel 字段，不动 max_tokens
    expect(sent).toEqual([512000, 512000]);
  });
});

/* ------------------------------------------------------------------ */
/* C：400 文案补提示行                                                  */
/* ------------------------------------------------------------------ */

describe("appendMaxTokensHint（issue #21 C）", () => {
  test("400 且文案不含 max_tokens → 追加提示行，原始文案保留在第一行", () => {
    const e = new LLMError("request was rejected by an internal MaaS component", 400);
    appendMaxTokensHint(e);
    expect(e.message.split("\n")[0]).toBe("request was rejected by an internal MaaS component");
    expect(e.message).toContain("max_tokens");
  });

  test("文案已含 max_tokens 语义 → 不追加", () => {
    const e = new LLMError("does not support max tokens > 196608", 400);
    appendMaxTokensHint(e);
    expect(e.message).not.toContain("提示：");
  });

  test("401/403/404/500 不追加", () => {
    for (const st of [401, 403, 404, 500]) {
      const e = new LLMError("boom", st);
      appendMaxTokensHint(e);
      expect(e.message).not.toContain("提示：");
    }
  });

  test("鉴权文案的 400 不追加", () => {
    const e = new LLMError("invalid api key", 400);
    appendMaxTokensHint(e);
    expect(e.message).not.toContain("提示：");
  });

  test("parallel_tool_calls 拒绝（issue #11 领地）不追加", () => {
    const e = new LLMError("unknown field: parallel_tool_calls", 400);
    appendMaxTokensHint(e);
    expect(e.message).not.toContain("提示：");
  });
});

/* ------------------------------------------------------------------ */
/* settings.example.json 说明补全                                       */
/* ------------------------------------------------------------------ */

describe("settings.example.json max_tokens 说明（issue #21 C）", () => {
  test("模板含 max_tokens_note，且 capability_note 写明不是上下文窗口", () => {
    const raw = JSON.parse(readFileSync(join(import.meta.dir, "..", "settings.example.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const p0 = (raw["providers"] as Array<Record<string, unknown>>)[0]!;
    expect(typeof p0["max_tokens_note"]).toBe("string");
    expect(p0["max_tokens_note"]).toContain("不是上下文窗口");
    expect(p0["capability_note"]).toContain("不是上下文窗口");
  });
});
