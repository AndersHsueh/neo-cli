# 交互 `/cd` 切换会话工作目录（issue #69）

基线：v0.4.93。本规格按 Leo 拍板落地，不宣称与 Claude Code 完全兼容。

## 目标

在不中断对话的前提下，把本会话的主工作目录搬走：文件工具、`@` 补全、默认 glob/grep、git 上下文以新目录为根；新根的项目指令成为当前规则；会话身份（`SessionMeta.cwd`）更新后，在新目录可按同一 id `--resume` 找到这条会话。

## 入口

- 只做交互 slash `/cd`。`-p` 不解析斜杠命令（既有 issue #41 行为）。
- 不改 ACP：编辑器换工作区走现有 `session/new` / `session/load`。
- 模型不能把 `/cd` 当工具调用。`shell.cwd` 仍只影响单条命令。
- 子代理不提供 `/cd`；新派发的子代理使用换根后的 `cfg.cwd`。
- 后台子代理任务正在跑、wiki worker 正在跑、或本轮用户 turn / 工具循环正在进行时，拒绝换根并说明原因。已启动的后台 shell 保持启动时快照的 cwd。
- `/mode plan` 与 `/plan` 规划态都允许 `/cd`。检查点目录在新根创建 `.neo/backups/<id>` 属于会话基础设施，不因此禁止规划态换根。

## 路径

- 相对路径相对当前会话 `cfg.cwd`，不是 `process.cwd()`。
- 支持 `~` 与 `~/...`（`~user` 不展开）。
- 先 resolve 再 realpath，会话里只存规范绝对路径；不把符号链接的逻辑路径当根。
- `/cd` 无参：只打印当前会话 cwd，不改状态。
- `/cd -`：回到上一根。无上一根时明确拒绝。失败的 `/cd` 不写入上一根槽。
- 与当前根 realpath 相同：成功并提示已在该目录，不做刷新。
- 不存在 / 不是目录 / 不可访问（含 realpath 失败）明确拒绝；空目录不是失败。
- 全程不调用 `process.chdir()`。
- 最小目录补全：`/cd ` 后只列 prefix 所在层的子目录，不递归、不列文件；跳过 `node_modules` 与 `.git`。

## 失败与原子性

先完成全部路径预检，再改任何会话状态。`meta.cwd` persist 属于成功条件：落盘失败则 cwd 与所有侧状态仍停在旧根。FileIndex、项目记忆 / 规则、PromptManager 刷新、MemoryBridge、CheckpointStore、信箱等必做改挂若失败，整次命令失败且侧状态（含磁盘 `meta.cwd`）全部不变。LSP 重启失败只警告，不回滚已成功的换根。

## 项目指令与存储

- 重建 `messages[0]` 的系统提示（`setProjectMemory` + 刷新），不追加消息。对话历史不动。
- 只加载新根上那一个 `AGENTS.md` / `NEO.md` / `.neo.md`（按此顺序取第一个存在的）。没有则清空项目记忆段，不能沿用旧文。不遍历上级，不按需加载子目录（那是 #54）。
- scoped / always-on 规则只来自新根 `.neo/rules`。
- 会话文件仍在全局 `~/.neo/sessions/`，不搬文件、不改 id，只更新 `meta.cwd`（立刻 persist）和信箱 profile cwd。
- `--resume` / `-c` 仍按既有全局查找；启动 cwd ≠ 记录 cwd 时只提示，不偷偷切目录。验收口径是「更新 `meta.cwd` 后在新目录能按 id resume 到同一会话」，不是「旧目录的 `-c` 不再命中」。这和 Claude Code 按项目搬家 transcript 不是同一套模型。

## 重载与保持

随新根重载：文件工具默认根、`@` / FileIndex、glob/grep/list_dir 默认根、系统提示里的工作目录 / 树 / 仓库地图、项目技能目录、项目 wiki 根与索引、路径规则、项目记忆文件、git 状态条、检查点根、MemoryBridge 项目范围、信箱 profile cwd、`meta.cwd`、已启用的 LSP 工作区（重启）、后续 hook 子进程的 cwd、后续新 shell / 新子代理的默认 cwd。

保持启动时的：`settings.json`（模型、密钥、hooks 定义、MCP server 列表、LSP 命令等）、用户级 wiki / 全局技能库、已连接 MCP 进程的 spawn cwd、`process.cwd()`、resume/sessions 的全局查找根、正在跑的后台 shell 的 job cwd、环境快照页、stream-json 的 `JsonlWriter` cwd。要使用新项目的 MCP / 本地 settings，须在该目录重新启动（有意收窄）。

## 与相邻 issue 的边界

- **#63 `--add-dir` / `/add-dir`**：已由 #63 落地（不在本单范围）。`/cd` 成功换主根会清空本会话额外根，`/cd -` 不恢复；同根、失败、忙碌被拒不清空。
- **#9 托管 worktree**：`/cd` 只进入已有目录，不创建 worktree。
- **#54 嵌套 AGENTS.md**：本单不按需加载子目录指令。
- 产品不做沙箱，也不引入目录信任名单。写文件 / shell 仍走既有 `ask` / `auto-edit` / `auto-all` / `plan` 审批。
- `/mode plan` 是只读闸门，`/plan` 是交互规划，分工不变。

## 测试

`tests/cd-workdir-69.test.ts`。以单测为主，无必选新 PTY。
