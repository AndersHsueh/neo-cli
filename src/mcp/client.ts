/**
 * MCP 客户端管理器（issue #2）：连接、握手、列工具、调用、清理。
 *
 * 设计取舍：
 *  - **单个 server 失败不拖垮整体**：connectAll 逐条 try/catch，失败只记
 *    `{ status:"error", error:"…" }`，其余 server 照常连接，主循环不受影响。
 *  - **不重连**：MCP server 挂了就是挂了，工具调用会给出「连接已断开」，
 *    用户可用 /mcp 看到状态并重启 neo。自动重连会让「为什么又慢了一秒」难以解释。
 *  - **工具注册与连接解耦**：连接成功才注册工具，注册返回的注销函数统一持有，
 *    closeAll 时一并注销 —— 测试里单进程共享模块表，不注销会污染其它测试。
 *  - **两阶段连接**（stable-names 轮）：先把所有 server 握手 + 列工具做完，
 *    再统一算注册名、统一注册。名字是整批工具集合的纯函数（见 tool.ts 的
 *    computeMcpNames），因此与连接顺序无关；也就不需要「分配器 + 失败回滚」。
 */
import type { McpServerConfig } from "../config.ts";
import { registerTool } from "../tools/index.ts";
import { StdioRpc, type McpRpc } from "./jsonrpc.ts";
import { HttpRpc } from "./httpRpc.ts";
import { computeMcpNames, makeMcpTool } from "./tool.ts";

/** tools/list 返回的工具条目（只取我们真正用到的字段）。 */
export interface McpToolInfo {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: unknown;
}

export type McpServerStatus = "connected" | "error" | "disabled" | "pending";

/** 一个已注册 MCP 工具的对外描述：本地注册名 ↔ 远端原名。 */
export interface McpToolEntry {
  /** 模型侧看到的函数名（已合法化，满足 ^[a-zA-Z0-9_-]{1,64}$）。 */
  name: string;
  /** 远端原始工具名（tools/call 用它）。 */
  remote: string;
}

export interface McpServerState {
  name: string;
  /** 传输类型（issue #29）：stdio 本地进程 / http 远程。 */
  transport?: "stdio" | "http";
  status: McpServerStatus;
  /** 已注册（真正可用）的工具。`tools` 是它的名字投影，保留给老调用方。 */
  toolEntries?: McpToolEntry[];
  /** 已注册的工具名（含 mcp__ 前缀）。只含**注册成功**的 —— 注册失败的不能算可用。 */
  tools: string[];
  /**
   * 注册失败的工具（重名 / 名字非法等）。它们**不在** tools 里，
   * 也不在模型工具清单里；/mcp 会以「不可用」显式列出，而不是静默消失。
   */
  rejected?: Array<{ remote: string; name: string; reason: string }>;
  /** 失败原因（人话，含 server 名）。 */
  error?: string;
  /** 握手后的服务端信息（排障用）。 */
  serverInfo?: { name?: string; version?: string };
  /** 连接耗时（毫秒），排障用。 */
  connectMs?: number;
}

export interface McpClientOptions {
  /** 单次请求超时（毫秒）。测试可调小。 */
  requestTimeoutMs?: number;
  /** 握手超时（毫秒）。npx 冷启动拉包可能慢，默认比普通请求宽松。 */
  connectTimeoutMs?: number;
  /** 每个 server 的 stderr 一行（默认丢弃；排障时可接 ui.info）。 */
  onStderr?: (server: string, line: string) => void;
}

interface Live {
  cfg: McpServerConfig;
  rpc: McpRpc;
  tools: McpToolInfo[];
  /** 注册名 → 远端原名（tools/call 用远端名，注册名只是本地别名）。 */
  entries: McpToolEntry[];
}

/**
 * 阶段一的握手结果。成功带 rpc + 工具清单，失败带可读错误。
 *
 * 用判别联合而不是「抛异常 + 外层 try」：connectAll 要在**全部**握手结束后
 * 才统一注册，失败信息得先存下来，不能中途抛出去打断 Promise.all。
 */
type Handshake =
  | {
      ok: true;
      cfg: McpServerConfig;
      rpc: McpRpc;
      tools: McpToolInfo[];
      serverInfo?: { name?: string; version?: string };
      connectMs: number;
    }
  | { ok: false; cfg: McpServerConfig; error: string; connectMs: number };

/** 握手协议版本：与主流 server 兼容的稳定版本。 */
const PROTOCOL_VERSION = "2024-11-05";

export class McpManager {
  private live = new Map<string, Live>();
  private states = new Map<string, McpServerState>();
  private unregisters: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly configs: McpServerConfig[],
    private readonly opts: McpClientOptions = {},
  ) {}

  /** 全部 server 的状态快照（按配置顺序，含未连接/失败的）。 */
  statuses(): McpServerState[] {
    return this.configs.map(
      (c) =>
        this.states.get(c.name) ?? {
          name: c.name,
          transport: c.transport,
          status: c.enabled ? "pending" : "disabled",
          tools: [],
        },
    );
  }

  /** 已注册的 MCP 工具总数。 */
  toolCount(): number {
    return this.unregisters.length;
  }

  /**
   * 连接全部已启用的 server 并注册工具。
   *
   * 永不抛错：任何异常都收敛成该 server 的 error 状态。
   * 返回本次新注册的工具数（0 = 没有任何外部工具可用）。
   *
   * **两阶段**（stable-names 轮）：先并行连接 + `tools/list` 拿到全部工具清单，
   * 再统一算名字、统一注册。上一版是「连上就注册、连上就分配名字」，
   * 而并行连接意味着分配顺序不确定 —— 同一 (server, tool) 的名字会随
   * 谁先连上而变。现在名字是**整批工具集合的纯函数**（computeMcpNames），
   * 与连接顺序无关。
   */
  async connectAll(): Promise<number> {
    const enabled = this.configs.filter((c) => c.enabled);
    for (const c of this.configs) {
      if (!c.enabled)
        this.states.set(c.name, { name: c.name, transport: c.transport, status: "disabled", tools: [] });
    }
    // 阶段一：并行连接（npx 冷启动可能要几秒，串行会把启动时间累加）。
    const handshakes = await Promise.all(enabled.map((c) => this.handshake(c)));
    // 阶段二：整批定名 + 注册（顺序无关，见 computeMcpNames）。
    this.registerAll(handshakes);
    return this.unregisters.length;
  }

  /**
   * 阶段一：拉起进程、握手、列工具。**不注册任何工具**。
   *
   * 失败在这里就被收敛成 error 状态：此时还没有任何工具被注册，
   * 因此不需要「回滚已注册工具」这一步（上一版需要，因为它在循环里边连边注册）。
   */
  private async handshake(cfg: McpServerConfig): Promise<Handshake> {
    const started = Date.now();
    const timeoutMs = this.opts.connectTimeoutMs ?? 30_000;
    // issue #29：传输层分支。stdio 要拉子进程；http 直接对端点发 POST。
    const requestTimeoutMs = this.opts.requestTimeoutMs ?? 20_000;
    const rpc: McpRpc =
      cfg.transport === "http"
        ? new HttpRpc({ url: cfg.url, headers: cfg.headers, requestTimeoutMs })
        : new StdioRpc({
            command: cfg.command,
            args: cfg.args,
            env: cfg.env,
            cwd: cfg.cwd,
            requestTimeoutMs,
            onStderr: (line) => this.opts.onStderr?.(cfg.name, line),
          });

    try {
      if (rpc instanceof StdioRpc) rpc.start();
      const init = await withTimeout(
        rpc.request<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string } }>(
          "initialize",
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "neo", version: "0" },
          },
        ),
        timeoutMs,
        `initialize 超时（${timeoutMs}ms）`,
      );
      await rpc.notify("notifications/initialized");

      const listed = await withTimeout(
        rpc.request<{ tools?: unknown }>("tools/list", {}),
        timeoutMs,
        `tools/list 超时（${timeoutMs}ms）`,
      );
      return {
        ok: true,
        cfg,
        rpc,
        tools: normalizeTools(listed?.tools),
        serverInfo: init?.serverInfo,
        connectMs: Date.now() - started,
      };
    } catch (e) {
      // 握手失败：进程收掉，状态记 error。此时一个工具都还没注册，
      // 不存在「状态 error 但工具还在注册表里可调」的矛盾状态。
      rpc.close();
      return { ok: false, cfg, error: describeError(cfg, e, rpc), connectMs: Date.now() - started };
    }
  }

  /**
   * 阶段二：给全部成功握手的 server 的工具统一算名字并注册。
   *
   * 名字由 computeMcpNames 一次性算出（纯函数，输入是全部 (server, tool) 的集合），
   * 因此**不需要任何「分配/释放」记账**：没有先到先得，也就没有「注册失败后
   * 把占住的名字还回去」这回事。名字只取决于集合本身，注册成功与否都不影响
   * 其它工具的命名。
   */
  private registerAll(handshakes: Handshake[]): void {
    const live = handshakes.filter((h): h is Extract<Handshake, { ok: true }> => h.ok);
    const names = computeMcpNames(
      live.flatMap((h) => h.tools.map((t) => ({ server: h.cfg.name, tool: t.name }))),
    );

    for (const h of handshakes) {
      if (!h.ok) {
        this.states.set(h.cfg.name, {
          name: h.cfg.name,
          transport: h.cfg.transport,
          status: "error",
          tools: [],
          error: h.error,
          connectMs: h.connectMs,
        });
        continue;
      }
      const entries: McpToolEntry[] = [];
      const rejected: Array<{ remote: string; name: string; reason: string }> = [];
      for (const info of h.tools) {
        // 注册名由整批定名结果给：合法化 + 防碰撞。远端原名只用于 tools/call。
        const name = names.get(`${h.cfg.name}\u0000${info.name}`) ?? "";
        try {
          const impl = makeMcpTool({
            server: h.cfg.name,
            info,
            name,
            call: (toolName, args) => this.callTool(h.cfg.name, toolName, args),
          });
          const un = registerTool(impl);
          this.unregisters.push(un);
          entries.push({ name, remote: info.name });
        } catch (e) {
          // 重名（例如与内置工具撞名）不该拖垮连接，但**必须**记进 rejected：
          // 注册失败的工具不在工具清单里，若还出现在 /mcp 的「已连接工具」下，
          // 用户会以为它可用。
          const reason = (e as Error).message;
          rejected.push({ remote: info.name, name, reason });
          this.opts.onStderr?.(h.cfg.name, `工具 ${name} 注册失败：${reason}`);
        }
      }
      this.live.set(h.cfg.name, { cfg: h.cfg, rpc: h.rpc, tools: h.tools, entries });
      this.states.set(h.cfg.name, {
        name: h.cfg.name,
        transport: h.cfg.transport,
        status: "connected",
        toolEntries: entries,
        tools: entries.map((t) => t.name),
        ...(rejected.length > 0 ? { rejected } : {}),
        serverInfo: h.serverInfo,
        connectMs: h.connectMs,
      });
    }
  }

  /**
   * 调一次 tools/call，把结果压成给模型看的文本。
   *
   * MCP 的结果是 content 数组（text / image / resource）。这里只取 text：
   * 图片进不了文本工具结果，塞 base64 只会烧上下文 —— 明确说「有图但没展示」，
   * 比静默丢掉更有用。isError=true 抛错，由上层转成工具错误。
   */
  private async callTool(server: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const live = this.live.get(server);
    if (!live || !live.rpc.alive) {
      throw new Error(`MCP server "${server}" 未连接或连接已断开，请用 /mcp 查看状态`);
    }
    let res: unknown;
    try {
      res = await live.rpc.request("tools/call", { name: toolName, arguments: args });
    } catch (e) {
      throw new Error(`MCP server "${server}" 调用 ${toolName} 失败：${(e as Error).message}`);
    }
    return formatCallResult(server, toolName, res);
  }

  /** 关闭所有连接并注销工具。幂等。 */
  closeAll(): void {
    if (this.closed) return;
    this.closed = true;
    for (const un of this.unregisters) {
      try {
        un();
      } catch {
        /* 已被其它路径注销 */
      }
    }
    this.unregisters = [];
    for (const [, l] of this.live) l.rpc.close();
    this.live.clear();
  }
}

/** 把 tools 数组收敛成合法条目（防 server 返回脏数据）。 */
function normalizeTools(raw: unknown): McpToolInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: McpToolInfo[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    const name = typeof t["name"] === "string" ? t["name"].trim() : "";
    // 远端工具名本身不受 OpenAI 命名约束（`files.read`、中文名都合法），
    // 它只在 tools/call 里原样回传；注册名由 McpNameAllocator 合法化。
    // 这里只挡「空名」与「含控制字符」这类必然坏掉的名字。
    if (!name || /[\u0000-\u001f\u007f]/.test(name)) continue;
    out.push({
      name,
      description: typeof t["description"] === "string" ? t["description"] : undefined,
      title: typeof t["title"] === "string" ? t["title"] : undefined,
      inputSchema: t["inputSchema"],
    });
  }
  return out;
}

/** tools/call 结果 → 文本。 */
export function formatCallResult(server: string, toolName: string, res: unknown): string {
  const r = (typeof res === "object" && res !== null ? res : {}) as Record<string, unknown>;
  const content = Array.isArray(r["content"]) ? r["content"] : [];
  const parts: string[] = [];
  let skippedImages = 0;
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    if (c["type"] === "text" && typeof c["text"] === "string") {
      parts.push(c["text"]);
    } else if (c["type"] === "image") {
      skippedImages++;
    } else if (c["type"] === "resource" && typeof c["resource"] === "object" && c["resource"] !== null) {
      const res = c["resource"] as Record<string, unknown>;
      if (typeof res["text"] === "string") parts.push(res["text"]);
      else if (typeof res["uri"] === "string") parts.push(`[resource] ${res["uri"]}`);
    }
  }
  if (skippedImages > 0) parts.push(`[${skippedImages} 个图片结果未展示：文本工具结果不支持图片]`);

  const text = parts.join("\n").trim();
  const isError = r["isError"] === true;
  if (isError) {
    // 远端已经说了「这是错误」，就把它的原话交给模型，别再加一层前缀。
    throw new Error(text || `MCP server "${server}" 的 ${toolName} 返回 isError 但无内容`);
  }
  if (text === "") return `（MCP server "${server}" 的 ${toolName} 返回空结果）`;
  return text;
}

/** 失败原因拼成人话：server 名 + 原因 + stderr 尾巴（npx 的报错都在 stderr）。 */
function describeError(cfg: McpServerConfig, e: unknown, rpc: McpRpc): string {
  const msg = (e as Error)?.message ?? String(e);
  const tail = rpc.stderrTail.slice(-2).join(" / ");
  const target = cfg.transport === "http" ? cfg.url : cfg.command;
  const label = cfg.transport === "http" ? "HTTP" : "stdio";
  return `MCP server "${cfg.name}"（${label} ${target}）连接失败：${msg}${tail ? `｜${tail}` : ""}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
