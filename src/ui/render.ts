/**
 * 轻量 Markdown 渲染器。
 * 目标不是完整 CommonMark，而是让终端输出「像样」：
 * 代码块加边框、行内代码着色、标题加粗、列表符号化。
 */
import { c } from "./theme.ts";

const fence = "─";

function isFence(line: string): boolean {
  return /^\s{0,3}(```|~~~)/.test(line);
}

function fenceLang(line: string): string {
  const m = /^\s{0,3}(?:```|~~~)(.*)$/.exec(line);
  return (m?.[1] ?? "").trim().split(/\s+/)[0] ?? "";
}

/** 行内代码 / 粗体 / 斜体 / 链接的着色。 */
export function renderInline(s: string): string {
  // 先抽出行内代码，避免其内部被其他规则改写
  const codes: string[] = [];
  let work = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  work = work
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => c.bold(c.bright(t)))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, p: string, t: string) => `${p}${c.italic(t)}`)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) =>
      `${c.accent(t)} ${c.dim(`<${u}>`)}`);

  work = work.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => {
    const code = codes[Number(i)] ?? "";
    return c.accent(code);
  });

  return work;
}

function renderBlock(lines: string[], width: number): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // 代码块
    if (isFence(line)) {
      const lang = fenceLang(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i++;
      }
      i++; // 跳过结束围栏
      const label = lang ? c.dim(` ${lang} `) : c.dim(" ");
      out.push(c.dim(fence.repeat(2)) + label);
      for (const b of body) out.push(c.dim("│ ") + c.mid(b));
      out.push(c.dim(fence.repeat(Math.max(2, width))));
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = (h[1] ?? "#").length;
      const text = h[2] ?? "";
      const marker = c.accent("#".repeat(level) + " ");
      out.push(level <= 2 ? c.bold(c.bright(text)) : c.bright(text));
      void marker;
      i++;
      continue;
    }

    // 分隔线
    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(c.dim("─".repeat(Math.max(4, Math.min(width, 80)))));
      i++;
      continue;
    }

    // 引用
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out.push(c.dim("│ ") + c.dim(renderInline(q[1] ?? "")));
      i++;
      continue;
    }

    // 无序列表
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      const pad = ul[1] ?? "";
      out.push(`${pad}${c.accent("•")} ${renderInline(ul[2] ?? "")}`);
      i++;
      continue;
    }

    // 有序列表
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      const pad = ol[1] ?? "";
      const num = (ol[2] ?? "1").padStart(2, " ");
      out.push(`${pad}${c.accent(num + ".")} ${renderInline(ol[3] ?? "")}`);
      i++;
      continue;
    }

    // 表格（仅做竖线着色，不做对齐）
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|");
      if (/^[\s:|-]+$/.test(line)) {
        out.push(c.dim("├" + "─".repeat(Math.max(4, Math.min(width, 60))) + "┤"));
      } else {
        out.push(c.dim("│ ") + cells.map((x) => c.text(x.trim())).join(c.dim(" │ ")) + c.dim(" │"));
      }
      i++;
      continue;
    }

    // 空行
    if (line.trim() === "") {
      out.push("");
      i++;
      continue;
    }

    // 普通段落：保留原样着色
    out.push(renderInline(line));
    i++;
  }

  return out;
}

export function renderMarkdown(md: string, width = 100): string {
  return renderBlock(md.replace(/\r\n/g, "\n").split("\n"), width).join("\n");
}
