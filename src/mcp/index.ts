/**
 * MCP 模块出口（issue #2）。组合根只从这里取东西。
 */
export {
  McpManager,
  formatCallResult,
  type McpServerState,
  type McpServerStatus,
  type McpToolEntry,
  type McpToolInfo,
} from "./client.ts";
export { StdioRpc, RpcError } from "./jsonrpc.ts";
export {
  makeMcpTool,
  mcpToolName,
  nameFor,
  nameCandidates,
  computeMcpNames,
  parseMcpToolName,
  isMcpTool,
  isValidToolName,
  sanitizeSegment,
  shortHash,
  MCP_TOOL_PREFIX,
  MCP_NAME_PATTERN,
} from "./tool.ts";
