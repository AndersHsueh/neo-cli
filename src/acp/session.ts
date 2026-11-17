/**
 * ACP 会话装配（issue #60，PRD §2.5–§2.9 / §2.12）。
 *
 * 与 `src/cli/sessionStart.ts` 的关系：**同一套执行引擎**（`Agent.send()`），
 * 但宿主是编辑器而不是 TUI，因此这里只做「Agent + 工具 + 记忆」的装配，
 * 明确跳过 TUI 专属件：composer / dock / 输入层 / 跨会话信箱 / 定时循环。
 *
 * 记忆口径（PRD §2.12）：ACP 是**交互会话**，`scopeMode: "both"`（用户级+项目级）。
 * 不走 `-p` 的 oneshot 口径 —— bootstrap 里 oneshot 会把 `cfg.memory.scopeMode`
 * 降成 "project"，那条路径在 ACP 里根本不经过。
 *
 * stdout 纪律（PRD §2.1）：stdout 只归协议 NDJSON。给 Agent 的 console 全部写 stderr，
 * 不依赖 NO_COLOR 之类的环境变量碰运气。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { Agent } from "../agent.ts";
import type { AgentEvent, PermissionMode, ToolEndEventData, ToolStartEventData } from "../agent/types.ts";
import { createPermissionBridge, type PermissionUi } from "./permission.ts";
import { isWriteTool, pathOfArgs, snapshotOldText, toolKind } from "./tools.ts";
import { Console } from "../ui/console.ts";
import { PromptManager } from "../prompt/manager.ts";
import { createMemoryBridge, type MemoryBridge } from "../memory/bridge.ts";
import { resolveAndApplyModelWindow } from "../env/modelWindows.ts";
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
import { createSession, type SessionMeta } from "../session.ts";
import { CheckpointStore } from "../checkpoint.ts";

/** 诊断只走 stderr：stdout 是协议通道。 */
function log(message: string): void {
  process.stderr.write(`[acp] ${message}\n`);
}

/** 装配好的 ACP 会话。 */
export interface AcpSession {
  sessionId: string;
  cwd: string;
  agent: Agent;
  /** 跑一轮用户输入；返回 stopReason（正常 end_turn / 被取消 cancelled）。 */
  prompt(text: string): Promise<{ stopReason: "end_turn" | "cancelled" }>;
  /** `session/cancel`：中止在途的模型请求与工具。 */
  cancel(): void;
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
   * 等通知队列排空（server 注入）：`prompt()` 返回前必须把本轮所有
   * `session/update` 都 await 完，否则通知可能晚于 prompt 的响应写出。
   */
  flushNotifications?: () => Promise<void>;
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

  // 权限模式：settings 的 permission_mode（server 从进程 cwd 的 settings.json 读），
  // 缺省 "ask"（与 `neo` 默认一致）。绝不因为走 ACP 就悄悄放宽成 auto-all。
  const mode: PermissionMode = opts.permissionMode ?? "ask";

  // 会话文件先建：记忆桥需要 sessionId 作为审计键（与 sessionStart 同一顺序）。
  const sess = createSession(cfg.model, cwd);
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
    sessionName: null,
  });

  const projectRules = discoverProjectRules(cwd);
  const scopedRuleList = projectRules.filter((r) => r.paths.length > 0);

  // ---- 权限桥（PRD §2.11）----
  // 判定顺序在桥里：decidePermission 说 allow → 直接放行；plan → 拒绝；
  // needs-confirm → 问编辑器；客户端不在/失败/超时 → 回退 settings 模式（不放宽）。
  let cancelled = false;
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

  const agent = new Agent({
    cfg,
    console: ui,
    // 权限模式来自 settings 的 permission_mode（缺省 ask），不再硬编码。
    mode,
    systemPrompt: promptManager.render(cfg).text,
    renderSystemPrompt: () => promptManager.render(cfg).text,
    getSessionName: () => null,
    toolPathsOf: (name, argsJson) => extractTouchedPaths(name, argsJson, cwd),
    scopedRulesPrompt: (touched) => {
      if (scopedRuleList.length === 0) return null;
      const matches = selectScopedRules(scopedRuleList, touched, { cwd });
      const text = formatScopedRulesBlock(matches);
      return text === "" ? null : { text, matches };
    },
    memory,
    checkpoint: new CheckpointStore({ cwd, sessionId }),
    sessionId,
    hooks: cfg.hooks,
    // 目标锚 / 信箱在 ACP 默认关：不读、不写。
    readGoal: () => null,
    refreshContextWindow: () => resolveAndApplyModelWindow(cfg),
    // 编辑器里没有 TUI 提问模态，ask_user 不注册。
    nonInteractive: true,
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
  registerTool(
    makeTaskTool({
      run: (prompt, tier, ctx, promptTier) => runSubagent(agent, prompt, tier, ctx, promptTier),
    }),
  );
  registerWikiTools(registerTool);
  registerTool(makeRememberTool({ remember: (body, scope) => memory.remember(body, scope) }));

  let sessionTodos: TodoItem[] = Array.isArray(sess.meta.todos) ? sess.meta.todos : [];
  registerTool(
    makeTodoWriteTool({
      get: () => sessionTodos,
      set: (items) => {
        sessionTodos = items;
        sess.meta.todos = items;
      },
      persist: () => persist(agent.messages, sess.meta),
    }),
  );

  // 运行时工具注册完再刷新系统提示：`可用工具` 行由 toolNames() 现取。
  promptManager.invalidate();
  agent.refreshSystemPrompt();

  // 项目记忆文件（AGENTS.md / NEO.md / .neo.md）与无 paths 的规则并入系统提示。
  const memoryFile = ["AGENTS.md", "NEO.md", ".neo.md"].map((f) => join(cwd, f)).find((p) => existsSync(p));
  const alwaysOnText = formatAlwaysOnRules(projectRules);
  if (memoryFile || alwaysOnText !== "") {
    const base = memoryFile ? readFileSync(memoryFile, "utf8") : "";
    promptManager.setProjectMemory({
      path: memoryFile ?? join(cwd, ".neo/rules"),
      text: `${base}${alwaysOnText}`,
    });
    agent.refreshSystemPrompt();
  }

  // R0：用户画像摘要注入 messages[1]（交互口径才有）。失败不阻塞会话。
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

  const meta: SessionMeta = sess.meta;

  return {
    sessionId,
    cwd,
    agent,
    async prompt(text: string) {
      // 新一轮开始：清掉上一轮的取消标志（cancel 只作用于在途的那一轮）。
      cancelled = false;
      const stats = await agent.send(text);
      // 通知队列：onEvent 是同步的，通知发送（含 await client.notify）在 server 侧排队；
      // prompt 的响应必须先于「本轮结束」之后的所有通知写出，所以这里等队列排空。
      await opts.flushNotifications?.();
      // 落盘：与 TUI 同口径（persist 内部已吞异常），编辑器重开进程后会话文件仍在。
      persist(agent.messages, meta);
      // 取消 → cancelled（PRD §2.11）；其余按正常结束。
      if (cancelled || stats.aborted) return { stopReason: "cancelled" as const };
      return { stopReason: "end_turn" as const };
    },
    cancel() {
      cancelled = true;
      // 先结束在途的权限询问：否则要等到超时（默认 300s）才生效。
      permissionBridge.abortPending();
      agent.cancel();
    },
  };
}
