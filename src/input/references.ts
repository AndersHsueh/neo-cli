/**
 * input/references.ts — `@path` 引用解析与展开（v0.2.4 C3）。
 *
 * 补全只是入口：真正有价值的是**内容随消息送达**，模型不必再多跑一次 read_file。
 * 三条纪律：
 *  1. 预算硬上限（文件数 / 单文件行数 / 总字节），防止一次 `@` 顶掉半上下文；
 *  2. 失败不阻断发送（不存在 / 二进制 / 超预算 → 记 error，`@path` 按原文保留）；
 *  3. 格式带明确起止标记，模型能分辨「用户引用」与「用户原话」。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { isAtBoundary, stripTrailingPunct } from "./completion.ts";

export interface Reference {
  /** 原文片段（含 `@`），用于定位。 */
  token: string;
  /** 去掉 `@` 与尾随标点后的路径。 */
  path: string;
  /** 行内起始下标。 */
  start: number;
}

export interface McpReferenceSource {
  connectedServers: Iterable<string>;
  read: (server: string, uri: string) => Promise<{ text?: string; blob?: string; mimeType?: string; uri?: string }>;
}

export interface ExpandOptions {
  cwd: string;
  /** 路径是否存在（相对 cwd 或绝对路径）。默认 fs.existsSync。 */
  exists?: (path: string) => boolean;
  /** 读文本文件。默认 fs.readFileSync(utf8)。 */
  readFile?: (path: string) => string;
  /** 文件字节数（预算前置检查用）。默认 fs.statSync().size。 */
  statSize?: (path: string) => number;
  /** 读前 N 字节（预算截断用）。默认 fs.openSync + readSync。 */
  readSlice?: (path: string, bytes: number) => string;
  /** 最多展开几个文件（默认 5）。 */
  maxFiles?: number;
  /** 单文件最多带几行（默认 400）。 */
  maxLinesPerFile?: number;
  /** 单条消息引用内容总字节上限（默认 60000）。 */
  maxBytesTotal?: number;
  /** issue #67：已连接 MCP 资源。不传则所有 `@` 都按文件路径处理。 */
  mcp?: McpReferenceSource;
}

export interface ExpandedRef {
  path: string;
  lines: number;
  truncated: boolean;
}

export interface ExpandResult {
  /** 原文 + 引用块（无引用时等于原文）。 */
  text: string;
  refs: ExpandedRef[];
  /** 非致命问题，调用方打一行软提示即可；不阻断发送。 */
  errors: string[];
}

export const DEFAULT_MAX_FILES = 5;
export const DEFAULT_MAX_LINES_PER_FILE = 400;
export const DEFAULT_MAX_BYTES_TOTAL = 60_000;

/** 从消息文本里解析 `@path`（与补全共用同一套边界规则）。 */
export function parseReferences(text: string): Reference[] {
  const out: Reference[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at === -1) break;
    const prev = at > 0 ? text[at - 1]! : "";
    if (at > 0 && !isAtBoundary(prev)) {
      i = at + 1;
      continue;
    }
    const rest = text.slice(at + 1);
    const m = /^[^\s@]+/.exec(rest);
    if (!m) {
      i = at + 1;
      continue;
    }
    const path = stripTrailingPunct(m[0]);
    if (path === "") {
      i = at + 1;
      continue;
    }
    out.push({ token: `@${path}`, path, start: at });
    i = at + 1 + m[0].length;
  }
  return out;
}

function defaultExists(path: string): boolean {
  return existsSync(path);
}

function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

function defaultStatSize(path: string): number {
  return statSync(path).size;
}

/**
 * 只读前 bytes 字节（按预算截断时用，避免把 50MB 文件整份读进内存）。
 *
 * 截断点可能落在多字节字符中间（中文 3 字节、emoji 4 字节）。默认的
 * `TextDecoder` 会把这段残缺字节替换成 U+FFFD —— 既让正文尾部出现乱码，
 * 又让 `Buffer.byteLength` 从 n 涨到 n+2，突破调用方刚算好的字节预算。
 * 用 `stream: true` 只解码「已完整」的前缀，残缺尾部直接丢弃。
 */
function defaultReadSlice(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, bytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, n), { stream: true });
  } finally {
    closeSync(fd);
  }
}

/** 统计行数：忽略末尾换行造成的空行（`"a\n"` 算 1 行）。 */
function countLines(content: string): number {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function normPath(p: string): string {
  return p.replace(/^\.\//, "");
}

/**
 * 展开 `@path`：原文不动，引用块附在末尾。
 * 返回的 errors 由调用方展示（软提示），正文按「能展开多少算多少」处理。
 */
export function expandReferences(text: string, opts: ExpandOptions): ExpandResult {
  const refs0 = parseReferences(text);
  if (refs0.length === 0) return { text, refs: [], errors: [] };

  // 相对路径一律相对 `opts.cwd`（cfg.cwd）解析：neo 可以用 -C 切工作目录，
  // 但 process.cwd() 仍是启动目录，直接用相对路径会「明明有文件却报不存在」。
  const absOf = (p: string): string => (isAbsolute(p) ? p : join(opts.cwd, p));
  const exists = opts.exists ?? defaultExists;
  const readFile = opts.readFile ?? defaultReadFile;
  const statSize = opts.statSize ?? defaultStatSize;
  const readSlice = opts.readSlice ?? defaultReadSlice;
  const maxFiles = Math.max(1, opts.maxFiles ?? DEFAULT_MAX_FILES);
  const maxLines = Math.max(1, opts.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE);
  const maxBytes = Math.max(1, opts.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL);

  const refs: ExpandedRef[] = [];
  const bodies: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const r of refs0) {
    const path = normPath(r.path);
    const abs = absOf(path); // 绝对/相对混用视为同一文件（@src/a.ts 与 @/abs/src/a.ts）
    if (seen.has(abs)) continue;
    seen.add(abs);

    if (refs.length >= maxFiles) {
      errors.push(`最多引用 ${maxFiles} 个文件，${r.token} 未展开`);
      continue;
    }
    if (!exists(absOf(path))) {
      errors.push(`${r.token} 不存在，按原文保留`);
      continue;
    }
    // 先看大小再读：预算只有 60KB，读进 50MB 再丢弃纯属浪费（实测 5.86ms + 50MB 瞬时占用）
    let size = 0;
    try {
      size = statSize(absOf(path));
    } catch (e) {
      errors.push(`${r.token} 读取失败：${(e as Error).message}`);
      continue;
    }
    const remaining = maxBytes - totalBytes;
    if (remaining <= 0) {
      errors.push(`${r.token} 会让引用总量超出 ${maxBytes} 字节预算，已跳过`);
      continue;
    }
    // 超出预算的文件按剩余预算截断（PRD C3：截断并标注，而不是整份丢弃）
    const truncatedByBytes = size > remaining;
    let content: string;
    try {
      content = truncatedByBytes ? readSlice(abs, remaining) : readFile(abs);
    } catch (e) {
      errors.push(`${r.token} 读取失败：${(e as Error).message}`);
      continue;
    }
    if (content.includes("\0")) {
      errors.push(`${r.token} 是二进制文件，已跳过`);
      continue;
    }
    totalBytes += Buffer.byteLength(content, "utf8");

    let lines = countLines(content);
    let body = content;
    let truncated = truncatedByBytes;
    if (lines > maxLines) {
      body = content.split("\n").slice(0, maxLines).join("\n");
      lines = maxLines;
      truncated = true;
    }
    refs.push({ path, lines, truncated });
    bodies.push(body);
  }

  if (refs.length === 0) return { text, refs, errors };

  const blocks = refs.map((r, i) => {
    const head = `——— ${r.path}（${r.lines} 行${r.truncated ? "，已截断" : ""}）———`;
    return `${head}\n${bodies[i] ?? ""}\n——— end ${r.path} ———`;
  });

  return {
    text: `${text}\n\n以下是 @ 引用的文件内容：\n${blocks.join("\n\n")}`,
    refs,
    errors,
  };
}

/** Windows 盘符（单字母 + : + \ 或 /）一律当文件路径，不当 MCP。 */
export function isWindowsDrivePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * `@<server>:<uri>`：首段能对上已连接 server 时才走 MCP。
 * 解析以 URI 为准，在第一个冒号处切开（URI 本身还可再含冒号）。
 */
export function parseMcpResourceRef(
  path: string,
  connectedServers: Iterable<string>,
): { server: string; uri: string } | null {
  if (isWindowsDrivePath(path)) return null;
  const colon = path.indexOf(":");
  if (colon <= 0) return null;
  const server = path.slice(0, colon);
  const uri = path.slice(colon + 1);
  if (!uri) return null;
  const list = [...connectedServers];
  const exact = list.find((s) => s === server);
  if (exact) return { server: exact, uri };
  const lower = server.toLowerCase();
  const folded = list.find((s) => s.toLowerCase() === lower);
  return folded ? { server: folded, uri } : null;
}

interface CollectedRef {
  kind: "file" | "mcp";
  path: string;
  lines: number;
  truncated: boolean;
  body: string;
  server?: string;
  uri?: string;
}

/**
 * 展开 `@path` 与 `@server:uri`：原文不动，引用块附在末尾。
 * 文件与 MCP 资源共用同一份预算，附件块分开标注。
 */
export async function expandMessageReferences(
  text: string,
  opts: ExpandOptions,
): Promise<ExpandResult> {
  const refs0 = parseReferences(text);
  if (refs0.length === 0) return { text, refs: [], errors: [] };

  const absOf = (p: string): string => (isAbsolute(p) ? p : join(opts.cwd, p));
  const exists = opts.exists ?? defaultExists;
  const readFile = opts.readFile ?? defaultReadFile;
  const statSize = opts.statSize ?? defaultStatSize;
  const readSlice = opts.readSlice ?? defaultReadSlice;
  const maxFiles = Math.max(1, opts.maxFiles ?? DEFAULT_MAX_FILES);
  const maxLines = Math.max(1, opts.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE);
  const maxBytes = Math.max(1, opts.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL);
  const connected = opts.mcp ? [...opts.mcp.connectedServers] : [];

  const collected: CollectedRef[] = [];
  const errors: string[] = [];
  const seenFile = new Set<string>();
  const seenMcp = new Set<string>();
  let totalBytes = 0;

  const applyBudget = (raw: string): { body: string; lines: number; truncated: boolean } => {
    let body = raw;
    let truncated = false;
    let lines = countLines(body);
    if (lines > maxLines) {
      body = body.split("\n").slice(0, maxLines).join("\n");
      lines = maxLines;
      truncated = true;
    }
    return { body, lines, truncated };
  };

  for (const r of refs0) {
    const mcpRef = opts.mcp ? parseMcpResourceRef(r.path, connected) : null;
    if (mcpRef) {
      const key = `${mcpRef.server}\0${mcpRef.uri}`;
      if (seenMcp.has(key)) continue;
      seenMcp.add(key);
      if (collected.length >= maxFiles) {
        errors.push(`最多引用 ${maxFiles} 个文件，${r.token} 未展开`);
        continue;
      }
      const remaining = maxBytes - totalBytes;
      if (remaining <= 0) {
        errors.push(`${r.token} 会让引用总量超出 ${maxBytes} 字节预算，已跳过`);
        continue;
      }
      try {
        const got = await opts.mcp!.read(mcpRef.server, mcpRef.uri);
        if (got.blob && got.text === undefined) {
          errors.push(`${r.token} 是二进制/blob 资源，已跳过`);
          continue;
        }
        if (got.text === undefined || got.text === "") {
          errors.push(`${r.token} 读取失败：空内容，按原文保留`);
          continue;
        }
        if (got.text.includes("\0")) {
          errors.push(`${r.token} 是二进制文件，已跳过`);
          continue;
        }
        let content = got.text;
        const size = Buffer.byteLength(content, "utf8");
        let truncatedByBytes = false;
        if (size > remaining) {
          // 按剩余字节截断，避免冲破预算。
          const buf = Buffer.from(content, "utf8").subarray(0, remaining);
          content = new TextDecoder("utf-8", { fatal: false }).decode(buf, { stream: true });
          truncatedByBytes = true;
        }
        totalBytes += Buffer.byteLength(content, "utf8");
        const clipped = applyBudget(content);
        collected.push({
          kind: "mcp",
          path: `${mcpRef.server} · ${mcpRef.uri}`,
          lines: clipped.lines,
          truncated: clipped.truncated || truncatedByBytes,
          body: clipped.body,
          server: mcpRef.server,
          uri: mcpRef.uri,
        });
      } catch (e) {
        errors.push(`${r.token} 读取失败：${(e as Error).message}`);
      }
      continue;
    }

    const path = normPath(r.path);
    const abs = absOf(path);
    if (seenFile.has(abs)) continue;
    seenFile.add(abs);

    if (collected.length >= maxFiles) {
      errors.push(`最多引用 ${maxFiles} 个文件，${r.token} 未展开`);
      continue;
    }
    if (!exists(absOf(path))) {
      errors.push(`${r.token} 不存在，按原文保留`);
      continue;
    }
    let size = 0;
    try {
      size = statSize(absOf(path));
    } catch (e) {
      errors.push(`${r.token} 读取失败：${(e as Error).message}`);
      continue;
    }
    const remaining = maxBytes - totalBytes;
    if (remaining <= 0) {
      errors.push(`${r.token} 会让引用总量超出 ${maxBytes} 字节预算，已跳过`);
      continue;
    }
    const truncatedByBytes = size > remaining;
    let content: string;
    try {
      content = truncatedByBytes ? readSlice(abs, remaining) : readFile(abs);
    } catch (e) {
      errors.push(`${r.token} 读取失败：${(e as Error).message}`);
      continue;
    }
    if (content.includes("\0")) {
      errors.push(`${r.token} 是二进制文件，已跳过`);
      continue;
    }
    totalBytes += Buffer.byteLength(content, "utf8");
    const clipped = applyBudget(content);
    collected.push({
      kind: "file",
      path,
      lines: clipped.lines,
      truncated: clipped.truncated || truncatedByBytes,
      body: clipped.body,
    });
  }

  if (collected.length === 0) return { text, refs: collected.map(({ path, lines, truncated }) => ({ path, lines, truncated })), errors };

  const files = collected.filter((c) => c.kind === "file");
  const resources = collected.filter((c) => c.kind === "mcp");
  const sections: string[] = [];
  if (files.length > 0) {
    const blocks = files.map((r) => {
      const head = `——— ${r.path}（${r.lines} 行${r.truncated ? "，已截断" : ""}）———`;
      return `${head}\n${r.body}\n——— end ${r.path} ———`;
    });
    sections.push(`以下是 @ 引用的文件内容：\n${blocks.join("\n\n")}`);
  }
  if (resources.length > 0) {
    const blocks = resources.map((r) => {
      const label = r.path;
      const head = `——— MCP 资源 ${label}（${r.lines} 行${r.truncated ? "，已截断" : ""}）———`;
      return `${head}\n${r.body}\n——— end ${label} ———`;
    });
    sections.push(`以下是 @ 引用的 MCP 资源：\n${blocks.join("\n\n")}`);
  }

  return {
    text: `${text}\n\n${sections.join("\n\n")}`,
    refs: collected.map(({ path, lines, truncated }) => ({ path, lines, truncated })),
    errors,
  };
}
