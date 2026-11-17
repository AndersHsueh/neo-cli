# ACP 服务端 PRD（issue #60）

> 状态：待实现（本文件是 A 步交付；实现合入前不加 `[done]` 后缀）
> 关联：GitHub #60。**首期只做「`neo acp` 作为 ACP v1 服务端被编辑器拉起」**；不做 GUI、不上 Registry、不做 v2。
> 协议依据：ACP v1 稳定版（`https://agentclientprotocol.com/protocol/v1/*`）。字段名一律以官方 schema 为准，本文不发明字段。

## 1 背景

neo 现在只有两个入口：TUI（`src/cli/inputLayer.ts`）与 `-p`（`src/cli/oneshot.ts`）。
想在 Zed / JetBrains 里用 neo，只能开一个终端跑 TUI，编辑器侧的 Agent 面板、diff 审阅、权限弹窗都用不上。

ACP（Agent Client Protocol）是编辑器与 agent 之间的 JSON-RPC 协议：编辑器拉起 agent 子进程，通过 stdio 交换
`initialize` / `session/new` / `session/prompt` 与 `session/update` 通知。Zed 的 External Agent（Custom Agent，
`agent_servers` 配置项）就是这条路。

**方向要说清**：现有 `src/mcp/`、`src/lsp/` 都是**客户端**（neo 去连外部工具/语言服务器），与 ACP 方向相反；
`src/mcp/jsonrpc.ts` 是 MCP 客户端传输层（拉起子进程、按 MCP 语义收发），**不是** ACP 服务端，不要硬套。
本次要新增的是「neo 作为服务端被连」这一侧。

## 2 需求（首期）

### 2.1 入口与进程模型

1. `neo acp` 启动 stdio 上的 ACP 服务端：
   - stdin 读 JSON-RPC（NDJSON，一行一条消息），stdout **只**写协议消息（NDJSON）；
   - 日志、诊断、警告一律走 stderr —— 与 `-p --output-format stream-json` 的「stdout 只归协议」同口径；
   - 不启 composer / dock（`src/tui/`），不启 readline 输入层；不打印 banner、spinner、ANSI 动画。
2. 与 TUI、`-p` 互斥：`neo acp -p "…"`、`neo acp --output-format json` 等组合为**用法错误**，退出码 2，
   错误信息写 stderr。
3. 复用现有执行引擎：agent 循环走 `src/agent/loop.ts`（`Agent.send()`），会话装配走 `src/cli/sessionStart.ts`
   的同一套（工具注册、MCP、hooks、rules、系统提示）。**不新造第三套执行引擎**。
4. 单进程**只支持一个 session**：第二次 `session/new` 返回明确错误（见 §2.6）。

### 2.2 协议版本与 SDK 选型

1. 目标协议：**ACP v1 稳定版**（`protocolVersion` 整数，v1 = `1`）。
2. 实现优先用官方 `@agentclientprotocol/sdk` 的**默认入口**（即 v1）：
   - 用官方推荐的 fluent API `agent()` 注册 handler；`AgentSideConnection` 已弃用，仅作兜底，不主动使用；
   - **禁止**从 `/experimental/v2`、`/unstable` 或任何 draft 子路径导入；
   - v2 仍是实验草案，本次不做（见 §5）。
3. **SDK 不可用时的备案**：若 SDK 在 Bun 运行时下因同行依赖（peer dep）、ESM/CJS 互操作或类型解析问题无法可用，
   允许按官方 v1 schema 自实现薄服务端（JSON-RPC 2.0 收发 + 本文列出的方法/通知），判定标准：
   - 触发条件：`bun install` 后 `bun x tsc --noEmit` 报 SDK 类型不可解析，或最小 `initialize` 往返在 Bun 下失败，
     且无法用配置（而非改 SDK 源码）解决；
   - 备案必须**把原因写回本 PRD**（新增「§7 实现记录」小节：日期、现象、尝试过的解法、结论），
     并保证 §3 的验收条款全部仍由 `tests/acp-protocol.test.ts` 覆盖；
   - 备案实现只做本文列出的方法与通知，不顺手实现 v2 或未广告能力。
4. 传输：stdio，**NDJSON**（一行一条 JSON-RPC 消息），不用 `Content-Length` 帧（那是 LSP 的形态，见 `src/lsp/`）。

### 2.3 协议通用约定

- JSON-RPC 2.0；对象键 `camelCase`；判别字段（如 `sessionUpdate`、`status`、`kind`、`outcome`）的值 `snake_case`。
- 协议里所有文件路径**必须是绝对路径**；行号从 **1** 起。
- 错误码沿用 ACP 定义：`-32700` 解析失败、`-32600` 非法请求（含「initialize 之前收到其它请求」）、
  `-32601` 方法未实现、`-32602` 参数非法、`-32603` 内部错误、`-32000` 需要鉴权、`-32002` 资源不存在。
  未知 session 的请求用 `-32002` 且 `data.sessionId` 回带请求里的 id。

### 2.4 `initialize`

请求含整数 `protocolVersion`、`clientCapabilities`、`clientInfo`（name/title/version）。
响应含选定 `protocolVersion`、`agentCapabilities`、`agentInfo`、`authMethods`。

- 请求版本为 `1` → 回 `1`；请求版本不是 `1` → **仍回本实现支持的 `1`**，由客户端决定是否断开（不报错）。
- `agentInfo`：`{ name: "neo", title: "neo", version: <VERSION> }`（`src/cli/version.ts`）。
- `authMethods`：首期**空数组**（鉴权沿用 settings.json 的模型配置，不新做 OAuth/登录流）。
- `agentCapabilities` 首期**只广告本次真做的能力**：
  - `loadSession: false`（`session/load` 未做，见 §5）；
  - `promptCapabilities`：`text` 与 **`resource_link` 都是 v1 必选、已做**。`embeddedContext: false`
    **只禁止**内嵌 `resource` 内容块，不得用来拒绝 `resource_link`。`image` / `audio` 未映射，显式 `false` 并列入 §5；
  - `mcpCapabilities`：官方 v1 规定所有 Agent **必须**支持 stdio MCP，该字段只用来广告 `http` / `sse`。
    本实现接入 settings 与客户端传入的 **stdio** MCP（见 §2.7），**不广告** http/sse（已知未做，见 §5）；
  - **不广告**：`session/list`、`session/delete`、`sessionCapabilities.*`（resume/close/additionalDirectories/
    systemPrompt）、`terminals`、session modes、config options、斜杠命令广告、`auth.logout`。
- `initialize` 之前收到其它请求 → `-32600`。

### 2.5 `session/new`

- 参数：`cwd`（**必填，绝对路径**）、`mcpServers`（可为空数组）。
- `cwd` 作为本次会话的工作区（等价于 `-C`）：配置、工具沙箱、记忆项目级根、检查点全部以它为根。
  **配置搜索根与 `permission_mode` 读取都以 session `cwd` 为准**，不是进程启动目录：先读
  `<cwd>/settings.json`，工作区没有再回退到启动目录、包装根、`~/.neo/settings.json`。
  相对路径 → `-32602`；目录不存在 → `-32602`（可读消息）。
- 成功返回 `{ sessionId }`（沿用 `src/session.ts` 的会话 id）。
- **缺模型凭证**（`cfg.apiKey` 为空，与 `src/cli/bootstrap.ts` 的判定同口径）→ 返回清楚错误
  （`-32000` 或 `-32603` 均可，但 message 必须说明「provider 未配置 api_key，请在 settings.json 的 providers
  中填写或设置环境变量」），不伪造 sessionId、不静默降级。
- 会话装配失败（MCP 全挂等非致命项）按既有口径降级并写 stderr，不因此拒绝 `session/new`。

### 2.6 单 session 约束

首期一个进程只服务一个 session。第二次 `session/new` **必须返回明确错误**（`-32603` 或 `-32600`，
message 含「只支持一个 session」），不得静默复用第一个 sessionId、不得新建第二个 agent 实例。

### 2.7 `mcpServers`（settings + 客户端传入）

官方 v1 Session Setup：所有 Agent **必须**支持 stdio MCP；`mcpCapabilities` 只控制 http/sse 广告。

- 两个来源一并接入现有 `McpManager`（`src/mcp/client.ts`）：settings.json 的 `mcpServers`，以及客户端
  在 `session/new` 里传入的 stdio 形态（`name` / `command` / `args` / `env: [{name,value}]`）→
  `McpStdioServerConfig`（`env` 由数组转对象）。重名以 settings 为准。
- 单个 server 失败只写 stderr 诊断，不因此拒绝 `session/new`；会话结束时 `closeAll()`。
- HTTP / SSE 形态首期**不接入、不广告**，跳过并记「未支持的传输」，不拒绝会话（见 §5）。
- **不得**把 `env` / `headers` 的值写进 `session/update`、错误消息、日志或模型上下文。

### 2.8 `session/prompt`

- 参数：`sessionId`、`prompt`（ContentBlock 数组）。
- 把 `prompt` 里的 text 与 `resource_link` block 拼成一轮用户输入（`resource_link` 映射为「资源 name (uri)」），
  交给现有 agent 循环跑完整轮；整轮结束后返回 `stopReason`：
  - 正常结束 → `end_turn`；
  - 被 `session/cancel` 取消 → `cancelled`（**不是** JSON-RPC 错误，见 §2.11）；
  - 达到工具迭代上限（`cfg.maxToolIterations`）→ `max_turn_requests`；
  - 模型明确拒绝（`finish_reason` 为 `content_filter` / `refusal`）→ `refusal`；输出被截断到上限（`length`）→ `max_tokens`。
- 同一 session 已有 prompt 在跑时收到新的 `session/prompt` → `-32603`（可读消息），不并发跑两轮、不第二次调用模型。
- 非取消的引擎失败（连接失败、连续空响应、意外异常）→ 可读 JSON-RPC 错误（`-32603`），**不得**伪装成 `end_turn`。
- `image` / `audio` / 内嵌 `resource`：未映射，回 `-32602`，不静默丢弃。`embeddedContext: false` 不能用来拒绝 `resource_link`。

### 2.9 `session/update`（通知）

过程中用 `session/update` 通知客户端，`params.update.sessionUpdate` 判别：

| 场景 | `sessionUpdate` | 关键字段 |
|---|---|---|
| 助手文本 | `agent_message_chunk` | `content: {type:"text", text}`（`messageId` 可选） |
| 工具调用开始 | `tool_call` | `toolCallId`、`title`、`name`、`kind`、`status: "pending"` |
| 工具进展/结束 | `tool_call_update` | `toolCallId`、`status: "in_progress"/"completed"/"failed"`、`content`、`locations` |
| 待办/计划 | `plan` | `entries: [{content, priority, status}]`（整表替换） |

- 数据源是现有 `AgentEvent`（`src/agent/types.ts`）：`text` → `agent_message_chunk`；`tool_start` → `tool_call`
  （`toolCallId` 直接用 `call_id`）；`tool_end` → `tool_call_update`（`status` 由 `ok` / `status` 映射：
  `success` → `completed`，`failure` → `failed`，`not_executed` → `failed` 且 `content` 说明未执行原因）。
- `kind` 映射（ACP `ToolKind`）：`read_file`/`list_dir`/`glob`/`grep`/`lsp`/`web_fetch`/`web_search`/`use_skill` → `read`
  或 `search`/`fetch`（按语义取其一）；`write_file`/`edit_file` → `edit`；`shell`/`shell_output` → `execute`；
  `task` → `other`；`todo_write`/`submit_plan`/`exit_plan_mode` → `think`；`mcp__*` → `other`。
- `plan` 映射（顺手做，成本低才做）：`todo_write` 的清单 → `plan` 通知，`entries[].status` 用
  `pending`/`in_progress`/`completed`（`cancelled` 项**不发送**，ACP 的 plan status 没有该值）；
  `priority` 统一 `medium`（现有 todo 无优先级，不编造）。`todo_write` 不可用或映射成本高 → 不做，列入 §5。
- 通知顺序必须与事件顺序一致；`session/prompt` 的响应**最后**发（取消场景见 §2.11）。

### 2.10 写作类工具的 diff 与 locations

`write_file` / `edit_file` 的 `tool_call_update` 必须带 `type: "diff"` 的 content：

```json
{ "type": "diff", "path": "/abs/path/file.ts", "oldText": "…", "newText": "…" }
```

- `path` 绝对路径；新文件 `oldText: null`；`newText` 是写入后的完整内容；
- 同时带 `locations: [{ path: "/abs/path/file.ts" }]`（行号可选，给了就从 1 起）；
- `oldText` 取写盘前内容（`write_file` 覆盖前、`edit_file` 替换前），读不到（新文件/读取失败）→ `null`；
- 其它工具（读、shell 等）的 `tool_call_update` 用 `type: "content"` 的 text block 承载输出摘要，
  不伪造 diff。

### 2.11 `session/cancel` 与权限

**取消**：`session/cancel` 是**通知**（无响应）。收到后立即 `agent.cancel()`（`src/agent/loop.ts` 的 AbortController），
停模型请求与工具。然后**先把本轮尚未发出的 `session/update` 刷完**，再用 `stopReason: "cancelled"` 回应原
`session/prompt`（响应在全部通知之后；与官方顺序一致，不要改成先响应后通知）。取消**不得**变成 JSON-RPC 错误
（现有 `sendTurn` 在 abort 时返回 `aborted: true` 的 stats，不抛错，正好对上）。

**权限**：客户端能响应 `session/request_permission` 时，工具确认走编辑器 UI：

- 请求：`sessionId`、`toolCall`（含 `toolCallId`、`title`、`kind`、`locations`）、`options`：
  `allow_once` / `allow_always` / `reject_once` / `reject_always`（`optionId` 自定，`name` 与 `kind` 语义一致）；
- 响应：`{ outcome: { outcome: "selected", optionId } }` 或 `{ outcome: { outcome: "cancelled" } }`；
- 按 `selected` 的 `kind` 执行：`allow_*` 放行，`reject_*` 按「用户拒绝」回给模型（走现有 `notExecuted` 通道，
  不执行、不跑 PostToolUse）；`cancelled` 视为本轮取消；
- `allow_always` / `reject_always` 的记忆范围：本 session 内同一工具（不跨 session、不写 settings）；
- **回退**：客户端未广告该能力、或调用失败/超时 → 回退到现有 settings 权限模式
  （`decidePermission`，`src/agent/policy.ts`：`ask` / `auto-edit` / `auto-all` / `plan`），不因 ACP 而放宽。
- 不做沙箱（见 §5）。

### 2.12 记忆作用域

ACP 是编辑器里的**交互会话**，记忆走交互模式：用户级 + 项目级（`scopeMode: "both"`）。
**不是** `-p` 的 oneshot 口径（`src/cli/bootstrap.ts` 里 oneshot 会把 `cfg.memory.scopeMode` 改成 `"project"`）。

跨会话信箱（`src/mailbox/`）与定时循环（`/loop`）**默认关**，不顺手开：ACP 会话不注册 `send_message` /
`list_peers` 工具，不跑 mailbox tick / watchdog。

### 2.13 文档

- `--help`（`src/cli/help.ts`）增加 `neo acp` 一行，说明「stdio 上的 ACP 服务端，供 Zed/JetBrains 等编辑器拉起」；
- `README.md` 增加 Zed External Agent 配置方法（Custom Agent）：

```json
{
  "agent_servers": {
    "neo": { "type": "custom", "command": "neo", "args": ["acp"] }
  }
}
```

## 3 验收

测试文件：`tests/acp-protocol.test.ts`（管道级假客户端：真起子进程或等价管道，stdin 写 NDJSON、stdout 读 NDJSON；
**不依赖真 Zed**）。help/README 断言可放在同文件或既有 help 测试里。

| 编号 | 验收条款 | 建议测试名 |
|---|---|---|
| A1 | `neo acp` 入口存在；与 `-p`/TUI 同时给时是用法错误，退出码 2 | `A1 neo acp 入口存在且与 -p 互斥` |
| A2 | `initialize` 协商 `protocolVersion=1`，返回 `agentCapabilities` / `agentInfo` / 空 `authMethods`；请求版本非 1 仍回 1 | `A2 initialize 协商 v1 与能力` |
| A3 | 握手期间 stdout 只有协议 NDJSON（无非 JSON 行、无 ANSI），诊断在 stderr | `A3 stdout 只有协议 NDJSON` |
| B1 | `session/new` 以 `cwd` 为工作区并返回 `sessionId`；相对路径/不存在的会话操作有明确错误 | `B1 session/new 以 cwd 为工作区` |
| B2 | 同一进程第二次 `session/new` 被拒绝（单 session） | `B2 第二个 session/new 被拒绝` |
| B3 | 缺模型凭证时 `session/new`（或等价路径）返回清楚错误（测试注入空 key，不读真实 settings） | `B3 缺凭证返回清楚错误` |
| C1 | `session/prompt` 先发 `agent_message_chunk`，再以 `stopReason: "end_turn"` 结束（注入 fake LLM，禁止 `mock.module`，禁止触网） | `C1 prompt 文本流与 end_turn` |
| C2 | ACP 会话记忆为交互模式（用户级+项目级），不是 `-p` 的仅项目级 | `C2 记忆 scopeMode 为 both` |
| D1 | 工具调用发出 `tool_call` 与 `tool_call_update`（pending → completed） | `D1 工具调用 pending 到 completed` |
| D2 | 写作类工具的 update 含 `type:"diff"`（绝对路径、`oldText`/`newText`，新文件 `oldText` 为 null） | `D2 写作工具 diff content` |
| D3 | 客户端支持时，写/执行类工具先走 `session/request_permission`，按 selected option 执行或拒绝 | `D3 权限走编辑器 UI` |
| D4 | 客户端不支持权限 RPC 时回退到现有 settings 权限模式 | `D4 无权限能力时回退 settings` |
| D5 | `session/cancel` 使进行中的 prompt 以 `stopReason: "cancelled"` 结束，且不是 JSON-RPC 错误 | `D5 cancel 返回 cancelled` |
| E1 | help 与 README 出现 `neo acp` 以及 Zed `agent_servers` 配置示例 | `E1 help 与 README 含 acp 与 agent_servers` |

补充（非编号闸门，但实现必须自检）：

- `bun x tsc --noEmit` 零错误、`bun test` 全绿、`bash scripts/verify.sh` 为 `ALL GREEN`；
- 真 Zed 手工连通只作人工验证，**不作闸门**（CI 不可靠）。

## 4 实现约束

- **先红后绿**：先补会失败的测试（`tests/acp-protocol.test.ts` 的 A1–E1），红态单独提交，再写实现；
  相关单测绿了再单独做一次 simplify。
- 提交说明带 `#60`；功能与发版拆开：**不改 `package.json` 版本**、不写 release note、不打 tag。
- 源文件仍守 **1000 行上限**（`src/acp/` 下按职责拆分：传输/协议映射/会话装配各一个文件）。
- 不顺手重构、不顺手格式化、不做沙箱。
- 测试隔离（`tests/README.md` §3）：临时目录（`mkdtempSync`）、`NEO_SESSIONS_DIR` / `NEO_MAILBOX_DIR` /
  `NEO_MEMORY_DIR` 等注入后 `afterAll` 还原、LLM 用注入 fake（`AgentOptions.chatStream`）、
  **禁止 `mock.module`**、不触网、不读真实 `~/.neo` 与真实 settings。
- 维护流程按 `docs/maintenance.md` §7.1（编排者审查后再提交）；全量闸门是 `bash scripts/verify.sh`。

## 5 非目标 / 已知未做

**非目标（本次明确不做）**

- 自研 GUI / 桌面客户端；
- ACP Registry 上架；
- ACP v2（实验草案，含 `/experimental/v2`、`/unstable` 入口）；
- issue #58；
- 沙箱（项目立场：隔离的是文件，不是权限）；
- 新做 OAuth / 登录流（鉴权继续用 settings.json 的模型配置）。

**已知未做（首期不做，后续按需）**

- `session/list`、`session/delete`；
- `terminals/*`（ACP 的终端能力）；
- session modes（`session/set_mode`）与 config options；
- 斜杠命令广告（`available_commands_update`）；
- `session/load`（若能复用现有 `--resume` 且不扩范围可做，否则不做；首期 `loadSession: false`）；
- 多 session（一进程一 session）；
- MCP 的 HTTP / SSE 传输（stdio 已做，不广告 http/sse）；
- `promptCapabilities.image` / `audio` / 内嵌 `resource`（未映射，显式 `false`；`resource_link` 已做）；
- `usage_update` / `session_info_update` / `notice` / compaction 相关 update 广告。

## 6 参考

- ACP v1 概览：<https://agentclientprotocol.com/protocol/v1/overview>
- 初始化：<https://agentclientprotocol.com/protocol/v1/initialization>
- 会话建立：<https://agentclientprotocol.com/protocol/v1/session-setup>
- 提示轮：<https://agentclientprotocol.com/protocol/v1/prompt-turn>
- 工具调用：<https://agentclientprotocol.com/protocol/v1/tool-calls>
- 计划：<https://agentclientprotocol.com/protocol/v1/agent-plan>
- 错误码：<https://agentclientprotocol.com/protocol/v1/error>
- TypeScript SDK：<https://www.npmjs.com/package/@agentclientprotocol/sdk>（默认入口 = 稳定 v1）、
  <https://agentclientprotocol.com/libraries/typescript>
- Zed External Agents（Custom Agent / `agent_servers`）：<https://zed.dev/docs/ai/external-agents>

## 7 实现记录

- 2026-11-17：官方 `@agentclientprotocol/sdk` 默认入口（v1，fluent `agent()`）在 Bun 下类型与运行时均可用，未走 §2.2 自实现备案。
- 但 SDK 的 `Connection.receive()` 对入站消息不等待，初始化闸门只在 `initialize` 的 `respondWithResult` 里放行。同一批 stdin 里紧跟的 `session/new` 会被误判为未初始化。实现在 `src/acp/inbound.ts` 对喂给 SDK 的字节流排队：上一条带 id 的请求对应的响应写出后才放行下一条。未改 SDK 源码。
- 客户端 `mcpServers`、工具/权限/cancel/diff 映射在后续步骤填写。
