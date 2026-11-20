/**
 * 假 MCP stdio server（issue #67）：可暴露 tools / resources / prompts。
 *
 * 与 mcp-server.ts 分开，避免改坏 issue #2 的既有夹具默认行为。
 *
 *   bun tests/fixtures/mcp-catalog-server.ts \
 *     --name=docs \
 *     --caps=tools,resources,prompts \
 *     [--pages=2] [--missing-method] [--read=ok|fail|blob] \
 *     [--notify-ms=80] [--notify-fail] [--init-log=/tmp/init.json] \
 *     [--page-cap-overflow]
 *
 * 默认资源 / 提示词见下方常量。`--caps` 决定 initialize.capabilities；
 * 未声明的类目即使被误调也回 -32601。
 */
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (k: string, dflt = ""): string => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const hasFlag = (k: string): boolean => argv.includes(`--${k}`);

const SERVER_NAME = opt("name", "docs");
const CAPS = new Set(
  (opt("caps", "tools,resources,prompts") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const PAGES = Math.max(1, Number(opt("pages", "1")) || 1);
const MISSING_METHOD = hasFlag("missing-method");
const READ_MODE = opt("read", "ok"); // ok | fail | blob
const NOTIFY_MS = Number(opt("notify-ms", "0")) || 0;
const NOTIFY_FAIL = hasFlag("notify-fail");
const INIT_LOG = opt("init-log");
const PAGE_OVERFLOW = hasFlag("page-cap-overflow");

const TOOLS = [
  {
    name: "echo",
    description: "原样回显 text 参数",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

const RESOURCES_A = [
  { uri: "file://api/authentication", name: "Auth", title: "Authentication", mimeType: "text/plain" },
  { uri: "issue://123", name: "Issue 123", mimeType: "text/plain" },
  { uri: "ui://widget", name: "UI widget", mimeType: "text/html" },
  { uri: "file://app-ui", name: "App UI", mimeType: "text/html;profile=mcp-app" },
];

const RESOURCES_B = [
  { uri: "file://api/authentication", name: "Auth", mimeType: "text/plain" },
  { uri: "issue://999", name: "Issue 999", mimeType: "text/plain" },
];

const PROMPTS_A = [
  {
    name: "hello",
    description: "无参数问好",
  },
  {
    name: "summarize",
    description: "总结一个仓库",
    arguments: [
      { name: "repo", description: "仓库名", required: true },
      { name: "style", description: "风格", required: false },
    ],
  },
];

const PROMPTS_B = [
  { name: "hello", description: "无参数问好（已更新）" },
  { name: "changelog", description: "更新后的提示词" },
];

let resourceGen = 0;
let promptGen = 0;
let listFailAfterNotify = false;
let initializeLogged = false;

function currentResources() {
  return resourceGen % 2 === 0 ? RESOURCES_A : RESOURCES_B;
}
function currentPrompts() {
  return promptGen % 2 === 0 ? PROMPTS_A : PROMPTS_B;
}

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function pageItems<T>(items: T[], cursor: unknown): { slice: T[]; nextCursor?: string } {
  if (PAGE_OVERFLOW) {
    // 每页 1 条且永远带 nextCursor，用来测客户端页数上限截断。
    const i = typeof cursor === "string" && cursor !== "" ? Number(cursor) || 0 : 0;
    const slice = items.slice(i % items.length, (i % items.length) + 1);
    return { slice, nextCursor: String(i + 1) };
  }
  if (PAGES <= 1) return { slice: items };
  const size = Math.max(1, Math.ceil(items.length / PAGES));
  const i = typeof cursor === "string" && cursor !== "" ? Number(cursor) || 0 : 0;
  const slice = items.slice(i, i + size);
  const next = i + size;
  return next < items.length ? { slice, nextCursor: String(next) } : { slice };
}

function capabilities(): Record<string, unknown> {
  const caps: Record<string, unknown> = {};
  if (CAPS.has("tools")) caps["tools"] = { listChanged: false };
  if (CAPS.has("resources")) caps["resources"] = { listChanged: true };
  if (CAPS.has("prompts")) caps["prompts"] = { listChanged: true };
  return caps;
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = msg["id"];
  const method = String(msg["method"] ?? "");

  if (id === undefined) {
    if (method === "notifications/initialized" && NOTIFY_MS > 0) {
      setTimeout(() => {
        // 失败刷新用例必须先打开失败开关，再发通知，避免客户端抢先 list 到新清单。
        if (NOTIFY_FAIL) listFailAfterNotify = true;
        else {
          resourceGen += 1;
          promptGen += 1;
        }
        send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
        send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
      }, NOTIFY_MS);
    }
    return;
  }

  if (method === "initialize") {
    if (INIT_LOG && !initializeLogged) {
      initializeLogged = true;
      try {
        writeFileSync(INIT_LOG, JSON.stringify(msg["params"] ?? {}), "utf8");
      } catch {
        /* 测试夹具：写失败不崩 */
      }
    }
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: capabilities(),
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
    if (name === "echo") {
      reply(id, { content: [{ type: "text", text: `echo:${String(args["text"] ?? "")}` }] });
      return;
    }
    replyError(id, -32602, `未知工具: ${name}`);
    return;
  }

  if (method === "resources/list") {
    if (!CAPS.has("resources") || MISSING_METHOD) {
      replyError(id, -32601, "不支持的方法: resources/list");
      return;
    }
    if (listFailAfterNotify) {
      replyError(id, -32603, "resources/list 刷新失败");
      return;
    }
    const params = (msg["params"] ?? {}) as Record<string, unknown>;
    const { slice, nextCursor } = pageItems(currentResources(), params["cursor"]);
    reply(id, nextCursor ? { resources: slice, nextCursor } : { resources: slice });
    return;
  }

  if (method === "resources/read") {
    if (!CAPS.has("resources")) {
      replyError(id, -32601, "不支持的方法: resources/read");
      return;
    }
    const params = (msg["params"] ?? {}) as Record<string, unknown>;
    const uri = String(params["uri"] ?? "");
    if (READ_MODE === "fail") {
      replyError(id, -32002, `读取失败: ${uri}`);
      return;
    }
    if (READ_MODE === "blob") {
      reply(id, {
        contents: [{ uri, mimeType: "application/octet-stream", blob: "A".repeat(400) }],
      });
      return;
    }
    const known = [...RESOURCES_A, ...RESOURCES_B].find((r) => r.uri === uri);
    if (!known) {
      replyError(id, -32002, `未知资源: ${uri}`);
      return;
    }
    reply(id, {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: `resource-body:${SERVER_NAME}:${uri}`,
        },
      ],
    });
    return;
  }

  if (method === "prompts/list") {
    if (!CAPS.has("prompts") || MISSING_METHOD) {
      replyError(id, -32601, "不支持的方法: prompts/list");
      return;
    }
    if (listFailAfterNotify) {
      replyError(id, -32603, "prompts/list 刷新失败");
      return;
    }
    const params = (msg["params"] ?? {}) as Record<string, unknown>;
    const { slice, nextCursor } = pageItems(currentPrompts(), params["cursor"]);
    reply(id, nextCursor ? { prompts: slice, nextCursor } : { prompts: slice });
    return;
  }

  if (method === "prompts/get") {
    if (!CAPS.has("prompts")) {
      replyError(id, -32601, "不支持的方法: prompts/get");
      return;
    }
    const params = (msg["params"] ?? {}) as Record<string, unknown>;
    const name = String(params["name"] ?? "");
    const args = (params["arguments"] ?? {}) as Record<string, string>;
    const all = [...PROMPTS_A, ...PROMPTS_B];
    if (!all.some((p) => p.name === name)) {
      replyError(id, -32602, `未知提示词: ${name}`);
      return;
    }
    const argLine = Object.keys(args).length > 0 ? ` args=${JSON.stringify(args)}` : "";
    reply(id, {
      description: `prompt ${name}`,
      messages: [
        {
          role: "user",
          content: { type: "text", text: `prompt-body:${SERVER_NAME}:${name}${argLine}` },
        },
      ],
    });
    return;
  }

  replyError(id, -32601, `不支持的方法: ${method}`);
});

rl.on("close", () => process.exit(0));
