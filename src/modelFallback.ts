/**
 * #59 会话级有序模型备用链。
 *
 * 只包装主 Agent 的单次模型请求：每个候选内部仍由 chatStream() 完成同模型重试、
 * 协议端点回退和受控参数降级；耗尽或明确的模型级失败后才进入下一个候选。
 *
 * 不读取 model_routes.*.fallback_allowed（那是档位目标协议不可用时的路由降级），
 * 不做健康探测、自动回切或 settings 写回；候选游标只向后移动。
 * 纯归因函数已晋升到 `@neo/core-compat/compat/v1`；Controller 仍留在旧侧。
 */
import { applyModelTarget, type Config, type ModelTarget } from "./config.ts";
import { chatStream, LLMError, type Message, type StreamHandlers, type StreamResult, type ToolSpec } from "./llm.ts";
import { resolveAndApplyModelWindow } from "./env/modelWindows.ts";
import {
  attributeFailure,
  redactFallbackText,
  type FallbackFailureCode,
} from "@neo/core-compat/compat/v1";
export { attributeFailure, redactFallbackText } from "@neo/core-compat/compat/v1";
export type { FallbackFailureCode, FallbackAttribution } from "@neo/core-compat/compat/v1";

/** 单个候选的失败摘要；message 已脱敏且不超过 240 个 Unicode code points。 */
export interface FallbackFailure {
  target: ModelTarget;
  code: FallbackFailureCode;
  message: string;
}

/** 一次成功切换的公开事件载荷（#37 把它映射为 model_fallback 逻辑事件）。 */
export interface ModelFallbackEvent {
  from: ModelTarget;
  to: ModelTarget;
  reason: FallbackFailure;
  attempts: FallbackFailure[];
}

export interface ModelFallbackOptions {
  /** 会话共享配置对象；只在完整响应成功后原地提交目标。 */
  cfg: Config;
  /** 有序备用链（不含当前主模型）。 */
  fallbacks: readonly ModelTarget[];
  /** 测试注入；缺省真实 chatStream。 */
  stream?: typeof chatStream;
  onFallback?: (e: ModelFallbackEvent) => void;
  onNotice?: (message: string) => void;
}

const EXHAUSTED_MAX = 500;

function abortLike(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * 主 Agent 单请求外层的有限候选遍历。
 *
 * 候选 0 是启动时的主模型；备用链按配置顺序追加，与主模型相同的项跳过。
 * 每次请求从 currentIndex 起、只访问其后的候选，成功即把目标提交进共享 cfg
 * 并保留下标 —— 会话内保持，不自动回切。
 */
export class ModelFallbackController {
  private readonly cfg: Config;
  private readonly fallbacks: readonly ModelTarget[];
  private readonly streamFn: typeof chatStream;
  private readonly onFallback?: (e: ModelFallbackEvent) => void;
  private readonly onNotice?: (message: string) => void;

  private candidates: ModelTarget[] = [];
  private currentIndex = 0;
  private fallbackActive = false;
  /** 最近一次成功提交的身份，用于识别用户显式 /model /provider /tier。 */
  private committed: ModelTarget | null = null;

  constructor(opts: ModelFallbackOptions) {
    this.cfg = opts.cfg;
    this.fallbacks = opts.fallbacks;
    this.streamFn = opts.stream ?? chatStream;
    this.onFallback = opts.onFallback;
    this.onNotice = opts.onNotice;
    const primary: ModelTarget = {
      provider: opts.cfg.providerName,
      model: opts.cfg.model,
    };
    this.rebuild(primary);
    this.committed = { ...primary };
  }

  get isActive(): boolean {
    return this.fallbackActive;
  }

  /** 当前候选顺序（供测试与诊断；不暴露可变内部状态）。 */
  get orderedCandidates(): readonly ModelTarget[] {
    return this.candidates.map((t) => ({ ...t }));
  }

  /** 显式切换身份后重置链；组合根也可在 /model /provider /tier 后调用。 */
  resetForExplicitTarget(): void {
    const primary: ModelTarget = {
      provider: this.cfg.providerName,
      model: this.cfg.model,
    };
    this.rebuild(primary);
    this.currentIndex = 0;
    this.fallbackActive = false;
    this.committed = { ...primary };
  }

  private rebuild(primary: ModelTarget): void {
    const seen = new Set<string>([`${primary.provider}\u0000${primary.model}`]);
    const rest: ModelTarget[] = [];
    for (const t of this.fallbacks) {
      const key = `${t.provider}\u0000${t.model}`;
      if (seen.has(key)) continue; // 与当前主模型相同：跳过，不重复请求
      seen.add(key);
      rest.push({ ...t });
    }
    this.candidates = [{ ...primary }, ...rest];
  }

  /** 请求边界：cfg 的 provider|model 被显式命令改了就重置链。 */
  private syncExplicitChange(): void {
    const c = this.committed;
    if (c && (c.provider !== this.cfg.providerName || c.model !== this.cfg.model)) {
      this.resetForExplicitTarget();
    }
  }

  /** 为候选构造独立请求 cfg；主模型沿用 requestCfg（保留临时预算覆盖）。 */
  private cfgFor(index: number, requestCfg: Config): Config {
    if (index === 0 && this.currentIndex === 0) return requestCfg;
    const next: Config = { ...requestCfg };
    applyModelTarget(next, this.candidates[index]!);
    // 目标窗口/能力按目标 provider 与 env 事实重算，不继承来源模型。
    resolveAndApplyModelWindow(next);
    return next;
  }

  async stream(
    requestCfg: Config,
    messages: Message[],
    tools: ToolSpec[],
    handlers: StreamHandlers = {},
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    this.syncExplicitChange();
    const from: ModelTarget = { ...this.candidates[0]! };
    const attempts: FallbackFailure[] = [];
    const start = this.currentIndex;

    for (let i = start; i < this.candidates.length; i += 1) {
      if (signal?.aborted) throw abortLike();
      const target = this.candidates[i]!;
      let emitted = false;
      // guard 必须包住三类增量 handler，不能只看正文字符数。
      const guarded: StreamHandlers = {
        onReasoning: (d) => {
          emitted = true;
          handlers.onReasoning?.(d);
        },
        onContent: (d) => {
          emitted = true;
          handlers.onContent?.(d);
        },
        onToolCallDelta: (idx, name, args) => {
          emitted = true;
          handlers.onToolCallDelta?.(idx, name, args);
        },
        onNotice: handlers.onNotice,
      };
      try {
        const res = await this.streamFn(
          this.cfgFor(i, requestCfg),
          messages,
          tools,
          guarded,
          signal,
        );
        this.commit(i, target);
        if (attempts.length > 0) {
          this.onNotice?.(
            `[fallback] 已切换到 ${target.provider}:${target.model}（前 ${attempts.length} 个候选失败）`,
          );
          this.onFallback?.({
            from,
            to: { ...target },
            reason: attempts[0]!,
            attempts: attempts.map((a) => ({ ...a, target: { ...a.target } })),
          });
        }
        return res;
      } catch (e) {
        const attributed = attributeFailure(e, emitted, signal);
        if (!attributed) throw e;
        attempts.push({
          target: { ...target },
          code: attributed.code,
          message: attributed.message,
        });
        this.onNotice?.(
          `[fallback] ${target.provider}:${target.model} 失败（${attributed.code}），尝试下一个候选`,
        );
      }
    }

    const summary = attempts
      .map((a) => `${a.target.provider}:${a.target.model}(${a.code}: ${a.message})`)
      .join(" → ");
    const exhausted = new LLMError(
      redactFallbackText(`所有模型候选均失败：${summary}`, EXHAUSTED_MAX),
    );
    exhausted.retryable = false;
    throw exhausted;
  }

  /** 只有完整响应成功后才把目标写进共享 cfg；失败候选不污染当前模型。 */
  private commit(index: number, target: ModelTarget): void {
    this.currentIndex = index;
    this.fallbackActive = index > 0;
    if (index > 0) {
      applyModelTarget(this.cfg, target);
      resolveAndApplyModelWindow(this.cfg);
    }
    this.committed = { provider: target.provider, model: target.model };
  }
}
