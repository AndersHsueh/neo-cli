/**
 * 交互 /resume：信箱身份接管（保留目标 name/inbox，退役当前身份，拒绝运行中目标）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mailbox } from "../src/mailbox/store.ts";
import {
  createIdentity,
  isAlive,
  readProfile,
  writeProfile,
} from "../src/mailbox/identity.ts";
import { readState } from "../src/mailbox/state.ts";
import { aliveDir } from "../src/mailbox/types.ts";

const roots: string[] = [];
function sandbox(): string {
  const r = mkdtempSync(join(tmpdir(), "neo-mbadopt-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("R3 mailbox.adopt（交互 /resume）", () => {
  test("R3a 接管死会话：sessionId 切换、目标 name 保留、当前 name/锁清掉", () => {
    const root = sandbox();
    const a = "si-a";
    const b = "si-b";
    createIdentity({ root, sessionId: a, cwd: "/tmp/a", name: "Trinity", nowMs: Date.now() - 5000 });
    createIdentity({ root, sessionId: b, cwd: "/tmp/b", name: "Morpheus", nowMs: Date.now() - 4000 });
    // 模拟 A 进程已死：去掉 .alive（pid 判定在浏览器场景下由 liveness 默认值覆盖）
    rmSync(aliveDir(root, a), { recursive: true, force: true });

    const mb = new Mailbox({ root, sessionId: b });
    const p = mb.adopt(a);
    expect(mb.sessionId).toBe(a);
    expect(p.name).toBe("Trinity");
    // 当前身份退役：锁释放、profile/state 名字清空（避免同名寻址歧义）
    expect(isAlive(root, b)).toBe(false);
    expect(readProfile(root, b)?.name).toBeNull();
    expect(readState(root, b)?.name).toBeNull();
  });

  test("R3b 目标是运行中会话 → resume_conflict，当前身份不被破坏", () => {
    const root = sandbox();
    const live = "si-live";
    const cur = "si-cur";
    createIdentity({ root, sessionId: live, cwd: "/tmp/live", name: "Trinity", nowMs: Date.now() });
    createIdentity({ root, sessionId: cur, cwd: "/tmp/cur", name: "Morpheus", nowMs: Date.now() });
    const mb = new Mailbox({ root, sessionId: cur });
    expect(() => mb.adopt(live)).toThrow();
    expect(mb.sessionId).toBe(cur);
    expect(isAlive(root, cur)).toBe(true);
    expect(readProfile(root, cur)?.name).toBe("Morpheus");
  });

  test("R3d adopt 时目标旧名与「即将退役的当前会话」重名 → 不加无意义后缀", () => {
    const root = sandbox();
    const a = "si-dup-a";
    const b = "si-dup-b";
    createIdentity({ root, sessionId: a, cwd: "/tmp/a", name: "Trinity", nowMs: Date.now() - 5000 });
    createIdentity({ root, sessionId: b, cwd: "/tmp/b", name: "Morpheus", nowMs: Date.now() - 4000 });
    // 把 B 改成和 A 同名（模拟 dead 名被池重新分配后，A 被 /resume adopt）
    const pb = readProfile(root, b)!;
    pb.name = "Trinity";
    writeProfile(root, pb);
    rmSync(aliveDir(root, a), { recursive: true, force: true });
    const mb = new Mailbox({ root, sessionId: b });
    // 当前身份 B 马上退役/清名，因此 A 的旧名应保持 Trinity，而不是白撞成 Trinity-2
    expect(mb.adopt(a).name).toBe("Trinity");
  });

  test("R3c 同 id adopt 是 no-op", () => {
    const root = sandbox();
    createIdentity({ root, sessionId: "si-x", cwd: "/tmp", name: "Seraph" });
    const mb = new Mailbox({ root, sessionId: "si-x" });
    expect(mb.adopt("si-x").name).toBe("Seraph");
  });
});
