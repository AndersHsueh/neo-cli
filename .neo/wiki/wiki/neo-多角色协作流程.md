# neo 多角色协作流程

> 最后更新:2026-10-16

## 摘要

neo 项目开发采用多 LLM 角色分工协作,从 v0.1.0-rc / v0.1.0 release notes 实证。六个角色各司其职:Samuel 出版本文档、AX/PM 拍板、Jacky/Mike 做 PRD review、Coco 做代码 review、Huang 做凭据实测。特征:review 意见先合并进 PRD 再实现;拍板有授权链与撤销机制;实测数据作为技术判死依据。

## 一、角色分工表

| 角色 | 职责 | 实例 |
|---|---|---|
| Samuel | 版本管理员,出 user-facing release note | `46a3d20` FINAL ReleaseNote |
| AX / PM | 拍板与接管权,催办后可代走决策路径 | v0.1.0-rc 路径 A 拍板 |
| Jacky / Mike | PRD review,提 P0/P1 修订 | memory-prd 12 处合并(Jacky 5 P0 + Mike 9 项漏) |
| Coco | review 看板,标缺与必修项 | memory 两轮 review 4 必修项 + 3 真 bug |
| Huang | 凭据实测(n=3) | fast 路由模型延迟数据 |

## 二、拍板与接管机制(v0.1.0-rc 实例)

- 触发:3 轮催办 0 回复 + cron 监控确认 idle 转 busy 后未出文本回信 = 走完 turn 但选择不回,事实意义上的「无答」
- 接管:PM 代走 Samuel 路径决策(A 路径:5 commit + 路由修复 + version bump + tag + push 一次完事),依据 user「放心拍」授权
- 制衡:Samuel 仍可在 a 轨道合并时撤销

## 三、流程特征

1. **review 前置**:Jacky/Mike 的 PRD 修订(12 处)先合并成 final,再进入实现
2. **实测驱动**:Huang 的 n=3 延迟数据直接判死 `l-deepseek-v4-flash`(std ≈ 87s,差 350×)
3. **文档分层**:内部记(v0.1.0.md)与 user-facing(v0.1.0-FINAL.md)分开,后者为最权威

## 修订记录

- 无

## 关联主题

- [[neo-版本时间线]] —— 各版本的拍板记录在时间线上
- [[neo-v0.1.0]] —— 角色分工最集中的一次发布
- [[neo-开发踩坑]] —— Coco review 产出的必修项沉淀为踩坑条目

## 来源

- `raw/2026-10-16_neo-v0.0.x-早期历史.md` §三
- `docs/release-notes/v0.1.0.md`(内部版,§AX 拍板一节)
