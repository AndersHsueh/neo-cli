# neo v0.4.1 —— 实战可靠性修复 + askUser

> 最后更新: 2026-10-27

## 摘要

v0.4.1（2026-10-27 发布，tag `v0.4.1` / commit `ac0b2c5`）针对 2026-10-26 售前资料实战暴露的 15 个问题做全量修复，并新增 TUI 提问组件 `ask_user`。核心承诺从「能跑」推进到「失败可见、可恢复、可诊断」：

- 会话不再静默空转：空正文/最后一次迭代失败都会变成 `hadError` + 明确错误 + 诊断日志；
- 上下文窗口不再盲信配置：`/models` 元数据 + 溢出错误自学习真实窗口，超限自动压缩重试；
- 显式 `remember` 不再「回执成功但实际丢弃」；
- 模型遇到歧义/破坏性操作可以主动用 `ask_user` 问用户（单选/多选/自由输入/Esc）；
- 工具输出被截断时完整内容落盘到 `~/.neo/tmp`（0600，不写用户仓库）。

## 背景

2026-10-26 下午的售前会话（session `20261026-143606-ldr92c`）跑到 184k tokens 仍未压缩（配置 512k、模型真实窗口未知），最后一轮「重试」没有 assistant 回复、没有报错，mailbox 仍记 `outcome=ok`，用户只能换会话。同轮实战还暴露：`use_skill karpathy-ax-html` 找不到技能、`extract-assets.sh ./outputs` 产出 `outputs/outputs/assets`、xlsx dump 因 `tool_output_limit` 中间段永久丢失、`remember` 返回成功但 capture-log 里是 `dropped`、56/66 条 shell 命令靠手写 `cd`、101 次工具调用 0 次 web_fetch。逐项映射见 `docs/neo-v0.4.1-workplan-20261026.md`。

## 批次与代码落点

| 批次 | 内容 | 主要文件 | commit |
|---|---|---|---|
| B1-A1 | 轮次诊断 JSONL + 空响应硬化 + resume 告警 + `session.meta.lastTurn` | `turnDiagnostics.ts`、`agent.ts`、`session.ts`、`index.ts` | `abffeef` |
| B1-A2 | 上下文窗口探测/持久化 + 溢出压缩重试 + `/context` | `contextWindow.ts`、`env/modelWindows.ts`、`config.ts` | `5e73ae8` |
| B2 | `ask_user` 工具 + composer 模态 + PTY S20 | `ui/askUser.ts`、`tools/askUser.ts`、`tui/composer.ts` | `61e8c68` |
| B3 | `remember` 同步回执 + 显式记忆可靠落页 + 审计补齐 + `skills_extra_paths` | `memory/*`、`skills.ts`、`config.ts` | `be3ace9` |
| B4 | 输出落盘 + `shell.cwd` + `web_search` + `/export` | `tools/index.ts`、`tools/webSearch.ts`、`sessionExport.ts` | `314165f` |
| B5 | 启动 GC + 提示词加固 + 外部 `extract-assets.sh` 修复 + 版本文档 | `maintenance.ts`、`system-prompt.ts`、外部技能包 | `fe35c6b` + 审计修复 `b8b6ca1`/`ac0b2c5` |

## 关键行为契约

### 1. 空响应/失败收口（A1）

- 第 1 次空正文：`finishReason=length` 时把 `max_tokens` 翻倍（封顶 64k）并追加一次 nudge 重试；其余情况同样只重试一次。
- 第 2 次仍空：置 `emptyResponse=true`、`hadError=true`，写明确 `errorMessage`、UI 打印错误、写轮次诊断日志，**不写空 assistant 消息**。
- 循环因溢出恢复/迭代上限结束但没有最终正文：同样 `hadError`，错误为「本轮在重试/迭代上限处结束，没有产出最终回答」（独立审计补的兜底）。
- 诊断日志只记元数据：`~/.neo/logs/turns/YYYY-MM-DD.jsonl`（`NEO_LOG_DIR` 可覆盖；不记 prompt 正文；30 天/5MB 滚动）。
- `session.meta.lastTurn` 持久化最后一轮 outcome；resume 时显式告警，`/sessions` 用 ⚠ 标记。

### 2. 上下文窗口来源优先级（A2）

1. env 事实文件 `~/.neo/env/<machineKey>.json` 的 `models` 字段（`/models` 元数据或溢出错误学习）；
2. `settings.context_window` / provider / globalDefaults 的配置原值（`cfg.configuredContextWindow`，不被探测值污染）；
3. 配置缺失时用已知模型兜底表。

- 溢出错误只认 400/413/422 且含 context/token 语义；解析真实上限后写回 env、压缩（失败则裁剪旧工具输出）并**同一轮重试一次**；第二次仍失败给出明确排障建议。
- `/context` 显示窗口、来源、阈值、估算用量、消息数、最近压缩；`/env refresh` 顺带探测并展示模型窗口。
- 环境快照刷新保留 `models`（否则一次 `/env refresh` 会抹掉学习结果）。

### 3. askUser（B2）

- 工具 `ask_user`：`question` 必填；`header/context/options(0–5)/multi_select/allow_custom`。
- TUI：单选 `↑↓` + Enter；多选 `Space` 勾选 + Enter（至少 1 项）；「其他（自行输入）」进文本态；纯文本提问直接进输入态；`Esc` 取消；答案提交到 scrollback（`提问：`/`回答：`）。
- 只注册在交互 TUI：`-p`/管道/子代理看不到该工具；`-y` 不会自动回答；系统提示词按 `opts.askUser` 条件注入规则（非交互时不教模型调用不存在的工具）。
- 结果序列化为 `{"status":"answered","selected":[],"custom":null}` 或 `{"status":"canceled"}`。

### 4. 记忆正确性（B3）

- `remember` 工具等待该 record 的 capture audit（≤15s）后如实回执「已写入 / 未写入 + 原因」。
- 显式记忆：绕过 confidence 门槛；`append` 目标页不存在自动降级 `create`，`create` 已存在降级 `append`；evidence 缺省用用户原文兜底；提炼 prompt 对 explicit 特化（必须至少 1 条 op）。
- 被价值判定过滤/abort 的轮次也写 `skipped` 审计；锁冲突写 `deferred`（非终态，journal 仍可重试），`/memory status` 展示最近 3 条。
- 技能：`settings.skills_extra_paths` / `NEO_SKILLS_PATHS` 支持只读外部技能目录；`not_found` 错误列出已搜索目录与配置提示。

### 5. 工具链（B4/B5）

- 超长工具输出：完整内容写 `~/.neo/tmp/tool-*.txt`（0644+`mode:0600`、目录 0700），返回头尾 + 路径；plan 模式不落盘；启动清理 7 天前 tmp/mailbox 目录。
- `shell` 新增 `cwd`（只影响本次调用，不改变会话 cwd）。
- `web_search`：cn.bing.com RSS，无需 API key；解析标题/URL/摘要，count 1–10，失败给明确错误。
- `/export [session-id]`：会话渲染 Markdown 到 `<cwd>/.neo/exports/<id>.md`。
- 外部技能包：修复 `karpathy-ax-html/references/extract-assets.sh` 的 `./outputs/outputs` 与 `--force` 解析；技能链入 `~/.neo/skills`。

## 验收与证据

- `tsc --noEmit`：0 错。
- `bun test`：**1027 pass / 0 fail / 66 文件**（新增 53 例；v0.4.0 基线 974/59）。
- PTY E2E：**20/20**（新增 S20 askUser）。
- `bash scripts/verify.sh`：ALL GREEN。
- 证据：`docs/evidence/v0.4.1-{tsc,tests,pty}.txt`；发布说明 `docs/release-notes/v0.4.1.md`；计划 `docs/neo-v0.4.1-workplan-20261026.md`。
- 独立审计发现 4 条阻断（末迭代静默 ok / 切模型窗口来源误报 / explicit 缺 confidence 被丢 / `-p` 提示词仍教 ask_user），均在发布前修复并补回归测试；另修复落盘安全、`NEO_ENV_HOME`、写锁空等、abort 状态、日志滚动清理、`/export` 模糊匹配等。

## 已知边界

- Windows 实机验收仍未做（PD-1，沿用 v0.4.0 实验性标记）。
- `glm-5.3-flash` 在网关不提供 `/models` 窗口元数据时，首次长会话仍可能先撞一次 400；会自动压缩重试，不会静默失败。
- askUser 未做「每轮最多 N 次」硬限制，靠提示词与用户 Esc 兜底。
- 数字类 Python 脚本报错属模型生成代码问题，仅通过提示词/工具输出改善。

## 关联

- [[空正文自动重试]] —— A1 前的旧契约，v0.4.1 改为「第二次仍空 = 错误收口」。
- [[neo-版本时间线]] —— 版本演进线（待补 v0.2–v0.4）。
- [[跨平台不可移植-shell解释器写死]] —— v0.4.0 平台适配层的后续（v0.4.1 新增 `shell.cwd`）。
- [[记忆激活-v0.1.11]] —— `remember` 与 capture 的原始设计，v0.4.1 补同步回执与显式落页。
