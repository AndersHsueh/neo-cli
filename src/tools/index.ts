/**
 * 工具集：文件系统 + 检索 + shell + 网络。
 *
 * 约定：
 *  - 每个工具实现 ToolImpl，execute 返回字符串（给模型看的文本）或抛 ToolError。
 *  - 结果统一在 dispatch() 中按配置截断，避免撑爆上下文。
 *  - write_file / edit_file / shell 默认需要用户批准，由上层注入 approver。
 *
 * 各工具实现按职责拆到同目录模块；本文件保留注册表、dispatch 与既有导出路径。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolSpec } from "../llm.ts";
import type { Config } from "../config.ts";
import { ToolError, gateTool, isNotExecuted, type ToolCtx, type ToolImpl, type ToolKind, type DispatchResult } from "./types.ts";
import { webSearchTool } from "./webSearch.ts";
import { submitPlanTool, exitPlanModeTool } from "./plan.ts";
import { toolTmpDir } from "../runtimeTmp.ts";
import { compactCtx } from "./compactCtx.ts";
import { toolSearchTool } from "../mcp/toolSearchTool.ts";
import { grepTool } from "./grep.ts";
import { globTool } from "./glob.ts";
import { listDir } from "./listDir.ts";
import { lspTool } from "./lspTool.ts";
import { readFile } from "./readFile.ts";
import { shell, shellOutput } from "./shellTool.ts";
import { useSkill } from "./useSkill.ts";
import { webFetch } from "./webFetch.ts";
import { editFile, writeFileTool } from "./writeFile.ts";
import { runJsTool } from "./codeMode.ts";

// 基础类型与注册表在 ./types.ts（叶子模块，解开 task → agent → tools 循环依赖）。
// 这里 re-export 保持既有导入路径不变。
export { ToolError, gateTool, isNotExecuted, notExecuted } from "./types.ts";
export type { ToolCtx, ToolImpl, ToolKind, DispatchResult } from "./types.ts";
export { globToRegExp } from "./glob.ts";
export { rewriteSearchUrl, extractTitle, htmlToText } from "./webFetch.ts";
export { shortArgs, abs as resolvePath, insideCwd } from "./fsPaths.ts";

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
  shellOutput,
  lspTool,
  webFetch,
  webSearchTool,
  useSkill,
  compactCtx,
  // MCP 工具按需发现（issue #68）：注册但只在延迟加载启用时进入工具清单，
  // 见 Agent.toolSpecsFor() 与 src/mcp/toolSearch.ts 的 toolSearchEnabled。
  toolSearchTool,
  // 实验性 Code Mode（issue #71）：默认关闭，只在交互 TUI + 开关打开时进入工具清单，
  // 见 agent/loop.ts 的 toolSpecsFor 与 tools/codeMode.ts 的 codeModeExposed。
  // 必须放在规划态控制工具之前：core 测试锁死 submit_plan / exit_plan_mode 在注册表尾部。
  runJsTool,
  // 规划态控制工具（issue #14）：注册但只在规划态进入工具清单，
  // 见 agent/plan-mode.ts 的 PLAN_CONTROL_TOOLS 与 Agent.toolSpecsFor()。
  submitPlanTool,
  exitPlanModeTool,
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
 * 该工具能否与同批次相邻工具并行执行（issue #11）。
 *
 * 唯一判据是注册表上的 `parallelizable` 标记，**不**从 sensitive/kind 推断：
 *  - use_skill / compact_ctx 都是 sensitive:false，但一个会建软链、一个改宿主状态；
 *  - 将来新增的只读工具也该显式声明，而不是靠「恰好不敏感」被卷进并行。
 * 未注册（模型幻觉出来的工具名）→ false，走串行路径，由 dispatch 报「未知工具」。
 */
export function isParallelizable(name: string): boolean {
  return registry.get(name)?.parallelizable === true;
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
  "todo_write",
  // 规划态控制工具：子代理不在规划态，调用只会报错。
  "submit_plan",
  "exit_plan_mode",
];

/**
 * LSP 是否面向模型/用户可见（#52）。
 *
 * 未传 cfg 时表示「注册表原始视图」，仅供已有内部调用和测试检视；生产路径必须传 cfg。
 * 显式 `enabled:true` 才可见，缺省或显式 false 都隐藏。
 */
export function lspVisible(cfg?: Config): boolean {
  return cfg === undefined || cfg.lsp?.enabled === true;
}

/** 按配置过滤后的工具 schema；cfg 缺省返回注册表原始集合。 */
export function toolSpecs(cfg?: Config): ToolSpec[] {
  return TOOLS
    .filter((t) => lspVisible(cfg) || t.spec.function.name !== "lsp")
    .map((t) => t.spec);
}

/** 按配置过滤后的工具名；cfg 缺省返回注册表原始集合。 */
export function toolNames(cfg?: Config): string[] {
  return TOOLS
    .filter((t) => lspVisible(cfg) || t.spec.function.name !== "lsp")
    .map((t) => t.spec.function.name);
}

/**
 * 主代理默认可见的工具名（issue #14）。
 *
 * 规划态控制工具（submit_plan / exit_plan_mode）只在规划态进入工具清单，
 * 但它们在注册表里是常驻的 —— 系统提示与 banner 用它，避免把两个
 * 平时调不通的工具名教给模型。
 *
 * issue #68：`tool_search` 同理 —— 它只在启用 MCP 延迟加载时进入清单，
 * 平时列出来只会让模型去搜一个没有目录的工具。
 */
export function mainToolNames(cfg?: Config): string[] {
  return toolNames(cfg).filter(
    (n) => !PLAN_ONLY_TOOL_NAMES.includes(n) && !CONDITIONAL_TOOL_NAMES.includes(n),
  );
}

/** 只在规划态可见的工具（与 agent/plan-mode.ts 的 PLAN_CONTROL_TOOLS 同口径）。 */
export const PLAN_ONLY_TOOL_NAMES: readonly string[] = ["submit_plan", "exit_plan_mode"];

/**
 * 只在特定条件下可见的工具（issue #68）：`tool_search` 只在 MCP 延迟加载启用时出现。
 * 与 PLAN_ONLY_TOOL_NAMES 分开：它们的可见条件不同，混在一起会让两边都说不清。
 *
 * issue #71：`run_js` 同理 —— 只在交互 TUI 且实验开关打开时进入清单。
 * 注意：**光加进这里不够**，`/tools` 与提示词「可用工具」行要单独处理
 * （mainToolNames 会把它滤掉，见 cli/commandSystem.ts 与 system-prompt.ts）。
 */
export const CONDITIONAL_TOOL_NAMES: readonly string[] = ["tool_search", "run_js"];

/**
 * 工具调用闸门（issue #53；#84 复用）。
 *
 * 名单外/禁用返回拒绝文案（以「未知工具: <name>」开头），否则 null。
 * 只在调用方显式给了策略时才拦 —— 不传 allow/deny 等于不设闸门（旧行为）。
 * 文案刻意与「工具不存在」同前缀：模型对「未知工具」的处理是换工具，
 * 而不是反复重试同一个被禁用的调用。
 */
export function toolCallRejection(
  name: string,
  policy: { allow?: readonly string[]; deny?: readonly string[] },
): string | null {
  if (policy.allow && !policy.allow.includes(name)) {
    return `未知工具: ${name}。当前任务只允许: ${policy.allow.join(", ")}`;
  }
  if (policy.deny && policy.deny.includes(name)) {
    return `未知工具: ${name}。该工具在当前任务中被禁用`;
  }
  return null;
}

export async function dispatch(
  name: string,
  rawArgs: string,
  ctx: ToolCtx,
): Promise<DispatchResult> {
  // 逐次白名单（issue #53）：schema 层已收窄，这里再挡一次 ——
  // 模型仍可能凭历史记忆调出名单外的工具，dispatch 不校验就等于白名单只写在提示里。
  if (ctx.toolAllowlist) {
    const rejected = toolCallRejection(name, { allow: ctx.toolAllowlist });
    if (rejected !== null) {
      return { ok: false, output: rejected, truncated: false, executed: false };
    }
  }
  const impl = registry.get(name);
  if (!impl) {
    return {
      ok: false,
      output: `未知工具: ${name}。可用工具: ${toolNames(ctx.cfg).join(", ")}`,
      truncated: false,
      executed: false,
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
      executed: false,
    };
  }

  try {
    ctx.signal?.throwIfAborted();
    // PreToolUse（issue #3）的调用点分两类，顺序都必须是「审批在前、hook 在后」：
    //  - 无审批的工具（read_file / glob / MCP 之外的只读工具）：在这里统一 gate，
    //    detail 省略 = 不审批，只跑 hook；
    //  - 带审批的工具（write_file / edit_file / shell / MCP 工具）：它们自己算 detail，
    //    在实现里调 gateTool(ctx, name, args, detail)，所以这里跳过。
    // 判据用 registry 上的 sensitive 标记：它正是「该工具要不要审批」的声明。
    if (!impl.sensitive) {
      const blocked = await gateTool(ctx, name, args);
      // 没执行 → 直接返回，不跑 PostToolUse（Post 的语义是「执行完了」）。
      // executed:false 让主循环的连续失败计数对这次调用保持中性。
      if (blocked !== null) return { ok: false, output: blocked, truncated: false, executed: false };
    }
    const out = await impl.execute(args, ctx);
    const limited = limitOutput(out, ctx.cfg.toolOutputLimit, ctx);
    // PostToolUse：工具已执行完成（成功）。hook 不能改结果，只能追加诊断
    // （onFailure=block 时返回原因 → 追加并把结果标记为出错，让模型看见）。
    return await applyPostHook(ctx, name, args, limited);
  } catch (e) {
    if (e instanceof ToolError) {
      // ToolError 有两种来源，PostToolUse 的待遇必须分开（issue #3 收口）：
      //  - **工具执行中失败**（远端报错、old_string 找不到…）：工具确实跑过，
      //    Post 照旧触发，载荷 ok:false；
      //  - **没执行**（用户拒绝 / plan 拒绝 / Pre 阻断，经 notExecuted 抛出）：
      //    工具一行都没跑，Post 绝不能触发 —— 否则 hook 会收到一次「从未发生的
      //    调用」，还会被当成 ok:true 的成功执行。
      // 判据是 notExecuted 打的标记，而不是文案匹配。
      if (isNotExecuted(e)) {
        // executed:false —— 工具一行都没跑，主循环的连续失败计数对它保持中性。
        return { ok: false, output: `错误: ${e.message}`, truncated: false, executed: false };
      }
      return await applyPostHook(ctx, name, args, { ok: false, output: `错误: ${e.message}`, truncated: false });
    }
    const err = e as Error;
    if (err.name === "AbortError") throw err;
    return await applyPostHook(ctx, name, args, { ok: false, output: `工具执行失败: ${err.message}`, truncated: false });
  }
}

/**
 * 跑 PostToolUse 并把它的诊断并进工具结果（issue #3）。
 *
 * onFailure=block 的语义（工具已执行、无法撤销）：hook 失败原因以
 * `[hook PostToolUse failed: ...]` 追加到 tool 结果末尾，并把结果标记为 ok:false，
 * 让模型看到并据此处理；continue 只给用户诊断（由宿主打日志），结果原样返回。
 */
async function applyPostHook(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
  result: DispatchResult,
): Promise<DispatchResult> {
  if (!ctx.postToolUse) return result;
  let diag: string | null = null;
  try {
    diag = await ctx.postToolUse(name, args, result);
  } catch (e) {
    // hook 层已收敛异常，这里只是最后一道保险：绝不让 hook 拖垮工具结果。
    diag = `[hook PostToolUse failed: ${(e as Error).message}]`;
  }
  if (diag === null || diag === "") return result;
  return { ok: false, output: `${result.output}\n\n${diag}`, truncated: result.truncated, executed: result.executed };
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
