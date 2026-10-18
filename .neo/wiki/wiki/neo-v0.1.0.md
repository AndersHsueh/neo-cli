# neo v0.1.0

> 最后更新:2026-10-16

## 摘要

neo 第一个 minor 版本,2026-10-16 以 merge commit `9ce2e4e` 合入 main。三条主线收官:c 轨道 memory 系统(走完 TDD 全周期)、skills 工具(第 9 个 tool `use_skill`,三层渐进式披露)、worktree 基础设施(K-group 守卫解耦)。测试基线 bun test 189 通过 / 0 失败,tsc 零错误。版本号从 0.0.3 升到 0.1.0,双源同步(`package.json` 与 `src/index.ts:39`)。

## 一、memory 系统(c 轨道)

- 能力清单:ingest 引擎、profile L1/L2/L3 fallback、`/memory` 子命令族(forget / reindex / redact)、PII 自动检测、`bodySource` 字段、AGENTS.md 路由
- TDD 全周期:`e469476` 红基线 → `035e912` 骨架(tsc 绿行为红)→ `f5bed8d`/`03e54e6`/`080198e` 分组转绿 → `5f1fc4d` 文档收尾
- 两轮 Coco review:第一轮 4 必修项(B8 spec / J4 locks / B5 测试 / K5 skip);第二轮修 3 真 bug + C3 fixture(`e148ef4`、`19ef667`)
- 设计文档:`memory-prd-final-v0.1.0` tag 承载 PRD 12 处修订;design 升 v0.2(两级 karpathy-wiki + 指针召回)

## 二、skills 工具

- 新增第 9 个 tool `use_skill(name)`,三层渐进式披露:索引常驻 system prompt → SKILL.md 正文按需 → 附件再按需
- 修复一处 symlink 遍历隐蔽 bug(`readdirSync` 对指向文件的软链的处理)
- 机制细节见 [[karpathy-wiki-技能拓扑]]

## 三、worktree 基础设施

- `.worktrees/` 加入 gitignore
- K-group 守卫从硬绑 worktree 名字改为「列表非空 + ROOT 解耦」,主仓与 worktree 都跑得通

## 修订记录

- 无

## 关联主题

- [[neo-v0.1.1]] —— 其后的极小改动版本,沿用本版确立的双源版本号机制
- [[karpathy-wiki-技能拓扑]] —— skills 工具与 ensureSkill 机制随本版 ship
- [[neo-开发踩坑]] —— 开发过程中沉淀的教训清单

## 来源

- `raw/2026-10-16_neo-v0.1.1-工作纪要.md` §一
- `docs/release-notes/v0.1.0-FINAL.md`(项目内,最权威用户级文档)
