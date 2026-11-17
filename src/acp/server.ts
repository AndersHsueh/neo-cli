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
 * 本步（C）实现：`initialize`、`session/new`、`session/prompt` 与文本类 `session/update`。
 * 工具事件 / 权限 / cancel / diff 是 D 步，未注册的方法一律回 `-32601`，不伪造结果。
 */
import { isAbsolute } from "node:path";
import { existsSync, statSync } from "node:fs";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ContentBlock,
  Implementation,
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { VERSION } from "../cli/version.ts";
import { loadConfig, ConfigError, type Config } from "../config.ts";
import { resolveAndApplyModelWindow } from "../env/modelWindows.ts";
import { createAcpSession, type AcpSession } from "./session.ts";
import { createInboundGate } from "./inbound.ts";

/**
 * 首期广告的能力（PRD §2.4）：只广告真做的。
 *
 * - `loadSession: false`：`session/load` 未做；
 * - `promptCapabilities` 显式全 false：本步只做 text 基线，image/audio/embeddedContext
 *   尚未映射到 `Agent.send()` 的图片通道；
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

/** `session/new` 的 cwd 校验（PRD §2.5）：必填、绝对、且是已存在的目录。 */
function resolveWorkspace(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw RequestError.invalidParams("session/new 需要 cwd（本次会话的工作区绝对路径）");
  }
  if (!isAbsolute(cwd)) {
    throw RequestError.invalidParams(`session/new 的 cwd 必须是绝对路径（收到 "${cwd}"）`);
  }
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw RequestError.invalidParams(`session/new 的 cwd 不存在或不是目录：${cwd}`);
  }
  return cwd;
}

/**
 * 缺模型凭证的判定与 bootstrap 同口径（`cfg.apiKey` 为空）：返回 JSON-RPC 错误，
 * 不伪造 sessionId、不静默降级（PRD §2.5）。
 */
function requireApiKey(cfg: Config): void {
  if (cfg.apiKey) return;
  throw RequestError.internalError(
    undefined,
    `provider "${cfg.providerName}" 没有配置 api_key：请在 settings.json 的 providers 中填写，` +
      `或设置环境变量 NEO_API_KEY。`,
  );
}

/** 从 ContentBlock 数组里取文本（本步只接受 text block，其余明确报错，不静默丢弃）。 */
function promptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    throw RequestError.invalidParams(
      `暂不支持 ${block.type} 内容块（本步只支持 text；image/audio/resource 见 PRD §5 已知未做）`,
    );
  }
  return parts.join("\n");
}

/**
 * 启动 stdio 上的 ACP 服务端，直到 stdin 关闭才返回。
 *
 * 返回值是进程退出码（正常关闭 stdin → 0）。
 */
export async function runAcpServer(): Promise<number> {
  // 入站顺序闸门（PRD §2.2 备案 A）：SDK 的 receive() 不等待 handler，
  // 初始化闸门在 handler 之前就拒绝后续请求，所以排队必须发生在字节流上。
  const inbound = createInboundGate(
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

  // 只有看到「带 id 的 JSON-RPC 响应」写出后才放行下一条入站请求。
  // 不能在 handler 的 finally 里 markAnswered：SDK 是 await handler() 之后才
  // respondWithResult（闸门也在那时放行），过早放行会再撞上初始化闸门。
  // session/update 通知没有 id，不会被当成响应。
  let outBuf = "";
  const stream = ndJsonStream(
    new WritableStream<Uint8Array>({
      write(chunk) {
        process.stdout.write(chunk);
        outBuf += new TextDecoder().decode(chunk);
        for (;;) {
          const nl = outBuf.indexOf("\n");
          if (nl === -1) break;
          const line = outBuf.slice(0, nl).trim();
          outBuf = outBuf.slice(nl + 1);
          if (line === "") continue;
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg && typeof msg === "object" && "id" in msg && !("method" in msg)) {
              inbound.markAnswered();
            }
          } catch {
            /* 不完整或不合法的行交给协议对端处理，这里不放行。 */
          }
        }
      },
    }),
    inbound.readable,
  );

  /** 单进程只服务一个 session（PRD §2.6）。 */
  let session: AcpSession | null = null;
  /** 同一 session 已有 prompt 在跑时，新的 session/prompt 回 -32603（PRD §2.8）。 */
  let prompting = false;

  /**
   * 请求串行队列（PRD §2.3 的「initialize 之前收到其它请求 → -32600」）。
   *
   * 注意：**光靠这里修不好**。SDK 的初始化闸门在 handler 进入之前就拒绝了
   * 未初始化的请求，所以真正的排队在字节流层（`createInboundGate`）。
   * 这一层保留，用于保证「同一 session 的 prompt 不并发」等 handler 内部顺序，
   * 以及让响应写出的先后与请求到达一致。
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

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
    .onRequest(methods.agent.session.new, async ({ params, client }) =>
      serial(async () => {
      // 先校验 cwd：非法参数应回 -32602，即使本进程已有 session（B1 在同一连接里测相对路径）。
      const cwd = resolveWorkspace(params.cwd);
      // 单 session：第二次 session/new 明确报错，不静默复用、不新建第二个 agent（PRD §2.6）。
      if (session) {
        throw RequestError.internalError(
          undefined,
          `本进程只支持一个 session（已有 ${session.sessionId}）；请为新的工作区另起一个 neo acp 进程。`,
        );
      }

      let cfg: Config;
      try {
        // settings.json 从**进程 cwd** 读（loadConfig 既有候选路径），工作区只作为 cfg.cwd。
        // 二者可以不同：编辑器给的工作区通常是 spawn 目录本身或其子目录。
        cfg = loadConfig({ cwd });
        resolveAndApplyModelWindow(cfg);
      } catch (e) {
        if (e instanceof ConfigError) {
          throw RequestError.internalError(undefined, `配置错误：${e.message}`);
        }
        throw e;
      }
      requireApiKey(cfg);

      const created = await createAcpSession({
        cfg,
        cwd,
        onText: (text) => {
          // 助手文本 → agent_message_chunk（PRD §2.9）。通知先于 prompt 响应发出。
          const notification: SessionNotification = {
            sessionId: created.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          };
          void client.notify(methods.client.session.update, notification).catch((err: unknown) => {
            log(`session/update 发送失败：${(err as Error).message}`);
          });
        },
      });
      session = created;
      log(`session/new：${created.sessionId}（工作区 ${cwd}）`);

      const response: NewSessionResponse = { sessionId: created.sessionId };
      return response;
      }),
    )
    .onRequest(methods.agent.session.prompt, async ({ params }) =>
      serial(async () => {
      const current = session;
      if (!current || current.sessionId !== params.sessionId) {
        // 未知 session：-32002，并把请求里的 id 回带（PRD §2.3）。
        throw RequestError.sessionNotFound(params.sessionId);
      }
      if (prompting) {
        throw RequestError.internalError(undefined, "该 session 已有一轮 prompt 在跑，不能并发");
      }
      const text = promptText(params.prompt);
      prompting = true;
      try {
        const { stopReason } = await current.prompt(text);
        const response: PromptResponse = { stopReason };
        return response;
      } finally {
        prompting = false;
      }
      }),
    )
    .onRequest("*", ({ method }) => {
      // 未实现的方法明确报 -32601，不返回假结果。
      throw RequestError.methodNotFound(method);
    });

  const connection = app.connect(stream);
  log(`服务端已就绪（stdio NDJSON，ACP v${PROTOCOL_VERSION}）`);

  // 不在这里退出：连接要一直读到 stdin 关闭（编辑器随时可能发下一条请求）。
  await connection.closed;
  return 0;
}
