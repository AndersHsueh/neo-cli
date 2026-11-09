/**
 * 核心逻辑单元测试。
 *
 * 覆盖 PRD 4.1 F1（工具 spec 正确）与本次修复的回归点。
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
  mainToolNames,
  globToRegExp,
  htmlToText,
  extractTitle,
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
/* F1：工具的 spec 与敏感标记                                     */
/* ------------------------------------------------------------------ */

describe("F1 工具集完整性", () => {
  // 主代理默认可见的工具（顺序即注册表顺序）。
  // issue #14：注册表尾部还有 submit_plan / exit_plan_mode，它们只在规划态
  // 进入工具清单（见 PLAN_CONTROL_TOOLS），因此默认清单用 mainToolNames()。
  const EXPECTED = [
    ["read_file", false],
    ["write_file", true],
    ["edit_file", true],
    ["list_dir", false],
    ["glob", false],
    ["grep", false],
    ["shell", true],
    ["shell_output", false],
    ["lsp", false],
    ["web_fetch", false],
    ["web_search", false],
    ["use_skill", false],
    ["compact_ctx", false],
  ] as const;

  /** 规划态控制工具：注册但默认不可见。 */
  const PLAN_ONLY = ["submit_plan", "exit_plan_mode"] as const;

  test("工具名与顺序符合注册表", () => {
    expect(mainToolNames()).toEqual(EXPECTED.map(([n]) => n));
  });

  test("规划态控制工具注册在尾部，且不在主代理默认清单里", () => {
    const all = toolNames();
    expect(all.slice(-PLAN_ONLY.length)).toEqual([...PLAN_ONLY]);
    for (const n of PLAN_ONLY) expect(mainToolNames()).not.toContain(n);
  });

  test("敏感标记与 PRD 2.1 表格一致", () => {
    const actual = new Map(TOOLS.map((t) => [t.spec.function.name, t.sensitive]));
    for (const [name, sensitive] of EXPECTED) {
      expect(`${name}=${actual.get(name)}`).toBe(`${name}=${sensitive}`);
    }
    // 规划态控制工具不产生写副作用，不算敏感动作。
    for (const n of PLAN_ONLY) expect(`${n}=${actual.get(n)}`).toBe(`${n}=false`);
  });

  test("每个 spec 都是合法的 function 定义且有 required", () => {
    for (const s of toolSpecs()) {
      expect(s.type).toBe("function");
      expect(s.function.name.length).toBeGreaterThan(0);
      expect(s.function.description.length).toBeGreaterThan(10);
      const params = s.function.parameters as { type?: string; required?: string[] };
      expect(params.type).toBe("object");
      expect(Array.isArray(params.required)).toBe(true);
      // compact_ctx 的 reason 是可选说明，不设必填；exit_plan_mode 的 reason 同理。
      if (s.function.name !== "compact_ctx" && s.function.name !== "exit_plan_mode") {
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

  test("new_string 里的 $ 替换模式按字面写入（P0-3）", async () => {
    // $&、$1、$$、$`、$' 在 String.replace 的第二参数里都是特殊模式；
    // edit_file 必须把它们当普通字符，否则会静默改写用户代码。
    const cases = ["$&", "$1", "$$", "$`", "$'"];
    for (const [i, pat] of cases.entries()) {
      const p = write(`dollar-${i}.txt`, "TOKEN");
      const replacement = `s.replace(/a/g, "${pat}")`;
      const r = await dispatch(
        "edit_file",
        JSON.stringify({ path: p, old_string: "TOKEN", new_string: replacement }),
        makeCtx(),
      );
      expect(r.ok).toBe(true);
      expect(readFileSync(p, "utf8")).toBe(replacement);
    }
  });

  test("replace_all 下 $& 同样按字面写入（P0-3）", async () => {
    const p = write("dollar-all.txt", "TOKEN\nTOKEN");
    const replacement = "x$&y";
    const r = await dispatch(
      "edit_file",
      JSON.stringify({ path: p, old_string: "TOKEN", new_string: replacement, replace_all: true }),
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(`${replacement}\n${replacement}`);
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

  // v0.4.11：glob 的 [!abc] 是「非 a/b/c」，旧实现原样塞进 RegExp 被读成
  // 字面量 `!` + `abc`，语义正好相反（d.ts 漏掉、a.ts 反被命中）。
  test("globToRegExp 字符类取反 [!...] 与 glob 语义一致", () => {
    expect(globToRegExp("[!abc].ts").test("d.ts")).toBe(true);
    expect(globToRegExp("[!abc].ts").test("a.ts")).toBe(false);
    expect(globToRegExp("[!abc].ts").test("!.ts")).toBe(true); // `!` 不在 a/b/c 里，属于取反集
    // [^...] 不是 glob 标准写法，但按取反处理，避免用户/模型误写时静默反义
    expect(globToRegExp("[^abc].ts").test("d.ts")).toBe(true);
    expect(globToRegExp("[^abc].ts").test("a.ts")).toBe(false);
    // 取反后类内为空 → 不匹配任何字符（不抛 SyntaxError）
    expect(() => globToRegExp("[!].ts")).not.toThrow();
    expect(globToRegExp("[!].ts").test("a.ts")).toBe(false);
  });

  test("globToRegExp 普通字符类与区间不受影响", () => {
    expect(globToRegExp("[a-c].ts").test("b.ts")).toBe(true);
    expect(globToRegExp("[a-c].ts").test("d.ts")).toBe(false);
    expect(globToRegExp("*.[ch]").test("a.c")).toBe(true);
    expect(globToRegExp("*.[ch]").test("a.ts")).toBe(false);
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

  test("grep 目录扫描超限文件必须明说跳过，不能静默假阴性", async () => {
    // 3MB 以上：内容里确实有 NEEDLE，若静默跳过就会谎报「无匹配」
    const big = "x".repeat(3_000_001) + "\nNEEDLE_IN_BIG\n";
    write("big/huge.log", big);
    const r = await dispatch(
      "grep",
      JSON.stringify({ pattern: "NEEDLE_IN_BIG", path: join(SANDBOX, "big") }),
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("无匹配");
    expect(r.output).toContain("文件过大，跳过");
    expect(r.output).toContain("huge.log");
  });

  test("grep 目录扫描有命中时也带上超限跳过说明", async () => {
    write("mix/huge.log", "y".repeat(3_000_001) + "\nNEEDLE_IN_BIG\n");
    write("mix/small.ts", "NEEDLE_IN_BIG");
    const r = await dispatch(
      "grep",
      JSON.stringify({ pattern: "NEEDLE_IN_BIG", path: join(SANDBOX, "mix") }),
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("small.ts:1:");
    expect(r.output).toContain("文件过大，跳过");
    expect(r.output).toContain("huge.log");
  });

  test("grep 单文件超限与目录扫描同一口径（都报文件过大）", async () => {
    const p = write("big2/huge.log", "z".repeat(3_000_001));
    const r = await dispatch("grep", JSON.stringify({ pattern: "zzz", path: p }), makeCtx());
    expect(r.ok).toBe(true);
    expect(r.output).toContain("文件过大");
    expect(r.output).toContain("跳过");
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

  // 标题与正文走同一套单次解码（v0.4.23）：旧版标题不解实体，
  // 输出里 `Title: A &amp; B` 与正文 `A & B` 并存，模型会把 `&amp;` 当原文抄走。
  test("extractTitle：解实体、剥标签、带属性", () => {
    expect(extractTitle("<html><head><title>A &amp; B</title></head></html>")).toBe("A & B");
    // 字面量标签的正规转义写法只解一次，停在字面量
    expect(extractTitle("<title>&amp;lt;b&amp;gt;y&amp;lt;/b&amp;gt;</title>")).toBe("&lt;b&gt;y&lt;/b&gt;");
    // 单层转义照常解码
    expect(extractTitle("<title>&lt;b&gt;x&lt;/b&gt;</title>")).toBe("<b>x</b>");
    // 标题里夹真标签：先剥后解，不会被当成标签剥掉内容
    expect(extractTitle("<title><b>neo</b> cli</title>")).toBe("neo cli");
    // 带属性的 title
    expect(extractTitle('<title lang="zh">你好</title>')).toBe("你好");
    // 数字实体与畸形实体
    expect(extractTitle("<title>it&#39;s &#x1F600;</title>")).toBe("it's 😀");
    expect(extractTitle("<title>&#1114112;</title>")).toBe("&#1114112;");
    // 空白折叠
    expect(extractTitle("<title>\n  a   b \n</title>")).toBe("a b");
  });

  test("extractTitle：无 title / 空 title 返回 null", () => {
    expect(extractTitle("<html><body>x</body></html>")).toBeNull();
    expect(extractTitle("<title></title>")).toBeNull();
    expect(extractTitle("<title>   </title>")).toBeNull();
  });

  test("rewriteSearchUrl: google/duckduckgo 搜索页改写到 cn.bing.com", () => {
    // google 带 q → 改写。空格的正规编码是 %20（encodeURIComponent 的输出）
    expect(rewriteSearchUrl("https://www.google.com/search?q=hello%20world")).toEqual({
      url: "https://cn.bing.com/search?q=hello%20world",
      note: expect.stringContaining("cn.bing.com"),
    });
    // duckduckgo 带 %20 → 改写
    expect(rewriteSearchUrl("https://duckduckgo.com/?q=neo%20cli")).toEqual({
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

  // 改写目标本身已是 cn.bing.com 时必须幂等（v0.4.26 修）
  test("rewriteSearchUrl: cn.bing.com 搜索页原样返回，不改写也不加 note", () => {
    // web_fetch 的 description 直接教模型拼 cn.bing.com/search?q=…，这条路径最常走
    expect(rewriteSearchUrl("https://cn.bing.com/search?q=neo+cli")).toEqual({
      url: "https://cn.bing.com/search?q=neo+cli",
      note: null,
    });
    // 旧实现里 bing 不在 isSearchHost 里，靠「无 q → 原样返回」侥幸通过；
    // 但带 q 的 bing 链接一旦进 isSearchHost 就会被改写成自身，会改写成自身
    // v0.4.26：www.bing.com 现在**应该**改写（与 cn.bing.com 不同域），
    // 这里只保证改写目标是 cn.bing.com 而非自身。
    expect(rewriteSearchUrl("https://www.bing.com/search?q=x").url).toBe(
      "https://cn.bing.com/search?q=x",
    );
  });

  // bing 主域要改写到 cn.bing.com（v0.4.26 修）
  test("rewriteSearchUrl: www.bing.com / bing.com 搜索页改写到 cn.bing.com", () => {
    // 模型凭习惯拼 www.bing.com，与 description 教的 cn.bing.com 不同域
    expect(rewriteSearchUrl("https://www.bing.com/search?q=neo")).toEqual({
      url: "https://cn.bing.com/search?q=neo",
      note: expect.stringContaining("cn.bing.com"),
    });
    // 裸域同样命中
    expect(rewriteSearchUrl("https://bing.com/search?q=neo%20cli&count=10").url).toBe(
      "https://cn.bing.com/search?q=neo%20cli&count=10",
    );
    // cn.bing.com 仍是幂等目标，不能被改写成自身
    expect(rewriteSearchUrl("https://cn.bing.com/search?q=neo")).toEqual({
      url: "https://cn.bing.com/search?q=neo",
      note: null,
    });
  });

  // 改写时保留原 URL 的其余查询参数（v0.4.26 修）
  test("rewriteSearchUrl: 保留 q 以外的查询参数", () => {
    expect(rewriteSearchUrl("https://www.google.com/search?q=neo&hl=en&num=20").url).toBe(
      "https://cn.bing.com/search?q=neo&hl=en&num=20",
    );
    // q 不在首位也一样
    expect(rewriteSearchUrl("https://duckduckgo.com/?kl=cn&q=neo").url).toBe(
      "https://cn.bing.com/search?q=neo&kl=cn",
    );
  });

  // 查询词里的字面 '+' 不能被当成空格（v0.4.26 修）
  test("rewriteSearchUrl: 字面 + 与 %2B 不被误解为空格", () => {
    // URL 里的 '+' 是字面加号（真正编码空格的是 %20），解成空格会把「c++」搜成「c  」
    expect(rewriteSearchUrl("https://www.google.com/search?q=c%2B%2B").url).toBe(
      "https://cn.bing.com/search?q=c%2B%2B",
    );
    // 未编码的 '+' 同样按字面保留
    expect(rewriteSearchUrl("https://www.google.com/search?q=c++").url).toBe(
      "https://cn.bing.com/search?q=c%2B%2B",
    );
    // 真正的空格（%20）仍解成空格
    expect(rewriteSearchUrl("https://www.google.com/search?q=neo%20cli").url).toBe(
      "https://cn.bing.com/search?q=neo%20cli",
    );
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

  // 外部网页里的畸形数字实体不该让整个 web_fetch 崩掉（v0.4.19）
  test("越界数字实体原样保留，不抛 RangeError", () => {
    expect(() => htmlToText("<p>&#1114112;</p>")).not.toThrow();
    expect(htmlToText("<p>&#1114112;</p>")).toBe("&#1114112;");
    expect(htmlToText("<p>&#99999999;</p>")).toBe("&#99999999;");
    // 代理区码点同样非法
    expect(htmlToText("<p>&#55357;</p>")).toBe("&#55357;");
  });

  test("合法数字实体照常解码（含 emoji）", () => {
    expect(htmlToText("<p>&#65;</p>")).toBe("A");
    expect(htmlToText("<p>&#128512;</p>")).toBe("😀");
  });

  // 与 decodeXml 对齐：网页里 &#x27; / &#x2F; 这类十六进制实体很常见（v0.4.19）
  test("解码十六进制实体", () => {
    expect(htmlToText("<p>it&#x27;s a&#x2F;b</p>")).toBe("it's a/b");
    expect(htmlToText("<p>&#x4F60;&#x597D;</p>")).toBe("你好");
    expect(htmlToText("<p>&#x1F600;</p>")).toBe("😀");
    // 大小写 x 与十六进制数字都要认
    expect(htmlToText("<p>&#X41;&#x6a;</p>")).toBe("Aj");
  });

  test("越界十六进制实体原样保留，不抛 RangeError", () => {
    expect(() => htmlToText("<p>&#x110000;</p>")).not.toThrow();
    expect(htmlToText("<p>&#x110000;</p>")).toBe("&#x110000;");
    expect(htmlToText("<p>&#xD83D;</p>")).toBe("&#xD83D;");
  });

  // NUL 会污染下游（模型上下文 / 终端 / JSON），且肉眼不可见（v0.4.21）
  test("NUL 实体原样保留，不产出 U+0000", () => {
    expect(htmlToText("<p>&#0;</p>")).toBe("&#0;");
    expect(htmlToText("<p>&#x0;</p>")).toBe("&#x0;");
    expect(htmlToText("<p>&#x0000;</p>")).toBe("&#x0000;");
    expect(htmlToText("<p>a&#0;b</p>")).not.toContain("\u0000");
  });

  // 与 web_search 的 decodeXml 共用 ./entities.ts，实体表不再漂移（v0.4.21）
  test("&apos; 与 XML 侧行为一致", () => {
    expect(htmlToText("<p>it&apos;s</p>")).toBe("it's");
  });

  // &#39; 必须走十进制数字实体（码点 39），不能塞进命名组抢匹配（v0.4.23 审阅修正）
  test("&#39; / &#x27; 解成单引号", () => {
    expect(htmlToText("<p>it&#39;s</p>")).toBe("it's");
    expect(htmlToText("<p>it&#x27;s</p>")).toBe("it's");
  });

  // 单次解码：命名实体与数字实体各扫一遍，解出的字符不再参与后续匹配（v0.4.23）
  test("实体只解一次：&amp;lt; / &amp;amp; / &amp;#65; 都停在字面量", () => {
    // 网页里字面量 <b>y</b> 的正规转义写法，必须原样保留成字面量
    expect(htmlToText("<p>&amp;lt;b&amp;gt;y&amp;lt;/b&amp;gt;</p>")).toBe("&lt;b&gt;y&lt;/b&gt;");
    // 比较符的双重转义
    expect(htmlToText("<p>a &amp;lt; b</p>")).toBe("a &lt; b");
    // &amp;amp; 停在 &amp;，不会一路解成 &
    expect(htmlToText("<p>&amp;amp;</p>")).toBe("&amp;");
    // &amp;#65; 停在 &#65;，不会解成 A（旧版行为是 A，属二次解码）
    expect(htmlToText("<p>&amp;#65;</p>")).toBe("&#65;");
    // 单层转义仍照常解码，不因修复而回退
    expect(htmlToText("<p>&lt;b&gt;x&lt;/b&gt;</p>")).toBe("<b>x</b>");
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
