/**
 * wiki 工具壳 —— wiki_search / wiki_write。
 *
 * 薄壳：校验与同步逻辑在 src/wiki/write.ts、src/wiki/search.ts（可单测），
 * 这里只做参数解析、布局解析与输出格式化。
 *
 * v0.2 记忆激活：两个工具都支持双作用域（scope）：
 *  - project（默认/原有行为）：<cwd>/.neo/wiki
 *  - user：~/.neo/wiki（跨项目个人记忆）
 * 检索严格遵守「先项目级、后用户级」；写入 user 作用域需显式指定，且走同一套
 * 命名/摘要/日期戳/INDEX/log 校验。
 */
import { join } from "node:path";
import type { WikiLayout } from "../wiki/paths.ts";
import { resolveUserWikiLayout, resolveWikiLayout } from "../wiki/paths.ts";
import { writeBack, WikiWriteError, type LogType, LOG_TYPES, formatLinkIssues } from "../wiki/write.ts";
import { searchWiki, formatSearchResults, wikiIsEmpty } from "../wiki/search.ts";
import { ensureScopeLayout } from "../memory/layout.ts";
import { ToolError, type ToolImpl } from "./types.ts";
import type { Config } from "../config.ts";

type Scope = "project" | "user";

/** 解析项目布局；失败抛带可行动提示的 ToolError。 */
function requireProjectLayout(cfg: Config): WikiLayout {
  const layout = resolveWikiLayout(cfg.cwd);
  if (!layout) {
    throw new ToolError(
      `当前目录不是 wiki 知识库（找不到 ${join(cfg.cwd, ".neo", "wiki", "wiki")} 或 ${join(cfg.cwd, "wiki")}）。` +
        `先跑 /init 创建骨架，或用 -C 切到知识库目录。`,
    );
  }
  return layout;
}

/** 用户级根目录（测试用部分 Config 可能没有 memory 段）。 */
function userRoot(cfg: Config): string | undefined {
  return cfg.memory?.userWikiDir;
}

/** 解析用户级布局（只读）；不存在/未配置返回 null。 */
function optionalUserLayout(cfg: Config): WikiLayout | null {
  const root = userRoot(cfg);
  return root ? resolveUserWikiLayout(root) : null;
}

/** 写路径用：确保用户级骨架存在。 */
function ensureUserLayout(cfg: Config): WikiLayout {
  const root = userRoot(cfg);
  if (!root) throw new ToolError("记忆配置缺少 user_wiki_dir，无法写用户级记忆。");
  return ensureScopeLayout("user", cfg.cwd, root);
}

/* ------------------------------------------------------------------ */
/* wiki_search                                                         */
/* ------------------------------------------------------------------ */

export const wikiSearchTool: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  parallelizable: true,
  spec: {
    type: "function",
    function: {
      name: "wiki_search",
      description:
        "在记忆 wiki 中检索主题页。多词 AND 匹配，按相关度排序，返回页面与命中行。" +
        "scope=auto（默认）先查项目级、再查用户级；项目级是本项目具体事实，用户级是跨项目个人背景。" +
        "适用：回忆这个项目之前做过什么、某个决策的沿革、用户的长期偏好。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词，空格分隔多个词（AND 语义）" },
          limit: { type: "integer", description: "每库最多返回条数，默认 10" },
          scope: {
            type: "string",
            enum: ["auto", "project", "user", "both"],
            description: "auto=项目优先合并；project/user=只查单库；both=两库合并",
          },
        },
        required: ["query"],
      },
    },
  },
  execute(args, ctx) {
    const query = String(args["query"] ?? "").trim();
    if (!query) throw new ToolError("query 不能为空");
    const limit = Math.max(1, Math.min(50, Number(args["limit"] ?? 10) || 10));
    const scope = String(args["scope"] ?? "auto");
    if (!["auto", "project", "user", "both"].includes(scope)) {
      throw new ToolError(`scope 必须是 auto/project/user/both，当前：${scope}`);
    }

    const userAllowed = ctx.cfg.memory?.scopeMode !== "project";
    if (!userAllowed && (scope === "user" || scope === "both")) {
      throw new ToolError("单次模式（-p）只用项目级记忆：不能检索用户级记忆。");
    }
    const wantProject = scope === "auto" || scope === "project" || scope === "both";
    const wantUser = userAllowed && (scope === "auto" || scope === "user" || scope === "both");

    const project = wantProject ? resolveWikiLayout(ctx.cfg.cwd) : null;
    const user = wantUser ? optionalUserLayout(ctx.cfg) : null;

    if (scope === "project" && !project) {
      throw new ToolError(`未找到项目 wiki 目录（${ctx.cfg.cwd}/.neo/wiki/wiki）。先跑 /init。`);
    }
    if (scope === "user" && !user) {
      throw new ToolError(
        `用户记忆库尚未创建（${userRoot(ctx.cfg) ?? ""}）。首次记忆写入或 /memory migrate 会创建它。`,
      );
    }
    if (!project && !user) {
      throw new ToolError(
        `当前目录不是 wiki 知识库（找不到 ${join(ctx.cfg.cwd, ".neo", "wiki", "wiki")} 或 ${join(ctx.cfg.cwd, "wiki")}），` +
          `用户记忆库也未创建。先跑 /init 创建项目骨架，或 /memory migrate 创建用户库。`,
      );
    }

    const projectHits = project && !wikiIsEmpty(project) ? searchWiki(project, query, limit) : [];
    const userHits = user && !wikiIsEmpty(user) ? searchWiki(user, query, limit) : [];

    // 只有一库可查时保持原输出形态（兼容既有行为与测试）
    if (scope === "project") return formatSearchResults(query, projectHits);
    if (scope === "user") return formatSearchResults(query, userHits);
    if (!project || !user) return formatSearchResults(query, projectHits.length > 0 ? projectHits : userHits);

    const lines: string[] = [];
    if (projectHits.length > 0) lines.push(`[项目] ${formatSearchResults(query, projectHits)}`);
    if (userHits.length > 0) lines.push(`[用户] ${formatSearchResults(query, userHits)}`);
    if (lines.length === 0) return `无命中: ${query}（项目级 / 用户级均未命中）`;
    return lines.join("\n\n");
  },
};

/* ------------------------------------------------------------------ */
/* wiki_write                                                          */
/* ------------------------------------------------------------------ */

export const wikiWriteTool: ToolImpl = {
  sensitive: false,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: "wiki_write",
      description:
        "向记忆 wiki 回填内容的唯一合法路径。自动强制：命名前缀校验、页面必备结构（## 摘要 + 日期戳）、" +
        "链接目标校验（[[X]] 目标不存在或只在另一层时会给出提示，指名缺失目标与所在层）、" +
        "INDEX.md 同步、log.md 登记。action=create 新建页（内容必须自带摘要与日期戳）；" +
        "action=append 往已有页追加「## 推理与依据」段并更新其日期戳。" +
        "scope=project（默认）写项目记忆；scope=user 写跨项目用户记忆（需显式指定）。" +
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
            description:
              "页面名（含 .md）。中文短语或登记前缀：待澄清- / 盘点-<YYYY-MM-DD>- / 对比- / 汇总- / <事件类型>-<MMDD>",
          },
          content: {
            type: "string",
            description: "create=完整页面内容（必须含 ## 摘要 与日期戳）；append=要追加的段落正文",
          },
          scope: {
            type: "string",
            enum: ["project", "user"],
            description: "project=项目记忆（默认）；user=跨项目用户记忆",
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
    const action = String(args["action"] ?? "");
    if (action !== "create" && action !== "append") {
      throw new ToolError(`action 必须是 create 或 append，当前：${action || "（空）"}`);
    }
    const scopeRaw = String(args["scope"] ?? "project");
    if (scopeRaw !== "project" && scopeRaw !== "user") {
      throw new ToolError(`scope 必须是 project 或 user，当前：${scopeRaw}`);
    }
    const scope = scopeRaw as Scope;
    if (scope === "user" && ctx.cfg.memory?.scopeMode === "project") {
      throw new ToolError("单次模式（-p）只用项目级记忆：不能写用户级记忆。");
    }

    const logType = args["log_type"] as LogType | undefined;
    if (logType !== undefined && !LOG_TYPES.includes(logType)) {
      throw new ToolError(`log_type 必须是 ${LOG_TYPES.join(", ")} 之一`);
    }

    const layout = scope === "user" ? ensureUserLayout(ctx.cfg) : requireProjectLayout(ctx.cfg);
    // 跨层判定用的另一层布局（issue #22）：写项目级时查用户级，反之亦然。
    // 另一层未创建 → null → 按「两层都无」处理。
    const otherLayout =
      scope === "user" ? resolveWikiLayout(ctx.cfg.cwd) : optionalUserLayout(ctx.cfg);
    try {
      const r = writeBack(layout, {
        action,
        page: String(args["page"] ?? ""),
        content: String(args["content"] ?? ""),
        logType,
        logTitle: String(args["log_title"] ?? ""),
        otherLayout,
      });
      const where = scope === "user" ? "用户记忆" : "项目记忆";
      const parts = [`已${r.action === "create" ? "新建" : "追加"} ${where}页 ${r.page}`];
      parts.push(r.indexSynced ? "INDEX.md 已同步" : "INDEX.md 无需变更");
      parts.push("log.md 已登记");
      if (r.linkIssues.length > 0) {
        // 警告不阻断写入（issue #22）：把缺失/跨层目标明确告诉模型，让它自己改链。
        parts.push(formatLinkIssues(r.linkIssues));
      }
      return parts.join("；\n");
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
