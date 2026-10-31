# neo 架构 — v0.1.0

> **作废:2026-10-31**
>
> 本文停在 v0.1.0（2026-10-16）的双仓快照，不再作为架构依据。
> 现行实现以 `src/` 为准：记忆在 `src/memory/`，组合根在 `src/index.ts`，主循环在 `src/agent/loop.ts`（`src/agent.ts` 只做再导出），斜杠命令在 `src/cli/commands.ts`。
> `../neo-memory/` 是已删除的 `dev/memory-v0.1.0` worktree，不是现行代码。
> 下文保留作历史记录，不要据此改代码或同步文档。

> **最后更新:2026-10-16** · 来源:本目录 wiki/项目管理-2026-10-16.md §2 + Kiki A1 commit message + 跨 session 协调经验
>
> **页面定位**:v0.1.0 release node 架构总览 — 跨仓事实 + 关键模块拓扑 + 何时动哪里
>
> **不是**:详细 PRD 规格(走 `docs/skills-prd[done].md` / `docs/memory-prd.md`)/ 实施代码细节(走 `neo/src/`)

## §1 仓库拓扑

```
neo/                  ← 平台主干(repository, `gitee.com/andershsueh/neo-agent`)
├── src/              ← 工具、CLI、skills 模块
├── tests/            ← 单元 + 集成测试(189 pass / 0 fail baseline)
├── docs/             ← 主仓文档
│   ├── skills-prd[done].md  (已 ship v0.1.0)
│   ├── memory-prd.md        (已 ship,但会从 main 删,见 §3)
│   ├── memory-design.md     (已 ship,但会从 main 删,见 §3)
│   ├── release-notes/
│   │   ├── v0.1.0.md        (stage 1,PM 出,110 行)
│   │   └── v0.1.0-FINAL.md  (待 Samuel 出,user-facing)
│   ├── v0.1.0-prd[done].md  (待 Mike push,主 PRD 整合,296 行)
│   ├── evidence/            (测试证据归档)
│   └── architecture.md      (本页)
├── worktree:  ../neo-memory/   ← 记忆特性独立 repo,worktree 共享 .git
                            (见 §2)
```

## §2 双仓事实(跨仓架构)

**核心事实**:
- **`neo/`** = 平台主干(repository `andershsueh/neo-agent`)
- **`neo-memory/`** = 记忆特性独立 repo(独立 git,但通过 git worktree 共享 `.git` directory)
- 实施地:`dev/memory-v0.1.0` 分支 HEAD `2793306` 在 `../neo-memory/`
- 真相源:`docs/memory-prd.md` 与 `docs/memory-design.md` 在 `neo-memory/`(已 ship,tag `memory-prd-final-v0.1.0`)

**Kiki A1 commit 消息原文**(双仓意图):
> 事实双仓说明:
> - 主 repo neo:平台主干
> - 独立 repo neo-memory (git worktree ../neo-memory/):记忆特性真正实施与 §6 §7 实施地

## §3 关键模块拓扑

```
              ┌─────────────────────────────────────────┐
              │  neo/ 平台主干(andershsueh/neo-agent)   │
              │  ───────────────────────────────────     │
              │  src/index.ts (CLI 入口)                │
              │    ├── src/agent.ts (主代理循环)        │
              │    ├── src/classifier/ (tier 路由)     │
              │    │   ├── src/config.ts (模型 + routes) │
              │    │   └── src/llm.ts (token 估算)      │
              │    ├── src/session.ts (会话持久化)      │
              │    ├── src/system-prompt.ts (system 拼) │
              │    ├── src/skills.ts (skill 加载)         │
              │    └── src/tools/                        │
              │        └── index.ts (9 个工具)          │
              │            ├── use_skill                │
              │            └── (其他 8 个)             │
              │  tests/                                │
              │    ├── core.test.ts                    │
              │    ├── skills.test.ts (A~J)            │
              │    ├── skills-cli.test.ts (L)         │
              │    ├── skills-command.test.ts (L)     │
              │    ├── symlink-traversal.test.ts (F)  │
              │    ├── skill-budget.test.ts            │
              │    ├── gitignore-rules.test.ts         │
              │    └── memory.test.ts (c 轨道, dev/memory-v0.1.0) │
              └─────────────────────────────────────────┘
                                  │
                                  │ git worktree (共享 .git)
                                  │  worktree 路径:../neo-memory/
                                  │  分支:dev/memory-v0.1.0
                                  ▼
              ┌─────────────────────────────────────────┐
              │  neo-memory/ 记忆特性独立 repo        │
              │  ───────────────────────────────────     │
              │  src/memory/                            │
              │    ├── types.ts        (MemoryEntry 等) │
              │    ├── schema.ts       (parseIndexEntry)│
              │    ├── recordIndex.ts  (F/I 测试核心)  │
              │    ├── profile.ts      (三层 fallback)  │
              │    ├── ingest.ts       (IngestEngine)   │
              │    ├── locks.ts        (mkdir 锁)        │
              │    ├── reInjectProfile.ts              │
              │    ├── init.ts         (3 接入点)        │
              │    └── agMd.ts         (AGENTS.md 路由)  │
              │  tests/memory.test.ts (236/1/18)        │
              └─────────────────────────────────────────┘
```

## §4 双仓同步规则

| 同步类型 | 路径 | 频率 | 工具 |
|---|---|---|---|
| 主仓 → memory 仓 | 用户本地 `cp docs/memory-{prd,design}.md ../neo-memory/docs/`(不 commit 到主仓) | 大版本变更时 | 手动 |
| memory 仓 → 主仓 | 仅文档类(回写已审稿),不写代码 | 罕有(2026-10-16 一例) | 手动 + Kiki A1 commit |
| 主仓 v0.1.0 release | commit + tag + push 在主仓 | 每发布 | 已有 `git push origin main` |
| memory 仓 v0.1.0 release | dev/memory-v0.1.0 → main + tag | 每发布 | 走 worktree |

**避免的反模式**:
- ❌ 在 `neo/docs/` 写"记忆特性"实现细节(spec 在 memory-prd.md)
- ❌ 在 `neo-memory/` 改 `docs/memory-prd.md` 后让主仓复制(真相反)
- ❌ 双仓交叉 merge(没用过,且违反清晰边界)

## §5 用户级接口边界

- **`/skills`** 命令(`src/index.ts:736`):仅在主仓,不会冒到 memory 仓
- **`/memory` 子命令族**(status / forget / reindex / redact):在 memory 仓,经 `(3) initProjectLevel + src/index.ts 接入点` 注入
- **AGENTS.md 路由**(约束 14a):memory 仓 init 时写到 `<userLevelDir>/AGENTS.md`,主仓不动

## §6 settings.json 处理(关键规则)

`settings.json` 在 **`.gitignore` 中**(repository 政策:本地配置不进版本控制)。这是 v0.1.0 release 时的关键约束:

- **修复要进 release notes,user 本地必改**(v0.1.0 这次 `routes.fast` 修复就是此模式)
- **不能通过 git 跟踪** changes
- **CI/测试** 不读 `settings.json`(走 env vars:`NEO_MEMORY_DIR` / `NEO_PLATFORM_OVERRIDE` / `NEO_PII_FILTER_DISABLE` 等)

具体修复 commit message 模板:
```
[N 修复名]: settings.json L<line> 改前 / 改后

凭据: <Huang n=3 实测 / Jacky spec / etc.>
user 本地必改: <改后内容>
```

## §7 实施期经验

1. **worktree 共享 .git**:`../neo-memory/` 通过 `git worktree add -b dev/memory-v0.1.0 ../neo-memory main` 创建,所有 git 操作(commit / push)都反映到主仓。
2. **测试 baseline 锚点**:`b5d4aa4` v0.1.0-rc 是 ship 时主仓顶端。c 轨道任何 commit 都用 `bun test + bunx tsc + full_test.sh` 三件核对,数字与 baseline 对位。
3. **NEO_DIR 前缀协议**:`test_case/*.sh` 内部硬编码 `NEO_DIR=/.../neo` 回退到主仓。c 轨道 worktree 跑 shell test 必须 `NEO_DIR=.../neo-memory zsh ... full_test.sh`,否则测的是老主仓代码。
4. **不进 v0.1.0 final 的 P3 残留**:J1~J3 gitignore 约束 / /memory redact 行为(改 vs 标记)/ 约束 55 owner / NFS flock / F3-F5 测试假设均。进 v0.2+ 路线。

## §8 待修整(留给 v0.1.0 final 升 tag 前)

- c 轨道 (3)/(5)/backlog 5 项完成后,`dev/memory-v0.1.0` 合 `main`
- 双仓同步**目前是手动 cp 文档**,未来可考虑**自动 sync** script(但现在不做,扩范围)
- `docs/architecture.md` 这是初版,实际项目复杂后应定期重写

## §9 关联 wiki

- [[项目管理-2026-10-16]] — 本架构沉淀的上游
- [[技能管理-v0.1.0]] — skills 子系统设计
- [[worktree-耦合的教训]] — 测试 baseline 锚定方式
- [[待提交-记忆管理PRD]] — memory 子系统设计入口
