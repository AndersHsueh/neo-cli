/**
 * Matrix 主题层。
 * 全部使用 24 位真彩色（38;2;r;g;b），保证在真彩终端下呈现磷光绿。
 */
import { homedir } from "node:os";
import { VERSION } from "../cli/version.ts";

const esc = "\x1b[";
const RESET = `${esc}0m`;

function fg(r: number, g: number, b: number): string {
  return `${esc}38;2;${r};${g};${b}m`;
}
function bg(r: number, g: number, b: number): string {
  return `${esc}48;2;${r};${g};${b}m`;
}

export const colorEnabled = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
};

/** 调色板。raw 为不含转义的 RGB 三元组，方便做渐变。 */
export const palette = {
  phosphor: [0, 255, 65] as const,       // 经典磷光绿
  dimGreen: [0, 143, 17] as const,
  midGreen: [0, 200, 52] as const,
  iceGreen: [180, 255, 190] as const,   // 高亮亮绿
  deadGreen: [0, 60, 20] as const,       // 网格/暗纹
  amber: [255, 176, 0] as const,        // 警告
  red: [255, 85, 85] as const,          // 错误
  cyan: [0, 220, 220] as const,         // 工具名
  magenta: [200, 120, 255] as const,     // 强调
  white: [230, 255, 235] as const,
  grey: [130, 165, 140] as const,
  /** v0.4.2 tier 语义色：深思亮红 / 快速亮蓝 / 默认冰绿（平衡沿用 phosphor）。 */
  tierDeep: [255, 59, 48] as const,
  tierFast: [0, 200, 255] as const,
  tierDefault: [180, 255, 190] as const,
};

type Role = keyof typeof palette;

type Rgb = readonly [number, number, number];

const wrap = (role: Role) => (s: string): string =>
  colorEnabled() ? `${fg(...palette[role] as Rgb)}${s}${RESET}` : s;

/**
 * tier → RGB（v0.4.2）。
 * `deep_reasoning` 用亮红、`fast` 亮蓝、`balanced` 磷光绿、`default` 冰绿；
 * 未知 tier 回退到平衡绿，保证旧配置/别名不会无颜色。
 */
export function tierRgb(tier: string): Rgb {
  switch (tier) {
    case "deep_reasoning":
    case "deep":
      return palette.tierDeep;
    case "fast":
      return palette.tierFast;
    case "default":
    case "auto":
      return palette.tierDefault;
    default:
      return palette.phosphor;
  }
}

export const c = {
  reset: RESET,

  // 语义角色
  accent: wrap("phosphor"),
  dim: wrap("dimGreen"),
  mid: wrap("midGreen"),
  bright: wrap("iceGreen"),
  muted: wrap("grey"),
  text: wrap("white"),

  ok: wrap("phosphor"),
  warn: wrap("amber"),
  err: wrap("red"),
  tool: wrap("cyan"),
  think: wrap("dimGreen"),
  accentMagenta: wrap("magenta"),
  /** Matrix 绿（#00FF41）：剧情标题等语义化用法，与 accent 同色但表达不同含义。 */
  matrix: wrap("phosphor"),
  /** v0.4.2：档位语义色（deep 亮红 / balanced 绿 / fast 亮蓝 / default 冰绿）。 */
  tier: (tier: string, s: string): string =>
    colorEnabled() ? `${fg(...tierRgb(tier))}${s}${RESET}` : s,

  bold: (s: string): string => (colorEnabled() ? `${esc}1m${s}${RESET}` : s),
  dimAttr: (s: string): string => (colorEnabled() ? `${esc}2m${s}${RESET}` : s),
  /**
   * issue #18：输入框占位文案的语义色 —— 比正文暗、但仍可读。
   *
   * 为什么不是单纯 `dim`（dimGreen #008F11）：那档在深色终端上跟正文（白色）比
   * 已经够暗，但用户仍觉得「占位像内容」。这里再叠一层 SGR 2（faint），
   * 让占位明确退到背景层；grey 保证叠 faint 之后仍有对比度（不是纯黑）。
   * 只影响占位，正文/光标走 c.text + c.inverse，不受影响。
   */
  placeholder: (s: string): string =>
    colorEnabled() ? `${fg(...palette.grey)}${esc}2m${s}${RESET}` : s,
  italic: (s: string): string => (colorEnabled() ? `${esc}3m${s}${RESET}` : s),
  inverse: (s: string): string => (colorEnabled() ? `${esc}7m${s}${RESET}` : s),
  onAccent: (s: string): string =>
    colorEnabled() ? `${bg(0, 60, 20)}${fg(0, 255, 65)}${esc}1m${s}${RESET}` : s,

  raw: { fg, bg, RESET },
};

/** 呼吸式闪烁的 Matrix 字符序列。 */
export const GLYPHS = [
  "0", "1", "ｦ", "ｧ", "ｨ", "ｩ", "ｪ", "ｫ", "ｲ", "ｭ",
  "ﾐ", "ﾋ", "ﾉ", "ﾘ", "ﾔ", "ﾕ", "ｶ", "ﾁ", "ﾈ",
  "ﾂ", "ﾃ", "ﾍ", "ﾒ", "ﾆ", "ﾃ",
] as const;

/** 随机磷光字符（用于 spinner / 装饰）。 */
export function glyph(): string {
  return GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "0";
}

/** 生成一条水平分隔线。 */
export function rule(width = 64, ch = "─"): string {
  return c.dim(ch.repeat(Math.max(0, width)));
}

/* ------------------------------------------------------------------ */
/* 启动横幅（issue #83：圆角框线卡片）                                  */
/* ------------------------------------------------------------------ */

/** 卡片外宽上限：终端再宽也只画到 80 列。 */
const BANNER_MAX_WIDTH = 80;

/** 有框阈值（含 40）：再窄就退化成无框纯文本，不硬画对不齐的框线。 */
const BANNER_BOX_MIN_WIDTH = 40;

/** 卡片内左右留白（框线以内各 1 列）。 */
const BANNER_PAD = 1;

/** 一行轻提示，文案固定。 */
const BANNER_HINT = "/help 查看命令 · ? 快捷键 · Shift+Tab 切换模式";

/** 启动横幅的输入。列数 / cwd / 工具数 / MCP server 数都由组合根给。 */
export type BannerOptions = {
  model: string;
  baseUrl: string;
  providerName?: string;
  modelTier?: string;
  /**
   * 终端列数。0 / undefined / 非正或按 Console 口径异常的值回落 80
   * （与 `Console.width` 一致：`n > 20` 才采信）。
   */
  columns?: number;
  cwd?: string;
  /** 对用户可见的工具数（与 `/tools` 同口径，不含仅目录的 MCP 工具）。 */
  toolCount?: number;
  /** 已配置的 MCP **server** 数（不是 `mcp__*` 工具数）。 */
  mcpServerCount?: number;
  /** `~` 缩写用的 home；缺省 `os.homedir()`。 */
  home?: string;
};

/** 终端列数 → 卡片外宽。口径与 `Console.width` 一致：`n > 20` 才采信。 */
function bannerOuterWidth(columns: number | undefined): number {
  const n = columns;
  const cols = typeof n === "number" && n > 20 ? n : BANNER_MAX_WIDTH;
  return Math.min(cols, BANNER_MAX_WIDTH);
}

/**
 * 路径展示：先把 home 缩成 `~`，再按可用列数做中间省略。
 *
 * 省略保留「头两段 + 末段」：用户认的是末段目录名，而头部能说明盘符/根目录。
 * 末段本身放不下时退回首段 + 省略号，绝不把整条路径截成无信息的前缀。
 */
function shortenHomePath(p: string, home: string, max: number): string {
  const flat = p.replace(/\s+/g, " ").trim();
  const h = home.replace(/\/+$/, "");
  let s = flat;
  if (h !== "" && (flat === h || flat.startsWith(`${h}/`))) s = `~${flat.slice(h.length)}`;
  if (displayWidth(s) <= max) return s;
  const parts = s.split("/");
  if (parts.length <= 2) return truncate(s, max);
  const tail = parts.at(-1) ?? "";
  const head = parts.slice(0, 2).join("/");
  const short = `${head}/…/${tail}`;
  return displayWidth(short) <= max ? short : truncate(`${head}/…`, max);
}

/** 卡片内的一行内容：`label` 是固定的左栏，`value` 是可变值。 */
type BannerField = { label: string; value: string };

/** 运行信息与提示（无框时按原样输出，有框时套进卡片）。 */
function bannerFields(opts: BannerOptions): BannerField[] {
  const fields: BannerField[] = [];
  if (opts.providerName !== undefined) {
    const tier = opts.modelTier ? ` [${opts.modelTier}]` : "";
    fields.push({ label: "provider", value: `${opts.providerName}${tier}` });
  }
  fields.push({ label: "model", value: opts.model });
  fields.push({ label: "endpoint", value: hostOf(opts.baseUrl) });
  fields.push({ label: "cwd", value: opts.cwd ?? process.cwd() });
  return fields;
}

function bannerToolsSummary(opts: BannerOptions): string {
  return `${opts.toolCount ?? 0} tools · ${opts.mcpServerCount ?? 0} MCP`;
}

/** 首行：Matrix 绿品牌 + 版本号。 */
function bannerTitle(): string {
  return `${c.accent("neo")} ${c.dim(`v${VERSION}`)}`;
}

/**
 * 按显示列把一行文本折成多行（在 ` · ` 分隔处断，不切词）。
 *
 * 提示文案是契约原文，窄卡片里宁可折成两行也不能截成 `Shift+T…`。
 * 只在分隔符处断行，避免把 `Shift+Tab` 拆开。
 */
function wrapByWidth(s: string, max: number, sep = " · "): string[] {
  if (displayWidth(s) <= max) return [s];
  const parts = s.split(sep);
  const out: string[] = [];
  let cur = "";
  for (const part of parts) {
    const next = cur === "" ? part : `${cur}${sep}${part}`;
    if (cur !== "" && displayWidth(next) > max) {
      out.push(cur);
      // 分隔符跟到下一行开头，折行后仍能拼回原文（不丢 `·`）。
      const resumed = `${sep.trimStart()}${part}`;
      cur = displayWidth(resumed) <= max ? resumed : part;
    } else {
      cur = next;
    }
  }
  if (cur !== "") out.push(cur);
  // 单段本身就超宽（没有分隔符可断）：只能按列截断。
  return out.flatMap((l) => (displayWidth(l) <= max ? [l] : [truncate(l, max)]));
}

/**
 * 启动横幅（issue #83）：圆角框线卡片。
 *
 * 外宽 = `min(终端列数, 80)`；`< 40` 列退化为无框纯文本（仍含全部信息）。
 * 框线行去掉 ANSI 后的显示宽度恒等于外宽，右边框永远落在最后一列 ——
 * 内容一律先按 `displayWidth` 收敛到内宽再补空格，中文/emoji 不会把框顶歪。
 *
 * 底部固定以一个空格行结束（不是空串）：dock 的 wrapAnsi 会忽略尾部空串，
 * 空格行才能稳定落成空行，把输入框顶线隔开。
 */
export function banner(opts: BannerOptions): string {
  const width = bannerOuterWidth(opts.columns);
  const home = opts.home ?? homedir();
  const fields = bannerFields(opts);

  const lines: string[] = [];
  if (width < BANNER_BOX_MIN_WIDTH) {
    // 窄终端：不画框，但信息一条不少。无框行不必卡终端宽度，提示保持单行原文。
    lines.push(bannerTitle());
    for (const f of fields) {
      const value = f.label === "cwd" ? shortenHomePath(f.value, home, 1024) : f.value;
      lines.push(`${c.dim(`${f.label} `)}${c.text(value)}`);
    }
    lines.push(c.muted(BANNER_HINT));
    lines.push(c.muted(bannerToolsSummary(opts)));
  } else {
    // 提示是契约原文。40 列内宽不够一整行（原文 46 列）时按 ` · ` 折行，不截断。
    const room = width - 2 - BANNER_PAD * 2;
    const inner = room + BANNER_PAD * 2;
    const row = (body: string): string =>
      `${c.dim("│")}${" ".repeat(BANNER_PAD)}${padEndW(body, room)}${" ".repeat(BANNER_PAD)}${c.dim("│")}`;
    const labelWidth = Math.max(...fields.map((f) => displayWidth(f.label)));
    lines.push(c.dim(`╭${"─".repeat(inner)}╮`));
    lines.push(row(truncate(bannerTitle(), room)));
    for (const f of fields) {
      const label = c.dim(padEndW(f.label, labelWidth));
      const value = f.label === "cwd"
        ? c.text(shortenHomePath(f.value, home, room - labelWidth - 1))
        : c.text(f.value);
      lines.push(row(`${label} ${value}`));
    }
    for (const hint of wrapByWidth(BANNER_HINT, room)) lines.push(row(c.muted(hint)));
    lines.push(row(c.muted(bannerToolsSummary(opts))));
    lines.push(c.dim(`╰${"─".repeat(inner)}╯`));
  }
  // 底部用「一个空格行」而不是空串：dock 的 wrapAnsi 会忽略尾部空串。
  lines.push(" ");
  return lines.join("\n");
}

/** 从 URL 中提取 host，用于展示。 */
export function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

/**
 * 零宽 ANSI 转义，不占显示宽度。
 *
 * 只认 SGR（`\x1b[...m`）是不够的：OSC 序列（`\x1b]...BEL` / `\x1b]...ST`，超链接、
 * 窗口标题都用它）的正文是普通字符，漏掉就会被当成可见文本计入宽度。
 * 例：`\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\` 实际只显示 4 列，漏剥会算成 22 列。
 *
 * 覆盖：CSI（含 SGR）、OSC（BEL 或 ST 结尾）、以及两字符的 `\x1b<单字符>` 转义。
 */
const ANSI_ESCAPE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|\x1b/g;

/** combining / format 字符（宽度 0）。 */
const ZERO_WIDTH = /\p{Mn}|\p{Me}|\p{Cf}/u;

/** 是否 emoji 主体区（终端按 2 列渲染）。 */
function isEmojiBase(cp: number): boolean {
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) || // emoji / 补充符号
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) || // 区域指示符（国旗）
    (cp >= 0x1f3fb && cp <= 0x1f3ff) // 肤色修饰
  );
}

/**
 * 单个 code point 的显示宽度（近似 wcwidth）：
 * CJK/全角 2，emoji 2，combining/format/ZWJ/VS 0，其余 1。
 * 注意：VS16/ZWJ 需要 grapheme 级判断，见 `graphemeWidth` / `displayWidth`。
 */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f) return 0; // 控制字符不占显示列（换行/制表由上层处理）
  if (cp === 0x200b || cp === 0x200d) return 0; // 零宽空格 / ZWJ
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // variation selectors
  if (cp === 0x20e3) return 0; // combining enclosing keycap
  if (ZERO_WIDTH.test(ch)) return 0;
  if (isEmojiBase(cp)) return 2;
  return (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
    ? 2
    : 1;
}

/** grapheme cluster 切分（emoji ZWJ / 组合字符不拆开）。 */
const SEGMENTER: { segment(input: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? (new (Intl as unknown as { Segmenter: new (l?: string, o?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter(undefined, { granularity: "grapheme" }))
    : null;

export function graphemes(s: string): string[] {
  if (SEGMENTER) return Array.from(SEGMENTER.segment(s), (x) => x.segment);
  return Array.from(s);
}

/** 一个 grapheme cluster 的显示宽度（VS16/ZWJ/国旗/组合字符按终端实际列数）。 */
export function graphemeWidth(g: string): number {
  const cps = Array.from(g);
  if (cps.length === 0) return 0;
  if (cps.length === 1) return charWidth(cps[0] as string);
  // 国旗（两个区域指示符）整体 2 列
  if (cps.length === 2 && cps.every((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp >= 0x1f1e6 && cp <= 0x1f1ff;
  })) return 2;
  const hasVs16 = cps.includes("\ufe0f");
  const hasZwj = cps.includes("\u200d");
  const emojiBase = cps.some((c) => isEmojiBase(c.codePointAt(0) ?? 0));
  // 组合序列：所有码点都是 0 宽 → 0
  const allZero = cps.every((c) => charWidth(c) === 0);
  if (allZero) return 0;
  if (hasVs16 || hasZwj || emojiBase) return 2;
  // 其余（如 e + combining acute）：取 base 宽度
  return charWidth(cps[0] as string);
}

/** 终端可视宽度（忽略 ANSI；按 grapheme 计算，emoji/组合字符不低估）。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const g of graphemes(s.replace(ANSI_ESCAPE, ""))) w += graphemeWidth(g);
  return w;
}

export function padEndW(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/**
 * 按**显示列**截断（v0.2.3 D2）。
 *
 * 旧实现按 code unit 切：`truncate("中文内容很长的字符串", 10)` 返回 20 列，
 * 窄终端里右侧被折断、行对不齐。省略号本身占 1 列，故预算为 max-1。
 * 输入约定为纯文本；带 ANSI 着色时先剥掉转义再切（绝不切半个转义序列）。
 */
export function truncate(s: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return "";
  if (displayWidth(s) <= max) return s;
  const budget = max - 1;
  let out = "";
  let w = 0;
  for (const g of graphemes(s.replace(ANSI_ESCAPE, ""))) {
    const cw = graphemeWidth(g);
    if (w + cw > budget) break;
    out += g;
    w += cw;
  }
  return `${out}…`;
}
