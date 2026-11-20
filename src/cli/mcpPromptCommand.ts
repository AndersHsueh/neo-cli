/**
 * MCP prompts 斜杠分发（issue #67）。
 *
 * 菜单限定名一律 `/<server>:<prompt>`（不要用 mcp__ 风格）。
 * 分发优先级在 commands.ts 里保证：内置 > 本地技能 > MCP prompt。
 */
import { formatMcpPromptResult, type McpPromptInfo } from "../mcp/catalog.ts";
import type { CommandContext } from "./commandContext.ts";

export type McpPromptEntry = McpPromptInfo & { server: string };

function promptList(ctx: CommandContext): McpPromptEntry[] {
  if (ctx.cfg.safeMode) return [];
  return ctx.mcpPrompts?.() ?? [];
}

function norm(s: string): string {
  return s.toLowerCase();
}

export function matchingMcpPrompts(name: string, prompts: McpPromptEntry[]): McpPromptEntry[] {
  const colon = name.indexOf(":");
  if (colon > 0) {
    const server = name.slice(0, colon);
    const prompt = name.slice(colon + 1);
    if (!prompt) return [];
    return prompts.filter(
      (p) => norm(p.server) === norm(server) && norm(p.name) === norm(prompt),
    );
  }
  return prompts.filter((p) => norm(p.name) === norm(name));
}

/** 内置或技能抢走 `/name` 时，指出未触发的限定名。 */
export function mcpPromptShadowNotice(name: string, prompts: McpPromptEntry[]): string | null {
  const hits = matchingMcpPrompts(name, prompts);
  if (hits.length === 0) return null;
  const names = hits.map((p) => `/${p.server}:${p.name}`).join("、");
  return `/${name} 未触发 MCP 提示词；要用这个提示词请输入 ${names}。`;
}

function isTTY(ctx: CommandContext): boolean {
  return ctx.selectDeps.isTTY ?? process.stdin.isTTY === true;
}

/**
 * 尝试把一行当成 MCP prompt 处理。
 * 返回 true = 已处理（成功入队、或已给出错误/歧义提示），调用方不要再当未知命令。
 * 返回 false = 与 MCP prompt 无关，走后续未知命令路径。
 */
export async function tryDispatchMcpPrompt(line: string, ctx: CommandContext): Promise<boolean> {
  const [nameRaw, ...rest] = line.slice(1).split(/\s+/);
  const name = (nameRaw ?? "").trim();
  const argsText = rest.join(" ").trim();
  if (!name) return false;
  const prompts = promptList(ctx);
  if (prompts.length === 0) return false;

  const hits = matchingMcpPrompts(name, prompts);
  if (hits.length === 0) {
    // 限定名对上了 server 但 prompt 不存在：给明确错误。
    const colon = name.indexOf(":");
    if (colon > 0) {
      const serverPart = name.slice(0, colon);
      const promptPart = name.slice(colon + 1);
      const server = prompts.find((p) => norm(p.server) === norm(serverPart))?.server;
      if (server && promptPart) {
        ctx.ui.warn(`MCP server "${server}" 没有提示词 ${promptPart}。`);
        return true;
      }
    }
    return false;
  }
  if (hits.length > 1) {
    const names = hits.map((p) => `/${p.server}:${p.name}`).join("、");
    ctx.ui.warn(`MCP 提示词 ${name} 有多个：${names}。请使用限定名，不要猜测。`);
    return true;
  }
  const prompt = hits[0]!;
  return await runMcpPrompt(prompt, argsText, ctx);
}

export async function resolveMcpPromptLine(
  line: string,
  ctx: CommandContext,
): Promise<{ handled: false } | { handled: true; ok: true; text: string } | { handled: true; ok: false; error: string }> {
  const [nameRaw, ...rest] = line.slice(1).split(/\s+/);
  const name = (nameRaw ?? "").trim();
  const argsText = rest.join(" ").trim();
  if (!name) return { handled: false };
  const prompts = promptList(ctx);
  if (prompts.length === 0) return { handled: false };
  const hits = matchingMcpPrompts(name, prompts);
  if (hits.length === 0) return { handled: false };
  if (hits.length > 1) {
    const names = hits.map((p) => `/${p.server}:${p.name}`).join("、");
    return { handled: true, ok: false, error: `MCP 提示词 ${name} 有多个：${names}。请使用限定名，不要猜测。` };
  }
  const built = await buildMcpPromptText(hits[0]!, argsText, ctx);
  if (!built.ok) return { handled: true, ok: false, error: built.error };
  return { handled: true, ok: true, text: built.text };
}

async function runMcpPrompt(prompt: McpPromptEntry, argsText: string, ctx: CommandContext): Promise<boolean> {
  const built = await buildMcpPromptText(prompt, argsText, ctx);
  if (!built.ok) {
    ctx.ui.warn(built.error);
    return true;
  }
  if (!ctx.enqueueUserTurn) {
    ctx.ui.warn(`当前模式无法通过 /${prompt.server}:${prompt.name} 启动一轮。`);
    return true;
  }
  ctx.enqueueUserTurn(built.text);
  ctx.ui.success(`已调用 MCP 提示词 /${prompt.server}:${prompt.name}，下一轮发送给模型。`);
  return true;
}

async function buildMcpPromptText(
  prompt: McpPromptEntry,
  argsText: string,
  ctx: CommandContext,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const bound = await collectPromptArgs(prompt, argsText, ctx);
  if (!bound.ok) return bound;
  if (!ctx.mcpGetPrompt) {
    return { ok: false, error: `当前进程无法调用 MCP 提示词 /${prompt.server}:${prompt.name}。` };
  }
  try {
    const result = await ctx.mcpGetPrompt(prompt.server, prompt.name, bound.args);
    const text = formatMcpPromptResult(prompt.server, prompt.name, result);
    if (!text) return { ok: false, error: `MCP 提示词 /${prompt.server}:${prompt.name} 返回空内容，未发送。` };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: `MCP 提示词 /${prompt.server}:${prompt.name} 失败：${(e as Error).message}` };
  }
}

async function collectPromptArgs(
  prompt: McpPromptEntry,
  argsText: string,
  ctx: CommandContext,
): Promise<{ ok: true; args: Record<string, string> } | { ok: false; error: string }> {
  const defs = prompt.arguments ?? [];
  const tokens = argsText === "" ? [] : argsText.split(/\s+/);
  const args: Record<string, string> = {};
  let i = 0;
  for (const def of defs) {
    if (i < tokens.length) {
      args[def.name] = tokens[i]!;
      i += 1;
    }
  }
  // 多余 token 忽略（按定义顺序一一对应）。
  const missing = defs.filter((d) => d.required && args[d.name] === undefined);
  if (missing.length === 0) return { ok: true, args };

  if (!isTTY(ctx) || !ctx.selectDeps.asker) {
    const listed = defs
      .map((d) => `${d.name}${d.required ? "（必填）" : "（可选）"}${d.description ? `：${d.description}` : ""}`)
      .join("、");
    return {
      ok: false,
      error: `MCP 提示词 /${prompt.server}:${prompt.name} 缺少必填参数：${missing.map((m) => m.name).join("、")}。参数：${listed}`,
    };
  }

  for (const def of missing) {
    const hint = def.description ? `${def.name}（${def.description}）` : def.name;
    const answer = (await ctx.selectDeps.asker(`MCP 提示词参数 ${hint}`)).trim();
    if (!answer) {
      return { ok: false, error: `MCP 提示词 /${prompt.server}:${prompt.name} 缺少必填参数 ${def.name}，已取消。` };
    }
    args[def.name] = answer;
  }
  return { ok: true, args };
}
