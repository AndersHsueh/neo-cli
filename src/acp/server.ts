/**
 * ACP v1 服务端（issue #60）。
 *
 * 方向：neo 作为**服务端**被编辑器（Zed / JetBrains）拉起，stdin 读 JSON-RPC NDJSON、
 * stdout 只写协议消息。与 `src/mcp/`、`src/lsp/`（neo 作为客户端）方向相反。
 *
 * 传输与 JSON-RPC 分发都交给官方 `@agentclientprotocol/sdk` 的**默认入口**（= 稳定 v1）：
 * `ndJsonStream()` 做 NDJSON 编解码，`agent()` 的 fluent API 注册 handler。
 * 本文件只负责：协议方法 → neo 侧的映射，以及 stdout 的独占。
 *
 * 首期（A 步）只做 `initialize` 握手；`session/*` 等按 PRD §2.5 起在后续步骤实现，
 * 现在一律回 `-32601`（方法未实现），不伪造结果。
 */
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type { AgentCapabilities, Implementation, InitializeResponse } from "@agentclientprotocol/sdk";
import { VERSION } from "../cli/version.ts";

/**
 * 首期广告的能力（PRD §2.4）：只广告真做的。
 *
 * - `loadSession: false`：`session/load` 未做；
 * - `promptCapabilities` 显式全 false：`session/prompt` 尚未接线（B/C 步才做），
 *   现在广告 image/audio/embeddedContext 会让客户端把内容发过来却没人处理；
 * - `mcpCapabilities` 不广告：客户端传入的 `mcpServers` 首期不接入（PRD §2.7 待定）。
 */
const CAPABILITIES: AgentCapabilities = {
  loadSession: false,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
};

const AGENT_INFO: Implementation = { name: "neo", title: "neo", version: VERSION };

/**
 * 诊断只走 stderr：stdout 是协议通道，任何人类可读文本写进去都会让客户端解析失败。
 */
function log(message: string): void {
  process.stderr.write(`[acp] ${message}\n`);
}

/**
 * 启动 stdio 上的 ACP 服务端，直到 stdin 关闭才返回。
 *
 * 返回值是进程退出码（正常关闭 stdin → 0）。
 */
export async function runAcpServer(): Promise<number> {
  const stream = ndJsonStream(
    new WritableStream<Uint8Array>({
      write(chunk) {
        // 直接写 fd 1，不经过 console：避免任何格式化/换行修饰混进协议流。
        process.stdout.write(chunk);
      },
    }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        process.stdin.on("data", (chunk: Buffer | string) => {
          controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
        });
        process.stdin.on("end", () => controller.close());
        process.stdin.on("error", (err) => controller.error(err));
      },
    }),
  );

  const app = agent({ name: "neo" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      // 请求版本不是 1 也回 1（PRD §2.4）：由客户端决定是否断开，这里不报错。
      log(`initialize：client=${params.clientInfo?.name ?? "?"} 请求 protocolVersion=${params.protocolVersion}`);
      const response: InitializeResponse = {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: CAPABILITIES,
        agentInfo: AGENT_INFO,
        authMethods: [],
      };
      return response;
    })
    .onRequest("*", ({ method }) => {
      // 首期只做握手；未实现的方法明确报 -32601，不返回假结果。
      throw RequestError.methodNotFound(method);
    });

  const connection = app.connect(stream);
  log(`服务端已就绪（stdio NDJSON，ACP v${PROTOCOL_VERSION}）`);

  // 不在这里退出：连接要一直读到 stdin 关闭（编辑器随时可能发下一条请求）。
  await connection.closed;
  return 0;
}
