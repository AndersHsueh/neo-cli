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
import { codePointToString, NAMED_ENTITIES } from "./entities.ts";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * XML 实体解码 —— **单次扫描**，解出的字符不再参与后续匹配。
 *
 * 反例（v0.4.22 修）：`&amp;lt;b&amp;gt;y&amp;lt;/b&amp;gt;` 是 RSS 里字面量
 * `<b>y</b>` 的正规写法（标题里的代码片段、比较符都这么转义）。旧实现是链式
 * `.replace()`：先 `&amp;`→`&`，再 `&lt;`→`<`，于是得到真标签 `<b>y</b>`，
 * 随后被 `stripTags` 的 `/<[^>]+>/g` 当标签剥掉，用户只看到 `y` —— 内容被静默吞掉。
 * 链式替换无论怎么排序都逃不掉（`&amp;` 放最后则 `&amp;amp;` 又错），
 * 只有一次扫描 + 单次解码才是对的。
 *
 * 数字实体走 `codePointToString`：越界 / 代理区 / NUL 原样保留（见 ./entities.ts）。
 */

/**
 * 一次扫描同时处理 CDATA 段与实体（v0.4.27）。
 *
 * 旧实现是「先 `replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1")` 脱壳，再整体解实体」，
 * 两个 bug 都出在这个顺序上：
 * 1. **CDATA 内实体被解码**：CDATA 的语义就是「字面量，不解实体」，
 *    `<![CDATA[a &amp; b]]>` 应原样输出 `a &amp; b`，旧版输出 `a & b`。
 * 2. **跨 CDATA 边界拼出实体**：`<![CDATA[&am]]>p;` 脱壳后拼成 `&amp;`，
 *    于是被解成 `&` —— 两个本不相邻的片段被拼成了一个实体。
 *
 * 修法是把 CDATA 也放进同一个正则：CDATA 段整体作为一个分支被**摘出来**，
 * 实体分支只可能从 CDATA 之外的原文里匹配，两个问题一起消失。
 */
const XML_TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|&(?:(amp|lt|gt|quot|apos|nbsp)|#([xX])([0-9a-fA-F]+)|#(\d+));/g;

/**
 * CDATA 段替换成私用区占位符（U+E000 + 序号），解码完再还原。
 *
 * 为什么不能「原样返回 CDATA 内容」：`decodeXml` 的输出还要过 `stripTags` 的
 * `/<[^>]+>/g`，CDATA 里的字面量 `<b>` 会当场被当标签剥掉 —— 与 v0.4.22 修的是
 * 同一类错误（解码/剥标签的顺序把字面量吃掉了）。占位符不含 `&` 也不含 `<`，
 * 安全穿过剥标签，最后由 `restoreCdata` 换回原文。
 *
 * 占位符用私用区码点：正常 RSS 里不会出现，且不会被实体正则或标签正则命中。
 */
const CDATA_PLACEHOLDER = "\uE000";

function decodeXml(s: string): string {
  const segments: string[] = [];
  const masked = s.replace(XML_TOKEN, (m, cdata: string | undefined, name, hex, hd, dec) => {
    if (cdata !== undefined) {
      segments.push(cdata);
      return `${CDATA_PLACEHOLDER}${segments.length - 1}${CDATA_PLACEHOLDER}`;
    }
    if (name) return NAMED_ENTITIES[name] ?? m;
    if (hex) return codePointToString(parseInt(hd ?? "", 16), m);
    return codePointToString(Number(dec), m);
  });
  return restoreCdata(masked, segments);
}

/** 把 `decodeXml` 埋下的 CDATA 占位符换回原文。 */
function restoreCdata(s: string, segments: string[]): string {
  if (segments.length === 0) return s;
  return s.replace(
    new RegExp(`${CDATA_PLACEHOLDER}(\\d+)${CDATA_PLACEHOLDER}`, "g"),
    (m, i: string) => segments[Number(i)] ?? m,
  );
}

function stripTags(s: string): string {
  const segments: string[] = [];
  // 先摘 CDATA：段内**不解实体**（字面量），但**剥标签**——Bing 摘要常用
  // CDATA 包 `<b>` 高亮，留给模型看字面量标签是噪声；实体字面量仍保留（v0.4.27）。
  const masked = s.replace(XML_TOKEN, (m, cdata: string | undefined, name, hex, hd, dec) => {
    if (cdata !== undefined) {
      segments.push(cdata.replace(/<[^>]+>/g, " "));
      return `${CDATA_PLACEHOLDER}${segments.length - 1}${CDATA_PLACEHOLDER}`;
    }
    if (name) return NAMED_ENTITIES[name] ?? m;
    if (hex) return codePointToString(parseInt(hd ?? "", 16), m);
    return codePointToString(Number(dec), m);
  });
  const stripped = masked
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return restoreCdata(stripped, segments).replace(/\s+/g, " ").trim();
}

/**
 * 取标签内**原文**，不解码 —— 解码由调用方做一次。
 *
 * v0.4.22 修：旧版 `tag()` 内部 `decodeXml`，而 `stripTags()` 又 `decodeXml` 一次，
 * 于是 `&amp;lt;b&amp;gt;` 被解两遍：第一遍 → `&lt;b&gt;`，第二遍 → `<b>`，
 * 再被 `/<[^>]+>/g` 当标签剥掉。单次解码必须由**调用链**保证，不能只靠函数内部。
 */
function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? (m[1] ?? "").trim() : "";
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
    const url = decodeXml(tag(block, "link")).trim();
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
