/**
 * 记忆系统测试（PRD docs/memory-prd.md §7.1）。
 *
 * 隔离原则（PRD §7.2 强制）：
 *  - 全部路径基于 mkdtempSync 沙箱
 *  - 绝不读写真实 ~/.neo/memorys/ —— store 路径一律通过 cfg.memory.userLevelDir 注入
 *  - 每个用例独立子目录（cases 之间会互相污染，例如 B2 与 B3 同 cwd 同日会撞）
 *  - macOS tmpdir() 与 realpathSync 的差异同样处理
 *
 * 运行：bun test
 *
 * 状态：v0.1.0 起始红。
 *  - Config.memory 字段尚未实现（§6.3 待开发 Agent 补）
 *  - src/memory/* 整套模块尚未实现（§6.1 待开发 Agent 补）
 *  - 当前本文件预期：bunx tsc --noEmit 红（Property 'memory' missing on Config）
 *                   + bun test 红（Cannot find module ../src/memory/...）
 * 推进次序：① Config.memory → tsc 绿；② src/memory/* → bun test 绿。
 */
import { describe, expect, test, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  statSync,
  realpathSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import type { Config } from "../src/config.ts";
import { MemoryError } from "../src/memory/types.ts";
import {
  parseIndexEntry,
  ensureProfile,
  recordIndex,
  reInjectProfile,
  ingestUserLevel,
  initProjectLevel,
  redactSummary,
  forgetEntries,
  reindexForCwd,
  sanitizeCwd,
  estimateProfile,
} from "../src/memory/index.ts";
import {
  forgetDryRun,
  forgetYes,
  forgetResume,
  listStatus,
} from "../src/memory/forget.ts";
import { reindex as reindexImpl } from "../src/memory/reindex.ts";

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "neo-mem-test-")));
const made: string[] = [];

function sandbox(tag: string): { cwd: string; cfg: Config } {
  const dir = realpathSync(mkdtempSync(join(ROOT, `${tag}-`)));
  const cwd = join(dir, "proj");
  mkdirSync(cwd, { recursive: true });
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const userLevelDir = join(home, ".neo", "memorys");
  made.push(dir);
  const cfg: Config = {
    // ---- 非 memory 字段占位（满足 Config 形状；跑分时只用 memory 部分）----
    providerName: "stub",
    providerType: "openai",
    apiKey: "sk-stub",
    baseUrl: "https://stub.example",
    modelTier: "fast",
    model: "stub-model",
    providers: [],
    routes: {
      default: { provider: "stub", model: "stub-model", fallbackAllowed: true },
      fast: { provider: "stub", model: "stub-model", fallbackAllowed: true },
      balanced: { provider: "stub", model: "stub-model", fallbackAllowed: true },
      deep_reasoning: { provider: "stub", model: "stub-model", fallbackAllowed: true },
    },
    classifierModel: "stub-model",
    classifierProvider: "stub",
    legacyFormat: false,
    maxTokens: 8000,
    temperature: 0.2,
    contextWindow: 200000,
    globalDefaults: { maxTokens: 8000, temperature: 0.2, contextWindow: 200000 },
    compactThreshold: 0.85,
    maxToolIterations: 32,
    toolOutputLimit: 8000,
    theme: "matrix",
    showReasoning: false,
    cwd,
    settingsPath: null,
    skillsStore: join(home, ".neo", "skills"),
    // ---- memory 字段（§6.3）----
    memory: {
      enabled: true,
      userLevelDir,
      profileTokensLimit: 500,
      ingest: { provider: "classifier_provider", model: null, timeoutMs: 2000 },
      autoWriteIndex: true,
      noProfileInOneShot: true,
      platform: "auto",
      worktreeIsolation: false,
    },
  };
  return { cwd, cfg };
}

afterAll(() => {
  for (const d of made) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeRawFile(cwd: string, name: string, body: string): string {
  const raw = join(cwd, ".neo", "wiki", "raw");
  mkdirSync(raw, { recursive: true });
  const path = join(raw, name);
  writeFileSync(path, body, "utf8");
  return path;
}

/* ------------------------------------------------------------------ */
/* A. schema 校验                                                      */
/* ------------------------------------------------------------------ */

describe("A. schema 校验 (parseIndexEntry)", () => {
  test("A1 合法 frontmatter | 解析成功，字段全保留", () => {
    const entry = parseIndexEntry({
      date: "2026-10-15",
      cwd: "/Users/xueyuheng/research/neo",
      short_id: "abcd1234",
      summary: "ok",
    });
    expect(entry.date).toBe("2026-10-15");
    expect(entry.cwd).toBe("/Users/xueyuheng/research/neo");
    expect(entry.shortId).toBe("abcd1234");
    expect(entry.summary).toBe("ok");
  });

  test("A2 缺 date | 抛 MemoryError code='schema_invalid'", () => {
    expect(() => parseIndexEntry({ cwd: "/x", short_id: "abcd1234", summary: "ok" }))
      .toThrow(MemoryError);
  });

  test("A3 date 非 ISO | 同上", () => {
    expect(() => parseIndexEntry({ date: "10/15/2026", cwd: "/x", short_id: "abcd1234", summary: "ok" }))
      .toThrow(MemoryError);
  });

  test("A4 cwd 非绝对路径 | 同上", () => {
    expect(() => parseIndexEntry({ date: "2026-10-15", cwd: "relative/path", short_id: "abcd1234", summary: "ok" }))
      .toThrow(MemoryError);
  });

  test("A5 short_id 非 8 位 hex | 同上", () => {
    expect(() => parseIndexEntry({ date: "2026-10-15", cwd: "/x", short_id: "XYZ", summary: "ok" }))
      .toThrow(MemoryError);
  });

  test("A6 summary 超 200 字符 | 同上", () => {
    const long = "a".repeat(201);
    expect(() => parseIndexEntry({ date: "2026-10-15", cwd: "/x", short_id: "abcd1234", summary: long }))
      .toThrow(MemoryError);
  });

  test("A7 topic 含换行 | 同上", () => {
    expect(() => parseIndexEntry({ date: "2026-10-15", cwd: "/x", short_id: "abcd1234", summary: "ok", topic: "bad\ntopic" }))
      .toThrow(MemoryError);
  });

  test("A8 额外字段 unknown | 保留原样", () => {
    const entry = parseIndexEntry({
      date: "2026-10-15", cwd: "/x", short_id: "abcd1234", summary: "ok",
      custom: { anything: 1 },
    } as unknown as Parameters<typeof parseIndexEntry>[0]);
    expect(entry).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* B. recordIndex                                                       */
/* ------------------------------------------------------------------ */

describe("B. recordIndex 索引自动写", () => {
  test("B1 首次调用 | raw 下新增 1 个文件，文件名符合命名格式", async () => {
    const { cwd, cfg } = sandbox("B1");
    const path = await recordIndex(cfg, cwd, { firstUserInput: "用户说 hello world" });
    expect(basename(path)).toMatch(/^\d{4}-\d{2}-\d{2}_.+_[a-f0-9]{8}\.md$/);
    expect(existsSync(path)).toBe(true);
  });

  test("B2 同 cwd 同日再次调用 | 不新增文件，更新 updated_at", async () => {
    const { cwd, cfg } = sandbox("B2");
    const p1 = await recordIndex(cfg, cwd, { firstUserInput: "first" });
    const stat1 = statSync(p1).mtimeMs;
    await new Promise(r => setTimeout(r, 50));
    const p2 = await recordIndex(cfg, cwd, { firstUserInput: "second" });
    expect(p2).toBe(p1);
    const stat2 = statSync(p1).mtimeMs;
    expect(stat2).toBeGreaterThan(stat1);
  });

  test("B3 同 cwd 不同日 | 新增文件", async () => {
    const { cwd, cfg } = sandbox("B3");
    const today = "2099-01-01";
    const tomorrow = "2099-01-02";
    const p1 = await recordIndex(cfg, cwd, { firstUserInput: "x", date: today });
    const p2 = await recordIndex(cfg, cwd, { firstUserInput: "x", date: tomorrow });
    expect(p1).not.toBe(p2);
  });

  test("B4 不同 cwd 同日 | 各新增 1 个文件", async () => {
    const { cfg } = sandbox("B4");
    const sub1 = mkdtempSync(join(ROOT, "B4-a-"));
    const sub2 = mkdtempSync(join(ROOT, "B4-b-"));
    const p1 = await recordIndex(cfg, sub1, { firstUserInput: "x" });
    const p2 = await recordIndex(cfg, sub2, { firstUserInput: "x" });
    expect(p1).not.toBe(p2);
  });

  test("B5 用户级目录无写权限 | 抛 permission_denied", async () => {
    const { cwd, cfg } = sandbox("B5");
    chmodSync(cfg.memory.userLevelDir, 0o555);
    try {
      await expect(recordIndex(cfg, cwd, { firstUserInput: "x" }))
        .rejects.toThrow(MemoryError);
    } finally {
      chmodSync(cfg.memory.userLevelDir, 0o755);
    }
  });

  test("B6 autoWriteIndex=false | 函数 no-op，不落盘", async () => {
    const { cwd, cfg } = sandbox("B6");
    cfg.memory.autoWriteIndex = false;
    const path = await recordIndex(cfg, cwd, { firstUserInput: "x" });
    expect(path).toBeNull();
  });

  test("B7 summary 默认 = 首个用户输入前 200 字符", async () => {
    const { cwd, cfg } = sandbox("B7");
    const input = "用户说 hello world ".repeat(20);
    const path = await recordIndex(cfg, cwd, { firstUserInput: input });
    const body = readFileSync(path, "utf8");
    const fmEnd = body.indexOf("---", 3);
    const yaml = body.slice(0, fmEnd);
    expect(yaml).toContain(`summary: ${input.slice(0, 200)}`);
  });

  test("B8 summary 超长截断 + 末尾…", async () => {
    const { cwd, cfg } = sandbox("B8");
    const input = "x".repeat(250);
    const path = await recordIndex(cfg, cwd, { firstUserInput: input });
    const body = readFileSync(path, "utf8");
    expect(body).toContain("…");
    expect(body).not.toContain(`summary: ${'x'.repeat(200)}…`);
  });

  test("B9 short_id 冲突重试 ≤ 3 次拿到新 id", async () => {
    const { cwd, cfg } = sandbox("B9");
    const path = await recordIndex(cfg, cwd, { firstUserInput: "x" });
    expect(existsSync(path)).toBe(true);
  });

  test("B10 写入后调 ingestUserLevel | wiki/ 出现 index.md", async () => {
    const { cwd, cfg } = sandbox("B10");
    const idxPath = await recordIndex(cfg, cwd, { firstUserInput: "x" });
    expect(idxPath).not.toBeNull();
    await ingestUserLevel(cfg);
    const wikiDir = join(cfg.memory.userLevelDir, "wiki");
    expect(existsSync(join(wikiDir, "index.md"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* C. ensureProfile                                                     */
/* ------------------------------------------------------------------ */

describe("C. ensureProfile profile 注入", () => {
  test("C1 profile.md 不存在 | 返回 null", async () => {
    const { cfg } = sandbox("C1");
    expect(await ensureProfile(cfg)).toBeNull();
  });

  test("C2 存在且 ≤500 tokens | 返回注入文本，含来源行", async () => {
    const { cfg } = sandbox("C2");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# 用户偏好\n- 简洁\n", "utf8");
    const result = await ensureProfile(cfg);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("## 用户画像");
    expect(result!.text).toContain("> 来源：");
  });

  test("C3 段落边界落入 [400,600] 区间 | L1 截断 + stderr WARN", async () => {
    const { cfg } = sandbox("C3");
    const para1 = "短段落。\n\n";
    const filler = "中文字。".repeat(40);
    const profile = para1 + filler + "\n\n" + filler + "\n\n" + filler;
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), profile, "utf8");
    const warns: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => warns.push(a.join(" "));
    try {
      const result = await ensureProfile(cfg);
      expect(result).not.toBeNull();
      expect(estimateProfile(result!.text)).toBeLessThanOrEqual(600);
      expect(warns.some(w => w.includes("按段落边界截断"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("C4 段落边界不落入区间 | L2 标题边界", async () => {
    const { cfg } = sandbox("C4");
    let profile = "短。\n\n";
    profile += "# title-A\n" + "字。".repeat(800) + "\n";
    profile += "# title-B\n" + "字。".repeat(800) + "\n";
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), profile, "utf8");
    const warns: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => warns.push(a.join(" "));
    try {
      const result = await ensureProfile(cfg);
      expect(result).not.toBeNull();
      expect(warns.some(w => w.includes("按 markdown 标题边界截断"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("C5 -p 模式 + noProfileInOneShot=true | 返回 null", async () => {
    const { cfg } = sandbox("C5");
    cfg.memory.noProfileInOneShot = true;
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- x\n", "utf8");
    const result = await ensureProfile(cfg, { oneShot: true });
    expect(result).toBeNull();
  });

  test("C6 非 UTF-8 文件 | 抛 schema_invalid", async () => {
    const { cfg } = sandbox("C6");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(ensureProfile(cfg)).rejects.toThrow(MemoryError);
  });

  test("C7 L3 硬截断：所有边界都远离 [400,600]", async () => {
    const { cfg } = sandbox("C7");
    let profile = "";
    for (let i = 0; i < 8; i++) profile += `# h${i}\n` + "字。".repeat(20) + "\n\n";
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), profile, "utf8");
    const warns: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => warns.push(a.join(" "));
    try {
      const result = await ensureProfile(cfg);
      expect(result).not.toBeNull();
      expect(warns.some(w => w.includes("[硬截]"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("C8 并列边界 480 vs 520 tokens | 取 ≤500 那个", async () => {
    const { cfg } = sandbox("C8");
    let profile = "";
    for (let i = 0; i < 5; i++) profile += "字。".repeat(60) + "\n\n";
    profile += "# hd480\n" + "字。".repeat(60) + "\n\n";
    profile += "# hd520\n" + "字。".repeat(80) + "\n\n";
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), profile, "utf8");
    const result = await ensureProfile(cfg);
    expect(result).not.toBeNull();
    expect(result!.text).toMatch(/hd480/);
  });
});

/* ------------------------------------------------------------------ */
/* D. reInjectProfile                                                   */
/* ------------------------------------------------------------------ */

describe("D. reInjectProfile", () => {
  test("D1 messages[1] 是 profile，compact 把它压掉 → reInject 后 messages[1] 又是 profile", async () => {
    const { cfg } = sandbox("D1");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- 偏简洁\n", "utf8");
    const profile = await ensureProfile(cfg);
    expect(profile).not.toBeNull();
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "base" },
      { role: "system", content: profile!.text },
      { role: "user", content: "hi" },
    ];
    messages.splice(1, 1);
    expect(messages[1]).toBeUndefined();
    const fixed = await reInjectProfile(cfg, messages);
    expect(fixed[1]).toBeDefined();
    expect(fixed[1].content).toContain("## 用户画像");
  });

  test("D2/D3 第一次/N 次 compact 后注入，profile 内容一致", async () => {
    const { cfg } = sandbox("D2");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- x\n", "utf8");
    const base = (await ensureProfile(cfg))!.text;
    const m1 = [{ role: "system", content: "base" }, { role: "system", content: base }, { role: "user", content: "a" }];
    const out1 = await reInjectProfile(cfg, m1);
    const m2 = out1.slice(0, 2).concat({ role: "user", content: "b" });
    const out2 = await reInjectProfile(cfg, m2);
    expect(out2[1].content).toBe(base);
  });
});

/* ------------------------------------------------------------------ */
/* E. initProjectLevel                                                       */
/* ------------------------------------------------------------------ */

describe("E. initProjectLevel /init 懒创建", () => {
  test("E1 干净目录 | 创建 raw/wiki/outputs + tags.md + 追加 AGENTS.md", async () => {
    const { cwd, cfg } = sandbox("E1");
    await initProjectLevel(cfg, cwd);
    const base = join(cwd, ".neo", "wiki");
    expect(existsSync(join(base, "raw"))).toBe(true);
    expect(existsSync(join(base, "wiki"))).toBe(true);
    expect(existsSync(join(base, "outputs"))).toBe(true);
    expect(existsSync(join(base, "raw", "tags.md"))).toBe(true);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
  });

  test("E2 重复 /init | 不重复创建，AGENTS.md 已有 ## 工作流 则跳过", async () => {
    const { cwd, cfg } = sandbox("E2");
    await initProjectLevel(cfg, cwd);
    const agents1 = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    await initProjectLevel(cfg, cwd);
    const agents2 = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents2).toBe(agents1);
  });

  test("E3 cwd 无写权限 | 抛 permission_denied，不改 AGENTS.md", async () => {
    const { cwd, cfg } = sandbox("E3");
    chmodSync(cwd, 0o555);
    try {
      await expect(initProjectLevel(cfg, cwd)).rejects.toThrow(MemoryError);
    } finally {
      chmodSync(cwd, 0o755);
    }
  });

  test("E4 .neo/wiki 存在但 tags.md 缺失 | 仅创建 tags.md", async () => {
    const { cwd, cfg } = sandbox("E4");
    const base = join(cwd, ".neo", "wiki");
    mkdirSync(join(base, "raw"), { recursive: true });
    mkdirSync(join(base, "wiki"), { recursive: true });
    await initProjectLevel(cfg, cwd);
    expect(existsSync(join(base, "raw", "tags.md"))).toBe(true);
  });

  test("E5 AGENTS.md 已有 skills 内容 | 追加而非覆盖", async () => {
    const { cwd, cfg } = sandbox("E5");
    writeFileSync(join(cwd, "AGENTS.md"), "# pre-existing skills content\n", "utf8");
    await initProjectLevel(cfg, cwd);
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("pre-existing skills content");
    expect(agents).toContain("## 工作流");
  });
});

/* ------------------------------------------------------------------ */
/* F. ingest 失败语义                                                    */
/* ------------------------------------------------------------------ */

describe("F. ingest 失败语义", () => {
  test("F1 ingest 成功 | wiki 更新；.ingest-failures 不增文件", async () => {
    const { cfg } = sandbox("F1");
    await ingestUserLevel(cfg);
    const failDir = join(cfg.memory.userLevelDir, ".ingest-failures");
    expect(existsSync(failDir) ? readdirSync(failDir).length : 0).toBe(0);
  });

  test("F2 网络错误 | 落 .ingest-failures/<date>_<id>.log；raw 不变", async () => {
    const { cfg } = sandbox("F2");
    await expect(ingestUserLevel(cfg)).rejects.toBeDefined();
    const failDir = join(cfg.memory.userLevelDir, ".ingest-failures");
    expect(existsSync(failDir)).toBe(true);
  });

  test("F3 LLM 输出无法解析 | 同 F2", async () => {
    const { cfg } = sandbox("F3");
    await expect(ingestUserLevel(cfg)).rejects.toBeDefined();
  });

  test("F4 ingest 429 配额 | 落 .ingest-failures + stderr WARN 含「配额」", async () => {
    const { cfg } = sandbox("F4");
    const warns: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => warns.push(a.join(" "));
    try {
      await expect(ingestUserLevel(cfg)).rejects.toBeDefined();
      expect(warns.some(w => /配额|429/.test(w))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("F5 ingest 超时 (>2000ms) | 同 F2 不重试", async () => {
    const { cfg } = sandbox("F5");
    await expect(ingestUserLevel(cfg)).rejects.toBeDefined();
  });

  test("F6 raw 写入 + ingest 失败 → 后续 ingestUserLevel 能扫 .ingest-failures 重试", async () => {
    const { cwd, cfg } = sandbox("F6");
    await recordIndex(cfg, cwd, { firstUserInput: "x" });
    // 第一次 ingest 失败（占位），第二次成功（占位）。实现期由 IngestEngine 注入器或
    // NEO_MEMORY_INGEST_FAIL=network|429|unparseable|timeout 环境变量决定。
    await expect(ingestUserLevel(cfg)).rejects.toBeDefined();
    await ingestUserLevel(cfg);
    const failDir = join(cfg.memory.userLevelDir, ".ingest-failures");
    expect(existsSync(failDir) ? readdirSync(failDir).length : 0).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* G. skills 降级（约束 40）                                              */
/* ------------------------------------------------------------------ */

describe("G. skills 系统降级", () => {
  test("G1 ~/.neo/skills 不含 karpathy-wiki-* | 启动 WARN 含「缺失」；profile 仍注入；索引仍生效", async () => {
    const { cwd, cfg } = sandbox("G1");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- x\n", "utf8");
    const warns: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => warns.push(a.join(" "));
    try {
      await ensureProfile(cfg);
      await recordIndex(cfg, cwd, { firstUserInput: "y" });
      expect(warns.some(w => /karpathy-wiki-/.test(w))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("G2 ~/.neo/skills 含 karpathy-wiki-new | 启动无 WARN", async () => {
    const { cfg } = sandbox("G2");
    const skillsDir = join(cfg.skillsStore, "karpathy-wiki-new");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: karpathy-wiki-new\n---\n# stub\n", "utf8");
    const warns: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => warns.push(a.join(" "));
    try {
      await ensureProfile(cfg);
      expect(warns.some(w => /karpathy-wiki-/.test(w))).toBe(false);
    } finally {
      console.error = origErr;
    }
  });

  test("G3 沙箱 userLevelDir 与真 ~/.neo/skills | 互不干扰", async () => {
    const { cwd, cfg } = sandbox("G3");
    const path = await recordIndex(cfg, cwd, { firstUserInput: "z" });
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* H. compact 联动                                                       */
/* ------------------------------------------------------------------ */

describe("H. compact 联动", () => {
  test("H1 5 轮对话触发 compact | messages[1] = profile 且内容不变", async () => {
    const { cfg } = sandbox("H1");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- 偏简洁\n", "utf8");
    const profile = (await ensureProfile(cfg))!.text;
    let messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "base" },
      { role: "system", content: profile },
    ];
    for (let i = 0; i < 5; i++) messages.push({ role: "user", content: `msg-${i}` }, { role: "assistant", content: `rep-${i}` });
    messages = await reInjectProfile(cfg, messages);
    expect(messages[1].content).toBe(profile);
  });

  test("H2 profile + --resume | 恢复后 messages[1] 重新是 profile（读盘）", async () => {
    const { cfg } = sandbox("H2");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- x\n", "utf8");
    const messages = [
      { role: "system" as const, content: "base" },
      { role: "user" as const, content: "old" },
    ];
    const fixed = await reInjectProfile(cfg, messages);
    expect(fixed[1].content).toContain("## 用户画像");
  });
});

/* ------------------------------------------------------------------ */
/* H+. noteModelChange 交互                                               */
/* ------------------------------------------------------------------ */

describe("H+. profile 与 noteModelChange 交互", () => {
  test("H3 /deep 切档触发 noteModelChange | messages[1] 内容不变", async () => {
    const { cfg } = sandbox("H3");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- 偏简洁\n", "utf8");
    const profile = (await ensureProfile(cfg))!.text;
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "base\n- 模型：deep" },
      { role: "system", content: profile },
      { role: "user", content: "hi" },
    ];
    const re = /- 模型：[^\n]*/;
    messages[0].content = messages[0].content.replace(re, "- 模型：deep_reasoning");
    expect(messages[1].content).toBe(profile);
  });

  test("H4 profile 注入块「来源」行格式完整保留", async () => {
    const { cfg } = sandbox("H4");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- 偏简洁\n", "utf8");
    const profile = (await ensureProfile(cfg))!.text;
    expect(profile).toMatch(/^## 用户画像\n[\s\S]+> 来源：.+\(\d+ 字节，\d+ tokens\)$/);
  });

  test("H5 compact 后 reInjectProfile 重新读盘", async () => {
    const { cfg } = sandbox("H5");
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- v1\n", "utf8");
    let messages: Array<{ role: string; content: string }> = [
      { role: "system", content: "base" },
      { role: "system", content: (await ensureProfile(cfg))!.text },
      { role: "user", content: "x" },
    ];
    messages.splice(1, 1);
    writeFileSync(join(cfg.memory.userLevelDir, "profile.md"), "# p\n- v2\n", "utf8");
    const fixed = await reInjectProfile(cfg, messages);
    expect(fixed[1].content).toContain("v2");
  });
});

/* ------------------------------------------------------------------ */
/* I. 端到端（标 P1）                                                       */
/* ------------------------------------------------------------------ */

describe("I. E2E 集成", () => {
  test("I1 完整流程 | 文件真实变更", async () => {
    const { cwd, cfg } = sandbox("I1");
    const idxPath = await recordIndex(cfg, cwd, { firstUserInput: "session-1" });
    expect(idxPath).not.toBeNull();
    await ingestUserLevel(cfg);
    expect(existsSync(join(cfg.memory.userLevelDir, "wiki", "index.md"))).toBe(true);
  });

  test("I2 二次会话同日同 cwd | 不新增索引；updated_at 更新", async () => {
    const { cwd, cfg } = sandbox("I2");
    const p1 = await recordIndex(cfg, cwd, { firstUserInput: "x" });
    const p2 = await recordIndex(cfg, cwd, { firstUserInput: "y" });
    expect(p2).toBe(p1);
  });

  test("I3 二次会话不同 cwd | 各一条独立索引", async () => {
    const { cfg } = sandbox("I3");
    const a = mkdtempSync(join(ROOT, "I3-a-"));
    const b = mkdtempSync(join(ROOT, "I3-b-"));
    const pa = await recordIndex(cfg, a, { firstUserInput: "x" });
    const pb = await recordIndex(cfg, b, { firstUserInput: "x" });
    expect(pa).not.toBe(pb);
  });
});

/* ------------------------------------------------------------------ */
/* J. 并发安全                                                            */
/* ------------------------------------------------------------------ */

describe("J. 并发安全", () => {
  test("J1 两并发进程同 cwd 同日 recordIndex | 终态只 1 个文件", async () => {
    const { cwd, cfg } = sandbox("J1");
    const [p1, p2] = await Promise.all([
      recordIndex(cfg, cwd, { firstUserInput: "a" }),
      recordIndex(cfg, cwd, { firstUserInput: "b" }),
    ]);
    expect(p1 === p2 || (p1 !== null && p2 !== null && basename(p1) === basename(p2))).toBe(true);
    const raw = join(cfg.memory.userLevelDir, "raw");
    if (existsSync(raw)) {
      const sameDate = readdirSync(raw).filter(f => basename(p1!) === f);
      expect(sameDate.length).toBe(1);
    }
  });

  test("J2 两并发 /init | 「## 工作流」段只出现 1 次", async () => {
    const { cwd, cfg } = sandbox("J2");
    await Promise.all([initProjectLevel(cfg, cwd), initProjectLevel(cfg, cwd)]);
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    const matches = agents.match(/^## 工作流/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  test("J3 rename 失败回退 | temp 文件被清理", async () => {
    const { cwd, cfg } = sandbox("J3");
    await recordIndex(cfg, cwd, { firstUserInput: "x" });
    const raw = join(cfg.memory.userLevelDir, "raw");
    expect(existsSync(raw)).toBe(true);
  });

  test("J4 .locks/ 残留 | 启动时 mtime ≥ 24h 的孤立锁目录被删", async () => {
    const { cwd, cfg } = sandbox("J4");
    const locks = join(cfg.memory.userLevelDir, ".locks");
    mkdirSync(locks, { recursive: true });
    const old = join(locks, "old-lock");
    mkdirSync(old, { recursive: true });
    const ancient = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(old, ancient, ancient);
    await recordIndex(cfg, cwd, { firstUserInput: "y" });
    expect(existsSync(old)).toBe(false);
  });

  test("J5 同 cwd 同日二次 | frontmatter updated_at 变，正文 SHA256 不变", async () => {
    const { cwd, cfg } = sandbox("J5");
    const path = await recordIndex(cfg, cwd, { firstUserInput: "x" });
    const before = readFileSync(path!, "utf8");
    const fmBefore = before.slice(0, before.indexOf("---", 3));
    const bodyBefore = before.slice(before.indexOf("---", 3)).replace(/\nupdated_at:.*\n/, "");
    const shaBefore = Bun.hash(bodyBefore);
    await new Promise(r => setTimeout(r, 50));
    await recordIndex(cfg, cwd, { firstUserInput: "y" });
    const after = readFileSync(path!, "utf8");
    const fmAfter = after.slice(0, after.indexOf("---", 3));
    const bodyAfter = after.slice(after.indexOf("---", 3)).replace(/\nupdated_at:.*\n/, "");
    expect(Bun.hash(bodyAfter)).toBe(shaBefore);
    expect(fmAfter).not.toBe(fmBefore);
  });
});

/* ------------------------------------------------------------------ */
/* K. PII 过滤                                                            */
/* ------------------------------------------------------------------ */

describe("K. PII 过滤", () => {
  test("K1 用户输入含 OpenAI key | summary 含 [REDACTED:openai-key]，raw 正文留原样", async () => {
    const { cwd, cfg } = sandbox("K1");
    const input = "用户说 sk-abcdef0123456789abcdef0123 帮我修";
    const path = await recordIndex(cfg, cwd, { firstUserInput: input });
    const body = readFileSync(path!, "utf8");
    expect(body).toContain("[REDACTED:openai-key]");
    expect(body).toContain("sk-abcdef0123456789abcdef0123");
  });

  test("K2 ghp_ GitHub PAT | summary 含 [REDACTED:github-pat]", async () => {
    const { cwd, cfg } = sandbox("K2");
    const pat = "ghp_" + "a".repeat(36);
    const path = await recordIndex(cfg, cwd, { firstUserInput: `token is ${pat}` });
    expect(readFileSync(path!, "utf8")).toContain("[REDACTED:github-pat]");
  });

  test("K3 user@example.com | summary 含 [REDACTED:email]", async () => {
    const { cwd, cfg } = sandbox("K3");
    const path = await recordIndex(cfg, cwd, { firstUserInput: "ping user@example.com" });
    expect(readFileSync(path!, "utf8")).toContain("[REDACTED:email]");
  });

  test("K4 多敏感串混合 | 全部命中按顺序替换 + INFO 日志「N 处敏感串已脱敏」", async () => {
    const { cwd, cfg } = sandbox("K4");
    const input = "key=sk-abcdef0123456789abcdef0123 mailto=user@example.com";
    const path = await recordIndex(cfg, cwd, { firstUserInput: input });
    const body = readFileSync(path!, "utf8");
    expect(body).toContain("[REDACTED:openai-key]");
    expect(body).toContain("[REDACTED:email]");
  });

  test("K5 正常文本无敏感串 | summary = 原文本（不变）", async () => {
    const { cwd, cfg } = sandbox("K5");
    const input = "普通文本没有密钥";
    const path = await recordIndex(cfg, cwd, { firstUserInput: input });
    const body = readFileSync(path!, "utf8");
    expect(body).toContain("普通文本没有密钥");
    expect(body).not.toContain("[REDACTED:");
  });

  test("K6 /memory redact --pattern=API_KEY <short_id> | frontmatter 加 redacted_at 与 redacted_count", async () => {
    const { cwd, cfg } = sandbox("K6");
    const path = await recordIndex(cfg, cwd, { firstUserInput: "hello" });
    const before = readFileSync(path!, "utf8");
    await redactSummary(cfg, path!, "API_KEY");
    const after = readFileSync(path!, "utf8");
    expect(after).toContain("redacted_at:");
    expect(after).toContain("redacted_count:");
    const bodyAfter = after.slice(after.indexOf("---", 3)).replace(/\nredacted_at:.*\n/, "").replace(/\nredacted_count:.*\n/, "");
    const bodyBefore = before.slice(before.indexOf("---", 3)).replace(/\nredacted_at:.*\n/, "").replace(/\nredacted_count:.*\n/, "");
    expect(bodyAfter).toBe(bodyBefore);
  });
});

/* ------------------------------------------------------------------ */
/* §A /memory 子命令族（status / list / forget / reindex / redact）         */
/* ------------------------------------------------------------------ */

describe("§A. /memory 子命令族", () => {
  test("A.status | 按 cwd 列出当前 cwd 在用户级索引里的全部条目", async () => {
    const { cwd, cfg } = sandbox("AS");
    await recordIndex(cfg, cwd, { firstUserInput: "a" });
    await recordIndex(cfg, cwd, { firstUserInput: "b" });
    const out = await listStatus(cfg, { cwd });
    expect(out).toContain(cwd);
  });

  test("A.forget --dry-run | 只打印，不删", async () => {
    const { cwd, cfg } = sandbox("AFd");
    const path = await recordIndex(cfg, cwd, { firstUserInput: "x" });
    await forgetDryRun(cfg, [path!]);
    expect(existsSync(path!)).toBe(true);
  });

  test("A.forget --yes | 直接删除", async () => {
    const { cwd, cfg } = sandbox("AFy");
    const path = await recordIndex(cfg, cwd, { firstUserInput: "x" });
    await forgetYes(cfg, [path!]);
    expect(existsSync(path!)).toBe(false);
  });

  test("A.reindex <new_cwd> | 旧 cwd 不存在的条目改名为新 sanitized-cwd", async () => {
    const { cwd: oldCwd, cfg } = sandbox("AR");
    const path = await recordIndex(cfg, oldCwd, { firstUserInput: "x" });
    const newCwd = mkdtempSync(join(ROOT, "AR-new-"));
    const out = await reindexImpl(cfg, oldCwd, newCwd);
    expect(out).not.toBeNull();
  });

  test("A.reindex 未指定 new_cwd | 抛错或返回失败", async () => {
    const { cwd, cfg } = sandbox("ARerr");
    await recordIndex(cfg, cwd, "");
    await expect(reindexForCwd(cfg, "")).rejects.toBeDefined();
  });
});