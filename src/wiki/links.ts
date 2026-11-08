/**
 * wiki 链接语法 —— 提取与归一化的唯一真源。
 *
 * 为什么抽出来（issue #22）：`src/wiki/lint.ts` 早就有一套链接解析（剥别名/锚点/
 * .md 后缀、跳过代码块），但它只服务离线体检；`src/wiki/write.ts` 写入路径要校验
 * 链接目标存在性时需要同一套口径。若 write 复制一份或反向依赖 lint，两处口径迟早
 * 漂移——而「lint 说不断链、write 写进断链」正是 issue 要消灭的那类不一致。
 *
 * 口径与原 lint.ts 完全一致（对齐 sh 版）：
 *  - `[[目标|别名]]` / `[[目标#锚点]]` / `[[目标.md]]` → 纯页名；
 *  - 含 `/` 的路径式目标不是 wiki 页引用，归一化为空串，由调用方跳过；
 *  - 代码块（``` 围栏）与行内反引号内的链接不计。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface RawLink {
  /** 来源页 basename（含 .md）。 */
  src: string;
  /** 目标页名（已剥离别名/锚点/.md，未校验存在性）。 */
  target: string;
}

/* ------------------------------------------------------------------ */
/* 链接提取                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从 markdown 文本提取 [[链接]]。
 * 代码块（``` 围栏翻转状态）与行内反引号内的内容跳过。
 */
export function extractLinks(fileName: string, text: string): RawLink[] {
  const links: RawLink[] = [];
  let inCode = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    // 先剔除行内反引号片段，避免 [[...]] 出现在代码里被误计
    const cleaned = line.replace(/`[^`]*`/g, " ");
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const raw = m[1] ?? "";
      const target = normalizeLinkTarget(raw);
      if (target !== "") links.push({ src: fileName, target });
    }
  }
  return links;
}

/**
 * `[[目标|别名]]` / `[[目标#锚点]]` / `[[目标.md]]` → 纯页名，trim。
 * 含 `/` 的路径式目标返回空串（与 sh 版一致：不是页名）。
 */
export function normalizeLinkTarget(raw: string): string {
  let t = raw.split("|")[0] ?? "";
  t = t.split("#")[0] ?? "";
  t = t.trim();
  t = t.replace(/\.md$/, "");
  if (t.includes("/")) return ""; // [[../AGENTS]] 这类路径式链接不是 wiki 页引用
  return t;
}

/**
 * 抽取正文里的链接目标（去重，保留首次出现顺序）。
 * 归一化后为空串的路径式目标按 lint 口径跳过。
 */
export function extractLinkTargets(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of extractLinks("", text)) {
    if (seen.has(l.target)) continue;
    seen.add(l.target);
    out.push(l.target);
  }
  return out;
}
