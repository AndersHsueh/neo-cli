/**
 * 自定义输出风格的发现与匹配（issue #73）。
 *
 * 只按 neo 自己的配置层级扫描：~/.neo/output-styles/*.md，以及从 cwd
 * 走到 git toplevel 的 .neo/output-styles/*.md。不读 .claude/output-styles。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { detectRepo } from "../worktree.ts";
import { builtinOutputStyles, isBuiltinOutputStyleName } from "./builtin.ts";
import type { DiscoverResult, OutputStyle } from "./types.ts";

export interface DiscoverOptions {
  cwd: string;
  home: string;
}

export function defaultStyleHome(): string {
  return process.env["HOME"] || process.env["USERPROFILE"] || homedir();
}

/** 项目级风格目录：cwd 最近的在前。不在 git 仓库则只返回 cwd 下那一份。 */
export function projectStyleDirs(cwd: string): string[] {
  const abs = resolve(cwd);
  const repo = detectRepo(abs);
  if (!repo.ok) return [join(abs, ".neo", "output-styles")];
  const stop = resolve(repo.root);
  const out: string[] = [];
  let cur = abs;
  for (;;) {
    out.push(join(cur, ".neo", "output-styles"));
    if (cur === stop) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

function listMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    files.push(full);
  }
  return files;
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;
  return undefined;
}

/**
 * 拆 frontmatter。解析失败（未闭合等）时字段为空，正文仍用整份文件。
 * force-for-plugin 与未知字段忽略。
 */
export function splitStyleFrontmatter(raw: string): {
  fields: Record<string, string>;
  body: string;
  failed: boolean;
} {
  const lines = raw.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return { fields: {}, body: raw, failed: false };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { fields: {}, body: raw, failed: true };

  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const m = /^([^:]+):\s?(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").trim();
    const val = (m[2] ?? "").trim();
    if (key) fields[key] = val;
  }
  return { fields, body: lines.slice(end + 1).join("\n"), failed: false };
}

export function styleNameFromPath(absPath: string): string {
  return basename(absPath).replace(/\.md$/i, "");
}

export function parseOutputStyleFile(absPath: string, raw: string): OutputStyle {
  const { fields, body, failed } = splitStyleFrontmatter(raw);
  const named = (fields["name"] ?? "").trim();
  return {
    name: failed || !named ? styleNameFromPath(absPath) : named,
    description: failed ? "" : (fields["description"] ?? "").trim(),
    kind: "custom",
    keepCodingInstructions: failed ? undefined : parseBool(fields["keep-coding-instructions"]),
    body,
    sourcePath: absPath,
  };
}

function readStyleFile(absPath: string): OutputStyle | null {
  try {
    return parseOutputStyleFile(absPath, readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

export function discoverOutputStyles(opts: DiscoverOptions): DiscoverResult {
  const diagnostics: string[] = [];
  const customs = new Map<string, OutputStyle>();
  const dirs = [...projectStyleDirs(opts.cwd), join(opts.home, ".neo", "output-styles")];
  for (const dir of dirs) {
    for (const file of listMarkdownFiles(dir)) {
      const style = readStyleFile(file);
      if (!style) continue;
      if (isBuiltinOutputStyleName(style.name)) {
        diagnostics.push(`自定义输出风格「${style.name}」与内置重名，已跳过（${file}）`);
        continue;
      }
      if (!customs.has(style.name)) customs.set(style.name, style);
    }
  }
  return { styles: [...builtinOutputStyles(), ...customs.values()], diagnostics };
}

export function matchOutputStyle(query: string, styles: readonly OutputStyle[]): OutputStyle | null {
  const exact = styles.find((s) => s.name === query);
  if (exact) return exact;
  const lowered = query.toLowerCase();
  return styles.find((s) => s.name.toLowerCase() === lowered) ?? null;
}
