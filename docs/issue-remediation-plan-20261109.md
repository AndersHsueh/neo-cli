# 剩余 issue 修复计划（2026-11-09）

> 执行口径：`docs/maintenance.md` 全流程。每条 issue 独立 worktree、先红后绿、simplify、`bash scripts/verify.sh` 为 `ALL GREEN`、
> `git merge --ff-only` 合入 main、按 §11 写评论并关闭。发版批量做，不跟单条 issue 绑定。
> 排序原则：**先易后难**——先做「纯本地逻辑 / 无 TTY / 无外部协议」的，再做交互面大的，最后做设计重的。

## 0 已完成

| issue | 结果 |
|---|---|
| #1 IPSA KEY 对 glm-5.3 无权限 | 非缺陷：模型名不存在，正确名 `glm-5.3-flash`；已按 not planned 关闭 |
| #18 启动 TUI 降噪 / 顺序 / 占位 | v0.4.65（`a768c94`）已实现，补证据跟贴后关闭 |
| #8 输出上限边界发现 | `a909bd6` 合入 main；A 报错证据入账（默认开）+ B 受控主动探测（默认关）；已关闭 |

## 1 顺序与规模

规模是**改动量+验证成本**的粗估，不是工时承诺：S ≈ 半天内、M ≈ 一天、L ≈ 两天以上、XL 需拆子项。

| # | issue | 规模 | 为什么放这个位置 |
|---|---|---|---|
| 1 | #17 路径作用域项目规则（glob 条件加载） | S | 纯本地：规则文件发现 + glob 匹配 + 提示词组装，无 TTY、无外部协议，测试可全用纯函数 |
| 2 | #30 输入框 `!` shell 模式 | S/M | 单点交互态（mode + 前缀/配色 + 提交路径去重）；要动 composer 与 `index.ts` 提交分叉，配 PTY 场景 |
| 3 | #25 定时 / 自节奏循环（`/loop`） | M | 本地调度器 + 命令 + 停止/状态；不新增渲染范式，注入走既有队列 |
| 4 | #31 `/` 渐进式命令菜单 | M | 纯 TUI，但面大：触发、过滤、高亮、导航、**删除旧单行 hint**（替换不是叠加）+ PTY |
| 5 | #29 MCP HTTP/SSE 远程传输 | M | 配置加 transport + 传输实现 + JSON-RPC over HTTP/SSE；用假 HTTP 服务可测，无 TTY |
| 6 | #16 异步后台子代理 | M/L | `task` 改成可后台：任务表、完成通知、状态查询；要动 agent loop 的 turn 边界 |
| 7 | #28 后台长驻 shell | M/L | 进程管理 + 输出回读 + 任务列表；跨平台（Windows 无 POSIX 进程组）需早定策略 |
| 8 | #15 仓库地图（Repo Map） | L | 符号提取 + token 预算内的分层摘要 + 增量更新；与 #23 有共享的符号索引底子 |
| 9 | #27 按轮次回滚 `/rewind` | L | 对话快照 + 文件检查点 + 恢复到轮边界；要在 checkpoint 之上加「轮」这一层，边界条件多 |
| 10 | #24 目标驱动自动续跑 | L | 设计最重：完成条件由谁判定、如何防自欺（模型自己说自己完成）；**开工前需要维护者拍板** |
| 11 | #23 代码智能（LSP） | XL | 独立协议客户端 + 诊断生命周期 + 符号导航；建议拆成「client / 编辑后诊断 / 符号导航」三个子项分别交付 |

## 2 每条的执行模板

1. `git worktree add -b neo/issue-<N>-<slug> .neo/worktrees/issue-<N>-<slug>`；
2. 干净树上记基线：`bun x tsc --noEmit`、`bun test`（pass/fail/skip 与文件数）；
3. 行为有变先写 `docs/<主题>-prd.md`；
4. 先写会红的测试（TTY 行为先加 `scripts/pty-e2e.ts` 场景）；
5. 实现 → 相关测试绿 → **单独一轮 simplify** → `NEO_BOT_COMMENTS_DIR=… NEO_STRICT_SKIPS=1 bash scripts/verify.sh`；
6. 自查 diff 范围（只动该 issue 相关文件）→ `git merge --ff-only` → `gh issue close --comment`（合入 commit + 闸门数字）。

## 3 发版节奏（建议）

- 每完成 2–3 条打一版：`v0.4.81`（#17/#30/#25）→ `v0.4.82`（#31/#29/#16）→ `v0.4.83`（#28/#15/#27）→ `v0.4.84`（#24/#23）。
- 每版走 §9：PRD 收尾改名 `[done]`、release note、README 数字、`.gitignore` 复核、只改 `package.json.version`、提交 → `git tag -a` → 推送。
- **推送需要单独确认**（维护流程默认推到 `github.com/AndersHsueh/neo-cli`，Gitee 不是要求）。

## 4 已知约束与风险

- **#24 需要拍板**：完成条件必须可验证（命令退出码 / 测试通过 / 文件指纹），不能由模型自述；否则自动续跑会变成自欺循环。
- **#23 建议拆单**：LSP 一次交付过重，拆子项后每条都能独立验收。
- **#28 的跨平台**：Windows 上后台进程管理没有 POSIX 进程组语义，需要先决定支持口径（可以只做 POSIX 并在文档写明）。
- **交互面冲突**：#30 / #31 / #25 都碰 `composer.ts` / `index.ts` / `input/`，必须逐条串行，不做并行 worktree。
- **闸门基线**：主仓 v0.4.80 + #8 = `bun test` 1733 pass / 0 fail / 0 skip（94 文件）、PTY 24/24；后续每条以新基线为准，release note 写实测数字。
