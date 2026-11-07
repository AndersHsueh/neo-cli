/**
 * 假 MCP stdio server（issue #2 测试 fixture）。
 *
 * 为什么自己写而不装官方 SDK：测试要覆盖的是**客户端**的协议行为
 * （initialize / tools/list / tools/call / isError / 坏命令），
 * 一个 100 行的假 server 就能把所有路径钉死，且零依赖、无网络、毫秒级启动。
 *
 * 用法（由测试通过 StdioRpc 或 McpManager 拉起）：
 *   bun tests/fixtures/mcp-server.ts [--mode=ok|noisy|slow|crash|badjson] [--name=echo]
 *
 * 模式：
 *   ok       正常应答（默认）
 *   noisy    先往 stdout 打一行非 JSON 日志（模拟「server 往 stdout 打日志」）
 *   slow     initialize 前先睡 5 秒（测超时路径）
 *   crash    收到 initialize 直接退出（测「进程退出」路径）
 *   badjson  initialize 回非法 JSON（测解析容错）
 *
 * 提供的工具：
 *   echo      {text} → 原样回显（用于验证参数透传）
 *   fail      任何参数 → isError:true + 文本（用于验证错误转可读）
 *   add       {a,b} → a+b（用于验证 inputSchema 透传与数值参数）
 *   empty     无参数 → 空 content 数组（用于验证空结果提示）
 */
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (k: string, dflt: string): string => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const MODE = opt("mode", "ok");
const SERVER_NAME = opt("name", "fake");

/** 工具清单：inputSchema 原样透传给客户端，测试据此断言 schema 未被改写。 */
const TOOLS = [
  {
    name: "echo",
    description: "原样回显 text 参数",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
    },
  },
  {
    name: "fail",
    description: "总是返回 isError=true",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add",
    description: "两数相加",
    title: "加法",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "empty",
    description: "返回空 content",
    inputSchema: { type: "object", properties: {} },
  },
];

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function callTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: `echo:${String(args["text"] ?? "")}` }] };
    case "fail":
      return { content: [{ type: "text", text: "远端拒绝了这次调用（权限不足）" }], isError: true };
    case "add":
      return {
        content: [{ type: "text", text: String(Number(args["a"] ?? 0) + Number(args["b"] ?? 0)) }],
      };
    case "empty":
      return { content: [] };
    default:
      return null;
  }
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return; // 客户端不会发非 JSON；真发了也不该崩
  }
  const id = msg["id"];
  const method = String(msg["method"] ?? "");

  // 通知（无 id）：不需要应答
  if (id === undefined) return;

  if (method === "initialize") {
    if (MODE === "crash") {
      process.stderr.write("fake server: 模拟启动即崩\n");
      process.exit(3);
    }
    if (MODE === "slow") {
      // 故意拖过客户端的握手超时
      setTimeout(() => reply(id, { protocolVersion: "2024-11-05" }), 5000);
      return;
    }
    if (MODE === "badjson") {
      process.stdout.write("{这不是 JSON\n");
      return;
    }
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: "0.0.1" },
    });
    return;
  }

  if (method === "tools/list") {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const params = (msg["params"] ?? {}) as Record<string, unknown>;
    const name = String(params["name"] ?? "");
    const args = (params["arguments"] ?? {}) as Record<string, unknown>;
    const result = callTool(name, args);
    if (result === null) {
      replyError(id, -32602, `未知工具: ${name}`);
      return;
    }
    reply(id, result);
    return;
  }

  replyError(id, -32601, `不支持的方法: ${method}`);
});

rl.on("close", () => process.exit(0));

// noisy 模式：启动即往 stdout 打一行非 JSON（真实 server 常见的「日志污染」）
if (MODE === "noisy") {
  process.stdout.write("fake server: starting up...\n");
}
