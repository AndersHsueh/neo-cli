# neo vs Claude Code：差距到底有多大？

> 评估日期：2026-10-26 · neo v0.3.4（HEAD ca93568）· Claude Code 2.1.301（本机，官方 changelog 已到 2.1.310）
> 方法：代码审计（带 file:line）+ 本机能力观测 + 官方文档核查 + 一次同模型受控小实验
> 结论口径：**「能不能把活干完」与「是不是一个成熟产品」是两个坐标轴，neo 在第一个轴上差距不大，在第二个轴上差距很大。**
> **2026-10-26 更新：本文列出的 6 个 P0 已全部修复并通过 verify.sh（tsc 0 / 913 tests / PTY 19/19），逐项 commit 与验收证据见文末 §7；正文保留修复前评估原貌，方便对照。**

---

## 0. 三句话结论

1. **日常单人编码这个口径上，neo 与 Claude Code 的差距已经进入「噪声级」**：同模型、同任务、隔离目录的受控实验中，两者都 6/6 通过、都只改了 3 个源文件、都没动测试；neo 用时 62s，Claude Code 162s（单次，不构成性能结论）。
2. **差距集中在一个很具体的地方：工程健壮性与生态面**，而不是「能不能写代码」。neo 有 6 个 P0 级缺陷（零重试、压缩丢细节、`edit_file` 的 `$&` 写坏文件、无检查点、grep 不守 `.gitignore`、`-p` 无法自动化），每一个都可能在真实任务里把「能完成」变成「完成不了」。
3. **但 neo 没必要也没有可能去复制 Claude Code 的全部产品面**（46 工具 / 66 flag / 120 条 slash / 33 hook 事件 / 6 权限模式 / 5 层配置 / 12 个宿主）。真正值得抄的是它的**容错与治理骨架**；neo 在记忆、跨会话、可复现性上本来就有结构性优势。

### 我的评分（判断值，不是测量值）

| 维度 | neo | Claude Code | 差距 |
|---|---|---|---|
| 单人单仓日常编码闭环 | 80 | 92 | 小，且多数任务感知不到 |
| 工具执行层健壮性 | 55 | 92 | 中偏大，全是可修的具体 bug |
| 上下文工程 | 60 | 90 | 中；长会话才暴露 |
| 安全 / 权限 / 沙箱 | 25 | 90 | 大；但个人使用可用「不碰」规避 |
| 扩展与生态（MCP/插件/hooks） | 10 | 95 | 代差；短期补不齐 |
| 多智能体编排 | 40 | 90 | 大；neo 只有一层串行子代理 |
| 产品形态 / 多宿主 / 协作 | 15 | 95 | 代差；不在同一品类 |
| 记忆 / 项目知识 | 85 | 75 | **neo 领先** |
| 中文 / 本地化工程 | 90 | 70 | **neo 领先** |
| 可复现 / 可审计 | 80 | 50 | **neo 领先**（CC 有静默上下文剥离） |

**一句话**：如果只服务你一个人写代码，neo 大约在 CC 的 80–90%；如果作为可交付给团队/企业的产品，neo 大约是 CC 的 20%。这两句话同时成立。

---

## 1. 评估口径与局限（先说清楚，避免拿结论当定律）

### 1.1 版本与状态

- **neo**：v0.3.4，`src/` 约 19,500 行，Bun + TypeScript，无框架依赖。审计实测：`tsc --noEmit` exit 0；`bun test` **881 pass / 0 fail（53 文件，5.88s）**；`scripts/pty-e2e.ts` **19/19 PASS**。
- **Claude Code**：本机 2.1.301；官方 changelog 2.1.310，本机 `.last-update-result.json` 记录 `install_failed`（2026-10-19），**落后 9 个版本**。以下 CC 能力以 2.1.301 实测 + 官方文档（code.claude.com/docs/en/*）为准。

### 1.2 受控小实验（同模型对比）

为了排除「模型差异」这个最大混淆项，把两边都指向 **MiniMax-M3**：

| | neo | Claude Code |
|---|---|---|
| 模型 | MiniMax-M3（OpenAI 兼容端点） | MiniMax-M3（Anthropic 兼容端点） |
| 权限 | `-y`（全放行） | `--dangerously-skip-permissions` |
| 配置隔离 | 独立临时 `settings.json` | 独立 `CLAUDE_CONFIG_DIR` + `--settings` |
| 任务 | 5 个失败用例的小型 TS 项目（CSV/金额解析，3 处缺陷） | 同左 |
| 提示词 | 同一条：「定位根因并修复 src/，不改 tests/，跑 bun test 全绿，一句话说明根因」 | 同左 |

结果：

| 指标 | neo | Claude Code |
|---|---|---|
| 结果 | 6/6 通过 | 6/6 通过 |
| 测试文件是否被改 | 否 | 否 |
| 改动文件 | 3 个源文件 | 3 个源文件 |
| 耗时 | **62s** | 162s |
| 工具调用 / 轮次 | 23 次工具调用（read 13 / shell 7 / edit 1 / write 2） | 26 turns；usage：input 40K、output 18K、cache-read 482K、thinking 13.6K |
| 额外产出 | 指出 legacy 文件与欧式小数未覆盖 | 额外实现了欧式小数、BOM、CRLF 等防御式解析 |

**同模型下，小任务打成平手，neo 还更快**。但必须说清：n=1、任务小、CC 的额外严谨（防御式解析、更多验证）也消耗了时间；这不是性能基准，只是「体感为什么够用」的一个可复现注脚。

另外两个**附带发现**（都指向 neo 的实际优势）：

- 本机 Claude Code 配置指向你现有的 ipsa 网关时，`-p` 直接失败（`There's an issue with the selected model`）；换成 MiniMax 的 Anthropic 兼容端点才能跑。**neo 用同一网关（OpenAI 兼容协议）可以直接跑**——模型/供应商自由度是 neo 的真实护城河。
- neo 在 `-p` 下仍会创建 `.neo/wiki` 脚手架（log/INDEX），属于无伤但需要知道的行为。

### 1.3 局限

- 实验样本 n=1，任务规模小，结论只适用于「小步编码任务」。
- 未测长会话（触发多次压缩）、大仓库（grep/gitignore）、网络故障（429/超时）、CI 自动化——这些恰恰是差距放大的地方，依据来自代码审计与缺陷复现，而非本实验。
- 评分是我的判断值，用于排序优先级，不是 benchmark。

---

## 2. 差距的真相：三个层，不是一层

### 2.1 第一层：单人日常编码闭环 → 差距小（80 vs 92）

这一层的要素 neo 全部具备，且实现不算敷衍：

- **主循环**：流式、工具调用解析、assistant(tool_calls)↔tool 配对、abort 回滚、空正文 nudge 重试、工具预算提示（第 N/80 轮）都有，且注释里能看到真实踩坑（`src/agent.ts:391-757`）。
- **工具面**：16 个（交互模式）——read/write/edit/list_dir/glob/grep/shell/web_fetch/use_skill/compact_ctx + task/remember/wiki_*/send_message/list_peers。CC 有 46 个，但**日常任务 90% 只用到其中 6–8 个**，neo 一个不缺。
- **上下文**：75% 阈值自动压缩 + `/compact` + 模型主动 `compact_ctx`（安全切点设计正确）。
- **子代理**：`task` 工具，深度 1、24 轮上限、上下文隔离、静音输出。对「探索 / 多文件改动」够用，只是不能并行。
- **技能**：SKILL.md + 索引渐进披露，与 CC 的 skills 同一思路。
- **模型调度**：档位分类器（规则/LLM/off）+ 跨 provider 路由 + 降级，比 CC 的 `/model` 手切更自动化，是 neo 的特色。

**为什么体感差不多**：agent 完成度的方差主要来自模型能力，其次来自「核心工具是否齐 + 上下文是否爆」；neo 这两项都过关。剩下的差异在长尾——长尾只有踩中才感知得到。

### 2.2 第二层：工程健壮性 → 差距中等，但全是「具体 bug」而非「架构不可救」

这一层是 neo 当前最值得投入的地方。审计+复现得到的 P0/P1：

| 优先级 | 缺陷 | 证据 | 真实后果 |
|---|---|---|---|
| P0-1 | **LLM 请求零重试、零超时** | `src/llm.ts:196-201`，fetch 只有 signal；全仓 retry 仅锁文件重试 | 429/5xx/网关挂起 ⇒ 整轮报废；没有检查点，只能从头再来 |
| P0-2 | **压缩丢信息**：摘要器每条消息只见 160 字符；压缩后只留一条摘要，不保留最近 N 条原文 | `src/agent.ts:268-279`、`836-839`、`311-315` | 超 75% 窗口后文件路径/命令/错误栈进入摘要即丢；长任务改错文件 |
| P0-3 | **`edit_file` 单次替换用 `String.replace(old,new)`** | `src/tools/index.ts:224` | `new_string` 含 `$&`/`$1` 时被静默展开，文件写坏且提示「已修改 1 处」（已复现） |
| P0-4 | **无检查点 / 撤销 / diff / 工作区隔离** | `writeFileSync` 直写（`tools/index.ts:169,225`）；全仓无 checkpoint/rewind/undo | 一次误改不可恢复；abort 只回滚消息不回滚文件 |
| P0-5 | **grep/glob 不守 `.gitignore`、纯 JS 扫盘、无上下文行** | `tools/index.ts:474-525`、`335-363`；已复现忽略目录仍被搜到 | 大仓库噪声吃光预算、可能把忽略的密钥读进上下文；性能随仓库线性劣化 |
| P0-6 | **`-p` 不适合自动化**：无 `--output-format json`、LLM 失败仍 exit 0、非 TTY 默认拒绝一切审批 | `src/index.ts:750`；`src/ui/console.ts:589-597` | 无法接 CI / 其它编排器；脚本拿不到结构化结果 |
| P1-7 | 权限模型只有 4 个全局模式 + y/N；`insideCwd` 是死代码；`read_file /etc/hosts` 零审批（已复现）；plan 模式拦不住 `wiki_write` | `tools/index.ts:27-34,922`；`agent.ts:820-832` | 要么频繁点 y 打断节奏，要么 `-y` 全放行无防护；`neo.sh` 默认就是 `--yes` |
| P1-8 | token 统计/计费不可靠：未请求 `stream_options.include_usage`，压缩/子代理消耗不计 | `llm.ts:92-108` | 成本不可控，无法做预算管理 |
| P1-9 | 工具串行 + 服务端 `parallel_tool_calls=false` | `agent.ts:641-665`；`llm.ts:104` | 读 10 个文件要 10 轮，长任务提前撞 80 轮上限 |
| P1-10 | 子代理不可并行/后台/嵌套/命名/恢复，无 worktree 隔离 | `tools/task.ts` | 大范围探索/批量改动的加速手段有限 |
| P1-11 | 无 TodoWrite 类结构化待办 | 全仓 grep 无命中 | 多步长任务易丢步骤、重复探索 |
| P1-12 | 无 MCP / hooks / 插件 / 自定义命令 / 自定义工具 | 全仓 grep 均 0 | 接不进 LSP/数据库/浏览器/团队工具链；没有确定性护栏 |

> 注：P0-3 的 `$&` 问题值得单独强调——它不报错、不拦截、返回成功，属于「信任被静默破坏」的一类 bug，比功能缺失更伤。

### 2.3 第三层：平台 / 生态 / 治理 → 代差（15 vs 95）

Claude Code 2.1.301 实测/官方文档的规模指标：

| 指标 | Claude Code | neo |
|---|---|---|
| 内置工具 | **46** | 16 |
| CLI flag / 子命令 | 66 / 18 | 约 15 / 0 |
| Slash command 条目 | **120** | 约 32 |
| Hook 事件 | **33**（4 类 handler，可阻断） | 0 |
| 权限模式 | 6（manual/plan/acceptEdits/auto/dontAsk/bypass + 规则系统） | 4（ask/auto-edit/auto-all/plan） |
| 配置层级 | 5 层 + managed/MDM + gateway | 3 处候选文件 + 环境变量 |
| 子代理并发 | 20，可 resume/fork/后台/团队 | 串行、深度 1 |
| 编排层级 | subagent → agent teams → dynamic workflows（脚本化上百 agent） | 一层 |
| 宿主 | CLI / IDE / desktop / web / cloud / Chrome / Slack / CI / SDK | CLI |
| 治理 | OTel、企业网关、组织策略、审计、成本看板、ZDR | 无 |
| 版本节奏 | 311 个 changelog 版本，每版十几项修复 | v0.3.4 |

这一层的差距不是「再写 30 个工具」能补的，而是**人月 × 时间**。判断它是否重要，取决于你把 neo 当「自己的趁手工具」还是「要卖/要推广的产品」。

---

## 3. neo 反而领先 / 不该自卑的地方

这些在对比时经常被忽略，但都是真实的结构性优势：

1. **记忆系统（领先）**：双作用域 wiki（项目/用户）+ 自动捕获→提炼→校验→合并→审计→召回，约 2,900 行；有 PII、去重、journal 恢复、`/memory why`。CC 只有 CLAUDE.md + auto memory，深度不在一个量级。
2. **跨会话信箱（CC 无等价物）**：`send_message`/`list_peers` + 会话状态机 + watchdog + 委派台账；CC 的 agent teams 是实验态且官方明确「不能 resume in-process teammate、不能嵌套、lead 不可换」。neo「每会话子进程 + 真续接」在可恢复性上反而更稳。
3. **可复现 / 可审计（领先）**：CC 有服务端 GrowthBook 控制的静默上下文剥离（microcompact，无开关、`/export` 与实际请求体不一致，issue #42542 仍 OPEN）；neo 的压缩是显式的、可见的、可被模型主动触发的。需要「同输入必同上下文」的场景，neo 更有优势。
4. **CJK 工程化**：显示宽度、1.5 字符/token 的中文估算、中文停用词、中文提示词与 TUI；面向中文用户的完成度高于多数英文 harness。
5. **模型自由度**：OpenAI 兼容协议，任意网关可接；CC 与 Anthropic 协议/订阅强绑定（本机指向 ipsa 网关即失败）。
6. **工程纪律（超出个人项目平均）**：881 测试 / 53 文件 / 5.88s，19 场景真 PTY E2E，注释里记录踩坑与设计取舍；这是对抗「单人维护 vs 300 版本迭代」最有效的对冲。
7. **工具预算提示**：把「第 N/80 轮、剩余 ≤5 强制收敛」告诉模型，显著减少「半截答案」——CC 不这么做。

---

## 4. 你会在什么时候真的翻车（场景清单）

按发生概率 × 杀伤力排序。这些不是理论，是代码里能指到的路径：

1. **长会话 / 大重构**（最可能先遇到）：连续工作 1–2 小时、多次压缩后，模型忘了早先的约束或改错文件 —— P0-2。
2. **网络抖动 / 网关限流**：一次 429 或 30s 以上挂起就整轮报废，且没有检查点 —— P0-1。
3. **改到含 `$&`/正则/模板串的代码**：静默写坏，测试未必立刻红 —— P0-3。
4. **误操作**：`rm` 错文件、覆盖错文件、abort 后工作区半改 —— P0-4（无 checkpoint）。
5. **中大型仓库探索**：grep 把 `dist/`、日志、生成物全扫进来，命中预算被噪声吃光；隐藏目录（`.github/` 等）直接看不见 —— P0-5。
6. **接 CI / 定时任务 / 别的编排器**：`-p` 没有 JSON、失败 exit 0 —— P0-6。
7. **接团队工具链**（Jira/DB/浏览器/LSP）：没有 MCP，只能临时写脚本 —— P1-12。
8. **多人/合规场景**：无沙箱、无审计、无策略，`neo.sh` 默认全放行 —— P1-7。

反过来，**这些场景你现在大概率碰不到**：单文件 bug、小功能、写测试、读文档、脚本化小工具 —— 所以体感「够用」是真实的，不是错觉。

---

## 5. 如果要把差距压到「体感以下」，我建议的顺序

### P0（1–2 天内，收益最大，都是局部改动）

1. **LLM 调用加重试 + deadline**：429/5xx/网络错误指数退避 3 次，连接与首字节超时；失败明确报错并保留已有上下文。验收：注入 429/超时用例，`bun test` 覆盖。
2. **压缩保留原文窗口**：压缩后保留最近 N（如 6–10）条消息原文 + 摘要；摘要输入不再用 160 字符截断（或提高到 2k 并保留路径/命令）。验收：构造 100 轮历史，压缩后最近一轮的 `path:line` 仍可检索。
3. **修 `edit_file` 的 `$&`**：单次替换改用 `src.split(oldS).join(newS)` 或 `replace(oldS, () => newS)`。验收：`new_string` 含 `$&`、`$1`、`$$` 的用例。
4. **加最小检查点**：每次 write/edit 前把原文件备份到 `.neo/backups/<session>/`，提供 `/rewind` 或至少 `--resume` 时提示；或直接借 git（工作区已 git 化时用 `git stash create`）。验收：误改后可一键还原。
5. **grep/glob 语义对齐 ripgrep**：优先 shell 调 `rg`（缺失时回退当前实现），尊重 `.gitignore`、不跳隐藏文件、支持 `-A/-B/-C`；glob 同理用 `fd`/`rg --files`。验收：`.gitignore` 忽略目录不再命中；`.github/` 可见。
6. **`-p` 可自动化**：`--output-format json`（至少 summary 一行 JSON：tokens/tools/duration/finish_reason），LLM 失败 exit≠0，`--permission-mode` 显式化。验收：CI 脚本能稳定解析结果与失败。

### P1（差异化，不必全抄）

7. **MCP 客户端**（比 hooks 更值的生态入口）：stdio + HTTP，工具动态注册，权限归入现有 approve。
8. **hooks**：至少 `PreToolUse`（拦截/改写）、`PostToolUse`（格式化/审计）、`Stop`。这是「确定性护栏」的唯一正解。
9. **权限规则 + 路径围栏**：`allow/deny` 规则（工具 + 命令前缀 + 路径 glob），`read_file` 越界拒绝，plan 模式覆盖所有写路径（含 wiki_write/use_skill）。
10. **TodoWrite 类待办 + 简单 diff**：成本极低，长任务收益明显。
11. **并行工具 + 子代理并行/后台**：先放开 `parallel_tool_calls`（只读工具可并行），再做 subagent 并发池。
12. **token 计费可见**：`stream_options.include_usage` + 压缩/子代理消耗并入账 + `/cost`。

### 不建议做

- 不要把 46 个工具/120 条命令/12 个宿主当目标：那是 Anthropic 的生态位，不是你的。
- 不要为了「对齐 CC」破坏 neo 已有的优势（显式压缩、可审计、每会话子进程、中文工程化）。
- 不要在没有重试/检查点之前扩展工具面——那只会放大「任务失败后不可恢复」的痛感。

---

## 6. 最终判断

- **「neo 是否还有很大的差距？」** 取决于坐标轴：
  - 当作**你个人的编码代理**：差距不大，日常任务 80–90% 等效，部分维度（记忆、中文、可复现、模型自由度）neo 更强。
  - 当作**要交付给团队/客户的产品**：差距很大（生态、治理、沙箱、多宿主、CI、稳定性），是「3–5 年工程投入」级别的差距，且没有补齐的必要。
- **体感为什么准**：因为瓶颈本来就在模型 + 核心工具 + 上下文，neo 都过关；差距藏在长尾（长会话、大仓库、网络故障、自动化、生态集成），不踩中就不显形。
- **最该做的不是「追平 CC」，而是把 P0 六个具体缺陷修掉**。修完之后，neo 在「单人日常编码」这个口径上会稳定进入 CC 的 90% 区间，同时保留 CC 补不回来的可复现性与中文优势。

---

## 7. 修复状态（2026-10-26 完成）

§2.2 的 6 个 P0 已全部修复，每项独立 commit + 专项测试，全量验证 `tsc 0 / bun test 913 pass（57 文件）/ PTY 19/19`（`bash scripts/verify.sh` ALL GREEN）。

| # | 缺陷 | commit | 关键改动 | 新增测试 |
|---|---|---|---|---|
| P0-3 | `edit_file` 的 `$&` 写坏文件 | `c0d8443` | 单次替换改 split/join，按字面写入 | `tests/core.test.ts`（5 种替换模式 + replace_all） |
| P0-1 | LLM 零重试/零超时 | `0c90a2e` | 只重试「未输出任何增量」的失败；指数退避 + Retry-After；连接 30s / 空闲 120s 超时；无 [DONE] 且无 finish_reason 的 EOF 判为断流 | `tests/llm-retry.test.ts`（9 场景，Bun.serve 本地假端点） |
| P0-2 | 压缩丢信息 | `46faaa0` | 摘要较早历史 + 保留最近 ≥6 条原文；摘要输入 160 → 2000 字符；压缩 usage 入账 | `tests/compact-ctx.test.ts`（+3 场景） |
| P0-5 | grep/glob 不守 .gitignore | `cf324b9` | git 工作区用 `git ls-files` 枚举（含隐藏、排除 ignored、展开软链）；非 git 回退内置 gitignore 匹配器；匹配仍用 JS 正则 | `tests/search-ignore.test.ts`（6 场景） |
| P0-4 | 无检查点/撤销 | `6c10784` | `.neo/backups/<session>/` 快照 + JSONL manifest；`/undo [n]`、`/checkpoints [n]`；仅覆盖工具写路径 | `tests/checkpoint.test.ts`（8 场景） |
| P0-6 | `-p` 不可自动化 | `795fe31` | `--output-format json`（stdout 单行，UI 走 stderr）；退出码 0/1/2/130；TurnStats 记录 hadError | `tests/cli-json.test.ts`（4 场景 spawn 真 CLI） |

**修复后仍存在的边界（诚实标注）**：

- shell / 外部进程修改文件不在 `/undo` 覆盖范围（只覆盖 `write_file`/`edit_file`）；
- P0-5 依赖本机 git 可用（无 rg）；非 git 目录的内置 gitignore 匹配器是最小实现（否定规则/复杂嵌套有近似）；
- 压缩保留 6 条原文是固定值，未做成 settings 可调；
- P1 项（MCP / hooks / 沙箱 / 权限规则 / 并行工具 / TodoWrite / 计费）本次**未动**，仍按 §5 的优先级建议处理。

---

## 附录 A：关键证据索引

**neo（本仓库）**

- 主循环与压缩：`src/agent.ts:391-757`、`261-319`、`268-279`、`836-839`、`311-315`
- 工具：`src/tools/index.ts:105-798`（read/write/edit/glob/grep/shell/web_fetch）、`:27-34,922`（路径围栏死代码）、`:224`（`$&`）
- LLM：`src/llm.ts:189-312`（fetch 无重试）、`:104`（禁并行）、`:326-383`（token 估算）
- 权限：`src/agent.ts:820-832`、`src/ui/console.ts:589-607`、`neo.sh`
- 子代理：`src/tools/task.ts`
- 记忆：`src/memory/*`（约 2,900 行）
- 信箱：`src/mailbox/*`（store/identity/state）
- 测试：`tests/`（55 文件）、`scripts/pty-e2e.ts`

**Claude Code（2.1.301 本机 + 官方文档）**

- 工具 46：`code.claude.com/docs/en/tools-reference`
- 上下文（auto-compact / microcompact / idle）：`/context-window`、changelog 2.1.290
- Hooks 33 事件：`/hooks`
- 权限 6 模式 + 沙箱：`/permissions`、`/sandboxing`
- 编排：`/sub-agents`（20 并发）、`/agent-teams`（实验态与限制）、`/workflows`
- 记忆：`/memory`
- 已知问题：GitHub `anthropics/claude-code#42542`（静默上下文剥离）、`#16157`/`#38335`（额度与计费）；HN 官方回应（cache miss 成本）

**本次生成的完整审计材料**（临时目录，未提交仓库）：`/tmp/neo-vs-cc/neo-audit.md`（436 行）、`/tmp/neo-vs-cc/claude-code-capabilities.md`（580 行）；受控实验目录 `/tmp/hbench/`。

## 附录 B：CC 本机能力面速查（与上文评分对应）

| 能力 | 状态 |
|---|---|
| Headless / SDK / CI | `-p`、`--output-format json/stream-json`、`--agents`、`--mcp-config`、Agent SDK、GitHub/GitLab CI |
| 多宿主 | CLI、VS Code/JetBrains、desktop、web/cloud、Chrome、Slack、Remote Control、`--bg`/`attach`/`logs` |
| 编排 | subagent（20 并发、resume/fork）、agent teams（实验）、dynamic workflows（脚本化） |
| 治理 | 5 层 settings、managed/MDM、OTel、企业 gateway、审计、ZDR |
| 上下文 | 100K–1M 可调、auto-compact、idle compaction、checkpoint/rewind（官方自陈不追 subagent 编辑） |
| 风险面 | 服务端静默行为（914 个 GrowthBook flag）、计费不透明、版本/文档漂移、复杂度税（66 flag/120 命令/247 设置键） |
