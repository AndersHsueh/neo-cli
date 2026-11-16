/**
 * glob 工具与 glob 模式编译。
 */
import { statSync } from "node:fs";
import type { ToolImpl } from "./types.ts";
import { listSearchFiles } from "./fileList.ts";
import { abs, requireDir } from "./fsPaths.ts";

export const globTool: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  parallelizable: true,
  spec: {
    type: "function",
    function: {
      name: "glob",
      description: "按 glob 模式查找文件，例如 src/**/*.ts。结果按修改时间倒序。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "glob 模式" },
          path: { type: "string", description: "搜索根目录，默认工作目录" },
          limit: { type: "integer", description: "最多返回条数，默认 200" },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(args, ctx) {
    const pattern = String(args["pattern"] ?? "");
    const root = abs(ctx, String(args["path"] ?? "."));
    requireDir(root);
    const limit = Math.max(1, Number(args["limit"] ?? 200) || 200);

    const re = globToRegExp(pattern);
    const { files, backend, truncated } = await listSearchFiles(root);
    const hits: Array<{ p: string; mtime: number }> = [];

    for (const f of files) {
      if (hits.length >= limit * 4) break;
      const base = f.rel.split("/").pop() ?? f.rel;
      if (!re.test(f.rel) && !re.test(base)) continue;
      let m = 0;
      try {
        m = statSync(f.full).mtimeMs;
      } catch {
        /* ignore */
      }
      hits.push({ p: f.rel, mtime: m });
    }

    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, limit);
    if (shown.length === 0) return `无匹配文件: ${pattern}`;
    const notes: string[] = [];
    if (backend === "git") notes.push("git 文件清单，已按 .gitignore 排除");
    if (truncated) notes.push("文件枚举已截断");
    const note = notes.length > 0 ? `\n（${notes.join("；")}）` : "";
    return `匹配 ${hits.length} 个文件（显示前 ${shown.length}）:\n${shown.map((h) => h.p).join("\n")}${note}`;
  },
};

/**
 * glob 字符类 → 正则字符类。
 *
 * glob 的 `[!abc]` 是「非 a/b/c」，原样塞进 RegExp 会被读成字面量 `!` 加 `abc`，
 * 语义正好相反（`[!abc].ts` 会命中 `a.ts` 而漏掉 `d.ts`）。这里做两件事：
 *  1. `!` / `^` 开头的取反统一转成 JS 的 `[^...]`；
 *  2. 类内的 `\` 与 `]` 转义，避免生成非法正则（如 `[a\]`）。
 * 空类（`[]`）在 glob 里是字面量，退化成转义后的 `\[\]` 由调用方处理更简单 ——
 * 这里返回 `[]` 会让整条正则抛 SyntaxError，故显式兜底成「永不匹配」。
 */
function charClass(body: string): string {
  let inner = body;
  let negate = false;
  if (inner.startsWith("!") || inner.startsWith("^")) {
    negate = true;
    inner = inner.slice(1);
  }
  if (inner === "") return "(?!)"; // 空字符类：不匹配任何字符
  inner = inner.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  return negate ? `[^${inner}]` : `[${inner}]`;
}

/** 最小 glob → RegExp。支持 *, **, ?, {a,b}, 字符类（含 [!...] 取反）。 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** 匹配跨目录
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end !== -1) {
        const alts = pattern
          .slice(i + 1, end)
          .split(",")
          .map((a) => a.replace(/[.+^${}()|[\]\\]/g, "\\$&"));
        re += `(?:${alts.join("|")})`;
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end !== -1) {
        re += charClass(pattern.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${re}$`);
}
