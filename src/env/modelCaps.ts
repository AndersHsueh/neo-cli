/**
 * 模型能力「空字段写回 settings.json」（P3，GitHub #5）。
 *
 * 为什么单独一个模块：modelWindows.ts 已经负责「探测 + env 事实」，
 * 这里只做「把探测到的能力补进用户配置的空缺处」，职责单一、可单测。
 * 依赖方向：本模块 → config.ts（只 import type）与 env/modelWindows.ts（探测），
 * 不反向 import，避免循环。
 *
 * 铁律（与 P1/P2 一致）：**手写优先**。
 *  - 只写「空缺」字段：数值 >0 算已填，布尔 true/false 都算已填（false 是明确判断）；
 *  - 探测值 unknown 不写（不知道 ≠ 不支持）；
 *  - 绝不碰 api_key / base_url / models / max_tokens 等无关键；
 *  - 写盘失败一律吞掉：能力补全是增强项，不得影响会话。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { Config, ProviderConfig } from "../config.ts";
import type { CapabilityFlag } from "./types.ts";
import {
  detectModelCapabilitiesFromModelsApi,
  modelKey,
  recordModelContext,
  type DetectedModelCapabilities,
} from "./modelWindows.ts";

/** 待写回的能力补丁：只含「探测到了」的字段，缺省 = 没探测到。 */
export interface CapabilityPatch {
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  vision?: CapabilityFlag;
  tools?: CapabilityFlag;
  reasoning?: CapabilityFlag;
}

/** 一次写回的结果，供调用方决定要不要提示用户。 */
export interface SettingsWritebackResult {
  /** 实际写进 settings.json 的键（snake_case，按写入顺序）。 */
  written: string[];
  /** 因「已填」而被跳过的键。 */
  skipped: string[];
  /** 是否真的落盘（没有可写字段 / 无 settingsPath 时为 false）。 */
  persisted: boolean;
  /** 落盘失败原因（吞掉但留痕，便于排障）。 */
  error?: string;
}

type Raw = Record<string, unknown>;

const EMPTY_RESULT: SettingsWritebackResult = { written: [], skipped: [], persisted: false };

/** 数值字段「已填」判定：>0 的有限数。0/负数/非数 = 未填（视作没声明）。 */
function filledNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** 布尔字段「已填」判定：true/false 都算已填 —— false 是用户的明确判断。 */
function filledBool(v: unknown): boolean {
  return typeof v === "boolean";
}

function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/** 三态 → 可写入的布尔；unknown 返回 undefined（不写）。 */
function writableFlag(v: CapabilityFlag | undefined): boolean | undefined {
  return v === true || v === false ? v : undefined;
}

/** 当前 provider 在 cfg.providers 里的那一项（找不到返回 undefined）。 */
export function currentProviderConfig(cfg: Config): ProviderConfig | undefined {
  return cfg.providers?.find((p) => p.name === cfg.providerName);
}

/**
 * 当前 provider 仍未声明的能力字段（snake_case，固定顺序）。
 *
 * 数值 >0 算已填；布尔 true/false 都算已填。找不到 provider 时返回空数组
 * （宁可不动，也不把「没有这份配置」当成「五项都空」）。
 *
 * #6：按字段看空缺。只填了 context_window 时，输出上限 / 视觉 / 工具 / 推理
 * 仍然算未声明，首次探测要继续补它们，提示也不能被窗口挡掉。
 */
export function undeclaredCapabilityFields(cfg: Config): string[] {
  const p = currentProviderConfig(cfg);
  if (!p) return [];
  const missing: string[] = [];
  if (!filledNumber(p.contextWindow)) missing.push("context_window");
  if (!filledNumber(p.maxOutputTokens)) missing.push("max_output_tokens");
  if (!filledBool(p.vision)) missing.push("vision");
  if (!filledBool(p.tools)) missing.push("tools");
  if (!filledBool(p.reasoning)) missing.push("reasoning");
  return missing;
}

/**
 * 当前 provider 的手写能力是否「全部未填」。
 *
 * 定义：context_window / max_output_tokens / vision / tools / reasoning
 * 五项**全部**没有有效值。找不到 provider 时返回 false。
 * 首次探测本身看 `undeclaredCapabilityFields`（有空缺就补），这个函数只回答
 * 「是不是一次都没声明过」，给启动文案用。
 */
export function isCapabilityUndeclared(cfg: Config): boolean {
  return undeclaredCapabilityFields(cfg).length === 5;
}

/** 读 settings.json；不存在/解析失败返回 null（解析失败绝不覆盖写）。 */
function readSettingsFile(path: string): Raw | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Raw;
  } catch {
    return null;
  }
}

/**
 * 把能力补丁写进 settings.json 的**空字段**，并同步内存里的 cfg.providers。
 *
 * 行为：
 *  1. cfg.settingsPath 为空 → no-op（返回空结果）；
 *  2. 读 settings.json，定位 `providers[].provider_name === cfg.providerName` 的那一项；
 *     找不到（或文件不可解析）→ 不写盘，但仍同步内存；
 *  3. 逐字段判断「已填/空缺」，只写空缺；已填的进 skipped；
 *  4. 写盘失败吞掉，error 里留原因。
 *
 * 注意 `max_output_tokens` 是新字段：**不读也不写 `max_tokens`** ——
 * 后者是「本次请求要多少输出」的预算，不是模型能力上限。
 */
export function writeBackCapabilities(
  cfg: Config,
  patch: CapabilityPatch,
): SettingsWritebackResult {
  const result: SettingsWritebackResult = { written: [], skipped: [], persisted: false };
  const prov = currentProviderConfig(cfg);

  // ---- 1. 规划：哪些字段该写（内存视角的「已填」判定） ----
  const plan: Array<{ key: string; value: number | boolean; mem: "contextWindow" | "maxOutputTokens" | "vision" | "tools" | "reasoning" }> = [];

  const ctx = positive(patch.contextWindow);
  if (ctx !== null) {
    if (filledNumber(prov?.contextWindow)) result.skipped.push("context_window");
    else plan.push({ key: "context_window", value: ctx, mem: "contextWindow" });
  }

  const out = positive(patch.maxOutputTokens);
  if (out !== null) {
    if (filledNumber(prov?.maxOutputTokens)) result.skipped.push("max_output_tokens");
    else plan.push({ key: "max_output_tokens", value: out, mem: "maxOutputTokens" });
  }

  for (const [key, flag, mem] of [
    ["vision", patch.vision, "vision"],
    ["tools", patch.tools, "tools"],
    ["reasoning", patch.reasoning, "reasoning"],
  ] as const) {
    const v = writableFlag(flag);
    if (v === undefined) continue;
    if (filledBool(prov?.[mem])) result.skipped.push(key);
    else plan.push({ key, value: v, mem });
  }

  if (plan.length === 0) return result;

  // ---- 2. 落盘：只改目标 provider 的空缺键 ----
  const path = cfg.settingsPath;
  if (path) {
    const raw = readSettingsFile(path);
    const list = raw?.["providers"];
    if (raw && Array.isArray(list)) {
      const entry = list.find(
        (x): x is Raw =>
          typeof x === "object" && x !== null && !Array.isArray(x) && (x as Raw)["provider_name"] === cfg.providerName,
      );
      if (entry) {
        const toPersist: Array<{ key: string; value: number | boolean }> = [];
        for (const item of plan) {
          // 文件里的值才是真相：内存可能已被本进程改过，或用户手改过文件。
          const cur = entry[item.key];
          const already =
            typeof item.value === "number" ? filledNumber(cur) : filledBool(cur);
          if (already) {
            if (!result.skipped.includes(item.key)) result.skipped.push(item.key);
            continue;
          }
          entry[item.key] = item.value;
          toPersist.push({ key: item.key, value: item.value });
        }
        if (toPersist.length > 0) {
          try {
            writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
            result.persisted = true;
            result.written.push(...toPersist.map((x) => x.key));
          } catch (e) {
            result.error = (e as Error).message;
          }
        }
      }
    }
  }

  // ---- 3. 同步内存：本进程不能继续当「未填」，否则会反复探测/反复提示 ----
  // 即便写盘失败也同步：本次会话内已知的事实不该丢。
  if (prov) {
    for (const item of plan) {
      if (item.mem === "contextWindow" || item.mem === "maxOutputTokens") {
        if (!filledNumber(prov[item.mem])) prov[item.mem] = item.value as number;
      } else if (!filledBool(prov[item.mem])) {
        prov[item.mem] = item.value as boolean;
      }
    }
  }

  return result;
}

/** 探测结果 → 写回补丁（只保留探测到的值）。 */
export function patchFromDetected(caps: DetectedModelCapabilities): CapabilityPatch {
  return {
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutputTokens,
    vision: caps.vision,
    tools: caps.tools,
    reasoning: caps.reasoning,
  };
}

/**
 * 上下文撞墙写回：把溢出错误里解析出的真实窗口补进空的 `context_window`。
 *
 * 只写「未填」的那一项；已填的保持用户值（探测值仍会进 env 事实，
 * 由 resolveContextWindow 在运行时优先采用 —— 那是「本次生效值」，
 * 与「用户配置」是两件事，不能混为一谈）。
 */
export function writeBackContextLimit(cfg: Config, tokens: number): SettingsWritebackResult {
  const limit = positive(tokens);
  if (limit === null) return { ...EMPTY_RESULT };
  return writeBackCapabilities(cfg, { contextWindow: limit });
}

/**
 * 输出撞墙写回：`finish_reason === "length"` 时补 `max_output_tokens`。
 *
 * 只走 `/models` 元数据（不额外发试探请求 —— 那既费钱又慢，也不能靠抬高 max_tokens 去摸硬顶）。
 * 网关没给上限就什么都不写：禁止把 `usage.completion_tokens` 或请求预算 `max_tokens`
 * 记成能力上限（#6 实测里那会把 64 当成硬顶）。
 * 返回写回结果；探测不到时 written 为空，调用方用提示告诉用户去手写。
 */
export async function writeBackOutputLimit(cfg: Config): Promise<SettingsWritebackResult> {
  const caps = await detectModelCapabilitiesFromModelsApi(cfg);
  const out = positive(caps?.maxOutputTokens);
  if (out === null) return { ...EMPTY_RESULT };
  return writeBackCapabilities(cfg, { maxOutputTokens: out });
}

/** 本进程已跑过首次探测的 `provider|model`（避免每轮重复探测/重复提示）。 */
const probedThisProcess = new Set<string>();

/** 测试用：清空「本进程已探测」标记。 */
export function resetFirstUseProbeMemo(): void {
  probedThisProcess.clear();
}

export interface FirstUseProbeResult {
  /** 是否真的发起了探测（false = 条件不满足或已探测过）。 */
  ran: boolean;
  /** 写进 settings.json 的键。 */
  written: string[];
  /** env 事实里的窗口（探测不到 = null）。 */
  contextWindow: number | null;
}

/**
 * 首次使用探测：当前 provider 还有未声明的能力字段、且本进程没探测过该 provider|model 时，
 * 跑一次 `/models` 探测，把空字段写回 settings.json，并继续写 env 快照。
 *
 * #6：不再要求五项全空。只填了 context_window 时，vision/tools/reasoning/输出上限
 * 仍要补；已填字段（含 false）由 writeBackCapabilities 跳过。
 *
 * 调用方负责「明确告知用户」那句提示（本函数不打印，便于单测）。
 * 任何失败都静默返回（探测是增强项，不得阻断会话）。
 */
export async function probeCapabilitiesOnFirstUse(cfg: Config): Promise<FirstUseProbeResult> {
  const none: FirstUseProbeResult = { ran: false, written: [], contextWindow: null };
  if (undeclaredCapabilityFields(cfg).length === 0) return none;

  const key = modelKey(cfg.providerName, cfg.model);
  if (probedThisProcess.has(key)) return none;
  probedThisProcess.add(key);

  try {
    const caps = await detectModelCapabilitiesFromModelsApi(cfg);
    if (!caps) return { ...none, ran: true };

    // env 事实（与 P1 一致）：窗口/输出上限/三态能力都记下来。
    recordModelContext(cfg, {
      contextWindow: caps.contextWindow,
      maxOutputTokens: caps.maxOutputTokens,
      vision: caps.vision,
      tools: caps.tools,
      reasoning: caps.reasoning,
      source: "models_api",
      evidence: caps.evidence,
    });

    const wb = writeBackCapabilities(cfg, patchFromDetected(caps));
    return { ran: true, written: wb.written, contextWindow: caps.contextWindow };
  } catch {
    return { ...none, ran: true };
  }
}
