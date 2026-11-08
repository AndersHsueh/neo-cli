/**
 * file-index.test.ts — v0.2.4 C1：文件索引（git ls-files 优先 + FS 回退 + TTL 缓存）。
 *
 * 规格：docs/v0.2.4-input-prd[done].md §2 C1、§4。
 * 默认实现走 git（尊重 .gitignore）；这里既测注入路径（缓存/回退），
 * 也测一次真实 git 仓库的集成行为（git 不存在时跳过）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileIndex, walkFiles, type RunOutput } from "../src/input/fileIndex.ts";

let SANDBOX = "";
beforeAll(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), "neo-fileindex-"));
});
afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

const okRun = (files: string[], counter?: { n: number }) => {
  return (): RunOutput => {
    if (counter) counter.n++;
    return { ok: true, stdout: files.join("\0") + "\0" };
  };
};

describe("C1d 索引来源", () => {
  test("list() 首次返回空并 kick 后台刷新（按键路径不阻塞）", async () => {
    // 注入一个「不立即完成」的异步 source，模拟 2 万文件仓库里 git 的耗时
    let release: (() => void) | null = null;
    const idx = new FileIndex({
      cwd: "/repo",
      runAsync: async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        return { ok: true, stdout: "a.ts\0" };
      },
    });
    expect(idx.list()).toEqual([]); // 首刷未完成：按键不等，直接返回空
    release!(); // 模拟后台 git 完成
    await idx.refresh();
    expect(idx.list()).toEqual(["a.ts"]);
  });

  test("git 可用时用 ls-files（NUL 分隔，路径含空格不裂）", async () => {
    const idx = new FileIndex({ cwd: "/repo", run: okRun(["a.ts", "dir/b c.ts"]) });
    await idx.refresh();
    expect(idx.list()).toEqual(["a.ts", "dir/b c.ts"]);
  });

  test("git 不可用（非仓库/无 git）回退 walk", async () => {
    const idx = new FileIndex({
      cwd: "/repo",
      run: () => ({ ok: false, stdout: "" }),
      walk: () => ["fallback.ts"],
    });
    await idx.refresh();
    expect(idx.list()).toEqual(["fallback.ts"]);
  });

  test("空 git 输出也回退 walk（空仓库不会给候选）", async () => {
    const idx = new FileIndex({
      cwd: "/repo",
      run: () => ({ ok: true, stdout: "" }),
      walk: () => ["w.ts"],
    });
    await idx.refresh();
    expect(idx.list()).toEqual(["w.ts"]);
  });

  test("limit 截断", async () => {
    const idx = new FileIndex({ cwd: "/repo", limit: 2, run: okRun(["a", "b", "c"]) });
    await idx.refresh();
    expect(idx.list()).toEqual(["a", "b"]);
  });
});

describe("C1e TTL 缓存", () => {
  test("TTL 内复用，不重复扫盘", async () => {
    const c = { n: 0 };
    let t = 1000;
    const idx = new FileIndex({ cwd: "/repo", ttlMs: 5000, now: () => t, run: okRun(["a.ts"], c) });
    await idx.refresh();
    t += 1000;
    expect(idx.list()).toEqual(["a.ts"]);
    idx.list();
    expect(c.n).toBe(1);
  });

  test("超过 TTL：list 仍返回旧值，后台刷新一次", async () => {
    const c = { n: 0 };
    let t = 1000;
    const idx = new FileIndex({ cwd: "/repo", ttlMs: 5000, now: () => t, run: okRun(["a.ts"], c) });
    await idx.refresh();
    t += 6000;
    expect(idx.list()).toEqual(["a.ts"]); // 过期但立即可用的旧值
    await idx.refresh(); // 等后台那次
    expect(c.n).toBe(2);
  });

  test("invalidate 立即失效并触发重扫（新建文件后能马上补全）", async () => {
    const c = { n: 0 };
    const idx = new FileIndex({ cwd: "/repo", now: () => 1, run: okRun(["a.ts"], c) });
    await idx.refresh();
    expect(c.n).toBe(1);
    idx.invalidate();
    await idx.refresh();
    expect(c.n).toBe(2);
    expect(idx.list()).toEqual(["a.ts"]);
  });
});

describe("C1f FS 回退遍历", () => {
  test("跳过 node_modules/.git/dist 等重目录，只收文件", () => {
    const root = join(SANDBOX, "walk");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "node_modules", "pkg", "i.js"), "x");
    writeFileSync(join(root, ".git", "config"), "x");
    writeFileSync(join(root, "dist", "out.js"), "x");
    writeFileSync(join(root, "README.md"), "x");

    const files = walkFiles(root, 100);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("README.md");
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(".git"))).toBe(false);
    expect(files.some((f) => f.includes("dist/"))).toBe(false);
  });

  test("limit 生效", () => {
    const root = join(SANDBOX, "walk-limit");
    mkdirSync(root, { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.ts`), "x");
    expect(walkFiles(root, 3).length).toBe(3);
  });
});

describe("C1g 真实 git 仓库集成", () => {
  // Bun.which 返回 string | null；skipIf(!git) 保证 null 情况下用例被显式跳过
  // （报告可见），?? "" 只是满足 spawnSync 的参数类型，空串分支实际不可达。
  const git = Bun.which("git") ?? "";
  // 环境无 git 时用 skipIf 显式跳过（报告里可见 skip 标记），不用 if-return 静默通过
  // —— 静默通过会让「缺 git 的环境」在报告里显示 pass，与 gitignore-rules.test.ts
  // 「环境的坏必须被看见」的纪律冲突。git 存在但损坏时仍走真实路径 fail。
  test.skipIf(!git)("有 .gitignore 时忽略被 ignore 的文件（排除 node_modules）", async () => {
    const root = join(SANDBOX, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "ignored"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "ignored/\nnode_modules/\n");
    writeFileSync(join(root, "src", "a.ts"), "x");
    writeFileSync(join(root, "ignored", "b.ts"), "x");
    writeFileSync(join(root, "tracked.txt"), "x");
    Bun.spawnSync([git, "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });

    const idx = new FileIndex({ cwd: root });
    await idx.refresh();
    const files = idx.list();
    expect(files).toContain("src/a.ts");
    expect(files).toContain("tracked.txt");
    expect(files).not.toContain("ignored/b.ts");
  });
});
