/**
 * P0-5：grep / glob 的 gitignore 与隐藏文件语义。
 *
 * 覆盖：
 *  - git 工作区：`ignored/` 不进 grep/glob；`.github/` 等隐藏文件可见；
 *  - 非 git 目录：内置 .gitignore 匹配器生效（尾 /、子目录规则）；
 *  - JS 正则语义不变（\d 等不能被 POSIX ERE 方言替换）；
 *  - 输出标注「已按 .gitignore 排除」。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatch } from "../src/tools/index.ts";
import type { Config } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "neo-search-p05-")));
let seq = 0;

interface Fixture {
  dir: string;
  ctx: ToolCtx;
}

function project(git: boolean): Fixture {
  const dir = join(SANDBOX, `p${seq++}`);
  mkdirSync(dir, { recursive: true });
  if (git) {
    const r = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    if (r.exitCode !== 0) throw new Error("git init 失败，测试环境不可用");
  }
  const cfg = { cwd: dir, toolOutputLimit: 30_000 } as unknown as Config;
  return { dir, ctx: { cfg, approve: async () => true } };
}

function put(dir: string, rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

async function grep(f: Fixture, pattern: string, extra: Record<string, unknown> = {}) {
  return dispatch("grep", JSON.stringify({ pattern, path: f.dir, ...extra }), f.ctx);
}

async function glob(f: Fixture, pattern: string) {
  return dispatch("glob", JSON.stringify({ pattern, path: f.dir }), f.ctx);
}

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("P0-5 git 工作区：尊重 .gitignore、包含隐藏文件", () => {
  const NEEDLE = "SEARCH_NEEDLE_5a1f";

  function repo(): Fixture {
    const f = project(true);
    put(f.dir, ".gitignore", "ignored/\n");
    put(f.dir, "ignored/secret.ts", `export const leak = "${NEEDLE}";\n`);
    put(f.dir, "src/a.ts", `export const ok = "${NEEDLE}";\n`);
    put(f.dir, ".github/workflow.yml", `name: ${NEEDLE}\n`);
    return f;
  }

  test("grep 不命中被 .gitignore 忽略的目录，命中隐藏目录", async () => {
    const r = await grep(repo(), NEEDLE);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("src/a.ts");
    expect(r.output).toContain(".github/workflow.yml");
    expect(r.output).not.toContain("ignored/secret.ts");
    expect(r.output).toContain("已按 .gitignore 排除");
  });

  test("glob 不列出被忽略的目录，能列出隐藏目录", async () => {
    const f = repo();
    const ts = await glob(f, "**/*.ts");
    expect(ts.ok).toBe(true);
    expect(ts.output).toContain("src/a.ts");
    expect(ts.output).not.toContain("ignored/secret.ts");

    const yml = await glob(f, ".github/**/*.yml");
    expect(yml.ok).toBe(true);
    expect(yml.output).toContain(".github/workflow.yml");
  });

  test("JS 正则语义不变（\\d、lookahead 仍可用）", async () => {
    const f = project(true);
    put(f.dir, "id.txt", "id=12345\n");
    const digit = await grep(f, "\\d{3}");
    expect(digit.output).toContain("id.txt:1:");
    const look = await grep(f, "id=(?=123)");
    expect(look.output).toContain("id.txt:1:");
  });
});

describe("P0-5 非 git 目录：内置 .gitignore 匹配器", () => {
  test("尾 / 的目录规则生效", async () => {
    const f = project(false);
    put(f.dir, ".gitignore", "dist/\n");
    put(f.dir, "dist/bundle.ts", "BUILD_MARKER_9f\n");
    put(f.dir, "visible.ts", "BUILD_MARKER_9f\n");
    const r = await grep(f, "BUILD_MARKER_9f");
    expect(r.output).toContain("visible.ts");
    expect(r.output).not.toContain("dist/bundle.ts");
  });

  test("子目录 .gitignore 按所在层级锚定", async () => {
    const f = project(false);
    put(f.dir, "sub/.gitignore", "local-only/\n");
    put(f.dir, "sub/local-only/x.ts", "NESTED_MARKER_77\n");
    put(f.dir, "sub/keep.ts", "NESTED_MARKER_77\n");
    const r = await grep(f, "NESTED_MARKER_77");
    expect(r.output).toContain("sub/keep.ts");
    expect(r.output).not.toContain("sub/local-only/x.ts");
  });

  test("无 .gitignore 时隐藏文件也可被检索到", async () => {
    const f = project(false);
    put(f.dir, ".config/settings.yml", "HIDDEN_MARKER_31\n");
    const g = await grep(f, "HIDDEN_MARKER_31");
    expect(g.output).toContain(".config/settings.yml");
    const l = await glob(f, ".config/*.yml");
    expect(l.output).toContain(".config/settings.yml");
  });
});
