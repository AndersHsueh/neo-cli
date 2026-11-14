# 修复-issue40-oneshot资源清理

## 摘要

issue #40 的单次模式资源清理已实现并手工验证，但集成测试为假阳性且未过全量闸门，禁止合入。

> 最后更新:2026-11-10
> 来源:session 20261110-095402-g4op80 · 2026-11-10 · 自动归纳

## 正文

issue #40 的工作位于独立 worktree `.neo/worktrees/fix-oneshot-cleanup`，分支 `neo/fix-oneshot-cleanup`，基于 `e99e9d9`，尚未 commit。实现新增 `src/cleanup.ts`，以 `cleanupEphemeral(deps)` 统一按“驱动（loop/drive）→ 子进程（tasks/shells/lsp）→ MCP → closeMailbox”顺序清理，并逐项容错；`src/index.ts` 通过 `tdzSafe()` 与 `cleanupEphemeralResources()` 接入 `shutdown()`、`-p` 正常/异常/空 prompt 及 `args.rest` 非 TTY 路径。手工脚本验证表明：修复前 `-p` 退出后留下 `sleep 300` 孤儿进程，修复后该进程消失。

当前不能合入：`tests/oneshot-cleanup.test.ts` 的 B1/B2 是假阳性，回退实现后仍然全绿，因此尚未真正证明“`-p` 退出后子进程已死”；应改为在 `-p` 运行期间轮询确认进程存在，退出后再断言消失。`bun x tsc --noEmit` 已通过，专项测试 7 pass / 0 fail，但全量 `bun test` 和 `bash scripts/verify.sh` 均未运行，尚不能排除 `shutdown()` 改动对交互路径的回归。
