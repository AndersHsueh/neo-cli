/**
 * issue #15：仓库地图（符号级注入）。
 *
 * 覆盖：
 *  A 符号抽取：ts / py / go / rust 的导出与顶层定义
 *  B 地图生成：跳过依赖目录、按预算截断、关闭时为空、缓存命中
 *  C 系统提示词：启用时注入「仓库地图」，关闭时不注入
 *  D 配置解析与 `/context` 摘要文案
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_REPO_MAP, resolveRepoMapConfig, type Config } from "../src/config.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { buildRepoMap, extractSymbols, repoMapSummary, resetRepoMapCache } from "../src/prompt/repoMap.ts";

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

// #52 起默认关闭；本文件旧用例验证的是「能力开启时」的行为，故显式开启。
// 52-A/B 用例显式传入 enabled，不受这个测试默认值影响。
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
/* A. 符号抽取                                                         */
/* ------------------------------------------------------------------ */

describe("A extractSymbols", () => {
  test("ts：导出函数/类/接口/类型/常量/枚举 + export { a, b as c }", () => {
    const src = `
export function alpha() {}
export async function beta() {}
export class Gamma {}
export interface Delta {}
export type Epsilon = string;
export const ZETA = 1;
export enum Eta {}
export { one, two as THREE };
function notExported() {}
`;
    expect(extractSymbols(src, "ts")).toEqual([
      "alpha",
      "beta",
      "Gamma",
      "Delta",
      "Epsilon",
      "ZETA",
      "Eta",
      "one",
      "two",
    ]);
  });

  test("py：def/class（含 async）；go：func/type；rust：fn/struct/enum/trait（含 pub）", () => {
    expect(extractSymbols("def a():\n    pass\nasync def b():\n    pass\nclass C:\n    pass\n", "py")).toEqual([
      "a",
      "b",
      "C",
    ]);
    expect(extractSymbols("func A() {}\nfunc (r *R) B() {}\ntype C struct{}\n", "go")).toEqual(["A", "B", "C"]);
    expect(extractSymbols("pub fn a() {}\nstruct B;\npub enum C {}\ntrait D {}\n", "rust")).toEqual([
      "a",
      "B",
      "C",
      "D",
    ]);
  });

  test("每文件符号上限 10 个，重复名去重", () => {
    const src = Array.from({ length: 20 }, (_, i) => `export function f${i}() {}`).join("\n");
    expect(extractSymbols(src, "ts").length).toBe(10);
    expect(extractSymbols("export function a() {}\nexport const a = 1;", "ts")).toEqual(["a"]);
  });
});

/* ------------------------------------------------------------------ */
/* B. 地图生成                                                         */
/* ------------------------------------------------------------------ */

describe("B buildRepoMap", () => {
  test("正常仓：给出 文件 → 符号；跳过 node_modules / 非源码", () => {
    const cwd = tmpdir_("neo-rm-");
    write(cwd, "src/a.ts", "export function alpha() {}\nexport class Beta {}\n");
    write(cwd, "lib/b.py", "def gamma():\n    pass\n");
    write(cwd, "node_modules/dep/c.ts", "export function ignoreMe() {}\n");
    write(cwd, "README.md", "export function notSource() {}\n");
    const map = buildRepoMap(cfgFor(cwd));
    expect(map.text).toContain("## 仓库地图");
    expect(map.text).toContain("src/a.ts: alpha, Beta");
    expect(map.text).toContain("lib/b.py: gamma");
    expect(map.text).not.toContain("ignoreMe");
    expect(map.text).not.toContain("notSource");
    expect(map.stats.symbols).toBe(3);
    expect(map.stats.truncated).toBe(false);
  });

  test("预算截断：小预算只收一部分并标注截断", () => {
    const cwd = tmpdir_("neo-rm-budget-");
    for (let i = 0; i < 30; i++) {
      write(cwd, `src/f${String(i).padStart(2, "0")}.ts`, `export function fn${i}() {}\n`);
    }
    const map = buildRepoMap(cfgFor(cwd, { enabled: true, budgetTokens: 100, maxFiles: 100 }));
    expect(map.stats.truncated).toBe(true);
    expect(map.text).toContain("截断");
    expect(map.text.length).toBeLessThan(100 * 4 + 400);
  });

  test("52-B 默认/显式关闭 → 空图且 files=0；显式开启保留扫描", () => {
    const cwd = tmpdir_("neo-rm-off-");
    write(cwd, "src/a.ts", "export function a() {}\n");
    for (const enabled of [false, true]) {
      resetRepoMapCache();
      const map = buildRepoMap(cfgFor(cwd, { enabled, budgetTokens: 800, maxFiles: 100 }));
      expect(map.text.includes("src/a.ts")).toBe(enabled);
      expect(map.stats.files === 0).toBe(!enabled);
    }
    resetRepoMapCache();
    const emptyDir = tmpdir_("neo-rm-empty-");
    const empty = buildRepoMap(cfgFor(emptyDir, { ...DEFAULT_REPO_MAP, enabled: true }));
    expect(empty.text).toBe("");
    expect(empty.stats.enabled).toBe(true);
  });

  test("缓存：同 cwd 二次调用不再扫描（文件改动在 TTL 内不生效）", () => {
    const cwd = tmpdir_("neo-rm-cache-");
    write(cwd, "src/a.ts", "export function a() {}\n");
    const first = buildRepoMap(cfgFor(cwd));
    expect(first.text).toContain("a");
    write(cwd, "src/a.ts", "export function a() {}\nexport function b() {}\n");
    const second = buildRepoMap(cfgFor(cwd));
    expect(second.text).not.toContain("b"); // 命中缓存
    resetRepoMapCache();
    expect(buildRepoMap(cfgFor(cwd)).text).toContain("b");
  });
});

/* ------------------------------------------------------------------ */
/* C. 系统提示词                                                       */
/* ------------------------------------------------------------------ */

describe("C 系统提示词注入", () => {
  test("启用时含「仓库地图」与符号；关闭时不含", () => {
    const cwd = tmpdir_("neo-rm-prompt-");
    write(cwd, "src/a.ts", "export function alpha() {}\n");
    const on = buildSystemPrompt(cfgFor(cwd));
    expect(on).toContain("仓库地图");
    expect(on).toContain("src/a.ts: alpha");
    resetRepoMapCache();
    const off = buildSystemPrompt(cfgFor(cwd, { enabled: false, budgetTokens: 800, maxFiles: 100 }));
    expect(off).not.toContain("仓库地图");
  });
});

/* ------------------------------------------------------------------ */
/* D. 配置与摘要                                                       */
/* ------------------------------------------------------------------ */

describe("D 配置解析与 /context 摘要", () => {
  test("52-A 默认关闭 800 tokens / 1200 文件；显式 true/false 覆盖与夹紧", () => {
    expect(DEFAULT_REPO_MAP.enabled).toBe(false);
    expect(resolveRepoMapConfig(undefined)).toEqual(DEFAULT_REPO_MAP);
    expect(resolveRepoMapConfig({ enabled: true }).enabled).toBe(true);
    expect(resolveRepoMapConfig({ enabled: false }).enabled).toBe(false);
    expect(resolveRepoMapConfig({ enabled: false, budget_tokens: 2_000, max_files: 50 })).toEqual({
      enabled: false,
      budgetTokens: 2_000,
      maxFiles: 50,
    });
    expect(resolveRepoMapConfig({ budget_tokens: 10 }).budgetTokens).toBe(DEFAULT_REPO_MAP.budgetTokens);
    expect(resolveRepoMapConfig({ budget_tokens: 99_999 }).budgetTokens).toBe(8_000);
    expect(resolveRepoMapConfig({ max_files: 1 }).maxFiles).toBe(DEFAULT_REPO_MAP.maxFiles);
  });

  test("repoMapSummary：关闭 / 未生成 / 正常三态", () => {
    const cwd = tmpdir_("neo-rm-sum-");
    write(cwd, "src/a.ts", "export function alpha() {}\n");
    expect(repoMapSummary(cfgFor(cwd))).toContain("tokens（预算 800）");
    resetRepoMapCache();
    expect(repoMapSummary(cfgFor(cwd, { enabled: false, budgetTokens: 800, maxFiles: 100 }))).toBe("已关闭");
    const empty = tmpdir_("neo-rm-sum-empty-");
    expect(repoMapSummary(cfgFor(empty))).toContain("未生成");
  });
});
