/**
 * SSE 事件块解析（issue #44 抽公共）。
 *
 * 两种 MCP 传输都用 SSE 承载 JSON-RPC，但承载位置不同：
 *  - streamable HTTP（`httpRpc.ts`）：事件流在 **POST 响应体**里；
 *  - 旧式 SSE（`sseRpc.ts`）：事件流在 **GET 长连接**里。
 *
 * 事件块的切分规则（`\n\n` 分隔、多行 `data:` 拼接、`event:` 取类型）两边完全一样，
 * 所以放在这里，避免复制两份后各自漂移。
 */

/** JSON-RPC 响应/通知的最小形状（两种传输共用）。 */
export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface SseBlock {
  /** `event:` 字段值；缺省为 "message"（SSE 规范默认值）。 */
  event: string;
  /** 所有 `data:` 行拼接后的内容（已 trim）。 */
  data: string;
}

/**
 * 从缓冲区里切出完整事件块。
 *
 * 返回切好的 `blocks` 与**未消费的残余** `rest`（调用方负责拼回下一次读到的数据）。
 * 只按 `\n\n` 切 —— 服务端也可能发 `\r\n\r\n`，这里统一先规整换行。
 */
export function parseSseBlocks(buf: string): { blocks: SseBlock[]; rest: string } {
  const normalized = buf.replace(/\r\n/g, "\n");
  const blocks: SseBlock[] = [];
  let rest = normalized;
  for (;;) {
    const sep = rest.indexOf("\n\n");
    if (sep === -1) break;
    const raw = rest.slice(0, sep);
    rest = rest.slice(sep + 2);
    const block = parseBlock(raw);
    if (block) blocks.push(block);
  }
  return { blocks, rest };
}

function parseBlock(raw: string): SseBlock | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    // 其它字段（id: / retry: / 注释 `:`）对 MCP 无意义，跳过。
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n").trim() };
}
