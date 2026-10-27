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
    expect(r[0]!.snippet).toContain("Vue 3.5 & 性能提升");
    expect(r[1]!.title).toBe("第二篇");
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
