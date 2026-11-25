/**
 * 小窗口下的工具可见集（issue #20 收尾）。
 *
 * 背景：小窗口下「mini 档仍放不下」时，选档只回报 `fits=false` 并照旧用 mini，
 * 请求带着注定超预算的系统提示词发出去 —— 实测 16K 窗口下系统提示 + 工具 schema
 * 约 6.1K token（预算只有 2.0K），模型可用上下文被提示词吃掉三分之一以上。
 *
 * 本模块按固定优先级算出「当前预算下最多能暴露哪些工具」。
 * v0.4.72 起 `/context` 用它做 dry-run。issue #104：选档 `fits=false` 时，
 * `decideRuntimeVisibility` 把同一份计算接到真正发出的系统提示词和工具 schema。
 * dry-run 在「连 0 个工具都放不下」时仍返回空集；运行时另有四个工具的硬底线，
 * 不把空集原样发出去。
 *
 * 三条硬约束：
 *  1. **可见集永远是优先级前缀** —— 不能出现「有 grep 没有 read_file」这种组合；
 *  2. **动态块三项成组裁** —— 技能索引 / wiki 索引 / 目录树要么全裁要么全留：
 *     实测单裁一项只省 ~200 token，三项齐裁才省 ~1.2K（技能 481 + wiki 255 + 树 453）；
 *  3. **按实测开销现算，不写死阈值表** —— 开销随环境（技能数、目录大小、MCP 工具数）
 *     变化，阈值表换个环境就是错的。
 */
import type { ToolSpec } from "../llm.ts";
import { isMcpToolName } from "../agent/policy.ts";
import { countSystemTokens } from "./tokens.ts";

/**
 * 工具可见性优先级（**全库唯一定义**）：越靠前越不能丢。
 *
 * 顺序的依据（实测 cl100k schema 开销 + 能力可替代性）：
 *  - read_file / edit_file / shell：agent 的最小有用闭环 —— 能读、能改、能验证；
 *  - list_dir / glob / grep：导航（shell 的 ls/rg 可替代，但结构化工具更安全）；
 *  - write_file：写文件（edit_file 只能改已存在的文件）；
 *  - compact_ctx：窗口管理 —— 小窗口下最需要它撑住长会话；
 *  - web_fetch / web_search：外部信息，不影响本地编码；
 *  - use_skill：技能正文入口（与「技能」索引节绑定，索引被裁时它没有意义）；
 *  - task：派生（最贵的单项，498 token）；
 *  - wiki_search / todo_write / remember / wiki_write：记忆与任务管理。
 *
 * 条件工具（ask_user / send_message / list_peers）排在最后：ask_user 虽然是唯一的
 * 提问通道，但小窗口下模型可以「报告并停下」，代价小于 436 token 的 schema。
 * MCP 动态工具永远排在最后（外部集成，最先被裁）。
 */
export const TOOL_VISIBILITY_PRIORITY: readonly string[] = [
  "read_file",
  "edit_file",
  "shell",
  "shell_output",
  "list_dir",
  "glob",
  "grep",
  "write_file",
  "compact_ctx",
  "web_fetch",
  "web_search",
  "use_skill",
  "task",
  "wiki_search",
  "todo_write",
  "remember",
  "wiki_write",
  "ask_user",
  "send_message",
  "list_peers",
];

/**
 * 按优先级排好的候选工具名（只含已注册的）。
 *
 * 未在优先级表里的工具（将来新增的第一方工具）排在已知工具之后、MCP 之前 ——
 * 名字排序保证结果确定（同一份注册表两次调用结果一致）。
 */
export function visibilityPriority(registered: readonly string[]): string[] {
  const has = new Set(registered);
  const known = TOOL_VISIBILITY_PRIORITY.filter((n) => has.has(n));
  const knownSet = new Set(known);
  const unknown = registered
    .filter((n) => !knownSet.has(n) && !isMcpToolName(n))
    .sort();
  const mcp = registered.filter((n) => isMcpToolName(n)).sort();
  return [...known, ...unknown, ...mcp];
}

/**
 * 「## 工具」节里可能出现的工具名全集：优先级表 ∪ 已注册工具。
 *
 * 为什么不能只用「已注册」：那节的工具说明是**硬编码**的 —— 即使某个工具当前没注册
 * （比如没启信箱时的 send_message），说明行也照样在提示词里。判定一行归属哪个工具时
 * 必须认识这些名字，否则它们的说明行会被当成「与工具无关」而永远留下，隐藏不掉。
 */
export function knownToolNames(registered: readonly string[]): string[] {
  return [...new Set([...TOOL_VISIBILITY_PRIORITY, ...registered])];
}

/** 一份可见集方案。 */
export interface ToolVisibility {
  /** 建议暴露的工具名（优先级前缀，按优先级顺序）。 */
  names: string[];
  /** 建议隐藏的工具名（按优先级顺序）。 */
  hidden: string[];
  /** 候选工具总数。 */
  total: number;
  /** 是否需要同时裁掉动态块三项（技能索引 / wiki 索引 / 目录树）。 */
  trimmed: boolean;
  /** 放得下吗：连 0 个工具都放不下时为 false（不抛错）。 */
  fits: boolean;
  /** 选中方案的估计开销（token）。 */
  cost: number;
  /** 预算（token）。 */
  budget: number;
  /**
   * 运行时已经按这个集合收窄请求（issue #104）。
   * 缺省 / false = 仍是 dry-run，请求没有按它裁。
   */
  applied?: boolean;
}

export interface VisibilityInput {
  /** 候选工具名，已按优先级排好（可见集永远是它的前缀）。 */
  priority: readonly string[];
  /** 预算（token）。 */
  budget: number;
  /** 给定可见集与裁剪标志时的系统提示词 + schema 开销（token）。 */
  measure: (names: readonly string[], trimDynamic: boolean) => number;
}

/**
 * 按优先级、预算与「是否同时裁动态块」算出一个可见集方案。
 *
 * 算法：动态块三项成组裁 ⇒ 只有「裁」与「不裁」两个状态；对每个状态取**放得下的
 * 最大前缀**（前缀性质由 priority 的定义保证）。两个状态比大小：能多放工具就多放
 * （工具是能力，索引只是导航）；一样多则不裁动态块（少一处损失）。
 *
 * 连 0 个工具都放不下时返回 `fits=false`（names 为空、hidden 为全部），不抛错 ——
 * 交由调用方决定是「报告上下文不足」还是别的处置。
 */
export function visibleToolNames(input: VisibilityInput): ToolVisibility {
  const { priority, budget, measure } = input;
  const best = (trimDynamic: boolean): { k: number; cost: number } => {
    for (let k = priority.length; k >= 0; k--) {
      const cost = measure(priority.slice(0, k), trimDynamic);
      if (cost <= budget) return { k, cost };
    }
    return { k: -1, cost: -1 };
  };
  const noTrim = best(false);
  const withTrim = best(true);
  // 裁动态块只会降开销 ⇒ withTrim.k >= noTrim.k。
  const useTrim = withTrim.k > noTrim.k;
  const chosen = useTrim ? withTrim : noTrim;
  if (chosen.k < 0) {
    return {
      names: [],
      hidden: [...priority],
      total: priority.length,
      trimmed: true,
      fits: false,
      cost: -1,
      budget,
    };
  }
  return {
    names: priority.slice(0, chosen.k),
    hidden: priority.slice(chosen.k),
    total: priority.length,
    trimmed: useTrim,
    fits: true,
    cost: chosen.cost,
    budget,
  };
}

/* ------------------------------------------------------------------ */
/* 开销估算                                                            */
/* ------------------------------------------------------------------ */

/** 「## 工具」节的标题。 */
const TOOL_SECTION = "工具";
/** 技能索引节 / wiki 索引节的标题（动态块三项的前两项）。 */
const SKILL_SECTION = "技能";
const WIKI_SECTION = "记忆库";
/**
 * 环境节里目录树的开头标记（动态块三项的第三项）。
 * 单根是「工作目录结构」；/add-dir 多根是「工作根目录结构」（issue #104）。
 * 后者不是前者的前缀，两套都要认。
 */
const TREE_MARKERS = ["工作根目录结构", "工作目录结构"] as const;

/** 运行时不得从请求里拿掉的最小闭环（issue #104）。dry-run 空集不沿用这条。 */
export const RUNTIME_TOOL_FLOOR: readonly string[] = [
  "read_file",
  "edit_file",
  "shell",
  "shell_output",
];

/** 计数口径：与选档完全一致（src/prompt/tokens.ts）。 */
export type VisibilityCounter = (text: string, specs: readonly ToolSpec[]) => number;

interface ParsedSection {
  title: string;
  body: string;
}

/** 拆出系统提示词的头部与各「## 标题」节；render 反运算必须逐字节还原。 */
function splitSections(systemText: string): { head: string; sections: ParsedSection[] } {
  const parts = systemText.split("\n## ");
  const head = parts[0] ?? "";
  const sections = parts.slice(1).map((p) => {
    const nl = p.indexOf("\n");
    return nl === -1 ? { title: p, body: "" } : { title: p.slice(0, nl), body: p.slice(nl + 1) };
  });
  return { head, sections };
}

/** 与 splitSections 互逆：逐字节还原原文本。 */
function joinSections(head: string, sections: ParsedSection[]): string {
  return head + sections.map((s) => `\n## ${s.title}\n${s.body}`).join("");
}

/**
 * 一行说明归属哪些工具。
 *
 * 规则：行首是「- 」时，取第一个「：」之前的部分作为 head；head 的**首个**词若是
 * 已知工具名，则该行归属这些工具（`- list_dir / glob / grep：…` 归属三个）；
 * 否则归属为空 —— 这类行（例如规划态说明）不与任何工具绑定，始终保留。
 */
function lineOwners(line: string, known: ReadonlySet<string>): string[] {
  if (!line.startsWith("- ")) return [];
  const head = line.slice(2).split("：")[0] ?? "";
  const first = (head.split(/[\s/]+/)[0] ?? "").trim();
  if (!known.has(first)) return [];
  return head
    .split(/[\s/]+/)
    .map((t) => t.trim())
    .filter((t) => known.has(t));
}

/**
 * 合成「给定可见集」的系统提示词（只用于估算开销）。
 *
 * 可见集之外的工具说明行被去掉；可见集内的工具说明行**整行保留**（含
 * `list_dir / glob / grep` 这种合并行：保守估计，宁可高估不可低估）。
 */
function synthesizeToolSection(
  body: string,
  visible: ReadonlySet<string>,
  known: ReadonlySet<string>,
): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let nameLineDone = false;
  for (const line of lines) {
    if (!nameLineDone && line.startsWith("可用工具：")) {
      out.push(`可用工具：${[...visible].join(", ")}`);
      nameLineDone = true;
      continue;
    }
    const owners = lineOwners(line, known);
    // 归属为空 → 与工具无关（规划态说明），始终保留。
    // 归属非空 → 至少有一个可见才保留（合并行整行保留 → 保守）。
    if (owners.length === 0 || owners.some((o) => visible.has(o))) out.push(line);
    else continue;
  }
  return out.join("\n");
}

function isTreeLine(line: string): boolean {
  const t = line.trimStart();
  return TREE_MARKERS.some((m) => t.startsWith(m));
}

/** 仓库地图可能跟在目录树后面、仍留在同一节正文里。裁树必须在它之前停。 */
function isRepoMapLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("## 仓库地图") || t.startsWith("仓库地图（");
}

/**
 * 裁掉目录树，停在仓库地图之前。
 * 标记之前的行（工作目录、额外工作根、模型行）保留。
 * 地图若已经被拆成独立的「## 仓库地图」节，则不在本节正文里，由调用方整节保留。
 */
function trimTree(body: string): string {
  const lines = body.split("\n");
  const at = lines.findIndex(isTreeLine);
  if (at === -1) return body;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && isRepoMapLine(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(0, at).concat(lines.slice(end)).join("\n");
}

export interface MeasureCostInput {
  /** 当前渲染出的完整系统提示词。 */
  systemText: string;
  /** 可见工具的 schema（按请求里的顺序）。 */
  specs: readonly ToolSpec[];
  /** 可见工具名集合。 */
  visible: ReadonlySet<string>;
  /**
   * 全部已注册的工具名 —— 用于判断某一行说明归属哪个工具。
   * 必须给全：隐藏工具的说明行也要能被认出来（否则会被当成「与工具无关」而留下）。
   */
  allToolNames: readonly string[];
  /** 是否裁掉动态块三项。 */
  trimDynamic: boolean;
  /** 计数口径（默认与选档同一套）。 */
  count?: VisibilityCounter;
}

/**
 * 合成「给定可见集与裁剪标志」的系统提示词。
 *
 * 估算与运行时共用这一份，避免 schema 收窄了、说明行却留着，或目录树裁剪两边不一致。
 * 规则：换掉「可用工具：」那行、去掉隐藏工具的说明行、（可选）去掉技能索引 / wiki 索引 / 目录树。
 * 仓库地图、额外工作根、MCP 目录短节、跨会话规则都不在裁剪面里。
 */
export function renderVisibilityText(input: Omit<MeasureCostInput, "count" | "specs">): string {
  const known = new Set(input.allToolNames);
  const { head, sections } = splitSections(input.systemText);
  const out: ParsedSection[] = [];
  for (const s of sections) {
    if (input.trimDynamic && (s.title === SKILL_SECTION || s.title === WIKI_SECTION)) continue;
    if (input.trimDynamic && s.title === "环境") {
      out.push({ title: s.title, body: trimTree(s.body) });
      continue;
    }
    if (s.title === TOOL_SECTION) {
      out.push({ title: s.title, body: synthesizeToolSection(s.body, input.visible, known) });
      continue;
    }
    out.push(s);
  }
  return joinSections(head, out);
}

/**
 * 估算「给定可见集与裁剪标志」的系统提示词 + schema 开销。
 *
 * 正文规则见 `renderVisibilityText`。
 */
export function measureVisibilityCost(input: MeasureCostInput): number {
  const count = input.count ?? ((text, specs) => countSystemTokens([text], specs).tokens);
  const text = renderVisibilityText(input);
  return count(text, input.specs);
}

/**
 * 把 dry-run 前缀抬到运行时硬底线。
 *
 * 底线工具若在候选优先级里，可见集至少覆盖到它们（仍是优先级前缀）。
 * 候选里没有的工具不会凭空加进去。
 */
export function applyRuntimeFloor(priority: readonly string[], names: readonly string[]): string[] {
  const floor = RUNTIME_TOOL_FLOOR.filter((n) => priority.includes(n));
  if (floor.length === 0) return [...names];
  const need = new Set(floor);
  let k = 0;
  for (let i = 0; i < priority.length; i++) {
    const name = priority[i];
    if (name !== undefined && need.has(name)) need.delete(name);
    k = i + 1;
    if (need.size === 0) break;
  }
  if (names.length >= k) return [...names];
  return priority.slice(0, k);
}

export interface RuntimeVisibilityDecision {
  /** false = 选档已落入预算，正文与 schema 都不收窄。 */
  narrowed: boolean;
  text: string;
  /** null = 不按可见集过滤 schema。 */
  toolNames: readonly string[] | null;
  trimmed: boolean;
  /** narrowed 时为收窄后的开销；否则调用方沿用选档自己的估计。 */
  cost: number;
  fits: boolean;
  /** narrowed 时给出实际发出的可见集（applied=true）。 */
  visibility: ToolVisibility | null;
}

function specsForNames(specs: readonly ToolSpec[], names: readonly string[]): ToolSpec[] {
  const allow = new Set(names);
  return specs.filter((s) => allow.has(s.function.name));
}

/**
 * 选档 fits=false 时，决定运行时真正发出的正文和工具名前缀（issue #104）。
 * fits=true 时原样返回，不重排、不裁。
 */
export function decideRuntimeVisibility(input: {
  tierFits: boolean;
  systemText: string;
  specs: readonly ToolSpec[];
  allToolNames: readonly string[];
  budget: number;
  count?: VisibilityCounter;
}): RuntimeVisibilityDecision {
  if (input.tierFits) {
    return {
      narrowed: false,
      text: input.systemText,
      toolNames: null,
      trimmed: false,
      cost: 0,
      fits: true,
      visibility: null,
    };
  }
  const count = input.count ?? ((text, specs) => countSystemTokens([text], specs).tokens);
  const priority = visibilityPriority(input.specs.map((s) => s.function.name));
  const measure = (names: readonly string[], trimDynamic: boolean): number =>
    measureVisibilityCost({
      systemText: input.systemText,
      specs: specsForNames(input.specs, names),
      visible: new Set(names),
      allToolNames: input.allToolNames,
      trimDynamic,
      count,
    });
  const dry = visibleToolNames({ priority, budget: input.budget, measure });
  let names = applyRuntimeFloor(priority, dry.names);
  let trim = dry.trimmed;
  // 硬底线把前缀抬长时，dry-run 的「一样多则不裁」不再覆盖这截前缀。
  // 不裁放得下就留着三项；放不下就裁，即便裁完仍超预算也裁（四个工具配上已裁的动态块）。
  if (names.length > dry.names.length) {
    trim = measure(names, false) > input.budget;
  }
  const specs = specsForNames(input.specs, names);
  const text = renderVisibilityText({
    systemText: input.systemText,
    visible: new Set(names),
    allToolNames: input.allToolNames,
    trimDynamic: trim,
  });
  const cost = count(text, specs);
  const keep = new Set(names);
  const visibility: ToolVisibility = {
    names: [...names],
    hidden: priority.filter((n) => !keep.has(n)),
    total: priority.length,
    trimmed: trim,
    fits: cost <= input.budget,
    cost,
    budget: input.budget,
    applied: true,
  };
  return {
    narrowed: true,
    text,
    toolNames: names,
    trimmed: trim,
    cost,
    fits: visibility.fits,
    visibility,
  };
}