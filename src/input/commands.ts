/**
 * input/commands.ts — 斜杠命令声明表（v0.2.4 C2，`/` 补全的唯一数据源）。
 *
 * 与 `src/cli/commands.ts` 的注册名是「表 + 实现」关系：
 * 两侧任何一边新增/删除而另一边没跟，`tests/commands.test.ts` 的漂移守卫会立刻红。
 * 新增命令的顺序：先在这里登记（名称 + 一句说明），再去 `cli/commands.ts` 加 case。
 */

export interface CommandEntry {
  name: string;
  description: string;
}

/** 顶层斜杠命令（不含 /memory 这类子命令）。别名也登记，方便补全时被发现。 */
export const COMMANDS: CommandEntry[] = [
  { name: "help", description: "帮助；别名 ?" },
  { name: "?", description: "别名：/help" },
  { name: "clear", description: "清空上下文" },
  { name: "compact", description: "压缩上下文" },
  { name: "cost", description: "token 与 provider 统计" },
  { name: "context", description: "上下文窗口/用量/最近压缩" },
  { name: "export", description: "导出会话 Markdown（/export <session-id>）" },
  { name: "provider", description: "切换 provider" },
  { name: "tier", description: "切换模型档位" },
  { name: "fast", description: "快捷：/tier fast" },
  { name: "balanced", description: "快捷：/tier balanced" },
  { name: "deep", description: "快捷：/tier deep_reasoning" },
  { name: "deep_reasoning", description: "快捷：/tier deep_reasoning" },
  { name: "default", description: "快捷：/tier default" },
  { name: "auto", description: "切换分类器（off/rule/llm）" },
  { name: "why", description: "上次分类判定与理由" },
  { name: "model", description: "查看 / 切换模型" },
  { name: "tools", description: "工具列表" },
  { name: "mcp", description: "MCP 外部工具 server 状态（连接/工具数/错误）" },
  { name: "hooks", description: "生命周期 hooks 列表（Pre/PostToolUse、TurnEnd）与配置告警" },
  { name: "env", description: "环境快照（/env refresh 重采并写 wiki 页）" },
  { name: "peers", description: "跨会话状态" },
  { name: "inbox", description: "查看/放行 held 消息" },
  { name: "rename", description: "设置本会话名字" },
  { name: "goal", description: "设置/查看目标锚（防跑偏）" },
  { name: "loop", description: "定时/自节奏循环提示（/loop 2m <提示> · self · stop）" },
  { name: "tasks", description: "后台子代理任务列表 / 取消（/tasks cancel [id]）" },
  { name: "ps", description: "后台长驻 shell：列表 / 停止（/ps kill [id|all]）" },
  { name: "todos", description: "查看本会话结构化待办" },
  { name: "skills", description: "技能列表与详情" },
  { name: "wiki-lint", description: "wiki 体检" },
  { name: "ingest", description: "编译 raw → wiki" },
  { name: "mode", description: "权限模式（plan = 只读闸门，禁止一切写操作）" },
  { name: "plan", description: "交互规划工作流：先澄清确认方案再改码（不是 /mode plan）" },
  { name: "review", description: "对照 git 改动做只读审查（/review [基线]；默认审未提交改动，不改文件）" },
  { name: "worktree", description: "托管 worktree：list 列出 / remove <name> [--force] 清理（创建用 --worktree <name>）" },
  { name: "init", description: "生成 AGENTS.md" },
  { name: "memory", description: "记忆子命令族" },
  { name: "remember", description: "显式记忆" },
  { name: "history", description: "历史统计" },
  { name: "save", description: "导出会话" },
  { name: "resume", description: "恢复会话" },
  { name: "last", description: "回看最近 n 次工具调用" },
  { name: "undo", description: "撤销最近 n 次 write/edit" },
  { name: "rewind", description: "按轮次回滚：/rewind 列表 · <n|last> [code|conversation|both]" },
  { name: "drive", description: "目标驱动自动续跑：/drive <检查命令> -- <提示> · stop" },
  { name: "checkpoints", description: "列出写文件检查点" },
  { name: "sessions", description: "历史会话列表" },
  { name: "exit", description: "退出；别名 quit" },
  { name: "quit", description: "别名：/exit" },
];

/**
 * 从一行文本里解析出**行首的已知斜杠命令名**（issue #41）。
 *
 * `"/drive bun test"` → `"drive"`；不是行首、或不是已登记命令 → `null`。
 * 一次性模式（`-p` / 非交互）用它明确提示「斜杠命令不可用」，而不是把整串当 prompt
 * 静默发给模型 —— 与 `docs/goal-drive-prd[done].md` 的口径对齐。
 */
export function knownSlashCommand(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return null;
  const name = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
  return COMMANDS.some((c) => c.name === name) ? name : null;
}
