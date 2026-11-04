/**
 * tui/status.ts — 底部常驻状态行：字段拼装 + 宽度降级（v0.3.0 S1/S2）。
 *
 * 纯函数，无 IO：输入是快照，输出是**可直接写终端的一行**（不折行是硬约束）。
 *
 * 版式（字段顺序固定，与优先级解耦）：
 *   `model · tier · mode · ⎇ branch · ctx ▓▓░░░ 42% · 0:42 · 12k tok`
 *
 * 宽度不足时按 priority **从低到高**丢字段（queue 30 → tokens 40 → branch 50 →
 * elapsed 60 → ctx 70 → mode 80 → tier 90 → model 100），但 `model` 与 `ctx` 是保底：
 * 两者仍超宽时用 `…` 截断 model（theme.truncate 按显示列切，CJK 也不会超宽）。
 *
 * 宽度口径统一走 `theme.displayWidth`（CJK=2、SGR=0 宽）；`⎇` 在该口径下是 1 列，
 * 故分支前缀 `⎇ ` 占 2 列。
 */
import { displayWidth, truncate } from "../ui/theme.ts";

export interface StatusSnapshot {
  /** 模型名，如 "deepseek-flash"。 */
  model: string;
  /** 档位，如 "balanced"。 */
  tier: string;
  /** 权限模式："ask" | "edit" | "yolo" | "plan"（缺省不显示）。 */
  mode?: string;
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
type Kind = "model" | "tier" | "mode" | "branch" | "ctx" | "elapsed" | "tokens" | "queue";

interface Built {
  kind: Kind;
  seg: StatusSegment;
}

/** 时长：<1h 用 `m:ss`，>=1h 用 `h:mm:ss`；负值按 0。 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

/**
 * token 数：<1e3 原样 → <1e4 一位小数 k → <1e6 整数 k → 其余一位小数 M。
 * 例：999 / 1.2k / 12k / 1.2M。不四舍五入跨档（9999 仍属一位小数档）。
 *
 * 档位边界必须「进位即升档」：9_999 的 toFixed(1) 是 "10.0"、999_999 的
 * Math.round 是 1000，若原样输出会得到 "10.0k"/"1000k" —— 既跨了档
 * （宽度突然多 2 列再缩回），又与下一档的 "10k"/"1.0M" 撞值。
 */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (v < 1_000) return String(v);
  if (v < 10_000) {
    const k = (v / 1_000).toFixed(1);
    return k === "10.0" ? "10k" : `${k}k`; // 9_950~9_999 进位到 10.0 → 降级整数档
  }
  if (v < 1_000_000) {
    const k = Math.round(v / 1_000);
    return k >= 1_000 ? `${(v / 1_000_000).toFixed(1)}M` : `${k}k`; // 999_500~999_999 → M 档
  }
  return `${(v / 1_000_000).toFixed(1)}M`;
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

  add("model", s.model, "accent", 100);
  add("tier", s.tier, "tier", 90);
  if (s.mode !== undefined && s.mode !== "") add("mode", s.mode, "text", 80);
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
      if (item.seg.priority < lowest) {
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
