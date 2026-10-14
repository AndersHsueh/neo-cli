/**
 * Agent 循环：user → LLM → tool_calls → 执行 → 回填 → LLM → …
 *
 * 上下文控制：
 *  - 每轮前估算 token，超阈值触发 /compact（把旧消息总结成一条 system 摘要）。
 *  - reasoning_content 不入历史，避免思维链污染后续轮次。
 */
import { chatStream, estimateTokens, LLMError, type Message, type ToolSpec } from "./llm.ts";
import type { Config } from "./config.ts";
import { Console } from "./ui/console.ts";
import { StreamFormatter } from "./ui/stream.ts";
import { renderMarkdown } from "./ui/render.ts";
import { c, colorEnabled } from "./ui/theme.ts";
import { dispatch, toolSpecs, toolNames, type ToolCtx } from "./tools/index.ts";

export type PermissionMode = "ask" | "auto-edit" | "auto-all" | "plan";

export interface AgentEvent {
  type:
    | "text"
    | "reasoning"
    | "tool_start"
    | "tool_end"
    | "turn_end"
    | "error"
    | "compact"
    | "aborted";
  data?: unknown;
}

export interface AgentOptions {
  cfg: Config;
  console: Console;
  mode: PermissionMode;
  systemPrompt: string;
  onEvent?: (e: AgentEvent) => void;
}

export interface TurnStats {
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  iterations: number;
  finishReason: string | null;
  aborted: boolean;
}

export class Agent {
  messages: Message[] = [];
  mode: PermissionMode;
  private abort: AbortController | null = null;
  private totalPrompt = 0;
  private totalCompletion = 0;
  private totalReasoning = 0;
  private lastStats: TurnStats | null = null;

  constructor(private readonly opt: AgentOptions) {
    this.mode = opt.mode;
    this.messages = [{ role: "system", content: opt.systemPrompt }];
  }

  get stats(): TurnStats | null {
    return this.lastStats;
  }

  get cumulative(): { prompt: number; completion: number; reasoning: number } {
    return { prompt: this.totalPrompt, completion: this.totalCompletion, reasoning: this.totalReasoning };
  }

  get historyLength(): number {
    // 不含 system
    return Math.max(0, this.messages.length - 1);
  }

  cancel(): void {
    this.abort?.abort();
  }

  reset(keepSystem = true): void {
    const sys = this.messages[0];
    this.messages = keepSystem && sys?.role === "system" ? [sys] : [];
  }

  /** 把当前非 system 消息替换为一段摘要。 */
  async compact(): Promise<boolean> {
    const convo = this.messages.slice(1);
    if (convo.length < 4) return false;

    const convoText = convo
      .map((m) => {
        if (m.role === "assistant" && m.tool_calls?.length) {
          const calls = m.tool_calls
            .map((tc) => `${tc.function.name}(${truncateArgs(tc.function.arguments)})`)
            .join("; ");
          return `assistant(tool_call): ${calls}`;
        }
        if (m.role === "tool") return `tool(${m.name ?? ""}): ${truncateArgs(m.content ?? "")}`;
        return `${m.role}: ${truncateArgs(m.content ?? "")}`;
      })
      .join("\n");

    const convoTokens = estimateTokens(convo);
    const budget = Math.min(12_000, Math.floor(this.opt.cfg.contextWindow * 0.2));    const prompt =
      `请把下面的对话历史压缩成一份结构化摘要，供后续继续工作使用。\n` +
      `必须保留：用户的目标与明确要求、已确定的事实与结论、已改动的文件路径、关键代码片段、待办事项与未解决问题。\n` +
      `丢弃：寒暄、重复内容、冗长的工具原始输出。\n` +
      `输出纯文本摘要，不要加前言。\n\n【对话历史】\n${convoText}`;

    try {
      const res = await chatStream(
        { ...this.opt.cfg, maxTokens: budget, temperature: 0.2 },
        [
          { role: "system", content: "你是压缩器，只输出结构化摘要。" },
          { role: "user", content: prompt },
        ],
        [],
        {},
      );
      if (!res.content.trim()) return false;

      const sys = this.messages[0];
      this.messages = [
        ...(sys ? [sys] : []),
        { role: "user", content: `<对话摘要>\n${res.content.trim()}\n</对话摘要>` },
      ];
      this.opt.onEvent?.({ type: "compact", data: { beforeTokens: convoTokens, afterTokens: estimateTokens(this.messages) } });
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

  /** 发送一条用户消息并跑完整个 agent 循环。 */
  async send(userInput: string): Promise<TurnStats> {
    const started = Date.now();
    this.abort = new AbortController();
    const signal = this.abort.signal;

    this.messages.push({ role: "user", content: userInput });

    const specs: ToolSpec[] = toolSpecs();
    let toolCalls = 0;
    let finishReason: string | null = null;
    let iterations = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let hadError = false;

    for (let iter = 0; iter < this.opt.cfg.maxToolIterations; iter++) {
      iterations++;
      if (signal.aborted) break;

      // 上下文超阈值 → 自动压缩
      const usage = estimateTokens(this.messages, specs) / this.opt.cfg.contextWindow;
      if (usage > this.opt.cfg.compactThreshold && this.messages.length > 6) {
        this.opt.console.info(`上下文使用率 ${(usage * 100).toFixed(0)}%，自动压缩中…`);
        await this.compact();
      }

      // ---- 发起一次流式请求 ----
      const reasoningOpen = { open: false };
      const answerFmt = new StreamFormatter({ colorize: colorEnabled() });
      let answerOpen = false;

      try {
        this.opt.console.startSpinner("连接中…");

        const res = await chatStream(
          this.opt.cfg,
          this.messages,
          specs,
          {
            onReasoning: (d) => {
              if (!this.opt.cfg.showReasoning) return;
              this.opt.console.stopSpinner();
              if (answerOpen) return; // 正文已开始，思维链增量忽略
              if (!reasoningOpen.open) {
                this.opt.console.beginStream("reasoning");
                reasoningOpen.open = true;
              }
              this.opt.console.writeStream(d, "reasoning");
              this.opt.onEvent?.({ type: "reasoning", data: d });
            },
            onContent: (d) => {
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
              this.opt.onEvent?.({ type: "text", data: d });
            },
          },
          signal,
        );

        this.opt.console.stopSpinner();
        if (reasoningOpen.open) {
          this.opt.console.endStream("reasoning");
          reasoningOpen.open = false;
        }
        if (answerOpen) {
          answerFmt.finish();
          answerOpen = false;
        }

        if (res.usage) {
          promptTokens += res.usage.prompt_tokens ?? 0;
          completionTokens += res.usage.completion_tokens ?? 0;
          reasoningTokens += res.usage.completion_tokens_details?.reasoning_tokens ?? 0;
        }
        finishReason = res.finishReason;

        // ---- 无工具调用 → 本轮结束 ----
        if (res.toolCalls.length === 0) {
          if (res.content.trim() === "" && res.reasoning.trim() !== "") {
            this.opt.console.info("模型只返回了思维链，没有正文。");
          }
          // 若模型产出了 reasoning 但没有 content，且没有工具调用，不写入空消息
          const hasBody = res.content.trim().length > 0;
          this.messages.push({
            role: "assistant",
            content: hasBody ? res.content : "",
          });
          break;
        }

        // ---- 有工具调用 ----
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
          this.opt.console.toolResult(r.output, 16);
          this.opt.onEvent?.({ type: "tool_end", data: { name, ok: r.ok, truncated: r.truncated } });

          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: r.output,
          });
        }
      } catch (e) {
        this.opt.console.stopSpinner();
        if (answerOpen) {
          answerFmt.finish();
          answerOpen = false;
        }
        this.opt.console.ensureStreamClosed("answer");
        this.opt.console.ensureStreamClosed("reasoning");

        if (e instanceof LLMError || (e as Error).name === "AbortError") {
          const err = e as Error;
          if (err.name === "AbortError" || signal.aborted) {
            this.opt.onEvent?.({ type: "aborted" });
            this.lastStats = {
              durationMs: Date.now() - started,
              promptTokens,
              completionTokens,
              reasoningTokens,
              toolCalls,
              iterations,
              finishReason: "aborted",
              aborted: true,
            };
            return this.lastStats;
          }
          hadError = true;
          this.opt.console.error(`LLM 请求失败: ${err.message}`);
          this.opt.onEvent?.({ type: "error", data: err.message });
          break;
        }
        throw e;
      }
    }

    if (iterations >= this.opt.cfg.maxToolIterations && toolCalls > 0) {
      this.opt.console.warn(`已达最大工具迭代次数 ${this.opt.cfg.maxToolIterations}，停止。`);
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
      aborted: false,
    };
    this.opt.onEvent?.({ type: "turn_end", data: this.lastStats });
    void hadError;
    return this.lastStats;
  }

  private makeCtx(signal: AbortSignal): ToolCtx {
    const mode = this.mode;
    const ui = this.opt.console;
    return {
      cfg: this.opt.cfg,
      signal,
      approve: async (tool, detail) => {
        if (mode === "auto-all") return true;
        if (mode === "auto-edit" && tool !== "shell") return true;
        if (mode === "plan") {
          ui.warn(`plan 模式禁止 ${tool}：${detail}`);
          return false;
        }
        return ui.confirm(`${tool} — ${detail}`);
      },
      onNotice: (m) => ui.info(m),
    };
  }
}

function truncateArgs(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function previewArgs(s: string): string {
  return truncateArgs(s, 100);
}

/** 渲染一次完整的助手回答（用于历史回放 / 导出）。 */
export function renderFinal(md: string, width = 100): string {
  return renderMarkdown(md, width);
}

export { c, toolNames };
