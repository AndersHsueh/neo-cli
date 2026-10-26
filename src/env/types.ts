/**
 * env/types.ts — 环境探测的数据契约（v0.4.0 平台适配层）。
 *
 * 分层原则：
 *  - EnvStatic：变化慢（OS / shell / CPU / 工具链版本），可落盘 + TTL 缓存；
 *  - EnvDynamic：每次会话现算（可用内存 / 磁盘），**不进系统提示词**（会中途过期）；
 *  - EnvSnapshot：两者合并，供渲染 prompt / wiki 页 / `/env` 使用。
 *
 * 本文件只放类型，不 import 任何实现模块（保持 config.ts 可安全 import type）。
 */
import type { ShellKind, ShellSource } from "../shell.ts";

/** settings.json 的 env 段。 */
export interface EnvConfig {
  /** 总开关；false = 不探测、不注入、不落盘。 */
  enabled?: boolean;
  /** 静态快照 TTL（小时），默认 12。 */
  probeTtlHours?: number;
  /** 是否把环境块注入系统提示词（默认 true）。 */
  prompt?: boolean;
  /** 是否把快照渲染到 ~/.neo/wiki/wiki/环境.md（默认 true；-p 模式恒不写）。 */
  wikiPage?: boolean;
  /** 快照根目录覆盖（测试/多环境隔离用），默认 ~/.neo/env。 */
  dir?: string;
}

export interface ToolInfo {
  /** which 解析出的绝对路径。 */
  path: string;
  /** 探测到的版本号（无版本命令或超时 = null）。 */
  version: string | null;
}

export interface EnvStatic {
  /** schema 版本；升级时据此迁移/丢弃旧快照。 */
  version: 1;
  /** 采集时间（ISO）。TTL 以它为准。 */
  collectedAt: string;
  /** 机器指纹：hostname-platform-arch-<hash8>。为将来 ~/.neo-team 多机同步预留。 */
  machineKey: string;
  hostname: string;
  os: {
    platform: NodeJS.Platform;
    arch: string;
    release: string;
    kernelVersion: string;
    /** 人类可读，例：Ubuntu 24.04.4 LTS / macOS (Darwin 27.0.0) / Windows 10.0.26100。 */
    pretty: string;
  };
  shell: {
    path: string;
    kind: ShellKind;
    login: boolean;
    source: ShellSource;
    /** shell 自身版本（`--version` 解析失败 = null）。 */
    version: string | null;
  };
  cpu: { cores: number; model: string };
  memoryTotalBytes: number;
  /** 固定候选工具名 → 存在性与版本；缺失的工具不出现在对象里。 */
  tools: Record<string, ToolInfo>;
  container: { docker: boolean; wsl: boolean; ssh: boolean };
  terminal: { term: string | null; program: string | null; colorterm: string | null };
  locale: { lang: string | null; timezone: string | null };
  privileges: { uid: number | null; root: boolean; sudo: boolean };
  /** 是否存在图形界面（SSH 上通常无）。 */
  gui: boolean;
  runtime: { bun: string; node: string | null; parentPath: string | null };
}

export interface EnvDynamic {
  observedAt: string;
  memoryFreeBytes: number;
  /** cwd 所在挂载点；statfs 失败 = null。 */
  disk: { path: string; freeBytes: number; totalBytes: number } | null;
}

export interface EnvSnapshot {
  static: EnvStatic;
  dynamic: EnvDynamic;
}
