/**
 * Agent 循环：user → LLM → tool_calls → 执行 → 回填 → LLM → …
 *
 * 上下文控制：
 *  - 每轮前估算 token，超阈值触发压缩（把旧消息总结成一条摘要）。
 *  - reasoning_content 不入历史，避免思维链污染后续轮次。
 *
 * 本文件只负责循环。类型在 types.ts，预算提示在 steer.ts，权限判定在 policy.ts，
 * 压缩切分在 compact.ts。新增一种宿主能力走 AgentOptions 回调，不要把具体模块 import 进来。
 */
import { chatStream, estimateTokens, contentText, LLMError, type Message, type ToolSpec } from "../llm.ts";
import type { Classifier } from "../classifier/index.ts";
import { applyTier, type Config } from "../config.ts";
import { StreamFormatter } from "../ui/stream.ts";
import { renderMarkdown } from "../ui/render.ts";
import { c, colorEnabled } from "../ui/theme.ts";
import { dispatch, toolSpecs, toolKindOf, TOOL_NAMES_EXCLUDED_FOR_SUBAGENT } from "../tools/index.ts";
import { ToolError, type ToolCtx } from "../tools/types.ts";
import { appendTurnLog } from "../turnDiagnostics.ts";
import { isContextOverflowError, parseContextLimitFromError } from "../contextWindow.ts";
import { applyCompaction, planCompaction } from "./compact.ts";
import { decidePermission } from "./policy.ts";
import { previewArgs } from "./render.ts";
import { budgetMessage as buildBudgetMessage, readGoalSafe } from "./steer.ts";
import type { AgentIO, AgentOptions, PermissionMode, TurnStats } from "./types.ts";

export type { AgentEvent, AgentIO, AgentOptions, PermissionMode, TurnStats } from "./types.ts";
export { renderFinal } from "./render.ts";

export class Agent {
  messages: Message[] = [];
  mode: PermissionMode;
  /** 连续工具失败计数。分类器用它判断当前档位是否撑不住。 */
  private consecutiveFailures = 0;
  /**
   * 距上次产出事实的 capability 调用数（2026-10-26）。
   *
   * 只数 capability（shell / send_message / task / use_skill），evidence 一出现就清零。
   * 这是「手段是否已升格成目标」的**唯一可数信号**：跑偏的会话每一步都有真实进展，
   * 心跳满格方向全错，只有「连续几次没产出关于目标的事实」能把它抓出来。
   *
   * 注意：计数本身不拦人，只喂给 budgetMessage 让模型看见。后台默默计数、
   * 到阈值才提示，等于模型全程无感 —— 那和 isStuck 没区别，只是换了判据。
   */
  private capabilityStreak = 0;
  /**
   * compact_ctx 工具登记的压缩请求。
   * 工具执行点不是安全切点（assistant(tool_calls) 与 tool 结果尚未配对完），
   * 只能置标记，等工具循环收口后由 runCompactIfRequested() 统一执行。
   */
  private compactRequested = false;
  private abort: AbortController | null = null;
  private totalPrompt = 0;
  private totalCompletion = 0;
  private totalReasoning = 0;
  private lastStats: TurnStats | null = null;
  /** 轮次序号：记忆捕获的审计键（会话内递增，不跨会话）。 */
  private turnSeq = 0;
  /** 诊断日志的轮次计数（v0.4.1 A1；与记忆 turnSeq 解耦）。 */
  private turnCounter = 0;
  /** 最近一次压缩的前后 tokens（只用于本轮诊断日志）。 */
  private lastCompact: { beforeTokens: number; afterTokens: number } | null = null;

  constructor(private readonly opt: AgentOptions) {
    this.mode = opt.mode;
    this.messages = [{ role: "system", content: opt.systemPrompt }];
  }

  /** LLM 流式函数：注入优先，缺省真实实现。 */
  private get streamFn(): typeof chatStream {
    return this.opt.chatStream ?? chatStream;
  }

  get classifier(): Classifier | undefined {
    return this.opt.classifier;
  }

  /** 当前生效配置。子代理（task 工具）据此派生浅拷贝，避免共享可变状态。 */
  get config(): Config {
    return this.opt.cfg;
  }

  /** 测试注入的流式函数（若有）。子代理透传同一注入点，保证测试可脚本化。 */
  get injectedStreamFn(): typeof chatStream | undefined {
    return this.opt.chatStream;
  }

  /** 输出层。子代理的静音实现把 confirm/warn 委托到这里。 */
  get io(): AgentIO {
    return this.opt.console;
  }

  get stats(): TurnStats | null {
    return this.lastStats;
  }

  get toolFailureStreak(): number {
    return this.consecutiveFailures;
  }

  get cumulative(): { prompt: number; completion: number; reasoning: number } {
    return { prompt: this.totalPrompt, completion: this.totalCompletion, reasoning: this.totalReasoning };
  }

  get historyLength(): number {
    // 不含 system
    return Math.max(0, this.messages.length - 1);
  }

  /** 最近一次压缩的前后 token（/context 展示用）。 */
  get lastCompactionInfo(): { beforeTokens: number; afterTokens: number } | null {
    return this.lastCompact;
  }

  /**
   * 本代理可用的工具集。
   *
   * 只有子代理（task 工具，isSubagent=true）才应用排除表：
   * task 结构性禁止递归派生；compact_ctx / remember / send_message / list_peers
   * 绑定主代理宿主的闭包或信箱身份，子代理调用会产生归属混乱。
   * 主代理必须拿到全量工具 —— v0.2.0 曾把排除表误用于主代理，导致运行时
   * 注册的工具（task/wiki/remember/send_message/list_peers）从未出现在模型工具清单里。
   */
  toolSpecsFor(): ToolSpec[] {
    const all = toolSpecs();
    if (!this.opt.isSubagent) return all;
    return all.filter((s) => !TOOL_NAMES_EXCLUDED_FOR_SUBAGENT.includes(s.function.name));
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** compact_ctx 工具经 ctx.host 调用：只登记，不执行。 */
  requestCompact(): void {
    this.compactRequested = true;
  }

  /**
   * 消费压缩标记。在安全切点调用（工具循环收口、下一轮请求之前）。
   * 返回压缩结果；未登记过请求时返回 null。
   */
  private async runCompactIfRequested(): Promise<{ beforeTokens: number; afterTokens: number } | null> {
    if (!this.compactRequested) return null;
    this.compactRequested = false;
    try {
      const r = await this.compactNow();
      this.opt.console.info(
        `已按模型请求压缩上下文（${r.beforeTokens} → ${r.afterTokens} tokens 估算）`,
      );
      return r;
    } catch (e) {
      // 压缩失败不终止本轮：如实告知模型，它可自行决定是否重试或放弃。
      this.opt.console.warn(`compact_ctx 执行失败：${(e as Error).message}`);
      this.messages.push({
        role: "system",
        content: `compact_ctx 执行失败：${(e as Error).message}`,
      });
      return null;
    }
  }

  /**
   * 模型 / provider 切换后同步系统提示词里的「模型」那一行。
   * 不更新的话，模型看到的仍是启动时的旧模型名 —— 那会直接影响它的行为判断
   * （例如是否该期待思维链先于正文出现）。
   */
  noteModelChange(cfg: Config): void {
    const sys = this.messages[0];
    if (!sys || sys.role !== "system") return;
    // system 消息恒为 string（结构性约束）；类型扩宽后此处显式收窄
    const current = typeof sys.content === "string" ? sys.content : "";
    const line =
      `- 模型：${cfg.model}（provider ${cfg.providerName}，档位 ${cfg.modelTier}；` +
      `这是推理模型，你的思维链会先于正文输出，这是正常的）`;
    if (/- 模型：[^\n]*/.test(current)) {
      sys.content = current.replace(/- 模型：[^\n]*/, line);
    } else {
      sys.content = `${current}\n\n## 环境\n\n${line}\n`;
    }
  }

  reset(keepSystem = true): void {
    const sys = this.messages[0];
    this.messages = keepSystem && sys?.role === "system" ? [sys] : [];
  }

  /**
   * 压缩核心。把当前非 system 消息替换为一段摘要，原地重写 this.messages。
   *
   * 约束：只能在「历史处于安全切点」时调用 —— 消息序列满足
   * assistant(tool_calls) 与 tool 结果严格配对（如轮次边界、/compact 命令）。
   * 工具循环中途调用会拆散配对，下一轮请求会被服务端以协议错误拒绝。
   * 抛错式：失败向上传，由调用方决定如何呈现。
   */
  async compactNow(): Promise<{ beforeTokens: number; afterTokens: number }> {
    const plan = planCompaction(this.messages);
    const budget = Math.min(12_000, Math.floor(this.opt.cfg.contextWindow * 0.2));
    const res = await this.streamFn(
      { ...this.opt.cfg, maxTokens: budget, temperature: 0.2 },
      [
        { role: "system", content: "你是压缩器，只输出结构化摘要。" },
        { role: "user", content: plan.prompt },
      ],
      [],
      {},
    );
    if (!res.content.trim()) {
      throw new ToolError("压缩器返回了空摘要");
    }

    // 压缩请求本身也花 token：计入累计，否则 /cost 与真实账单对不上（P0-2）。
    if (res.usage) {
      this.totalPrompt += res.usage.prompt_tokens ?? 0;
      this.totalCompletion += res.usage.completion_tokens ?? 0;
      this.totalReasoning += res.usage.completion_tokens_details?.reasoning_tokens ?? 0;
    }

    // v0.2 记忆激活 §7.6.1 T2：压缩前捕获摘要 —— 历史即将被替换，
    // 这轮对话的信息价值最高（决策/踩坑很可能只在这一轮里出现过）。
    this.turnSeq += 1;
    try {
      this.opt.memory?.captureCompact(res.content.trim(), this.turnSeq);
    } catch {
      // 记忆失败不影响压缩
    }

    this.messages = applyCompaction(this.messages, res.content.trim(), plan);
    const afterTokens = estimateTokens(this.messages);
    this.lastCompact = { beforeTokens: plan.convoTokens, afterTokens };
    this.opt.onEvent?.({ type: "compact", data: { beforeTokens: plan.convoTokens, afterTokens } });
    return { beforeTokens: plan.convoTokens, afterTokens };
  }

  /**
   * 压缩入口（薄壳，保持旧契约）：太短或失败返回 false，不抛错。
   * /compact 命令与自动压缩走这里；工具触发的压缩走 compactNow + 标记收口。
   */
  async compact(): Promise<boolean> {
    try {
      await this.compactNow();
      return true;
    } catch {
      return false;
    }
  }

  /** 上下文使用率 0..1。 */
  contextUsage(): number {
    const used = estimateTokens(this.messages, toolSpecs());
    return used / this.opt.cfg.contextWindow;
  }

  /**
   * 轮次开始时的自动分类。
   *
   * 只在这里做，不在工具循环内部做。原因：跨 provider 的对话历史需要格式转换，
   * 一个轮次里反复切换供应商会让转换次数和出错概率都上升。
   * 代价是「工具报错立刻升档」做不到 —— 改为记录失败数，下轮生效。这个代价值得付。
   */
  private async classifyTurn(
    userInput: string,
  ): Promise<TurnStats["tierSwitch"]> {
    const cls = this.opt.classifier;
    if (!cls) return null;

    const cfg = this.opt.cfg;
    const before = cfg.modelTier;

    const decision = await cls.classify(
      userInput,
      before,
      this.contextUsage(),
      this.consecutiveFailures,
    );
    if (!decision || decision.tier === before) {
      // 即便没切档，失败计数也该清零 —— 下一轮是新任务
      this.consecutiveFailures = 0;
      return null;
    }

    const r = applyTier(cfg, decision.tier);
    if (!r.ok) {
      this.opt.console.warn(`分类结果无法应用：${r.error}`);
      this.consecutiveFailures = 0;
      return null;
    }

    this.noteModelChange(cfg);
    this.consecutiveFailures = 0;
    const switchInfo: NonNullable<TurnStats["tierSwitch"]> = {
      from: before,
      to: cfg.modelTier,
      reason: decision.reason,
      ...(r.degraded && r.note ? { degraded: r.note } : {}),
    };
    // v0.4.2：切档在请求前发生，UI 也必须在这一刻知道 —— 不能等 turn 结束才提示。
    this.opt.onEvent?.({ type: "tier_switch", data: switchInfo });
    return switchInfo;
  }

  /**
   * 发送一条用户消息并跑完整个 agent 循环。
   * 多模态输入（PRD §5.4）：{text, images} → content 组装为 ContentPart[]
   * （text part 在前，image_url parts 随后）；纯文本退化为 string，不破坏现有 provider。
   * 分类器只吃文本（PRD §5.5：图片结构性排除）。
   */
  async send(
    userInput: string | { text: string; images: string[] },
    opts: { rollbackOnAbort?: boolean } = {},
  ): Promise<TurnStats> {
    const started = Date.now();
    this.turnCounter += 1;
    this.lastCompact = null;
    this.abort = new AbortController();
    const signal = this.abort.signal;

    const text = typeof userInput === "string" ? userInput : userInput.text;
    const images = typeof userInput === "string" ? [] : userInput.images;

    // 分类在消息入队之前完成，这样本轮从一开始就用对模型
    const tierSwitch = await this.classifyTurn(text);
    // 分类可能切 provider/model（v0.4.1 A2）：切完再解析当前模型的窗口事实。
    this.opt.refreshContextWindow?.();

    // v0.2 记忆激活 §7.7.2：本轮开始前自动召回（临时 system 消息，轮末摘除）。
    // 放在 user 消息之前：既是协议上最稳的位置，也让模型先看到历史再读问题。
    // 失败静默降级为「无记忆」—— 记忆是增强项，不是依赖项。
    const turnStart = this.messages.length;
    let recallMsg: Message | null = null;
    if (this.opt.memory) {
      try {
        const recalled = await this.opt.memory.recall(text);
        if (recalled) {
          this.messages.push(recalled.message);
          recallMsg = recalled.message;
        }
      } catch {
        // 召回不可用：按无记忆继续
      }
    }

    // 回滚基线：opts.rollbackOnAbort 时，abort 返回前把历史截回 turnStart，
    // 本轮（含召回临时消息与 user 消息）整体作废 —— 面向「输入错了要重来」的场景。
    const startLen = turnStart;
    this.messages.push(
      images.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text },
              ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
            ],
          }
        : { role: "user", content: text },
    );

    const specs: ToolSpec[] = this.toolSpecsFor();
    const maxIter = this.opt.cfg.maxToolIterations;
    let toolCalls = 0;
    let finishReason: string | null = null;
    let iterations = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let hadError = false;
    let errorMessage: string | null = null;
    /** 空正文终态（连续两轮无正文）；仅在放弃时置 true。 */
    let emptyResponse = false;
    /** 空正文重试时临时提高的输出预算（仅一次）。 */
    let retryMaxTokens: number | null = null;
    /**
     * 空正文自动重试的 user 提示；非 null 表示本轮已重试过一次（至多一次，
     * 防止「模型持续空回复」变成死循环）。成功或放弃后都从历史摘除。
     */
    let nudgeMsg: Message | null = null;
    /** 上下文溢出恢复只做一次（A2），避免无限压缩-重试循环。 */
    let overflowRecovered = false;
    /** 本轮是否已产出最终正文（用于收口「循环结束但没回答」）。 */
    let answered = false;
    /** 轮次内是否因用户 abort 退出（循环顶部 break 路径）。 */
    let abortedFlag = false;

    for (let iter = 0; iter < maxIter; iter++) {
      iterations++;
      if (signal.aborted) {
        abortedFlag = true;
        break;
      }

      // 上下文超阈值 → 自动压缩
      const usage = estimateTokens(this.messages, specs) / this.opt.cfg.contextWindow;
      if (usage > this.opt.cfg.compactThreshold && this.messages.length > 6) {
        this.opt.console.info(`上下文使用率 ${(usage * 100).toFixed(0)}%，自动压缩中…`);
        await this.compact();
      }

      // A2：接近窗口上限（含本次 maxTokens 预留）时提前压缩。配置窗口可能偏大，
      // 这里只是减少 400 概率；真正的兜底是下面的 overflow 错误恢复。
      if (
        this.messages.length > 6 &&
        estimateTokens(this.messages, specs) + this.opt.cfg.maxTokens >
          this.opt.cfg.contextWindow * 0.98
      ) {
        this.opt.console.info("上下文接近窗口上限，压缩后继续…");
        const ok = await this.compact();
        if (!ok) this.trimOldToolOutputs();
      }

      // ---- P1 跨会话消息注入（PRD v1.2 §4.4）----
      // 安全切点：本批 tool 结果已全部回填（上一轮迭代的工具循环已收口），
      // 且自动 compact 已处理完 —— 此时插入 user 消息不会拆散
      // assistant(tool_calls) → tool×N 的配对，也不会被 compact 摘要吞掉。
      // 首轮（toolCalls === 0）不注入：P1 只服务「活跃 turn 中的工具间隙」。
      if (this.opt.pollInbox && toolCalls > 0) {
        try {
          const incoming = this.opt.pollInbox();
          for (const text of incoming) {
            this.messages.push({ role: "user", content: text });
          }
        } catch (e) {
          // 信箱轮询失败不得击穿主循环：跨会话是增强项，本轮按无消息继续。
          this.opt.console.warn(`跨会话信箱轮询失败：${(e as Error).message}`);
        }
      }

      // ---- 把本轮预算告知模型 ----
      // 追加为一条临时 system 消息，请求后立刻移除，不进历史。
      // 不塞进 tools 数组：那是静态 schema，掺文本会污染 tool_choice 语义，
      // 部分服务端还会校验 schema。system 是 OpenAI 兼容协议里最稳的旁路。
      // 计数用 iter+1（第几次 LLM 请求）而非 toolCalls：
      // parallel_tool_calls=false 下两者相等，但 iter 与硬上限严格对齐，
      // 不会出现「显示 5/80 而循环已跑到 78」的错位。
      const budgetMsg = this.budgetMessage(iter + 1, maxIter);
      this.messages.push(budgetMsg);

      // ---- 发起一次流式请求 ----
      // TTY 下逐 chunk 流式；非 TTY（管道 / CI / 重定向）改为块级：
      // 逐 chunk 写进管道只会得到带控制符的碎片，且没有任何阅读价值。
      // 做法是照常接收增量，但先累积，等本轮结束后一次性渲染。
      const interactive = this.opt.nonInteractive !== true && process.stdout.isTTY === true;
      const reasoningOpen = { open: false };
      // 正文/代码块经 StreamFormatter 写入，但同样要走 Console 的输出通道：
      // 否则注入的 write 只覆盖「● 」前缀，正文仍直写 stdout，测试与真实路径分叉。
      const writeRaw = this.opt.console.writeRaw?.bind(this.opt.console);
      const answerFmt = new StreamFormatter({
        colorize: colorEnabled(),
        ...(writeRaw ? { write: writeRaw } : {}),
      });
      let answerOpen = false;
      let blockReasoning = "";
      let blockAnswer = "";

      try {
        if (interactive) this.opt.console.startSpinner("连接中…");

        // 空正文重试（尤其 finishReason=length）时临时放大输出预算。
        const reqCfg =
          retryMaxTokens !== null ? { ...this.opt.cfg, maxTokens: retryMaxTokens } : this.opt.cfg;
        const res = await this.streamFn(
          reqCfg,
          this.messages,
          specs,
          {
            onReasoning: (d) => {
              if (!this.opt.cfg.showReasoning) return;
              this.opt.onEvent?.({ type: "reasoning", data: d });
              if (!interactive) {
                blockReasoning += d;
                return;
              }
              this.opt.console.stopSpinner();
              if (answerOpen) return; // 正文已开始，思维链增量忽略
              if (!reasoningOpen.open) {
                this.opt.console.beginStream("reasoning");
                reasoningOpen.open = true;
              }
              this.opt.console.writeStream(d, "reasoning");
            },
            onContent: (d) => {
              this.opt.onEvent?.({ type: "text", data: d });
              if (!interactive) {
                blockAnswer += d;
                return;
              }
              this.opt.console.stopSpinner();
              if (reasoningOpen.open) {
                this.opt.console.endStream("reasoning");
                reasoningOpen.open = false;
              }
              if (!answerOpen) {
                this.opt.console.beginStream("answer");
                answerOpen = true;
              }
              answerFmt.write(d);
            },
            onNotice: (m) => {
              // 重试/降级提示：仅交互模式让人看见；管道模式留给最终答案，避免污染 stdout
              if (interactive) this.opt.console.warn(m);
            },
          },
          signal,
        );

        // 预算提示只服务于这一次请求，立刻摘掉，避免污染对话历史
        this.dropTransientMessage(budgetMsg);

        if (!interactive) {
          // 块级：思维链与正文各渲染一次
          if (blockReasoning.trim() && this.opt.cfg.showReasoning) {
            this.opt.console.line(c.dim("┌ think"));
            this.opt.console.line(c.dim(this.opt.console.indent(blockReasoning.trim())));
            this.opt.console.line(c.dim("└─"));
          }
          if (blockAnswer.trim()) {
            this.opt.console.line(renderMarkdown(blockAnswer.trim(), this.opt.console.width));
          }
        } else {
          this.opt.console.stopSpinner();
          if (reasoningOpen.open) {
            this.opt.console.endStream("reasoning");
            reasoningOpen.open = false;
          }
          if (answerOpen) {
            // StreamFormatter 已经负责正文换行，这里只复位流式状态（v0.2.3 D1）。
            // 旧实现在正常路径完全不复位：streaming 一旦置 true 就再没下来，
            // 下一批次的 beginStream 直接早退 —— `●` 前缀整个会话只出现一次。
            answerFmt.finish();
            this.opt.console.endStream("answer", false);
            answerOpen = false;
          }
        }

        if (res.usage) {
          promptTokens += res.usage.prompt_tokens ?? 0;
          completionTokens += res.usage.completion_tokens ?? 0;
          reasoningTokens += res.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        }
        finishReason = res.finishReason;

        // ---- 无工具调用 → 本轮结束 ----
        if (res.toolCalls.length === 0) {
          const hasBody = res.content.trim().length > 0;
          if (hasBody) {
            // 重试成功：摘掉重试提示，别让它作为噪音留在后续轮次的历史里
            if (nudgeMsg) this.dropTransientMessage(nudgeMsg);
            this.messages.push({ role: "assistant", content: res.content });
            answered = true;
            retryMaxTokens = null;
            break;
          }

          // 正文为空的两种退化场景：
          //  - finishReason=length：输出预算被思维链吃光，正文还没轮到就被截断；
          //  - 其余（通常 stop）：推理模型把答案全写进思维链通道，content 通道为空。
          // 第一次：length 时临时放大输出预算，并追加 nudge 提示；只重试一次。
          // 第二次仍空：按错误收口（v0.4.1 A1），必须让 UI/日志/会话状态都看见，
          // 不能像旧实现那样静默放弃并报 ok。
          const truncated = res.finishReason === "length";
          if (nudgeMsg) {
            this.dropTransientMessage(nudgeMsg);
            emptyResponse = true;
            hadError = true;
            errorMessage =
              `模型连续两轮未产出正文（finishReason=${res.finishReason ?? "null"}；` +
              `reasoning ${res.reasoning.trim().length} 字符）` +
              (truncated ? "；输出预算被思维链耗尽" : "");
            this.opt.console.error(
              `${errorMessage}。本轮已放弃；诊断日志见 ~/.neo/logs/turns/（可用 NEO_LOG_DIR 覆盖）。`,
            );
            this.opt.onEvent?.({ type: "error", data: errorMessage });
            break;
          }
          if (truncated) {
            // 翻倍预算，但封顶 64k；下一轮请求生效。
            retryMaxTokens = Math.min(
              65_536,
              Math.max(this.opt.cfg.maxTokens * 2, this.opt.cfg.maxTokens + 4_096),
            );
          }
          if (res.reasoning.trim() !== "") {
            this.opt.console.info(
              truncated
                ? `输出预算被思维链耗尽，正文未开始 —— 提高 max_tokens 后自动重试一次（${retryMaxTokens ?? this.opt.cfg.maxTokens}）。`
                : "模型只返回了思维链，没有正文 —— 自动重试一次。",
            );
          } else {
            this.opt.console.info("模型返回了空响应 —— 自动重试一次。");
          }
          nudgeMsg = {
            role: "user",
            content:
              "（系统提示）你上一轮没有输出正文。请把最终答案作为正文（content）直接输出，不要只留在思维链里。",
          };
          this.messages.push(nudgeMsg);
          continue;
        }

        // ---- 有工具调用 ----
        // 放大过的输出预算只在「空正文重试」那一次生效；带工具调用后复位。
        retryMaxTokens = null;
        this.messages.push({
          role: "assistant",
          content: res.content,
          tool_calls: res.toolCalls,
        });

        const ctx = this.makeCtx(signal);

        for (const call of res.toolCalls) {
          toolCalls++;
          const name = call.function.name;
          this.opt.onEvent?.({ type: "tool_start", data: { name, args: call.function.arguments } });
          this.opt.console.toolHeader(name, previewArgs(call.function.arguments));

          const r = await dispatch(name, call.function.arguments, ctx);
          this.opt.console.toolResult(r.output, 2, r.ok);
          this.opt.onEvent?.({ type: "tool_end", data: { name, ok: r.ok, truncated: r.truncated } });

          // 连续失败计数：分类器据此判断当前档位是否撑不住。
          // 成功即清零 —— 只关心连续失败，不累计历史失败。
          if (r.ok) {
            this.consecutiveFailures = 0;
          } else {
            this.consecutiveFailures++;
          }

          // 手段/目标分层计数（2026-10-26）：evidence 产出即清零，
          // capability 累加，neither 不影响（交付/管理动作不算漂移）。
          const kind = toolKindOf(name);
          if (kind === "evidence") {
            this.capabilityStreak = 0;
          } else if (kind === "capability") {
            this.capabilityStreak++;
          }

          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: r.output,
          });
        }

        // ---- 工具循环收口：安全切点，处理 compact_ctx 登记的压缩请求 ----
        // 必须等全部 tool 结果回填完毕（assistant(tool_calls) 配对完整）才能压缩，
        // 否则下一轮请求会因消息序列不完整被服务端拒绝。
        await this.runCompactIfRequested();
      } catch (e) {
        this.opt.console.stopSpinner();
        // 请求失败时同样要摘掉预算提示，否则它会作为一条孤立消息留在历史里
        this.dropTransientMessage(budgetMsg);
        // 块级模式下，出错也要把已收到的内容吐出来 ——
        // 直接丢掉等于让用户误以为模型什么都没说。
        if (!interactive) {
          if (blockReasoning.trim() && this.opt.cfg.showReasoning) {
            this.opt.console.line(c.dim("┌ think"));
            this.opt.console.line(c.dim(this.opt.console.indent(blockReasoning.trim())));
            this.opt.console.line(c.dim("└─"));
          }
          if (blockAnswer.trim()) {
            this.opt.console.line(renderMarkdown(blockAnswer.trim(), this.opt.console.width));
          }
        }
        if (answerOpen) {
          answerFmt.finish();
          this.opt.console.endStream("answer", false);
          answerOpen = false;
        }
        // 只关「当前真正打开的那个块」：旧实现先 answer 后 reasoning，
        // 推理阶段出错时 answer 的复位把状态清掉，reasoning 的 └─ 永远不打印。
        this.opt.console.ensureStreamClosed();

        // ---- A2：上下文超限 → 校正窗口 + 压缩/裁剪 → 同一轮重试一次 ----
        if (!overflowRecovered && isContextOverflowError(e)) {
          overflowRecovered = true;
          const limit = parseContextLimitFromError((e as Error).message);
          if (limit) {
            this.opt.cfg.contextWindow = limit;
            this.opt.cfg.contextWindowSource = "overflow_error";
            try {
              this.opt.onContextLimit?.(limit, this.opt.cfg.model);
            } catch {
              // 持久化失败不影响恢复
            }
            this.opt.console.warn(
              `服务端提示上下文上限 ${limit.toLocaleString()} tokens，已按实际窗口校正；压缩后重试。`,
            );
          } else {
            this.opt.console.warn("上下文超限：压缩后重试一次…");
          }
          let compacted = false;
          try {
            await this.compactNow();
            compacted = true;
          } catch {
            // 历史太短/压缩失败：退化为裁剪旧工具输出
          }
          if (!compacted) {
            this.trimOldToolOutputs();
            this.opt.console.warn("压缩不可用，已裁剪旧工具输出后重试。");
          }
          continue;
        }

        if (e instanceof LLMError || (e as Error).name === "AbortError") {
          const err = e as Error;
          if (err.name === "AbortError" || signal.aborted) {
            if (opts.rollbackOnAbort) {
              this.messages.length = startLen;
            }
            if (recallMsg) this.dropTransientMessage(recallMsg);
            this.opt.onEvent?.({ type: "aborted" });
            this.emitMemoryCapture(turnStart, "aborted");
            this.lastStats = {
              durationMs: Date.now() - started,
              promptTokens,
              completionTokens,
              reasoningTokens,
              toolCalls,
              iterations,
              finishReason: "aborted",
              aborted: true,
              hadError: false,
              errorMessage: null,
              emptyResponse: false,
              contextUsage: estimateTokens(this.messages, specs) / this.opt.cfg.contextWindow,
              tierSwitch,
            };
            this.writeTurnLog(this.lastStats);
            return this.lastStats;
          }
          hadError = true;
          errorMessage = isContextOverflowError(err)
            ? `${err.message}（已尝试压缩仍超限；请检查 settings.context_window / 模型实际窗口）`
            : err.message;
          this.opt.console.error(`LLM 请求失败: ${errorMessage}`);
          this.opt.onEvent?.({ type: "error", data: err.message });
          break;
        }
        if (recallMsg) this.dropTransientMessage(recallMsg);
        throw e;
      }
    }

    if (iterations >= maxIter && toolCalls > 0) {
      this.opt.console.warn(
        `已达最大工具迭代次数 ${maxIter}，本轮被截断 —— 上面的回答可能不完整。`,
      );
    }

    // 收口兜底：循环结束却没有最终正文（例：最后一次迭代恰好触发溢出恢复/迭代上限），
    // 不能静默返回 ok —— 这正是 A1 要消灭的「最后一轮没回复、没报错」。
    if (!answered && !hadError && !emptyResponse && !abortedFlag && !signal.aborted) {
      hadError = true;
      if (finishReason === null) emptyResponse = true;
      errorMessage = "本轮在重试/迭代上限处结束，没有产出最终回答";
      this.opt.console.error(errorMessage);
      this.opt.onEvent?.({ type: "error", data: errorMessage });
    }

    this.totalPrompt += promptTokens;
    this.totalCompletion += completionTokens;
    this.totalReasoning += reasoningTokens;

    this.lastStats = {
      durationMs: Date.now() - started,
      promptTokens,
      completionTokens,
      reasoningTokens,
      toolCalls,
      iterations,
      finishReason,
      aborted: abortedFlag,
      hadError,
      errorMessage,
      emptyResponse,
      contextUsage: estimateTokens(this.messages, specs) / this.opt.cfg.contextWindow,
      tierSwitch,
    };

    // 临时召回消息只服务于本轮：轮末摘除，不进历史、不污染后续轮次
    if (recallMsg) this.dropTransientMessage(recallMsg);

    this.opt.onEvent?.({ type: "turn_end", data: this.lastStats });
    this.emitMemoryCapture(turnStart, "turn");
    this.writeTurnLog(this.lastStats);
    return this.lastStats;
  }

  /**
   * 写一轮诊断日志（v0.4.1 A1）。失败静默：诊断不得影响主流程。
   * 只记元数据，不记 prompt/回答正文。
   */
  private writeTurnLog(stats: TurnStats): void {
    // 没有会话 id = 测试/裸 Agent：不写盘，避免单测污染用户 ~/.neo/logs。
    if (!this.opt.sessionId) return;
    appendTurnLog({
      sessionId: this.opt.sessionId,
      turn: this.turnCounter,
      provider: this.opt.cfg.providerName,
      model: this.opt.cfg.model,
      durationMs: stats.durationMs,
      iterations: stats.iterations,
      toolCalls: stats.toolCalls,
      promptTokens: stats.promptTokens,
      completionTokens: stats.completionTokens,
      reasoningTokens: stats.reasoningTokens,
      finishReason: stats.finishReason,
      aborted: stats.aborted,
      hadError: stats.hadError,
      emptyResponse: stats.emptyResponse,
      errorMessage: stats.errorMessage,
      contextWindow: this.opt.cfg.contextWindow,
      contextUsage: stats.contextUsage,
      ...(this.lastCompact
        ? { compaction: { before: this.lastCompact.beforeTokens, after: this.lastCompact.afterTokens } }
        : {}),
    });
  }

  /**
   * 上下文溢出兜底（A2）：压缩不可用时，把最老的一批 tool 输出替换为占位文本。
   * 只动 tool content，不改角色/配对，消息序列仍然合法。
   */
  private trimOldToolOutputs(keepRecent = 6): void {
    const toolIndices: number[] = [];
    this.messages.forEach((m, i) => {
      if (m.role === "tool") toolIndices.push(i);
    });
    const drop = Math.max(0, toolIndices.length - Math.max(0, keepRecent));
    for (let k = 0; k < drop; k++) {
      const idx = toolIndices[k];
      if (idx === undefined) continue;
      const m = this.messages[idx];
      if (!m) continue;
      const before = contentText(m.content)?.length ?? 0;
      m.content = `[旧工具输出已裁剪以适配上下文（原 ${before} 字符）；如需重看请重新调用工具]`;
    }
  }

  /**
   * 轮末捕获入口（§7.6.1 T1 / abort）。
   * fire-and-forget：捕获内部有队列与失败降级，绝不允许异常冒泡到主循环。
   */
  private emitMemoryCapture(turnStart: number, kind: "turn" | "aborted"): void {
    const mem = this.opt.memory;
    if (!mem) return;
    this.turnSeq += 1;
    try {
      mem.capture({
        kind,
        messages: this.messages.slice(turnStart),
        turn: this.turnSeq,
        ...(this.lastStats
          ? {
              stats: {
                toolCalls: this.lastStats.toolCalls,
                iterations: this.lastStats.iterations,
                aborted: this.lastStats.aborted,
                finishReason: this.lastStats.finishReason,
              },
            }
          : {}),
      });
    } catch {
      // 捕获失败静默：记忆不是主流程的一部分
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
  private budgetMessage(attempt: number, max: number): Message {
    return buildBudgetMessage(attempt, max, readGoalSafe(this.opt.readGoal), this.capabilityStreak);
  }

  /** 移除临时消息（预算提示 / 重试提示）。按引用比对，避免误删历史里内容相同的消息。 */
  private dropTransientMessage(msg: Message): void {
    const i = this.messages.lastIndexOf(msg);
    if (i !== -1) this.messages.splice(i, 1);
  }

  private makeCtx(signal: AbortSignal): ToolCtx {
    const mode = this.mode;
    const ui = this.opt.console;
    return {
      cfg: this.opt.cfg,
      signal,
      host: this,
      checkpoint: this.opt.checkpoint,
      approve: async (tool, detail) => {
        const decision = decidePermission(mode, tool);
        if (decision.allow) return true;
        if (decision.reason === "plan") {
          ui.warn(`plan 模式禁止 ${tool}：${detail}`);
          return false;
        }
        return ui.confirm(`${tool} — ${detail}`);
      },
      onNotice: (m) => ui.info(m),
      onProgress: (m) => ui.updateSpinner(m),
      askUser: this.opt.askUser,
      cancelAskUser: this.opt.cancelAskUser,
      readOnly: this.opt.mode === "plan",
    };
  }
}
