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
};

type Role = keyof typeof palette;

type Rgb = readonly [number, number, number];

const wrap = (role: Role) => (s: string): string =>
  colorEnabled() ? `${fg(...palette[role] as Rgb)}${s}${RESET}` : s;

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

  bold: (s: string): string => (colorEnabled() ? `${esc}1m${s}${RESET}` : s),
  dimAttr: (s: string): string => (colorEnabled() ? `${esc}2m${s}${RESET}` : s),
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
  const title = "N E O";
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
    rule(76),
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

/** 终端可视宽度（近似：忽略 ANSI、宽字符算 2 列）。 */
export function displayWidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200b) continue;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

export function padEndW(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

export function truncate(s: string, max: number): string {
  // 负数/零宽度会让 slice 产生垃圾内容，必须短路
  if (!Number.isFinite(max) || max <= 0) return "";
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}
