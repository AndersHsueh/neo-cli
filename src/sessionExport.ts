/**
 * 会话导出（v0.4.1 B4 / D4）。
 *
 * `/export [session-id]` 把一段会话渲染成 Markdown：保留用户/助手正文、
 * 工具调用与工具结果（fenced code），并带上最后一轮诊断状态，便于归档/复盘。
 * 纯函数（meta+messages → text），命令层只负责读写文件。
 */
import { contentText, type Message } from "./llm.ts";
import type { SessionMeta } from "./session.ts";

function fence(text: string): string {
  // 内容本身含 ``` 时用四反引号围栏，避免提前闭合。
  const ticks = text.includes("```") ? "````" : "```";
  return [ticks, text, ticks].join("\n");
}

function toolCallLines(m: Message): string[] {
  const calls = m.tool_calls ?? [];
  if (calls.length === 0) return [];
  return calls.map((c) => {
    const args = c.function.arguments ?? "";
    const flat = args.replace(/\s+/g, " ").slice(0, 500);
    return `- \`${c.function.name}\` ${flat.length < args.length ? flat + "…" : flat}`;
  });
}

export function renderSessionMarkdown(meta: SessionMeta, messages: Message[]): string {
  const lines: string[] = [];
  lines.push(`# neo 会话导出 · ${meta.id}`, "");
  lines.push(`- 模型：${meta.model}`);
  lines.push(`- 工作目录：${meta.cwd}`);
  lines.push(`- 轮次：${meta.turns}`);
  lines.push(`- 创建：${meta.createdAt}`);
  lines.push(`- 更新：${meta.updatedAt}`);
  if (meta.lastTurn) {
    const lt = meta.lastTurn;
    lines.push(
      `- 最后一轮：${lt.outcome}${lt.errorMessage ? `（${lt.errorMessage}）` : ""}` +
        `${lt.at ? ` @ ${lt.at}` : ""}`,
    );
  }
  lines.push("", "---", "");

  let n = 0;
  for (const m of messages) {
    if (m.role === "system") continue;
    n += 1;
    if (m.role === "user") {
      lines.push(`## 用户`, "", contentText(m.content) ?? "", "");
    } else if (m.role === "assistant") {
      const text = contentText(m.content) ?? "";
      const calls = toolCallLines(m);
      if (text.trim() === "" && calls.length === 0) continue;
      lines.push(`## 助手`, "");
      if (text.trim() !== "") lines.push(text, "");
      if (calls.length > 0) lines.push("工具调用：", ...calls, "");
    } else if (m.role === "tool") {
      lines.push(`### 工具结果${m.name ? ` · ${m.name}` : ""}`, "");
      lines.push(fence(contentText(m.content) ?? ""), "");
    }
  }
  if (n === 0) lines.push("（空会话）", "");
  return lines.join("\n");
}
