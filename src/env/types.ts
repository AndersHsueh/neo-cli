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
  /**
   * `/models` 能力探测超时（毫秒）。缺省 5000。
   * 旧默认 2500 对慢企业网关的冷启动偏紧，会把「有元数据」误判成探测失败。
   */
  modelsProbeTimeoutMs?: number;
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
  /**
   * 已探测到的模型上下文窗口（v0.4.1 A2）。key = `${provider}|${model}`。
   * 单独放在静态快照里，让 /env、启动与 /context 都能读到同一份事实。
   */
  models?: Record<string, ModelContextInfo>;
}

/**
 * 三态能力标记：true/false 是已知事实，"unknown" 是「没探测到」。
 * 用三态而不是 boolean 是为了区分「确认不支持」与「不知道」——
 * 前者可以据此拒绝请求，后者只能保守放行。
 */
export type CapabilityFlag = true | false | "unknown";

/** 单个模型的上下文窗口事实（可能来自 /models 元数据或溢出错误）。 */
export interface ModelContextInfo {
  /** 探测到的窗口；null = 只知道存在但没拿到值。 */
  contextWindow: number | null;
  source: "models_api" | "overflow_error" | "config" | "known" | "error_evidence" | "behavior_probe";
  updatedAt: string;
  /** 依据（截断后的错误文案/字段名），便于 /env 展示与排障。 */
  evidence?: string;
  /** 成功请求里见过的最大 prompt tokens（下界证据，不代表上限）。 */
  observedMaxPromptTokens?: number;
  /**
   * 模型单次输出上限（P1）。与 settings 的 `max_tokens` 语义不同：
   * 后者是「本次请求我要多少输出」，这里是「模型最多能给多少」。
   * 缺省/null = 未探测到。旧快照没有这些字段，读取方必须容忍 undefined。
   */
  maxOutputTokens?: number | null;
  /** 是否支持图像输入。 */
  vision?: CapabilityFlag;
  /** 是否支持工具调用。 */
  tools?: CapabilityFlag;
  /** 是否为推理模型。 */
  reasoning?: CapabilityFlag;
  /**
   * 输出上限主动探测的时间与结论（issue #8）。它的唯一用途是**防空转**：
   * 7 天内探过（不论结论）就不再重复发请求。结论本身不写进 settings，
   * 只有 found 才会把值写进 `max_output_tokens`。
   */
  outputProbe?: {
    at: string;
    outcome: "found" | "lower_bound" | "inconclusive";
    /** lower_bound 时「已验证至少能接受」的预算。 */
    atLeast?: number;
    /** found 时的精确上限（写回 settings 的同一个值）。 */
    limit?: number;
    /** inconclusive 的原因（opaque / context / auth / other）。 */
    reason?: string;
  };
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
