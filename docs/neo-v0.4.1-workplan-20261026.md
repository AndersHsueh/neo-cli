# v0.4.1 工作计划：实战可靠性修复 + askUser 特性

> 状态：**已实施完成**（2026-10-27；B1–B5 全部落地，verify ALL GREEN）
> 基线：v0.4.0 · tsc 0 错 · `bun test` **974 pass / 59 文件** · PTY 19/19
> 依据：2026-10-26 两个实战会话（`20261026-143606-ldr92c`、`20261026-171421-ktid2x`）+ 其 journal / capture-log / mailbox state
> 最终版本：**v0.4.1**（用户裁决：语义上按 minor patch 发布，含 askUser 特性）

---

## 0. 目标与边界

### 目标

1. **先保命**：会话不能再出现「跑了几小时、最后一轮无声无息、只能换会话」。
2. **把静默失败变成可诊断失败**：任何异常轮都要有记录、有错误、有状态，不再 `outcome=ok`。
3. **补记忆正确性**：`remember` 不假成功，捕获不再无声丢轮。
4. **工具链实战化**：技能可安装/可发现、大输出可回查、shell 不靠模型猜 cwd、能搜公开信息。
5. **新增 askUser 组件**：模型在关键分叉/歧义/破坏性操作前，用 TUI 向用户提问并拿回结构化答案。
6. 不弱化现有 974 用例语义；新增用例覆盖所有修复点（最终 1027 pass / 66 文件）。

### 不在范围（本次不做）

- 多模态/联网搜索服务商接入（只做最小可用 web_search，见 D3）。
- 重写 agent 主循环 / 引入持久化 shell / daemon。
- ~~外部技能包本身~~：用户已授权修复外部 `karpathy-ax-html/references/extract-assets.sh`（路径拼接 bug）。
- 纯模型行为问题（Python 脚本写错、字体比对绕路）不 hack harness 硬修，只做提示词/流程引导。

---

## 1. 问题 → 修复项映射（15 项全覆盖）

| # | 实战问题 | 类型 | 修复项 | 批次 | 工作量 |
|---|---|---|---|---|---|
| 1 | 收尾轮静默空转、无回复、状态 ok | neo | **A1 轮次诊断 + 空响应硬化** | B1 | M |
| 2 | 184k tokens 未触发压缩，长会话无兜底 | neo | **A2 上下文溢出恢复** | B1 | M |
| 3 | `use_skill` 找不到外部技能（karpathy-ax-html） | neo/配置 | **C1 技能额外路径 + 可发现性** | B3 | S–M |
| 4 | 技能脚本写错 `outputs/outputs/assets` | 外部技能 | **E1 外部技能修补清单**（不进 neo） | B5 | XS |
| 5 | 30k 输出截断丢 70k 字符 | neo | **D1 大输出落盘 + 回查路径** | B4 | M |
| 6 | `remember` 假成功、实际 dropped | neo | **B1 显式记忆同步回执 + 目标页创建** | B3 | M |
| 7 | 记忆捕获缺轮、失败不可见 | neo | **B2 捕获审计全覆盖 + 状态可见** | B3 | S–M |
| 8 | shell cwd 无状态，56/66 条命令手写 cd | neo | **D2 shell cwd 参数 + 提示词纠偏** | B4 | S |
| 9 | 用户要「打探/搜索」，0 次 web_fetch | neo/能力 | **D3 web_search 工具（Bing RSS）** | B4 | M |
| 10 | 主动提议删除 v1 旧交付物 | 模型行为 | **F1 交付物纪律提示词 + askUser 确认** | B5 | S |
| 11 | Excel 模板分组语义没先确认 | 模型行为 | **F1 提示词 + askUser 澄清** | B5 | S |
| 12 | 模型 Python 脚本两次报错 | 模型行为 | 不改代码（提示词里加「先小样本验证」） | B5 | XS |
| 13 | 字体比对绕 4 轮（E5 空单元格假差异） | 模型行为 | 不改代码（同上） | B5 | XS |
| 14 | 旧会话导出只能手读 824KB JSON | neo | **D4 `/export <session-id>`** | B4 | M |
| 15 | 孤儿 mailbox 目录、`.tmp` 中间稿 | neo/杂项 | **F3 启动 GC + tmp TTL** | B5 | S |

> 说明：问题 12/13 是模型行为，本计划**不**用 harness 逻辑硬修；只在系统提示词里加「执行前小步验证 / 空单元格先判空」的流程建议，并在验收里标注「不保证」。

---

## 2. 批次总览

| 批次 | 主题 | 主要交付 | 预估 |
|---|---|---|---|
| **B1** | P0 止血：诊断 + 空响应 + 上下文兜底 | A1、A2 | 1.5–2 天 |
| **B2** | **askUser 特性**（本版核心新功能） | 工具 + TUI 组件 + PTY | 1.5–2 天 |
| **B3** | 记忆正确性 + 技能发现 | B1、B2、C1 | 1–1.5 天 |
| **B4** | 工具实战化 | D1、D2、D3、D4 | 2 天 |
| **B5** | 交付纪律 + 杂项 + 发布 | F1、F3、E1、验证/发布 | 1 天 |

**总计约 7–9 个开发日（按 agent 工作量约 4–6 个会话批次）。**
若求快，MVP 可只做 **B1 + B2 + B1(记忆)** 约 4–5 天，其余下一版。

每批独立 commit；每批结束跑 `tsc + 全量 bun test`；B2 与最终跑 `verify.sh`（PTY）。

---

## 3. B1：会话可靠性（A1 + A2）

### A1. 轮次诊断 + 空响应硬化

**要解决的现象**：17:09「重试」那一轮，mailbox `outcome=ok`、会话无 assistant 消息、无任何错误记录；用户只能放弃会话。

**根因现状**：`src/agent.ts` 的「空正文」分支在 nudge 重试一次后直接放弃，不写 assistant、不置 `hadError`；`src/index.ts` 的 outcome 只看 abort/异常；会话 JSON 不存任何请求/错误元数据。

**方案**：

1. **新增 `src/observe/turnLog.ts`**：每轮追加一行 JSONL（默认 `~/.neo/logs/turns/YYYY-MM-DD.jsonl`，`NEO_LOG_DIR` 可覆盖）：
   - `sessionId/turn/ts/model/provider`、`estimatedPromptTokens`、真实 `usage`、`iterations`、`toolCalls`、`finishReason`、`aborted`、`hadError`、`emptyResponse`、`durationMs`、`contextWindow`、`contextUsage`、`compaction`（前后 tokens）。
   - **不记录 prompt/回答内容**（隐私）；错误信息截断 500 字符。
   - 按天轮转 + 30 天保留 + 单文件 5MB 上限。
2. **`TurnStats` 扩展**：`emptyResponse: boolean`、`contextUsage: number`；`send()` 在 `finally` 写 turnLog（AgentOptions 增加 `sessionId`，index 注入；测试可注入临时日志目录）。
3. **空响应硬化**：
   - `finishReason === "length"`：用 `maxTokens × 2`（封顶配置上限）重试一次；
   - 第二次仍空/只有 reasoning：置 `hadError=true`、`emptyResponse=true`、`errorMessage`（含 finishReason、reasoning 字符数）；**不再静默 `break`**；
   - UI 明确显示「本轮没有产出：…；日志：<path>」；
   - `onEvent` 发 `error`，便于以后 GUI/遥测消费。
4. **outcome 修正**：`src/index.ts` turn 结束时 `stats.hadError || stats.emptyResponse` → `outcome="error"`；mailbox 状态机不再报 ok；`showStats` 显示错误摘要。
5. **会话 meta 增加 `lastTurn`（可选字段，version 1→2 兼容读取）**：`{at, outcome, finishReason, errorMessage?, usage?}`；`/sessions` 对最后一轮失败/空的会话标 ⚠；`--resume` 启动时提示「上轮失败：…；日志 …」。
6. **可选 `/retry` 命令**：重发最后一条 user 输入（仅在上一轮 error/empty 时有效，避免误重放）。建议做，成本约 0.2 天。

**涉及文件**：`src/agent.ts`、`src/index.ts`、`src/session.ts`、`src/config.ts`、新增 `src/observe/turnLog.ts`、`src/system-prompt.ts`（提示 `/retry` 可选）、`src/input/commands.ts`、`tests/commands.test.ts`。

**测试**：
- `tests/turn-reliability.test.ts`：fakeStream 返回空 content（stop/length）→ `hadError/emptyResponse`、无 assistant 消息、turnLog 写入；正常轮不误报；session meta `lastTurn` 保存/读取；resume 告警格式。
- 真实会话日志回归：用今天的 session 1 消息做「只读回放诊断」（不请求模型）校验估算与格式化。
- `tests/session*.test.ts` 补 meta version 2 兼容。

**验收**：
- 构造「空响应两次」场景，UI 有明确错误、日志可查、mailbox outcome=error、会话可继续（不静默）。
- 不再出现「user 消息后没有 assistant 且无任何错误记录」的终态。

### A2. 上下文溢出恢复

**要解决的现象**：184k tokens 未压缩（配置 512k × 0.75 = 384k 才触发）；若模型真实窗口小于配置，直接 400/空转。

**方案**：

1. **`src/llm.ts`** 导出 `isContextOverflowError(err)`：`status 400/413/422` + 消息正则（context length / maximum tokens / prompt too long / exceed）；仅这类错误触发恢复，避免误伤普通 400。
2. **`src/agent.ts` 发送循环**：
   - 捕获到 context overflow 且本轮未恢复过 → `compactNow({force:true, reason:"overflow"})`，输出提示「上下文超限，压缩后重试」，**同一轮重试一次**；
   - 若历史太短/压缩失败 → `trimOldestToolOutputs()`（保留最近 6 条，把更早 tool 结果替换为占位摘要）后重试；
   - 仍失败 → `hadError` + 明确提示「检查 settings.context_window 与模型实际窗口」。
3. **预检**：请求前估算 `estimateTokens + maxTokens + 安全余量 > contextWindow` → 提前压缩（安全余量可配 `context_safety_margin`，默认 5%）。
4. **`/context` 命令**：显示 provider/model、配置 `context_window`、估算 tokens、使用率、最近一次压缩前后、触发阈值；用于一眼发现配置与真实窗口不一致。
5. **配置**：`settings.example.json` 增加 `context_safety_margin`；不改变现有默认行为。

**涉及文件**：`src/llm.ts`、`src/agent.ts`、`src/config.ts`、`src/index.ts`、`src/input/commands.ts`、`settings.example.json`。

**测试**：
- `tests/context-recovery.test.ts`（Bun.serve）：第一次返回 400 `context length exceeded`，第二次 200 → 断言发生压缩且重试成功；第二次仍 400 → 错误可读、不无限循环；非 context 400 不触发压缩。
- 预检触发：小窗口 cfg + 长历史 → 请求前 compact。
- `/context` 格式化单测。

**验收**：模拟「实际窗口 200k、配置 512k」场景，溢出后能自动压缩并完成本轮；失败时错误明确、日志完整。

---

## 4. B2：askUser 特性

### 4.1 定位

模型在以下场景主动向用户提问，并在 TUI 里用**可视化选项组件**收集答案：

- 业务口径/模板结构有歧义（如今天的报价小计分组）；
- 删除/覆盖交付物等破坏性动作前的确认；
- 需要用户做一次分叉选择（方案 A/B、数据源选择）。

不是审批（`approve` 仍是 y/N 权限），不是 `/model` 这类设置菜单；是 **agent 工具**。

### 4.2 交互契约（TUI）

- 打开时：暂停 spinner，输入框上方/原位显示：
  - 标题「提问」+ 可选 `header`
  - 问题正文（按宽度换行，CJK 安全）
  - 可选 `context`（暗色小字）
  - 选项列表：`❯` 光标、label + 可选 description（第二行缩进、暗色、窄屏截断）
  - 底部提示：`↑↓ 选择 · Enter 确认 · Esc 取消`（多选时 `Space 勾选`）
- 键盘：`↑/↓` 移动（clamp，不循环）；`Enter` 确认；`Esc` 取消；`1-9` 数字直选（可选）；多选时 `Space` 切换勾选、`Enter` 提交。
- **自由输入**：`allow_custom`（默认 true）时选项末尾自动加「其他（自行输入）」；选中后切到现有 `ask` 文本模态，Enter 提交。
- **纯文本问题**：`options` 为空时直接进文本模态。
- 高度/宽度：最多 10 个选项 + 问题/描述；超宽截断带省略号；超窄（COLUMNS=60）不折行溢出；不启用 alt-screen，历史保留。
- 回答后：问题+答案定格进 scrollback（可回看），恢复 busy 状态。
- **状态条**：显示「等待回答」，`Ctrl+C` 第一次取消提问（返回 canceled，模型可继续/换问法），第二次按现有语义退出/中断本轮；`Esc` 只取消提问。
- 非 TTY / `-p`：**不注册**该工具（模型看不到），不弹窗；若历史会话恢复出该工具调用（不会发生），返回错误。

### 4.3 工具契约

工具名：`ask_user`（主代理可见；子代理排除）。

参数（JSON Schema）：

```json
{
  "question": "string，必填，≤200 字",
  "header": "string，可选，≤12 字",
  "context": "string，可选，≤400 字（为什么问、影响什么）",
  "options": [
    { "label": "string ≤40", "description": "string ≤120，可选" }
  ],
  "multi_select": "boolean，默认 false",
  "allow_custom": "boolean，默认 true"
}
```

约束：
- `options` 0–5 个；有 options 时 label 必须唯一、非空；
- `multi_select` 为 true 时至少选 1 项才能提交（Esc 取消除外）；
- 每轮最多提问 `ask_user.max_per_turn`（默认 3，settings 可配），超出返回错误；
- 不允许模型传默认答案/超时自动选，必须人类输入；
- `-y` / `auto-all` 不自动作答。

返回值（工具结果字符串，JSON）：

```json
{"status":"answered","selected":["选项A"],"custom":null}
{"status":"answered","selected":[],"custom":"用户自由输入"}
{"status":"canceled"}
```

### 4.4 实现拆分

| 层 | 文件 | 内容 |
|---|---|---|
| 纯 UI 状态机 | 新增 `src/ui/askUser.ts` | `AskUserState`（cursor/scroll/selected/customMode）、`reduceAskUser`、`layoutAskUser`（宽度/高度/换行）；可 bun test 直测的纯函数 |
| TUI 组件 | `src/tui/composer.ts` | 新 `mode: "ask_user"`；`askUser(req)` Promise；复用 `composeSelect` 的框线/滚动思路 + 现有 `ask` 文本模态；`Esc`/`Ctrl+C`/resize/窄屏 |
| 工具实现 | 新增 `src/tools/askUser.ts` | schema 校验、max/turn 计数、返回 JSON、无 host 时错误 |
| 接线 | `src/tools/types.ts` / `src/agent.ts` / `src/ui/console.ts` / `src/index.ts` | `ToolCtx.askUser?`；`AgentOptions.askUser?`；`AgentIO.askUser?`（可选，避免破坏测试 fake）；index 仅在交互 TTY 注册工具并注入 `composer.askUser` |
| 提示词 | `src/system-prompt.ts` | 工具说明 + 使用纪律（只在真需要时问；一次一个问题；选项具体；破坏性/歧义优先问） |
| 排除 | `src/tools/index.ts` | `TOOL_NAMES_EXCLUDED_FOR_SUBAGENT` 加 `ask_user` |
| 会话 | 无 schema 变更 | 工具调用与答案自然进 messages；`--resume` 回放即可 |

### 4.5 关键边界

- **阻塞语义**：工具 `await` 用户回答；期间 agent 不继续发请求；spinner 暂停；状态条显示等待。
- **abort**：`ctx.signal` 触发时 resolve `canceled` 并关闭模态；agent 按 abort 退出，不把取消当答案。
- **重入保护**：已有模态（审批/选择/提问）时不允许再开；`ask_user` 工具在模态期间不会被并行调用（工具串行）。
- **auto-turn / 跨会话**：来自 mailbox 的自动轮也可提问，但状态条标注来源；人类输入始终优先。
- **隐私**：问题与答案进 session JSON（用户自己的会话数据），与现有消息一致；不写额外日志内容。
- **无 TUI 兜底**：`interactiveTTY=false` 时工具不注册（不是运行时才报错），`-p` 的 tool 列表断言覆盖。

### 4.6 测试与 PTY

- `tests/ask-user-tool.test.ts`：schema 校验、唯一 label、max/turn、cancel、custom、无 host 错误、子代理排除。
- `tests/ask-user-ui.test.ts`：`reduceAskUser` 上下 clamp/scroll/resize；单/多选；custom 切换；窄屏截断；Esc/Enter 语义。
- `tests/tui-composer.test.ts` 扩展：进入/退出模态、状态条、busy 恢复、resize。
- `tests/cli-json.test.ts`：`-p` 的 `toolNames()` 不含 `ask_user`。
- `scripts/fake-llm.ts` 新增场景 `ask-user`：第一次返回 `ask_user` tool call（2 个选项 + custom），下一次请求根据 tool 结果返回 `ANSWER_OK`。
- `scripts/pty-e2e.ts` 新增 **S20**：启动 → 进入提问 → ↓/Enter 选第二项 → 断言屏幕出现问题/选项/答案 → 模型收到答案（fake-llm 校验）。
- **手工验收**：真实 TUI 提问；`-y` 不自动答；Esc 取消后模型可继续；Ctrl+C 中断；`--resume` 回放。

**工作量**：约 1.5–2 天（纯 UI 状态机 + composer 集成占一半，PTY 场景占 1/4）。

---

## 5. B3：记忆正确性 + 技能发现

### B1. `remember` 同步回执 + 显式记忆目标页

**问题**：`remember` 立即返回「已登记」，异步 distill 失败只写 capture-log（`append 目标页不存在于清单`），用户/模型都不知道。

**方案**：
1. `MemoryEngine.captureExplicit` 返回 `{ recordId, done: Promise<CaptureAudit> }`；Bridge `remember` 改为 `async remember(...)`，等待 `done`（超时默认 20s；超时返回「已排队，结果未确认」）。
2. 工具 `remember` 的 `execute` 改 async：返回真实的 `applied/dropped` 摘要；drop 时附原因 + 建议（如「目标页不存在，已自动创建」或「请换一个主题名」）。
3. **显式记忆走确定性路径**：
   - 跳过价值判定（本来如此），同时跳过 confidence 门槛；
   - `append` 目标页不存在时，在 validate 阶段降级为 `create`（而不是直接 drop）——复用 merge 已有 create 逻辑；
   - 页名由提炼器给出 + 落库前校验；失败时返回可用页名建议。
4. UI：`remember` 失败/部分成功时 `ui.warn` 提醒；`/memory status` 展示最近 5 条 capture 审计（applied/dropped/reasons）。
5. 测试：复现今天的 `偏好-交付物版本管理.md` 场景，断言页面被创建、用户偏好可召回；超时/失败回执准确。

**涉及**：`src/memory/{bridge,capture,distill,merge}.ts`、`src/tools/memory.ts`、`src/index.ts`、`src/tools/types.ts`。

### B2. 捕获审计全覆盖

- 每轮（含空响应/错误/abort）都必须产生一条 capture-log（`skipped` 也要有 reason），不允许「无记录」；
- `recoverPending` 失败/丢弃写日志；`/memory status` 可查；
- 修复今天 turn 4 无记录的根因（先加断言/日志，再修）；
- 测试：空轮、abort 轮、distill 失败轮都产生审计记录。

**涉及**：`src/memory/capture.ts`、`src/memory/bridge.ts`、`src/index.ts`、`src/input/commands.ts`。

### C1. 技能额外路径 + 可发现性

- `settings.json` 新增 `skills_extra_paths: string[]`（也可 `NEO_SKILLS_PATHS` 冒号分隔）；`discoverSkills` 扫描 global → project → extras（重名按优先级去重，标记来源）；
- 可选：默认把 `~/.claude/skills` 作为只读 fallback（兼容 Claude 格式技能），settings 可关；
- `use_skill` 失败信息列出搜索过的目录 + 安装建议（含 `skills_extra_paths` 示例）；
- `/skills` 显示每个技能的来源目录；
- 测试：fixtures 三目录、优先级、同名冲突、错误信息、`NEO_SKILLS_PATHS`。

**涉及**：`src/config.ts`、`src/skills.ts`、`src/index.ts`、`src/system-prompt.ts`、`settings.example.json`、`tests/skills*.test.ts`。

### E1. 外部技能修补清单（不进 neo 仓库）

- `ax-office-skills/skills/karpathy-ax-html/SKILL.md` 的 `bash extract-assets.sh ./outputs` 与脚本契约（参数=项目根）冲突：改为 `bash "$SKILL_REF/extract-assets.sh" .`；
- 或改脚本：识别参数以 `outputs` 结尾时不重复拼接；
- `karpathy-ax-html/SKILL.md` 里 `$HOME/.claude/skills` 路径对 neo 不适用：建议在技能里改为「按环境探测/接受 `SKILL_REF` 覆盖」；
- 建议给 ax-office-skills 加一个 `install-to-neo.sh`（软链到 `~/.neo/skills` 或写 `skills_extra_paths`）。
- 这些是**外部文件**，需要你确认是否允许我改那棵树；不改也能靠 C1 + 手动路径继续用。

---

## 6. B4：工具实战化（D1–D4）

### D1. 大输出落盘 + 回查

- `dispatch/limitOutput` 超限时把**完整输出**写入 `<cwd>/.neo/tmp/tool-<timestamp>-<rand>.txt`（gitignore；TTL 24h / 总量 100MB 清理），返回：head 70% + tail 20% + `… 完整输出: <相对路径>（可用 read_file/grep 查看）`；
- `settings.tool_output_spill` 默认 true；`read_file` 分段读已能消费；
- 测试：超限 → 文件存在且内容完整、返回路径可读；关闭开关回退旧行为；清理。
- 涉及：`src/tools/index.ts`、`src/config.ts`、`.gitignore`、`tests/core.test.ts`/新测试。

### D2. shell cwd

- shell 增加可选 `cwd` 参数（默认项目根，必须存在）；返回串首行保留命令，末尾附 `[cwd] <相对路径>` 方便模型确认；
- system prompt「## 环境」补一句：**每条 shell 都从工作目录启动，不需要重复 `cd` 到项目根**；子代理紧凑 prompt 同步；
- 测试：`cwd` 生效/非法路径报错；prompt 包含声明（字符串断言）。
- 涉及：`src/tools/index.ts`、`src/system-prompt.ts`、`src/tools/task.ts`、`src/shell.ts`（如需）。
- **不做**：持久 shell 会话（风险大，收益低）。

### D3. `web_search` 工具

- 默认后端：`https://cn.bing.com/search?q=<q>&format=rss`（Bing RSS，无需 key；本机可达性先验证）；`NEO_SEARCH_URL`/settings 可覆盖；
- 工具参数：`query`（必填）、`count`（1–10，默认 5）；返回编号结果：title / url / snippet / date；
- 15s 超时、query 10 分钟内存缓存、错误可读（网络/被限流，提示改用 web_fetch 具体 URL）；
- 测试：本地 Bun.serve 返回 RSS fixture（解析/编码/count/错误），不碰外网；
- 若 RSS 在本机不可用，退化为 HTML `b_algo` 解析（README 记录风险）；
- system prompt 工具说明 + 提示「客户公开信息检索用 web_search，不要猜」。
- 涉及：`src/tools/` 新文件、`src/tools/index.ts`、`src/system-prompt.ts`、`tests/`。

### D4. `/export <session-id> [path]`

- 新命令：导出任意会话为 markdown 纪要（Q/A + 工具调用摘要 + 统计），默认路径 `discussed_<YYMMDD-HHMM>.md`，支持当前会话/指定 id；只读 `~/.neo/sessions`，不 hydrate 图片附件；
- 渲染器纯函数 + 命令接线；`--raw` 可选（默认不含 reasoning/图片，避免泄漏）；
- 测试：fixture session → markdown 快照；非法 id；命令表漂移守卫。
- 涉及：新增 `src/sessionExport.ts`、`src/index.ts`、`src/input/commands.ts`、`tests/commands.test.ts`。

---

## 7. B5：交付纪律 + 杂项 + 发布

### F1. 系统提示词纪律（问题 10/11）

在 `src/system-prompt.ts` 增加「交付物与决策」段：

- 交付物**默认保留**；不主动建议删除/覆盖旧版本，除非用户明确要求；版本用后缀另存。
- 模板类任务先读「填写示例/schema」并说明分组语义；分组、口径、删除等不可逆/有歧义处，**先用 `ask_user` 问**，不要猜。
- 写脚本/命令前先小样本验证；表格格式比对先判空（针对问题 12/13，仅建议不强制）。
- 子代理 prompt 同步精简版。

测试：prompt 字符串包含规则（unit）；行为无法自动化，验收时人工演练。

### F3. 杂项清理

- 启动时 GC：`~/.neo/mailbox/<sessionId>` 无对应会话文件且超过 7 天 → 删除（跳过 running）；
- `.neo/tmp` TTL 清理（与 D1 共用）；
- 测试：fixtures 临时 HOME/环境变量，断言只删孤儿、不碰活会话。

### E1/E2/E3

- E1 外部技能修补清单（见 B3）；
- E2/E3 不改代码，只在提示词里加流程建议，收尾说明「不保证模型一定遵守」。

### 发布

- `package.json` + `src/index.ts` 双源 bump **0.4.1**；`scripts/verify.sh` `EVIDENCE_PREFIX=v0.4.1`；
- `docs/release-notes/v0.4.1.md`；`tests/README.md` 基线更新；
- `bash scripts/verify.sh` ALL GREEN（含新 PTY S20）；证据落 `docs/evidence/v0.4.1-*`；
- 独立审计子代理复验（重点 A1/A2/askUser/记忆）；
- commit 策略：每批一个 commit，最后 release commit + `v0.4.1` tag；push 前报告数字，等你确认。

---

## 8. 测试与验收总则

| 层级 | 内容 |
|---|---|
| 每批 | `bunx tsc --noEmit` + `bun test`（全量）；新增专项测试 |
| B2 后 | `bash scripts/verify.sh`（含 S20），ALL GREEN |
| 最终 | `verify.sh` + 独立审计复验 + 手工真实 TUI 演练（askUser、长会话、remember、导出） |
| 测试数 | 基线 974/59 → 实际 **1027/66**（新增 49；含 B5 清理 4 例） |
| 证据 | `docs/evidence/v0.4.1-{tsc,tests,pty}.txt`（PTY 20/20） |

**回归红线**：现有 974 用例语义不得弱化；只允许因新增字段/工具列表/会话 version 做必要更新，且需在 commit 里说明。

---

## 9. 风险与应对

| 风险 | 应对 |
|---|---|
| askUser 阻塞导致 turn 卡住 | 状态条明确「等待回答」；Esc/Ctrl+C 可退；无默认自动答 |
| 空响应根因无法 100% 复现 | A1 先落诊断；用 fakeStream 复现空路径；真实会话下次可定位 |
| 上下文恢复误判普通 400 | 严格正则 + status 白名单；只重试一次；日志留证 |
| 记忆同步变慢（distill LLM） | 20s 超时 + 排队兜底；tool 结果如实说明 |
| web_search 网络/反爬 | 本地 fixture 测试；后端可配置；失败给明确建议 |
| 新增工具破坏精确断言 | 同步更新 toolNames/命令表/子代理排除测试 |
| 大输出落盘占磁盘 | TTL + 总量上限 + gitignore |
| 提示词纪律不能保证行为 | 只作为引导；破坏性操作仍依赖审批/用户确认，不宣称 100% |

---

## 10. 已拍板的 6 件事（用户 2026-10-26）

1. **版本号**：v0.4.1。
2. **askUser 范围**：单选 + 多选 + 自由输入 + Esc 取消，全部要。
3. **web_search 后端**：默认 Bing（cn.bing.com RSS），不接额外 API key。
4. **上下文窗口**：不假设 `glm-5.3-flash` 的真实值，运行时探测（/models）+ 溢出错误自学习，并持久化到 env 事实文件。
5. **外部技能包**：允许修改（已修 `extract-assets.sh`，并把技能链入 `~/.neo/skills`）。
6. **范围**：全量（B1–B5）。

---

## 11. 实施结果（v0.4.1，2026-10-27）

| 批次 | 内容 | 提交 |
|---|---|---|
| B1-A1 | 轮次诊断 JSONL + 空响应硬化 + resume 告警 + 会话 lastTurn | `abffeef` |
| B1-A2 | 上下文窗口探测（env 事实/models/溢出学习）+ 溢出压缩重试 + `/context` | `5e73ae8` |
| B2 | askUser（单选/多选/自由输入/Esc；仅交互 TUI）+ PTY S20 | `61e8c68` |
| B3 | remember 同步回执 + 显式记忆可靠落页 + 审计补齐 + 技能额外路径 | `be3ace9` |
| B4 | 工具输出落盘 + shell cwd + web_search + /export | `314165f` |
| B5 | 启动 GC（tmp/mailbox）+ 提示词加固 + 外部脚本修复 + 版本文档 | 见 release commit |

最终闸门：`tsc` 0 错；`bun test` **1027 pass / 0 fail / 66 文件**；PTY **20/20**；`ALL GREEN`。

未做/遗留：Windows 实机验收（PD-1 仍旧）；askUser 未做「每轮最多 N 次」硬限制（靠提示词与 Esc 兜底）；
真实 `glm-5.3-flash` 窗口仍可能探测不到元数据，此时依赖溢出学习（`/context` 会显示来源）。

---

## 12. 建议的讨论顺序（历史，已执行）

1. 问题 1/2 的根因假设（我会先给出 A1/A2 的测试复现路径）；
2. askUser 的交互契约（4.1/4.2）——这是唯一新增产品面，先对齐再动手；
3. 记忆 B1/B2 的「同步回执 vs 异步」取舍；
4. 工具 D1–D4 的优先级（可砍 web_search/export）；
5. 最后定版本号与 MVP/全量。
