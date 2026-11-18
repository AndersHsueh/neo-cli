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
 * 未注册的方法一律回 `-32601`，不伪造结果。
 */
import { isAbsolute } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ContentBlock,
  Implementation,
  AgentConnection,
  InitializeResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { VERSION } from "../cli/version.ts";
import { loadConfig, ConfigError, type Config, type McpServerConfig } from "../config.ts";
import type { PermissionMode, ToolEndEventData, ToolStartEventData } from "../agent/types.ts";
import { resolveAndApplyModelWindow } from "../env/modelWindows.ts";
import { createAcpSession, type AcpSession } from "./session.ts";
import { acpPromptError } from "./turn.ts";
import { createInboundGate } from "./inbound.ts";
import { REQUEST_PERMISSION_METHOD } from "./permission.ts";
import { toolCallEndOf, toolCallStartOf } from "./tools.ts";
import { asPermissionMode, availableCommands, modeState } from "./followup.ts";
import { adoptSession, loadSession as loadStoredSession, sessionsDir, type SessionMeta } from "../session.ts";
import type { Message } from "../llm.ts";
import { installFatalSignalHandlers } from "../signals.ts";

/**
 * 首期广告的能力（PRD §2.4）：只广告真做的。
 *
 * - `loadSession: true`：`session/load` 已做（issue #80）—— 复用 `src/session.ts` 的
 *   `loadSession()` / `adoptSession()` / `applyRestored()`，与 `--resume` 同一条恢复路径；
 *   进程仍只服务一个 session，已有会话时再 load 回 `-32603`（与第二次 `session/new` 同口径）；
 * - `promptCapabilities`：`text` 是基线；`embeddedContext: false` 只禁 `resource` 内容块，
 *   `resource_link` 是 v1 必选、已做（复审 R6）；`image` / `audio` 尚未映射到
 *   `Agent.send()` 的图片通道，显式 false；
 * - `mcpCapabilities` 不广告 http/sse：只接 stdio（settings + 客户端传入，复审 R5），
 *   HTTP/SSE 已知未做（PRD §5），不广告也不因此拒绝 session/new。
 */
const CAPABILITIES: AgentCapabilities = {
  loadSession: true,
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

/**
 * 从 ContentBlock 数组里取文本（PRD §2.8 / 复审 R6）。
 *
 * - `text`：原文；
 * - `resource_link`：v1 **必选**，映射成一行「资源 name (uri)」交给模型
 *   （不读文件内容 —— 那是 `resource` 的语义，首期未做）；
 * - `image` / `audio` / `resource`：明确报 `-32602`，不静默丢弃。
 */
function promptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push(block.text);
      continue;
    }
    if (block.type === "resource_link") {
      const name = typeof block.name === "string" && block.name !== "" ? block.name : block.uri;
      parts.push(`资源 ${name} (${block.uri})`);
      continue;
    }
    throw RequestError.invalidParams(
      `暂不支持 ${block.type} 内容块（支持 text 与 resource_link；image/audio/resource 见 PRD §5 已知未做）`,
    );
  }
  return parts.join("\n");
}

/**
 * 从 loadConfig **实际选中的那份** settings.json 读顶层 `permission_mode`（PRD §2.5/§2.11，复审 R4）。
 *
 * 必须与模型配置同源：工作区有 settings 就读工作区的；没有则与 loadConfig 一样回退
 * （启动目录 → 包装根 → ~/.neo）。不能单独固定读 `<cwd>/settings.json` ——
 * 那会让模型配置回退到启动目录、权限却落回 ask，两者来自不同文件。
 *
 * 只读这一个键，不新增对外 Config API：`loadConfig` 的 Config 是公开契约，
 * 为一个 ACP 专属回退值扩字段会牵动所有宿主。合法值 ask/auto-edit/auto-all/plan，
 * 缺省/非法 → "ask"（**不放宽**：拼错的配置不该变成 auto-all）。
 * 读不到/解析失败同样回 "ask"，解析错误本身由 loadConfig 在别处报出来。
 */
function readPermissionMode(path: string | null): PermissionMode {
  try {
    if (path === null || !existsSync(path)) return "ask";
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "ask";
    const value = (raw as Record<string, unknown>)["permission_mode"];
    if (value === "ask" || value === "auto-edit" || value === "auto-all" || value === "plan") return value;
    if (value !== undefined) log(`settings.json 的 permission_mode=${JSON.stringify(value)} 不合法，按 ask 处理`);
    return "ask";
  } catch {
    return "ask";
  }
}

/**
 * 把客户端 `session/new` 传入的 `mcpServers` 归一成 `McpServerConfig`（PRD §2.7 / 复审 R5）。
 *
 * 官方形态：`{ name, command, args?, env?: [{ name, value }] }`（stdio）。
 * - `env` 数组转对象；
 * - HTTP/SSE 形态（带 `url` / `type`）**跳过**并记「未支持的传输」：不广告
 *   `mcpCapabilities.http/sse`，也**不因此拒绝 session/new**；
 * - 单条写错只丢这一条（诊断里只说名字与原因，**绝不写 env 值**）。
 */
function clientMcpServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      log("session/new 的 mcpServers 有一条不是对象，已跳过");
      continue;
    }
    const r = item as Record<string, unknown>;
    const name = typeof r["name"] === "string" ? r["name"].trim() : "";
    if (name === "") {
      log("session/new 的 mcpServers 有一条缺少 name，已跳过");
      continue;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      log(`session/new 的 mcpServers "${name}" 名字非法（只允许字母/数字/_/-），已跳过`);
      continue;
    }
    const transport = typeof r["type"] === "string" ? r["type"].trim().toLowerCase() : "";
    if (transport === "http" || transport === "sse" || typeof r["url"] === "string") {
      log(`session/new 的 mcpServers "${name}" 使用未支持的传输（${transport || "url"}），已跳过`);
      continue;
    }
    const command = typeof r["command"] === "string" ? r["command"].trim() : "";
    if (command === "") {
      log(`session/new 的 mcpServers "${name}" 缺少 command，已跳过`);
      continue;
    }
    if (seen.has(name)) {
      log(`session/new 的 mcpServers "${name}" 重名，已跳过后面那条`);
      continue;
    }
    seen.add(name);
    const argsRaw = r["args"];
    const args = Array.isArray(argsRaw) ? argsRaw.map((a) => String(a)) : [];
    // env 是 [{ name, value }] 数组；转成对象。值只进子进程环境，不进任何日志。
    const env: Record<string, string> = {};
    const envRaw = r["env"];
    if (Array.isArray(envRaw)) {
      for (const pair of envRaw) {
        if (typeof pair !== "object" || pair === null) continue;
        const p = pair as Record<string, unknown>;
        const key = typeof p["name"] === "string" ? p["name"] : "";
        if (key === "") continue;
        env[key] = typeof p["value"] === "string" ? p["value"] : String(p["value"] ?? "");
      }
    }
    out.push({ name, transport: "stdio", command, args, env, enabled: true });
  }
  return out;
}

/**
 * 启动 stdio 上的 ACP 服务端，直到 stdin 关闭才返回。
 *
 * 返回值是进程退出码（正常关闭 stdin → 0）。
 */
export async function runAcpServer(): Promise<number> {
  // 入站顺序闸门（PRD §2.2 备案 A）：SDK 的 receive() 不等待 handler，
  // 初始化闸门在 handler 之前就拒绝后续请求，所以排队必须发生在字节流上。
  // dispose 在闸门之后定义，EOF 回调通过这个可变槽转过去。
  let invokeDispose: () => void = () => undefined;
  // session 在下面才声明：cancel 闩通过这个槽转到 session.cancel()，
  // 必须在 SDK 异步处理通知之前同步落下。
  let invokeSessionCancel: (sessionId: string) => void = () => undefined;
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
    {
      onRawEnd: () => invokeDispose(),
      onSessionCancel: (sessionId) => invokeSessionCancel(sessionId),
    },
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
              // initialize 的响应写出之后 SDK 才放开初始化闸门。
              // 必须在这里 markInitialized，不能在 handler 里提前放行。
              inbound.markInitialized();
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
  invokeSessionCancel = (sessionId) => {
    if (!session || session.sessionId !== sessionId) {
      log(`session/cancel（入站闩）指向未知 session ${sessionId}（已忽略）`);
      return;
    }
    log(`session/cancel（入站闩）：${sessionId}`);
    session.cancel();
  };
  /** 同一 session 已有 prompt 在跑时，新的 session/prompt 回 -32603（PRD §2.8）。 */
  let prompting = false;
  /** 连接句柄：`connect()` 之后才有；通知与权限请求都经它发给客户端。 */
  let connection: AgentConnection | null = null;

  /**
   * 通知串行队列：`session/update` 必须按事件顺序写出，且 prompt 的响应要在
   * 本轮全部通知之后 —— 所以 `prompt()` 返回前 `flushNotifications()`。
   * 发送失败只进诊断：客户端断开不该把一轮对话变成 JSON-RPC 错误。
   */
  let notifyQueue: Promise<void> = Promise.resolve();
  const sendNotification = (notification: SessionNotification): void => {
    const run = notifyQueue.then(async () => {
      if (!session || !connection) return;
      await connection.client.notify(methods.client.session.update, notification);
    });
    notifyQueue = run.catch((err: unknown) => {
      log(`session/update 发送失败：${(err as Error).message}`);
    });
  };
  const flushNotifications = (): Promise<void> => notifyQueue;

  /**
   * 请求串行队列（PRD §2.3 的「initialize 之前收到其它请求 → -32600」）。
   *
   * 注意：**光靠这里修不好**。SDK 的初始化闸门在 handler 进入之前就拒绝了
   * 未初始化的请求，所以真正的排队在字节流层（`createInboundGate`）。
   * 这一层只保留给 `session/new`（保证响应写出的先后与请求到达一致、
   * 且第二次 session/new 仍稳定回 -32603）；`session/prompt` **不再串行**（复审 R7）。
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  /** 统一释放（复审 R3）：会话资源 + 入站流 + 连接，幂等。 */
  let disposed = false;
  /** session/new 装配中途断连：已拉起的 MCP 子进程由它收掉（第三轮 N3）。 */
  const hostGone = new AbortController();
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    hostGone.abort();
    try {
      session?.dispose();
    } catch (e) {
      log(`dispose 失败：${(e as Error).message}`);
    }
    // 结束入站流：SDK 的读循环随之结束，connection.closed 才能 resolve，进程才退得掉。
    try {
      void inbound.readable.cancel();
    } catch {
      /* 已关闭 */
    }
  };
  invokeDispose = dispose;
  // issue #75：shell 已 setsid 脱组，编辑器按进程组发 SIGTERM/SIGHUP（或人工 Ctrl-C）
  // 时必须先 dispose 再按 143/129/130 退出，否则后台 shell 与孙进程会留下写盘。
  const uninstallSignals = installFatalSignalHandlers({
    cleanup: () => dispose(),
  });

  /**
   * 装配一个 ACP 会话（`session/new` 与 `session/load` 共用）。
   *
   * 两条路径的唯一差别是 `resume`：传了就是接管已有会话文件（沿用原 sessionId、
   * 恢复历史），不传就新建。其余（模型配置、权限桥、MCP、通知回调）完全一致 ——
   * 复制一份会让两条路径悄悄漂移。
   */
  const assemble = (
    cfg: Config,
    cwd: string,
    mcpServers: McpServerConfig[],
    resume?: { meta: SessionMeta; messages: Message[] },
  ): Promise<AcpSession> => {
    // 通知回调在装配完成前就要能引用 sessionId：先占位，装配后回填。
    let created: AcpSession | null = null;
    const sid = (): string => created?.sessionId ?? "";
    return createAcpSession({
      cfg,
      cwd,
      signal: hostGone.signal,
      ...(resume ? { resume } : {}),
      onText: (text) => {
        // 助手文本 → agent_message_chunk（PRD §2.9）。通知先于 prompt 响应发出。
        sendNotification({
          sessionId: sid(),
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
      },
      onToolStart: (data: ToolStartEventData) => {
        // tool_start → tool_call（PRD §2.9）：pending，编辑器据此显示「要做什么」。
        const start = toolCallStartOf(data, cwd);
        sendNotification({
          sessionId: sid(),
          update: {
            sessionUpdate: "tool_call",
            toolCallId: start.toolCallId,
            title: start.title,
            kind: start.kind,
            status: start.status,
            ...(start.locations ? { locations: start.locations } : {}),
          },
        });
      },
      onToolEnd: (data: ToolEndEventData, oldText: string | null, argsJson: string | undefined) => {
        // tool_end → tool_call_update（PRD §2.10）：写工具带 diff，oldText/args 来自 tool_start 快照。
        const end = toolCallEndOf(data, cwd, oldText, argsJson);
        sendNotification({
          sessionId: sid(),
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: end.toolCallId,
            status: end.status,
            ...(end.content ? { content: end.content } : {}),
            ...(end.locations ? { locations: end.locations } : {}),
          },
        });
      },
      // 权限询问（PRD §2.11）：直接转成对客户端的 JSON-RPC 请求。
      permissionUi: {
        request: (params: RequestPermissionRequest) =>
          connection === null
            ? Promise.reject(new Error("连接尚未建立"))
            : connection.client.request<RequestPermissionResponse>(REQUEST_PERMISSION_METHOD, params),
      },
      // settings 的 permission_mode（与模型配置同一份 settings.json，工作区优先）：客户端不在/失败/超时时回退用。
      permissionMode: readPermissionMode(cfg.settingsPath),
      // 客户端在 session/new 里传入的 stdio MCP（PRD §2.7）：与 settings 的 mcpServers 合并。
      clientMcpServers: mcpServers,
      flushNotifications,
    }).then((s) => {
      created = s;
      return s;
    });
  };

  /** session/new 与 session/load 共用：先赋 session，再发命令广告并排空通知。 */
  const advertiseCommands = async (s: AcpSession): Promise<void> => {
    sendNotification({
      sessionId: s.sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: availableCommands() },
    });
    await flushNotifications();
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
    .onRequest(methods.agent.session.new, async ({ params }) =>
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
        // settings.json 从 **session cwd** 读（复审 R4）：编辑器给的工作区就是配置根，
        // 与 spawn 目录可以不同。TUI / -p 不传第二参数，行为不变。
        cfg = loadConfig({ cwd }, { settingsDir: cwd });
        resolveAndApplyModelWindow(cfg);
      } catch (e) {
        if (e instanceof ConfigError) {
          throw RequestError.internalError(undefined, `配置错误：${e.message}`);
        }
        throw e;
      }
      requireApiKey(cfg);

      const created = await assemble(cfg, cwd, clientMcpServers(params.mcpServers));
      session = created;
      log(`session/new：${created.sessionId}（工作区 ${cwd}）`);
      await advertiseCommands(created);

      const response: NewSessionResponse = { sessionId: created.sessionId, modes: modeState(created.currentMode()) };
      return response;
      }),
    )
    .onRequest(methods.agent.session.load, async ({ params }) =>
      serial(async () => {
      // cwd 校验与 session/new 同一口径（PRD §2.5）；单 session 同样只允许一次（issue #80）。
      const cwd = resolveWorkspace(params.cwd);
      if (session) {
        throw RequestError.internalError(
          undefined,
          `本进程只支持一个 session（已有 ${session.sessionId}）；session/load 不能替换它，请另起一个 neo acp 进程。`,
        );
      }
      if (typeof params.sessionId !== "string" || params.sessionId === "") {
        throw RequestError.invalidParams("session/load 需要 sessionId");
      }

      // 复用 `--resume` 的恢复路径：loadSession 读文件（含附件 hydrate）→ adoptSession 接管
      // 原 id / path / createdAt（不新建文件）→ createAcpSession 里 applyRestored 恢复消息。
      const stored = loadStoredSession(params.sessionId);
      if (!stored) {
        throw RequestError.invalidParams(`找不到会话 ${params.sessionId}（${sessionsDir()} 下没有匹配的会话文件）`);
      }
      // 工作区以本次请求的 cwd 为准（与 `--resume` 一致）：会话文件里的 cwd 只是历史记录，
      // 不把「从另一个目录续上」当成错误。

      let cfg: Config;
      try {
        cfg = loadConfig({ cwd }, { settingsDir: cwd });
        resolveAndApplyModelWindow(cfg);
      } catch (e) {
        if (e instanceof ConfigError) {
          throw RequestError.internalError(undefined, `配置错误：${e.message}`);
        }
        throw e;
      }
      requireApiKey(cfg);

      const adopted = adoptSession(stored.meta, cfg.model);
      const created = await assemble(cfg, cwd, clientMcpServers(params.mcpServers), {
        meta: adopted.meta,
        messages: stored.messages,
      });
      session = created;
      log(`session/load：${created.sessionId}（工作区 ${cwd}，${stored.messages.length} 条消息）`);
      await advertiseCommands(created);

      const response: LoadSessionResponse = { modes: modeState(created.currentMode()) };
      return response;
      }),
    )
    .onRequest(methods.agent.session.setMode, async ({ params }) => {
      // issue #80：档位只用 neo 已有的四个名字；Claude 的 acceptEdits / bypassPermissions
      // 之类一律 -32602，不静默映射（映射等于替用户改主意）。
      const current = session;
      if (!current || current.sessionId !== params.sessionId) {
        throw RequestError.sessionNotFound(params.sessionId);
      }
      const next = asPermissionMode(params.modeId);
      if (next === null) {
        throw RequestError.invalidParams(
          `未知权限模式 ${JSON.stringify(params.modeId)}（可选：ask / auto-edit / auto-all / plan）`,
        );
      }
      current.setMode(next);
      log(`session/set_mode：${current.sessionId} → ${next}`);
      // 先发通知再 flush：客户端拿到响应时 current_mode_update 已经在了。
      sendNotification({
        sessionId: current.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: next },
      });
      await flushNotifications();
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      // R7：**不串 serial()**。串行化会让第二个 prompt 堵在队头，挡住其后的 cancel 与
      // 权限响应（队头阻塞）。重叠判定改为在入口同步置位 `prompting`：
      // 置位必须在任何 await 之前，否则两个 handler 会同时通过检查。
      const current = session;
      if (!current || current.sessionId !== params.sessionId) {
        // 未知 session：-32002，并把请求里的 id 回带（PRD §2.3）。
        throw RequestError.sessionNotFound(params.sessionId);
      }
      if (prompting) {
        // 已有 prompt 在跑：立刻回 -32603，不第二次调模型（PRD §2.8）。
        throw RequestError.internalError(undefined, "该 session 已有一轮 prompt 在跑，不能并发");
      }
      prompting = true;
      try {
        const text = promptText(params.prompt);
        const { stopReason } = await current.prompt(text);
        // issue #80：prompt 结束后用真实计量发 usage_update，再 flush，保证通知先于响应。
        const usage = current.usage();
        sendNotification({
          sessionId: current.sessionId,
          update: { sessionUpdate: "usage_update", used: usage.used, size: usage.size },
        });
        await flushNotifications();
        const response: PromptResponse = { stopReason };
        return response;
      } catch (e) {
        // R9：引擎失败不得伪装 end_turn —— 转成可读的 JSON-RPC 错误（-32603）。
        throw acpPromptError(e);
      } finally {
        prompting = false;
      }
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      // cancel 是**通知**：不串进 serial()，否则要等 prompt 结束才被处理 —— 那就没有意义了。
      // 未知 session 只记诊断，不抛错（通知没有响应通道，抛错只会变成客户端错误日志）。
      const current = session;
      if (!current || current.sessionId !== params.sessionId) {
        log(`session/cancel 指向未知 session ${params.sessionId}（已忽略）`);
        return;
      }
      log(`session/cancel：${params.sessionId}`);
      current.cancel();
    })
    .onRequest("*", ({ method }) => {
      // 未实现的方法明确报 -32601，不返回假结果。
      throw RequestError.methodNotFound(method);
    });

  connection = app.connect(stream);
  log(`服务端已就绪（stdio NDJSON，ACP v${PROTOCOL_VERSION}）`);

  // 原始 stdin 结束/出错 → 统一 dispose（复审 R3）：在途 shell 必须停掉，
  // 不能在 stdin 关闭后继续写盘；入站流结束让 connection.closed 收口，进程才能退出。
  process.stdin.on("end", () => {
    log("stdin 已关闭，释放会话");
    dispose();
  });
  process.stdin.on("error", (err) => {
    log(`stdin 出错：${err.message}`);
    dispose();
  });
  // stdout 写出失败（编辑器已断开）→ 同样 dispose：协议通道没了，继续跑没有意义。
  process.stdout.on("error", (err) => {
    log(`stdout 写出失败：${err.message}`);
    dispose();
  });

  // 不在这里退出：连接要一直读到 stdin 关闭（编辑器随时可能发下一条请求）。
  await connection.closed;
  // 连接结束（stdin EOF / 流被取消）后确保资源释放，再让进程退出。
  uninstallSignals();
  dispose();
  return 0;
}
