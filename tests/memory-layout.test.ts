/**
 * 记忆双作用域布局与锁 / 原子写（v0.2 记忆激活 M0）。
 *
 * 规格：docs/001-memory-system-design[done].md §7.5（存储）、§7.5.7（锁与原子写）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertInsideLayout,
  ensureScopeLayout,
  isInside,
  resolveBothLayouts,
  resolveScopeLayout,
  scopeLockDir,
  scopeRoot,
} from "../src/memory/layout.ts";
import { acquireLock, releaseLock, tryAcquireLock, withLock } from "../src/memory/locks.ts";
import { userWikiRoot, resolveUserWikiLayout } from "../src/wiki/paths.ts";
import { todayStamp, writeAtomic, writeBack } from "../src/wiki/write.ts";
import { MemoryError } from "../src/memory/types.ts";

let SANDBOX = "";
let CWD = "";
let USER_ROOT = "";
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-mem-layout-"));
  CWD = join(SANDBOX, "proj");
  USER_ROOT = join(SANDBOX, "user-wiki");
  savedEnv["NEO_USER_WIKI_DIR"] = process.env["NEO_USER_WIKI_DIR"];
  process.env["NEO_USER_WIKI_DIR"] = USER_ROOT;
});

afterAll(() => {
  if (savedEnv["NEO_USER_WIKI_DIR"] === undefined) delete process.env["NEO_USER_WIKI_DIR"];
  else process.env["NEO_USER_WIKI_DIR"] = savedEnv["NEO_USER_WIKI_DIR"];
  rmSync(SANDBOX, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个用例用独立 cwd，避免互相污染
  const unique = mkdtempSync(join(SANDBOX, "case-"));
  CWD = join(unique, "proj");
});

/* ------------------------------------------------------------------ */
/* 路径解析                                                             */
/* ------------------------------------------------------------------ */

describe("A 作用域路径", () => {
  test("A1 用户库根目录可被 NEO_USER_WIKI_DIR 覆盖", () => {
    expect(userWikiRoot()).toBe(USER_ROOT);
  });

  test("A2 未创建时 resolve 返回 null（读路径不建目录）", () => {
    expect(resolveScopeLayout("project", CWD)).toBeNull();
    expect(resolveUserWikiLayout()).toBeNull();
    expect(resolveBothLayouts(CWD)).toEqual({ project: null, user: null });
    expect(existsSync(CWD)).toBe(false);
  });

  test("A3 scopeRoot / scopeLockDir 指向正确位置", () => {
    expect(scopeRoot("project", CWD)).toBe(join(CWD, ".neo", "wiki"));
    expect(scopeRoot("user", CWD)).toBe(USER_ROOT);
    expect(scopeLockDir("user", CWD)).toBe(join(USER_ROOT, ".locks", "user.lock"));
  });
});

/* ------------------------------------------------------------------ */
/* 懒创建骨架                                                           */
/* ------------------------------------------------------------------ */

describe("B 骨架懒创建", () => {
  test("B1 项目级：建 raw/wiki/outputs + INDEX + log，分辨率可读回", () => {
    const layout = ensureScopeLayout("project", CWD);
    expect(existsSync(join(CWD, ".neo", "wiki", "raw"))).toBe(true);
    expect(existsSync(join(CWD, ".neo", "wiki", "outputs"))).toBe(true);
    expect(existsSync(join(layout.pagesDir, "INDEX.md"))).toBe(true);
    expect(existsSync(join(layout.pagesDir, "log.md"))).toBe(true);
    // 项目级不在懒创建时写 AGENTS.md（那是 /init 的职责）
    expect(existsSync(join(layout.pagesDir, "AGENTS.md"))).toBe(false);
    const reread = resolveScopeLayout("project", CWD);
    expect(reread?.scope).toBe("project");
    expect(reread?.pagesDir).toBe(layout.pagesDir);
  });

  test("B2 用户级：额外写 schema AGENTS.md，且 scope=user", () => {
    // 本用例要独立用户根，先清掉
    rmSync(USER_ROOT, { recursive: true, force: true });
    const layout = ensureScopeLayout("user", CWD);
    expect(layout.scope).toBe("user");
    expect(layout.kind).toBe("user");
    expect(existsSync(join(USER_ROOT, "wiki", "INDEX.md"))).toBe(true);
    expect(existsSync(join(USER_ROOT, "wiki", "log.md"))).toBe(true);
    expect(existsSync(join(USER_ROOT, "wiki", "AGENTS.md"))).toBe(true);
    const schema = readFileSync(join(USER_ROOT, "wiki", "AGENTS.md"), "utf8");
    expect(schema).toContain("推断（待确认）");
    expect(resolveUserWikiLayout()?.scope).toBe("user");
  });

  test("B3 幂等：已存在的 INDEX/log/AGENTS 不被覆盖", () => {
    rmSync(USER_ROOT, { recursive: true, force: true });
    const first = ensureScopeLayout("user", CWD);
    writeFileSync(join(first.pagesDir, "INDEX.md"), "# 手写索引\n", "utf8");
    writeFileSync(join(first.pagesDir, "AGENTS.md"), "# 手写 schema\n", "utf8");
    ensureScopeLayout("user", CWD);
    expect(readFileSync(join(first.pagesDir, "INDEX.md"), "utf8")).toBe("# 手写索引\n");
    expect(readFileSync(join(first.pagesDir, "AGENTS.md"), "utf8")).toBe("# 手写 schema\n");
  });

  test("B4 项目级骨架也能被 wiki 写入链正常使用（INDEX 表格兼容）", () => {
    const layout = ensureScopeLayout("project", CWD);
    const page = "决策-骨架验证.md";
    writeBack(layout, {
      action: "create",
      page,
      content: `# 决策-骨架验证\n\n## 摘要\n\n骨架 INDEX 可直接同步。\n\n> 最后更新:${todayStamp()}\n`,
      logTitle: "建页",
      logType: "wiki",
    });
    const index = readFileSync(join(layout.pagesDir, "INDEX.md"), "utf8");
    expect(index).toContain("[[决策-骨架验证]]");
    expect(index).toContain("骨架 INDEX 可直接同步");
  });
});

/* ------------------------------------------------------------------ */
/* 路径安全                                                             */
/* ------------------------------------------------------------------ */

describe("C 路径安全", () => {
  test("C1 isInside：同根 / 子路径 / 越界 / 兄弟目录", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c/d.md")).toBe(true);
    expect(isInside("/a/b", "/a/bc/d.md")).toBe(false);
    expect(isInside("/a/b", "/a/c/d.md")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });

  test("C2 assertInsideLayout：越界抛 MemoryError(schema_invalid)", () => {
    const layout = ensureScopeLayout("project", CWD);
    expect(() => assertInsideLayout(layout, join(layout.pagesDir, "ok.md"))).not.toThrow();
    expect(() => assertInsideLayout(layout, join(CWD, "..", "evil.md"))).toThrow(MemoryError);
  });
});

/* ------------------------------------------------------------------ */
/* 锁                                                                  */
/* ------------------------------------------------------------------ */

describe("D 互斥锁（修复 recursive:true 吞 EEXIST 的存量 bug）", () => {
  test("D1 同一把锁第二次 acquire 抛 raw_concurrent_modify", () => {
    const lockDir = join(SANDBOX, "locks", "d1.lock");
    const got = acquireLock(lockDir);
    expect(got).toBe(lockDir);
    let err: unknown = null;
    try {
      acquireLock(lockDir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MemoryError);
    expect((err as MemoryError).code).toBe("raw_concurrent_modify");
    releaseLock(got);
    // 释放后可再次获取
    expect(() => releaseLock(acquireLock(lockDir))).not.toThrow();
  });

  test("D2 tryAcquireLock 被占用时返回 null，不抛错", () => {
    const lockDir = join(SANDBOX, "locks", "d2.lock");
    const first = tryAcquireLock(lockDir);
    expect(first).toBe(lockDir);
    expect(tryAcquireLock(lockDir)).toBeNull();
    releaseLock(first);
    expect(tryAcquireLock(lockDir)).toBe(lockDir);
  });

  test("D3 withLock 串行化并发写：20 个并发自增不丢更新", async () => {
    const lockDir = join(SANDBOX, "locks", "d3.lock");
    let value = 0;
    const tasks = Array.from({ length: 20 }, () =>
      withLock(lockDir, async () => {
        const cur = value;
        await new Promise((r) => setTimeout(r, 2));
        value = cur + 1;
      }),
    );
    await Promise.all(tasks);
    expect(value).toBe(20);
  });

  test("D4 锁目录为父目录不存在时也能正确建立（先建父目录再非递归 mkdir）", () => {
    const lockDir = join(SANDBOX, "deep", "nested", "d4.lock");
    const got = acquireLock(lockDir);
    expect(existsSync(lockDir)).toBe(true);
    releaseLock(got);
  });
});

/* ------------------------------------------------------------------ */
/* 跨进程互斥（真实子进程）                                              */
/* ------------------------------------------------------------------ */

describe("D5 跨进程锁", () => {
  test("D5 父进程持锁时子进程拿不到；释放后子进程可拿", () => {
    const lockDir = join(SANDBOX, "locks", "xproc.lock");
    // v0.4.0 平台适配层：原来写死 macOS 绝对路径，Ubuntu 上子进程 import 失败。
    const projectRoot = join(import.meta.dir, "..");
    const script = `import { tryAcquireLock, releaseLock } from ${JSON.stringify(join(projectRoot, "src/memory/locks.ts"))}; const r = tryAcquireLock(${JSON.stringify(lockDir)}); if (r) { console.log("ACQUIRED"); releaseLock(r); } else { console.log("BUSY"); }`;
    const hold = acquireLock(lockDir);
    const busy = Bun.spawnSync([process.execPath, "-e", script]);
    expect(busy.stdout.toString().trim()).toBe("BUSY");
    releaseLock(hold);
    const free = Bun.spawnSync([process.execPath, "-e", script]);
    expect(free.stdout.toString().trim()).toBe("ACQUIRED");
  });
});

describe("D6 staleMs 残留锁", () => {
  test("残留锁超时后被自动清理并重新获取", () => {
    const lockDir = join(SANDBOX, "locks", "stale.lock");
    const got = acquireLock(lockDir);
    expect(got).toBe(lockDir);
    // 未超时 → 拿不到
    expect(tryAcquireLock(lockDir, { staleMs: 60_000 })).toBeNull();
    // 把 mtime 改成 10 分钟前 → 应视为残留并抢到
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockDir, old, old);
    const re = tryAcquireLock(lockDir, { staleMs: 60_000 });
    expect(re).toBe(lockDir);
    releaseLock(re);
  });
});

/* ------------------------------------------------------------------ */
/* 原子写                                                               */
/* ------------------------------------------------------------------ */

describe("E 原子写 writeAtomic", () => {
  test("E1 写入后内容完整、临时文件不残留", () => {
    const dir = join(SANDBOX, "atomic");
    const target = join(dir, "a.md");
    writeAtomic(target, "第一版\n");
    expect(readFileSync(target, "utf8")).toBe("第一版\n");
    writeAtomic(target, "第二版\n");
    expect(readFileSync(target, "utf8")).toBe("第二版\n");
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("E2 自动创建父目录", () => {
    const target = join(SANDBOX, "deep2", "dir", "b.md");
    writeAtomic(target, "内容");
    expect(readFileSync(target, "utf8")).toBe("内容");
  });
});
