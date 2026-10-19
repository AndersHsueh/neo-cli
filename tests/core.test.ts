/**
 * 核心逻辑单元测试。
 *
 * 覆盖 PRD 4.1 F1（10 个工具 spec 正确）与本次修复的回归点。
 * 运行：bun test
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  TOOLS,
  toolSpecs,
  toolNames,
  globToRegExp,
  htmlToText,
  rewriteSearchUrl,
  dispatch,
} from "../src/tools/index.ts";
import { estimateTokens } from "../src/llm.ts";
import { RuleClassifier } from "../src/classifier/rules.ts";
import { LlmClassifier } from "../src/classifier/llm.ts";
import { tierRank, TIER_ORDER } from "../src/classifier/types.ts";
import type { Config, ModelTier } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/index.ts";

/* ------------------------------------------------------------------ */
/* 测试脚手架                                                          */
/* ------------------------------------------------------------------ */

const SANDBOX = join(tmpdir(), `neo-test-${Date.now()}`);
mkdirSync(SANDBOX, { recursive: true });

function makeCtx(over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as Config,
    approve: async () => true,
    ...over,
  };
}

function write(path: string, content: string): string {
  const full = join(SANDBOX, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

function cleanup(): void {
  rmSync(SANDBOX, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ */
/* F1：10 个工具的 spec 与敏感标记                                     */
/* ------------------------------------------------------------------ */

describe("F1 工具集完整性", () => {
  const EXPECTED = [
    ["read_file", false],
    ["write_file", true],
    ["edit_file", true],
    ["list_dir", false],
    ["glob", false],
    ["grep", false],
    ["shell", true],
    ["web_fetch", false],
    ["use_skill", false],
    ["compact_ctx", false],
  ] as const;

  test("恰好 10 个工具，名称与顺序符合 PRD 2.1", () => {
    expect(toolNames()).toEqual(EXPECTED.map(([n]) => n));
  });

  test("敏感标记与 PRD 2.1 表格一致", () => {
    const actual = new Map(TOOLS.map((t) => [t.spec.function.name, t.sensitive]));
    for (const [name, sensitive] of EXPECTED) {
      expect(`${name}=${actual.get(name)}`).toBe(`${name}=${sensitive}`);
    }
  });

  test("每个 spec 都是合法的 function 定义且有 required", () => {
    for (const s of toolSpecs()) {
      expect(s.type).toBe("function");
      expect(s.function.name.length).toBeGreaterThan(0);
      expect(s.function.description.length).toBeGreaterThan(10);
      const params = s.function.parameters as { type?: string; required?: string[] };
      expect(params.type).toBe("object");
      expect(Array.isArray(params.required)).toBe(true);
      // compact_ctx 的 reason 是可选说明，不设必填；其余工具至少一个必填参数。
      if (s.function.name !== "compact_ctx") {
        expect((params.required ?? []).length).toBeGreaterThan(0);
      }
    }
  });

  test("工具名唯一", () => {
    expect(new Set(toolNames()).size).toBe(toolNames().length);
  });
});

/* ------------------------------------------------------------------ */
/* 工具行为                                                            */
/* ------------------------------------------------------------------ */

describe("read_file", () => {
  test("带行号输出，offset/limit 生效", async () => {
    const p = write("r.txt", "l1\nl2\nl3\nl4\nl5");
    const r = await dispatch("read_file", JSON.stringify({ path: p, offset: 2, limit: 2 }), makeCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("l2");
    expect(r.output).toContain("l3");
    expect(r.output).not.toContain("l1");
    expect(r.output).toContain("还有 2 行未显示");
  });

  test("文件不存在时报错并给出路径", async () => {
    const r = await dispatch("read_file", JSON.stringify({ path: join(SANDBOX, "nope.txt") }), makeCtx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("文件不存在");
  });

  test("非法 JSON 参数不抛异常", async () => {
    const r = await dispatch("read_file", "{not json", makeCtx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("不是合法 JSON");
  });

  test("未知工具返回可用清单", async () => {
    const r = await dispatch("nope", "{}", makeCtx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("未知工具");
  });
});

describe("edit_file 唯一性校验（PRD S4）", () => {
  test("old_string 出现多次时报错", async () => {
    const p = write("e.txt", "a\nX\nb\nX\nc");
    const r = await dispatch(
      "edit_file",
      JSON.stringify({ path: p, old_string: "X", new_string: "Y" }),
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("不唯一");
  });

  test("replace_all 可全量替换", async () => {
    const p = write("e2.txt", "X\nX");
    const r = await dispatch(
      "edit_file",
      JSON.stringify({ path: p, old_string: "X", new_string: "Y", replace_all: true }),
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("Y\nY");
  });

  test("找不到 old_string 时报错", async () => {
    const p = write("e3.txt", "abc");
    const r = await dispatch("edit_file", JSON.stringify({ path: p, old_string: "zzz", new_string: "y" }), makeCtx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("找不到");
  });

  test("审批拒绝时不写文件", async () => {
    const p = write("e4.txt", "keep");
    const r = await dispatch(
      "edit_file",
      JSON.stringify({ path: p, old_string: "keep", new_string: "gone" }),
      makeCtx({ approve: async () => false }),
    );
    expect(r.output).toContain("用户拒绝");
    expect(readFileSync(p, "utf8")).toBe("keep");
  });
});

describe("write_file", () => {
  test("自动创建父目录", async () => {
    const p = join(SANDBOX, "deep/nested/new.txt");
    const r = await dispatch("write_file", JSON.stringify({ path: p, content: "hi" }), makeCtx());
    expect(r.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("hi");
  });

  test("审批拒绝时不创建文件", async () => {
    const p = join(SANDBOX, "nope2/x.txt");
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: p, content: "hi" }),
      makeCtx({ approve: async () => false }),
    );
    expect(r.output).toContain("用户拒绝");
    expect(() => readFileSync(p, "utf8")).toThrow();
  });
});

describe("glob / grep", () => {
  test("globToRegExp 支持 ** 通配", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/c.css")).toBe(false);
  });

  test("globToRegExp 支持 {a,b} 与 ?", () => {
    expect(globToRegExp("*.{ts,js}").test("a.ts")).toBe(true);
    expect(globToRegExp("*.{ts,js}").test("a.py")).toBe(false);
    expect(globToRegExp("a?.txt").test("ab.txt")).toBe(true);
  });

  test("glob 找到文件", async () => {
    write("g/one.ts", "1");
    write("g/two.ts", "2");
    const r = await dispatch("glob", JSON.stringify({ pattern: "**/*.ts", path: join(SANDBOX, "g") }), makeCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("one.ts");
  });

  test("grep 命中并给出行号", async () => {
    write("s/x.ts", "line1\nNEEDLE\nline3");
    const r = await dispatch(
      "grep",
      JSON.stringify({ pattern: "NEEDLE", path: join(SANDBOX, "s") }),
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("x.ts:2:");
  });

  test("grep 支持单文件路径", async () => {
    const p = write("s/one.ts", "TARGET");
    const r = await dispatch("grep", JSON.stringify({ pattern: "TARGET", path: p }), makeCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("TARGET");
  });

  test("grep 非法正则给出可读错误", async () => {
    const r = await dispatch("grep", JSON.stringify({ pattern: "([", path: SANDBOX }), makeCtx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("正则表达式无效");
  });

  test("grep 跳过二进制文件（PRD 6.1）", async () => {
    write("b/bin.dat", "abc\u0000def");
    write("b/txt.ts", "abc");
    const r = await dispatch("grep", JSON.stringify({ pattern: "abc", path: join(SANDBOX, "b") }), makeCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("txt.ts");
    expect(r.output).not.toContain("bin.dat");
  });
});

describe("shell", () => {
  test("执行命令并返回退出码", async () => {
    const r = await dispatch("shell", JSON.stringify({ command: "echo hi" }), makeCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("hi");
    expect(r.output).toContain("[exit 0]");
  });

  test("非零退出码被如实报告", async () => {
    const r = await dispatch("shell", JSON.stringify({ command: "exit 3" }), makeCtx());
    expect(r.output).toContain("[exit 3]");
  });

  test("审批拒绝时不执行", async () => {
    const marker = join(SANDBOX, "should-not-exist");
    const r = await dispatch(
      "shell",
      JSON.stringify({ command: `touch ${marker}` }),
      makeCtx({ approve: async () => false }),
    );
    expect(r.output).toContain("用户拒绝");
    expect(() => readFileSync(marker)).toThrow();
  });

  test("空命令被拒", async () => {
    const r = await dispatch("shell", JSON.stringify({ command: "   " }), makeCtx());
    expect(r.ok).toBe(false);
  });
});

describe("web_fetch", () => {
  test("非 http(s) 协议被拒", async () => {
    const r = await dispatch("web_fetch", JSON.stringify({ url: "file:///etc/passwd" }), makeCtx());
    expect(r.ok).toBe(false);
    expect(r.output).toContain("http");
  });

  test("rewriteSearchUrl: google/duckduckgo 搜索页改写到 cn.bing.com", () => {
    // google 带 q → 改写
    expect(rewriteSearchUrl("https://www.google.com/search?q=hello+world")).toEqual({
      url: "https://cn.bing.com/search?q=hello%20world",
      note: expect.stringContaining("cn.bing.com"),
    });
    // duckduckgo 带 q → 改写
    expect(rewriteSearchUrl("https://duckduckgo.com/?q=neo+cli")).toEqual({
      url: "https://cn.bing.com/search?q=neo%20cli",
      note: expect.stringContaining("cn.bing.com"),
    });
    // 子域也命中（endsWith(".google.com")）
    expect(rewriteSearchUrl("https://scholar.google.com/search?q=x").url).toBe(
      "https://cn.bing.com/search?q=x",
    );
  });

  test("rewriteSearchUrl: 非搜索引擎与无 q 的 URL 原样返回", () => {
    // 普通网页不动
    expect(rewriteSearchUrl("https://example.com/page")).toEqual({
      url: "https://example.com/page",
      note: null,
    });
    // google 首页（无 q）不动
    expect(rewriteSearchUrl("https://www.google.com/")).toEqual({
      url: "https://www.google.com/",
      note: null,
    });
    // 非法 URL 原样返回
    expect(rewriteSearchUrl("not a url")).toEqual({ url: "not a url", note: null });
  });
});

describe("htmlToText", () => {
  test("剥离 script/style 与标签", () => {
    const out = htmlToText("<html><style>x{}</style><script>y()</script><p>Hello</p></html>");
    expect(out).toContain("Hello");
    expect(out).not.toContain("y()");
    expect(out).not.toContain("<p>");
  });

  test("解码实体", () => {
    expect(htmlToText("<p>a &amp; b &lt;c&gt;</p>")).toContain("a & b <c>");
  });
});

/* ------------------------------------------------------------------ */
/* estimateTokens —— CJK 修复回归（PRD 2.4）                            */
/* ------------------------------------------------------------------ */

describe("estimateTokens", () => {
  test("ASCII 按 4 字符/token", () => {
    // 400 字符 + 每条消息 4 token开销
    expect(estimateTokens([{ role: "user", content: "a".repeat(400) }])).toBe(105);
  });

  test("CJK 按 1.5 字符/token，不再退化成 ASCII 速率", () => {
    const ascii = estimateTokens([{ role: "user", content: "a".repeat(400) }]);
    const cjk = estimateTokens([{ role: "user", content: "中".repeat(400) }]);
    expect(cjk).toBe(272);
    // 关键回归：修复前两者相等（105 == 105）
    expect(cjk).toBeGreaterThan(ascii);
    expect(cjk / ascii).toBeGreaterThan(2.5);
  });

  test("中英混合按各自权重累加", () => {
    const mixed = estimateTokens([{ role: "user", content: "中".repeat(200) + "a".repeat(200) }]);
    expect(mixed).toBe(188);
  });

  test("工具 spec 也计入 token", () => {
    const withTools = estimateTokens([{ role: "user", content: "x".repeat(100) }], toolSpecs());
    expect(withTools).toBeGreaterThan(estimateTokens([{ role: "user", content: "x".repeat(100) }]));
  });

  test("空历史不崩溃", () => {
    // 空消息列表仍要把 tools 的 JSON 串算进去（此处为空数组 "[]"，2 字符 → 1 token）
    expect(estimateTokens([])).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(estimateTokens([]))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 规则分类器                                                          */
/* ------------------------------------------------------------------ */

describe("RuleClassifier", () => {
  const rc = new RuleClassifier();

  const ctx = (over: Partial<Parameters<typeof rc.classify>[0]> = {}) => ({
    userInput: "",
    contextUsage: 0.1,
    consecutiveToolFailures: 0,
    currentTier: "default" as ModelTier,
    tierAvailable: () => true,
    ...over,
  });

  test("override：/deep 显式升档（PRD 2.3 最高优先级）", async () => {
    const r = await rc.classify(ctx({ userInput: "/deep 分析这段代码" }));
    expect(r.tier).toBe("deep_reasoning");
    expect(r.source).toBe("override");
  });

  test("override：/fast 显式降档", async () => {
    const r = await rc.classify(ctx({ userInput: "/fast 列文件" }));
    expect(r.tier).toBe("fast");
  });

  test("PRD 3.4 三个示例场景判定正确", async () => {
    expect((await rc.classify(ctx({ userInput: "用 glob 找所有 .ts 文件" }))).tier).toBe("fast");
    expect((await rc.classify(ctx({ userInput: "帮我设计一下多租户架构" }))).tier).toBe("deep_reasoning");
    // 第三句无档位意图，维持当前
    expect((await rc.classify(ctx({ userInput: "上下文使用率多少了" }))).tier).toBe("default");
  });

  test("deep_strong 优先级高于 fast_signal", async () => {
    const r = await rc.classify(ctx({ userInput: "找出所有并发问题的根因" }));
    expect(r.tier).toBe("deep_reasoning");
    expect(r.reason).toContain("deep_strong");
  });

  test("tool_failure：连续失败升档", async () => {
    const r = await rc.classify(ctx({ consecutiveToolFailures: 3 }));
    expect(tierRank(r.tier)).toBeGreaterThan(tierRank("default"));
  });

  test("context_pressure：占用率高时升档", async () => {
    const r = await rc.classify(ctx({ contextUsage: 0.8 }));
    expect(r.tier).toBe("deep_reasoning");
  });

  test("无规则命中时维持当前档且 source=fallback", async () => {
    const r = await rc.classify(ctx({ userInput: "你好", currentTier: "balanced" }));
    expect(r.tier).toBe("balanced");
    expect(r.source).toBe("fallback");
  });

  test("每条判定都有可读理由（/why 的前提）", async () => {
    for (const s of ["用 glob 找所有 .ts 文件", "帮我设计架构", "列一下文件"]) {
      expect((await rc.classify(ctx({ userInput: s }))).reason.length).toBeGreaterThan(4);
    }
  });

  test("PRD R5：目标档不可用时只向上找，绝不向下", async () => {
    // deep 不可用，其余可用 → 应向上找到可用的更高档或维持，不掉到 fast
    const r = await rc.classify(
      ctx({ userInput: "帮我设计一下架构", tierAvailable: (t) => t !== "deep_reasoning" }),
    );
    expect(r.tier).not.toBe("fast");
    expect(r.tier).not.toBe("balanced");
  });

  test("长输入触发 long_input", async () => {
    const r = await rc.classify(ctx({ userInput: "x".repeat(600) }));
    expect(r.tier).toBe("balanced");
  });
});

/* ------------------------------------------------------------------ */
/* LLM 分类器 —— 失败不掉档（PRD R5）                                   */
/* ------------------------------------------------------------------ */

describe("LlmClassifier 兜底不降档", () => {
  // 不可达地址：必定走 catch 分支
  const deadCfg = {
    baseUrl: "http://127.0.0.1:9/v1",
    classifierProvider: "x",
    classifierModel: "y",
    providers: [],
  } as unknown as Config;

  const base = (currentTier: ModelTier) => ({
    userInput: "分析一下",
    contextUsage: 0.1,
    consecutiveToolFailures: 0,
    currentTier,
    tierAvailable: () => true,
  });

  test("LLM 失败时维持当前档，不掉到 default", async () => {
    const c = new LlmClassifier(deadCfg);
    for (const tier of TIER_ORDER) {
      const r = await c.classify(base(tier));
      expect(`${tier}=>${r.tier}`).toBe(`${tier}=>${tier}`);
    }
  });

  test("无可用候选档时维持当前档", async () => {
    const c = new LlmClassifier(deadCfg);
    const r = await c.classify({ ...base("deep_reasoning"), tierAvailable: () => false });
    expect(r.tier).toBe("deep_reasoning");
    expect(r.source).toBe("fallback");
  });

  test("分类失败不抛出异常（异常已被吞掉）", async () => {
    const c = new LlmClassifier(deadCfg);
    expect(typeof (await c.classify(base("default"))).reason).toBe("string");
  });
});

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

cleanup();
