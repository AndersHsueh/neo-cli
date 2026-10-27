/**
 * ask_user 工具（v0.4.1 B2）。
 *
 * 模型在关键分叉/歧义/破坏性操作前主动向用户提问；TUI 侧由 Composer 渲染
 * 单选/多选/自由输入模态。工具本身只做参数校验与结果序列化：
 *  - 无 host（-p / 非交互 / 测试裸 ctx）→ 明确报错，不假装成功；
 *  - 用户 Esc 取消 → {status:"canceled"}，模型可继续或换问法；
 *  - 回答以 JSON 字符串回给模型，便于稳定解析。
 */
import { ToolError, type ToolImpl } from "./types.ts";
import type { AskUserRequest } from "../ui/askUser.ts";

export function makeAskUserTool(deps: {
  ask: (req: AskUserRequest) => Promise<{ status: "answered"; selected: string[]; custom: string | null } | { status: "canceled" }>;
}): ToolImpl {
  return {
    sensitive: false,
    spec: {
      type: "function",
      function: {
        name: "ask_user",
        description:
          "向用户提一个问题并从 TUI 拿回结构化回答。适用：业务口径/模板结构有歧义、需要用户在方案间选择、" +
          "删除或覆盖交付物等不可逆操作前确认。单选/多选/自由输入由用户操作决定。" +
          "不要用本工具代替权限审批；一次只问一个真正需要人回答的问题，能自己查证的事实不要问。",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "问题正文（必填，≤200 字，具体、可回答）",
            },
            header: { type: "string", description: "短标题（可选，≤12 字）" },
            context: {
              type: "string",
              description: "为什么问/影响什么（可选，≤400 字，暗色展示）",
            },
            options: {
              type: "array",
              description: "选项（0–5 个；为空则直接进入自由输入）",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "选项主文本（≤40 字）" },
                  description: { type: "string", description: "选项说明（可选，≤120 字）" },
                },
                required: ["label"],
              },
            },
            multi_select: {
              type: "boolean",
              description: "是否多选（Space 勾选，Enter 提交，至少 1 项）",
            },
            allow_custom: {
              type: "boolean",
              description: "是否追加「其他（自行输入）」入口，默认 true",
            },
          },
          required: ["question"],
        },
      },
    },
    async execute(args, ctx) {
      if (!ctx.askUser) {
        throw new ToolError("当前环境无法向用户提问（非交互模式或未接入 TUI）。");
      }
      const question = String(args["question"] ?? "").trim();
      if (question.length < 2 || question.length > 200) {
        throw new ToolError(`question 长度必须在 2–200 字之间（当前 ${question.length}）`);
      }
      const header = args["header"] === undefined ? undefined : String(args["header"]).trim();
      if (header && header.length > 12) throw new ToolError("header 最多 12 字");
      const contextRaw = args["context"] === undefined ? undefined : String(args["context"]).trim();
      if (contextRaw && contextRaw.length > 400) throw new ToolError("context 最多 400 字");

      const rawOptions = args["options"];
      if (rawOptions !== undefined && !Array.isArray(rawOptions)) {
        throw new ToolError("options 必须是数组");
      }
      const options = (rawOptions ?? []) as Array<Record<string, unknown>>;
      if (options.length > 5) throw new ToolError("options 最多 5 个");
      const seen = new Set<string>();
      const parsed = options.map((o, i) => {
        if (typeof o !== "object" || o === null || Array.isArray(o)) {
          throw new ToolError(`options[${i}] 必须是对象`);
        }
        const label = String(o["label"] ?? "").trim();
        const desc = o["description"] === undefined ? undefined : String(o["description"]).trim();
        if (!label) throw new ToolError(`options[${i}].label 不能为空`);
        if (label.length > 40) throw new ToolError(`options[${i}].label 最多 40 字`);
        if (desc && desc.length > 120) throw new ToolError(`options[${i}].description 最多 120 字`);
        if (seen.has(label)) throw new ToolError(`options 里 label 重复：${label}`);
        seen.add(label);
        return { label, ...(desc ? { description: desc } : {}) };
      });

      const multiSelect = args["multi_select"] === true;
      if (multiSelect && parsed.length === 0) {
        throw new ToolError("multi_select=true 时 options 不能为空");
      }
      const allowCustom = args["allow_custom"] !== false;
      if (parsed.length === 0 && !allowCustom) {
        throw new ToolError("options 为空且 allow_custom=false：没有可回答的入口");
      }

      const req: AskUserRequest = {
        question,
        ...(header ? { header } : {}),
        ...(contextRaw ? { context: contextRaw } : {}),
        ...(parsed.length > 0 ? { options: parsed } : {}),
        ...(multiSelect ? { multiSelect: true } : {}),
        allowCustom,
      };

      // 宿主 abort（例如 Ctrl+C）时主动关闭模态，避免 UI 永远停在提问态。
      let onAbort: (() => void) | null = null;
      const aborted = new Promise<{ status: "canceled" }>((resolve) => {
        if (!ctx.signal) return;
        if (ctx.signal.aborted) {
          resolve({ status: "canceled" });
          return;
        }
        onAbort = () => {
          ctx.cancelAskUser?.();
          resolve({ status: "canceled" });
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        if (ctx.signal?.aborted) return JSON.stringify({ status: "canceled" });
        const answer = await Promise.race([deps.ask(req), aborted]);
        return JSON.stringify(answer);
      } finally {
        if (onAbort && ctx.signal) ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
