/**
 * `/skills` 斜杠命令端到端测试（PRD skills-prd.md §6.6 + 约束 16）。
 *
 * ## 为什么用子进程而不是 import
 *
 * `handleCommand()` 没有导出，且 `src/index.ts` 顶层是
 * `const code = await main(); process.exit(code);` —— import 即启动 CLI 并退出进程，
 * 所以无法在测试进程内直接调用。
 *
 * 但 `main()` 用 readline 从stdin 读命令，于是可以**启动真实 CLI 子进程**、喂 stdin、
 * 断言真实 stdout。这样测的是用户真正看到的东西，比断言源码文本的「结构守卫」强得多：
 * 结构守卫只能证明代码里没有某个字符串，改个变量名就失效；端到端能证明输出里真的没有正文。
 *
 * 代价是每个用例一次进程启动（实测约 34ms），远小于测试能发现的回归价值。
 *
 * ## 隔离（关键，务必保持）
 *
 * CLI 会把会话写进 `~/.neo/sessions/`（src/session.ts:27 硬编码 homedir），
 * 且默认 `skills_store` 也指向 `~/.neo/skills`（src/config.ts:407）。
 * 直接跑会污染用户真实 home，因此子进程必须同时隔离两处：
 *   1. `HOME=<沙箱>/fakehome`  —— 会话落到沙箱
 *   2. `settings.json` 的 `skills_store` —— 全局技能库落到沙箱
 *
 * 有一个用例（L0）专门断言真实 home 未被写入，防止有人日后改掉隔离逻辑。
 *
 * 运行：bun test
 */
import { describe, expect, test, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { listSkillFiles } from "../src/skills.ts";

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const ROOT = mkdtempSync(join(tmpdir(), "neo-skills-cli-"));
const REPO = resolve(import.meta.dir, "..");
const ENTRY = join(REPO, "src", "index.ts");
const EXAMPLE_SETTINGS = join(REPO, "settings.example.json");

interface Sandbox {
  /** 项目工作目录，同时是子进程的 cwd */
  cwd: string;
  /** 全局技能库（经settings.json 的 skills_store 注入） */
  store: string;
  /** 假 HOME，子进程的 HOME 指向它 */
  home: string;
}

/** 建一个隔离沙箱：项目区 + 全局库 + 假 HOME，并写好 settings.json。 */
function sandbox(tag: string): Sandbox {
  const dir = join(ROOT, tag);
  const cwd = join(dir, "proj");
  const store = join(dir, "store");
  const home = join(dir, "fakehome");
  for (const d of [cwd, store, home]) mkdirSync(d, { recursive: true });

  // 以 settings.example.json 为底，只覆盖 skills_store。
  // 必须给全字段：缺 provider 配置 CLI 起不来，而 example 里的占位值足够启动，
  // 因为 /skills 分支不碰任何网络调用。
  const base = JSON.parse(readFileSync(EXAMPLE_SETTINGS, "utf8")) as Record<string, unknown>;
  writeFileSync(join(cwd, "settings.json"), JSON.stringify({ ...base, skills_store: store }, null, 2));

  return { cwd, store, home };
}

/** 写一个技能目录（真实目录，非软链）。 */
function makeSkill(dir: string, name: string, description: string, body = ""): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\ndescription: ${description}\n---\n# ${name} 标题\n${body}\n`);
  return d;
}

/**
 * 跑一次真实 CLI，喂一串斜杠命令，返回合并后的输出。
 *
 * timeout 是必须的：CLI 若因任何原因没读到 /exit 就会挂在 readline 上，
 * 没有超时整个测试进程会永久卡住。
 */
function runCli(sb: Sandbox, commands: string[]): string {
  const stdin = `${commands.join("\n")}\n/exit\n`;
  const proc = Bun.spawnSync([process.execPath, "run", ENTRY], {
    cwd: sb.cwd,
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home },
    stdin: Buffer.from(stdin),
    timeout: 20_000,
  });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  // 超时会让 stdout 被截断，测试里断言具体内容时必须能一眼看出是超时而非断言失败
  if (proc.exitCode === null) throw new Error(`CLI 超时（未读到 /exit）。输出：\n${out}`);
  return stripAnsi(out);
}

/** 去掉 ANSI 转义与 readline 回显，否则断言中文子串会被转义序列打断。 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "").replace(/\u001B\][^\u0007]*\u0007/g, "");
}

/* ------------------------------------------------------------------ */
/* L 组：/skills 斜杠命令                                              */
/* ------------------------------------------------------------------ */

/**
 * 关键：技能说明（description）刻意**不含**「项目」「全局」「软链」这三个词。
 * 否则断言 `line).toContain("软链")` 会因为命中说明文字而假绿——
 * 删掉真正的标注也照样通过（变异测试实测踩过这个坑）。
 * 说明用中性词后，命中即只能来自 origin 列。
 */
function neutralSkill(dir: string, name: string, tag: string): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\ndescription: 说明-${tag}\n---\n# ${name} 标题\n`);
  return d;
}

describe("L 组/skills 斜杠命令（PRD §6.6）", () => {
  test("L1 无技能时提示放置位置，不打印技能列表", () => {
    const sb = sandbox("l1-empty");
    const out = runCli(sb, ["/skills"]);
    expect(out).toContain("没有可用技能");
    // 空态不该出现列表头
    expect(out).not.toContain("可用技能 ");
    // 提示里要给出可操作的位置
    expect(out).toContain(join(sb.cwd, "skills"));
  });

  test("L2 有技能时列出全部技能名与说明", () => {
    const sb = sandbox("l2-list");
    makeSkill(join(sb.cwd, "skills"), "alpha", "阿尔法说明");
    makeSkill(join(sb.cwd, "skills"), "beta", "贝塔说明");
    const out = runCli(sb, ["/skills"]);
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).toContain("阿尔法说明");
    expect(out).toContain("贝塔说明");
    // 计数与实际一致
    expect(out).toContain("2");
  });

  test("L3 标注来源：项目真目录标「项目」，全局库标「全局」", () => {
    const sb = sandbox("l3-source");
    neutralSkill(join(sb.cwd, "skills"), "aaa-local", "甲");
    neutralSkill(sb.store, "bbb-remote", "乙");
    const out = runCli(sb, ["/skills"]);

    const localLine = out.split("\n").find((l) => l.includes("aaa-local")) ?? "";
    const remoteLine = out.split("\n").find((l) => l.includes("bbb-remote")) ?? "";
    expect(localLine).toBeTruthy();
    expect(remoteLine).toBeTruthy();
    expect(localLine).toContain("项目");
    // 项目私有技能不应被标成全局，否则用户会误判该改哪个库
    expect(localLine).not.toContain("全局");
    expect(remoteLine).toContain("全局");
  });

  test("L4 标注软链状态：项目区软链显示「软链」，真目录不显示", () => {
    const sb = sandbox("l4-link");
    neutralSkill(join(sb.cwd, "skills"), "plaindir", "甲");
    const target = neutralSkill(sb.store, "viastore", "乙");
    mkdirSync(join(sb.cwd, "skills"), { recursive: true });
    symlinkSync(target, join(sb.cwd, "skills", "viastore"), "dir");

    const out = runCli(sb, ["/skills"]);
    // 名字与说明互不含对方，也不含「软链」，否则用 includes 找行/断言会串行或假绿
    const plainLine = out.split("\n").find((l) => l.includes("plaindir")) ?? "";
    const linkLine = out.split("\n").find((l) => l.includes("viastore")) ?? "";
    expect(plainLine).toBeTruthy();
    expect(linkLine).toBeTruthy();
    expect(linkLine).toContain("软链");
    // 真目录不是软链产物，标成软链会让用户去查一个不存在的问题
    expect(plainLine).not.toContain("软链");
  });

  /**
   * 约束 16 的核心断言。
   *
   * 用一份5000 行的 SKILL.md，正文每行都埋唯一标记 LEAKED_SECRET_<n>。
   * `/skills <名>` 只应打印索引字段 + 首行标题；若误加载全文，
   * 这些标记会成片出现在输出里，`not.toContain` 立刻变红。
   *
   * 同时正向断言「标题」出现 —— 证明它确实读了首行，而不是压根没读 SKILL.md
   * （那样not.toContain 就是假绿）。
   */
  test("L5 约束 16：/skills <名> 不加载 SKILL.md 全文，只出首行标题", () => {
    const sb = sandbox("l5-no-fulltext");
    const lines = 5000;
    const body = Array.from({ length: lines }, (_, i) => `正文机密段落 LEAKED_SECRET_${i}`).join("\n");
    makeSkill(join(sb.cwd, "skills"), "big", "大技能", body);

    const out = runCli(sb, ["/skills big"]);

    // 约束 16：正文一个字节都不许进输出
    expect(out).not.toContain("LEAKED_SECRET");
    expect(out).not.toContain("正文机密段落");
    // 输出规模应与正文规模无关：5000 行正文不可能压到几十行
    expect(out.split("\n").length).toBeLessThan(60);

    // 正向：确实读了首行标题（否则上面的 not.toContain 是假绿）
    expect(out).toContain("# big 标题");
    // 索引字段齐全
    expect(out).toContain("名称");
    expect(out).toContain("说明");
    expect(out).toContain("大技能");
  });

  test("L6 /skills <名> 指向 use_skill 作为唯一加载路径", () => {
    const sb = sandbox("l6-hint");
    makeSkill(join(sb.cwd, "skills"), "alpha", "阿尔法说明");
    const out = runCli(sb, ["/skills alpha"]);
    // 约束 16 的意图：这是诊断入口，加载正文只有 use_skill 一条路
    expect(out).toContain("use_skill");
  });

  test("L7 /skills <不存在的名> 报错并列出可用技能名", () => {
    const sb = sandbox("l7-missing");
    makeSkill(join(sb.cwd, "skills"), "alpha", "阿尔法说明");
    makeSkill(join(sb.cwd, "skills"), "beta", "贝塔说明");
    const out = runCli(sb, ["/skills nosuchskill"]);
    expect(out).toContain("nosuchskill");
    // 报错要可操作：把可用名字给出来
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
  });

  test("L8 /skills <名> 对非法技能名拒绝而非崩溃", () => {
    const sb = sandbox("l8-malformed");
    makeSkill(join(sb.cwd, "skills"), "alpha", "阿尔法说明");
    const out = runCli(sb, ["/skills ../etc"]);
    // 路径穿越必须被 NAME_RE 拦下（skills.ts:47），CLI 不应崩、也不应列出 /etc 内容
    expect(out).toContain("非法");
  });

  test("L9 空技能目录（只有 SKILL.md 缺失的条目）不产生条目", () => {
    const sb = sandbox("l9-malformed-dir");
    mkdirSync(join(sb.cwd, "skills", "emptydir"), { recursive: true });
    // 没有 SKILL.md，不构成有效技能
    const out = runCli(sb, ["/skills"]);
    expect(out).not.toContain("emptydir");
    expect(out).toContain("没有可用技能");
  });

  test("L10 /skills 帮助文本中列出该命令", () => {
    const sb = sandbox("l10-help");
    const out = runCli(sb, ["/help"]);
    expect(out).toContain("/skills");
  });

  /**
   * 只读诊断入口：`/skills <名>` 不得改动项目目录。
   *
   * 背景：详情分支一度调用 `resolveSkill()`，而它会在 `<cwd>/skills/`
   * 建软链 —— 一条纯查看命令在悄悄改用户的项目目录。软链只应由
   * `use_skill`（模型行为，且会在输出里告知）创建。
   *
   * 断言落在**文件系统状态**而非输出文本：即使实现改成建软链后立刻删掉，
   * 这里也不会漏（那属于另一种行为，此处不 care）。
   */
  test("L11 /skills 是只读入口：列技能与看详情都不建软链", () => {
    const sb = sandbox("l11-readonly");
    // 技能只在全局库，项目区一开始是空的
    neutralSkill(sb.store, "pdf", "甲");
    const out = runCli(sb, ["/skills", "/skills pdf"]);
    expect(out).toContain("pdf"); // 确实解析到了，不是命令没跑

    const projectSkills = join(sb.cwd, "skills");
    const entries = existsSync(projectSkills) ? readdirSync(projectSkills) : [];
    // 关键：项目区仍为空，一条纯查看命令不该留下任何痕迹
    expect(entries).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* O 组：isRealDir 的软链判定（src/skills.ts，函数名会随重构变）        */
/* ------------------------------------------------------------------ */

/**
 * `isRealDir` 决定 `listSkillFiles` 把一个条目当目录（递归进去）
 * 还是当附件（列进清单）。它是PRD §5.2 明令不许简化的那处逻辑。
 *
 * ## 为什么这组用例存在
 *
 * 变异实测：`isRealDir` 改成 `e.isDirectory() || e.isSymbolicLink()`
 * （注释里明令禁止的写法）时，**全量测试原本一个都不红** ——
 * 这个改动是零反馈的，静默 bug 会直接进主干。
 *
 * `skill-budget.test.ts` 的 N 组已钉住「软链到文件」与「断链软链」
 * （我用变异确认N2/N3 会红）。但**「软链到目录」这一向当时没有用例**：
 * naive 写法对它恰好也返回 true，所以那类变异抓不到它 ——
 * 反过来，若有人把 `statSync` 那层删掉只留 `isDirectory()`，
 * 软链到目录就会被当成附件（只列名字、不递归），N 组同样抓不到。
 *
 * O 组补的就是这个方向：**软链到目录必须被递归展开**。
 */
describe("O 组 isRealDir 的软链判定", () => {
  /**
   * 造一个含四种条目的技能目录。
   * 每个用例独立子目录 —— 软链与目录会互相污染（今天已踩过串扰的坑）。
   */
  function fixture(tag: string): { root: string; dir: string; outside: string } {
    const dir = realpathSync(mkdtempSync(join(ROOT, `${tag}-`)));
    // 软链目标建在扫描根**之外**（真实 use_skill 场景就是链到全局技能库），
    // 否则目标目录自身也会被列进清单，O3 的全集断言就得把它算进去，
    // 反而让「软链被当成目录递归」这件事变得看不出来。
    const outside = mkdtempSync(join(ROOT, `${tag}-target-`));

    // ① 真实子目录（基线：必须被递归展开）
    mkdirSync(join(dir, "realdir"), { recursive: true });
    writeFileSync(join(dir, "realdir", "inner.md"), "x", "utf8");

    // ② 软链到目录 —— 本组的核心。必须被递归展开成 dirlink/inner.md
    mkdirSync(join(outside, "dirtarget"), { recursive: true });
    writeFileSync(join(outside, "dirtarget", "inner.md"), "y", "utf8");
    symlinkSync(join(outside, "dirtarget"), join(dir, "dirlink"), "dir");

    // ③ 软链到文件（已由 N2 覆盖，这里作为对照保留）
    writeFileSync(join(outside, "plain.md"), "z", "utf8");
    symlinkSync(join(outside, "plain.md"), join(dir, "filelink.md"));

    // ④ 断链软链（已由 N3 覆盖，这里作为对照）
    symlinkSync(join(outside, "never-existed.md"), join(dir, "brokenlink"));

    return { root: dir, dir, outside };
  }

  test("O1 软链到目录必须被递归展开，而不是当成附件只列名字", () => {
    const { dir } = fixture("o1-dirlink");
    const files = listSkillFiles(dir);

    // 断言集合完整：软链到目录的内容必须在里面，且路径带 dirlink/ 前缀
    expect(`清单=${JSON.stringify(files)}`).toContain("dirlink/inner.md");
    expect(files).toContain("dirlink/inner.md");
    // 反证：不能只出现光秃秃的 "dirlink"（那是把它当附件而非目录）
    expect(files).not.toContain("dirlink");
    // 真实目录仍走同一条路径，对照组保证不是「所有东西都展开」
    expect(files).toContain("realdir/inner.md");
  });

  test("O2 软链到目录与真实目录产出等价的清单形态", () => {
    const { dir } = fixture("o2-parity");
    const files = listSkillFiles(dir);
    // 两个目录型条目都必须以 "<名字>/<文件>" 形态出现，不允许裸目录名
    for (const name of ["realdir", "dirlink"]) {
      expect(files.some((f) => f.startsWith(`${name}/`))).toBe(true);
      expect(files).not.toContain(name);
    }
  });

  test("O3 四类条目齐备：真实目录/软链到目录/软链到文件/断链软链", () => {
    const { dir } = fixture("o3-complete");
    const files = listSkillFiles(dir);
    // 集合完整断言：缺任何一项、或多出任何一项都要红。
    // 逐项 toContain 会让「多出不该有的条目」溜过去，故比对全集。
    //注意 plain.md 建在扫描根之外（软链目标），它本身不该出现，
    // 只有 filelink.md 这个软链名该出现。
    const expected = [
      "dirlink/inner.md", // 软链到目录 → 递归展开
      "filelink.md", // 软链到文件 → 列为附件
      "brokenlink", // 断链软链 → 列为附件
      "realdir/inner.md", // 真实目录 → 递归展开
    ].sort();

    expect(`清单=${JSON.stringify(files)}`).toBe(`清单=${JSON.stringify(expected)}`);
    expect(files).toEqual(expected);
  });

  test("O4 statSync 不可用时（断链）不得抛异常，静默列为附件", () => {
    const { dir } = fixture("o4-broken-no-throw");
    // 断链软链让 statSync 抛 ENOENT；该分支必须被 catch 住而不是向上抛
    expect(() => listSkillFiles(dir)).not.toThrow();
    expect(listSkillFiles(dir)).toContain("brokenlink");
  });

  /**
   * 隔离守卫：CLI 把会话写到 ~/.neo/sessions（session.ts:27 硬编码 homedir）。
   * 若沙箱没生效，这个用例会发现真实 home 里出现属于本沙箱的会话而变红。
   *
   * 注意：**不能**断言「真实 home 的会话文件数不变」——
   * 用户或并行跑的其他 neo 实例会同时往那儿写，实测计数从110 一路涨到 560，
   * 那样写必然变成随机假红。改为断言「真实 home 里没有cwd 指向本沙箱的会话」，
   * 这才是本用例真正要证明的事，且不受外部并发影响。
   *
   * 不能删 —— 它是其余所有用例不污染用户机器的唯一凭据。
   */
  test("L0 隔离：CLI 不把本沙箱的会话写进用户真实 home", () => {
    const realSessions = join(homedir(), ".neo", "sessions");
    const sb = sandbox("l0-isolation");
    makeSkill(join(sb.cwd, "skills"), "alpha", "阿尔法说明");
    runCli(sb, ["/skills", "/skills alpha"]);

    // 会话应落在沙箱的假 home 里
    expect(existsSync(join(sb.home, ".neo", "sessions"))).toBe(true);

    // 真实 home 里不得出现 cwd 指向本沙箱的会话。
    // 用 realpath 比对：macOS 上 cwd 会被写成 /private/var/... 而 sb.cwd 是 /var/...
    const sbCwdReal = realpathSync(sb.cwd);
    if (existsSync(realSessions)) {
      const leaked = readdirSync(realSessions).filter((f) => {
        try {
          const meta = JSON.parse(readFileSync(join(realSessions, f), "utf8")) as { meta?: { cwd?: string } };
          const cwd = meta.meta?.cwd ?? "";
          return cwd === sbCwdReal || cwd === sb.cwd;
        } catch {
          return false; // 别的实例正在写、文件不完整，与本用例无关
        }
      });
      expect(leaked).toEqual([]);
    }
  });
});

// 必须用 afterAll 而非顶层 cleanup()：bun 在收集阶段就执行模块顶层代码，
// 顶层调用会在任何用例跑之前把ROOT 删掉，后续 sandbox() 全部 ENOENT。
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});