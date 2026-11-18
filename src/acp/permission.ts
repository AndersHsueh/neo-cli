/**
 * ACP 权限桥（issue #60，PRD §2.11）。
 *
 * 职责：把「工具要不要批准」这件事交给编辑器 UI（`session/request_permission`），
 * 并在客户端不可用/失败/超时时**回退到 settings 的权限模式**（`decidePermission`），
 * 绝不因为走 ACP 而放宽。
 *
 * 判定顺序（与 `src/agent/loopSupport.ts` 的 approve 同口径，只是多了一层编辑器）：
 *  1. `decidePermission(mode, tool)` 说 allow（auto-all / auto-edit 的写盘）→ 直接放行，
 *     不问编辑器：settings 已经授权了，再问一遍是噪音；
 *  2. 说 plan → 直接拒绝（只读承诺，编辑器也不能推翻）；
 *  3. 说 needs-confirm → 有编辑器就发 `session/request_permission`；
 *     没有/失败/超时 → 回退到 settings 的 ask 语义（非交互宿主下即拒绝）。
 *
 * `allow_always` / `reject_always` 的记忆范围：本 session 内同一工具，不写 settings。
 *
 * 取消（PRD §2.11）：`session/cancel` 到来时 `abortPending()` 立刻结束在途询问，
 * 以 `cancel` 收尾 —— 用户明确取消，不是客户端失败，因此**不回退 settings**。
 */
import { methods } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { decidePermission } from "../agent/policy.ts";
import type { PermissionMode } from "../agent/types.ts";

/** 编辑器侧权限询问的注入点（server 提供；不提供 = 回退 settings）。 */
export interface PermissionUi {
  request(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}

export type PermissionOutcome = "allow" | "deny" | "cancel";

export interface PermissionBridgeOptions {
  /**
   * 当前权限模式。既可以是值，也可以是取值函数 —— `session/set_mode`（issue #80）
   * 会在会话中途切换档位，闭包必须读到**切换后**的模式，不能是构造时的快照。
   */
  mode: PermissionMode | (() => PermissionMode);
  /** 编辑器 UI；null = 客户端不支持，全部回退 settings。 */
  ui: PermissionUi | null;
  /** 本会话 id：`session/request_permission` 的 `sessionId` 必须是真实值，不能是空串。 */
  sessionId: string;
  /** 单次询问超时（毫秒）。超时按「调用失败」处理 → 回退 settings。 */
  timeoutMs?: number;
  /** 诊断（stderr）。 */
  log?: (message: string) => void;
  /** 本轮是否已被取消（cancel 后不再弹新框）。 */
  isCancelled?: () => boolean;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export interface PermissionBridge {
  /** 判定一次工具调用能不能执行。`toolCall` 是给编辑器看的上下文。 */
  ask(
    tool: string,
    toolCall: { toolCallId: string; title: string; kind: RequestPermissionRequest["toolCall"]["kind"]; locations?: RequestPermissionRequest["toolCall"]["locations"] },
  ): Promise<PermissionOutcome>;
  /**
   * 切换本会话的权限模式（`session/set_mode`，issue #80）。
   *
   * 只改桥自己的判定口径；Agent 侧的模式由调用方同步（两者必须一起改，
   * 否则会出现「工具清单按旧档位、审批按新档位」的第二条旁路）。
   * `always` 记忆不清：它是用户对**某个工具**的明确表态，与档位无关。
   */
  setMode(mode: PermissionMode): void;
  /** 当前生效的权限模式。 */
  currentMode(): PermissionMode;
  /**
   * `session/cancel` 到来时调用：立刻结束正在等的 `session/request_permission`，
   * 以 `cancel` 收尾（不回退 settings —— 用户已经明确取消，不是客户端失败）。
   * 不这样做的话，取消要等到超时（默认 300s）才生效，D5 会挂死。
   */
  abortPending(): void;
  /**
   * 新一轮 `prompt()` 开始时调用（复审 R2）：复位上一轮的取消状态。
   * 只清「本轮已被取消」这个开关，**不**清 `always` 记忆 ——
   * `allow_always` / `reject_always` 的语义是本 session 内有效，跨轮保留。
   */
  resetForTurn(): void;
}

export function createPermissionBridge(opts: PermissionBridgeOptions): PermissionBridge {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** 当前档位：初值是构造时传入的，之后由 `setMode()` 覆盖（issue #80）。 */
  let mode: PermissionMode = typeof opts.mode === "function" ? opts.mode() : opts.mode;
  /** 每次判定都现取：档位可在会话中途被 `session/set_mode` 改掉。 */
  const currentMode = (): PermissionMode => mode;
  /** 本 session 内的「总是允许/总是拒绝」记忆（按工具名）。 */
  const always = new Map<string, "allow" | "deny">();
  /** 在途询问的取消钩子（一次只有一个：工具串行执行，审批不并发）。 */
  let pendingAbort: (() => void) | null = null;
  /** 已被 abortPending 取消过：之后不再弹新框。 */
  let aborted = false;

  const fallback = (tool: string, why: string): PermissionOutcome => {
    const mode = currentMode();
    const decision = decidePermission(mode, tool);
    if (decision.allow) return "allow";
    if (decision.reason === "plan") {
      opts.log?.(`${why}；settings 权限模式 plan 拒绝 ${tool}`);
      return "deny";
    }
    // 回退到 ask：编辑器不在场时没有人能批准，按拒绝处理（不放宽）。
    opts.log?.(`${why}；回退 settings 权限模式 ${mode}，${tool} 未获批准`);
    return "deny";
  };

  return {
    async ask(tool, toolCall) {
      const remembered = always.get(tool);
      if (remembered) return remembered;

      const decision = decidePermission(currentMode(), tool);
      if (decision.allow) return "allow";
      if (decision.reason === "plan") {
        opts.log?.(`settings 权限模式 plan 拒绝 ${tool}`);
        return "deny";
      }
      if (!opts.ui) return fallback(tool, "客户端不支持 session/request_permission");
      if (aborted || opts.isCancelled?.()) return "cancel";

      const params: RequestPermissionRequest = {
        sessionId: opts.sessionId,
        toolCall: {
          toolCallId: toolCall.toolCallId,
          title: toolCall.title,
          kind: toolCall.kind,
          ...(toolCall.locations ? { locations: toolCall.locations } : {}),
        },
        options: [
          { optionId: "allow_once", name: `允许一次（${tool}）`, kind: "allow_once" },
          { optionId: "allow_always", name: `本会话内总是允许（${tool}）`, kind: "allow_always" },
          { optionId: "reject_once", name: `拒绝一次（${tool}）`, kind: "reject_once" },
          { optionId: "reject_always", name: `本会话内总是拒绝（${tool}）`, kind: "reject_always" },
        ],
      };

      let response: RequestPermissionResponse;
      try {
        response = await withTimeout(opts.ui.request(params), timeoutMs, (abort) => {
          pendingAbort = abort;
        });
      } catch (e) {
        if (e instanceof CancelledError) return "cancel";
        return fallback(tool, `session/request_permission 失败：${(e as Error).message}`);
      } finally {
        pendingAbort = null;
      }

      // 等待期间已经被 cancel：即便迟到的 allow 先落到了 Promise，也按取消处理，不得落盘。
      if (aborted || opts.isCancelled?.()) return "cancel";

      const outcome = response.outcome;
      if (outcome.outcome === "cancelled") return "cancel";
      const kind = params.options.find((o) => o.optionId === outcome.optionId)?.kind;
      if (kind === "allow_once") return "allow";
      if (kind === "allow_always") {
        always.set(tool, "allow");
        return "allow";
      }
      if (kind === "reject_always") {
        always.set(tool, "deny");
        return "deny";
      }
      // reject_once 或未知 optionId：一律按拒绝处理（不放宽）。
      return "deny";
    },
    abortPending() {
      aborted = true;
      const abort = pendingAbort;
      pendingAbort = null;
      abort?.();
    },
    setMode(next: PermissionMode) {
      mode = next;
    },
    currentMode,
    resetForTurn() {
      // 只复位「本轮已取消」：`always` 记忆是本 session 级的，不能在这里丢。
      aborted = false;
      pendingAbort = null;
    },
  };
}

/** 被 `abortPending()` 取消的询问：与「调用失败」区分开，不走 settings 回退。 */
class CancelledError extends Error {
  constructor() {
    super("session/request_permission 已被 session/cancel 取消");
    this.name = "CancelledError";
  }
}

/**
 * 超时即视为调用失败（PRD §2.11 的「调用失败/超时 → 回退」）。
 *
 * `register` 把「立刻以 CancelledError 结束」的钩子交给调用方，
 * 供 `abortPending()` 使用；正常结束/超时后钩子即失效。
 */
function withTimeout<T>(p: Promise<T>, ms: number, register?: (abort: () => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`超时 ${ms}ms`))), ms);
    register?.(() => finish(() => reject(new CancelledError())));
    p.then(
      (v) => finish(() => resolve(v)),
      (e: unknown) => finish(() => reject(e as Error)),
    );
  });
}

/** 供 server 复用的方法名常量（避免各处硬编码字符串）。 */
export const REQUEST_PERMISSION_METHOD = methods.client.session.requestPermission;
