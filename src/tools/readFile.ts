/**
 * read_file 工具：带行号读取文本，支持 offset/limit 分页。
 */
import { readFileSync, statSync } from "node:fs";
import { ToolError, type ToolImpl } from "./types.ts";
import { MAX_READ, abs, requireFile } from "./fsPaths.ts";

export const readFile: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  parallelizable: true,
  spec: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "读取文本文件内容。返回带行号的内容（cat -n 风格）。可指定 offset/limit 分页读取大文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径，相对路径基于工作目录" },
          offset: { type: "integer", description: "起始行号（1 起），默认 1" },
          limit: { type: "integer", description: "最多读取行数，默认 2000" },
        },
        required: ["path"],
      },
    },
  },
  execute(args, ctx) {
    const path = abs(ctx, String(args["path"] ?? ""));
    requireFile(path);
    const offset = Math.max(1, Number(args["offset"] ?? 1) || 1);
    const limit = Math.max(1, Number(args["limit"] ?? 2000) || 2000);

    const st = statSync(path);
    if (st.size > MAX_READ) throw new ToolError(`文件过大 (${st.size} bytes)，请用 offset/limit 分段读取`);

    const raw = readFileSync(path, "utf8");
    const all = raw.split("\n");
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((l, i) => `${String(offset + i).padStart(5, " ")}\t${l}`).join("\n");
    const more = all.length > offset - 1 + limit ? `\n\n[还有 ${all.length - (offset - 1 + limit)} 行未显示]` : "";
    // 完整读取才记账：从第 1 行起且切片覆盖全部行（结果中没有「还有 N 行未显示」）。
    // 部分读取既不更新指纹，也不关闭已启用的检查。
    if (offset === 1 && more === "") {
      ctx.fileFreshness?.recordCompleteRead(path, raw);
    }
    return `${body}${more}`;
  },
};
