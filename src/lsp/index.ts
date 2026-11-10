/**
 * LSP 管理器（issue #23）：按配置启动语言服务器，提供两条能力：
 *
 *  1. **编辑后诊断**：write_file / edit_file 落盘后，把该文件的新诊断摘要附进工具结果；
 *  2. **只读符号导航**：`lsp` 工具的 definition / references / hover。
 *
 * 零配置 = 零开销：`settings.lsp.servers` 为空时不 spawn、不扫盘。
 * 会话退出 closeAll()，不留孤儿语言服务器进程。
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Config, LspServerConfig } from "../config.ts";
import { LspClient, type LspDiagnostic } from "./client.ts";

export interface LspServerState {
  name: string;
  command: string;
  extensions: string[];
  status: "connected" | "error";
  error?: string;
}

interface Entry {
  cfg: LspServerConfig;
  client: LspClient;
  status: "connected" | "error";
  error?: string;
  opened: Set<string>;
  versions: Map<string, number>;
}

export interface PositionRef {
  /** 绝对路径。 */
  file: string;
  /** 1-based 行（人类口径；内部转 0-based）。 */
  line: number;
  /** 1-based 列（内部转 0-based）。 */
  character: number;
}

/** `lsp` 工具支持的操作（issue #23 首期三种 + #43 扩展三种）。 */
export const LSP_OPERATIONS = [
  "definition",
  "references",
  "hover",
  "workspaceSymbol",
  "callHierarchy",
  "completion",
] as const;

export type LspOperation = (typeof LSP_OPERATIONS)[number];

/** 需要文件位置的 operation（workspaceSymbol 不需要）。 */
export const LSP_POSITION_OPERATIONS: readonly LspOperation[] = [
  "definition",
  "references",
  "hover",
  "callHierarchy",
  "completion",
];

export type CallDirection = "incoming" | "outgoing";

/** 各类结果最多显示多少条（超出标注总数）。 */
export const NAV_MAX_ITEMS = 20;
/** hover 最多显示多少行。 */
export const HOVER_MAX_LINES = 20;

const SEVERITY_LABEL: Record<LspDiagnostic["severity"], string> = {
  error: "error",
  warning: "warning",
  info: "info",
  hint: "hint",
};

export class LspManager {
  private entries: Entry[] = [];
  private cwd = "";
  private timeoutMs = 1_500;

  get configured(): boolean {
    return this.entries.some((e) => e.status === "connected");
  }

  states(): LspServerState[] {
    return this.entries.map((e) => ({
      name: e.cfg.name,
      command: e.cfg.command,
      extensions: [...e.cfg.extensions],
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
    }));
  }

  /**
   * 按配置启动全部 server。永不抛错：启动失败的 server 记 error 状态并返回可读消息，
   * 其它 server 照常工作（与 MCP 同口径）。
   */
  async configure(cfg: Pick<Config, "cwd" | "lsp">): Promise<string[]> {
    this.closeAll();
    this.cwd = cfg.cwd;
    this.timeoutMs = cfg.lsp.diagnosticsTimeoutMs;
    if (!cfg.lsp.enabled) return [];
    const problems: string[] = [];
    for (const sc of cfg.lsp.servers) {
      const client = new LspClient({ name: sc.name, command: sc.command, args: sc.args, cwd: cfg.cwd });
      const entry: Entry = { cfg: sc, client, status: "error", opened: new Set(), versions: new Map() };
      try {
        await client.start();
        entry.status = "connected";
      } catch (e) {
        entry.error = (e as Error).message;
        problems.push(entry.error);
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
      this.entries.push(entry);
    }
    return problems;
  }

  /** 编辑落盘后调用：返回可附带进工具结果的诊断摘要（无 server / 无诊断 = ""）。 */
  async afterEdit(absPath: string): Promise<string> {
    const entry = this.forFile(absPath);
    if (!entry) return "";
    const uri = pathToFileURL(absPath).href;
    let text: string;
    try {
      text = readFileSync(absPath, "utf8");
    } catch {
      return "";
    }
    this.sync(entry, uri, text);
    const diags = await entry.client.waitDiagnostics(uri, this.timeoutMs);
    if (diags === null || diags.length === 0) return "";
    const shown = diags.slice(0, 10);
    const errors = diags.filter((d) => d.severity === "error").length;
    const warnings = diags.filter((d) => d.severity === "warning").length;
    const head = `[LSP 诊断] ${errors} error / ${warnings} warning${diags.length > shown.length ? `（共 ${diags.length} 条，显示前 ${shown.length}）` : ""}`;
    const lines = shown.map((d) => {
      const rel = this.relOf(absPath);
      return `  ${rel}:${d.line + 1}:${d.character + 1} [${SEVERITY_LABEL[d.severity]}] ${d.message.replace(/\s+/g, " ").slice(0, 200)}`;
    });
    return `\n${head}\n${lines.join("\n")}`;
  }

  /**
   * 只读导航（issue #23 / #43）。server 未启动时抛可读错误。
   *
   * - `workspaceSymbol` 只吃 query：不需要文件、不需要位置，全仓查询；
   * - 其余 operation 都需要位置（file + line），且文件必须存在。
   */
  async navigate(op: LspOperation, ref: PositionRef, query?: string, direction?: CallDirection): Promise<string> {
    if (op === "workspaceSymbol") {
      const entry = this.entries.find((e) => e.status === "connected");
      if (!entry) throw new Error("没有可用的语言服务器（检查 settings.lsp.servers）");
      const result = await entry.client.request<unknown>("workspace/symbol", { query: query ?? "" });
      return formatNavigation(op, result, this.cwd);
    }
    const abs = resolve(ref.file);
    if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    const entry = this.forFile(abs);
    if (!entry) throw new Error(`没有语言服务器处理 ${extname(abs) || "该文件"}（检查 settings.lsp.servers）`);
    const text = readFileSync(abs, "utf8");
    const uri = pathToFileURL(abs).href;
    this.sync(entry, uri, text);
    const position = { line: Math.max(0, ref.line - 1), character: Math.max(0, ref.character - 1) };
    const result = await this.requestAt(entry, op, uri, position, direction);
    return formatNavigation(op, result, this.cwd);
  }

  /** 按 operation 发对应请求；callHierarchy 是两段式（prepare 拿 item，再拿 calls）。 */
  private async requestAt(
    entry: Entry,
    op: Exclude<LspOperation, "workspaceSymbol">,
    uri: string,
    position: { line: number; character: number },
    direction?: CallDirection,
  ): Promise<unknown> {
    const textDocument = { uri };
    if (op === "callHierarchy") {
      const prepared = await entry.client.request<unknown>("textDocument/prepareCallHierarchy", {
        textDocument,
        position,
      });
      const items = asArray(prepared);
      const item = items[0];
      // 拿不到 item 就没有调用链可言 —— 返回空让 formatter 出「没有找到」。
      if (typeof item !== "object" || item === null) return [];
      // item 必须**原样回传**（含 data 字段），server 靠它定位符号。
      const method = direction === "outgoing" ? "callHierarchy/outgoingCalls" : "callHierarchy/incomingCalls";
      return entry.client.request<unknown>(method, { item });
    }
    if (op === "references") {
      return entry.client.request<unknown>("textDocument/references", {
        textDocument,
        position,
        context: { includeDeclaration: true },
      });
    }
    const method =
      op === "definition"
        ? "textDocument/definition"
        : op === "completion"
          ? "textDocument/completion"
          : "textDocument/hover";
    return entry.client.request<unknown>(method, { textDocument, position });
  }

  closeAll(): void {
    for (const e of this.entries) {
      try {
        e.client.close();
      } catch {
        /* ignore */
      }
    }
    this.entries = [];
  }

  /* ---------------- 内部 ---------------- */

  private relOf(abs: string): string {
    const rel = relative(this.cwd, abs);
    return rel === "" || rel.startsWith("..") ? abs : rel.split("\\").join("/");
  }

  private forFile(abs: string): Entry | null {
    const ext = extname(abs).toLowerCase();
    return this.entries.find((e) => e.status === "connected" && e.cfg.extensions.includes(ext)) ?? null;
  }

  /** didOpen / didChange 同步（每个文件每 server 只 open 一次，之后增量全量同步）。 */
  private sync(entry: Entry, uri: string, text: string): void {
    const version = (entry.versions.get(uri) ?? 0) + 1;
    entry.versions.set(uri, version);
    if (!entry.opened.has(uri)) {
      entry.opened.add(uri);
      entry.client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: languageIdOf(uri), version, text },
      });
    } else {
      entry.client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    entry.client.markDirty(uri);
  }
}

function languageIdOf(uri: string): string {
  const ext = extname(uri).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
  };
  return map[ext] ?? "plaintext";
}

/** `asArray`：LSP 的 result 可能是单值、数组或 null，统一成数组（导出给单测）。 */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
}

/** 把 LSP 返回的 Location/Hover/SymbolInformation/CallHierarchy/Completion 压成人能读的几行（导出给单测）。 */
export function formatNavigation(op: LspOperation, result: unknown, cwd: string): string {
  const rel = (uri: unknown): string => {
    if (typeof uri !== "string") return "?";
    try {
      const p = uri.startsWith("file://") ? decodeURIComponent(new URL(uri).pathname) : uri;
      const r = relative(cwd, p);
      return r === "" || r.startsWith("..") ? p : r.split("\\").join("/");
    } catch {
      return uri;
    }
  };
  /** `path:line:col`（LSP 0-based → 人类 1-based）。 */
  const at = (uri: unknown, range: unknown): string => {
    const r = range as { start?: { line?: number; character?: number } } | undefined;
    const line = typeof r?.start?.line === "number" ? r.start.line + 1 : 1;
    const ch = typeof r?.start?.character === "number" ? r.start.character + 1 : 1;
    return `${rel(uri)}:${line}:${ch}`;
  };
  /** 统一截断口径：最多 NAV_MAX_ITEMS 条，超了标注总数。 */
  const capped = (label: string, lines: string[], empty: string): string => {
    if (lines.length === 0) return empty;
    const shown = lines.slice(0, NAV_MAX_ITEMS);
    const tail = lines.length > shown.length ? `（共 ${lines.length} 条，已截断显示前 ${shown.length} 条）` : "";
    return `[${label}] ${shown.length} 条${tail}\n${shown.join("\n")}`;
  };

  if (op === "hover") {
    const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
    const contents = r["contents"];
    const text =
      typeof contents === "string"
        ? contents
        : Array.isArray(contents)
          ? contents
              .map((c) => (typeof c === "string" ? c : typeof (c as { value?: unknown })?.value === "string" ? String((c as { value: string }).value) : ""))
              .filter((s) => s !== "")
              .join("\n")
          : typeof (contents as { value?: unknown })?.value === "string"
            ? String((contents as { value: string }).value)
            : "";
    if (text.trim() === "") return "（hover 没有返回内容）";
    return `[hover]\n${text.trim().split("\n").slice(0, HOVER_MAX_LINES).join("\n")}`;
  }

  if (op === "workspaceSymbol") {
    const arr = asArray(result);
    const lines: string[] = [];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      const name = typeof it["name"] === "string" ? it["name"] : "?";
      // SymbolInformation 用 location；WorkspaceSymbol 可能只有 uri。
      const loc = (it["location"] ?? {}) as Record<string, unknown>;
      const where = loc["uri"] !== undefined ? at(loc["uri"], loc["range"]) : at(it["uri"], it["range"]);
      const container = typeof it["containerName"] === "string" && it["containerName"] !== "" ? ` (${it["containerName"]})` : "";
      lines.push(`  ${name}${container} — ${where}`);
    }
    return capped("workspaceSymbol", lines, "（没有找到符号）");
  }

  if (op === "callHierarchy") {
    const arr = asArray(result);
    const lines: string[] = [];
    for (const item of arr) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      // incomingCalls 用 from，outgoingCalls 用 to；两者都是 CallHierarchyItem。
      const peer = (it["from"] ?? it["to"] ?? {}) as Record<string, unknown>;
      const name = typeof peer["name"] === "string" ? peer["name"] : "?";
      const detail = typeof peer["detail"] === "string" && peer["detail"] !== "" ? ` ${peer["detail"]}` : "";
      const site = at(peer["uri"], peer["range"]);
      // fromRanges 是「调用发生在我这一侧的位置」，只取第一条做线索。
      const ranges = asArray(it["fromRanges"]);
      const first = ranges[0] as { start?: { line?: number; character?: number } } | undefined;
      const callAt =
        typeof first?.start?.line === "number" ? ` @${first.start.line + 1}:${(first.start.character ?? 0) + 1}` : "";
      lines.push(`  ${name}${detail} — ${site}${callAt}`);
    }
    return capped("callHierarchy", lines, "（没有找到调用关系）");
  }

  if (op === "completion") {
    // CompletionList 是 { isIncomplete, items }；也兼容直接返回数组的 server。
    const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
    const raw = Array.isArray(result) ? result : asArray(r["items"]);
    const lines: string[] = [];
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const it = item as Record<string, unknown>;
      const label = typeof it["label"] === "string" ? it["label"] : "?";
      const detail = typeof it["detail"] === "string" && it["detail"] !== "" ? ` — ${it["detail"]}` : "";
      lines.push(`  ${label}${detail}`);
    }
    const head = r["isIncomplete"] === true ? "（isIncomplete：server 只给了部分候选）" : "";
    const body = capped("completion", lines, "（没有补全候选）");
    return head === "" ? body : `${body}\n${head}`;
  }

  // definition / references：Location 用 uri；LocationLink 用 targetUri。
  const arr = asArray(result);
  const lines: string[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const it = item as Record<string, unknown>;
    lines.push(`  ${at(it["uri"] ?? it["targetUri"], it["range"] ?? it["targetRange"])}`);
  }
  return capped(op, lines, op === "definition" ? "（没有找到定义）" : "（没有找到引用）");
}

/** 会话内唯一实例。 */
export const lspServers = new LspManager();

/** 测试用：清空单例。 */
export function resetLspServers(): void {
  lspServers.closeAll();
}
