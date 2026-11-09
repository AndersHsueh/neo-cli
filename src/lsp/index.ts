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

  /** 只读导航：definition / references / hover。server 未启动时抛可读错误。 */
  async navigate(op: "definition" | "references" | "hover", ref: PositionRef): Promise<string> {
    const abs = resolve(ref.file);
    if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`);
    const entry = this.forFile(abs);
    if (!entry) throw new Error(`没有语言服务器处理 ${extname(abs) || "该文件"}（检查 settings.lsp.servers）`);
    if (entry.status !== "connected") {
      throw new Error(`LSP server ${entry.cfg.name} 未连接：${entry.error ?? "未知原因"}`);
    }
    const doc = { text: readFileSync(abs, "utf8") };
    const uri = pathToFileURL(abs).href;
    this.sync(entry, uri, doc.text);
    const position = { line: Math.max(0, ref.line - 1), character: Math.max(0, ref.character - 1) };
    const method =
      op === "definition"
        ? "textDocument/definition"
        : op === "references"
          ? "textDocument/references"
          : "textDocument/hover";
    const params =
      op === "references"
        ? { textDocument: { uri }, position, context: { includeDeclaration: true } }
        : { textDocument: { uri }, position };
    const result = await entry.client.request<unknown>(method, params);
    return formatNavigation(op, result, this.cwd);
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

/** 把 LSP 返回的 Location/Hover 压成人能读的几行（导出给单测）。 */
export function formatNavigation(op: "definition" | "references" | "hover", result: unknown, cwd: string): string {
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
    return `[hover]\n${text.trim().split("\n").slice(0, 20).join("\n")}`;
  }
  const arr = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result];
  const positions: string[] = [];
  for (const item of arr.slice(0, 20)) {
    if (typeof item !== "object" || item === null) continue;
    const it = item as Record<string, unknown>;
    // Location 用 uri；LocationLink 用 targetUri。
    const uri = it["uri"] ?? it["targetUri"];
    const range = (it["range"] ?? it["targetRange"]) as { start?: { line?: number; character?: number } } | undefined;
    const line = typeof range?.start?.line === "number" ? range.start.line + 1 : 1;
    const ch = typeof range?.start?.character === "number" ? range.start.character + 1 : 1;
    positions.push(`  ${rel(uri)}:${line}:${ch}`);
  }
  if (positions.length === 0) return op === "definition" ? "（没有找到定义）" : "（没有找到引用）";
  return `[${op}] ${positions.length} 处\n${positions.join("\n")}`;
}

/** 会话内唯一实例。 */
export const lspServers = new LspManager();

/** 测试用：清空单例。 */
export function resetLspServers(): void {
  lspServers.closeAll();
}
