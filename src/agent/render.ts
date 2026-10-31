/**
 * 回答渲染与工具参数预览。
 *
 * 放在叶子模块：loop 和历史回放都要用，但不能让回放反向依赖 Agent。
 */
import { renderMarkdown } from "../ui/render.ts";

export function truncateArgs(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

export function previewArgs(s: string): string {
  return truncateArgs(s, 100);
}

/** 渲染一次完整的助手回答（用于历史回放 / 导出）。 */
export function renderFinal(md: string, width = 100): string {
  return renderMarkdown(md, width);
}
