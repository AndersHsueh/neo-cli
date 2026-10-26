/**
 * tests/shell.test.ts — 跨平台 shell 解析器（v0.4.0 平台适配层）。
 *
 * 覆盖三平台分支（darwin/linux/win32 全注入模拟，不依赖真实环境）、
 * argv 构造、PATH 保真 preamble、错误提示，以及「写死 /bin/zsh」的防漂移守卫。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  ShellResolveError,
  POSIX_PATH_PREAMBLE,
  describeShell,
  detectShellKind,
  getShell,
  isPosixShellKind,
  prepareShellInvocation,
  resetShellCache,
  resolveShell,
  shellArgv,
  shellErrorHint,
  supportsPathPreamble,
} from "../src/shell.ts";

const EXEC_ONLY = (paths: string[]) => (p: string) => paths.includes(p);

describe("detectShellKind", () => {
  test("识别 POSIX 家族与绝对路径", () => {
    expect(detectShellKind("/bin/zsh")).toBe("zsh");
    expect(detectShellKind("/bin/bash")).toBe("bash");
    expect(detectShellKind("/usr/bin/fish")).toBe("fish");
    expect(detectShellKind("/bin/dash")).toBe("dash");
  });

  test("识别 Windows 路径（反斜杠 + .exe，不依赖当前平台）", () => {
    expect(detectShellKind("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
    expect(detectShellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("pwsh");
    expect(detectShellKind("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
  });

  test("未知 shell 归为 unknown", () => {
    expect(detectShellKind("/opt/tool/myshell")).toBe("unknown");
  });
});

describe("resolveShell — POSIX 探测顺序", () => {
  test("darwin 无 $SHELL 时用平台默认 /bin/zsh", () => {
    const spec = resolveShell({}, {
      platform: "darwin",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/zsh"]),
      which: () => null,
    });
    expect(spec.path).toBe("/bin/zsh");
    expect(spec.source).toBe("platform");
    expect(spec.kind).toBe("zsh");
    expect(spec.login).toBe(true);
    expect(spec.args).toEqual(["-l", "-c"]);
  });

  test("linux 上 $SHELL 指向不存在的 zsh → 回退平台默认 bash（sp7 场景）", () => {
    const spec = resolveShell({}, {
      platform: "linux",
      env: { SHELL: "/bin/zsh" },
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    expect(spec.path).toBe("/bin/bash");
    expect(spec.kind).toBe("bash");
    expect(spec.source).toBe("platform");
    expect(spec.login).toBe(true);
  });

  test("$SHELL 合法时优先于平台默认", () => {
    const spec = resolveShell({}, {
      platform: "darwin",
      env: { SHELL: "/usr/local/bin/fish" },
      isExecutable: EXEC_ONLY(["/usr/local/bin/fish", "/bin/zsh"]),
      which: () => null,
    });
    expect(spec.path).toBe("/usr/local/bin/fish");
    expect(spec.kind).toBe("fish");
    expect(spec.source).toBe("env:SHELL");
  });

  test("NEO_SHELL 高于 $SHELL", () => {
    const spec = resolveShell({}, {
      platform: "linux",
      env: { NEO_SHELL: "/usr/bin/bash", SHELL: "/bin/sh" },
      isExecutable: EXEC_ONLY(["/usr/bin/bash"]),
      which: () => null,
    });
    expect(spec.path).toBe("/usr/bin/bash");
    expect(spec.source).toBe("env:NEO_SHELL");
  });

  test("settings.shell.path 优先级最高；不可执行时回退并记 warning", () => {
    const ok = resolveShell({ path: "/opt/myshell" }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/opt/myshell", "/bin/bash"]),
      which: () => null,
    });
    expect(ok.path).toBe("/opt/myshell");
    expect(ok.source).toBe("config");

    const bad = resolveShell({ path: "/opt/missing" }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    expect(bad.path).toBe("/bin/bash");
    expect(bad.warnings.some((w) => w.includes("/opt/missing"))).toBe(true);
  });

  test("未知 kind 的 shell 只给 -c、不走登录参数", () => {
    const spec = resolveShell({ path: "/opt/weird/myshell" }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/opt/weird/myshell"]),
      which: () => null,
    });
    expect(spec.kind).toBe("unknown");
    expect(spec.login).toBe(false);
    expect(spec.args).toEqual(["-c"]);
  });

  test("which 兜底（$SHELL/平台默认都不存在）", () => {
    const spec = resolveShell({}, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/home/u/bin/bash"]),
      which: (name) => (name === "bash" ? "/home/u/bin/bash" : null),
    });
    expect(spec.path).toBe("/home/u/bin/bash");
    expect(spec.source).toBe("which");
  });

  test("全部候选都不存在 → ShellResolveError（可操作提示）", () => {
    expect(() =>
      resolveShell({}, { platform: "linux", env: {}, isExecutable: () => false, which: () => null }),
    ).toThrow(ShellResolveError);
    try {
      resolveShell({}, { platform: "linux", env: {}, isExecutable: () => false, which: () => null });
    } catch (e) {
      expect((e as Error).message).toContain("NEO_SHELL");
    }
  });

  test("login:false 与 args 覆盖", () => {
    const noLogin = resolveShell({ login: false }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    expect(noLogin.login).toBe(false);
    expect(noLogin.args).toEqual(["-c"]);

    const override = resolveShell({ path: "/bin/bash", args: ["-c"] }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    expect(override.args).toEqual(["-c"]);
  });
});

describe("resolveShell — Windows 分支", () => {
  test("ComSpec(cmd) 兜底", () => {
    const spec = resolveShell({}, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      isExecutable: (p) => p === "C:\\Windows\\System32\\cmd.exe",
      which: () => null,
    });
    expect(spec.kind).toBe("cmd");
    expect(spec.args).toEqual(["/d", "/s", "/c"]);
    expect(spec.login).toBe(false);
    expect(spec.warnings.some((w) => w.includes("PD-1"))).toBe(true);
  });

  test("pwsh 优先于 cmd", () => {
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const spec = resolveShell({}, {
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      isExecutable: (p) => p === pwsh || p.includes("cmd.exe"),
      which: (n) => (n === "pwsh" ? pwsh : null),
    });
    expect(spec.kind).toBe("pwsh");
    expect(spec.path).toBe(pwsh);
    expect(spec.args).toEqual(["-NoProfile", "-NoLogo", "-Command"]);
  });
});

describe("argv / PATH 保真", () => {
  test("shellArgv 把 command 追加在参数前缀之后", () => {
    const spec = resolveShell({ path: "/bin/bash" }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    expect(shellArgv(spec, "echo hi")).toEqual(["/bin/bash", "-l", "-c", "echo hi"]);
  });

  test("登录 POSIX shell 注入 NEO_INHERITED_PATH + preamble", () => {
    const spec = resolveShell({ path: "/bin/bash" }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    const inv = prepareShellInvocation(spec, "echo hi", { PATH: "/custom/bin:/usr/bin", HOME: "/home/u" });
    expect(inv.pathPreamble).toBe(true);
    expect(inv.env["NEO_INHERITED_PATH"]).toBe("/custom/bin:/usr/bin");
    expect(inv.command.startsWith(POSIX_PATH_PREAMBLE)).toBe(true);
    expect(inv.command.endsWith("echo hi")).toBe(true);
    expect(inv.argv.at(-1)).toBe(inv.command);
  });

  test("非登录 shell 不注入 preamble（env 原样继承）", () => {
    const spec = resolveShell({ path: "/bin/bash", login: false }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    const inv = prepareShellInvocation(spec, "echo hi", { PATH: "/custom/bin" });
    expect(inv.pathPreamble).toBe(false);
    expect(inv.env["NEO_INHERITED_PATH"]).toBeUndefined();
    expect(inv.command).toBe("echo hi");
  });

  test("fish / Windows cmd 不吃 POSIX preamble", () => {
    expect(supportsPathPreamble("fish")).toBe(false);
    expect(supportsPathPreamble("cmd")).toBe(false);
    expect(supportsPathPreamble("bash")).toBe(true);
    expect(isPosixShellKind("fish")).toBe(true);
    expect(isPosixShellKind("pwsh")).toBe(false);

    const fish = resolveShell({ path: "/usr/local/bin/fish" }, {
      platform: "darwin",
      env: {},
      isExecutable: EXEC_ONLY(["/usr/local/bin/fish"]),
      which: () => null,
    });
    const inv = prepareShellInvocation(fish, "echo hi", { PATH: "/x" });
    expect(inv.pathPreamble).toBe(false);
    expect(inv.command).toBe("echo hi");
  });
});

describe("describeShell / shellErrorHint", () => {
  test("描述串包含路径、家族与登录标识", () => {
    const spec = resolveShell({ path: "/bin/bash" }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    expect(describeShell(spec)).toBe("/bin/bash（bash，登录 shell）");
  });

  test("ENOENT 给出配置建议", () => {
    const spec = resolveShell({ path: "/bin/bash" }, {
      platform: "linux",
      env: {},
      isExecutable: EXEC_ONLY(["/bin/bash"]),
      which: () => null,
    });
    const hint = shellErrorHint(new Error("ENOENT: no such file or directory, posix_spawn '/bin/zsh'"), spec);
    expect(hint).toContain("shell.path");
    expect(hint).toContain("NEO_SHELL");
    expect(shellErrorHint(new Error("EACCES: permission denied"), spec)).toContain("无执行权限");
  });
});

describe("getShell 缓存", () => {
  test("resetShellCache 后仍能解析（真实环境）", () => {
    resetShellCache();
    const a = getShell();
    const b = getShell();
    expect(a.path).toBe(b.path);
    expect(a.path.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* 防漂移守卫：写死 /bin/zsh 只能出现在 src/shell.ts                    */
/* ------------------------------------------------------------------ */

function* walkTs(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true }) as Dirent[]) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkTs(full);
    else if (e.name.endsWith(".ts")) yield full;
  }
}

describe("防漂移守卫（v0.4.0 平台适配层）", () => {
  test("src 下除 shell.ts 外不得出现写死 /bin/zsh", () => {
    const root = join(import.meta.dir, "..", "src");
    const offenders: string[] = [];
    for (const f of walkTs(root)) {
      if (f.endsWith(`${join("", "shell.ts")}`) && f.endsWith("shell.ts")) continue;
      if (readFileSync(f, "utf8").includes("/bin/zsh")) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
