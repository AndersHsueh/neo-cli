/**
 * AGENTS.md wiki 工作流区块的写入策略（区块所有权模式）。
 *
 * 规格：src/memory/agMd.ts 文件头 + wiki-turnning-1018.md「区块所有权」。
 * 核心承诺：区块外内容一律不碰；重复调用结果一致（幂等）。
 */
import { describe, expect, test } from "bun:test";

import {
  composeAgentsContent,
  WIKI_SECTION_END,
  WIKI_SECTION_START,
} from "../src/memory/agMd.ts";

const START_LINE = `<!-- neo:wiki-workflow:start v1 -->`;

/** 数标记出现次数。 */
function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

/** 断言输出只有一对标记，且幂等。 */
function expectWellFormed(out: string): void {
  expect(count(out, WIKI_SECTION_START)).toBe(1);
  expect(count(out, WIKI_SECTION_END)).toBe(1);
  expect(composeAgentsContent(out)).toBe(out);
}

describe("composeAgentsContent — 基本分支", () => {
  test("null / 空串 / 纯空白 → 只输出区块", () => {
    for (const input of [null, "", "   \n\n  "]) {
      const out = composeAgentsContent(input);
      expect(out.startsWith(WIKI_SECTION_START)).toBe(true);
      expectWellFormed(out);
    }
  });

  test("无标记 → 追加区块，原文保留", () => {
    const out = composeAgentsContent("# 标题\n\n手写内容\n");
    expect(out).toContain("# 标题");
    expect(out).toContain("手写内容");
    expectWellFormed(out);
  });

  test("正常顺序区块 → 只替换区块内，区块外手写保留", () => {
    const existing = [
      "# 标题",
      START_LINE,
      "旧区块内容",
      WIKI_SECTION_END,
      "手写区",
    ].join("\n");
    const out = composeAgentsContent(existing);
    expect(out).toContain("# 标题");
    expect(out).toContain("手写区");
    expect(out).not.toContain("旧区块内容");
    expectWellFormed(out);
  });
});

describe("composeAgentsContent — 标记乱序（回归）", () => {
  // 缺陷：END 出现在 START 之前时，旧实现只校验「两个标记都存在」，
  // 随后 slice(0, start) + section + slice(endIdx) 会产出第二个 END，
  // 每次 /init 都让 AGENTS.md 增长一整个区块（非幂等）。
  const scrambled = [
    "# 我的项目约定",
    WIKI_SECTION_END,
    "## 用户手写的踩坑记录",
    "这一行很重要，绝对不能丢。",
    START_LINE,
    "旧的 wiki 区块内容",
  ].join("\n");

  test("乱序输入不产生重复标记", () => {
    const out = composeAgentsContent(scrambled);
    expectWellFormed(out);
  });

  test("乱序输入重复调用不膨胀（幂等）", () => {
    const first = composeAgentsContent(scrambled);
    const second = composeAgentsContent(first);
    const third = composeAgentsContent(second);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(third.length).toBe(first.length);
  });

  test("乱序输入保留用户手写内容", () => {
    const out = composeAgentsContent(scrambled);
    expect(out).toContain("# 我的项目约定");
    expect(out).toContain("## 用户手写的踩坑记录");
    expect(out).toContain("这一行很重要，绝对不能丢。");
  });
});

describe("composeAgentsContent — 残缺标记", () => {
  test("只有 END → 摘掉标记后追加，手写保留", () => {
    const out = composeAgentsContent(`# 标题\n${WIKI_SECTION_END}\n手写\n`);
    expect(out).toContain("# 标题");
    expect(out).toContain("手写");
    expectWellFormed(out);
  });

  test("只有 START → 摘掉标记后追加，手写保留", () => {
    const out = composeAgentsContent(`# 标题\n${START_LINE}\n手写\n`);
    expect(out).toContain("# 标题");
    expect(out).toContain("手写");
    expectWellFormed(out);
  });
});
