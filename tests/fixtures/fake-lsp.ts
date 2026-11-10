/**
 * 假语言服务器（issue #23 / #43 测试夹具）：实现最小 LSP 子集 + Content-Length 帧。
 *
 * 行为：
 *  - initialize：回 capabilities；若 params.capabilities.workspace.configuration 为 true，
 *    则**主动**发一个 server→client 请求 `workspace/configuration`（issue #43：真实 server
 *    如 pyright 会这么做，客户端不应答就会挂）。应答结果记在 lastConfigurationReply。
 *  - textDocument/didOpen | didChange：若文档文本含 "BROKEN" 推一条 error 诊断（第 1 行），否则推空数组；
 *  - textDocument/definition：返回该文件第 2 行第 3 列；
 *  - textDocument/references：两条位置（第 4/6 行）；
 *  - textDocument/hover：返回 "**fake type**"；
 *  - workspace/symbol：按 query 返回 2 条 SymbolInformation（空 query 返回 25 条，用于测截断）；
 *  - textDocument/prepareCallHierarchy：返回 1 个 item（带 data，供原样回传校验）；
 *  - callHierarchy/incomingCalls | outgoingCalls：**校验 item 原样回传**（data 丢了就报错），
 *    分别返回 2 条 / 1 条；
 *  - textDocument/completion：返回 25 条 item（测截断）+ isIncomplete；
 *  - shutdown：回空结果后退出。
 */
type Msg = { jsonrpc?: string; id?: number; method?: string; params?: unknown };

function encode(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload]);
}

function send(msg: unknown): void {
  process.stdout.write(encode(msg));
}

let buf = Buffer.alloc(0);
const texts = new Map<string, string>();
let lastUri = "";
let nextServerId = 900;
/** 客户端对 workspace/configuration 的应答（排障用，也供测试断言）。 */
let lastConfigurationReply: unknown = null;
/** 有多少个 server→client 请求还没收到应答。 */
let unanswered = 0;

const CALL_ITEM = {
  name: "fakeFn",
  kind: 12,
  uri: "",
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
  selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } },
  detail: "fake detail",
  data: { token: "keep-me" },
};

function onMessage(msg: Msg): void {
  // server→client 请求的应答（有 id、无 method）—— 只用于记账。
  if (msg.method === undefined && msg.id !== undefined) {
    lastConfigurationReply = (msg as { result?: unknown }).result ?? null;
    unanswered = Math.max(0, unanswered - 1);
    return;
  }
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const doc = (params["textDocument"] ?? {}) as { uri?: string; text?: string };
  if (doc.uri) lastUri = doc.uri;
  if (msg.method === "initialize") {
    const caps = (params["capabilities"] ?? {}) as Record<string, unknown>;
    const workspace = (caps["workspace"] ?? {}) as Record<string, unknown>;
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 2 } } });
    // 客户端声明了 workspace.configuration 才发 —— 与真实 server 的行为一致。
    if (workspace["configuration"] === true) {
      unanswered += 1;
      send({ jsonrpc: "2.0", id: nextServerId++, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
    }
    return;
  }
  if (msg.method === "initialized") return;
  if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
    const uri = doc.uri ?? "";
    if (typeof doc.text === "string") texts.set(uri, doc.text);
    const text = texts.get(uri) ?? "";
    const diags = text.includes("BROKEN")
      ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "fake type error", source: "fake-lsp" }]
      : [];
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diags } });
    return;
  }
  if (msg.method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [{ uri: lastUri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }],
    });
    return;
  }
  if (msg.method === "textDocument/references") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        { uri: lastUri, range: { start: { line: 3, character: 0 } } },
        { uri: lastUri, range: { start: { line: 5, character: 4 } } },
      ],
    });
    return;
  }
  if (msg.method === "textDocument/hover") {
    send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: "**fake type**" } } });
    return;
  }
  if (msg.method === "workspace/symbol") {
    const query = String(params["query"] ?? "");
    // 空 query = 「列全仓」：25 条，用来验证客户端侧截断。
    const count = query === "" ? 25 : 2;
    const result = Array.from({ length: count }, (_, i) => ({
      name: query === "" ? `sym${i}` : `${query}${i}`,
      kind: 12,
      location: { uri: lastUri, range: { start: { line: i, character: 0 } } },
    }));
    send({ jsonrpc: "2.0", id: msg.id, result });
    return;
  }
  if (msg.method === "textDocument/prepareCallHierarchy") {
    send({ jsonrpc: "2.0", id: msg.id, result: [{ ...CALL_ITEM, uri: lastUri }] });
    return;
  }
  if (msg.method === "callHierarchy/incomingCalls" || msg.method === "callHierarchy/outgoingCalls") {
    const item = (params["item"] ?? {}) as Record<string, unknown>;
    const data = (item["data"] ?? {}) as Record<string, unknown>;
    if (data["token"] !== "keep-me") {
      // item 没有原样回传（data 丢了）—— 真实 server 会拒绝，这里显式报错。
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "item 未原样回传（data 丢失）" } });
      return;
    }
    const incoming = msg.method === "callHierarchy/incomingCalls";
    const count = incoming ? 2 : 1;
    const result = Array.from({ length: count }, (_, i) => ({
      from: incoming ? { ...CALL_ITEM, name: `caller${i}`, uri: lastUri } : undefined,
      to: incoming ? undefined : { ...CALL_ITEM, name: `callee${i}`, uri: lastUri },
      fromRanges: [{ start: { line: 10 + i, character: 2 } }],
    }));
    send({ jsonrpc: "2.0", id: msg.id, result });
    return;
  }
  if (msg.method === "textDocument/completion") {
    const items = Array.from({ length: 25 }, (_, i) => ({ label: `cand${i}`, kind: 3, detail: `detail${i}` }));
    send({ jsonrpc: "2.0", id: msg.id, result: { isIncomplete: true, items } });
    return;
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") process.exit(0);
}

process.stdin.resume();
process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buf.subarray(0, headerEnd).toString("ascii");
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) {
      buf = buf.subarray(headerEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = headerEnd + 4;
    if (buf.length < start + len) return;
    const body = buf.subarray(start, start + len).toString("utf8");
    buf = buf.subarray(start + len);
    try {
      onMessage(JSON.parse(body) as Msg);
    } catch {
      /* ignore */
    }
  }
});
