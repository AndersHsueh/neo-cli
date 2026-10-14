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

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolCtx {
  cfg: Config;
  /** 敏感操作审批，返回 true 才执行。 */
  approve: (tool: string, detail: string) => Promise<boolean>;
  /** 取消信号（Ctrl+C）。 */
  signal?: AbortSignal;
  /** 由 agent 注入，让工具能观察取消。 */
  onNotice?: (msg: string) => void;
}

export interface ToolImpl {
  spec: ToolSpec;
  /** 是否属于敏感操作（需要审批）。 */
  sensitive: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string> | string;
}

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
    const content = String(args["content"] ?? "");
    const isNew = !existsSync(path);
    const detail = isNew ? `新建文件 ${path}` : `覆盖已有文件 ${path}（${content.length} 字符）`;
    const ok = await ctx.approve("write_file", detail);
    if (!ok) return "用户拒绝了该操作，未写入文件。";

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

    const out = all ? src.split(oldS).join(newS) : src.replace(oldS, newS);
    writeFileSync(path, out, "utf8");
    return `已修改 ${path}（${all ? count : 1} 处）`;
  },
};

/* ------------------------------------------------------------------ */
/* list_dir                                                            */
/* ------------------------------------------------------------------ */

const listDir: ToolImpl = {
  sensitive: false,
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
        if (e.isDirectory()) {
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
    const hits: Array<{ p: string; mtime: number }> = [];

    const walk = (dir: string, depth: number): void => {
      if (hits.length >= limit * 4 || depth > 14) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".env") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          walk(full, depth + 1);
        } else {
          const rel = relative(root, full).split(sep).join("/");
          if (re.test(rel) || re.test(e.name)) {
            let m = 0;
            try {
              m = statSync(full).mtimeMs;
            } catch {
              /* ignore */
            }
            hits.push({ p: rel, mtime: m });
          }
        }
      }
    };
    walk(root, 0);

    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, limit);
    if (shown.length === 0) return `无匹配文件: ${pattern}`;
    return `匹配 ${hits.length} 个文件（显示前 ${shown.length}）:\n${shown.map((h) => h.p).join("\n")}`;
  },
};

/** 最小 glob → RegExp。支持 *, **, ?, {a,b}, 字符类。 */
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
        re += pattern.slice(i, end + 1);
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
  execute(args, ctx) {
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

    const walk = (dir: string, depth: number): void => {
      if (hits.length >= limit || truncated || depth > 12) return;
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= limit) {
          truncated = true;
          return;
        }
        if (e.name.startsWith(".") && e.name !== ".env") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          walk(full, depth + 1);
          continue;
        }
        const rel = relative(root, full).split(sep).join("/");
        if (globRe && !globRe.test(e.name) && !globRe.test(rel)) continue;

        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.size > 3_000_000) continue;

        let text: string;
        try {
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue; // 二进制
        filesScanned++;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (!re.test(line)) continue;
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
          if (hits.length >= limit) {
            truncated = true;
            return;
          }
        }
      }
    };
    walk(root, 0);

    if (hits.length === 0) return `无匹配。扫描 ${filesScanned} 个文件，模式: ${pattern}`;
    const tail = truncated ? `\n… 结果截断在 ${limit} 行` : "";
    return `${hits.length} 处匹配（扫描 ${filesScanned} 文件）:\n${hits.join("\n")}${tail}`;
  },
};

/** 在单个文件内搜索。 */
function grepFile(file: string, re: RegExp, pattern: string, limit: number, label: string | null): string {
  const st = statSync(file);
  if (st.size > 3_000_000) return `文件过大 (${st.size}B)，跳过: ${file}`;
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

const shell: ToolImpl = {
  sensitive: true,
  spec: {
    type: "function",
    function: {
      name: "shell",
      description:
        "在 shell 中执行命令并返回 stdout/stderr/退出码。用于运行构建、测试、git 等。默认 120 秒超时。执行前需用户批准。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令" },
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

    const ok = await ctx.approve("shell", `执行: ${command}`);
    if (!ok) return "用户拒绝了该命令，未执行。";

    const proc = Bun.spawn(["/bin/zsh", "-lc", command], {
      cwd: ctx.cfg.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" },
    });

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

    const parts = [`$ ${command}`];
    if (out.trim()) parts.push(out.trimEnd());
    if (errOut.trim()) parts.push(`[stderr] ${errOut.trimEnd()}`);
    parts.push(`[exit ${code}]`);
    return parts.join("\n");
  },
};

/* ------------------------------------------------------------------ */
/* web_fetch                                                           */
/* ------------------------------------------------------------------ */

const webFetch: ToolImpl = {
  sensitive: false,
  spec: {
    type: "function",
    function: {
      name: "web_fetch",
      description: "抓取 URL 内容并转为纯文本（去除 HTML 标签）。适合查文档、读网页。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "完整 URL（http/https）" } },
        required: ["url"],
      },
    },
  },
  async execute(args) {
    const url = String(args["url"] ?? "");
    if (!/^https?:\/\//i.test(url)) throw new ToolError("url 必须以 http:// 或 https:// 开头");
    const res = await fetch(url, {
      headers: { "User-Agent": "neo-cli/0.1 (+bun)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `抓取失败: HTTP ${res.status} ${res.statusText}`;
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = ct.includes("html") ? htmlToText(body) : body;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim();
    return [`URL: ${url}`, title ? `Title: ${title}` : "", "", text.slice(0, 60_000)].filter((x) => x !== undefined).join("\n");
  },
};

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
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
];

const registry = new Map(TOOLS.map((t) => [t.spec.function.name, t]));

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => t.spec);
}

export function toolNames(): string[] {
  return TOOLS.map((t) => t.spec.function.name);
}

export interface DispatchResult {
  ok: boolean;
  output: string;
  truncated: boolean;
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
    return limitOutput(out, ctx.cfg.toolOutputLimit);
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, output: `错误: ${e.message}`, truncated: false };
    const err = e as Error;
    if (err.name === "AbortError") throw err;
    return { ok: false, output: `工具执行失败: ${err.message}`, truncated: false };
  }
}

function limitOutput(s: string, limit: number): DispatchResult {
  if (s.length <= limit) return { ok: true, output: s, truncated: false };
  const head = s.slice(0, Math.floor(limit * 0.7));
  const tail = s.slice(-Math.floor(limit * 0.2));
  const omitted = s.length - head.length - tail.length;
  return {
    ok: true,
    output: `${head}\n\n… [中间省略 ${omitted} 字符，因超出 tool_output_limit=${limit}] …\n\n${tail}`,
    truncated: true,
  };
}

export { shortArgs, abs as resolvePath, insideCwd };
