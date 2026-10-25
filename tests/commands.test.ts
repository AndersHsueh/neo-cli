/**
 * commands.test.ts — v0.2.4 C2：命令声明表与 handleCommand 的漂移守卫。
 *
 * 声明表是 `/` 补全的唯一数据源；`index.ts` 的 switch 是唯一实现。
 * 两边任何一侧新增/删除而另一侧没跟，测试立刻红 —— 这是「表即规格」的落地。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { COMMANDS } from "../src/input/commands.ts";

const INDEX = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8");

/** 取出 handleCommand 函数体（到下一个顶层分隔注释为止）。 */
function handlerBody(): string {
  const start = INDEX.indexOf("async function handleCommand(");
  expect(start).toBeGreaterThan(-1);
  const rest = INDEX.slice(start);
  const end = rest.indexOf("/* ------------------------------------------------------------------ */\n/* shell 直通");
  return end === -1 ? rest : rest.slice(0, end);
}

/** 顶层 switch 的 case（4 空格缩进；嵌套 switch 的 case 更深）。 */
function implementedCommands(): string[] {
  const body = handlerBody();
  return [...body.matchAll(/^ {4}case "([^"]+)":/gm)].map((m) => m[1]!);
}

describe("C2a 命令表", () => {
  test("名称唯一、说明非空", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  test("别名也进表（? 与 quit 能被补全出来）", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(names).toContain("?");
    expect(names).toContain("quit");
  });

  test("表里每条都有 handleCommand 实现（forward guard）", () => {
    const impl = new Set(implementedCommands());
    const missing = COMMANDS.map((c) => c.name).filter((n) => !impl.has(n));
    expect(missing).toEqual([]);
  });

  test("handleCommand 每个顶层 case 都在表里（reverse guard）", () => {
    const declared = new Set(COMMANDS.map((c) => c.name));
    const undocumented = implementedCommands().filter((n) => !declared.has(n));
    expect(undocumented).toEqual([]);
  });

  test("解析出的命令数量合理（防止正则失效导致空断言）", () => {
    expect(implementedCommands().length).toBeGreaterThan(25);
    expect(implementedCommands()).toContain("last");
    expect(implementedCommands()).toContain("memory");
  });
});
