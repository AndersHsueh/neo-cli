/**
 * 轮次内的方向提示：工具预算 + 目标锚 + 手段计数。
 *
 * 纯函数。循环每轮请求前调用一次，请求后把返回的消息摘掉。
 * 计数不拦截工具，只让模型看见「离目标多远」。
 */
import type { Message } from "../llm.ts";

/**
 * 连续 capability 调用阈值（2026-10-26）。
 *
 * 取 4 而不是 2/3：正常排查里连续两次 shell 很常见（`ls` 再看 `cat`），
 * 阈值太低会把正常工作流误判成漂移，提示变成噪音、被模型学会忽略。
 * 4 次连续只扩展手段而无事实产出，已经不像在查东西，更像在开通道。
 */
export const CAPABILITY_STREAK_LIMIT = 4;

export function readGoalSafe(readGoal: (() => string | null) | undefined): string | null {
  try {
    const g = readGoal?.() ?? null;
    return g && g.trim() ? g : null;
  } catch {
    return null;
  }
}

/**
 * 构造本轮预算 + 目标提示。
 *
 * 每次请求前注入、请求后移除，模型因此始终知道「这是第几次、还剩几次」。
 * 剩余 ≤ 5 时额外给出明确次数并要求收敛 —— 只写「即将耗尽」模型无法判断
 * 还能做几件事，往往会继续探索，最后被硬截断，用户拿到半截答案。
 *
 * 2026-10-26 追加目标锚：只报消耗量不够。跑偏的会话每步都有进展
 * （DNS 解析成功、拿到 IP 都是真的），心跳满格方向全错。把原始目标
 * 每轮摆在这里，是给模型一个「离目标多远」的信号，而不只是「还剩几步」。
 * 目标由用户/宿主写入，模型只读 —— 提示里明确写出这一点，防止它自行重述。
 */
export function budgetMessage(
  attempt: number,
  max: number,
  goal: string | null,
  capabilityStreak: number,
): Message {
  // attempt 是「第几次请求」（调用方传 iter + 1，iter 从 0 起），本次请求本身还没消耗预算：
  // 已消耗 = attempt - 1，剩余 = max - (attempt - 1)。旧实现写 max - attempt，
  // 首轮就报「剩余 79/80」、末轮报「仅剩 0 次」却其实还剩最后一次 —— 模型据此提前收手。
  const remaining = Math.max(0, max - attempt + 1);
  let text =
    `本轮工具调用：第 ${attempt} 次 / 上限 ${max}（已用 ${attempt - 1}，剩余 ${remaining}）。`;
  if (goal) {
    text +=
      `\n原始目标（用户设定，你不可修改）：${goal}` +
      `\n每次调用工具前自问：这一步是在产出关于目标的事实，还是只在扩展手段？` +
      `若连续多次只扩展手段而无新事实，停下来回到目标本身。`;
    // 手段/目标分层计数（2026-10-26）：把偏离做成可见数字。
    // 只在设了目标时显示 —— 没有目标就没有「离目标多远」可言。
    if (capabilityStreak > 0) {
      text += `\n距上次产出事实，已连续 ${capabilityStreak} 次只扩展手段（shell/发消息/派子代理/加载技能）。`;
      if (capabilityStreak >= CAPABILITY_STREAK_LIMIT) {
        text +=
          `\n**已超过 ${CAPABILITY_STREAK_LIMIT} 次阈值**：你正在把手段当成目标。` +
          `立刻停止扩展能力，回到原始目标：现在手上已有的事实够回答吗？` +
          `够就直接答；不够就说明缺什么，不要再去开新通道。`;
      }
    }
  }
  if (remaining <= 5) {
    text +=
      `\n预算即将耗尽，仅剩 ${remaining} 次工具调用机会。` +
      `请停止继续探索，立即基于已有信息给出最终答案；` +
      `信息不足就在答案中明确说明缺什么，不要再用工具。`;
  }
  return { role: "system", content: text };
}
