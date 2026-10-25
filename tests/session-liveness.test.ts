/**
 * 会话活/死判定与残留锁回收（2026-10-26 裁决）：
 * running = .alive + pid 存活 + 心跳 <= deadAfterMs；
 * pid 死 / 心跳 >120s → dead，可立刻恢复并清残留锁。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAlive,
  createIdentity,
  isAlive,
  readProfile,
  sessionLiveness,
  writeProfile,
} from "../src/mailbox/identity.ts";
import { aliveOwnerPath, profilePath, statePath } from "../src/mailbox/types.ts";

const roots: string[] = [];
function sandbox(): string {
  const r = mkdtempSync(join(tmpdir(), "neo-live-"));
  roots.push(r);
  return r;
}
function ageFiles(paths: string[], msAgo: number): void {
  const t = new Date(Date.now() - msAgo);
  for (const p of paths) utimesSync(p, t, t);
}
const pidAliveYes = (): boolean => true;
const pidAliveNo = (): boolean => false;

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("R2 会话活/死判定", () => {
  test("R2a pid 存活 + 心跳新鲜 = running", () => {
    const root = sandbox();
    const id = "si-live";
    createIdentity({ root, sessionId: id, cwd: "/tmp", name: "Trinity", nowMs: Date.now() });
    expect(sessionLiveness(root, id, { pidAlive: pidAliveYes })).toBe("running");
  });

  test("R2b pid 已死 + 心跳新鲜 = dead（崩溃残留可立刻恢复）", () => {
    const root = sandbox();
    const id = "si-crash";
    createIdentity({ root, sessionId: id, cwd: "/tmp", name: "Trinity", nowMs: Date.now() });
    expect(sessionLiveness(root, id, { pidAlive: pidAliveNo })).toBe("dead");
  });

  test("R2c pid 存活但心跳 >120s = dead（事件循环卡死/休眠）", () => {
    const root = sandbox();
    const id = "si-hung";
    createIdentity({ root, sessionId: id, cwd: "/tmp", name: "Trinity", nowMs: Date.now() });
    ageFiles([profilePath(root, id), statePath(root, id)], 200_000);
    expect(sessionLiveness(root, id, { pidAlive: pidAliveYes })).toBe("dead");
  });

  test("R2d 无 .alive / 无 profile = dead", () => {
    const root = sandbox();
    expect(sessionLiveness(root, "si-none", { pidAlive: pidAliveYes })).toBe("dead");
  });

  test("R2e acquireAlive takeover：pid 死立刻回收；pid 活且心跳新鲜拒绝；心跳超时回收", () => {
    const root = sandbox();
    const id = "si-takeover";
    createIdentity({ root, sessionId: id, cwd: "/tmp", name: "Trinity", nowMs: Date.now() });
    expect(isAlive(root, id)).toBe(true);

    // 同 pid 活着 + 心跳新鲜 → 拒绝双开
    expect(() => acquireAlive(root, id, { takeover: true, pidAlive: pidAliveYes })).toThrow();

    // pid 已死（心跳仍新鲜）→ 立刻回收
    acquireAlive(root, id, { takeover: true, pidAlive: pidAliveNo });
    expect(isAlive(root, id)).toBe(true);

    // pid 活但心跳超时 → 回收
    ageFiles([profilePath(root, id), statePath(root, id)], 200_000);
    acquireAlive(root, id, { takeover: true, pidAlive: pidAliveYes });
    expect(isAlive(root, id)).toBe(true);
  });

  test("R2g 崩溃残留（.alive 在、pid 死）resume 旧名不会自己撞成 -2", () => {
    const root = sandbox();
    const id = "si-crash-name";
    createIdentity({ root, sessionId: id, cwd: "/tmp", name: "Trinity", nowMs: Date.now() });
    // 模拟 SIGKILL：.alive 残留，profile.pid 指向一个不存在的进程
    const p = readProfile(root, id)!;
    p.pid = 999999;
    writeProfile(root, p);
    writeFileSync(aliveOwnerPath(root, id), JSON.stringify({ pid: 999999, at: Date.now() }));

    createIdentity({ root, sessionId: id, cwd: "/tmp", name: "Trinity", nowMs: Date.now() + 1000 });
    expect(readProfile(root, id)?.name).toBe("Trinity");

    // 不显式给名（走 old?.name）也不能撞自己
    rmSync(join(root, id, ".alive"), { recursive: true, force: true });
    createIdentity({ root, sessionId: id, cwd: "/tmp", nowMs: Date.now() + 2000 });
    expect(readProfile(root, id)?.name).toBe("Trinity");
  });

  test("R2h createIdentity 抢锁失败不覆盖存活会话的 profile（v0.3.2 critical）", () => {
    const root = sandbox();
    const id = "si-live-profile";
    createIdentity({ root, sessionId: id, cwd: "/orig", mode: "ask", name: "Trinity" });
    expect(() =>
      createIdentity({ root, sessionId: id, cwd: "/intruder", mode: "auto-edit", name: "Neo" }),
    ).toThrow();
    const p = readProfile(root, id)!;
    expect(p.name).toBe("Trinity");
    expect(p.cwd).toBe("/orig");
    expect(p.mode).toBe("ask");
    expect(p.pid).toBe(process.pid);
  });

  test("R2f createIdentity 同 id 续接：name 保留；显式 name 覆盖", () => {
    const root = sandbox();
    const id = "si-name";
    createIdentity({ root, sessionId: id, cwd: "/tmp", name: "Trinity", nowMs: Date.now() });
    // 模拟进程死亡：去掉 .alive（pid 判定不参与 createIdentity 的 name 逻辑）
    rmSync(join(root, id, ".alive"), { recursive: true, force: true });
    createIdentity({ root, sessionId: id, cwd: "/tmp", nowMs: Date.now() + 1000 });
    expect(readProfile(root, id)?.name).toBe("Trinity");

    rmSync(join(root, id, ".alive"), { recursive: true, force: true });
    createIdentity({ root, sessionId: id, cwd: "/tmp", name: "Morpheus", nowMs: Date.now() + 2000 });
    expect(readProfile(root, id)?.name).toBe("Morpheus");
  });
});
