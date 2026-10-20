# neo 记忆系统设计(第一稿)

> 目的:让 neo 跨会话保留对项目、对用户、对历史工作的认知。
> 范围:本文只覆盖设计与路线,不进入实现细节。
>
> **2026-10-20 追加**:§1–§6 是第一稿(v0.1 设计,历史保留)。**当前有效规格 = §7「v0.2 记忆激活」**,
> 含完整 PRD、接线点、验收与回滚方案。二者冲突时以 §7 为准。

---

## 1. 现状盘点

neo 当前的持久化能力非常薄:

- **会话原文**:`src/session.ts` 把整轮对话落盘到 `~/.neo/sessions/*.json`,支持 `--resume` 恢复。这只是**回放**,不是记忆。
- **项目脚手架**:`src/system-prompt.ts` 的 `buildMemoryFile()` 在 `/init` 时生成 `AGENTS.md`,但写完就走人,**启动时从不读回**。
- **对话压缩**:`src/agent.ts` 的 `compact()` 把历史压成一条 system 摘要 —— 这是**一次性、用完即弃**的,跟记忆是两件事,但底层都是"让模型做摘要"。

结论:记忆系统的核心缺失,不是"存哪里",而是**写入、维护、检索、注入**这一整套。

---

## 2. 记忆分四层

| 层 | 内容 | 存储 | 共享性 | 状态 |
|---|---|---|---|---|
| **L0 项目约定** | 命名规范、目录职责、构建命令、提交风格 | `<cwd>/AGENTS.md` | 进 git,团队共享 | `/init` 写了但**从不读** |
| **L1 项目事实** | 架构、关键模块作用、外部依赖、踩坑 | 同上 | 同上 | 完全没有 |
| **L2 用户偏好** | 跨项目风格、工具链习惯、审美 | `~/.neo/memory.md` | 本机,不进 git | 完全没有 |
| **L3 情景/进度** | "上次做到哪、下一步是什么" | `~/.neo/projects/<hash>/state.md` | 本机 | 完全没有 |
| **L4 会话原文** | 工具结果、对话过程 | `~/.neo/sessions/*.json` | 本机 | **已有** |

关键边界:

- **L0/L1 进 git,L2/L3/L4 不进**。这是边界设计,不是建议 —— 团队约定该共享,个人偏好不该。
- **L0 与 L1 同文件但不同语义**:L0 由人维护,L1 由系统自动写。文件结构上要分节标注。
- **L4 不是记忆**。它是回放,作用是恢复中断的会话。混在一起会导致"压缩时把记忆也压掉"。

---

## 3. 三个根本设计问题

这三条必须先想清楚,否则做出来的东西很难用。

### 3.1 谁负责写?

| 选项 | 优点 | 缺点 |
|---|---|---|
| A. 模型自动写 | 自然,能抓语义 | "什么值得记"不可靠,易塞垃圾 |
| B. 程序提取 | 可靠,零成本 | 只能记"做了什么",记不了"为什么" |
| C. 用户显式写 `/remember` | 精确 | 违背"老友同事"的协作模式 —— 不该是用户的工作 |

**推荐 A+B 组合**:程序从 `tool_calls` 提取改动事实(改了哪些文件、读了哪些文件、跑了哪些命令),轻量模型提炼约定/坑/原因,两者合并写入。`/remember <text>` 作为兜底手动命令。

### 3.2 怎么注入才不会爆上下文?

- 不能整个 `AGENTS.md` 塞进 system prompt —— 内容会无限增长,迟早爆。
- 必须**按相关性筛选**:基于当前 cwd + 最近 user input,匹配 Top-N 段落注入。
- 每条记忆必须带**来源标签**,否则模型无法判断"该信哪条":
  ```
  [项目约定] 命名用 camelCase,组件文件名 PascalCase
  [用户偏好] 输出不加"还有什么可以帮你"这类收尾
  [踩坑 · 2026-01] openai SDK 1.x 不支持 streaming tool_calls 拼接,要手拼
  [上次会话] 项目记忆系统做到 M2,下一步是 M3 检索
  ```
- 时间戳 + 来源 = 模型可以判断"这是历史经验还是当下事实"。

### 3.3 遗忘机制必须有

记忆系统的死亡方式不是写不出来,是**塞满过期垃圾**。

- 容量上限:总条数 / 总字节数。
- 时间衰减:超过 N 天的非核心记忆打 `stale:` 前缀,**不直接删除** —— 给 `/forget` 留确认机会。
- LRU 淘汰只在容量超限时触发,不要主动丢东西。

---

## 4. 与 `/compact` 合并实现

`compact()` 现在做的是"压对话",记忆提炼做的是"提记忆"。两者底层都是一次 LLM 摘要调用 —— **合并成一个**:

```
输入:本轮对话 + 工具调用列表
输出:
  <summary>
    ...对话压缩摘要...
  </summary>
  <memory>
    - [项目约定] ...
    - [踩坑] ...
    - [上次会话] ...
  </memory>
```

- `<summary>` 写回 messages 替换历史。
- `<memory>` 解析后追加到对应记忆文件。
- 一次调用做两件事,基础设施少写一半,延迟/成本也少一半。

---

## 5. 开发路线

按"风险/收益比"排,M0 最划算,M3 是质变。

### M0 · 让 `/init` 真正生效 · 半天

- 启动时若 `AGENTS.md` 存在,把它注入 system prompt 的"约定"段。
- `buildSystemPrompt()` 加 `memory: string | null` 参数。
- 注入时标注 `[项目记忆]` 前缀。
- **风险最低,收益最确定**:零新存储、零新写入、只改读取路径。

### M1 · 程序提取改动事实 · 1~2 天

- 在 `Agent.send()` 末尾遍历本轮 `tool_calls`,提取:
  - `write_file` / `edit_file` 的目标路径 → 改动文件清单
  - `read_file` / `grep` / `glob` 的路径 → 关注文件清单
  - `shell` 的命令 → 跑过的命令(摘要)
- append 到 `~/.neo/projects/<hash>/facts.jsonl`(每条带 ISO 时间戳)。
- 这是结构化数据,后续检索方便,容量可控,**零 LLM 成本**。

### M2 · 模型提炼记忆 · 2~3 天

- 复用 `fast` 档调用,输入本轮对话摘要 + M1 的 facts,输出 3~5 条 `<memory>`。
- 与 M1 合并去重后,按来源写回:
  - `[项目约定]` / `[踩坑]` → `AGENTS.md`
  - `[用户偏好]` → `~/.neo/memory.md`
  - `[上次会话]` → `state.md`
- **同时改造 `compact()`**:在现有 prompt 后追加提炼 `<memory>` 的子任务。一次调用两个输出。

### M3 · 相关性检索 · 2~3 天

- 关键词匹配 + 文件路径三元组(`file:section:line`)做锚点。
- 启动时按 cwd + 最近 user input 选 Top-N,注入量控制在 2~3KB。
- 新增命令:
  - `/memory` 查看当前记忆
  - `/forget <pattern>` 按关键词清理
  - `/remember <text>` 手动追加
- **MVP 不做向量检索**。关键词 + 路径匹配解决 80% 场景。

### M4 · 团队共享 · 可选,1~2 天

- `.neo/memory.local.md` 进 `.gitignore`,本机记忆写到这。
- `AGENTS.md` 进 git,作为团队共享约定。
- `settings.json` 加 `memory` 段:`disabled` / `read_only` / `auto_write` 三档权限,防止误写污染。

---

## 6. 会踩的坑

- **不要先做向量检索**。关键词 + 路径匹配解决 80% 场景,向量是锦上添花。Premature optimization is the root of evil.
- **记忆段落要给模型"该不该信"的提示**。踩坑记忆必须带日期,模型才知道这是历史经验而非当下事实。
- **记忆文件损坏不能让 agent 崩**。读不出来就降级到"无记忆"模式,日志一行提示,不抛错。
- **`-C` 切换 cwd 时要重新加载项目记忆**。当前 cwd 变了,`AGENTS.md` 就该重读,否则会注入错项目的约定。
- **路径迁移要带 schema 版本号**。`SessionFile` 现在有 `version: 1`,记忆文件也该有 —— 不然 M2 改了格式,M3 读老文件就崩。
- **`/compact` 与记忆提炼合并时,要先做 `<memory>` 再做 `<summary>`**。顺序反了模型会把"该记的事"塞进 summary,提不出来。

---

## 7. v0.2 记忆激活升级规格（2026-10-20，当前有效）

> **状态**:待实现（实施前须经仓库作者确认）
> **目标版本**:v0.1.11
> **规格日期**:2026-10-20
> **基线**:commit `f5d6a35`（v0.1.10，tsc 0 错误 / 402 pass / 1 skip）
> **地位**:§1–§6 是第一稿，历史保留；本节的实施规格取代第一稿中未实现的部分（§5 的 M1–M4 路线由 §7.17 里程碑替代）。
> **回逆**:本节的回滚与数据回退步骤见 §7.18；所有新增行为均受配置开关控制，可一键停用。
> **文档策略**:记忆功能**只维护这一份规格**，不再另开 PRD。后续每次升级都在本节追加带日期的「变更记录」，
> 说明为什么改、改了什么；正文保持为当前有效规格。

### 7.0.1 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-10-20 | 追加 §7「v0.2 记忆激活」完整规格（双作用域存储、自动归纳、项目优先召回、旧记忆迁移、回滚方案） | v0.1.x 记忆系统只写不读、用户级 wiki 从未创建；需要把「记录→提炼→召回→注入」闭环接通 |
| 2026-10-20 | 拍板 D1–D7（见 §7.3） | 仓库作者确认；其中 -p 只用项目级记忆，避免服务器脚本混入操作员个人记忆 |
| 2026-10-20 | 实现 M0–M4 并交付 v0.1.11 | 见 §7.17、`docs/release-notes/v0.1.11.md` |

### 7.0 一句话定位

让记忆从"只写不读的空转模块"变成**双作用域闭环**：
一轮问答结束后自动归纳（项目级沉淀事实/决策/踩坑，用户级沉淀个人画像与偏好），
下一次提问时**先项目级、再用户级**召回并注入，使回答带有历史上下文。
用户不需要说"记住"，也不需要手动整理。

### 7.1 现状实证（2026-10-20 探针，决定方案形态）

| # | 事实 | 证据 |
|---|---|---|
| 1 | 用户级 wiki `~/.neo/wiki/` **不存在**（从未创建） | `find ~/.neo -maxdepth 3 -type d` |
| 2 | 用户级 raw 索引只有 7 条，内容为 `exit` 这类首条输入截断，信噪比极低 | `~/.neo/memorys/raw/2026-10-16_ai-info_a5c7b88e.md` |
| 3 | `profile.md` **全仓无写入者**，启动注入恒为空 | `grep -rn "profile\.md" src/` 只有读路径 |
| 4 | `ingestUserLevel` **零生产调用点**，`wiki/index.md` 从未生成 | `grep -rn "ingestUserLevel" src/` |
| 5 | 记忆互斥锁**从未生效**：`mkdirSync(recursive:true)` 对已存在目录不抛 EEXIST | 探针实测：第二次 mkdir 静默成功；非递归则抛 EEXIST |
| 6 | `wiki_write append` **不同步 INDEX**（返回 `indexSynced:false`），且 log 类型默认 `query` | 探针实测输出 |
| 7 | 启动注入位 messages[1] 已存在（role=system），但无内容可注入 | `src/memory/profile.ts:263`、`src/index.ts:373` |
| 8 | 项目级 wiki 机制完备：命名/摘要/日期戳校验、INDEX/log 同步、lint、检索均已可用 | 探针：10 个候选页名 + 标准模板全部通过校验 |
| 9 | PII 脱敏可复用：`redactPII(text) → {text, counts, total}` | 探针实测 openai-key/email 均被替换 |
| 10 | 静态工具清单被测试锁死为 10 个；组合根已可追加运行时工具（task/wiki_*） | `tests/core.test.ts:61-73`、`src/tools/index.ts:828` |

**结论**：项目级 wiki 的写入/校验/检索机构已经完备，可直接作为记忆存储层；
缺的是「自动归纳 → 落页 → 召回 → 注入」这条链路，以及用户级存储的建立。
因此本方案**复用 wiki 机制，不另造存储格式**。

### 7.2 目标与非目标

**目标（可验收）**

1. 一次有信息量的问答结束后 ≤5 秒，对应记忆页被创建或更新，界面只增加一行 dim 提示。
2. 新会话提问时自动召回：先项目级（≤2 页），再用户级（≤1 页），总注入 ≤900 token，无命中则零注入。
3. 跨会话生效：会话 A 写入的记忆，会话 B 能召回；用户级跨项目共享，项目级只在所属 cwd 可见。
4. 20 次相似对话不产生重复页；每页写入可追溯（`/memory why` 可解释来源）；`/memory forget` 可删。
5. 不阻塞主流程：写入后台异步，任一环节失败只降级不打断；启动零 LLM 调用、额外开销 ≤15ms。
6. 项目级 wiki 继续通过 `/wiki-lint` 0 error。

**非目标（本期明确不做）**

- 向量检索 / embedding（零依赖原则；`recall.ts` 保留接口，将来可换）。
- 后台 daemon / supervisor / 跨进程常驻。
- 自动改写 `AGENTS.md`（人工维护区，只读不写）。
- 跨会话消息 / mailbox（仍属 v0.2.0 的 cross-session-messaging PRD）。
- 用 LLM 做冲突二次仲裁（先 `supersedes` 机制 + 人工查看）。
- 自动 git commit（记忆页会出现在 `git status`，由人决定何时提交）。

### 7.3 已拍板决策（仓库作者，2026-10-20）

| # | 决策 | 结论 | 落点 |
|---|---|---|---|
| D1 | 项目级自动写入默认档位 | **boundary 全自动**（有信息量的轮次自动写） | §7.6.1 / §7.9 `auto_capture.mode` |
| D2 | 用户级是否允许推断 | **允许，但必须显式标识为"推断"**，与用户明确表达的事实分区存放 | §7.5.5 / §7.6.5 |
| D3 | 提炼模型档位 | **fast 档** | §7.9 `auto_capture.model_tier` |
| D4 | journal 位置 | **`~/.neo/memory/journal`**（不进 git，生命周期独立） | §7.5.2 |
| D5 | `-p` 单次模式的记忆范围 | **只用项目级**：不读用户画像、不召回用户库、不写用户库、`wiki_search`/`wiki_write`/`remember` 的用户作用域一律拒绝 | §7.4 / §7.7.1 / §7.7.2 |
| D6 | 文档维护方式 | 记忆功能**只维护一份规格文档**（本文件 §7），后续变更以带日期的「变更记录」追加，不另开 PRD | §7.0.1 |
| D7 | 用户级 wiki 体检 | **独立 `/memory lint` 轻量入口**，复用 lint 实现但不并入项目 `/wiki-lint` | §7.10 |

### 7.4 作用域模型

| 维度 | 项目级（project） | 用户级（user） |
|---|---|---|
| 存储 | `<cwd>/.neo/wiki/{raw,wiki,outputs}` | `~/.neo/wiki/{raw,wiki,outputs}`（新建） |
| 内容 | 本项目的事实、决策、踩坑、架构、进度、待澄清 | 跨项目的用户画像、偏好、环境、经验、长期目标 |
| 共享 | 按仓库共享（`git`） | 本机所有项目共享（不进 git） |
| 可见性 | 仅在对应 cwd 下召回 | 任何 cwd 下都可召回（排序靠后） |
| 写入者 | 自动归纳（boundary）+ 模型 `remember`+ 人工 `wiki_write` | 自动归纳（仅用户相关事实）+ 模型 `remember` + `/remember` |
| 优先级 | 高（本项目具体事实优先） | 低（背景信息，明确标注来源） |
| `-p` 单次模式 | ✅ 读写 | ❌ 完全不参与（服务器脚本场景，见 D5） |

**硬边界**

- 项目级页面**不得**写入用户个人信息（身份、偏好、联系方式）。
- 用户级页面**不得**写入某个项目的内部细节（文件路径、内部代号）；跨项目可复用的是方法论与偏好。
- 提炼器输入带当前 cwd 与作用域候选清单；合并器对 scope/路径做最后裁决。

### 7.5 存储规格

#### 7.5.1 目录布局

```
项目级（不变）                         用户级（新增，与项目级同构）
<cwd>/.neo/wiki/                       ~/.neo/wiki/
├── raw/         人工证据                ├── raw/           归档/历史证据（legacy 迁移）
├── wiki/        ← 记忆页面              ├── wiki/         ← 记忆页面（INDEX.md / log.md 同在此）
│   ├── INDEX.md                        │   ├── INDEX.md
│   ├── log.md                          │   ├── log.md
│   └── *.md                            │   └── *.md
└── outputs/     派生物（ignore）         └── outputs/
```

- 用户级根目录支持环境变量覆盖：`NEO_USER_WIKI_DIR`（测试隔离用，惯例同 `NEO_SESSIONS_DIR`）。
- 骨架懒创建：首次 capture 或首次 `/memory` 调用时创建；启动时**只读**，不存在则跳过注入。
- 骨架内容：`raw/`、`wiki/`、`outputs/` 三目录 + `wiki/INDEX.md`（复用 `syncIndex` 兼容的表格头）+ `wiki/log.md` + `wiki/AGENTS.md`（用户级 schema 说明，由代码生成一次，后续人工可改）。

#### 7.5.2 运行 journal（不属于 wiki）

```
~/.neo/memory/journal/YYYY-MM-DD.jsonl   # 每轮一条 TurnRecord，append-only
~/.neo/memory/capture-log.jsonl          # 提炼/合并结果审计（30 天保留）
~/.neo/memory/.locks/                    # 写锁
```

- 环境变量 `NEO_MEMORY_JOURNAL_DIR` 可覆盖；默认 `~/.neo/memory/journal`。
- 保留期 7 天（`journal_retention_days`），启动时清理过期文件。
- journal 是运行时状态，**不进 git、不参与 wiki 语义**；`~/.neo/memorys/` 迁移后只读保留。

#### 7.5.3 页面分类与命名

| 作用域 | 页面模板 | 内容 |
|---|---|---|
| user | `用户画像.md` | 身份/角色/长期目标；**摘要常驻注入** |
| user | `偏好-<主题>.md` | 代码风格、沟通方式、工具偏好（事实/推断分区） |
| user | `环境.md` | OS、shell、编辑器、常用路径、语言 |
| user | `经验-<领域>.md` | 跨项目可复用的方法论 |
| project | `决策-<主题>.md` | 选了什么、为什么、日期；后续更正追加 |
| project | `踩坑-<主题>.md` | 症状/根因/修法/`文件:行` |
| project | `架构-<模块>.md` | 职责、不变量、数据流 |
| project | `进度-<特性>.md` | 已完成/待办/阻塞（摘要可刷新） |
| project | `待澄清-<主题>.md` | 未决问题（复用现有前缀） |

- 命名一律走现有 `validatePageName`（探针验证：上表全部名称合法）。
- 自动页必须带来源行（见 7.5.4）；人工页不强制。

#### 7.5.4 页面必备结构（自动写入模板）

```markdown
# 踩坑-热键系统

## 摘要

热键必须挂在 input 流而非 readline 实例上，否则热键永不触发。

> 最后更新:2026-10-20
> 来源:session 20261020-1432-ab12 · turn 3 · 自动归纳

## 事实

- 2026-10-20：`hotkeys.attach()` 若挂 rl 实例，keypress 不触发（src/hotkeys.ts:52）。
- 修法：attach(input, stdin)；已加单测钉死。

## 推理与依据

- 证据：本轮修改 src/hotkeys.ts；用户确认热键仍不生效。
```

- `## 摘要` + 日期戳为强制（复用 `validatePageContent`，探针验证模板通过）。
- 自动页额外要求 `> 来源:` 行（session id / turn / 自动归纳），供回逆与审计。
- append 一律落在 `## 推理与依据` 段（复用 `writeBack append`）。

#### 7.5.5 推断标记规格（D2）

用户级页面固定两节：`## 事实（用户明确表达）` 与 `## 推断（待确认）`。

- 事实：用户原话可直接引用，或用户行为明确表达（如"以后都用中文"）。
- 推断：从单次行为/上下文推测，**必须**写成带标记的条目：
  `- （推断 2026-10-20 · 置信 0.7 · session xxxx）可能偏好先给结论再给依据`
- 召回渲染时，推断条目统一加前缀 `[推断]`；系统提示明确"推断仅作背景，不得当作硬性要求"。
- 推断置信度门槛高于事实（见 7.6.4）；推断条目可被后续事实覆盖：命中同一主题时把推断条目标记为 `（已确认）` 或 `（已否定）`，不删除历史。
- 禁止类别：健康、政治、宗教、财务、性取向等敏感推断；除非用户明确陈述，否则不写。
- `/memory list user` 展示待确认推断；用户可手动编辑页面（wiki 是 Markdown，可读可改）。

#### 7.5.6 INDEX / log 同步规则（修正现有缺口）

| 动作 | INDEX | log | 说明 |
|---|---|---|---|
| create | 插入行（摘要 80 字） | `wiki` 类型必登 | 现状即如此，复用 |
| append | **新增：同步刷新该页摘要与日期戳** | `wiki` 类型必登 | 修现状 `indexSynced:false` 缺口 |
| 自动写入 | 同上 | 类型固定 `wiki`（不用默认 `query`） | 区分人工 query 回填与自动沉淀 |

- `log.md` 只在自动写入真正落盘成功后登记；失败不登。
- 自动写入的 log 标题格式：`自动记忆：<scope>/<page>（<op>）`。

#### 7.5.7 锁与原子写

- **修锁**：`acquireCwdLock` 改为「先 `mkdirSync(locksDir,{recursive:true})` 建父目录 → 再 `mkdirSync(lockDir)` 非递归」，
  EEXIST 才表示他方持锁（探针已验证该语义）；TTL 过期扫除保留。
- 作用域锁：`<userWiki>/.locks/user.lock`、`<cwd>/.neo/wiki/.locks/project.lock`（后者加入 `.gitignore`）。
- 进程内串行队列 + 文件锁双层：同一进程内写操作排队；跨进程靠锁目录。
- 原子写：`writeAtomic(path, content)` = 同目录 `*.tmp-<pid>` 写入 + `renameSync`；所有记忆页写入都走它（`writeBack` 内部替换 `writeFileSync`）。
- journal 用 `appendFileSync` 单行 JSON（<4KB 原子追加）。

#### 7.5.8 容量与淘汰

- 单页软上限 16KB；超出时新建 `<页名>-续1.md`（并在原页摘要加指针）。
- 用户画像：事实条目 ≤40 条；超出提示人工整理。推断条目 ≤40 条，超出按「时间最旧 → 置信最低」淘汰（写审计）。
- 项目页不做自动淘汰；由 `/memory forget` 或人工编辑。
- 每会话写入页数 ≤8（`max_pages_per_session`）。

### 7.6 写入链路（capture）

#### 7.6.1 四类触发点

| 触发 | 时机 | 行为 |
|---|---|---|
| **T1 轮末（默认）** | `Agent.send()` 主循环结束、最终回答已渲染、`turn_end` 事件之后 | 价值判定 → 写 journal → 异步提炼 → 落页 |
| **T2 压缩前** | `Agent.compactNow()` 重写消息历史之前 | 用压缩摘要作为 `kind=compact` 的 TurnRecord 提炼（信息即将丢失，优先级最高） |
| **T3 显式** | 模型调用 `remember` 工具；用户 `/remember <text>` | 跳过价值判定，直接进入提炼管线（scope 可指定） |
| **T4 会话退出** | `shutdown` / `rl close` / `-p` 返回前 | `flush(3000ms)` 处理积压 journal |

补充规则：

- `plan` 模式：仅召回、不捕获。
- abort / 回滚轮：不提炼，journal 记 `kind=aborted` 供调试。
- 同一轮重复触发（T1 与 T2 同时）以先到为准，用 `sessionId + turn 序号` 去重。

#### 7.6.2 价值判定（零 LLM 成本的前置过滤）

满足任一即捕获，否则跳过：

- 工具调用 ≥2 次，或触碰文件 ≥1 个；
- 用户消息 ≥80 字且最终回答 ≥300 字；
- 命中信号词：决策/方案/约定/坑/根因/以后/记住/不要再/默认……
- 显式触发（T2/T3）无条件捕获。

纯寒暄、纯查询、abort 轮直接跳过。

#### 7.6.3 TurnRecord（journal 单行）

```json
{
  "v": 1,
  "ts": "2026-10-20T13:05:00.000Z",
  "sessionId": "20261020-1300-ab12",
  "cwd": "/Users/xueyuheng/research/000-alice-new/neo",
  "kind": "turn",
  "turn": 3,
  "user": "前面 500 字，已过 PII 脱敏",
  "answer": "最终正文，截断 2000 字，已过 PII 脱敏",
  "tools": [{"name": "edit_file", "ok": true, "digest": "src/agent.ts"}],
  "filesTouched": ["src/agent.ts"],
  "processed": false,
  "attempts": 0
}
```

**关键取舍**：提炼器只看到「用户说了什么 + 助手最终结论 + 工具名/成败/路径摘要」，
**不接收工具原始输出**。理由：控制 token；避免网页/文件内容构成间接注入污染长期记忆。

#### 7.6.4 提炼器（distiller，fast 档）

- 调用：独立 `chatStream`，`cfg` 为当前配置的浅拷贝 + `applyTier(clone,"fast")`，`temperature=0.2`，`maxTokens=1024`。
- 输入：TurnRecord + 双库现有页面清单（scope/page/摘要 80 字/更新时间）+ 分类法 + 规则。
- 输出：严格 JSON（不允许代码围栏以外的文本）：

```json
{"ops":[
  {"scope":"project","action":"append","page":"踩坑-热键系统.md",
   "summary":"热键需挂 input 流","body":"...","confidence":0.86,
   "inferred":false,"evidence":"用户说热键不生效；本轮修改 src/hotkeys.ts"}
]}
```

**代码侧硬校验**（prompt 之外的第二道闸）：

| 字段 | 规则 |
|---|---|
| `ops` | ≤2 条；超出截断并审计 |
| `scope` | `project` \| `user` |
| `action` | `create` \| `append` |
| `page` | 过 `validatePageName`；不存在时 action 必须为 create |
| `body` | 20–1500 字；不含密钥（过 `redactPII` 后比对变化） |
| `confidence` | 事实 ≥0.65；推断（`inferred=true`）≥0.75 |
| `inferred` | 用户级默认 false；true 时必须落"推断"节并带标记（D2） |
| `evidence` | 非空，且必须能在 TurnRecord 的 user/answer 中找到至少一个 3 字以上片段 |

- JSON 解析失败：重试 1 次（提示"只输出 JSON"）；再失败则 journal 标失败、静默放弃。
- 网络失败：不重试本轮，journal 保留，下次 flush 再试（最多 2 次）。

#### 7.6.5 合并规则（merge）

1. **作用域解析**：`project → 当前 cwd 布局`；`user → NEO_USER_WIKI_DIR`。目标路径 realpath 必须落在对应库内（防穿越）。
2. **去重**：`sha1(normalize(page + body))` 比对目标页全文与最近 200 条已应用 op；四字 shingle 相似度 >0.85 视为重复，丢弃。
3. **事实/推断分流**（用户级）：
   - `inferred=false` → `## 事实（用户明确表达）`；
   - `inferred=true` → `## 推断（待确认）`，条目带日期+置信+session 标记。
4. **冲突/更正**：op 带 `supersedes` 且原句能在页内找到 → 追加 `> 更正 (2026-10-20, session xxx)：旧结论 → 新结论`，刷新摘要；
   `supersedes` 找不到原句则按普通 append 处理（不猜测）。
5. **落页**：create/append 均走 `writeBack`（自动校验 + INDEX + log）；append 同时刷新 INDEX 摘要（§7.5.6）。
6. **上限/审计**：每轮 ≤2 op、每会话 ≤8 页、单页 >16KB 拆分；每个 op 结果写 `capture-log.jsonl`（op/结果/原因/耗时）。

**摘要更新规则**：append 不改摘要，除非新摘要信息量更高（长度 ≥旧摘要 1.2 倍且 confidence ≥0.8）；create 必须有摘要。

#### 7.6.6 `remember` 工具（模型显式写入）

```json
{"name":"remember","sensitive":false,"parameters":{
  "scope":"auto|project|user","title":"一句话标题","body":"事实正文","reason":"为什么值得记"}}
```

- `auto` 判定：正文含"用户/我/偏好/习惯/以后"→ user；含文件路径/模块/项目名 → project；否则 project。
- 与自动管线共用 merge/dedupe/上限；同样受 plan 模式与总开关约束。
- 子代理排除清单加入 `remember`（防止子代理误写主记忆）。
- 系统提示要求：仅在发现可复用结论/用户长期偏好时调用，寒暄与临时状态不要写。

#### 7.6.7 透明度

- 一次写入后 dim 一行：`· 记忆 +1 项目（踩坑-热键系统）` / `· 记忆 +1 用户（推断）`；`quiet=true` 时只在 `/memory status` 可见。
- 每次写入的决策（含被丢弃原因）进 `capture-log.jsonl`，由 `/memory why` 展示最近 5 条。

### 7.7 读取链路（recall）

#### 7.7.1 R0 启动注入（零 LLM，纯文件读）

`buildSystemPrompt()` 增加 `## 记忆库` 节（在 `## 工具` 之后、`## 环境` 之前，与现有 skills/wiki 节并列）：

```
## 记忆库

- 项目记忆：<cwd>/.neo/wiki/wiki（已有主题 13 个：踩坑-…、决策-…、…）
- 用户记忆：~/.neo/wiki/wiki（已有主题 5 个：用户画像、偏好-沟通、…）

检索纪律：回忆时先查项目级（本项目具体事实），再查用户级（跨项目个人背景）。
项目级内容与本项目强相关，用户级内容仅作背景；推断内容以 [推断] 标注，不得当作硬性要求。
有长期价值的结论用 remember 或 wiki_write 回填。
```

- 主题清单各取前 40/20 条，来自两库 `INDEX.md` 的 `[[链接]]`；无库则整段不输出（不报错）。
- `用户画像.md` 的 `## 摘要` + `## 事实` 前若干条渲染为 ≤200 token 的块，注入 messages[1]（role=system，替换现有空转的 profile 注入位）。
- 启动路径只做 `readFileSync`，无 LLM、无写盘。
- **`-p` 单次模式不注入用户画像与用户索引**（D5）：`cfg.memory.scopeMode="project"` 由组合根设置，
  系统提示、召回、工具三处同时生效。

#### 7.7.2 R1 每轮自动召回（turn start）

在 `Agent.send()` 完成分类、推送 user 消息**之前**调用 `memory.recall(text)`：

1. **关键词抽取**：中文 bigram + 英文词 + 停用词过滤，≤12 个；
2. **项目级检索**：`searchScored(projectLayout, terms)` → 取 top2；
3. **用户级检索**：`searchScored(userLayout, terms)` → 取 top1；
4. **渲染**：每页给 `[项目] [[页名]] 摘要前 200 字 + 2 行命中片段`；推断条目带 `[推断]`；
5. **注入**：作为临时 system 消息，内容以固定标记 `【记忆召回·自动】` 开头；总预算 ≤900 token，无命中不注入。
6. **`-p` 单次模式**：只检索项目级（`projectOnly=true`），用户库即使存在也不参与（D5）。

#### 7.7.3 R2 工具检索（工具循环中）

- `wiki_search` 增加 `scope: "auto"|"project"|"user"|"both"`（默认 `auto` = 项目优先合并）：
  - 输出每行标注 `[项目]` / `[用户]`；
  - 项目库不存在时不报错，`auto` 退化为只查用户库；两库都不存在才报"先跑 /init 或 /memory init"。
- `remember` 为对称写入口（§7.6.6）。
- 模型需要看全文时用 `read_file` 打开页面路径（R0/召回渲染均给出路径）。

#### 7.7.4 排序与预算

```
rank = 词频分 + 标题命中×3 + 近 30 天×2 + (项目级 +1.5)
输出顺序：先全部项目级命中（按 rank 降序），再用户级命中（按 rank 降序）—— 严格两桶，不混排
```

| 项 | 预算 |
|---|---|
| R0 系统提示（双索引） | ≤400 token |
| R0 用户画像摘要块 | ≤200 token |
| R1 每轮召回 | ≤900 token（项目 2 页 + 用户 1 页） |
| R2 工具单次返回 | ≤30k 字符（沿用全局截断） |

#### 7.7.5 注入生命周期（关键正确性约束）

- 召回消息是**临时消息**，与预算提示同类：
  - 注入点：分类之后、user 消息之前；记录 `turnStart`（注入前的 messages 长度）；
  - 正常结束：按引用/标记摘除（`dropTransientMessage` 同款）；
  - abort 回滚：`messages.length = turnStart`（把召回消息一并回滚）；
  - 异常：catch 分支同样摘除。
- `compactNow()` 组装历史时**过滤掉**带 `【记忆召回·自动】` 标记的消息，避免污染压缩摘要。
- `persist()` 本就过滤 system 消息，召回消息不会写进会话 JSON；`--resume` 时重新注入（不重复）。

### 7.8 接线点与新增模块

#### 7.8.1 新增模块（`src/memory/`）

| 模块 | 职责 | 可测性 |
|---|---|---|
| `layout.ts` | 双作用域布局解析、用户库骨架懒创建、路径包含校验 | 纯函数 + fs |
| `journal.ts` | TurnRecord 追加/扫描/标记/清理、崩溃恢复 | fs |
| `distill.ts` | prompt 构造、JSON 解析与硬校验 | 纯函数（注入 LLM） |
| `merge.ts` | 去重/冲突/推断分流/上限/落页 | 注入 writeBack |
| `recall.ts` | 关键词抽取、打分、双桶排序、预算渲染 | 纯函数 |
| `capture.ts` | 触发判定、编排、串行队列、审计 | 注入 distiller |
| `bridge.ts` | 注入 Agent 的 `MemoryBridge`，绑定 sessionId/cfg/ui | 组合 |

```ts
export interface MemoryBridge {
  startup(): Promise<{ message: Message; tokens: number } | null>;
  recall(input: string): Promise<{ message: Message; trace: RecallTrace } | null>;
  capture(input: CaptureInput): void;          // fire-and-forget
  captureCompact(summary: string): void;
  flush(timeoutMs?: number): Promise<void>;
  status(): string;  why(): string;
}
```

依赖方向：`agent.ts` 只依赖 `MemoryBridge` 类型（不 import `src/memory` 实现），组合根注入；沿用现有 `chatStream` 注入风格。

#### 7.8.2 改动文件

| 文件 | 改动 |
|---|---|
| `src/agent.ts:65` | `AgentOptions` 加 `memory?: MemoryBridge` |
| `src/agent.ts:353` | `send()`：计算 `turnStart` → `await memory.recall` → 注入临时 system → 推送 user |
| `src/agent.ts:662` | 轮末 `turn_end` 事件之后 `void memory.capture({messages: slice(turnStart), stats, kind:"turn"})` |
| `src/agent.ts:233` | `compactNow()`：重写前 `void memory.captureCompact(res.content)`；组装历史时过滤召回标记 |
| `src/index.ts:337` | 先 `createSession` 再构造 Agent，注入 bridge（含 sessionId）；plan 模式禁 capture |
| `src/index.ts:373` | 删除旧 `ensureProfile/reInjectProfile` 调用，改 `bridge.startup()` 注入用户画像 |
| `src/index.ts:448` | `shutdown` 改 async：`await memory.flush(3000)` 后退出；`rl close` 同样 flush |
| `src/index.ts:393` | `-p` 模式返回前 `await memory.flush(3000)` |
| `src/index.ts:617` | 删除首条输入 `recordIndex` 钩子（噪音源，被 TurnRecord 取代） |
| `src/index.ts:1261` | `/memory` 落地真实子命令；新增 `/remember` |
| `src/system-prompt.ts:66` | 双库索引节 + 用户画像摘要块（复用现有 wiki/skills 注入方式） |
| `src/tools/wiki.ts` | `wiki_search` 加 scope；`wiki_write` 加 `scope`（默认 project，user 需显式） |
| `src/tools/index.ts:803` | 组合根注册 `remember`；`TOOL_NAMES_EXCLUDED_FOR_SUBAGENT` 加 `remember` |
| `src/config.ts:135` | `MemoryConfig` 扩展（§7.9），旧键兼容 |
| `src/wiki/paths.ts:12` | `WikiLayout` 加 `scope: "project"\|"user"`；新增 `resolveUserWikiLayout()` |
| `src/wiki/search.ts` | 新增 `searchScored(layout, terms)`（OR + 词频 + 标题加权）；保留 `searchWiki` |
| `src/wiki/write.ts:203` | append 同步 INDEX 摘要；`writeAtomic`；log 类型参数显式化 |
| `.gitignore` | 增加 `.neo/wiki/.locks/`（项目级锁目录） |
| `src/memory/index.ts` | 旧导出保留一版（deprecated 注释）；新增 v2 公共 API 导出 |

### 7.9 配置规格

```json
"memory": {
  "enabled": true,
  "user_wiki_dir": "~/.neo/wiki",
  "journal_dir": "~/.neo/memory/journal",
  "auto_recall": {
    "enabled": true,
    "max_tokens": 900,
    "project_pages": 2,
    "user_pages": 1,
    "recent_days_boost": 30
  },
  "auto_capture": {
    "enabled": true,
    "mode": "boundary",
    "model_tier": "fast",
    "max_ops_per_turn": 2,
    "max_pages_per_session": 8,
    "min_confidence": 0.65,
    "min_inferred_confidence": 0.75,
    "journal_retention_days": 7,
    "flush_timeout_ms": 3000
  },
  "pii_filter": { "enabled": true },
  "quiet": false
}
```

- `mode`: `off | boundary | every_turn`；默认 `boundary`（D1）。
- 环境变量覆盖：`NEO_USER_WIKI_DIR`、`NEO_MEMORY_JOURNAL_DIR`、`NEO_MEMORY_DISABLE`（沿用）。
- 旧键（`user_level_dir` / `profile_tokens_limit` / `auto_write_index` / `ingest*`）保留解析、标 deprecated；
  `user_level_dir` 仅在 `/memory migrate` 时使用。

### 7.10 命令与工具面

| 入口 | 行为 |
|---|---|
| `/memory` | status：双库页数、最近写入、最近召回、开关状态、journal 积压 |
| `/memory list [project\|user]` | 列出页面（名/摘要/更新时间/推断条数） |
| `/memory recall <query>` | 人工检索（双桶、项目优先），用于调试 |
| `/memory why` | 最近 5 条 capture 决策（含丢弃原因）+ 上次召回 trace |
| `/memory flush` | 立即处理积压 journal |
| `/memory on\|off` | 会话内开关（不落配置文件） |
| `/memory forget <scope>/<page>` | 删除页面 + 同步 INDEX/log（二次确认） |
| `/memory migrate` | 旧 `~/.neo/memorys` → 用户级归档（幂等、不删旧数据） |
| `/memory lint` | 用户级 wiki 轻量体检（复用 lint 实现，不并入项目 `/wiki-lint`；D7） |
| `/remember <text> [--user\|--project]` | 显式记忆（进入提炼管线） |

工具：`remember`（新）、`wiki_search`（加 scope）、`wiki_write`（加 scope）。
`/help`、系统提示工具段同步更新（修现有工具说明漏项）。

### 7.11 旧件处置与迁移

| 旧件 | 处置 |
|---|---|
| `recordIndex`（首条输入→raw） | **停用并从启动路径移除**（实测 7 条全是 `exit` 类首行噪音）；函数保留导出 1 个版本，`/memory migrate` 归档旧结果 |
| `ensureProfile` / `reInjectProfile`（profile.md） | 启动调用移除；profile.md 若存在，迁移为 `用户画像.md` |
| `ingestUserLevel`（桩） | 调用链删除；保留接口 deprecated（wiki 编译仍走人工 `/ingest`） |
| `redact` / `forget` / `reindex` | 保留并修缺陷：redact 不破坏正文、forget 同步删 INDEX 引用、reindex 不丢正文 |
| `locks.ts` | 修互斥 bug，复用为记忆写锁 |
| `~/.neo/memorys/` | 迁移后只读归档；不再写入 |

`/memory migrate` 步骤（幂等）：

1. 建 `~/.neo/wiki` 骨架（不存在则建）；
2. `profile.md` 存在 → 生成/合并 `用户画像.md`（来源行标注 legacy）；
3. `~/.neo/memorys/raw/*.md` 摘要汇总到 `~/.neo/wiki/raw/legacy-memorys.md`（一份证据文件，不逐条建页）；
4. 写 `~/.neo/memorys/.migrated-v2` 标记；
5. 失败不删除任何旧数据。

### 7.12 隐私与安全

- PII：TurnRecord 入库前与送入提炼器前各过一次 `redactPII`；命中密钥的 op 直接丢弃。
- 敏感推断禁止（§7.5.5）；用户级页面本机存放，不上传。
- 外部内容不进入提炼器（只喂用户话+助手结论），降低间接注入风险。
- 路径安全：所有写入目标 realpath 必须位于对应 wiki 根内；`remember`/自动写入不接受用户直接指定的绝对路径。
- 项目级不写用户隐私；用户级不写项目内部细节（§7.4）。
- `plan` 模式禁写；`/memory off` 立即生效。

### 7.13 失败模式与降级

| 失败 | 行为 |
|---|---|
| 提炼 LLM 超时/非 JSON | 重试 1 次 → 放弃；journal 标失败；不提示用户（`NEO_DEBUG` 打 stderr） |
| 页面校验失败 | 丢弃 op，写 capture-log；不重试 |
| 写锁被占 | 本轮跳过，journal 保留，下次 flush 或下轮再试 |
| 磁盘不可写 | 静默降级，不打断会话 |
| 用户库不存在 | 启动/召回跳过；首次写入时懒创建 |
| 用户关闭记忆 | 双链路停用，零读写零注入 |
| 压缩时含召回消息 | 过滤后再压缩 |
| 会话异常退出 | journal 已落盘（先 journal 后提炼），下次启动可恢复处理 |

### 7.14 成本与性能预算

| 项 | 预算 |
|---|---|
| 启动注入 | 文件读 ≤15ms；+约 400 token（双索引）+ ≤200 token（画像） |
| 每轮召回 | 本地检索 ≤5ms；≤900 token；0 次 LLM |
| 每轮沉淀 | 1 次 fast 档调用，约 2k prompt + ≤300 completion；后台执行，不占用户等待 |
| 写盘 | ≤2 页/轮，原子写 <5ms |
| 关闭开关 | 0 开销 |

### 7.15 测试计划

| 文件 | 用例 |
|---|---|
| `tests/memory-layout.test.ts` | 双库解析、env 注入、骨架懒创建幂等、路径穿越拒绝 |
| `tests/memory-recall.test.ts` | 项目优先两桶排序、预算截断、无命中不注入、中英文关键词、近期加权、推断标注 |
| `tests/memory-capture.test.ts` | 假 `chatStream`：create/append/去重/冲突更正/置信门槛/ops 上限/PII 丢弃/非法 JSON 重试/推断分流 |
| `tests/memory-journal.test.ts` | 追加/扫描/崩溃残留恢复/processed 标记/保留期清理 |
| `tests/memory-queue.test.ts` | 两进程并发写同页（子进程真实锁）互斥、不丢数据 |
| `tests/memory-commands.test.ts` | `/memory` 全部子命令、`/remember` |
| `tests/memory-e2e.test.ts` | 临时 HOME：会话 A 捕获 → 会话 B 召回；跨 cwd 用户级可见、项目级不可见；abort 回滚不残留召回消息 |
| `tests/wiki-scope.test.ts` | `wiki_search scope` 排序与标注；`wiki_write scope=user`；append 后 INDEX 同步 |

回归要求：现有 402 用例全绿；新增 ≥45 例；`bunx tsc --noEmit` 零错误。

### 7.16 验收标准

1. **写入**：在 neo 仓库跑一次真实调试轮次（改一个文件+跑测试），5 秒内生成/更新 `踩坑-*` 或 `决策-*` 页；
   INDEX 摘要与 log 同步；页面带来源行；`/memory why` 可解释。
2. **召回**：新开会话问"之前热键那个坑怎么修的"，回答引用 `[[踩坑-热键系统]]`，
   且注入消息中项目级在前；无相关问题时零注入。
3. **跨作用域**：项目 A 写入用户偏好（如"回答先给结论"），在项目 B 的会话能召回；项目 A 的踩坑页在项目 B 不出现。
4. **推断标记**：用户级推断条目带 `[推断]` 标记；召回渲染保留标记。
5. **不重复**：同一事实连续 20 轮不产生重复页/重复条目。
6. **可回退**：`memory.enabled=false` 后行为回到 v0.1.10（无读写、无注入）。
7. **质量**：`/wiki-lint` 项目库 0 error；`bun test` / `tsc` 全绿。

### 7.17 里程碑

| 里程碑 | 内容 | 验收 | 估时 |
|---|---|---|---|
| M0 地基 | 双作用域布局、用户库骨架、锁修复、原子写、append 同步 INDEX | 双库可解析；跨进程锁测试；旧测试全绿 | 0.5d |
| M1 读链路 | R0 双索引 + 用户画像摘要 + R1 自动召回 + `wiki_search scope` | 手工 3 问命中并引用；预算与零注入断言 | 0.5d |
| M2 写链路 | journal + distiller + merge + T1/T2/T3 + `remember` + dim 提示 | 一轮内落页；20 轮不重复；PII/推断用例过 | 1d |
| M3 命令与透明 | `/memory` 全套 + `/remember` + `/memory why` + 退出 flush | 写入可解释；退出 flush 有断言 | 0.5d |
| M4 迁移与文档 | `/memory migrate`、release note、wiki 回填、E2E 证据 | 迁移幂等；证据归档；lint 0 error | 0.5d |

### 7.18 回滚与回逆

**回逆锚点**：v0.1.11 发布 commit 的父提交 = `f5d6a35`（v0.1.10）。

| 层级 | 操作 | 效果 |
|---|---|---|
| L1 运行开关 | `settings.json` 设 `memory.enabled=false`（或 `auto_capture.enabled=false` 单独关写） | 立即停止读写/注入，代码不变 |
| L2 代码回退 | `git revert <v0.1.11 实施 commits>` 或 `git checkout v0.1.10 -- src/` | 回到 v0.1.10 行为 |
| L3 数据回退（用户级） | `mv ~/.neo/wiki ~/.neo/wiki.bak-$(date +%F)`；`rm -rf ~/.neo/memory/journal` | 用户记忆清空；旧 `~/.neo/memorys` 未动 |
| L4 数据回退（项目级） | 自动写入的页面在 git 中可见：`git clean -fd .neo/wiki/wiki` 或逐页 `git checkout` | 项目 wiki 恢复 |
| L5 迁移回退 | 迁移不删旧数据；`.migrated-v2` 标记可删，重新迁移幂等 | 无数据丢失 |

保证：**迁移非破坏性、写入可审计、无自动 git 操作**；任何时刻停止使用不会损坏已有数据。

### 7.19 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 提炼质量不足（漏记/乱记） | 记忆噪音 | 置信门槛 + 每轮 ≤2 op + `/memory why` 审计 + 易删 |
| 中文关键词召回偏弱 | 召回命中率 | 词频+标题加权+近期加权；规模大了再评估升级（接口已留） |
| 后台调用与主请求并发 | 网关限流/延迟 | 轮末触发、串行队列、失败静默；可设 `mode=off` |
| 项目 wiki 自动写入进入 git diff | 提交噪音 | 全自动已拍板；页面集中在 `.neo/wiki/wiki/`，提交时人工筛选 |
| 用户级推断越界 | 隐私/冒犯 | 敏感类别禁止 + 置信门槛 + `[推断]` 标注 + 可删 |
| 网关对中途 system 消息的容忍度 | 兼容性 | 已有预算提示先例；召回消息仅在 user 前注入，属标准位置 |

**开放问题（待仓库作者确认，不阻塞 M0）**

1. 本规格追加在 `docs/001-memory-system-design[done].md`；是否需要同步一份到 `../neo-memory/docs/memory-prd.md`（v0.1 真相源）？
2. `-p` 单次模式是否默认捕获（推荐是，退出前 flush）？
3. 用户级页面是否需要纳入 `/wiki-lint`（推荐：`/memory lint` 独立轻量检查，不并进项目 lint）。

### 附录 A：探针证据（2026-10-20 实测）

| 探针 | 命令/位置 | 结论 |
|---|---|---|
| 锁语义 | 复刻 `acquireCwdLock`：`mkdirSync(dir,{recursive:true})` 两次 | 两次均成功 → **互斥失效证实**；非递归第二次抛 EEXIST → 修法可用 |
| append INDEX | 临时 wiki 调 `writeBack create` → `append` | create 后 INDEX 含摘要；append 返回 `indexSynced:false`，INDEX 未更新 → 缺口证实 |
| append 日期戳 | 同上 | 页面日期戳更新为当天（行为正常） |
| 页面命名/内容 | `validatePageName` × 10 个计划页名 + 标准模板 `validatePageContent` | 全部通过 |
| PII | `redactPII("key sk-… 和 me@example.com")` | 返回 `[REDACTED:openai-key]` / `[REDACTED:email]` |
| profile 注入位 | `src/memory/profile.ts:263-300` | role=system，位于 messages[1]；`persist`/`applyRestored` 均过滤 system → 不会重复持久化 |
| 静态工具清单 | `tests/core.test.ts:61-73` | 锁定 10 个静态工具；运行时注册不影响，测试需注销 |
| 用户级存储现状 | `~/.neo/wiki` 不存在；`~/.neo/memorys/raw` 7 条 | 用户级需新建；旧 raw 低价值，迁移只归档不建页 |
| wiki 模板 | `src/wiki/templates/wiki-INDEX.md` / `wiki-log.md` | 可直接裁剪为用户级骨架 |

### 附录 B：与旧文档/旧实现的关系

| 旧内容 | 关系 |
|---|---|
| 本文件 §2 四层模型（L0–L4） | 概念沿用：L0=AGENTS.md（不变）、L1=项目 wiki、L2=用户 wiki、L3=进度页/界面状态、L4=session 回放（不变）；**存储落地改为 wiki 承载** |
| 本文件 §3.1 写入方案 | 采纳 A+B：程序触发（价值判定）+ fast 模型提炼；`/remember` 保留为兜底 |
| 本文件 §3.3 遗忘机制 | 以「推断淘汰 + `/memory forget` + journal 保留期 + 页面软上限」实现 |
| 本文件 §4 与 compact 合并 | **不采纳**合并为一次调用：compact 有独立语义，记忆提炼放在压缩前后独立调用，失败互不影响 |
| 本文件 §5 M1–M4 路线 | 由 §7.17 里程碑替代 |
| `../neo-memory/docs/memory-prd.md`（v0.1 真相源） | 其已实现部分（schema/recordIndex/profile）保留/废弃见 §7.11；本轮升级以本文件 §7 为准 |

