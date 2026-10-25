/**
 * references.test.ts — v0.2.4 C3：`@path` 引用解析与展开。
 *
 * 规格：docs/v0.2.4-input-prd[done].md §2 C3。
 * 全部通过注入的 readFile/exists 驱动，不碰真实文件系统。
 */
import { describe, expect, test } from "bun:test";

import { expandReferences, parseReferences } from "../src/input/references.ts";

// 注入的 IO 收到的是**绝对路径**（相对 opts.cwd 解析后的结果）
const files: Record<string, string> = {
  "/repo/a.ts": "const a = 1;\n",
  "/repo/src/b.ts": Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n"),
  "/repo/bin.dat": "abc\u0000def",
  "/repo/big.txt": "x".repeat(1_000),
};

const deps = {
  cwd: "/repo",
  exists: (p: string): boolean => p in files,
  readFile: (p: string): string => files[p]!,
  statSize: (p: string): number => Buffer.byteLength(files[p] ?? "", "utf8"),
};

describe("C3a 解析", () => {
  test("句中/行首/多个引用", () => {
    expect(parseReferences("看 @a.ts 和 @src/b.ts")).toEqual([
      { token: "@a.ts", path: "a.ts", start: 2 },
      { token: "@src/b.ts", path: "src/b.ts", start: 10 },
    ]);
    expect(parseReferences("@a.ts").map((r) => r.path)).toEqual(["a.ts"]);
  });

  test("剥掉尾随标点", () => {
    expect(parseReferences("见 @a.ts, 还有 @src/b.ts。").map((r) => r.path)).toEqual([
      "a.ts",
      "src/b.ts",
    ]);
    expect(parseReferences("(@a.ts)").map((r) => r.path)).toEqual(["a.ts"]);
  });

  test("email 与孤立 @ 不算引用", () => {
    expect(parseReferences("mail a@b.com")).toEqual([]);
    expect(parseReferences("@ hello")).toEqual([]);
  });
});

describe("C3b 展开", () => {
  test("内容附在原文之后，带起止标记与行数", () => {
    const r = expandReferences("看 @a.ts", deps);
    expect(r.text.startsWith("看 @a.ts")).toBe(true);
    expect(r.text).toContain("——— a.ts（1 行）———");
    expect(r.text).toContain("const a = 1;");
    expect(r.text).toContain("——— end a.ts ———");
    expect(r.refs).toEqual([{ path: "a.ts", lines: 1, truncated: false }]);
    expect(r.errors).toEqual([]);
  });

  test("重复引用只展开一次", () => {
    const r = expandReferences("@a.ts 和 @a.ts", deps);
    expect(r.refs.length).toBe(1);
    expect(r.text.split("——— end a.ts ———").length - 1).toBe(1);
  });

  test("文件不存在：保留原文 + 报错，不阻断", () => {
    const r = expandReferences("看 @nope.ts", deps);
    expect(r.text).toBe("看 @nope.ts");
    expect(r.refs).toEqual([]);
    expect(r.errors.join("\n")).toContain("nope.ts");
  });

  test("二进制文件跳过并报错", () => {
    const r = expandReferences("@bin.dat", deps);
    expect(r.refs).toEqual([]);
    expect(r.errors.join("\n")).toContain("二进制");
  });

  test("单文件超行数上限：截断并标注", () => {
    const r = expandReferences("@src/b.ts", { ...deps, maxLinesPerFile: 400 });
    expect(r.refs[0]!.truncated).toBe(true);
    expect(r.refs[0]!.lines).toBe(400);
    expect(r.text).toContain("已截断");
    expect(r.text).not.toContain("line499");
  });

  test("最多 5 个文件：多余的报「未展开」", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 7; i++) many[`/repo/f${i}.ts`] = "x";
    const r = expandReferences(
      Array.from({ length: 7 }, (_, i) => `@f${i}.ts`).join(" "),
      {
        cwd: "/repo",
        exists: (p) => p in many,
        readFile: (p) => many[p]!,
        statSize: (p) => Buffer.byteLength(many[p] ?? "", "utf8"),
      },
    );
    expect(r.refs.length).toBe(5);
    expect(r.errors.join("\n")).toContain("最多引用 5 个");
  });

  test("超预算的文件按剩余预算截断（PRD C3：截断并标注，不是整份丢弃）", () => {
    const r = expandReferences("@big.txt", {
      ...deps,
      maxBytesTotal: 100,
      readSlice: (p, n) => files[p]!.slice(0, n),
    });
    expect(r.refs.length).toBe(1);
    expect(r.refs[0]!.truncated).toBe(true);
    expect(r.text).toContain("已截断");
  });

  test("预算耗尽后剩下的引用报错跳过", () => {
    const r = expandReferences("@big.txt @a.ts", {
      ...deps,
      maxBytesTotal: 10,
      readSlice: (p, n) => files[p]!.slice(0, n),
    });
    expect(r.refs.length).toBe(1);
    expect(r.errors.join("\n")).toContain("超出");
  });

  test("没有引用时原样返回", () => {
    const r = expandReferences("普通消息", deps);
    expect(r).toEqual({ text: "普通消息", refs: [], errors: [] });
  });
});

describe("C3c 路径解析相对 cfg.cwd（-C 场景）", () => {
  test("相对路径按 opts.cwd 解析，而不是 process.cwd()", () => {
    const seen: string[] = [];
    const r = expandReferences("@a.ts", {
      cwd: "/work/proj",
      exists: (p) => {
        seen.push(p);
        return p === "/work/proj/a.ts";
      },
      statSize: () => 7,
      readFile: (p) => {
        expect(p).toBe("/work/proj/a.ts");
        return "content";
      },
    });
    expect(seen[0]).toBe("/work/proj/a.ts");
    expect(r.refs[0]!.path).toBe("a.ts"); // 展示仍是相对路径
  });

  test("绝对路径与相对路径指向同一文件时只展开一次", () => {
    const r = expandReferences("@a.ts @/repo/a.ts", {
      cwd: "/repo",
      exists: (p) => p === "/repo/a.ts",
      readFile: () => "x",
      statSize: () => 1,
    });
    expect(r.refs.length).toBe(1);
  });

  test("绝对路径原样使用", () => {
    const r = expandReferences("@/abs/x.ts", {
      cwd: "/work/proj",
      exists: (p) => p === "/abs/x.ts",
      readFile: () => "z",
      statSize: () => 1,
    });
    expect(r.refs[0]!.path).toBe("/abs/x.ts");
  });
});
