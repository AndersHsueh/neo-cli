/**
 * tests/env.test.ts — 环境探测 / 渲染 / wiki 派生页（v0.4.0 平台适配层）。
 *
 * 全部依赖注入（platform / os / fs / which / run / now），不碰真实机器状态；
 * 唯一真实 IO 是 mkdtemp 临时目录（快照与 wiki 页落盘）。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import type { ShellSpec } from "../src/shell.ts";
import {
  envRoot,
  isSnapshotFresh,
  loadEnv,
  machineKeyOf,
  parseVersion,
  probeDynamic,
  probeStatic,
  readSnapshot,
  resetEnvCache,
  snapshotFile,
  writeSnapshot,
  type ProbeDeps,
} from "../src/env/probe.ts";
import {
  formatBytes,
  formatEnvForCli,
  formatEnvPrompt,
  readEnvPageFingerprint,
  renderEnvPage,
} from "../src/env/render.ts";
import { buildEnvPage, mergeEnvPage, syncEnvPage } from "../src/env/wiki.ts";
import type { EnvSnapshot } from "../src/env/types.ts";
import type { WikiLayout } from "../src/wiki/paths.ts";

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const NOW = new Date();

const LINUX_SHELL: ShellSpec = {
  path: "/bin/bash",
  args: ["-l", "-c"],
  kind: "bash",
  login: true,
  source: "platform",
  warnings: [],
};

function makeDeps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    platform: "linux",
    arch: "x64",
    release: "6.17.0-23-generic",
    kernelVersion: "6.17.0-23-generic",
    hostname: "anders-Surface-Pro-7",
    cpus: () => [{ model: "Intel(R) Core(TM) i3-1005G1 CPU @ 1.20GHz" }, { model: "Intel" }],
    totalmem: () => 3.4 * 1024 ** 3,
    freemem: () => 1.8 * 1024 ** 3,
    statfs: () => ({ bsize: 4096, blocks: 30_000_000, bavail: 11_000_000 }),
    exists: (p) => p === "/.dockerenv",
    readFile: (p) => (p === "/etc/os-release" ? 'PRETTY_NAME="Ubuntu 24.04.4 LTS"\n' : null),
    which: (n) => {
      if (n === "bun") return "/home/anders/.local/bin/bun";
      if (n === "git") return "/usr/bin/git";
      if (n === "sudo") return "/usr/bin/sudo";
      return null;
    },
    run: (cmd) => {
      const program = cmd[0] ?? "";
      if (program.endsWith("bun")) return { stdout: "1.4.4\n", stderr: "", ok: true };
      if (program.endsWith("git")) return { stdout: "git version 2.43.0\n", stderr: "", ok: true };
      return { stdout: "", stderr: "", ok: false };
    },
    env: {
      SHELL: "/bin/bash",
      LANG: "zh_CN.UTF-8",
      TERM: "xterm-256color",
      SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22",
    },
    now: () => NOW,
    bunVersion: "1.4.4",
    nodeVersion: "24.15.0",
    uid: 1000,
    ...over,
  };
}

function makeSnap(opts: { shell?: ShellSpec; host?: string; deps?: ProbeDeps } = {}): EnvSnapshot {
  const deps = opts.deps ?? makeDeps(opts.host ? { hostname: opts.host } : {});
  const shell = opts.shell ?? LINUX_SHELL;
  return {
    static: probeStatic({ cwd: "/work", home: "/home/anders", shell, deps }),
    dynamic: probeDynamic({ cwd: "/work", deps }),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "neo-env-test-"));
}

function fakeLayout(root: string): WikiLayout {
  const pagesDir = join(root, "pages");
  mkdirSync(pagesDir, { recursive: true });
  return { pagesDir, rawDir: join(root, "raw"), kind: "user", scope: "user" };
}

/* ------------------------------------------------------------------ */
/* 机器指纹与基础工具                                                   */
/* ------------------------------------------------------------------ */

describe("machineKeyOf / parseVersion / formatBytes", () => {
  test("machineKey 确定性且带可读前缀", () => {
    const a = machineKeyOf("anders-Surface-Pro-7", "linux", "x64");
    const b = machineKeyOf("anders-Surface-Pro-7", "linux", "x64");
    expect(a).toBe(b);
    expect(a).toMatch(/^anders-surface-pro-7-linux-x64-[0-9a-f]{8}$/);
    expect(machineKeyOf("M4P", "darwin", "arm64")).toContain("m4p-darwin-arm64-");
  });

  test("parseVersion 容忍前缀/后缀格式", () => {
    expect(parseVersion("zsh 5.9 (x86_64)")).toBe("5.9");
    expect(parseVersion("git version 2.43.0")).toBe("2.43.0");
    expect(parseVersion("1.4.4")).toBe("1.4.4");
    expect(parseVersion("v20.11.1-linux")).toBe("20.11.1-linux");
    expect(parseVersion("no number here")).toBeNull();
  });

  test("formatBytes 二进制单位", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(1023)).toBe("1023B");
    expect(formatBytes(1024)).toBe("1.0K");
    expect(formatBytes(1536)).toBe("1.5K");
    expect(formatBytes(3.4 * 1024 ** 3)).toBe("3.4G");
    expect(formatBytes(48 * 1024 ** 3)).toBe("48G");
  });
});

/* ------------------------------------------------------------------ */
/* 静态/动态探测                                                        */
/* ------------------------------------------------------------------ */

describe("probeStatic — Ubuntu 事实采集", () => {
  test("OS / shell / CPU / 内存 / 工具链 / 容器 / 权限", () => {
    const snap = probeStatic({ cwd: "/work", home: "/home/anders", shell: LINUX_SHELL, deps: makeDeps() });
    expect(snap.version).toBe(1);
    expect(snap.os.pretty).toBe("Ubuntu 24.04.4 LTS");
    expect(snap.os.platform).toBe("linux");
    expect(snap.os.arch).toBe("x64");
    expect(snap.shell.path).toBe("/bin/bash");
    expect(snap.shell.kind).toBe("bash");
    expect(snap.tools["bun"]?.version).toBe("1.4.4");
    expect(snap.tools["git"]?.version).toBe("2.43.0");
    expect(snap.tools["node"]).toBeUndefined();
    expect(snap.cpu.cores).toBe(2);
    expect(snap.cpu.model).toContain("i3-1005G1");
    expect(snap.container.docker).toBe(true);
    expect(snap.container.ssh).toBe(true);
    expect(snap.gui).toBe(false);
    expect(snap.privileges.uid).toBe(1000);
    expect(snap.privileges.root).toBe(false);
    expect(snap.privileges.sudo).toBe(true);
    expect(snap.runtime.bun).toBe("1.4.4");
    expect(snap.runtime.node).toBe("24.15.0");
    expect(snap.machineKey.startsWith("anders-surface-pro-7-linux-x64-")).toBe(true);
    expect(snap.collectedAt).toBe(NOW.toISOString());
  });

  test("root 用户 / 无 sudo", () => {
    const snap = probeStatic({
      cwd: "/root",
      shell: LINUX_SHELL,
      deps: makeDeps({ uid: 0, which: () => null }),
    });
    expect(snap.privileges.root).toBe(true);
    expect(snap.privileges.sudo).toBe(false);
  });

  test("Windows 分支：pretty / GUI / cmd shell", () => {
    const cmdShell: ShellSpec = {
      path: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c"],
      kind: "cmd",
      login: false,
      source: "platform",
      warnings: [],
    };
    const deps = makeDeps({
      platform: "win32",
      arch: "x64",
      release: "10.0.26100",
      hostname: "WIN11-DESKTOP",
      cpus: () => [{ model: "AMD Ryzen 9 7950X" }],
      readFile: () => null,
      which: () => null,
      exists: () => false,
      env: {},
      run: () => null,
    });
    const snap = probeStatic({ cwd: "C:\\work", shell: cmdShell, deps });
    expect(snap.os.pretty).toBe("Windows 10.0.26100");
    expect(snap.gui).toBe(true);
    expect(snap.shell.kind).toBe("cmd");
    expect(snap.container.docker).toBe(false);
  });
});

describe("probeDynamic", () => {
  test("磁盘按 bsize/bavail 换算，内存取当前可用", () => {
    const dyn = probeDynamic({ cwd: "/work", deps: makeDeps() });
    expect(dyn.memoryFreeBytes).toBeCloseTo(1.8 * 1024 ** 3, 0);
    expect(dyn.disk?.freeBytes).toBe(11_000_000 * 4096);
    expect(dyn.disk?.totalBytes).toBe(30_000_000 * 4096);
    expect(dyn.disk?.path).toBe("/work");
  });

  test("statfs 抛错 / 返回 null → disk=null，不抛", () => {
    const dyn = probeDynamic({
      cwd: "/work",
      deps: makeDeps({
        statfs: () => {
          throw new Error("boom");
        },
      }),
    });
    expect(dyn.disk).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 快照读写                                                            */
/* ------------------------------------------------------------------ */

describe("快照持久化", () => {
  test("writeSnapshot → readSnapshot 往返一致；原子写不残留 tmp", () => {
    const dir = tempDir();
    try {
      const stat = makeSnap().static;
      const file = join(dir, "m.json");
      writeSnapshot(file, stat);
      expect(existsSync(file)).toBe(true);
      expect(readSnapshot(file)?.machineKey).toBe(stat.machineKey);
      expect(readSnapshot(file)?.shell.path).toBe("/bin/bash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("损坏 JSON / 版本不符 → null（当无缓存）", () => {
    const dir = tempDir();
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{not json");
      expect(readSnapshot(bad)).toBeNull();
      const old = join(dir, "old.json");
      writeFileSync(old, JSON.stringify({ ...makeSnap().static, version: 2 }));
      expect(readSnapshot(old)).toBeNull();
      expect(readSnapshot(join(dir, "missing.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isSnapshotFresh：TTL 边界", () => {
    const stat = makeSnap().static;
    const t = Date.parse(stat.collectedAt);
    expect(isSnapshotFresh(stat, 12, t + 11 * 3_600_000)).toBe(true);
    expect(isSnapshotFresh(stat, 12, t + 13 * 3_600_000)).toBe(false);
    expect(isSnapshotFresh({ ...stat, collectedAt: "not-a-date" }, 12, t)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* loadEnv 组合入口                                                    */
/* ------------------------------------------------------------------ */

describe("loadEnv", () => {
  const cfgOf = (env?: Record<string, unknown>): Config =>
    ({ cwd: "/work", env }) as unknown as Config;

  test("persist=true 首次探测并落盘，二次命中快照缓存", () => {
    const home = tempDir();
    try {
      resetEnvCache();
      const deps = makeDeps();
      const first = loadEnv({ cfg: cfgOf({ probeTtlHours: 12 }), persist: true, home, deps, shell: LINUX_SHELL });
      expect(first).not.toBeNull();
      expect(first!.persisted).toBe(true);
      expect(first!.fromCache).toBe(false);
      const key = first!.snapshot.static.machineKey;
      expect(first!.snapshotPath).toBe(snapshotFile(home, key, { probeTtlHours: 12 }));
      expect(existsSync(first!.snapshotPath)).toBe(true);

      resetEnvCache();
      const second = loadEnv({ cfg: cfgOf({ probeTtlHours: 12 }), persist: true, home, deps, shell: LINUX_SHELL });
      expect(second!.fromCache).toBe(true);

      resetEnvCache();
      const forced = loadEnv({
        cfg: cfgOf({ probeTtlHours: 12 }),
        persist: true,
        home,
        deps,
        shell: LINUX_SHELL,
        force: true,
      });
      expect(forced!.fromCache).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("persist=false 不落盘（-p / 非交互语义）", () => {
    const home = tempDir();
    try {
      resetEnvCache();
      const loaded = loadEnv({ cfg: cfgOf({}), persist: false, home, deps: makeDeps(), shell: LINUX_SHELL });
      expect(loaded).not.toBeNull();
      expect(loaded!.persisted).toBe(false);
      expect(existsSync(envRoot(home, {}))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("env.enabled=false / NEO_ENV_DISABLE=1 → null", () => {
    const home = tempDir();
    try {
      resetEnvCache();
      expect(loadEnv({ cfg: cfgOf({ enabled: false }), persist: true, home, deps: makeDeps(), shell: LINUX_SHELL })).toBeNull();
      const disabledDeps = makeDeps({ env: { ...makeDeps().env, NEO_ENV_DISABLE: "1" } });
      expect(loadEnv({ cfg: cfgOf({}), persist: true, home, deps: disabledDeps, shell: LINUX_SHELL })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("快照里的旧 shell 不会覆盖本次运行解析结果", () => {
    const home = tempDir();
    try {
      resetEnvCache();
      const deps = makeDeps();
      loadEnv({ cfg: cfgOf({ probeTtlHours: 12 }), persist: true, home, deps, shell: LINUX_SHELL });
      resetEnvCache();
      const zshShell: ShellSpec = { ...LINUX_SHELL, path: "/usr/bin/zsh", kind: "zsh", source: "config" };
      const loaded = loadEnv({ cfg: cfgOf({ probeTtlHours: 12 }), persist: true, home, deps, shell: zshShell });
      expect(loaded!.snapshot.static.shell.path).toBe("/usr/bin/zsh");
      expect(loaded!.snapshot.static.shell.kind).toBe("zsh");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

describe("formatEnvPrompt", () => {
  test("主代理版含平台/shell/资源/工具/约束，约 100–300 token", () => {
    const text = formatEnvPrompt(makeSnap());
    expect(text).toContain("平台：Ubuntu 24.04.4 LTS");
    expect(text).toContain("shell：/bin/bash（bash，登录 shell");
    expect(text).toContain("资源：2 核");
    expect(text).toContain("工具：bun 1.4.4");
    expect(text).toContain("无 GUI");
    expect(text).toContain("远程 SSH 会话");
    expect(text.length).toBeLessThan(1200);
  });

  test("子代理紧凑版省略资源行", () => {
    const text = formatEnvPrompt(makeSnap(), { compact: true });
    expect(text).not.toContain("资源：");
    expect(text).toContain("shell：/bin/bash");
  });

  test("无 GUI / 非 sudo 时不误报", () => {
    const snap = makeSnap({
      deps: makeDeps({ exists: () => false, env: { SHELL: "/bin/bash" }, which: () => null }),
    });
    const text = formatEnvPrompt(snap);
    expect(text).not.toContain("容器内");
    expect(text).not.toContain("远程 SSH");
    expect(text).not.toContain("sudo");
  });
});

describe("renderEnvPage / formatEnvForCli", () => {
  test("生成块含标记、指纹与关键字段", () => {
    const page = renderEnvPage(makeSnap());
    expect(page.block.startsWith("<!-- neo:env:start -->")).toBe(true);
    expect(page.block.endsWith("<!-- neo:env:end -->")).toBe(true);
    expect(page.block).toContain("/bin/bash");
    expect(page.block).toContain("Ubuntu 24.04.4 LTS");
    expect(page.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(readEnvPageFingerprint(page.block)).toBe(page.fingerprint);
    expect(page.summary).toContain("本机环境快照");
  });

  test("指纹只随机器/OS/shell 变化", () => {
    const a = renderEnvPage(makeSnap());
    const b = renderEnvPage(makeSnap({ host: "anders-Surface-Pro-7" }));
    expect(a.fingerprint).toBe(b.fingerprint);
    const c = renderEnvPage(makeSnap({ shell: { ...LINUX_SHELL, path: "/usr/bin/bash" } }));
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  test("/env CLI 输出含机器指纹、shell 与工具", () => {
    const text = formatEnvForCli(makeSnap(), { fromCache: true, probeMs: 8 });
    expect(text).toContain("环境快照");
    expect(text).toContain("/bin/bash");
    expect(text).toContain("bun 1.4.4");
    expect(text).toContain("命中缓存");
  });
});

/* ------------------------------------------------------------------ */
/* wiki 合并与同步                                                     */
/* ------------------------------------------------------------------ */

describe("mergeEnvPage", () => {
  test("无页面 → 新建：摘要 + 日期戳 + 块 + 人工补充区", () => {
    const { block, summary } = renderEnvPage(makeSnap());
    const r = mergeEnvPage(null, block, summary, "2026-10-26");
    expect(r.content).toContain("## 摘要");
    expect(r.content).toContain("> 最后更新:2026-10-26");
    expect(r.content).toContain("<!-- neo:env:start -->");
    expect(r.content).toContain("## 人工补充");
    expect(r.replacedBlock).toBe(false);
  });

  test("已有生成块 → 只替换块内，块外人工内容原样保留", () => {
    const a = renderEnvPage(makeSnap());
    const page = buildEnvPage(a.summary, a.block, "2026-01-01") + "\n人工追加：实验室机器，勿删。\n";

    const b = renderEnvPage(makeSnap({ shell: { ...LINUX_SHELL, path: "/usr/bin/zsh", kind: "zsh" } }));
    const r = mergeEnvPage(page, b.block, b.summary, "2026-10-26");
    expect(r.replacedBlock).toBe(true);
    expect(r.previousFingerprint).toBe(a.fingerprint);
    expect(r.content).toContain("人工追加：实验室机器，勿删。");
    expect(r.content).toContain("/usr/bin/zsh");
    expect(r.content).not.toContain("/bin/bash（bash，登录 shell");
    expect(r.content).toContain("> 最后更新:2026-10-26");
    // 块只能出现一次
    expect(r.content.split("<!-- neo:env:start -->").length).toBe(2);
  });

  test("手写页面（无生成块）→ 追加块并补摘要/日期戳，原文不丢", () => {
    const handwritten = "## 摘要\n\n我的机器笔记。\n\n若干手写内容 ABC。\n";
    const { block, summary } = renderEnvPage(makeSnap());
    const r = mergeEnvPage(handwritten, block, summary, "2026-10-26");
    expect(r.content).toContain("若干手写内容 ABC。");
    expect(r.content).toContain("我的机器笔记。");
    expect(r.content).toContain("<!-- neo:env:start -->");
    expect(r.content).toContain("> 最后更新:2026-10-26");
  });

  test("完全无结构的手写文件 → 页首补必备结构", () => {
    const { block, summary } = renderEnvPage(makeSnap());
    const r = mergeEnvPage("随手写的一行\n", block, summary, "2026-10-26");
    expect(r.content.startsWith("## 摘要")).toBe(true);
    expect(r.content).toContain("随手写的一行");
  });

  test("同输入幂等：两次 merge 结果一致", () => {
    const { block, summary, fingerprint } = renderEnvPage(makeSnap());
    const once = mergeEnvPage(null, block, summary, "2026-10-26");
    const twice = mergeEnvPage(once.content, block, summary, "2026-10-26");
    expect(twice.content).toBe(once.content);
    expect(readEnvPageFingerprint(twice.content)).toBe(fingerprint);
  });
});

describe("syncEnvPage", () => {
  test("创建 → 幂等 → 关键变化才更新并记 log", () => {
    const root = tempDir();
    try {
      const layout = fakeLayout(root);
      const snapA = makeSnap();
      const r1 = syncEnvPage(layout, snapA);
      expect(r1.action).toBe("created");
      expect(r1.logged).toBe(true);
      expect(existsSync(r1.pagePath)).toBe(true);
      expect(readFileSync(join(layout.pagesDir, "INDEX.md"), "utf8")).toContain("[[环境]]");
      const logAfter1 = readFileSync(join(layout.pagesDir, "log.md"), "utf8");
      expect(logAfter1).toContain("环境快照");

      const r2 = syncEnvPage(layout, makeSnap());
      expect(r2.action).toBe("unchanged");
      expect(r2.logged).toBe(false);

      // 人工往块外追加内容后，换 shell 触发更新：人工区必须保留。
      writeFileSync(r1.pagePath, `${readFileSync(r1.pagePath, "utf8")}\n人工追加：实验室机器\n`);
      const snapB = makeSnap({ shell: { ...LINUX_SHELL, path: "/usr/bin/zsh", kind: "zsh" } });
      const r3 = syncEnvPage(layout, snapB);
      expect(r3.action).toBe("updated");
      expect(r3.logged).toBe(true);
      const page = readFileSync(r3.pagePath, "utf8");
      expect(page).toContain("人工追加：实验室机器");
      expect(page).toContain("/usr/bin/zsh");
      expect(readFileSync(join(layout.pagesDir, "log.md"), "utf8").split("环境快照").length - 1).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
