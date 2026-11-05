# neo 开发知识库 — 索引

> 内容导向的目录:每个 wiki 页面在这里占一行,给出链接、一句话摘要和可选元数据。
> 最后更新:2026-11-05

## 📌 一句话定位

记录 neo 终端编程助手项目自 v0.0.1 起的开发历程:版本演进、基础设施决策、协作流程、踩坑教训,供后续会话与协作者快速召回。

## 🧭 当前状态

已编译 5 份 raw,覆盖 26 个主题页。2026-10-20 v0.2.0 发布:跨会话消息 —— 文件信箱(~/.neo/mailbox/<session-id>/)+ 会话状态机(state.json: idle/working/waiting_input/exiting + 心跳 + outstanding)+ 委派 watchdog(120s)+ send_message/list_peers + P1 工具间隙注入 / P2 空闲 tick + 人工接管(ESC 裁决 A);对等组网、无固定 leader,支持多跳协作;全量用例 445→519(+74,26 文件),tsc 零错误。同日 v0.2.1 hotfix:真实双会话验证暴露 ① 主代理运行时工具被 `TOOL_NAMES_EXCLUDED_FOR_SUBAGENT` 误过滤、② 长 turn 心跳不刷新导致 watchdog 误报 dead;修复后用例 519→523。v0.2.2 界面优化:工具调用默认紧凑单行(`⚡ name args .` 原地更新/下一个覆盖/✓✗),`toolcall_info_details` 可恢复旧版详情;用例 523→530(27 文件)。当晚 anders↔huan 两个真实前台进程完成双向验收(消息 id/reply_to/13s/紧凑工具行),详见 [[里程碑-1020]]。v0.2.3 TUI 补漏:流式状态泄漏(`●` 前缀只出现一次)、宽度数学(CJK 按 code unit 截断/回落 100/无 resize)、`/last` 工具回看与失败详情、`--resume` 回放、Ctrl+C 提示破坏输入五行修复;用例 530→580(32 文件),PTY 4/4,详见 [[TUI补漏-v0.2.3]] 与 [[TUI进化路线-2026Q4]]。v0.2.4 输入层:`@` 文件补全/引用展开、`/` 命令补全、`Ctrl+J` 多行;M0 探针纠正「bun 不支持 completer」误判(真 PTY 下原生可用,缺 cursor 入参);用例 569→660(37 文件),PTY 10/10,详见 [[输入层-v0.2.4]]。v0.3.0 TUI:底部常驻状态条(model/tier/模式/分支/ctx/时长/tok)+ Claude Code 式自绘输入框(多行/历史/补全/粘贴/审批/选择/双 Ctrl+C);不换渲染模型(inline+scrollback、不 alt-screen);M0 探针 P1~P4 全 PASS;用例 660→839(46 文件),PTY 17/17,详见 [[TUI状态栏-输入框-v0.3.0]]。v0.3.1 剧情层:`--resume` 真续接同一 session-id(活进程拒绝/列表隐藏/残留锁回收)+ 12 个 Matrix 角色池随机代号 + `Agent: <代号>` 顶线 + `neo` 的 Mr.Anderson/N E O 绿字动画;用例 839→873(52 文件),PTY 19/19,详见 [[会话代号与标题动画-v0.3.1]]。v0.3.2 hotfix:并发 resume 抢锁失败覆盖存活 profile(critical)修复 + deadAfterMs 贯穿;用例 873→876,PTY 19/19。v0.3.3 hotfix:resume 身份失败致命 exit 2 + owner 新鲜独立保护启动窗口;用例 876→878,PTY 19/19。v0.3.4 banner 视觉:M.A.T.R.I.X + 底部空行;用例 878→881(53 文件)。v0.4.0 平台适配层:跨平台 shell 探测(`src/shell.ts` 唯一真源)+ 纯脚本环境探测(`~/.neo/env/<machineKey>.json`)+ 主/子代理双层注入 + `环境.md` 生成块 + `/env`;macOS 与 sp7(Ubuntu 24.04)双平台 974/59、PTY 19/19。v0.4.1 实战可靠性 + askUser:轮次诊断/空响应硬化、窗口探测与溢出恢复、`ask_user`(单选/多选/自由输入/Esc)、remember 同步回执、超长输出落盘、`shell.cwd`、`web_search`、`/export`;用例 1027/66、PTY 20/20,详见 [[neo-v0.4.1-实战可靠性]]。v0.4.2 tier 视觉 + 切档即时反馈:深思亮红/平衡绿/快速亮蓝/默认冰绿,状态条/spinner ⚡/工具行/回答 ● 随档位着色;分类切档在首次请求前即时提示;用例 1039/67、PTY 20/20,详见 [[neo-v0.4.2-tier视觉]]。前一版 v0.1.12:记忆旧件清理 —— 删除 8 个零调用模块、861 行旧测试与死配置,用例 497→445。缺口:supervisor/后台会话/attach/agent view/跨机留 v0.3;多跳环检测与 reply_to 兜底待实测;协调消息是否静默记忆捕获待评估。

## 🗂 主题目录

### 版本发布

| 主题 | 页面 | 一句话摘要 | 元数据 |
|------|------|-----------|--------|
| neo 版本时间线 | [[neo-版本时间线]] | v0.0.1 → v0.1.1 全演进线,git tag 实证 | 6 个 tag |
| neo v0.1.0 | [[neo-v0.1.0]] | memory 系统 + skills 工具 + worktree 基础设施三线收官,TDD 全周期 | 2026-10-16 合入 main |
| neo v0.1.1 | [[neo-v0.1.1]] | web_fetch 搜索 URL 兜底改写 cn.bing.com,极小改动版本 | tag 已推 gitee |
| 工具调用预算 v0.1.2+ | [[工具调用预算-v0.1.2+]] | 每轮注入临时 system 消息告知「第 N 次/上限 80」,≤5 次带具体次数要求收敛;上限 40→80 | commit `1edc374`,tag v0.1.3 已推 gitee |
| 热键系统 v0.1.2+ | [[热键系统-v0.1.2+]] | ESC 中止+历史回滚 / Ctrl+C 双击退出(仿 Claude Code);HotkeyRouter 为按键唯一入口 | commit `8c08cdc`,tag v0.1.3 已推 gitee |
| 选择器组件-select | [[选择器组件-select]] | 输入层组件:行内选择器 `select<T>`(↑↓ 移动/回车确认/esc 取消),`/resume` `/model` `/tier` `/provider` `/mode` 已接入;M0 探针挖出并修复热键 keypress 挂错对象、bun 事件顺序分歧两个运行时级问题 | v0.1.8 已合入 |
| docs-完成标记约定 | [[docs-完成标记约定]] | docs/ 下功能类文档（PRD/设计）实现完成后，文件名加 `[done]` 后缀：`原文件名.md` → `原文件名[done].md`。改名用 `git  | |
| 已实现功能盘点 | [[已实现功能盘点]] | neo 截至 v0.1.8（2026-10-19）全部已实现功能的集中映射：功能 → 代码落点 → 证据（测试/发布说明）→ 文档状态。新建功能文档时对照本页判 | |
| 空正文自动重试 | [[空正文自动重试]] | 推理模型（glm-5.3-flash 等）偶发只返回 `reasoning_content` 而 `content` 为空的退化响应。neo 在 agent 主 | |
| 记忆激活-v0.1.11 | [[记忆激活-v0.1.11]] | v0.1.11 把记忆系统从「只写不读」接通为双作用域闭环：项目级 `.neo/wiki` 沉淀决策/踩坑/进度，用户级 `~/.neo/wiki` 沉淀画像/ | |
| 清理-v0.1.12 | [[清理-v0.1.12]] | v0.1.12 清理 v0.1.0 时代遗留的「空转实现」：删除 recordIndex/profile/ingest/forget/reindex/redac | |
| 跨会话消息-v0.2.0 | [[跨会话消息-v0.2.0]] | v0.2.0 交付 neo 的跨会话消息：多个前台交互式进程通过 `~/.neo/mailbox/` 文件信箱互发纯文本消息，支持任意会话派活/回信/多跳协作， | v0.2.0 已交付 |
| 工具调用紧凑显示-v0.2.2 | [[工具调用紧凑显示-v0.2.2]] | v0.2.2 工具调用默认单行原地更新（点号动画/下一条覆盖/✓✗），`toolcall_info_details` 可恢复旧版详情；非 TTY 保留详情 | v0.2.2 已交付 |
| TUI补漏-v0.2.3 | [[TUI补漏-v0.2.3]] | v0.2.3 不换渲染模型，修 5 个丢信息/吃输入的缺陷：流式状态泄漏（`●` 只出现一次）、宽度数学（CJK/回落 80/resize）、`/last` 工具回看、`--resume` 回放、Ctrl+C 提示不破坏输入；TTY 验证固化为 `scripts/` 三件套 | v0.2.3 已交付 |
| 输入层-v0.2.4 | [[输入层-v0.2.4]] | v0.2.4 补齐输入层：`@` 文件补全（Tab/模糊匹配）、`@path` 引用展开（预算截断）、`/` 命令补全（漂移守卫）、`Ctrl+J` 多行（非 TTY 保持 Enter 语义）；M0 探针推翻「bun 不支持 completer」误判 | v0.2.4 已交付 |
| TUI状态栏-输入框-v0.3.0 | [[TUI状态栏-输入框-v0.3.0]] | v0.3.0 底部 live 帧：常驻状态条 + 自绘输入框（上下横线/多行/历史/补全/粘贴/审批/选择/双 Ctrl+C）；不 alt-screen；PTY 17/17、红态 0/7 | v0.3.0 已交付 |
| 会话代号与标题动画-v0.3.1 | [[会话代号与标题动画-v0.3.1]] | v0.3.1 剧情层：Matrix 角色池随机代号 + `Agent: <代号>` 顶线 + `neo` 的 Mr.Anderson/N E O 动画；前置 `--resume` 真续接；v0.3.2/0.3.3 并发抢锁 + owner 启动窗口 hotfix；PTY 19/19 | v0.3.3 已交付 |
| neo v0.4.1 实战可靠性 | [[neo-v0.4.1-实战可靠性]] | 2026-10-26 实战 15 问题的全量修复：空响应/失败可见、窗口探测与溢出恢复、`ask_user`（单选/多选/自由输入/Esc）、remember 同步回执、输出落盘、`shell.cwd`、`web_search`、`/export`、启动 GC；1027/66 + PTY 20/20 | v0.4.1 已发布（tag `v0.4.1`） |
| neo v0.4.2 tier 视觉 | [[neo-v0.4.2-tier视觉]] | 深思亮红/平衡绿/快速亮蓝/默认冰绿；状态条 tier、spinner `⚡`、工具行、回答 `●` 随档位着色；`tier_switch` 事件在首次 LLM 请求前即时提示；`/tier deep|bal|fast` 简写 | v0.4.2 已发布 |
| 2026-10-26 工作盘点 | [[盘点-2026-10-26-v0.3.1剧情层与hotfix]] | v0.3.1 剧情层 + 3 轮 resume 并发 hotfix + v0.3.4 banner 的当日完整盘点：版本时间线、owner 锁经验、测试/证据与下一步 | v0.3.4 已交付 |
| TUI进化路线-2026Q4 | [[TUI进化路线-2026Q4]] | v0.2.4 输入层（`@` 补全/多行）→ v0.3 常驻状态栏+transcript+diff → v0.3.x supervisor；含「不做」清单与 2026 横评依据 | 规划中 |
| 里程碑-1020 | [[里程碑-1020]] | 2026-10-20 v0.2.0~v0.2.2 三连发 + anders↔huan 真实双会话验收通过；当日经验（工具可见性/心跳/watchdog/紧凑显示/reply_to 对账） | 3 个 tag 已推 gitee |
| 待澄清-目标锚与手段分类 | [[待澄清-目标锚与手段分类]] | 2026-10-26 讨论「AI 跑偏」案例（考试找博客作者 → 搜索失败 → 假设答案在缓存 → 假设需外联 → 连 DNS 找出口）后，确定 neo 需要「 | |
| 修复-1104-hydrate图片占位编号 | [[修复-1104-hydrate图片占位编号]] | v0.4.8 修复 `src/session.ts` `hydrateMessages` 的图片丢失占位编号错位：原来 N 按「第几个丢失」计数，前面只要有一张 | |
| 修复-1104-verify证据前缀取版本 | [[修复-1104-verify证据前缀取版本]] | v0.4.9 修 `scripts/verify.sh` 的 `EVIDENCE_PREFIX`：从手写常量 `v0.4.4` 改为从 `package.jso | |
| 修复-1104-图片附件落盘命名覆盖 | [[修复-1104-图片附件落盘命名覆盖]] | v0.4.12 修 saveSession 图片按 part 下标命名导致每轮 img-1.png 互相覆盖，改为会话内递增序号 | |
| 重构-1116-档位纪律共享工具 | [[重构-1116-档位纪律共享工具]] | v0.4.13/14/15 连续三次修的是同一类缺陷——`toFixed`/`Math.round` 把档内值进位到档边界（`9_999 → "10.0k"`、 | |
| 修复-1104-CDATA字面量被解码 | [[修复-1104-CDATA字面量被解码]] | 2026-11-04，`src/tools/webSearch.ts` 的 `decodeXml` 有两个同源缺陷：**CDATA 段内的实体被解码**、**跨 | |
| 修复-1105-裸ESC残留 | [[修复-1105-裸ESC残留]] | 2026-11-05（v0.4.34），修复 TUI 的**裸 ESC 残留**缺陷：不构成合法转义序列的 ESC（后面跟普通字符或直接到结尾）此前被 `tok | |
| 修复-1105-复合参数SGR的reset语义 | [[修复-1105-复合参数SGR的reset语义]] | `src/tui/ansi.ts` 的 `nextActive()` 处理 SGR 复合参数（`\x1b[31;0m`、`\x1b[0;31m`）时语义错误，导 | |
| 修复-1106-wrapAnsi连续空格折行与buffer同口径 | [[修复-1106-wrapAnsi连续空格折行与buffer同口径]] | v0.4.38（HEAD `2a60c8d` 之后）修掉 `src/tui/ansi.ts` 的 `wrapAnsi` 在**连续空格**处折行与 `src/t | |
| 修复-1104-trimPending颜色上下文丢失 | [[修复-1104-trimPending颜色上下文丢失]] | v0.4.38 后修 trimPending 切分丢 SGR：切分后算 head 末尾 active SGR 前置到 pending 剩余部分 | |
| 修复-1107-formatTokens末档P漏整数档 | [[修复-1107-formatTokens末档P漏整数档]] | 2026-11-07（v0.4.45）。`formatTokens` 的 P 档末档只写了 `fixed1(v / 1e15)`，漏了「整数档」那一半：`fix | |
| 修复-1107-sanitizeOutput漏OSC剥离 | [[修复-1107-sanitizeOutput漏OSC剥离]] | 2026-11-07（v0.4.46）。`sanitizeOutput`（`src/ui/toolLog.ts`）只写了 `\x1b[@-_]` 一条通用转义， | |
| 修复-1107-formatBytes末档P单位没除 | [[修复-1107-formatBytes末档P单位没除]] | 2026-11-07（v0.4.47）。`formatBytes`（`src/env/render.ts`）在 P 档（末档）**所有 ≥1P 的值都被放大 1 | |
| 修复-1108-引用漏剥中文右括号 | [[修复-1108-引用漏剥中文右括号]] | 2026-11-08（v0.4.48）。`@path` 引用解析的 `TRAILING_PUNCT`（`src/input/completion.ts`）只剥  | |
| 修复-1108-引用漏剥弯引号右半边 | [[修复-1108-引用漏剥弯引号右半边]] | 2026-11-04（v0.4.49）。v0.4.48 后仍漏弯引号右半边 ” ’ 〞 〟；只剥尾部，左引号故意不进集合 | |
| 合并-1105-本地与github-main合并 | [[合并-1105-本地与github-main合并]] | 2026-11-05 将 github/main 的 54 个提交合并进本地 main，合并提交 71c7381，测试 1216 pass | |
| neo-开发踩坑-续1 | [[neo-开发踩坑-续1]] | 新增踩坑：本地重复实现远程已有修复（901bdae vs 2ef640f），git cherry 标 + 不代表内容冲突 | |

### 流程与基础设施

| 主题 | 页面 | 一句话摘要 | 元数据 |
|------|------|-----------|--------|
| neo 多角色协作流程 | [[neo-多角色协作流程]] | Samuel/AX/Jacky/Mike/Coco/Huang 六角色分工,拍板有授权链与撤销机制 | 实证自 v0.1.0 release notes |
| karpathy-wiki 技能拓扑 | [[karpathy-wiki-技能拓扑]] | 技能唯一实体在用户级,项目软链自动跟随,ensureSkill 兜底 | ⚠ 历史页:v0.1.4 起技能退役,实体迁回项目 `.neo/skills/` |
| neo 开发踩坑 | [[neo-开发踩坑]] | neo 开发过程中沉淀的教训清单,持续追加。当前十条:zsh 变量不分词、gitignore 无法区分软链与真目录、google 国别域不命中搜索改写、fast | 持续追加 |
| 待澄清-neo | [[待澄清-neo]] | 悬决事项登记页;首批 4 项已全部解决,当前无开放问题 | 状态:清空 |

### 跨平台与服务器部署

| 主题 | 页面 | 一句话摘要 | 元数据 |
|------|------|-----------|--------|
| 跨平台不可移植-shell解释器写死 | [[跨平台不可移植-shell解释器写死]] | v0.3.4 在 Ubuntu 24.04 + bash 上实测 877/881:`shell` 工具与 `!` 写死 `/bin/zsh` → Linux 上 agent 一条命令都执行不了(读类工具/LLM 正常);Windows PowerShell 推定同样不可用。含 sp7 部署实证、4 条失败归因、修复方向与验收标准 | 2026-10-26 发现；**v0.4.0 已修复**（双平台 974/59） |

## 📚 来源清单

- `raw/2026-10-16_neo-v0.1.1-工作纪要.md` — 当日工作流水,支撑 v0.1.0 / v0.1.1 / 技能拓扑 / 踩坑 / 待澄清诸页
- `raw/2026-10-16_neo-v0.0.x-早期历史.md` — 历史回溯(git 时间线 + 内部版 release note),支撑版本时间线 / 协作流程 / 踩坑 §四§五
- `raw/2026-10-18_neo-v0.1.2-双功能.md` — 工具调用预算 + 热键系统同日双功能工作流水,支撑两个功能主题页与踩坑 +2

## ⭐ 关键事实速查

- **当前版本**: v0.4.2(版本号双源 package.json + src/index.ts) — tier 视觉语义（深红/平衡绿/亮蓝/默认冰绿）+ 分类切档即时提示；见 `docs/release-notes/v0.4.2.md` 与 [[neo-v0.4.2-tier视觉]]；v0.4.1 可靠性+askUser 见 [[neo-v0.4.1-实战可靠性]]
- **测试基线**: bun test **1039 通过 / 0 失败(67 文件)**、`scripts/verify.sh` ALL GREEN(tsc + pty **20/20**),tsc --noEmit 零错误 — v0.4.2 发布前实测(2026-10-27)
- **平台边界(2026-10-27)**: v0.4.2 的 1039/0 在 **macOS(zsh)** 实测；v0.4.0 已在 sp7(Ubuntu 24.04 + bash)双平台 974/59 全绿；Windows PowerShell 仍为实验性、未实机验收 — 见 [[跨平台不可移植-shell解释器写死]]
- **TTY 行为验证**: `scripts/fake-llm.ts`(无状态假 SSE,含 slow/write-then-answer) + `scripts/pty-e2e.ts`(真 PTY 断言,19 场景) + `scripts/tui-probe.ts`(raw/帧/交错/终端恢复探针) + `scripts/readline-probe.ts`(readline 探针) + `scripts/verify.sh`(全量闸门) — PTY 必加 `--auto off`,见 [[neo-开发踩坑]] 2026-10-25 条
- **工具预算**: 每轮告知模型「第 N 次/上限 80」,≤5 次带具体次数收敛;入口 `budgetMessage()` — 见 `wiki/工具调用预算-v0.1.2+.md`
- **热键语义**: ESC=中止+回滚,Ctrl+C=双击退出不回滚;按键唯一入口 `HotkeyRouter` — 见 `wiki/热键系统-v0.1.2+.md`
- **技能唯一实体**: `~/.neo/skills/`,项目 `skills/` 只放软链 — 见 `wiki/karpathy-wiki-技能拓扑.md`
- **搜索兜底**: google/duckduckgo 搜索页自动改写 cn.bing.com,入口 `rewriteSearchUrl()` — 见 `wiki/neo-v0.1.1.md`
- **fast 路由判死**: `l-deepseek-v4-flash` 延迟 std ≈ 87s(差 350×)判死,回落 `deepseek-flash` 后 std ≈ 0.2s — 见 `wiki/neo-开发踩坑.md`
- **拍板机制**: PM 可在授权链内代走决策路径,原负责人保留合并时撤销权 — 见 `wiki/neo-多角色协作流程.md`

## 🔗 主题关联图

### 版本链路

- [[neo-版本时间线]] → [[neo-v0.1.0]]:时间线锚定各版本位置
- [[neo-v0.1.0]] → [[neo-v0.1.1]]:v0.1.0 是 v0.1.1 的基线,版本号双源机制沿用
- [[karpathy-wiki-技能拓扑]] → [[neo-v0.1.0]]:skills 工具与 ensureSkill 机制随 v0.1.0 ship

### 流程与问题链路

- [[neo-多角色协作流程]] → [[neo-版本时间线]]:每个版本的拍板记录落在时间线上
- [[neo-多角色协作流程]] → [[neo-v0.1.0]]:角色分工在 v0.1.0 发布中最集中
- [[neo-开发踩坑]] → [[neo-v0.1.1]]:google.com.hk 不命中改写,源自 v0.1.1 测试用例修正
- [[neo-开发踩坑]] ↔ [[neo-多角色协作流程]]:Coco review 必修项沉淀为踩坑;Huang 实测判死模型池
- [[待澄清-neo]] → [[karpathy-wiki-技能拓扑]]:问题 1(备份清理)依赖拓扑重构已验证的前提
- [[工具调用预算-v0.1.2+]] ↔ [[热键系统-v0.1.2+]]:同日双功能,「请求级临时消息」心智与测试基建(chatStream 注入点)共享
- [[热键系统-v0.1.2+]] → [[neo-开发踩坑]]:mock.module 泄漏与 AbortSignal 两坑出自热键开发

## 🛠 维护约定

- **新增 / 重写 / 重命名 / 删除 wiki 页面后**,同一次会话内同步更新本文件的主题目录、来源清单与关联图
- **摘要跟着页面走** — 主题页被重写成新的综述后,这里的一句话摘要也要改成新结论
- **改完就改戳** — 更新本文件后,把顶部 `最后更新` 换成当天真实日期
- **这里只放指针** — 本文件是目录不是内容;任何事实都先落在主题页里,这里只留链接与一句话摘要
- **不必凑指标** — 本文件和 `wiki/log.md` 一样,不参与 orphan / 摘要 / 链接密度检查
- **版本发布后同步当前版本行** — release commit 落地后,把「关键事实速查」的当前版本与测试基线一并更新到新版本实测值
