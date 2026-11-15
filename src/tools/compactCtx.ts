/**
 * compact_ctx 工具：向宿主登记一次上下文压缩请求。
 */
import { ToolError, type ToolImpl } from "./types.ts";

export const compactCtx: ToolImpl = {
  // 只读操作：不碰任何文件，压缩本身是宿主代理的内部行为。
  sensitive: false,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: "compact_ctx",
      description:
        "请求压缩当前对话上下文：把历史总结成一份结构化摘要，释放窗口空间。" +
        "适合：刚完成大范围探索/长任务、准备进入下一阶段前主动整理；" +
        "或你判断历史里大量工具原始输出已不再需要逐字保留。" +
        "压缩会保留用户目标、关键结论与改动文件路径，丢弃冗余过程。" +
        "实际压缩在当前工具批次结束后执行，本工具返回的是登记回执。",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "简要说明为何需要压缩（会展示给用户）" },
        },
        required: [],
      },
    },
  },
  execute(args, ctx) {
    if (!ctx.host) {
      // 测试裸 ctx 或未来其它宿主：如实报告，不静默假装成功。
      throw new ToolError("当前环境没有宿主代理，无法压缩上下文");
    }
    ctx.host.requestCompact();
    const reason = String(args["reason"] ?? "").trim();
    return reason
      ? `已登记压缩请求（理由：${reason}）。将在本轮工具调用结束后执行。`
      : "已登记压缩请求。将在本轮工具调用结束后执行。";
  },
};
