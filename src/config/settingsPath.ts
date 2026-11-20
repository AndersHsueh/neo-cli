/**
 * settings.json 候选路径。
 *
 * 与 loadConfig 共用同一套顺序与「第一份存在的文件全赢」语义，
 * 避免向导与加载各写一份而漂移。本文件不改变搜索顺序。
 *
 * 候选：工作区 settings.json →（ACP 传 settingsDir 且与进程 cwd 不同时还
 * 有启动目录那份）→ 包装根 settings.json → ~/.neo/settings.json。
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface SettingsSearchOptions {
  settingsDir?: string;
}

/**
 * 包装根：本文件在 src/config/ 下，两级回到仓库根。
 * 与 src/config.ts 里 `dirname(import.meta.url) + ".."` 同义。
 */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 用户级默认配置路径：`$HOME/.neo/settings.json`（尊重 HOME / USERPROFILE）。 */
export function userSettingsPath(): string {
  return join(process.env["HOME"] || process.env["USERPROFILE"] || homedir(), ".neo", "settings.json");
}

/** loadConfig 的候选路径，顺序与语义不变。 */
export function settingsCandidates(options: SettingsSearchOptions = {}): string[] {
  const here = options.settingsDir ?? process.cwd();
  const spawnDir = process.cwd();
  return [
    join(here, "settings.json"),
    ...(options.settingsDir !== undefined && resolve(here) !== resolve(spawnDir)
      ? [join(spawnDir, "settings.json")]
      : []),
    join(packageRoot(), "settings.json"),
    userSettingsPath(),
  ];
}

/** 第一份存在的候选；都不存在则 null。 */
export function findSettingsPath(options: SettingsSearchOptions = {}): string | null {
  return settingsCandidates(options).find((p) => existsSync(p)) ?? null;
}
