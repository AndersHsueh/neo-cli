/**
 * shell.ts — 跨平台 shell 解析与 spawn 参数构造（v0.4.0 平台适配层）。
 *
 * 背景：v0.3.5 之前 `shell` 工具与 `!cmd` 都写死 `["/bin/zsh","-lc",cmd]`，
 * 在 Ubuntu 上（默认无 zsh）直接 `ENOENT`，两条执行路径全部失效。
 *
 * 本模块是「用哪个 shell、怎么传参、怎么保 PATH」的唯一真源：
 *  - 探测顺序：settings.shell.path → NEO_SHELL → $SHELL → 平台默认 → which → /bin/sh；
 *  - Windows：pwsh → powershell → ComSpec(cmd) 分支（实验性，未实机验证，见 PD-1）；
 *  - 登录 shell 会重新初始化 PATH（macOS /etc/zprofile、Ubuntu /etc/profile），
 *    因此登录模式 spawn 时注入 NEO_INHERITED_PATH，并在命令前把父进程 PATH 前置，
 *    保证「neo 启动环境里能用的命令，shell 工具一样能用」。
 *
 * 不依赖模型/网络，纯函数可注入（platform/env/isExecutable/which），便于单测模拟三平台。
 */
import { accessSync, constants, statSync } from "node:fs";

export type ShellKind =
  | "zsh"
  | "bash"
  | "sh"
  | "dash"
  | "ksh"
  | "fish"
  | "pwsh"
  | "powershell"
  | "cmd"
  | "unknown";

export type ShellSource =
  | "config"
  | "env:NEO_SHELL"
  | "env:SHELL"
  | "platform"
  | "which"
  | "fallback";

/** settings.json 的 shell 段（可覆盖探测结果）。 */
export interface ShellConfig {
  /** 绝对路径；不填=自动探测。 */
  path?: string;
  /** 是否用登录 shell（-l）。默认 true（与旧 macOS 行为一致）。 */
  login?: boolean;
  /** 终极逃生口：整体覆盖 shell 参数前缀（command 追加在最后）。 */
  args?: string[];
}

export interface ShellSpec {
  path: string;
  /** shell 参数前缀，不含 command；例 ["-l","-c"] / ["-NoProfile","-Logo","-Command"]。 */
  args: string[];
  kind: ShellKind;
  login: boolean;
  source: ShellSource;
  /** 解析过程中的非致命问题（配置路径不存在、$SHELL 不可用等），供启动诊断展示。 */
  warnings: string[];
}

export interface ResolveShellDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** 路径是否为可执行文件；默认 fs.access(X_OK)+isFile()。 */
  isExecutable?: (path: string) => boolean;
  /** PATH 查找；默认 Bun.which。 */
  which?: (name: string) => string | null;
}

export class ShellResolveError extends Error {
  readonly attempted: string[];

  constructor(message: string, attempted: string[]) {
    super(message);
    this.name = "ShellResolveError";
    this.attempted = attempted;
  }
}

/** 登录 shell 的 PATH 保真前缀（POSIX sh 语法；fish 不适用）。 */
export const POSIX_PATH_PREAMBLE =
  'if [ -n "${NEO_INHERITED_PATH-}" ]; then PATH="$NEO_INHERITED_PATH:$PATH"; export PATH; fi; unset NEO_INHERITED_PATH; ';

const POSIX_KINDS: ReadonlySet<ShellKind> = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish"]);

/** 该 shell 是否属于 POSIX 家族（sh/bash/zsh/dash/ksh/fish）。 */
export function isPosixShellKind(kind: ShellKind): boolean {
  return POSIX_KINDS.has(kind);
}

/** 该 shell 是否能吃 POSIX 登录 PATH preamble（fish 的语法不兼容）。 */
export function supportsPathPreamble(kind: ShellKind): boolean {
  return kind !== "fish" && kind !== "unknown" && kind !== "pwsh" && kind !== "powershell" && kind !== "cmd";
}

/** 从 shell 路径识别家族。兼容 POSIX 与 Windows 两种分隔符（便于跨平台单测）。 */
export function detectShellKind(path: string): ShellKind {
  const base = fileNameOf(path).toLowerCase().replace(/\.exe$/, "");
  if (base === "pwsh" || base.startsWith("pwsh-")) return "pwsh";
  switch (base) {
    case "zsh":
    case "bash":
    case "sh":
    case "dash":
    case "ksh":
    case "fish":
      return base;
    case "powershell":
      return "powershell";
    case "cmd":
      return "cmd";
    default:
      return "unknown";
  }
}

/** 取路径最后一段（同时识别 / 与 \，不依赖当前平台）。 */
function fileNameOf(p: string): string {
  const m = /([^\\/]+)$/.exec(p);
  return m?.[1] ?? p;
}

function looksAbsolute(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(p);
}

function defaultIsExecutable(p: string): boolean {
  if (!looksAbsolute(p)) return false;
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultWhich(name: string): string | null {
  return Bun.which(name);
}

function normalizeArgs(args: string[] | undefined): string[] | null {
  if (!Array.isArray(args)) return null;
  const clean = args.filter((a): a is string => typeof a === "string");
  return clean.length > 0 ? clean : null;
}

/** 平台默认 shell（仅 POSIX；win32 走 Windows 分支）。 */
function platformDefault(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "/bin/zsh";
    case "linux":
      return "/bin/bash";
    default:
      return "/bin/sh";
  }
}

interface Candidate {
  path: string;
  source: ShellSource;
}

function pushCandidate(
  list: Candidate[],
  path: string | undefined,
  source: ShellSource,
  isExec: (p: string) => boolean,
  warnings: string[],
): void {
  if (!path || path.trim() === "") return;
  const p = path.trim();
  if (!isExec(p)) {
    if (source === "config" || source === "env:NEO_SHELL") {
      warnings.push(`指定的 shell 不可执行：${p}（${source}），已回退到其它候选`);
    }
    return;
  }
  if (list.some((c) => c.path === p)) return;
  list.push({ path: p, source });
}

/** 解析 shell。测试可注入 platform/env/isExecutable/which 模拟三平台。 */
export function resolveShell(config: ShellConfig = {}, deps: ResolveShellDeps = {}): ShellSpec {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const isExec = deps.isExecutable ?? defaultIsExecutable;
  const which = deps.which ?? defaultWhich;
  const overrideArgs = normalizeArgs(config.args);
  const loginWanted = config.login ?? true;
  const warnings: string[] = [];
  const candidates: Candidate[] = [];

  pushCandidate(candidates, config.path, "config", isExec, warnings);
  pushCandidate(candidates, env["NEO_SHELL"], "env:NEO_SHELL", isExec, warnings);

  if (platform === "win32") {
    pushCandidate(candidates, env["SHELL"], "env:SHELL", isExec, warnings);
    for (const name of ["pwsh", "powershell"]) {
      pushCandidate(candidates, which(name) ?? undefined, "which", isExec, warnings);
    }
    const comspec = env["ComSpec"] ?? env["COMSPEC"];
    pushCandidate(candidates, comspec, "platform", isExec, warnings);
    pushCandidate(candidates, which("cmd") ?? undefined, "which", isExec, warnings);
    if (candidates.length === 0) {
      throw new ShellResolveError(
        `Windows 上未找到可用 shell（尝试 pwsh / powershell / ComSpec）。可用 --shell 配置或设置 NEO_SHELL。`,
        [],
      );
    }
    const chosen = candidates[0]!;
    const kind = detectShellKind(chosen.path);
    const args = overrideArgs ?? defaultWindowsArgs(kind);
    warnings.push("Windows shell 执行尚未实机验证（PD-1），如遇失败请附 stderr 反馈");
    return { path: chosen.path, args, kind, login: false, source: chosen.source, warnings };
  }

  pushCandidate(candidates, env["SHELL"], "env:SHELL", isExec, warnings);
  pushCandidate(candidates, platformDefault(platform), "platform", isExec, warnings);
  for (const name of ["zsh", "bash", "sh"]) {
    pushCandidate(candidates, which(name) ?? undefined, "which", isExec, warnings);
  }
  pushCandidate(candidates, "/bin/sh", "fallback", isExec, warnings);

  if (candidates.length === 0) {
    throw new ShellResolveError(
      `未找到可用 shell（已尝试 config / NEO_SHELL / $SHELL / ${platformDefault(platform)} / which / /bin/sh）。` +
        `请在 settings.json 的 shell.path 指定，或设置 NEO_SHELL。`,
      [],
    );
  }

  const chosen = candidates[0]!;
  const kind = detectShellKind(chosen.path);
  const usableLogin = loginWanted && kind !== "unknown";
  const args = overrideArgs ?? (usableLogin ? ["-l", "-c"] : ["-c"]);
  return { path: chosen.path, args, kind, login: usableLogin, source: chosen.source, warnings };
}

function defaultWindowsArgs(kind: ShellKind): string[] {
  switch (kind) {
    case "pwsh":
    case "powershell":
      return ["-NoProfile", "-NoLogo", "-Command"];
    case "cmd":
      return ["/d", "/s", "/c"];
    default:
      // 自定义/未知 Windows shell：给一个最常见的 -c，失败时由用户用 shell.args 覆盖。
      return ["-c"];
  }
}

/** 构造完整 argv（command 永远追加在最后）。 */
export function shellArgv(spec: ShellSpec, command: string): string[] {
  return [spec.path, ...spec.args, command];
}

export interface ShellInvocation {
  argv: string[];
  /** 传给 Bun.spawn 的环境（登录 POSIX shell 会注入 NEO_INHERITED_PATH）。 */
  env: Record<string, string | undefined>;
  /** 实际执行的命令串（可能包含 PATH preamble）。 */
  command: string;
  /** 是否注入了 PATH preamble。 */
  pathPreamble: boolean;
}

/**
 * 构造一次 shell 执行的 argv/env。
 *
 * PATH 保真的原因：`-l` 会重新初始化 PATH。旧实现虽然传了 env，
 * 但登录 shell 会把 PATH 覆盖掉（macOS path_helper / Ubuntu /etc/profile），
 * 于是「neo 能调用 bun、shell 工具却 not found」。登录模式下把父进程 PATH
 * 放在最前面，其余 rc 追加项保留在后面。
 */
export function prepareShellInvocation(
  spec: ShellSpec,
  command: string,
  baseEnv: Record<string, string | undefined> = process.env,
): ShellInvocation {
  const needsPreamble = spec.login && supportsPathPreamble(spec.kind);
  if (!needsPreamble) {
    return { argv: shellArgv(spec, command), env: { ...baseEnv }, command, pathPreamble: false };
  }
  const inherited = baseEnv["PATH"] ?? baseEnv["Path"] ?? "";
  const env = { ...baseEnv, NEO_INHERITED_PATH: inherited };
  const wrapped = `${POSIX_PATH_PREAMBLE}${command}`;
  return { argv: shellArgv(spec, wrapped), env, command: wrapped, pathPreamble: true };
}

/** 给人/模型看的 shell 描述，例：/bin/bash（bash，登录 shell）。 */
export function describeShell(spec: ShellSpec): string {
  const label = spec.kind === "unknown" ? "未知 shell" : spec.kind;
  return `${spec.path}（${label}${spec.login ? "，登录 shell" : ""}）`;
}

/** spawn 失败时的可操作提示（ENOENT / EACCES 各有说法）。 */
export function shellErrorHint(err: unknown, spec: ShellSpec): string {
  const msg = err instanceof Error ? err.message : String(err);
  const extra =
    spec.warnings.length > 0 ? `；解析告警：${spec.warnings.join("；")}` : "";
  if (/ENOENT/.test(msg)) {
    return `找不到 shell 可执行文件（${spec.path}）。请在 settings.json 配置 shell.path 或设置 NEO_SHELL${extra}`;
  }
  if (/EACCES|EPERM/.test(msg)) {
    return `shell 无执行权限（${spec.path}）。请检查文件权限${extra}`;
  }
  return msg;
}

/* ------------------------------------------------------------------ */
/* 进程内缓存                                                          */
/* ------------------------------------------------------------------ */

interface HasShellConfig {
  shell?: ShellConfig;
}

let cached: { key: string; spec: ShellSpec } | null = null;

function shellCacheKey(config?: HasShellConfig): string {
  return JSON.stringify({
    shell: config?.shell ?? null,
    platform: process.platform,
    shellEnv: process.env["SHELL"] ?? null,
    neoShellEnv: process.env["NEO_SHELL"] ?? null,
    pathEnv: process.env["PATH"] ?? null,
  });
}

/**
 * 取当前进程的 shell 解析结果（带缓存）。
 *
 * 缓存键包含 PATH / SHELL / NEO_SHELL / settings.shell：同一进程内 PATH 变化
 * （罕见）或配置热改后能自动失效。测试用 resetShellCache() 重置。
 */
export function getShell(config?: HasShellConfig): ShellSpec {
  const key = shellCacheKey(config);
  if (cached && cached.key === key) return cached.spec;
  const spec = resolveShell(config?.shell ?? {});
  cached = { key, spec };
  return spec;
}

export function resetShellCache(): void {
  cached = null;
}
