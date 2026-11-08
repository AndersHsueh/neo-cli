# neo 托管 worktree 路径归一（realpath canonical）— 需求规格说明书（PRD）

> 版本：v0.4.78 — fix/worktree-realpath-canonical
> 文档类型：需求规格说明书（PRD）
> 起源：GitHub issue AndersHsueh/neo-cli#26
> 基线状态：v0.4.76（commit d9d1117）。修复前 `tests/worktree.test.ts` 24 pass / 16 fail（40 用例）
> 日期：2026-11-08

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 一句话 | 托管 worktree 的路径比对统一走 **canonical 口径**（软链展开后的真实路径），修掉 macOS 上 `/var → /private/var` 导致清单恒空、复用失败、孤儿误判 |
| 起源 | issue #26：macOS 上 `os.tmpdir()` 是 `/var/...`（软链），git 报的是 `/private/var/...`，两者不等 |
| 改动文件 | `src/worktree.ts`（新增 `canonicalize`）、`tests/worktree.test.ts`（新增 h 组 9 例 + 1 处断言口径调整） |
| 修法 | **边界归一**，不逐处打补丁：新增共享 helper `canonicalize(p)`，4 处比对点两侧都归一后再比 |
| 最大风险 | 归一后可能放宽「不托管就不动」的保护 → 用 3 条安全断言用例锁死（验收标准 3） |
| 明确不做 | 不写死 `/private`、不依赖开发机目录形态、不改 `src/wiki/`、不引入新的平台假设 |

---

## 1. 背景与根因

### 1.1 现象

v0.4.63 的托管 worktree 功能在 macOS 上表现为：

- `listManaged(repo)` 返回 `[]` —— 明明建了 worktree，清单却是空的；
- 第二次 `ensureWorktree(repo, name)` 报「路径已存在，但它不是 neo 托管的 worktree」—— 明明是 neo 自己建的；
- `orphanDirs` 把真实托管目录误判成孤儿；
- `detectRepo` 的「不套娃」断言在 macOS 上不成立。

### 1.2 根因

代码拿**调用方传入的原始路径**去和 **git 报的 realpath** 比对。

macOS 实测（`os.tmpdir()` 下建仓）：

```
cwd            = /var/folders/.../T/tmp.XXXX/repo
git toplevel   = /private/var/folders/.../T/tmp.XXXX/repo
git worktree   = /private/var/folders/.../T/tmp.XXXX/repo/.neo/worktrees/wt1
```

`/var → /private/var`、`/tmp → /private/tmp` 是 macOS 的系统级软链。两边字符串不等 → 所有比对失配：

| 位置 | 原逻辑 | 失配后果 |
|---|---|---|
| `src/worktree.ts:358` listManaged | `relative(rootDir, item.path)` | 得到 `../../private/var/...`，以 `..` 开头被跳过 → 列表恒空 |
| `src/worktree.ts:193` ensureWorktree | `listed.find(w => w.path === path)` | 不等 → 复用失败 → 误报「不是 neo 托管的」 |
| `src/worktree.ts:384` orphanDirs | `known.has(p)` | 不对称 → 真实托管目录被判成孤儿 |
| `src/worktree.ts:128` detectRepo | mainRoot 是 canonical，调用方 repo 常是原始路径 | 「不套娃」断言在 macOS 不成立 |

### 1.3 为什么 Linux CI 是绿的

Linux 上 `/tmp` 不是软链，`os.tmpdir()` 返回的路径与 realpath 一致，比对恰好成立。**这是平台巧合，不是正确性** —— 修的时候不能引入新的平台假设，也不能靠「CI 绿了就算修好」。

---

## 2. 方案：边界归一

### 2.1 口径

新增共享 helper（`src/worktree.ts`）：

```
canonicalize(p):
  1. p → resolve(p)（绝对化）
  2. 从深到浅找出第一个**已存在**的祖先 cur
  3. head = realpath(cur)（展开软链；失败则退回 cur）
  4. 返回 head + 原样拼回剩余的不存在段
```

关键点：

- **只对已存在的祖先做 realpath**。托管叶子（`.neo/worktrees/<name>`）在首次 `ensureWorktree` 前并不存在，整条路径直接 `realpathSync` 会抛 ENOENT —— 而要比较的恰恰包含「尚未创建的托管路径」。
- **不存在的尾部原样拼回**，不做任何平台假设（不写死 `/private`）。
- 语义上等价于「把这条路径写成它唯一指向的那个写法」。

已有的 `realish()`（realpath 失败回落 resolve）保留并导出复用；`canonicalize` 是它的加强版（能处理尾部不存在的情况）。

### 2.2 4 处比对点如何改

| 位置 | 改法 |
|---|---|
| `listManaged` | `rootDir` 与 `item.path` 两侧都 `canonicalize` 后再 `relative` |
| `ensureWorktree` | `listed.find(w => canonicalize(w.path) === canonicalize(path))` |
| `orphanDirs` | `known` 集合存 `canonicalize(w.path)`；比对时 `canonicalize(p)` |
| `detectRepo` | `mainRoot` 返回 canonical（源侧）；测试侧按 canonical 比较 |

### 2.3 契约方向

派单口径：**源侧返回 canonical 更稳，测试侧按 canonical 比较，两边都成立才算修好**。

`detectRepo.mainRoot` 从「原始路径」改为「canonical 路径」—— 因为它的下游（`ensureWorktree`、`listManaged`）本来就要和 git 的 realpath 打交道，canonical 是它的自然形态。既有断言 `expect(repoFromWt.mainRoot).toBe(repo)` 相应改为 `toBe(canonicalize(repo))`，并**补一条更强的语义断言**（新建的 b 不在 a 内部套娃），确保「不套娃」这个契约没被削弱。

---

## 3. 约束

1. **不削弱既有安全断言**：「不是托管 worktree 绝不覆盖」「当前 worktree 永不删」「脏工作区拒绝删除」必须仍在，且在软链路径下同样成立。
2. **不引入平台假设**：不写死 `/private`、不依赖开发机 `/tmp` 形态、不依赖开发机目录。
3. **边界**：只动 `src/worktree.ts` 与 `tests/worktree.test.ts` 及配套文档；不碰 `src/wiki/` 与 `tests/wiki-write.test.ts`。
4. **不 push / 不 merge 回 main**，分支留在 worktree 等审查。
5. **不写 `.neo/wiki`**（wiki 登记由 Keymaker 侧统一处理）。
6. **版本号单源**：只改 `package.json` 的 `version`（`src/cli/version.ts` 运行时读它），不改 `src/index.ts`。

---

## 4. 验收标准

| # | 标准 | 状态 |
|---|---|---|
| 1 | `tests/worktree.test.ts` 既有 40 用例全过（修复前 24 pass / 16 fail） | ✅ 40/40 |
| 2 | 新增软链路径用例，断言两种路径写法下都成立 | ✅ 新增 h 组 9 例 |
| 3 | 既有安全断言未被削弱 | ✅ 3 条安全断言用例在 h 组内重跑 |
| 4 | `bun x tsc --noEmit` 零错误 + `bun test` 全绿 + `bash scripts/verify.sh` 全绿 | ✅ 证据见 §5 |
| 5 | 版本号 bump 到 v0.4.78（单源：package.json） | ✅ |
| 6 | PRD 本文档（ship 后改名加 `[done]`）+ release note | ✅ `docs/release-notes/v0.4.78.md` |

### 4.1 用例有效性自证

新增用例必须**真的能抓住 bug**，否则是假阳性。验证方式：把测试对 `canonicalize` 的依赖临时换成测试内独立实现，在**修复前的源码**上重跑 —— h 组 7 个用例失败（list / reuse / mixed-reuse / remove / orphanDirs / 当前不可删 / 脏拒绝），正是 issue #26 点名的比对点；修复后全部转绿。

---

## 5. 证据

- `docs/evidence/v0.4.78-tsc.txt`
- `docs/evidence/v0.4.78-tests.txt`
- `docs/evidence/v0.4.78-pty.txt`

---

## 6. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/worktree.ts` | 新增并导出 `canonicalize()`；`realish()` 改为导出；4 处比对点归一；`detectRepo.mainRoot` 返回 canonical |
| `tests/worktree.test.ts` | 新增 h 组 9 例（软链 list/reuse/mixed-reuse/remove/orphanDirs/detectRepo + 3 条安全断言）；「不套娃」断言改 canonical 口径并补语义断言；import 增加 `canonicalize`、`orphanDirs` |
| `package.json` | version 0.4.76 → 0.4.78 |
| `docs/worktree-realpath-canonical-prd.md` | 本文档（ship 后改名加 `[done]`） |
| `docs/release-notes/v0.4.78.md` | 发布说明 |
