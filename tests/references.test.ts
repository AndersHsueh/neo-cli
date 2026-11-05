/**
 * references.test.ts — v0.2.4 C3：`@path` 引用解析与展开。
 *
 * 规格：docs/v0.2.4-input-prd[done].md §2 C3。
 * 全部通过注入的 readFile/exists 驱动，不碰真实文件系统。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("剥掉中文右引号/右括号/书名号", () => {
    // v0.4.48：TRAILING_PUNCT 只有 ASCII 的 )]} 和全角句读（，。；：、！？），
    // 漏了中文右引号/右括号/书名号。用户写「见 @a.ts）」时路径带上「）」，
    // exists 失败，引用静默不展开。
    for (const tail of ["）", "」", "》", "】", "〕", "〉", "｝", "］", "｠", "〗"]) {
      expect(parseReferences(`见 @a.ts${tail}`).map((r) => r.path)).toEqual(["a.ts"]);
    }
    // 叠加多个也要一次剥干净
    expect(parseReferences("见 @a.ts」》】）").map((r) => r.path)).toEqual(["a.ts"]);
    // 全角括号包住整个引用（左括号不在剥离集里，不影响）
    expect(parseReferences("（见 @a.ts）").map((r) => r.path)).toEqual(["a.ts"]);
  });

  test("剥掉中文引号（含左引号被误剥的一半）", () => {
    // v0.4.49：TRAILING_PUNCT 补了右括号/书名号，但仍漏了右引号 ” ’。
    // 更糟的是左引号 “ ‘ 不在集合里，却因为「剥尾部」规则被当成尾随标点剥掉：
    //   「见 @a.ts”」  => path "a.ts”"   （右引号没剥 → exists 失败）
    //   「见 @“a.ts”」=> path "“a.ts"   （左引号被剥 → exists 失败）
    // 两头都错，且都是静默不展开。
    for (const tail of ["”", "’", "〞", "〟"]) {
      expect(parseReferences(`见 @a.ts${tail}`).map((r) => r.path)).toEqual(["a.ts"]);
    }
    // 引号包住整个引用：左引号不能被剥
    expect(parseReferences("见 @“a.ts”").map((r) => r.path)).toEqual(["“a.ts"]);
    expect(parseReferences("见 @‘a.ts’").map((r) => r.path)).toEqual(["‘a.ts"]);
    // 叠加多个也要一次剥干净
    expect(parseReferences("见 @a.ts”’）").map((r) => r.path)).toEqual(["a.ts"]);
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

describe("C3d 字节预算截断落在多字节字符中间（真实 readSlice）", () => {
  // 这一组**不注入** readSlice，走 defaultReadSlice 的真实实现：
  // 缺陷是「TextDecoder 把残缺的多字节尾部替换成 U+FFFD」，
  // 注入 mock 永远测不到（旧用例的 mock 按字符 slice，不是按字节）。
  test("截断点落在中文中间时不留 U+FFFD，且不突破字节预算", () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-refs-"));
    try {
      // 全中文：每字 3 字节，90000 字节，远超预算
      writeFileSync(join(dir, "big.txt"), "中".repeat(30_000));
      const budget = 100;
      const r = expandReferences("@big.txt", { cwd: dir, maxBytesTotal: budget });

      expect(r.refs.length).toBe(1);
      expect(r.refs[0]!.truncated).toBe(true);
      // 正文里不能出现替换字符（乱码进模型上下文会被当成文件真实内容）
      expect(r.text).not.toContain("\uFFFD");
      // 引用块正文必须落在预算内（修复前是 102 字节 > 100）
      const body = /——— big\.txt[^\n]*———\n([\s\S]*?)\n——— end/.exec(r.text)?.[1] ?? "";
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(budget);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("截断点落在 emoji（4 字节）中间同样不产生乱码", () => {
    const dir = mkdtempSync(join(tmpdir(), "neo-refs-"));
    try {
      // 5 个 ASCII + emoji：预算 7 字节会切在 emoji 的第 2 个字节上
      writeFileSync(join(dir, "mix.txt"), "abcde😀😀");
      const r = expandReferences("@mix.txt", { cwd: dir, maxBytesTotal: 7 });
      expect(r.text).not.toContain("\uFFFD");
      const body = /——— mix\.txt[^\n]*———\n([\s\S]*?)\n——— end/.exec(r.text)?.[1] ?? "";
      expect(body).toBe("abcde");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
