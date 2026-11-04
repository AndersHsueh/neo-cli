/**
 * v0.4.1 B5：过期 tmp / mailbox 目录清理。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupMailboxDirs, cleanupRuntime, cleanupTmpDir } from "../src/maintenance.ts";

const ROOT = mkdtempSync(join(tmpdir(), "neo-maint-"));
const HOME_TMP = join(ROOT, "home-tmp");
process.env["NEO_TMP_DIR"] = HOME_TMP;
afterAll(() => {
  delete process.env["NEO_TMP_DIR"];
  rmSync(ROOT, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

function age(path: string, days: number): void {
  const t = (Date.now() - days * DAY) / 1000;
  utimesSync(path, t, t);
}

describe("cleanupTmpDir", () => {
  test("删过期文件、保留新文件、跳过隐藏项", () => {
    const cwd = join(ROOT, "tmp1");
    const dir = join(cwd, ".neo", "tmp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tool-old.txt"), "old");
    writeFileSync(join(dir, "tool-new.txt"), "new");
    writeFileSync(join(dir, ".keep"), "");
    age(join(dir, "tool-old.txt"), 8);
    const r = cleanupTmpDir(cwd);
    expect(r.removed).toBe(1);
    expect(existsSync(join(dir, "tool-old.txt"))).toBe(false);
    expect(existsSync(join(dir, "tool-new.txt"))).toBe(true);
    expect(existsSync(join(dir, ".keep"))).toBe(true);
  });

  test("目录不存在不报错", () => {
    expect(cleanupTmpDir(join(ROOT, "nope")).removed).toBe(0);
  });

  test("过期子目录不删、不报错、不计入 freedBytes", () => {
    const cwd = join(ROOT, "tmp2");
    const dir = join(cwd, ".neo", "tmp");
    mkdirSync(dir, { recursive: true });
    // 非空过期子目录：非递归 rm 会 EISDIR，修复前会进 errors 且 freedBytes 被目录元数据污染
    const sub = join(dir, "old-subdir");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "inner.txt"), "x".repeat(100));
    age(sub, 8);
    writeFileSync(join(dir, "tool-old.txt"), "12345");
    age(join(dir, "tool-old.txt"), 8);

    const r = cleanupTmpDir(cwd);
    expect(r.removed).toBe(1);
    expect(r.freedBytes).toBe(5);
    expect(r.errors).toEqual([]);
    expect(existsSync(sub)).toBe(true);
    expect(existsSync(join(dir, "tool-old.txt"))).toBe(false);
  });
});

describe("cleanupMailboxDirs", () => {
  test("只删形状合法且过期的会话目录", () => {
    const root = join(ROOT, "mailbox");
    mkdirSync(root, { recursive: true });
    const old = join(root, "20260101-000000-abcdef");
    const fresh = join(root, "20260102-000000-ghijkl");
    const weird = join(root, "not-a-session");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    mkdirSync(weird, { recursive: true });
    writeFileSync(join(old, "state.json"), "{}");
    writeFileSync(join(fresh, "state.json"), "{}");
    age(join(old, "state.json"), 8);
    age(join(fresh, "state.json"), 1);
    const r = cleanupMailboxDirs(root);
    expect(r.removed).toEqual(["20260101-000000-abcdef"]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(weird)).toBe(true);
  });
});

describe("cleanupRuntime", () => {
  test("汇总两类清理结果", () => {
    const cwd = join(ROOT, "rt");
    const tmp = HOME_TMP;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "tool-old.txt"), "12345");
    age(join(tmp, "tool-old.txt"), 9);
    const root = join(ROOT, "mb2");
    mkdirSync(join(root, "20260101-000000-abcdef"), { recursive: true });
    writeFileSync(join(root, "20260101-000000-abcdef", "state.json"), "{}");
    age(join(root, "20260101-000000-abcdef", "state.json"), 9);
    const r = cleanupRuntime(cwd, root);
    expect(r.removedTmpFiles).toBe(1);
    expect(r.removedMailboxDirs).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });
});
