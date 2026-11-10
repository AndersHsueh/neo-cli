/**
 * mcp-sse.test.ts — MCP 旧式 SSE 传输（issue #44，来源 #29 非目标）。
 *
 * 覆盖 issue #44 的四条验收：
 *  1. `event: endpoint` 握手：GET 长连接首事件给出 POST 目标（相对路径按 GET URL 解析）；
 *  2. 请求走 POST 到 endpoint 收 202，**结果从 GET 流回来**（与 streamable HTTP 的
 *     「POST 响应体内 SSE」是两种不同形态，这里专测前者）；
 *  3. 断流时在途请求**立即** reject，而不是干等到 requestTimeoutMs；
 *  4. `transport: "sse"` 在 config 解析里不再被 warning 跳过，`/mcp` 显示 `[sse]`。
 *
 * 全部用本地假 SSE server，不触外网。bun test 单进程共享模块表：
 * 每个用例结束必须 closeAll() 注销 mcp__* 工具。
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { Config, McpSseServerConfig } from "../src/config.ts";
import { parseMcpServers } from "../src/config.ts";
import { McpManager } from "../src/mcp/client.ts";
import { SseRpc } from "../src/mcp/sseRpc.ts";
import { dispatch, toolNames } from "../src/tools/index.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import { dispatchCommand, wireCommands } from "../src/cli/commands.ts";
import type { CommandContext } from "../src/cli/commands.ts";
import { captureConsole } from "./helpers.ts";

const managers: McpManager[] = [];
function track(m: McpManager): McpManager {
  managers.push(m);
  return m;
}

afterEach(() => {
  for (const m of managers.splice(0)) m.closeAll();
});

function makeCtx(approve = true): ToolCtx {
  return {
    cfg: { cwd: "/tmp", toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => approve,
  };
}

interface Recorded {
  method: string;
  path: string;
}

/**
 * 假旧式 SSE MCP server。
 *
 * 协议形态（MCP 2024-11-05 HTTP+SSE）：
 *  - `GET /sse` 建长连接，首事件 `event: endpoint` + `data: <POST 目标>`；
 *  - 客户端把 JSON-RPC 消息 POST 到该目标，服务端回 202，结果写回 GET 流。
 *
 * `endpointPath` 控制握手给的是绝对路径还是相对路径（相对路径必须按 GET URL 解析）。
 * `dropAfter` = 收到第 N 个 POST 后主动关闭 GET 流（测断流 failAll）。
 */
function startFakeSse(opts: {
  endpointPath?: string;
  dropAfter?: number;
} = {}): { port: number; seen: Recorded[]; stop: () => void } {
  const seen: Recorded[] = [];
  // endpointPath 是**握手事件里给出的原样字符串**（可能是相对路径 "msg"），
  // 但服务端路由匹配的是解析后的 pathname —— 这里按 GET URL 解析出实际路径。
  const endpointRaw = opts.endpointPath ?? "/message";
  const endpointPath = new URL(endpointRaw, "http://x/sse").pathname;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let postCount = 0;
  const enc = new TextEncoder();

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/sse" && req.method === "GET") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            // 首事件：endpoint 握手。
            c.enqueue(enc.encode(`event: endpoint\ndata: ${endpointRaw}\n\n`));
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }

      if (url.pathname === endpointPath && req.method === "POST") {        const body = (await req.json()) as { id?: number; method?: string; params?: unknown };
        seen.push({ method: body.method ?? "", path: url.pathname });
        postCount += 1;
        // 结果从 GET 流回来（不是 POST 响应体）。
        const reply = (payload: unknown) => {
          controller?.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(payload)}\n\n`));
        };
        if (body.method === "initialize") {
          reply({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2024-11-05", serverInfo: { name: "sse-fake", version: "1" } },
          });
        } else if (body.method === "tools/list") {
          reply({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: [
                {
                  name: "echo",
                  description: "回声",
                  inputSchema: { type: "object", properties: { text: { type: "string" } } },
                },
              ],
            },
          });
        } else if (body.method === "tools/call") {
          const args = (body.params as { arguments?: { text?: string } } | undefined)?.arguments;
          reply({
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: `ECHO:${args?.text ?? ""}` }] },
          });
        }
        if (opts.dropAfter !== undefined && postCount >= opts.dropAfter) {
          // 断流：服务端主动关闭 GET 长连接。
          try {
            controller?.close();
          } catch {
            /* 已关闭 */
          }
          controller = null;
        }
        // 旧式 SSE 的 POST 一律 202，body 为空。
        return new Response(null, { status: 202 });
      }

      return new Response("not found", { status: 404 });
    },
  });
  return { port: Number(server.port), seen, stop: () => server.stop(true) };
}

function sseServer(port: number, over: Partial<McpSseServerConfig> = {}): McpSseServerConfig {
  return {
    name: "legacy",
    transport: "sse",
    url: `http://127.0.0.1:${port}/sse`,
    headers: {},
    enabled: true,
    ...over,
  };
}

describe("issue #44 旧式 SSE 传输", () => {
  test("S1 endpoint 握手 + 结果从 GET 流回来 + 经 dispatch 调用", async () => {
    const fake = startFakeSse();
    try {
      const m = track(new McpManager([sseServer(fake.port)], { connectTimeoutMs: 5_000 }));
      expect(await m.connectAll()).toBe(1);

      const st = m.statuses()[0]!;
      expect(st.status).toBe("connected");
      expect(st.transport).toBe("sse");
      expect(st.serverInfo?.name).toBe("sse-fake");
      expect(toolNames()).toContain("mcp__legacy__echo");

      const r = await dispatch("mcp__legacy__echo", JSON.stringify({ text: "你好" }), makeCtx());
      expect(r.ok).toBe(true);
      expect(r.output).toContain("ECHO:你好");

      // 所有 JSON-RPC 都 POST 到握手给的 endpoint，而不是 GET 的 /sse。
      expect(fake.seen.every((x) => x.path === "/message")).toBe(true);
      expect(fake.seen.map((x) => x.method)).toContain("initialize");
      expect(fake.seen.map((x) => x.method)).toContain("tools/list");
    } finally {
      fake.stop();
    }
  });

  test("S2 endpoint 是相对路径 → 按 GET URL 解析（不是拼到根）", async () => {
    // GET 是 /sse，endpoint 给相对路径 "msg" → 应解析成 /msg（与 /sse 同级），不是 /msg 之外的怪路径。
    const fake = startFakeSse({ endpointPath: "msg" });
    try {
      const rpc = new SseRpc({ url: `http://127.0.0.1:${fake.port}/sse`, requestTimeoutMs: 3_000 });
      await rpc.start();
      const init = await rpc.request<{ serverInfo?: { name?: string } }>("initialize", {});
      expect(init.serverInfo?.name).toBe("sse-fake");
      expect(fake.seen.every((x) => x.path === "/msg")).toBe(true);
      rpc.close();
    } finally {
      fake.stop();
    }
  });

  test("S3 断流 → 在途请求立即 reject，不等超时", async () => {
    // 收到 initialize 后立刻关流：此时 tools/list 还没发，握手应快速失败。
    const fake = startFakeSse({ dropAfter: 1 });
    try {
      const rpc = new SseRpc({
        url: `http://127.0.0.1:${fake.port}/sse`,
        // 超时给得很大：若断流没触发 failAll，这条用例会等 30s 才失败。
        requestTimeoutMs: 30_000,
      });
      await rpc.start();
      await rpc.request("initialize", {});
      const started = Date.now();
      await expect(rpc.request("tools/list", {})).rejects.toThrow(/断开|关闭|结束/);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(rpc.alive).toBe(false);
      rpc.close();
    } finally {
      fake.stop();
    }
  });

  test("S4 断流后 manager 侧调用给可读错误（不挂死）", async () => {
    const fake = startFakeSse({ dropAfter: 2 });
    try {
      const m = track(new McpManager([sseServer(fake.port)], { connectTimeoutMs: 5_000 }));
      await m.connectAll();
      // 第 2 个 POST（tools/list）后服务端关流 → 工具调用应快速失败。
      const started = Date.now();
      const r = await dispatch("mcp__legacy__echo", JSON.stringify({ text: "x" }), makeCtx());
      expect(r.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      fake.stop();
    }
  });

  test("S5 /mcp 面板显示 [sse] 与工具", async () => {
    const fake = startFakeSse();
    try {
      const m = track(new McpManager([sseServer(fake.port)], { connectTimeoutMs: 5_000 }));
      await m.connectAll();
      wireCommands();
      const cap = captureConsole();
      const ctx = {
        cfg: { cwd: "/tmp" } as unknown as Config,
        ui: cap.ui,
        mcp: () => m.statuses(),
      } as unknown as CommandContext;
      await dispatchCommand("/mcp", ctx);
      const text = cap.out();
      expect(text).toContain("[sse]");
      expect(text).toContain("mcp__legacy__echo");
    } finally {
      fake.stop();
    }
  });
});

describe("issue #44 配置解析", () => {
  test("S6 transport:\"sse\" 解析出 url / headers，不再 warning 跳过", () => {
    const { servers, warnings } = parseMcpServers({
      legacy: { transport: "sse", url: "https://x.example.com/sse", headers: { Authorization: "Bearer t" } },
    });
    expect(warnings).toEqual([]);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: "legacy",
      transport: "sse",
      url: "https://x.example.com/sse",
      headers: { Authorization: "Bearer t" },
      enabled: true,
    });
  });

  test("S7 sse 缺 url / 非 http(s) → 各自 warning 并跳过", () => {
    const { servers, warnings } = parseMcpServers({
      noUrl: { transport: "sse" },
      badUrl: { transport: "sse", url: "ftp://x" },
    });
    expect(servers).toEqual([]);
    const text = warnings.join("\n");
    expect(text).toContain("noUrl 的 transport=\"sse\" 缺少 url");
    expect(text).toContain("必须是 http(s) 绝对地址");
  });
});
