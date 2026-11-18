/**
 * MCP 工具按需发现（issue #68）。
 *
 * ## 问题
 *
 * `McpManager.connectAll()` 把每个远端工具的 `inputSchema` **原样**注册进工具表，
 * 而 `Agent.toolSpecsFor()` 每轮把整张表塞进请求。接了三五个 server 之后，
 * 光 MCP 的 schema 就能吃掉上万 token —— 模型还没开始读代码，窗口已经用掉一截。
 *
 * ## 做法
 *
 * 只延迟 **MCP** 工具（第一方工具始终全量，含本模块提供的 `tool_search`）：
 *
 *  - 可延迟数 = 已注册 MCP 工具中**非 alwaysLoad** 的数量；
 *  - `mcp.tool_search = "auto"`（默认）：可延迟数 ≥ `tool_search_threshold`（默认 10）才启用；
 *    `true` 强制启用，`false` 关闭（今日行为）；
 *  - 启用后，未装入的工具只出现在系统提示的**目录短节**（注册名 + 约 80 字描述，不含 schema），
 *    模型用 `tool_search` 命中后，**本会话**的已加载集合记下它，下一次模型请求带上完整 schema；
 *  - 模型也可以直接点名已注册但未装入的 `mcp__*`：照走审批并执行，同时记入已加载集合。
 *
 * ## 为什么是「条数阈值」而不是窗口百分比
 *
 * 条数可测、可讲，验收能写成断言；窗口百分比随模型窗口与估算口径漂移，
 * 同一份配置在不同模型上行为不同，讲不清也测不稳。也**不**读 `ENABLE_TOOL_SEARCH`
 * 环境变量 —— 行为只由 settings 决定，环境变量是隐藏的第二套开关。
 *
 * ## 状态归属
 *
 * 工具表是**进程级全局表**（ACP 一进程可有多会话），所以「已加载集合」必须挂在
 * 会话/`Agent` 上，不能靠从全局表注销实现。生命周期：成功压缩、`/clear`、
 * 会话结束即丢；`/resume` 不持久化，回来后只保留 `alwaysLoad`。
 *
 * 本模块是纯逻辑（阈值判定 / 匹配 / 目录渲染 / 会话状态），不 import Agent，
 * 避免 tools → agent 的循环依赖。
 */
import type { Config, McpServerConfig } from "../config.ts";
import { DEFAULT_MCP_CONFIG } from "../config/types.ts";
import type { ToolSpec } from "../llm.ts";
import { MCP_TOOL_PREFIX, parseMcpToolName } from "./tool.ts";

/** 搜索工具名（第一方工具，不是 MCP 工具）。 */
export const TOOL_SEARCH_NAME = "tool_search";

/** 一次搜索默认装入几个。 */
export const TOOL_SEARCH_DEFAULT_LIMIT = 5;

/** 一次搜索最多装入几个（模型传更大的 limit 也按它截断）。 */
export const TOOL_SEARCH_MAX_LIMIT = 10;

/** 目录短节里单条描述的最大字符数。 */
export const CATALOG_DESC_CHARS = 80;

/** 生效的 mcp 配置（缺省 = auto / 10）。 */
export function mcpConfigOf(cfg: Config): { toolSearch: "auto" | boolean; toolSearchThreshold: number } {
  const m = cfg.mcp;
  return {
    toolSearch: m?.toolSearch ?? DEFAULT_MCP_CONFIG.toolSearch,
    toolSearchThreshold: m?.toolSearchThreshold ?? DEFAULT_MCP_CONFIG.toolSearchThreshold,
  };
}

/** 该 server 是否声明了 alwaysLoad（server 级，不做按工具名单）。 */
export function isAlwaysLoadServer(cfg: Config, server: string): boolean {
  const list: McpServerConfig[] = cfg.mcpServers ?? [];
  return list.some((s) => s.name === server && s.alwaysLoad === true);
}

/** 一个已注册 MCP 工具在「延迟加载」视角下的分类。 */
export interface McpToolClass {
  /** 注册名（`mcp__<server>__<tool>`）。 */
  name: string;
  /** 所属 server（从注册名反解；反解不出时为 null）。 */
  server: string | null;
  /** true = 该 server 声明了 alwaysLoad，永远带完整 schema。 */
  alwaysLoad: boolean;
}

/** 把一组工具 spec 里的 MCP 工具挑出来并分类（顺序沿用注册表顺序）。 */
export function classifyMcpTools(cfg: Config, specs: readonly ToolSpec[]): McpToolClass[] {
  const out: McpToolClass[] = [];
  for (const s of specs) {
    const name = s.function.name;
    if (!name.startsWith(MCP_TOOL_PREFIX)) continue;
    const parsed = parseMcpToolName(name);
    const server = parsed?.server ?? null;
    out.push({ name, server, alwaysLoad: server !== null && isAlwaysLoadServer(cfg, server) });
  }
  return out;
}

/** 可延迟的 MCP 工具名（非 alwaysLoad）。 */
export function deferrableMcpNames(cfg: Config, specs: readonly ToolSpec[]): string[] {
  return classifyMcpTools(cfg, specs)
    .filter((t) => !t.alwaysLoad)
    .map((t) => t.name);
}

/**
 * 是否启用延迟加载。
 *
 * `true` / `false` 强制开/关；`"auto"` 看可延迟条数是否达到阈值。
 * 注意阈值判定用的是**可延迟数**（非 alwaysLoad 的 MCP 工具），
 * 所以 alwaysLoad 的 server 再大也不会把阈值顶穿。
 */
export function toolSearchEnabled(cfg: Config, specs: readonly ToolSpec[]): boolean {
  const { toolSearch, toolSearchThreshold } = mcpConfigOf(cfg);
  if (toolSearch === true) return true;
  if (toolSearch === false) return false;
  return deferrableMcpNames(cfg, specs).length >= toolSearchThreshold;
}

/**
 * 本会话的已加载集合（issue #68 §5）。
 *
 * 只存「因搜索/直接点名而装入」的 MCP 工具名。alwaysLoad 的工具**不**进这个集合 ——
 * 它们由配置决定，清空集合时不该被一起清掉（否则 /clear 之后 alwaysLoad 的工具
 * 会消失一轮，直到下一次 toolSpecsFor 重新分类）。
 */
export class McpLoadState {
  private loaded = new Set<string>();

  /** 已加载的 MCP 工具名（拷贝，调用方随便改）。 */
  snapshot(): string[] {
    return [...this.loaded];
  }

  has(name: string): boolean {
    return this.loaded.has(name);
  }

  /** 记一个工具为已加载；返回 true 表示这是新装入的。 */
  mark(name: string): boolean {
    if (!name.startsWith(MCP_TOOL_PREFIX)) return false;
    if (this.loaded.has(name)) return false;
    this.loaded.add(name);
    return true;
  }

  /** 清空（成功压缩 / `/clear` / 会话结束）。alwaysLoad 本来就不在这里。 */
  clear(): void {
    this.loaded.clear();
  }

  /** 派生一个副本（子代理拷贝父会话当时的已加载集合，变更不写回父会话）。 */
  copy(): McpLoadState {
    const next = new McpLoadState();
    next.loaded = new Set(this.loaded);
    return next;
  }
}

/**
 * 会话已加载集合的宿主能力（结构化类型）。
 *
 * `ToolCtx.host` 是 `CompactHost`，Agent 隐式满足；这里用鸭子类型取「已加载集合」，
 * 免得 tools 层反向 import Agent。测试的裸 ctx 不传 host 时，工具照样能执行，
 * 只是不记账（下一次请求不会带上 schema）。
 */
export interface McpLoadHost {
  markMcpLoaded?: (name: string) => boolean;
  mcpLoadedNames?: () => string[];
}

/** 从 ctx.host 取已加载集合宿主；不满足形状返回 null。 */
export function mcpLoadHostOf(host: unknown): McpLoadHost | null {
  if (typeof host !== "object" || host === null) return null;
  const h = host as McpLoadHost;
  if (typeof h.markMcpLoaded !== "function") return null;
  return h;
}

/** 把工具名记进宿主会话的已加载集合（宿主缺失时静默跳过）。 */
export function markMcpLoadedOn(host: unknown, name: string): boolean {
  const h = mcpLoadHostOf(host);
  if (!h) return false;
  try {
    return h.markMcpLoaded!(name) === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 匹配                                                                */
/* ------------------------------------------------------------------ */

/** 一个可被搜索到的 MCP 工具（目录条目）。 */
export interface CatalogEntry {
  name: string;
  /** 注册名里的远端段（`mcp__<server>__<tool>` 的 tool 部分），用于展示与匹配。 */
  shortName: string;
  server: string | null;
  description: string;
}

/** 从注册名反解出「短名」（远端段）；反解不出时退回注册名本身。 */
export function shortNameOf(name: string): string {
  const parsed = parseMcpToolName(name);
  return parsed?.tool ?? name;
}

/** 从 spec 的描述里剥掉 MCP 适配层加的前缀，只留远端原话。 */
function cleanDescription(spec: ToolSpec): string {
  const raw = spec.function.description ?? "";
  // makeMcpTool 拼的是 `[MCP:<server>] <远端描述>（title）（远端工具名：x）。外部 MCP 服务…`
  const stripped = raw
    .replace(/^\[MCP:[^\]]*\]\s*/, "")
    .replace(/。外部 MCP 服务提供的工具，调用前需用户批准。\s*$/, "")
    .trim();
  return stripped === "" ? raw.trim() : stripped;
}

/** 把一组 spec 里可延迟的 MCP 工具转成目录条目（顺序沿用注册表顺序）。 */
export function catalogEntries(cfg: Config, specs: readonly ToolSpec[], loaded: ReadonlySet<string>): CatalogEntry[] {
  const classes = classifyMcpTools(cfg, specs);
  const out: CatalogEntry[] = [];
  for (const c of classes) {
    if (c.alwaysLoad || loaded.has(c.name)) continue;
    const spec = specs.find((s) => s.function.name === c.name);
    if (!spec) continue;
    out.push({
      name: c.name,
      shortName: shortNameOf(c.name),
      server: c.server,
      description: cleanDescription(spec),
    });
  }
  return out;
}

/**
 * 按名字/描述做**大小写不敏感**的子串匹配。
 *
 * 为什么是子串而不是分词/打分：可测、可解释，模型看目录后基本会直接搜工具名的一部分。
 * 查询按空白切成若干词，**全部**命中才算匹配（AND 语义），这样
 * `"github issues"` 不会把只沾了 `issues` 的无关工具全捞进来。
 * 排序：名字命中优先于仅描述命中，同类按注册名排序 —— 结果确定，便于断言。
 */
export function matchCatalog(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (terms.length === 0) return [];
  const scored: Array<{ e: CatalogEntry; byName: boolean }> = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    const short = e.shortName.toLowerCase();
    const desc = e.description.toLowerCase();
    const byName = terms.every((t) => name.includes(t) || short.includes(t));
    const byDesc = terms.every((t) => desc.includes(t));
    if (!byName && !byDesc) continue;
    scored.push({ e, byName });
  }
  scored.sort((a, b) => {
    if (a.byName !== b.byName) return a.byName ? -1 : 1;
    return a.e.name < b.e.name ? -1 : a.e.name > b.e.name ? 1 : 0;
  });
  return scored.map((s) => s.e);
}

/** 把 limit 参数收敛到 [1, TOOL_SEARCH_MAX_LIMIT]，缺省 5。 */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return TOOL_SEARCH_DEFAULT_LIMIT;
  return Math.min(TOOL_SEARCH_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

/* ------------------------------------------------------------------ */
/* 目录短节                                                            */
/* ------------------------------------------------------------------ */

/** 截断描述到约 80 字符（按字符，不按字节 —— 中文一个字算一个）。 */
export function truncateDescription(text: string, max = CATALOG_DESC_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

/**
 * 系统提示里的 MCP 目录短节。
 *
 * 只有名字 + 截断描述，**没有 schema** —— 目录本身不能又变成一份上下文负担。
 * 未启用延迟加载（或没有可延迟的工具）时返回空串，提示词与今日完全一致。
 */
export function buildMcpCatalogSection(cfg: Config, specs: readonly ToolSpec[], loaded: ReadonlySet<string>): string {
  if (!toolSearchEnabled(cfg, specs)) return "";
  const entries = catalogEntries(cfg, specs, loaded);
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.name}：${truncateDescription(e.description)}`);
  return [
    "",
    "## MCP 工具目录（按需装入）",
    "",
    `下列 MCP 工具**尚未装入上下文**（只有名字与简述，没有参数 schema）。需要时用 ${TOOL_SEARCH_NAME}(query) 装入，` +
      `命中后下一次模型请求即可调用；也可以直接点名调用 —— 已注册的名字会照走审批并自动装入。`,
    "",
    ...lines,
    "",
  ].join("\n");
}
