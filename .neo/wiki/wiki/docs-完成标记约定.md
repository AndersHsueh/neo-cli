# docs-完成标记约定

## 摘要

docs/ 下功能类文档（PRD/设计）实现完成后，文件名加 `[done]` 后缀：`原文件名.md` → `原文件名[done].md`。改名用 `git mv` 保留历史，并同步更新全库引用（src/tests 注释、docs 互引、AGENTS.md 路径清单）。

> 最后更新:2026-10-19

## 首批改名（2026-10-19）

| 原名 | 判定依据 |
|---|---|
| skills-prd.md | src/skills.ts + use_skill 工具已实现，v0.1.0 已 ship |
| skills-acceptance-checklist.md | skills PRD 的验收清单，随 PRD 一起完成 |
| v0.1.0-prd.md | 文档自述「状态：已 ship」 |
| select-component-prd.md | src/ui/select.ts 已实现，v0.1.8 发布 |
| select-component-m0-probes.md | select PRD 的 M0 探针结论，随组件一起完成 |
| 001-memory-system-design.md | src/memory/ 全套已实现 |

## 引用同步范围

- `tests/gitignore-rules.test.ts:281`：K8 测试硬编码 `docs/skills-prd.md` 路径（断言不被 ignore），是**功能引用**，漏改会挂测试
- src 注释：`src/ui/select.ts`、`src/hotkeys.ts`
- tests 注释：`tests/skills.test.ts`、`tests/skills-cli.test.ts`、`tests/symlink-traversal.test.ts`
- docs 互引：`architecture.md`、`red-phase-evidence.md`、`release-notes/v0.1.0-FINAL.md`、`release-notes/v0.1.8.md、改名文件内部互引
- `AGENTS.md` 结构清单

## 注意

- `docs/memory-prd.md` 在多份文档中被引用但**不在仓库里**（历史遗留引用），改名时不要误改它
- release-notes 里的历史引用只更新路径字符串，历史内容不动

## 关联

- [[已实现功能盘点]] —— 用本约定判断功能文档是否该加 `[done]`
- [[neo-版本时间线]] —— 每个版本发布时文档改名的时间点
- [[记忆激活-v0.1.11]] —— 记忆功能采用「单文档 + 变更记录」替代多 PRD 的实例
