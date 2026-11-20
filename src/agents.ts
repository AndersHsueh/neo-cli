/**
 * 自定义命名子代理（issue #36）。
 *
 * 定义是单个 markdown 文件（不是技能那种 SKILL.md 目录）。发现顺序与技能同精神：
 * 项目先于用户，同级优先 neo 路径再 Claude 互操作路径；同名先到者胜。
 * 执行仍走既有 runSubagent / task，不另建一套运行时。
 *
 * 两条硬约束：
 *  1. 零第三方 YAML 依赖，frontmatter 用最小解析器。
 *  2. 用户级 neo 库路径必须从 cfg.agentsStore 读，测试注入沙箱，
 *     不得硬编码去读写用户真实的 ~/.neo/agents/。
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** 每次现读 HOME，避免 os.homedir() 缓存导致测试隔离失败，也避免扫到真实 ~/.claude/agents。 */
function userHome(): string {
  return process.env["HOME"] || process.env["USERPROFILE"] || homedir();
}
import type { Config, ModelTier } from "./config.ts";
import { normalizeTierName } from "./config.ts";
import { normalizeDescription } from "./skills.ts";
import { PLAN_ONLY_TOOL_NAMES, TOOL_NAMES_EXCLUDED_FOR_SUBAGENT, toolNames } from "./tools/index.ts";

/** 与技能名同一套白名单：小写字母 / 数字 / 连字符，且不以连字符开头。 */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export type AgentSource = "project-neo" | "project-claude" | "user-neo" | "user-claude";

export interface NamedAgent {
  name: string;
  description: string;
  absPath: string;
  source: AgentSource;
  /** 解析后的 neo 工具名白名单；undefined = 沿用默认子代理工具集。 */
  tools?: string[];
  /** frontmatter 里的 model/tier 原始值（已修整）。 */
  modelRaw?: string;
  body: string;
  /** 有 description 才进入索引 / 自动披露。 */
  advertised: boolean;
}

export interface AgentDiscovery {
  agents: NamedAgent[];
  warnings: string[];
}

export function isValidAgentName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 用户级 neo 子代理库。优先 cfg.agentsStore（测试注入点）。 */
export function agentsStore(cfg: Config): string {
  return cfg.agentsStore || join(userHome(), ".neo", "agents");
}

export function projectAgentsDir(cfg: Config): string {
  return join(cfg.cwd, ".neo", "agents");
}

export function projectClaudeAgentsDir(cfg: Config): string {
  return join(cfg.cwd, ".claude", "agents");
}

export function userClaudeAgentsDir(): string {
  return join(userHome(), ".claude", "agents");
}

export function describeAgentSource(source: AgentSource): string {
  switch (source) {
    case "project-neo":
      return "项目 .neo";
    case "project-claude":
      return "项目 .claude";
    case "user-neo":
      return "用户 .neo";
    case "user-claude":
      return "用户 .claude";
  }
}

/** Claude 工具名 → neo 工具名的小对照表。未知名只告警并丢弃，绝不默许放行。 */
export const CLAUDE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  Read: "read_file",
  Write: "write_file",
  Edit: "edit_file",
  Bash: "shell",
  Grep: "grep",
  Glob: "glob",
  Agent: "task",
};

const TIER_NAMES = new Set(["fast", "balanced", "default", "deep", "deep_reasoning", "inherit"]);

export type AgentModelResolution =
  | { kind: "inherit" }
  | { kind: "tier"; tier: ModelTier }
  | { kind: "model"; model: string }
  | { kind: "unknown"; raw: string };

/**
 * 解析 frontmatter 的 model/tier。优先档位名，其次当前 provider 已配置的模型 id。
 * 未知值由调用方告警并回落 inherit；不切换 provider。
 */
export function resolveAgentModel(raw: string | undefined, cfg: Config): AgentModelResolution {
  const value = (raw ?? "").trim();
  if (!value || value === "inherit" || value === "auto") return { kind: "inherit" };
  if (TIER_NAMES.has(value)) {
    const t = normalizeTierName(value);
    return t ? { kind: "tier", tier: t } : { kind: "inherit" };
  }
  const current = cfg.providers?.find((p) => p.name === cfg.providerName);
  const ids = new Set<string>();
  if (current?.models) {
    for (const v of Object.values(current.models)) {
      if (typeof v === "string" && v) ids.add(v);
    }
  }
  if (cfg.model) ids.add(cfg.model);
  if (ids.has(value)) return { kind: "model", model: value };
  return { kind: "unknown", raw: value };
}

/* ------------------------------------------------------------------ */
/* frontmatter                                                         */
/* ------------------------------------------------------------------ */

export interface AgentFrontmatter {
  fields: Record<string, string>;
  tools?: string[];
  body: string;
  closed: boolean;
  hasFrontmatter: boolean;
}

function stripQuotes(val: string): string {
  const t = val.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function splitToolList(raw: string): string[] {
  const s = raw.trim();
  const inner = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
  return inner
    .split(",")
    .map((x) => stripQuotes(x))
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * 解析子代理 markdown：`---` 块 + 正文。支持 tools 的逗号分隔、[a, b] 与缩进列表。
 * 未闭合的 frontmatter 视为畸形（closed=false）。
 */
export function parseAgentMarkdown(content: string): AgentFrontmatter {
  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return { fields: {}, body: content, closed: true, hasFrontmatter: false };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { fields: {}, body: "", closed: false, hasFrontmatter: true };
  }

  const fields: Record<string, string> = {};
  let tools: string[] | undefined;
  let listKey: string | null = null;
  const listItems: string[] = [];

  const flushList = (): void => {
    if (!listKey) return;
    if (listKey === "tools") tools = listItems.slice();
    else if (listItems.length) fields[listKey] = listItems.join(", ");
    listKey = null;
    listItems.length = 0;
  };

  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && listKey) {
      const item = stripQuotes(listMatch[1] ?? "");
      if (item) listItems.push(item);
      continue;
    }
    flushList();
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (!key) continue;
    if (val === "") {
      listKey = key;
      continue;
    }
    if (key === "tools") tools = splitToolList(val);
    else fields[key] = stripQuotes(val);
  }
  flushList();

  return {
    fields,
    tools,
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
    closed: true,
    hasFrontmatter: true,
  };
}

export interface ResolvedTools {
  names?: string[];
  warnings: string[];
}

/**
 * 把 frontmatter tools 收成 neo 工具名。缺省 = 默认子代理集（返回 undefined）。
 * 排除表（含 task）始终生效；未知名告警并丢弃。
 */
export function resolveAgentTools(
  raw: string[] | undefined,
  cfg?: Config,
  known?: readonly string[],
): ResolvedTools {
  if (raw === undefined) return { names: undefined, warnings: [] };
  const available = new Set(known ?? toolNames(cfg));
  const warnings: string[] = [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of raw) {
    const src = token.trim();
    if (!src) continue;
    const mapped = CLAUDE_TOOL_ALIASES[src] ?? src;
    if (!available.has(mapped)) {
      warnings.push(`未知工具 "${src}" 已忽略`);
      continue;
    }
    if (TOOL_NAMES_EXCLUDED_FOR_SUBAGENT.includes(mapped) || PLAN_ONLY_TOOL_NAMES.includes(mapped)) {
      warnings.push(`工具 "${src}" 对子代理不可用（结构性排除），已忽略`);
      continue;
    }
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }
  return { names: out, warnings };
}

/* ------------------------------------------------------------------ */
/* 发现                                                                */
/* ------------------------------------------------------------------ */

function isMarkdownFile(full: string, e: Dirent): boolean {
  if (!e.name.endsWith(".md") || e.name.startsWith(".")) return false;
  if (e.isFile()) return true;
  if (e.isSymbolicLink()) {
    try {
      return statSync(full).isFile();
    } catch {
      return false;
    }
  }
  return false;
}

function fileStem(filename: string): string {
  return basename(filename).replace(/\.md$/i, "");
}

function scanAgentsDir(
  dir: string,
  source: AgentSource,
  seen: Set<string>,
  cfg: Config,
  warnings: string[],
): NamedAgent[] {
  if (!existsSync(dir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    warnings.push(`无法读取子代理目录 ${dir}：${(e as Error).message}`);
    return [];
  }
  const out: NamedAgent[] = [];
  const files = entries
    .filter((e) => isMarkdownFile(join(dir, e.name), e))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of files) {
    const absPath = join(dir, e.name);
    let raw = "";
    try {
      raw = readFileSync(absPath, "utf8");
    } catch (err) {
      warnings.push(`无法读取子代理文件 ${absPath}：${(err as Error).message}`);
      continue;
    }
    const parsed = parseAgentMarkdown(raw);
    if (parsed.hasFrontmatter && !parsed.closed) {
      warnings.push(`子代理文件 ${absPath} 的 frontmatter 未闭合，已跳过`);
      continue;
    }
    const stem = fileStem(e.name);
    const named = (parsed.fields["name"] ?? "").trim();
    const name = named || stem;
    if (!isValidAgentName(name)) {
      warnings.push(`子代理名非法（${name}），已跳过：${absPath}`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`子代理 ${name} 被先发现的定义覆盖，已跳过：${absPath}`);
      continue;
    }
    const description = (parsed.fields["description"] ?? "").trim();
    if (!description) {
      warnings.push(`子代理 ${name} 缺少 description，不进入自动索引：${absPath}`);
    }
    const toolRes = resolveAgentTools(parsed.tools, cfg);
    warnings.push(...toolRes.warnings.map((w) => `${absPath}: ${w}`));
    const modelRaw = (parsed.fields["model"] ?? parsed.fields["tier"] ?? "").trim() || undefined;
    if (modelRaw) {
      const resolved = resolveAgentModel(modelRaw, cfg);
      if (resolved.kind === "unknown") {
        warnings.push(`${absPath}: 未知 model/tier "${modelRaw}"，将回落 inherit`);
      }
    }
    seen.add(name);
    out.push({
      name,
      description,
      absPath,
      source,
      tools: toolRes.names,
      modelRaw,
      body: parsed.body,
      advertised: description.length > 0,
    });
  }
  return out;
}

/**
 * 按约定顺序发现命名子代理。safe-mode 下载入空列表。
 * 同名先到者胜：项目 .neo → 项目 .claude → 用户 .neo → 用户 .claude。
 */
export function discoverAgents(cfg: Config): AgentDiscovery {
  if (cfg.safeMode) return { agents: [], warnings: [] };
  const warnings: string[] = [];
  const seen = new Set<string>();
  const agents: NamedAgent[] = [];
  const layers: Array<{ dir: string; source: AgentSource }> = [
    { dir: projectAgentsDir(cfg), source: "project-neo" },
    { dir: projectClaudeAgentsDir(cfg), source: "project-claude" },
    { dir: agentsStore(cfg), source: "user-neo" },
    { dir: userClaudeAgentsDir(), source: "user-claude" },
  ];
  for (const layer of layers) {
    agents.push(...scanAgentsDir(layer.dir, layer.source, seen, cfg, warnings));
  }
  return { agents, warnings };
}

export function findAgent(cfg: Config, name: string): NamedAgent | undefined {
  return discoverAgents(cfg).agents.find((a) => a.name === name);
}

export function advertisedAgents(agents: NamedAgent[]): NamedAgent[] {
  return agents.filter((a) => a.advertised);
}

export function formatAgentLine(name: string, description: string): string {
  return `- ${name}：${normalizeDescription(description, name)}`;
}

/** 注入 system prompt / task 描述的短索引。无可用项时返回空串。 */
export function buildAgentIndex(agents: NamedAgent[]): string {
  const listed = advertisedAgents(agents);
  if (listed.length === 0) return "";
  const lines = listed.map((a) => formatAgentLine(a.name, a.description));
  return [
    "## 自定义子代理",
    "",
    "以下命名子代理可通过 task 工具的可选参数 agent 调用（与技能不同：技能用 use_skill 加载说明书，子代理是隔离执行的角色）。不传 agent 则为通用子代理。",
    "",
    ...lines,
  ].join("\n");
}

/** 正文摘录：给人看的详情，避免把整份角色提示词倒出来。 */
export function excerptAgentBody(body: string, maxChars = 400): string {
  const text = body.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

/**
 * 解析 task.agent 参数。空名字 = 通用子代理。
 * 未知名字返回错误，并列出当前可用名称（含未自动披露但可显式调用的）。
 */
export function resolveTaskAgent(
  cfg: Config,
  name: string | undefined,
): { ok: true; agent?: NamedAgent } | { ok: false; error: string } {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { ok: true };
  const { agents } = discoverAgents(cfg);
  const hit = agents.find((a) => a.name === trimmed);
  if (!hit) {
    const available = agents.map((a) => a.name);
    const list = available.length > 0 ? available.join(", ") : "（无）";
    return { ok: false, error: `未知子代理 "${trimmed}"。可用：${list}` };
  }
  return { ok: true, agent: hit };
}
