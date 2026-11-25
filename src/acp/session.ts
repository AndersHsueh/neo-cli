/**
 * ACP 会话装配（issue #60，PRD §2.5–§2.9 / §2.12）。
 *
 * 与 `src/cli/sessionStart.ts` 的关系：**同一套执行引擎**（`Agent.send()`），
 * 但宿主是编辑器而不是 TUI，因此这里只做「Agent + 工具 + 记忆」的装配，
 * 明确跳过 TUI 专属件：composer / dock / 输入层 / 跨会话信箱 / 定时循环。
 * 这不是 `src/session.ts` 的会话 JSON 落盘模块。
 *
 * 记忆口径（PRD §2.12）：ACP 是**交互会话**，`scopeMode: "both"`（用户级+项目级）。
 * 不走 `-p` 的 oneshot 口径 —— bootstrap 里 oneshot 会把 `cfg.memory.scopeMode`
 * 降成 "project"，那条路径在 ACP 里根本不经过。
 *
 * stdout 纪律（PRD §2.1）：stdout 只归协议 NDJSON。给 Agent 的 console 全部写 stderr，
 * 不依赖 NO_COLOR 之类的环境变量碰运气。
 */
import { join } from "node:path";
import type { Config, McpServerConfig } from "../config.ts";
import { chatStream, type Message } from "../llm.ts";
import {
  collectNestedInstructionFiles,
  composePermanentMemory,
  formatNestedAgentsBlock,
  loadSessionInstructionMemory,
} from "../cli/nestedAgents.ts";
import { workRoots } from "../cli/additionalDirs.ts";
import { ModelFallbackController } from "../modelFallback.ts";
import { Agent } from "../agent.ts";
import type { AgentEvent, AssistantMessageEventData, PermissionMode, ToolEndEventData, ToolStartEventData } from "../agent/types.ts";
import { createPermissionBridge, type PermissionUi } from "./permission.ts";
import { isWriteTool, pathOfArgs, snapshotOldText, toolKind } from "./tools.ts";
import { usageOf } from "./followup.ts";
import { Console } from "../ui/console.ts";
import { PromptManager } from "../prompt/manager.ts";
import { createMemoryBridge, type MemoryBridge } from "../memory/bridge.ts";
import { formatCapabilityGapHint, recordModelContext, resolveAndApplyModelWindow } from "../env/modelWindows.ts";
import { writeBackContextLimit, writeBackOutputLimit } from "../env/modelCaps.ts";
import { loadEnv } from "../env/probe.ts";
import { syncEnvPage } from "../env/wiki.ts";
import { ensureScopeLayout } from "../memory/layout.ts";
import { discoverProjectRules, extractTouchedPaths, formatAlwaysOnRules, formatScopedRulesBlock, selectScopedRules } from "../rules/index.ts";
import { registerTool } from "../tools/index.ts";
import { registerWikiTools } from "../tools/wiki.ts";
import { makeRememberTool } from "../tools/memory.ts";
import { makeTaskTool, runSubagent } from "../tools/task.ts";
import { makeTodoWriteTool, type TodoItem } from "../tools/todo.ts";
import { persist } from "../cli/sessions.ts";
import { applyRestored, createSession, type SessionMeta } from "../session.ts";
import type { UsageUpdate } from "@agentclientprotocol/sdk";
import { CheckpointStore } from "../checkpoint.ts";
import { McpManager } from "../mcp/index.ts";
import { backgroundShells } from "../tools/backgroundShell.ts";
import { cleanupEphemeral } from "../cleanup.ts";
import { sessionMonitors } from "../monitors.ts";
import { runAcpTurn, type AcpStopReason } from "./turn.ts";

/** 诊断只走 stderr：stdout 是协议通道。 */
function log(message: string): void {
  process.stderr.write(`[acp] ${message}\n`);
}

export type { AcpStopReason } from "./turn.ts";

/** 装配好的 ACP 会话。 */
export interface AcpSession {
  sessionId: string;
  cwd: string;
  agent: Agent;
  /** 跑一轮用户输入；返回 stopReason（映射见 `AcpStopReason`）。 */
  prompt(text: string): Promise<{ stopReason: AcpStopReason }>;
  /** `session/cancel`：中止在途的模型请求与工具。 */
  cancel(): void;
  /**
   * 当前上下文用量（issue #80 的 `usage_update`）：`used` 是
   * `estimateTokens(messages, 当前工具规格)`，`size` 是 `cfg.contextWindow`。
   */
  usage(): UsageUpdate;
  /** 当前权限档位（`session/set_mode` 的 `currentModeId` 来源）。 */
  currentMode(): PermissionMode;
  /**
   * 切换权限档位（`session/set_mode`）：权限桥与 `Agent.mode` **一起**改，
   * 否则会出现「工具清单按旧档位、审批按新档位」的第二条旁路。
   */
  setMode(mode: PermissionMode): void;
  /**
   * 释放会话资源（复审 R3 / 第三轮 N1）：结束在途权限询问、中止在途模型请求与工具、
   * 收掉后台 shell（**都不能在 stdin 关闭后继续写盘**）、关闭 MCP 连接。幂等。
   */
  dispose(): void;
}

export interface CreateAcpSessionOptions {
  cfg: Config;
  cwd: string;
  /** 助手文本增量（PRD §2.9：`agent_message_chunk`）。 */
  onText: (text: string) => void;
  /** 工具事件（PRD §2.9/§2.10）：tool_call / tool_call_update。 */
  onToolStart?: (data: ToolStartEventData) => void;
  /**
   * 工具结束。`oldText` 是写工具在 tool_start 时快照的旧内容（新文件/非写工具为 null），
   * `argsJson` 是同一 call 在 tool_start 时的原始参数（tool_end.paths 不足以还原绝对路径）。
   */
  onToolEnd?: (data: ToolEndEventData, oldText: string | null, argsJson: string | undefined) => void;
  /** 编辑器侧权限询问（PRD §2.11）；null = 回退 settings 权限模式。 */
  permissionUi?: PermissionUi | null;
  /** settings 的权限模式（回退用）。 */
  permissionMode?: PermissionMode;
  /**
   * 客户端在 `session/new` 里传入的 stdio MCP server（PRD §2.7 / 复审 R5）。
   * 已由 server 归一成 `McpServerConfig`；HTTP/SSE 形态不在这里出现（未支持，不广告）。
   */
  clientMcpServers?: McpServerConfig[];
  /**
   * 等通知队列排空（server 注入）：`prompt()` 返回前必须把本轮所有
   * `session/update` 都 await 完，否则通知可能晚于 prompt 的响应写出。
   */
  flushNotifications?: () => Promise<void>;
  /**
   * 宿主断连（server dispose）信号：`session/new` 还在等 MCP 握手时 stdin 就关了，
   * 已拉起的 MCP 子进程也必须收掉（第三轮 N3）—— 此时还没有 AcpSession 可 dispose。
   */
  signal?: AbortSignal;
  /**
   * `session/load`（issue #80）：接管已有会话文件而不是新建。
   *
   * 由 server 用 `src/session.ts` 的 `loadSession()` 读出、`adoptSession()` 接管后传入。
   * 传了就**沿用原 sessionId**、不再 `createSession`（不新建会话文件）。
   */
  resume?: { meta: SessionMeta; messages: Message[] };
  /**
   * 测试注入主会话 LLM 流（与 `Agent.opt.chatStream` 同口径）。
   * 提供时同时交给备用链 controller 与 compact 等非主路径。
   * 缺省走真实 `chatStream`。
   */
  chatStream?: typeof chatStream;
}

/**
 * 以 `cwd` 为工作区建一个 ACP 会话。
 *
 * 调用方（`src/acp/server.ts`）已保证：cwd 是绝对路径、目录存在、单进程单 session。
 * 这里不再重复校验，但任何装配失败都直接抛错 —— 由调用方转成 JSON-RPC 错误，
 * 绝不返回一个假的 sessionId。
 */
export async function createAcpSession(opts: CreateAcpSessionOptions): Promise<AcpSession> {
  const { cfg, cwd, onText } = opts;
  // ACP 是交互会话：显式钉死 both，避免 loadConfig 缺省或外界把 scopeMode 降成 project。
  cfg.memory.scopeMode = "both";

  // 权限模式：settings 的 permission_mode（server 从 loadConfig 选中的同一份 settings.json 读，工作区优先，复审 R4），
  // 缺省 "ask"（与 `neo` 默认一致）。绝不因为走 ACP 就悄悄放宽成 auto-all。
  // issue #80：`session/set_mode` 会在会话中途改它，所以是可变状态，权限桥读闭包。
  let mode: PermissionMode = opts.permissionMode ?? "ask";

  // 会话文件：`session/load` 时接管已有文件（沿用原 id / path / createdAt，不新建），
  // 否则新建。记忆桥需要 sessionId 作为审计键（与 sessionStart 同一顺序）。
  const sess = opts.resume
    ? { meta: opts.resume.meta, save: () => undefined }
    : createSession(cfg.model, cwd);
  const sessionId = sess.meta.id;

  // 输出层：所有人类可读文本写 stderr。非 TTY 形态（stdoutIsTTY=false）避免
  // 任何 ANSI 动画/紧凑行，即便 stderr 是终端也不污染日志。
  const ui = new Console(cfg.theme === "matrix", cfg.toolcallInfoDetails, {
    stdoutIsTTY: false,
    stdinIsTTY: false,
    getTier: () => cfg.modelTier,
    write: (s: string) => {
      process.stderr.write(s);
    },
  });

  // 记忆：交互口径（both）。绝不传 "oneshot"。
  const memory: MemoryBridge = createMemoryBridge({
    cfg,
    cwd,
    sessionId,
    mode: "interactive",
    captureEnabled: true,
    onNotice: (m) => ui.info(m),
  });

  const promptManager = new PromptManager({
    // 信箱在 ACP 默认关（PRD §2.12）：不注册 send_message / list_peers，提示词里也不提。
    mailbox: false,
    askUser: false,
    // issue #100：暂不向 ACP 暴露 monitor（系统提示去掉那一行）。CLI 默认仍暴露。
    monitor: false,
    sessionName: null,
  });

  const projectRules = discoverProjectRules(cwd);
  const scopedRuleList = projectRules.filter((r) => r.paths.length > 0);

  // ---- 权限桥（PRD §2.11）----
  // 判定顺序在桥里：decidePermission 说 allow → 直接放行；plan → 拒绝；
  // needs-confirm → 问编辑器；客户端不在/失败/超时 → 回退 settings 模式（不放宽）。
  let cancelled = false;
  /** 本轮最后一次模型响应是否是无工具调用的正文收口（N2）。 */
  let answeredLastIteration = false;
  const permissionBridge = createPermissionBridge({
    mode,
    ui: opts.permissionUi ?? null,
    sessionId,
    isCancelled: () => cancelled,
    log,
  });

  /** 最近一次 tool_start 的上下文：tool_end 事件里没有原始参数，diff/locations 要用它。 */
  let lastToolStart: { call_id: string; name: string; args: string } | null = null;
  /** 写工具在 tool_start 时的旧内容快照（按 call_id），供 tool_end 出 diff。 */
  const oldTextByCall = new Map<string, string | null>();
  /** 同一 call 的原始参数：tool_end.paths 是 cwd 相对且工作区外为空，diff 必须用这个。 */
  const argsByCall = new Map<string, string>();

  // 溢出写回的能力缺口提示：只走 stderr，每个 provider|model 一次，不扩协议。
  const announcedCapabilityGap = new Set<string>();
  const announceCapabilityGap = (): void => {
    const key = `${cfg.providerName}|${cfg.model}`;
    if (announcedCapabilityGap.has(key)) return;
    const hint = formatCapabilityGapHint(cfg);
    if (!hint) return;
    announcedCapabilityGap.add(key);
    log(`能力缺口：${hint}`);
  };

  // #59：有链才建 controller；只包主 Agent 请求。链空与 CLI 一样不建。
  const fallbackController =
    (cfg.modelFallback?.length ?? 0) > 0
      ? new ModelFallbackController({
          cfg,
          fallbacks: cfg.modelFallback,
          ...(opts.chatStream ? { stream: opts.chatStream } : {}),
          onNotice: (m) => ui.warn(m),
          onFallback: (e) => {
            ui.warn(
              `[fallback] ${e.from.provider}:${e.from.model} → ${e.to.provider}:${e.to.model}` +
                `（${e.reason.code}：${e.reason.message}）`,
            );
          },
        })
      : null;

  const agent = new Agent({
    cfg,
    console: ui,
    // 权限模式来自 settings 的 permission_mode（缺省 ask），不再硬编码。
    mode,
    ...(opts.chatStream ? { chatStream: opts.chatStream } : {}),
    // #59：只有主 Agent 请求经过备用链；compact / subagent 走既有路径。
    ...(fallbackController
      ? {
          mainChatStream: (
            c2: Config,
            m: Parameters<typeof chatStream>[1],
            t: Parameters<typeof chatStream>[2],
            h?: Parameters<typeof chatStream>[3],
            s?: AbortSignal,
          ) => fallbackController.stream(c2, m, t, h, s),
          isFallbackActive: () => fallbackController.isActive,
        }
      : {}),
    systemPrompt: promptManager.render(cfg).text,
    renderSystemPrompt: () => promptManager.render(cfg, { mcpLoaded: agent.mcpLoadedNames() }).text,
    // issue #104：与 CLI 同一条收窄。monitor 已由 excludeTools 拿掉，不在候选里。
    visibleToolNames: () => promptManager.runtimeToolNames(cfg, { mcpLoaded: agent.mcpLoadedNames() }),
    getSessionName: () => null,
    toolPathsOf: (name, argsJson) => extractTouchedPaths(name, argsJson, cwd),
    scopedRulesPrompt: (touched) => {
      if (scopedRuleList.length === 0) return null;
      const matches = selectScopedRules(scopedRuleList, touched, { cwd });
      const text = formatScopedRulesBlock(matches);
      return text === "" ? null : { text, matches };
    },
    // issue #54：嵌套指令按需注入。roots 用现有 workRoots（通常只有主根），不给 ACP 加 --add-dir。
    nestedAgentsPrompt: (touched) => {
      if (cfg.safeMode) return null;
      const perm = composePermanentMemory(cwd, cfg.additionalDirs ?? []);
      const files = collectNestedInstructionFiles({
        roots: workRoots({ cwd, additionalDirs: cfg.additionalDirs }),
        touched,
        exclude: perm?.files.map((f) => f.path),
      });
      const text = formatNestedAgentsBlock(files);
      return text === "" ? null : { text, files };
    },
    memory,
    checkpoint: new CheckpointStore({ cwd, sessionId }),
    sessionId,
    hooks: cfg.hooks,
    // 目标锚 / 信箱在 ACP 默认关：不读、不写。
    readGoal: () => null,
    refreshContextWindow: () => resolveAndApplyModelWindow(cfg),
    onContextLimit: (tokens) => {
      recordModelContext(cfg, {
        contextWindow: tokens,
        source: "overflow_error",
        evidence: "服务端上下文溢出错误",
      });
      writeBackContextLimit(cfg, tokens);
    },
    onOutputLimit: () => {
      void writeBackOutputLimit(cfg)
        .then((r) => {
          if (r.written.length > 0) {
            ui.info(`已从网关 /models 补上：${r.written.join("、")}（只写空字段）。`);
          }
          announceCapabilityGap();
        })
        .catch(() => {
          /* 探测/写回失败不影响重试 */
        });
    },
    // 编辑器里没有 TUI 提问模态，ask_user 不注册。
    nonInteractive: true,
    // issue #100：宿主侧排除 monitor；不要用 toolAllowlist 反做黑名单。
    excludeTools: ["monitor"],
    // 审批走权限桥：decidePermission 已在 makeCtx 里先判过（plan/allow 不会到这里），
    // 这里只处理 needs-confirm —— 问编辑器，或（客户端不在/失败/超时）回退 settings。
    approve: async (tool, detail) => {
      // 工具串行执行，最近一次 tool_start 就是本次审批的对象（拿 call_id 与路径）。
      const start = lastToolStart?.name === tool ? lastToolStart : null;
      const path = start ? pathOfArgs(start.args, cwd) : null;
      const outcome = await permissionBridge.ask(tool, {
        toolCallId: start?.call_id ?? tool,
        title: detail === "" ? tool : `${tool} ${detail}`,
        kind: toolKind(tool),
        ...(path ? { locations: [{ path }] } : {}),
      });
      if (outcome === "allow") return true;
      if (outcome === "cancel") {
        // 用户取消：先中止本轮，再按拒绝处理（工具不执行）。
        cancelled = true;
        agent.cancel();
      }
      return false;
    },
    onEvent: (e: AgentEvent) => {
      if (e.type === "assistant_message") {
        const data = e.data as AssistantMessageEventData;
        answeredLastIteration = data.tool_calls.length === 0 && data.content.trim() !== "";
        return;
      }
      if (e.type === "text" && typeof e.data === "string" && e.data !== "") {
        onText(e.data);
        return;
      }
      if (e.type === "tool_start") {
        const data = e.data as ToolStartEventData;
        lastToolStart = { call_id: data.call_id, name: data.name, args: data.args };
        argsByCall.set(data.call_id, data.args);
        // 写工具的旧内容必须在写盘前快照：等 tool_end 再读就已经是新内容了。
        if (isWriteTool(data.name)) {
          const path = pathOfArgs(data.args, cwd);
          oldTextByCall.set(data.call_id, path ? snapshotOldText(path) : null);
        }
        opts.onToolStart?.(data);
        return;
      }
      if (e.type === "tool_end") {
        const data = e.data as ToolEndEventData;
        // 通知发送（含 await client.notify）在 server 的回调里排队，
        // 这里只按顺序把事件交出去 —— onEvent 是同步的，不能在这里 await。
        opts.onToolEnd?.(data, oldTextByCall.get(data.call_id) ?? null, argsByCall.get(data.call_id));
        oldTextByCall.delete(data.call_id);
        argsByCall.delete(data.call_id);
      }
    },
  });

  // ---- 工具注册：与 sessionStart 同一批运行时工具，但跳过信箱与 TUI 专属 ----
  // 记下注销函数：单测同进程会多次 createAcpSession，dispose 时必须摘掉，
  // 否则第二次 registerTool 会抛「已注册」，也会污染其它测试的工具清单。
  const unregisters: Array<() => void> = [];
  unregisters.push(
    registerTool(
      makeTaskTool({
        run: (prompt, tier, ctx, promptTier, agentName) =>
          runSubagent(agent, prompt, tier, ctx, promptTier, undefined, { agentName }, agentName),
      }),
    ),
  );
  unregisters.push(registerWikiTools(registerTool));
  unregisters.push(registerTool(makeRememberTool({ remember: (body, scope) => memory.remember(body, scope) })));

  let sessionTodos: TodoItem[] = Array.isArray(sess.meta.todos) ? sess.meta.todos : [];
  unregisters.push(
    registerTool(
      makeTodoWriteTool({
        get: () => sessionTodos,
        set: (items) => {
          sessionTodos = items;
          sess.meta.todos = items;
        },
        persist: () => persist(agent.messages, sess.meta),
      }),
    ),
  );

  // 运行时工具注册完再刷新系统提示：`可用工具` 行由 toolNames() 现取。
  promptManager.invalidate();
  agent.refreshSystemPrompt();

  // ---- MCP 外部工具（PRD §2.7 / 复审 R5）----
  // 两个来源合并：settings.json 的 mcpServers（只认本地，模板里的示例不启动）+
  // 客户端在 session/new 里传入的 stdio server。重名以 settings 为准（用户自己的配置优先）。
  // 单个 server 失败只记诊断，不阻塞 session/new；连完再刷新系统提示，模型第一轮就能看见 mcp__*。
  const mcpConfigs: McpServerConfig[] = [...(cfg.mcpServers ?? [])];
  const takenNames = new Set(mcpConfigs.map((c) => c.name));
  for (const c of opts.clientMcpServers ?? []) {
    if (takenNames.has(c.name)) {
      log(`MCP：客户端传入的 "${c.name}" 与 settings 重名，按 settings 的配置处理`);
      continue;
    }
    takenNames.add(c.name);
    mcpConfigs.push(c);
  }
  let mcpManager: McpManager | null = null;
  if (mcpConfigs.length > 0) {
    mcpManager = new McpManager(mcpConfigs, {
      // server 的 stderr 很吵（npx 进度、日志），默认丢弃；这里只留一行诊断位。
      onStderr: (server, line) => {
        void server;
        void line;
      },
      // 握手超时要短：假/坏 server 不能把 session/new 卡住 30 秒。
      // 子进程在 start() 时已经拉起（R5 的「已启动」以此为准）；握手失败只记诊断。
      connectTimeoutMs: 4_000,
    });
    const manager = mcpManager;
    if (opts.signal?.aborted) manager.closeAll();
    else opts.signal?.addEventListener("abort", () => manager.closeAll(), { once: true });
    try {
      const n = await mcpManager.connectAll();
      if (n > 0) log(`MCP：已接入 ${n} 个外部工具`);
      for (const s of mcpManager.statuses()) {
        // 只报 server 名与错误文本：env / headers 的值绝不进日志（PRD §2.7）。
        if (s.status === "error") log(`MCP server "${s.name}" 连接失败：${s.error ?? "未知原因"}`);
      }
    } catch (e) {
      // connectAll 本身不抛；真抛了也只是诊断，不拖垮会话。
      log(`MCP 装配失败：${(e as Error).message}（session 不阻塞）`);
    }
    promptManager.invalidate();
    agent.refreshSystemPrompt();
  }

  // 项目记忆：与 CLI 同一 helper（#54 pickInstructionFile + git 祖先）；#17 无 paths 规则仍并入。
  // extraRoots 走缺省空数组；safeMode 只让指令文件 helper 返回空，不关掉 #17。
  const permanentMem = loadSessionInstructionMemory(cwd, { safeMode: cfg.safeMode });
  const alwaysOnText = formatAlwaysOnRules(projectRules);
  if (permanentMem || alwaysOnText !== "") {
    promptManager.setProjectMemory({
      path: permanentMem?.path ?? join(cwd, ".neo/rules"),
      text: `${permanentMem?.text ?? ""}${alwaysOnText}`,
    });
    agent.refreshSystemPrompt();
  }

  // R0：用户画像摘要注入 messages[1]（交互口径才有）。失败不阻塞会话。
  // `session/load` 时先恢复历史再注入，画像与历史都保留。
  if (opts.resume && opts.resume.messages.length > 0) {
    agent.messages = applyRestored(agent.messages[0], opts.resume.messages);
    log(`session/load：已恢复 ${opts.resume.messages.length} 条消息（${sessionId}）`);
  }
  try {
    const slice = await memory.startup();
    if (slice) agent.messages.splice(1, 0, slice.message);
  } catch (e) {
    log(`用户画像注入失败 ${(e as Error).message}（session 不阻塞）`);
  }
  memory.recoverPending();

  // 环境快照落用户级 wiki（与 sessionStart 的交互口径同条件）：
  // 这一步同时保证用户级记忆骨架存在（ensureScopeLayout("user", …)）。
  // 记忆关闭时也准备骨架：ACP 是交互会话，用户级库本就该可用。
  try {
    if (cfg.memory.enabled) {
      const layout = ensureScopeLayout("user", cwd, cfg.memory.userWikiDir);
      if (cfg.env?.enabled !== false && cfg.env?.wikiPage !== false) {
        const loaded = loadEnv({ cfg, persist: true });
        if (loaded) syncEnvPage(layout, loaded.snapshot);
      }
    }
  } catch (e) {
    log(`环境快照落盘失败 ${(e as Error).message}（session 不阻塞）`);
  }

  // ---- SessionStart（#64）：历史恢复与 memory.startup 之后、任何真实输入之前触发一次。
  // new = 本进程新开会话；resume = session/load 接管了历史。回放历史不算用户提交，
  // 所以这里只发 SessionStart。失败只诊断（runSessionStart 自身恒不阻断）。
  await agent.runSessionStart(opts.resume ? "resume" : "new");

  const meta: SessionMeta = sess.meta;

  return {
    sessionId,
    cwd,
    agent,
    async prompt(text: string) {
      // 新一轮开始：清掉上一轮的取消标志（cancel 只作用于在途的那一轮）。
      // 权限桥的 aborted 也必须复位，否则上一轮取消后本轮连权限都不问（复审 R2）。
      cancelled = false;
      answeredLastIteration = false;
      permissionBridge.resetForTurn();
      // 通知排空与落盘（与 TUI 同口径）在 runAcpTurn 里，成功/失败/抛错都先做完再返回。
      const stopReason = await runAcpTurn(text, {
        send: (t) => agent.send(t),
        flush: opts.flushNotifications,
        persist: () => persist(agent.messages, meta),
        cancelled: () => cancelled,
        maxToolIterations: cfg.maxToolIterations,
        answeredLastIteration: () => answeredLastIteration,
      });
      return { stopReason };
    },
    cancel() {
      cancelled = true;
      // 先结束在途的权限询问：否则要等到超时（默认 300s）才生效。
      permissionBridge.abortPending();
      agent.cancel();
    },
    usage() {
      // 真实计量：与 Agent.contextUsage() 同源（estimateTokens + 当前工具规格），
      // 只是换成 ACP 要的「tokens / 窗口」两个整数。
      return usageOf(agent.messages, agent.toolSpecsFor(), cfg.contextWindow);
    },
    currentMode() {
      return mode;
    },
    setMode(next: PermissionMode) {
      mode = next;
      // 两处一起改：权限桥（审批口径）与 Agent.mode（只读闸门 / 工具清单 / hooks 载荷）。
      permissionBridge.setMode(next);
      agent.mode = next;
    },
    dispose() {
      // 顺序：先结束在途权限询问（否则工具会卡到超时），再中止模型请求与工具
      // （在途 shell 由 agent.cancel 的 AbortSignal 杀掉），然后走 cleanupEphemeral
      //（issue #100：与 CLI 共用释放清单，按进程组回收监视，含组内子进程）。
      cancelled = true;
      try {
        permissionBridge.abortPending();
      } catch (e) {
        log(`dispose：结束权限询问失败 ${(e as Error).message}`);
      }
      try {
        agent.cancel();
      } catch (e) {
        log(`dispose：中止在途请求失败 ${(e as Error).message}`);
      }
      cleanupEphemeral({
        shells: backgroundShells,
        monitors: sessionMonitors,
        mcp: mcpManager,
      });
      for (const u of unregisters) {
        try {
          u();
        } catch (e) {
          log(`dispose：注销运行时工具失败 ${(e as Error).message}`);
        }
      }
      unregisters.length = 0;
    },
  };
}
