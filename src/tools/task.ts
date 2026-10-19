/**
 * task 工具：派生一个子代理，在隔离上下文中完成自包含任务，返回最终报告。
 *
 * 设计要点（详见会话讨论）：
 *  - 子代理 = new Agent(...)，复用主循环的全部机制（预算提示 / 自动 compact / abort）。
 *  - 上下文彻底隔离：专用 system prompt，messages 从零开始；工具集裁掉 task 自身，
 *    结构性禁止递归派生（深度 ≤ 1，无运行时计数）。
 *  - 输出静音：子代理的流式渲染不进终端；但 confirm/warn 委托主 console，
 *    否则 ask 模式下子代理的写操作会被静默拒绝，模型只会看到「用户拒绝了」。
 *  - 档位决策三层：主代理在参数里声明（首选，它对任务性质判断最准）→
 *    规则兜底（零成本确定性）→ 沿用主代理当前档位。
 *    刻意不用 LLM 分类器：为派个任务多一次 LLM 往返不值。
 *  - cfg 浅拷贝：applyTier 是原地改写 cfg（config.ts），共享引用会让主代理
 *    下一轮的档位切换污染正在运行的子代理。
 */
import { Agent, type AgentIO } from "../agent.ts";
import { contentText } from "../llm.ts";
import { applyTier, tierAvailable, type Config, type ModelTier } from "../config.ts";
import { TIER_ORDER } from "../classifier/types.ts";
import { ToolError, type ToolCtx, type ToolImpl } from "./types.ts";

/** 子代理迭代上限。子代理是单一任务，跑满主代理的 80 次迭代意味着早已跑偏。 */
const SUB_MAX_ITERATIONS = 24;

function subSystemPrompt(prompt: string): string {
  return [
    "你是主代理派生的子代理，独立完成一项自包含任务。",
    "你没有与用户的对话历史，任务描述包含你需要的全部信息。",
    "不要向用户提问；无法完成时，说明缺什么，然后结束。",
    "",
    "## 报告格式（这是你返回给主代理的全部内容）",
    "1. 结论（一句话先行）",
    "2. 关键发现/改动，附 文件:行号 引用",
    "3. 未解决或存疑的点",
    "",
    "## 任务",
    prompt,
  ].join("\n");
}

/**
 * 子代理的静音输出层。
 *
 * 输出方法全部 no-op；confirm 与 warn 委托主 console：
 *  - confirm：ask 模式下子代理的敏感操作要能正常弹审批框；
 *  - warn：plan 模式的拒绝提示、分类器告警等必须让用户看见。
 * 其余信息性输出（info/error）静音 —— 它们属于「过程」，报告才是「结果」。
 */
class SilentConsole implements AgentIO {
  line(): void {}
  blank(): void {}
  info(): void {}
  warn(msg: string): void {
    this.main.warn(msg);
  }
  error(): void {}
  toolHeader(): void {}
  toolResult(): void {}
  indent(body: string, prefix = "│ "): string {
    return body
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
  }
  startSpinner(): void {}
  updateSpinner(): void {}
  stopSpinner(): void {}
  beginStream(): void {}
  writeStream(): void {}
  endStream(): void {}
  ensureStreamClosed(): void {}
  confirm(question: string): Promise<boolean> {
    return this.main.confirm(question);
  }
  get width(): number {
    return this.main.width;
  }
  constructor(private readonly main: AgentIO) {}
}

/* ------------------------------------------------------------------ */
/* 档位决策                                                            */
/* ------------------------------------------------------------------ */

/**
 * 深度推理信号词。与 rules.ts 的 DEEP_STRONG/DEEP_WEAK 同源，
 * 按子代理语义合并 —— 子代理任务由主代理起草，措辞常带动词性描述，
 * 「review/审查/评估/对比」这类弱信号在任务描述里出现时基本是真需求。
 */
const DEEP_WORDS = [
  "架构", "设计", "重构", "根因", "排查", "权衡", "迁移", "选型",
  "design", "architecture", "refactor", "trade-off", "tradeoff",
  "review", "审查", "评估", "对比",
];

/**
 * 机械操作信号词。与 rules.ts 的 FAST_SIGNALS 同源（节选高频项）。
 * 注意顺序：decideSubTier 里深度信号优先于机械信号 ——
 * 主代理起草的任务描述几乎必然带「找/查/列」这类动词，
 * 机械信号的误报率天然偏高，所以先判深度。
 */
const FAST_WORDS = [
  "列一下", "列下", "读一下", "读下", "看一下", "看下", "统计",
  "有多少", "几个", "grep", "找一下", "查一下", "找所有", "列出所有",
  "改个名", "重命名", "格式", "大小", "搜索",
];

interface TierDecision {
  tier: ModelTier;
  source: "declared" | "rule" | "inherit";
  reason: string;
}

function hitWords(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

/**
 * 子代理档位决策。
 *
 * 返回 source: "inherit" 表示沿用主代理当前档位 —— 三种情况：
 *  1. 主代理显式传了 tier: "inherit"；
 *  2. 声明的档位在当前路由下不可用（tierAvailable 为 false）；
 *  3. 未声明且无信号词命中。
 * 此时静默沿用而非报错：子代理是优化层，不能因档位配置问题拖垮任务。
 */
export function decideSubTier(
  prompt: string,
  declared: string | undefined,
  cfg: Config,
): TierDecision {
  const current = cfg.modelTier;
  const available = (t: ModelTier) => tierAvailable(cfg, t);

  // 第一层：主代理声明。它刚写完任务描述，对任务性质判断上下文最完整。
  if (declared && declared !== "inherit") {
    const t = declared as ModelTier;
    if (TIER_ORDER.includes(t)) {
      if (available(t)) {
        return { tier: t, source: "declared", reason: `主代理声明 ${t}` };
      }
      return { tier: current, source: "inherit", reason: `声明的 ${t} 不可用，沿用主代理档位` };
    }
    throw new ToolError(
      `无效的 tier "${declared}"。可用值：fast, balanced, default, deep_reasoning, inherit`,
    );
  }

  // 第二层：规则兜底。深度信号优先于机械信号（理由见 FAST_WORDS 注释）。
  // 目标档不可用时直接沿用，不向上找 —— 子代理任务短，升档收益有限，
  // 而误升到付费档是实打实的成本。
  if (hitWords(prompt, DEEP_WORDS) && available("deep_reasoning")) {
    return { tier: "deep_reasoning", source: "rule", reason: "任务含深度推理信号词" };
  }
  if (hitWords(prompt, FAST_WORDS) && available("fast")) {
    return { tier: "fast", source: "rule", reason: "任务为机械读写操作" };
  }

  return { tier: current, source: "inherit", reason: "无信号命中，沿用主代理档位" };
}

/** 供测试与 /why 展示：档位决策的可读描述。 */
export function describeTierDecision(d: TierDecision): string {
  return `[task] 子代理档位 ${d.tier}（${d.source}）：${d.reason}`;
}

/* ------------------------------------------------------------------ */
/* 子代理运行                                                          */
/* ------------------------------------------------------------------ */

/**
 * 运行一个子代理任务，返回最终报告文本。
 * 由组合根注入主代理引用后装配成 task 工具。
 */
export async function runSubagent(
  main: Agent,
  prompt: string,
  declaredTier: string | undefined,
  ctx: ToolCtx,
): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new ToolError("prompt 不能为空 —— 子代理没有主代理的上下文，空任务无法执行");
  }

  const cfg = main.config;
  const decision = decideSubTier(trimmed, declaredTier, cfg);

  // 浅拷贝：applyTier 原地改写 cfg 顶层标量，共享引用会互相污染。
  const subCfg: Config = {
    ...cfg,
    modelTier: decision.tier,
    maxToolIterations: Math.min(SUB_MAX_ITERATIONS, cfg.maxToolIterations),
  };
  const applied = applyTier(subCfg, decision.tier);
  if (!applied.ok) {
    // 决策时 tierAvailable 已通过，到这里失败属于配置在运行间隙被改动 —— 如实上报。
    throw new ToolError(`子代理档位应用失败：${applied.error}`);
  }

  const sub = new Agent({
    cfg: subCfg,
    console: new SilentConsole(main.io),
    mode: main.mode,
    systemPrompt: subSystemPrompt(trimmed),
    chatStream: main.injectedStreamFn,
    // 不传 classifier：子代理任务短，内部切档收益趋近于零，
    // 且分类器依赖连续失败计数等主循环状态，子代理里没有意义。
  });

  // abort 链路：父任务被 Ctrl+C 打断时，子代理一并取消。
  const onAbort = () => sub.cancel();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const stats = await sub.send(trimmed);

    // 报告 = 子代理最后一条非空 assistant 正文。
    // 中间轮次的 assistant 消息要么带 tool_calls（内容是给工具的旁白），
    // 要么是空正文 —— 都不该混进报告。
    const body = sub.messages
      .filter((m) => m.role === "assistant" && (contentText(m.content) ?? "").trim() !== "" && !m.tool_calls)
      .map((m) => contentText(m.content) ?? "")
      .pop();
    const report = (body ?? "").trim();
    const usage =
      `— 子代理用量: prompt ${stats.promptTokens} / completion ${stats.completionTokens} tokens, ` +
      `${stats.iterations} 轮, 档位 ${subCfg.modelTier} → ${subCfg.model}（${decision.source}）`;

    if (!report) {
      return `子代理未产出任何报告（finishReason=${stats.finishReason ?? "unknown"}）。${usage}`;
    }
    return `${report}\n\n${usage}`;
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * task 工具定义。deps.run 由组合根注入，避免本模块直接依赖主代理实例。
 */
export function makeTaskTool(deps: {
  run: (prompt: string, tier: string | undefined, ctx: ToolCtx) => Promise<string>;
}): ToolImpl {
  return {
    // 敏感性取决于子代理内部做了什么，task 调用本身不敏感：
    // ask 模式下子代理的写操作会在子代理内部弹审批（confirm 委托主 console），
    // 若这里也标 sensitive，用户要为同一次写操作点两次批准。
    sensitive: false,
    spec: {
      type: "function",
      function: {
        name: "task",
        description:
          "派生一个子代理，在独立上下文中完成一项自包含任务，只把最终报告返回给你。" +
          "适合：大范围代码探索、批量机械读写、跑测试并汇总结果 —— 子代理烧掉的上下文不占用你的窗口。" +
          "任务描述必须自包含：子代理看不到与用户的对话历史。" +
          "tier 参数决定子代理用哪档模型（档位名，实际模型由该档位的路由配置解析）：机械读写用 fast 档（廉价模型）省钱，" +
          "深度推理用 deep_reasoning 档（强推理模型），不确定就留空（自动按任务措辞判断，无信号则沿用当前档位）。",
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "自包含的任务描述。包含子代理需要的全部背景、目标与验收标准",
            },
            tier: {
              type: "string",
              enum: ["fast", "balanced", "default", "deep_reasoning", "inherit"],
              description: "子代理模型档位。机械读写任务选 fast，深度推理选 deep_reasoning；留空自动判断",
            },
          },
          required: ["prompt"],
        },
      },
    },
    async execute(args, ctx) {
      const prompt = String(args["prompt"] ?? "");
      const tierRaw = args["tier"];
      const tier = typeof tierRaw === "string" && tierRaw.trim() !== "" ? tierRaw.trim() : undefined;
      const label = tier ? `tier=${tier}` : "tier=auto";
      ctx.onProgress?.(`子代理运行中（${label}）…`);
      return deps.run(prompt, tier, ctx);
    },
  };
}
