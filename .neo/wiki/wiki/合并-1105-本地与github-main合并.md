# 合并-1105-本地与github-main合并

## 摘要

2026-11-05 将 github/main 的 54 个提交合并进本地 main，合并提交 71c7381，测试 1216 pass

> 最后更新:2026-11-05
> 来源:session 20261105-154244-kuupfx · 2026-11-05 · 自动归纳

## 正文

2026-11-05 把 `github/main` 的 54 个远程提交全部并入本地 `main`，合并提交 `71c7381`，合并前建了备份分支 `backup/pre-merge-20261105-154601`。

结果：本地领先 `github/main` 2 个提交（合并提交 + 本地原有的 `901bdae`）；冲突只有 `tests/README.md` 两处基线数字，取远程较新版本；`tsc` 零错误；`bun test` 1216 pass / 0 fail / 75 文件。**尚未 push**。

关键事实：
- 本地提交 `901bdae`（SIGINT 修复 `signalSpawnedBun`）是**重复劳动**——远程 `2ef640f v0.4.5` 里已有逐字节相同的实现，`git cherry` 标 `+` 只是提交元数据不同。已 merge，建议保留不动历史（rebase 风险大于收益）。
- `tests/README.md` 里写的基线 `1097 pass / 0 fail / 70 文件`（v0.4.12 实测）已过时，合并后实际是 `1216 / 0 / 75`；远程 v0.4.13–v0.4.55 期间没同步更新该文件。
- `neo-agent-app/` 仍未跟踪且不在 `.gitignore` 里，`git status` 会一直显示。
- **remote 命名易混淆**：`origin` 指向 gitee 的 `neo-agent.git`，`github` 指向 GitHub 的 `neo-cli.git`，两个仓库名不同。本次只对 `github/main` 操作，未碰 `origin`；若二者本应互为镜像，需确认 gitee 侧是否同步。
