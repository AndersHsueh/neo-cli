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
import type { AgentEvent } from "../agent/loop.ts";
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
  /** 跑一轮用户输入；返回 stopReason 的判定依据（本步只区分正常结束）。 */
  prompt(text: string): Promise<{ stopReason: "end_turn" }>;
}

export interface CreateAcpSessionOptions {
  cfg: Config;
  cwd: string;
  /** 助手文本增量（PRD §2.9：`agent_message_chunk`）。 */
  onText: (text: string) => void;
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

  const agent = new Agent({
    cfg,
    console: ui,
    // 权限模式与 `neo` 默认一致（"ask"）：编辑器审批（session/request_permission）是 D 步，
    // 本步不接，因此**不放宽**——需要确认的工具仍走既有审批判定，而不是悄悄 auto-all。
    mode: "ask",
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
    onEvent: (e: AgentEvent) => {
      if (e.type === "text" && typeof e.data === "string" && e.data !== "") onText(e.data);
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
      const stats = await agent.send(text);
      // 落盘：与 TUI 同口径（persist 内部已吞异常），编辑器重开进程后会话文件仍在。
      persist(agent.messages, meta);
      // 本步只做文本基线：取消/迭代上限/拒绝/截断的映射在 D 步。
      if (stats.aborted) log("本轮被取消（session/cancel 的 stopReason 映射在 D 步）");
      return { stopReason: "end_turn" as const };
    },
  };
}
