/**
 * v0.3.1 A5：同名多命中时优先 running，dead 残留不得遮蔽活会话。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mailbox } from "../src/mailbox/store.ts";
import {
  createIdentity,
  readProfile,
  takenAliveNames,
  writeProfile,
} from "../src/mailbox/identity.ts";
import { aliveDir } from "../src/mailbox/types.ts";

const roots: string[] = [];
function sandbox(): string {
  const r = mkdtempSync(join(tmpdir(), "neo-name-resolve-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function forceName(root: string, id: string, name: string): void {
  const p = readProfile(root, id);
  if (!p) throw new Error(`profile missing: ${id}`);
  p.name = name;
  writeProfile(root, p);
}

describe("N2 同名 dead/alive 寻址", () => {
  test("N2a dead + alive 同名 → 解析到 running 的那个", () => {
    const root = sandbox();
    createIdentity({ root, sessionId: "dead-1", cwd: "/tmp/d", name: "Trinity" });
    createIdentity({ root, sessionId: "live-1", cwd: "/tmp/l", name: "Morpheus" });
    forceName(root, "dead-1", "Trinity");
    forceName(root, "live-1", "Trinity");
    rmSync(aliveDir(root, "dead-1"), { recursive: true, force: true }); // dead 残留

    const mb = new Mailbox({ root, sessionId: "self" });
    expect(mb.resolvePeer("Trinity").session).toBe("live-1");
    expect(takenAliveNames(root)).toEqual(new Set(["Trinity"]));
  });

  test("N2b 两个 running 同名 → 仍然 ambiguous", () => {
    const root = sandbox();
    createIdentity({ root, sessionId: "live-a", cwd: "/tmp/a", name: "Seraph" });
    createIdentity({ root, sessionId: "live-b", cwd: "/tmp/b", name: "Oracle" });
    forceName(root, "live-a", "Seraph");
    forceName(root, "live-b", "Seraph");
    const mb = new Mailbox({ root, sessionId: "self" });
    expect(() => mb.resolvePeer("Seraph")).toThrow();
  });

  test("N2e 名字优先于 session-id 片段：短名不会被 base36 id 抢走", () => {
    const root = sandbox();
    // id 里含 "neo"，但它的名字不是 neo；另一个会话精确叫 neo
    createIdentity({ root, sessionId: "si-neo-frag", cwd: "/tmp/f", name: "Trinity" });
    createIdentity({ root, sessionId: "si-name-neo", cwd: "/tmp/n", name: "neo" });
    const mb = new Mailbox({ root, sessionId: "self" });
    expect(mb.resolvePeer("neo").session).toBe("si-name-neo");
  });

  test("N2d requireAlive 与同名优先共用 running 口径：pid 死残留不算活", () => {
    const root = sandbox();
    createIdentity({ root, sessionId: "stale-1", cwd: "/tmp", name: "Ghost" });
    const p = readProfile(root, "stale-1")!;
    p.pid = 999999; // .alive 仍在，但 pid 已死
    writeProfile(root, p);
    const mb = new Mailbox({ root, sessionId: "self" });
    expect(() => mb.resolvePeer("Ghost", { requireAlive: true })).toThrow();
  });

  test("N2c 只有 dead 同名 → 保持原语义（requireAlive 时报不可达，而不是歧义）", () => {
    const root = sandbox();
    createIdentity({ root, sessionId: "dead-a", cwd: "/tmp/a", name: "Switch" });
    createIdentity({ root, sessionId: "dead-b", cwd: "/tmp/b", name: "Tank" });
    forceName(root, "dead-a", "Switch");
    forceName(root, "dead-b", "Switch");
    rmSync(aliveDir(root, "dead-a"), { recursive: true, force: true });
    rmSync(aliveDir(root, "dead-b"), { recursive: true, force: true });
    const mb = new Mailbox({ root, sessionId: "self" });
    // 仍是 ambiguous（与原行为一致），不冒领成某个 dead 会话
    expect(() => mb.resolvePeer("Switch")).toThrow();
    expect(takenAliveNames(root).size).toBe(0);
  });
});
