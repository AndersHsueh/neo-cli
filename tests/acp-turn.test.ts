/**
 * ACP 一轮 prompt 的收口单测（issue #60 第三轮，Leo 复审 R9(a) / N2）。
 *
 * 不起进程、不走管道：注入一个假的 `send()`，直接断言 `runAcpTurn` 的
 * 「先排空通知、再落盘、再抛/返回」顺序，以及 server 侧把异常映射成 -32603。
 */
import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { TurnStats } from "../src/agent/types.ts";
import { acpPromptError, runAcpTurn, type AcpTurnDeps } from "../src/acp/turn.ts";

function stats(over: Partial<TurnStats> = {}): TurnStats {
  return {
    durationMs: 1,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
    iterations: 1,
    finishReason: "stop",
    aborted: false,
    hadError: false,
    errorMessage: null,
    emptyResponse: false,
    contextUsage: 0,
    tierSwitch: null,
    ...over,
  } as TurnStats;
}

function deps(order: string[], over: Partial<AcpTurnDeps> = {}): AcpTurnDeps {
  return {
    send: async () => {
      order.push("send");
      return stats();
    },
    flush: async () => {
      order.push("flush");
    },
    persist: () => {
      order.push("persist");
    },
    cancelled: () => false,
    maxToolIterations: 2,
    answeredLastIteration: () => true,
    ...over,
  };
}

describe("R9(a) agent.send 抛错", () => {
  test("R9(a) send 抛错时先排空通知并落盘再抛，server 映射为 -32603 而非 end_turn", async () => {
    const order: string[] = [];
    const d = deps(order, {
      send: async () => {
        order.push("send");
        throw new Error("引擎炸了");
      },
    });
    let caught: unknown = null;
    let stopReason: string | null = null;
    try {
      stopReason = await runAcpTurn("hi", d);
    } catch (e) {
      caught = e;
    }
    expect(stopReason).toBeNull();
    expect(caught).toBeInstanceOf(Error);
    expect(order).toEqual(["send", "flush", "persist"]);
    const rpc = acpPromptError(caught);
    expect(rpc.code).toBe(-32603);
    expect(`${rpc.message} ${JSON.stringify(rpc.data ?? null)}`).toContain("引擎炸了");
  });

  test("R9(a) 已是 RequestError 的异常原样透传", () => {
    const original = RequestError.invalidParams(undefined, "坏参数");
    expect(acpPromptError(original)).toBe(original);
  });

  test("R9(a) hadError 的一轮抛错而不是 end_turn", async () => {
    const order: string[] = [];
    const d = deps(order, { send: async () => stats({ hadError: true, errorMessage: "坏了" }) });
    await expect(runAcpTurn("hi", d)).rejects.toThrow("坏了");
    expect(order).toEqual(["flush", "persist"]);
  });
});

describe("N2 迭代上限判定（单测）", () => {
  test("N2 迭代用满但最后一轮已作答 → end_turn", async () => {
    const d = deps([], { send: async () => stats({ iterations: 2, toolCalls: 1 }), answeredLastIteration: () => true });
    expect(await runAcpTurn("hi", d)).toBe("end_turn");
  });

  test("N2 迭代用满且最后一轮仍在调工具 → max_turn_requests", async () => {
    const d = deps([], {
      send: async () => stats({ iterations: 2, toolCalls: 2, hadError: true, errorMessage: "没有最终回答" }),
      answeredLastIteration: () => false,
    });
    expect(await runAcpTurn("hi", d)).toBe("max_turn_requests");
  });
});
