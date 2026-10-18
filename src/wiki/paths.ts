/**
 * wiki 目录布局解析。
 *
 * 两种布局（与 lint.ts 的 resolveWikiDir 口径一致）：
 *  - neo 项目：<cwd>/.neo/wiki/{raw,wiki,outputs}，主题页在 .neo/wiki/wiki/
 *  - 独立知识库：<cwd>/wiki/，主题页与 raw 同级（wiki/、wiki/raw/）
 */

import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface WikiLayout {
  /** 主题页目录（INDEX.md / log.md 也在这里）。 */
  pagesDir: string;
  /** raw 源目录。 */
  rawDir: string;
  /** 布局名，用于报错信息。 */
  kind: "neo" | "lib";
}

/** 解析 wiki 布局；都不是有效布局返回 null。 */
export function resolveWikiLayout(cwd: string): WikiLayout | null {
  const neoPages = join(cwd, ".neo", "wiki", "wiki");
  if (existsSync(neoPages)) {
    return { pagesDir: neoPages, rawDir: join(cwd, ".neo", "wiki", "raw"), kind: "neo" };
  }
  const libPages = join(cwd, "wiki");
  if (existsSync(libPages)) {
    return { pagesDir: libPages, rawDir: join(cwd, "wiki", "raw"), kind: "lib" };
  }
  return null;
}

/**
 * 路径是否位于 raw 目录内（任一布局）。
 * raw 语义：可创建、可删除、删除后可重建同名；不可修改已存在文件的内容。
 */
export function insideRawDir(cwd: string, p: string): boolean {
  for (const raw of [join(cwd, ".neo", "wiki", "raw"), join(cwd, "wiki", "raw")]) {
    const r = relative(raw, p);
    if (r !== "" && !r.startsWith("..") && !r.startsWith(sep + "..")) return true;
  }
  return false;
}
