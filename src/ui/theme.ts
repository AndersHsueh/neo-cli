/**
 * Matrix 主题层。
 * 全部使用 24 位真彩色（38;2;r;g;b），保证在真彩终端下呈现磷光绿。
 */

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

/**
 * Matrix 数字雨背景。单行版本 —— 供启动横幅使用，
 * 不做全屏动画，避免干扰 readline 的光标管理。
 */
export function digitalRain(rows = 6, cols = 78, seed = 0): string {
  const out: string[] = [];
  let s = seed || Date.now();
  const rand = () => {
    // 线性同余，避免 Math.random 在同帧内不可复现
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let i = 0; i < cols; i++) {
      const v = rand();
      let g: string;
      if (v > 0.94) g = c.bright(GLYPHS[Math.floor(rand() * GLYPHS.length)] ?? "0");
      else if (v > 0.6) g = c.accent(GLYPHS[Math.floor(rand() * GLYPHS.length)] ?? "1");
      else g = c.dim(GLYPHS[Math.floor(rand() * GLYPHS.length)] ?? "0");
      line += g;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** 启动横幅。toolsText 由组合根传入当前实际注册工具（含运行时工具）。 */
export function banner(
  model: string,
  baseUrl: string,
  providerName?: string,
  modelTier?: string,
  toolsText = "read_file write_file edit_file list_dir glob grep shell fetch",
): string {
  const title = "M.A.T.R.I.X";
  const sub = "wake up, neo... the matrix has you.";
  const host = hostOf(baseUrl);
  const providerLine =
    providerName === undefined
      ? ""
      : c.dim("  provider ") + c.accent(providerName) + (modelTier ? c.dim(` [${modelTier}]`) : "");
  const lines = [
    digitalRain(4, 76, 42),
    c.onAccent(`  ${title}  `) + c.dim("  ") + c.bright(sub),
    rule(76),
    providerLine,
    c.dim("  model  ") + c.accent(model),
    c.dim("  endpoint ") + c.muted(host),
    c.dim("  tools  ") + c.muted(toolsText),
    // 底部不再画第二条横线：输入框顶线就在下面，两条线贴太近会显得突兀。
    // 用「一个空格行」而不是空串：dock 的 wrapAnsi 会忽略尾部空串，空格行才能稳定落成空行。
    " ",
  ];
  return lines.filter((l) => l !== "").join("\n");
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
