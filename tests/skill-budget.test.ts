/**
 * M 组 —— description 的 token 预算与三处输出一致性。
 *
 * 运行：bun test
 *
 * 覆盖：
 *   M1~M6  description 按 40 tokens 截断（PRD §9.4 修订）
 *   M7~M9  索引 / `/skills` 列表 / `/skills <名>` 详情三处形态逐字一致
 *
 * ============================================================================
 * 【为什么按 token 而不按字符】
 * ============================================================================
 * `estimateTokens`（src/llm.ts:302）的算法是 `CJK/1.5 + ASCII/4`：
 * 同样 40 tokens 能装 **60 个汉字**或**160 个英文字符**。
 * 按字符截断（比如统一 120 字符）会让中文描述被砍掉一半信息 ——
 * 120 字符的中文只值 80 tokens，却把 60 字的正常描述也一起砍了。
 *
 * ============================================================================
 * 【度量口径：必须扣掉每条消息的固定开销】
 * ============================================================================
 * `estimateTokens` 末尾有`messages.length * 4` 的固定开销（llm.ts:325），
 * 那是给**对话消息**算的，与「一段文本」无关。
 * 测试侧同样扣掉它 —— 否则 60 个汉字会被算成 44 tokens 而被误判超预算。
 * 两边口径必须一致，否则测试与实现在边界上打架。
 *
 * 本组不 spawn 子进程，纯函数级断言 —— 快且不受并发写文件影响。
 * 跨进程的一致性由 `tests/skills-cli.test.ts` 的 L 组负责。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeDescription,
  formatSkillLine,
  listSkillFiles,
  buildSkillIndex,
  describeSource,
} from "../src/skills.ts";
import { estimateTokens } from "../src/llm.ts";
import type { SkillMeta } from "../src/skills.ts";
import type { Config } from "../src/config.ts";

/** 与实现同口径的 token 度量：扣掉每条消息的固定开销。 */
const OVERHEAD = estimateTokens([{ role: "user", content: "" }], []);
const tok = (s: string): number => Math.max(0, estimateTokens([{ role: "user", content: s }], []) - OVERHEAD);

const BUDGET = 40;

function meta(name: string, description: string): SkillMeta {
  return {
    name,
    description,
    absPath: `/store/${name}`,
    linkPath: `/store/${name}`,
    source: "global",
    linked: false,
  };
}

describe("M. description 的 token 预算（PRD §9.4 修订）", () => {
  test("M1 中文 60 字（≈40 tokens）不截断", () => {
    const desc = "中".repeat(60);
    expect(tok(desc)).toBeLessThanOrEqual(BUDGET);
    const out = normalizeDescription(desc, "fb");
    expect(out).toBe(desc);
    expect(out).not.toContain("…");
  });

  test("M2 中文 200 字超预算 → 截断且带 …，结果仍在预算内", () => {
    const out = normalizeDescription("中".repeat(200), "fb");
    expect(out).toContain("…");
    expect(tok(out)).toBeLessThanOrEqual(BUDGET);
    expect(out.length).toBeLessThan(200);
  });

  test("M3 英文 160 字符（≈40 tokens）不截断", () => {
    const desc = "a".repeat(160);
    expect(tok(desc)).toBeLessThanOrEqual(BUDGET);
    const out = normalizeDescription(desc, "fb");
    expect(out).toBe(desc);
    expect(out).not.toContain("…");
  });

  test("M4 英文 400 字符超预算 → 截断且带 …，结果仍在预算内", () => {
    const out = normalizeDescription("a".repeat(400), "fb");
    expect(out).toContain("…");
    expect(tok(out)).toBeLessThanOrEqual(BUDGET);
    expect(out.length).toBeLessThan(400);
  });

  test("M5 边界：恰好 40 tokens 不截断，刚超 1 token 就截断", () => {
    // 逐字构造到恰好 40 tokens，验证「≤ 预算不截断」这条边界是精确的
    let exact = "";
    while (tok(exact) < BUDGET) exact += "中";
    expect(tok(exact)).toBe(BUDGET);
    expect(normalizeDescription(exact, "fb")).toBe(exact);

    const over = exact + "中";
    expect(tok(over)).toBeGreaterThan(BUDGET);
    expect(normalizeDescription(over, "fb")).toContain("…");
  });

  test("M6 截断后仍严格一行、含 …，且索引不产生第二行", () => {
    const idx = buildSkillIndex([meta("pdf", "中".repeat(200))]);
    const skillLines = idx.split("\n").filter((l) => l.startsWith("- "));
    expect(skillLines.length).toBe(1);
    expect(skillLines[0]?.endsWith("…")).toBe(true);
    // 换行必须先压平再截断，否则「一行一技能」被破坏
    expect(idx.includes("中\n")).toBe(false);
  });

  test("M6.1 含换行的超长描述：先压成单行再截断，不产生碎行", () => {
    const desc = Array.from({ length: 120 }, (_, i) => `第${i}行内容`).join("\n");
    const out = normalizeDescription(desc, "fb");
    expect(out).not.toContain("\n");
    expect(out).toContain("…");
    expect(tok(out)).toBeLessThanOrEqual(BUDGET);
  });

  test("M6.2 description 为空时回退到技能名，不产出空行", () => {
    const idx = buildSkillIndex([meta("pdf", ""), meta("docx", "   ")]);
    const lines = idx.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("- pdf：pdf");
    expect(lines[1]).toBe("- docx：docx");
  });
});

describe("M7. 三处输出形态一致（索引 / /skills 列表 / 详情）", () => {
  test("M7 formatSkillLine 是索引与列表的唯一形态来源", () => {
    const s = meta("pdf", "提取 PDF 文本与表格");
    expect(formatSkillLine("pdf", s.description)).toBe("- pdf：提取 PDF 文本与表格");
    // 索引里的那一行必须与 formatSkillLine 逐字相同
    const idx = buildSkillIndex([s]);
    expect(idx.split("\n")).toContain(formatSkillLine("pdf", s.description));
  });

  test("M8 索引与列表对超长描述采用同一截断结果（口径不分裂）", () => {
    const desc = "中".repeat(200);
    const line = formatSkillLine("pdf", desc);
    const idx = buildSkillIndex([meta("pdf", desc)]);
    // 列表侧调formatSkillLine 得到的就是索引里那一行 —— 同一函数保证不分裂
    expect(idx.split("\n")).toContain(line);
    expect(line).toContain("…");
  });

  test("M9 describeSource 的形态：来源：<名>（<source> / 软链|本地）", () => {
    const cfg = { cwd: "/tmp/x", skillsStore: "/tmp/store" } as unknown as Config;
    const s = meta("pdf", "d");
    expect(describeSource(cfg, s, false)).toBe("来源：pdf（global / 本地）");
    expect(describeSource(cfg, { ...s, linked: true }, true)).toBe("来源：pdf（global / 软链）");
    expect(describeSource(cfg, { ...s, source: "project" }, false)).toBe("来源：pdf（project / 本地）");
  });
});

/* ================================================================== */
/* N 组—— listSkillFiles 的软链处理（补零覆盖缺口）                    */
/* ================================================================== */

/**
 * N 组存在的原因：`listSkillFiles`（src/skills.ts:413）此前**零测试覆盖**，
 * 而它是 `use_skill` 输出「附件清单」的唯一数据来源。
 *
 * 变异实测（coverage-gap-filler 发现，我独立复现）：把 `isRealDir`
 * （原名 isDirTarget，simplify 阶段与 tools/system-prompt 的两份副本合并后统一改名）
 * 简化成 PRD §5.2 明令禁止的 `e.isDirectory() || e.isSymbolicLink()`，
 * **全量 180 个用例一个都不红** —— 该改动是零反馈的。
 *
 * 行为差异（实测）：
 *   现状：  ["brokenlink", "filelink.md", "realdir/a.md", "realfile.md"]
 *   简化后：["realdir/a.md", "realfile.md"]        ← 软链静默消失
 *
 * 危害不是「把文件软链当目录」（那被 readSkill 挡了），
 * 而是**附件清单漏掉文件软链与断链软链** ——
 * 模型据此以为「该技能没有附件」，而 glob 其实看得到。
 */
describe("N. listSkillFiles 的软链处理（零覆盖缺口）", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "neo-lsf-")));
  const dir = root;
  // 真实目录 + 真实文件
  mkdirSync(join(dir, "realdir"), { recursive: true });
  writeFileSync(join(dir, "realdir", "a.md"), "x", "utf8");
  writeFileSync(join(dir, "realfile.md"), "x", "utf8");
  // 指向文件的软链（合法，必须出现在清单里）
  symlinkSync(join(dir, "realfile.md"), join(dir, "filelink.md"));
  // 断链软链（目标已删除，仍应出现在清单里 —— 模型 glob 时也看得到它）
  symlinkSync(join(dir, "gone.md"), join(dir, "brokenlink"));
  const files = listSkillFiles(dir);

  test("N1 真实文件与真实目录内容都在清单里", () => {
    expect(files).toContain("realfile.md");
    expect(files).toContain("realdir/a.md");
  });

  test("N2 指向文件的软链必须出现在清单里（简化为 isSymbolicLink 会让它消失）", () => {
    expect(`清单=${JSON.stringify(files)}`).toContain("filelink.md");
    expect(files).toContain("filelink.md");
  });

  test("N3 断链软链必须出现在清单里（目标已删除，仍是既有路径的一部分）", () => {
    expect(`清单=${JSON.stringify(files)}`).toContain("brokenlink");
    expect(files).toContain("brokenlink");
  });

  test("N4 清单不含 SKILL.md 自身（它是正文，不是附件）", () => {
    //本组fixture 没有 SKILL.md；此用例守住「附件」语义边界
    expect(files.some((f) => f.endsWith("SKILL.md"))).toBe(false);
  });

  test("N5 清单是相对路径且不泄漏绝对路径前缀", () => {
    for (const f of files) {
      expect(f.startsWith("/")).toBe(false);
      expect(f.includes(dir)).toBe(false);
    }
  });

  // 清理放describe 内的 afterAll —— fixture 是 describe 作用域的局部变量，
  // 提到模块顶层会拿不到（且顶层 afterAll 会在收集阶段就绪，顺序不可控）
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});
