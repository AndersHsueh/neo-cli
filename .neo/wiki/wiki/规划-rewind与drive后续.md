# 规划-rewind与drive后续

## 摘要

v0.4.81 后 /rewind 与 /drive 后续项的现状、风险、工作量及优先级

> 最后更新:2026-11-10
> 来源:session 20261110-095430-3sc7f0 · 2026-11-10 · 自动归纳

## 正文

v0.4.81 后对 issue #35 中两组后续项做了只读源码分析。

## /rewind（issue #27）
- 定点 compact 与交互式菜单均未实现；PRD 中相关能力标为“另议”，与代码现状一致，属于显式推迟，而非实现遗漏。
- 现有地基缺陷：`RewindTurn.messagesBefore` 保存绝对消息下标，而 `applyCompaction` 会替换消息 head，导致 `/compact` 后再 `/rewind` 的回滚目标可能不可信。定点 compact 前应先修正该语义，并增加压缩事件记录（如 `SessionMeta.compactions`）。
- ESC 已有多种前置语义；安全落点是“空闲且输入框为空”，当前该场景为 no-op。双击时间窗口及与“连按两次清空”的区分仍需产品口径。
- 粗估 5.5–6.5 人日，难度中、影响中、把握中，建议第二或第三批。

## /drive（issue #24）
- LLM 评估与 `-p` 长跑均未实现；`-p` 当前是单次 send → persist → 退出，没有队列、drain，交互路径中的 `DriveManager` 不会被触达。
- LLM 评估本身约 2–3 人日，但会冲突于检查命令硬条件等既有设计约束。若限定为“仅用于用户显式声明为不可验证的目标”，仍需修改 PRD 原文。
- `-p` 长跑还需解决权限等待死锁、费用上限、退出码映射和资源清理；其中 `-p` 不调用 `shutdown()`，会遗留后台进程、子代理或 LSP。
- 整体粗估 7–8.5 人日，难度高、影响中、把握低。

另建议将三个现存问题独立建 issue：压缩后 `messagesBefore` 失效；`-p` 下 `/drive` 无法给出“明确提示不可用”；`-p` 路径不走 `shutdown()` 导致资源未清理。

## 推理与依据

- 2026-11-10（session 20261110-095402-g4op80）：issue #47 的 rewind 菜单已在独立分支 `neo/feat-rewind-menu` 和 worktree `.neo/worktrees/feat-rewind-menu` 中实现：新增 `src/tui/rewindMenu.ts`，在 `src/tui/composer.ts` 注入 rewind 能力并用双击 Esc 打开菜单，在 `src/index.ts` 复用 `/rewind` 的 `rewindLog.rewind` 逻辑，同时新增 `tests/rewind-menu.test.ts`（11/11 通过）及 `scripts/pty-e2e.ts` 的 S30 场景；`bun x tsc --noEmit` 通过。当前不能合入：PTY S30 中连续两次 Esc 未打开菜单并超时，Esc 取消与五种单 Esc 语义也未完成验收；全量 `bun test` 和 `bash scripts/verify.sh` 均未运行。独立探针已证明 composer 状态机逻辑可正确渲染菜单，因此当前卡点集中在真实 PTY 连续按键传输或读取链路。提交前必须删除 `scripts/pty-e2e.ts` 中临时 `DBG screen after 2x Esc` 日志。另需拍板双击窗口：实现将 `REWIND_MENU_WINDOW_MS` 从约定的 ≤400ms 放宽到 600ms；若坚持 400ms，需要改用更可靠的 PTY 连发方式。

- 2026-11-10（session 20261110-095430-3sc7f0）：2026-11-10，issue #46 已在独立分支 `neo/fix-compact-from` 实现并提交，commit 为 `640be83`，worktree 位于 `.neo/worktrees/fix-compact-from`。命令面新增 `/compact --from <轮次|last>`；`/rewind` 继续只负责回滚，压缩能力挂在 `/compact` 下。实现通过新增 `rewind.turnStart` 将用户轮次转换为消息下标，再由 `planCompaction(messages, { from })` 生成压缩计划；`from` 之前的消息放入 `CompactionPlan.kept`，最终输出结构为 `system + kept + 摘要 + tail`。整体压缩时 `kept` 为空，行为保持与 v0.4.82 一致；下标平移仍复用 #39 的 `onCompacted` / `noteCompaction`。变更涉及 9 个文件，包括 compact 核心、agent loop/types、CLI 命令、输入命令、帮助文本及 `tests/compact-ctx.test.ts`。闸门结果：tsc 0 错，`bun test` 1915 pass / 0 fail / 3 skip，`verify.sh` ALL GREEN，PTY 31/31。尚未改版本号、打 tag、push、合入 main 或关闭 issue。
