/**
 * list_dir 工具：列出目录内容，可选递归。
 */
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { isRealDir } from "../skills.ts";
import type { ToolImpl } from "./types.ts";
import { abs, requireDir } from "./fsPaths.ts";

export const listDir: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  parallelizable: true,
  spec: {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出目录内容，含名称、类型、大小、修改时间。可选递归。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，默认工作目录" },
          recursive: { type: "boolean", description: "是否递归，默认 false" },
          limit: { type: "integer", description: "最多返回条目数，默认 300" },
        },
        required: ["path"],
      },
    },
  },
  execute(args, ctx) {
    const path = abs(ctx, String(args["path"] ?? "."));
    requireDir(path);
    const recursive = args["recursive"] === true;
    const limit = Math.max(1, Number(args["limit"] ?? 300) || 300);

    const rows: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (rows.length >= limit) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        rows.push(`${"  ".repeat(depth)}! 无法读取: ${(e as Error).message}`);
        return;
      }
      // 目录优先，同类按名称排序
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad - bd || a.name.localeCompare(b.name);
      });
      for (const e of entries) {
        if (rows.length >= limit) return;
        const full = join(dir, e.name);
        const rel = relative(path, full) || e.name;
        if (isRealDir(full, e)) {
          rows.push(`${"  ".repeat(depth)}${rel}/`);
          if (recursive && depth < 6) walk(full, depth + 1);
        } else {
          let size = 0;
          let mtime = "";
          try {
            const st = statSync(full);
            size = st.size;
            mtime = st.mtime.toISOString().slice(0, 16).replace("T", " ");
          } catch {
            /* ignore */
          }
          rows.push(`${"  ".repeat(depth)}${rel}  (${size}B, ${mtime})`);
        }
      }
    };
    walk(path, 0);

    const head = `目录 ${path}`;
    const body = rows.join("\n");
    const tail = rows.length >= limit ? `\n… 已达 limit=${limit} 截断` : "";
    return `${head}\n${body}${tail}`;
  },
};
