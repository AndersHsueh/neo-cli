/**
 * 技能管理测试（PRD skills-prd[done].md §7）。
 *
 * 隔离原则（PRD §7.3 强制）：
 *  - 全部路径基于 mkdtempSync 沙箱
 *  - 绝不读写真实 ~/.neo/skills/ —— store 路径一律通过 cfg.skillsStore 注入
 *  - 每个用例独立子目录：技能用例之间会互相污染（B2 需要「项目区是真目录」，
 *    若被 C3 建下的软链抢先占用就失效了）
 *  - macOS 上 tmpdir() 是 /var/folders/... 而 realpathSync 返回 /private/var/folders/...，
 *    断言里比较路径时两边都要过 realpath
 *
 * 运行：bun test
 */
import { describe, expect, test, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep, isAbsolute, dirname } from "node:path";

import { discoverSkills, parseFrontmatter, resolveSkill, buildSkillIndex } from "../src/skills.ts";
import type { SkillMeta } from "../src/skills.ts";
import { TOOLS, toolNames, dispatch } from "../src/tools/index.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import type { Config } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/index.ts";

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const ROOT = mkdtempSync(join(tmpdir(), "neo-skill-test-"));
const TMP_REAL = realpathSync(tmpdir());
const made: string[] = [];

/** 每个用例一个独立沙箱子目录，返回 realpath 后的 cwd 与 store 路径。 */
function sandbox(tag: string): { cwd: string; store: string } {
  const dir = realpathSync(mkdtempSync(join(ROOT, `${tag}-`)));
  const cwd = join(dir, "proj");
  const store = join(dir, "store");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(store, { recursive: true });
  made.push(dir);
  return { cwd, store };
}

function makeCtx(cwd: string, store: string, over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    cfg: { cwd, skillsStore: store, toolOutputLimit: 30_000 } as unknown as Config,
    approve: async () => true,
    ...over,
  };
}

function makeCfg(cwd: string, store: string): Config {
  return {
    cwd,
    skillsStore: store,
    model: "test-model",
    providerName: "test-provider",
    modelTier: "balanced",
    toolOutputLimit: 30_000,
  } as unknown as Config;
}

/** 在 base 下造一个技能目录并写入 SKILL.md，返回该目录绝对路径。 */
function makeSkill(
  base: string,
  name: string,
  opts: { description?: string; raw?: string } = {},
): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  const body =
    opts.raw !== undefined
      ? opts.raw
      : opts.description !== undefined
        ? `---\nname: ${name}\ndescription: ${opts.description}\n---\n\n# ${name} 标题\n\n正文内容。\n`
        : `# ${name} 标题\n\n正文内容。\n`;
  writeFileSync(join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

function writeFileDeep(path: string, content: string): string {
  // dirname 而非 join(path, "..")：后者在路径是文件时会先 mkdir 出一个同名目录，
  // 导致后续写该文件失败（表现为「文件不存在」，排查时极具误导性）。
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function cleanup(): void {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
}

/** macOS: /var → /private/var。比较路径前两边都过 realpath。 */
function rp(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return realpathSync(join(p, ".."));
  }
}

function isInside(child: string, parent: string): boolean {
  const r = relative(rp(parent), rp(child));
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep + ".."));
}

function readdirSorted(p: string): string[] {
  return readdirSync(p).sort();
}

/* ------------------------------------------------------------------ */
/* A. frontmatter 解析（§7.1 A1-A6）                                   */
/* ------------------------------------------------------------------ */

describe("A. parseFrontmatter", () => {
  test("A1 标准三字段 frontmatter", () => {
    const fm = parseFrontmatter(
      "---\nname: pdf\ndescription: 提取 PDF 文本\nversion: 1.0.0\n---\n\n# PDF\n",
    );
    expect(fm["name"]).toBe("pdf");
    expect(fm["description"]).toBe("提取 PDF 文本");
    expect(fm["version"]).toBe("1.0.0");
  });

  test("A2 description 含中文与冒号时按第一个 ': ' 分割", () => {
    const fm = parseFrontmatter(
      "---\nname: pdf\ndescription: 用途：读 PDF；场景：填表格\n---\n",
    );
    expect(fm["description"]).toBe("用途：读 PDF；场景：填表格");
    expect(fm["name"]).toBe("pdf");
  });

  test("A3 无 frontmatter 返回空对象，不抛异常", () => {
    expect(parseFrontmatter("# 标题\n\n正文\n")).toEqual({});
  });

  test("A4 frontmatter 未闭合返回空对象，不抛异常", () => {
    expect(parseFrontmatter("---\nname: pdf\ndescription: x\n\n# 没有闭合\n")).toEqual({});
  });

  test("A5 多行 YAML 只取首行，不解析嵌套", () => {
    const fm = parseFrontmatter("---\nname: pdf\nallowed-tools: [Read, Grep]\n---\n");
    expect(fm["allowed-tools"]).toBe("[Read, Grep]");
    expect(Array.isArray(fm["allowed-tools"])).toBe(false);
  });

  test("A6 空文件返回空对象", () => {
    expect(parseFrontmatter("")).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* B. 技能发现（§7.1 B1-B7）                                           */
/* ------------------------------------------------------------------ */

describe("B. discoverSkills", () => {
  test("B1 store 中 3 个技能、项目为空 → 3 条 global/linked:false", () => {
    const { cwd, store } = sandbox("b1");
    makeSkill(store, "alpha", { description: "A 技能" });
    makeSkill(store, "beta", { description: "B 技能" });
    makeSkill(store, "gamma", { description: "C 技能" });

    const all = discoverSkills(makeCfg(cwd, store));
    expect(all).toHaveLength(3);
    for (const s of all) {
      expect(s.source).toBe("global");
      expect(s.linked).toBe(false);
    }
    expect(all.map((s: SkillMeta) => s.name).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("B2 项目真目录 + store 同名 → 两条都返回，项目那条 source=project", () => {
    const { cwd, store } = sandbox("b2");
    makeSkill(store, "pdf", { description: "全局版" });
    makeSkill(join(cwd, "skills"), "pdf", { description: "项目版" });

    const all = discoverSkills(makeCfg(cwd, store));
    expect(all).toHaveLength(2);
    expect(all.filter((s: SkillMeta) => s.source === "project")).toHaveLength(1);
    expect(all.filter((s: SkillMeta) => s.source === "global")).toHaveLength(1);
    // 同名时项目条排在前面，保证顺序稳定（约束 5）
    expect(all[0]?.source).toBe("project");
    // 索引去重后只有一行（P8 裁决）
    const lines = buildSkillIndex(all).split("\n").filter((l: string) => l.startsWith("- pdf："));
    expect(lines).toHaveLength(1);
  });

  test("B3 项目真目录 + store 无同名 → 返回项目条 source=project", () => {
    const { cwd, store } = sandbox("b3");
    makeSkill(join(cwd, "skills"), "only-project", { description: "项目独有" });
    makeSkill(store, "other", { description: "别的" });

    const all = discoverSkills(makeCfg(cwd, store));
    expect(all).toHaveLength(2);
    const p = all.find((s: SkillMeta) => s.name === "only-project");
    expect(p?.source).toBe("project");
    expect(p?.linked).toBe(false);
  });

  test("B4 目录缺 SKILL.md → 跳过，不产生条目", () => {
    const { cwd, store } = sandbox("b4");
    makeSkill(store, "good", { description: "好的" });
    mkdirSync(join(store, "broken"), { recursive: true });

    expect(discoverSkills(makeCfg(cwd, store)).map((s: SkillMeta) => s.name)).toEqual(["good"]);
  });

  test("B5 store 目录不存在 → 返回 []，不抛异常", () => {
    const { cwd, store } = sandbox("b5");
    expect(discoverSkills(makeCfg(cwd, store))).toEqual([]);
    // 完全不存在的路径也不能抛
    expect(discoverSkills(makeCfg(cwd, join(cwd, "no-such-dir")))).toEqual([]);
  });

  test("B6 三个 store 技能 a、b、c → 字典序稳定可复现", () => {
    const { cwd, store } = sandbox("b6");
    makeSkill(store, "c", { description: "C" });
    makeSkill(store, "a", { description: "A" });
    makeSkill(store, "b", { description: "B" });

    const first = discoverSkills(makeCfg(cwd, store)).map((s: SkillMeta) => s.name);
    expect(first).toEqual(["a", "b", "c"]);
    // 约束 5：同输入必须同输出，否则索引顺序抖动破坏可复现性
    expect(discoverSkills(makeCfg(cwd, store)).map((s: SkillMeta) => s.name)).toEqual(first);
  });

  test("B7 目录名非法（大写 / 下划线 / 连字符开头）→ 跳过", () => {
    const { cwd, store } = sandbox("b7");
    makeSkill(store, "good-name", { description: "合法" });
    makeSkill(store, "BadName", { description: "大写非法" });
    makeSkill(store, "bad_name", { description: "下划线非法" });
    makeSkill(store, "-leading", { description: "连字符开头非法" });

    expect(discoverSkills(makeCfg(cwd, store)).map((s: SkillMeta) => s.name)).toEqual(["good-name"]);
  });

  test("B8 索引缺 description 时回退为 SKILL.md 首行标题（约束 1）", () => {
    const { cwd, store } = sandbox("b8");
    makeSkill(store, "titled", { raw: "# 这是标题行\n\n正文\n" });
    const all = discoverSkills(makeCfg(cwd, store));
    expect(all).toHaveLength(1);
    expect(all[0]?.description).toContain("这是标题行");
  });

  test("B9 项目区软链也能被发现：linked=true，absPath 已解析软链", () => {
    const { cwd, store } = sandbox("b9");
    const real = makeSkill(store, "linked-skill", { description: "通过软链访问" });
    mkdirSync(join(cwd, "skills"), { recursive: true });
    symlinkSync(real, join(cwd, "skills", "linked-skill"), "dir");

    // 与 B2 的区别：B2 是「项目真目录 + store 同名」——两个不同 absPath，返回 2 条；
    // 这里是「项目软链指回 store」——use_skill 建出的懒加载产物，absPath 相同，
    // 是**同一个**技能，返回 1 条，否则索引与 use_skill 的来源说明会自相矛盾。
    const all = discoverSkills(makeCfg(cwd, store));
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe("linked-skill");
    expect(all[0]?.linked).toBe(true);
    expect(rp(all[0]?.absPath ?? "")).toBe(rp(real));
    expect(existsSync(join(all[0]?.absPath ?? "", "SKILL.md"))).toBe(true);

    // 索引里仍然只有一行，且描述取自真实目录
    const lines = buildSkillIndex(all).split("\n").filter((l: string) => l.startsWith("- "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("通过软链访问");
  });
});

/* ------------------------------------------------------------------ */
/* C. 名称校验与解析（§7.1 C1-C10）                                     */
/* ------------------------------------------------------------------ */

describe("C. resolveSkill", () => {
  test("C1 合法名，项目已有软链 → ok:true, createdLink:false", () => {
    const { cwd, store } = sandbox("c1");
    const real = makeSkill(store, "pdf", { description: "PDF" });
    mkdirSync(join(cwd, "skills"), { recursive: true });
    symlinkSync(real, join(cwd, "skills", "pdf"), "dir");

    const r = resolveSkill(makeCfg(cwd, store), "pdf");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.createdLink).toBe(false);
      expect(r.meta.name).toBe("pdf");
    }
  });

  test("C2 合法名，store 有、项目软链已由上次调用建立 → createdLink:false", () => {
    const { cwd, store } = sandbox("c2");
    makeSkill(store, "pdf", { description: "PDF" });

    const first = resolveSkill(makeCfg(cwd, store), "pdf");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.createdLink).toBe(true);

    const second = resolveSkill(makeCfg(cwd, store), "pdf");
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.createdLink).toBe(false);
  });

  test("C3 合法名，仅 store 有，首次调用 → createdLink:true 且软链落地为绝对路径", () => {
    const { cwd, store } = sandbox("c3");
    const real = makeSkill(store, "pdf", { description: "PDF 技能" });

    const r = resolveSkill(makeCfg(cwd, store), "pdf");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.createdLink).toBe(true);
      expect(r.meta.name).toBe("pdf");
      expect(r.meta.source).toBe("global");
      expect(r.meta.linked).toBe(true);
    }
    const link = join(cwd, "skills", "pdf");
    expect(existsSync(link)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // 约束 3：软链必须是绝对路径
    expect(isAbsolute(readlinkSync(link))).toBe(true);
    expect(realpathSync(link)).toBe(rp(real));
  });

  test("C4 重复调用 → createdLink:false，不报错，软链不被重建", () => {
    const { cwd, store } = sandbox("c4");
    makeSkill(store, "pdf", { description: "PDF" });
    resolveSkill(makeCfg(cwd, store), "pdf");
    const link = join(cwd, "skills", "pdf");
    const ino = lstatSync(link).ino;

    const again = resolveSkill(makeCfg(cwd, store), "pdf");
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.createdLink).toBe(false);
    expect(lstatSync(link).ino).toBe(ino);
  });

  test("C5 不存在的名 → ok:false, not_found, available 含已有技能名", () => {
    const { cwd, store } = sandbox("c5");
    makeSkill(store, "alpha", { description: "A" });
    makeSkill(store, "beta", { description: "B" });

    const r = resolveSkill(makeCfg(cwd, store), "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("not_found");
      expect(r.available).toContain("alpha");
      expect(r.available).toContain("beta");
    }
  });

  test("C6 路径穿越 ../../etc/passwd → malformed", () => {
    const { cwd, store } = sandbox("c6");
    makeSkill(store, "alpha", { description: "A" });
    const r = resolveSkill(makeCfg(cwd, store), "../../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  test("C7 绝对路径 /etc/passwd → malformed", () => {
    const { cwd, store } = sandbox("c7");
    makeSkill(store, "alpha", { description: "A" });
    const r = resolveSkill(makeCfg(cwd, store), "/etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  test("C8 含下划线 my_skill → malformed", () => {
    const { cwd, store } = sandbox("c8");
    const r = resolveSkill(makeCfg(cwd, store), "my_skill");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  test("C9 空字符串 → malformed", () => {
    const { cwd, store } = sandbox("c9");
    const r = resolveSkill(makeCfg(cwd, store), "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });

  test("C10 项目与 store 同名 → 用项目的，createdLink:false，全局库未被修改", () => {
    const { cwd, store } = sandbox("c10");
    const globalDir = makeSkill(store, "dup", { description: "全局版" });
    const projectDir = makeSkill(join(cwd, "skills"), "dup", { description: "项目版" });
    const globalBefore = readFileSync(join(globalDir, "SKILL.md"), "utf8");
    const storeBefore = readdirSorted(store);

    const r = resolveSkill(makeCfg(cwd, store), "dup");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.createdLink).toBe(false);
      expect(r.meta.source).toBe("project");
      expect(rp(r.meta.absPath)).toBe(rp(projectDir));
    }
    expect(readFileSync(join(globalDir, "SKILL.md"), "utf8")).toBe(globalBefore);
    expect(readdirSorted(store)).toEqual(storeBefore);
    // 项目区仍是真目录，没被替换成软链
    expect(lstatSync(join(cwd, "skills", "dup")).isSymbolicLink()).toBe(false);
  });

  test("C11 项目区无 skills 目录时自动创建并落地软链", () => {
    const { cwd, store } = sandbox("c11");
    makeSkill(store, "auto", { description: "自动建目录" });
    expect(existsSync(join(cwd, "skills"))).toBe(false);

    const r = resolveSkill(makeCfg(cwd, store), "auto");
    expect(r.ok).toBe(true);
    expect(lstatSync(join(cwd, "skills", "auto")).isSymbolicLink()).toBe(true);
  });

  test("C12 目录存在但缺 SKILL.md → ok:false，message 含「缺少 SKILL.md」（约束 8）", () => {
    const { cwd, store } = sandbox("c12");
    mkdirSync(join(store, "nosk"), { recursive: true });

    const r = resolveSkill(makeCfg(cwd, store), "nosk");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("缺少 SKILL.md");
  });
});

/* ------------------------------------------------------------------ */
/* D. 索引生成（§7.1 D1-D4）                                           */
/* ------------------------------------------------------------------ */

describe("D. buildSkillIndex", () => {
  const meta = (name: string, description: string): SkillMeta => ({
    name,
    description,
    absPath: `/tmp/${name}`,
    linkPath: `/tmp/${name}`,
    source: "global",
    linked: false,
  });

  test("D1 2 个技能 → 每技能一行，以 '- 名称：' 开头", () => {
    const out = buildSkillIndex([meta("pdf", "读 PDF"), meta("docx", "写 Word")]);
    const lines = out.split("\n").filter((l: string) => l.startsWith("- "));
    expect(lines).toHaveLength(2);
    expect(lines.some((l: string) => l.startsWith("- pdf："))).toBe(true);
    expect(lines.some((l: string) => l.startsWith("- docx："))).toBe(true);
    expect(out).toContain("use_skill");
  });

  test("D2 空数组 → 返回空字符串", () => {
    expect(buildSkillIndex([])).toBe("");
  });

  test("D3 description 含换行 → 压成单行，不破坏「一行一技能」", () => {
    const out = buildSkillIndex([meta("multi", "第一行\n第二行\n第三行")]);
    const lines = out.split("\n").filter((l: string) => l.startsWith("- "));
    expect(lines).toHaveLength(1);
  });

  test("D4 description 为空 → 回退为目录名，不为空", () => {
    const out = buildSkillIndex([meta("fallback-name", "")]);
    const lines = out.split("\n").filter((l: string) => l.startsWith("- "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fallback-name");
  });

  test("D5 同名技能去重，项目优先", () => {
    const a: SkillMeta = { ...meta("dup", "全局版"), source: "global" };
    const b: SkillMeta = { ...meta("dup", "项目版"), source: "project" };
    const lines = buildSkillIndex([b, a])
      .split("\n")
      .filter((l: string) => l.startsWith("- "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("项目版");
  });
});

/* ------------------------------------------------------------------ */
/* E. use_skill 工具（§7.1 E1-E12，经 dispatch）                       */
/* ------------------------------------------------------------------ */

describe("E. use_skill 工具", () => {
  test("E1 工具已注册，共 10 个，use_skill 在 web_fetch 之后", () => {
    const names = toolNames();
    expect(names).toContain("use_skill");
    expect(names).toHaveLength(10);
    expect(new Set(names).size).toBe(10);
    expect(names[names.length - 2]).toBe("use_skill");
    expect(names[names.length - 1]).toBe("compact_ctx");
  });

  test("E2 标记为非敏感", () => {
    const t = TOOLS.find((x) => x.spec.function.name === "use_skill");
    expect(t).toBeDefined();
    expect(t?.sensitive).toBe(false);
  });

  test("E3 spec 结构合法：type=function，required 含 name", () => {
    const t = TOOLS.find((x) => x.spec.function.name === "use_skill");
    expect(t?.spec.type).toBe("function");
    const params = t?.spec.function.parameters as
      | { type?: string; required?: string[]; properties?: Record<string, unknown> }
      | undefined;
    expect(params?.type).toBe("object");
    expect(params?.required).toContain("name");
    expect(Object.keys(params?.properties ?? {})).toContain("name");
    expect(t?.spec.function.description.length).toBeGreaterThan(10);
  });

  test("E4 成功加载：输出含 SKILL.md 正文特征串", async () => {
    const { cwd, store } = sandbox("e4");
    const dir = makeSkill(store, "pdf", { description: "PDF 技能" });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: pdf\ndescription: PDF\n---\n\nUNIQUE_BODY_MARKER_42\n", "utf8");

    const r = await dispatch("use_skill", JSON.stringify({ name: "pdf" }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("UNIQUE_BODY_MARKER_42");
  });

  test("E5 输出含附件清单（references/ 与 scripts/ 下的文件名）", async () => {
    const { cwd, store } = sandbox("e5");
    const dir = makeSkill(store, "pdf", { description: "PDF" });
    writeFileDeep(join(dir, "references", "detail.md"), "细节");
    writeFileDeep(join(dir, "scripts", "extract.py"), "print(1)");

    const r = await dispatch("use_skill", JSON.stringify({ name: "pdf" }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("references/detail.md");
    expect(r.output).toContain("scripts/extract.py");
  });

  test("E6 输出含来源说明", async () => {
    const { cwd, store } = sandbox("e6");
    makeSkill(store, "pdf", { description: "PDF" });
    const r = await dispatch("use_skill", JSON.stringify({ name: "pdf" }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("来源");
  });

  test("E7 首次调用后软链被创建（lstatSync.isSymbolicLink）", async () => {
    const { cwd, store } = sandbox("e7");
    makeSkill(store, "pdf", { description: "PDF" });
    const link = join(cwd, "skills", "pdf");
    expect(existsSync(link)).toBe(false);

    const r = await dispatch("use_skill", JSON.stringify({ name: "pdf" }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test("E8 技能不存在 → ok:false，输出含「可用技能：」", async () => {
    const { cwd, store } = sandbox("e8");
    makeSkill(store, "alpha", { description: "A" });
    const r = await dispatch("use_skill", JSON.stringify({ name: "ghost" }), makeCtx(cwd, store));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("可用技能：");
    expect(r.output).toContain("alpha");
  });

  test("E9 非法名 → ok:false，输出含「技能名非法」", async () => {
    const { cwd, store } = sandbox("e9");
    const r = await dispatch("use_skill", JSON.stringify({ name: "../evil" }), makeCtx(cwd, store));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("技能名非法");
  });

  test("E10 目录存在但无 SKILL.md → ok:false，含「缺少 SKILL.md」", async () => {
    const { cwd, store } = sandbox("e10");
    mkdirSync(join(store, "empty-dir"), { recursive: true });
    const r = await dispatch("use_skill", JSON.stringify({ name: "empty-dir" }), makeCtx(cwd, store));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("缺少 SKILL.md");
  });

  test("E11 输出长度不超过 toolOutputLimit（约束 6）", async () => {
    const { cwd, store } = sandbox("e11");
    const dir = makeSkill(store, "big", { description: "大文件" });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: big\ndescription: big\n---\n\n${"长".repeat(40_000)}`, "utf8");

    const r = await dispatch("use_skill", JSON.stringify({ name: "big" }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(30_000);
  });

  test("E12 非法 JSON 参数 → ok:false，含「不是合法 JSON」", async () => {
    const { cwd, store } = sandbox("e12");
    makeSkill(store, "pdf", { description: "PDF" });
    const r = await dispatch("use_skill", "{not json", makeCtx(cwd, store));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("不是合法 JSON");
  });
});

/* ------------------------------------------------------------------ */
/* F. symlink 遍历修复回归（§5 + §7.1 F1-F5，这是地基）                 */
/* ------------------------------------------------------------------ */

describe("F. symlink 遍历修复", () => {
  /** 建一个 store 技能并在项目 skills/ 下建软链。 */
  function linked(tag: string): { cwd: string; store: string; link: string } {
    const s = sandbox(tag);
    const dir = makeSkill(s.store, "pdf", { description: "PDF" });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: pdf\n---\n\nNEEDLE_IN_SYMLINK\n", "utf8");
    mkdirSync(join(s.cwd, "skills"), { recursive: true });
    const link = join(s.cwd, "skills", "pdf");
    symlinkSync(dir, link, "dir");
    return { cwd: s.cwd, store: s.store, link };
  }

  test("F1 glob skills/**/*.md 能列出软链内的 SKILL.md（修复前为空）", async () => {
    const { cwd, store } = linked("f1");
    const r = await dispatch(
      "glob",
      JSON.stringify({ pattern: "skills/**/*.md", path: cwd }),
      makeCtx(cwd, store),
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("SKILL.md");
  });

  test("F2 grep 从 cwd 递归能命中软链内文件，输出含 SKILL.md:行号:", async () => {
    const { cwd, store } = linked("f2");
    const r = await dispatch("grep", JSON.stringify({ pattern: "NEEDLE_IN_SYMLINK", path: cwd }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("NEEDLE_IN_SYMLINK");
    expect(r.output).toMatch(/SKILL\.md:\d+:/);
  });

  test("F3 list_dir skills 把软链显示为 pdf/（带尾斜杠）", async () => {
    const { cwd, store } = linked("f3");
    const r = await dispatch("list_dir", JSON.stringify({ path: "skills" }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/pdf\//);
    // 修复前会被当成文件，输出形如 "pdf  (128B, ...)"
    expect(r.output).not.toMatch(/pdf\s+\(\d+B,/);
  });

  test("F4 list_dir skills recursive 能列出软链内文件", async () => {
    const { cwd, store } = linked("f4");
    const r = await dispatch("list_dir", JSON.stringify({ path: "skills", recursive: true }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("SKILL.md");
  });

  test("F5 修复不破坏真实目录遍历：F1~F4 对真目录同样通过", async () => {
    const { cwd, store } = sandbox("f5");
    const dir = makeSkill(join(cwd, "skills"), "pdf", { description: "PDF" });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: pdf\n---\n\nNEEDLE_REAL_DIR\n", "utf8");

    const g = await dispatch("glob", JSON.stringify({ pattern: "skills/**/*.md", path: cwd }), makeCtx(cwd, store));
    expect(g.ok).toBe(true);
    expect(g.output).toContain("SKILL.md");

    const gr = await dispatch("grep", JSON.stringify({ pattern: "NEEDLE_REAL_DIR", path: cwd }), makeCtx(cwd, store));
    expect(gr.ok).toBe(true);
    expect(gr.output).toContain("NEEDLE_REAL_DIR");

    const ld = await dispatch("list_dir", JSON.stringify({ path: "skills", recursive: true }), makeCtx(cwd, store));
    expect(ld.ok).toBe(true);
    expect(ld.output).toMatch(/pdf\//);
    expect(ld.output).toContain("SKILL.md");
  });

  test("F6 不破坏普通文件遍历：指向文件的软链仍能被 glob 匹配（P1 回归防护）", async () => {
    const { cwd, store } = sandbox("f6");
    mkdirSync(join(cwd, "skills"), { recursive: true });
    const target = writeFileDeep(join(cwd, "assets", "note.md"), "# 普通文件\n");
    symlinkSync(target, join(cwd, "skills", "alias.md"));

    const r = await dispatch("glob", JSON.stringify({ pattern: "skills/**/*.md", path: cwd }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("alias.md");
  });

  test("F7 指向文件的软链仍能被 grep 命中（P1 回归防护）", async () => {
    const { cwd, store } = sandbox("f7");
    mkdirSync(join(cwd, "skills"), { recursive: true });
    // 目标放在沙箱**外面**（tmpdir 根部），使 cwd 递归扫描只能经由 skills/alias.md 命中。
    // 若目标仍在 cwd 内，原写法会误匹配到真实文件 —— 错误改法下软链丢失也能「通过」，
    // 该回归就测不出来（详见 docs/red-phase-evidence.md §假绿排查）。
    const outside = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "f7-target-")));
    const target = writeFileDeep(join(outside, "note.md"), "NEEDLE_FILE_LINK\n");
    symlinkSync(target, join(cwd, "skills", "alias.md"));

    const r = await dispatch("grep", JSON.stringify({ pattern: "NEEDLE_FILE_LINK", path: cwd }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    // 必须命中软链本身，而不是别处的同内容文件
    expect(r.output).toContain("alias.md");
    rmSync(outside, { recursive: true, force: true });
  });

  test("F8 system prompt 工作目录树把 skills/pdf 显示为目录（§5 第 4 处）", () => {
    const { cwd, store } = linked("f8");
    expect(buildSystemPrompt(makeCfg(cwd, store))).toMatch(/skills\/pdf\//);
  });
});

/* ------------------------------------------------------------------ */
/* G. 写工具守卫（§7.1 G1-G6）                                         */
/* ------------------------------------------------------------------ */

describe("G. 写工具软链守卫", () => {
  /** store 里放 pdf，项目 skills/pdf 软链到它 —— 真实的穿透写入场景。 */
  function guard(tag: string): { cwd: string; store: string; link: string; target: string } {
    const s = sandbox(tag);
    const dir = makeSkill(s.store, "pdf", { description: "PDF" });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: pdf\n---\n\nORIGINAL_SKILL_BODY\n", "utf8");
    mkdirSync(join(s.cwd, "skills"), { recursive: true });
    const link = join(s.cwd, "skills", "pdf");
    symlinkSync(dir, link, "dir");
    return { cwd: s.cwd, store: s.store, link, target: dir };
  }

  test("G1 write_file 写向软链内 → ok:false，含「禁止写入全局技能库」", async () => {
    const { cwd, store } = guard("g1");
    const victim = join(cwd, "skills", "pdf", "injected.md");
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: victim, content: "恶意内容" }),
      makeCtx(cwd, store),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("禁止写入全局技能库");
    expect(existsSync(victim)).toBe(false);
  });

  test("G2 edit_file 改软链内文件 → ok:false，含「禁止写入全局技能库」", async () => {
    const { cwd, store } = guard("g2");
    const victim = join(cwd, "skills", "pdf", "SKILL.md");
    const r = await dispatch(
      "edit_file",
      JSON.stringify({ path: victim, old_string: "ORIGINAL_SKILL_BODY", new_string: "被篡改" }),
      makeCtx(cwd, store),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("禁止写入全局技能库");
    expect(readFileSync(victim, "utf8")).toContain("ORIGINAL_SKILL_BODY");
  });

  test("G3 守卫触发时不调用 approve（约束 12：守卫必须在 approve 之前）", async () => {
    const { cwd, store } = guard("g3");
    let approveCalls = 0;
    const ctx = makeCtx(cwd, store, {
      approve: async () => {
        approveCalls++;
        return true;
      },
    });
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: join(cwd, "skills", "pdf", "x.md"), content: "x" }),
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("禁止写入全局技能库");
    expect(approveCalls).toBe(0);
  });

  test("G4 正常写项目文件 → ok:true（守卫不误伤）", async () => {
    const { cwd, store } = guard("g4");
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: join(cwd, "src", "app.ts"), content: "ok" }),
      makeCtx(cwd, store),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(join(cwd, "src", "app.ts"), "utf8")).toBe("ok");
  });

  test("G5 store 目录外的相对路径正常放行", async () => {
    const { cwd, store } = sandbox("g5");
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: "notes/todo.md", content: "待办" }),
      makeCtx(cwd, store),
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(join(cwd, "notes", "todo.md"), "utf8")).toBe("待办");
  });

  test("G6 守卫抛 ToolError 而非字符串 → dispatch 转 ok:false", async () => {
    const { cwd, store } = guard("g6");
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: join(cwd, "skills", "pdf", "y.md"), content: "y" }),
      makeCtx(cwd, store),
    );
    // ToolError 被包成「错误: ...」；非 ToolError 则是「工具执行失败: ...」
    expect(r.ok).toBe(false);
    expect(r.output).toContain("错误:");
    expect(r.output).toContain("禁止写入全局技能库");
  });

  test("G7 约束 13：新文件（父目录存在、文件不存在）同样被拒", async () => {
    const { cwd, store } = guard("g7");
    const victim = join(cwd, "skills", "pdf", "brand-new.md");
    expect(existsSync(victim)).toBe(false);
    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: victim, content: "新文件" }),
      makeCtx(cwd, store),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("禁止写入全局技能库");
  });

  test("G8 守卫必须用 realpath 而非字符串比较（P2：路径必须来自 cfg.skillsStore）", async () => {
    const { cwd, store } = guard("g8");
    const linkPath = join(cwd, "skills", "pdf");
    // 软链路径与 store 真实路径字符串不等，纯字符串比较会漏判
    expect(linkPath).not.toBe(join(store, "pdf"));
    expect(isInside(linkPath, store)).toBe(true);

    const r = await dispatch(
      "write_file",
      JSON.stringify({ path: join(linkPath, "z.md"), content: "z" }),
      makeCtx(cwd, store),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("禁止写入全局技能库");
  });
});

/* ------------------------------------------------------------------ */
/* H. system prompt 注入（§7.1 H1-H4）                                 */
/* ------------------------------------------------------------------ */

describe("H. system prompt 技能索引注入", () => {
  test("H1 有技能时 prompt 含「## 技能」与 use_skill", () => {
    const { cwd, store } = sandbox("h1");
    makeSkill(store, "pdf", { description: "提取与转换 PDF。适用于读 PDF、填表格。" });
    const prompt = buildSystemPrompt(makeCfg(cwd, store));
    expect(prompt).toContain("## 技能");
    expect(prompt).toContain("use_skill");
    expect(prompt).toContain("pdf");
  });

  test("H2 无技能时不含「## 技能」，无空标题残留（约束 10）", () => {
    const { cwd, store } = sandbox("h2");
    const prompt = buildSystemPrompt(makeCfg(cwd, store));
    expect(prompt).not.toContain("## 技能");
    expect(prompt).not.toContain("可用技能");
  });

  test("H3 索引位置在「## 工具」之后、「## 环境」之前（约束 9）", () => {
    const { cwd, store } = sandbox("h3");
    makeSkill(store, "pdf", { description: "PDF" });
    const prompt = buildSystemPrompt(makeCfg(cwd, store));
    expect(prompt).toContain("## 技能");
    expect(prompt.indexOf("## 技能")).toBeGreaterThan(prompt.indexOf("## 工具"));
    expect(prompt.indexOf("## 技能")).toBeLessThan(prompt.indexOf("## 环境"));
  });

  test("H4 不破坏模型行：noteModelChange 的正则仍只匹配一处", () => {
    const { cwd, store } = sandbox("h4");
    makeSkill(store, "pdf", { description: "PDF" });
    makeSkill(store, "docx", { description: "Word" });
    const prompt = buildSystemPrompt(makeCfg(cwd, store));
    expect(prompt.match(/- 模型：[^\n]*/g) ?? []).toHaveLength(1);
  });

  test("H5 索引每技能严格一行", () => {
    const { cwd, store } = sandbox("h5");
    makeSkill(store, "pdf", { description: "PDF 一" });
    makeSkill(store, "docx", { description: "Word 二" });
    makeSkill(store, "xlsx", { description: "Excel 三" });
    const prompt = buildSystemPrompt(makeCfg(cwd, store));
    const lines = prompt.split("\n").filter((l) => /^- (pdf|docx|xlsx)：/.test(l));
    expect(lines).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ */
/* I. 端到端集成（§7.1 I1-I3）                                          */
/* ------------------------------------------------------------------ */

describe("I. 端到端集成", () => {
  test("I1 完整流程：建 store 技能 → 发现 → 进 prompt → use_skill → 文件真实变更", async () => {
    const { cwd, store } = sandbox("i1");
    const real = makeSkill(store, "pdf", { description: "提取 PDF 文本。适用于读 PDF。" });
    writeFileSync(join(real, "SKILL.md"), "---\nname: pdf\ndescription: 提取 PDF 文本\n---\n\n# PDF 处理\n\n步骤一：读文件。\n", "utf8");

    const found = discoverSkills(makeCfg(cwd, store));
    expect(found.map((s: SkillMeta) => s.name)).toEqual(["pdf"]);

    const prompt = buildSystemPrompt(makeCfg(cwd, store));
    expect(prompt).toContain("## 技能");
    expect(prompt).toContain("- pdf：");

    const r = await dispatch("use_skill", JSON.stringify({ name: "pdf" }), makeCtx(cwd, store));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("步骤一：读文件。");

    const link = join(cwd, "skills", "pdf");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(rp(link)).toBe(rp(real));
  });

  test("I2 二次加载同一技能：createdLink:false，内容一致，不重复建链", async () => {
    const { cwd, store } = sandbox("i2");
    makeSkill(store, "pdf", { description: "PDF" });
    const link = join(cwd, "skills", "pdf");

    const first = await dispatch("use_skill", JSON.stringify({ name: "pdf" }), makeCtx(cwd, store));
    const ino = lstatSync(link).ino;
    const second = await dispatch("use_skill", JSON.stringify({ name: "pdf" }), makeCtx(cwd, store));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.output).toBe(first.output);
    expect(lstatSync(link).ino).toBe(ino);

    const r = resolveSkill(makeCfg(cwd, store), "pdf");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.createdLink).toBe(false);
  });

  test("I3 多技能共存：索引全在，各自 use_skill 拿到正确正文，不串内容", async () => {
    const { cwd, store } = sandbox("i3");
    makeSkill(store, "pdf", { description: "PDF 技能" });
    makeSkill(store, "docx", { description: "Word 技能" });
    makeSkill(store, "xlsx", { description: "Excel 技能" });
    writeFileSync(join(store, "pdf", "SKILL.md"), "---\nname: pdf\n---\n\nMARKER_PDF_ONLY\n", "utf8");
    writeFileSync(join(store, "docx", "SKILL.md"), "---\nname: docx\n---\n\nMARKER_DOCX_ONLY\n", "utf8");
    writeFileSync(join(store, "xlsx", "SKILL.md"), "---\nname: xlsx\n---\n\nMARKER_XLSX_ONLY\n", "utf8");

    const prompt = buildSystemPrompt(makeCfg(cwd, store));
    for (const n of ["pdf", "docx", "xlsx"]) expect(prompt).toContain(`- ${n}：`);

    const cases = [
      { name: "pdf", marker: "MARKER_PDF_ONLY", others: ["MARKER_DOCX_ONLY", "MARKER_XLSX_ONLY"] },
      { name: "docx", marker: "MARKER_DOCX_ONLY", others: ["MARKER_PDF_ONLY", "MARKER_XLSX_ONLY"] },
      { name: "xlsx", marker: "MARKER_XLSX_ONLY", others: ["MARKER_PDF_ONLY", "MARKER_DOCX_ONLY"] },
    ];
    for (const { name, marker, others } of cases) {
      const r = await dispatch("use_skill", JSON.stringify({ name }), makeCtx(cwd, store));
      expect(r.ok).toBe(true);
      expect(r.output).toContain(marker);
      for (const o of others) expect(r.output).not.toContain(o);
    }
  });
});

/* ------------------------------------------------------------------ */
/* J. 隔离红线（§7.3 / §9.3）                                           */
/* ------------------------------------------------------------------ */

describe("J. 测试隔离红线", () => {
  test("J1 全部沙箱都在 tmpdir 之下，测试不可能碰到真实 ~/.neo/skills", () => {
    expect(made.length).toBeGreaterThan(0);
    for (const d of made) expect(isInside(d, TMP_REAL)).toBe(true);
    for (const d of made) expect(d.startsWith(realpathSync(ROOT))).toBe(true);
  });

  test("J2 cfg.skillsStore 缺失时 discoverSkills 不崩溃", () => {
    const { cwd } = sandbox("j2");
    const cfg = { cwd, toolOutputLimit: 30_000 } as Config;
    expect(() => discoverSkills(cfg)).not.toThrow();
  });

  test("J3 软链指向目录时 statSync 可判定为目录（P1 修复依赖此行为）", () => {
    const s = sandbox("j3");
    const dir = makeSkill(s.store, "pdf", { description: "PDF" });
    mkdirSync(join(s.cwd, "skills"), { recursive: true });
    const link = join(s.cwd, "skills", "pdf");
    symlinkSync(dir, link, "dir");
    // Dirent.isDirectory() 为 false，但 statSync（跟随软链）为 true
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(statSync(link).isDirectory()).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

// 必须用 afterAll 而非顶层 cleanup()：bun 的 test 文件在收集阶段就执行模块顶层代码，
// 顶层调用会在任何用例跑之前把 ROOT 删掉，后续 sandbox() 全部 ENOENT。
afterAll(() => {
  cleanup();
});
