/**
 * 假语言服务器（issue #23 测试夹具）：实现最小 LSP 子集 + Content-Length 帧。
 *
 * 行为：
 *  - textDocument/didOpen | didChange：若文档文本含 "BROKEN" 推一条 error 诊断（第 1 行），否则推空数组；
 *  - textDocument/definition：返回该文件第 2 行第 3 列；
 *  - textDocument/references：两条位置（第 4/6 行）；
 *  - textDocument/hover：返回 "**fake type**"；
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

function onMessage(msg: Msg): void {
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const doc = (params["textDocument"] ?? {}) as { uri?: string; text?: string };
  if (doc.uri) lastUri = doc.uri;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { textDocumentSync: 2 } } });
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
