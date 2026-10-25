/**
 * git.ts 单测（v0.3.0 S11 的纯逻辑覆盖）：真临时仓库，不碰当前目录。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBranch, resetBranchCache } from "../src/git.ts";

const dirs: string[] = [];
function tempRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "neo-git-"));
  dirs.push(d);
  const run = (args: string[]): void => {
    const r = Bun.spawnSync(["git", ...args], { cwd: d, stdout: "ignore", stderr: "ignore" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  };
  run(["init", "-q"]);
  run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  run(["commit", "-q", "--allow-empty", "-m", "init"]);
  return d;
}

afterEach(() => {
  resetBranchCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("git getBranch", () => {
  test("S11a 真仓库返回当前分支", () => {
    const d = tempRepo();
    expect(getBranch(d)).toBe("main");
  });

  test("S11b 非 git 目录返回 null", () => {
    const d = mkdtempSync(join(tmpdir(), "neo-nogit-"));
    dirs.push(d);
    expect(getBranch(d)).toBeNull();
  });

  test("S11c 同一 cwd 只 spawn 一次（缓存）", () => {
    let calls = 0;
    const exec = (): string => {
      calls += 1;
      return "dev\n";
    };
    expect(getBranch("/x", { exec })).toBe("dev");
    expect(getBranch("/x", { exec })).toBe("dev");
    expect(calls).toBe(1);
  });

  test("S11d detached HEAD 返回 null", () => {
    resetBranchCache();
    let out = "HEAD\n";
    expect(getBranch("/y", { exec: () => out })).toBeNull();
    resetBranchCache();
    out = "";
    expect(getBranch("/z", { exec: () => out })).toBeNull();
  });
});
