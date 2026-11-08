# 待办-Issue与发布说明收尾

## 摘要

待验证关闭 Issue #21，并补齐 v0.4.50–76 的发布说明

> 最后更新:2026-11-08
> 来源:session 20261108-180540-w6ssty · 2026-11-08 · 自动归纳

## 正文

当前收尾清单有两项：① Issue #21 的描述是模型 `max_tokens` 超过服务端上限后导致整个会话无法继续请求；v0.4.75 已实现从 HTTP 400/422 响应解析 per-model `max_tokens` 上限、夹紧请求值并在同一轮重发，下一步应实测确认该场景已覆盖，验证通过后关闭 issue，避免继续误导排期。② 发布说明存在 27 个版本的欠账：`docs/release-notes/` 的版本序列缺少 v0.4.50 至 v0.4.76，而当前 HEAD 为 v0.4.76；可结合 commit message 与 diff 批量补齐。Issue #20 属于更大的后续块，暂不作为当天傍晚收尾项。

## 推理与依据

- 2026-11-08（session 20261108-180540-w6ssty）：2026-11-08，决定将第3号 release notes 欠账委派给 Tank 在独立 worktree 中完成，避免影响主工作树继续开发 #22。任务范围为补齐 v0.4.50–v0.4.76 共 27 篇发布说明，参照 v0.4.47–v0.4.49 的既有体例，并依据 `git show` 中的提交消息与 diff 编写，禁止硬凑或编造。Tank 使用 `docs/release-notes-backfill` 分支，仅新增 release notes 文件，不修改 `src/`、测试或版本号，不 push、不 merge，完成后保留 worktree 供主代理审查；回信需附任务号、27 个文件清单、每版本一句话摘要及散提交列表。wiki 登记统一由主代理负责，避免与 Tank 同时写入 `.neo/wiki` 造成冲突。

- 2026-11-08（session 20261108-180540-w6ssty）：2026-11-08，Issue #22 按用户要求委派给 `oracle` 执行；当前待办共 4 项。协作状态为 Tank 与 Oracle 分别在各自 worktree 中工作，主工作树不受影响；Issue #21 仍待后续验证，发布说明收尾事项继续保持开放。

- 2026-11-08（session 20261108-181405-ecu9hf）：2026-11-08，release notes 欠账已补齐至 v0.4.76。基于 31880e0 创建独立 worktree `../neo-worktrees/release-notes-backfill` 与分支 `docs/release-notes-backfill`，未修改主工作树。新增 `docs/release-notes/` 下 v0.4.50–v0.4.76 共 27 个文件，合计约 +496 行，按 5 批提交（9803c59 至 d9d1117）。34 个提交均完成归组：27 个版本各有对应提交，v0.4.54 另含实现提交 ae642d1；无版本号可归入的 6 个散提交（wiki 回填、merge、test fix 等）单独记录，未硬塞进版本说明。由于 `docs/evidence/` 没有这 27 个版本的证据文件，各篇文末注明所依据的提交 hash；v0.4.65 因提交正文不足，摘要依据 diff 文件统计归纳并明确标注。当前分支尚未 push、未 merge、未修改 `src/`，也未运行 `verify.sh`（纯文档变更），保留 worktree 等待审查。

- 2026-11-08（session 20261108-180540-w6ssty）：发布说明补齐分支 `docs/release-notes-backfill` 已交付复核：共 5 个提交，HEAD `d9d1117`；v0.4.50–76 共 27 篇 release notes 全部就位，新增 496 行，且变更仅限 `docs/release-notes/`，未 push、未 merge，等待审查。复核确认版本号无跳号、每版恰有一个 `v0.4.XX:` 提交；无法归入版本号的 6 个散提交（测试修复、wiki 文档、merge 提交）如实单列。因 `docs/evidence/` 缹少这些版本的对应证据，各篇均明确标注「依据提交 hash 撰写」。此前摘要有两处笔误：v0.4.52 应为「撞墙/首次使用时能力探测写回，只填空字段（issue #5 P3）」，不是「撤回」；v0.4.69 应为「子代理三档提示词，默认 mini（issue #20）」，且不得重复版本号前缀。v0.4.75 已清楚记录 #21 的修复机制（400/422 解析上限 → 夹紧同轮重发），但 #21 尚不能直接关闭，仍需实际运行验证；Oracle 正在处理 #22。

> 更正（2026-11-08 · session 20261108-180540-w6ssty）：原结论「待验证关闭 Issue #21，并补齐 v0.4.50–76 的发布说明」→ 见下

- 2026-11-08（session 20261108-180540-w6ssty）：2026-11-08，release-notes 补齐工作已审查并以 fast-forward 方式合入 main：`31880e0` → `d9d1117`，共补齐 v0.4.50–v0.4.76 共 27 篇发布说明，历史保持线性；`bun x tsc --noEmit` 通过。该批内容仅涉及 `docs/release-notes/`，无测试引用，未 push 到远端。复核时发现全量 `bun test` 为 1638 pass / 16 fail，失败均集中在 `tests/worktree.test.ts`；在合并前 `31880e0` 的临时 worktree 复跑仍是相同 16 fail，确认属于既有问题而非本次发布说明合入造成，需另建 issue 或安排修复。当前仍待验证并关闭 Issue #21；Oracle 的 #22 尚在进行中。

- 2026-11-08（session 20261108-181934-g0zw27）：2026-11-08 核查发现：Git 已跟踪的 release notes 只到 v0.4.49；v0.4.50 之后的发布说明位于主工作树且尚未提交，因此不能把当前主工作树状态视为可复现的仓库发布记录。另 `docs/evidence/` 已被 `.gitignore` 忽略，验证证据可本地生成但不会入库；若需证明各版本验证结果，应另行规划可提交的证据载体或明确其不入库约定。
