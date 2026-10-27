/**
 * subagent（task 工具）测试。
 *
 * 覆盖：
 *  - decideSubTier：三层档位决策（声明 → 规则 → 沿用）与不可用档回落。
 *  - runSubagent：假 LLM 脚本化端到端 —— 主代理派 task，子代理读文件后交报告。
 *  - ask 模式下子代理写操作的审批委托（SilentConsole.confirm → 主 console）。
 *  - cfg 隔离：子代理切档不污染主代理配置。
 *
 * 注意：本文件刻意不调用 registerTool() —— 它会向全局工具表追加 task，
 * bun test 单进程共享模块表，会破坏 skills.test.ts / core.test.ts 的精确清单断言。
 * task 工具壳（makeTaskTool）很薄，端到端走 runSubagent + 独立 Agent 即可覆盖。
 *
 * 运行：bun test tests/subagent.test.ts
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Agent, type AgentIO } from "../src/agent.ts";
import { decideSubTier, runSubagent, makeTaskTool } from "../src/tools/task.ts";
import { TOOL_NAMES_EXCLUDED_FOR_SUBAGENT, registerTool } from "../src/tools/index.ts";
import { ToolError } from "../src/tools/types.ts";
import type { Config, ModelTier } from "../src/config.ts";
import { contentText, type Message, type StreamResult, type ToolCall } from "../src/llm.ts";

/* ------------------------------------------------------------------ */
/* 脚手架                                                              */
/* ------------------------------------------------------------------ */

const SANDBOX = join(tmpdir(), `neo-subagent-test-${Date.now()}`);
mkdirSync(SANDBOX, { recursive: true });
writeFileSync(join(SANDBOX, "a.txt"), "hello", "utf8");

function makeCfg(tier: ModelTier = "default"): Config {
  const provider = {
    name: "p1",
    type: "openai" as const,
    baseUrl: "http://localhost:0",
    apiKey: "k",
    models: {
      default: "m-default",
      deep_reasoning: "m-deep",
      balanced: "m-bal",
      fast: "m-fast",
    } as Record<ModelTier, string>,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
  };
  return {
    providerName: "p1",
    providerType: "openai",
    apiKey: "k",
    baseUrl: "http://localhost:0",
    modelTier: tier,
    model: `m-${tier}`,
    providers: [provider],
    routes: {
      default: { provider: "p1", model: null, fallbackAllowed: true },
      deep_reasoning: { provider: "p1", model: null, fallbackAllowed: true },
      balanced: { provider: "p1", model: null, fallbackAllowed: true },
      fast: { provider: "p1", model: null, fallbackAllowed: true },
    },
    classifierModel: "x",
    classifierProvider: "p1",
    legacyFormat: false,
    maxTokens: 100,
    temperature: 0.3,
    contextWindow: 100_000,
    globalDefaults: { maxTokens: 100, temperature: 0.3, contextWindow: 100_000 },
    compactThreshold: 0.8,
    maxToolIterations: 80,
    toolOutputLimit: 30_000,
    theme: "matrix",
    showReasoning: false,
    cwd: SANDBOX,
    settingsPath: null,
    skillsStore: join(SANDBOX, "skills"),
    memory: {
      enabled: false,
      userLevelDir: join(SANDBOX, "mem"),
      userWikiDir: join(SANDBOX, "wiki"),
      journalDir: join(SANDBOX, "journal"),
      autoRecall: { enabled: false, maxTokens: 900, projectPages: 2, userPages: 1 },
      autoCapture: {
        enabled: false,
        mode: "off" as const,
        modelTier: "fast",
        maxOpsPerTurn: 2,
        maxPagesPerSession: 8,
        minConfidence: 0.65,
        minInferredConfidence: 0.75,
        journalRetentionDays: 7,
        flushTimeoutMs: 3000,
      },
      quiet: true,
    },
  } as Config;
}

interface SpyConsole extends AgentIO {
  confirmCalls: string[];
  warnCalls: string[];
}

function spyConsole(over: Partial<AgentIO> = {}): SpyConsole {
  const confirmCalls: string[] = [];
  const warnCalls: string[] = [];
  const base: AgentIO = {
    line(): void {},
    blank(): void {},
    info(): void {},
    warn(msg: string): void {
      warnCalls.push(msg);
    },
    error(): void {},
    toolHeader(): void {},
    toolResult(): void {},
    indent(body: string, prefix = "│ "): string {
      return body
        .split("\n")
        .map((l) => prefix + l)
        .join("\n");
    },
    startSpinner(): void {},
    updateSpinner(): void {},
    stopSpinner(): void {},
    beginStream(): void {},
    writeStream(): void {},
    endStream(): void {},
    ensureStreamClosed(): void {},
    async confirm(question: string): Promise<boolean> {
      confirmCalls.push(question);
      return true;
    },
    width: 100,
  };
  return Object.assign(base, over, { confirmCalls, warnCalls }) as SpyConsole;
}

function tc(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${Math.random().toString(36).slice(2)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

interface FakeCall {
  model: string;
  tier: ModelTier;
  systemHead: string;
  msgCount: number;
}

/**
 * 脚本化假 chatStream。每个 step 严格校验自己被调用的场景：
 * step 收到的对话与预期不符时抛错 —— 排序错误会立刻变成测试失败，
 * 而不是被静默吞掉。
 */
function fakeStream(
  steps: Array<(cfg: Config, messages: Message[]) => Partial<StreamResult>>,
) {
  const calls: FakeCall[] = [];
  let i = 0;
  const fn = (cfg: Config, messages: Message[]): Promise<StreamResult> => {
    const sys = contentText(messages[0]?.content ?? "") ?? "";
    calls.push({
      model: cfg.model,
      tier: cfg.modelTier,
      systemHead: sys.slice(0, 20),
      msgCount: messages.length,
    });
    const step = steps[i];
    if (!step) throw new Error(`fake chatStream: 脚本耗尽（第 ${i + 1} 次调用）`);
    i++;
    return Promise.resolve({
      content: "",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      raw: null,
      ...step(cfg, messages),
    } as StreamResult);
  };
  return { calls, fn };
}

const isSub = (msgs: Message[]): boolean =>
  (contentText(msgs[0]?.content ?? "") ?? "").startsWith("你是主代理派生的子代理");

const taskCtx = { cfg: makeCfg(), approve: async () => true };

// ---- task 工具注册（带清理）----
// e2e 要走主代理的 dispatch → 注册表路径，所以必须真注册；
// registerTool 返回注销函数，afterAll 里摘掉，不污染其它测试文件。
let unregisterTask: (() => void) | null = null;
let currentMain: Agent | null = null;
unregisterTask = registerTool(
  makeTaskTool({
    run: (prompt, tier, ctx) => {
      if (!currentMain) throw new Error("currentMain 未设置");
      return runSubagent(currentMain, prompt, tier, ctx);
    },
  }),
);
afterAll(() => {
  unregisterTask?.();
  unregisterTask = null;
});

/* ------------------------------------------------------------------ */
/* decideSubTier：三层档位决策                                          */
/* ------------------------------------------------------------------ */

describe("task 档位决策", () => {  test("主代理声明的档位优先", () => {
    const cfg = makeCfg("default");
    expect(decideSubTier("随便什么任务", "fast", cfg)).toEqual({
      tier: "fast",
      source: "declared",
      reason: "主代理声明 fast",
    });
    expect(decideSubTier("随便什么任务", "deep_reasoning", cfg).tier).toBe("deep_reasoning");
  });

  test("inherit 显式沿用主代理档位", () => {
    const cfg = makeCfg("balanced");
    const d = decideSubTier("任务", "inherit", cfg);
    expect(d.tier).toBe("balanced");
    expect(d.source).toBe("inherit");
  });

  test("非法档位名抛 ToolError（而不是静默沿用）", () => {
    expect(() => decideSubTier("任务", "turbo", makeCfg())).toThrow(ToolError);
  });

  test("声明的档位不可用 → 沿用主代理档位，不报错", () => {
    const cfg = makeCfg("default");
    // fast 路由指向未接入的协议（anthropic）→ tierAvailable 为 false
    cfg.routes["fast"] = { provider: "ghost", model: null, fallbackAllowed: true };
    cfg.providers.push({
      name: "ghost",
      type: "anthropic",
      baseUrl: "x",
      apiKey: "k",
      models: cfg.providers[0]!.models,
      maxTokens: null,
      temperature: null,
      contextWindow: null,
    });
    const d = decideSubTier("任务", "fast", cfg);
    expect(d.tier).toBe("default");
    expect(d.source).toBe("inherit");
  });

  test("无声明：深度信号词 → deep_reasoning", () => {
    const d = decideSubTier("审查 src/agent.ts 的架构并评估重构方案", undefined, makeCfg());
    expect(d.tier).toBe("deep_reasoning");
    expect(d.source).toBe("rule");
  });

  test("无声明：机械信号词 → fast", () => {
    const d = decideSubTier("列出所有 .ts 文件并统计行数", undefined, makeCfg());
    expect(d.tier).toBe("fast");
    expect(d.source).toBe("rule");
  });

  test("深度信号优先于机械信号（任务描述常带动词，机械词误报率高）", () => {
    const d = decideSubTier("查找并排查内存泄漏的根因", undefined, makeCfg());
    expect(d.tier).toBe("deep_reasoning");
  });

  test("无信号命中 → 沿用主代理档位", () => {
    const d = decideSubTier("把这份文档读一遍", undefined, makeCfg("balanced"));
    expect(d.tier).toBe("balanced");
    expect(d.source).toBe("inherit");
  });
});

/* ------------------------------------------------------------------ */
/* runSubagent：端到端                                                  */
/* ------------------------------------------------------------------ */

describe("task 子代理端到端", () => {
  test("主代理派 task → 子代理读文件 → 报告回填主上下文，全程模型档位正确", async () => {
    const cfg = makeCfg("default");
    const mainConsole = spyConsole();
    const fake = fakeStream([
      // 第 1 次：主代理发起 task 调用（声明 fast —— 机械读任务）
      (_cfg, msgs) => {
        if (msgs[0]?.content !== "main") throw new Error("step1 应为主代理调用");
        return { content: "", toolCalls: [tc("task", { prompt: "读取 a.txt 并总结内容", tier: "fast" })] };
      },
      // 第 2 次：子代理决定读文件
      (_cfg, msgs) => {
        if (!isSub(msgs)) throw new Error("step2 应为子代理调用");
        return { content: "", toolCalls: [tc("read_file", { path: "a.txt" })] };
      },
      // 第 3 次：子代理交报告
      (_cfg, msgs) => {
        if (!isSub(msgs)) throw new Error("step3 应为子代理调用");
        return { content: "报告：a.txt 的内容是 hello", toolCalls: [] };
      },
      // 第 4 次：主代理基于报告收尾
      (_cfg, msgs) => {
        if (msgs[0]?.content !== "main") throw new Error("step4 应为主代理调用");
        return { content: "任务完成", toolCalls: [] };
      },
    ]);

    const main = new Agent({
      cfg,
      console: mainConsole,
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: fake.fn,
    });
    currentMain = main;

    const stats = await main.send("派个子代理去读 a.txt");

    // 子代理的两次调用用的是 fast 档模型；主代理两次用 default
    expect(fake.calls.length).toBe(4);
    expect(fake.calls[0]?.model).toBe("m-default");
    expect(fake.calls[1]?.model).toBe("m-fast");
    expect(fake.calls[2]?.model).toBe("m-fast");
    expect(fake.calls[3]?.model).toBe("m-default");

    // 主上下文里能看到报告与用量行
    const toolMsg = main.messages.find((m) => m.role === "tool" && m.name === "task");
    expect(toolMsg?.content).toContain("报告：a.txt 的内容是 hello");
    expect(toolMsg?.content).toContain("子代理用量");
    expect(toolMsg?.content).toContain("档位 fast → m-fast（declared）");
    expect(stats.toolCalls).toBe(1);

    // cfg 隔离：子代理切到 fast 不污染主代理
    expect(main.config.modelTier).toBe("default");
    expect(main.config.model).toBe("m-default");
  });

  test("ask 模式：子代理写操作经 SilentConsole 委托到主 console 审批", async () => {
    const cfg = makeCfg("default");
    const mainConsole = spyConsole();
    const fake = fakeStream([
      (_cfg, msgs) => {
        if (msgs[0]?.content !== "main") throw new Error("step1 应为主代理调用");
        return {
          content: "",
          toolCalls: [tc("task", { prompt: "把 ok 写入 b.txt", tier: "fast" })],
        };
      },
      (_cfg, msgs) => {
        if (!isSub(msgs)) throw new Error("step2 应为子代理调用");
        return { content: "", toolCalls: [tc("write_file", { path: "b.txt", content: "ok" })] };
      },
      (_cfg, msgs) => {
        if (!isSub(msgs)) throw new Error("step3 应为子代理调用");
        return { content: "报告：已写入 b.txt", toolCalls: [] };
      },
      (_cfg, msgs) => {
        if (msgs[0]?.content !== "main") throw new Error("step4 应为主代理调用");
        return { content: "完成", toolCalls: [] };
      },
    ]);

    const main = new Agent({
      cfg,
      console: mainConsole,
      mode: "ask", // 关键：写操作需要审批
      systemPrompt: "main",
      chatStream: fake.fn,
    });
    currentMain = main;

    await main.send("派子代理写 b.txt");

    // 审批框弹到了主 console（用户面前），而不是被子代理静默吞掉
    expect(mainConsole.confirmCalls.length).toBe(1);
    expect(mainConsole.confirmCalls[0]).toContain("write_file");
  });

  test("空 prompt 拒绝执行", async () => {
    const main = new Agent({
      cfg: makeCfg(),
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "main",
    });
    await expect(runSubagent(main, "   ", undefined, taskCtx)).rejects.toThrow(ToolError);
  });

  test("子代理未产出报告时返回说明而非空串", async () => {
    const cfg = makeCfg("default");
    const fake = fakeStream([
      // 直接调 runSubagent：第 1 次调用就是子代理（无主代理参与）
      (_cfg, msgs) => {
        if (!isSub(msgs)) throw new Error("step1 应为子代理调用");
        // 子代理只返回思维链没有正文（推理模型退化场景）
        return { content: "", reasoning: "想了想，没啥可说", toolCalls: [] };
      },
      (_cfg, msgs) => {
        if (!isSub(msgs)) throw new Error("step2 应为子代理调用");
        // 第 2 次调用应携带自动重试提示（system + user + nudge + 预算提示 = 4 条）
        if (msgs.length !== 4) throw new Error(`step2 应带重试提示，实际 ${msgs.length} 条`);
        return { content: "", reasoning: "还是没啥可说", toolCalls: [] };
      },
    ]);
    const main = new Agent({
      cfg,
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: fake.fn,
    });
    currentMain = main;
    const out = await runSubagent(main, "随便看看", undefined, taskCtx);
    expect(out).toContain("子代理未产出任何报告");
    expect(out).toContain("子代理用量");
  });
});

/* ------------------------------------------------------------------ */
/* 空正文自动重试（推理模型退化场景）                                     */
/* ------------------------------------------------------------------ */

describe("空正文自动重试", () => {
  test("首次空正文 → 自动重试一次 → 成功后提示被摘除", async () => {
    const cfg = makeCfg("default");
    const fake = fakeStream([
      (_cfg, msgs) => {
        if (isSub(msgs)) throw new Error("step1 应为主代理调用");
        return { content: "", reasoning: "只在思维链里想了", toolCalls: [] };
      },
      (_cfg, msgs) => {
        if (isSub(msgs)) throw new Error("step2 应为主代理调用");
        // system + user + 重试提示 + 本轮预算提示 = 4 条（预算提示请求前注入）
        if (msgs.length !== 4) throw new Error(`step2 应为 4 条消息，实际 ${msgs.length}`);
        const nudge = msgs[2]!;
        if (nudge.role !== "user" || !String(nudge.content).includes("正文")) {
          throw new Error("第 3 条应为重试提示");
        }
        return { content: "这是正文答案", toolCalls: [] };
      },
    ]);
    const main = new Agent({
      cfg,
      console: spyConsole(),
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: fake.fn,
    });
    currentMain = main;
    const stats = await main.send("你好");
    expect(stats.iterations).toBe(2);
    // 重试提示已摘除，历史干净：system + user + assistant
    expect(main.messages.length).toBe(3);
    expect(main.messages[2]!.role).toBe("assistant");
    expect(contentText(main.messages[2]!.content)).toContain("正文答案");
  });

  test("重试仍空正文 → 按错误收口（v0.4.1），历史不留空消息与提示", async () => {
    const cfg = makeCfg("default");
    const errors: string[] = [];
    const fake = fakeStream([
      () => ({ content: "", reasoning: "想了", toolCalls: [] }),
      () => ({ content: "", reasoning: "又想了", toolCalls: [] }),
    ]);
    const main = new Agent({
      cfg,
      console: spyConsole({ error: (m: string) => errors.push(m) }),
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: fake.fn,
    });
    currentMain = main;
    const stats = await main.send("你好");
    expect(stats.hadError).toBe(true);
    expect(stats.emptyResponse).toBe(true);
    expect(stats.errorMessage).toContain("连续两轮未产出正文");
    expect(errors.some((w) => w.includes("连续两轮"))).toBe(true);
    // 历史回到失败交换之前：system + user，无空 assistant、无重试提示
    expect(main.messages.length).toBe(2);
    expect(main.messages[1]!.role).toBe("user");
  });

  test("finishReason=length 时给出预算耗尽的针对性提示", async () => {
    const cfg = makeCfg("default");
    const infos: string[] = [];
    const fake = fakeStream([
      () => ({ content: "", reasoning: "思维链很长", toolCalls: [], finishReason: "length" }),
      () => ({ content: "补交的正文", toolCalls: [] }),
    ]);
    const main = new Agent({
      cfg,
      console: spyConsole({ info: (m: string) => infos.push(m) }),
      mode: "auto-all",
      systemPrompt: "main",
      chatStream: fake.fn,
    });
    currentMain = main;
    await main.send("你好");
    expect(infos.some((m) => m.includes("预算被思维链耗尽"))).toBe(true);
    // 重试成功，历史干净
    expect(main.messages.length).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* 工具壳与结构约束                                                     */
/* ------------------------------------------------------------------ */

describe("task 工具壳", () => {
  test("makeTaskTool 透传参数并触发 onProgress", async () => {
    const seen: Array<{ prompt: string; tier: string | undefined }> = [];
    let progress = "";
    const tool = makeTaskTool({
      run: async (prompt, tier) => {
        seen.push({ prompt, tier });
        return "ok";
      },
    });
    const out = await tool.execute(
      { prompt: "做点事", tier: "fast" },
      {
        cfg: makeCfg(),
        approve: async () => true,
        onProgress: (m) => {
          progress = m;
        },
      },
    );
    expect(out).toBe("ok");
    expect(seen[0]?.prompt).toBe("做点事");
    expect(seen[0]?.tier).toBe("fast");
    expect(progress).toContain("tier=fast");
  });

  test("tier 留空 → undefined（走自动判断）", async () => {
    const seen: Array<string | undefined> = [];
    const tool = makeTaskTool({
      run: async (_p, tier) => {
        seen.push(tier);
        return "ok";
      },
    });
    await tool.execute({ prompt: "做点事" }, { cfg: makeCfg(), approve: async () => true });
    expect(seen[0]).toBeUndefined();
  });

  test("task 不敏感：审批发生在子代理内部，不在这层", () => {
    const tool = makeTaskTool({ run: async () => "ok" });
    expect(tool.sensitive).toBe(false);
    expect(tool.spec.function.name).toBe("task");
  });

  test("子代理工具集排除表包含 task（结构性禁止递归）", () => {
    expect(TOOL_NAMES_EXCLUDED_FOR_SUBAGENT).toContain("task");
  });

  test("子代理工具集排除表包含 compact_ctx（宿主闭包绑定主代理）", () => {
    expect(TOOL_NAMES_EXCLUDED_FOR_SUBAGENT).toContain("compact_ctx");
  });
});
