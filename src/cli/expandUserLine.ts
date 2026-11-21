/**
 * 真人输入行发给模型前的展开（@ 引用 → chip 还原 → 图片），drain 与 #66 运行中转向共用同一份规则。
 *
 * 顺序沿用 v0.2.4 C3：先展开 @ 引用，再做 chip 还原 —— 反过来会把「粘贴内容里恰好出现的 @foo」
 * 也当成引用展开。可见副作用（已引用 / 已发送图片提示、触达路径记账）也在这里，两条路径一致。
 */
import { resolveLine, type Attachment, type ResolvedLine } from "../attachments.ts";
import { expandMessageReferences } from "../input/references.ts";
import { normalizeRelPath } from "../rules/index.ts";
import { c } from "../ui/theme.ts";
import type { AppSession } from "./sessionStart.ts";

export async function expandUserLine(
  s: Pick<AppSession, "cfg" | "ui" | "agent" | "mcpManager">,
  line: string,
  attachments: Attachment[],
): Promise<ResolvedLine> {
  const { cfg, ui, agent, mcpManager } = s;
  const expanded = await expandMessageReferences(line, {
    cwd: cfg.cwd,
    mcp: {
      connectedServers: mcpManager.connectedServerNames(),
      read: (server, uri) => mcpManager.readResource(server, uri),
    },
  });
  const resolved = resolveLine(expanded.text, attachments);
  if (expanded.refs.length > 0) {
    // issue #17：用户 @ 引用算触达（规则只看路径，不看被引用内容）。
    agent.noteTouchedPaths(
      expanded.refs
        .map((r) => normalizeRelPath(cfg.cwd, r.path))
        .filter((p): p is string => p !== null && p !== "."),
    );
    const lines = expanded.refs.reduce((n, r) => n + r.lines, 0);
    ui.line(c.dim(`· 已引用 ${expanded.refs.length} 个文件（+${lines} 行）`));
  }
  for (const e of expanded.errors) ui.line(c.dim(`· ${e}`));
  if (resolved.images.length > 0) {
    // PRD §5.8：用户对「发出去了什么」有知情权（图片可能含敏感信息）
    ui.line(c.dim(`· 已发送图片 ×${resolved.images.length}`));
  }
  return resolved;
}
