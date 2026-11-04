/**
 * 工具集：文件系统 + 检索 + shell + 网络。
 *
 * 约定：
 *  - 每个工具实现 ToolImpl，execute 返回字符串（给模型看的文本）或抛 ToolError。
 *  - 结果统一在 dispatch() 中按配置截断，避免撑爆上下文。
 *  - write_file / edit_file / shell 默认需要用户批准，由上层注入 approver。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, type Dirent } from "node:fs";
import { dirname, resolve, join, relative, sep } from "node:path";
import type { ToolSpec } from "../llm.ts";
import type { Config } from "../config.ts";
import { describeSource, insideGlobalSkills, isRealDir, listSkillFiles, resolveSkill } from "../skills.ts";
import { insideRawDir } from "../wiki/paths.ts";
import { ToolError, type ToolCtx, type ToolImpl, type ToolKind, type DispatchResult } from "./types.ts";
import { webSearchTool } from "./webSearch.ts";
import { toolTmpDir } from "../runtimeTmp.ts";
import { shellMarks } from "./shellMarks.ts";
import { listSearchFiles } from "./fileList.ts";
import { getShell, prepareShellInvocation, shellErrorHint } from "../shell.ts";

// 基础类型与注册表在 ./types.ts（叶子模块，解开 task → agent → tools 循环依赖）。
// 这里 re-export 保持既有导入路径不变。
export { ToolError } from "./types.ts";
export type { ToolCtx, ToolImpl, ToolKind, DispatchResult } from "./types.ts";

/* ------------------------------------------------------------------ */
/* 路径处理                                                            */
/* ------------------------------------------------------------------ */

function abs(ctx: ToolCtx, p: string): string {
  if (!p || typeof p !== "string") throw new ToolError("缺少 path 参数");
  return resolve(ctx.cfg.cwd, p);
}
function insideCwd(ctx: ToolCtx, p: string): boolean {
  const r = relative(ctx.cfg.cwd, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep + ".."));
}

function requireFile(p: string): string {
  if (!existsSync(p)) throw new ToolError(`文件不存在: ${p}`);
  const st = statSync(p);
  if (!st.isFile()) throw new ToolError(`不是文件: ${p}`);
  return p;
}

function requireDir(p: string): string {
  if (!existsSync(p)) throw new ToolError(`目录不存在: ${p}`);
  const st = statSync(p);
  if (!st.isDirectory()) throw new ToolError(`不是目录: ${p}`);
  return p;
}

const MAX_READ = 2_000_000;

/** grep 单文件大小上限：目录扫描与单文件分支共用同一阈值，超限必须明说跳过。 */
const MAX_GREP_FILE = 3_000_000;

/**
 * 写工具守卫：禁止经软链穿透写入全局技能库（技能是只读资源）。
 *
 * 必须在 ctx.approve() 之前调用 —— 放之后会先弹审批框再拒绝，用户白点一次。
 */
function assertNotGlobalSkills(ctx: ToolCtx, path: string): void {
  if (!insideGlobalSkills(ctx.cfg, path)) return;
  throw new ToolError(
    `禁止写入全局技能库。技能是只读资源，` +
      `如需修改，请直接用编辑器打开该技能目录下的 SKILL.md。`,
  );
}

/**
 * raw 不可改守卫：raw/ 下的**已存在文件**禁止修改内容。
 *
 * 语义（wiki-turnning-1018.md）：raw 可创建、可删除（shell rm）、删除后可重建同名；
 * 唯独不许改已存在文件的内容。发现源有问题，在对应 wiki 主题页加「> 待澄清:」注记。
 * 仅拦工具路径，不防 shell 绕过 —— 方案已明确：护栏只防 agent 手滑，不防人有意为之。
 *
 * 必须在 ctx.approve() 之前调用 —— 先拒绝，不让用户为注定失败的操作白点一次审批。
 */
function assertRawImmutable(ctx: ToolCtx, path: string): void {
  if (!insideRawDir(ctx.cfg.cwd, path)) return;
  if (existsSync(path)) {
    throw new ToolError(
      `raw 源不可修改：${path} 已存在。raw 可创建/删除，但已存在文件的内容不许改；` +
        `发现问题请在对应 wiki 主题页加「> 待澄清:」注记。`,
    );
  }
}

function shortArgs(args: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((k) => {
      const v = args[k];
      if (v === undefined) return "";
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 60 ? s.slice(0, 60) + "…" : s}`;
    })
    .filter(Boolean)
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */

const readFile: ToolImpl = {
  sensitive: false,
  kind: "evidence",
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
    return `${body}${more}`;
  },
};

/* ------------------------------------------------------------------ */
/* write_file                                                          */
/* ------------------------------------------------------------------ */

const writeFileTool: ToolImpl = {
  sensitive: true,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: "write_file",
      description: "写入文本文件（覆盖）。父目录会自动创建。这会破坏原内容，执行前需用户批准。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "完整文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  async execute(args, ctx) {
    const path = abs(ctx, String(args["path"] ?? ""));
    assertNotGlobalSkills(ctx, path);
    assertRawImmutable(ctx, path);
    const content = String(args["content"] ?? "");
    const isNew = !existsSync(path);
    const detail = isNew ? `新建文件 ${path}` : `覆盖已有文件 ${path}（${content.length} 字符）`;
    const ok = await ctx.approve("write_file", detail);
    if (!ok) return "用户拒绝了该操作，未写入文件。";

    // 审批通过、写盘之前留检查点（P0-4）。失败不阻塞写入。
    try {
      ctx.checkpoint?.beforeWrite(path, "write_file");
    } catch {
      /* 检查点是增强项：失败不阻止写盘 */
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return `${isNew ? "已创建" : "已覆盖"} ${path}（${content.length} 字符，${content.split("\n").length} 行）`;
  },
};

/* ------------------------------------------------------------------ */
/* edit_file                                                           */
/* ------------------------------------------------------------------ */

const editFile: ToolImpl = {
  sensitive: true,
  kind: "neither",
  spec: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "在文件中做精确字符串替换。old_string 必须在文件中唯一出现（出现多次会失败）。可传 replace_all 做全量替换。执行前需用户批准。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string", description: "要替换的原文，必须唯一" },
          new_string: { type: "string", description: "替换后的新文本" },
          replace_all: { type: "boolean", description: "是否替换所有出现，默认 false" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  async execute(args, ctx) {
    const path = abs(ctx, String(args["path"] ?? ""));
    assertNotGlobalSkills(ctx, path);
    assertRawImmutable(ctx, path);
    requireFile(path);
    const oldS = String(args["old_string"] ?? "");
    const newS = String(args["new_string"] ?? "");
    const all = args["replace_all"] === true || args["replace_all"] === "true";

    if (oldS === "") throw new ToolError("old_string 不能为空");

    const src = readFileSync(path, "utf8");
    const count = src.split(oldS).length - 1;
    if (count === 0) throw new ToolError(`在 ${path} 中找不到 old_string`);
    if (count > 1 && !all) {
      throw new ToolError(
        `old_string 在 ${path} 中出现 ${count} 次，不唯一。请加入更多上下文使其唯一，或设置 replace_all=true`,
      );
    }

    const ok = await ctx.approve(
      "edit_file",
      `修改 ${path}：${count > 1 ? `替换全部 ${count} 处` : "替换 1 处"}`,
    );
    if (!ok) return "用户拒绝了该操作，文件未修改。";

    // 审批通过、写盘之前留检查点（P0-4）。失败不阻塞写入。
    try {
      ctx.checkpoint?.beforeWrite(path, "edit_file");
    } catch {
      /* 检查点是增强项：失败不阻止写盘 */
    }

    // 按字面写入，绝不能用 String.replace(old, new)：new_string 里的 $&、$1、$$、
    // $`、$' 会被当成替换模式展开，静默写坏代码（P0-3）。此时 count 已确认，
    // split/join 与单次 replace 语义等价，且没有模式展开。
    const out = src.split(oldS).join(newS);
    writeFileSync(path, out, "utf8");
    return `已修改 ${path}（${all ? count : 1} 处）`;
  },
};

/* ------------------------------------------------------------------ */
/* list_dir                                                            */
/* ------------------------------------------------------------------ */

const listDir: ToolImpl = {
  sensitive: false,
  kind: "evidence",
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

/* ------------------------------------------------------------------ */
/* glob                                                                */
/* ------------------------------------------------------------------ */

const globTool: ToolImpl = {
  sensitive: false,
  kind: "evidence",
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

/* ------------------------------------------------------------------ */
/* grep                                                                */
/* ------------------------------------------------------------------ */

const grepTool: ToolImpl = {
  sensitive: false,
  kind: "evidence",
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

/* ------------------------------------------------------------------ */
/* shell                                                               */
/* ------------------------------------------------------------------ */

/** 管道模式 spawn（独立函数是为了让 TS 推断出具体的 pipe 返回类型）。 */
function spawnPiped(
  argv: string[],
  cwd: string,
  env: Record<string, string | undefined>,
) {
  return Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env });
}

const shell: ToolImpl = {
  sensitive: true,
  kind: "capability",
  spec: {
    type: "function",
    function: {
      name: "shell",
      description:
        "在 shell 中执行命令并返回 stdout/stderr/退出码。用于运行构建、测试、git 等。默认 120 秒超时。执行前需用户批准。" +
        "shell 由当前平台自动选择（macOS/Linux 用 $SHELL 或 bash，Windows 用 PowerShell），命令需兼容系统提示词「## 环境」里声明的 shell。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令" },
          cwd: {
            type: "string",
            description:
              "命令工作目录（相对项目根或绝对路径）。只影响本次调用，不改变会话 cwd；默认项目根。",
          },
          timeout_ms: { type: "integer", description: "超时毫秒，默认 120000" },
        },
        required: ["command"],
      },
    },
  },
  async execute(args, ctx) {
    const command = String(args["command"] ?? "").trim();
    if (!command) throw new ToolError("command 为空");
    const timeout = Math.max(1000, Number(args["timeout_ms"] ?? 120_000) || 120_000);
    // v0.4.1 B4 / D2：每次调用可指定 cwd（实战里 56/66 条命令都在手写 cd）。
    const rawCwd = args["cwd"] === undefined ? null : String(args["cwd"]);
    let workdir = ctx.cfg.cwd;
    if (rawCwd && rawCwd.trim() !== "") {
      workdir = resolve(ctx.cfg.cwd, rawCwd);
      if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
        throw new ToolError(`cwd 不是目录: ${workdir}`);
      }
    }

    const ok = await ctx.approve(
      "shell",
      workdir === ctx.cfg.cwd ? `执行: ${command}` : `执行（cwd=${workdir}）: ${command}`,
    );
    if (!ok) return "用户拒绝了该命令，未执行。";

    // v0.4.0 平台适配层：shell 由 resolveShell 探测（配置/环境变量/$SHELL/平台默认），
    // 登录 shell 会注入 PATH 保真前缀，避免「neo 能跑的 bun 在工具里 not found」。
    const spec = getShell(ctx.cfg);
    const invocation = prepareShellInvocation(spec, command, {
      ...process.env,
      NO_COLOR: process.env.NO_COLOR ?? "1",
    });
    const proc = (() => {
      try {
        return spawnPiped(invocation.argv, workdir, invocation.env);
      } catch (e) {
        throw new ToolError(`无法启动 shell：${shellErrorHint(e, spec)}`);
      }
    })();

    const timer = setTimeout(() => {
      proc.kill(9);
    }, timeout);
    ctx.signal?.addEventListener("abort", () => proc.kill(9), { once: true });

    const [out, errOut, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const parts = [shellMarks.cmd(command)];
    if (out.trim()) parts.push(out.trimEnd());
    if (errOut.trim()) parts.push(`${shellMarks.stderr}${errOut.trimEnd()}`);
    parts.push(shellMarks.exit(code));
    return parts.join("\n");
  },
};

/* ------------------------------------------------------------------ */
/* web_fetch                                                           */
/* ------------------------------------------------------------------ */

/**
 * 把不可达的搜索引擎 URL 改写到国内可达的 cn.bing.com。
 *
 * 背景：本机在中国境内，google.com / duckduckgo.com 均连接超时（实测 000）。
 * 模型可能凭习惯拼出这些 URL，这里兜底改写，避免白跑一次抓取。
 * 只改「搜索页」URL；普通网页抓取不受影响。
 */
export function rewriteSearchUrl(url: string): { url: string; note: string | null } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url, note: null };
  }
  const host = u.hostname.toLowerCase();
  const isSearchHost =
    host === "www.google.com" ||
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "duckduckgo.com" ||
    host === "www.duckduckgo.com" ||
    host === "html.duckduckgo.com" ||
    host === "lite.duckduckgo.com";

  if (!isSearchHost) return { url, note: null };

  // 提取查询词：google 用 q，duckduckgo 用 q
  const q = u.searchParams.get("q");
  if (!q) return { url, note: null };

  const next = `https://cn.bing.com/search?q=${encodeURIComponent(q)}`;
  return { url: next, note: `已将 ${host} 的搜索改写为 cn.bing.com（原域名在中国境内不可达）` };
}

const webFetch: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  spec: {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "抓取 URL 内容并转为纯文本（去除 HTML 标签）。适合查文档、读网页。\n" +
        "搜索时用 cn.bing.com：https://cn.bing.com/search?q=<关键词>（关键词需 URL 编码）。\n" +
        "不要用 google.com / duckduckgo.com——本机在中国境内，这两个域名不可达（已实测连接超时）。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "完整 URL（http/https）。搜索用 https://cn.bing.com/search?q=<关键词>",
          },
        },
        required: ["url"],
      },
    },
  },
  async execute(args) {
    const raw = String(args["url"] ?? "");
    if (!/^https?:\/\//i.test(raw)) throw new ToolError("url 必须以 http:// 或 https:// 开头");
    const { url, note } = rewriteSearchUrl(raw);
    const res = await fetch(url, {
      headers: { "User-Agent": "neo-cli/0.1 (+bun)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `抓取失败: HTTP ${res.status} ${res.statusText}`;
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = ct.includes("html") ? htmlToText(body) : body;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim();
    return [note, `URL: ${url}`, title ? `Title: ${title}` : "", "", text.slice(0, 60_000)]
      .filter((x) => x !== undefined && x !== null && x !== "")
      .join("\n");
  },
};

/**
 * 数字字符引用 → 字符。码点越界（> 0x10FFFF）或落在代理区（0xD800–0xDFFF）
 * 时 `String.fromCodePoint` 会抛 RangeError，而引用来自外部网页，畸形实体
 * （如 `&#1114112;`）不该让整个 web_fetch 崩掉 —— 原样保留即可。
 */
function codePointToString(cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
    return `&#${cp};`;
  }
  return String.fromCodePoint(cp);
}

/** 极简 HTML → 文本。移除 script/style，块级标签转换行。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "  • ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => codePointToString(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* use_skill                                                           */
/* ------------------------------------------------------------------ */

const useSkill: ToolImpl = {
  // 只读：不改任何文件。首次加载全局技能会在 <cwd>/skills/ 建一个软链，
  // 那是一次无害且会在输出里明说的操作，不构成破坏性行为。
  sensitive: false,
  kind: "capability",
  spec: {
    type: "function",
    function: {
      name: "use_skill",
      description:
        "加载指定技能的完整操作说明（SKILL.md 正文）。仅当系统提示的技能索引中某技能与当前任务相关时调用。不相关就不要调用——技能正文会占用上下文。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名，取自技能索引" },
        },
        required: ["name"],
      },
    },
  },
  execute(args, ctx) {
    const r = resolveSkill(ctx.cfg, String(args["name"] ?? ""));
    if (!r.ok) {
      // 抛 ToolError 而非返回字符串 —— dispatch 会转成 ok:false 并计入连续失败数，
      // 模型据此知道这次调用没成功。not_found 时附可用技能清单，帮它自我纠正。
      const hint = r.available.length > 0 ? `\n可用技能：${r.available.join(", ")}` : "";
      throw new ToolError(`${r.message}${hint}`);
    }

    const body = readFileSync(join(r.meta.absPath, "SKILL.md"), "utf8");
    const files = listSkillFiles(r.meta.absPath).filter((f) => f !== "SKILL.md");

    const parts = [body.trimEnd()];
    parts.push("---");
    if (files.length > 0) {
      parts.push("附件（按需自行 read_file 或执行）：");
      for (const f of files) parts.push(`- ${f}`);
    } else {
      parts.push("附件：无");
    }
    parts.push(describeSource(ctx.cfg, r.meta, r.createdLink));
    return parts.join("\n");
  },
};

/* ------------------------------------------------------------------ */
/* compact_ctx                                                         */
/* ------------------------------------------------------------------ */

const compactCtx: ToolImpl = {
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

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

export const TOOLS: ToolImpl[] = [
  readFile,
  writeFileTool,
  editFile,
  listDir,
  globTool,
  grepTool,
  shell,
  webFetch,
  webSearchTool,
  useSkill,
  compactCtx,
];

const registry = new Map(TOOLS.map((t) => [t.spec.function.name, t]));

/**
 * 查工具的手段/目标分层（2026-10-26）。
 * 未注册或未标 kind → "neither"（不参与偏离判定）。
 */
export function toolKindOf(name: string): ToolKind {
  return registry.get(name)?.kind ?? "neither";
}

/**
 * 运行时注册一个工具（追加到注册表尾部）。
 *
 * 供组合根（src/index.ts）装配 task 等依赖 Agent 的工具 —— 它们不能放进
 * 静态 TOOLS 数组，否则会形成 task → agent → tools 的循环依赖。
 * 必须在首次 agent.send() 之前调用：toolSpecs() 每轮现取，注册后即刻生效。
 *
 * 返回注销函数。测试用它做清理 —— bun test 单进程共享模块表，
 * 注册不留清理会污染其它测试文件的精确清单断言。
 */
export function registerTool(impl: ToolImpl): () => void {
  const name = impl.spec.function.name;
  if (registry.has(name)) {
    throw new Error(`工具 ${name} 已注册，不能重复注册`);
  }
  TOOLS.push(impl);
  registry.set(name, impl);
  return () => {
    const i = TOOLS.indexOf(impl);
    if (i !== -1) TOOLS.splice(i, 1);
    registry.delete(name);
  };
}

/**
 * 子代理（task 工具）不可用的工具名。
 *
 *  - task：从工具集层面结构性禁止递归派生，深度天然 ≤ 1，不需要任何运行时深度计数。
 *  - compact_ctx：宿主闭包绑定的是主代理 —— 子代理调用它会错误压缩主代理的
 *    对话历史（子代理自己烧完上下文就结束了，没有压缩价值）。若将来要放开
 *    多层派生或给子代理配独立宿主，改这里即可。
 *  - send_message / list_peers（v0.2 跨会话消息）：子代理与父会话共享同一进程与
 *    信箱身份，让子代理发消息会产生「消息代表谁」的归属混乱（PRD v1.2 §4.8）。
 */
export const TOOL_NAMES_EXCLUDED_FOR_SUBAGENT: readonly string[] = [
  "task",
  "compact_ctx",
  "remember",
  "send_message",
  "list_peers",
  "ask_user",
];

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => t.spec);
}

export function toolNames(): string[] {
  return TOOLS.map((t) => t.spec.function.name);
}

export async function dispatch(
  name: string,
  rawArgs: string,
  ctx: ToolCtx,
): Promise<DispatchResult> {
  const impl = registry.get(name);
  if (!impl) {
    return {
      ok: false,
      output: `未知工具: ${name}。可用工具: ${toolNames().join(", ")}`,
      truncated: false,
    };
  }

  let args: Record<string, unknown>;
  try {
    const parsed: unknown = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("参数必须是 JSON 对象");
    }
    args = parsed as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      output: `工具 ${name} 的参数不是合法 JSON 对象: ${(e as Error).message}`,
      truncated: false,
    };
  }

  try {
    ctx.signal?.throwIfAborted();
    const out = await impl.execute(args, ctx);
    return limitOutput(out, ctx.cfg.toolOutputLimit, ctx);
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, output: `错误: ${e.message}`, truncated: false };
    const err = e as Error;
    if (err.name === "AbortError") throw err;
    return { ok: false, output: `工具执行失败: ${err.message}`, truncated: false };
  }
}

/** 超长输出落盘目录：~/.neo/tmp（0600；NEO_TMP_DIR 可覆盖，不放用户仓库）。 */
function spillDir(): string {
  return toolTmpDir();
}

/**
 * 工具输出截断（v0.4.1 B4 / D1）。
 *
 * 旧实现只回 head/tail + 省略标记，中间内容永久丢失（实战里 xlsx dump 被截后
 * 无法再查）。现在把**完整输出**写入 <cwd>/.neo/tmp/tool-*.txt，模型可用
 * read_file 分段读；落盘失败才退回旧的省略提示。
 */
export function limitOutput(s: string, limit: number, ctx: ToolCtx): DispatchResult {
  if (s.length <= limit) return { ok: true, output: s, truncated: false };
  const head = s.slice(0, Math.floor(limit * 0.7));
  const tail = s.slice(-Math.floor(limit * 0.2));
  const omitted = s.length - head.length - tail.length;
  let path: string | null = null;
  try {
    // plan 模式是只读承诺：不落盘，退回旧的头尾截断。
    if (ctx.readOnly) throw new Error("plan 模式不落盘");
    const dir = spillDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    path = join(dir, `tool-${stamp}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(path, s, { encoding: "utf8", mode: 0o600 });
  } catch {
    path = null;
  }
  const notice = path
    ? `… [输出 ${s.length} 字符，超过 tool_output_limit=${limit}；中间省略 ${omitted} 字符。` +
      `完整输出已落盘：${path}（用 read_file offset/limit 分段读）] …`
    : `… [中间省略 ${omitted} 字符，因超出 tool_output_limit=${limit}；落盘失败] …`;
  return { ok: true, output: `${head}\n\n${notice}\n\n${tail}`, truncated: true };
}

export { shortArgs, abs as resolvePath, insideCwd };
