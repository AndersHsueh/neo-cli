# 修复-1108-max-tokens不透明400安全降级

> 最后更新:2026-11-08

## 摘要

对 issue #21（max_tokens 超网关上限导致整个会话发不出请求）的核查结论：**v0.4.75 只修好了一半，#21 不能关**。已实测确认 `parseMaxTokensLimit` 对 issue 里那条真实 400 文案返回 null，因此既不夹紧也不重发；而 400 不在可重试状态里，于是原症状（会话完全发不出请求）依然存在。另有两项期望从未落地：加载配置时对不合理 max_tokens 无告警、400 文案不提 max_tokens。已派会话补齐（v0.4.79）。

## 背景

issue #21（2026-11-07）报：settings.json 里某 provider 把 max_tokens 配成与 context_window 相同的值（512000），网关对每个请求回 400「request was rejected by an internal MaaS component」，`neo -p` 全部失败。期望三条：加载配置时对明显不合理的值告警或钳制；400 时错误信息提示检查 max_tokens；settings.example.json 写清「这不是上下文窗口」。验收口径为「配置 max_tokens: 512000 时启动有告警，或请求自动降级到安全值」。

2026-11-08 v0.4.75 提交了「按模型学习 max_tokens 上限」，容易被误读为 #21 已修，故本次做专项核查。

## 已核实的代码事实

- `src/llm.ts:221-244` `parseMaxTokensLimit`：只在 status ∈ {400, 422}、且文案同时含 max tokens 语义与可解析的上限数字时才返回值；上下文超长文案、鉴权错误、非 4xx 一律不认。
- `src/llm.ts:438-440` `isRetryableStatus`：可重试集合为 undefined / ≥500 / 若干特定状态，**400 不在其中**。
- `src/llm.ts:499-511`：仅当 `parseMaxTokensLimit` 返回非 null 时才学到上限、夹紧并同轮重发一次。
- `src/config.ts`：全文无任何 `maxTokens` 与 `contextWindow` 的比较 —— 加载期没有任何针对不合理值的告警或钳制。

## 实测结果

以探针直接调用 `parseMaxTokensLimit`（status=400，sent=512000）：

| 文案 | 结果 |
| --- | --- |
| `request was rejected by an internal MaaS component` | null —— 不解析、不夹紧、不重发 |
| `invalid params, request was rejected by an internal MaaS component` | null —— 同上 |
| `does not support max tokens > 196608` | 196608 —— 正常夹紧 |

即 v0.4.75 的学习机制依赖「网关明说上限」。issue 报的那种不透明 400 走不进去。

## 结论

1. **#21 不能关**：原症状（会话完全发不出请求）在 issue 描述的网关行为下依然复现。
2. v0.4.75 的修复本身有效且有价值 —— 它覆盖的是「网关明说上限」这一类，属于真实进展，不是白做；只是不完整。
3. 剩余缺口三条，与 issue 原始期望一一对应：
   - 加载期对不合理 max_tokens（≥ context_window，或 > 已知 max_output_tokens）告警；
   - 解析不出上限的不透明 400，允许一次安全降级重发（硬约束：一次上限、不循环、不吞 401/403/404/5xx、上下文超长与鉴权类不降级、降级后仍失败要透传原始文案）；
   - 400 报错文案追加指向 max_tokens 的提示；settings.example.json 补写「max_tokens 是本次请求的输出预算，不是上下文窗口」。
4. settings.example.json 现状：`capability_note` 只讲清了 `max_output_tokens ≠ max_tokens`，**未**写明 max_tokens 与上下文窗口的关系 —— 半条，不是全条。

## 关联

- [[修复-1108-worktree路径realpath不对称]] —— 同一轮核查中发现的另一处既有失败
- [[跨会话消息-v0.2.0]] —— 派活通道
