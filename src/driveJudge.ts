/**
 * 完成条件判定器（issue #50 抽出，issue #51 复用）。
 *
 * 交互 `/drive` 与 `-p --drive` 必须用**同一份**提示词与解析逻辑 ——
 * 复制第二份会让两条路径的判定口径悄悄分叉（PRD §3 明令禁止）。
 *
 * 这里只放「怎么问、怎么解析」；用哪个 stream / 要不要记账由调用方注入。
 */
import type { Config } from "./config.ts";
import type { JudgeInput, JudgeResult } from "./drive.ts";
import type { StreamResult } from "./llm.ts";

export interface JudgeDeps {
  /** 当前配置（取 contextWindow 与模型）。 */
  cfg: Config;
  /** 流式函数（交互用 agent.injectedStreamFn ?? chatStream；-p 同）。 */
  stream: (
    cfg: Config,
    messages: Array<{ role: string; content: string }>,
    tools: unknown[],
    opts: Record<string, unknown>,
  ) => Promise<StreamResult>;
  /** 记账回调（issue #50：judge 是独立小请求，不经过主循环，必须显式回报 usage）。 */
  recordUsage?: (usage: NonNullable<StreamResult["usage"]>) => void;
}

/**
 * 造一个 `DriveDeps.evaluate` 实现。
 *
 * 判定纪律（PRD §2.3）：只根据给出的工具输出判断，不臆测；不确定判 false；
 * 输出必须是 `{"done": boolean, "reason": string}`，解析不出来按 `invalid` 处理
 * （`DriveManager` 会把它当未达成并累加失败计数，绝不因此宣布完成）。
 */
export function makeDriveJudge(deps: JudgeDeps): (input: JudgeInput) => Promise<JudgeResult> {
  return async (input) => {
    const budget = Math.min(2_000, Math.floor(deps.cfg.contextWindow * 0.05));
    const checkLine = input.lastCheck
      ? `检查命令结果：exit ${input.lastCheck.code ?? "?"}（未通过）\n输出尾部：${input.lastCheck.output.slice(-600)}`
      : "没有配置检查命令。";
    const res = await deps.stream(
      { ...deps.cfg, maxTokens: budget, temperature: 0 },
      [
        {
          role: "system",
          content:
            "你是完成条件判定器。只根据给出的工具输出判断目标是否达成。" +
            "不要臆测没有出现在输出里的结果；不确定就判 false。" +
            '只输出一行 JSON：{"done": true|false, "reason": "一句话理由"}。',
        },
        {
          role: "user",
          content:
            `【目标提示】\n${input.prompt}\n\n` +
            `【完成标准】\n${input.criteria}\n\n` +
            `【${checkLine}】\n\n` +
            `【最近一轮工具输出（可能已截断）】\n${input.recentOutput || "（无）"}`,
        },
      ],
      [],
      {},
    );
    if (res.usage) deps.recordUsage?.(res.usage);
    const text = res.content.trim();
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!json) return { done: false, invalid: true };
    try {
      const parsed = JSON.parse(json) as { done?: unknown; reason?: unknown };
      if (typeof parsed.done !== "boolean") return { done: false, invalid: true };
      return {
        done: parsed.done,
        ...(typeof parsed.reason === "string" && parsed.reason.trim() !== ""
          ? { reason: parsed.reason.trim() }
          : {}),
      };
    } catch {
      return { done: false, invalid: true };
    }
  };
}
