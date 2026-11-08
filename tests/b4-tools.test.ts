/**
 * v0.4.1 B4：D1 输出落盘 / D2 shell cwd / D3 web_search。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch, limitOutput } from "../src/tools/index.ts";
import { makeWebSearchTool, parseBingRss } from "../src/tools/webSearch.ts";
import type { Config } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "neo-b4-"));
const TMP_DIR = join(ROOT, "tooltmp");
process.env["NEO_TMP_DIR"] = TMP_DIR;
afterAll(() => {
  delete process.env["NEO_TMP_DIR"];
  rmSync(ROOT, { recursive: true, force: true });
});

function makeCfg(cwd: string): Config {
  return {
    cwd,
    toolOutputLimit: 30_000,
    shell: { path: null, login: false, args: null },
    env: {},
  } as unknown as Config;
}

function makeCtx(cwd: string): ToolCtx {
  return {
    cfg: makeCfg(cwd),
    approve: async () => true,
  };
}

describe("D1 超长输出落盘", () => {
  test("截断时把完整输出写到 NEO_TMP_DIR 并给出路径（0600）", () => {
    const cwd = join(ROOT, "spill");
    mkdirSync(cwd, { recursive: true });
    const full = `HEAD-${"x".repeat(200)}-TAIL`;
    const r = limitOutput(full, 80, makeCtx(cwd));
    expect(r.truncated).toBe(true);
    expect(r.output).toContain(TMP_DIR);
    expect(r.output).toContain("完整输出已落盘");
    expect(r.output).toContain("TAIL");
    const path = /落盘：(.+?)（/.exec(r.output)?.[1];
    expect(path).toBeTruthy();
    expect(existsSync(path!)).toBe(true);
    expect(readFileSync(path!, "utf8")).toBe(full);
    expect(statSync(path!).mode & 0o777).toBe(0o600);
  });

  test("plan 模式（readOnly）不落盘", () => {
    const cwd = join(ROOT, "spill-plan");
    mkdirSync(cwd, { recursive: true });
    const full = `HEAD-${"x".repeat(200)}-TAIL`;
    const r = limitOutput(full, 80, { ...makeCtx(cwd), readOnly: true });
    expect(r.truncated).toBe(true);
    expect(r.output).not.toContain("完整输出已落盘");
    expect(r.output).toContain("落盘失败");
  });

  test("未超限不落盘", () => {
    const cwd = join(ROOT, "spill2");
    mkdirSync(cwd, { recursive: true });
    const r = limitOutput("short", 80, makeCtx(cwd));
    expect(r.truncated).toBe(false);
    expect(r.output).toBe("short");
  });
});

// Windows 跳过原因（PD-1 Windows 实机验收前的已知豁免）：下面两个用例跑 `pwd`
// 并断言输出含 POSIX 风格相对路径 "shell/sub"（正斜杠）；Windows 侧 shell 工具
// 走 cmd/PowerShell，`pwd` 要么不存在（cmd）要么输出反斜杠绝对路径（PowerShell），
// 断言必然失败。恢复条件：PD-1 落地 Windows shell 约定后，把断言改成平台中立
// （归一化路径分隔符或按平台选命令），届时移除本 skipIf。
describe.skipIf(process.platform === "win32")("D2 shell cwd", () => {
  test("cwd 参数只影响本次调用（pwd 落在子目录）", async () => {
    const cwd = join(ROOT, "shell");
    mkdirSync(join(cwd, "sub"), { recursive: true });
    const r = await dispatch("shell", JSON.stringify({ command: "pwd", cwd: "sub" }), makeCtx(cwd));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("shell/sub");
  });

  test("cwd 不存在 → 明确报错", async () => {
    const cwd = join(ROOT, "shell2");
    mkdirSync(cwd, { recursive: true });
    const r = await dispatch("shell", JSON.stringify({ command: "pwd", cwd: "nope" }), makeCtx(cwd));
    expect(r.ok).toBe(false);
    expect(String(r.output)).toContain("cwd 不是目录");
  });
});

describe("D3 web_search", () => {
  const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title><![CDATA[Vue 3.5 发布]]></title><link>https://example.com/vue</link>
      <description><![CDATA[<b>Vue</b> 3.5 &amp; 性能提升]]></description></item>
    <item><title>Bad</title><link>not-a-url</link><description>x</description></item>
    <item><title>第二篇</title><link>https://example.com/two</link><description>摘要二</description></item>
  </channel></rss>`;

  test("parseBingRss：CDATA/实体/坏链接过滤", () => {
    const r = parseBingRss(RSS);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: "Vue 3.5 发布", url: "https://example.com/vue" });
    // CDATA：剥标签、不解实体 → 高亮去掉，&amp; 保留字面量（v0.4.27）
    expect(r[0]!.snippet).toContain("Vue 3.5 &amp; 性能提升");
    expect(r[1]!.title).toBe("第二篇");
  });

  // 畸形数字字符引用不该让整个 web_search 崩掉（v0.4.19）
  test("parseBingRss：越界数字实体原样保留，不抛 RangeError", () => {
    const mk = (t: string) =>
      `<rss><item><title>${t}</title><link>https://a.com/x</link></item></rss>`;
    expect(() => parseBingRss(mk("&#1114112;"))).not.toThrow();
    expect(parseBingRss(mk("&#1114112;"))[0]!.title).toBe("&#1114112;");
    expect(parseBingRss(mk("&#x110000;"))[0]!.title).toBe("&#x110000;");
    // 合法实体照常解码
    expect(parseBingRss(mk("&#x1F600;"))[0]!.title).toBe("😀");
  });

  // NUL 会污染下游，且肉眼不可见（v0.4.21，与 htmlToText 共用 entities.ts）
  test("parseBingRss：NUL 实体原样保留，不产出 U+0000", () => {
    const mk = (t: string) =>
      `<rss><item><title>${t}</title><link>https://a.com/x</link></item></rss>`;
    expect(parseBingRss(mk("&#0;"))[0]!.title).toBe("&#0;");
    expect(parseBingRss(mk("&#x0;"))[0]!.title).toBe("&#x0;");
    expect(parseBingRss(mk("a&#0;b"))[0]!.title).not.toContain("\u0000");
  });

  // 单次解码：转义后的字面量标签不能被二次解码成真标签再被剥掉（v0.4.22）
  test("parseBingRss：实体只解一次，&amp;lt;b&amp;gt; 保留为字面量", () => {
    const mk = (t: string) =>
      `<rss><item><title>${t}</title><link>https://a.com/x</link></item></rss>`;
    // 标题里的代码片段：字面量 <b>y</b> 的正规转义写法
    expect(parseBingRss(mk("&amp;lt;b&amp;gt;y&amp;lt;/b&amp;gt;"))[0]!.title).toBe("&lt;b&gt;y&lt;/b&gt;");
    // 比较符：a < b 的双重转义
    expect(parseBingRss(mk("a &amp;lt; b"))[0]!.title).toBe("a &lt; b");
    // &amp;amp; 停在 &amp;，不会一路解成 &
    expect(parseBingRss(mk("&amp;amp;"))[0]!.title).toBe("&amp;");
    // 单层转义仍照常解码（不因修复而回退）
    expect(parseBingRss(mk("&lt;b&gt;x&lt;/b&gt;"))[0]!.title).toBe("x");
    // url 侧同样只解一次
    const r = parseBingRss(
      `<rss><item><title>t</title><link>https://a.com/x?a=1&amp;amp;b=2</link></item></rss>`,
    );
    expect(r[0]!.url).toBe("https://a.com/x?a=1&amp;b=2");
  });

  // CDATA 是字面量段：段内实体不解码，也不能与段外拼出实体（v0.4.27）
  test("parseBingRss：CDATA 内容按字面量保留，段内实体不解码", () => {
    const mk = (t: string) =>
      `<rss><item><title>${t}</title><link>https://a.com/x</link></item></rss>`;
    // CDATA 里写什么就是什么，&amp; 不该变成 &
    expect(parseBingRss(mk("<![CDATA[a &amp; b]]>"))[0]!.title).toBe("a &amp; b");
    // 段内标签剥掉（Bing 高亮），实体字面量保留
    expect(parseBingRss(mk("<![CDATA[<b>x</b>]]>"))[0]!.title).toBe("x");
    // 段外实体照常解码，且与段内互不影响（段内的 &amp; 保持字面量）
    expect(parseBingRss(mk("&lt;i&gt;<![CDATA[&amp;]]>"))[0]!.title).toBe("&amp;");
    // 跨 CDATA 边界不能拼出实体：&am + p; 不是 &amp;
    expect(parseBingRss(mk("<![CDATA[&am]]>p;"))[0]!.title).toBe("&amp;");
    // 空 CDATA 与多段 CDATA 拼接
    expect(parseBingRss(mk("<![CDATA[]]>x<![CDATA[y]]>"))[0]!.title).toBe("xy");
  });

  test("工具返回格式化结果；count 生效", async () => {
    let seenUrl = "";
    const tool = makeWebSearchTool({
      fetchImpl: (async (url: string) => {
        seenUrl = String(url);
        return new Response(RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
      }) as unknown as typeof fetch,
    });
    const out = await tool.execute({ query: "vue 3.5", count: 1 }, makeCtx(ROOT));
    expect(seenUrl).toContain("format=rss");
    expect(out).toContain("搜索：vue 3.5");
    expect(out).toContain("Vue 3.5 发布");
    expect(out).not.toContain("第二篇"); // count=1
  });

  test("HTTP 错误 → ToolError", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: (async () => new Response("blocked", { status: 403 })) as unknown as typeof fetch,
    });
    await expect(tool.execute({ query: "x" }, makeCtx(ROOT))).rejects.toThrow("搜索失败");
  });

  test("返回 HTML 而非 RSS → 明确提示", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: (async () => new Response("<html>verify</html>", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(tool.execute({ query: "x" }, makeCtx(ROOT))).rejects.toThrow("不是 RSS");
  });

  test("query 为空/过长 → ToolError", async () => {
    const tool = makeWebSearchTool({
      fetchImpl: (async () => new Response(RSS)) as unknown as typeof fetch,
    });
    await expect(tool.execute({ query: "" }, makeCtx(ROOT))).rejects.toThrow("query 长度");
    await expect(tool.execute({ query: "x".repeat(201) }, makeCtx(ROOT))).rejects.toThrow("query 长度");
  });
});
