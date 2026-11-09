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
