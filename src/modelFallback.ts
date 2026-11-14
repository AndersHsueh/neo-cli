/**
 * #59 会话级有序模型备用链。
 *
 * 只包装主 Agent 的单次模型请求：每个候选内部仍由 chatStream() 完成同模型重试、
 * 协议端点回退和受控参数降级；耗尽或明确的模型级失败后才进入下一个候选。
 *
 * 不读取 model_routes.*.fallback_allowed（那是档位目标协议不可用时的路由降级），
 * 不做健康探测、自动回切或 settings 写回；候选游标只向后移动。
 */
import { applyModelTarget, type Config, type ModelTarget } from "./config.ts";
import {
  chatStream,
  isAuthErrorText,
  isContextLengthErrorText,
  isMaxTokensErrorText,
  LLMError,
  LLMTimeoutError,
  type Message,
  type StreamHandlers,
  type StreamResult,
  type ToolSpec,
} from "./llm.ts";
import { resolveAndApplyModelWindow } from "./env/modelWindows.ts";

export type FallbackFailureCode =
  | "network"
  | "timeout"
  | "rate_limit"
  | "server"
  | "model_unavailable"
  | "model_forbidden";

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

const REASON_MAX = 240;
const EXHAUSTED_MAX = 500;

/**
 * 去掉 URL / 常见密钥形态，并按 Unicode code point 截断。
 * 只处理可识别的形态，不宣称能识别任意形态秘密；完整 body 从不进入事件或日志。
 */
export function redactFallbackText(text: string, max: number = REASON_MAX): string {
  const cleaned = text
    .replace(/https?:\/\/[^\s"'<>]+/g, "[URL]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, "[REDACTED]")
    .replace(
      /"?(authorization|api[-_]?key|token|secret|password|cookie|credential)"?\s*[:=]\s*"[^"]*"/gi,
      "[REDACTED]",
    )
    .replace(/\s+/g, " ")
    .trim();
  const cps = Array.from(cleaned);
  return cps.length > max ? `${cps.slice(0, max).join("")}…` : cleaned;
}

interface Attributed {
  code: FallbackFailureCode;
  message: string;
}

/**
 * 从响应里保守识别「明确的模型不存在 / 无权限」。
 * 优先用结构化 error.code/type；只有文本同时含 model 语义与 not-found/no-access 语义时才认。
 */
function explicitModelLevel(err: LLMError): "model_unavailable" | "model_forbidden" | null {
  const body = typeof err.body === "string" ? err.body : "";
  let code = "";
  let type = "";
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; type?: string };
    };
    code = (parsed.error?.code ?? "").toLowerCase();
    type = (parsed.error?.type ?? "").toLowerCase();
  } catch {
    /* 非 JSON body：只走下面的保守文本判定 */
  }
  const structured = `${code} ${type}`;
  if (/model_not_found|model_not_exists|unknown_model|deployment_not_found/.test(structured)) {
    return "model_unavailable";
  }
  if (/model_permission|model_access_denied|model_forbidden|no_access_to_model/.test(structured)) {
    return "model_forbidden";
  }
  const text = err.message.toLowerCase();
  const modelWord = /model|deployment|模型/.test(text);
  const notFound = /not ?found|does ?not ?exist|unknown|不存在/.test(text);
  const noAccess = /permission|forbidden|denied|not ?allowed|无权限|不允许/.test(text);
  if (err.status === 404 && modelWord && notFound) return "model_unavailable";
  if ((err.status === 401 || err.status === 403) && modelWord && noAccess) {
    return "model_forbidden";
  }
  return null;
}

/**
 * 判定一次候选失败是否值得进入下一个候选。null = 不切换，原错误原样抛出。
 *
 * 判定顺序不可颠倒（架构 §3.4）：abort → 已发增量 → 上下文/参数/鉴权 →
 * 明确模型级 → 网络/超时/429/5xx → 其它一律不切换。
 */
export function attributeFailure(
  err: unknown,
  emitted: boolean,
  signal?: AbortSignal,
): Attributed | null {
  if (signal?.aborted) return null;
  const e = err as Error | undefined;
  if (e?.name === "AbortError") return null;
  // 任一 reasoning/content/tool 增量已交付：切换会造成重复正文或重复工具调用。
  if (emitted) return null;

  const llm = err instanceof LLMError ? err : new LLMError(e?.message ?? String(err));
  const explicit = explicitModelLevel(llm);
  if (explicit) {
    return { code: explicit, message: redactFallbackText(llm.message) };
  }
  // 上下文超长、max_tokens 普通参数问题、无效 API key / 普通鉴权失败都不属于模型网关故障。
  if (
    isContextLengthErrorText(llm.message) ||
    isMaxTokensErrorText(llm.message) ||
    isAuthErrorText(llm.message)
  ) {
    return null;
  }
  if (err instanceof LLMTimeoutError || /timeout|timed? ?out|超时/i.test(llm.message)) {
    return { code: "timeout", message: redactFallbackText(llm.message) };
  }
  const status = llm.status;
  if (status === undefined) {
    // 无 HTTP status 的连接 / DNS / socket 错误。
    return { code: "network", message: redactFallbackText(llm.message) };
  }
  if (status === 429) {
    return { code: "rate_limit", message: redactFallbackText(llm.message) };
  }
  if (status >= 500 || status === 408 || status === 409 || status === 425) {
    return { code: "server", message: redactFallbackText(llm.message) };
  }
  // 裸 400/401/403/404 不得仅凭状态码切换。
  return null;
}

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
