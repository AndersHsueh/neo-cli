/**
 * web_fetch 工具：抓取 URL 为文本，并改写不可达的搜索引擎地址。
 */
import { decodeHtmlEntities } from "./entities.ts";
import { ToolError, type ToolImpl } from "./types.ts";

/**
 * 把不可达的搜索引擎 URL 改写到国内可达的 cn.bing.com。
 *
 * 背景：本机在中国境内，google.com / duckduckgo.com 均连接超时（实测 000）。
 * 模型可能凭习惯拼出这些 URL，这里兜底改写，避免白跑一次抓取。
 * 只改「搜索页」URL；普通网页抓取不受影响。
 *
 * v0.4.25 修三处口径问题：
 * 1. **幂等**：`cn.bing.com` 是改写目标，必须显式排除。旧版靠「bing 不在
 *    isSearchHost 里」侥幸不命中，但 web_fetch 的 description 恰恰教模型拼
 *    `cn.bing.com/search?q=…` —— 一旦有人把 bing 加进 isSearchHost，就会改写成
 *    自身并改写成自身。现在把「目标域名」写成显式排除，意图可读。
 * 2. **保留其余参数**：旧版只留 `q`，`&hl=en&num=20` 这类参数被静默丢弃。
 * 3. **`+` 是字面加号**：`URLSearchParams.get` 会把 `+` 解成空格，`?q=c++`
 *    被搜成 `c  `。这里手工取原始串，只把 `%20` 解成空格（`+` 保留为字面量）。
 */
export function rewriteSearchUrl(url: string): { url: string; note: string | null } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { url, note: null };
  }
  const host = u.hostname.toLowerCase();
  // 改写目标自身：幂等，原样返回（见上「1. 幂等」）
  if (host === "cn.bing.com" || host === "www.cn.bing.com") return { url, note: null };
  const isSearchHost =
    host === "www.google.com" ||
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "duckduckgo.com" ||
    host === "www.duckduckgo.com" ||
    host === "html.duckduckgo.com" ||
    host === "lite.duckduckgo.com" ||
    // bing 主域（v0.4.26）：模型常凭习惯拼 www.bing.com/search?q=…，
    // 与 description 教的 cn.bing.com 不是同一域名。cn.bing.com 已在上面排除，
    // 这里只收 bing.com / www.bing.com，避免把 cn 站改写成自身。
    host === "bing.com" ||
    host === "www.bing.com";

  if (!isSearchHost) return { url, note: null };

  // 提取查询词：google 与 duckduckgo 都用 q
  const q = rawQueryParam(u, "q");
  if (!q) return { url, note: null };

  // 保留 q 以外的参数（顺序不变），只替换 q 的值
  const rest = u.searchParams
    .entries()
    .filter(([k]) => k !== "q")
    .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .toArray()
    .join("");
  const next = `https://cn.bing.com/search?q=${encodeURIComponent(q)}${rest}`;
  return { url: next, note: `已将 ${host} 的搜索改写为 cn.bing.com` };
}

/**
 * 取查询串里某个参数的**原始值**，只解 `%XX`，不把 `+` 当空格。
 *
 * `URLSearchParams` 按 `application/x-www-form-urlencoded` 解析，`+` → 空格。
 * 但 URL 查询串里 `+` 是合法字面字符（空格的正规编码是 `%20`），`?q=c++`
 * 应该搜「c++」而不是「c  」。解码失败（畸形 `%`）时退回原文，不抛错。
 */
function rawQueryParam(u: URL, name: string): string | null {
  const search = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  for (const pair of search.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (safeDecodeURIComponent(key) !== name) continue;
    return eq === -1 ? "" : safeDecodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 从 HTML 里取 `<title>` 并解码实体；取不到返回 null。
 *
 * 为什么要单独抽出来（v0.4.23）：旧版在 web_fetch 里直接
 * `/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim()`，**没解实体**。
 * 于是 `<title>A &amp; B</title>` 输出成 `Title: A &amp; B`，而正文经
 * `htmlToText` 已是 `A & B` —— 同一份内容在输出里两种写法，模型容易把
 * `&amp;` 当成页面原文抄进回答。标题走同一套单次解码。
 *
 * 顺带把两个边角一并处理：`<title>` 里带属性（`<title lang="zh">`）能匹配；
 * 标题里夹标签（`<title><b>x</b></title>`）先剥标签再解码，与 htmlToText 同序
 * （先剥后解，避免解出的 `<` 被当标签剥掉）。
 */
export function extractTitle(html: string): string | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (raw === undefined) return null;
  const title = decodeHtmlEntities(raw.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return title === "" ? null : title;
}

export const webFetch: ToolImpl = {
  sensitive: false,
  kind: "evidence",
  parallelizable: true,
  spec: {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "抓取 URL 内容并转为纯文本（去除 HTML 标签）。适合查文档、读网页。\n" +
        "搜索时用 cn.bing.com：https://cn.bing.com/search?q=<关键词>（关键词需 URL 编码）。\n" +
        "不要用 google.com / duckduckgo.com——本机在中国境内，这两个域名不可达（已实测连接超时）。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "完整 URL（http/https）。搜索用 https://cn.bing.com/search?q=<关键词>",
          },
        },
        required: ["url"],
      },
    },
  },
  async execute(args) {
    const raw = String(args["url"] ?? "");
    if (!/^https?:\/\//i.test(raw)) throw new ToolError("url 必须以 http:// 或 https:// 开头");
    const { url, note } = rewriteSearchUrl(raw);
    const res = await fetch(url, {
      headers: { "User-Agent": "neo-cli/0.1 (+bun)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `抓取失败: HTTP ${res.status} ${res.statusText}`;
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = ct.includes("html") ? htmlToText(body) : body;
    const title = extractTitle(body);
    return [note, `URL: ${url}`, title ? `Title: ${title}` : "", "", text.slice(0, 60_000)]
      .filter((x) => x !== undefined && x !== null && x !== "")
      .join("\n");
  },
};

/**
 * 数字字符引用解码见 ./entities.ts（与 web_search 共用，v0.4.21 抽出）。
 */

/**
 * 极简 HTML → 文本。移除 script/style，块级标签转换行。
 *
 * 实体解码顺序有讲究：**先剥标签，再一次性解实体**（`decodeHtmlEntities`）。
 *
 * v0.4.23 修：旧版先链式解命名实体、再调 `decodeNumericEntities`，于是
 * `&amp;lt;b&amp;gt;` 被解两遍（→ `&lt;b&gt;` → `<b>`），`&amp;amp;` 一路解成 `&`、
 * `&amp;#65;` 解成 `A` —— 都是二次解码。现在命名与数字实体共用一次扫描：
 * `&amp;lt;b&amp;gt;` → `&lt;b&gt;`（字面量），`&amp;amp;` → `&amp;`，`&amp;#65;` → `&#65;`。
 * 与 web_search 的 `decodeXml` 行为对齐。
 */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "  • ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
