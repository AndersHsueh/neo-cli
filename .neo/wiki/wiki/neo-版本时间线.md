# neo 版本时间线

> 最后更新:2026-10-19

## 摘要

neo 自 2026-10-16 起的完整版本演进线,全部经 git tag 实证。主线:CLI 骨架(v0.0.1)→ 档位分类与多 provider 路由(v0.0.2)→ 审计修缺陷建测试(v0.0.3)→ memory + skills 两大子系统(v0.1.0)→ 搜索兜底小修(v0.1.1)。

## 一、tag 实证表

| tag | commit | 内容 |
|---|---|---|
| v0.0.1 | `ce925a0` | Initial commit: Matrix-themed CLI coding harness |
| v0.0.2 | `ab6dd79` | tier classifier、multi-provider routing、degradation |
| v0.0.3 | `1eb6ade` | PRD-vs-source audit 修 7 缺陷 + 46 用例测试套件 |
| v0.1.0-rc | `b5d4aa4` | 版本号 bump 0.0.3 → 0.1.0 + release notes |
| v0.1.0 | `9ce2e4e` | c 轨道 memory 合 main,final 收官 |
| v0.1.1 | `6a2b4fb` | web_fetch 搜索 URL 兜底改写 |

另有非版本 tag:`memory-prd-final-v0.1.0`(承载 PRD 12 处修订 + design v0.2)。

## 二、演进逻辑

- v0.0.x 三连发解决「能用」:骨架 → 智能(分类/路由/降级)→ 可信(审计 + 测试)
- v0.1.0 解决「有记忆、有技能」:memory 两级 karpathy-wiki + skills 三层渐进披露
- v0.1.1 起 进入小步快修节奏,feat 与 release 分笔提交成为惯例

## 修订记录

- 无

## 关联主题

- [[neo-v0.1.0]] —— 时间线上最重要的一版,三线收官
- [[neo-v0.1.1]] —— 当前最新版本
- [[neo-多角色协作流程]] —— 每个版本背后的角色分工与拍板机制

## 来源

- `raw/2026-10-16_neo-v0.0.x-早期历史.md` §一
- git log --reverse 全时间线(实测)

## 推理与依据

## 2026-10-19 时间线补全：v0.1.2 → v0.1.8（tag 实证）

正文 tag 表停在 v0.1.1，以下经 `git tag` + `git log` 实证补全：

| tag/commit | 内容 | 发布说明 |
|---|---|---|
| v0.1.2 | /resume 交互恢复 + NEO_SESSIONS_DIR | docs/release-notes/v0.1.2.md |
| v0.1.3 | 工具调用预算 + 热键系统（ESC 回滚 / Ctrl+C 双击） | docs/release-notes/v0.1.3.md |
| v0.1.4 | task 子代理 + wiki 技能代码化（四技能退役） | docs/release-notes/v0.1.4.md |
| v0.1.5 | .neo/wiki/ 入库 + gitignore 死规则修复 | docs/release-notes/v0.1.5.md |
| v0.1.6 | **跳号**（无 release commit、无 tag；paste PRD 占号未实现） | — |
| v0.1.7 | `9a8497c` select 组件 + /resume /model 接入 | docs/release-notes/v0.1.8.md（合并覆盖） |
| v0.1.8 | `8e1950c` /tier /provider /mode 接入选择器 | docs/release-notes/v0.1.8.md |

当前 `package.json` version = 0.1.8。v0.1.6 跳号为推断（基于 commit 历史与 tag 缺失），非文档明示。
