/**
 * wiki 目录布局解析。
 *
 * 两种布局（与 lint.ts 的 resolveWikiDir 口径一致）：
 *  - neo 项目：<cwd>/.neo/wiki/{raw,wiki,outputs}，主题页在 .neo/wiki/wiki/
 *  - 独立知识库：<cwd>/wiki/，主题页与 raw 同级（wiki/、wiki/raw/）
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export interface WikiLayout {
  /** 主题页目录（INDEX.md / log.md 也在这里）。 */
  pagesDir: string;
  /** raw 源目录。 */
  rawDir: string;
  /** 布局名，用于报错信息。 */
  kind: "neo" | "lib" | "user";
  /**
   * 记忆作用域。project = 当前 cwd 的项目记忆；user = 跨项目的用户记忆。
   * 可选：旧代码（测试/工具）手造的布局对象没有该字段，按 project 处理。
   */
  scope?: "project" | "user";
}

/** 解析项目 wiki 布局；都不是有效布局返回 null。 */
export function resolveWikiLayout(cwd: string): WikiLayout | null {
  const neoPages = join(cwd, ".neo", "wiki", "wiki");
  if (existsSync(neoPages)) {
    return {
      pagesDir: neoPages,
      rawDir: join(cwd, ".neo", "wiki", "raw"),
      kind: "neo",
      scope: "project",
    };
  }
  const libPages = join(cwd, "wiki");
  if (existsSync(libPages)) {
    return {
      pagesDir: libPages,
      rawDir: join(cwd, "wiki", "raw"),
      kind: "lib",
      scope: "project",
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 用户级记忆库（v0.2 记忆激活，§7.5.1）                                  */
/* ------------------------------------------------------------------ */

/**
 * 用户级 wiki 根目录。
 * 默认 ~/.neo/wiki；NEO_USER_WIKI_DIR 可覆盖（测试隔离 + 多机迁移）。
 * 相对路径按进程 cwd 解析成绝对路径。
 */
export function userWikiRoot(): string {
  const env = process.env["NEO_USER_WIKI_DIR"];
  if (env && env.trim()) return resolve(env);
  return join(homedir(), ".neo", "wiki");
}

/**
 * 解析用户级 wiki 布局；目录尚未创建时返回 null（读取路径不报错，写路径走 ensure）。
 * 布局与项目级同构：<root>/wiki 是主题页目录，<root>/raw 是证据目录。
 */
export function resolveUserWikiLayout(root: string = userWikiRoot()): WikiLayout | null {
  const pages = join(root, "wiki");
  if (!existsSync(pages)) return null;
  return { pagesDir: pages, rawDir: join(root, "raw"), kind: "user", scope: "user" };
}

/** 布局是否属于用户级作用域（旧布局无 scope 字段时视为项目级）。 */
export function isUserScope(layout: WikiLayout): boolean {
  return layout.scope === "user" || layout.kind === "user";
}

/**
 * 路径是否位于 raw 目录内（任一布局）。
 * raw 语义：可创建、可删除、删除后可重建同名；不可修改已存在文件的内容。
 */
export function insideRawDir(cwd: string, p: string): boolean {
  for (const raw of [join(cwd, ".neo", "wiki", "raw"), join(cwd, "wiki", "raw")]) {
    const r = relative(raw, p);
    // 越界判定只认 ".." 本身或 "../" 前缀：startsWith("..") 会把同级的
    // "..foo/" 也算成越界，让 raw 护栏漏掉 .neo/wiki/..foo/ 这类兄弟目录。
    if (r !== "" && r !== ".." && !r.startsWith(".." + sep)) return true;
  }
  return false;
}
