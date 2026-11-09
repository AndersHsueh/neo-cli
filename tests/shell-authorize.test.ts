/**
 * issue #34：shell 直通的授权 / 执行拆分。
 *
 * 背景：TUI 里 `!cmd` 在 ask 模式下要弹确认框，而旧实现是「先 suspend composer、
 * 再在 runShell 里 confirm」——挂起后 composer 不渲染也不收键，确认框永远不出现，
 * 整个会话死锁（表面现象是「跑完 shell 后输入失效」）。
 *
 * 这里锁住拆分后的契约：授权只看权限模式（plan 拒绝 / ask 询问 / 自动放行），
 * 执行只负责跑命令；两者可以分开调用，TUI 因此能把确认放在挂起之前。
 */
import { describe, expect, test } from "bun:test";

import { authorizeShell } from "../src/cli/shell.ts";
import type { Console } from "../src/ui/console.ts";
import type { PermissionMode } from "../src/agent/types.ts";

interface FakeConsole {
  asked: string[];
  warns: string[];
  infos: string[];
}

function fakeConsole(answer: boolean): { console: Console; log: FakeConsole } {
  const log: FakeConsole = { asked: [], warns: [], infos: [] };
  const console = {
    async confirm(q: string): Promise<boolean> {
      log.asked.push(q);
      return answer;
    },
    warn(msg: string): void {
      log.warns.push(msg);
    },
    info(msg: string): void {
      log.infos.push(msg);
    },
  } as unknown as Console;
  return { console, log };
}

describe("authorizeShell（issue #34）", () => {
  test("auto-all：直接放行，不弹确认；auto-edit 对 shell 仍要确认（策略如此）", async () => {
    const autoAll = fakeConsole(false);
    expect(await authorizeShell("echo hi", autoAll.console, "auto-all")).toBe("allow");
    expect(autoAll.log.asked).toEqual([]);

    const autoEdit = fakeConsole(true);
    expect(await authorizeShell("echo hi", autoEdit.console, "auto-edit")).toBe("allow");
    expect(autoEdit.log.asked.length).toBe(1);
  });

  test("ask：确认框只问一次；回答 y → allow，拒绝 → deny", async () => {
    const yes = fakeConsole(true);
    expect(await authorizeShell("echo hi", yes.console, "ask")).toBe("allow");
    expect(yes.log.asked.length).toBe(1);
    expect(yes.log.asked[0]).toContain("shell — 执行: echo hi");

    const no = fakeConsole(false);
    expect(await authorizeShell("echo hi", no.console, "ask")).toBe("deny");
  });

  test("plan：不询问、直接拒绝（不给绕过确认的后门）", async () => {
    const { console, log } = fakeConsole(true);
    expect(await authorizeShell("echo hi", console, "plan")).toBe("plan");
    expect(log.asked).toEqual([]);
  });

  test("空命令：直接 allow，不询问也不执行", async () => {
    const { console, log } = fakeConsole(true);
    expect(await authorizeShell("   ", console, "ask")).toBe("allow");
    expect(log.asked).toEqual([]);
  });
});
