/**
 * input/commands.ts — 斜杠命令声明表（v0.2.4 C2，`/` 补全的唯一数据源）。
 *
 * 与 `src/index.ts` 的 `handleCommand` switch 是「表 + 实现」关系：
 * 两侧任何一边新增/删除而另一边没跟，`tests/commands.test.ts` 的漂移守卫会立刻红。
 * 新增命令的顺序：先在这里登记（名称 + 一句说明），再去 switch 加 case。
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
  { name: "peers", description: "跨会话状态" },
  { name: "inbox", description: "查看/放行 held 消息" },
  { name: "rename", description: "设置本会话名字" },
  { name: "skills", description: "技能列表与详情" },
  { name: "wiki-lint", description: "wiki 体检" },
  { name: "ingest", description: "编译 raw → wiki" },
  { name: "mode", description: "权限模式" },
  { name: "init", description: "生成 AGENTS.md" },
  { name: "memory", description: "记忆子命令族" },
  { name: "remember", description: "显式记忆" },
  { name: "history", description: "历史统计" },
  { name: "save", description: "导出会话" },
  { name: "resume", description: "恢复会话" },
  { name: "last", description: "回看最近 n 次工具调用" },
  { name: "undo", description: "撤销最近 n 次 write/edit" },
  { name: "checkpoints", description: "列出写文件检查点" },
  { name: "sessions", description: "历史会话列表" },
  { name: "exit", description: "退出；别名 quit" },
  { name: "quit", description: "别名：/exit" },
];
