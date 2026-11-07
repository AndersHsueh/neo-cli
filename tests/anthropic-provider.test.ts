/**
 * Anthropic 协议接入（api_type）：转换层纯函数 + 假网关上的协议选择/回退。
 * 全部本地假端点，不依赖外网。真实网关（minimax）的验证见提交说明。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  AnthropicStreamAccumulator,
  buildAnthropicBody,
  mapStopReason,
  mapUsage,
  parseAnthropicMessage,
  sanitizeToolId,
  toAnthropicMessages,
} from "../src/anthropicWire.ts";
import { loadConfig, type Config, type ProviderConfig } from "../src/config.ts";
import { detectModelCapabilitiesFromModelsApi } from "../src/env/modelWindows.ts";
import { chat, chatStream, endpointPlan, listModels, resetEndpointMemo, type Message, type ToolSpec } from "../src/llm.ts";

const tools: ToolSpec[] = [
  { type: "function", function: { name: "calc", description: "d", parameters: { type: "object", properties: { e: { type: "string" } } } } },
];

describe("toAnthropicMessages", () => {
  test("开头 system 合并成顶层字段；中途 system 降级为 user 文本且不丢", () => {
    const msgs: Message[] = [
      { role: "system", content: "S1" },
      { role: "system", content: "S2" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "system", content: "中途提示" },
      { role: "user", content: "再来" },
    ];
    const r = toAnthropicMessages(msgs);
    expect(r.system).toBe("S1\n\nS2");
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const last = r.messages[2]!.content.map((b) => b["text"]).join("|");
    expect(last).toContain("中途提示");
    expect(last).toContain("再来");
  });

  test("tool_calls → tool_use；连续 tool 结果合并进同一条 user，且 tool_result 排在最前", () => {
    const msgs: Message[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "好",
        tool_calls: [
          { id: "a", type: "function", function: { name: "calc", arguments: '{"e":"1"}' } },
          { id: "b", type: "function", function: { name: "calc", arguments: "{坏json" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "tool", tool_call_id: "b", content: "" },
      { role: "user", content: "继续" },
    ];
    const r = toAnthropicMessages(msgs).messages;
    expect(r.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const asst = r[1]!.content;
    expect(asst[0]).toEqual({ type: "text", text: "好" });
    expect(asst[1]).toMatchObject({ type: "tool_use", id: "a", input: { e: "1" } });
    expect(asst[2]).toMatchObject({ type: "tool_use", id: "b", input: {} });
    const u = r[2]!.content;
    expect(u.map((b) => b["type"])).toEqual(["tool_result", "tool_result", "text"]);
    expect(u[1]).toMatchObject({ tool_use_id: "b", content: "(无输出)" });
  });

  test("空助手消息给占位，保证交替且不被服务端拒收", () => {
    const r = toAnthropicMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "" },
      { role: "user", content: "b" },
    ]).messages;
    expect(r.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(r[1]!.content.length).toBe(1);
  });

  test("图片 data URL → base64 source；http URL → url source", () => {
    const r = toAnthropicMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ],
      },
    ]).messages[0]!.content;
    expect(r[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    expect(r[2]).toEqual({ type: "image", source: { type: "url", url: "https://x/y.png" } });
  });

  test("其他协议生成的 tool id 含非法字符时被清洗，且 use/result 两侧一致", () => {
    expect(sanitizeToolId("call:1/x")).toBe("call_1_x");
    const r = toAnthropicMessages([
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [{ id: "c:1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c:1", content: "ok" },
    ]).messages;
    expect(r[1]!.content[0]!["id"]).toBe("c_1");
    expect(r[2]!.content[0]!["tool_use_id"]).toBe("c_1");
  });
});

describe("buildAnthropicBody", () => {
  const base = { model: "m", maxTokens: 4096, temperature: 0.6, parallel: true };
  test("tools / tool_choice / system / parallel", () => {
    const b = buildAnthropicBody(base, [{ role: "system", content: "S" }, { role: "user", content: "u" }], tools, true);
    expect(b["system"]).toBe("S");
    expect(b["stream"]).toBe(true);
    expect((b["tools"] as Array<Record<string, unknown>>)[0]).toMatchObject({ name: "calc", input_schema: tools[0]!.function.parameters });
    expect(b["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: false });
    const off = buildAnthropicBody({ ...base, parallel: false }, [{ role: "user", content: "u" }], tools, false);
    expect(off["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect("parallel_tool_calls" in off).toBe(false);
  });
  test("无工具不下发 tool_choice；thinking 开关与预算", () => {
    const b = buildAnthropicBody({ ...base, thinking: { type: "enabled" } }, [{ role: "user", content: "u" }], [], false);
    expect("tool_choice" in b).toBe(false);
    expect(b["thinking"]).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(buildAnthropicBody({ ...base, thinking: { type: "disabled" } }, [], [], false)["thinking"]).toEqual({ type: "disabled" });
    // max_tokens 太小放不下最小预算：不下发（宁可不思考也不发必被拒的请求）
    expect("thinking" in buildAnthropicBody({ ...base, maxTokens: 1000, thinking: { type: "enabled" } }, [], [], false)).toBe(false);
  });
});

describe("映射", () => {
  test("stop_reason → finish_reason", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason(null)).toBeNull();
  });
  test("usage：输入含缓存读写；thinking 计入 reasoning", () => {
    const u = mapUsage({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } });
    expect(u).toMatchObject({ prompt_tokens: 115, completion_tokens: 7, total_tokens: 122, completion_tokens_details: { reasoning_tokens: 3 } });
  });
  test("非流式响应解析", () => {
    const r = parseAnthropicMessage({
      content: [
        { type: "thinking", thinking: "想" },
        { type: "text", text: "答" },
        { type: "tool_use", id: "t1", name: "calc", input: { e: "1" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(r).toMatchObject({ content: "答", reasoning: "想", finishReason: "tool_calls" });
    expect(r.toolCalls[0]).toMatchObject({ id: "t1", function: { name: "calc", arguments: '{"e":"1"}' } });
  });
});

describe("AnthropicStreamAccumulator", () => {
  test("文本 + 工具参数分片 + 用量累计（message_start 的 0 占位不覆盖 delta）", () => {
    const got = { c: "", r: "", t: [] as string[] };
    const a = new AnthropicStreamAccumulator({
      onContent: (d) => (got.c += d),
      onReasoning: (d) => (got.r += d),
      onToolCallDelta: (i, n, d) => got.t.push(`${i}:${n}:${d}`),
    });
    const ev = (o: unknown) => a.feed(o as Record<string, unknown>);
    ev({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } });
    ev({ type: "ping" });
    ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
    ev({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } });
    ev({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "calc", input: {} } });
    ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"e":' } });
    ev({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"1"}' } });
    ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 50, output_tokens: 9 } });
    ev({ type: "message_stop" });
    const r = a.result();
    expect(got).toEqual({ c: "你好", r: "想", t: ["0:calc:{\"e\":", "0:calc:\"1\"}"] });
    expect(r.toolCalls[0]).toMatchObject({ id: "t1", function: { name: "calc", arguments: '{"e":"1"}' } });
    expect(r.finishReason).toBe("tool_calls");
    expect(r.usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 9 });
    expect(a.sawStop).toBe(true);
  });

  test("无参数工具：input 保持 {}；error 事件被记录", () => {
    const a = new AnthropicStreamAccumulator({});
    a.feed({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "x", name: "noop", input: {} } });
    expect(a.result().toolCalls[0]!.function.arguments).toBe("{}");
    a.feed({ type: "error", error: { type: "overloaded_error", message: "忙" } });
    expect(a.error).toEqual({ type: "overloaded_error", message: "忙" });
  });
});

/* ------------------------------------------------------------------ */
/* 假网关：协议选择与回退                                               */
/* ------------------------------------------------------------------ */

const servers: Array<{ stop: (f?: boolean) => void }> = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});
beforeEach(() => resetEndpointMemo());

interface Hit {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function sseAnthropic(text: string): Response {
  const ev = (o: unknown): string => `event: x\ndata: ${JSON.stringify(o)}\n\n`;
  const body =
    ev({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } }) +
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
    ev({ type: "message_stop" });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function sseOpenAI(text: string): Response {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** 一个同时挂了两种协议路径的假网关；`anthropic404` 时 /v1/messages 不存在。 */
function gateway(opts: { anthropic404?: boolean; openai404?: boolean; anthropic401?: boolean } = {}): { url: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : null;
      hits.push({ path: u.pathname, headers, body });
      if (u.pathname === "/anthropic/v1/messages") {
        if (opts.anthropic404) return new Response("not found", { status: 404 });
        if (opts.anthropic401) return new Response('{"error":{"message":"bad key"}}', { status: 401 });
        return body?.["stream"] ? sseAnthropic("来自anthropic") : Response.json({ content: [{ type: "text", text: "来自anthropic" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      }
      if (u.pathname === "/anthropic/v1/models") {
        if (opts.anthropic404) return new Response("nf", { status: 404 });
        return Response.json({ data: [{ id: "claude-x" }] });
      }
      if (u.pathname === "/v1/chat/completions") {
        if (opts.openai404) return new Response("nf", { status: 404 });
        return body?.["stream"] ? sseOpenAI("来自openai") : Response.json({ choices: [{ message: { content: "来自openai" }, finish_reason: "stop" }] });
      }
      if (u.pathname === "/v1/models") return Response.json({ data: [{ id: "gpt-x" }] });
      return new Response("nf", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits };
}

function cfgFor(url: string, apiTypes: Array<"anthropic" | "openai">, extra: Partial<ProviderConfig> = {}): Config {
  const p: ProviderConfig = {
    name: "gw",
    type: apiTypes[0]!,
    apiTypes,
    baseUrl: apiTypes[0] === "anthropic" ? `${url}/anthropic` : `${url}/v1`,
    baseUrls: { anthropic: `${url}/anthropic`, openai: `${url}/v1` },
    apiKey: "K",
    models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
    maxTokens: null,
    temperature: null,
    contextWindow: null,
    ...extra,
  };
  return {
    providerName: "gw",
    providerType: p.type,
    apiKey: "K",
    baseUrl: p.baseUrl,
    model: "m",
    maxTokens: 1024,
    temperature: 0.5,
    providers: [p],
    retry: { maxAttempts: 1, baseDelayMs: 1, connectTimeoutMs: 5000, streamIdleTimeoutMs: 5000 },
  } as unknown as Config;
}

const U: Message[] = [{ role: "user", content: "hi" }];

describe("协议选择与回退", () => {
  test("单协议 anthropic：打 /v1/messages，带 x-api-key 与 anthropic-version，不碰 openai 路径", async () => {
    const g = gateway();
    const r = await chatStream(cfgFor(g.url, ["anthropic"]), U, []);
    expect(r.content).toBe("来自anthropic");
    expect(g.hits.map((h) => h.path)).toEqual(["/anthropic/v1/messages"]);
    expect(g.hits[0]!.headers["x-api-key"]).toBe("K");
    expect(g.hits[0]!.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("单协议 openai：行为不变（Bearer，/chat/completions）", async () => {
    const g = gateway();
    const r = await chat(cfgFor(g.url, ["openai"]), U);
    expect(r.content).toBe("来自openai");
    expect(g.hits[0]!.path).toBe("/v1/chat/completions");
    expect(g.hits[0]!.headers["authorization"]).toBe("Bearer K");
    expect(g.hits[0]!.headers["x-api-key"]).toBeUndefined();
  });

  test("两种都能通 → 优先 anthropic（与数组书写顺序无关）", async () => {
    const g = gateway();
    const cfg = cfgFor(g.url, ["anthropic", "openai"]);
    expect(endpointPlan(cfg).map((e) => e.proto)).toEqual(["anthropic", "openai"]);
    const r = await chatStream(cfg, U, []);
    expect(r.content).toBe("来自anthropic");
    expect(g.hits.map((h) => h.path)).toEqual(["/anthropic/v1/messages"]);
  });

  test("anthropic 端点 404 → 回退 openai，并记住：后续请求不再试错", async () => {
    const g = gateway({ anthropic404: true });
    const cfg = cfgFor(g.url, ["anthropic", "openai"]);
    const notices: string[] = [];
    const r1 = await chatStream(cfg, U, [], { onNotice: (m) => notices.push(m) });
    expect(r1.content).toBe("来自openai");
    expect(notices.some((n) => n.includes("openai"))).toBe(true);
    g.hits.length = 0;
    const r2 = await chatStream(cfg, U, []);
    expect(r2.content).toBe("来自openai");
    expect(g.hits.map((h) => h.path)).toEqual(["/v1/chat/completions"]);
  });

  test("鉴权失败(401) 不回退：换协议只会掩盖配置错误", async () => {
    const g = gateway({ anthropic401: true });
    await expect(chatStream(cfgFor(g.url, ["anthropic", "openai"]), U, [])).rejects.toMatchObject({ status: 401 });
    expect(g.hits.map((h) => h.path)).toEqual(["/anthropic/v1/messages"]);
  });

  test("单协议时 404 照常抛出，不会「回退」到没声明的协议", async () => {
    const g = gateway({ anthropic404: true });
    await expect(chatStream(cfgFor(g.url, ["anthropic"]), U, [])).rejects.toMatchObject({ status: 404 });
    expect(g.hits.every((h) => h.path.startsWith("/anthropic"))).toBe(true);
  });

  test("NEO_BASE_URL 式覆盖（cfg.baseUrl 偏离 provider）→ 只走 cfg.providerType 单协议", () => {
    const cfg = cfgFor("http://x", ["anthropic", "openai"]);
    cfg.baseUrl = "http://override";
    expect(endpointPlan(cfg)).toEqual([{ proto: "anthropic", baseUrl: "http://override" }]);
  });

  test("非流式 chat 同样走 anthropic 并回退", async () => {
    const g = gateway({ anthropic404: true });
    const r = await chat(cfgFor(g.url, ["anthropic", "openai"]), U);
    expect(r.content).toBe("来自openai");
    expect(g.hits.map((h) => h.path)).toEqual(["/anthropic/v1/messages", "/v1/chat/completions"]);
  });

  test("listModels：anthropic 用 /v1/models + x-api-key；404 回退 openai", async () => {
    const g = gateway();
    expect(await listModels(cfgFor(g.url, ["anthropic", "openai"]))).toEqual(["claude-x"]);
    expect(g.hits[0]!.headers["x-api-key"]).toBe("K");
    const g2 = gateway({ anthropic404: true });
    expect(await listModels(cfgFor(g2.url, ["anthropic", "openai"]))).toEqual(["gpt-x"]);
  });

  test("请求体：anthropic 路径不含 OpenAI 专有字段", async () => {
    const g = gateway();
    await chatStream(cfgFor(g.url, ["anthropic"]), [{ role: "system", content: "S" }, ...U], tools);
    const b = g.hits[0]!.body!;
    expect(b["system"]).toBe("S");
    expect("parallel_tool_calls" in b).toBe(false);
    expect((b["messages"] as unknown[]).length).toBe(1);
  });
});

describe("能力探测走对协议", () => {
  test("anthropic provider：/v1/models + x-api-key；条目里的窗口字段照常解析", async () => {
    const hits: Array<{ path: string; key: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        hits.push({ path: u.pathname, key: req.headers.get("x-api-key") });
        if (u.pathname === "/anthropic/v1/models") return Response.json({ data: [{ id: "m", context_window: 300000 }] });
        return new Response("nf", { status: 404 });
      },
    });
    servers.push(server);
    const cfg = cfgFor(`http://127.0.0.1:${server.port}`, ["anthropic"]);
    const caps = await detectModelCapabilitiesFromModelsApi(cfg);
    expect(caps?.contextWindow).toBe(300000);
    expect(hits).toEqual([{ path: "/anthropic/v1/models", key: "K" }]);
  });
});

describe("配置：api_type 解析", () => {
  function load(provider: Record<string, unknown>): ProviderConfig {
    const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "neo-cfg-"));
    require("node:fs").writeFileSync(
      require("node:path").join(dir, "settings.json"),
      JSON.stringify({ providers: [{ provider_name: "p", default_model_name: "m", api_key: "k", ...provider }] }),
    );
    const prev = process.cwd();
    process.chdir(dir);
    try {
      return loadConfig().providers[0]!;
    } finally {
      process.chdir(prev);
    }
  }

  test("数组：两种都填 → anthropic 优先；各自 base_url 覆盖", () => {
    const p = load({ api_type: ["openai", "anthropic"], base_url: "http://a/v1", anthropic_base_url: "http://a/anthropic" });
    expect(p.apiTypes).toEqual(["anthropic", "openai"]);
    expect(p.type).toBe("anthropic");
    expect(p.baseUrl).toBe("http://a/anthropic");
    expect(p.baseUrls).toEqual({ anthropic: "http://a/anthropic", openai: "http://a/v1" });
  });
  test("字符串 / 旧字段 provider_type 仍然有效", () => {
    expect(load({ api_type: "openai", base_url: "http://a/v1" }).apiTypes).toEqual(["openai"]);
    expect(load({ provider_type: "anthropic", base_url: "http://a" }).apiTypes).toEqual(["anthropic"]);
  });
  test("非法协议 / 缺失 / 缺 base_url 给出可定位错误", () => {
    expect(() => load({ api_type: ["grpc"], base_url: "http://a" })).toThrow(/不是已知协议/);
    expect(() => load({ base_url: "http://a" })).toThrow(/缺少 api_type/);
    expect(() => load({ api_type: ["anthropic", "openai"], openai_base_url: "http://a/v1" })).toThrow(/anthropic/);
  });
});
