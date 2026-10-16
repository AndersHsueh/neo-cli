# neo 记忆管理 — 需求规格说明书（PRD）

> 版本：v0.1.0 - feature/记忆管理
> 文档类型：需求规格说明书（Product Requirements Document）
> 编写依据：`neo/docs/memory-design.md` v0.2 + 2026-10-15 社长拍板决议 + `neo/docs/skills-prd.md` v0.1.0（同期进行中）+ PRD v0.0.3 边界宣言
> 适用范围：给**开发 Agent**（按 §6 逐条实现）与**测试 Agent**（按 §7 编写用例）执行
> 基线状态：`bunx tsc --noEmit` 零错误；`bun test` 46 pass / 0 fail（v0.0.3 基线）
> 日期：2026-10-15

> **v0.1.0 范围声明**：实现主架构（P0 用户级 + P1 项目级 + 索引自动写 + profile 注入 + 写入时同步 ingest）。**P2 主观经验抽取 / P3 守护进程 / skills 加载对接** 写 N/A，纳入 §11 dashboard TODO。开发 Agent **不得** 因 §11 出现 TODO 而扩展 v0.1.0 范围。

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 一句话 | 让 neo 用「两级 karpathy-wiki + 指针召回」做记忆 —— 用户级索引跨项目，项目级 wiki 落地经验 |
| 核心机制 | 客观索引自动写；主观经验待 P2；写入时同步 ingest；profile 常驻注入；AGENTS.md 路由技能 |
| 新增工具 | **无**（沿用现有 8 个工具；wiki 操作全部用 `read_file` / `write_file` / `shell` 承载） |
| 新增目录 | `~/.neo/memorys/{raw,wiki,outputs}` + `~/.neo/memorys/profile.md`；项目级 `<cwd>/.neo/wiki/{raw,wiki,outputs}` |
| **硬前置** | **skills v0.1.0 已 tag + push**（PRD §6.4 / 约束 7-8）；未发则本 spec 不进入 v0.1.0 dev |
| 依赖约束 | 复用同期 v0.1.0 feature/技能管理（§6.4）；无新第三方依赖 |
| 新增 CLI | `/memory {status\|list\|forget\|reindex}` + 沿用 `/init`（§6.2 §A） |
| 不动的东西 | session.ts、compact 逻辑、classifier 现有实现、AGENTS.md 查找顺序（保持 AGENTS.md > NEO.md > .neo.md 兼容旧行为） |

---

## 1. 背景与问题

### 1.1 当前状况（沿用 design v0.2 §1，已验证）

代码里与「记忆」沾边的三处彼此独立无统一抽象：

| 位置 | 机制 | 缺口 |
|---|---|---|
| `src/session.ts` | 会话 JSON 落盘 `~/.neo/sessions/`，32 份实测存在 | 只用于 `--resume`，从不参与提取 |
| `src/index.ts:326-334` | `AGENTS.md` 注入，全文无截断 | 无检索、无容量上限；实测 `~/.neo/` 下无 AGENTS.md，路径空转 |
| `src/agent.ts:126-172` | `compact()` 摘要 | 会话内摘要，进程退出即丢，不回写 |

### 1.2 要解决什么

- **失忆**：跨项目、跨会话，模型不知道「这个项目用 bun」「X 月 X 日我做过 XX」。
- **注入方案的根本痛点**：v0.1 设计的「检索后注入 messages[1]」有 token 预算、注入位置冲突、prompt 缓存失效三个问题。
- **与 skills 系统的关系**：skills-prd.md 已定 skills 加载机制，记忆系统必须与之**无缝协作**，AGENTS.md 写法要让模型用 `use_skill karpathy-wiki-new` 而非直接 `read_file`。
- **CLI 命令面维度（v0.1.0 必须解决）**：记忆条目只能写入不读等于瞎写。`/memory {status, list, forget, reindex}` 是 user-facing 入口；`/init` 已有，新增 `/memory` 子命令族承载「查看 / 整理 / 重建」三类操作。详见 §6.2 §A。

### 1.3 不做什么（v0.1.0 明确边界，与 PRD v0.0.3 §1.3 一致）

- ❌ 不做向量库 / embedding（design v0.2 §7 决议）
- ❌ 不做知识图谱
- ❌ 不做主观经验自动抽取（P2 阶段；v0.1.0 留接口、不实现）
- ❌ 不做守护进程 / fast-model 循环（P3；v0.1.0 走「写入时同步 ingest」）
- ❌ 不做记忆自修改（让模型改自己的记忆）
- ❌ 不在工具层强制 raw「不可改」（约定写 AGENTS.md，约束 neo 自身行为）
- ❌ 不动 `session.ts` / `compact()` / `classifier/` 现有实现
- ❌ 不引入第三方依赖（沿用 `package.json` 现状）

---

## 2. 核心概念与术语

| 术语 | 定义 | 落地形态 |
|---|---|---|
| **用户级 wiki** | 跨项目记忆，存于 home 目录 | `~/.neo/memorys/{raw,wiki,outputs}` |
| **项目级 wiki** | 当前工作目录的项目记忆 | `<cwd>/.neo/wiki/{raw,wiki,outputs}` |
| **索引条目** | 用户级 raw 中的项目指针（date/cwd/topic/概要） | `~/.neo/memorys/raw/<date>_<sanitized-cwd>_<short-id>.md` |
| **经验条目** | 项目级 raw 中的事实记录（**v0.1.0 留 schema 留接口，不实现自动抽取**） | `<cwd>/.neo/wiki/raw/entries/<...>.md` |
| **profile.md** | 常驻注入的用户画像，≤500 tokens | `~/.neo/memorys/profile.md` |
| **AGENTS.md** | 项目级工作目录的项目记忆说明（不与 skills 系统的 AGENTS.md 查找路径冲突） | `<cwd>/AGENTS.md` |
| **ingest** | raw → wiki 的编译动作 | `src/memory/ingest.ts`（v0.1.0 实现同步版） |
| **回忆路径** | 用户问「以前做过 XX」→ 用户级 wiki → 索引条目 → cwd → 项目级 wiki | 不需新工具；模型用 `use_skill karpathy-wiki-query` |

---

## 3. 目录布局

### 3.1 用户级（跨项目，由 neo 自己管）

```
~/.neo/memorys/
├── raw/                # 索引条目客观源（约定可增可删不可改，约束 neo 自身）
│   ├── 2026-10-15_research-000-alice-new_a3f2k9b1.md
│   └── ... (一条一文件)
├── wiki/               # ingest 编译产物
│   └── index.md        # 索引视图，按 date 倒序
├── outputs/            # 暂时空；预留
├── profile.md          # 常驻注入的用户画像，≤500 tokens
├── .ingest-failures/   # ingest 失败留痕（不改 raw 内容）
│   └── <date>_<id>.log
└── CLAUDE.md           # 用户级 wiki 的 schema 文档（karpathy-wiki 模板要求）
```

**约束 1 — 路径必须加 `.ingest-failures/`**
v0.1.0 ingest 失败不能回滚 raw（见 §5.2），失败需落 `.ingest-failures/<date>_<id>.log` 留痕。下一版守护进程接管时扫此目录重试。

**约束 2 — `~/.neo/memorys/` 命名固定为 `memorys`（单数加 s）**
本设计范围内命名不可变（沿用社长 2026-10-15 决议）。spec 后续如出现「memory」字样，均指项目级 `<cwd>/.neo/wiki/`；用户级统一称「memorys」。

**约束 3 — `~/.neo/memorys/` 进 git 排除**
按 v0.0.3 PRD §1.3 与 skills-prd §6.5 一致，home 目录本就不在任何仓库内，**无需在 `<cwd>/.gitignore` 加任何规则**。如果未来有「项目级 dotfiles 仓库」场景，再讨论。

### 3.2 项目级（每个工作目录，懒创建）

```
<cwd>/.neo/
├── wiki/
│   ├── raw/            # 项目级原始素材（约定可增可删不可改）
│   ├── wiki/           # 编译产物
│   ├── outputs/        # 暂时空；预留
│   └── CLAUDE.md       # 项目级 wiki 的 schema 文档
└── ...
<cwd>/AGENTS.md         # 写「先用 use_skill karpathy-wiki-new 再操作」—— **不与 skills 系统的项目级 AGENTS.md 冲突**
```

**约束 4 — 项目级路径一律 `.neo/` 前缀**
避开与已有仓库的 `wiki/` `skills/` `docs/` 撞名（沿用 2026-10-15 决议）。

**约束 5 — `AGENTS.md` 查找顺序不变**
保持 v0.0.3 现状（`AGENTS.md` > `NEO.md` > `.neo.md`，在 cwd 根目录）。**不得**改为查 `<cwd>/.neo/AGENTS.md`。这条与 skills-prd §11 提到的「AGENTS.md 是项目级工作目录说明」不冲突 —— 两份 AGENTS.md 内容互补，由 `index.ts:326-334` 的查找逻辑依次加载。

**约束 6 — `<cwd>/.neo/wiki/` 不进 gitignore**
按 skills-prd §6.5 约束 15 决议（2026-10-15 拍板）：`raw/` 与 `wiki/` 进 git 实现前因后果完整交接，**`outputs/` 排除**。
```gitignore
# 知识图谱派生物：能从 wiki 重新生成，不进版本控制
.neo/wiki/outputs/
```
现有 `.gitignore` 已有 `.neo-session/` 等条目，本节只新增这一条。

### 3.3 skills 系统的协作（与 skills-prd.md v0.1.0 对齐）

记忆系统用以下 karpathy-wiki 技能（在 `~/.neo/skills/` 下作为普通技能）：

| 技能 | 触发 | 角色 |
|---|---|---|
| `karpathy-wiki-new` | 首次进新目录 | 创建项目级骨架（`<cwd>/.neo/wiki/{raw,wiki,outputs}`） |
| `karpathy-wiki-ingest` | 写入后 / staleness check | 把 raw 编译成 wiki 视图 |
| `karpathy-wiki-lint` | 提交前 / 用户显式 | 健康检查 |
| `karpathy-wiki-query` | 用户问「以前做过 XX」 | 跨库查询（用户级 → 项目级） |

**约束 7 — 这四个技能由同期 v0.1.0 feature/技能管理 提供**
它们是普通技能文件夹，存于 `~/.neo/skills/karpathy-wiki-*/SKILL.md`。**v0.1.0 记忆系统不实现技能加载**，只约定这四个技能的 SKILL.md 必须存在并按 skills-prd 规范可被 `use_skill` 加载。**若实现时这四个技能尚未落入 `~/.neo/skills/`，属技能侧的交付缺口，记忆侧走降级路径**（见 §6.4）。

**约束 7a — 启动时序硬前置（Jacky P0 #2 同步确认）**
本 spec 标 v0.1.0，**前提** 是 skills v0.1.0 已 tag 并 push：
1. `Config.skillsStore` 字段已在 skills release 中落地
2. `use_skill(name)` 与 `discoverSkills()` API 已稳定
3. `karpathy-wiki-{new,ingest,lint,query}` 四个 SKILL.md 已落入 `~/.neo/skills/`
否则 §6.4 降级路径是默认行为而非异常分支，应直接视 v0.1.0 记忆系统未达 release gate。
**release 顺序**：skills v0.1.0 → memory PRD v0.1.0 final → memory v0.1.0 dev。不可乱序。

**约束 8 — `karpathy-wiki-query` 必须支持双库**
skills-prd §11.3 描述的 SKILL.md 格式默认单库。本系统要求 `karpathy-wiki-query` 的 SKILL.md 正文明确写「先查 `~/.neo/memorys/`，命中 `cwd` 路径后再查 `<cwd>/.neo/wiki/`」。**这条由技能侧 owner 落实**，记忆侧在 AGENTS.md 路由里照此指示用。

---

## 4. 数据模型

### 4.1 索引条目（`~/.neo/memorys/raw/*.md`）

```markdown
---
date: 2026-10-15                  # 必填，ISO 8601 日期
cwd: /Users/xueyuheng/research/000-alice-new  # 必填，绝对路径
topic: neo 记忆系统设计            # 可选，单行文本
short_id: a3f2k9b1                # 必填，8 位 hex，取自 crypto.randomUUID().slice(0,8)
summary: 讨论并拍板两级 wiki 记忆架构   # 必填，≤200 字符
created_at: 2026-10-15T15:14:08+08:00  # 必填，ISO 8601 时间戳
---

# neo 记忆系统设计（2026-10-15）

（一句话概要，与 summary 字段冗余但保留正文段以便 LLM 检索。）
```

**字段规则**：

| 字段 | 类型 | 必填 | 校验 | 来源 |
|---|---|---|---|---|
| `date` | string | ✅ | `^\d{4}-\d{2}-\d{2}$` | 系统时间 |
| `cwd` | string | ✅ | 绝对路径，resolved | `process.cwd()` |
| `topic` | string | ❌ | ≤60 字符，单行 | LLM 推断（v0.1.0 留空） |
| `short_id` | string | ✅ | `^[a-f0-9]{8}$` | `crypto.randomUUID().slice(0,8)` |
| `summary` | string | ✅ | 1~200 字符，单行 | 默认 = 首个会话的第一条用户输入（v0.1.0 实现见 §5.3） |
| `created_at` | string | ✅ | ISO 8601 | 系统时间 |

**文件命名**：`{date}_{sanitized-cwd}_{short_id}.md`
- `sanitized-cwd`：将绝对路径的 `/` 替换为 `-`，去掉前导 `-`，截断到 60 字符；冲突时追加 `{short_id}` 区分
- 例：`2026-10-15_research-000-alice-new_a3f2k9b1.md`

**约束 9 — 校验失败时**：
- 任何字段校验失败 → 抛 `ConfigError` 列出哪个字段不合法，**不得** 静默落盘
- `short_id` 冲突 → 重新生成一次（`crypto.randomUUID().slice(0,8)` 至多重试 3 次，3 次仍冲突改用 `crypto.randomBytes(4).toString('hex')`）

**约束 9a — 并发安全契约（Jacky P0 #2 + Spec #2 实现原语）**
多 neo 实例并发写 raw 时的安全保证：

| 场景 | 原语 | 失败模式 | 回滚 |
|---|---|---|---|
| (a) 同 cwd 同日去重 | mkdir 锁 `<user_level_dir>/.locks/<sha256(sanitized_cwd)[:16]>` → 持锁后**再次 listdir** → 都看到走 update updated_at 分支 | mkdir EEXIST 视为他人持锁 | 锁内闭环；rename 失败 unlink temp |
| (b) short_id 文件名冲突 | tmp + rename + fsync(parent dir) | rename 失败 | 重生成 short_id（沿 B9 3 次 → `crypto.randomBytes(4)` 回退） |
| (c) 跨进程持久原子写 | POSIX rename atomic | rename 失败 | unlink temp；不污染 raw/ |
| (d) 残留锁目录清理 | 启动时 `discoverSkills` 或 `recordIndex` 扫 `.locks/`，mtime ≥ 24h 一律删 | 锁残留 EOF | 自愈；下次启动即清 |

**回滚总原则**：写失败不破坏已写内容；temp 文件 rename 失败一律 unlink；raw 不可改（约束 28）继续生效；frontmatter 字段更新属约束 28b 例外（见下）。

**约束 28b — frontmatter 字段更新不算改 raw（Mike Q3 #2 自纠）**
B2「同 cwd 同日复用条目仅更新 `updated_at`」与约束 28「raw 不可改」表面冲突。**裁决**：`updated_at` 是 frontmatter 元数据字段，不是 raw 内容；写 frontmatter 字段属于 ADD-only 的「附加行为」，不违反「不可改 raw」原义。约定：
- 仅允许的 frontmatter 字段更新：`updated_at`（自动）；任何 LLM 推断字段（如 `topic`）**不在 v0.1.0 写**（约束 10）
- 文件正文（frontmatter 之外）**绝不** 重写
- 此条作为约束 28 的明文例外，写进代码 review 清单

**约束 10 — `topic` v0.1.0 行为**：
- 留空；不调用 LLM 推断
- 不在 AGENTS.md / ingest 中补任何默认值
- 留待 P2 经验条目时由信号系统填充

### 4.2 经验条目（项目级 `<cwd>/.neo/wiki/raw/entries/*.md`，**v0.1.0 留 schema 不实现**）

```markdown
---
id: <short_id>
created_at: <ISO 8601>
tags: [deploy, ci, bun]            # 来自受控词表 tags.md（v0.1.0 创建空文件）
source: session:20261014-230259-i3tgr1
confidence: 0.9
supersedes: <id>                    # 可选，ADD-only 时指向被替代者
status: active | superseded
---

部署前必须先跑 bun run check，CI 会卡。
```

**v0.1.0 行为**：schema 定、文件目录不创建、不写任何条目。P2 阶段实现抽取时使用此 schema。`tags.md` 在 `<cwd>/.neo/wiki/raw/` 下创建空文件作为占位（**不创建会破坏 P2 介入路径**）。

**约束 11 — `<cwd>/.neo/wiki/raw/tags.md` 必创建**
即便空文件。内容为 `# 受控词表` 标题 + 空行，作为 P2 阶段的接入点。

### 4.3 profile.md（`~/.neo/memorys/profile.md`）

```markdown
# 用户画像（≤500 tokens）

## 偏好
- 回答不用加收尾语
- 偏好直接、不废话

## 工具偏好
- 用 zsh，不用 bash
- 终端用 ripgrep
```

**约束 12 — profile.md 截断规则**：
- 启动时检查 `~/.neo/memorys/profile.md`，存在且 ≤500 tokens → 注入为 messages[1]
- 存在但 >500 tokens → 用 `agent.ts:113` 同款 token 估算（`src/llm.ts:302` `estimateTokens`）截断到 500 tokens，stderr 一行 WARN（**不丢内容到 .ingest-failures** —— profile 是人工维护，不算 raw）
- 不存在 → 静默不注入，启动日志不告警

**约束 13 — profile 注入是 messages[1]**
**不与主 system prompt 拼接**。这是 v0.1 design §4.2 与 v0.0.3 PRD §2.4 的硬约束。原因：`noteModelChange()` 用正则 `/- 模型：[^\n]*/` 改 system prompt，混在一起会被吃掉。

### 4.4 AGENTS.md（项目级 `<cwd>/AGENTS.md`）

由 `/init` 命令生成，**不与 skills 系统的 AGENTS.md 冲突**（两者写同一文件，内容互补）：

```markdown
# 项目级 wiki 记忆使用说明

本项目启用了 neo 记忆管理（v0.1.0 feature/记忆管理）。

## 工作流
1. 涉及 wiki 操作时，**先用 `use_skill karpathy-wiki-new` 加载完整规则**（如已加载则跳过）
2. 写入新内容到 `<cwd>/.neo/wiki/raw/`
3. 写入完成后调 `use_skill karpathy-wiki-ingest` 触发同步编译
4. 提交前调 `use_skill karpathy-wiki-lint` 做健康检查
5. 用户问「以前做过 XX」时调 `use_skill karpathy-wiki-query` 跨库查询

## 约束
- `raw/` 可增可删不可改（neo 自身行为；用户手改不拦）
- `wiki/` 是编译产物，可重新生成
- `outputs/` 不进 git
- 修改此 AGENTS.md 须同步给同期 v0.1.0 feature/技能管理 侧的 AGENTS.md 模板
```

**约束 14 — AGENTS.md 由 `/init` 命令一次性生成**
不是每次会话重写。后续若需更新，由用户手改。

**约束 14a — 路由文案分两支（Jacky P0 #4 先手 / 降级）**
AGENTS.md 中「## 工作流」段按 karpathy-wiki-* 技能可用与否写两套文案：

```markdown
## 工作流
<先手支，默认>
1. 涉及 wiki 操作时，**先用 `use_skill karpathy-wiki-new` 加载完整规则**（如已加载则跳过）
2. 写入新内容到 `<cwd>/.neo/wiki/raw/`
3. 写入完成后调 `use_skill karpathy-wiki-ingest` 触发同步编译
4. 提交前调 `use_skill karpathy-wiki-lint` 做健康检查
5. 用户问「以前做过 XX」时调 `use_skill karpathy-wiki-query` 跨库查询

## 工作流（降级支，当 karpathy-wiki-* 缺失时由 /init 自动替换）
1. wiki 操作直接用 `read_file` / `write_file` 读写 `<cwd>/.neo/wiki/` 目录（**不依赖 use_skill**）
2. 用户问「以前做过 XX」时，先 `read_file ~/.neo/memorys/raw/` 按 cwd 匹配，再 `read_file <cwd>/.neo/wiki/`
3. 启动日志 WARN 后**不**重复告警
4. 技能恢复后**下一次 `/init`** 会重写 AGENTS.md 工作流段为先手支
```

**实现路径**：`memory.initProjectLevel()` 检测 `discoverSkills()` 是否含 karpathy-wiki-*：
- 全含 → 写先手支
- 任一缺 → 写降级支 + 启动日志 WARN（与约束 40 一致）

**约束 15 — 多个 feature 共享 AGENTS.md**
skills-prd §11.3 与本 spec 都依赖 `<cwd>/AGENTS.md`，**两处 `/init` 写的内容必须可共存**。本 spec 写「## 工作流」「## 约束」两段（见上），skills 侧写它的段。冲突解决：两者都用 `## ` 二级标题，按节追加不互相覆盖。开发 Agent 实现 `/init` 时应 **追加而非覆盖**（若文件已存在）。

---

## 5. 行为规则

### 5.1 懒创建触发（项目级骨架）

触发条件 = **首次满足以下任一**：
- 用户显式调 `/init` 命令
- 启动后第一次调用 `shell` 且 `<cwd>/.neo/wiki/` 不存在
- 启动后第一次调用 `write_file` 且 `<cwd>/.neo/wiki/` 不存在

**约束 16 — 触发后行为**：
1. 创建 `<cwd>/.neo/wiki/{raw,wiki,outputs}/`（mkdirSync recursive）
2. 创建 `<cwd>/.neo/wiki/raw/tags.md`（空受控词表占位，约束 11）
3. 在 `<cwd>/AGENTS.md` **追加** §4.4 内容（约束 15）
4. **不创建 `<cwd>/.neo/skills/` 或任何 skills 软链** —— 那是 skills 系统的职责，记忆系统不越界
5. 启动日志一行 INFO：`已初始化项目级 wiki 记忆骨架 @ <cwd>/.neo/wiki/`

**约束 17 — 创建失败不阻塞会话**：
- 无写权限 → 启动日志 WARN：`项目级 wiki 骨架创建失败（<原因>），本次会话不写索引`
- 不抛异常；本会话索引自动写功能降级（不写 raw）但其他功能正常

**约束 18 — `AGENTS.md` 写入是幂等的**：
- 若已含「## 工作流」段，跳过（不重复）
- 检测方法：检查文件中是否含 `use_skill karpathy-wiki-new`

### 5.2 写入时同步 ingest 与失败语义

**v0.1.0 行为**：每次写 raw 后立即同步触发 ingest（设计 v0.2 §4.3 决议）。

**约束 19 — ingest 失败绝不能回滚 raw**：
- raw 写入成功 → 即便 ingest 失败也算「已记下」
- 失败处理三步：
  1. 落 `~/.neo/memorys/.ingest-failures/<date>_<short_id>.log`，内容为 `ingest failed at <ISO 时间戳>: <错误摘要>`
  2. 启动日志 stderr 一行 WARN：`用户级 wiki ingest 失败，详见 ~/.neo/memorys/.ingest-failures/<file>.log`
  3. 下一版守护进程接管时扫 `.ingest-failures/` 重试

**约束 20 — ingest 是阻塞的**：
- v0.1.0 没有守护进程，ingest 必须同步完成才能返回
- 单条索引条目的 ingest 应 < 2 秒（实测可接受范围）
- 若预计超过 2 秒（如 LLM 调用），改用 fast-model（`classifier_provider`）的零成本网关（与 skills-prd §1.2 同样的取舍）
- **不得** 在 ingest 中调用 main-model（防止递归 / 死循环）

**约束 21 — ingest 失败重试策略**：
- 网络错误（连接拒绝、超时）：重试 1 次，间隔 1 秒
- 解析错误（LLM 输出不符合 wiki 格式）：不重试，直接落 `.ingest-failures/`
- 配额错误（429）：不重试，落 `.ingest-failures/` 并 stderr WARN 含「配额」字样

### 5.3 索引自动写

**触发条件**：会话内第一次产生交互输入（即第一次非空用户消息）且当前 cwd 下无对应索引条目。

**约束 22 — 概要（summary）默认值**：
- = 当前会话第一条用户输入的前 200 字符
- 截断规则：以字符为单位，不拆分 Unicode；超过 200 在末尾加 `…`
- 用户事后可改：改 `<cwd>/.neo/wiki/wiki/<某页面>`（**不改 raw**，符合约定）

**约束 23 — 索引自动写零审批**：
- 这是客观元数据（design v0.2 §3.3 决议）
- 与现有「写文件需审批」不冲突 —— 写 raw 是 neo 内部行为，不走工具层
- 实现路径：`src/memory/index.ts` 的 `recordIndex()` 直接 `writeFileSync`，**不**走 `tools/writeFileTool`

**约束 24 — 同 cwd 同日去重**：
- 若 `~/.neo/memorys/raw/` 下已有 `2026-10-15_<sanitized-cwd>_*.md`，不写新条目
- 行为：复用现有条目，仅 `updated_at` 字段更新（**首次加新字段，不是覆盖**；ADD-only）
- 找不到日期匹配但 `cwd` 匹配 → 当日首次，**追加**新条目

### 5.4 profile.md 注入与降级

| 场景 | 行为 | 日志 |
|---|---|---|
| `~/.neo/memorys/profile.md` 不存在 | 静默不注入 | 无 |
| 存在，≤500 tokens | 注入为 messages[1] | 无 |
| 存在，>500 tokens，**段落边界可截** | 截到区间最近的段落边界（详见约束 12a） | stderr WARN：`profile.md 超 500 tokens，按段落边界截断` |
| 存在，>500 tokens，**段落边界不可截（落入区间外）** | 升级到 L2 标题边界 | stderr WARN：`profile.md 超 500 tokens，按 markdown 标题边界截断` |
| 存在，>500 tokens，**段落+标题都不可截** | L3 硬截断到 500 tokens 字符边界 | stderr WARN：`profile.md 超 500 tokens，[硬截]无段落/标题边界，按字符截断` |
| `--no-profile` CLI 标志 | 显式禁用 | 无 |
| 单次模式 `-p` | 默认不注入 | 无 |

**约束 12a — 截断三层 fallback 链（Jacky P0 #1 + Spec #1 实现原语）**
触发条件精确：估算 = `src/llm.ts:302 estimateTokens(text.slice(0, i))` 对每个边界偏移 i 算累计 token；区间 = `[400, 600]` tokens（500 ± 20%）；判定：≥1 个候选落入区间 → L1/L2 命中；0 个 → 升层。

| 层 | 原语 | 命中条件 | 兜底 |
|---|---|---|---|
| L1 段落边界 | 扫 `\n\n` 偏移 → estimateTokens 累计 token，选落入 [400,600] 中距 500 最近的边界 | ≥1 候选落入区间 | 进 L2 |
| L2 标题边界 | 正则 `/^#{1,6}\s+.+$/m` 扫所有 markdown 标题偏移，同样 estimateTokens + 区间选最近 | ≥1 候选落入区间 | 进 L3 |
| L3 硬截断 | 二分查找 estimateTokens(text) == 500 的字符边界，截到该偏移 | 必然命中 | ——（不再退化；整体丢违反约束 12） |

边界选择规则：<500 与 >500 都接受，选绝对距离 |i - 500| 最小者；并列时取 ≤500 那个。estimateTokens 已存在，**不重复实现**。stderr WARN 必须走 stderr（`process.stderr.write` / `console.error`），不可污染 LLM 流。

**约束 25 — `--no-profile` 与 `-p` 优先级**：
- `-p` 默认不注入
- `-p --profile` 显式开启（**v0.1.0 不实现 `--profile`**，仅做 `-p` 默认不注入）

**约束 26 — profile 注入位置是 messages[1]**
**不**追加到 messages[0]（避开 `noteModelChange()` 正则改写）。

**约束 27 — compact 语义（v0.1 design §4.2 补）**：
- 压缩只作用于对话消息（messages[2..]）
- profile 注入块（messages[1]）必须原样保留
- agent.ts 的 compact 实现**不动**；在 compact 完成后由 `memory.reInjectProfile()` 重新保证 messages[1] 存在

### 5.5 raw 不可改的约束

**约束 28 — 不在工具层强制保护**：
- 沿用 2026-10-15 决议：约定而非强制
- 用户手改 raw 是其自由；neo 读到什么以什么为准
- `write_file` / `edit_file` 对 `<cwd>/.neo/wiki/raw/` **不**加任何守卫

**约束 29 — neo 自身行为约束**：
- 写 raw 只用 `appendFile` 语义（v0.1.0 实现：`memory.writeEntry()` 内部先 `readFile` 检查是否已存在，是则只更新 frontmatter `updated_at`，否则新建）
- 任何写 raw 的代码路径必须经过 `memory.writeEntry()`，**不**直接调 `writeFileSync`
- 这是约定，靠 code review 兜底（v0.1.0 不加 lint 规则）

### 5.6 注入位置与 system prompt

**约束 30 — system prompt 结构**：
```
messages[0] = system   基础提示词（现有 buildSystemPrompt，不动）
messages[1] = system   profile 注入块（新增，由 memory 模块插入）
messages[2...] = 对话
```

**约束 31 — profile 注入块格式**：
```
## 用户画像（来自记忆系统）

<profile.md 全文，最长 500 tokens 截断>

> 来源：~/.neo/memorys/profile.md（<文件大小> 字节，<token 估算> tokens）
```

末尾「来源」行让模型知道这是从文件来的，不是凭空。

---

## 5.7 PII / 敏感数据过滤（Mike P0 #3）

**v0.1.0 行为**：自动索引写（`recordIndex`）时，summary 默认值取自用户首条输入（约束 22）。**该文本可能含密钥、token、邮箱、身份证号** 等敏感信息。

**约束 45 — 自动过滤模式（最小集）**：
- 显式模式串：用户首条输入按以下正则匹配，命中则替换为 `[REDACTED:<模式名>]`：
  - `(?i)sk-[a-zA-Z0-9]{20,}` → OpenAI/Anthropic API key
  - `(?i)ghp_[a-zA-Z0-9]{36}` → GitHub PAT
  - `(?i)ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` → JWT
  - `(?i)AKIA[0-9A-Z]{16}` → AWS access key
  - `(?i)xox[baprs]-[0-9a-zA-Z-]+` → Slack token
  - `\b[\w.+-]+@[\w-]+\.[\w.-]+\b` → 邮箱
- 命中即过滤，**不告警**（避免污染 LLM 流；启动日志 INFO 一行「N 处敏感串已脱敏」）
- **不**做语义判断（如「这是测试密钥」这样的判断留给用户改 raw）

**约束 46 — 提供 `/memory redact <pattern>` 命令（见 §6.2 §A）**
用户显式对已存在的索引条目重过滤（用同模式串），不修改正文，**只** 在 frontmatter 加 `redacted_at: <ISO>` 与 `redacted_count: N`。

**约束 47 — 不在原始 raw 上做（脱敏只到 summary 字段）**
索引文件正文留原样，用户事后删/改自由；summary 与 topic 字段在 `recordIndex` 写入时已被过滤。

---

## 6. 实现规格（开发 Agent 执行）

### 6.1 新建 `src/memory/` 目录结构

```
src/memory/
├── index.ts        # 公共 API：ensureProfile / recordIndex / reInjectProfile / ingestUserLevel
├── schema.ts       # 索引条目 / 经验条目 / profile 的解析与校验
├── ingest.ts       # 写入时同步 ingest 实现
├── profile.ts      # profile.md 读写 + 截断 + 注入
├── user-level.ts   # ~/.neo/memorys/ 目录操作
├── project-level.ts# <cwd>/.neo/wiki/ 目录操作 + 懒创建
└── types.ts        # 内部类型（IndexEntry / ExperienceEntry / ProfileDoc）
```

**约束 32 — 模块导出**：
```typescript
// src/memory/index.ts
export { ensureProfile } from "./profile.ts";
export { recordIndex } from "./index.ts";  // 命名冲突时改名为 recordIndexEntry
export { reInjectProfile } from "./profile.ts";
export { ingestUserLevel } from "./ingest.ts";
export type { IndexEntry, ExperienceEntry, ProfileDoc } from "./types.ts";
```

**约束 33 — `src/memory/` 零第三方依赖**（沿用 skills-prd §6.1 约束）。

### 6.2 与现有代码的接入点

| 文件 | 位置 | 改动 | 侵入性 |
|---|---|---|---|
| `src/index.ts` | **`main()` 启动序列，profile 注入点（**约 326-334 之间**）** | 在 AGENTS.md 注入之后插入 `await memory.ensureProfile()`，结果放 messages[1] | ~10 行 |
| `src/index.ts` | **首次用户输入接收处（约 360-400 之间）** | 调 `memory.recordIndex(this.cwd, summary)`，**不阻塞主流程**（try/catch 兜底） | ~8 行 |
| `src/index.ts` | **`compact()` 触发后** | 调 `memory.reInjectProfile(messages)` | ~3 行 |
| `src/agent.ts` | `compact()` 实现**不动**，仅在调用 `reInjectProfile` 前确认 messages[1] 存在 | 1 行守卫 |
| `src/index.ts` | `/init` 命令（约 535-807 之间） | 新增 `case "init"`，调 `memory.initProjectLevel()` | ~25 行 |
| `src/index.ts` | `/memory` 命令族（**新增，见 §A**） | 新增 `case "memory"`，分发到 status / list / forget / reindex / redact 子命令 | ~80 行 |
| `.gitignore` | — | 新增一行 `.neo/wiki/outputs/`（沿用 skills-prd §6.5 约束 15） | 1 行 |
| `src/memory/*` | 新建 | 全部记忆逻辑 | 估计 ~700 行（含 PII 过滤 + 并发原语） |

**约束 34 — 不动 `src/agent.ts` 主体**
仅在 compact 完成点插入一行 `reInjectProfile` 调用。`compact()` 的实现、token 估算、阈值逻辑全部沿用 v0.0.3。

**约束 35 — 不动 `src/session.ts`**
会话 JSON 落盘格式保持 v0.0.3。profile 注入块不落盘（与 system prompt 同 —— 沿用 skills-prd §10.1 拍板的「`persist()` 过滤 system」机制，自然落不到 disk 上）。

### §A — `/memory` 子命令族（Mike P0 #1 必修）

| 子命令 | 行为 | 输出 |
|---|---|---|
| `/memory status` | 列出当前 cwd 在用户级索引里的全部条目（按 date 倒序） | `cwd: /Users/.../neo  索引 3 条：  - 2026-10-15 ... ... (summary)` |
| `/memory list [--cwd=...] [--date=YYYY-MM-DD]` | 列出指定范围（默认 cwd=当前，date=2cd） | 同上格式 |
| `/memory forget <short_id>` | 删除指定索引条目 | 见下方「forget 详情」 |
| `/memory forget --dry-run <short_id>...` | 只打印删除清单与影响面，不实际执行 | `将删除:  2026-10-15_..._a3f2k9b1.md  (raw + wiki 引用)` |
| `/memory forget --yes <short_id>...` | 跳过确认，直接删除 | `已删除 ... (N 条)` |
| `/memory forget --resume` | 续删上次中断的 forget 任务（详见下方） | `续删 N 条 → 完成 / N 条失败` |
| `/memory reindex <cwd>` | 重建指定 cwd 的索引条目（用当前首条用户输入 + sanitized-cwd 重写） | `已重建 .../...md` 或 `失败：<原因>` |
| `/memory redact [--pattern=API_KEY\|PAT\|JWT\|...]` | 对已存在索引条目按模式串重过滤（约束 46） | `已脱敏 N 处（原 N 条 → 后续 N 处）` |
| `/memory --help` | 列出子命令与说明 | 普通 help 输出 |

**`/memory forget` 详情（AX 拍板，2026-10-15）**：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| **默认**（无 flag） | 打印「将删除 X 条条目（list），确认? y/N」；非 `y` 立即 abort 退出（不删任何） | 人工交互 |
| `--yes` / `-y` | 跳过确认，直接删除 | CI / 批处理 |
| `--dry-run` | 只打印计划，不删；建议默认开启，可与 `--yes` 共存「先 dry-run 看影响再 yes」 | 删除前的安全网 |

**约束 52 — forget 失败回滚（断电 / 中断续删）**
实现位置：`src/memory/forget.ts`。机制：

1. 删除**前**先在 `<user_level_dir>/.forget-journal/<session_id>.jsonl` 写一条 `{short_id, status: pending, ts: <ISO>}`（POSIX atomic rename 落盘）
2. 删 raw 文件 + 删 wiki 中对应条目（POSIX rename unlink）
3. 删除完成后改 journal 那条 `status: done`
4. 中断（断电 / SIGKILL / 异常退出）时 journal 里有 `pending` 条目
5. 下次调 `/memory forget --resume`：扫 `.forget-journal/`，按时间排序，逐条回放（删 raw + 删 wiki）；完成后归档 journal 到 `.forget-journal/done-<date>/`
6. **不**自动清理 `.forget-journal/` 历史 — 用户手清，避免误删留痕

**约束 53 — forget 不删 `.ingest-failures/`**
raw 与 wiki 是 forget 目标；`.ingest-failures/` 是 ingest 留痕，与 forget 操作无关。**两个目录生命周期独立**。

**实现注意**：
- `/memory *` 在交互模式可用，`-p` 单次模式**不可用**（无会话上下文）
- 子命令解析走现有 `handleCommand` 分发表（参考 `/init`）
- 错误一律走 `MemoryError`（§6.5），stderr 输出

**约束 48 — `/memory reindex` 是 cwd 改名/搬家后的恢复入口（Mike P0 #2）**
原 `cwd` 字段是绝对路径，项目搬家后旧索引的 `cwd` 指向不存在目录。`/memory reindex <new_cwd>` 行为：
1. 在 `<user_level_dir>/raw/` 扫所有 `cwd` 不存在的条目
2. 对每条询问用户是否绑定到 `<new_cwd>`（一次性输入新文件）
3. 改名为新 sanitized-cwd + 写新 frontmatter（**不改 summary**）
4. 不动旧 raw 全文，仅 `rename` 文件 + 更新 frontmatter 字段
- 实现位置：`src/memory/reindex.ts`
- v0.1.0 必须实现；不能挂 dashboard TODO

### 6.3 配置项（settings.json 新增字段）

```json
{
  "memory": {
    "enabled": true,                          // 总开关；false 时所有 memory API 返回 no-op
    "user_level_dir": "~/.neo/memorys",       // 可覆盖（测试用）
    "profile_tokens_limit": 500,              // 截断阈值
    "ingest": {
      "provider": "classifier_provider",      // 复用 classifier_provider；不得用 main-model
      "model": null,                          // null 时取 classifier 的默认模型
      "timeout_ms": 2000                      // ingest 超时
    },
    "auto_write_index": true,                 // 索引自动写开关
    "no_profile_in_one_shot": true,           // -p 模式不注入
    "platform": "auto",                       // auto | macos | linux | win32（Mike P0 #4）
    "worktree_isolation": false               // true 时 profile 跟 cwd 走（Mike P0 #5）
  }
}
```

**约束 36 — 默认值**：
- `enabled: true`
- `user_level_dir: ~/.neo/memorys`（通过 `homedir()` 拼接，**不**在 `memory/` 模块内硬编码）
- `profile_tokens_limit: 500`
- `ingest.provider: "classifier_provider"`（**绝不**允许 `"default"` 或 `"balanced"` 之类）
- `ingest.timeout_ms: 2000`
- `auto_write_index: true`
- `no_profile_in_one_shot: true`
- `platform: "auto"`（运行时读 `process.platform` 自动判定）
- `worktree_isolation: false`（默认 false 兼容 v0.0.3 行为）

**约束 37 — 环境变量**：
- `NEO_MEMORY_DISABLE=1` → 强制 `enabled: false`，优先级最高
- `NEO_MEMORY_DIR=<绝对路径>` → 覆盖 `user_level_dir`（测试用，约束 38 同款机制）
- `NEO_PLATFORM_OVERRIDE=<macos\|linux\|win32>` → 强制 platform（仅测试用）
- 不为 ingest / profile 加单独环境变量（settings.json 已够）

**约束 38 — 测试可注入**：
- `user_level_dir` 必须可被测试覆盖（沿用 skills-prd §7.3「不读写真实 `~/.neo/memorys/`」的隔离要求）
- `Config.memory.userLevelDir` 字段由 `loadConfig()` 解析环境变量 `NEO_MEMORY_DIR`（无则用 settings.json，再无则用 `~/.neo/memorys` 默认）

**约束 49 — 跨平台路径处理（Mike P0 #4 必修）**：
- 所有路径走 `node:path` 的 `join` / `resolve`，**不**自己写 `/` 或 `\`
- `process.platform` 取值 `darwin` / `linux` / `win32` → 映射为内部 `Platform` enum (`macos` / `linux` / `win32`)
- Windows 路径长度限制 260 字符：路径超过 200 时 stderr WARN + 截断 sanitized-cwd 到 40 字符（默认 60）
- macOS 路径含中文/空格/Unicode：sanitize 阶段用 NFC Unicode 规范化（`string.normalize("NFC")`）后转 `encodeURIComponent`，再替换 `%` 为 `-`
- 测试用例覆盖三平台（mock `process.platform`）

**约束 50 — profile 跨 worktree 隔离（Mike P0 #5）**：
- `worktree_isolation: false`（默认）：profile 固定 `~/.neo/memorys/profile.md`，跨 worktree 共享同一份
- `worktree_isolation: true`：profile 改为 `<cwd>/.neo/wiki/profile.md`，每 worktree 独立一份
- 行为一致性：summary 自动写**不**走 worktree 隔离（用户级 raw 永远是全局共享；约束 23 是按 cwd 而非按 worktree）
- 启用条件：用户**显式**写 `memory.worktree_isolation: true` 才生效；CLI 不开 `--worktree-profile` 之类快捷

### 6.4 与 skills 系统的协作（**关键对齐点**）

**约束 39 — 不直接依赖 skills 加载 API**
v0.1.0 记忆系统的代码**不 import** 任何 skills 系统的实现。理由：skills 加载 API 是 feature/技能管理 的内部接口，未稳定。记忆系统只通过 AGENTS.md 告诉模型「用 use_skill karpathy-wiki-*」，由模型自己经工具系统调用。

**约束 40 — 降级路径（若 karpathy-wiki-* 技能未落入 `~/.neo/skills/`）**：
- 启动时 `discoverSkills()` 不含这四个技能名 → 启动日志 WARN：`记忆系统所需的 karpathy-wiki-* 技能缺失，请安装后再启用记忆功能。详见 docs/memory-prd.md §6.4`
- 行为：profile 注入仍生效（不依赖 skills），索引自动写仍生效，**但 ingest / query 退化为「模型用 read_file 直接读 raw + wiki 目录」**
- 这条降级保证记忆系统在 skills 侧未交付时**仍可用**，只是能力降级

**约束 40a — 降级模式下用户操作预期（Jacky P0 #3 必修）**
降级模式下 wiki/ 目录可能过期（上次正常 ingest 留下的产物，未重跑），模型 `read_file` 直接读会读到陈旧 wiki 内容。**用户预期必须明示**：

| 用户行为 | 降级模式预期 | 完整模式预期 |
|---|---|---|
| 启动会话 | profile 仍注入；raw 已存在；wiki/ 可能过期 | profile 注入 + raw 存在 + wiki/ 同步 |
| 用户问「以前做过 XX」 | 模型用 `read_file ~/.neo/memorys/raw/...` 按 cwd 匹配；**会用「本回答基于原始记录，wiki 未重编译」字样标注** | 模型 `use_skill karpathy-wiki-query`，无需标注 |
| 用户写新 raw | 直接落盘；**不自动 ingest**（需用户手动调 `karpathy-wiki-ingest` 或等待守护进程） | 写入时同步 ingest |
| `/memory status/list` | 显示完整用户级索引（**不依赖 skills**） | 同 |
| `/memory forget` | 直接删 raw；**不删 wiki**（下次 ingest 会重新生成） | 删 raw + 删 wiki 中对应条目 |
| 用户加新 skill 后重启 | 下次 `/init` 重写 AGENTS.md 工作流段为先手支（约束 14a） | 同 |

**约束 51 — 降级模式不可静默**
启动日志 WARN 是降级模式的唯一信号。**不**在每条用户输入后再 warn 一次（避免噪声）。AGENTS.md 工作流段**明示**「降级支」（见约束 14a）。

**约束 41 — karpathy-wiki-query 技能的双库支持**
这条**由技能侧 owner 落实**，记忆侧不修改技能 SKILL.md。记忆侧在 AGENTS.md 路由里写明「karpathy-wiki-query 技能应支持双库查询」，并在 commit message 里通知技能侧。

### 6.5 错误类型

```typescript
// src/memory/types.ts
export class MemoryError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "MemoryError";
  }
}

export type MemoryErrorCode =
  | "schema_invalid"           // 索引条目字段校验失败
  | "ingest_failed"            // ingest 调用失败
  | "profile_truncated"        // profile 超 500 tokens 截断（仅警告，不抛）
  | "permission_denied"        // 用户级 / 项目级目录无写权限
  | "skills_missing"           // 降级 WARN
  | "raw_concurrent_modify";   // ADD-only 违反
```

**约束 42 — `profile_truncated` 是警告而非错误**：
- 启动日志 stderr 一行，不抛 `MemoryError`
- 与其他错误区别对待（其他都进 `.ingest-failures/` 或 `ConfigError`）

---

## 7. 测试规格（测试 Agent 执行）

**文件**：`tests/memory.test.ts`（新建）。运行：`bun test`。

**必沿用** `tests/core.test.ts` 脚手架（`bun:test` + `mkdtempSync` 沙箱 + 末尾 `cleanup()`）。

**强制隔离**：所有用例基于 `mkdtempSync` 沙箱，**绝不读写真实 `~/.neo/memorys/`**。通过 `Config.memory.userLevelDir` 注入沙箱路径（约束 38）。

### 7.1 必测用例

#### A. schema 校验

| # | 用例 | 期望 |
|---|---|---|
| A1 | 合法 frontmatter | 解析成功，字段全保留 |
| A2 | 缺 `date` | 抛 `MemoryError code="schema_invalid"` |
| A3 | `date` 格式错（非 ISO） | 同上 |
| A4 | `cwd` 非绝对路径 | 同上 |
| A5 | `short_id` 非 8 位 hex | 同上 |
| A6 | `summary` 超过 200 字符 | 同上 |
| A7 | `topic` 含换行 | 同上 |
| A8 | 额外字段（如 `unknown: x`） | **不抛**，保留原样（向前兼容） |

#### B. 索引自动写（`recordIndex`）

| # | 用例 | 期望 |
|---|---|---|
| B1 | 首次调用 | raw 下新增 1 个文件，文件名符合 `{date}_{sanitized-cwd}_{short_id}.md` |
| B2 | 同 cwd 同日再次调用 | 不新增文件；最新条目的 `updated_at` 更新（**新增 frontmatter 字段，不改原内容**） |
| B3 | 同 cwd 不同日 | 新增 1 个文件，旧的保留 |
| B4 | 不同 cwd 同日 | 各新增 1 个文件 |
| B5 | 用户级目录无写权限 | 抛 `MemoryError code="permission_denied"`，**不**降级为静默（启动日志 WARN 但函数抛错） |
| B6 | `auto_write_index: false` | 函数变 no-op，**不**落盘 |
| B7 | summary 默认值 = 首个用户输入前 200 字符 | 文件 summary 字段匹配 |
| B8 | summary 默认值：超长截断 + `…` | 200 字符后加 `…` |
| B9 | `short_id` 冲突重试 | 重试 ≤ 3 次后能拿到新 id |
| B10 | 写入后调 `ingestUserLevel` | wiki/ 目录下出现 `index.md`（具体内容不限） |

#### C. profile 注入（`ensureProfile`）

| # | 用例 | 期望 |
|---|---|---|
| C1 | profile.md 不存在 | 返回 `null`；messages 不变 |
| C2 | 存在且 ≤500 tokens | 返回文本块；含 `## 用户画像` 段 + 「来源」行 |
| C3 | 存在且 >500 tokens，**段落边界落入 [400,600] 区间** | L1 命中：截到最近的段落边界；stderr WARN 含「按段落边界截断」字样 |
| C4 | 存在且 >500 tokens，**段落边界不落入区间**（构造用例） | L2 命中：截到最近的 markdown 标题边界（`/^#{1,6}\s+.+$/m`）；stderr WARN 含「按 markdown 标题边界截断」字样 |
| C5 | `no_profile_in_one_shot: true` + `-p` 模式 | 返回 `null` |
| C6 | 文件可读但内容非 UTF-8 | 抛 `MemoryError code="schema_invalid"` |
| C7（新增，Spec #1 L3） | 存在且 >500 tokens，**段落 + 标题边界都不落入区间**（构造用例：所有边界都远离区间） | L3 命中：硬截断到 500 tokens 字符边界；stderr WARN 含「`[硬截]无段落/标题边界，按字符截断`」字样 |
| C8（新增，Spec #1 选择规则） | 段落边界 480 tokens 与 520 tokens 都在区间内 | 选绝对距离最小者 = 480（\|480-500\|=20 < \|520-500\|=20，但并列取 ≤500 → 480）；验证 SPEC 并列规则 |

#### D. reInjectProfile（compact 后）

| # | 用例 | 期望 |
|---|-----|---|
| D1 | messages[1] 是 profile，compact 把它压掉 | 调用后 messages[1] 重新是 profile |
| D2 | 用户第一次 compact | profile 内容与原一致（**不**重新读盘，缓存即可） |
| D3 | 用户第 N 次 compact | 同上 |

**v0.1.0 简化**：`reInjectProfile` 可以读盘（性能开销忽略不计），不强制走缓存。后续优化。

#### E. 懒创建（`initProjectLevel`）

| # | 用例 | 期望 |
|---|---|---|
| E1 | `/init` 在干净目录 | 创建 `<cwd>/.neo/wiki/{raw,wiki,outputs}/` + `raw/tags.md`（空） + 追加 AGENTS.md |
| E2 | 重复 `/init` | 不重复创建；AGENTS.md 已有 `## 工作流` 段则跳过 |
| E3 | cwd 无写权限 | 抛 `MemoryError code="permission_denied"`，**不**修改 AGENTS.md |
| E4 | `<cwd>/.neo/wiki/` 已存在但 `tags.md` 缺失 | 仅创建 `tags.md`（不重建其他目录） |
| E5 | AGENTS.md 已含 skills 系统的内容 | 追加而非覆盖（约束 15） |

#### F. ingest 失败语义

| # | 用例 | 期望 |
|---|---|---|
| F1 | ingest 调用成功 | wiki/ 目录更新；`.ingest-failures/` 不增加文件 |
| F2 | ingest 网络错误 | `.ingest-failures/<date>_<id>.log` 落一条；raw 不变 |
| F3 | ingest LLM 输出无法解析 | 同 F2（不重试） |
| F4 | ingest 429 配额 | 同 F2 + stderr WARN 含「配额」 |
| F5 | ingest 超时（>2000ms） | 同 F2（不重试超时） |
| F6 | raw 写入成功 + ingest 失败 | 后续 `ingestUserLevel` 调用能扫 `.ingest-failures/` 重试 |

#### G. 与 skills 系统的降级（约束 40）

| # | 用例 | 期望 |
|---|---|---|
| G1 | `~/.neo/skills/` 不含 karpathy-wiki-* | 启动日志 stderr WARN 含「karpathy-wiki-* 技能缺失」；profile 仍注入；索引自动写仍生效 |
| G2 | `~/.neo/skills/` 含 karpathy-wiki-new | 启动日志无 WARN |
| G3 | 用沙箱假 `user_level_dir` + 真 skills 系统 | 互不干扰（**不**互相读对方的 dir） |

**注意 G3**：测试不直接读写真实 `~/.neo/skills/`，仅验证「未读」语义 —— 通过 spy `readdir` / `realpath` 等系统调用，断言「未访问 `~/.neo/skills/` 路径」。

#### H. compact 行为联动

| # | 用例 | 期望 |
|---|---|---|
| H1 | 启动后 5 轮对话，触发 compact | messages[1] = profile；profile 内容不变；消息数减少 |
| H2 | profile 注入 + 会话恢复（`--resume`） | 恢复后 messages[1] 重新是 profile（**不**走缓存，磁盘读） |

#### H+. profile 与 `noteModelChange` 交互（Mike P0 #8 必修）

`noteModelChange()` 用正则 `/- 模型：[^\n]*/` 改写 `messages[0]`，profile 是 `messages[1]`。**两者不应互相干扰**（PRD §0 一页速览「不动的东西」含 compact 逻辑）。

| # | 用例 | 期望 |
|---|---|---|
| H3 | 启动时切档（`/deep` → `deep_reasoning`），触发 `noteModelChange` | messages[0] 被改（去掉旧模型名 + 加新模型名）；**messages[1]（profile）内容不变**；**profile frontmatter / view / 哨兵段不被吃掉** |
| H4 | profile 注入块末尾的「来源」行格式 | `> 来源：~/.neo/memorys/profile.md（<N> 字节，<M> tokens）` 完整保留；`noteModelChange` 后仍可见 |
| H5 | compact 后调 `reInjectProfile` | messages[1] = 新读盘的 profile（**不**用 compact 前的快照；避免索引陈旧） |

**实现约束**：profile 注入块**不**用 `- 模型：...` 之类的正则匹配模式作为前缀/分隔符，避免 `noteModelChange` 误伤。

#### I. 端到端集成（标 P1，v0.1.0 跑通即可不阻塞 merge）

| # | 用例 | 期望 |
|---|---|---|
| I1 | 完整流程：首次会话 → 触发自动索引 → 写 raw → ingest 成功 → wiki/ 出现索引 | 文件真实变更 |
| I2 | 二次会话同日同 cwd | 不新增索引；旧条目 `updated_at` 更新 |
| I3 | 二次会话不同 cwd | 各一条独立索引 |

#### J. 并发安全（Jacky P0 #2 + Spec #2）

| # | 用例 | 期望 |
|---|---|---|
| J1（=D7 旧编号） | 两并发进程同 cwd 同日 `recordIndex` | 终态只 1 个文件（含 mkdir 锁原语） |
| J2（=D8） | 两并发进程 AGENTS.md 同时 `/init` | 终态「## 工作流」段只出现 1 次（含 read-compare-append + 段标题正则幂等） |
| J3（=D9） | rename 失败回退：用只读目录模拟，确认 temp 文件被清理，不留半成品 | mkdir 锁内闭环；失败时 `unlink temp` |
| J4 | `.locks/` 残留：启动时扫一次，mtime ≥ 24h 的孤立锁目录被删 | 自愈；下次 `recordIndex` 即清 |
| J5 | B2 vs 约束 28b：同 cwd 同日二次会话，frontmatter `updated_at` 更新；正文**零修改** | 文件内容 SHA256 不变（仅 frontmatter 字段变化） |

#### K. PII 过滤（Mike P0 #3）

| # | 用例 | 期望 |
|---|---|---|
| K1 | 用户首条输入含 `sk-abcdef0123456789abcdef0123`（OpenAI key） | summary 字段含 `[REDACTED:openai-key]`，raw 正文留原样 |
| K2 | 用户首条输入含 `ghp_` GitHub PAT | summary 含 `[REDACTED:github-pat]` |
| K3 | 用户首条输入含 `user@example.com` | summary 含 `[REDACTED:email]` |
| K4 | 多个敏感串混合 | 全部命中按顺序替换；INFO 日志一行「N 处敏感串已脱敏」 |
| K5 | 正常文本无敏感串 | summary = 原文本（不变） |
| K6 | `/memory redact --pattern=API_KEY <short_id>` | 已有条目 frontmatter 加 `redacted_at: <ISO>` + `redacted_count: N`；正文不变 |

### 7.2 测试脚手架

```typescript
// tests/memory.test.ts 骨架（给测试 Agent 参考）
import { describe, expect, test, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-mem-test-"));
const FAKE_HOME = join(SANDBOX, "home");
mkdirSync(FAKE_HOME, { recursive: true });

// 关键：通过 Config 注入 user_level_dir，**绝不**写真实 ~/.neo/memorys/
const cfg = {
  cwd: join(SANDBOX, "project"),
  memory: {
    enabled: true,
    userLevelDir: join(FAKE_HOME, ".neo", "memorys"),  // 沙箱内
    profileTokensLimit: 500,
    ingest: { provider: "classifier_provider", model: null, timeoutMs: 2000 },
    autoWriteIndex: true,
    noProfileInOneShot: true,
  },
};

function cleanup(): void { rmSync(SANDBOX, { recursive: true, force: true }); }
```

**约束 43 — 不读真实 home**：
- 测试通过 `Config.memory.userLevelDir` 注入沙箱路径
- 实现层用 `cfg.memory.userLevelDir ?? homedir()/.neo/memorys`，测试场景下 `cfg` 总有值
- 若发现实现层硬编码 `homedir()` 而忽略 cfg，**测试必须失败**（应反馈给开发 Agent）

### 7.3 关键回归断言

```
// A 类 schema 校验的破坏性测试：A2 缺 date 必抛
expect(() => parseIndexEntry({ cwd: "/x", short_id: "abcd1234", summary: "ok" }))
  .toThrow(MemoryError);

// B1 文件名格式
expect(basename(result.path)).toMatch(/^\d{4}-\d{2}-\d{2}_.+_[a-f0-9]{8}\.md$/);

// C3 profile 截断 + stderr WARN
const warnSpy = spyOn(console, "error");
const result = await ensureProfile(cfg, mockProfile500Plus);
expect(estimateTokens(result)).toBeLessThanOrEqual(500);
expect(warnSpy).toHaveBeenCalled();
warnSpy.mockRestore();
```

### 7.4 测试 Agent 需要自己补的两处

1. **`Config.memory` 字段**：若 §6.3 未实现，测试 Agent 无法写隔离用例。属实现缺失，反馈给开发 Agent，**不要 mock 文件系统**。
2. **`ingestUserLevel` 的 mock LLM**：v0.1.0 ingest 走 `classifier_provider`，测试需要 mock 一个返回固定 wiki 视图的 LLM。可在沙箱内 `Bun.serve` 起 mock（沿用 v0.0.3 PRD §9.5 的 mock 经验），或注入 fast fake（`src/memory/ingest.ts` 暴露 `IngestEngine` 接口以便注入）。

---

## 8. 【已知改动】现有代码与测试必须验证的项

### 8.1 现有 46 个测试不应被破坏

`tests/core.test.ts` 的 46 个用例**不应**有任何失败。新增 `tests/memory.test.ts` 后总数 = 46 + 新增数。

### 8.2 现有 CLI 不变

`neo --help` / `neo --version` 输出格式与 v0.0.3 一致。`/init` 是新命令。

### 8.3 `package.json` 与 `tsconfig.json`

- `package.json`：**不加**新依赖；`scripts` 不变
- `tsconfig.json`：**不**修改 include；`src/memory/*.ts` 已被 `src/**/*.ts` 通配覆盖
- `bun.lock`：仅当某 npm 包版本变化时自动更新（不应变）

### 8.4 文档

- `neo/README.md` v0.0.3 提到的「AGENTS.md 注入」段落**补充**「v0.1.0 起还会注入 profile.md；详见 docs/memory-prd.md」一行
- `docs/memory-design.md` v0.2 不动（已对齐）

---

## 9. 验收标准（Definition of Done）

实现完成需**同时**满足：

### 9.1 功能

- [ ] `~/.neo/memorys/{raw,wiki,outputs}` 结构在首次 `recordIndex` 时创建
- [ ] 索引条目文件名符合 `{date}_{sanitized-cwd}_{short_id}.md`
- [ ] 同 cwd 同日二次会话不重复写索引
- [ ] ingest 失败留痕 `.ingest-failures/`，raw 不变
- [ ] profile.md ≤500 tokens 时注入为 messages[1]
- [ ] profile.md >500 tokens 时截断并 stderr WARN
- [ ] profile.md 不存在时静默不注入
- [ ] compact 后 messages[1] 仍是 profile
- [ ] `/init` 创建项目级骨架 + 追加 AGENTS.md，幂等
- [ ] `--resume` 恢复后 profile 重新注入

### 9.2 与 skills 系统对齐

- [ ] 启动日志含 karpathy-wiki-* 技能缺失检测（缺失则 WARN，含「karpathy-wiki-* 技能缺失」字样）
- [ ] 缺失时降级行为正确（profile/索引仍生效）
- [ ] AGENTS.md 路由文案能引导模型调 `use_skill karpathy-wiki-*`

### 9.3 质量门槛

- [ ] `bunx tsc --noEmit` 零错误
- [ ] `bun test` 全绿：现有 46 个 + `tests/memory.test.ts` 新增
- [ ] `src/memory/*` 零第三方依赖
- [ ] **不**读取真实 `~/.neo/memorys/`（测试隔离强制）
- [ ] **不**读取真实 `<cwd>/.neo/`（如 cwd 已有骨架则尊重，不重写）
- [ ] 不修改 `src/agent.ts` / `src/session.ts` / `src/classifier/` 主体

### 9.4 上下文预算（实测验收）

- [ ] profile 注入块 ≤500 tokens
- [ ] 单条索引条目 ingest < 2 秒
- [ ] 启动额外开销 < 100ms（profile 检查 + skills 缺失检测 + raw 存在性检查）

### 9.5 召回率验收（Jacky P0 #5 必修，最关键一项）

前四项只验「性能 / 资源占用」，**没验「功能本身能查到什么」**。v0.1.0 必须有召回率验收。

**测试方法**：构造 N=100 条真实问答回归样本，每条形如「`<日期> <项目> <问题>`」（如 `2026-10-15 neo "什么叫 karpathy-wiki 指针召回"`），通过 `karpathy-wiki-query`（或降级模式的 `read_file` 模拟）查询。判分标准：

| 指标 | 计算 | 门槛（v0.1.0） |
|---|---|---|
| **Top-1 命中率** | 正确问题编号区间（top-1）的样本占比 | ≥ 0.85 |
| **Top-3 命中率** | top-3 内任意命中占比 | ≥ 0.95 |
| **MRR**（Mean Reciprocal Rank） | 平均 1/rank | ≥ 0.90 |
| **P95 延迟** | 95% 查询耗时 | ≤ 200ms |

**样本构造规则**：
- N=100 条覆盖三类：**已知项目**（80%）：从开发 Agent 自身过去会话 + 已 commit 的会话 JSON 抽；**跨项目**（15%）：构造「跨项目相关问题」（如「之前 X 项目怎么做 Y」）；**冷查询**（5%）：应返回空 + 标注「无相关记忆」。
- 标注：每条由 Mike 标记 ground truth（top-3 应命中的索引 short_id 列表）。
- 抽样脚本：`scripts/eval-recall.ts`（**新增**），跑 `bun scripts/eval-recall.ts --samples=<N>` 输出四指标 + 失败样本清单。

**约束 54 — 召回率门槛未达时不出 v0.1.0**
任一指标低于门槛：发布门**未过**。修复方向（按优先级）：
1. profile 注入块质量（截断策略 / 内容建议）
2. summary 默认值（首条用户输入未必代表「项目做了什么」）
3. ingest 模板（wiki 视图的可检索性）
4. AGENTS.md 路由文案（模型是否能正确触发 query）
不能掩盖为「v0.2 再修」——召回率是用户价值的核心指标。

**约束 55 — 召回率测试与 CI 集成**
`bun test` 套件新增 `tests/recall.test.ts`，跑 N=20（**CI 友好小样本**），门槛同上。完整 N=100 留 `scripts/eval-recall.ts`，开发阶段手动跑。
- v0.1.0 merge 前：`bun scripts/eval-recall.ts --samples=100` 输出贴 PR
- v0.1.0 tag 后每月跑一次（脚本纳入 package.json `eval` script）

---

## 10. 风险与边界

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| karpathy-wiki-* 技能未交付 | 高 | 记忆系统部分功能降级 | §6.4 降级路径 + 启动日志 WARN |
| ingest 反复失败累积 | 中 | `.ingest-failures/` 无界增长 | 守护进程上线前手动清理（写进 README）；v0.1.0 不自动清理 |
| profile.md 长期不维护 | 中 | 注入内容过期误导模型 | v0.1.0 不解决；P3 阶段加 staleness 检测 |
| 用户手改 raw 导致 schema 破坏 | 低 | ingest 失败但 raw 已被改 | 失败时 .ingest-failures 留痕；约束 28 不强制保护 |
| `noteModelChange` 正则冲突 | 中 | 改 system prompt 时误吃 profile | profile 独立 messages[1]（约束 13/26/30/31） |
| 多次 `recordIndex` 性能 | 低 | 沙箱内文件 IO 可忽略 | 实测可接受 |
| AGENTS.md 多 feature 互相覆盖 | 中 | skills-prd 与本 spec 都改 AGENTS.md | 约束 15 追加而非覆盖 + 段标题检测 |
| 写入路径在 macOS 路径含特殊字符 | 低 | sanitized-cwd 截断逻辑需健壮 | A1~A7 schema 校验 + 文件名冲突重试（B9） |

### 10.1 明确不做（v0.1.0）

| 不做 | 理由 |
|---|---|
| 主观经验自动抽取 | P2；v0.1.0 留 schema 留目录占位 |
| 守护进程 fast-model 循环 | P3；v0.1.0 走同步 ingest |
| 记忆自修改 | 风险不可控 |
| 向量库 / embedding | design v0.2 §7 决议 |
| 跨会话自动继承（`--resume` 已覆盖） | 不在 v0.1.0 范围 |
| `tags.md` 受控词表填充 | P2 阶段处理；v0.1.0 创建空文件占位 |
| AGENTS.md 自动化生成（基于项目结构） | `/init` 写固定模板，不做 LLM 推断 |
| `--profile` 显式开启（`-p --profile`） | CLI 复杂度；`no_profile_in_one_shot` 默认值够用 |

### 10.2 与 skills-prd 的边界

| 议题 | 谁负责 | 边界 |
|---|---|---|
| `<cwd>/skills/` 软链机制 | skills-prd | 记忆系统不创建、不读 |
| `use_skill` 工具 | skills-prd | 记忆系统不实现；AGENTS.md 路由用 |
| `~/.neo/skills/` 目录管理 | skills-prd | karpathy-wiki-* 技能由 skills-prd 交付 |
| `<cwd>/AGENTS.md` 多 feature 共享 | 双方 | 双方都用 `## 段标题` 追加，约束 15 |
| karpathy-wiki-query 双库支持 | skills-prd（技能侧） | 记忆系统不修改技能 SKILL.md；在 AGENTS.md 路由中说明用法（约束 41） |

---

## 11. dashboard TODO（不在 v0.1.0 实施）

下列条目由 v0.1.0 feature/记忆管理 登记，待后续 feature 实施时由对应 spec 引用：

| # | TODO | 关联 spec | 优先级 |
|---|---|---|---|
| T1 | 主观经验条目自动抽取（design v0.2 §3.3） | feature/记忆管理 v0.2.0 | P2 |
| T2 | 守护进程 fast-model 循环（design v0.2 §4.3） | feature/守护进程 v1.0.0 | P3 |
| T3 | `tags.md` 受控词表填充（design v0.2 §6.1） | feature/记忆管理 v0.2.0 | P2 |
| T4 | 跨会话自动索引刷新（解决「会话中途新增技能」类比「会话中途新增项目」） | 待定 | P3 |
| T5 | karpathy-wiki-query 技能的双库支持（约束 41） | feature/技能管理 v0.1.0 同窗口 | P1（与本 spec 并行） |
| T6 | profile.md staleness 检测 | feature/记忆管理 v0.2.0 | P2 |
| T7 | `.ingest-failures/` 自动重试 + 清理 | feature/守护进程 v1.0.0 | P3 |
| T8 | 索引条目的 `topic` LLM 推断（约束 10） | feature/记忆管理 v0.2.0 | P2 |
| T9 | `--profile` 显式 CLI 标志 | feature/记忆管理 v0.2.0 | P3 |
| T10 | AGENTS.md 自动化生成（基于项目结构推断） | 待定 | P3 |
| **T11** | **跨项目索引聚合性能：`~/.neo/memorys/raw/` 累积 1000+ 后 query 性能（Mike P1 #9）** | feature/记忆管理 v0.2.0 | P3 |
| **T12** | **`/memory forget` 带二次确认的 UX 实测**（Mike P1 #7 删改修订时同步登记） | feature/记忆管理 v0.1.x | P2 |
| **T13** | **profile.md staleness 提示**（Mike P2 #6 已在 v0.1.0 简化为「无提示」；建议 v0.2 加 mtime 距今 ≥90 天时 WARN） | feature/记忆管理 v0.2.0 | P3 |

**约束 44 — dashboard TODO 不进 v0.1.0 范围**：
- 开发 Agent 看到本文档 §11 时**不**扩展 v0.1.0 范围
- 每个 TODO 在对应后续 spec 中独立实现，引用本文档作为设计依据

---

## 12. 附录 A：术语表

| 术语 | 含义 |
|---|---|
| 客观索引 | 用户级 raw 中的项目指针；date/cwd/short_id/summary 都是客观元数据 |
| 主观经验 | 项目级 raw 中的事实提炼；依赖 LLM 抽取，P2 阶段 |
| ADD-only | 覆盖时新增条目并标记被替代者，不原地改写 |
| ingest | raw → wiki 的编译动作 |
| profile.md | 常驻注入的用户画像，≤500 tokens |
| 懒创建 | 首次满足触发条件才创建骨架，非进目录就建 |
| 降级路径 | skills 系统未交付时记忆系统部分功能仍可用 |
| dashboard TODO | v0.1.0 范围外的待办，在 §11 集中登记 |

## 附录 B：与 PRD v0.0.3 边界的关系

v0.0.3 §1.3 边界宣言：
- **不是 IDE 插件** — 记忆系统保持 CLI 形态，不做 GUI ✅
- **不是 GUI 应用** — profile 注入是文本块，无图形 ✅
- **不是托管服务** — 全部本地落盘，零远端调用（ingest 也走本地 LLM 网关）✅
- **不是 Agent 编排框架** — 记忆系统是单 agent 循环内的辅助，不调度多 agent ✅
- **不自动执行修改 memory** — v0.0.3 §1.3 写明；本 v0.1.0 **仅做客观索引自动写**，主观经验抽取是 P2 TODO（约束 44），当前不实现，符合 ✅
- **不支持自动写 memory** — 同上 ✅

v0.0.3 §6.1 已知限制：v0.1.0 不动。

## 附录 C：与 skills-prd.md v0.1.0 的接口契约

| 接口 | 记忆系统侧用法 | skills 系统侧提供 |
|---|---|---|
| `use_skill(name)` 工具 | AGENTS.md 路由文案引导模型调用 | skills-prd §6.2 实现 |
| `discoverSkills()` 启动时扫描 | 检查 karpathy-wiki-* 是否存在 | skills-prd §6.1 实现 |
| `<cwd>/AGENTS.md` 查找 | 约束 5 保持现状 | 不变 |
| `<cwd>/skills/` 软链 | 不创建、不读 | skills-prd §3.2 决策 1 实现 |
| `~/.neo/skills/` 全局库 | 不创建、不读，仅检查技能名 | skills-prd §3.1 实现 |
| `~/.neo/memorys/` 用户级 | 本 spec 拥有 | 不涉及 |
| `<cwd>/.neo/wiki/` 项目级 | 本 spec 拥有 | 不涉及 |
| `Config.skillsStore` 字段 | 间接通过 `Config.skillsStore ?? default` 读取 | skills-prd §6.1 实现 |

## 附录 D：未验证项（诚实标注）

| 项 | 状态 | 需要的动作 |
|---|---|---|
| ingest 2 秒内能否完成（fast-model 实测） | 未验证 | 测试 Agent 跑 I1~I3 时实测 |
| profile 截断「段落边界优先」的实际可用性 | **已定稿（约束 12a 三层 fallback + 区间 [400,600]）**；可用性待 100 条真实 profile 回归 | §9.5 recall.test.ts 同跑 |
| 索引条目 `summary` 200 字符上限的合理性 | 拍脑袋 | §9.5 真实问答召回率回归 |
| `karpathy-wiki-query` 技能的双库支持是否落实 | 依赖技能侧 | T5 dashboard TODO |
| 守护进程未上线时 `.ingest-failures/` 累积速度 | 未测 | 100 次会话回归 |
| 启动开销 < 100ms 是否可达 | 未测 | I1~I3 实测 |
| macOS 路径特殊字符（中文、空格、unicode）下 sanitized 逻辑 | **已定稿（约束 49 NFC + encodeURIComponent）**；用例待补 | 测试 Agent 边界用例 |
| 与 PRD v0.0.3 已发布版本的兼容（v0.0.3 settings.json 缺 `memory` 字段时） | 已设计默认值 | 实测启动 |
| 并发原语（mkdir 锁 / tmp+rename）的 POSIX 行为跨平台一致性 | **已定稿（约束 9a）**；跨平台用例待补 | 测试 Agent J 类用例（macOS + Linux） |
| profile 跨 worktree 隔离的语义是否真有人用 | 未实测 | `/memory status` 输出使用统计 |
| 召回率门槛（Top-1 ≥ 0.85, MRR ≥ 0.90）的样本规模 N=100 是否够 | 拍脑袋 | N=100 跑完后看置信区间；必要时扩到 300 |
| PII 过滤模式串的覆盖度 | 拍脑袋（仅覆盖 6 种常见模式） | 真实用户输入回归 + 社区报告 |

---

## 13. 一页总结

1. **做什么**：两级 karpathy-wiki + 指针召回；客观索引自动写；profile 常驻注入；PII 脱敏；并发安全契约。
2. **范围**：v0.1.0 = P0 用户级 + P1 项目级 + 同步 ingest + profile 注入 + 索引自动写 + `/memory` CLI 子命令族；P2/P3 走 dashboard TODO（§11）。
3. **怎么找到**：AGENTS.md 路由 `use_skill karpathy-wiki-*`（**先手 / 降级两支文案**，约束 14a）；模型按需查询，不注入。
4. **怎么保护**：raw 不可改是约定不强制（约束 28）；frontmatter 字段更新属 28b 例外；profile 三层 fallback 截断（约束 12a）；ingest 失败不丢 raw；并发原语保证（约束 9a）。
5. **与 skills 系统**：约束 39 不直接依赖；约束 40 降级路径 + 约束 40a 用户预期明示；约束 41 双库查询由技能侧 owner 落实（dashboard T5）。
6. **质量门槛**：46 + 新增测试全绿；tsc 零错；零三方依赖；不读真实 home；**召回率 ≥ Top-1 0.85 / MRR 0.90**（§9.5）。
7. **硬前置**：skills v0.1.0 已 tag + push（约束 7a）；未发则 v0.1.0 记忆系统不发。
8. **诚实**：§D 十二项未验证/已定稿待回归，尤其「召回率」「跨平台并发原语」「PII 模式串覆盖度」需实测 + 真实输入回归。
