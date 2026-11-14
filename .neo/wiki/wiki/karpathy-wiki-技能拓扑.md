# karpathy-wiki 技能拓扑

> 最后更新:2026-11-09

## 摘要

2026-10-16 完成的技能存放拓扑重构。此前 `~/.neo/skills/` 里全是**反向软链**(指回项目 `.neo/karpathy-*`),用户级技能离开本项目即失效。重构后唯一实体在 `~/.neo/skills/`,项目 `skills/` 只放软链自动跟随,`ensureSkill` 机制为协作者 clone 后自动补链。依据:`src/skills.ts:59` 与 `:64` 确认 neo 只扫描 `<cwd>/skills` 与 `~/.neo/skills` 两个目录。

## 一、重构前的错误拓扑

```
~/.neo/skills/karpathy-*  →  neo/.neo/karpathy-*   (反向软链,实体困在项目里)
neo/skills/karpathy-wiki-ingest  →  ~/.neo/skills/karpathy-wiki-ingest  (链到软链的软链)
```

问题:实体在项目 `.neo/` 下,而该目录不在 neo 扫描范围;用户级目录里全是软链,换一个 cwd 技能全失效。

## 二、重构操作(三步)

1. **物化**:`cp -RL` 把 4 个技能(karpathy-wiki-ingest / lint / new / query,共 11 文件)复制到 `~/.neo/skills/`,解引用生成真实文件;旧目录备份为 `~/.neo/skills.bak-20261016-205308`
2. **删源**:逐字节 `diff -rq` 校验一致后,删除项目 `.neo/karpathy-*` 源目录
3. **建链**:项目 `skills/` 用 `ln -sfn` 建 4 条绝对路径软链指向用户级

## 三、运行时依据

- neo 技能扫描路径只有两个:`<cwd>/skills`(`src/skills.ts:64`)与 `~/.neo/skills`(`src/skills.ts:59`)
- `ensureSkill`(`src/skills.ts:338`):`<cwd>/skills/<name>` 缺失而全局库有时,自动建绝对路径软链、幂等——协作者 clone 后无需手工建链
- 项目软链不入库:`.gitignore` 无法区分软链与真目录,写 `skills/` 会连项目私有技能一起 ignore(见 [[neo-开发踩坑]])
- 验证:skills 相关 3 个测试文件 103 用例全绿

## 修订记录

- 无

## 关联主题

- [[neo-v0.1.0]] —— skills 工具与 ensureSkill 机制随该版 ship,是本拓扑的代码前提
- [[neo-开发踩坑]] —— gitignore 软链问题的出处
- [[待澄清-neo]] —— 备份目录清理等遗留事项

## 来源

- `raw/2026-10-16_neo-v0.1.1-工作纪要.md` §三
- `src/skills.ts:59`、`:64`、`:338`

## 推理与依据

- 2026-11-09（session 20261109-214431-n8rocu）：当前 `/init` 的实际行为是：创建 `.neo/wiki/{raw,wiki,outputs}` 目录、写入 `.neo/wiki/raw/tags.md` 占位文件、创建空 `skills/` 目录，并向 `AGENTS.md` 写入带 `neo:wiki-workflow` 标记的 wiki 工作流规则区块。它不会生成 `karpathy-wiki-new` 的完整脚手架（如 `INDEX.md`、`log.md` 和模板文件），也不会自动软链任何 `karpathy-wiki-*` 技能。旧版 `/init` 自动挂载 karpathy 技能的行为已退役；相关能力内化到 `src/wiki/` 与工具层，karpathy-wiki-new/-ingest/-lint/-query 现作为独立技能供用户手动触发。相关代码落点：`src/cli/commands.ts` 的 `/init` 入口、`src/memory/init.ts` 的 `initProjectLevel`、`src/memory/agMd.ts` 与 `src/wiki/templates/agents-wiki-section.md`。
