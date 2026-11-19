/**
 * #82 P2：计数器写失败不得发号、活持有者锁不可偷、后继锁不可被旧 finally 误删、
 * 默认名撞名再分配而非 Neo#N-2、有效落后计数器与已关闭 profile 恢复的正式回归。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateNextDefaultName,
  allocateUnusedDefaultName,
  acquireDefaultNameLock,
  releaseDefaultNameLock,
  chooseSessionName,
  defaultNameLockDir,
  DefaultNameReservationError,
  openMailboxIdentity,
  readDefaultNameLockOwner,
  type DefaultNameLockHold,
} from "../src/sessionName.ts";
import { createIdentity, readProfile, writeProfile } from "../src/mailbox/identity.ts";
import { aliveDir } from "../src/mailbox/types.ts";

const roots: string[] = [];
function sandbox(): string {
  const r = mkdtempSync(join(tmpdir(), "neo-82-p2-"));
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

function closeSession(root: string, sessionId: string): void {
  rmSync(aliveDir(root, sessionId), { recursive: true, force: true });
}

async function collectProc(p: ReturnType<typeof Bun.spawn>): Promise<{ stdout: string; stderr: string; code: number }> {
  const stdoutStream = p.stdout;
  const stderrStream = p.stderr;
  const [stdout, stderr, code] = await Promise.all([
    stdoutStream && typeof stdoutStream !== "number" ? new Response(stdoutStream).text() : Promise.resolve(""),
    stderrStream && typeof stderrStream !== "number" ? new Response(stderrStream).text() : Promise.resolve(""),
    p.exited,
  ]);
  return { stdout, stderr, code };
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

describe("N2 正式回归：有效落后计数器 / 已关闭 profile", () => {
  test("N2d 有效但落后的计数器：next=3 且已有 Neo#7 → 分配 Neo#8", () => {
    const root = sandbox();
    plantName(root, "s7", "Neo#7");
    writeFileSync(seqPath(root), `${JSON.stringify({ next: 3 }, null, 2)}\n`, "utf8");
    expect(allocateNextDefaultName(root)).toBe("Neo#8");
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#9", source: "default" });
  });

  test("N2e 计数器缺失时，已关闭（无 .alive）的 Neo#N 仍计入恢复", () => {
    const root = sandbox();
    plantName(root, "s1", "Neo#1");
    plantName(root, "s5", "Neo#5");
    closeSession(root, "s1");
    closeSession(root, "s5");
    if (existsSync(seqPath(root))) rmSync(seqPath(root));
    expect(chooseSessionName({ root })).toEqual({ name: "Neo#6", source: "default" });
  });
});

describe("N4 计数器持久化失败不得把未预留的号当成功发出", () => {
  test("N4a write 失败抛 DefaultNameReservationError，不返回 Neo#N", () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    // 把计数器路径做成目录，writeJsonAtomic 的 rename 必然失败；锁目录仍可创建。
    mkdirSync(seqPath(root));
    let thrown: unknown;
    try {
      allocateNextDefaultName(root);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DefaultNameReservationError);
    const err = thrown as InstanceType<typeof DefaultNameReservationError>;
    expect(err.message).toContain("无法预留");
    expect(err.message).toContain(seqPath(root));
    expect(err.message).toMatch(/权限|磁盘|写/);
  });

  test("N4b 写失败不得留下已推进的有效计数器（未预留成功）", () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    mkdirSync(seqPath(root));
    expect(() => allocateNextDefaultName(root)).toThrow(DefaultNameReservationError);
    // 计数器路径仍是目录，没有被写成 {next:2} 之类的成功预留。
    expect(statSync(seqPath(root)).isDirectory()).toBe(true);
  });

  test("N4c 损坏/缺失的可读计数器仍正常恢复（不把恢复当写失败）", () => {
    const root = sandbox();
    plantName(root, "s3", "Neo#3");
    writeFileSync(seqPath(root), "not-json", "utf8");
    expect(allocateNextDefaultName(root)).toBe("Neo#4");
  });

  test("N4d openMailboxIdentity 走真实装配路径：写失败上抛可行动错误，不回落到 neo", () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    mkdirSync(seqPath(root));
    let thrown: unknown;
    try {
      openMailboxIdentity({ root, sessionId: "s-new", cwd: "/tmp" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DefaultNameReservationError);
    expect((thrown as Error).message).toContain("无法预留");
    expect(readProfile(root, "s-new")).toBeNull();
  });
});

describe("N5 锁协议：活持有者不可偷锁、旧 finally 不可删后继锁、死持有者可恢复", () => {
  test("N5a 后继者已持锁时，旧持有者 release 不得删除后继锁", () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    const holdA: DefaultNameLockHold = acquireDefaultNameLock(root);
    const tokenA = holdA.token;
    // 模拟 A 的锁目录已被回收、B 重新取得一把新锁。
    // 本机 ext4 可能复用 inode，所以身份不能只靠 ino；token 必须不同。
    rmSync(defaultNameLockDir(root), { recursive: true, force: true });
    const holdB = acquireDefaultNameLock(root);
    expect(holdB.token).not.toBe(tokenA);
    const ownerBefore = readDefaultNameLockOwner(root);
    expect(ownerBefore?.token).toBe(holdB.token);

    releaseDefaultNameLock(holdA); // 即使 inode 碰巧复用，token 不同也不得删 B 的锁
    expect(existsSync(defaultNameLockDir(root))).toBe(true);
    const ownerAfter = readDefaultNameLockOwner(root);
    expect(ownerAfter?.token).toBe(holdB.token);
    expect(ownerAfter?.token).not.toBe(tokenA);

    // 再强制同一个 ino 去调 A 的 finally：只靠 token 也必须保住 B。
    releaseDefaultNameLock({ ...holdA, dev: holdB.dev, ino: holdB.ino });
    expect(existsSync(defaultNameLockDir(root))).toBe(true);
    expect(readDefaultNameLockOwner(root)?.token).toBe(holdB.token);

    releaseDefaultNameLock(holdB);
    expect(existsSync(defaultNameLockDir(root))).toBe(false);
  });

  test("N5b 活持有者被暂停超过 10s，等待者不得偷锁", async () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    const src = join(import.meta.dir, "../src/sessionName.ts");
    const ready = join(root, "holder-ready.json");
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `
          import { acquireDefaultNameLock, releaseDefaultNameLock } from ${JSON.stringify(src)};
          import { writeFileSync } from "node:fs";
          const hold = acquireDefaultNameLock(${JSON.stringify(root)});
          writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, token: hold.token, ino: hold.ino }) + "\\n");
          const release = () => { try { releaseDefaultNameLock(hold); } finally { process.exit(0); } };
          process.on("SIGTERM", release);
          process.stdin.on("data", release);
          setInterval(() => {}, 1 << 30);
        `,
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
    );
    const started = Date.now();
    while (!existsSync(ready) && Date.now() - started < 5_000) {
      await Bun.sleep(20);
    }
    expect(existsSync(ready)).toBe(true);
    const holderMeta = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; token: string };
    // Bun.spawn 的 pid 是启动器，必须对脚本进程（owner.pid）发信号。
    signalPid(holderMeta.pid, "SIGSTOP");

    const waiter = Bun.spawn(
      [
        "bun",
        "-e",
        `import { allocateNextDefaultName } from ${JSON.stringify(src)}; process.stdout.write(allocateNextDefaultName(${JSON.stringify(root)}));`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    // 超过旧实现 10s mtime 偷锁阈值，证明不是靠加长阈值蒙混。
    await Bun.sleep(12_000);
    expect(waiter.exitCode).toBeNull();
    const ownerWhilePaused = readDefaultNameLockOwner(root);
    expect(ownerWhilePaused?.token).toBe(holderMeta.token);
    expect(ownerWhilePaused?.pid).toBe(holderMeta.pid);

    signalPid(holderMeta.pid, "SIGCONT");
    signalPid(holderMeta.pid, "SIGTERM");
    const holderDone = await collectProc(holder);
    expect(holderDone.code).toBe(0);

    const waited = await collectProc(waiter);
    expect(waited.code).toBe(0);
    expect(waited.stdout).toBe("Neo#1");
  }, 30_000);

  test("N5c 死持有者（SIGKILL、无 finally）可被恢复，等待者能拿到号", async () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    const src = join(import.meta.dir, "../src/sessionName.ts");
    const ready = join(root, "dead-ready.json");
    const holder = Bun.spawn(
      [
        "bun",
        "-e",
        `
          import { acquireDefaultNameLock } from ${JSON.stringify(src)};
          import { writeFileSync } from "node:fs";
          const hold = acquireDefaultNameLock(${JSON.stringify(root)});
          writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, token: hold.token }) + "\\n");
          setInterval(() => {}, 1 << 30);
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const started = Date.now();
    while (!existsSync(ready) && Date.now() - started < 5_000) {
      await Bun.sleep(20);
    }
    expect(existsSync(ready)).toBe(true);
    const deadMeta = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; token: string };
    // 必须杀掉持锁脚本进程，而不是 Bun 启动器。
    signalPid(deadMeta.pid, "SIGKILL");
    await holder.exited;

    const t0 = Date.now();
    const waiter = Bun.spawn(
      [
        "bun",
        "-e",
        `import { allocateNextDefaultName } from ${JSON.stringify(src)}; process.stdout.write(allocateNextDefaultName(${JSON.stringify(root)}));`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const waited = await collectProc(waiter);
    const elapsed = Date.now() - t0;
    expect(waited.code).toBe(0);
    expect(waited.stdout).toBe("Neo#1");
    expect(elapsed).toBeLessThan(8_000);
  }, 15_000);
});

describe("N6 默认名撞名再分配，后缀只给 --name /rename；装配走真实 wiring", () => {
  test("N6a allocateUnusedDefaultName 跳过已被占用的号，返回下一个 Neo#N", () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    expect(allocateUnusedDefaultName(root, { isTaken: (n) => n === "Neo#1" || n === "Neo#2" })).toBe("Neo#3");
  });

  test("N6b openMailboxIdentity：已有运行中 Neo#1/Neo#2 时新会话得到 Neo#3，绝不是 Neo#N-2", () => {
    const root = sandbox();
    plantName(root, "s1", "Neo#1");
    plantName(root, "s2", "Neo#2");
    const r = openMailboxIdentity({ root, sessionId: "s3", cwd: "/tmp" });
    expect(r.chosen.source).toBe("default");
    expect(r.identity.profile.name).toBe("Neo#3");
    expect(r.identity.profile.name).not.toMatch(/-/);
    expect(r.suffixFrom).toBeUndefined();
  });

  test("N6c 分配后、落盘前被抢占同一 Neo#N：再分配而不是 Neo#1-2", () => {
    const root = sandbox();
    mkdirSync(root, { recursive: true });
    const r = openMailboxIdentity({
      root,
      sessionId: "s-new",
      cwd: "/tmp",
      onAfterDefaultAllocate: (name) => {
        if (name === "Neo#1" && !readProfile(root, "racer")) {
          plantName(root, "racer", name);
        }
      },
    });
    expect(r.chosen.source).toBe("default");
    expect(r.identity.profile.name).toBe("Neo#2");
    expect(r.identity.profile.name).not.toBe("Neo#1-2");
    expect(r.suffixFrom).toBeUndefined();
  });

  test("N6d --name 撞名仍加后缀；resume 保留 Trinity", () => {
    const root = sandbox();
    plantName(root, "live", "Jacky");
    const named = openMailboxIdentity({ root, sessionId: "s-exp", cwd: "/tmp", explicit: "Jacky" });
    expect(named.chosen.source).toBe("explicit");
    expect(named.identity.profile.name).toBe("Jacky-2");
    expect(named.suffixFrom).toBe("Jacky");

    plantName(root, "old", "Trinity");
    closeSession(root, "old");
    const resumed = openMailboxIdentity({ root, sessionId: "old", cwd: "/tmp", previous: "Trinity", takeover: true });
    expect(resumed.chosen.source).toBe("resume");
    expect(resumed.identity.profile.name).toBe("Trinity");
  });

  test("N6e createIdentity(applyUniqueSuffix:false) 撞名抛错，不会写成 Neo#1-2", () => {
    const root = sandbox();
    plantName(root, "s1", "Neo#1");
    expect(() =>
      createIdentity({ root, sessionId: "s2", cwd: "/tmp", name: "Neo#1", applyUniqueSuffix: false }),
    ).toThrow();
    expect(readProfile(root, "s2")?.name ?? null).not.toBe("Neo#1-2");
  });
});
