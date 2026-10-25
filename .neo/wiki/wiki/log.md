# 日志(log.md)

> 时间导向的事件流,**append-only**。与 `wiki/INDEX.md`(内容导向的目录)互为补充:
> 想知道"这个库里有什么"看 INDEX,想知道"这个库经历了什么"看这里。
>
> 覆盖七类事件:**ingest**(新源摄取)/ **query**(提问与回填)/ **wiki**(页面变更)/
> **lint**(健康检查)/ **deliverable**(产出物生成)/ **milestone**(阶段性成果)/ **todo**(待办)。
>
> LLM 在摄取新源、回填查询结果、变更 wiki、跑体检、生成产出物时**追加**条目;不删旧条目,不改历史。
>
> ⚠️ **append-only 只约束本文件。** wiki 主题页允许并鼓励重写正文与 `## 摘要`,让它始终反映**当前最优综述**;
> 被推翻的旧结论不必原样留在页面里,压缩成 `## 修订记录` 的一行,或直接交给 git 版本历史兜底。

## 📐 格式约定

每条条目由一行标题开头,后跟 2-4 句正文:

    ## [YYYY-MM-DD] type | 短标题

- `type ∈ {ingest, query, wiki, lint, deliverable, milestone, todo}`
- 日期用当天真实日期(`date +%F` 的结果),不猜、不补写、不用相对时间
- 短标题一行写完;正文说明**发生了什么、动了哪些文件、为什么**
- 标题行格式固定不变,这样整份日志可以被一行 grep 解析

## 🔍 grep 速查

```bash
# 最近 5 条事件
grep "^## \[" wiki/log.md | tail -5

# 今天的全部事件
grep "^## \[$(date +%F)\]" wiki/log.md

# 按类型过滤(全类型)
grep -E "^## \[[0-9-]+\] (ingest|query|wiki|lint|deliverable|milestone|todo) \|" wiki/log.md

# 只看提问回填与产出物
grep -E "^## \[[0-9-]+\] (query|deliverable) \|" wiki/log.md

# 各类型条数统计
grep "^## \[" wiki/log.md | awk '{print $3}' | sort | uniq -c

# 某份源被提到的所有条目
grep -n "raw/<文件名>" wiki/log.md

# 还没消化掉的待办
grep -E -A3 "^## \[[0-9-]+\] todo \|" wiki/log.md
```

## 📋 维护纪律

1. **新源 → `ingest` 必登** — 每往 `raw/` 落一份文件,**同一次会话内**追加一条 `ingest` 条目,并至少更新 1 个 wiki 主题页或在 `INDEX.md` 来源清单登记
2. **回填 → `query` 必登** — 每次提问后把答案回填成新页面或补进已有页面,追加一条 `query` 条目,写清问题、结论、回填到了哪几页;一次性事实不回填也就不必登记
3. **wiki 变更 → `wiki` 必登** — 页面新增 / 重写 / 纠正过时事实,追加一条 `wiki` 条目;与用户确认后修改 `AGENTS.md` schema 也走这一类,写明改了什么、为什么
4. **体检 → `lint` 必登** — 每次跑完健康检查,追加一条 `lint` 条目,说明扫了什么、发现了什么、修了什么、还剩什么
5. **产出物 → `deliverable` 必登** — `outputs/` 下生成任何正式成品时,追加一条 `deliverable` 条目,注明依据哪些 wiki 页
6. **阶段性成果 → `milestone` 必登** — 某个主题闭环、某批源全部消化完、库达到可对外分享的状态等,追加一条 `milestone` 条目
7. **待办 → `todo` 必登** — 发现治理欠账(INDEX 未同步、某主题只有骨架、某份源还没编译、schema 待与用户确认)时,追加一条 `todo` 条目;解决后不要删,追加新条目说明已闭环
8. **只追加不改写** — 本文件 append-only;要纠正旧结论就写新条目,不修改旧条目的文字。这条纪律**只管本文件**,主题页该重写就重写

## 🧪 条目示例

> 下面示例整体缩进了两格,是为了不被 `grep "^## \["` 抓进真实条目;实际写入时**顶格**。

```text
  ## [YYYY-MM-DD] ingest | raw/<文件名>

  这份源讲了什么(1-2 句)。提取出的关键事实进入 <主题页 1>、<主题页 2>;
  与既有内容冲突的部分记在 <待澄清-主题>。

  ## [YYYY-MM-DD] query | <被问的问题>

  结论一句话。依据来自 <主题页 1>、<主题页 2>。判断为"下次还会用到",
  已回填为新页 <新页面名>,并在 INDEX.md 主题目录与关联图登记。

  ## [YYYY-MM-DD] wiki | <变动摘要>

  改了 <页面名> 的哪一段、为什么改(新源推翻旧结论 / 术语统一 / 拆分过长页面),
  受影响的互链与 INDEX 已同步。

  ## [YYYY-MM-DD] lint | 周期体检

  断链 N 处、orphan N 个、矛盾 N 处、缺摘要或缺日期戳 N 页、互链不足 N 页;
  已修 X,建议用户处理 Y。

  ## [YYYY-MM-DD] deliverable | outputs/<产出物>

  为回答 <问题> 生成,依据 <主题页 1>、<主题页 2>,形态为 <报告 / 对比表 / 幻灯片 / 图表>。

  ## [YYYY-MM-DD] milestone | <阶段性成果>

  达成了什么、库当前的规模(主题页 N 个、源 N 份)、下一阶段的重点。

  ## [YYYY-MM-DD] todo | <待办一句话>

  欠了什么、为什么现在不做、什么条件下再做。
```

---

<!-- 真实条目从这一行以下顶格追加,最新的写在最下方(append-only)。 -->

## [2026-10-16] ingest | 2026-10-16 工作纪要(v0.1.0 final → v0.1.1)

- 源:raw/2026-10-16_neo-v0.1.1-工作纪要.md,当日工作流水
- 覆盖:v0.1.0 final 收官、v0.1.1 小版本、技能拓扑重构、过程踩坑、遗留事项五节

## [2026-10-16] wiki | 首次搭建:从 raw 编译 4 个主题页 + 1 个待澄清页

- 脚手架此前只有 3 个空目录,本次先补齐 6 模板并填实 schema,再执行首次 ingest
- 新建:neo-v0.1.0 / neo-v0.1.1 / karpathy-wiki-技能拓扑 / neo-开发踩坑 / 待澄清-neo

## [2026-10-16] wiki | INDEX.md 首次建立

- 主题目录分「版本发布 / 基础设施」两类,含关键事实速查与主题关联图

## [2026-10-16] wiki | 新建 [[neo-v0.1.0]]

- memory 系统 + skills 工具 + worktree 基础设施三线收官,merge commit 9ce2e4e

## [2026-10-16] wiki | 新建 [[neo-v0.1.1]]

- rewriteSearchUrl 搜索兜底 + 发布流程,tag v0.1.1 已推 gitee

## [2026-10-16] wiki | 新建 [[karpathy-wiki-技能拓扑]]

- 技能唯一实体迁至用户级,项目软链自动跟随,含重构前后拓扑与运行时依据

## [2026-10-16] wiki | 新建 [[neo-开发踩坑]]

- 三条教训:zsh 不分词 / gitignore 不分软链 / google 国别域不命中改写

## [2026-10-16] wiki | 初始化 AGENTS.md schema

- 知识库名:neo 开发知识库;核心约束 5 条:可溯源 / 以 git 为准 / 不臆造 / 中文 / raw 只读
- 用户未逐条确认,按上下文代填,可随时改

## [2026-10-16] todo | 待澄清:4 项开放问题

- 备份目录清理 / 项目根 AGENTS.md 入库 / v0.1.1 release note / 早期历史入仓,详见 wiki/待澄清-neo.md

## [2026-10-16] ingest | 2026-10-16 v0.0.x 早期历史素材

- 源:raw/2026-10-16_neo-v0.0.x-早期历史.md,来自 git log 全时间线与 docs/release-notes/v0.1.0.md(内部版)
- 覆盖:版本时间线 / fast 路由判死 / 多角色协作流程 / §五未决观察 / 四项决定

## [2026-10-16] wiki | 新建 [[neo-版本时间线]]

- v0.0.1 → v0.1.1 六个 tag 实证表 + 演进逻辑

## [2026-10-16] wiki | 新建 [[neo-多角色协作流程]]

- 六角色分工表 + 拍板接管机制(v0.1.0-rc 实例)+ 流程三特征

## [2026-10-16] wiki | 更新 [[neo-开发踩坑]](+2 条)

- 新增:fast 路由模型池判死 / 本地配置不进 git 的同步义务;摘要同步改为五条

## [2026-10-16] wiki | 改版 [[待澄清-neo]]

- 首批 4 项开放问题全部由用户拍板解决,页面改版为处置记录,当前无开放问题

## [2026-10-16] wiki | 更新 INDEX.md

- 主题 4 → 7,新增「流程与基础设施」分类;关键事实速查 +2 条;关联图 +3 条

## [2026-10-16] wiki | 四项待澄清处置落地

- 备份目录已删;项目根 AGENTS.md 不入库(.gitignore 加 /AGENTS.md);v0.1.1 note 不补;v0.0.x 素材已补(本条上一条 ingest)

## [2026-10-18] wiki | 新建 [[工具调用预算-v0.1.2+]]

- 每轮注入临时 system 消息告知「第 N 次/上限 80」,剩余 ≤5 带具体次数要求收敛;上限 40→80;commit `1edc374`

## [2026-10-18] wiki | 新建 [[热键系统-v0.1.2+]]

- ESC 中止+历史回滚 / Ctrl+C 双击退出(仿 Claude Code);HotkeyRouter 按键唯一入口;commit `8c08cdc`

## [2026-10-18] wiki | 更新 [[neo-开发踩坑]](+2 条)

- 新增:bun test 单进程共享模块表 mock.module 泄漏 / AbortSignal 上没有 abort();摘要同步改为七条

## [2026-10-18] wiki | 更新 INDEX.md

- 主题 7 → 9;关键事实速查 +2 条(工具预算/热键语义),测试基线更新为 277;关联图 +2 条

## [2026-10-18] ingest | 新增 raw 素材 2026-10-18_neo-v0.1.2-双功能.md

- 工具调用预算 + 热键系统同日双功能的工作流水,支撑两个新主题页与踩坑 +2

## [2026-10-18] milestone | v0.1.3 发布 — tag 已推 gitee

- commit 链:`1edc374`(工具预算)→ `8c08cdc`(热键)→ `a3cd71a`(release);annotated tag `v0.1.3` 已推 gitee
- release note `docs/release-notes/v0.1.3.md`;版本号双源 bump 0.1.2→0.1.3
- 发布时发现上版遗留:`src/index.ts` VERSION 在 v0.1.2 发布时漏改,停在 0.1.1,本次一并修正;沉淀为踩坑第八条
- [[工具调用预算-v0.1.2+]] / [[热键系统-v0.1.2+]] / INDEX 状态与速查同步为「已随 v0.1.3 发布」
## [2026-10-18] ingest | full 编译 5 份 raw
## [2026-10-18] query | 预算消息识别经验：数字与时间线吻合即正常注入，非泄漏
## [2026-10-18] wiki | 补记一次绕行：edit_file 直改 wiki 页绕过 wiki_write，硬闸门缺口确认

## [2026-10-18] wiki | 更新 INDEX.md 至 v0.1.4 状态

- 关键事实速查:当前版本 v0.1.3→v0.1.4,测试基线 277→343 pass / 1 skip;当前状态段补 v0.1.4 双主线(task 子代理 + wiki 技能代码化)与技能退役
- 技能拓扑页标注「⚠ 历史页:v0.1.4 起技能退役」;来源清单补 2026-10-18 双功能 raw
- 维护约定新增「版本发布后同步当前版本行」;顶部最后更新戳 2026-10-18

## [2026-10-18] milestone | v0.1.5 发布 — tag 已推 gitee

- commit `3495f83`:wiki 知识库首次入库(raw 5 份 + 主题页 9 个 + INDEX/log,共 19 文件)+ `.gitignore` 死规则修复(`.neo/.wiki/outputs/` → `.neo/wiki/outputs/`);annotated tag `v0.1.5` 已推 gitee
- release note `docs/release-notes/v0.1.5.md`;版本号双源 bump 0.1.4→0.1.5
- `.neo/skills/` 与 `.neo/wiki/outputs/` 维持 ignore;AGENTS.md 不入库决定不受影响
- [[INDEX]] 当前版本行同步 v0.1.5
## [2026-10-18] deliverable | 选择器组件 select PRD 完成,待 neo 实施
## [2026-10-18] wiki | select-M0 两轮超时踩坑:单轮动作过多,改为一轮一小步
## [2026-10-18] milestone | select M0+M1 完成:hotkeys存量bug修复+bun事件顺序分歧+宽限窗
## [2026-10-18] milestone | select M2 完成:/model可选+C9 SIGINT协调+choose删除
## [2026-10-19] wiki | docs 功能文档加 [done] 后缀约定，首批 6 份改名并同步引用
## [2026-10-19] milestone | select 组件 ship 确认：v0.1.7+v0.1.8 交付，PRD 已加 [done] 后缀
## [2026-10-19] wiki | 版本时间线补全 v0.1.2-v0.1.8：tag 实证 + v0.1.6 跳号确认
## [2026-10-19] deliverable | 已实现功能盘点：功能→代码→证据→文档映射，含未实现 PRD 与存量问题
## [2026-10-19] wiki | K6/K9 死路径断言修复：gitignore 联动教训 + 恒真断言盲区入库
## [2026-10-19] wiki | 已实现功能盘点：K6/K9 存量问题闭环，全量测试归绿
## [2026-10-19] wiki | memory-prd 引用悬空澄清：跨仓真相源指针，存量问题清零
## [2026-10-19] milestone | 粘贴增强 M1 完成：多行粘贴逐行提交 bug 修复，chip 折叠上线
## [2026-10-19] wiki | JXA 三坑入库：stdout 污染/退出码失效/无 console.error，二进制走临时文件
## [2026-10-19] milestone | 粘贴增强 M2 完成：macOS 贴图全链路 + mapKey 守卫顺序 bug 修复
## [2026-10-19] milestone | 空正文自动重试机制落地：区分 length/stop 原因，重试一次不写空消息
## [2026-10-19] wiki | 发布踩坑：先 tag 后 rebase 致 tag 指向孤儿 commit，v0.1.10 重打
## [2026-10-20] milestone | v0.1.11 记忆激活交付：双作用域存储 + 自动归纳 + 项目优先召回
## [2026-10-20] wiki | 新建 [[记忆激活-v0.1.11]] 主题页（规格 §7 实现交付）
## [2026-10-20] milestone | v0.1.12 记忆旧件清理交付：删除 8 模块 / 旧测试 / 死配置，用例 497→445
## [2026-10-20] wiki | 新建 [[清理-v0.1.12]] 主题页（deprecated 旧件清理记录 + 回逆锚点）
## [2026-10-20] milestone | v0.2.0 跨会话消息交付：文件信箱 + 状态机 + 120s watchdog + send_message/list_peers + P1/P2 注入 + 人工接管，用例 445→517
## [2026-10-20] wiki | 新建 [[跨会话消息-v0.2.0]] 主题页，INDEX 当前状态/版本行/主题目录同步
## [2026-10-20] wiki | /resume 信箱身份改键接线（dead 接管 / 活进程拒绝），补 2 例；基线 517→519
## [2026-10-20] wiki | 自动记忆：project/跨会话消息-v0.2.0.md（append）
## [2026-10-20] wiki | 自动记忆：project/跨会话消息-v0.2.0.md（append）
## [2026-10-20] wiki | 自动记忆：project/neo-开发踩坑.md（append）
## [2026-10-20] milestone | v0.2.1 hotfix：主代理工具可见性（isSubagent）+ 长 turn 独立心跳/pid 兜底，用例 519→523
## [2026-10-20] wiki | 修正 [[neo-开发踩坑]] 第九条根因与 [[跨会话消息-v0.2.0]] 修复记录，INDEX 版本行同步 v0.2.1
## [2026-10-20] milestone | v0.2.2 工具调用紧凑显示：单行原地更新 + 点号动画 + toolcall_info_details 开关，用例 523→530
## [2026-10-20] wiki | 新建 [[工具调用紧凑显示-v0.2.2]] 主题页，INDEX 版本行/主题目录同步
## [2026-10-20] wiki | 自动记忆：project/跨会话消息-v0.2.0.md（append）
## [2026-10-20] wiki | 自动记忆：project/跨会话消息-v0.2.0.md（append）
## [2026-10-20] milestone | anders↔huan 真实双会话跨会话消息验收通过：双向消息/reply_to/13s/紧凑工具行，用户反馈清爽迅速
## [2026-10-20] wiki | 新建 [[里程碑-1020]] 记录当日三连发与经验，更新踩坑第十条（心跳不能挂空闲 tick）、跨会话/工具显示验收与 INDEX
## [2026-10-25] milestone | v0.2.3 TUI 补漏交付：流式状态/宽度/`/last`/回放/Ctrl+C 五项，用例 530→580，PTY 4/4，verify.sh ALL GREEN
## [2026-10-25] wiki | 新建 [[TUI补漏-v0.2.3]] 与 [[TUI进化路线-2026Q4]]，踩坑补 2026-10-25 条（PTY --auto off / script socketpair / COLUMNS），INDEX 版本行与主题目录同步
## [2026-10-25] milestone | v0.2.4 输入层交付：@ 文件补全/引用展开、/ 命令补全、Ctrl+J 多行；用例 569→660，PTY 10/10，verify.sh ALL GREEN
## [2026-10-25] wiki | 新建 [[输入层-v0.2.4]]，[[TUI进化路线-2026Q4]] 标记第一段完成，踩坑补 readline 三坑（非 TTY 不跑行编辑器/裸 Tab 插字面量/Ctrl+J 顺序），INDEX 版本行同步
## [2026-10-25] milestone | v0.3.0 TUI 交付：底部常驻状态条 + 自绘输入框（live 帧），用例 660→839（46 文件），PTY 10→17 场景，verify.sh ALL GREEN，红态 0/7
## [2026-10-25] wiki | 新建 [[TUI状态栏-输入框-v0.3.0]]，[[TUI进化路线-2026Q4]] 标记常驻状态完成并拆出 v0.3.1 transcript / v0.3.2 diff，踩坑补 v0.3.0 八条，INDEX 版本行与主题目录同步
## [2026-10-25] wiki | 自动记忆：project/TUI状态栏-输入框-v0.3.0.md（append）
## [2026-10-25] wiki | 自动记忆：project/neo-开发踩坑-续1.md（create）
## [2026-10-25] wiki | 自动记忆：project/TUI状态栏-输入框-v0.3.0.md（append）
## [2026-10-25] wiki | 自动记忆：project/TUI状态栏-输入框-v0.3.0.md（append）
## [2026-10-25] wiki | 自动记忆：project/会话随机命名-黑客帝国角色.md（create）
## [2026-10-25] wiki | 自动记忆：project/neo-开发踩坑-续2.md（create）
## [2026-10-25] wiki | 自动记忆：project/会话随机命名-黑客帝国角色.md（append）
## [2026-10-25] wiki | 自动记忆：project/neo-开发踩坑-续2.md（append）
