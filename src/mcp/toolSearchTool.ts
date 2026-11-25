/**
 * `tool_search` 工具（issue #68）：把 MCP 工具的 schema 按需装进本会话上下文。
 *
 * 形态取舍：
 *  - **一个工具，不拆 search / load**：模型看目录 → 搜 → 用，多一跳就多一次往返；
 *    命中即装入，没有「先搜再确认」的第二跳。
 *  - **普通 function 工具**：OpenAI 兼容与 Anthropic 都按普通 tools 数组发出，
 *    不走任何厂商专用的 tool-search / deferred-tools 协议 —— 行为不依赖后端能力。
 *  - **不标 sensitive**：它只改本会话的「已装入集合」，不碰外部世界。
 *  - **不设累计装入上限**：可以反复搜到需要的都在上下文里；压缩或清会话后自然降回。
 *
 * 只在启用延迟加载时进入 `Agent.toolSpecsFor()`（见 agent/loop.ts），
 * 但**始终**注册进工具表 —— dispatch 得找得到它，规划态白名单里也没有它。
 */
import { toolSpecs } from "../tools/index.ts";
import { ToolError, type ToolImpl } from "../tools/types.ts";
import {
  TOOL_SEARCH_DEFAULT_LIMIT,
  TOOL_SEARCH_MAX_LIMIT,
  TOOL_SEARCH_NAME,
  catalogEntries,
  clampLimit,
  matchCatalog,
  markMcpLoadedOn,
  mcpLoadHostOf,
  toolSearchEnabled,
  truncateDescription,
} from "./toolSearch.ts";

/** 本会话已加载的工具名（宿主缺失时视为空集 —— 独立调用不记账）。 */
function loadedOf(host: unknown): Set<string> {
  const h = mcpLoadHostOf(host);
  if (!h?.mcpLoadedNames) return new Set();
  try {
    return new Set(h.mcpLoadedNames());
  } catch {
    return new Set();
  }
}

export const toolSearchTool: ToolImpl = {
  sensitive: false,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: TOOL_SEARCH_NAME,
      description:
        "搜索并装入 MCP 工具的定义（按注册名/描述做大小写不敏感匹配）。" +
        "系统提示里「MCP 工具目录」列出的工具只有名字与简述、没有参数 schema；" +
        "命中后它们的完整定义会在下一次模型请求里出现，随后即可直接调用（走既有审批）。" +
        `默认最多装入 ${TOOL_SEARCH_DEFAULT_LIMIT} 个，上限 ${TOOL_SEARCH_MAX_LIMIT} 个；可多次搜索继续装入。` +
        "空查询或无命中返回空结果，不装入任何工具。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "关键词（按空白分词，全部命中才算匹配）；可写工具名的一部分或用途描述",
          },
          limit: {
            type: "number",
            description: `本次最多装入几个（默认 ${TOOL_SEARCH_DEFAULT_LIMIT}，上限 ${TOOL_SEARCH_MAX_LIMIT}）`,
          },
        },
        required: ["query"],
      },
    },
  },
  async execute(args, ctx) {
    const query = String(args["query"] ?? "").trim();
    const limit = clampLimit(args["limit"]);
    // 未启用延迟加载时不该被调到；真调到了就如实说明，而不是假装装入。
    const all = toolSpecs(ctx.cfg);
    if (!toolSearchEnabled(ctx.cfg, all)) {
      throw new ToolError(
        "当前没有启用 MCP 工具延迟加载（mcp.tool_search），所有 MCP 工具已全量装入，无需搜索。",
      );
    }
    if (query === "") {
      return "空查询：没有命中任何工具，也未装入任何工具。请给出工具名的一部分或用途关键词。";
    }
    const entries = catalogEntries(ctx.cfg, all, loadedOf(ctx.host));
    const hits = matchCatalog(entries, query).slice(0, limit);
    if (hits.length === 0) {
      return `没有命中任何未装入的 MCP 工具（query="${query}"，0 个）。未装入任何工具。`;
    }
    for (const h of hits) markMcpLoadedOn(ctx.host, h.name);
    const lines = hits.map(
      (h) => `- ${h.name}：${truncateDescription(h.description)}`,
    );
    return [
      `已装入 ${hits.length} 个 MCP 工具（query="${query}"）：`,
      ...lines,
      "",
      "它们的完整参数定义会在下一次模型请求里生效，随后可直接调用（MCP 工具调用前需用户批准）。",
    ].join("\n");
  },
};
