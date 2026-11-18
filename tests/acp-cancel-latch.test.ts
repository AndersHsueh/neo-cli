/**
 * issue #80 复审 P1：cancel 闩。
 *
 * 失败形态：prompt 已 cancelled，但迟到的 allow_once 仍让 write_file 落盘。
 * 根因：SDK 对 JSON-RPC 响应（allow）是同步 resolve，对 session/cancel 通知要
 * 走一串 async handleMessage；#80 新增的 session/load、session/set_mode 让取消
 * 处理更晚，写盘发生在闩落下之前。
 *
 * 本文件钉死「写盘执行前必须再检一次本轮已取消」，不依赖管道竞态。
 * R1 / R1b 仍负责管道级时序。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { writeFileTool } from "../src/tools/writeFile.ts";
import { isNotExecuted, type ToolCtx } from "../src/tools/types.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-acp-cancel-latch-"));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("cancel 闩：迟到的 allow 不得写盘", () => {
  test("L1 审批返回 allow_once 时本轮已 cancel，write_file 不得落盘", async () => {
    const target = join(SANDBOX, "late-allow.txt");
    const ac = new AbortController();
    const ctx: ToolCtx = {
      cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as unknown as Config,
      signal: ac.signal,
      approve: async () => {
        // 模拟：权限 RPC 已返回 allow，但取消闩在等待期间已经落下。
        ac.abort();
        return true;
      },
    };

    let failed: unknown = null;
    try {
      await writeFileTool.execute({ path: target, content: "不该写入\n" }, ctx);
    } catch (e) {
      failed = e;
    }

    expect(failed).not.toBeNull();
    expect(isNotExecuted(failed)).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});
