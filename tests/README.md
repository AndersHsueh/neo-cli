# neo 测试约定

> **最后更新:2026-10-16** · 来源:本目录 wiki/项目管理-2026-10-16.md §4 + 跨 session 协调经验
>
> **页面定位**:如何正确跑测试(baseline + c 轨道 / multi-session 协调 / 双仓跨仓)

## §1 baseline

- **origin/main `b5d4aa4` v0.1.0-rc**:189 pass / 0 fail / 695 expect() / 7 files / 2.10s
- `full_test.sh`(zsh):30 pass / 0 fail / 0 skip / 9 modules
- `bunx tsc --noEmit`:exit 0
- 工具 spec 开销:+96 tok(901 → 997)

## §2 测试三件

所有测试 / 验收三件标准组合:

```bash
# 1. bun test(单元 + 集成,worktree 内 cwd 对齐)
bun test

# 2. bunx tsc --noEmit(类型检查,worktree 内)
bunx tsc --noEmit

# 3. full_test.sh(zsh 跑,NEEDS NEO_DIR 前缀对齐 c 轨道 worktree)
NEO_DIR=/Users/xueyuheng/research/000-alice-new/neo-memory \
  zsh /Users/xueyuheng/research/000-alice-new/test_case/full_test.sh
```

## §3 NEO_DIR 前缀协议(关键!)

`test_case/*.sh` 内部硬编码回退路径:

```sh
# test_case/tools/test_glob_and_html.sh:9
NEO_DIR="${NEO_DIR:-$(cd "$(dirname "$0")/../../neo" && pwd)}"
```

**含义**:
- `NEO_DIR` 不设 → 回退到主仓 `000-alice-new/neo/`
- `NEO_DIR` 显式设 → 走该路径(必须 worktree 路径)

**为什么重要**:c 轨道 worktree 在 `../neo-memory/`,src/ 内容与主仓不同。**直接 `zsh full_test.sh` 测的是老主仓代码,不是 c 轨道代码** — 数字与 `bun test` 不可比,失去验证意义。

**用法**(在 `../neo-memory/` worktree 内):
```bash
NEO_DIR=/Users/xueyuheng/research/000-alice-new/neo-memory \
  zsh /Users/xueyuheng/research/000-alice-new/test_case/full_test.sh
```

**用法**(在主仓 `../neo/`):
```bash
NEO_DIR=/Users/xueyuheng/research/000-alice-new/neo \
  zsh /Users/xueyuheng/research/000-alice-new/test_case/full_test.sh
```

## §4 worktree 切分

主仓 git worktree:
- `../neo/` — 分支 `main`(平台主干,已 ship v0.1.0-rc 在 `b5d4aa4`)
- `../neo-memory/` — 分支 `dev/memory-v0.1.0`(c 轨道开发)

**测试 baseline 锚点**:`b5d4aa4` 在 `main` 顶端。任何 c 轨道 commit 都用 §2 三件 + 与 baseline 对比。

## §5 已 ship 测试文件

| 文件 | 路径 | 用例数 | 状态 |
|---|---|---|---|
| `core.test.ts` | `tests/` | 46 | baseline |
| `skills.test.ts` | `tests/` | 71(A~J)| baseline |
| `skills-cli.test.ts` | `tests/` | 11(L)| baseline |
| `skills-command.test.ts` | `tests/` | 16(L)| baseline |
| `symlink-traversal.test.ts` | `tests/` | 10(F)| baseline |
| `skill-budget.test.ts` | `tests/` | — | baseline |
| `gitignore-rules.test.ts` | `tests/` | — | baseline |
| `memory.test.ts` | `tests/`(c 轨道) | 355+ | in progress on `dev/memory-v0.1.0` |

## §6 c 轨道当前数字(2026-10-16 下午)

- HEAD:`2793306` on `dev/memory-v0.1.0`
- `bun test`:236 pass / 0 fail / 1 K5 skip / 18 fail / 772 expect() / 1.86s
- `full_test.sh`:30 / 0 / 0
- `bunx tsc --noEmit`:exit 0

**18 fail** 是预期内:
- §A 余子命令(stub)/ E1-E4 (initProjectLevel 缺)/ G (skills 降级 stub)/ J2 (concurrent /init stub)/ K1-K4/K6 (PII feature absent)/ §A status 实际归在 profile 类等

## §7 已知风险(box-tick / feature absent)

不在 v0.1.0 final 修,压 P3 backlog:
- K 类 PII(feature absent) — `it.skip` + 等 PII 单
- B5 chmod root-bypass(已改测)
- B9 重试测试零覆盖
- J1 进程级并发(lock 持了但测试是 Promise.all 同步)
- J3 rename 失败回退测目录存在,没构造 rename 失败
- A8 同名字段静默丢弃
- F3-F5 测试假设不均
- WARN stderr 切字符(console.error → 走 stderr 风险)

## §8 跨 session 测试协议(PM AX skillup)

每 feature commit 后,PM 拉测试员 Coco 跑 §2 三件 + 与 baseline 对比 + 特别核查(commit message 自报 vs 实测)。

Coco review 报告**关键纪律**:
- **数字必须实跑** — 不引用上一 commit 数字当本 commit 数字
- **自报 vs 实测** 差要在 commit message 诚实补
- **box-tick** vs **feature absent** 要明示(改了 fixture 让路径真触达,或 `it.skip` 显式标)
- **commit message claim** 要在代码 + 测试中兑现 — 不写没做的承诺

## §9 相关 wiki

- [[项目管理-2026-10-16]] — 测试节奏与 PM 协调经验
- [[worktree-耦合的教训]] — K 组守卫起源
- [[技能管理-v0.1.0]] — skills 子系统测试设计
