# 按轮次回滚 `/rewind` PRD（issue #27）

> 状态：实现中（待审查）
> 关联：GitHub #27。与单文件 `/undo` 并存（不替代、不拆掉）。

## 1 背景

现有写文件检查点（`src/checkpoint.ts`）只按**操作条目**倒序恢复文件：一轮里改了十几个文件时，
用户要猜 `/undo` 次数；而且**不回滚对话** —— 模型仍记得后续决策，容易再跑回同一条路。

## 2 需求

1. **轮次记账**：每个用户轮次开始时记一个锚点（prompt 摘要、`messagesBefore` 边界、时间），
   轮次结束时把该轮新产生的检查点 seq 归到这一轮。最多保留最近 50 轮。
2. **命令**：
   - `/rewind`（或 `/rewind list`）：列出本次会话的用户轮次（序号 / 时间 / 提示摘要 / 文件检查点数）；
   - `/rewind <n|last> [code|conversation|both]`：回到该轮**开始之前**；默认 `both`（代码+对话）；
     `code` 只恢复文件、`conversation` 只截断对话。
3. **代码恢复语义**：只回滚该轮及之后各轮里的检查点（同一文件多轮改过时，从新到旧恢复得到最早内容）；
   **只覆盖 `write_file` / `edit_file`**，shell 改的文件不跟踪（与 Claude Code 同口径）。
   `most recent` 起算，回滚后这些检查点从 manifest 摘掉。
4. **对话恢复语义**：把 `agent.messages` 截到最早被回滚那一轮的边界（永远保住 `messages[0]` 系统提示）。
   `code` 模式不截断对话；轮次记录保留但清空其检查点 seq（防重复回滚）。
5. **持久化**：轮次表存 `session.meta.rewind` 并随会话保存 —— **`--resume` 同一会话后仍能 rewind**。
6. **保留** `/undo [n]` 与 `/checkpoints [n]`：仍按操作条目工作，不拆。
7. 回滚后立即 persist 会话（对话截断 + 轮次表都落盘）。

## 3 验收

1. `/rewind` 能列出本次会话的用户轮次并选择一个时刻；
2. 能分别执行「只恢复代码」「只恢复对话」「代码+对话一起恢复」；
3. `--resume` 同一会话后仍能 rewind；
4. `/undo` / `/checkpoints` 行为不变；
5. `bun x tsc --noEmit` 零错误、`bun test` 全绿（含 PTY）、`bash scripts/verify.sh` 为 `ALL GREEN`。

## 4 非目标

- 不做版本控制替代 / 不跟踪 shell 改动 / 不跟踪工作区外文件；
- 不做「从这里向后/向前压缩对话」（定点 compact）——另议；
- 不做交互式菜单（Esc Esc 打开那种）；命令 + 列表足够，键位改动涉及 TUI 冲突，另议。

## 5 修正记录（2026-11-10，issue #42）

原实现把 drain 里**所有**入队轮次都记进轮次表，`/rewind` 列表因此混入跨会话消息帧、状态通知、
`/loop` 与 `/drive` 注入的自动轮。现修正口径：

- **列表与编号只算用户轮次**（`origin === "user"` 且非 loop 注入）；自动轮不显示、不能当回滚目标。
- **内部记账保留自动轮**：回滚用户轮次时，其后的自动轮（含跨会话消息轮次）产生的文件检查点会一并恢复，
  否则「代码退干净」不成立。
- 旧会话的 `meta.rewind` 没有来源字段，按用户轮次兼容。

## 6 修正记录（2026-11-10，issue #39）

`/compact`、`compact_ctx`、上下文溢出自动压缩都会把较早的整段历史换成 1 条摘要
（`applyCompaction`），后续消息整体前移；而 `RewindTurn.messagesBefore` 记的是**绝对下标**，
压缩后不跟着平移 → 对话回滚截错位置或静默不回滚（`both` 模式下代码退了、对话没退）。
现修正：

- **压缩生效后平移**：`AgentOptions.onCompacted({ removedFrom, removedTo, summaryIndex })`
  在 `applyCompaction` 之后调用一次；组合根调 `RewindLog.noteCompaction` 平移所有轮次的
  `messagesBefore`（含尚未 endTurn 的 pending 轮次），并写回 `sess.meta.rewind`。
  压缩失败/被跳过时不调用，下标不动。
- **平移口径**：被删区间是 `[removedFrom, removedTo]`（`system` 在下标 0，摘要落在 `summaryIndex`）。
  - 起点在区间**之后** → 平移 `(removedTo - removedFrom + 1) - 1` 条；
  - 起点落在区间**之内**（含左端点） → **clamp 到 `summaryIndex`**，并给该轮打 `compacted: true`。
- **clamp 的代价写清**：这些轮次的逐字原文已进摘要、不可恢复，对话只能回到摘要位置；
  回滚时 `RewindResult.notes` 会说明「该轮起点已被压进摘要」。代码回滚不受影响。
- **兼容**：旧会话 `meta.rewind` 没有 `compacted` 字段 = 未压缩过；没有压缩记录的会话行为完全不变。
- 已知未做：定点 compact（从某轮向后压缩）仍是非目标，见 §4。
