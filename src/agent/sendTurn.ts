/** Agent.send 的回合循环，抽到独立模块以免 loop.ts 超过行数上限。 */
import { estimateTokens, LLMError, type Message, type ToolSpec } from "../llm.ts";
import { StreamFormatter } from "../ui/stream.ts";
import { renderMarkdown } from "../ui/render.ts";
import { c, colorEnabled } from "../ui/theme.ts";
import { dispatch, isParallelizable } from "../tools/index.ts";
import { isContextOverflowError, parseContextLimitFromError } from "../contextWindow.ts";
import { CompactBlockedError, reportLifecycle } from "./lifecycle.ts";
import { previewArgs } from "./render.ts";
import type {
  ToolEndEventData,
  ToolEventStatus,
  ToolStartEventData,
  TurnStats,
} from "./types.ts";

import type { Agent } from "./loop.ts";

/**
 * #37：把 DispatchResult 映射为公开工具状态。
 *
 * `executed === false` 表示工具根本没跑（用户拒绝 / plan 拒绝 / Pre 阻断 /
 * 参数非法 / 未知工具），必须区别于「跑了但失败」——这也是 `settleToolOutcome`
 * 保持中性的同一判据。
 */
export function toolStatusOf(r: { ok: boolean; executed?: boolean }): ToolEventStatus {
  if (r.executed === false) return "not_executed";
  return r.ok ? "success" : "failure";
}

export async function sendTurn(
  this: Agent,
  userInput: string | { text: string; images: string[] },
  opts: { rollbackOnAbort?: boolean } = {},
): Promise<TurnStats> {
  const started = Date.now();
  this.turnCounter += 1;
  const previousCompact = this.lastCompact;
  this.abort ??= new AbortController();
  const signal = this.abort.signal;

  const text = typeof userInput === "string" ? userInput : userInput.text;
  const images = typeof userInput === "string" ? [] : userInput.images;

  // ---- #64 UserPromptSubmit：必须在**分类器之前**、写历史之前 ----
  // 阻断时零模型请求（含分类器）、history 一个字节都不动，原因可见。
  // 幂等：宿主（-p / ACP）已提前 submitUserPrompt 过，或这是同一条用户输入的
  // 内部轮（drive/loop/Stop 续跑），都不会再执行 hook。
  // 阻断结果留在 userTurn.blocked 上：宿主重复 send 同一条输入时直接复用，
  // 不会因为「再 send 一次」就绕过用户策略。
  const ups = await this.ensureUserPromptSubmit(text);
  if (ups.blocked || signal.aborted) {
    const msg = signal.aborted ? null : `UserPromptSubmit hook 阻断了本次输入：${ups.reason}`;
    if (msg) reportLifecycle(this, msg);
    if (signal.aborted) this.opt.onEvent?.({ type: "aborted" });
    this.lastStats = {
      durationMs: Date.now() - started,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      toolCalls: 0,
      iterations: 0,
      finishReason: signal.aborted ? "aborted" : "blocked",
      aborted: signal.aborted,
      // 阻断不是模型失败：hadError 保持 false，宿主据 `blocked` 决定退出码。
      hadError: false,
      errorMessage: msg,
      emptyResponse: false,
      contextUsage: estimateTokens(this.messages, this.toolSpecsFor()) / this.opt.cfg.contextWindow,
      tierSwitch: null,
      blocked: !signal.aborted,
    };
    this.writeTurnLog(this.lastStats);
    return this.lastStats;
  }

  this.lastCompact = null;

  // 分类在消息入队之前完成，这样本轮从一开始就用对模型
  const tierSwitch = await this.classifyTurn(text);
  // 分类可能切 provider/model（v0.4.1 A2）：切完再解析当前模型的窗口事实。
  this.opt.refreshContextWindow?.();
  // 请求边界：窗口/来源/会话名/模型任何一项在上一轮之后变了，档位与正文都要重选。
  // 探针完成、overflow 校正、rename 都只改状态，统一在这里生效，不在流式响应中途改写。
  this.refreshSystemPrompt();

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

  let specs: ToolSpec[] = this.toolSpecsFor();
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
  /**
   * 输出撞墙写回每轮用户请求只做一次（P3 / #6）。
   * finish_reason=length 即记一次：空正文、截断正文、工具轮都算，避免每条迭代都打 /models。
   */
  let outputLimitProbed = false;
  /** 本轮是否已产出最终正文（用于收口「循环结束但没回答」）。 */
  let answered = false;
  /** 轮次内是否因用户 abort 退出（循环顶部 break 路径）。 */
  let abortedFlag = false;
  /** #64：Stop 续跑是否已用掉（每条用户输入最多一次，额度挂在 userTurn 上）。 */
  let stopContinued = this.userTurn?.stopContinued === true;
  /** #64：自动压缩被 PreCompact 拒绝 —— 本轮明确停止，不 trim、不重试。 */
  let compactBlocked: string | null = null;
  for (let iter = 0; iter < maxIter; iter++) {
    iterations++;
    if (signal.aborted) {
      abortedFlag = true;
      break;
    }

    // issue #68：工具清单按**每次请求**重算。
    // tool_search 装入的 MCP schema 必须在下一轮请求里就出现；上一轮工具循环里
    // 也可能因直接点名而记账。清单是纯函数（toolSpecsFor 读会话已加载集合），
    // 重算成本远低于多发一份过期 schema 或漏发刚装入的 schema。
    specs = this.toolSpecsFor();

    // 上下文超阈值 → 自动压缩
    const usage = estimateTokens(this.messages, specs) / this.opt.cfg.contextWindow;
    if (usage > this.opt.cfg.compactThreshold && this.messages.length > 6) {
      this.opt.console.info(`上下文使用率 ${(usage * 100).toFixed(0)}%，自动压缩中…`);
      // #64：PreCompact 拒绝 ≠ 压缩失败。拒绝是用户的决定，本轮必须明确停下，
      // 不得退化为裁剪/重试（那两条都会破坏历史），也不得下一轮重复跑 hook。
      try {
        await this.compactNow({ compactTrigger: "auto" });
      } catch (e) {
        if (signal.aborted) { abortedFlag = true; break; }
        if (e instanceof CompactBlockedError) {
          compactBlocked = e.reason;
          break;
        }
        // 普通压缩失败（历史太短 / 摘要器空）沿用旧语义：不中断本轮。
      }
    }

    // A2：接近窗口上限（含本次 maxTokens 预留）时提前压缩。配置窗口可能偏大，
    // 这里只是减少 400 概率；真正的兜底是下面的 overflow 错误恢复。
    if (
      this.messages.length > 6 &&
      estimateTokens(this.messages, specs) + this.opt.cfg.maxTokens >
        this.opt.cfg.contextWindow * 0.98
    ) {
      this.opt.console.info("上下文接近窗口上限，压缩后继续…");
      let ok: boolean;
      try {
        await this.compactNow({ compactTrigger: "auto" });
        ok = true;
      } catch (e) {
        if (signal.aborted) { abortedFlag = true; break; }
        if (e instanceof CompactBlockedError) {
          compactBlocked = e.reason;
          break;
        }
        ok = false;
      }
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
    // 两者在「一轮一个工具调用」时相等，但 iter 与硬上限严格对齐，
    // 不会出现「显示 5/80 而循环已跑到 78」的错位（issue #11 起一轮可含多个工具调用，
    // toolCalls 会大于 iter，这个理由更充分）。
    // ---- 后台子代理结果（issue #16）----
    // 与信箱注入同口径：作为 user 消息追加，宿主取走即清（一次性）。
    // 不需要「工具批次之后」这个限制 —— 后台结果随时可能到，越早注入越好。
    if (this.opt.pollBackground) {
      try {
        for (const text of this.opt.pollBackground()) {
          this.messages.push({ role: "user", content: text });
        }
      } catch {
        /* 后台结果注入是增强项，失败不拖垮主循环 */
      }
    }

    // ---- 路径作用域规则（issue #17）----
    // 触达路径在工具批次之后才变多，所以按**每次请求**重算：命中集合变了就换掉临时
    // system 消息，不再命中就摘除。与预算提示同口径：只服务当前请求，轮末统一清理。
    this.syncScopedRulesMessage();

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
      // 在途标记：请求发出到返回之间，messages[0] 不许被改写。
      this.requestInFlight = true;
      const identityBefore = `${this.opt.cfg.providerName}|${this.opt.cfg.model}`;
      const res = await this.mainStreamFn(
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
      this.requestInFlight = false;
      // #59：fallback 成功后共享 cfg 已切到实际响应目标；在安全边界刷新系统提示词。
      if (`${this.opt.cfg.providerName}|${this.opt.cfg.model}` !== identityBefore) {
        this.noteModelChange(this.opt.cfg);
      }

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
        // #59：按实际提供响应的目标记分桶（总量在 send 末尾统一累加）。
        this.addToBucket(res.usage, this.opt.cfg.providerName, this.opt.cfg.model);
      }
      finishReason = res.finishReason;

      // #37：每次完整模型响应成功后发一条内部 assistant_message 事件。
      // 位置在 `const calls = res.toolCalls`（工具 dispatch）之前，且早于
      // 「无工具调用 → 本轮结束」分支，因此最终回答、带 tool_calls 的响应、
      // 以及同一 send() 内工具循环的每一轮都会各发一条。只带公开正文 /
      // tool_calls 原序 / finish_reason；truncated 由 writer 判定。
      this.emitAssistantMessageEvent(res);

      // #6：只要这轮被 length 截断就尝试探测写回。真实截断经常带着部分正文或工具调用，
      // 只认「空正文」会在主力模型上打不中。本轮只打一次；回调不得把 completion_tokens
      // 或请求预算当成能力上限（那是组合根的纪律，这里只负责通知）。
      if (res.finishReason === "length" && !outputLimitProbed) {
        outputLimitProbed = true;
        try {
          this.opt.onOutputLimit?.(this.opt.cfg.model);
        } catch {
          // 写回失败不影响本轮（重试 / 工具执行照常）
        }
      }

      // ---- 无工具调用 → 本轮结束 ----
      if (res.toolCalls.length === 0) {
        const hasBody = res.content.trim().length > 0;
        if (hasBody) {
          // 重试成功：摘掉重试提示，别让它作为噪音留在后续轮次的历史里
          if (nudgeMsg) this.dropTransientMessage(nudgeMsg);
          this.messages.push({
            role: "assistant",
            content: res.content,
            ...(res.thinkingBlocks ? { thinking_blocks: res.thinkingBlocks } : {}),
          });
          answered = true;
          retryMaxTokens = null;
          if (signal.aborted) {
            abortedFlag = true;
            break;
          }
          // Stop 属于模型的正常终态，不是工具轮或截断响应；续跑仍在原 for 内。
          if (res.finishReason === "stop") {
            const stop = await this.runStopHooks(stopContinued);
            if (signal.aborted) {
              abortedFlag = true;
              break;
            }
            if (stop.continue) {
              if (stopContinued) {
                reportLifecycle(this, `Stop hook 续跑已达每条用户输入一次的上限：${stop.reason}`);
              } else if (iter + 1 >= maxIter) {
                reportLifecycle(this, "Stop hook 请求续跑，但原迭代预算已用尽。");
              } else {
                stopContinued = true;
                if (this.userTurn) this.userTurn.stopContinued = true;
                this.messages.push({ role: "user", content: stop.reason });
                answered = false;
                continue;
              }
            } else if (stop.reason) {
              reportLifecycle(this, `Stop hook 未请求续跑（仅诊断）：${stop.reason}`);
            }
          }
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
          // 输出上限探测已在上面按 finish_reason 记过一次，这里只放大请求预算。
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
        ...(res.thinkingBlocks ? { thinking_blocks: res.thinkingBlocks } : {}),
      });

      const ctx = this.makeCtx(signal);

      // ---- 工具执行（issue #11：只读工具可并行）----
      // 调度语义：
      //  1. 连续的「可并行」工具（registry 上 parallelizable=true）组成一个并行段，
      //     段内同时执行；段与段之间、以及任何不可并行工具都是**串行屏障**。
      //  2. 因此 [read, write, read] 退化为全串行 —— 写工具不会与相邻读写并发，
      //     依赖顺序不会被破坏。
      //  3. messages 里 tool 结果**严格按 tool_calls 原序**回填（服务端按 id 配对，
      //     乱序会被拒或错配）；tool_start 在段内先按序全部发出，tool_end 按序发出。
      //  4. 计数（consecutiveFailures / capabilityStreak / toolCalls）按原序结算，
      //     与串行实现逐条等价。
      const parallelOn = this.opt.cfg.parallelToolCalls !== "off";
      const calls = res.toolCalls;
      let ci = 0;
      while (ci < calls.length) {
        const head = calls[ci]!;
        const headName = head.function.name;
        const canParallel = parallelOn && isParallelizable(headName);

        if (!canParallel) {
          toolCalls++;
          const startData: ToolStartEventData = {
            name: headName,
            args: head.function.arguments,
            // #37：call_id 用现成的 tool_call_id（回填 tool 消息用的同一个 id）。
            call_id: head.id,
            paths: this.toolPathsFor(headName, head.function.arguments),
          };
          this.opt.onEvent?.({ type: "tool_start", data: startData });
          this.opt.console.toolHeader(headName, previewArgs(head.function.arguments));
          const r = await dispatch(headName, head.function.arguments, ctx);
          this.noteToolPaths(headName, head.function.arguments);
          this.opt.console.toolResult(r.output, 2, r.ok);
          const endData: ToolEndEventData = {
            name: headName,
            ok: r.ok,
            truncated: r.truncated,
            // #37：新增字段；status 区分「跑了但失败」与「根本没跑」。
            call_id: head.id,
            output: r.output,
            status: toolStatusOf(r),
            paths: this.toolPathsFor(headName, head.function.arguments),
          };
          this.opt.onEvent?.({ type: "tool_end", data: endData });
          this.settleToolOutcome(headName, r.ok, r.executed !== false);
          this.messages.push({ role: "tool", tool_call_id: head.id, name: headName, content: r.output });
          ci++;
          continue;
        }

        // 收集连续可并行段
        let cj = ci;
        while (cj < calls.length && isParallelizable(calls[cj]!.function.name)) cj++;
        const slice = calls.slice(ci, cj);

        // 段内先按序发 start（UI 立刻看到「要做什么」），再并发执行
        for (const call of slice) {
          toolCalls++;
          // #37：并行段仍按 tool_calls 原序先发全部 start（顺序不变）。
          const startData: ToolStartEventData = {
            name: call.function.name,
            args: call.function.arguments,
            call_id: call.id,
            paths: this.toolPathsFor(call.function.name, call.function.arguments),
          };
          this.opt.onEvent?.({ type: "tool_start", data: startData });
          this.opt.console.toolHeader(call.function.name, previewArgs(call.function.arguments));
        }
        // dispatch 内部已把 ToolError / 参数错误收敛成 ok:false，不会让 Promise.all 炸掉批次
        const results = await Promise.all(
          slice.map((call) => dispatch(call.function.name, call.function.arguments, ctx)),
        );
        for (let k = 0; k < slice.length; k++) {
          const call = slice[k]!;
          const r = results[k]!;
          this.opt.console.toolResult(r.output, 2, r.ok);
          this.noteToolPaths(call.function.name, call.function.arguments);
          // #37：并行段结果仍按原序发 end（顺序不变），与 start 用同一 call.id 配对。
          const endData: ToolEndEventData = {
            name: call.function.name,
            ok: r.ok,
            truncated: r.truncated,
            call_id: call.id,
            output: r.output,
            status: toolStatusOf(r),
            paths: this.toolPathsFor(call.function.name, call.function.arguments),
          };
          this.opt.onEvent?.({ type: "tool_end", data: endData });
          this.settleToolOutcome(call.function.name, r.ok, r.executed !== false);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: r.output,
          });
        }
        ci = cj;
      }

      // ---- 工具循环收口：安全切点，处理 compact_ctx 登记的压缩请求 ----
      // 必须等全部 tool 结果回填完毕（assistant(tool_calls) 配对完整）才能压缩，
      // 否则下一轮请求会因消息序列不完整被服务端拒绝。
      await this.runCompactIfRequested();
    } catch (e) {
      // 请求失败/中断：在途标记必须清掉，否则之后的请求边界不再刷新提示词。
      this.requestInFlight = false;
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
          await this.compactNow({ compactTrigger: "auto" });
          compacted = true;
        } catch (e) {
          // #64：PreCompact 拒绝时不得退化为裁剪（那是破坏历史），本轮明确停止。
          if (signal.aborted) { abortedFlag = true; break; }
        if (e instanceof CompactBlockedError) {
            compactBlocked = e.reason;
            break;
          }
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
          this.dropScopedRulesMessage();
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
      this.dropScopedRulesMessage();
      throw e;
    }
  }

  if (iterations >= maxIter && toolCalls > 0) {
    this.opt.console.warn(
      `已达最大工具迭代次数 ${maxIter}，本轮被截断 —— 上面的回答可能不完整。`,
    );
  }

  // #64：自动压缩被 PreCompact 拒绝 —— 本轮明确停止（不 trim、不重试、不换轮）。
  // 历史与 lastCompact 原样保留；原因必须可见，且按「本轮失败」收口。
  if (compactBlocked !== null) {
    if (this.lastCompact === null) this.lastCompact = previousCompact;
    hadError = true;
    errorMessage = `PreCompact hook 拒绝了自动压缩，本轮已停止：${compactBlocked}`;
    this.opt.console.error(errorMessage);
    this.opt.onEvent?.({ type: "error", data: errorMessage });
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

  // 临时召回消息只服务于本轮：轮末摘除，不进历史、不污染后续轮次
  if (recallMsg) this.dropTransientMessage(recallMsg);
  this.dropScopedRulesMessage();

  this.totalPrompt += promptTokens;
  this.totalCompletion += completionTokens;
  this.totalReasoning += reasoningTokens;

  abortedFlag ||= signal.aborted;
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
    ...(compactBlocked !== null ? { compactBlocked: true } : {}),
  };

  this.opt.onEvent?.({ type: "turn_end", data: this.lastStats });
  this.emitMemoryCapture(turnStart, "turn");
  this.writeTurnLog(this.lastStats);
  // TurnEnd hooks（issue #3）：主代理回合结束（含 -p 单次模式）。
  // 放在统计落定之后 —— hook 拿到的 turn_stats 与 UI/日志看到的是同一份。
  // 返回值非 null = 有 onFailure=block 的 TurnEnd hook 失败：把原因并进
  // errorMessage 并标 hadError，-p 因此以非 0 退出码结束（见 index.ts 的退出码约定）。
  const turnEndFailure = await this.emitTurnEndHooks(this.lastStats);
  if (turnEndFailure !== null) {
    this.lastStats.hadError = true;
    this.lastStats.errorMessage =
      this.lastStats.errorMessage === null
        ? turnEndFailure
        : `${this.lastStats.errorMessage}；${turnEndFailure}`;
  }
  return this.lastStats;
}
