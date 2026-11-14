/**
 * issue #49：仓库地图按 import 引用图排序（纯文本解析，不引 tree-sitter / LSP）。
 *
 * 覆盖：
 *  E import 解析：ts/js（import/export from/require）、py（import/from-import）、
 *    go（单行与分组 import）、rust（use/mod）——相对路径解析与包名归一
 *  F 引用图与排序：被引用多的文件优先；引用度只用于排序、不进正文
 *  G 边界：循环 import 不死循环、自引用不计、解析不出的 import 忽略
 *  H 缓存：目录 mtime/文件数变化即失效；写入后主动 reset
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_REPO_MAP, type Config } from "../src/config.ts";
import {
  buildRepoMap,
  buildRefGraph,
  extractImports,
  resetRepoMapCache,
  resolveImportTarget,
  sortSourcesByRefs,
} from "../src/prompt/repoMap.ts";

const dirs: string[] = [];
function tmpdir_(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  resetRepoMapCache();
});

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// #52 把 repo_map.enabled 默认改为 false；本文件测的是「已开启时的引用图/缓存行为」，
// 必须显式开启，不能继承新默认值。与 tests/repo-map.test.ts 的 cfgFor 保持同一口径。
function cfgFor(cwd: string, repoMap = { ...DEFAULT_REPO_MAP, enabled: true }): Config {
  return {
    cwd,
    skillsStore: join(cwd, "no-skills"),
    providerName: "p",
    providerType: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    model: "m1",
    modelTier: "balanced",
    maxTokens: 4_096,
    temperature: 0.5,
    contextWindow: 100_000,
    contextWindowSource: "config",
    configuredContextWindow: 100_000,
    configuredContextWindowExplicit: true,
    env: { prompt: false, dir: join(cwd, "no-env") },
    providers: [],
    repoMap,
  } as unknown as Config;
}

/* ------------------------------------------------------------------ */
/* E. import 解析                                                      */
/* ------------------------------------------------------------------ */

describe("E extractImports", () => {
  test("E1 ts/js：import from / export from / side-effect import / require / dynamic import", () => {
    const src = `
import { a } from "./a.ts";
import b from "../lib/b";
import "./side-effect.css";
export { c } from "./c.ts";
export * from "./d.ts";
const e = require("./e.js");
const f = await import("./f.ts");
`;
    expect(extractImports(src, "ts")).toEqual([
      "./a.ts",
      "../lib/b",
      "./side-effect.css",
      "./c.ts",
      "./d.ts",
      "./e.js",
      "./f.ts",
    ]);
  });

  test("E2 py：import x / import x.y as z / from . import a / from .mod import b", () => {
    const src = `
import os
import pkg.sub as s
from . import sibling
from .mod import thing
from ..parent import other
from typing import List
`;
    expect(extractImports(src, "py")).toEqual(["os", "pkg.sub", ".", ".mod", "..parent", "typing"]);
  });

  test("E3 go：单行 import 与分组 import 都认", () => {
    const src = `
package main

import "fmt"
import alias "example.com/x/y"
import (
	"strings"
	_ "embed"
)
`;
    expect(extractImports(src, "go")).toEqual(["fmt", "example.com/x/y", "strings", "embed"]);
  });

  test("E4 rust：use 路径（含 crate/self/super）与 mod 声明", () => {
    const src = `
use std::collections::HashMap;
use crate::foo::bar;
use super::baz;
mod local;
pub mod nested;
`;
    expect(extractImports(src, "rust")).toEqual(["std::collections::HashMap", "crate::foo::bar", "super::baz", "local", "nested"]);
  });

  test("E5 注释里的 import 不算（ts 行注释与块注释）", () => {
    const src = `
// import { a } from "./commented";
/* import b from "./blocked"; */
import { real } from "./real.ts";
`;
    expect(extractImports(src, "ts")).toEqual(["./real.ts"]);
  });
});

describe("E resolveImportTarget", () => {
  test("E6 相对路径：补扩展名 / 补 index 文件 / 目录", () => {
    const files = new Set(["src/a.ts", "src/b/index.ts", "lib/c.ts"]);
    expect(resolveImportTarget("src/a.ts", "./b", files)).toBe("src/b/index.ts");
    expect(resolveImportTarget("src/a.ts", "../lib/c", files)).toBe("lib/c.ts");
    expect(resolveImportTarget("src/a.ts", "./a.ts", files)).toBe("src/a.ts");
    // 解析不到（包名 / 外部依赖）→ null
    expect(resolveImportTarget("src/a.ts", "react", files)).toBeNull();
    expect(resolveImportTarget("src/a.ts", "./missing", files)).toBeNull();
  });

  test("E7 包名归一：py 的点号路径、go 的包路径、rust 的 crate:: 路径", () => {
    const files = new Set(["pkg/mod.py", "pkg/__init__.py", "internal/util/util.go", "src/foo/bar.rs", "src/lib.rs"]);
    // py：from .mod import x 在 pkg/mod.py 里 → 指向 pkg/__init__.py（包根）
    expect(resolveImportTarget("pkg/mod.py", ".", files)).toBe("pkg/__init__.py");
    // go：包路径按目录尾段匹配
    expect(resolveImportTarget("cmd/main.go", "example.com/x/internal/util", files)).toBe("internal/util/util.go");
    // rust：crate::foo::bar → src/foo/bar.rs
    expect(resolveImportTarget("src/lib.rs", "crate::foo::bar", files)).toBe("src/foo/bar.rs");
  });
});

/* ------------------------------------------------------------------ */
/* F. 引用图与排序                                                     */
/* ------------------------------------------------------------------ */

describe("F 引用图与排序", () => {
  test("F1 buildRefGraph：统计每个文件被多少个文件引用（去重，同文件多次 import 只算一次）", () => {
    const cwd = tmpdir_("neo-ref-graph-");
    write(cwd, "src/core.ts", "export function core() {}\n");
    write(cwd, "src/a.ts", 'import { core } from "./core.ts";\nimport { core as c2 } from "./core.ts";\nexport function a() {}\n');
    write(cwd, "src/b.ts", 'import { core } from "./core.ts";\nexport function b() {}\n');
    write(cwd, "src/c.ts", 'import { a } from "./a.ts";\nexport function c() {}\n');

    const graph = buildRefGraph(cwd, ["src/core.ts", "src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(graph.get("src/core.ts")).toBe(2); // a、b 引用
    expect(graph.get("src/a.ts")).toBe(1); // c 引用
    expect(graph.get("src/b.ts")).toBe(0);
    expect(graph.get("src/c.ts")).toBe(0);
  });

  test("F2 sortSourcesByRefs：被引用多的排前面；同引用数保持字典序（稳定）", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const refs = new Map([
      ["src/a.ts", 0],
      ["src/b.ts", 3],
      ["src/c.ts", 0],
      ["src/d.ts", 1],
    ]);
    expect(sortSourcesByRefs(files, refs, (f) => f)).toEqual(["src/b.ts", "src/d.ts", "src/a.ts", "src/c.ts"]);
  });

  test("F3 地图正文不含引用次数（引用度只用于排序）", () => {
    const cwd = tmpdir_("neo-ref-body-");
    write(cwd, "src/core.ts", "export function core() {}\n");
    write(cwd, "src/a.ts", 'import { core } from "./core.ts";\nexport function a() {}\n');
    write(cwd, "src/b.ts", 'import { core } from "./core.ts";\nexport function b() {}\n');
    const map = buildRepoMap(cfgFor(cwd));
    expect(map.text).toContain("src/core.ts: core");
    // 正文里不能出现「被引用 N 次」这类元数据
    expect(map.text).not.toMatch(/引用\s*\d+\s*次/);
    expect(map.text).not.toContain("refs=");
  });

  test("F4 排序生效：被引用多的文件在小预算下先出现", () => {
    const cwd = tmpdir_("neo-ref-order-");
    // aaa.ts 字典序最前但没人引用；zzz.ts 被引用两次
    write(cwd, "src/aaa.ts", "export function aaa() {}\n");
    write(cwd, "src/zzz.ts", "export function zzz() {}\n");
    write(cwd, "src/m1.ts", 'import { zzz } from "./zzz.ts";\nexport function m1() {}\n');
    write(cwd, "src/m2.ts", 'import { zzz } from "./zzz.ts";\nexport function m2() {}\n');
    // 预算只够放 2 行左右
    const map = buildRepoMap(cfgFor(cwd, { enabled: true, budgetTokens: 100, maxFiles: 100 }));
    const zzzAt = map.text.indexOf("src/zzz.ts");
    const aaaAt = map.text.indexOf("src/aaa.ts");
    expect(zzzAt).toBeGreaterThanOrEqual(0);
    // zzz 要么在 aaa 前面，要么 aaa 根本没进地图
    expect(aaaAt === -1 || zzzAt < aaaAt).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* G. 边界                                                             */
/* ------------------------------------------------------------------ */

describe("G 边界", () => {
  test("G1 循环 import 不死循环，两边都算被引用", () => {
    const cwd = tmpdir_("neo-ref-cycle-");
    write(cwd, "src/x.ts", 'import { y } from "./y.ts";\nexport function x() {}\n');
    write(cwd, "src/y.ts", 'import { x } from "./x.ts";\nexport function y() {}\n');
    const graph = buildRefGraph(cwd, ["src/x.ts", "src/y.ts"]);
    expect(graph.get("src/x.ts")).toBe(1);
    expect(graph.get("src/y.ts")).toBe(1);
    // 地图生成不挂
    expect(buildRepoMap(cfgFor(cwd)).text).toContain("src/x.ts");
  });

  test("G2 自引用不计入被引用次数", () => {
    const cwd = tmpdir_("neo-ref-self-");
    write(cwd, "src/s.ts", 'import { s } from "./s.ts";\nexport function s() {}\n');
    expect(buildRefGraph(cwd, ["src/s.ts"]).get("src/s.ts")).toBe(0);
  });

  test("G3 解析不到的 import（外部包）被忽略，不抛错", () => {
    const cwd = tmpdir_("neo-ref-ext-");
    write(cwd, "src/a.ts", 'import React from "react";\nimport { z } from "./missing";\nexport function a() {}\n');
    const graph = buildRefGraph(cwd, ["src/a.ts"]);
    expect(graph.get("src/a.ts")).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* H. 缓存                                                             */
/* ------------------------------------------------------------------ */

describe("H 缓存失效", () => {
  test("H1 文件内容变化（目录 mtime 变）后地图立即反映，不必等 20s", () => {
    const cwd = tmpdir_("neo-ref-cache-");
    write(cwd, "src/a.ts", "export function a() {}\n");
    expect(buildRepoMap(cfgFor(cwd)).text).toContain("a");
    // 新增文件会改目录 mtime
    write(cwd, "src/b.ts", "export function brandNew() {}\n");
    expect(buildRepoMap(cfgFor(cwd)).text).toContain("brandNew");
  });

  test("H2 文件数变化也触发失效（mtime 精度不足时的兜底）", () => {
    const cwd = tmpdir_("neo-ref-cache2-");
    write(cwd, "src/a.ts", "export function a() {}\n");
    const first = buildRepoMap(cfgFor(cwd));
    write(cwd, "src/c.ts", "export function extra() {}\n");
    const second = buildRepoMap(cfgFor(cwd));
    expect(second.text).toContain("extra");
    expect(first.text).not.toContain("extra");
  });

  test("H3 resetRepoMapCache 仍然有效（写入后主动失效的入口）", () => {
    const cwd = tmpdir_("neo-ref-cache3-");
    write(cwd, "src/a.ts", "export function a() {}\n");
    buildRepoMap(cfgFor(cwd));
    write(cwd, "src/a.ts", "export function a() {}\nexport function b() {}\n");
    resetRepoMapCache();
    expect(buildRepoMap(cfgFor(cwd)).text).toContain("b");
  });
});
