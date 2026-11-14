# 规划-MCP-HTTP后续项

## 摘要

v0.4.81 后 MCP HTTP 的旧 SSE 与 OAuth 浏览器登录可行性及优先级

> 最后更新:2026-11-10
> 来源:session 20261110-095359-xdifnq · 2026-11-10 · 自动归纳

## 正文

针对 GitHub issue #35 中两项 MCP HTTP 后续能力，基于 v0.4.81（HEAD c1db9ee）源码完成只读分析。

1. 旧式 SSE GET 事件流：难度 M、影响低、修复把握高，约 2.5–3 人日。现有 `src/mcp/httpRpc.ts` 实现的是 streamable HTTP 的响应体事件流：仅一处 `fetch`，使用 POST；不存在 GET、EventSource 或 endpoint 握手。因此旧 SSE 是独立传输实现，不是配置开关。`src/mcp/jsonrpc.ts:62-70` 的 `McpRpc` 契约已解耦 manager 与传输，可在 `src/mcp/client.ts:163-173` 增加分支；`src/cli/commands.ts:754` 的 `/mcp` 面板已使用泛型 `[${transport}]`，无需联动修改。主要工作量在测试用假 server。建议列为第三批。

2. OAuth 浏览器登录：难度 L、影响中、修复把握中，完整实现约 7–8 人日。仓库内没有本地 HTTP server 先例，也没有凭据持久化机制；DCR、PKCE、回调端口、token 存储、refresh 与 TUI 时序均需新建。`src/mcp/httpRpc.ts:103-108` 目前仅把 401 拼成错误字符串，需增加“需要重新鉴权”的状态位。运行时 token 不应写入会被提交的 `settings.json`，但 settings 可增加可选 `"auth": "oauth"`，用于区别静态 headers 与 OAuth。建议排在第四批或更后；可先做手动粘贴回调 URL、不做 DCR 与自动刷新的最小版，约 3 人日后再评估。

PRD 的非目标与代码现状一致，未发现文档漂移；两项均不依赖其他 issue，可独立交付。

## 推理与依据

- 2026-11-10（session 20261110-095359-xdifnq）：2026-11-10，issue #44 的 MCP SSE 支持已实现并提交：commit `256bd50`，分支 `neo/feat-mcp-sse`，worktree `.neo/worktrees/feat-mcp-sse`，当前未合入 main、未 push、未关闭 issue、未改版本号。

实现落点：新增 `src/mcp/sseRpc.ts` 与 `src/mcp/sseParse.ts`；`SseRpc` 支持 GET 长连接、`event: endpoint` 握手、相对 endpoint 按 GET URL 解析、POST 接收 202、常驻读流、pending 请求映射，以及断流时立即 `failAll` 在途请求。SSE 事件块解析抽到公共模块，`httpRpc` 与 `sseRpc` 共用，避免保留两份解析实现。`src/mcp/client.ts` 已接入 SSE transport，`src/config.ts` 已增加 `McpSseServerConfig` 和与 HTTP 共用 url/headers 的配置分支。测试新增 `tests/mcp-sse.test.ts`（S1–S7），并更新 `tests/mcp.test.ts`、README 和 `docs/mcp-http-prd[done].md`。

验证结果：改前基线 1863 pass / 0 fail / 0 skip / 107 文件，改后 1870 pass / 0 fail / 0 skip / 108 文件，TypeScript 零错误，`bash scripts/verify.sh` ALL GREEN，PTY 31/31。

合入前仍有两点需 Lead 处理：① simplify 未完整执行，已识别 `request`/`post` 超时 timer 重复计时，以及 `dispatch` 响应配对结构与 `StdioRpc.handleLine` 相似，建议补一轮或明确接受；② `SseRpc` 使用只声明 `read`/`cancel` 的 `SseReader` 结构类型，而非 `ReadableStreamDefaultReader<Uint8Array>`，原因是后者额外要求 `readMany`，与 `body.getReader()` 推断类型不兼容（TS2741），并非绕过类型检查。
