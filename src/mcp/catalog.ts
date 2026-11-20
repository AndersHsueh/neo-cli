/**
 * MCP resources / prompts 的纯数据与清单辅助（issue #67）。
 *
 * 能力协商、通知回调、真正的 RPC 仍在 client.ts；这里只放规范化、分页、
 * 菜单条目和 prompts/get 结果的文本化，方便单测直接驱动。
 */
/** list 跟页上限：到顶就截断并告警，避免不诚实的 cursor 把启动拖死。 */
export const MAX_LIST_PAGES = 20;

export interface McpResourceInfo {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** 扁平化到「已连接资源」列表时带上。 */
  server?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
  server?: string;
}

export interface McpResourceReadResult {
  text?: string;
  blob?: string;
  mimeType?: string;
  uri?: string;
}

export interface McpPromptMessage {
  role?: string;
  content?: unknown;
}

export interface McpPromptGetResult {
  description?: string;
  messages?: McpPromptMessage[];
}

export interface ServerCapFlags {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

/** 服务端 capabilities 里出现对应键（即使是空对象）即视为已声明。 */
export function serverCapFlags(caps: unknown): ServerCapFlags {
  if (!caps || typeof caps !== "object") {
    return { tools: false, resources: false, prompts: false };
  }
  const o = caps as Record<string, unknown>;
  return {
    tools: o["tools"] != null,
    resources: o["resources"] != null,
    prompts: o["prompts"] != null,
  };
}

/** MCP Apps UI 资源：不要进 `@` 建议。 */
export function isMcpAppResource(r: { uri?: string; mimeType?: string }): boolean {
  const uri = r.uri ?? "";
  const mime = (r.mimeType ?? "").toLowerCase();
  if (uri.startsWith("ui://")) return true;
  if (mime.includes("profile=mcp-app")) return true;
  return false;
}

export function normalizeResources(raw: unknown): McpResourceInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: McpResourceInfo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const uri = typeof o["uri"] === "string" ? o["uri"] : "";
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    const rec: McpResourceInfo = { uri };
    if (typeof o["name"] === "string") rec.name = o["name"];
    if (typeof o["title"] === "string") rec.title = o["title"];
    if (typeof o["description"] === "string") rec.description = o["description"];
    if (typeof o["mimeType"] === "string") rec.mimeType = o["mimeType"];
    out.push(rec);
  }
  return out;
}

export function normalizePrompts(raw: unknown): McpPromptInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: McpPromptInfo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = typeof o["name"] === "string" ? o["name"] : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const rec: McpPromptInfo = { name };
    if (typeof o["title"] === "string") rec.title = o["title"];
    if (typeof o["description"] === "string") rec.description = o["description"];
    if (Array.isArray(o["arguments"])) {
      const args: McpPromptArgument[] = [];
      for (const a of o["arguments"]) {
        if (!a || typeof a !== "object") continue;
        const ar = a as Record<string, unknown>;
        if (typeof ar["name"] !== "string" || ar["name"] === "") continue;
        const arg: McpPromptArgument = { name: ar["name"] };
        if (typeof ar["description"] === "string") arg.description = ar["description"];
        if (typeof ar["required"] === "boolean") arg.required = ar["required"];
        args.push(arg);
      }
      if (args.length > 0) rec.arguments = args;
    }
    out.push(rec);
  }
  return out;
}

export function normalizeResourceRead(raw: unknown): McpResourceReadResult {
  if (!raw || typeof raw !== "object") return {};
  const contents = (raw as Record<string, unknown>)["contents"];
  if (!Array.isArray(contents) || contents.length === 0) return {};
  // 优先第一段带 text 的；否则第一段 blob。
  let blobFallback: McpResourceReadResult | null = null;
  for (const item of contents) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const rec: McpResourceReadResult = {};
    if (typeof o["uri"] === "string") rec.uri = o["uri"];
    if (typeof o["mimeType"] === "string") rec.mimeType = o["mimeType"];
    if (typeof o["text"] === "string") {
      rec.text = o["text"];
      return rec;
    }
    if (typeof o["blob"] === "string" && !blobFallback) {
      rec.blob = o["blob"];
      blobFallback = rec;
    }
  }
  return blobFallback ?? {};
}

/**
 * 跟页：请求带 cursor，直到没有 nextCursor 或达到页数上限。
 * 截断时 truncated=true，由调用方告警；已读到的页仍保留。
 */
export async function listAllPages<T>(opts: {
  request: (params: Record<string, unknown>) => Promise<unknown>;
  key: string;
  normalize: (raw: unknown) => T[];
  maxPages?: number;
}): Promise<{ items: T[]; truncated: boolean }> {
  const maxPages = Math.max(1, opts.maxPages ?? MAX_LIST_PAGES);
  const items: T[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, unknown> = {};
    if (cursor !== undefined) params["cursor"] = cursor;
    const raw = await opts.request(params);
    const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    items.push(...opts.normalize(obj[opts.key]));
    const next = obj["nextCursor"];
    if (typeof next === "string" && next !== "") {
      cursor = next;
      if (page === maxPages - 1) truncated = true;
    } else {
      cursor = undefined;
      break;
    }
  }
  return { items, truncated };
}

/** `/` 菜单用限定名；不要写成 mcp__server__prompt。 */
export function mcpPromptMenuEntries(
  prompts: Array<Pick<McpPromptInfo, "name" | "description" | "title"> & { server: string }>,
): Array<{ name: string; description: string }> {
  return prompts.map((p) => {
    const extra = p.description ?? p.title;
    return {
      name: `${p.server}:${p.name}`,
      description: extra ? `MCP · ${p.server} · ${extra}` : `MCP · ${p.server}`,
    };
  });
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => contentToText(c)).filter(Boolean).join("\n");
  }
  if (!content || typeof content !== "object") return "";
  const o = content as Record<string, unknown>;
  if (typeof o["text"] === "string") return o["text"];
  if (o["type"] === "resource" && o["resource"] && typeof o["resource"] === "object") {
    const res = o["resource"] as Record<string, unknown>;
    if (typeof res["text"] === "string") return res["text"];
    if (typeof res["uri"] === "string") return `[resource] ${res["uri"]}`;
  }
  return "";
}

/** 把 prompts/get 结果压成即将入队的用户消息（不是隐藏系统提示词）。 */
export function formatMcpPromptResult(
  server: string,
  prompt: string,
  result: McpPromptGetResult,
): string {
  const parts: string[] = [];
  for (const msg of result.messages ?? []) {
    const text = contentToText(msg.content).trim();
    if (!text) continue;
    const role = (msg.role ?? "user").toLowerCase();
    parts.push(role === "user" ? text : `[${role}]\n${text}`);
  }
  const body = parts.join("\n\n").trim();
  if (!body) return "";
  return `${body}\n---\nMCP 提示词 /${server}:${prompt}`;
}

/** 方法不存在（含 JSON-RPC -32601）—— 跳过即可，不能让握手失败。 */
export function isMethodMissing(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  if (code === -32601) return true;
  const msg = (e as Error)?.message ?? String(e);
  return msg.includes("-32601") || /method not found/i.test(msg) || /不支持的方法/.test(msg);
}

/** 看起来像二进制、不应塞进用户消息的资源。 */
export function isBinaryResource(r: McpResourceReadResult): boolean {
  if (r.text !== undefined) return r.text.includes("\0");
  if (r.blob) return true;
  const mime = (r.mimeType ?? "").toLowerCase();
  if (!mime) return false;
  if (mime.startsWith("text/")) return false;
  if (mime.includes("json") || mime.includes("xml") || mime.includes("javascript") || mime.includes("yaml")) {
    return false;
  }
  return true;
}
