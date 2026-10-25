/**
 * P0-1：LLM 流式请求的重试与超时。
 *
 * 全部用 Bun.serve 起的本地假端点，不依赖外网、不产生真实 token 消耗。
 * 覆盖：5xx 重试、4xx 不重试、429 Retry-After、连接超时、空闲超时、
 * 中途断流不重试、用户 abort（含退避期间 abort）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chatStream, LLMError, LLMTimeoutError } from "../src/llm.ts";
import type { Config } from "../src/config.ts";
import type { RetryConfig } from "../src/config.ts";

const enc = new TextEncoder();

const EVENT_CONTENT = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n';
const EVENT_STOP = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
const EVENT_ROLE = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
const EVENT_DONE = "data: [DONE]\n\n";

function sseOk(): Response {
  const body = EVENT_CONTENT + EVENT_STOP + EVENT_DONE;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** 一个正常返回、但会在 chunk 之间等待/挂起的 SSE 流。 */
function sseStalling(prefix = EVENT_ROLE): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(prefix));
      // 故意不 close、不再 enqueue：模拟服务端卡死。
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

/** 已输出一段内容后连接被提前结束（没有 [DONE]/finish_reason）：模拟中途断流。 */
function sseThenReset(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(EVENT_CONTENT));
      // 给客户端先消费掉 content chunk 的时间，然后直接 EOF（部分网关的真实行为）。
      setTimeout(() => controller.close(), 20);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const servers: Array<{ stop: (force?: boolean) => void }> = [];

function serve(fetchImpl: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: fetchImpl });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

afterAll(() => {
  for (const s of servers) s.stop(true);
});

function makeCfg(baseUrl: string, retry: Partial<RetryConfig> = {}): Config {
  return {
    baseUrl,
    apiKey: "test-key",
    model: "test-model",
    maxTokens: 32,
    temperature: 0,
    retry: { maxAttempts: 3, baseDelayMs: 1, connectTimeoutMs: 1000, streamIdleTimeoutMs: 1000, ...retry },
  } as unknown as Config;
}

function messages() {
  return [{ role: "user" as const, content: "hi" }];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("chatStream 重试（P0-1）", () => {
  test("5xx 连续失败后成功：按 maxAttempts 重试", async () => {
    let hits = 0;
    const url = serve(() => {
      hits += 1;
      return hits < 3 ? new Response("boom", { status: 500 }) : sseOk();
    });
    const r = await chatStream(makeCfg(url), messages(), []);
    expect(r.content).toBe("hi");
    expect(hits).toBe(3);
  });

  test("4xx 不重试，直接失败", async () => {
    let hits = 0;
    const url = serve(() => {
      hits += 1;
      return new Response("bad request", { status: 400 });
    });
    await expect(chatStream(makeCfg(url), messages(), [])).rejects.toThrow("bad request");
    expect(hits).toBe(1);
  });

  test("429 遵守 Retry-After 后成功", async () => {
    let hits = 0;
    const url = serve(() => {
      hits += 1;
      if (hits === 1) {
        return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      }
      return sseOk();
    });
    const r = await chatStream(makeCfg(url), messages(), []);
    expect(r.content).toBe("hi");
    expect(hits).toBe(2);
  });

  test("重试耗尽时报错包含尝试次数", async () => {
    let hits = 0;
    const url = serve(() => {
      hits += 1;
      return new Response("boom", { status: 503 });
    });
    await expect(
      chatStream(makeCfg(url, { maxAttempts: 2 }), messages(), []),
    ).rejects.toThrow("已尝试 2 次");
    expect(hits).toBe(2);
  });

  test("连接超时：有界失败且按次数重试", async () => {
    let hits = 0;
    const url = serve(async () => {
      hits += 1;
      await sleep(200);
      return sseOk();
    });
    const started = Date.now();
    const err = await chatStream(
      makeCfg(url, { maxAttempts: 2, connectTimeoutMs: 40 }),
      messages(),
      [],
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect((err as LLMTimeoutError).kind).toBe("connect");
    expect(hits).toBe(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("用户 abort 不重试", async () => {
    let hits = 0;
    const url = serve(async () => {
      hits += 1;
      await sleep(300);
      return sseOk();
    });
    const ctrl = new AbortController();
    const p = chatStream(makeCfg(url, { maxAttempts: 3 }), messages(), [], {}, ctrl.signal);
    setTimeout(() => ctrl.abort(), 20);
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(hits).toBe(1);
  });

  test("退避等待期间 abort 立即停止", async () => {
    let hits = 0;
    const url = serve(() => {
      hits += 1;
      return new Response("boom", { status: 500 });
    });
    const ctrl = new AbortController();
    const p = chatStream(
      makeCfg(url, { maxAttempts: 3, baseDelayMs: 500 }),
      messages(),
      [],
      {},
      ctrl.signal,
    );
    setTimeout(() => ctrl.abort(), 30);
    const started = Date.now();
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(hits).toBe(1);
    expect(Date.now() - started).toBeLessThan(300);
  });

  test("已输出后中途断流：不重试，错误说明已输出", async () => {
    let hits = 0;
    const url = serve(() => {
      hits += 1;
      return sseThenReset();
    });
    let seen = "";
    const err = await chatStream(makeCfg(url, { maxAttempts: 3 }), messages(), [], {
      onContent: (d) => {
        seen += d;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).message).toContain("不再重试");
    expect((err as LLMError).message).toContain("已输出");
    expect(seen).toBe("hi");
    expect(hits).toBe(1);
  });

  test("空闲超时（尚未输出）：可重试，最终超时失败", async () => {
    let hits = 0;
    const url = serve(() => {
      hits += 1;
      return sseStalling();
    });
    const err = await chatStream(
      makeCfg(url, { maxAttempts: 2, streamIdleTimeoutMs: 40 }),
      messages(),
      [],
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMTimeoutError);
    expect((err as LLMTimeoutError).kind).toBe("idle");
    expect(hits).toBe(2);
  });
});
