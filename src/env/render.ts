/**
 * env/render.ts — 环境快照的三种呈现（v0.4.0 平台适配层）。
 *
 *  - formatEnvPrompt：系统提示词「## 环境」段（主代理完整版 / 子代理紧凑版）；
 *  - renderEnvPage：wiki 页生成块（结构化、可检索、带机器指纹）；
 *  - formatEnvForCli：`/env` 命令输出。
 *
 * 全部纯函数：输入 EnvSnapshot，输出字符串，便于快照式单测与 token 预算断言。
 */
import { createHash } from "node:crypto";
import type { EnvSnapshot } from "./types.ts";

/** 字节 → 人类可读（二进制单位，1 位小数）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  const units = ["B", "K", "M", "G", "T", "P"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  if (i === 0) return `${Math.round(v)}B`;
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`;
}

/** prompt 里展示的核心工具顺序（其余工具只在 `/env` 与 wiki 页出现）。 */
const PROMPT_TOOL_ORDER = ["bun", "node", "git", "python3", "docker", "rg"] as const;

function shellKindLabel(kind: string): string {
  switch (kind) {
    case "zsh":
      return "zsh";
    case "bash":
      return "bash";
    case "sh":
      return "POSIX sh";
    case "dash":
      return "dash";
    case "ksh":
      return "ksh";
    case "fish":
      return "fish";
    case "pwsh":
      return "PowerShell 7";
    case "powershell":
      return "Windows PowerShell";
    case "cmd":
      return "cmd.exe";
    default:
      return "该 shell";
  }
}

function toolLine(snap: EnvSnapshot): string {
  const parts: string[] = [];
  for (const name of PROMPT_TOOL_ORDER) {
    const info = snap.static.tools[name];
    if (!info) continue;
    parts.push(info.version ? `${name} ${info.version}` : name);
  }
  if (parts.length === 0) return "";
  return `- 工具：${parts.join(" · ")}（未列出的工具不要假设已安装）`;
}

function constraintLine(snap: EnvSnapshot): string {
  const s = snap.static;
  const items: string[] = [];
  if (s.container.docker) items.push("容器内（Docker）");
  if (s.container.wsl) items.push("WSL 内");
  if (s.container.ssh) items.push("远程 SSH 会话");
  if (!s.gui) items.push("无 GUI（不要建议打开浏览器/编辑器）");
  if (s.privileges.root) items.push("以 root 运行（命令直接影响系统）");
  else if (s.privileges.sudo) items.push("非 root（需要提权时先说明）");
  if (items.length === 0) return "";
  return `- 约束：${items.join(" · ")}`;
}

/**
 * 渲染系统提示词环境块。
 * compact=true 给子代理：去掉资源/内存等次要行，保留平台、shell、工具与约束。
 */
export function formatEnvPrompt(snap: EnvSnapshot, opts: { compact?: boolean } = {}): string {
  const s = snap.static;
  const lines: string[] = [];
  lines.push(`- 平台：${s.os.pretty} · ${s.os.arch}（${s.os.platform} ${s.os.release}）`);

  const login = s.shell.login ? "登录 shell" : "非登录 shell";
  lines.push(
    `- shell：${s.shell.path}（${shellKindLabel(s.shell.kind)}，${login}；` +
      `命令必须兼容 ${shellKindLabel(s.shell.kind)}，不要使用其它 shell 专有语法）`,
  );

  if (!opts.compact) {
    lines.push(`- 资源：${s.cpu.cores} 核 · 内存 ${formatBytes(s.memoryTotalBytes)}`);
    const tool = toolLine(snap);
    if (tool) lines.push(tool);
  } else {
    const tool = toolLine(snap);
    if (tool) lines.push(tool);
  }

  const constraint = constraintLine(snap);
  if (constraint) lines.push(constraint);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* wiki 页 / CLI                                                       */
/* ------------------------------------------------------------------ */

export const ENV_BLOCK_START = "<!-- neo:env:start -->";
export const ENV_BLOCK_END = "<!-- neo:env:end -->";
const FINGERPRINT_RE = /<!-- neo:env:fingerprint:([0-9a-f]+) -->/;

/** 指纹只取「变了才值得记 log」的关键字段：机器/OS/shell。 */
export function envFingerprint(snap: EnvSnapshot): string {
  const s = snap.static;
  return createHash("sha256")
    .update(`${s.machineKey}|${s.os.platform}|${s.os.release}|${s.shell.path}|${s.shell.kind}`)
    .digest("hex")
    .slice(0, 12);
}

export function envPageSummary(snap: EnvSnapshot): string {
  const s = snap.static;
  return (
    `本机环境快照（自动生成）：${s.os.pretty} · ${shellKindLabel(s.shell.kind)} · ` +
    `${s.cpu.cores} 核 / ${formatBytes(s.memoryTotalBytes)} 内存`
  );
}

function mdCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export interface EnvPageRender {
  summary: string;
  /** 生成块（含 start/end 标记与指纹）。 */
  block: string;
  fingerprint: string;
}

/** 渲染 wiki 页的生成块（只此块由脚本拥有，块外内容由人或 remember 维护）。 */
export function renderEnvPage(snap: EnvSnapshot): EnvPageRender {
  const s = snap.static;
  const d = snap.dynamic;
  const fingerprint = envFingerprint(snap);
  const rows: Array<[string, string]> = [
    ["主机名", s.hostname],
    ["机器指纹", `\`${s.machineKey}\``],
    ["OS", `${s.os.pretty}（${s.os.platform} ${s.os.release} ${s.os.arch}）`],
    ["内核", s.os.kernelVersion],
    ["shell", `${s.shell.path}（${shellKindLabel(s.shell.kind)}，${s.shell.login ? "登录 shell" : "非登录 shell"}，来源 ${s.shell.source}）`],
    ["shell 版本", s.shell.version ?? "（未探测到）"],
    ["CPU", `${s.cpu.cores} 核 · ${s.cpu.model}`],
    ["内存", `${formatBytes(s.memoryTotalBytes)}（当前可用 ${formatBytes(d.memoryFreeBytes)}）`],
    ["磁盘", d.disk ? `${d.disk.path}：可用 ${formatBytes(d.disk.freeBytes)} / 共 ${formatBytes(d.disk.totalBytes)}` : "（不可用）"],
    [
      "工具链",
      Object.entries(s.tools)
        .map(([name, info]) => (info.version ? `${name} ${info.version}` : name))
        .join(" · ") || "（无）",
    ],
    [
      "运行环境",
      [
        `Bun ${s.runtime.bun}`,
        s.runtime.node ? `Node ${s.runtime.node}` : null,
        s.gui ? "有 GUI" : "无 GUI",
        s.container.docker ? "Docker" : null,
        s.container.wsl ? "WSL" : null,
        s.container.ssh ? "SSH" : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    ["终端", [s.terminal.term ? `TERM=${s.terminal.term}` : null, s.terminal.program ? `TERM_PROGRAM=${s.terminal.program}` : null].filter(Boolean).join(" · ") || "（未设置）"],
    ["区域", [s.locale.lang, s.locale.timezone].filter(Boolean).join(" · ") || "（未知）"],
    [
      "权限",
      [
        s.privileges.uid === null ? null : `uid=${s.privileges.uid}`,
        s.privileges.root ? "root" : "非 root",
        s.privileges.sudo ? "sudo 可用" : "无 sudo",
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    ["采集时间", `${s.collectedAt}（快照采集；可用内存/磁盘为本次会话观测）`],
  ];

  const table = ["| 项 | 值 |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${mdCell(v)} |`)].join("\n");
  const block = [
    ENV_BLOCK_START,
    "> 本块由 neo 自动生成（/env refresh 可重采）；请勿手工编辑块内内容。",
    "",
    table,
    "",
    `<!-- neo:env:fingerprint:${fingerprint} -->`,
    ENV_BLOCK_END,
  ].join("\n");

  return { summary: envPageSummary(snap), block, fingerprint };
}

/** 解析已有 wiki 页里的机器指纹（没有生成块 = null）。 */
export function readEnvPageFingerprint(page: string): string | null {
  return FINGERPRINT_RE.exec(page)?.[1] ?? null;
}

/** `/env` 命令输出。 */
export function formatEnvForCli(snap: EnvSnapshot, meta?: { snapshotPath?: string; fromCache?: boolean; probeMs?: number; persisted?: boolean }): string {
  const s = snap.static;
  const d = snap.dynamic;
  const lines: string[] = [];
  lines.push(`环境快照  ${s.machineKey}`);
  lines.push(`  采集      ${s.collectedAt}${meta?.fromCache ? "（命中缓存）" : ""}${meta?.probeMs ? ` · 探测 ${meta.probeMs}ms` : ""}`);
  if (meta?.snapshotPath) {
    lines.push(`  快照文件  ${meta.snapshotPath}${meta.persisted ? "（已更新）" : ""}`);
  }
  lines.push(`  平台      ${s.os.pretty} · ${s.os.platform} ${s.os.release} · ${s.os.arch} · ${s.cpu.cores} 核`);
  lines.push(`  shell     ${s.shell.path}（${shellKindLabel(s.shell.kind)}，${s.shell.login ? "登录 shell" : "非登录 shell"}，来源 ${s.shell.source}${s.shell.version ? `，版本 ${s.shell.version}` : ""}）`);
  lines.push(`  内存      ${formatBytes(s.memoryTotalBytes)} 总 / ${formatBytes(d.memoryFreeBytes)} 可用`);
  lines.push(`  磁盘      ${d.disk ? `${d.disk.path} 可用 ${formatBytes(d.disk.freeBytes)} / 共 ${formatBytes(d.disk.totalBytes)}` : "不可用"}`);
  const tools = Object.entries(s.tools).map(([n, i]) => (i.version ? `${n} ${i.version}` : n));
  lines.push(`  工具      ${tools.length > 0 ? tools.join(" · ") : "（无）"}`);
  const flags = [
    s.gui ? "GUI" : "无 GUI",
    s.container.docker ? "Docker" : null,
    s.container.wsl ? "WSL" : null,
    s.container.ssh ? "SSH" : null,
    s.privileges.root ? "root" : "非 root",
    s.privileges.sudo ? "sudo" : null,
    s.locale.timezone,
  ].filter(Boolean);
  lines.push(`  标记      ${flags.join(" · ")}`);
  return lines.join("\n");
}
