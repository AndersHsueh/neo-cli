/**
 * remember 工具 —— 模型显式写入记忆（v0.2 记忆激活 §7.6.6）。
 *
 * 与自动归纳共用同一条合并管线（去重/上限/落页校验），区别只是：
 *  - 跳过价值判定（模型认为值得记就记）；
 *  - 可以显式指定 scope；auto 时由提炼器按内容判断。
 *
 * 子代理不可见（TOOL_NAMES_EXCLUDED_FOR_SUBAGENT），防止子代理误写主记忆。
 */
import { ToolError, type ToolImpl } from "./types.ts";

export interface RememberDeps {
  /** 返回给模型看的回执（写队列已登记，不等待 LLM）。 */
  remember: (body: string, scope?: "project" | "user") => Promise<string>;
}

export function makeRememberTool(deps: RememberDeps): ToolImpl {
  return {
    sensitive: false,
    spec: {
      type: "function",
      function: {
        name: "remember",
        description:
          "把长期有价值的结论或用户偏好写入记忆（异步提炼后落页）。" +
          "适用：做出决策、解决了一个需要记住根因的问题、用户明确表达长期偏好/约定时。" +
          "scope=auto（默认）由内容判断归属项目级还是用户级；寒暄、临时状态、一次性命中不要写。",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "要记住的事实（一句话到一小段，写清为什么/怎么做，≥8 字符）",
            },
            scope: {
              type: "string",
              enum: ["auto", "project", "user"],
              description: "auto=自动判断；project=项目记忆；user=跨项目用户记忆",
            },
          },
          required: ["text"],
        },
      },
    },
    async execute(args) {
      const text = String(args["text"] ?? "").trim();
      if (text.length < 8) throw new ToolError("text 太短（<8 字符），请写清要记住的结论与依据");
      const scopeRaw = String(args["scope"] ?? "auto");
      if (scopeRaw !== "auto" && scopeRaw !== "project" && scopeRaw !== "user") {
        throw new ToolError(`scope 必须是 auto/project/user，当前：${scopeRaw}`);
      }
      const hint = scopeRaw === "auto" ? undefined : (scopeRaw as "project" | "user");
      return await deps.remember(text, hint);
    },
  };
}
