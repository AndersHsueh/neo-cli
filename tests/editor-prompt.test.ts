/**
 * editor-prompt.test.ts — issue #62：外部编辑器撰写提示词。
 *
 * 覆盖：docs/external-editor-prd.md 的 E1/E2/E3/E5/E6/E7。
 *  - 解析层（$VISUAL/$EDITOR、参数切分）是纯函数；
 *  - 落盘与 spawn 全部注入假实现 —— 不起真实编辑器、不触网、不碰用户终端。
 *  - E4/E9/E10（回填与挂起）由 tests/tui-composer.test.ts 覆盖。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { editInEditor, resolveEditorArgv, splitEditorCommand } from "../src/editor.ts";

describe("E1 编辑器来源：$VISUAL 优先，回落 $EDITOR", () => {
  test("E1a 两个都设 → 用 $VISUAL", () => {
    expect(resolveEditorArgv({ VISUAL: "vim", EDITOR: "nano" })).toEqual(["vim"]);
  });

  test("E1b 只有 $EDITOR → 用 $EDITOR", () => {
    expect(resolveEditorArgv({ EDITOR: "nano" })).toEqual(["nano"]);
  });

  test("E1c 都没设 → null（调用方据此给可读提示，不发请求）", () => {
    expect(resolveEditorArgv({})).toBeNull();
  });

  test("E1d $VISUAL 是空白串 → 视为没设，回落 $EDITOR", () => {
    expect(resolveEditorArgv({ VISUAL: "   ", EDITOR: "nano" })).toEqual(["nano"]);
  });
});

describe("E2 编辑器命令按引号切分", () => {
  test("E2a 空格分隔：EDITOR='code --wait' → ['code','--wait']", () => {
    expect(splitEditorCommand("code --wait")).toEqual(["code", "--wait"]);
  });

  test("E2b 双引号包住带空格的路径 → 一个参数", () => {
    expect(splitEditorCommand('"/Applications/My Editor.app/bin/ed" --wait')).toEqual([
      "/Applications/My Editor.app/bin/ed",
      "--wait",
    ]);
  });

  test("E2c 单引号同样识别", () => {
    expect(splitEditorCommand("'my editor' -f")).toEqual(["my editor", "-f"]);
  });

  test("E2d 引号内保留空格，多个空白不产生空参数", () => {
    expect(splitEditorCommand('  vim   "-c"   "set  nu"  ')).toEqual(["vim", "-c", "set  nu"]);
  });
});

describe("E3/E5/E6/E7 打开编辑器并回填", () => {
  test("E3 提示词全文写进临时文件，编辑器以该文件路径启动", async () => {
    let seenArgv: string[] = [];
    let seenFile = "";
    // 编辑器「运行期间」的文件内容 —— 必须在 spawnFn 里读：编辑器退出后临时文件已被删。
    let seenContent = "";
    const r = await editInEditor({
      initial: "第一行\n第二行",
      env: { EDITOR: "code --wait" },
      spawnFn: async (argv, file) => {
        seenArgv = argv;
        seenFile = file;
        seenContent = readFileSync(file, "utf8");
        return 0;
      },
    });
    expect(r.ok).toBe(true);
    expect(seenArgv.slice(0, 2)).toEqual(["code", "--wait"]);
    expect(seenArgv[seenArgv.length - 1]).toBe(seenFile);
    expect(seenContent).toBe("第一行\n第二行");
  });

  test("E3b 文件后缀是 .md（编辑器按 markdown 语法高亮）", async () => {
    let seenFile = "";
    await editInEditor({
      initial: "x",
      env: { EDITOR: "vim" },
      spawnFn: async (_argv, file) => {
        seenFile = file;
        return 0;
      },
    });
    expect(seenFile.endsWith(".md")).toBe(true);
  });

  test("E5 编辑器非 0 退出 → 不回填，给可读原因", async () => {
    const r = await editInEditor({
      initial: "原文",
      env: { EDITOR: "vim" },
      spawnFn: async () => 1,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("退出码 1");
  });

  test("E5b 编辑器把内容清空 → 不回填（保住用户已有草稿）", async () => {
    const r = await editInEditor({
      initial: "原文",
      env: { EDITOR: "vim" },
      spawnFn: async (_argv, file) => {
        rmSync(file);
        return 0;
      },
    });
    expect(r.ok).toBe(false);
  });

  test("E6 编辑器起不来 → 不回填，错误里带可执行名", async () => {
    const r = await editInEditor({
      initial: "原文",
      env: { EDITOR: "nvim" },
      spawnFn: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("nvim");
  });

  test("E7 临时文件用完即删（不留残余）", async () => {
    let seenFile = "";
    await editInEditor({
      initial: "x",
      env: { EDITOR: "vim" },
      spawnFn: async (_argv, file) => {
        seenFile = file;
        return 0;
      },
    });
    expect(existsSync(seenFile)).toBe(false);
    expect(existsSync(dirname(seenFile))).toBe(false);
  });

  test("E7b 没配编辑器 → 不起进程，直接给可读提示", async () => {
    let spawned = false;
    const r = await editInEditor({
      initial: "x",
      env: {},
      spawnFn: async () => {
        spawned = true;
        return 0;
      },
    });
    expect(spawned).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("$EDITOR");
  });
});

describe("临时目录隔离", () => {
  test("每次调用都用独立临时目录，不互相覆盖", async () => {
    const dirs: string[] = [];
    for (let i = 0; i < 2; i++) {
      await editInEditor({
        initial: `第 ${i} 次`,
        env: { EDITOR: "vim" },
        spawnFn: async (_argv, file) => {
          dirs.push(dirname(file));
          return 0;
        },
      });
    }
    expect(dirs[0]).not.toBe(dirs[1]);
    expect(dirs[0]!.startsWith(tmpdir())).toBe(true);
  });

  test("临时目录在系统 tmp 下（不落项目工作区）", () => {
    const d = mkdtempSync(join(tmpdir(), "neo-editor-probe-"));
    rmSync(d, { recursive: true, force: true });
    expect(d.startsWith(tmpdir())).toBe(true);
  });
});
