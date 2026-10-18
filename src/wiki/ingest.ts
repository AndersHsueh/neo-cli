/**
 * ingest 计划与状态 —— /ingest 命令的纯函数核心。
 *
 * 模式判定（wiki-turnning-1018.md「全量 / 增量」）：
 *  - /ingest full          → 全量；
 *  - /ingest incremental   → 增量；
 *  - /ingest（无参）        → 读 log 最近一次 ingest 时间：超 1 周 → 全量（执行前告知），
 *                            1 周内 → 增量；从未 ingest 过 → 全量（第一次本来就是全量）。
 *
 * 增量的「上次快照」存 <pages>/../ingest-state.json（时间戳 + 当时的 raw 清单）。
 * 快照缺失但 log 显示最近跑过 → 无法算差集，回落全量（如实告知）。
 *
 * 子代理派发与 UI 交互在命令层（src/index.ts），本模块不碰 console、不碰 Agent。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { WikiLayout } from "./paths.ts";
import { lastIngestDate } from "./write.ts";

export type IngestMode = "full" | "incremental";

export interface IngestState {
  /** 上次 ingest 完成时间（ISO）。 */
  lastRunAt: string;
  /** 上次 ingest 时的 raw 文件清单（相对 raw/ 的路径）。 */
  lastRawFiles: string[];
}

export interface IngestPlan {
  mode: IngestMode;
  /** 判定理由（给用户看）。 */
  reason: string;
  /** 是否需要在执行前明确告知用户（自动判定出的全量）。 */
  needsAnnounce: boolean;
  /** 全量：全部 raw；增量：新增的 raw（相对路径）。 */
  files: string[];
  /** 增量模式下自上次以来删除的 raw（相对路径）。 */
  removed: string[];
  /** 当前 raw 全集（相对路径）。 */
  allRawFiles: string[];
}

const STATE_FILE = "ingest-state.json";
const WEEK_MS = 7 * 24 * 3600 * 1000;

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

function statePath(layout: WikiLayout): string {
  // 状态文件放主题页目录的上一级（neo 布局 = .neo/wiki/；独立库 = <cwd>/）
  return join(layout.pagesDir, "..", STATE_FILE);
}

export function readIngestState(layout: WikiLayout): IngestState | null {
  const p = statePath(layout);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as IngestState;
    if (!Array.isArray(raw.lastRawFiles) || typeof raw.lastRunAt !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeIngestState(layout: WikiLayout, files: string[]): void {
  const state: IngestState = { lastRunAt: new Date().toISOString(), lastRawFiles: files };
  writeFileSync(statePath(layout), JSON.stringify(state, null, 2), "utf8");
}

/** 清除状态文件（测试用）。 */
export function clearIngestState(layout: WikiLayout): void {
  const p = statePath(layout);
  if (existsSync(p)) unlinkSync(p);
}

/* ------------------------------------------------------------------ */
/* 计划                                                                */
/* ------------------------------------------------------------------ */

/** 列出 raw/ 下的全部文件（相对路径，递归；忽略点文件）。 */
export function listRawFiles(layout: WikiLayout): string[] {
  const root = layout.rawDir;
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

/** 距上次 ingest 是否超过 1 周。从未 ingest 过返回 true（第一次按全量走）。 */
export function isStale(layout: WikiLayout): boolean {
  const last = lastIngestDate(layout);
  if (!last) return true;
  const t = Date.parse(`${last}T00:00:00`);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > WEEK_MS;
}

/**
 * 计算 ingest 计划。arg 是用户输入的参数（"" / "full" / "incremental"）。
 * 抛 Error 当参数非法。
 */
export function planIngest(layout: WikiLayout, arg: string): IngestPlan {
  const all = listRawFiles(layout);
  const param = arg.trim().toLowerCase();
  if (param !== "" && param !== "full" && param !== "incremental") {
    throw new Error(`未知参数 "${arg}"。用法：/ingest [full|incremental]`);
  }

  // 增量：需要上次快照
  if (param === "incremental" || (param === "" && !isStale(layout))) {
    const state = readIngestState(layout);
    if (!state) {
      const reason =
        param === "incremental"
          ? "无上次 ingest 快照，无法计算增量，回落全量"
          : "距上次 ingest 不足 1 周，但无快照，回落全量";
      return {
        mode: "full",
        reason,
        needsAnnounce: true,
        files: all,
        removed: [],
        allRawFiles: all,
      };
    }
    const last = new Set(state.lastRawFiles);
    const added = all.filter((f) => !last.has(f));
    const removed = state.lastRawFiles.filter((f) => !all.includes(f));
    const auto = param === "";
    return {
      mode: "incremental",
      reason: auto
        ? `距上次 ingest（${state.lastRunAt.slice(0, 10)}）不足 1 周，走增量`
        : "用户指定增量",
      needsAnnounce: false,
      files: added,
      removed,
      allRawFiles: all,
    };
  }

  // 全量
  const auto = param === "";
  const last = lastIngestDate(layout);
  return {
    mode: "full",
    reason: auto
      ? last
        ? `距上次 ingest（${last}）超过 1 周，自动走全量`
        : "首次 ingest，走全量"
      : "用户指定全量",
    needsAnnounce: auto && last !== null, // 首次全量无需特别宣告，跑就是了
    files: all,
    removed: [],
    allRawFiles: all,
  };
}

/* ------------------------------------------------------------------ */
/* 提示词组装                                                          */
/* ------------------------------------------------------------------ */

/** 读编译流程模板（src/wiki/templates/ingest-prompt.md）。 */
export function loadIngestTemplate(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "templates", "ingest-prompt.md"), "utf8");
}

/**
 * 组装子代理任务描述。模板来自 src/wiki/templates/ingest-prompt.md，
 * 追加本次计划的具体信息（目录、文件清单、模式）。
 */
export function buildIngestPrompt(
  layout: WikiLayout,
  plan: IngestPlan,
  templateText: string,
): string {
  const fileList =
    plan.mode === "full"
      ? `全量模式：处理 raw/ 下全部 ${plan.files.length} 份文件：\n${plan.files.map((f) => `- ${f}`).join("\n") || "（raw/ 为空）"}`
      : `增量模式：新增 ${plan.files.length} 份：\n${plan.files.map((f) => `- ${f}`).join("\n") || "（无）"}\n\n删除 ${plan.removed.length} 份（在 wiki 页提及它们的处所加「> 已过时:」注记，不要删页）：\n${plan.removed.map((f) => `- ${f}`).join("\n") || "（无）"}`;

  return [
    templateText.trim(),
    "",
    "## 本次任务参数",
    "",
    `- 主题页目录：<pages> = ${layout.pagesDir}`,
    `- raw 目录：<raw> = ${layout.rawDir}`,
    `- outputs 目录：${join(layout.pagesDir, "..", "outputs")}`,
    "",
    fileList,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* 收尾                                                                */
/* ------------------------------------------------------------------ */

/**
 * ingest 成功收尾：更新状态快照。log 的 ingest 条目由命令层决定要不要登
 * （无变更的空跑不登 log，只刷状态）。
 */
export function finishIngest(layout: WikiLayout): void {
  writeIngestState(layout, listRawFiles(layout));
}
