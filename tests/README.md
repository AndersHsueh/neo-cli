# neo 测试约定

> **最后更新:2026-11-08**（基线对齐 v0.4.80 实测 1704/0/93；§4 清单口径改为以 `ls` 为准；§2 补 verify.sh 实际执行历史；补 skip 守卫与豁免可见性纪律）

## §1 当前基线

```bash
bun x tsc --noEmit    # exit 0（strict + noUncheckedIndexedAccess；不用 bunx：部分 bun 安装没有独立 bunx 入口）
bun test              # 1704 pass / 0 fail / 0 skip（93 个测试文件，约 30s；v0.4.80 实测）
bash scripts/verify.sh # 全量闸门：上两条 + 真 PTY E2E（29 场景），输出落 docs/evidence/
```

v0.4.80 基线（2026-11-08 实测）：**1704 pass / 0 fail / 93 文件**。更早的历史基线（v0.4.78 为 1676/0/92、v0.4.12 为 1097/0/70、v0.4.8 为 1076/0/69、v0.4.4 为 1061/0/68、v0.4.2 为 1039/0/67/PTY20、v0.4.0 为 974/59/PTY19、v0.2.4 为 660/37、v0.2.3 为 569/32 等）以 git 历史与本文件旧版为准，不再逐版维护。

**skip 口径（2026-11-08 起）**：`bun test` 有 skip 时退出码仍为 0 —— verify.sh 会解析 skip 数并告警（打印条数与所在文件），`NEO_STRICT_SKIPS=1` 时 skip 直接判失败。已知合法 skip：worktree 布局下 `prompt-tiers.test.ts` 的 3 条「与 bot-comments 源文件逐字一致」（源目录默认按仓库物理位置推断，worktree 父目录不同会找不到；可用 `NEO_BOT_COMMENTS_DIR` 显式指定，主仓布局 0 skip）。

证据目录 `docs/evidence/` 在 .gitignore 里：仓库跟踪的证据止于 v0.4.2-\*（规则加入前的 55 个文件仍在 git），其后的证据只落本地、不进仓库。改功能前先在干净树上跑一遍，数字对位后再动手。

> **已知失败已清零**：原 `memory-capture.test.ts` D6、以及 `cli-json.test.ts` SIGINT（`Bun.spawn` 杀到启动器 pid、脚本进程收不到信号）均已修复；当前验收口径恢复为 **0 fail**。

### TTY-only 行为的验证方式（v0.2.3 起）

终端渲染类改动（动画行覆盖、`●` 前缀、宽度、`/last`、`--resume` 回放/拒绝、Agent 标题、代号列表隐藏）**只有真 PTY 能验证**，
bun test 里的 fake IO 测不出事件顺序与覆盖语义。可复用脚本：

| 脚本 | 用途 |
|---|---|
| `scripts/fake-llm.ts` | 无状态假 OpenAI SSE 端点（按 `messages` 有无 tool 消息决定下一帧，可反复跑），`SCENARIO` 选场景 |
| `scripts/pty-e2e.ts` | 用系统 `script(1)` 起真 PTY 跑 neo，喂脚本化输入 + 最小屏幕缓冲断言屏幕文本 |
| `scripts/verify.sh` | 全量闸门：tsc → bun test → pty-e2e，各阶段输出写 `docs/evidence/<版本>-<stage>.txt`；对 tests 阶段的 skip 数告警（`NEO_STRICT_SKIPS=1` 时 fail） |
| `scripts/env-probe.ts` | v0.4.0 平台探针：打印 shell spec + 环境块 + wiki 块（`--json` 原始快照），排查「这台机器上 shell/环境判断不对」先跑它 |
| `scripts/readline-probe.ts` | bun readline 行为探针（completer / Tab / Ctrl+J / rl.line 多行），改输入层前先跑它 |
| `scripts/tui-probe.ts` | v0.3.0 TUI 探针（raw mode / 按键形态 / 底部 live 帧 / 异步交错 / 终端恢复），改渲染前先跑它 |

新增 TTY 行为时**先加 pty-e2e 场景，再改实现**；不要靠手工敲一遍当证据。

## §2 测试即规格

- **测试名带规格引用**：如 `C6 上限可配置`、`L11 /skills 是只读入口`、`B4 去重` —— 改行为先改规格再改测试。
- **红→绿**：新功能先写真失败用例（或至少先写断言），再实现；PRD 里的验收条款要能在测试里找到对应。
- **回归锚点**：任何提交以 `tsc + bun test` 双绿为准；发布时把实测数字写进 release note 与 wiki INDEX。
- **实际执行历史（2026-11-08 补记，避免误读）**：上面的「提交前闸门」并非一直被执行 —— 本机自 v0.4.5 起到 v0.4.77 没有跑过 verify.sh（本地 `docs/evidence/` 一度止于 v0.4.4，且该目录在 .gitignore 里，仓库侧看不出这段空窗），直到 v0.4.78 才补回 ALL GREEN。判断「有没有验证」要看证据文件，不要看约定本身。

## §3 隔离纪律（踩过的坑）

| 场景 | 约定 |
|---|---|
| 文件系统 | 每个测试用 `mkdtempSync(join(tmpdir(), "..."))` 建独立沙箱，`afterAll` 清理；不要写真实 `~/.neo` |
| 环境变量 | `NEO_SESSIONS_DIR` / `NEO_MAILBOX_DIR` / `NEO_USER_WIKI_DIR` / `NEO_MEMORY_JOURNAL_DIR` / `NEO_MEMORY_DIR` / `NEO_BOT_COMMENTS_DIR` 注入后必须在 afterAll 还原 |
| 真实 home | 测试里给 `cfg.memory.userLevelDir` 也指到沙箱（`migrate` 会写 `.migrated-v2`） |
| LLM | 不触网：通过 `AgentOptions.chatStream` / `CaptureDeps.streamFn` 注入 fake；禁止 `mock.module` 全局污染（bun test 单进程共享模块表） |
| 工具注册 | `registerTool` 会改全局注册表：测试必须拿返回的注销函数清理 |
| 子进程 | 跨进程锁用 `Bun.spawnSync` 真子进程验证，不用同进程 `Promise.all` 冒充 |

## §4 测试文件清单

**以 `ls tests/*.test.ts` 为准**（v0.4.78 时为 92 个）。本节不再逐版本追加文件清单 —— 旧版清单停在 46 个（v0.4.3）、基线数字停在 v0.4.12，正是逐版维护不可持续的证据。新增测试文件的覆盖说明写在**文件头部注释**里（先例：`gitignore-rules.test.ts`、`shell.test.ts`、`b4-tools.test.ts`）。

保留两条与具体版本解绑的历史踩坑：

> **写 capability 计数用例时踩到的坑**：`maxToolIterations` 默认 4，跑满 4 次 capability 后循环已收口，
> **下一次请求根本不存在**，阈值提示永远看不到。用例里必须把上限调到 `n+2` 才能观察到。
> 这不是测试写法问题，而是实现的一个真实边界：**计数在最后一次工具调用后无人消费**。

### 豁免可见性纪律（2026-11-08 起）

- 环境缺失用 `test.skipIf(...)` **显式跳过**（报告里可见 skip 标记），不用 `if-return` 静默通过 —— 静默通过会让坏环境在报告里显示 pass（先例修复：`file-index.test.ts` 的 git 集成用例）。
- 平台豁免（如 Windows）要在 `skipIf` 处注释**为什么跳过、什么条件下恢复**（先例：`b4-tools.test.ts` D2 shell cwd）。
- 显式指定的注入路径（如 `NEO_BOT_COMMENTS_DIR`）找不到文件时**直接 fail**，不静默 skip —— 配置错误必须被看见。
- 闸门对 skip 告警；要求零跳过的验收用 `NEO_STRICT_SKIPS=1`。

### 跨平台测试纪律（v0.4.0 起）

- 不写死开发者机器路径：用 `import.meta.dir` / `tmpdir()`。
- 不依赖开发机 `settings.json`：PTY 场景在临时 cwd 写确定性配置。
- 外部命令输出断言固定 `LC_ALL=C`（git 报错在中文 locale 下会变）。
- 新增「平台相关」逻辑时，优先把 platform/env/fs/which 做成注入参数，用单测覆盖三平台，而不是只在当前机器上跑。

## §5 记忆子系统的特殊约定

- **真实链路 E2E 需要真 LLM**：单测一律 fake；发布前可手工跑一次 `-p` 真实链路（写入 → 下次启动 journal 恢复 → 落页）。
- **`-p` 作用域**：`cfg.memory.scopeMode="project"` 时用户级记忆三处（提示/召回/工具）都必须拒绝，测试见 `memory-bridge` G1。
- **清理守卫**：`memory-core` E1/E2/E3 断言 deprecated 文件不得复活；新增旧件时测试会先红。

## §6 跨会话消息子系统的特殊约定

- **不碰真实信箱**：测试一律 `new Mailbox({ root: mkdtemp(...), sessionId, now: () => clock.t })`；
  不用真实 `~/.neo/mailbox`（需要默认路径时用 `NEO_MAILBOX_DIR` 注入）。
- **时间注入**：状态机 / watchdog / exec 全部通过 `now` 回调或显式 `nowMs`，测试不真等 2 分钟。
- **身份隔离**：用 `identity.createIdentity({ root, sessionId, nowMs })` 建会话；`.alive` 锁随
  `releaseAlive` 清理；TTL 用例用 `utimesSync` 造旧 mtime。
- **at-most-once**：`poll` 读即删；断言重复消息不会二次投递，`poll(limit)` 会留剩余的给下一 tick。
- **E2E**：store 级双会话 E2E 已覆盖；2026-10-20 另用本地 fake OpenAI SSE 端点跑通「P2 自动收信 +
  `send_message` 实际投递 + state 落盘 + 用户新任务不误标回信」交互式 E2E（`reply_to`/`exec` 自动
  填充由单测覆盖）。真实双终端 + 真实 LLM 的编排验收仍建议发布前人工在 TTY 下跑一次。
