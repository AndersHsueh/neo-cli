# 修复-1108-worktree路径realpath不对称

> 最后更新:2026-11-08

## 摘要

`bun test` 在 macOS 上长期 16 红的根因：v0.4.63 引入的托管 worktree 功能里，代码拿**调用方传入的原始路径**去和 **git 报的 realpath** 比对，路径含软链时两者不等 → `/worktree list` 恒空、同名复用被误拒。Linux 上 `/tmp` 非软链故 CI 绿，属「测试偷偷依赖平台」形态。已建 GitHub issue #26 并派会话修复（v0.4.78）。

## 背景

合并 v0.4.50–76 的 release notes 欠账后，跑全量闸门发现 16 个失败，全部集中在 `tests/worktree.test.ts`。先排除「是本次合并引入的」：在合并前的提交 `31880e0` 上开临时 detached worktree 复跑，同样是 24 pass / 16 fail —— **既有问题**，与文档改动无关。

## 根因（实测确认）

git 的 `worktree list --porcelain` 报的是 **realpath**（macOS 上 `/private/var/...`），而代码多处拿**原始路径**（`/var/...`）与之比对。macOS 的 `/var` → `/private/var`、`/tmp` → `/private/tmp` 是软链，于是：

- `src/worktree.ts:358` `listManaged`：`relative(rootDir, item.path)` —— `rootDir` 来自 `repoRoot`（原始），`item.path` 来自 git（realpath）。软链下 `relative` 得到 `../../private/var/...`，以 `..` 开头被 `continue` 跳过 → **列表恒空**。
- `src/worktree.ts:193` `ensureWorktree`：`listed.find((w) => w.path === path)` 同样不等 → 复用失败；又因列表为空，随后落入「目录在但没登记 → 不是 neo 托管的 worktree → 拒绝」，实测报「路径 … 已存在，但它不是 neo 托管的 worktree（未登记在 git worktree list 里）」。
- `src/worktree.ts:384` `orphanDirs`：`known.has(p)` —— `known` 装 git realpath，`p` 是 `join(rootDir, ent.name)` 原始路径，同样不对称。
- `src/worktree.ts:128` `detectRepo` 的 `mainRoot`：由 git 的 `--git-common-dir` 推出（canonical），而调用方 `repo` 常是原始路径 → 「在 worktree 里再建，不套娃」的断言在 macOS 不成立。

实测（macOS，用 `os.tmpdir()` 建仓）：

```
git 报的路径: /private/var/folders/.../repo/.neo/worktrees/feat-a
测试用的路径: /var/folders/.../repo/.neo/worktrees/feat-a
listManaged 结果: []
第二次 ensureWorktree: 失败（"已存在，但不是 neo 托管的 worktree"）
```

`src/worktree.ts:309` 已有 `realish()`（realpath 归一，失败回落 resolve）helper，但只用于 `isWithin`（:331-342），没用在上述路径比对上。

## 影响面

- 产品侧：仓库路径含软链（macOS 的 `/tmp`、`/var`，或用户自建软链目录）时，`/worktree list` 空、`--worktree` 复用被拒 —— 是真实功能缺陷，不只是测试环境问题。
- 流程侧：`docs/evidence/` 里最高版本只到 **v0.4.4**（v0.4.5 之后无任何证据文件），说明闸门自 v0.4.5 起就没再产出证据 —— v0.4.63 引入的这批失败因此无人察觉。这是**闸门失效**的信号，比单个 bug 更值得记。

## 修法方向（已派活时的约定）

在**边界归一**而非各处打补丁：`repoRoot` 一定是已存在的仓库目录、`item.path` 来自 git 也已存在，两者先 realpath 归一再比对。注意 `.neo/worktrees` 叶子可能尚不存在（`realpathSync` 会抛异常），归一须作用在**已存在的祖先**（repoRoot / worktree 根）上再拼剩余段。`realish()` 可提升为共享 helper 复用。`detectRepo` 的 `mainRoot` 与调用方 `repo` 是否必须相等属「源 vs 测试」契约：源侧返回 canonical 更稳，测试侧按 canonical 比较。

硬约束：不得削弱既有安全断言 ——「不是托管 worktree 绝不覆盖」「当前 worktree 永不删」「脏工作区拒绝删除」必须仍在；不得写死 `/private` 或依赖开发机目录。

## 关联

- issue #26（GitHub，AndersHsueh/neo-cli）
- [[修复-1108-max-tokens不透明400安全降级]] —— 同一轮核查的另一个结论
- [[跨平台不可移植-shell解释器写死]] —— 同类教训：macOS 专用假设会伪装成 CI 绿

## 推理与依据

## 推理与依据

- 2026-11-08（session 20261108-180540-w6ssty）：补精确「闸门失效」这条推论的依据链，避免后续会话误用。
  - `docs/evidence/` 在 `.gitignore:49`（"全量闸门证据：verify.sh 每次运行覆盖写入，不进版本控制"），因此**「仓库里没有 v0.4.5+ 证据文件」是设计如此，不能直接当作闸门没跑的证据**。
  - 但本地目录是另一回事：`scripts/verify.sh:24` 从 package.json 的 version 推出 `EVIDENCE_PREFIX`，每次运行都写 `docs/evidence/${EVIDENCE_PREFIX}-{tsc,tests,pty}.txt` 到**本地**。实测本地目录最新证据为 `v0.4.4-*.txt`（mtime 2026-10-31 17:43），而 v0.4.5 提交于 2026-11-04、v0.4.63 提交于 2026-11-07 —— 即自 v0.4.5 起至 v0.4.76（32 个版本）**本机未再跑过 verify.sh**。若当时跑过 v0.4.63 版本的闸门，本地会留下 `v0.4.63-*.txt`（验证失败也会写盘，脚本在失败分支同样落盘）。
  - 结论不变：**闸门自 v0.4.5 起在本机失效**，这正是 v0.4.63 引入的 16 个 worktree 失败能一路存活到今天的原因。补跑闸门时应留意：v0.4.63 起的这批失败会让 verify.sh 立刻红灯，属预期（已由 issue #26 承接修复）。
  - 另注：`git ls-files docs/evidence/` 显示 16 个 v0.4.0–4.4 的证据文件仍被跟踪 —— 那是 `.gitignore` 规则加入之前入库的历史文件，已跟踪文件不受 ignore 影响，属正常残留。

## 推理与依据

- 2026-11-08（session 20261108-180540-w6ssty）：补精确「闸门失效」这条推论的依据链，避免后续会话误用。
  - `docs/evidence/` 在 `.gitignore:49`（"全量闸门证据：verify.sh 每次运行覆盖写入，不进版本控制"），因此**「仓库里没有 v0.4.5+ 证据文件」是设计如此，不能直接当作闸门没跑的证据**。
  - 但本地目录是另一回事：`scripts/verify.sh:24` 从 package.json 的 version 推出 `EVIDENCE_PREFIX`，每次运行都写 `docs/evidence/${EVIDENCE_PREFIX}-{tsc,tests,pty}.txt` 到**本地**。实测本地目录最新证据为 `v0.4.4-*.txt`（mtime 2026-10-31 17:43），而 v0.4.5 提交于 2026-11-04 —— 即自 v0.4.5 起至 v0.4.76（32 个版本）**本机未再跑过 verify.sh**。若当时跑过 v0.4.63 版本的闸门，本地会留下 `v0.4.63-*.txt`（验证失败也会写，脚本在失败分支同样落盘）。
  - 结论不变：**闸门自 v0.4.5 起在本机失效**，这正是 v0.4.63 引入的 16 个 worktree 失败能一路存活到今天的原因。补跑闸门时应留意：v0.4.63 起的这批失败会让 verify.sh 立刻红灯，属预期（已由 issue #26 承接修复）。
  - 另注：`git ls-files docs/evidence/` 显示 16 个 v0.4.0–4.4 的证据文件仍被跟踪 —— 那是 `.gitignore` 规则加入之前入库的历史文件，已跟踪文件不受 ignore 影响，属正常残留。
