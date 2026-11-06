/**
 * issue #13 —— 技能支持用户直接 `/技能名` 调用。
 *
 * 与 skills-command.test.ts 不同，本文件**直接 import** `src/skills.ts` 与
 * `src/cli/commands.ts`（不 import `src/index.ts` —— 它顶层自执行 main() 并
 * process.exit，import 即退出进程）。所以这里能拿到真正的分发逻辑，
 * 用假 Console + 假 ctx 断言「是否 enqueue 了一轮」。
 *
 * 核心不变量：
 *  - 内置命令优先，同名技能被遮挡时要提示；
 *  - 技能命中 → enqueueUserTurn 收到含正文与参数的合成消息；
 *  - 未命中 → 不 enqueue，且给出可纠正的提示；
 *  - `/skills` 仍不泄漏正文（约束 16），且 slash 路径不建软链。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchCommand, type CommandContext } from "../src/cli/commands.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { buildSkillSlashPrompt, tryLoadSkillForSlash } from "../src/skills.ts";
import { captureConsole } from "./helpers.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** 只有正文里才有的唯一标记：出现在 /skills 输出里就说明读了全文。 */
const BODY_MARKER = "SLASH_BODY_ONLY_MARKER_7Q2";

/**
 * 造一个沙箱 cwd：settings.json 里把 skills_store 指到沙箱内，
 * 绝不碰用户真实的 ~/.neo/skills。
 */
function makeCfg(extraSkills: Record<string, string> = {}): Config {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "neo-skill-slash-")));
  made.push(cwd);
  const store = join(cwd, "store");
  mkdirSync(store, { recursive: true });

  const skills: Record<string, string> = {
    demo:
      `---\nname: demo\ndescription: 演示技能。\n---\n\n# 演示\n\n步骤：${BODY_MARKER}\n`,
    ...extraSkills,
  };
  for (const [name, body] of Object.entries(skills)) {
    mkdirSync(join(store, name), { recursive: true });
    writeFileSync(join(store, name, "SKILL.md"), body, "utf8");
  }
  // 附件：验证 slash prompt 给出绝对路径
  mkdirSync(join(store, "demo", "references"), { recursive: true });
  writeFileSync(join(store, "demo", "references", "detail.md"), "细则", "utf8");

  writeFileSync(
    join(cwd, "settings.json"),
    JSON.stringify({
      skills_store: store,
      providers: [
        {
          provider_name: "test",
          provider_type: "openai",
          base_url: "http://127.0.0.1:9/v1",
          api_key: "sk-test",
          default_model_name: "m-default",
        },
      ],
    }),
    "utf8",
  );
  // loadConfig 从 process.cwd() 找 settings.json，这里显式传 cwd 覆盖
  return loadConfig({ cwd, skillsStore: store });
}

interface Harness {
  ctx: CommandContext;
  out: () => string;
  enqueued: string[];
}

/** 最小假 ctx：只填 dispatchCommand 会碰到的字段。 */
function makeCtx(cfg: Config): Harness {
  const cap = captureConsole({ stdoutIsTTY: false, stdinIsTTY: false });
  const enqueued: string[] = [];
  const ctx = {
    cfg,
    ui: cap.ui,
    agent: {} as CommandContext["agent"],
    memory: {} as CommandContext["memory"],
    classifier: {} as CommandContext["classifier"],
    meta: {} as CommandContext["meta"],
    shutdown: () => {},
    selectDeps: {} as CommandContext["selectDeps"],
    mailbox: null,
    checkpoints: null,
    enqueueUserTurn: (text: string) => {
      enqueued.push(text);
    },
  } as CommandContext;
  return { ctx, out: cap.out, enqueued };
}

/* ------------------------------------------------------------------ */
/* S1 buildSkillSlashPrompt（纯函数）                                   */
/* ------------------------------------------------------------------ */

describe("S1 buildSkillSlashPrompt", () => {
  test("S1.1 含 $ARGUMENTS 时全部替换为参数", () => {
    const text = buildSkillSlashPrompt({
      name: "demo",
      body: "# 演示\n\n处理 $ARGUMENTS，再复查 $ARGUMENTS。\n",
      args: "a b",
    });
    expect(text).toContain("处理 a b，再复查 a b。");
    expect(text).not.toContain("$ARGUMENTS");
    // 有占位符时不再追加「用户参数」段
    expect(text).not.toContain("用户参数：");
  });

  test("S1.2 无占位符且有参数 → 末尾追加「用户参数」段", () => {
    const text = buildSkillSlashPrompt({ name: "demo", body: "# 演示\n正文", args: "bar baz" });
    expect(text).toContain("用户参数：");
    expect(text).toContain("bar baz");
    // 正文仍在，且参数段在正文之后
    expect(text.indexOf("正文")).toBeLessThan(text.indexOf("bar baz"));
  });

  test("S1.3 无参数时不追加空段", () => {
    const text = buildSkillSlashPrompt({ name: "demo", body: "# 演示\n正文", args: "" });
    expect(text).not.toContain("用户参数：");
    expect(text).toContain("正文");
  });

  test("S1.4 有占位符但参数为空 → 占位符被清掉，不留字面量", () => {
    const text = buildSkillSlashPrompt({ name: "demo", body: "处理 $ARGUMENTS 即可", args: "" });
    expect(text).not.toContain("$ARGUMENTS");
    expect(text).toContain("处理  即可");
  });

  test("S1.5 附件与来源行都进 prompt", () => {
    const text = buildSkillSlashPrompt({
      name: "demo",
      body: "# 演示",
      args: "",
      files: ["/abs/demo/references/detail.md"],
      sourceLine: "来源：demo（global / 本地）",
    });
    expect(text).toContain("附件（按需自行 read_file 或执行）：");
    expect(text).toContain("/abs/demo/references/detail.md");
    expect(text).toContain("来源：demo（global / 本地）");
  });

  test("S1.6 开头明确这是用户主动调用", () => {
    const text = buildSkillSlashPrompt({ name: "demo", body: "x", args: "" });
    expect(text).toContain("/demo");
    expect(text).toContain("主动调用");
  });
});

/* ------------------------------------------------------------------ */
/* S2 tryLoadSkillForSlash                                             */
/* ------------------------------------------------------------------ */

describe("S2 tryLoadSkillForSlash", () => {
  test("S2.1 命中技能：返回正文与绝对路径附件", () => {
    const cfg = makeCfg();
    const r = tryLoadSkillForSlash(cfg, "demo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toContain(BODY_MARKER);
    expect(r.files.some((f) => f.endsWith("references/detail.md"))).toBe(true);
    // 绝对路径（slash 路径不建软链，相对路径在项目区可能不可达）
    expect(r.files.every((f) => f.startsWith("/"))).toBe(true);
  });

  test("S2.2 不建软链（人发起的入口只读，与约束 16 同一职责边界）", () => {
    const cfg = makeCfg();
    const r = tryLoadSkillForSlash(cfg, "demo");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.createdLink).toBe(false);
    // <cwd>/skills/ 下不应出现 demo 软链
    let entries: string[] = [];
    try {
      entries = readdirSync(join(cfg.cwd, "skills"));
    } catch {
      entries = [];
    }
    expect(entries).not.toContain("demo");
  });

  test("S2.3 不存在的技能 → not_found + 可用列表", () => {
    const cfg = makeCfg();
    const r = tryLoadSkillForSlash(cfg, "no-such-skill-xyz");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not_found");
    expect(r.available).toContain("demo");
  });

  test("S2.4 非法名（路径穿越）→ invalid，且不读目标", () => {
    const cfg = makeCfg();
    const r = tryLoadSkillForSlash(cfg, "../etc");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("invalid");
  });
});

/* ------------------------------------------------------------------ */
/* S3 dispatchCommand 分发                                             */
/* ------------------------------------------------------------------ */

describe("S3 dispatchCommand 分发", () => {
  test("S3.1 内置 /help 仍工作，不 enqueue", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    await dispatchCommand("/help", h.ctx);
    expect(h.out()).toContain("/skills");
    expect(h.enqueued).toEqual([]);
  });

  test("S3.2 /demo 命中技能 → enqueue 一轮，含正文标记", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    await dispatchCommand("/demo", h.ctx);
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0]).toContain(BODY_MARKER);
    expect(h.enqueued[0]).toContain("/demo");
    expect(h.out()).toContain("已调用技能 demo");
  });

  test("S3.3 /demo a b → 参数进 prompt（无占位符时走「用户参数」段）", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    await dispatchCommand("/demo a b", h.ctx);
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0]).toContain("用户参数：");
    expect(h.enqueued[0]).toContain("a b");
  });

  test("S3.4 有 $ARGUMENTS 的技能：参数替换进正文", async () => {
    const cfg = makeCfg({
      tpl: `---\nname: tpl\ndescription: 模板技能\n---\n\n# 模板\n\n处理 $ARGUMENTS\n`,
    });
    const h = makeCtx(cfg);
    await dispatchCommand("/tpl 甲 乙", h.ctx);
    expect(h.enqueued.length).toBe(1);
    expect(h.enqueued[0]).toContain("处理 甲 乙");
    expect(h.enqueued[0]).not.toContain("$ARGUMENTS");
  });

  test("S3.5 内置优先：/compact 同时存在同名技能时走内置，且有遮挡提示", async () => {
    const cfg = makeCfg({
      compact: `---\nname: compact\ndescription: 同名技能\n---\n\n# 假 compact\n\n${BODY_MARKER}\n`,
    });
    const h = makeCtx(cfg);
    // agent.compact 是内置 /compact 的必经调用；给个最小实现避免抛错
    (h.ctx.agent as unknown as { compact: () => Promise<boolean> }).compact = async () => false;

    await dispatchCommand("/compact", h.ctx);

    // 技能正文绝不能进队列
    expect(h.enqueued).toEqual([]);
    const out = h.out();
    expect(out).toContain("内置命令");
    expect(out).toContain("同名技能");
    expect(out).not.toContain(BODY_MARKER);
  });

  test("S3.6 未知技能名 → 不 enqueue，有错误提示与可用技能列表", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    await dispatchCommand("/no-such-skill-xyz", h.ctx);
    expect(h.enqueued).toEqual([]);
    const out = h.out();
    expect(out).toContain("未知命令");
    expect(out).toContain("no-such-skill-xyz");
    expect(out).toContain("demo"); // 可用技能列表帮人纠正
  });

  test("S3.7 非法名（路径穿越）→ 不 enqueue，按未知命令处理", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    await dispatchCommand("/../etc", h.ctx);
    expect(h.enqueued).toEqual([]);
    expect(h.out()).toContain("未知命令");
  });

  test("S3.8 没有 enqueueUserTurn 的入口（-p 等）→ 明确告知而不是静默吞掉", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    delete (h.ctx as { enqueueUserTurn?: unknown }).enqueueUserTurn;
    await dispatchCommand("/demo", h.ctx);
    expect(h.out()).toContain("use_skill");
  });
});

/* ------------------------------------------------------------------ */
/* S4 文案与约束 16 回归                                               */
/* ------------------------------------------------------------------ */

describe("S4 文案与约束 16", () => {
  test("S4.1 /help 说明可直接 /名称 调用", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    await dispatchCommand("/help", h.ctx);
    const out = h.out();
    expect(out).toContain("/<技能名>");
    expect(out).toContain("直接调用技能");
  });

  test("S4.2 /skills 列表提示「直接 /名称 调用」与 use_skill", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    await dispatchCommand("/skills", h.ctx);
    const out = h.out();
    expect(out).toContain("/名称");
    expect(out).toContain("use_skill");
    // 约束 16：列表不泄漏正文
    expect(out).not.toContain(BODY_MARKER);
  });

  test("S4.3 /skills demo 详情不泄漏正文，且指向 /名称 与 use_skill", async () => {
    const cfg = makeCfg();
    const h = makeCtx(cfg);
    await dispatchCommand("/skills demo", h.ctx);
    const out = h.out();
    expect(out).not.toContain(BODY_MARKER);
    expect(out).toContain("/demo");
    expect(out).toContain("use_skill");
  });
});
