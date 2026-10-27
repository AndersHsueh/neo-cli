/**
 * web_search 工具（v0.4.1 B4 / D3）。
 *
 * 背景：v0.4.1 之前只有 web_fetch，模型想搜只能抓 Bing 搜索结果 HTML，
 * 101 次工具调用里 0 次 web_fetch —— 门槛太高。这里给一个**无需 API key** 的
 * 搜索入口：Bing 中国站的 RSS 输出（cn.bing.com/search?...&format=rss）。
 *
 * 约束：零依赖、纯文本解析；只在搜索失败时抛 ToolError，不吞成「没结果」。
 */
import { ToolError, type ToolCtx, type ToolImpl } from "./types.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decodeXml(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decodeXml(m[1] ?? "").trim() : "";
}

/** 解析 Bing RSS（`<item><title/><link/><description/></item>`）。坏条目跳过。 */
export function parseBingRss(xml: string): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  for (;;) {
    const m = re.exec(xml);
    if (!m) break;
    const block = m[1] ?? "";
    const title = stripTags(tag(block, "title"));
    const url = tag(block, "link").trim();
    const snippet = stripTags(tag(block, "description"));
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title, url, snippet: snippet.slice(0, 400) });
  }
  return out;
}

export function makeWebSearchTool(deps: { fetchImpl?: typeof fetch } = {}): ToolImpl {
  const doFetch = deps.fetchImpl ?? fetch;
  return {
    sensitive: false,
    kind: "evidence",
    spec: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "用 Bing（cn.bing.com RSS，无需 API key）搜索全网，返回标题/URL/摘要列表。适合查最新资料、" +
          "价格、版本、新闻、社区讨论。需要正文时再对结果 URL 用 web_fetch。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索关键词（中文/英文均可，1–200 字）" },
            count: { type: "integer", description: "返回条数 1–10，默认 5" },
          },
          required: ["query"],
        },
      },
    },
    async execute(args: Record<string, unknown>, _ctx: ToolCtx) {
      const query = String(args["query"] ?? "").trim();
      if (query.length === 0 || query.length > 200) {
        throw new ToolError(`query 长度必须在 1–200 字之间（当前 ${query.length}）`);
      }
      const rawCount = Number(args["count"] ?? 5);
      const count = Number.isFinite(rawCount) ? Math.min(10, Math.max(1, Math.trunc(rawCount))) : 5;
      const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${count}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          headers: {
            "User-Agent": "neo-cli/0.4 (+bun; search-rss)",
            Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        throw new ToolError(`搜索请求失败：${(e as Error).message}`);
      }
      if (!res.ok) throw new ToolError(`搜索失败：HTTP ${res.status} ${res.statusText}`);
      const body = await res.text();
      if (!/<(?:rss|feed)\b/i.test(body)) {
        throw new ToolError("搜索返回的不是 RSS（Bing 可能限流或要求验证），请稍后重试或改用 web_fetch。");
      }
      const results = parseBingRss(body).slice(0, count);
      if (results.length === 0) {
        return `没有搜索结果：${query}\n（Bing RSS 可能限流；可直接 web_fetch https://cn.bing.com/search?q=…）`;
      }
      const lines = [`搜索：${query}（${results.length} 条，来源 cn.bing.com RSS）`];
      results.forEach((r, i) => {
        lines.push("", `${i + 1}. ${r.title}`, `   ${r.url}`);
        if (r.snippet) lines.push(`   ${r.snippet}`);
      });
      return lines.join("\n");
    },
  };
}

export const webSearchTool: ToolImpl = makeWebSearchTool();
