/**
 * 提示词缓存（issue #95 已签切面）。
 *
 * 锁定：Anthropic 路径三个 ephemeral 断点（系统 / 工具末项 / 稳定历史）、
 * 临时「[系统消息]」留在历史断点之后、prompt_cache 可关、非 Anthropic 零字段、
 * 用量透出与 /cost /context 的「无」vs「0」口径、前缀稳定性。
 * 不改 vendor pin，不把系统提示拆成稳定核心+动态后缀，不加 statusline prompt_cache。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/agent.ts";
import type { TurnStats, UsageBucket } from "../src/agent/types.ts";
import {
  AnthropicStreamAccumulator,
  buildAnthropicBody,
  mapUsage,
  parseAnthropicMessage,
} from "../src/anthropicWire.ts";
import { handleSessionCommands } from "../src/cli/commandSession.ts";
import type { CommandContext } from "../src/cli/commandContext.ts";
import { helpText } from "../src/cli/help.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { chat, chatStream, resetEndpointMemo, type Message, type ToolSpec, type Usage } from "../src/llm.ts";
import {
  applyCacheControl,
  enrichOpenAICacheUsage,
  formatCacheHit,
  formatCacheTokens,
} from "../src/prompt/cacheControl.ts";
import { captureConsole } from "./helpers.ts";

const SYSTEM_MSG_PREFIX = "[系统消息]";

const tools: ToolSpec[] = [
  { type: "function", function: { name: "alpha", description: "a", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "beta", description: "b", parameters: { type: "object", properties: {} } } },
];

const bodyInput = { model: "m", maxTokens: 1024, temperature: 0.5, parallel: true };

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function cacheControlOf(v: unknown): unknown {
  return v !== null && typeof v === "object" && "cache_control" in (v as object)
    ? (v as { cache_control: unknown }).cache_control
    : undefined;
}

function cachePoints(body: Record<string, unknown>): string[] {
  const points: string[] = [];
  const sys = body["system"];
  if (Array.isArray(sys)) {
    sys.forEach((b, i) => {
      if (cacheControlOf(b)) points.push(`system[${i}]`);
    });
  }
  const ts = body["tools"];
  if (Array.isArray(ts)) {
    ts.forEach((t, i) => {
      if (cacheControlOf(t)) points.push(`tools[${i}]`);
    });
  }
  const msgs = body["messages"];
  if (Array.isArray(msgs)) {
    msgs.forEach((m, mi) => {
      const content = (m as { content?: unknown }).content;
      if (Array.isArray(content)) {
        content.forEach((b, bi) => {
          if (cacheControlOf(b)) points.push(`messages[${mi}].content[${bi}]`);
        });
      }
    });
  }
  if (cacheControlOf(body)) points.push("top-level");
  return points;
}

function allCacheControls(body: Record<string, unknown>): unknown[] {
  const found: unknown[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if ("cache_control" in rec) found.push(rec["cache_control"]);
      for (const x of Object.values(rec)) walk(x);
    }
  };
  walk(body);
  return found;
}

const dirs: string[] = [];
const servers: Array<{ stop: () => void }> = [];

afterAll(() => {
  resetEndpointMemo();
  for (const s of servers.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function isolatedCfg(raw: Record<string, unknown> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), "neo-95-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      providers: [
        {
          provider_name: "p",
          default_model_name: "m",
          api_key: "k",
          api_type: "anthropic",
          base_url: "http://127.0.0.1:9",
        },
      ],
      ...raw,
    }),
  );
  return loadConfig({ cwd: dir }, { settingsDir: dir });
}

type Hit = { path: string; headers: Record<string, string>; body: Record<string, unknown> | null };

function gateway(opts: {
  proto?: "anthropic" | "openai";
  usage?: Record<string, unknown>;
  openaiUsage?: Record<string, unknown>;
} = {}): { url: string; hits: Hit[] } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : null;
      hits.push({ path: u.pathname, headers, body });
      if (u.pathname.endsWith("/messages")) {
        const usage = opts.usage ?? { input_tokens: 10, output_tokens: 2 };
        if (body?.["stream"]) {
          const ev = [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          ].join("");
          return new Response(ev, { headers: { "Content-Type": "text/event-stream" } });
        }
        return Response.json({
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage,
        });
      }
      if (u.pathname.endsWith("/chat/completions")) {
        const usage = opts.openaiUsage ?? { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
        if (body?.["stream"]) {
          const ev =
            `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n` +
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n` +
            `data: [DONE]\n\n`;
          return new Response(ev, { headers: { "Content-Type": "text/event-stream" } });
        }
        return Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage,
        });
      }
      return new Response("nf", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits };
}

function cfgFor(url: string, proto: "anthropic" | "openai", over: Partial<Config> = {}): Config {
  return {
    providerName: "gw",
    providerType: proto,
    apiKey: "K",
    baseUrl: proto === "anthropic" ? `${url}/v1` : `${url}/v1`,
    model: "m",
    maxTokens: 1024,
    temperature: 0.5,
    providers: [
      {
        name: "gw",
        type: proto,
        apiTypes: [proto],
        baseUrl: `${url}/v1`,
        baseUrls: { anthropic: `${url}/v1`, openai: `${url}/v1` },
        apiKey: "K",
        models: { default: "m", deep_reasoning: "m", balanced: "m", fast: "m" },
        maxTokens: null,
        temperature: null,
        contextWindow: null,
      },
    ],
    retry: { maxAttempts: 1, baseDelayMs: 1, connectTimeoutMs: 5000, streamIdleTimeoutMs: 5000 },
    ...over,
  } as unknown as Config;
}

function lastBlock<T>(arr: T[] | undefined): T | undefined {
  return arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
}

describe("#95 applyCacheControl 三个 ephemeral 断点", () => {
  test("#95 系统提示改成 text block 数组，最后一块打断点", () => {
    const raw = buildAnthropicBody(bodyInput, [
      { role: "system", content: "You are neo." },
      { role: "user", content: "hi" },
    ], tools, false);
    expect(typeof raw["system"]).toBe("string");
    const body = applyCacheControl(raw);
    expect(Array.isArray(body["system"])).toBe(true);
    const sys = body["system"] as Array<Record<string, unknown>>;
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ type: "text", text: "You are neo." });
    expect(cacheControlOf(sys[0])).toEqual({ type: "ephemeral" });
    expect((cacheControlOf(sys[0]) as { ttl?: string }).ttl).toBeUndefined();
  });

  test("#95 工具列表最后一项打断点；空列表不加", () => {
    const withTools = applyCacheControl(
      buildAnthropicBody(bodyInput, [{ role: "user", content: "hi" }], tools, false),
    );
    const ts = withTools["tools"] as Array<Record<string, unknown>>;
    expect(ts).toHaveLength(2);
    expect(cacheControlOf(ts[0])).toBeUndefined();
    expect(cacheControlOf(ts[1])).toEqual({ type: "ephemeral" });
    expect(ts[0]!["name"]).toBe("alpha");
    expect(ts[1]!["name"]).toBe("beta");

    const empty = applyCacheControl(
      buildAnthropicBody(bodyInput, [{ role: "user", content: "hi" }], [], false),
    );
    expect(empty["tools"]).toBeUndefined();
    expect(cachePoints(empty).some((p) => p.startsWith("tools["))).toBe(false);
  });

  test("#95 稳定历史打在最后一条消息的最后一个 content block 上", () => {
    const body = applyCacheControl(
      buildAnthropicBody(
        bodyInput,
        [
          { role: "system", content: "S" },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
        ],
        tools,
        false,
      ),
    );
    const msgs = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(cachePoints(body)).toContain(`messages[${msgs.length - 1}].content[${msgs[msgs.length - 1]!.content.length - 1}]`);
    expect(cacheControlOf(lastBlock(lastBlock(msgs)?.content))).toEqual({ type: "ephemeral" });
    // 更早的历史块不额外打点
    expect(cacheControlOf(msgs[0]!.content[0])).toBeUndefined();
  });

  test("#95 从末尾跳过正文以「[系统消息]」开头的 trailing user 块再打历史断点", () => {
    const body = applyCacheControl(
      buildAnthropicBody(
        bodyInput,
        [
          { role: "system", content: "S" },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "system", content: "召回片段" },
          { role: "system", content: "预算提示" },
        ],
        tools,
        false,
      ),
    );
    const msgs = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const trailing = msgs.filter((m) =>
      m.role === "user" &&
      m.content.some((b) => typeof b["text"] === "string" && String(b["text"]).startsWith(SYSTEM_MSG_PREFIX)),
    );
    expect(trailing.length).toBeGreaterThanOrEqual(1);
    for (const t of trailing) {
      for (const b of t.content) expect(cacheControlOf(b)).toBeUndefined();
    }
    const lastStable = [...msgs].reverse().find((m) =>
      !(m.role === "user" && m.content.some((b) => typeof b["text"] === "string" && String(b["text"]).startsWith(SYSTEM_MSG_PREFIX))),
    );
    expect(lastStable).toBeDefined();
    expect(cacheControlOf(lastBlock(lastStable!.content))).toEqual({ type: "ephemeral" });
  });

  test("#95 第一轮没有可打点历史时只保留系统与工具两处", () => {
    const body = applyCacheControl(
      buildAnthropicBody(bodyInput, [{ role: "system", content: "S" }], tools, false),
    );
    // 只有 leading system、转换后 messages 为空：不应出现历史断点
    expect((body["messages"] as unknown[] | undefined)?.length ?? 0).toBe(0);
    const points = cachePoints(body);
    expect(points.some((p) => p.startsWith("system["))).toBe(true);
    expect(points.some((p) => p.startsWith("tools["))).toBe(true);
    expect(points.some((p) => p.startsWith("messages["))).toBe(false);
  });

  test("#95 临时 system 不会被拼进被缓存的 system 前缀", () => {
    const body = applyCacheControl(
      buildAnthropicBody(
        bodyInput,
        [
          { role: "system", content: "stable system" },
          { role: "user", content: "hi" },
          { role: "system", content: "临时召回不应进 system" },
        ],
        tools,
        false,
      ),
    );
    const sys = body["system"] as Array<Record<string, unknown>>;
    const sysText = sys.map((b) => b["text"]).join("\n");
    expect(sysText).toContain("stable system");
    expect(sysText).not.toContain("临时召回不应进 system");
    const msgs = body["messages"] as Array<{ content: Array<Record<string, unknown>> }>;
    const joined = msgs.flatMap((m) => m.content.map((b) => String(b["text"] ?? ""))).join("\n");
    expect(joined).toContain(`${SYSTEM_MSG_PREFIX}\n临时召回不应进 system`);
  });

  test("#95 applyCacheControl 不改写入参、断点均为默认 TTL 的 ephemeral", () => {
    const raw = buildAnthropicBody(bodyInput, [
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
    ], tools, false);
    const before = JSON.stringify(raw);
    const body = applyCacheControl(raw);
    expect(JSON.stringify(raw)).toBe(before);
    const ccs = allCacheControls(body);
    expect(ccs.length).toBeGreaterThanOrEqual(3);
    for (const cc of ccs) {
      expect(cc).toEqual({ type: "ephemeral" });
    }
  });
});

describe("#95 bodyFor 接线与协议隔离", () => {
  test("#95 Anthropic 默认开启：连续两轮第二轮仍含系统与工具断点，历史断点在临时块之前", async () => {
    const g = gateway();
    const cfg = cfgFor(g.url, "anthropic");
    const history: Message[] = [
      { role: "system", content: "S" },
      { role: "user", content: "q1" },
    ];
    await chatStream(cfg, history, tools);
    history.push({ role: "assistant", content: "a1" }, { role: "user", content: "q2" }, { role: "system", content: "召回" });
    await chatStream(cfg, history, tools);
    expect(g.hits).toHaveLength(2);
    const second = g.hits[1]!.body!;
    const points = cachePoints(second);
    expect(points.some((p) => p.startsWith("system["))).toBe(true);
    expect(points).toContain("tools[1]");
    const msgs = second["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const lastTemp = msgs.findLast((m) =>
      m.role === "user" && m.content.some((b) => typeof b["text"] === "string" && String(b["text"]).startsWith(SYSTEM_MSG_PREFIX)),
    );
    expect(lastTemp).toBeDefined();
    for (const b of lastTemp!.content) expect(cacheControlOf(b)).toBeUndefined();
    expect(points.some((p) => p.startsWith("messages["))).toBe(true);
    expect(g.hits[1]!.headers["anthropic-beta"]).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain("prompt-caching-");
  });

  test("#95 prompt_cache: false 时 body 无 cache_control，行为与今日相同", async () => {
    const g = gateway();
    const cfg = cfgFor(g.url, "anthropic", { promptCache: false });
    await chat(cfg, [
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
    ], tools);
    const body = g.hits[0]!.body!;
    expect(allCacheControls(body)).toEqual([]);
    expect(body["system"]).toBe("S");
    expect(cacheControlOf((body["tools"] as unknown[])?.[1])).toBeUndefined();
  });

  test("#95 OpenAI 协议路径不发 cache_control、不加仅用于缓存的 header", async () => {
    const g = gateway({ proto: "openai" });
    const cfg = cfgFor(g.url, "openai");
    await chatStream(cfg, [
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
    ], tools);
    const hit = g.hits[0]!;
    expect(allCacheControls(hit.body ?? {})).toEqual([]);
    expect(JSON.stringify(hit.body)).not.toContain("cache_control");
    expect(hit.headers["anthropic-beta"]).toBeUndefined();
    expect(hit.headers["x-api-key"]).toBeUndefined();
  });

  test("#95 同一可见集内工具 schema 名称顺序稳定（Anthropic 与 OpenAI）", async () => {
    const order = ["zeta", "alpha", "mcp__s__t", "beta"];
    const specs: ToolSpec[] = order.map((name) => ({
      type: "function",
      function: { name, description: name, parameters: { type: "object", properties: {} } },
    }));
    const ga = gateway();
    const go = gateway({ proto: "openai" });
    const ca = cfgFor(ga.url, "anthropic");
    const co = cfgFor(go.url, "openai");
    const msgs: Message[] = [{ role: "system", content: "S" }, { role: "user", content: "hi" }];
    await chat(ca, msgs, specs);
    await chat(ca, msgs, specs);
    await chat(co, msgs, specs);
    await chat(co, msgs, specs);
    const anthNames = ga.hits.map((h) => (h.body!["tools"] as Array<{ name: string }>).map((t) => t.name));
    const oaiNames = go.hits.map((h) =>
      (h.body!["tools"] as Array<{ function: { name: string } }>).map((t) => t.function.name),
    );
    expect(anthNames[0]).toEqual(order);
    expect(anthNames[1]).toEqual(order);
    expect(oaiNames[0]).toEqual(order);
    expect(oaiNames[1]).toEqual(order);
  });
});

describe("#95 用量包装与命中率口径", () => {
  test("#95 宿主包装 mapUsage：保留 prompt_tokens 合计并透出 cache 读写", () => {
    const u = mapUsage({
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
      output_tokens: 7,
      output_tokens_details: { thinking_tokens: 3 },
    });
    expect(u.prompt_tokens).toBe(115);
    expect(u.completion_tokens).toBe(7);
    expect(u.total_tokens).toBe(122);
    expect(u.cache_creation_input_tokens).toBe(5);
    expect(u.cache_read_input_tokens).toBe(100);
  });

  test("#95 mapUsage 未收到 cache 字段时不补 0", () => {
    const u = mapUsage({ input_tokens: 10, output_tokens: 2 });
    expect(u.prompt_tokens).toBe(10);
    expect(u.cache_creation_input_tokens).toBeUndefined();
    expect(u.cache_read_input_tokens).toBeUndefined();
  });

  test("#95 parseAnthropicMessage 与流式累积都透出 cache 字段（含值为 0）", () => {
    const parsed = parseAnthropicMessage({
      content: [{ type: "text", text: "答" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    expect(parsed.usage).toMatchObject({
      prompt_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    const acc = new AnthropicStreamAccumulator({});
    acc.feed({
      type: "message_start",
      message: { usage: { input_tokens: 0, output_tokens: 0 } },
    });
    acc.feed({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 20, output_tokens: 3, cache_creation_input_tokens: 8, cache_read_input_tokens: 12 },
    });
    acc.feed({ type: "message_stop" });
    expect(acc.result().usage).toMatchObject({
      prompt_tokens: 40,
      cache_creation_input_tokens: 8,
      cache_read_input_tokens: 12,
    });
  });

  test("#95 OpenAI 已有 prompt_tokens_details.cached_tokens 才展示；没有不编造", () => {
    const withCache = enrichOpenAICacheUsage({
      prompt_tokens: 80,
      completion_tokens: 5,
      total_tokens: 85,
      prompt_tokens_details: { cached_tokens: 20 },
    } as Usage);
    expect(withCache.cache_read_input_tokens).toBe(20);
    expect(withCache.prompt_tokens).toBe(80);

    const none = enrichOpenAICacheUsage({ prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 });
    expect(none.cache_read_input_tokens).toBeUndefined();
    expect(none.cache_creation_input_tokens).toBeUndefined();
  });

  test("#95 命中率 = cache_read / prompt_tokens，一位小数；分母 0 为「无」", () => {
    expect(formatCacheHit(100, 115)).toBe("87.0%");
    expect(formatCacheHit(12, 100)).toBe("12.0%");
    expect(formatCacheHit(1, 8)).toBe("12.5%");
    expect(formatCacheHit(0, 100)).toBe("0.0%");
    expect(formatCacheHit(0, 0)).toBe("无");
    expect(formatCacheTokens(5, true)).toBe("5 tokens");
    expect(formatCacheTokens(0, true)).toBe("0 tokens");
    expect(formatCacheTokens(0, false)).toBe("无");
    expect(formatCacheTokens(undefined, false)).toBe("无");
  });

  test("#95 会话累计与本轮字段分开记账", async () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-95-agent-"));
    dirs.push(dir);
    const cfg = isolatedCfg();
    cfg.memory = { ...cfg.memory, enabled: false };
    const agent = new Agent({
      cfg,
      console: captureConsole({ stdoutIsTTY: false }).ui,
      mode: "auto-all",
      systemPrompt: "S",
    });
    const u1: Usage = {
      prompt_tokens: 115,
      completion_tokens: 7,
      total_tokens: 122,
      completion_tokens_details: { reasoning_tokens: 3 },
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 100,
    };
    const u2: Usage = {
      prompt_tokens: 200,
      completion_tokens: 10,
      total_tokens: 210,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 180,
    };
    agent.recordUsage(u1);
    agent.recordUsage(u2);
    expect(agent.cumulative.prompt).toBe(315);
    expect(agent.cumulative.completion).toBe(17);
    expect(agent.cumulative.reasoning).toBe(3);
    expect(agent.cumulative.cacheCreation).toBe(5);
    expect(agent.cumulative.cacheRead).toBe(280);
    expect(agent.cumulative.cacheFieldsSeen).toBe(true);
    const buckets: UsageBucket[] = agent.usageByModel();
    expect(buckets[0]).toMatchObject({
      prompt: 315,
      completion: 17,
      reasoning: 3,
      cacheCreation: 5,
      cacheRead: 280,
    });
  });
});

describe("#95 settings.prompt_cache 默认 true", () => {
  test("#95 缺省为 true；显式 false 可关", () => {
    expect(isolatedCfg().promptCache).toBe(true);
    expect(isolatedCfg({ prompt_cache: true }).promptCache).toBe(true);
    expect(isolatedCfg({ prompt_cache: false }).promptCache).toBe(false);
  });
});

describe("#95 /cost 与 /context 展示", () => {
  function stubAgent(over: {
    cum?: Partial<Agent["cumulative"]>;
    last?: Partial<TurnStats> | null;
    promptCache?: boolean;
  } = {}): { cfg: Config; ctx: CommandContext; out: () => string } {
    const cap = captureConsole({ stdoutIsTTY: false });
    const cfg = isolatedCfg();
    if (over.promptCache === false) cfg.promptCache = false;
    const cum = {
      prompt: 0,
      completion: 0,
      reasoning: 0,
      cacheCreation: 0,
      cacheRead: 0,
      cacheFieldsSeen: false,
      ...over.cum,
    };
    const last = over.last === null
      ? null
      : over.last
        ? {
            durationMs: 1,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            toolCalls: 0,
            iterations: 1,
            finishReason: "stop",
            aborted: false,
            hadError: false,
            errorMessage: null,
            emptyResponse: false,
            contextUsage: 0.1,
            tierSwitch: null,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cacheFieldsSeen: false,
            ...over.last,
          }
        : null;
    const agent = {
      cumulative: cum,
      contextUsage: () => 0.25,
      messages: [{ role: "system" }, { role: "user" }],
      usageByModel: () => [] as UsageBucket[],
      lastStats: last,
      stats: last,
      lastCompactionInfo: null,
      toolSpecsFor: () => [],
      activeNestedAgents: [],
    };
    const ctx = {
      agent,
      ui: cap.ui,
      cfg,
      meta: {},
    } as unknown as CommandContext;
    return { cfg, ctx, out: cap.out };
  }

  test("#95 /cost 三行插在 thinking 与 context 之间；键名与数字口径", async () => {
    const h = stubAgent({
      cum: { prompt: 115, completion: 7, reasoning: 3, cacheCreation: 5, cacheRead: 100, cacheFieldsSeen: true },
    });
    await handleSessionCommands("cost", "", [], h.ctx);
    const text = stripAnsi(h.out());
    const thinking = text.indexOf("thinking");
    const write = text.indexOf("cache write");
    const read = text.indexOf("cache read");
    const hit = text.indexOf("cache hit");
    const context = text.indexOf("context");
    expect(thinking).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(thinking);
    expect(read).toBeGreaterThan(write);
    expect(hit).toBeGreaterThan(read);
    expect(context).toBeGreaterThan(hit);
    expect(text).toContain("5 tokens");
    expect(text).toContain("100 tokens");
    expect(text).toContain("87.0%");
    expect(text).not.toMatch(/5,|100,/);
    expect(text).not.toContain("提示词缓存已关闭");
  });

  test("#95 从未收到 cache 字段时三行都是「无」，不是 0 tokens / 0.0%", async () => {
    const h = stubAgent({
      cum: { prompt: 20, completion: 2, reasoning: 1, cacheFieldsSeen: false },
    });
    await handleSessionCommands("cost", "", [], h.ctx);
    const text = stripAnsi(h.out());
    const cacheSection = text.slice(text.indexOf("cache write"), text.indexOf("context"));
    expect(cacheSection).toMatch(/cache write\s+无/);
    expect(cacheSection).toMatch(/cache read\s+无/);
    expect(cacheSection).toMatch(/cache hit\s+无/);
    expect(cacheSection).not.toContain("0 tokens");
    expect(cacheSection).not.toContain("0.0%");
  });

  test("#95 后端回过且值为 0 时可以显示 0 tokens / 0.0%", async () => {
    const h = stubAgent({
      cum: { prompt: 10, completion: 1, reasoning: 0, cacheCreation: 0, cacheRead: 0, cacheFieldsSeen: true },
    });
    await handleSessionCommands("cost", "", [], h.ctx);
    const text = stripAnsi(h.out());
    expect(text).toMatch(/cache write\s+0 tokens/);
    expect(text).toMatch(/cache read\s+0 tokens/);
    expect(text).toMatch(/cache hit\s+0\.0%/);
  });

  test("#95 分母 prompt_tokens 为 0 时命中率写「无」", async () => {
    const h = stubAgent({
      cum: { prompt: 0, completion: 0, reasoning: 0, cacheCreation: 0, cacheRead: 0, cacheFieldsSeen: true },
    });
    await handleSessionCommands("cost", "", [], h.ctx);
    const text = stripAnsi(h.out());
    expect(text).toMatch(/cache write\s+0 tokens/);
    expect(text).toMatch(/cache hit\s+无/);
    expect(text).not.toContain("0.0%");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
  });

  test("#95 prompt_cache: false 时加暗色「提示词缓存已关闭」；未收到字段仍为「无」", async () => {
    const h = stubAgent({
      promptCache: false,
      cum: { prompt: 20, completion: 2, cacheFieldsSeen: false },
    });
    await handleSessionCommands("cost", "", [], h.ctx);
    const raw = h.out();
    const text = stripAnsi(raw);
    const hit = text.indexOf("cache hit");
    const closed = text.indexOf("提示词缓存已关闭");
    const context = text.indexOf("context");
    expect(closed).toBeGreaterThan(hit);
    expect(context).toBeGreaterThan(closed);
    expect(text).toMatch(/cache write\s+无/);
    expect(text).toMatch(/cache hit\s+无/);
    expect(text).not.toContain("0.0%");
    expect(raw).toContain("提示词缓存已关闭");
  });

  test("#95 /context 只多一行 cache hit（上次请求），不加 write/read", async () => {
    const h = stubAgent({
      last: { promptTokens: 115, cacheReadTokens: 100, cacheCreationTokens: 5, cacheFieldsSeen: true },
    });
    await handleSessionCommands("context", "", [], h.ctx);
    const text = stripAnsi(h.out());
    expect(text).toContain("cache hit");
    expect(text).toContain("87.0%");
    expect(text).toContain("（上次请求）");
    expect(text).not.toContain("cache write");
    expect(text).not.toContain("cache read");
  });

  test("#95 /context 无上一轮缓存数据或分母为 0 时写「无」，不加（上次请求）", async () => {
    const none = stubAgent({ last: null });
    await handleSessionCommands("context", "", [], none.ctx);
    const t1 = stripAnsi(none.out());
    expect(t1).toMatch(/cache hit\s+无/);
    expect(t1).not.toContain("（上次请求）");
    expect(t1).not.toContain("0.0%");

    const zero = stubAgent({
      last: { promptTokens: 0, cacheReadTokens: 0, cacheFieldsSeen: true },
    });
    await handleSessionCommands("context", "", [], zero.ctx);
    const t2 = stripAnsi(zero.out());
    expect(t2).toMatch(/cache hit\s+无/);
    expect(t2).not.toContain("（上次请求）");
  });

  test("#95 /context 在 prompt_cache: false 时同样加暗色关闭说明", async () => {
    const h = stubAgent({
      promptCache: false,
      last: { promptTokens: 100, cacheFieldsSeen: false },
    });
    await handleSessionCommands("context", "", [], h.ctx);
    const text = stripAnsi(h.out());
    expect(text).toMatch(/cache hit\s+无/);
    expect(text).toContain("提示词缓存已关闭");
    expect(text).not.toContain("0.0%");
  });

  test("#95 /cost 按模型分桶仍只列 prompt / completion / thinking", async () => {
    const cap = captureConsole({ stdoutIsTTY: false });
    const cfg = isolatedCfg();
    const agent = {
      cumulative: { prompt: 10, completion: 2, reasoning: 1, cacheCreation: 3, cacheRead: 4, cacheFieldsSeen: true },
      contextUsage: () => 0.1,
      messages: [],
      usageByModel: () => [
        { provider: "p1", model: "m1", prompt: 6, completion: 1, reasoning: 1, cacheCreation: 2, cacheRead: 3 },
        { provider: "p2", model: "m2", prompt: 4, completion: 1, reasoning: 0, cacheCreation: 1, cacheRead: 1 },
      ],
      lastStats: null,
      stats: null,
      lastCompactionInfo: null,
      toolSpecsFor: () => [],
      activeNestedAgents: [],
    };
    await handleSessionCommands("cost", "", [], { agent, ui: cap.ui, cfg, meta: {} } as unknown as CommandContext);
    const text = stripAnsi(cap.out());
    expect(text).toContain("按实际响应模型分桶");
    expect(text).toContain("6 prompt / 1 completion / 1 thinking");
    expect(text).not.toMatch(/p1\/m1:.*cache/);
  });

  test("#95 help 与 statusline 口径：仍写明没有 prompt_cache", () => {
    expect(helpText()).toContain("没有费用、rate_limits、prompt_cache");
  });
});
