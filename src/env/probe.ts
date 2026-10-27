/**
 * env/probe.ts — 纯脚本环境探测（v0.4.0 平台适配层）。
 *
 * 设计要点（PRD docs/neo-platform-adaptation-prd.md §3.2）：
 *  - **不需要模型**：OS/shell/CPU/内存/磁盘/工具链/容器全部确定性采集，约 10ms；
 *  - **事实源**：~/.neo/env/<machineKey>.json（静态部分 + TTL），动态值每次现算；
 *  - -p / 非交互模式只注入不落盘（persist=false）；
 *  - 不跑 sudo、不 dump 全量 env、不联网；
 *  - 所有外部依赖可注入，便于单测模拟 darwin/linux/win32。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { statfsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname as osHostname, arch as osArch, cpus, freemem, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { getShell, type ShellSpec } from "../shell.ts";
import type { EnvConfig, EnvDynamic, EnvSnapshot, EnvStatic, ToolInfo } from "./types.ts";

/** 固定候选清单：存在性全部探测；带版本的只对 VERSION_TOOLS 执行 `--version`。 */
const TOOL_CANDIDATES = [
  "bun",
  "node",
  "npm",
  "pnpm",
  "deno",
  "git",
  "python3",
  "python",
  "go",
  "rustc",
  "cargo",
  "java",
  "dotnet",
  "docker",
  "podman",
  "rg",
  "fd",
  "jq",
  "make",
  "gcc",
  "clang",
  "nvim",
  "vim",
  "code",
  "curl",
  "wget",
] as const;

const VERSION_TOOLS = new Set(["bun", "node", "git", "python3", "docker", "rg"]);

const VERSION_TIMEOUT_MS = 800;

export interface ProbeRunResult {
  stdout: string;
  stderr: string;
  ok: boolean;
}

/** 探测依赖注入面（生产默认走真实系统；测试全量注入）。 */
export interface ProbeDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  release?: string;
  kernelVersion?: string;
  hostname?: string;
  cpus?: () => Array<{ model: string }>;
  totalmem?: () => number;
  freemem?: () => number;
  statfs?: (p: string) => { bsize: number; blocks: number; bavail: number } | null;
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string | null;
  which?: (name: string) => string | null;
  run?: (cmd: string[], timeoutMs?: number) => ProbeRunResult | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** 已解析的 shell；不传则用 getShell()。 */
  shell?: ShellSpec;
  /** Bun 运行时版本（默认 Bun.version）。 */
  bunVersion?: string;
  /** 当前 node 版本。 */
  nodeVersion?: string | null;
  uid?: number | null;
}

const DEFAULT_DEPS: Required<
  Pick<
    ProbeDeps,
    | "platform"
    | "arch"
    | "release"
    | "hostname"
    | "cpus"
    | "totalmem"
    | "freemem"
    | "exists"
    | "readFile"
    | "which"
    | "run"
    | "env"
    | "now"
    | "bunVersion"
    | "nodeVersion"
  >
> = {
  platform: process.platform,
  arch: process.arch,
  release: release(),
  hostname: osHostname(),
  cpus: () => cpus().map((c) => ({ model: c.model })),
  totalmem: () => totalmem(),
  freemem: () => freemem(),
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  which: (name) => Bun.which(name),
  run: (cmd, timeoutMs = VERSION_TIMEOUT_MS) => {
    try {
      const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
      return {
        stdout: new TextDecoder().decode(r.stdout ?? new Uint8Array()),
        stderr: new TextDecoder().decode(r.stderr ?? new Uint8Array()),
        ok: r.exitCode === 0,
      };
    } catch {
      return null;
    }
  },
  env: process.env,
  now: () => new Date(),
  bunVersion: Bun.version,
  nodeVersion: process.versions.node ?? null,
};

function resolveDeps(deps: ProbeDeps = {}): typeof DEFAULT_DEPS & { kernelVersion?: string; statfs?: ProbeDeps["statfs"]; shell?: ShellSpec; uid?: number | null } {
  return { ...DEFAULT_DEPS, ...deps } as typeof DEFAULT_DEPS & {
    kernelVersion?: string;
    statfs?: ProbeDeps["statfs"];
    shell?: ShellSpec;
    uid?: number | null;
  };
}

/* ------------------------------------------------------------------ */
/* 机器指纹                                                            */
/* ------------------------------------------------------------------ */

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "host"
  );
}

/** 机器指纹：可读前缀 + hash；确定性（同机恒定），为多机区分/未来同步预留。 */
export function machineKeyOf(hostname: string, platform: NodeJS.Platform, arch: string): string {
  const hash = createHash("sha256").update(`${hostname}|${platform}|${arch}`).digest("hex").slice(0, 8);
  return `${slugify(hostname)}-${platform}-${arch}-${hash}`;
}

/* ------------------------------------------------------------------ */
/* 版本解析                                                            */
/* ------------------------------------------------------------------ */

/** 从版本输出里抓第一个 semver 形态（容忍 "git version 2.43.0" / "bun 1.4.4" 之类）。 */
export function parseVersion(text: string): string | null {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/.exec(text);
  return m?.[1] ?? null;
}

function versionOf(deps: ReturnType<typeof resolveDeps>, path: string): string | null {
  const r = deps.run([path, "--version"]);
  if (!r) return null;
  return parseVersion(`${r.stdout}\n${r.stderr}`);
}

/* ------------------------------------------------------------------ */
/* 静态探测                                                            */
/* ------------------------------------------------------------------ */

export interface ProbeStaticOptions {
  cwd: string;
  home?: string;
  /** 不传则 getShell()（生产路径）；测试可注入。 */
  shell?: ShellSpec;
  deps?: ProbeDeps;
  /** 是否探测工具版本（默认 true；单测可关掉避免 spawn）。 */
  toolVersions?: boolean;
}

/** 有副作用的系统命令一律不经 shell：直接 `--version`，800ms 超时。 */
export function probeStatic(opts: ProbeStaticOptions): EnvStatic {
  const deps = resolveDeps(opts.deps);
  const platform = deps.platform;
  const shell = opts.shell ?? deps.shell ?? getShell();
  const now = deps.now();

  const tools: Record<string, ToolInfo> = {};
  const wantVersions = opts.toolVersions !== false;
  for (const name of TOOL_CANDIDATES) {
    const path = deps.which(name);
    if (!path) continue;
    tools[name] =
      wantVersions && VERSION_TOOLS.has(name)
        ? { path, version: versionOf(deps, path) }
        : { path, version: null };
  }

  const env = deps.env;
  const hostname = deps.hostname;
  const platformName = deps.platform;
  const arch = deps.arch;
  const rel = deps.release;

  return {
    version: 1,
    collectedAt: now.toISOString(),
    machineKey: machineKeyOf(hostname, platformName, arch),
    hostname,
    os: {
      platform: platformName,
      arch,
      release: rel,
      kernelVersion: deps.kernelVersion ?? rel,
      pretty: detectPrettyOs(platformName, rel, deps.readFile),
    },
    shell: {
      path: shell.path,
      kind: shell.kind,
      login: shell.login,
      source: shell.source,
      version: shell.kind === "cmd" ? null : versionOf(deps, shell.path),
    },
    cpu: {
      cores: deps.cpus().length,
      model: (deps.cpus()[0]?.model ?? "unknown").trim(),
    },
    memoryTotalBytes: deps.totalmem(),
    tools,
    container: {
      docker: deps.exists("/.dockerenv") || Boolean(env["container"]),
      wsl: Boolean(env["WSL_DISTRO_NAME"] ?? env["WSL_INTEROP"]),
      ssh: Boolean(env["SSH_CONNECTION"] ?? env["SSH_TTY"] ?? env["SSH_CLIENT"]),
    },
    terminal: {
      term: env["TERM"] ?? null,
      program: env["TERM_PROGRAM"] ?? null,
      colorterm: env["COLORTERM"] ?? null,
    },
    locale: {
      lang: env["LC_ALL"] ?? env["LANG"] ?? null,
      timezone: detectTimezone(now),
    },
    privileges: {
      uid: deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : null),
      root: (deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : null)) === 0,
      sudo: Boolean(deps.which("sudo")),
    },
    gui:
      platformName === "darwin" ||
      platformName === "win32" ||
      Boolean(env["DISPLAY"] ?? env["WAYLAND_DISPLAY"]),
    runtime: {
      bun: deps.bunVersion,
      node: deps.nodeVersion,
      parentPath: env["PATH"] ?? null,
    },
  };
}

function detectPrettyOs(
  platform: NodeJS.Platform,
  rel: string,
  readFile: (p: string) => string | null,
): string {
  if (platform === "linux") {
    const txt = readFile("/etc/os-release");
    if (txt) {
      const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(txt);
      if (m?.[1]) return m[1].trim();
    }
    return `Linux ${rel}`;
  }
  if (platform === "darwin") return `macOS (Darwin ${rel})`;
  if (platform === "win32") return `Windows ${rel}`;
  return platform;
}

function detectTimezone(now: Date): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 动态探测                                                            */
/* ------------------------------------------------------------------ */

export interface ProbeDynamicOptions {
  cwd: string;
  deps?: ProbeDeps;
}

export function probeDynamic(opts: ProbeDynamicOptions): EnvDynamic {
  const deps = resolveDeps(opts.deps);
  const disk = readDisk(deps, opts.cwd);
  return {
    observedAt: deps.now().toISOString(),
    memoryFreeBytes: deps.freemem(),
    disk,
  };
}

function readDisk(
  deps: ReturnType<typeof resolveDeps>,
  cwd: string,
): EnvDynamic["disk"] {
  const statfs = deps.statfs ?? defaultStatfs;
  try {
    const s = statfs(cwd);
    if (!s) return null;
    const bsize = Number(s.bsize);
    const blocks = Number(s.blocks);
    const bavail = Number(s.bavail);
    if (!Number.isFinite(bsize) || !Number.isFinite(blocks) || !Number.isFinite(bavail)) return null;
    return { path: cwd, freeBytes: bavail * bsize, totalBytes: blocks * bsize };
  } catch {
    return null;
  }
}

function defaultStatfs(p: string): { bsize: number; blocks: number; bavail: number } | null {
  try {
    const s = statfsSync(p);
    return { bsize: s.bsize, blocks: s.blocks, bavail: s.bavail };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 快照读写                                                            */
/* ------------------------------------------------------------------ */

export function envRoot(home: string, cfg?: EnvConfig): string {
  return cfg?.dir ?? join(home, ".neo", "env");
}

export function snapshotFile(home: string, machineKey: string, cfg?: EnvConfig): string {
  return join(envRoot(home, cfg), `${machineKey}.json`);
}

/** 读快照；schema 版本不符或结构损坏 = null（当作无缓存）。 */
export function readSnapshot(file: string): EnvStatic | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const snap = parsed as Partial<EnvStatic>;
    if (snap.version !== 1) return null;
    if (typeof snap.machineKey !== "string" || typeof snap.collectedAt !== "string") return null;
    if (typeof snap.shell !== "object" || snap.shell === null) return null;
    return snap as EnvStatic;
  } catch {
    return null;
  }
}

/** 原子写：tmp + rename，避免半截 JSON。 */
export function writeSnapshot(file: string, snap: EnvStatic): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(snap, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

export function isSnapshotFresh(snap: EnvStatic, ttlHours: number, nowMs = Date.now()): boolean {
  const ts = Date.parse(snap.collectedAt);
  if (!Number.isFinite(ts)) return false;
  const ttl = Math.max(0, ttlHours) * 3_600_000;
  return nowMs - ts <= ttl;
}

/* ------------------------------------------------------------------ */
/* 组合入口                                                            */
/* ------------------------------------------------------------------ */

export interface LoadEnvOptions {
  /** 是否允许落盘（交互式 true；-p / 非交互 false）。 */
  persist: boolean;
  /** 忽略 TTL 强制重采。 */
  force?: boolean;
  home?: string;
  deps?: ProbeDeps;
  shell?: ShellSpec;
  /** 不传则用 cfg.env / cfg.shell / cfg.cwd。 */
  cfg?: Config;
}

export interface LoadedEnv {
  snapshot: EnvSnapshot;
  /** 快照文件路径（persist=false 时仍返回理论路径，供 /env 展示）。 */
  snapshotPath: string;
  fromCache: boolean;
  persisted: boolean;
  /** 静态探测耗时（ms），诊断用。 */
  probeMs: number;
}

let snapshotCache: { key: string; loaded: LoadedEnv } | null = null;

/**
 * 组装当前环境快照。
 *
 * 规则：
 *  1. env.enabled=false / NEO_ENV_DISABLE=1 → null；
 *  2. 有新鲜快照 → 用；否则重采静态部分（persist 时写盘）；
 *  3. shell 字段永远以**本次运行解析结果**为准（配置改了不能等 TTL）；
 *  4. 动态部分每次现算。
 */
export function loadEnv(opts: LoadEnvOptions): LoadedEnv | null {
  const cfg = opts.cfg;
  const envCfg = cfg?.env ?? {};
  const deps = opts.deps;
  const realEnv = deps?.env ?? process.env;
  if (envCfg.enabled === false || realEnv["NEO_ENV_DISABLE"] === "1") return null;

  const home = opts.home ?? homedir();
  const cwd = cfg?.cwd ?? process.cwd();
  const shell = opts.shell ?? getShell(cfg);
  const ttlHours = envCfg.probeTtlHours ?? 12;
  const key = JSON.stringify({
    home,
    cwd,
    persist: opts.persist,
    force: opts.force ?? false,
    envCfg,
    shell: { path: shell.path, kind: shell.kind, login: shell.login },
    platform: deps?.platform ?? process.platform,
    hostname: deps?.hostname ?? osHostname(),
  });
  if (!opts.force && snapshotCache && snapshotCache.key === key) return snapshotCache.loaded;

  const machineKey = machineKeyOf(
    deps?.hostname ?? osHostname(),
    deps?.platform ?? process.platform,
    deps?.arch ?? osArch(),
  );
  const file = snapshotFile(home, machineKey, envCfg);
  const existing = readSnapshot(file);

  let stat: EnvStatic;
  let fromCache = false;
  let probeMs = 0;
  if (!opts.force && existing && isSnapshotFresh(existing, ttlHours)) {
    stat = existing;
    fromCache = true;
  } else {
    const t0 = performance.now();
    stat = probeStatic({ cwd, home, shell, deps });
    probeMs = Math.round(performance.now() - t0);
  }

  // shell 以本次运行解析结果为准：即使快照是 12h 前的，也不能让 prompt 说错 shell。
  // models（A2 探测到的窗口事实）不属于「静态探测」产物：刷新时保留旧值，
  // 否则一次 /env refresh 或 TTL 过期就把学习结果抹掉。
  stat = {
    ...stat,
    ...(existing?.models ? { models: existing.models } : {}),
    machineKey,
    shell: {
      path: shell.path,
      kind: shell.kind,
      login: shell.login,
      source: shell.source,
      // 路径没变才沿用快照里的版本号，避免拿旧 shell 的版本冒充新的。
      version: stat.shell.path === shell.path ? stat.shell.version : null,
    },
  };

  const dynamic = probeDynamic({ cwd, deps });
  let persisted = false;
  if (opts.persist) {
    try {
      writeSnapshot(file, stat);
      persisted = true;
    } catch {
      // 落盘失败不致命：本次仍可用内存里的快照；
      // 权限/磁盘问题由 /env 或下次写入暴露，不阻塞会话。
    }
  }

  const loaded: LoadedEnv = { snapshot: { static: stat, dynamic }, snapshotPath: file, fromCache, persisted, probeMs };
  snapshotCache = { key, loaded };
  return loaded;
}

export function resetEnvCache(): void {
  snapshotCache = null;
}

/**
 * 供系统提示词/子代理使用的便捷入口：永不抛错、永不落盘。
 * 探测失败返回 null（提示词段落直接省略，不影响主流程）。
 */
export function getEnvForPrompt(cfg?: Config): EnvSnapshot | null {
  try {
    const loaded = loadEnv({ cfg, persist: false });
    return loaded?.snapshot ?? null;
  } catch {
    return null;
  }
}
