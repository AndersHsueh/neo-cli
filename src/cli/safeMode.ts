/**
 * `--safe-mode` / `NEO_SAFE_MODE`：本次进程以干净配置启动，用于排查自定义项故障。
 *
 * 仍加载登录 / provider / 模型、内置工具与 `/mode` 权限模式；
 * 不加载项目记忆文件、路径规则、技能、自定义子代理、hooks、MCP、LSP、仓库地图、记忆 wiki 与 status line。
 * 只改内存中的 Config，不写、不改写 settings.json。这不是沙箱。
 */
import type { Config } from "../config.ts";
import { emptyHooksConfig } from "../hooks/types.ts";

/** 启动与 /hooks /mcp /skills /agents /context 共用的提示原文。 */
export const SAFE_MODE_NOTICE = "当前为干净配置，自定义项未加载";

export function isSafeModeEnvValue(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function isSafeModeEnabled(
  cliFlag = false,
  env: { [key: string]: string | undefined } = process.env,
): boolean {
  return Boolean(cliFlag) || isSafeModeEnvValue(env["NEO_SAFE_MODE"]);
}

/**
 * 在本次进程的 Config 上卸下自定义面。幂等；不碰磁盘。
 */
export function applySafeMode(cfg: Config): Config {
  cfg.safeMode = true;
  cfg.mcpServers = [];
  cfg.hooks = emptyHooksConfig();
  cfg.lsp = { ...cfg.lsp, enabled: false, servers: [] };
  cfg.lspWarnings = [];
  cfg.repoMap = { ...cfg.repoMap, enabled: false };
  cfg.memory = { ...cfg.memory, enabled: false };
  cfg.skillsExtraPaths = [];
  cfg.statusLine = null;
  cfg.statusLineWarnings = [];
  return cfg;
}
