/**
 * 斜杠命令共享上下文。实现仍按命令组分文件，避免 commands.ts 再次膨胀。
 */
import type { Agent } from "../agent.ts";
import type { Classifier } from "../classifier/index.ts";
import type { CheckpointStore } from "../checkpoint.ts";
import type { Config } from "../config.ts";
import type { BackgroundView } from "../tools/background.ts";
import type { ShellJobView } from "../tools/backgroundShell.ts";
import type { RewindMode, RewindResult, RewindTurn } from "../rewind.ts";
import type { DriveSpec } from "../drive.ts";
import type { LoopSpec } from "../loop.ts";
import type { ProjectRule, RuleMatch } from "../rules/index.ts";
import type { MemoryBridge } from "../memory/bridge.ts";
import type { McpPromptGetResult, McpPromptInfo, McpServerState } from "../mcp/client.ts";
import type { PromptSelection } from "../prompt/select.ts";
import type { ToolVisibility } from "../prompt/visibility.ts";
import type { Envelope } from "../mailbox/types.ts";
import type { Mailbox } from "../mailbox/store.ts";
import type { Message } from "../llm.ts";
import type { PromptManager } from "../prompt/manager.ts";
import type { PreviousCwdSlot } from "./cdWorkdir.ts";
import type { SessionMeta } from "../session.ts";
import type { TodoItem } from "../tools/todo.ts";
import type { SelectDeps } from "../ui/select.ts";
import type { Console } from "../ui/console.ts";

export interface CommandContext {
  agent: Agent;
  ui: Console;
  cfg: Config;
  memory: MemoryBridge;
  classifier: Classifier;
  meta: SessionMeta;
  shutdown: () => void | Promise<void>;
  selectDeps: SelectDeps;
  mailbox: Mailbox | null;
  checkpoints: CheckpointStore | null;
  injectMailbox?: (env: Envelope) => void;
  onMailboxRekey?: () => void;
  onNameChange?: (name: string) => void;
  /**
   * 当前 cfg 下的系统提示词选档诊断（issue #20）；/context 展示用，取不到时为 null。
   *
   * 实现方只算不写：不得改写 messages[0]（提示词何时生效由请求边界决定）。
   */
  promptSelection?: () => PromptSelection | null;
  /**
   * 小窗口下的工具可见集方案（issue #20 收尾，**dry-run**：只算不生效）。
   *
   * /context 展示「按当前预算最多能暴露几个工具」；运行时暴露的工具集不变。
   */
  toolVisibility?: () => ToolVisibility | null;
  /**
   * 路径作用域规则（issue #17）：每会话条数、本轮已加载 scoped 条数与命中原因。
   * 不传 = 不展示（子代理/测试场景）。
   */
  rules?: () => { alwaysOn: ProjectRule[]; loaded: RuleMatch[]; total: number };
  /** 目标驱动自动续跑（issue #24）：/drive 列表 / 启动 / 停止。不传 = 不支持。 */
  drive?: {
    start: (spec: DriveSpec) => { ok: true } | { ok: false; error: string };
    stop: () => void;
    status: () => string[];
  };
  /** 按轮次回滚（issue #27）：列出轮次 / 回滚到某轮之前。不传 = 不支持。 */
  rewind?: {
    list: () => RewindTurn[];
    apply: (target: number | "last", mode: RewindMode) => RewindResult;
    /**
     * 用户轮次 → 该轮起点的消息下标（issue #46 定点 compact 用）。
     * 返回 null = 轮次不存在。
     */
    turnStart?: (target: number | "last") => number | null;
  };
  /** 后台长驻 shell（issue #28）：列表 / 停止。不传 = 不支持（/ps 会明说）。 */
  shells?: {
    list: () => ShellJobView[];
    kill: (target: string) => number;
  };
  /** 事件驱动监视（issue #87）：启 / 列 / 停。不传 = 不支持（/monitor 会明说）。 */
  monitors?: {
    start: (opts: { command: string; timeoutMs: number; description?: string }) => { ok: true; id: string; timeoutMs: number } | { ok: false; error: string };
    stop: (target: string) => number;
    listLines: () => string[];
  };
  /**
   * 轮末后台 wiki 维护（issue #53）。仅交互会话注入；`/ingest` 用它做单飞判定
   * （worker 在跑时拒绝手动派发，避免两路同时写 wiki）。
   */
  wikiMaintainer?: { readonly running: boolean };
  /** 后台子代理任务（issue #16）：列表 / 取消。不传 = 不支持（/tasks 会明说）。 */
  tasks?: {
    list: () => BackgroundView[];
    cancel: (target: string) => number;
    /**
     * 续聊（issue #48）：给指定任务追加一条用户消息并继续该子代理。
     * 不传 = 不支持续聊（`/tasks chat` 会明说）。
     */
    chat?: (id: string, text: string) => Promise<{ ok: true; reply: string } | { ok: false; error: string }>;
  };
  /**
   * 定时 / 自节奏循环提示（issue #25）。仅交互会话注入；`-p` 下为 undefined，
   * `/loop` 会直接提示「不可用」而不启动任何定时器。
   */
  loop?: {
    start: (spec: LoopSpec) => void;
    stop: () => void;
    status: () => string[];
  };
  memoryMode?: "interactive" | "oneshot";
  /**
   * 把合成的用户消息排进主循环队列，作为下一轮发给模型（issue #13）。
   *
   * `/技能名` 命中后走这里而不是直接 agent.send：drain 正在跑，直接 send 会重入
   * 并打乱 draining 状态机。入队后 dispatchCommand 正常返回，drain 的 while
   * 会在下一轮取出该消息（文本不以 `/` 开头，自然走 agent.send 路径）。
   */
  enqueueUserTurn?: (text: string) => void;
  /**
   * 读本会话的结构化待办（issue #10）。组合根持有内存态（resume 后来自 meta.todos），
   * 优先于 meta.todos 读 —— 工具刚写完还没落盘时 meta 是旧的。
   */
  todos?: () => TodoItem[];
  /**
   * MCP server 状态快照（issue #2）。`/mcp` 用它列出 server / 连接状态 / 工具数 / 错误。
   * 不传 = 本进程没有接 MCP（单测裸 ctx），`/mcp` 会明确说明而不是显示空表。
   */
  mcp?: () => McpServerState[];
  /**
   * issue #67：已连接 MCP 提示词清单（含 server 名）。
   * `/` 分发与撞名提示用；不传 = 本入口没有提示词。
   */
  mcpPrompts?: () => Array<McpPromptInfo & { server: string }>;
  /** issue #67：调用 prompts/get。失败抛错，由分发层转警告。 */
  mcpGetPrompt?: (
    server: string,
    name: string,
    args?: Record<string, string>,
  ) => Promise<McpPromptGetResult>;
  /** issue #67：`/mcp` 手动查看时再 list 一次（HTTP 通知为 P3）。 */
  mcpRefresh?: () => Promise<void>;
  /**
   * issue #69：交互 `/cd` 换根所需的可选接线。缺一项 = 该侧状态本入口没有
   * （`-p` / 测试裸 ctx），不是「跳过刷新」的借口。
   */
  promptManager?: PromptManager;
  persistSession?: (messages: Message[], meta: SessionMeta) => void;
  previousCwd?: PreviousCwdSlot;
  fileIndex?: { setCwd: (cwd: string) => void };
  /** 本轮 turn / 工具循环是否在进行（`/cd` 忙碌判定）。 */
  turnActive?: boolean | (() => boolean);
  /** 换根后替换路径作用域规则（新根 .neo/rules）。 */
  replaceRules?: (cwd: string, rules: ProjectRule[]) => void;
  /** 换根后重启语言服务器；失败只警告、不回滚。 */
  restartLsp?: (cfg: Config) => void | Promise<void>;
}
