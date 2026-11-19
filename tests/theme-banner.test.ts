/**
 * issue #83：启动 banner 改为圆角框线卡片。
 *
 * 契约：
 *  - 外宽 = min(终端列数, 80)；去掉 ANSI 后，框线行的 displayWidth 等于外宽；
 *  - 40 列是有框阈值（含 40）；< 40 列退化为无框纯文本，不画对不齐的 ╭╮╰╯；
 *  - 首行含 neo 标识与 package.json 版本；Matrix 绿作强调色，但不再用字符雨 / M.A.T.R.I.X / wake up, neo...；
 *  - 运行信息含 provider（name [tier]）、model、endpoint host、cwd（home 缩成 ~，过长中间省略）；
 *  - 提示原文钉死；tools 只出数量摘要 `N tools · M MCP`，不整行平铺工具名；
 *  - 底部以空格行结束（不是空串），方便 dock 把输入框顶线隔开；
 *  - NO_COLOR 下无颜色转义，框线仍对齐。
 *
 * banner() 的产品调用改为选项对象（列数 / cwd / 工具数 / MCP server 数等）。
 * 旧的 toolsText 平铺参数不再作为产品输出。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { VERSION } from "../src/cli/version.ts";
import { stripAnsi } from "../src/tui/ansi.ts";
import { GLYPHS, banner as bannerImpl, displayWidth, graphemes, hostOf } from "../src/ui/theme.ts";

/** issue #83 新卡片契约的调用形状。 */
export type BannerInput = {
  model: string;
  baseUrl: string;
  providerName?: string;
  modelTier?: string;
  columns?: number;
  cwd?: string;
  toolCount?: number;
  mcpServerCount?: number;
  home?: string;
};

const banner = (opts: BannerInput): string =>
  (bannerImpl as unknown as (opts: BannerInput) => string)(opts);

const HINT = "/help 查看命令 · ? 快捷键 · Shift+Tab 切换模式";
const RAIN = new Set<string>(GLYPHS);

const BASE: BannerInput = {
  model: "deepseek-flash",
  baseUrl: "https://api.example.com:8080/v1",
  providerName: "ipsa",
  modelTier: "default",
  columns: 80,
  cwd: "/tmp/demo",
  toolCount: 12,
  mcpServerCount: 0,
};

const envStack: Array<{ noColor: string | undefined; forceColor: string | undefined }> = [];

function pushColorEnv(opts: { noColor?: boolean; forceColor?: boolean }): void {
  envStack.push({ noColor: process.env["NO_COLOR"], forceColor: process.env["FORCE_COLOR"] });
  if (opts.noColor) process.env["NO_COLOR"] = "1";
  else delete process.env["NO_COLOR"];
  if (opts.forceColor) process.env["FORCE_COLOR"] = "1";
  else delete process.env["FORCE_COLOR"];
}

function popColorEnv(): void {
  const prev = envStack.pop();
  if (!prev) return;
  if (prev.noColor === undefined) delete process.env["NO_COLOR"];
  else process.env["NO_COLOR"] = prev.noColor;
  if (prev.forceColor === undefined) delete process.env["FORCE_COLOR"];
  else process.env["FORCE_COLOR"] = prev.forceColor;
}

afterEach(() => {
  while (envStack.length > 0) popColorEnv();
});

function plainOf(opts: BannerInput): string {
  return stripAnsi(banner(opts));
}

function linesOf(text: string): string[] {
  return text.split("\n");
}

function boxRows(text: string): string[] {
  return linesOf(text).filter((l) => /[╭╮╰╯│]/.test(l));
}

function looksLikeRain(line: string): boolean {
  const chars = graphemes(line.replace(/\s/g, ""));
  if (chars.length < 20) return false;
  const hits = chars.filter((ch) => RAIN.has(ch)).length;
  return hits / chars.length > 0.5;
}


/**
 * 提示原文钉死。80 列下是连续一行；40 列有框时原文 displayWidth 为 46，
 * 大于内宽，必须在 ` · ` 处折行，不能截断或加宽卡片。
 * 分段与去空白后的紧凑串都必须能拼回原文（折行时分隔符跟到下一行）。
 */
function expectPinnedHint(plain: string): void {
  for (const part of HINT.split(" · ")) expect(plain).toContain(part);
  const compact = (s: string) => s.replace(/[╭╮╰╯│─]/g, "").replace(/\s+/g, "");
  expect(compact(plain)).toContain(compact(HINT));
}

function expectSharedContract(plain: string, opts: BannerInput): void {
  expect(plain).toContain("neo");
  expect(plain).toContain(VERSION);
  expect(plain).not.toContain("M.A.T.R.I.X");
  expect(plain).not.toContain("wake up, neo");
  expect(plain).not.toContain("N E O");
  if (opts.providerName) {
    expect(plain).toContain(opts.providerName);
    if (opts.modelTier) expect(plain).toContain(`[${opts.modelTier}]`);
  }
  expect(plain).toContain(opts.model);
  expect(plain).toContain(hostOf(opts.baseUrl));
  expectPinnedHint(plain);
  expect(plain).toContain(`${opts.toolCount ?? 0} tools · ${opts.mcpServerCount ?? 0} MCP`);
  expect(plain.endsWith("\n ")).toBe(true);
  expect(linesOf(plain).at(-1)?.trim()).toBe("");
  expect(linesOf(plain).some((l) => looksLikeRain(l))).toBe(false);
  expect(plain).not.toContain("read_file");
  expect(plain).not.toContain("write_file");
  expect(plain).not.toContain("edit_file");
}

function expectBoxWidth(plain: string, width: number): void {
  const rows = boxRows(plain);
  expect(rows.length).toBeGreaterThanOrEqual(3);
  expect(rows[0]).toMatch(/╭/);
  expect(rows[0]).toMatch(/╮/);
  expect(rows.at(-1)).toMatch(/╰/);
  expect(rows.at(-1)).toMatch(/╯/);
  expect(rows.some((l) => l.includes("│"))).toBe(true);
  for (const row of rows) {
    expect(displayWidth(row)).toBe(width);
    const trimmed = row.trimEnd();
    // 右边框必须落在最后一列，不能被中文/emoji 顶歪。
    expect(/[╮╯│]/.test(trimmed.slice(-1))).toBe(true);
  }
}

describe("B1 启动 banner 圆角卡片（issue #83）", () => {
  test("B1a 80 列：框线闭合，行宽 80，含品牌/运行信息/提示/工具摘要，不含旧标题与字符雨", () => {
    const plain = plainOf(BASE);
    expectSharedContract(plain, BASE);
    expect(plain).toContain("/tmp/demo");
    expectBoxWidth(plain, 80);
  });

  test("B1b 120 列：外宽仍封顶 80", () => {
    const opts = { ...BASE, columns: 120 };
    const plain = plainOf(opts);
    expectSharedContract(plain, opts);
    expectBoxWidth(plain, 80);
    expect(boxRows(plain).every((l) => displayWidth(l) === 80)).toBe(true);
  });

  test("B1c 40 列：仍有框且右边框对齐（40 是阈值，不退化；提示按 · 折行）", () => {
    const opts = { ...BASE, columns: 40 };
    const plain = plainOf(opts);
    expectSharedContract(plain, opts);
    expectBoxWidth(plain, 40);
  });

  test("B1d 30 列：无框纯文本，不出现对不齐的框线", () => {
    const opts = { ...BASE, columns: 30 };
    const plain = plainOf(opts);
    expectSharedContract(plain, opts);
    expect(plain).not.toMatch(/[╭╮╰╯]/);
    expect(boxRows(plain)).toEqual([]);
  });

  test("B1e 39 列：同样无框，不退化出对不齐的 ╭╮╰╯", () => {
    const opts = { ...BASE, columns: 39 };
    const plain = plainOf(opts);
    expectSharedContract(plain, opts);
    expect(plain).not.toMatch(/[╭╮╰╯]/);
  });

  test("B1f 列数 0 / 缺省：按 Console 口径回落 80，仍画对齐的框", () => {
    for (const columns of [0, undefined]) {
      const opts = { ...BASE, columns };
      const plain = plainOf(opts);
      expectSharedContract(plain, opts);
      expectBoxWidth(plain, 80);
    }
  });

  test("B1g 不传 provider 时不出现 provider 行，但底部空格行仍在", () => {
    const opts: BannerInput = { ...BASE, providerName: undefined, modelTier: undefined };
    const plain = plainOf(opts);
    expect(plain).toContain("neo");
    expect(plain).toContain(VERSION);
    expect(plain).not.toContain("provider ");
    expect(plain).not.toContain("[default]");
    expect(plain.endsWith("\n ")).toBe(true);
    expectBoxWidth(plain, 80);
  });

  test("B1h 工具摘要随可见工具数与 MCP server 数变化，M=0 仍写出 0 MCP", () => {
    const a = plainOf({ ...BASE, toolCount: 12, mcpServerCount: 0 });
    const b = plainOf({ ...BASE, toolCount: 15, mcpServerCount: 3 });
    const c = plainOf({ ...BASE, toolCount: 8, mcpServerCount: 1 });
    expect(a).toContain("12 tools · 0 MCP");
    expect(b).toContain("15 tools · 3 MCP");
    expect(c).toContain("8 tools · 1 MCP");
    expect(a).not.toContain("15 tools");
    expect(b).not.toContain("12 tools · 0 MCP");
  });
});

describe("B1 路径展示与宽字符对齐（issue #83）", () => {
  test("B1i home 缩写成 ~，且右边框不错位", () => {
    const opts: BannerInput = {
      ...BASE,
      home: "/home/tester",
      cwd: "/home/tester/projects/neo-cli",
    };
    const plain = plainOf(opts);
    expectSharedContract(plain, opts);
    expect(plain).toContain("~/projects/neo-cli");
    expect(plain).not.toContain("/home/tester/projects/neo-cli");
    expectBoxWidth(plain, 80);
  });

  test("B1j 恰好等于 home 时整条缩成 ~", () => {
    const opts: BannerInput = { ...BASE, home: "/home/tester", cwd: "/home/tester" };
    const plain = plainOf(opts);
    expect(plain).toMatch(/(?:^|\s)~(?:\s|$)/m);
    expect(plain).not.toContain("/home/tester");
    expectBoxWidth(plain, 80);
  });

  test("B1k 过长路径中间省略，保留可识别的首尾，右边框对齐", () => {
    const home = "/home/tester";
    const leaf = "workspace";
    const cwd = `${home}/var/very/long/directory/tree/that/cannot/fit/in/a/narrow/banner/${leaf}`;
    const opts: BannerInput = { ...BASE, columns: 80, home, cwd };
    const plain = plainOf(opts);
    expectSharedContract(plain, opts);
    expect(plain).not.toContain(cwd);
    expect(plain).toContain("…");
    expect(plain).toContain(leaf);
    expect(plain).toContain("~");
    expectBoxWidth(plain, 80);
  });

  test("B1l 中文路径在 80 列下右边框不错位", () => {
    const opts: BannerInput = {
      ...BASE,
      home: "/home/tester",
      cwd: "/home/tester/项目/很长的中文目录名/工作区",
    };
    const plain = plainOf(opts);
    expectSharedContract(plain, opts);
    expect(plain).toContain("~");
    expect(plain).toContain("项目");
    expectBoxWidth(plain, 80);
  });

  test("B1m 含 emoji 的路径在 40 列下仍闭合对齐", () => {
    const opts: BannerInput = {
      ...BASE,
      columns: 40,
      home: "/home/tester",
      cwd: "/home/tester/docs/📁/notes-很长的补充目录名",
    };
    const plain = plainOf(opts);
    expectSharedContract(plain, opts);
    expectBoxWidth(plain, 40);
  });
});

describe("B1 NO_COLOR（issue #83）", () => {
  test("B1n NO_COLOR 下无颜色转义，框线仍对齐", () => {
    pushColorEnv({ noColor: true });
    const raw = banner(BASE);
    const plain = stripAnsi(raw);
    expect(raw).toBe(plain);
    expect(raw).not.toMatch(/\x1b\[/);
    expectSharedContract(plain, BASE);
    expectBoxWidth(plain, 80);
  });

  test("B1o 颜色开启时品牌/强调仍可带转义，但去色后行宽仍为 80", () => {
    pushColorEnv({ forceColor: true });
    const raw = banner(BASE);
    expect(raw).toMatch(/\x1b\[/);
    const plain = stripAnsi(raw);
    expectSharedContract(plain, BASE);
    expectBoxWidth(plain, 80);
  });
});
