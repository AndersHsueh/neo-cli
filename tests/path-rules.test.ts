/**
 * issue #17：路径作用域项目规则（`.neo/rules` + `paths` glob 条件加载）。
 *
 * 覆盖：frontmatter 解析 / glob 语义 / 目录发现 / 命中选择 / 预算截断 /
 * 工具参数里的路径提取 / `/context` 报告文案。
 * 全部纯函数 + 临时目录，不触网、不碰真实 ~/.neo。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RULE_DIRS,
  RULE_MAX_ALWAYS_ON_CHARS,
  RULE_MAX_SCOPED_CHARS,
  discoverProjectRules,
  extractTouchedPaths,
  formatAlwaysOnRules,
  formatScopedRulesBlock,
  matchRuleGlob,
  normalizeRelPath,
  parseRuleFile,
  rulesReport,
  selectScopedRules,
  type ProjectRule,
} from "../src/rules/index.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-path-rules-"));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

let seq = 0;
function sandbox(): string {
  seq += 1;
  const dir = join(SANDBOX, `case-${seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function rule(over: Partial<ProjectRule> = {}): ProjectRule {
  return {
    file: "/x/.neo/rules/a.md",
    relPath: ".neo/rules/a.md",
    name: "a",
    paths: [],
    body: "正文",
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* A：frontmatter 解析                                                 */
/* ------------------------------------------------------------------ */

describe("A frontmatter 解析：paths / globs / 行内数组 / 无 frontmatter", () => {
  test("无 frontmatter → 每会话规则（paths 为空）", () => {
    const r = parseRuleFile("就是一段规则\n第二行", { file: "/x/.neo/rules/a.md", relPath: ".neo/rules/a.md" });
    expect(r.paths).toEqual([]);
    expect(r.body).toBe("就是一段规则\n第二行");
    expect(r.name).toBe("a");
  });

  test("YAML 列表写法", () => {
    const raw = '---\npaths:\n  - "src/api/**"\n  - "src/server/**"\n---\n接口约定';
    const r = parseRuleFile(raw, { file: "/x", relPath: ".neo/rules/api.md" });
    expect(r.paths).toEqual(["src/api/**", "src/server/**"]);
    expect(r.body).toBe("接口约定");
  });

  test("行内数组写法 + globs 别名", () => {
    const raw = '---\nglobs: ["src/api/**", "src/web/*.tsx"]\n---\n前端约定';
    const r = parseRuleFile(raw, { file: "/x", relPath: ".neo/rules/web.md" });
    expect(r.paths).toEqual(["src/api/**", "src/web/*.tsx"]);
  });

  test("逗号分隔字符串也认", () => {
    const raw = "---\npaths: src/api/**, src/db/**\n---\nbody";
    const r = parseRuleFile(raw, { file: "/x", relPath: ".neo/rules/db.md" });
    expect(r.paths).toEqual(["src/api/**", "src/db/**"]);
  });

  test("title 覆盖展示名；未知键忽略；CRLF 容忍", () => {
    const raw = "---\r\ntitle: 接口规则\r\npaths: src/api/**\r\nunknown: 1\r\n---\r\nbody\r\n";
    const r = parseRuleFile(raw, { file: "/x", relPath: ".neo/rules/api.md" });
    expect(r.name).toBe("接口规则");
    expect(r.body).toBe("body");
  });

  test("frontmatter 未闭合 → 整段当正文，不猜", () => {
    const raw = "---\npaths: src/api/**\n没有闭合\nbody";
    const r = parseRuleFile(raw, { file: "/x", relPath: ".neo/rules/broken.md" });
    expect(r.paths).toEqual([]);
    expect(r.body).toContain("paths: src/api/**");
  });
});

/* ------------------------------------------------------------------ */
/* B：glob 语义                                                        */
/* ------------------------------------------------------------------ */

describe("B glob 语义", () => {
  test("** 跨层", () => {
    expect(matchRuleGlob("src/api/**", "src/api/a.ts")).toBe(true);
    expect(matchRuleGlob("src/api/**", "src/api/x/y.ts")).toBe(true);
    expect(matchRuleGlob("src/api/**", "src/web/a.ts")).toBe(false);
  });

  test("**/*.ts 任意层级", () => {
    expect(matchRuleGlob("**/*.ts", "a.ts")).toBe(true);
    expect(matchRuleGlob("**/*.ts", "src/a/b.ts")).toBe(true);
    expect(matchRuleGlob("**/*.ts", "src/a/b.js")).toBe(false);
  });

  test("不含 / 的模式按 basename 匹配任意层", () => {
    expect(matchRuleGlob("*.md", "docs/x.md")).toBe(true);
    expect(matchRuleGlob("*.md", "x.md")).toBe(true);
    expect(matchRuleGlob("*.md", "docs/x.txt")).toBe(false);
  });

  test("{a,b} 交替 + ? 单字符", () => {
    expect(matchRuleGlob("src/{api,web}/**", "src/api/a.ts")).toBe(true);
    expect(matchRuleGlob("src/{api,web}/**", "src/web/a.ts")).toBe(true);
    expect(matchRuleGlob("src/{api,web}/**", "src/db/a.ts")).toBe(false);
    expect(matchRuleGlob("src/a?.ts", "src/ab.ts")).toBe(true);
    expect(matchRuleGlob("src/a?.ts", "src/abc.ts")).toBe(false);
  });

  test("尾部 / = 目录前缀", () => {
    expect(matchRuleGlob("src/api/", "src/api/a.ts")).toBe(true);
    expect(matchRuleGlob("src/api/", "src/apix/a.ts")).toBe(false);
  });

  test("路径归一：./ 前缀、绝对路径转相对、cwd 外返回 null", () => {
    const cwd = "/repo";
    expect(normalizeRelPath(cwd, "./src/a.ts")).toBe("src/a.ts");
    expect(normalizeRelPath(cwd, "/repo/src/a.ts")).toBe("src/a.ts");
    expect(normalizeRelPath(cwd, "/elsewhere/a.ts")).toBeNull();
    expect(normalizeRelPath(cwd, "src\\a.ts")).toBe("src/a.ts");
  });
});

/* ------------------------------------------------------------------ */
/* C：目录发现                                                         */
/* ------------------------------------------------------------------ */

describe("C 目录发现：.neo/rules 递归 + .claude/rules 兼容 + 忽略非 md", () => {
  test("递归发现、忽略非 md、结果确定排序", () => {
    const cwd = sandbox();
    writeFile(cwd, ".neo/rules/api.md", "---\npaths: src/api/**\n---\napi");
    writeFile(cwd, ".neo/rules/nested/db.md", "db");
    writeFile(cwd, ".neo/rules/readme.txt", "不是规则");
    const rules = discoverProjectRules(cwd);
    expect(rules.map((r) => r.relPath)).toEqual([".neo/rules/api.md", ".neo/rules/nested/db.md"]);
    expect(rules[0]!.paths).toEqual(["src/api/**"]);
  });

  test(".claude/rules 兼容读取；两个目录都存在时都收", () => {
    const cwd = sandbox();
    writeFile(cwd, ".neo/rules/a.md", "a");
    writeFile(cwd, ".claude/rules/b.md", "b");
    const rules = discoverProjectRules(cwd);
    expect(rules.map((r) => r.relPath)).toEqual([".claude/rules/b.md", ".neo/rules/a.md"]);
    expect(RULE_DIRS).toEqual([".neo/rules", ".claude/rules"]);
  });

  test("目录不存在 → 空数组，不抛错", () => {
    expect(discoverProjectRules(sandbox())).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* D：命中选择                                                         */
/* ------------------------------------------------------------------ */

describe("D 命中选择：只有带 paths 的规则参与，且给出原因", () => {
  const api = rule({ relPath: ".neo/rules/api.md", name: "api", paths: ["src/api/**"] });
  const web = rule({ relPath: ".neo/rules/web.md", name: "web", paths: ["src/web/**"] });
  const always = rule({ relPath: ".neo/rules/base.md", name: "base", paths: [] });

  test("触达路径命中 → 返回规则与原因", () => {
    const m = selectScopedRules([api, web, always], ["src/api/user.ts"]);
    expect(m.length).toBe(1);
    expect(m[0]!.rule.name).toBe("api");
    expect(m[0]!.reasons[0]).toContain("src/api/**");
    expect(m[0]!.reasons[0]).toContain("src/api/user.ts");
  });

  test("每会话规则不参与 scoped 选择（它已经在提示词里）", () => {
    expect(selectScopedRules([always], ["src/api/user.ts"])).toEqual([]);
  });

  test("同一规则多条路径命中 → 一条结果、多个原因", () => {
    const m = selectScopedRules([api], ["src/api/a.ts", "src/api/b.ts"]);
    expect(m.length).toBe(1);
    expect(m[0]!.reasons.length).toBe(2);
  });

  test("未触达 → 空；路径先归一（绝对/./）", () => {
    expect(selectScopedRules([api], ["src/web/a.ts"])).toEqual([]);
    const cwd = "/repo";
    const m = selectScopedRules([api], ["/repo/src/api/a.ts", "./src/api/b.ts"], { cwd });
    expect(m.length).toBe(1);
    expect(m[0]!.rule.name).toBe("api");
  });
});

/* ------------------------------------------------------------------ */
/* E：渲染与预算                                                       */
/* ------------------------------------------------------------------ */

describe("E 渲染与预算：带来源标注、超限截断", () => {
  test("每会话块带标题与来源；空列表返回空串", () => {
    const text = formatAlwaysOnRules([rule({ name: "base", body: "约定一号" })]);
    expect(text).toContain("项目规则");
    expect(text).toContain(".neo/rules/a.md");
    expect(text).toContain("约定一号");
    expect(formatAlwaysOnRules([])).toBe("");
  });

  test("scoped 块给出命中原因；空列表返回空串", () => {
    const m = selectScopedRules([rule({ name: "api", paths: ["src/api/**"], body: "接口约定" })], [
      "src/api/user.ts",
    ]);
    const text = formatScopedRulesBlock(m);
    expect(text).toContain("接口约定");
    expect(text).toContain("src/api/**");
    expect(formatScopedRulesBlock([])).toBe("");
  });

  test("单条超长截断并标注；总量超限也截断", () => {
    const huge = rule({ name: "huge", body: "x".repeat(9000) });
    const one = formatAlwaysOnRules([huge]);
    expect(one.length).toBeLessThan(RULE_MAX_ALWAYS_ON_CHARS + 500);
    expect(one).toContain("截断");

    const many = Array.from({ length: 20 }, (_, i) =>
      rule({ name: `r${i}`, relPath: `.neo/rules/r${i}.md`, body: "y".repeat(3000) }),
    );
    const all = formatAlwaysOnRules(many);
    expect(all.length).toBeLessThan(RULE_MAX_ALWAYS_ON_CHARS + 500);
    expect(all).toContain("截断");
    expect(RULE_MAX_SCOPED_CHARS).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* F：工具参数 → 触达路径                                              */
/* ------------------------------------------------------------------ */

describe("F 触达路径提取：只认明确带路径的工具参数", () => {
  const cwd = "/repo";

  test("read_file / write_file / edit_file 的 path 与 file_path", () => {
    expect(extractTouchedPaths("read_file", '{"path":"src/api/a.ts"}', cwd)).toEqual(["src/api/a.ts"]);
    expect(extractTouchedPaths("write_file", '{"file_path":"src/web/b.tsx"}', cwd)).toEqual(["src/web/b.tsx"]);
    expect(extractTouchedPaths("edit_file", '{"path":"/repo/src/api/a.ts"}', cwd)).toEqual(["src/api/a.ts"]);
  });

  test("list_dir / glob / grep 的 path", () => {
    expect(extractTouchedPaths("list_dir", '{"path":"src/api"}', cwd)).toEqual(["src/api"]);
    expect(extractTouchedPaths("glob", '{"pattern":"**/*.ts","path":"src/api"}', cwd)).toEqual(["src/api"]);
    expect(extractTouchedPaths("grep", '{"pattern":"foo","path":"src/api/a.ts"}', cwd)).toEqual(["src/api/a.ts"]);
  });

  test("未知工具 / 坏 JSON / 无路径 → 空数组（不猜 shell 里的路径）", () => {
    expect(extractTouchedPaths("shell", '{"command":"cat src/api/a.ts"}', cwd)).toEqual([]);
    expect(extractTouchedPaths("read_file", "{坏 json", cwd)).toEqual([]);
    expect(extractTouchedPaths("read_file", "{}", cwd)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* G：/context 报告                                                    */
/* ------------------------------------------------------------------ */

describe("G /context 报告文案", () => {
  test("没规则 → 一行说明「未发现规则」", () => {
    expect(rulesReport([], [], 0).join("\n")).toContain("未发现");
  });

  test("有规则 → 条数 + 命中原因（最多 3 条）", () => {
    const always = [rule({ name: "base" })];
    const matches = selectScopedRules(
      [rule({ name: "api", paths: ["src/api/**"] })],
      ["src/api/a.ts", "src/api/b.ts", "src/api/c.ts", "src/api/d.ts"],
    );
    const lines = rulesReport(always, matches, 2).join("\n");
    expect(lines).toContain("每会话 1 条");
    expect(lines).toContain("作用域 1 条");
    expect(lines).toContain("src/api/**");
  });
});
