/**
 * MCP 工具适配层（issue #2）。
 *
 * 把一个远端 MCP 工具包成 neo 的 ToolImpl：
 *  - 命名 `mcp__<server>__<tool>`：前缀让用户一眼看出「这是外部工具」，
 *    也让权限/展示/排除表能按前缀统一处理，不必维护白名单。
 *  - `sensitive: true`：MCP 工具做什么我们不知道（可能是写盘、可能是发请求），
 *    因此按非只读对待，走与 write_file / shell 完全相同的审批路径。
 *  - `kind: "capability"`：它扩展「能做什么」而不直接产出关于本仓库的事实，
 *    与 shell 同口径参与「连续扩展手段」的偏离判定。
 *  - 不标 parallelizable：远端 server 是否有状态我们不知道，串行是安全侧。
 *
 * ## 命名合法化（stable-names 轮）
 *
 * 模型侧的 function name 必须满足 `^[a-zA-Z0-9_-]{1,64}$`（OpenAI 兼容网关的硬约束）。
 * 但远端工具名不受我们控制：`files.read`、`a.b/c`、甚至 200 字符的长名都合法。
 * 因此注册名与远端名**解耦**：
 *
 *   注册名 = `mcp__` + 合法化(server) + `__` + 合法化(tool) [+ `__` + 短哈希] [+ `_` + 序号]
 *
 * 三段式，按**信息损失程度**递进（见 nameFor）：
 *
 *  1. **朴素名**：合法化后拼起来 ≤ 64 且无歧义 —— 用朴素名，可读性最好；
 *  2. **注入哈希**：名字超长 / 分界歧义（`__`）/ 合法化折叠（`a.b` vs `a_b`）/
 *     非 ASCII 被清洗 / 截断 —— 在末尾追加 `__<8 位哈希>`，哈希覆盖
 *     `(server, tool)` **原始**字符串，因此不同原名必然不同名；
 *  3. **兜底序号**：哈希本身撞车（概率 ~2^-32）时按候选列表顺序取第一个空闲名。
 *
 * **关键性质：名字只由「本次要注册的全部 (server, tool)」这个集合决定，
 * 与连接顺序、分配顺序无关。** 上一版是「先到先得」（先来者保留朴素名、
 * 后来者升级成哈希），而 connectAll 并行连接，于是同一对 (server, tool)
 * 会因为谁先连上而拿到不同的名字 —— 模型看到的工具名在一次会话里都不稳定，
 * 更别说跨会话。现在改成：先把整个集合算完，再决定谁该带哈希。
 *
 * 为什么「有歧义就全带哈希」而不是「让其中一个带」：只要存在两个不同原名
 * 能拼出同一个朴素名，谁带哈希就是一次任意选择，而任意选择 = 顺序依赖。
 * 让这一组**全部**升级成哈希，选择就消失了，代价只是这一组名字长一点。
 *
 * 调用 `tools/call` 时始终用**远端原始工具名**（`info.name`），注册名只活在本地。
 */
import type { ToolSpec } from "../llm.ts";
import { ToolError, type ToolImpl } from "../tools/types.ts";
import type { McpToolInfo } from "./client.ts";

/** 工具名前缀。权限、展示、/mcp 都按它识别外部工具。 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 模型侧函数名的硬约束（OpenAI 兼容网关）。 */
export const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 注册名长度上限。 */
const MAX_NAME = 64;

/** 哈希后缀长度（8 位十六进制）。 */
const HASH_LEN = 8;

/** 哈希形态下 server 段的长度上限：用户靠它认来源，留个前缀就够。 */
const SERVER_HEAD = 8;

/**
 * 把任意字符串映射成 `[A-Za-z0-9_-]` 片段。
 *
 * 非法字符逐个替换成 `_`（不删除 —— 删除会让 `a.b` 与 `ab` 撞车，
 * 替换后至少保留「这里原来有个分隔符」的信息）。
 *
 * 注意：这个映射**有损**（`a.b` 与 `a_b` 都变成 `a_b`，中文变成一串 `_`），
 * 所以它只用来生成「可读的候选名」，能不能真的用这个名字由 nameFor 判定。
 */
export function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * 稳定短哈希（FNV-1a 32 位 → 8 位十六进制）。
 *
 * 只用于「超长截断」与「碰撞拆开」两种兜底场景，不做安全用途。
 * 选 FNV-1a 是因为实现只有几行、无依赖、同输入同输出。
 */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 乘 16777619，用移位避免 32 位溢出丢精度
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(HASH_LEN, "0");
}

/**
 * 朴素拼名：`mcp__<server>__<tool>`（各段合法化，不截断、不加哈希）。
 *
 * 这是**候选**而不是最终名字：它可能超长，也可能与别的工具撞名。
 * 要拿真正注册用的名字请用 nameFor / computeMcpNames。
 */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
}

/**
 * 该 (server, tool) 的朴素名是否**无信息损失**（可以直接用）。
 *
 * 三个条件缺一不可：
 *  - 长度 ≤ 64（否则要截断，截断即损失）；
 *  - 合法化没有改动任何字符（`a.b` → `a_b` 是损失，`a_b` 原样保留就不是）；
 *  - 两段自身都不含 `__` —— 否则 `mcp__a__b__c` 既可能是 (a__b, c) 也可能是
 *    (a, b__c)，光看名字分不清来源（见 parseMcpToolName 的说明）。
 */
function isLossless(server: string, tool: string): boolean {
  if (sanitizeSegment(server) !== server || sanitizeSegment(tool) !== tool) return false;
  if (server.includes("__") || tool.includes("__")) return false;
  return mcpToolName(server, tool).length <= MAX_NAME;
}

/**
 * 带哈希的拼名（长度预算见下）。
 *
 * 长度预算（硬上限 64）：
 *  - `mcp__`(5) + serverHead(≤8) + `__`(2) + tool + `__`(2) + hash(8) ≤ 64；
 *  - server 段先截到 8 字符，剩余预算全给 tool 段 —— 否则长 server 名会把
 *    tool 段挤成空，两个不同工具撞成同一个名字。
 *
 * 哈希覆盖 `server\0tool` 的**原始**字符串（不是合法化后的），
 * 因此 `a.b` 与 `a_b`、`中文` 与别的中文名，哈希值必然不同。
 */
function hashedName(server: string, tool: string): string {
  const suffix = `__${shortHash(`${server}\u0000${tool}`)}`;
  const room = MAX_NAME - suffix.length;
  const sPart = sanitizeSegment(server).slice(0, SERVER_HEAD);
  const head = `${MCP_TOOL_PREFIX}${sPart}__`;
  const tPart = sanitizeSegment(tool).slice(0, Math.max(1, room - head.length));
  return `${head}${tPart}${suffix}`;
}

/** 兜底形态：哈希名再撞时，截短 3 字符换成 `_<序号>`。 */
function numberedName(hashed: string, i: number): string {
  return `${hashed.slice(0, MAX_NAME - 3)}_${i}`;
}

/**
 * 单个 (server, tool) 的**候选名列表**（按优先级，纯函数）。
 *
 * 一个工具最终用哪个候选，取决于同批次里还有谁 —— 见 computeMcpNames。
 * 单独调用本函数（例如没有其它工具的场景）等价于取第一个候选。
 */
export function nameCandidates(server: string, tool: string): string[] {
  const plain = mcpToolName(server, tool);
  // 无损失 → 朴素名优先（可读性最好）；有损失 → 直接跳到哈希形态，
  // 免得「朴素名恰好没人撞」时出现「有时带哈希、有时不带」的不确定外观。
  const head = isLossless(server, tool) ? [plain] : [];
  const hashed = hashedName(server, tool);
  const out = [...head, hashed];
  for (let i = 2; i < 100; i++) out.push(numberedName(hashed, i));
  return out;
}

/**
 * 单个 (server, tool) 的注册名，不考虑同批次其它工具。
 *
 * 只在「只有一个工具」或「调用方自己保证无碰撞」时使用；
 * 批量注册请用 computeMcpNames（它才处理组内歧义）。
 */
export function nameFor(server: string, tool: string): string {
  return nameCandidates(server, tool)[0]!;
}

/**
 * 一批 (server, tool) → 注册名。**纯函数，结果只取决于集合本身。**
 *
 * 算法（两趟，与输入顺序无关）：
 *  1. 每个工具算出候选列表；朴素名无损失的工具进「朴素组」，
 *     其余（超长 / 折叠 / 非 ASCII / 含 `__`）直接进「哈希组」；
 *  2. 统计每个朴素名被几个工具占用：只有 1 个 → 它用朴素名；
 *     ≥2 个（分界歧义或折叠碰撞）→ **全部**改走哈希，谁都不占朴素名。
 *     这样「谁该让路」这个需要顺序才能回答的问题就不存在了。
 *  3. 哈希组按**排序后的 (server, tool)** 依次取第一个空闲候选
 *     （排序只为让兜底序号可复现；正常情况下哈希互不相同，排序不影响结果）。
 *
 * 返回 Map，键是 `server\0tool`（与调用顺序无关）。
 */
export function computeMcpNames(pairs: Array<{ server: string; tool: string }>): Map<string, string> {
  const keyOf = (p: { server: string; tool: string }): string => `${p.server}\u0000${p.tool}`;
  const uniq = new Map<string, { server: string; tool: string }>();
  for (const p of pairs) uniq.set(keyOf(p), p);

  // 1) 分组 + 统计朴素名占用
  const plainCount = new Map<string, number>();
  const grouped: Array<{ p: { server: string; tool: string }; cands: string[]; plain: boolean }> = [];
  for (const p of uniq.values()) {
    const plain = mcpToolName(p.server, p.tool);
    const lossless = isLossless(p.server, p.tool);
    if (lossless) plainCount.set(plain, (plainCount.get(plain) ?? 0) + 1);
    grouped.push({ p, cands: nameCandidates(p.server, p.tool), plain: lossless });
  }

  // 2) 朴素名唯一者直接定名；其余进哈希组
  const out = new Map<string, string>();
  const taken = new Set<string>();
  const pending: Array<{ p: { server: string; tool: string }; cands: string[] }> = [];
  for (const g of grouped) {
    const plain = mcpToolName(g.p.server, g.p.tool);
    if (g.plain && plainCount.get(plain) === 1) {
      out.set(keyOf(g.p), plain);
      taken.add(plain);
    } else {
      pending.push({ p: g.p, cands: g.cands });
    }
  }

  // 3) 哈希组：按 (server, tool) 排序后依次取第一个空闲候选
  pending.sort((a, b) => (keyOf(a.p) < keyOf(b.p) ? -1 : keyOf(a.p) > keyOf(b.p) ? 1 : 0));
  for (const { p, cands } of pending) {
    const pick = cands.find((c) => !taken.has(c));
    // 100 个候选全被占：只可能发生在病态输入（同一 server 上百个同名工具）。
    // 此时宁可用最后一个候选（会与别人撞名，由注册表重名拒绝 + rejected 兜底），
    // 也不抛错拖垮整个 server 的连接。
    const name = pick ?? cands[cands.length - 1]!;
    out.set(keyOf(p), name);
    taken.add(name);
  }
  return out;
}

/**
 * 名字是否满足模型侧硬约束。
 *
 * 独立成函数而不是到处写正则：注册前要校验、测试要断言、/mcp 要解释，
 * 三处必须同一个口径。
 */
export function isValidToolName(name: string): boolean {
  return MCP_NAME_PATTERN.test(name);
}

/**
 * 从注册名反解 { server, tool }；不是 MCP 工具返回 null。
 *
 * 注意：注册名可能被合法化过（`.` → `_`）或带哈希后缀，因此反解结果**不保证**
 * 等于原始的 server / tool 名。要拿远端原名请用 McpServerState.toolEntries 里的映射。
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const i = rest.indexOf("__");
  if (i <= 0 || i + 2 >= rest.length) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

export function isMcpTool(name: string): boolean {
  return parseMcpToolName(name) !== null;
}

/**
 * 远端 inputSchema → 工具参数 schema。
 *
 * 原样透传（模型才知道真实参数），只在缺失时补一个空 object schema：
 * 部分 server 的 inputSchema 是 undefined，直接塞给模型会让请求体不合法。
 */
function parametersOf(info: McpToolInfo): Record<string, unknown> {
  const s = info.inputSchema;
  if (typeof s === "object" && s !== null && !Array.isArray(s)) {
    return s as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

export interface McpToolDeps {
  server: string;
  info: McpToolInfo;
  /**
   * 本地注册名（模型侧看到的函数名）。缺省 = nameFor(server, info.name)。
   * 批量注册时由 computeMcpNames 统一算好再传进来。
   */
  name?: string;
  /** 执行一次 tools/call，返回给模型看的文本。失败抛错（由本层转成 ToolError）。 */
  call: (toolName: string, args: Record<string, unknown>) => Promise<string>;
}

export function makeMcpTool(deps: McpToolDeps): ToolImpl {
  const { server, info } = deps;
  const name = deps.name ?? nameFor(server, info.name);
  if (!isValidToolName(name)) {
    // 兜底：走到这里说明调用方绕过了命名层。宁可当场报错，也不要把非法名
    // 塞进请求体 —— 那会让整轮 LLM 请求被网关以 400 拒绝，且错误信息与 MCP 无关。
    throw new Error(`MCP 工具注册名 "${name}" 不合法（须匹配 ${MCP_NAME_PATTERN}）`);
  }
  const remoteDesc = info.description?.trim() || `MCP 工具 ${info.name}`;
  // 注册名可能被合法化过（`files.read` → `files_read`）或带哈希后缀，
  // 描述里给出远端原名，否则用户/模型对不上「我看到的工具」和「server 文档里的工具」。
  const renamed = name !== `${MCP_TOOL_PREFIX}${server}__${info.name}`;
  const spec: ToolSpec = {
    type: "function",
    function: {
      name,
      description:
        `[MCP:${server}] ${remoteDesc}` +
        (info.title ? `（${info.title}）` : "") +
        (renamed ? `（远端工具名：${info.name}）` : "") +
        "。外部 MCP 服务提供的工具，调用前需用户批准。",
      parameters: parametersOf(info),
    },
  };

  return {
    sensitive: true,
    kind: "capability",
    spec,
    async execute(args, ctx) {
      // 审批先于任何网络/进程交互：用户拒绝时连请求都不该发出去。
      const detail = `调用 MCP 工具 ${server}/${info.name}（${shortJson(args)}）`;
      const ok = await ctx.approve(name, detail);
      if (!ok) return `用户拒绝了该 MCP 工具调用，未执行。`;
      try {
        // 始终用远端原始工具名调 tools/call —— 注册名只是本地合法化后的别名。
        return await deps.call(info.name, args);
      } catch (e) {
        // 远端错误 → ToolError，dispatch 会转成「错误: ...」交给模型，
        // 主循环照常继续（不 throw 到 agent 层）。
        throw new ToolError((e as Error).message);
      }
    },
  };
}

/** 参数摘要：审批框里要能看清「调了什么」，但不能把整段 JSON 塞进一行。 */
function shortJson(args: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
