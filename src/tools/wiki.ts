/**
 * wiki 工具壳 —— wiki_search / wiki_write。
 *
 * 薄壳：校验与同步逻辑在 src/wiki/write.ts、src/wiki/search.ts（可单测），
 * 这里只做参数解析、布局解析与输出格式化。
 *
 * wiki_write 不设 sensitive：它写的是 .neo/wiki/ 内部（项目记忆），不是用户代码；
 * 且工具内部已强制命名/结构校验与 log 同步。raw 的不可改语义由 write_file/edit_file
 * 的统一拦截保证（见 tools/index.ts 的 assertRawImmutable），不在这里重复设防。
 */
import { join } from "node:path";
import { resolveWikiLayout } from "../wiki/paths.ts";
import { writeBack, WikiWriteError, type LogType, LOG_TYPES } from "../wiki/write.ts";
import { searchWiki, formatSearchResults, wikiIsEmpty } from "../wiki/search.ts";
import { ToolError, type ToolCtx, type ToolImpl } from "./types.ts";
import type { Config } from "../config.ts";

/** 解析布局；失败抛带可行动提示的 ToolError。 */
function requireLayout(cfg: Config): NonNullable<ReturnType<typeof resolveWikiLayout>> {
  const layout = resolveWikiLayout(cfg.cwd);
  if (!layout) {
    throw new ToolError(
      `当前目录不是 wiki 知识库（找不到 ${join(cfg.cwd, ".neo", "wiki", "wiki")} 或 ${join(cfg.cwd, "wiki")}）。` +
        `先跑 /init 创建骨架，或用 -C 切到知识库目录。`,
    );
  }
  return layout;
}

/* ------------------------------------------------------------------ */
/* wiki_search                                                         */
/* ------------------------------------------------------------------ */

export const wikiSearchTool: ToolImpl = {
  sensitive: false,
  spec: {
    type: "function",
    function: {
      name: "wiki_search",
      description:
        "在项目 wiki 知识库中检索主题页。多词 AND 匹配，按相关度排序，返回页面与命中行。" +
        "适用：回忆这个项目之前做过什么、某个决策的沿革、某主题已有哪些结论。" +
        "小规模先看 INDEX.md（会话开始时已注入清单）；页面多或关键词明确时用本工具。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词，空格分隔多个词（AND 语义）" },
          limit: { type: "integer", description: "最多返回条数，默认 10" },
        },
        required: ["query"],
      },
    },
  },
  execute(args, ctx) {
    const layout = requireLayout(ctx.cfg);
    const query = String(args["query"] ?? "").trim();
    if (!query) throw new ToolError("query 不能为空");
    if (wikiIsEmpty(layout)) {
      return "wiki 库为空。把素材写入 .neo/wiki/raw/ 后跑 /ingest 即可开始积累。";
    }
    const limit = Math.max(1, Math.min(50, Number(args["limit"] ?? 10) || 10));
    return formatSearchResults(query, searchWiki(layout, query, limit));
  },
};

/* ------------------------------------------------------------------ */
/* wiki_write                                                          */
/* ------------------------------------------------------------------ */

export const wikiWriteTool: ToolImpl = {
  sensitive: false,
  spec: {
    type: "function",
    function: {
      name: "wiki_write",
      description:
        "向项目 wiki 回填内容的唯一合法路径。自动强制：命名前缀校验、页面必备结构（## 摘要 + 日期戳）、" +
        "INDEX.md 同步、log.md 登记。action=create 新建页（内容必须自带摘要与日期戳）；" +
        "action=append 往已有页追加「## 推理与依据」段并更新其日期戳。" +
        "raw/ 的写入不经过本工具（raw 可创建/删除，不可改已有文件）。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "append"],
            description: "create=新建主题页；append=往已有页追加推理与依据段",
          },
          page: {
            type: "string",
            description: "页面名（含 .md）。命名前缀必须来自登记表：待澄清- / 盘点-<YYYY-MM-DD>- / 对比-<A>-与-<B> / 汇总- / <事件类型>-<MMDD>，或无前缀中文短语",
          },
          content: {
            type: "string",
            description: "create=完整页面内容（必须含 ## 摘要 与日期戳）；append=要追加的段落正文",
          },
          log_type: {
            type: "string",
            enum: [...LOG_TYPES],
            description: "log 条目类型，默认 query",
          },
          log_title: { type: "string", description: "log 条目一句话（grep 友好，单行）" },
        },
        required: ["action", "page", "content", "log_title"],
      },
    },
  },
  execute(args, ctx) {
    const layout = requireLayout(ctx.cfg);
    const action = String(args["action"] ?? "");
    if (action !== "create" && action !== "append") {
      throw new ToolError(`action 必须是 create 或 append，当前：${action || "（空）"}`);
    }
    const logType = args["log_type"] as LogType | undefined;
    if (logType !== undefined && !LOG_TYPES.includes(logType)) {
      throw new ToolError(`log_type 必须是 ${LOG_TYPES.join(", ")} 之一`);
    }
    try {
      const r = writeBack(layout, {
        action,
        page: String(args["page"] ?? ""),
        content: String(args["content"] ?? ""),
        logType,
        logTitle: String(args["log_title"] ?? ""),
      });
      const parts = [`已${r.action === "create" ? "新建" : "追加"} ${r.page}`];
      parts.push(r.indexSynced ? "INDEX.md 已同步" : "INDEX.md 无需变更");
      parts.push("log.md 已登记");
      return parts.join("；");
    } catch (e) {
      if (e instanceof WikiWriteError) throw new ToolError(e.message);
      throw e;
    }
  },
};

/** 注册入口：组合根调用。返回注销函数（测试清理用）。 */
export function registerWikiTools(register: (t: ToolImpl) => () => void): () => void {
  const unSearch = register(wikiSearchTool);
  const unWrite = register(wikiWriteTool);
  return () => {
    unSearch();
    unWrite();
  };
}
