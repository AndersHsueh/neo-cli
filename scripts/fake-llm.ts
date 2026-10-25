#!/usr/bin/env bun
/**
 * scripts/fake-llm.ts — 脚本化 OpenAI 兼容端点（SSE）。
 *
 * 用途：让 PTY 端到端测试在没有真实 LLM / 外网的环境下跑完整交互链路。
 * 关键设计：**完全无状态** —— 每一轮该回什么，只由本次请求的 messages 内容
 * （是否已有 tool 消息、已有几条）决定。同一个进程可反复跑任意场景，
 * 多次运行结果一致，不会因为上一个用例留下的状态而漂移。
 *
 * 用法：
 *   bun run scripts/fake-llm.ts                        # 默认 18123 端口、tool-then-answer
 *   PORT=0 SCENARIO=narration bun run scripts/fake-llm.ts
 *     ↑ PORT=0 让内核分配空闲端口，启动后 stdout 打印 `FAKE_LLM_READY port=<n>`
 *       （PTY 测试用这种方式彻底规避端口冲突）
 *
 * 环境变量：
 *   PORT      监听端口，默认 18123；0 = 自动分配
 *   SCENARIO  tool-then-answer（默认）| narration | resume
 *   HOST      监听地址，默认 127.0.0.1
 *
 * 路由：
 *   GET  /health                 → ok
 *   GET  /v1/models              → {"object":"list","data":[{"id":"fake-model"}]}
 *   POST /v1/chat/completions    → SSE（每轮按 messages 决定帧）
 *   （不带 /v1 前缀的同名路由也支持，便于 NEO_BASE_URL 不带 /v1 时复用）
 *
 * 所有请求体仅在内存中读取、不落盘；不记录日志（避免把测试数据写进仓库）。
 */

type Scenario = "tool-then-answer" | "narration" | "resume";

const SCENARIOS: readonly Scenario[] = ["tool-then-answer", "narration", "resume"];

function pickScenario(raw: string | undefined): Scenario {
  const s = (raw ?? "").trim();
  if ((SCENARIOS as readonly string[]).includes(s)) return s as Scenario;
  if (s) {
    console.error(`[fake-llm] 未知 SCENARIO="${s}"，可选：${SCENARIOS.join(" | ")}；回落到 tool-then-answer`);
  }
  return "tool-then-answer";
}

const SCENARIO: Scenario = pickScenario(process.env["SCENARIO"]);
const PORT = normalizePort(process.env["PORT"]);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const MODEL = "fake-model";

function normalizePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 18123;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`[fake-llm] 非法 PORT="${raw}"，回落 18123`);
    return 18123;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 帧构造                                                              */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

/** 一个 chat.completion.chunk 帧。delta 为空对象表示本帧只携带 finish_reason。 */
function frame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  const payload = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 正文拆成两帧下发，确保客户端真的走增量拼接而不是「一次到手」。 */
function contentFrames(text: string): string[] {
  const half = Math.max(1, Math.floor(text.length / 2));
  return [frame({ content: text.slice(0, half) }), frame({ content: text.slice(half) })];
}

/** 工具调用：name 与 arguments 分开两帧，覆盖增量拼接路径（index/id/type）。 */
function toolCallFrames(): string[] {
  return [
    frame({
      tool_calls: [
        {
          index: 0,
          id: "call_fake_0",
          type: "function",
          function: { name: "read_file", arguments: "" },
        },
      ],
    }),
    frame({
      tool_calls: [
        {
          index: 0,
          function: { arguments: '{"path":' },
        },
      ],
    }),
    frame({
      tool_calls: [
        {
          index: 0,
          function: { arguments: '"a.txt"}' },
        },
      ],
    }),
  ];
}

function finishFrames(reason: "stop" | "tool_calls"): string[] {
  return [frame({}, reason), "data: [DONE]\n\n"];
}

/* ------------------------------------------------------------------ */
/* 场景：按 messages 内容决定这一轮                                   */
/* ------------------------------------------------------------------ */

interface WireMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
}

/** 已有的 tool 消息条数 —— 场景分支的唯一依据（无状态的关键）。 */
function countToolMessages(messages: WireMessage[]): number {
  return messages.reduce((n, m) => (m.role === "tool" ? n + 1 : n), 0);
}

function framesFor(scenario: Scenario, messages: WireMessage[]): string[] {
  const toolRounds = countToolMessages(messages);
  switch (scenario) {
    case "resume":
      // 恢复回放场景：不调工具，两次请求都是同一个最终答案。
      return [...contentFrames("会话恢复测试答案。"), ...finishFrames("stop")];

    case "narration": {
      // 连续两轮「正文 + 工具」，用于验证每一段正文都有 ● 前缀（v0.2.3 D1）。
      if (toolRounds === 0) {
        return [...contentFrames("先看看这个文件。"), ...toolCallFrames(), ...finishFrames("tool_calls")];
      }
      if (toolRounds === 1) {
        return [...contentFrames("第二次说明。"), ...toolCallFrames(), ...finishFrames("tool_calls")];
      }
      return [...contentFrames("都读完了。"), ...finishFrames("stop")];
    }

    case "tool-then-answer":
    default: {
      if (toolRounds === 0) {
        // 第 1 轮：先说一句、再调 read_file a.txt
        return [...contentFrames("先看看这个文件。"), ...toolCallFrames(), ...finishFrames("tool_calls")];
      }
      // 第 2 轮：已经拿到工具结果（无论成功/失败），直接给最终答案。
      return [...contentFrames("读完了：内容是 hello。"), ...finishFrames("stop")];
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // 每帧之间让出事件循环：既模拟真实流式，也让 PTY 侧能观察到中间态。
        for (const f of frames) {
          controller.enqueue(encoder.encode(f));
          await Bun.sleep(2);
        }
      } catch {
        // 客户端提前断开（例如测试里 /exit）：静默收尾，不打印噪音
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function json(data: unknown): Response {
  return Response.json(data, { headers: { "Cache-Control": "no-cache" } });
}

const server = (() => {
  try {
    return Bun.serve({
  hostname: HOST,
  port: PORT,
  // 测试端点只服务本机，不需要 keep-alive 保活策略
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    // 同时接受带 /v1 与不带 /v1 的路径：NEO_BASE_URL 是否含 /v1 由调用方决定。
    const path = url.pathname.replace(/^\/v1(?=\/)/, "");

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return new Response("ok", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (req.method === "GET" && path === "/models") {
      return json({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "fake" }] });
    }

    if (req.method === "POST" && path === "/chat/completions") {
      let messages: WireMessage[] = [];
      try {
        const body = (await req.json()) as { messages?: WireMessage[] };
        if (Array.isArray(body.messages)) messages = body.messages;
      } catch {
        // 请求体不是合法 JSON 也照常回一个 stop 帧，避免测试被语法错误卡死
      }
      return sseResponse(framesFor(SCENARIO, messages));
    }

    return new Response(`not found: ${req.method} ${url.pathname}`, { status: 404 });
  },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[fake-llm] 无法监听 ${HOST}:${PORT} —— ${msg}\n` +
        `  端口被占用时请换 PORT，或用 PORT=0 让内核分配临时端口。`,
    );
    process.exit(1);
  }
})();

// 供 pty-e2e.ts 读取实际端口（PORT=0 时是内核分配的临时端口）。
// 一行、稳定前缀，便于父进程按行解析。
console.log(`FAKE_LLM_READY port=${server.port} scenario=${SCENARIO}`);

const shutdown = (): void => {
  try {
    server.stop(true);
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
