/**
 * P0-4：写文件检查点与 /undo 的存储层。
 *
 * 覆盖：已有文件还原、新建文件删除、多次撤销逆序、审批拒绝不产快照、
 * 条数上限裁剪、manifest 坏行容错、工作目录外不快照、超大文件只记 manifest。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CheckpointStore } from "../src/checkpoint.ts";
import { dispatch } from "../src/tools/index.ts";
import type { Config } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-ckpt-"));
let seq = 0;

interface Env {
  cwd: string;
  store: CheckpointStore;
  ctx: ToolCtx;
}

function env(maxEntries?: number): Env {
  const cwd = join(SANDBOX, `s${seq++}`);
  mkdirSync(cwd, { recursive: true });
  const store = new CheckpointStore({ cwd, sessionId: "sess-1", ...(maxEntries ? { maxEntries } : {}) });
  const cfg = { cwd, toolOutputLimit: 30_000 } as unknown as Config;
  return { cwd, store, ctx: { cfg, approve: async () => true, checkpoint: store } };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("CheckpointStore（P0-4）", () => {
  test("edit_file 后 /undo 还原为写前内容", async () => {
    const { cwd, store, ctx } = env();
    const file = join(cwd, "a.ts");
    write(file, "const x = 1;\n");

    const r = await dispatch(
      "edit_file",
      JSON.stringify({ path: file, old_string: "1", new_string: "2" }),
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("const x = 2;\n");
    expect(store.list()).toHaveLength(1);

    const results = store.undo(1);
    expect(results[0]?.restored).toBe("content");
    expect(readFileSync(file, "utf8")).toBe("const x = 1;\n");
    expect(store.list()).toHaveLength(0);
  });

  test("write_file 新建文件后 /undo 删除文件", async () => {
    const { cwd, store, ctx } = env();
    const file = join(cwd, "new.txt");
    const r = await dispatch("write_file", JSON.stringify({ path: file, content: "hi" }), ctx);
    expect(r.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(store.undo(1)[0]?.restored).toBe("deleted");
    expect(existsSync(file)).toBe(false);
  });

  test("undo(n) 逆序还原多次写操作", async () => {
    const { cwd, store } = env();
    const file = join(cwd, "b.txt");
    write(file, "v0");
    store.beforeWrite(file, "edit_file");
    write(file, "v1");
    store.beforeWrite(file, "edit_file");
    write(file, "v2");

    const results = store.undo(2);
    expect(results.map((r) => r.restored)).toEqual(["content", "content"]);
    expect(readFileSync(file, "utf8")).toBe("v0");
  });

  test("审批拒绝不产生检查点", async () => {
    const { cwd, store, ctx } = env();
    const file = join(cwd, "c.txt");
    write(file, "keep");
    const denied: ToolCtx = { ...ctx, approve: async () => false };
    const r = await dispatch(
      "edit_file",
      JSON.stringify({ path: file, old_string: "keep", new_string: "gone" }),
      denied,
    );
    expect(r.output).toContain("用户拒绝");
    expect(store.list()).toHaveLength(0);
  });

  test("超过 maxEntries 时裁剪最老记录与快照", () => {
    const { cwd, store } = env(3);
    const file = join(cwd, "d.txt");
    for (let i = 0; i < 5; i++) {
      write(file, `v${i}`);
      store.beforeWrite(file, "write_file");
    }
    expect(store.list(10).map((e) => e.seq)).toEqual([3, 4, 5]);
    // 备份目录里只剩 manifest + 3 个快照
    const backups = join(cwd, ".neo", "backups", "sess-1");
    const names = readdirSync(backups);
    expect(names.filter((n) => n !== "manifest.jsonl")).toHaveLength(3);
  });

  test("manifest 出现坏行时其余记录仍可用", () => {
    const { cwd, store } = env();
    const file = join(cwd, "e.txt");
    write(file, "x");
    store.beforeWrite(file, "write_file");
    const manifest = join(cwd, ".neo", "backups", "sess-1", "manifest.jsonl");
    writeFileSync(manifest, `${readFileSync(manifest, "utf8")}{broken json\n`, "utf8");
    expect(store.list()).toHaveLength(1);
    expect(store.undo(1)[0]?.restored).toBe("content");
  });

  test("工作目录外的文件不快照（避免 /undo 写出仓库）", () => {
    const { store } = env();
    const outside = join(SANDBOX, "outside.txt");
    write(outside, "x");
    expect(store.beforeWrite(outside, "write_file")).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  test("目录路径不快照（避免 /checkpoints 噪音）", () => {
    const { cwd, store } = env();
    const dir = join(cwd, "adir");
    mkdirSync(dir, { recursive: true });
    expect(store.beforeWrite(dir, "write_file")).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  test("指向工作目录外的软链不快照（避免 /undo 写穿仓库）", () => {
    const { cwd, store } = env();
    const outside = join(SANDBOX, `outside-link-${seq}.txt`);
    write(outside, "x");
    const link = join(cwd, "link.txt");
    symlinkSync(outside, link);
    expect(store.beforeWrite(link, "edit_file")).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  test("超大文件只记 manifest，undo 明确跳过", () => {
    const { cwd, store } = env();
    const file = join(cwd, "big.bin");
    writeFileSync(file, "x".repeat(2_000_001), "utf8");
    const entry = store.beforeWrite(file, "write_file");
    expect(entry?.snapshot).toBeNull();
    expect(entry?.note).toContain("超过快照上限");
    writeFileSync(file, "changed", "utf8");
    const results = store.undo(1);
    expect(results[0]?.restored).toBe("skipped");
    expect(readFileSync(file, "utf8")).toBe("changed");
  });
});
