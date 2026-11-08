# neo max_tokens 安全防护 — PRD

> 版本：v0.4.79 - fix/issue21-max-tokens-safety
> 类型：缺陷修复 + 防护增强
> 来源：AndersHsueh/neo-cli#21（请求 max_tokens 超过网关上限时缺少防护，导致整个会话无法发出请求）
> 基线：main = d9d1117（v0.4.76）
> 日期：2026-11-08

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 一句话 | 配置了明显不合理的 max_tokens 时启动即告警；网关回「解析不出上限的不透明 400」时，同轮安全降级一次重发，不再让整个会话发不出请求 |
| 对标 | v0.4.75 的「网关明说上限」学习机制（parseMaxTokensLimit）只覆盖了一类网关；本版补齐另一类 |
| 改动文件 | src/config.ts（告警）、src/llm.ts（降级 + 提示行）、src/index.ts（告警打印）、settings.example.json（说明补全）、tests/（新增用例） |
| 明确不做 | 不改写用户配置文件；不碰 overflow 恢复（上下文超长）；不碰 401/403/404/5xx 的既有语义；降级不落盘、不记忆 |
| 降级取值口径 | 8192（settings.example.json 的默认 max_tokens，保守且与模板默认一致）；仅当当前值 >8192 时才降级，否则原样透传 |

---

## 1. 背景

### 1.1 issue 现象

settings.json 里某 provider 把 `max_tokens` 配成与 `context_window` 相同的值（512000）。网关对每个请求都返回 400 `"request was rejected by an internal MaaS component"`，`neo -p` 全部失败，分类器切档后也一样。curl 对比验证：不带 max_tokens 和 16384 都返回 200，512000 返回 400。

### 1.2 为什么 v0.4.75 没修完

v0.4.75 的 `parseMaxTokensLimit`（src/llm.ts:221-244）只在 400/422 且文案**同时**含 max tokens 语义与可解析上限数字时才认。实测探针：

- `"request was rejected by an internal MaaS component"` → null（不解析，不触发夹紧）
- `"does not support max tokens > 196608"` → 196608

而 400 不在 isRetryableStatus（src/llm.ts:438-440）里 → 不重试。结论：v0.4.75 只修好了「网关明说上限」的那一类；issue 报的原症状（网关回不透明 400 → 整个会话发不出请求）依然存在。

issue 的另外两项期望也未落地：

- 加载配置时对不合理 max_tokens 无任何告警（src/config.ts 无任何 maxTokens vs contextWindow / maxOutputTokens 的比较）。
- 400 报错文案不提 max_tokens；settings.example.json 的 capability_note 只讲清了 max_output_tokens ≠ max_tokens，未写明 max_tokens 不是上下文窗口。

## 2. 目标与非目标

### 2.1 目标

1. **A 启动期告警**：加载配置时，若某 provider 的 max_tokens 明显不合理，给出明确告警并指出是哪个 provider/字段。
2. **B 不透明 400 的安全降级**：400 文案解析不出上限时，允许**只降级一次**：把 max_tokens 夹到安全值后重发同一请求，并给用户一条 onNotice。
3. **C 错误文案与模板说明**：400 报错文案在不改写原始文案的前提下追加一行指向 max_tokens 的提示；settings.example.json 补清 max_tokens 语义。

### 2.2 非目标

- 不自动改写用户 settings.json（告警不夹紧配置；降级是运行时行为，不落盘）。
- 不碰上下文超长（context length / prompt too long）——那是 agent 的 overflow 恢复管的。
- 不碰 401/403/404/5xx 的既有语义（鉴权错误、端点不存在、服务端故障各走各的路径）。
- 不做「逐请求自适应搜索上限」（二分探测）——一次降级 + 既有学习机制已覆盖绝大多数场景，搜索会放大故障窗口。

## 3. 设计

### 3.1 A：启动期告警（src/config.ts + src/index.ts）

纯函数 `auditMaxTokens(providers: ProviderConfig[]): string[]`：对每个 provider 独立判断，规则：

1. `max_tokens ≥ context_window`（两者都非 null）→ 告警「请求输出预算 ≥ 上下文窗口，网关/模型几乎必然拒绝」。
2. `max_tokens > max_output_tokens`（两者都非 null）→ 告警「超过已声明的模型单次输出上限」。

判据要点：

- **max_output_tokens 未知（瘦网关）时只按 context_window 判，不猜**。
- **不误报**：settings.example.json 默认 max_tokens=8192 / context_window=200000，8192 < 200000 不命中。任何「max_tokens < context_window 且 ≤ max_output_tokens」的配置都不命中。
- 只告警，不改配置：用户配的是意图，neo 不替用户改文件；网关的真实上限是运行时事实，由 B 的降级机制兜底。

打印位置：src/index.ts 启动块（hooks warnings 同款 `ui.warn`），交互与 -p / 管道模式共用该路径，一次性进程也能看到。

告警文案示例：

```
max_tokens 配置告警：provider "example" 的 max_tokens=512000 ≥ context_window=512000。max_tokens 是本次请求的输出预算，不是上下文窗口；这个值几乎必然被网关/模型拒绝，建议改小（如 8192）。
```

### 3.2 B：不透明 400 的安全降级（src/llm.ts）

**触发条件**（全部满足才降级，封装为导出纯函数 `shouldDowngradeForOpaque400(err, sent)`，chat 与 chatStream 共用）：

1. `err.status === 400`；
2. `parseMaxTokensLimit(err, sent) === null`（文案解析不出上限）；
3. 不是上下文超长文案（context length / prompt too long —— parseMaxTokensLimit 内置该排除，复用其判定）；
4. 不是鉴权类错误（401/403 状态码已被条件 1 排除；文案含 auth/unauthorized/forbidden/api key 的 400 也排除）；
5. 当前生效的 max_tokens > `OPAQUE_400_DOWNGRADE_FLOOR`（=8192，**只降不升**：当前值 ≤8192 时降级没有意义，原样透传）。

**取值口径**：8192 —— settings.example.json 的默认 max_tokens。理由：

- 它是本项目对「保守但可用的输出预算」的既有默认，与模板默认一致，不引入第三个魔数；
- issue 实测：网关对 16384 都返回 200，8192 在任何正常网关下都远低于典型上限；
- 上下文窗口比例（如 4%）依赖 contextWindow 的可信度（探测兜底的 200000 不是事实），而 8192 是静态保守值，不引入对未证实事实的依赖。

**作用域：本次请求内，不记忆**。与 v0.4.75 的 learnedMaxTokens（按 provider|baseUrl|model 记忆）不同：

- learnedMaxTokens 学的是**网关明说的上限**——那是网关的明确陈述，跨请求稳定，记忆是安全的；
- 不透明 400 学到的「8192 能通」只是**一次观察**，不是网关的陈述——网关可能因为别的原因拒绝（限流、内部组件抖动、请求体其他字段），把一次观察固化成该 provider+model 的永久上限，会让后续请求被一个没有依据的值永久污染（比如网关抖动一次，之后整个会话都被夹在 8192）。
- 若网关真的有稳定上限，下一轮请求会再次失败，届时要么文案可解析（走 v0.4.75 学习），要么再降级一次（每轮一次，不循环）——每轮最多多发一个请求，代价可控。

**一次上限**：每个 chatStream/chat 调用内最多降级一次（局部 flag），不许循环。降级后仍失败 → 原始错误透传（不吞、不改写 message 前缀，只保留 3.3 的追加提示行）。

**onNotice 文案**：

```
网关拒绝了原 max_tokens=512000（错误文案里解析不出上限），已降级到 8192 重发（仅本次请求；如持续失败请检查 settings.json 的 max_tokens 配置）。
```

### 3.3 C：400 文案补提示行（src/llm.ts）

在 chatStream/chat 抛出 400 类 LLMError 前，若错误文案不含 max_tokens 字样，追加一行：

```
（提示：部分网关对过大的 max_tokens 会回不透明的 400；请检查 settings.json 里该 provider 的 max_tokens 配置。）
```

- 不改写原始文案（原始 message 原样保留在第一行），只追加一行；
- 只对 400/422 追加，401/403/404/5xx 不加（那些和 max_tokens 无关）；文案含鉴权语义（auth/unauthorized/forbidden/api key）时也不追加，避免误导。

### 3.4 settings.example.json

- 新键 `max_tokens_note`：「这是本次请求的输出预算，不是上下文窗口；超过网关/模型上限会被拒」。
- `capability_note` 补一句：max_tokens 不是上下文窗口。

## 4. 边界与硬约束

1. 一次上限：每个请求最多降级一次，不许循环。
2. 不吞真实错误：降级后仍失败 → 原始 400 文案如实透传（保留追加提示行）。
3. 上下文超长文案一律不降级（overflow 恢复的领地）。
4. 鉴权错误不降级：401/403 状态码天然排除；400 文案含 auth/unauthorized/forbidden/api key 也不降级。
5. 只降不升：当前生效的 max_tokens ≤ 8192 时不降级，原样透传（降级没有意义）。
6. 不改写用户配置文件；降级不落盘、不记忆。
7. 只动 src/config.ts、src/llm.ts、src/index.ts（告警打印）、settings.example.json、相关测试；不碰 src/wiki/、src/worktree.ts、tests/wiki-write.test.ts、tests/worktree.test.ts。

## 5. 新增测试

tests/anthropic-provider.test.ts 扩展（假网关，不触网）：

| # | 用例 | 断言 |
|---|---|---|
| T1 | 启动告警命中 | max_tokens=512000 ≥ context_window=512000 → 告警含 provider 名与字段名 |
| T2 | 启动告警不误报 | 8192/200000 → 无告警；max_tokens < context_window 且 ≤ max_output_tokens → 无告警 |
| T2b | max_output_tokens 未知不猜 | max_tokens=512000，context_window=null，max_output_tokens=null → 无告警 |
| T3 | 不透明 400 降级一次成功 | 网关对 >8192 回不透明 400，对 8192 返回 200 → 内容正确，sent = [512000, 8192] |
| T4 | 降级后仍失败透传原始文案 | 网关恒回不透明 400 → rejects 含原始文案，且 sent = [512000, 8192]（只发两次） |
| T5 | 401/403/上下文超长不降级 | 401/403 状态码、context length 文案 → 不降级，sent = [512000] |
| T6 | 不许循环 | 恒 400 → sent 恰好 2 次，不第三次 |

非流式 chat 与 chatStream 走同一 helper（shouldDowngradeForOpaque400），测试以 chatStream 断言为主，helper 纯函数直测补齐 chat 路径的等价性。

## 6. 验收

- `bun x tsc --noEmit` 零错误；`bun test` 全绿（除 main 上 16 个既有 worktree 失败，与本版无关，回信时如实区分）；
- `bash scripts/verify.sh` ALL GREEN，证据落 docs/evidence/v0.4.79-*；
- issue #21 的三项期望全部落地：启动告警 / 不透明 400 降级 / 文案与模板说明。
