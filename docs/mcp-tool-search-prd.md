# MCP 工具按需发现 PRD（issue #68）

> 状态：实现中（待审查）
> 关联：GitHub #68。版本仍为 0.4.92，本单不合入、不发版。

## 1 背景

MCP server 一多，每轮请求都会把全部工具的完整 `inputSchema` 塞进模型上下文。
这会挤占窗口、抬高费用，也让模型更难从一长串相近的工具名里选对。
本单要在「工具仍然能被发现和调用」的前提下，默认只把必要的 MCP schema 发给模型。

## 2 行为

1. 配置（`settings.json` 的 `mcp` 段，**不**提交用户 `settings.json`）：
   - `tool_search`：`"auto"`（默认）/ `true` / `false`。不认 `ENABLE_TOOL_SEARCH`，不按窗口百分比判定。
   - `tool_search_threshold`：默认 10。`auto` 下，可延迟 MCP 工具数 ≥ 该阈值才启用延迟加载；`true` / `false` 强制开或关。
   - 每个 `mcpServers` 条目可写 `alwaysLoad: true`，该 server 的全部工具常驻。本单不做按工具名单。
2. 只延迟 MCP。第一方工具始终全量装入，启用延迟时包含内置 `tool_search`。
3. `tool_search` 是普通内置工具（`query` + 可选 `limit`，默认 5、上限 10）：按名字/描述做可测的大小写不敏感匹配；命中立刻写入**本会话**已加载集合，同一 agent loop 下一次模型请求即可经现有审批调用。空查询或无命中返回明确空结果，不得随便装入。不拆 search/load，不设累计装入上限。系统提示里放一截目录（描述约 80 字）。
4. 直接点名已注册但未装入的 `mcp__*`：走现有审批并执行，同时加入已加载集合（含与 `tool_search` 同批并行）。未注册/编造的名字仍明确失败。不强制先搜索。审批与 `sensitive` 不放宽。
5. 已加载集合只在会话内存，按会话隔离（工具表仍是进程级）。仅在压缩**真正成功**、`/clear`（`Agent.reset`）、会话结束时丢弃；resume 不持久化，只保留 `alwaysLoad`。PreCompact 阻断（#64 exit 2、历史保留）不得清已加载项。
6. 交互、`-p`、ACP 主会话同一套规则（经共享 `toolSpecsFor()` 进入 ACP，不改 ACP 协议/stdout）。子代理拷贝父会话当时已加载集合（新 Set，不共享引用）并自带 `tool_search`，不写回父会话，不把全部 MCP schema 塞进子代理。wiki worker 不扩权。规划态不暴露 MCP / `tool_search`。
7. `/mcp` 仍全量列出。`/tools` 与 `/context` 区分「已装入上下文」和「仅目录」。#20 dry-run 用实际将发送的 specs 计量（延迟且未装入的 MCP 不得进入候选集或 hidden），不启用运行时裁剪。用量与压缩估计一律走 `toolSpecsFor()`，与请求同口径。

## 3 与 Claude Code 的差异（刻意不宣称兼容）

- **无厂商工具搜索 API**：OpenAI 兼容与 Anthropic 都把 `tool_search` 当普通 function / `input_schema` 工具，不走 `tool_search_tool`、`deferred_tools` 一类专用字段。
- **无 `ENABLE_TOOL_SEARCH` 环境变量**；开关只在 `mcp.tool_search`。
- **`auto` 按可延迟 MCP 条数阈值判定**，不按上下文窗口 10%，也不总是延迟。
- **不延迟第一方工具**（含 `tool_search` 自身）。
- 已加载集合不落盘；成功压缩后丢弃，不跨 resume 恢复（除 `alwaysLoad`）。

## 4 验收

以 `tests/mcp-tool-search-68.test.ts` 为准，覆盖：强制 `true`/`false`、`alwaysLoad`、PreCompact 阻断后集合仍在、resume 只留 `alwaysLoad`、子代理隔离、空查询不装入、用量与 #20 候选集同口径、两种协议都当普通工具。

`bun x tsc --noEmit` 零错误，`bun test` 全绿（worktree 允许既有 3 条 prompt-tiers skip），`bash scripts/verify.sh` 为 `ALL GREEN`。不加新 PTY 场景。

## 5 非目标

- 不启用 #20 的运行时工具裁剪，不把 #82 并进来。
- 不改 shell 权限、不放宽审批 / `sensitive`、不扩 wiki worker 工具表。
- 不做按工具的 alwaysLoad 名单、不做已加载集合持久化、不引入累计装入上限。
- 若与并行 ACP 协议改动冲突则停，不擅自改协议。
