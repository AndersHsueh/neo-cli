# 合并-1105-本地与github-main合并

## 摘要

2026-11-05 将 github/main 的 54 个提交合并进本地 main，合并提交 71c7381，测试 1216 pass；随后推送双端并规范 remote 命名（origin=GitHub、gitee=Gitee）

> 最后更新:2026-11-05
> 来源:session 20261105-154244-kuupfx · 2026-11-05 · 自动归纳

## 正文

2026-11-05 把 `github/main` 的 54 个远程提交全部并入本地 `main`，合并提交 `71c7381`，合并前建了备份分支 `backup/pre-merge-20261105-154601`。

结果：本地领先 `github/main` 2 个提交（合并提交 + 本地原有的 `901bdae`）；冲突只有 `tests/README.md` 两处基线数字，取远程较新版本；`tsc` 零错误；`bun test` 1216 pass / 0 fail / 75 文件。**已于同日推送**：`main` 与全部 81 个 tag 同步到 GitHub（`neo-cli`）与 Gitee（`neo-agent`），两端 `main` 同为 `8c563e3`、tag 集合完全一致，`cursor/thin-gateway-output-limit-e755` 分支也已镜像到 Gitee。

关键事实：
- 本地提交 `901bdae`（SIGINT 修复 `signalSpawnedBun`）是**重复劳动**——远程 `2ef640f v0.4.5` 里已有逐字节相同的实现，`git cherry` 标 `+` 只是提交元数据不同。已 merge，建议保留不动历史（rebase 风险大于收益）。
- `tests/README.md` 里写的基线 `1097 pass / 0 fail / 70 文件`（v0.4.12 实测）已过时，合并后实际是 `1216 / 0 / 75`；远程 v0.4.13–v0.4.55 期间没同步更新该文件。
- `neo-agent-app/` 是**独立子项目**（自带 `.git`，远程 `gitee neo-agent-app`），已写入 `.gitignore`，不再出现在 `git status` 里，也避免误 `git add` 生成 gitlink。
- **remote 命名已规范化**：`origin` → GitHub `neo-cli.git`（`git push`/`git pull` 默认目标，另设 `remote.pushDefault=origin`），`gitee` → Gitee `neo-agent.git`；`main` 跟踪 `origin/main`。此前 `origin` 指向 gitee、`github` 指向 GitHub，两仓库名不同易混，现两仓互为镜像。
- 本地仍有三个未上远端的分支：`backup/pre-merge-20261105-154601`、`dev/memory-v0.1.0`、`feature/skills`（两端都没有，保持一致口径故未推）。
