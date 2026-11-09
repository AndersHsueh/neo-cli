# 路径作用域项目规则 PRD（issue #17）

> 状态：实现中（待审查）
> 关联：GitHub #17；维护主流程 `docs/maintenance.md`
> 排序来源：`docs/issue-remediation-plan-20261109.md` 第 1 条（先易后难）

## 1 背景与目标

现状：`/init` 生成的 `AGENTS.md`（或 `NEO.md` / `.neo.md`）整文件进上下文，是「总是-on」的项目指令。
monorepo / 前后端同仓时，用户只有两个坏选择：把目录专属约定（「改 `src/api/**` 才需要的接口约定」）
塞进 AGENTS.md 付每轮 token，或者不写、让模型在对应目录里裸奔。

目标：提供**按路径 glob 条件加载**的规则目录，做到「上下文预算与正确性双赢」，实现面限定在
「发现目录 + glob 匹配 + 注入」，不碰 hooks / MCP / 沙箱。

## 2 需求

### 2.1 目录与格式

- 主目录：`<cwd>/.neo/rules/`；兼容读取 `<cwd>/.claude/rules/`（Claude Code 迁移过来的规则不用改）。
- 递归发现 `*.md`（深度不限，跳过隐藏目录与 `node_modules`）。
- 文件格式与 Claude Code 的 rules 一致：可选 YAML 风格 frontmatter + 正文。

```md
---
paths:
  - "src/api/**"
  - "src/server/**"
---
改接口时必须同步更新 openapi.yaml；不要直接改生成的 client。
```

- `paths` 也接受行内数组 `paths: ["src/api/**"]`、逗号分隔字符串；别名 `globs:` 等价。
- **无 `paths`** = 每会话加载（语义同「追加进 AGENTS.md），但独立成节、可被 `/context` 区分）。

### 2.2 glob 语义（最小但够用）

| 写法 | 含义 |
|---|---|
| `**` | 跨任意层（含 0 层） |
| `*` | 段内任意字符（不含 `/`） |
| `?` | 段内单字符 |
| `{a,b}` | 交替 |
| `src/api/**` | 只匹配该前缀下 |
| `*.md`（不含 `/`） | 匹配任意层级的 basename |
| 尾部 `/` | 目录前缀语义（`src/api/` 等价 `src/api/**`） |

匹配对象是**相对 cwd 的 POSIX 路径**；绝对路径先归一成相对（cwd 外路径不参与匹配）。

### 2.3 触发（何时加载带 `paths` 的规则）

一轮请求前，用本会话**已触达路径**的并集匹配：

1. 工具调用参数里的路径：`read_file` / `write_file` / `edit_file` 的 `path`/`file_path`；
   `list_dir` / `glob` / `grep` 的 `path`（grep 的 `path` 可为文件或目录）；
2. 用户消息里的 `@path` 引用（`expandReferences` 解析出的 refs）；
3. 不认 `shell` 命令里猜出来的路径 —— 猜错会把规则误加载，宁缺勿滥。

命中规则以**临时 system 消息**注入（声明态），与本轮召回提示同一生命周期：轮末摘除、不进历史落盘；
命中集合变化时才重注入（避免每轮重复同一段）。

### 2.4 预算与截断

- 单条规则正文截断到 4000 字符，超出加 `…（截断）` 标记；
- 一轮注入的 scoped 规则总长上限 12000 字符，超出按规则顺序截断并提示；
- 每会话规则（always-on）总长上限 16000 字符，与 `AGENTS.md` 分开计量。

### 2.5 可观测

`/context` 增两行：

- `规则`：`每会话 N 条 · 路径作用域 M 条已加载（共 K 条）`
- 命中原因：`  src/api/** ← src/api/user.ts`（最多列 3 条，其余折叠）

不新增启动 TUI 输出（保持 #18 的「TUI 只留结果」口径，规则是诊断/上下文细节，走 `/context`）。

### 2.6 非目标

- 不做规则优先级/覆盖（多条命中就都注入，顺序按发现顺序）；
- 不做 `@import`、不做嵌套引用；
- 不改 `AGENTS.md` 的既有语义与区块所有权；
- 不做热加载（会话中途改规则，下次启动生效；`/context` 反映本会话已发现的那份）。

## 3 验收

1. `.neo/rules/*.md` 与 `.claude/rules/*.md` 能被发现（递归、忽略非 md）；
2. 无 `paths` 的规则按每会话加载；
3. 带 `paths` 的规则仅在本轮触达匹配路径时注入，且轮末从历史摘除；
4. `/context` 能看到每会话条数、已加载 scoped 条数与命中原因；
5. 超大规则按预算截断并明确提示；
6. 默认不写任何规则时**行为与今天完全一致**（零额外上下文、零新 TUI 输出）；
7. `bun x tsc --noEmit` 零错误、`bun test` 全绿、`bash scripts/verify.sh` 为 `ALL GREEN`。
