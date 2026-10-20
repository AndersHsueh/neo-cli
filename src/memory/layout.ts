/**
 * layout.ts — 记忆双作用域布局（v0.2 记忆激活，规格 docs/001-memory-system-design[done].md §7.5）。
 *
 * 两个作用域：
 *  - project：<cwd>/.neo/wiki/，跟仓库走，进 git；
 *  - user   ：~/.neo/wiki/，跨项目、本机共享，不进 git。
 *
 * 两者目录同构（raw/ wiki/ outputs/），因此写入、检索、lint 全部复用 src/wiki/。
 * 本模块只负责：解析、懒创建骨架、路径包含校验。
 */
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WikiLayout } from "../wiki/paths.ts";
import { resolveUserWikiLayout, resolveWikiLayout, userWikiRoot } from "../wiki/paths.ts";
import { todayStamp, writeAtomic } from "../wiki/write.ts";
import { MemoryError } from "./types.ts";

export type MemoryScope = "project" | "user";

/* ------------------------------------------------------------------ */
/* 根目录                                                              */
/* ------------------------------------------------------------------ */

/** 项目级记忆库根目录（与 wiki 布局一致）。 */
export function projectWikiRoot(cwd: string): string {
  return join(cwd, ".neo", "wiki");
}

/** 某作用域的根目录（不保证已创建）。userRoot 覆盖默认 ~/.neo/wiki（来自 cfg.memory.userWikiDir）。 */
export function scopeRoot(scope: MemoryScope, cwd: string, userRoot?: string): string {
  return scope === "user" ? (userRoot ?? userWikiRoot()) : projectWikiRoot(cwd);
}

/** 某作用域的锁目录（同进程/跨进程写串行化用）。 */
export function scopeLockDir(scope: MemoryScope, cwd: string, userRoot?: string): string {
  return join(scopeRoot(scope, cwd, userRoot), ".locks", `${scope}.lock`);
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/** 只读解析：已存在则返回布局，不存在返回 null（读路径不建目录）。 */
export function resolveScopeLayout(
  scope: MemoryScope,
  cwd: string,
  userRoot?: string,
): WikiLayout | null {
  if (scope === "user") return resolveUserWikiLayout(userRoot);
  return resolveWikiLayout(cwd);
}

/** 读路径用：两库都可能不存在，返回 null 表示该作用域不可用。 */
export function resolveBothLayouts(
  cwd: string,
  userRoot?: string,
): {
  project: WikiLayout | null;
  user: WikiLayout | null;
} {
  return {
    project: resolveScopeLayout("project", cwd),
    user: resolveScopeLayout("user", cwd, userRoot),
  };
}

/* ------------------------------------------------------------------ */
/* 懒创建骨架                                                          */
/* ------------------------------------------------------------------ */

/**
 * 确保某作用域可用（写路径用）。已存在则原样返回，不覆盖任何文件。
 * project 的 INDEX/log 缺失时补最小骨架（不写 AGENTS.md —— 那是 /init 的职责）。
 */
export function ensureScopeLayout(
  scope: MemoryScope,
  cwd: string,
  userRoot?: string,
): WikiLayout {
  const root = scopeRoot(scope, cwd, userRoot);
  const pagesDir = join(root, "wiki");
  const rawDir = join(root, "raw");
  for (const dir of [pagesDir, rawDir, join(root, "outputs")]) {
    mkdirSync(dir, { recursive: true });
  }

  const indexPath = join(pagesDir, "INDEX.md");
  if (!existsSync(indexPath)) {
    writeAtomic(indexPath, scope === "user" ? userIndexTemplate() : projectIndexTemplate());
  }
  const logPath = join(pagesDir, "log.md");
  if (!existsSync(logPath)) {
    writeAtomic(logPath, logTemplate(scope));
  }
  if (scope === "user") {
    const schemaPath = join(pagesDir, "AGENTS.md");
    if (!existsSync(schemaPath)) writeAtomic(schemaPath, userSchemaTemplate());
  }

  return { pagesDir, rawDir, kind: scope === "user" ? "user" : "neo", scope };
}

/* ------------------------------------------------------------------ */
/* 路径安全                                                            */
/* ------------------------------------------------------------------ */

/** target 是否位于 root 内（解析符号链接前的字符串级判定，写路径另做 realpath 校验）。 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep + "..");
}

/** 断言写目标落在布局内；越界抛 MemoryError（防自动写入被构造路径带出库外）。 */
export function assertInsideLayout(layout: WikiLayout, target: string): void {
  const root = resolve(layout.pagesDir, "..");
  if (!isInside(root, target)) {
    throw new MemoryError("schema_invalid", `写入目标越界：${target} 不在 ${root} 内`);
  }
}

/* ------------------------------------------------------------------ */
/* 模板                                                                */
/* ------------------------------------------------------------------ */

function userIndexTemplate(): string {
  return `# 用户记忆 — 索引

> 跨项目个人记忆库（neo 自动维护，本机私有，不进 git）。
> 记录「关于你这个人」的稳定事实与偏好；项目内部细节不放这里。
> 最后更新:${todayStamp()}

## 📌 一句话定位

跨项目复用：身份/角色、沟通与代码偏好、环境、经验方法论。
推断内容单独分区并带 \`[推断]\` 标记，未经确认前只作背景。

## 🧭 当前状态

<!-- 由 neo 自动同步：已收录页面数、最近更新、待确认推断数。 -->

## 🗂 主题目录

| 主题 | 页面 | 一句话摘要 | 元数据 |
|------|------|-----------|--------|

## 🛠 维护约定

- 页面由 \`remember\` / 自动归纳写入，也可人工编辑
- 事实与推断分区：\`## 事实（用户明确表达）\` / \`## 推断（待确认）\`
- 推断条目格式：\`- （推断 YYYY-MM-DD · 置信 0.x · session xxx）内容\`
- 敏感类别（健康/政治/宗教/财务等）禁止推断
`;
}

function projectIndexTemplate(): string {
  return `# 项目记忆 — 索引

> 由 neo 自动创建（记忆激活）。项目级记忆：决策/踩坑/架构/进度/待澄清。
> 最后更新:${todayStamp()}

## 🧭 当前状态

<!-- 由 neo 自动同步 -->

## 🗂 主题目录

| 主题 | 页面 | 一句话摘要 | 元数据 |
|------|------|-----------|--------|

## 🛠 维护约定

- 页面由 \`remember\` / 自动归纳写入，也可人工编辑
- 写入统一走 wiki_write / 记忆管线，raw 不可改
`;
}

function logTemplate(scope: MemoryScope): string {
  return `# 日志(log.md)

> ${scope === "user" ? "用户级" : "项目级"}记忆事件流，append-only。
> 条目格式：## [YYYY-MM-DD] type | 短标题

`;
}

function userSchemaTemplate(): string {
  return `# 用户记忆库 schema

> 本文件由 neo 自动生成一次，之后可人工修改。

## 目录

- \`raw/\` — 历史证据（迁移归档；可创建/删除，不可修改已有文件）
- \`wiki/\` — 主题页（当前最优综述）+ \`INDEX.md\` + \`log.md\`
- \`outputs/\` — 派生物

## 页面类型

| 页面 | 内容 |
|---|---|
| 用户画像.md | 身份/角色/长期目标（摘要常驻注入） |
| 偏好-<主题>.md | 代码风格、沟通、工具偏好 |
| 环境.md | OS/shell/编辑器/常用路径 |
| 经验-<领域>.md | 跨项目方法论 |

## 分区纪律

- \`## 事实（用户明确表达）\`：用户原话或行为明确表达
- \`## 推断（待确认）\`：从上下文推测，必须带 \`（推断 日期 · 置信 · session）\` 标记
- 敏感类别不做推断

## 检索纪律

项目级记忆优先，用户级仅作背景；推断内容不得当作硬性要求。
`;
}
