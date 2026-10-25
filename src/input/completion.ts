/**
 * input/completion.ts — 补全的纯逻辑（v0.2.4 C1/C2，无 IO）。
 *
 * 分两层：
 *  1. `triggerAt`：从「光标前的行内容」判断当前是否在补全上下文（`@` 文件 / `/` 命令）；
 *  2. `fuzzyScore` / `rankFiles` / `rankCommands`：子序列匹配 + 路径边界加权 + 确定性排序。
 *
 * 设计约束（PRD §1）：先做纯函数，等 M0 探针确认 readline 的 completer 能力后，
 * `index.ts` 只做「取索引 → completeLine → 返回 [matches, token]」的薄接线；
 * 若原生 completer 不可用，同一个 completeLine 也能喂给自绘候选。
 */

export interface CommandEntry {
  name: string;
  description: string;
}

export interface TriggerContext {
  kind: "file" | "command";
  /** 需要被替换的原文片段（含 `@` 或 `/`）。 */
  token: string;
  /** 查询串（不含触发符）。 */
  query: string;
  /** token 在行内的起始下标。 */
  start: number;
}

export interface CompleteInput {
  files: string[];
  commands: CommandEntry[];
  limit?: number;
  /** 光标位置（readline completer 只给整行时用行尾）。 */
  cursor?: number;
}

export interface CompleteResult {
  /** 替换用的完整候选（含 `@` / `/` 前缀）。 */
  matches: string[];
  /** 被替换的原文片段。 */
  token: string;
  /** token 在行内的起点（applyCompletion 直接用，避免二次解析分叉）。 */
  start: number;
}

/** 不命中哨兵。用 -Infinity 而不是 -1：`score - target.length` 可能恰好等于 -1。 */
export const NO_MATCH = Number.NEGATIVE_INFINITY;

/**
 * `@` 的合法前导：只要前一个字符不是「邮件本地部分字符」就算边界。
 * 这样 `a@b.com` 不误判，而中文用户最自然的 `读一下@src/a.ts`（无空格）也能触发。
 * references.ts 共用同一份判定。
 */
const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;

export function isAtBoundary(prev: string): boolean {
  return prev !== "@" && !EMAIL_LOCAL.test(prev);
}
/** 引用路径末尾可能粘上的标点，解析时剥掉。 */
const TRAILING_PUNCT = /[,.;:!?)\]}，。；：、！？]+$/;

function isBoundary(target: string, i: number): boolean {
  const prev = target[i - 1] ?? "";
  return prev === "/" || prev === "-" || prev === "_" || prev === ".";
}

/**
 * 解析补全触发上下文。cursor 之前的部分才参与判断（readline 可能把光标后的文本也给你）。
 * 无触发返回 null。
 */
export function triggerAt(line: string, cursor = line.length): TriggerContext | null {
  const head = line.slice(0, Math.max(0, Math.min(cursor, line.length)));

  // 命令：行首 `/` 且还没出现空白（正在敲命令名）
  const cmd = /^\/([^\s]*)$/.exec(head);
  if (cmd) return { kind: "command", token: head, query: cmd[1] ?? "", start: 0 };

  // 文件：最后一个 `@`，前面必须是边界，`@` 之后到光标不能有空白
  const at = head.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !isAtBoundary(head[at - 1]!)) return null;
  const query = head.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { kind: "file", token: head.slice(at), query, start: at };
}

/**
 * 模糊子序列打分：-1 = 不命中；否则分越高越优先。
 *
 * 加分：基础命中、连续命中、路径边界（`/ - _ .` 之后）、basename 内命中、
 *       前缀命中、命中结束在边界；扣分：目标越长越靠后（短名优先）。
 * 纯整数运算，同输入必同分 —— 排序确定性靠它，不靠 locale。
 */
export function fuzzyScore(query: string, target: string): number {
  return fuzzyScoreLower(query.toLowerCase(), target.toLowerCase());
}

/** 已小写化的打分内核（批量排序时避免每个候选都重新 toLowerCase）。 */
function fuzzyScoreLower(q: string, t: string): number {
  if (q === "") return 0;
  const basenameStart = t.lastIndexOf("/") + 1;

  let ti = 0;
  let score = 0;
  let prev = -2;
  for (const ch of q) {
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i;
        break;
      }
    }
    if (found === -1) return NO_MATCH;
    score += 10;
    if (found === prev + 1) score += 4; // 连续
    if (found === 0 || isBoundary(t, found)) score += 8; // 词边界
    if (found >= basenameStart) score += 2; // 命中在文件名内
    prev = found;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 20;
  // 命中结束在路径边界（目录名整段命中）比停在词中间更像用户想要的
  const after = t[prev + 1];
  if (after === undefined || after === "/" || after === "." || after === "-" || after === "_") score += 6;
  return score - t.length;
}

function cmpCandidate(a: [string, number], b: [string, number]): number {
  if (b[1] !== a[1]) return b[1] - a[1];
  if (a[0].length !== b[0].length) return a[0].length - b[0].length;
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/**
 * 有界 top-k：一边打分一边插入有序数组，只保留前 limit 个。
 * 与「全量 sort 再 slice」结果一致（同样的 cmpCandidate），但 2 万文件时省掉整体排序。
 */
function topK<T>(items: T[], limit: number, score: (item: T) => number, key: (item: T) => string): T[] {
  const max = Math.max(0, limit);
  if (max === 0) return [];
  const out: Array<[T, string, number]> = [];
  for (const item of items) {
    const s = score(item);
    if (s === NO_MATCH) continue;
    const k = key(item);
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const cur = out[mid]!;
      if (cmpCandidate([k, s], [cur[1], cur[2]]) < 0) hi = mid;
      else lo = mid + 1;
    }
    out.splice(lo, 0, [item, k, s]);
    if (out.length > max) out.pop();
  }
  return out.map(([item]) => item);
}

/** 文件候选排序（确定性）。空查询直接取前 limit 个（`@` 之后立刻 Tab 浏览的常见场景）。 */
export function rankFiles(query: string, files: string[], limit = 20): string[] {
  const max = Math.max(0, limit);
  if (query === "") return files.slice(0, max);
  const q = query.toLowerCase();
  return topK(files, max, (f) => fuzzyScoreLower(q, f.toLowerCase()), (f) => f);
}

/** 命令候选排序（按名称匹配）。 */
export function rankCommands(query: string, commands: CommandEntry[], limit = 20): CommandEntry[] {
  const max = Math.max(0, limit);
  if (query === "") return commands.slice(0, max);
  const q = query.toLowerCase();
  return topK(commands, max, (c) => fuzzyScoreLower(q, c.name.toLowerCase()), (c) => c.name);
}

/** 整行补全：给 readline completer（或自绘候选）用的最终结果。 */
export function completeLine(line: string, input: CompleteInput): CompleteResult | null {
  const ctx = triggerAt(line, input.cursor ?? line.length);
  if (!ctx) return null;
  // 命令候选不设 20 上限（COMMANDS 有 30+ 条，截断会让尾部命令永远搜不到）；
  // 文件候选仍限 20（几千条路径对终端没有意义）。
  const limit = input.limit ?? (ctx.kind === "command" ? input.commands.length : 20);
  if (ctx.kind === "command") {
    return {
      matches: rankCommands(ctx.query, input.commands, limit).map((c) => `/${c.name}`),
      token: ctx.token,
      start: ctx.start,
    };
  }
  return {
    matches: rankFiles(ctx.query, input.files, limit).map((f) => `@${f}`),
    token: ctx.token,
    start: ctx.start,
  };
}

/** 引用路径解析用：剥尾随标点（供 references.ts 复用，保持两边口径一致）。 */
export function stripTrailingPunct(s: string): string {
  return s.replace(TRAILING_PUNCT, "");
}

/** 补全插入结果：替换 token 后的整行 + 新光标位置。 */
export interface AppliedCompletion {
  line: string;
  cursor: number;
}

/**
 * 把第 index 个候选替换进整行（纯函数）。
 * `line` 是**已去掉 Tab 字符**的当前行；cursor 是去掉 Tab 后的光标位置。
 * 候选只替换 token 段，光标后可能还有用户已经打好的内容 —— 保持不动。
 */
export function applyCompletion(
  line: string,
  cursor: number,
  result: CompleteResult,
  index: number,
): AppliedCompletion {
  const match = result.matches[index];
  if (match === undefined || result.start < 0 || result.start > cursor) return { line, cursor };
  return applyMatch(line, cursor, result.start, match);
}

/** 把 [start, cursor) 这段替换成 match（Tab 连按循环也走这里，保证同一套替换语义）。 */
export function applyMatch(
  line: string,
  cursor: number,
  start: number,
  match: string,
): AppliedCompletion {
  if (start < 0 || start > cursor) return { line, cursor };
  return {
    line: `${line.slice(0, start)}${match}${line.slice(cursor)}`,
    cursor: start + match.length,
  };
}

/** 候选提示行（纯文本；调用方负责着色与前缀）。 */
export function formatCandidateHint(kind: "file" | "command", matches: string[], max = 8): string {
  const shown = matches.slice(0, max).join("  ");
  const more = matches.length > max ? `  … 还有 ${matches.length - max} 个` : "";
  const what = kind === "command" ? "命令" : "文件";
  return `${matches.length} 个${what}候选：${shown}${more}（继续按 Tab 循环）`;
}
