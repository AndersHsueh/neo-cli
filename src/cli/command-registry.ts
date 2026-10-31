/**
 * 斜杠命令注册表。
 *
 * 补全表（input/commands.ts）回答「有哪些名字」。
 * 这里回答「这个名字由哪个函数处理」。
 * 新增命令：先登记补全表，再 registerCommand。漂移守卫会抓住漏的一边。
 *
 * 处理器签名刻意不带 arg/rest：一行文本进、上下文进。
 * 解析留给各命令自己做，避免表和实现各拆一次、拆法还不一致。
 */
import type { CommandContext } from "./commands.ts";

export type CommandHandler = (line: string, ctx: CommandContext) => Promise<void>;

const handlers = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  if (handlers.has(name)) {
    throw new Error(`斜杠命令 /${name} 已注册`);
  }
  handlers.set(name, handler);
}

export function registerCommands(names: readonly string[], handler: CommandHandler): void {
  for (const name of names) registerCommand(name, handler);
}

export function commandHandler(name: string): CommandHandler | undefined {
  return handlers.get(name);
}

/** 已注册的命令名。漂移守卫用它对照补全表，不读源码。 */
export function registeredCommandNames(): string[] {
  return [...handlers.keys()];
}

export function resetCommands(): void {
  handlers.clear();
}
