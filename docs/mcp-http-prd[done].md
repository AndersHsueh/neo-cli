# MCP 远程 HTTP 传输 PRD（issue #29）

> 状态：实现中（待审查）
> 关联：GitHub #29（#2 stdio 客户端之后的传输层补缺，不是重开 MCP 整件）。

## 1 背景

`#2` 只实现了 **stdio**：`mcpServers` 条目是 `{ command, args, env }` 本地进程。
生态里主流云端 MCP（GitHub / Notion / Sentry 等）对外是 **streamable HTTP**，没有这层传输，
neo 的 MCP 入口对这类服务是空的。

## 2 需求（首期）

1. `mcpServers` 条目支持远程端点：

```json
"mcpServers": {
  "github": {
    "type": "http",
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${TOKEN}" }
  }
}
```

   - `type` 与 `transport` 都认（兼容主流 CLI 写法）；缺省仍是 `stdio`；
   - `url` 必须是 `http(s)://` 绝对地址；`headers` 是静态键值（首期只做静态 Bearer）；
   - 缺 `url` / url 非法 / `sse` → 该条跳过并给**可读 warning**，不炸整个配置。
2. 连上后工具仍注册为 `mcp__<server>__<tool>`，审批与 plan 口径与 stdio **完全一致**（不新增旁路）。
3. 协议（streamable HTTP）：
   - 消息 POST 到 `url`；`Accept: application/json, text/event-stream`；
   - 响应是 JSON 或 SSE 都要能读（SSE 里跳过服务端通知，只取匹配 id 的结果）；
   - 响应头 `Mcp-Session-Id` 必须回带到后续请求；
   - 通知（`notifications/initialized`）回 202 即可。
4. 失败可读、不拖垮主循环：401 / 连不上 → 该 server 记 `error`（含 URL 与状态码），其余照常连接。
5. `/mcp` 状态里显示传输类型（`[stdio]` / `[http]`），错误行含端点信息。

## 3 验收

1. `type: "http"` + `url` + `headers` 能连接、注册工具、可被 dispatch 调用；
2. `Mcp-Session-Id` 回带、`Authorization` 透传、JSON 与 SSE 两种响应都能处理；
3. 401/连接失败不抛、状态可读、其它 server 不受影响；
4. `/mcp` 能看到 transport 与错误；
5. `bun x tsc --noEmit` 零错误、`bun test` 全绿、`bash scripts/verify.sh` 为 `ALL GREEN`。

## 4 非目标

- **SSE 旧传输**（GET 事件流拿 endpoint 的那套）已在 **issue #44** 实现（`src/mcp/sseRpc.ts`）：
  `transport: "sse"` + `url`，首事件 `event: endpoint` 握手，结果从 GET 长连接流回来，不重连。
- **OAuth 浏览器登录**（`/mcp login`）分期；首期静态 `headers` 足够接 GitHub PAT 类端点。
- 不重连、不做多进程协调（与 stdio 既有口径一致：失败看 `/mcp`，重启 neo）。
- 不改工具命名/审批/plan 的既有规则。
