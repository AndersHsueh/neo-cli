/**
 * completion.test.ts — v0.2.4 C1/C2：触发识别 + 模糊匹配 + 排序。
 *
 * 规格：docs/v0.2.4-input-prd[done].md §2 C1/C2、§4 模块划分。
 * 纯逻辑，无 IO。
 */
import { describe, expect, test } from "bun:test";

import {
  NO_MATCH,
  applyCompletion,
  applyMatch,
  completeLine,
  fuzzyScore,
  formatCandidateHint,
  rankCommands,
  rankFiles,
  triggerAt,
  type CommandEntry,
} from "../src/input/completion.ts";

const CMDS: CommandEntry[] = [
  { name: "provider", description: "切换 provider" },
  { name: "peers", description: "跨会话状态" },
  { name: "help", description: "帮助" },
];

describe("C1a 触发识别", () => {
  test("行首 @ 路径", () => {
    expect(triggerAt("@src")).toEqual({ kind: "file", token: "@src", query: "src", start: 0 });
  });

  test("句中 @ 路径（前置空白）", () => {
    const ctx = triggerAt("读一下 @src/ui/con");
    expect(ctx).toEqual({ kind: "file", token: "@src/ui/con", query: "src/ui/con", start: 4 });
  });

  test("前置标点也算边界：([{'\",;", () => {
    for (const p of ["(", "[", "{", "'", '"', ",", ";"]) {
      expect(triggerAt(`看${p}@a.ts`)?.query).toBe("a.ts");
    }
  });

  test("email 形态不误判（@ 前是单词字符）", () => {
    expect(triggerAt("mail a@b.com")).toBeNull();
    expect(triggerAt("a@b")).toBeNull();
  });

  test("中文紧贴 @ 也算边界（中文用户最自然的写法）", () => {
    expect(triggerAt("读一下@src/a.ts")?.query).toBe("src/a.ts");
    expect(triggerAt("看@a")?.kind).toBe("file");
  });

  test("@ 后出现空白 → 不是引用", () => {
    expect(triggerAt("@a b")).toBeNull();
    expect(triggerAt("见 @a.ts 最后")).toBeNull();
  });

  test("行首 / 触发命令补全", () => {
    expect(triggerAt("/")).toEqual({ kind: "command", token: "/", query: "", start: 0 });
    expect(triggerAt("/pro")).toEqual({ kind: "command", token: "/pro", query: "pro", start: 0 });
  });

  test("命令名之后有空格的不是命令补全；前导空格的 / 也不算", () => {
    expect(triggerAt("/provider x")).toBeNull();
    expect(triggerAt("  /pro")).toBeNull();
  });

  test("普通文本无触发", () => {
    expect(triggerAt("hello world")).toBeNull();
    expect(triggerAt("")).toBeNull();
  });

  test("命令行里还能再触发 @（句末引用）", () => {
    expect(triggerAt("/provider @src")).toEqual({ kind: "file", token: "@src", query: "src", start: 10 });
  });
});

describe("C1b 模糊匹配", () => {
  test("子序列命中", () => {
    expect(fuzzyScore("con", "src/ui/console.ts")).toBeGreaterThan(0);
    expect(fuzzyScore("suc", "src/ui/console.ts")).toBeGreaterThan(0);
  });

  test("不命中返回 NO_MATCH（-Infinity；不能用 -1，会被长路径扣分撞上）", () => {
    expect(fuzzyScore("xyz", "src/ui/console.ts")).toBe(NO_MATCH);
    expect(fuzzyScore("oncl", "src/ui/console.ts")).toBe(NO_MATCH); // 顺序必须一致
  });

  test("大小写不敏感", () => {
    expect(fuzzyScore("CON", "console.ts")).toBe(fuzzyScore("con", "console.ts"));
  });

  test("前缀命中优于中段命中", () => {
    expect(fuzzyScore("con", "console.ts")).toBeGreaterThan(fuzzyScore("con", "src/ui/console.ts"));
  });

  test("路径边界加分：ui/ 比 uix 更优", () => {
    expect(fuzzyScore("ui", "a/ui/b.ts")).toBeGreaterThan(fuzzyScore("ui", "a/uixb.ts"));
  });

  test("CJK 路径可匹配", () => {
    expect(fuzzyScore("测试", "文档/测试说明.md")).toBeGreaterThan(0);
  });

  test("空查询匹配一切且同分", () => {
    expect(fuzzyScore("", "a.ts")).toBe(fuzzyScore("", "b/c.ts"));
  });
});

describe("C1c-0 回归：深路径命中不被长度扣分误杀", () => {
  test("长路径的真实命中仍出现在候选里（simplify 效率审查发现的 bug）", () => {
    const deep = "packages/app-core/src/components/forms/fields/Validation1.spec.ts";
    expect(fuzzyScore("src", deep)).toBeGreaterThan(NO_MATCH);
    const out = rankFiles("src", deep ? [deep, "a.ts"] : []);
    expect(out).toContain(deep);
  });
});

describe("C1c 排序与候选", () => {
  const files = ["docs/readme.md", "README.md", "src/ui/console.ts", "src/uixb.ts", "a/ui/b.ts"];

  test("短名优先于同分长名", () => {
    const out = rankFiles("readme", files);
    expect(out[0]).toBe("README.md");
    expect(out).toContain("docs/readme.md");
  });

  test("路径边界优先", () => {
    const out = rankFiles("ui", files);
    expect(out.indexOf("a/ui/b.ts")).toBeLessThan(out.indexOf("src/uixb.ts"));
  });

  test("limit 生效，过滤不命中", () => {
    expect(rankFiles("", files, 2).length).toBe(2);
    expect(rankFiles("zzz", files)).toEqual([]);
  });

  test("结果确定（同输入同输出）", () => {
    expect(rankFiles("ui", files)).toEqual(rankFiles("ui", files));
  });

  test("命令排序按名称模糊匹配", () => {
    const out = rankCommands("pr", CMDS);
    expect(out[0]!.name).toBe("provider"); // pr 是前缀，peers 只是子序列
    expect(out.map((c) => c.name)).not.toContain("help");
  });
});

describe("C2 整行补全（readline completer 的输入输出）", () => {
  test("文件补全：保留 @ 前缀，token 精确可替换", () => {
    const r = completeLine("@src/ui/con", { files: ["src/ui/console.ts"], commands: [] });
    expect(r).toEqual({ matches: ["@src/ui/console.ts"], token: "@src/ui/con", start: 0 });
  });

  test("命令补全：保留 / 前缀", () => {
    const r = completeLine("/pro", { files: [], commands: CMDS });
    expect(r).toEqual({ matches: ["/provider"], token: "/pro", start: 0 });
  });

  test("无触发返回 null", () => {
    expect(completeLine("hello", { files: ["a.ts"], commands: CMDS })).toBeNull();
  });

  test("无候选时返回空 matches 而不是 null（调用方据此响铃/不动作）", () => {
    const r = completeLine("@zzz", { files: ["a.ts"], commands: [] });
    expect(r).toEqual({ matches: [], token: "@zzz", start: 0 });
  });

  test("默认上限 20", () => {
    const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
    const r = completeLine("@f", { files, commands: [] });
    expect(r!.matches.length).toBe(20);
  });
});

describe("C1d 插入（Tab 由我们自己接管）", () => {
  test("替换 token，保留光标后的文本", () => {
    const line = "@src/ui/con 后面还有字";
    const cursor = "@src/ui/con".length;
    const r = completeLine("@src/ui/con", { files: ["src/ui/console.ts"], commands: [] });
    const out = applyCompletion(line, cursor, r!, 0);
    expect(out.line).toBe("@src/ui/console.ts 后面还有字");
    expect(out.cursor).toBe("@src/ui/console.ts".length);
  });

  test("命令补全插入后光标在末尾", () => {
    const r = completeLine("/pro", { files: [], commands: CMDS });
    const out = applyCompletion("/pro", 4, r!, 0);
    expect(out.line).toBe("/provider");
    expect(out.cursor).toBe(9);
  });

  test("候选越界时原样返回（防御）", () => {
    const r = completeLine("@a", { files: ["abc.ts"], commands: [] });
    expect(applyCompletion("@a", 2, r!, 99)).toEqual({ line: "@a", cursor: 2 });
  });
});

describe("C1e Tab 连按循环（同一批候选）", () => {
  test("applyMatch 在同一 start 上依次替换，9 次回到首个候选", () => {
    const matches = ["@a1.ts", "@a2.ts", "@a3.ts"];
    let line = "@a";
    let cursor = 2;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = applyMatch(line, cursor, 0, matches[i]!);
      line = r.line;
      cursor = r.cursor;
      seen.push(line);
    }
    expect(seen).toEqual(["@a1.ts", "@a2.ts", "@a3.ts"]);
    const back = applyMatch(line, cursor, 0, matches[0]!);
    expect(back.line).toBe("@a1.ts");
    expect(back.cursor).toBe("@a1.ts".length);
  });

  test("替换只碰 token 段，光标后的文本保留", () => {
    const r = applyMatch("@a 尾巴", 2, 0, "@abc.ts");
    expect(r.line).toBe("@abc.ts 尾巴");
    expect(r.cursor).toBe("@abc.ts".length);
  });

  test("候选提示行包含数量与候选名", () => {
    const hint = formatCandidateHint("file", ["@a.ts", "@b.ts", "@c.ts"]);
    expect(hint).toContain("3 个文件候选");
    expect(hint).toContain("@a.ts");
    expect(hint).toContain("Tab");
  });

  test("命令候选提示只留给 readline 降级路径（不再是 TUI 主交互）", () => {
    const names = Array.from({ length: 33 }, (_, i) => `/cmd${i}`);
    const hint = formatCandidateHint("command", names);
    expect(hint).toContain("33 个命令候选");
    expect(hint).toContain("还有 25 个");
  });
});
