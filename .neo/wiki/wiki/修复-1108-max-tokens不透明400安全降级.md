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

## 推理与依据

- 2026-11-08（session 20261108-182604-smf6ln）：v0.4.79 已补齐 issue #21 的三类防护：①启动时由 `auditMaxTokens` 逐 provider 检查 `max_tokens` 是否达到或超过 context window、或超过 max output tokens；仅在双方上限明确时判定，避免对缺少元数据的网关误报。②不可解析上限的 opaque 400 在排除上下文超长、鉴权和 parallel 拒绝后，将 `max_tokens` 降为 8192 并仅重试一次；恒定 400 时总请求数恰为 2，降级值只影响本次请求，不写入 `learnedMaxTokens`。③400/422 错误保留原文并追加 max_tokens 提示，配置示例补充 `max_tokens_note` 与“max_output_tokens 不是上下文窗口”的说明。

交付位于分支 `fix/issue21-max-tokens-safety`，基点 `d9d1117`，代码提交 `9b06f98`（8 文件，+741/-8），尚未 push、尚未合入 main；合并方应只 cherry-pick 此代码提交。主工作树中的 wiki 提交 `6c3064f` 已同时位于 main，不要 rebase/reset，也不要重复合入。

验证结果：TypeScript 检查 0 错误；`bun test` 1704 pass / 0 fail（93 文件，新增 28 用例）；`scripts/verify.sh` ALL GREEN，PTY 24/24；证据位于 `docs/evidence/v0.4.79-{tsc,tests,pty}.txt`。PRD 已按约定改名并加 `[done]`，发布说明为 `docs/release-notes/v0.4.79.md`，版本号仅修改 `package.json` 为 0.4.79。

## 推理与依据

- 2026-11-08（session 20261108-180540-w6ssty）：**#21 已修复并合入 main（v0.4.79，提交 9b06f98）**。本页开头的结论（v0.4.75 只修好「网关明说上限」那一类、原症状仍在）**在 v0.4.79 后不再成立**，现补记落地结果：
  - **A 启动告警**：`src/config.ts` 新增导出纯函数 `auditMaxTokens(providers)`，加载配置时逐 provider 判定两条判据 —— `max_tokens ≥ context_window`（issue #21 原始事故 512000/512000 即此形态）、`max_tokens > max_output_tokens`（已声明的模型单次输出上限）。**双方非 null 才判**（瘦网关没声明就不猜）；**只告警不改配置**（用户配的是意图，neo 不替用户改文件）；启动块逐条 `ui.warn` 摆出。模板默认 8192/200000 两条都不命中，正常配置不误报。
  - **B 不透明 400 安全降级**：`src/llm.ts` 新增 `OPAQUE_400_DOWNGRADE_FLOOR = 8192` 与导出纯函数 `shouldDowngradeForOpaque400(err, sent)`。触发条件**全部满足才降级**：status===400（401/403/404/5xx 各走各路）、`parseMaxTokensLimit` 返回 null（能解析的走 v0.4.75 学习机制）、非上下文超长文案、非鉴权文案、非 `parallel_tool_calls` 拒绝（那是 issue #11 的降级路径，不能被抢）、当前值 > 8192（**只降不升**）。降级后夹到 8192 **重发一次**（不循环、不占协议回退预算），chat 与 chatStream 双路径同口径。**降级值仅本次请求内生效，刻意不写 `learnedMaxTokens`** —— 网关明说的上限是稳定陈述可记忆，不透明 400 只是单次观察（可能是限流、抖动、请求体其它字段），固化会永久污染该 provider+model。
  - **取值理由**：8192 = settings.example.json 的默认 max_tokens（本项目既有保守默认，不引入第三个魔数）；**刻意不用 contextWindow 比例** —— 探测兜底的 200,000 不是事实，拿猜测当基数只会放大猜测。
  - **C 文案与模板**：400/422 报错追加一行指向 max_tokens 的提示（**不改写原始文案**，鉴权类与 parallel 拒绝不加）；`settings.example.json` 新增 `max_tokens_note` 写明「输出预算 ≠ 上下文窗口」，`capability_note` 补「max_output_tokens 也不是上下文窗口」。
  - 验收：新增 `tests/max-tokens-safety.test.ts` 28 用例；tsc 零错误；**全量 1704 pass / 0 fail（93 文件）**；verify.sh ALL GREEN（PTY 24/24）。

- 2026-11-08（session 20261108-180540-w6ssty）：**同日连带的另一条修复 —— 测试闸门加 skip 守卫**（issue #26 审计连带项，提交 65d2a11，已合入）。`scripts/verify.sh` 新增 `check_test_skips`：bun test 有 skip 时退出码仍是 0，`run_stage` 只看退出码 ⇒ **ALL GREEN 不代表覆盖完整**。现 skip>0 时告警并逐条列出所在文件，`NEO_STRICT_SKIPS=1` 可令其直接 fail；skip=0 静默（主仓默认路径不受影响）。配套：`tests/file-index.test.ts:149` 的 `if (!git) return;` 改 `test.skipIf(!git)`（原写法是**静默通过**，与本仓「环境坏了必须 fail」纪律冲突）；`tests/prompt-tiers.test.ts` 的 `SOURCE_DIR` 支持 `NEO_BOT_COMMENTS_DIR` 注入（显式指定却找不到文件直接 throw fail —— 配置错误必须被看见）；`tests/README.md` 基线与清单补真。
  - **一个仍然存在的盲区**（未修，记录在案）：「提示词与源文件逐字一致」这 3 条在**任何 worktree 布局下都会 skip**（SOURCE_DIR 指向仓库父目录的 bot-comments）。契约的验证义务落在有源文件的机器上，靠 `NEO_BOT_COMMENTS_DIR` 注入 + `NEO_STRICT_SKIPS=1` 强制零跳过。**「bot-comments 是否纳入版本控制」仍待人工拍板** —— 它是仓库外的兄弟目录，而这恰是最重要的契约被最常跳过的那条。

- 2026-11-08（session 20261108-180540-w6ssty）：**issue #20 完成度审计结论（Oracle 只读审计，建议可关闭）**。8 个注意项逐条核实全部完成：非交互审批措辞（tiers.ts 三档正文「缺批准就先询问；不能交互则只做可逆准备并停止」）、模型行无推理断言（`src/prompt/modelLine.ts:5-6`）、子代理独立构建且默认 mini（`src/tools/task.ts:233-253`，requiredTier 放不下时抛 ToolError 交回主代理收窄任务，不降控制要求）、启动探针只改 cfg 不改 messages[0]（v0.4.70 设计，统一在 send() 请求边界重渲染）、`resolveContextWindow` 兜底保留 source（`contextWindow.ts:13/52/56`，`select.ts:69-78` 对 source=default 永不信 → 按 unknownWindowBudget=8192 保守 mini）、PromptManager 指纹统一重渲染（manager.ts:135-148 含 sessionName/memory/model/provider/tier/contextWindow/source/systemPrompt/toolNames）、rename 后 sessionName 同步 + 子代理身份句、资料来源标注与 schema 计入动态开销（tokens.ts:37-46 保守估算 + 20% 余量）。验收矩阵各项有测试映射，相关测试 121 pass / 0 fail。
  - 审计发现的**唯一真实薄弱点**：提示词正文（审批措辞等关键句）**没有内容断言测试** —— 若有人误改 tiers.ts 的审批/边界措辞，本机与 CI 都不会拦（v0.4.66 该提交 0 个测试文件，遗留至今）。建议拆小 issue：把三档源文件纳入仓库，或加内容快照断言。**未发现「闸门停跑期间漏拦、现在仍在」的功能性缺陷**。
  - 附带两个非阻塞建议：turn 级临时消息（recall/budgetMessage/planMode）不计入选档预算（属对话历史管理范畴，是取舍不是缺陷）；wiki 索引节可补「资料」标注（只含主题名清单，风险低）。
