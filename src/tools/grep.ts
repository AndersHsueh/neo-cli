/**
 * grep 工具：按正则搜索文件内容。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { ToolError, type ToolImpl } from "./types.ts";
import { listSearchFiles } from "./fileList.ts";
import { globToRegExp } from "./glob.ts";
import { MAX_GREP_FILE, abs, requireDir, requireFile } from "./fsPaths.ts";

export const grepTool: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  parallelizable: true,
  spec: {
    type: "function",
    function: {
      name: "grep",
      description: "在文件内容中搜索正则。返回 file:line: 内容。path 可以是目录（递归搜索）也可以是单个文件。支持 glob 过滤、忽略大小写。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "正则表达式" },
          path: { type: "string", description: "搜索根目录或单个文件路径，默认工作目录" },
          glob: { type: "string", description: "只搜索匹配该 glob 的文件，例如 *.ts" },
          ignore_case: { type: "boolean", description: "忽略大小写，默认 false" },
          limit: { type: "integer", description: "最多返回匹配行数，默认 200" },
        },
        required: ["pattern"],
      },
    },
  },
  async execute(args, ctx) {
    const pattern = String(args["pattern"] ?? "");
    const root = abs(ctx, String(args["path"] ?? "."));
    const globPat = args["glob"] ? String(args["glob"]) : null;
    const globRe = globPat ? globToRegExp(globPat) : null;
    const ignoreCase = args["ignore_case"] === true;
    const limit = Math.max(1, Number(args["limit"] ?? 200) || 200);

    let re: RegExp;
    try {
      re = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch (e) {
      throw new ToolError(`正则表达式无效: ${(e as Error).message}`);
    }

    // path 可以是文件：直接搜该文件，不递归
    if (existsSync(root) && statSync(root).isFile()) {
      return grepFile(root, re, pattern, limit, null);
    }
    requireDir(root);

    const hits: string[] = [];
    let filesScanned = 0;
    let truncated = false;
    const skippedLarge: string[] = [];

    // 文件清单走 gitignore 语义（git 工作区用 git ls-files，非 git 目录用内置匹配器）；
    // 匹配仍用上面的 JS 正则，不切 git grep —— 保持 \d、lookahead 等语义不变。
    const listed = await listSearchFiles(root);
    for (const f of listed.files) {
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      const base = f.rel.split("/").pop() ?? f.rel;
      if (globRe && !globRe.test(f.rel) && !globRe.test(base)) continue;

      let st;
      try {
        st = statSync(f.full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_GREP_FILE) {
        // 与单文件分支口径一致：跳过必须说出来，否则「无匹配」是假阴性
        skippedLarge.push(`${f.rel} (${st.size}B)`);
        continue;
      }

      let text: string;
      try {
        text = readFileSync(f.full, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // 二进制
      filesScanned++;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (!re.test(line)) continue;
        hits.push(`${f.rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
        if (hits.length >= limit) {
          truncated = true;
          break;
        }
      }
    }

    const notes: string[] = [];
    if (listed.backend === "git") notes.push("已按 .gitignore 排除");
    if (listed.truncated) notes.push("文件枚举已截断");
    if (skippedLarge.length > 0) {
      const shown = skippedLarge.slice(0, 5).join("、");
      const more = skippedLarge.length > 5 ? ` 等 ${skippedLarge.length} 个` : "";
      notes.push(`文件过大，跳过: ${shown}${more}`);
    }
    const note = notes.length > 0 ? `；${notes.join("；")}` : "";
    if (hits.length === 0) return `无匹配。扫描 ${filesScanned} 个文件（${pattern}）${note}`;
    const tail = truncated ? `\n… 结果截断在 ${limit} 行` : "";
    return `${hits.length} 处匹配（扫描 ${filesScanned} 文件${note}）:\n${hits.join("\n")}${tail}`;
  },
};

/** 在单个文件内搜索。 */
function grepFile(file: string, re: RegExp, pattern: string, limit: number, label: string | null): string {
  const st = statSync(file);
  if (st.size > MAX_GREP_FILE) return `文件过大 (${st.size}B)，跳过: ${file}`;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return `无法读取 ${file}: ${(e as Error).message}`;
  }
  const rel = label ?? file.split(sep).pop() ?? file;
  const hits: string[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i] ?? "";
    if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
  }
  if (hits.length === 0) return `${rel} 中无匹配。模式: ${pattern}`;
  const tail = hits.length >= limit ? `\n… 结果截断在 ${limit} 行` : "";
  return `${hits.length} 处匹配（${rel}）:\n${hits.join("\n")}${tail}`;
}
