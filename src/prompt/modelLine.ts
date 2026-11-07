import type { Config } from "../config.ts";

/** 系统提示词「## 环境」里的模型行；system-prompt 与 Agent.noteModelChange 共用，避免两处漂移。 */
export function formatModelLine(cfg: Pick<Config, "model" | "providerName" | "modelTier">): string {
  return `- 模型：${cfg.model}（provider ${cfg.providerName}，档位 ${cfg.modelTier}）`;
}
