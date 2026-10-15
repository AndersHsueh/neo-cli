/**
 * L 组 —— `/skills` 斜杠命令（PRD §6.6 + 约束 16）。
 *
 * 运行：bun test
 *
 * ============================================================================
 * 【为什么必须用子进程，不能直接 import handleCommand】
 * ============================================================================
 * `src/index.ts` 第 928 行是 `const code = await main(); ... process.exit(code);`
 * —— **import 即自执行并退出进程**。handleCommand 也没导出。
 * 所以单元测试路线根本不存在，只能起子进程走 stdin 管道进交互模式。
 *
 * `-p` 模式也不行：它把参数当 prompt 直接发给 LLM，根本不进 handleCommand。
 * 只有交互模式读到以 `/` 开头的行才会走命令分支。
 *
 * 代价：每个用例 ~1-2 秒（要启 bun 运行时）。这是唯一可行方案的必然成本。
 * ============================================================================
 *
 * ============================================================================
 * 【本组的核心：约束 16 —— `/skills` 不加载全文】
 * ============================================================================
 * 约束 16 原文：「这个命令是给**人**看的诊断入口。打印全文会让人误以为这是
 * 加载路径，实际加载只有 use_skill 一条路。保持职责单一。」
 *
 * 怎么测才算真测到，而不是走过场：
 * 不用「断言输出里没有某段文字」（那是弱断言，改个变量名就假绿），
 * 而是造一个**只有正文才有的唯一标记串**，断言它不出现。
 * 若实现改成加载全文，这个标记必然泄漏 —— 无论变量怎么重命名都拦不住。
 */
import { describe, expect, test, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(REPO, "src", "index.ts");
const made: string[] = [];

/**
 * 只有 SKILL.md 正文里才有的标记。
 * frontmatter 与标题行都不含它 —— 所以它一旦出现在 /skills 输出里，
 * 就只可能是「读了正文」，即违反约束 16。
 */
const BODY_MARKER = "Z9X7V5_BODY_ONLY_MARKER";

/** 建一个含 store 的工作目录，返回 cwd。 */
function makeProject(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "neo-skills-cmd-")));
  // 假 home：src/session.ts:27 把会话目录硬编码成 join(homedir(), ".neo", "sessions")，
  // CLI 每次启动都会写一个会话文件。不隔离 HOME 的话每跑一次本文件就有18 个
  // 会话文件落进用户真实的 ~/.neo/sessions（实测 43 → 61，且只增不减）。
  // 子进程 env 里通过 HOME/USERPROFILE 指向这里。
  mkdirSync(join(cwd, "fakehome"), { recursive: true });
  const store = join(cwd, "store");
  mkdirSync(join(store, "pdf", "references"), { recursive: true });
  writeFileSync(
    join(store, "pdf", "SKILL.md"),
    `---\nname: pdf\ndescription: 提取 PDF 文本与表格。适用于读 PDF、填表格。\n---\n\n` +
      `# PDF 处理\n\n步骤一：${BODY_MARKER}，然后 read_file 读入。\n\n` +
      `## 附件\n详细规则见 references/detail.md。\n`,
    "utf8",
  );
  writeFileSync(join(store, "pdf", "references", "detail.md"), "表格识别细则", "utf8");

  mkdirSync(join(store, "docx"), { recursive: true });
  writeFileSync(
    join(store, "docx", "SKILL.md"),
    `---\nname: docx\ndescription: 生成与美化 Word 文档。适用于写报告、合同。\n---\n\n# Word 处理\n\n步骤一：DOCX_BODY_MARKER\n`,
    "utf8",
  );

  // settings.json 走 skills_store 注入 store 路径 —— 绝不碰真实 ~/.neo/skills
  writeFileSync(join(cwd, "settings.json"), JSON.stringify({ skills_store: store }), "utf8");

  made.push(cwd);
  return cwd;
}

/** 在 cwd 下跑一串斜杠命令，返回合并后的 stdout+stderr。 */
function runCommands(cwd: string, cmds: string[]): string {
  return execFileSync(process.execPath, [ENTRY], {
    cwd,
    input: `${cmds.join("\n")}\n/exit\n`,
    encoding: "utf8",
    timeout: 30_000,
    // 不设 NEO_CLASSIFIER_PROVIDER —— "off" 是分类器名不是 provider 名，
    // 设了会被 config 校验拦下。/skills 走的是本地命令分支，根本不调 LLM。
    //
    // HOME/USERPROFILE 必须重定向到沙箱内的假 home：src/session.ts:27 硬编码
    // join(homedir(), ".neo", "sessions")，不隔离就会往用户真实 home 写会话。
    // USERPROFILE 一起设是为跨平台稳妥（macOS 上 HOME 就够，设上无害）。
    env: {
      ...process.env,
      NO_COLOR: "1",
      HOME: join(cwd, "fakehome"),
      USERPROFILE: join(cwd, "fakehome"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* L1 /skills 列出全部技能                                             */
/* ------------------------------------------------------------------ */

describe("L1 /skills 列出全部技能", () => {
  test("L1.1 列出 store 里的全部技能与数量", () => {
    const out = runCommands(makeProject(), ["/skills"]);
    expect(out).toContain("可用技能");
    expect(out).toContain("pdf");
    expect(out).toContain("docx");
  });

  test("L1.2 标注来源（全局/项目）与软链状态", () => {
    const cwd = makeProject();
    // 追加两个项目侧技能：真目录（应标「项目」）与指向 store 的软链（应标「软链」）。
    //
    // 必须建在 <cwd>/skills/ —— 本用例用 runCommands(cwd, ...) 启动，
    // 子进程工作目录就是 cwd，CLI 只扫 <cwd>/skills/。
    mkdirSync(join(cwd, "skills", "local-only"), { recursive: true });
    writeFileSync(
      join(cwd, "skills", "local-only", "SKILL.md"),
      "---\nname: local-only\ndescription: 甲说明\n---\n\n# 本地\n",
      "utf8",
    );
    // 软链目标必须是 store 里**独立的**技能：若指向已存在的 pdf/docx，
    // discoverSkills 会按解析后的 absPath 去重（同一技能不算两个），
    // 列表里就只剩 docx 一行，fromlink 根本不会出现 —— 那是正确行为，不是 bug。
    mkdirSync(join(cwd, "store", "xlsx"), { recursive: true });
    writeFileSync(
      join(cwd, "store", "xlsx", "SKILL.md"),
      "---\nname: xlsx\ndescription: 丙说明\n---\n\n# 表格\n",
      "utf8",
    );
    symlinkSync(join(cwd, "store", "xlsx"), join(cwd, "skills", "fromlink"), "dir");
    // 刻意**不**往软链里写 SKILL.md —— 那是穿透写全局库，正是守卫要拦的事。

    const out = runCommands(cwd, ["/skills"]);

    // 按行取，不能用整段 toContain —— 技能名/说明里若出现「项目」「软链」等字样，
    // 整段匹配会命中说明文字而不是来源列，变异测试证实那样会变成假绿。
    const lineOf = (n: string) => out.split("\n").find((l) => l.includes(n)) ?? "";
    const storeLine = lineOf("pdf");
    const localLine = lineOf("local-only");
    const linkLine = lineOf("fromlink");

    expect(storeLine).toBeTruthy();
    expect(localLine).toBeTruthy();
    expect(linkLine).toBeTruthy();
    // store 注入 → 全局，且非软链
    expect(storeLine).toContain("全局");
    expect(storeLine).not.toContain("软链");
    // 项目真目录 → 项目，且非软链
    expect(localLine).toContain("项目");
    expect(localLine).not.toContain("软链");
    // 项目区软链 → 标「软链」
    expect(linkLine).toContain("软链");
  });

  /**
   * 隔离守卫：CLI 每次启动都会经src/session.ts:27 往
   * join(homedir(), ".neo", "sessions") 写一个会话文件。
   * runCommands 已把 HOME/USERPROFILE 重定向到沙箱假home，本用例证明它真的生效。
   *
   * 断言方式必须是**按 cwd 匹配具体会话**，**不能**断言「真实 home 会话数不变」——
   * 用户自己或并行跑的其他 neo 实例会同时往那儿写，实测计数在 110~1560 之间乱跳，
   * 那样写必然变成随机假红（coverage-gap-filler 实测踩过）。
   */
  test("L1.2.1 隔离守卫：会话不写进用户真实 home", () => {
    const realSessions = join(homedir(), ".neo", "sessions");
    const cwd = makeProject();
    mkdirSync(join(cwd, "skills", "local-only"), { recursive: true });
    writeFileSync(
      join(cwd, "skills", "local-only", "SKILL.md"),
      "---\nname: local-only\ndescription: 甲说明\n---\n\n# 本地\n",
      "utf8",
    );
    runCommands(cwd, ["/skills", "/skills local-only"]);

    // 沙箱内应确实产生了会话 —— 若为0，说明 HOME 重定向没生效，本用例等于没测
    const sbSessions = join(cwd, "fakehome", ".neo", "sessions");
    expect(existsSync(sbSessions)).toBe(true);
    const inSandbox = readdirSync(sbSessions).length;
    expect(inSandbox).toBeGreaterThan(0);

    // 真实 home 里不得出现 cwd 指向本沙箱的会话
    if (existsSync(realSessions)) {
      const cwdReal = realpathSync(cwd);
      const leaked = readdirSync(realSessions).filter((f) => {
        try {
          const meta = JSON.parse(readFileSync(join(realSessions, f), "utf8")) as {
            meta?: { cwd?: string };
          };
          const c = meta.meta?.cwd ?? "";
          return c === cwd || c === cwdReal;
        } catch {
          return false; // 别的实例正在写、文件不完整，与本用例无关
        }
      });
      expect(leaked).toEqual([]);
      // 真实 home 里也不该出现本次沙箱的任何会话文件（按内容再兜一层）
      const fakeHomePrefix = join(cwdReal, "fakehome");
      const byContent = readdirSync(realSessions).filter((f) => {
        try {
          return readFileSync(join(realSessions, f), "utf8").includes(fakeHomePrefix);
        } catch {
          return false;
        }
      });
      expect(byContent).toEqual([]);
    }
  });

  test("L1.3 展示 description 供人判断", () => {
    const out = runCommands(makeProject(), ["/skills"]);
    expect(out).toContain("提取 PDF 文本与表格");
  });

  test("L1.4 无技能时给出可操作提示而非空白", () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "neo-skills-empty-")));
    writeFileSync(join(cwd, "settings.json"), JSON.stringify({ skills_store: join(cwd, "empty") }), "utf8");
    made.push(cwd);

    const out = runCommands(cwd, ["/skills"]);
    expect(out).toContain("没有可用技能");
    // 必须告诉用户放哪去，否则是死路
    expect(out).toContain("skills");
  });

  test("L1.5 提示 use_skill 是正文加载路径", () => {
    const out = runCommands(makeProject(), ["/skills"]);
    expect(out).toContain("use_skill");
  });
});

/* ------------------------------------------------------------------ */
/* L2 约束 16：/skills 不加载 SKILL.md 全文（核心组）                  */
/* ------------------------------------------------------------------ */

describe("L2 约束 16 —— /skills 不加载 SKILL.md 全文", () => {
  test("L2.1 列表输出不含正文标记（读全文就必然泄漏）", () => {
    const out = runCommands(makeProject(), ["/skills"]);
    expect(out).not.toContain(BODY_MARKER);
  });

  test("L2.2 /skills <名称> 详情输出不含正文标记 —— 约束 16 的正主", () => {
    const out = runCommands(makeProject(), ["/skills pdf"]);
    expect(out).not.toContain(BODY_MARKER);
  });

  test("L2.3 详情输出确实展示了 SKILL.md 首行标题（证明读了文件但只取标题）", () => {
    const out = runCommands(makeProject(), ["/skills pdf"]);
    // 标题行是允许展示的（约束 16 明确说「索引信息 + SKILL.md 首行」）
    expect(out).toContain("PDF 处理");
  });

  test("L2.4 详情输出含 name/description/source/path 四要素", () => {
    const out = runCommands(makeProject(), ["/skills pdf"]);
    expect(out).toContain("pdf");
    expect(out).toContain("提取 PDF 文本与表格");
    expect(out).toContain("全局");
    // 「路径」展示的是技能**目录**（absPath），不是 SKILL.md 文件本身。
    // 这正是约束 16 的体现：只给定位信息，不给正文。
    expect(out).toMatch(/路径\s+\S+\/pdf/);
  });

  test("L2.5 详情输出显式指向 use_skill 作为正文加载路径", () => {
    const out = runCommands(makeProject(), ["/skills pdf"]);
    // 「/skills 是给人看的，加载只有 use_skill 一条路」—— 措辞可变，语义不可变
    expect(out).toContain("use_skill");
  });

  test("L2.6 多个技能时逐个查看详情也不泄漏任一正文", () => {
    const out = runCommands(makeProject(), ["/skills pdf", "/skills docx"]);
    expect(out).not.toContain(BODY_MARKER);
    expect(out).not.toContain("DOCX_BODY_MARKER");
  });
});

/* ------------------------------------------------------------------ */
/* L3 异常路径                                                         */
/* ------------------------------------------------------------------ */

describe("L3 /skills 异常路径", () => {
  test("L3.1 不存在的技能名 → 报错并列出可用技能，帮人纠正", () => {
    const out = runCommands(makeProject(), ["/skills no-such-skill"]);
    expect(out).toMatch(/不存在|找不到|未找到/);
    expect(out).toContain("pdf");
  });

  test("L3.2 非法技能名（路径穿越）→ 被拒，不得回退到文件系统查找", () => {
    const cwd = makeProject();
    // 关键：目标必须**真实存在且路径可达**，否则「回退到 existsSync 查找」的变异体
    // 走不到，测试会假绿（实测：../../ 从 /private/var/folders/... 出发会跳出沙箱）。
    //
    // 布局：mkdtemp 根 = cwd，其下有 proj/ 与 sibling-secret/。
    // 启动时用 -C/--cwd 无关，这里通过 settings.json 让 cwd 指向 proj，
    // 于是 `../sibling-secret` 从 proj 出发正好命中 —— 一个真实可达的穿越目标。
    mkdirSync(join(cwd, "sibling-secret"), { recursive: true });
    writeFileSync(
      join(cwd, "sibling-secret", "SKILL.md"),
      "---\nname: pwned\ndescription: TRAVERSAL_LEAK_MARKER\n---\n",
      "utf8",
    );
    mkdirSync(join(cwd, "proj"), { recursive: true });
    // 把 store 复制一份到 proj 下，让它在正确的 cwd 里也可用
    writeFileSync(
      join(cwd, "proj", "settings.json"),
      readFileSync(join(cwd, "settings.json"), "utf8"),
      "utf8",
    );
    const proj = join(cwd, "proj");

    const out = runCommands(proj, ["/skills ../sibling-secret"]);

    // 白名单必须拦住：含 `/` 的名字一律非法
    expect(out).toMatch(/非法|不存在|找不到|未找到/);
    // 最强断言：穿越目标的 description 绝不能被读出来。
    // 注意不要断言输出里不含 "sibling-secret" —— 报错信息回显用户输入是正常的，
    // 真正的不变量是「没有去读那个目录」。
    expect(out).not.toContain("TRAVERSAL_LEAK_MARKER");
    expect(out).not.toContain("pwned");
    // 且必须给出可用的真技能，而不是把穿越目标当作技能
    expect(out).toContain("可用技能");
  });

  test("L3.4 非法名不得被当作项目私有技能接受", () => {
    const cwd = makeProject();
    // 造一个非法名（带下划线）的真目录，§3.3 的白名单要求跳过它
    mkdirSync(join(cwd, "skills", "bad_name"), { recursive: true });
    writeFileSync(join(cwd, "skills", "bad_name", "SKILL.md"), "---\nname: bad_name\ndescription: 非法名\n---\n", "utf8");

    const out = runCommands(cwd, ["/skills bad_name"]);
    expect(out).toMatch(/非法|不存在|找不到|未找到/);
    expect(out).not.toContain("非法名"); // 不该展示它的 description
  });

  test("L3.5 白名单是唯一防线：即使有人删掉它，遍历也不得穿越 cwd", () => {
    // 本例针对「实现退化成 join(cfg.cwd, arg) 直接查文件」这种最坏写法。
    // 变异测试实测：删掉 isValidSkillName 检查后本用例必须失败 ——
    // 否则说明 /skills 存在任意文件读取面。
    const cwd = makeProject();
    mkdirSync(join(cwd, "proj"), { recursive: true });
    writeFileSync(join(cwd, "proj", "settings.json"), readFileSync(join(cwd, "settings.json"), "utf8"), "utf8");
    mkdirSync(join(cwd, "secret-dir"), { recursive: true });
    writeFileSync(
      join(cwd, "secret-dir", "SKILL.md"),
      "---\nname: whatever\ndescription: OUTSIDE_CWD_LEAK_MARKER\n---\n",
      "utf8",
    );
    const proj = join(cwd, "proj");

    const out = runCommands(proj, ["/skills ../secret-dir"]);

    // 无论白名单在不在，cwd 之外的文件内容都不该被读出来
    expect(out).not.toContain("OUTSIDE_CWD_LEAK_MARKER");
  });

  test("L3.3 缺参数时只列技能，不进入详情分支", () => {
    const out = runCommands(makeProject(), ["/skills"]);
    expect(out).toContain("pdf");
    expect(out).not.toContain("完整正文请让模型调用");
  });
});

/* ------------------------------------------------------------------ */
/* L4 与 use_skill 工具的职责分离                                       */
/* ------------------------------------------------------------------ */

describe("L4 /skills 与 use_skill 职责分离", () => {
  test("L4.1 /skills 是只读诊断入口，不创建任何软链", () => {
    const cwd = makeProject();
    expect(safeReaddir(join(cwd, "skills"))).not.toContain("pdf");

    runCommands(cwd, ["/skills", "/skills pdf"]);

    // 列技能与看详情都不该改动文件系统 —— 软链只在 use_skill 时建
    expect(safeReaddir(join(cwd, "skills"))).not.toContain("pdf");
    expect(safeReaddir(join(cwd, "skills"))).toEqual([]);
  });

  test("L4.2 /help 中已列出 /skills 命令（用户可发现）", () => {
    const out = runCommands(makeProject(), ["/help"]);
    expect(out).toContain("/skills");
  });
});

/* ------------------------------------------------------------------ */

/** 列目录内容；目录不存在时返回空数组。用 fs 而非 ls，避免 stderr 噪声。 */
function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
