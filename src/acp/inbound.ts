/**
 * ACP 入站字节流的顺序闸门（issue #60）。
 *
 * 官方 SDK 的 Connection.receive() 对每条消息调用 receiveUnvalidatedMessage()
 * 而不等待；初始化闸门只在 initialize 的 respondWithResult 里把连接标为已初始化。
 * 同一批 stdin 里紧跟的 session/new 会因此被误判为未初始化。
 *
 * 在 handler 外包 serial() 太晚。这里在喂给 SDK 的字节流上排队：
 * - stdin 按行拆成完整 JSON-RPC 消息；
 * - **只串行化入站请求**（有 method 且有 id）：上一条请求的响应写出之后，才放行下一条请求；
 * - 客户端通知（有 method 无 id）与客户端对服务端请求的响应（有 id 无 method）
 *   **立刻放行**，不等当前请求结束 —— 否则 `session/cancel` 要等 `session/prompt`
 *   跑完才被读到（cancel 永远晚于它要取消的那一轮），
 *   `session/request_permission` 的响应也要等 prompt 结束才喂进去（互相死锁）；
 * - 服务端自己发出的 session/update（无 id）不算响应。
 */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** 只取判定「是不是请求」所需的字段。 */
function isRequestLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return typeof record["method"] === "string" && "id" in record;
  } catch {
    return false;
  }
}

export interface InboundGate {
  readable: ReadableStream<Uint8Array>;
  /** 某条请求的响应已经写出时由 stdout 监视器调用。 */
  markAnswered(): void;
}

/**
 * 把原始 stdin 字节流包成「请求一次只放一条、通知与响应立刻放行」的输入流。
 */
export function createInboundGate(stdin: ReadableStream<Uint8Array>): InboundGate {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pending: string[] = [];
  let awaitingResponse = false;
  let closed = false;

  const pump = (): void => {
    if (!controller) return;
    while (pending.length > 0) {
      // 队头是请求且上一条请求还没应答：整队停在这里，保持到达顺序。
      if (awaitingResponse && isRequestLine((pending[0] as string).trim())) return;
      const line = pending.shift() as string;
      controller.enqueue(encoder.encode(line));
      // 只有请求会占住闸门；通知与响应喂进去就完事，不等任何东西。
      if (isRequestLine(line.trim())) awaitingResponse = true;
    }
    if (closed && pending.length === 0 && !awaitingResponse) {
      try {
        controller.close();
      } catch {
        /* 已关闭 */
      }
    }
  };

  async function consume(): Promise<void> {
    const reader = stdin.getReader();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf("\n");
          if (lf === -1) break;
          pending.push(buffer.slice(0, lf + 1));
          buffer = buffer.slice(lf + 1);
          pump();
        }
        if (buffer.length > MAX_LINE_BYTES) {
          pending.push(buffer);
          buffer = "";
          pump();
        }
      }
      buffer += decoder.decode();
      if (buffer !== "") {
        const last = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
        if (last !== "") pending.push(`${last}\n`);
      }
      closed = true;
      pump();
    } catch (err) {
      try {
        controller?.error(err);
      } catch {
        /* 已关闭 */
      }
    } finally {
      reader.releaseLock();
    }
  }

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      void consume();
    },
  });

  return {
    readable,
    markAnswered() {
      if (!awaitingResponse) return;
      awaitingResponse = false;
      pump();
    },
  };
}
