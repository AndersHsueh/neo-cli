/**
 * 规划态的两个控制工具（issue #14）。
 *
 * 与 ask_user 同构：工具本身只做参数校验与结果序列化，会话态由宿主（Agent）持有。
 * 两者都只在规划态出现在工具清单里（见 agent/plan-mode.ts 的 PLAN_CONTROL_TOOLS），
 * 非规划态调用会明确报错 —— 不假装成功，否则模型会以为方案已经提交。
 */
import { parsePlanDraft, renderPlan } from "../agent/plan-mode.ts";
import { ToolError, type ToolImpl } from "./types.ts";

/** submit_plan：模型把分步方案交给用户确认。 */
export const submitPlanTool: ToolImpl = {
  sensitive: false,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: "submit_plan",
      description:
        "在规划态把分步方案提交给用户确认。提交后用户会看到「步骤 / 风险 / 涉及文件」，可以确认开始实施、要求修改或直接改方案。" +
        "提交前先把范围/约束/取舍澄清清楚；方案要短，用户要能一眼看完。非规划态不可用。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "一句话说清这份方案要做什么" },
          summary: { type: "string", description: "可选：一两句背景与整体思路" },
          steps: {
            type: "array",
            description: "3–8 步，每步写清「改哪里、改成什么」",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "步骤主文本（一句话）" },
                detail: { type: "string", description: "可选：补充说明" },
              },
              required: ["title"],
            },
          },
          risks: {
            type: "array",
            description: "会影响什么、可能坏什么、需要回滚什么；没有风险写「无」",
            items: { type: "string" },
          },
          files: {
            type: "array",
            description: "涉及文件的具体路径（不要写「相关文件」）",
            items: { type: "string" },
          },
        },
        required: ["title", "steps"],
      },
    },
  },
  async execute(args, ctx) {
    const host = ctx.planHost;
    if (!host) throw new ToolError("当前不在规划态，不能提交方案。用 /plan 进入规划态。");
    let draft;
    try {
      draft = parsePlanDraft(args);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    host.submitPlan(draft);
    return `方案已提交，等待用户确认。用户可确认开始实施、要求修改，或直接改方案。\n\n${renderPlan(draft)}`;
  },
};

/** exit_plan_mode：模型请求开始实施（用户确认后写操作才放行）。 */
export const exitPlanModeTool: ToolImpl = {
  sensitive: false,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: "exit_plan_mode",
      description:
        "在规划态请求用户确认并开始实施。宿主会把已提交的方案交给用户确认；确认后权限模式切回进入规划态之前的那一个，" +
        "写盘/执行类工具重新可用。没有已提交的方案时不要调用。非规划态不可用。",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "可选：一句话说明为什么现在可以动手" },
        },
        required: [],
      },
    },
  },
  async execute(args, ctx) {
    const host = ctx.planHost;
    if (!host) throw new ToolError("当前不在规划态，无需退出。");
    if (!host.planning) return "已不在规划态。";
    const reason = String(args["reason"] ?? "").trim();
    host.requestPlanApproval();
    return reason
      ? `已向用户请求开始实施（理由：${reason}）。等待用户确认，确认前不要尝试写盘或执行命令。`
      : "已向用户请求开始实施。等待用户确认，确认前不要尝试写盘或执行命令。";
  },
};
