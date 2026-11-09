# neo 维护流程

> 最后更新：2026-11-09
> 本文件是维护流程的唯一入口。改代码前先读完。
> 测试约定只维护在 [`tests/README.md`](../tests/README.md)。本文件不复制第二份。
> 发版说明体例看 [`docs/release-notes/`](release-notes/)。版本 PRD 体例看 `docs/` 下现有 `*-prd[done].md`。

远程仓库：`github.com/AndersHsueh/neo-cli`。

## 0. 开工前

- [ ] 读完本文件，再读 `tests/README.md`。
- [ ] 先判定走哪条审查路径（§7.1 默认 / §7.2 自我改进）。两条互斥，判定后再往下做。
- [ ] 大改动放进 worktree。main 工作区已脏时，不要在那棵树上开工。

纯文档、无行为变更：做到合入并清理 worktree 即可。不改 `package.json` 版本，不打 tag。发版才做 §9。

## 1. 准备 worktree

优先用 neo 托管目录，整会话进隔离检出：

```bash
neo --worktree <name>          # .neo/worktrees/<name>，分支 neo/<name>
neo -w <name> -p "…"           # 与 -p 等入口兼容
```

`git worktree` 也可以：

```bash
mkdir -p .neo/worktrees
git worktree add -b neo/<name> .neo/worktrees/<name>
```

- [ ] 名字只含 `[A-Za-z0-9._-]`，不以 `.` 或 `-` 开头（`neo --worktree` 的合法字符）。
- [ ] 同名目录已存在则复用，不重建、不覆盖已有改动。
- [ ] 在 worktree 里再开 `--worktree` 时，新目录仍挂在主仓库的 `.neo/worktrees/` 下。
- [ ] `.neo/worktrees/` 已在 `.gitignore`。不要把检出加进版本库。

清理命令见 §8。`/worktree remove` 只删除托管检出，不会把分支合进 main。

## 2. 改前基线

在干净树上先记数字，再改文件。worktree 刚从已提交的 HEAD 建出来，即干净树。

```bash
bun x tsc --noEmit    # 记退出码。用 bun x，不用 bunx（部分 bun 安装没有独立 bunx 入口）
bun test              # 记 pass / fail / skip 与测试文件数
```

- [ ] 数字写进任务笔记或 PR 描述。对照 `tests/README.md` §1 的当前基线口径。
- [ ] `docs/evidence/` 已 gitignore。基线输出留在本地，不 `git add`。
- [ ] 基线本身不是绿的：先停，把失败记清楚再决定是否继续。不要把既有失败混进这次改动。

`package.json` 的 `check` 脚本目前写成 `bunx tsc --noEmit`。维护时以 `tests/README.md` 的 `bun x tsc --noEmit` 为准。是否改脚本，见 §14。

## 3. 先红后绿

写实现之前先有失败的测试。

- [ ] 新行为：先写会失败的用例（或至少先写断言），跑一次确认是红的，再改实现。
- [ ] 测试名带规格引用。写法见 `tests/README.md` §2。
- [ ] PRD 里的验收条款要能在测试里找到对应。
- [ ] TTY 行为（动画行覆盖、宽度、`/last`、`--resume`、Agent 标题、代号列表）先往 `scripts/pty-e2e.ts` 加场景，再改实现。bun test 的 fake IO 测不出事件顺序与覆盖语义。可复用脚本表见 `tests/README.md` §1，不在这里重列。

相关单测变绿，只说明实现跟上了这批用例。下一步是 §4，不是宣称完成。

## 4. simplify

相关单测变绿之后，单独做一轮审查。这轮不实现新行为。

查这四类：

- [ ] 重复逻辑
- [ ] 死代码
- [ ] 命名
- [ ] 过度抽象

清理若改变对外行为，回到 §3，先补会失败的测试。清理结束再跑 §5。跳过本轮、直接拿单测绿色去交卷，流程未走完。

## 5. 全量闸门

全量只有这一条：

```bash
bash scripts/verify.sh
```

它按顺序跑：`bun x tsc --noEmit` → `bun test` → `bun run scripts/pty-e2e.ts`。任一阶段失败打印 `FAILED: <stage>` 并以 1 退出，后续阶段不跑。三阶段都过打印 `ALL GREEN`。证据落在 `docs/evidence/<version>-{tsc,tests,pty}.txt`（前缀读 `package.json` 的 `version`）。该目录不入库。

- [ ] 交卷口径是 `ALL GREEN`。
- [ ] 禁止把「只跑了 `bun test`」叫做全量。单测绿了不能代替这条闸门。
- [ ] `bun test` 有 skip 时退出码仍是 0。`verify.sh` 会解析 skip 数，列出所在文件并告警；默认告警后继续。
- [ ] 要求零跳过时：`NEO_STRICT_SKIPS=1 bash scripts/verify.sh`。有 skip 则 `FAILED: tests (strict skips)`。
- [ ] worktree 布局下 `tests/prompt-tiers.test.ts` 可能 skip 3 条（源目录在仓库外）。主仓应为 0 skip。要在 worktree 里零跳过，设 `NEO_BOT_COMMENTS_DIR` 再加 `NEO_STRICT_SKIPS=1`。原因与豁免写法见 `tests/README.md` §1 与 §4，此处不展开。

隔离、环境变量还原、平台豁免、记忆与信箱的特殊约定，全部以 `tests/README.md` 为准。

## 6. 全绿之后

- [ ] 默认路径：把闸门结果交给 Amelia（或本次任务的下达者）审查。审查通过之前不合入、不打 tag、不推远程。
- [ ] 审查者独立复跑 `bash scripts/verify.sh`，以自己的 `ALL GREEN` 为准。
- [ ] 自我改进路径的自审见 §7.2，不要把自审写成「已经让 Amelia 看过」。

## 7. 审查路径

先判定，只进其中一节。

### 7.1 默认路径

适用：外部任务、GitHub issue、Amelia 编排的实现、以及一切没有明确授权自审的改动。

- [ ] Amelia（或任务下达者）在合入、打 tag、推送之前审查。
- [ ] 审查看：改动范围、红→绿证据、simplify 是否单独做过、全量是否 `ALL GREEN`、有没有越界文件。
- [ ] 通过之后才执行 §8。要发版再执行 §9。

### 7.2 自我改进路径

Anders 已授权 Leo：对 **neo 自身的改进产出**，Leo 自审后可以 commit、打 annotated tag、推送到 `github.com/AndersHsueh/neo-cli`。这条路径不以 Amelia 事前审查为前置。

同时满足才进入：

- [ ] 执行者是 Leo。
- [ ] 任务书或 Anders 标明这是 neo 自身改进。
- [ ] 自审走完 §2–§5：有改前基线、先红后绿、simplify 单独做过、`bash scripts/verify.sh` 为 `ALL GREEN`。
- [ ] 未触碰 §13 禁止项。

缺任何一条，退回 §7.1，停在审查前。

自审留下与默认路径同等的证据：闸门输出、改动文件列表、若发版则 §10 四件套对齐。证据写在提交说明或 PR 描述里。

范围从紧：修 neo 自己的缺陷，补 neo 自己的测试与文档，且任务书允许自审。外部 issue、权限模型、发版口径本身的变更，走 §7.1。边界再放宽见 §14。

## 8. 合入 main 并清理 worktree

审查通过（或 §7.2 自审通过）之后，在主仓库目录操作。

```bash
git checkout main
git merge --ff-only neo/<name>          # main 已前进时，先在 worktree 里 rebase 到 main 再 ff-only
git worktree remove .neo/worktrees/<name>
git branch -d neo/<name>
git worktree prune
```

- [ ] 合入前 worktree 工作区干净，改动都已提交。
- [ ] 提交说明含对应 issue 的 `#N`（有 issue 时，见 §11）。
- [ ] 有未提交改动时，`/worktree remove` 与 `git worktree remove` 都会拒绝。确认要丢弃才 `--force`，且 neo 的 `/worktree remove --force` 仍会再确认一次。当前会话所在的 worktree 不能删。
- [ ] 只清理 `.neo/worktrees/<name>` 且分支为 `neo/<name>` 的托管检出。别人自己的 worktree 不删。
- [ ] 合入后用文件内容核对「改动真的在 main 上」。不要只靠 patch-id（cherry-pick 解过 `package.json` 冲突时，patch-id 会假报未合入）。

合并策略的默认值见 §14。

## 9. 发版

只在这次改动要发布时做。纯文档合入不做本节。

顺序：

1. 版本 PRD。行为有变时，在 `docs/` 留一份。总览体例 `docs/v0.1.0-prd[done].md`，专题体例 `docs/v0.2.4-input-prd[done].md` 及其它 `docs/*-prd[done].md`，验收清单体例 `docs/skills-acceptance-checklist[done].md`。做完的文件名带 `[done]`。无行为变更不新开 PRD，在 release note 里写「无行为变更」。
2. 写 `docs/release-notes/vX.Y.Z.md`。抬头对齐 `docs/release-notes/v0.4.80.md`：发布日、基线 commit、闸门结果、证据路径、关联 issue。正文写为什么发、变更、验证时的 `bun x tsc --noEmit` / `bun test` 数字 / `bash scripts/verify.sh` 是否 `ALL GREEN`、已知未做。
3. 刷新 `README.md`：把本版特性短句和测试基线数字改到与实测一致。只改相关句。
4. 检查 `.gitignore`（§13 的清单仍在）。
5. 只改 `package.json` 的 `version` 字段，改为 `X.Y.Z`。其它字段不动。
6. 提交。说明里写版本号；有 issue 则写 `#N`。
7. 在该提交上打 annotated tag，再推送：

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin HEAD
git push origin vX.Y.Z
```

推送目标是 `github.com/AndersHsueh/neo-cli`。tag 打在已包含该 `version` 的提交上。

- [ ] 发版前再跑一次 `bash scripts/verify.sh`，确认证据前缀已是 `vX.Y.Z`（前缀从 `package.json` 读，不手写）。
- [ ] §10 四件套对齐后再推。

## 10. 版本单源

版本号只改 `package.json` 的 `version`。运行时 `src/cli/version.ts` 读这个字段，不手写第二份常量。

发版时这四件套指同一个 `X.Y.Z`：

- [ ] `package.json` → `"version": "X.Y.Z"`
- [ ] annotated tag 名 `vX.Y.Z`，指向含该版本号的提交
- [ ] 文件 `docs/release-notes/vX.Y.Z.md` 存在，标题版本一致
- [ ] `README.md` 里涉及本版的特性与基线数字与 release note 一致

远程：`github.com/AndersHsueh/neo-cli`。

## 11. Issue 闭环

仓库：`AndersHsueh/neo-cli`。

- [ ] 改动绑到已有 GitHub issue。外部缺陷与下达的任务必须有 issue。
- [ ] 每次提交说明写 `#N`。
- [ ] 合入 main 之后关闭 issue。评论里写：合入 commit、闸门结果（tsc 退出码、`bun test` 的 pass/fail/skip、verify 是否 `ALL GREEN`）、若已发版则写版本号与 tag。
- [ ] 开着 PR、尚未合入时不关闭 issue。

没有 issue 的自我改进如何编号，见 §14。不编造 `#N`。

## 12. 推理分工

- [ ] 实现推理优先用 `neo -p`（IPSA Thor）。编排者不替实现者做推理。
- [ ] Amelia 编排：拆任务、收证据、独立复跑 §5。
- [ ] Amelia 接手写代码，只在 neo 卡住，或 neo 自修一轮后仍失败。
- [ ] 接手之后仍走 §2–§5，不另开一条更短的路径。

## 13. 禁止

- [ ] 不提交 `settings.json`、`settings.json.bak*`、`settings.*.bak`、`settings.local.json`。
- [ ] 不提交 `.env`、`.env.*`、api key、token、其它密钥。提交前看 `git diff --cached`。
- [ ] 不提交 `docs/evidence/`（全量闸门的本地输出）。
- [ ] 不提交 `.neo/worktrees/`、`.worktrees/`。
- [ ] 不把 `/AGENTS.md` 从 `.gitignore` 去掉。项目根 `AGENTS.md` 按用户决定不入库。
- [ ] 不把 `bot-comments/` 纳入版本控制。维护者已定：临时文件。契约验证落在有源文件的机器上。
- [ ] 不改与本次任务无关的文件。不顺手重构、不顺手格式化、不顺手改版本号。
- [ ] 产品立场是 AI 自由，不做沙箱。worktree 是文件级隔离，不是安全沙箱（`src/worktree.ts` 文件头；README「托管 worktree」）。hooks 不提供沙箱（README hooks 段）。「没有沙箱」不是待办，不开 issue、不补实现。
- [ ] 下列已拍板事项不要当缺口重开：提示词正文内容断言暂不开 issue；跨层互链保持现状，不做跨层链接解析。记录见 `docs/release-notes/v0.4.80.md`「已知未做」。

## 14. 待 Anders 拍板

下列用当前默认执行。拍板之后改本文件对应小节，删掉本条。

| 项 | 当前默认 |
|---|---|
| 合入方式 | `git merge --ff-only`。main 已前进则先 rebase 再 ff-only。需要保留合并节点时再改用 `--no-ff`。 |
| 发版提交是否与功能提交拆开 | 功能在 worktree 里先提交并合入。发版提交携带 release note、README 对齐、`.gitignore` 核对、`package.json` 的 version。release note 已在功能提交里写完时，发版提交可以只 bump version，但推送前 §10 必须已经对齐。 |
| tag 与 commit 的先后 | 先提交含 `version` 的那一次，再 `git tag -a` 打在该提交上，再推送。 |
| 无 issue 的自我改进 | 不编造 `#N`。提交说明写清动机。是否每个改动都要先开 issue，尚未规定；外部任务仍必须有 issue。 |
| 自我改进的范围 | 按 §7.2 从紧。放宽到哪些类型的产出，尚未规定。 |
| PRD 文件名 | 行为变更用 `docs/<主题>-prd.md`，完成后改为 `docs/<主题>-prd[done].md`。 |
| `package.json` 的 `check` 脚本 | 仍是 `bunx`。人手执行与文档一律写 `bun x tsc --noEmit`。本流程不为此改脚本。 |
| 第二远程 | 只推 `github.com/AndersHsueh/neo-cli`。仓库历史里出现过 Gitee 镜像同时更新；本流程不要求推第二远程。 |
