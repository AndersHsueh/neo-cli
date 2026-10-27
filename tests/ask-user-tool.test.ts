/**
 * v0.4.1 B2：ask_user 工具契约与边界。
 */
import { describe, expect, test } from "bun:test";

import { makeAskUserTool } from "../src/tools/askUser.ts";
import type { AskUserRequest } from "../src/ui/askUser.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import type { ToolCtx } from "../src/tools/types.ts";
import type { Config } from "../src/config.ts";

function ctx(over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    cfg: {} as Config,
    approve: async () => true,
    askUser: async () => ({ status: "canceled" }),
    ...over,
  };
}

const base = {
  question: "选哪个方案？",
  options: [{ label: "A" }, { label: "B" }],
};

describe("ask_user 工具", () => {
  test("正常回答：返回 JSON（selected/custom）", async () => {
    const tool = makeAskUserTool({
      ask: async () => ({ status: "answered", selected: ["B"], custom: null }),
    });
    const out = await tool.execute(base, ctx());
    expect(JSON.parse(out)).toEqual({ status: "answered", selected: ["B"], custom: null });
  });

  test("取消：返回 canceled", async () => {
    const tool = makeAskUserTool({ ask: async () => ({ status: "canceled" }) });
    expect(JSON.parse(await tool.execute(base, ctx()))).toEqual({ status: "canceled" });
  });

  test("无 host（非交互）：明确报错", async () => {
    const tool = makeAskUserTool({ ask: async () => ({ status: "canceled" }) });
    await expect(tool.execute(base, ctx({ askUser: undefined }))).rejects.toThrow("无法向用户提问");
  });

  test("参数校验：question/header/options/label 重复/allow_custom", async () => {
    const tool = makeAskUserTool({ ask: async () => ({ status: "canceled" }) });
    await expect(tool.execute({ question: "" }, ctx({ askUser: async () => ({ status: "canceled" }) }))).rejects.toThrow(
      "question 长度",
    );
    await expect(
      tool.execute({ question: "x".repeat(201) }, ctx({ askUser: async () => ({ status: "canceled" }) })),
    ).rejects.toThrow("question 长度");
    await expect(
      tool.execute({ question: "问题", header: "x".repeat(13) }, ctx({ askUser: async () => ({ status: "canceled" }) })),
    ).rejects.toThrow("header");
    await expect(
      tool.execute(
        { question: "问题", options: Array.from({ length: 6 }, (_, i) => ({ label: `L${i}` })) },
        ctx({ askUser: async () => ({ status: "canceled" }) }),
      ),
    ).rejects.toThrow("最多 5 个");
    await expect(
      tool.execute(
        { question: "问题", options: [{ label: "A" }, { label: "A" }] },
        ctx({ askUser: async () => ({ status: "canceled" }) }),
      ),
    ).rejects.toThrow("重复");
    await expect(
      tool.execute(
        { question: "问题", options: [], allow_custom: false },
        ctx({ askUser: async () => ({ status: "canceled" }) }),
      ),
    ).rejects.toThrow("没有可回答的入口");
  });

  test("多选但无选项：报错", async () => {
    const tool = makeAskUserTool({ ask: async () => ({ status: "canceled" }) });
    await expect(
      tool.execute({ question: "问题", multi_select: true }, ctx({ askUser: async () => ({ status: "canceled" }) })),
    ).rejects.toThrow("options 不能为空");
  });

  test("abort：关闭模态并返回 canceled", async () => {
    const ctrl = new AbortController();
    let cancelCalled = 0;
    let seen: AskUserRequest | null = null;
    const tool = makeAskUserTool({
      ask: (req) => {
        seen = req;
        return new Promise((resolve) => {
          ctrl.signal.addEventListener("abort", () => resolve({ status: "canceled" }), { once: true });
        });
      },
    });
    const p = tool.execute(
      { question: "问题", options: [{ label: "A" }] },
      ctx({
        signal: ctrl.signal,
        askUser: async () => ({ status: "canceled" }),
        cancelAskUser: () => {
          cancelCalled += 1;
        },
      }),
    );
    // 让 askUser 注册 abort listener 后再触发
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    const out = JSON.parse(await p);
    expect(out.status).toBe("canceled");
    expect(seen).not.toBeNull();
    expect(cancelCalled).toBe(1);
  });

  test("提示词：非交互模式不教模型调用 ask_user（B4）", () => {
    const cfg = { cwd: "/tmp", model: "m", providerName: "p", modelTier: "balanced", toolOutputLimit: 30_000 } as unknown as Config;
    const on = buildSystemPrompt(cfg, { askUser: true });
    const off = buildSystemPrompt(cfg, { askUser: false });
    expect(on).toContain("ask_user");
    expect(off).not.toContain("ask_user");
  });

  test("schema：name / required / 参数描述", () => {
    const tool = makeAskUserTool({ ask: async () => ({ status: "canceled" }) });
    expect(tool.spec.function.name).toBe("ask_user");
    expect(tool.spec.function.parameters["required"]).toEqual(["question"]);
    expect(tool.sensitive).toBe(false);
  });
});
