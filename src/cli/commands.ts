/**
 * 斜杠命令实现。
 *
 * 每个 case 仍是一条命令的实现。分发走注册表，新增命令不用再改入口的 switch。
 * 命令名必须同时出现在 input/commands.ts，漂移守卫会对照两边。
 */
import { readFileSync } from "node:fs";

import {
  buildSkillSlashPrompt,
  describeSource,
  discoverSkills,
  isValidSkillName,
  tryLoadSkillForSlash,
} from "../skills.ts";
import { commandHandler, registerCommand } from "./command-registry.ts";
import { mcpPromptShadowNotice, tryDispatchMcpPrompt } from "./mcpPromptCommand.ts";

import type { CommandContext } from "./commandContext.ts";
export type { CommandContext } from "./commandContext.ts";
import { handleSessionCommands } from "./commandSession.ts";
import { handleSystemCommands } from "./commandSystem.ts";
import { handleWorkspaceCommands } from "./commandWorkspace.ts";
import { handleAddDirCommand } from "./additionalDirs.ts";

export async function handleCommand(line: string, ctx: CommandContext): Promise<void> {
  const [cmdRaw, ...rest] = line.slice(1).split(/\s+/);
  const cmd = (cmdRaw ?? "").toLowerCase();
  const arg = rest.join(" ").trim();
  switch (cmd) {
    // issue #63：本会话额外工作根（实现在 additionalDirs.ts，命令组文件已接近行数上限）。
    case "add-dir":
      await handleAddDirCommand(line.slice(1 + (cmdRaw ?? "").length).trim(), ctx);
      return;
  }
  if (await handleSessionCommands(cmd, arg, rest, ctx)) return;
  if (await handleSystemCommands(cmd, arg, rest, ctx)) return;
  if (await handleWorkspaceCommands(cmd, arg, rest, ctx)) return;
  ctx.ui.warn(`未知命令 /${cmd}。用 /help 查看全部命令。`);
}

/**
 * 把本文件实现的命令登记进注册表。
 *
 * 名字从 switch 的顶层 case 现取，不手抄第二份清单。
 * 每个名字都指向同一个 handleCommand：新增 case 即自动可分发，
 * 不必再在入口写一遍 switch。重复调用是幂等的。
 */
let wired = false;

export function wireCommands(): void {
  if (wired) return;
  wired = true;
  for (const name of implementedCommandNames()) {
    registerCommand(name, handleCommand);
  }
}

export async function dispatchCommand(line: string, ctx: CommandContext): Promise<void> {
  wireCommands();
  const [nameRaw, ...rest] = line.slice(1).split(/\s+/);
  const name = (nameRaw ?? "").toLowerCase();
  const args = rest.join(" ").trim();
  const handler = commandHandler(name);

  if (handler) {
    // 内置优先（issue #13 验收 3）：同名技能被遮挡时必须说一句，
    // 否则用户会以为技能正文已经加载了，而模型那边什么也没收到。
    if (isValidSkillName(name) && discoverSkills(ctx.cfg).some((s) => s.name === name)) {
      ctx.ui.info(
        `/${name} 是内置命令，同名技能未触发；要用这个技能请改名，或让模型 use_skill 加载。`,
      );
    }
    const mcpNotice = mcpPromptShadowNotice(name, ctx.cfg.safeMode ? [] : (ctx.mcpPrompts?.() ?? []));
    if (mcpNotice) ctx.ui.info(mcpNotice);
    await handler(line, ctx);
    return;
  }

  // 未命中内置命令 → 尝试当作技能名（技能是动态发现的，不登记进补全表）
  if (!isValidSkillName(name)) {
    if (await tryDispatchMcpPrompt(line, ctx)) return;
    ctx.ui.warn(`未知命令 /${name}。用 /help 查看全部命令。`);
    return;
  }

  const loaded = tryLoadSkillForSlash(ctx.cfg, name);
  if (!loaded.ok) {
    if (await tryDispatchMcpPrompt(line, ctx)) return;
    const avail = loaded.available.length > 0 ? `\n可用技能：${loaded.available.join(", ")}` : "";
    ctx.ui.warn(`未知命令 /${name}：无此技能。${loaded.message}${avail}`);
    ctx.ui.info("用 /help 查看内置命令，/skills 列出全部技能。");
    return;
  }

  const mcpNotice = mcpPromptShadowNotice(name, ctx.cfg.safeMode ? [] : (ctx.mcpPrompts?.() ?? []));
  if (mcpNotice) ctx.ui.info(mcpNotice);

  if (!ctx.enqueueUserTurn) {
    // 单次模式（-p）等没有主循环队列的入口：明确告知，不静默吞掉
    ctx.ui.warn(`当前模式无法通过 /${name} 启动一轮，请让模型 use_skill 加载。`);
    return;
  }

  const text = buildSkillSlashPrompt({
    name: loaded.meta.name,
    body: loaded.body,
    args,
    files: loaded.files,
    sourceLine: describeSource(ctx.cfg, loaded.meta, loaded.createdLink),
  });
  ctx.enqueueUserTurn(text);
  ctx.ui.success(`已调用技能 ${loaded.meta.name}${args ? `（参数：${args}）` : ""}，下一轮发送给模型。`);
  ctx.ui.info(`${describeSource(ctx.cfg, loaded.meta, loaded.createdLink)} · ${loaded.meta.absPath}`);
}

/** 顶层 case 名。嵌套 switch（/memory）缩进更深，不会被算进来。 */
export function implementedCommandNames(source?: string): string[] {
  const text = source ?? [
    readFileSync(new URL("./commands.ts", import.meta.url), "utf8"),
    readFileSync(new URL("./commandSession.ts", import.meta.url), "utf8"),
    readFileSync(new URL("./commandSystem.ts", import.meta.url), "utf8"),
    readFileSync(new URL("./commandWorkspace.ts", import.meta.url), "utf8"),
  ].join("\n");
  // 各命令组文件没有 handleCommand，整份源码扫描 4 空格顶层 case。
  return [...text.matchAll(/^ {4}case "([^"]+)":/gm)].map((m) => m[1]!);
}
