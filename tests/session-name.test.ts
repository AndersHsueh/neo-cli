/**
 * #82 会话默认名：单调递增 Neo#N，关闭后不回收；计数器丢失/损坏可恢复；并发不重号。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateNextDefaultName, chooseSessionName } from "../src/sessionName.ts";
import { createIdentity, writeProfile, readProfile } from "../src/mailbox/identity.ts";
import { aliveDir } from "../src/mailbox/types.ts";

const roots: string[] = [];
function sandbox(): string {
  const r = mkdtempSync(join(tmpdir(), "neo-82-name-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const SEQ_FILE = "default-name-seq.json";
function seqPath(root: string): string {
  return join(root, SEQ_FILE);
}

function plantName(root: string, sessionId: string, name: string): void {
  createIdentity({ root, sessionId, cwd: "/tmp", name });
  const p = readProfile(root, sessionId);
  if (!p) throw new Error(`profile missing: ${sessionId}`);
  p.name = name;
  writeProfile(root, p);
}

describe("N1 会话代号选择", () => {
  test("N1a 显式 --name 优先于一切，且不消耗默认编号", () => {
    const root = sandbox();
    expect(chooseSessionName({ explicit: "Jacky", previous: "Trinity", root }))
      .toEqual({ name: "Jacky", source: "explicit" });
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#1", source: "default" });
  });

  test("N1b resume 旧名保留（含历史 Matrix 角色名），且不消耗默认编号", () => {
    const root = sandbox();
    expect(chooseSessionName({ previous: "Trinity", root }))
      .toEqual({ name: "Trinity", source: "resume" });
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#1", source: "default" });
  });

  test("N1c 新开会话依次得到 Neo#1、Neo#2", () => {
    const root = sandbox();
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#1", source: "default" });
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#2", source: "default" });
  });

  test("N1d 关掉 Neo#1 再开新的，得到 Neo#3 而不是 Neo#1", () => {
    const root = sandbox();
    const first = chooseSessionName({ root });
    expect(first).toEqual({ name: "Neo#1", source: "default" });
    plantName(root, "s1", "Neo#1");
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#2", source: "default" });
    plantName(root, "s2", "Neo#2");
    rmSync(aliveDir(root, "s1"), { recursive: true, force: true });
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#3", source: "default" });
  });

  test("N1e 无显式/旧名且无 root → null（不报错）", () => {
    expect(chooseSessionName({})).toBeNull();
  });
});

describe("N2 计数器丢失或损坏时恢复", () => {
  test("N2a 计数器缺失：按已知最大 Neo#N+1 恢复，不报错", () => {
    const root = sandbox();
    plantName(root, "s1", "Neo#1");
    plantName(root, "s5", "Neo#5");
    plantName(root, "sx", "Trinity");
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#6", source: "default" });
  });

  test("N2b 计数器损坏（非 JSON / 非法 next）：按已知最大 Neo#N+1 恢复，不报错", () => {
    const payloads = [
      "this is not json\n",
      JSON.stringify({ next: "foo" }),
      JSON.stringify({ next: -1 }),
      JSON.stringify({ next: 1.5 }),
    ];
    for (const payload of payloads) {
      const root = sandbox();
      plantName(root, "s3", "Neo#3");
      writeFileSync(seqPath(root), payload, "utf8");
      expect(chooseSessionName({ root })).toEqual({ name: "Neo#4", source: "default" });
    }
    // 恢复后会把有效计数器写回；此后不再损坏时继续单调递增。
    const root = sandbox();
    plantName(root, "s3", "Neo#3");
    writeFileSync(seqPath(root), "this is not json\n", "utf8");
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#4", source: "default" });
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#5", source: "default" });
  });

  test("N2c 计数器缺失且没有任何 Neo#N 会话：从 Neo#1 开始", () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    expect(allocateNextDefaultName(root)).toBe("Neo#1");
  });
});

describe("N3 并发分配", () => {
  test("N3a 多个进程同时申请不会拿到同一个号", async () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    const n = 24;
    const src = join(import.meta.dir, "../src/sessionName.ts");
    const procs = Array.from({ length: n }, () =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `import { allocateNextDefaultName } from ${JSON.stringify(src)}; process.stdout.write(allocateNextDefaultName(${JSON.stringify(root)}));`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const names = await Promise.all(
      procs.map(async (p) => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        if (code !== 0) throw new Error(`alloc failed (${code}): ${stderr || stdout}`);
        return stdout;
      }),
    );
    expect(names).toHaveLength(n);
    expect(new Set(names).size, `duplicate default names: ${names.sort().join(",")}`).toBe(n);
    const nums = names.map((s) => {
      const m = /^Neo#([1-9]\d*)$/.exec(s);
      if (!m) throw new Error(`unexpected name: ${JSON.stringify(s)}`);
      return Number(m[1]);
    });
    nums.sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  }, 30_000);
});
