/**
 * mcp-http.test.ts — MCP 远程 HTTP 传输（issue #29）。
 *
 * 覆盖：
 *  1. `{ type: "http", url, headers }` 能连远程端点、注册工具、经 dispatch 调用；
 *  2. streamable HTTP 的协议细节：`Mcp-Session-Id` 回带、`Authorization` 透传、
 *     `application/json` 与 `text/event-stream` 两种响应都能读；
 *  3. 失败可读且不拖垮整体：401 / 连不上只让该 server 进 error，其它照常连接；
 *  4. 传输类型在 `/mcp` 状态里可见（transport 字段）。
 *
 * 全部用本地假 HTTP server，不触外网。注意 bun test 单进程共享模块表：
 * 每个用例结束必须 closeAll() 注销 mcp__* 工具。
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { Config, McpHttpServerConfig } from "../src/config.ts";
import { McpManager } from "../src/mcp/client.ts";
import { HttpRpc } from "../src/mcp/httpRpc.ts";
import { dispatch, toolNames } from "../src/tools/index.ts";
import type { ToolCtx } from "../src/tools/types.ts";

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
  session: string | null;
  auth: string | null;
  accept: string | null;
}

/**
 * 假 streamable HTTP MCP server。
 *
 * `mode` 控制响应形态：json（默认）/ sse（tools/list 走事件流）/ 401。
 * 记录每次请求的方法与会话/鉴权头，供断言「会话回带」「header 透传」。
 */
function startFakeMcp(
  mode: "json" | "sse" | "unauthorized" = "json",
): { port: number; seen: Recorded[]; stop: () => void } {
  const seen: Recorded[] = [];
  let sessionSeq = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
      if (mode === "unauthorized") {
        return new Response("unauthorized", { status: 401 });
      }
      const body = (await req.json()) as { id?: number; method?: string; params?: unknown };
      seen.push({
        method: body.method ?? "",
        session: req.headers.get("mcp-session-id"),
        auth: req.headers.get("authorization"),
        accept: req.headers.get("accept"),
      });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (body.method === "initialize") {
        sessionSeq += 1;
        headers["Mcp-Session-Id"] = `sess-${sessionSeq}`;
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "http-fake", version: "1" },
            },
          },
          { headers },
        );
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202, headers });
      }
      if (body.method === "tools/list") {
        const result = {
          tools: [
            {
              name: "echo",
              description: "回声",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        };
        if (mode === "sse") {
          // 事件流：先来一条服务端通知（应被跳过），再给真正的响应。
          const payload =
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`;
          return new Response(payload, {
            headers: { ...headers, "Content-Type": "text/event-stream" },
          });
        }
        return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers });
      }
      if (body.method === "tools/call") {
        const args = (body.params as { arguments?: { text?: string } } | undefined)?.arguments;
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { content: [{ type: "text", text: `ECHO:${args?.text ?? ""}` }] },
          },
          { headers },
        );
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
    },
  });
  return { port: Number(server.port), seen, stop: () => server.stop(true) };
}

function httpServer(port: number, over: Partial<McpHttpServerConfig> = {}): McpHttpServerConfig {
  return {
    name: "remote",
    transport: "http",
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: "Bearer secret" },
    enabled: true,
    ...over,
  };
}

describe("issue #29 HTTP 传输", () => {
  test("连接 + 注册 + 经 dispatch 调用；会话 id 回带、Authorization 透传", async () => {
    const fake = startFakeMcp("json");
    try {
      const m = track(new McpManager([httpServer(fake.port)], { connectTimeoutMs: 5_000 }));
      expect(await m.connectAll()).toBe(1);

      const st = m.statuses()[0]!;
      expect(st.status).toBe("connected");
      expect(st.transport).toBe("http");
      expect(st.serverInfo?.name).toBe("http-fake");
      expect(toolNames()).toContain("mcp__remote__echo");

      const r = await dispatch("mcp__remote__echo", JSON.stringify({ text: "你好" }), makeCtx());
      expect(r.ok).toBe(true);
      expect(r.output).toContain("ECHO:你好");

      // initialize 之后的所有请求都必须回带 Mcp-Session-Id
      const afterInit = fake.seen.filter((x) => x.method !== "initialize");
      expect(afterInit.length).toBeGreaterThan(0);
      expect(afterInit.every((x) => x.session === "sess-1")).toBe(true);
      // 静态 headers 原样发出
      expect(fake.seen.every((x) => x.auth === "Bearer secret")).toBe(true);
      // 要求服务端可以回 SSE
      expect(fake.seen[0]?.accept).toContain("text/event-stream");
    } finally {
      fake.stop();
    }
  });

  test("SSE 响应也能读：跳过服务端通知，取到匹配 id 的结果", async () => {
    const fake = startFakeMcp("sse");
    try {
      const m = track(new McpManager([httpServer(fake.port)], { connectTimeoutMs: 5_000 }));
      expect(await m.connectAll()).toBe(1);
      expect(m.statuses()[0]?.status).toBe("connected");
      const r = await dispatch("mcp__remote__echo", JSON.stringify({ text: "sse" }), makeCtx());
      expect(r.ok).toBe(true);
      expect(r.output).toContain("ECHO:sse");
    } finally {
      fake.stop();
    }
  });

  test("401 → 该 server 进 error、错误可读，其它 server 照常连接", async () => {
    const bad = startFakeMcp("unauthorized");
    const good = startFakeMcp("json");
    try {
      const m = track(
        new McpManager([httpServer(bad.port, { name: "bad" }), httpServer(good.port)], {
          connectTimeoutMs: 5_000,
        }),
      );
      await m.connectAll();
      const states = m.statuses();
      const badState = states.find((s) => s.name === "bad")!;
      expect(badState.status).toBe("error");
      expect(badState.error).toContain("401");
      expect(badState.transport).toBe("http");
      expect(states.find((s) => s.name === "remote")?.status).toBe("connected");
    } finally {
      bad.stop();
      good.stop();
    }
  });

  test("连不上（端口无服务）→ error 且不抛；描述里带 URL", async () => {
    const m = track(
      new McpManager([httpServer(1)], { connectTimeoutMs: 2_000, requestTimeoutMs: 1_000 }),
    );
    await m.connectAll();
    const st = m.statuses()[0]!;
    expect(st.status).toBe("error");
    expect(st.error).toContain("HTTP");
  });

  test("HttpRpc：JSON-RPC error 转可读错误；close 后请求被拒", async () => {
    const fake = startFakeMcp("json");
    try {
      const rpc = new HttpRpc({ url: `http://127.0.0.1:${fake.port}/mcp`, requestTimeoutMs: 2_000 });
      await rpc.request("initialize", {});
      await expect(rpc.request("bogus/method")).rejects.toThrow(/JSON-RPC 错误/);
      rpc.close();
      expect(rpc.alive).toBe(false);
      await expect(rpc.request("tools/list")).rejects.toThrow(/关闭/);
    } finally {
      fake.stop();
    }
  });
});
