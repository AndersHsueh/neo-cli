/**
 * issue #87：专用 monitor 工具（不要做成 shell + background:true，也不要靠 shell_output 轮询）。
 */
import { ToolError, gateTool, notExecuted, type ToolImpl } from "./types.ts";
import { sessionMonitors } from "../monitors.ts";
import { formatMonitorJobs, formatMonitorTimeout, parseMonitorTimeoutMs } from "../monitor.ts";

export const monitorTool: ToolImpl = {
  sensitive: true,
  kind: "capability",
  spec: {
    type: "function",
    function: {
      name: "monitor",
      description:
        "启动有限时的命令输出监视：行到达时自动回流当前会话，不必轮询 shell_output。" +
        "action 为 start / list / stop（省略 action 但提供 command 视为 start）。" +
        "start 必填 command；timeout_ms 默认 300000（5 分钟），最长 30 分钟（-p 最长 10 分钟）。" +
        "stop 必填 id 或 all。用户也可用 /monitor 启/列/停。" +
        "本轮不支持 WebSocket 源。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["start", "list", "stop"],
            description: "start 启动、list 列出、stop 取消。省略且带了 command 视为 start。",
          },
          command: { type: "string", description: "要监视的命令（start 必填）" },
          timeout_ms: {
            type: "integer",
            description: "时限毫秒，默认 300000（5 分钟）。超过最长时限会被拒绝，不会暗默夹断。",
          },
          description: { type: "string", description: "短标签，用于列表和回流块标题；省略则用命令摘要。" },
          id: { type: "string", description: "stop 时的监视 id（如 mon-1），或 all。" },
        },
        required: [],
      },
    },
  },
  async execute(args, ctx) {
    if (args["ws"] !== undefined) {
      throw new ToolError("WebSocket 源后置，本轮仅支持命令输出流监视。");
    }

    const actionRaw = args["action"] === undefined ? "" : String(args["action"]).trim().toLowerCase();
    const command = args["command"] === undefined ? "" : String(args["command"]).trim();
    let action: "start" | "list" | "stop";
    if (actionRaw === "start" || actionRaw === "list" || actionRaw === "stop") action = actionRaw;
    else if (actionRaw === "" && command) action = "start";
    else if (actionRaw === "") action = "list";
    else throw new ToolError(`未知 action：${actionRaw}（可选 start / list / stop）`);

    if (action === "list") {
      const lines = formatMonitorJobs(sessionMonitors.list());
      return lines.join("\n");
    }

    if (action === "stop") {
      const id = String(args["id"] ?? "").trim();
      if (!id) throw new ToolError("stop 需要 id 或 all。用法：monitor({ action: \"stop\", id: \"mon-1\" })");
      const n = sessionMonitors.stop(id);
      if (n > 0) return id === "all" ? `已取消 ${n} 条监视。` : `已取消监视 ${id}。`;
      return id === "all" ? "没有可取消的监视。" : `没有正在运行的监视 ${id}。`;
    }

    // start
    if (!command) throw new ToolError("start 需要 command");
    if (ctx.readOnly) {
      notExecuted(`plan 模式禁止执行 shell：${command}`);
    }

    const timeoutRaw = args["timeout_ms"];
    const oneshot = ctx.nonInteractive === true;
    if (timeoutRaw !== undefined) {
      const checked = parseMonitorTimeoutMs(timeoutRaw, { oneshot });
      if (!checked.ok) throw new ToolError(checked.error);
    }

    const denied = await gateTool(ctx, "monitor", args, `监视: ${command}`);
    if (denied !== null) notExecuted(denied);
    if (ctx.signal?.aborted) notExecuted("本轮已取消，未执行（monitor）。");

    const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
    const started = sessionMonitors.start({
      command,
      cwd: ctx.cfg.cwd,
      timeoutMs,
      description: args["description"] === undefined ? undefined : String(args["description"]),
      owner: ctx.monitorOwnerId ? { kind: "subagent", id: ctx.monitorOwnerId } : { kind: "session" },
    });
    if (!started.ok) throw new ToolError(started.error);
    return (
      `已开始监视 ${started.id} · 时限 ${formatMonitorTimeout(started.timeoutMs)}。` +
      `行到达时会回流当前会话，无需再调 shell_output。` +
      `用 monitor({ action: "stop", id: "${started.id}" }) 或 /monitor stop ${started.id} 取消。`
    );
  },
};
