/**
 * tui/status.ts — 底部常驻状态行：字段拼装 + 宽度降级（v0.3.0 S1/S2）。
 *
 * 纯函数，无 IO：输入是快照，输出是**可直接写终端的一行**（不折行是硬约束）。
 *
 * 版式（字段顺序固定，与优先级解耦）：
 *   `v0.4.54 · model · tier · mode · ⎇ branch · ctx ▓▓░░░ 42% · 0:42 · 12k tok`
 *
 * mode 段在交互规划态（`/plan`，issue #14）显示 `planning · 规划中`，
 * 与只读闸门 `plan`（`/mode plan` / `--plan`）区分。
 *
 * 宽度不足时按 priority **从低到高**丢字段（queue 30 → todos 35 → tokens 40 → branch 50 →
 * elapsed 60 → ctx 70 → mode 80 → tier 90 → version/model 100），但 `model` 与 `ctx` 是保底：
 * 两者仍超宽时用 `…` 截断 model（theme.truncate 按显示列切，CJK 也不会超宽）。
 * `version` 与 `model` 同为 100，但**不保底**：窄屏先丢 version，再截 model。
 *
 * 宽度口径统一走 `theme.displayWidth`（CJK=2、SGR=0 宽）；`⎇` 在该口径下是 1 列，
 * 故分支前缀 `⎇ ` 占 2 列。
 */
import { clock, fixed1, rounded } from "../ui/format.ts";
import { displayWidth, truncate } from "../ui/theme.ts";

export interface StatusSnapshot {
  /** 版本号，如 "0.4.54"；显示在状态行最左（`v0.4.54`）。 */
  version: string;
  /** 模型名，如 "deepseek-flash"。 */
  model: string;
  /** 档位，如 "balanced"。 */
  tier: string;
  /** 权限模式："ask" | "edit" | "yolo" | "plan"（缺省不显示）。 */
  mode?: string;
  /**
   * 交互规划态（issue #14）：true 时 mode 段显示 `planning · 规划中`。
   *
   * 与 `mode: "plan"` 区分开 —— 后者是 `/mode plan` / `--plan` 的只读闸门，
   * 前者是 `/plan` 的交互规划工作流。两者生效的权限模式都是 plan，
   * 但用户要能一眼看出「我现在是在出方案，还是在只读」。
   */
  planning?: boolean;
  /** git 分支；null / 空 / 纯空白 = 不显示。 */
  branch?: string | null;
  /** 上下文占用比 0..1（>1 允许，显示时 clamp 并显示 ">100%"）。 */
  ctxUsage: number;
  /** 本轮已跑时长（ms）；非活动时可传上一轮的时长，仍会显示。 */
  elapsedMs: number;
  /** 是否在 turn 中：目前只影响 elapsed 的角色（活动/暗色）。 */
  active: boolean;
  /** 累计 prompt+completion token 数。 */
  tokensTotal: number;
  /** 排队消息数；>0 时追加 `⇥ N 排队`。 */
  queueCount?: number;
  /**
   * 待办短摘要（issue #10），如 `✓2/5`；null / 空串 = 不显示。
   * 优先级 35：比 queue(30) 先保留、比 tokens(40) 先丢 —— 窄屏时先丢「排队数」，
   * 因为待办是长任务的进度锚，排队数只是瞬时状态。
   */
  todosSummary?: string | null;
  /** 终端列数。 */
  width: number;
}

export interface StatusSegment {
  text: string;
  role: "accent" | "dim" | "muted" | "warn" | "text" | "tool" | "tier";
  priority: number;
}

const SEP = " · ";
const BAR_CELLS = 5;
const ELLIPSIS_WIDTH = 1;

/** 内部字段种类：用于识别保底字段（model / ctx）与丢弃目标。 */
type Kind = "version" | "model" | "tier" | "mode" | "branch" | "ctx" | "elapsed" | "tokens" | "queue" | "todos";

interface Built {
  kind: Kind;
  seg: StatusSegment;
}

/** 时长：<1h 用 `m:ss`，>=1h 用 `h:mm:ss`；负值按 0。 */
export function formatElapsed(ms: number): string {
  return clock(ms / 1000);
}

/**
 * token 数：一位小数档 / 整数档交替推进到 T。
 * 例：999 / 1.2k / 12k / 1.2M / 12M / 1.2G / 12G / 1.0T。
 * 不四舍五入跨档（9999 仍属一位小数档）。
 *
 * 档位边界必须「进位即升档」（纪律与实现在 ui/format.ts）：9_999 的
 * toFixed(1) 是 "10.0"、999_999 的 Math.round 是 1000，若原样输出会得到
 * "10.0k"/"1000k" —— 既跨了档（宽度突然多 2 列再缩回），又与下一档的
 * "10k"/"1.0M" 撞值。
 *
 * v0.4.31：M/G 档原先没有守这条纪律（9_999_999 → "10.0M"、999_999_999 →
 * "1000.0M"，且 1e9 以上一直显示 "1000.0M"），现按同一套「一位小数档 /
 * 整数档」交替推进，与 k 档同构。
 */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (v < 1_000) return String(v);
  if (v < 10_000) return `${fixed1(v / 1_000)}k`; // 9_950~9_999 进位到 10 → 降级整数档
  if (v < 1_000_000) {
    const k = rounded(v / 1_000);
    return k >= 1_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${k}k`; // 999_500~999_999 → M 档
  }
  // M 档：一位小数（<10M）→ 整数（<1000M），进位到 1000 升 G 档。
  if (v < 10_000_000) return `${fixed1(v / 1_000_000)}M`; // 9_950_000~9_999_999 → "10M"
  if (v < 1_000_000_000) {
    const m = rounded(v / 1_000_000);
    return m >= 1_000 ? `${(v / 1_000_000_000).toFixed(1)}G` : `${m}M`;
  }
  // G 档：一位小数（<10G）→ 整数（<1000G），进位到 1000 升 T 档。
  if (v < 10_000_000_000) return `${fixed1(v / 1_000_000_000)}G`;
  if (v < 1_000_000_000_000) {
    const g = rounded(v / 1_000_000_000);
    return g >= 1_000 ? `${(v / 1_000_000_000_000).toFixed(1)}T` : `${g}G`;
  }
  // T 档：一位小数（<10T）→ 整数（<1000T），进位到 1000 升 P 档。
  // v0.4.44：旧实现把 T 当末档直接 `fixed1(v / 1e12)`，于是 999_999_999_999_999
  // 与 1e15 都输出 "1000T" —— 既跨档（宽度多 1 列），又与「1.0P」数量级撞值。
  // 与 k/M/G 档同构补上 P 档；P 才是末档（十进制，1e15 起）。
  if (v < 10_000_000_000_000) return `${fixed1(v / 1_000_000_000_000)}T`;
  if (v < 1_000_000_000_000_000) {
    const t = rounded(v / 1_000_000_000_000);
    return t >= 1_000 ? `${(v / 1_000_000_000_000_000).toFixed(1)}P` : `${t}T`;
  }
  // P 档是末档：一位小数（<10P）→ 整数（≥10P），无处可升（与 formatBytes 的
  // 末档 P 同口径：进位到 1000 时保留原档，见 env/render.ts）。
  //
  // v0.4.45：v0.4.44 这里只写了 `fixed1(v / 1e15)`，漏了末档的「整数档」那一半。
  // fixed1 只把 10.0 降级成 10，不负责把 1000.0 收成整数，于是 1e18 输出 "1000P"、
  // 1e21 输出 "1000000P" —— 宽度随数量级无限增长，且与 k/M/G/T 档的两档结构不一致。
  // 末档与 k/M/G/T 档同构：<10 一位小数，≥10 整数。
  //
  // 已知未修：≥1e21 时 `Math.round` 返回原值、`String()` 走科学计数法（1e300 →
  // "1.0000000000000001e+285P"）。`toFixed(0)` 同样在 1e21 以上退化（JS 规范），
  // 要彻底解决得给末档封顶或做十进制展开 —— 属于改口径，见 v0.4.45 release note。
  if (v < 10_000_000_000_000_000) return `${fixed1(v / 1_000_000_000_000_000)}P`;
  return `${Math.round(v / 1_000_000_000_000_000)}P`;
}

/** 进度条：ratio clamp 到 0..1 后按格数四舍五入。默认 5 格、▓ 填充 / ░ 空白。 */
export function progressBar(ratio: number, cells = BAR_CELLS): string {
  const total = Number.isFinite(cells) ? Math.max(0, Math.floor(cells)) : 0;
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(r * total);
  return "▓".repeat(filled) + "░".repeat(total - filled);
}

/** ctx 文本里的百分比：取整；>100% 显示 ">100%"；负数/NaN 按 0%。 */
function ctxPercent(ratio: number): string {
  if (ratio > 1) return ">100%";
  const r = Math.min(1, Math.max(0, ratio));
  return `${Math.round(r * 100)}%`;
}

function build(s: StatusSnapshot): Built[] {
  const out: Built[] = [];
  const add = (kind: Kind, text: string, role: StatusSegment["role"], priority: number): void => {
    out.push({ kind, seg: { text, role, priority } });
  };

  add("version", `v${s.version}`, "muted", 100);
  add("model", s.model, "accent", 100);
  add("tier", s.tier, "tier", 90);
  if (s.planning === true) {
    // 规划态优先于权限模式：生效模式恒为 plan，但用户要看的是「在出方案」。
    add("mode", "planning · 规划中", "warn", 80);
  } else if (s.mode !== undefined && s.mode !== "") add("mode", s.mode, "text", 80);
  if (s.branch !== undefined && s.branch !== null && s.branch.trim() !== "") {
    add("branch", `⎇ ${s.branch}`, "muted", 50);
  }

  const ratio = Number.isFinite(s.ctxUsage) ? s.ctxUsage : 0;
  add(
    "ctx",
    `ctx ${progressBar(ratio)} ${ctxPercent(ratio)}`,
    ratio >= 0.9 ? "warn" : "dim",
    70,
  );

  add("elapsed", formatElapsed(s.elapsedMs), s.active ? "text" : "muted", 60);
  add("tokens", `${formatTokens(s.tokensTotal)} tok`, "dim", 40);

  // 待办摘要（issue #10）：priority 35 —— 窄屏时先于 tokens 被丢，后于 queue。
  // 版式上紧挨 tokens 之后、queue 之前，与「进度类字段聚在一起」的直觉一致。
  const todos = s.todosSummary ?? "";
  if (todos.trim() !== "") add("todos", todos, "dim", 35);

  const queue = s.queueCount ?? 0;
  if (queue > 0) add("queue", `⇥ ${queue} 排队`, "warn", 30);

  return out;
}

/** 字段列表（固定顺序；priority 供 renderStatus 做宽度降级）。 */
export function statusSegments(s: StatusSnapshot): StatusSegment[] {
  return build(s).map((b) => b.seg);
}

function isProtected(kind: Kind): boolean {
  return kind === "model" || kind === "ctx";
}

/** 保底兜底：只留 model · ctx；仍超宽则按显示列截断 model。 */
function clampToMinimum(built: Built[], limit: number): Built[] {
  const model = built.find((b) => b.kind === "model");
  const ctx = built.find((b) => b.kind === "ctx");
  if (!model || !ctx) return built.slice();

  // 极端窄终端：ctx 本身也放不下时先截 ctx，保证结果绝不超宽。
  const ctxBudget = Math.max(0, limit - SEP.length);
  const ctxText =
    displayWidth(ctx.seg.text) <= ctxBudget ? ctx.seg.text : truncate(ctx.seg.text, ctxBudget);
  if (ctxText === "") return [];

  const modelBudget = Math.max(0, limit - SEP.length - displayWidth(ctxText));
  if (modelBudget < ELLIPSIS_WIDTH) {
    return [{ ...ctx, seg: { ...ctx.seg, text: ctxText } }];
  }
  const modelText =
    displayWidth(model.seg.text) <= modelBudget
      ? model.seg.text
      : truncate(model.seg.text, modelBudget);

  return [
    { ...model, seg: { ...model.seg, text: modelText } },
    { ...ctx, seg: { ...ctx.seg, text: ctxText } },
  ];
}

/**
 * 渲染成一行纯文本（paint 缺省恒等）。
 *
 * 宽限字段：`version` 与 `model` 同为 priority 100，但**不参与保底**——
 * 窄终端下先丢 version 再截 model，保证模型名与 ctx 始终可读。
 * 丢弃循环按 priority 从低到高，version 排在 model 之后（同优先级时后者先被丢）。
 *
 * paint 只接收「保留下来」的字段文本；分隔符 `" · "` 不参与着色。
 * 宽度判定一律在**纯文本**上做 —— paint 若返回 SGR（零宽）不影响结果；
 * 若返回非 SGR 转义则由调用方自行保证零宽。
 */
export function renderStatus(
  s: StatusSnapshot,
  paint: (role: StatusSegment["role"], text: string) => string = (_role, text) => text,
): string {
  const built = build(s);
  const limit = Number.isFinite(s.width) ? Math.max(0, Math.floor(s.width)) : 0;
  const widthOf = (items: Built[]): number =>
    displayWidth(items.map((b) => b.seg.text).join(SEP));

  let keep = built.slice();
  while (widthOf(keep) > limit) {
    let dropAt = -1;
    let lowest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < keep.length; i++) {
      const item = keep[i];
      if (!item || isProtected(item.kind)) continue;
      // 同优先级时取靠后的字段：version 与 model 同为 100，窄屏先丢 version 再截 model。
      if (item.seg.priority <= lowest) {
        lowest = item.seg.priority;
        dropAt = i;
      }
    }
    if (dropAt === -1) break; // 只剩保底字段
    keep.splice(dropAt, 1);
  }

  if (widthOf(keep) > limit) keep = clampToMinimum(built, limit);

  return keep.map((b) => paint(b.seg.role, b.seg.text)).join(SEP);
}
