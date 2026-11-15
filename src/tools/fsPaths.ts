/**
 * 工具路径守卫与共用上限：绝对路径、cwd 约束、技能库/raw 不可写、参数摘要。
 */
import { existsSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { insideGlobalSkills } from "../skills.ts";
import { insideRawDir } from "../wiki/paths.ts";
import { ToolError, type ToolCtx } from "./types.ts";

export function abs(ctx: ToolCtx, p: string): string {
  if (!p || typeof p !== "string") throw new ToolError("缺少 path 参数");
  return resolve(ctx.cfg.cwd, p);
}
export function insideCwd(ctx: ToolCtx, p: string): boolean {
  const r = relative(ctx.cfg.cwd, p);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep + ".."));
}

export function requireFile(p: string): string {
  if (!existsSync(p)) throw new ToolError(`文件不存在: ${p}`);
  const st = statSync(p);
  if (!st.isFile()) throw new ToolError(`不是文件: ${p}`);
  return p;
}

export function requireDir(p: string): string {
  if (!existsSync(p)) throw new ToolError(`目录不存在: ${p}`);
  const st = statSync(p);
  if (!st.isDirectory()) throw new ToolError(`不是目录: ${p}`);
  return p;
}

export const MAX_READ = 2_000_000;

/** grep 单文件大小上限：目录扫描与单文件分支共用同一阈值，超限必须明说跳过。 */
export const MAX_GREP_FILE = 3_000_000;

/**
 * 写工具守卫：禁止经软链穿透写入全局技能库（技能是只读资源）。
 *
 * 必须在 ctx.approve() 之前调用 —— 放之后会先弹审批框再拒绝，用户白点一次。
 */
export function assertNotGlobalSkills(ctx: ToolCtx, path: string): void {
  if (!insideGlobalSkills(ctx.cfg, path)) return;
  throw new ToolError(
    `禁止写入全局技能库。技能是只读资源，` +
      `如需修改，请直接用编辑器打开该技能目录下的 SKILL.md。`,
  );
}

/**
 * raw 不可改守卫：raw/ 下的**已存在文件**禁止修改内容。
 *
 * 语义（wiki-turnning-1018.md）：raw 可创建、可删除（shell rm）、删除后可重建同名；
 * 唯独不许改已存在文件的内容。发现源有问题，在对应 wiki 主题页加「> 待澄清:」注记。
 * 仅拦工具路径，不防 shell 绕过 —— 方案已明确：护栏只防 agent 手滑，不防人有意为之。
 *
 * 必须在 ctx.approve() 之前调用 —— 先拒绝，不让用户为注定失败的操作白点一次审批。
 */
export function assertRawImmutable(ctx: ToolCtx, path: string): void {
  if (!insideRawDir(ctx.cfg.cwd, path)) return;
  if (existsSync(path)) {
    throw new ToolError(
      `raw 源不可修改：${path} 已存在。raw 可创建/删除，但已存在文件的内容不许改；` +
        `发现问题请在对应 wiki 主题页加「> 待澄清:」注记。`,
    );
  }
}

export function shortArgs(args: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((k) => {
      const v = args[k];
      if (v === undefined) return "";
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 60 ? s.slice(0, 60) + "…" : s}`;
    })
    .filter(Boolean)
    .join(" ");
}
