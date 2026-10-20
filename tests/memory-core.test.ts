/**
 * 记忆子系统清理后的核心资产（v0.1.12 deprecated 清理）。
 *
 * 覆盖仍在使用的最小面：
 *  - 配置：memory 默认值 / 环境变量覆盖 / 总开关；
 *  - PII：脱敏模式；
 *  - /init 骨架：目录、tags.md、skills/、AGENTS.md 工作流区块与幂等；
 *  - 错误类型；
 *  - 清理守卫：deprecated 文件不得复活。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type Config } from "../src/config.ts";
import { initProjectLevel } from "../src/memory/init.ts";
import { MemoryError } from "../src/memory/types.ts";
import { redactPII } from "../src/memory/pii.ts";

let SANDBOX = "";
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-mem-core-"));
  for (const k of [
    "NEO_MEMORY_DIR",
    "NEO_USER_WIKI_DIR",
    "NEO_MEMORY_JOURNAL_DIR",
    "NEO_MEMORY_DISABLE",
  ]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(SANDBOX, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

describe("A memory 配置（清理后只剩被消费的字段）", () => {
  test("A1 默认值：双库路径 / 召回 / 捕获 / 总开关", () => {
    const cfg = loadConfig();
    expect(cfg.memory.enabled).toBe(true);
    expect(cfg.memory.userWikiDir.endsWith(join(".neo", "wiki"))).toBe(true);
    expect(cfg.memory.journalDir.endsWith(join(".neo", "memory", "journal"))).toBe(true);
    expect(cfg.memory.autoRecall.enabled).toBe(true);
    expect(cfg.memory.autoCapture.mode).toBe("boundary");
    expect(cfg.memory.autoCapture.modelTier).toBe("fast");
    expect(cfg.memory.quiet).toBe(false);
  });

  test("A2 环境变量覆盖目录与总开关", () => {
    process.env["NEO_USER_WIKI_DIR"] = join(SANDBOX, "u");
    process.env["NEO_MEMORY_JOURNAL_DIR"] = join(SANDBOX, "j");
    process.env["NEO_MEMORY_DIR"] = join(SANDBOX, "legacy");
    let cfg = loadConfig();
    expect(cfg.memory.userWikiDir).toBe(join(SANDBOX, "u"));
    expect(cfg.memory.journalDir).toBe(join(SANDBOX, "j"));
    expect(cfg.memory.userLevelDir).toBe(join(SANDBOX, "legacy"));

    process.env["NEO_MEMORY_DISABLE"] = "1";
    cfg = loadConfig();
    expect(cfg.memory.enabled).toBe(false);

    delete process.env["NEO_USER_WIKI_DIR"];
    delete process.env["NEO_MEMORY_JOURNAL_DIR"];
    delete process.env["NEO_MEMORY_DIR"];
    delete process.env["NEO_MEMORY_DISABLE"];
  });

  test("A3 旧配置字段已从类型中删除（清理守卫）", () => {
    const cfg = loadConfig();
    const m = cfg.memory as unknown as Record<string, unknown>;
    for (const dead of [
      "cwdRelativeMode",
      "worktreeIsolation",
      "maxProfileChars",
      "profileTokensLimit",
      "ingest",
      "autoWriteIndex",
      "noProfileInOneShot",
      "platform",
      "piiFilter",
      "ingestJournal",
    ]) {
      expect(m[dead]).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* PII                                                                 */
/* ------------------------------------------------------------------ */

describe("B PII 脱敏（仍被 journal / 提炼器使用）", () => {
  test("B1 密钥与邮箱被替换并计数", () => {
    const r = redactPII("key sk-abcdefghijklmnopqrstuvwxyz012345 和 a@b.com");
    expect(r.total).toBe(2);
    expect(r.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(r.text).toContain("[REDACTED:");
  });

  test("B2 modes 限定只跑指定模式", () => {
    const r = redactPII("a@b.com", { modes: ["openai-key"] });
    expect(r.total).toBe(0);
    expect(r.text).toBe("a@b.com");
  });

  test("B3 正常文本不变", () => {
    const r = redactPII("普通中文文本，没有敏感串。");
    expect(r.total).toBe(0);
    expect(r.text).toBe("普通中文文本，没有敏感串。");
  });
});

/* ------------------------------------------------------------------ */
/* /init 骨架                                                          */
/* ------------------------------------------------------------------ */

describe("C initProjectLevel（/init 骨架）", () => {
  const makeCfg = (enabled = true): Config => ({ memory: { enabled } }) as unknown as Config;

  test("C1 建 raw/wiki/outputs + tags.md + skills/ + AGENTS.md 工作流区块", async () => {
    const cwd = join(SANDBOX, "init-1");
    await initProjectLevel(makeCfg(), cwd);
    for (const sub of ["raw", "wiki", "outputs"]) {
      expect(existsSync(join(cwd, ".neo", "wiki", sub))).toBe(true);
    }
    expect(existsSync(join(cwd, ".neo", "wiki", "raw", "tags.md"))).toBe(true);
    expect(existsSync(join(cwd, "skills"))).toBe(true);
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("neo:wiki-workflow:start");
    expect(agents).toContain("neo:wiki-workflow:end");
  });

  test("C2 幂等：重复 /init 只保留一个工作流区块", async () => {
    const cwd = join(SANDBOX, "init-2");
    await initProjectLevel(makeCfg(), cwd);
    await initProjectLevel(makeCfg(), cwd);
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents.split("neo:wiki-workflow:start").length - 1).toBe(1);
    expect(agents.split("neo:wiki-workflow:end").length - 1).toBe(1);
  });

  test("C3 总开关关闭 → 完全 no-op", async () => {
    const cwd = join(SANDBOX, "init-3");
    await initProjectLevel(makeCfg(false), cwd);
    expect(existsSync(join(cwd, ".neo"))).toBe(false);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 错误类型                                                            */
/* ------------------------------------------------------------------ */

describe("D MemoryError", () => {
  test("D1 code / name / cause 可携带", () => {
    const cause = new Error("底层");
    const e = new MemoryError("raw_concurrent_modify", "锁被占用", cause);
    expect(e.code).toBe("raw_concurrent_modify");
    expect(e.name).toBe("MemoryError");
    expect(e.cause).toBe(cause);
    expect(e).toBeInstanceOf(Error);
  });
});

/* ------------------------------------------------------------------ */
/* 清理守卫                                                            */
/* ------------------------------------------------------------------ */

describe("E 清理守卫：deprecated 实现不得复活", () => {
  const memoryDir = join(import.meta.dir, "..", "src", "memory");
  const deleted = [
    "index.ts",
    "recordIndex.ts",
    "profile.ts",
    "ingest.ts",
    "forget.ts",
    "reindex.ts",
    "redact.ts",
    "schema.ts",
  ];

  test("E1 已删除的旧模块文件不存在", () => {
    for (const f of deleted) {
      expect({ file: f, exists: existsSync(join(memoryDir, f)) }).toEqual({ file: f, exists: false });
    }
  });

  test("E2 现行模块齐备", () => {
    for (const f of ["bridge", "capture", "distill", "init", "journal", "layout", "locks", "merge", "pii", "port", "recall", "types", "agMd"]) {
      expect({ file: f, exists: existsSync(join(memoryDir, `${f}.ts`)) }).toEqual({ file: f, exists: true });
    }
  });

  test("E3 旧模板与陈旧 wiki 工作流页已删除", () => {
    const root = join(import.meta.dir, "..");
    for (const p of [
      join(root, "src", "wiki", "templates", "wiki-INDEX.md"),
      join(root, "src", "wiki", "templates", "wiki-log.md"),
      join(root, "src", "wiki", "templates", "raw-README.md"),
      join(root, "src", "wiki", "templates", "outputs-README.md"),
      join(root, ".neo", "wiki", "wiki", "工作流-ingest-query-lint.md"),
    ]) {
      expect({ path: p, exists: existsSync(p) }).toEqual({ path: p, exists: false });
    }
  });
});
