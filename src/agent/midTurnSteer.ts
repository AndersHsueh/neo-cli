/**
 * #66 运行中转向（Agent 侧）：在安全切点把真人排队的转向写进当前轮。
 *
 * 切点与顺序由 sendTurn 决定（pollInbox → pollBackground → 这里，且只在本轮已有工具批次之后）；
 * 本模块只做「一个切点取走全部条目 → 每条各跑一次 UPS → 按原序各追加一条 user」。
 * 不打断进行中的工具、不碰已回填的结果，也不另发请求：调用方照常发下一次请求，模型就能看到。
 */
import type { Message } from "../llm.ts";
import { reportLifecycle, runSteerPromptSubmit } from "./lifecycle.ts";
import type { Agent } from "./loop.ts";
import type { SteerItem } from "./types.ts";

function userMessage(item: SteerItem): Message {
  if (item.images.length === 0) return { role: "user", content: item.text };
  return {
    role: "user",
    content: [
      { type: "text", text: item.text },
      ...item.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ],
  };
}

/**
 * 返回本切点实际写入历史的转向条数（> 0 时调用方关掉本轮回滚，见合同第 11 条）。
 *
 * - UPS 阻断：该条不写入、`block()` 让它留在宿主队列等轮末，原因可见；其余条目照常处理。
 * - 取消（含 UPS 跑到一半时取消）：立即停手，未写入的条目全部留在队列。
 * - `claim()` 失败（已被 ↑ 收回）：跳过，不重复注入。
 */
export async function injectSteers(agent: Agent, signal: AbortSignal): Promise<number> {
  const poll = agent.opt.pollSteer;
  if (!poll || signal.aborted) return 0;
  let items: SteerItem[];
  try {
    items = await poll();
  } catch (e) {
    // 转向是增强项：取条目失败不得击穿主循环，条目仍在队列、轮末照常 drain。
    agent.opt.console.warn(`运行中转向读取失败：${(e as Error).message}`);
    return 0;
  }
  let injected = 0;
  for (const item of items) {
    if (signal.aborted) break;
    const ups = await runSteerPromptSubmit.call(agent, item.text);
    if (signal.aborted) break;
    if (ups.blocked) {
      reportLifecycle(agent, `UserPromptSubmit hook 阻断了运行中转向（已留在队列，轮末作为新一轮）：${ups.reason}`);
      item.block(ups.reason);
      continue;
    }
    if (!item.claim()) continue;
    agent.messages.push(userMessage(item));
    injected++;
  }
  return injected;
}
