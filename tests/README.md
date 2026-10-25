# neo 测试约定

> **最后更新:2026-10-25**（v0.2.4 输入层交付；v0.2.3 TUI 补漏；v0.2.0 跨会话消息；v0.1.12 记忆旧件清理后重写）

## §1 当前基线

```bash
bunx tsc --noEmit     # exit 0（strict + noUncheckedIndexedAccess）
bun test              # 660 pass / 0 fail（37 个测试文件，约 4.9s）
bash scripts/verify.sh # 全量闸门：上两条 + 真 PTY E2E（10 场景），输出落 docs/evidence/
```

v0.2.4 输入层后的基线：**660 pass / 0 fail**（v0.2.3 为 569 / 32 文件，v0.2.2 为 530 / 27 文件）。
改功能前先在干净树上跑一遍，数字对位后再动手。

### TTY-only 行为的验证方式（v0.2.3 起）

终端渲染类改动（动画行覆盖、`●` 前缀、宽度、`/last`、`--resume` 回放）**只有真 PTY 能验证**，
bun test 里的 fake IO 测不出事件顺序与覆盖语义。可复用脚本：

| 脚本 | 用途 |
|---|---|
| `scripts/fake-llm.ts` | 无状态假 OpenAI SSE 端点（按 `messages` 有无 tool 消息决定下一帧，可反复跑），`SCENARIO` 选场景 |
| `scripts/pty-e2e.ts` | 用系统 `script(1)` 起真 PTY 跑 neo，喂脚本化输入 + 最小屏幕缓冲断言屏幕文本 |
| `scripts/verify.sh` | 全量闸门：tsc → bun test → pty-e2e，各阶段输出写 `docs/evidence/v0.2.4-<stage>.txt` |
| `scripts/readline-probe.ts` | bun readline 行为探针（completer / Tab / Ctrl+J / rl.line 多行），改输入层前先跑它 |

新增 TTY 行为时**先加 pty-e2e 场景，再改实现**；不要靠手工敲一遍当证据。

## §2 测试即规格

- **测试名带规格引用**：如 `C6 上限可配置`、`L11 /skills 是只读入口`、`B4 去重` —— 改行为先改规格再改测试。
- **红→绿**：新功能先写真失败用例（或至少先写断言），再实现；PRD 里的验收条款要能在测试里找到对应。
- **回归锚点**：任何提交以 `tsc + bun test` 双绿为准；发布时把实测数字写进 release note 与 wiki INDEX。

## §3 隔离纪律（踩过的坑）

| 场景 | 约定 |
|---|---|
| 文件系统 | 每个测试用 `mkdtempSync(join(tmpdir(), "..."))` 建独立沙箱，`afterAll` 清理；不要写真实 `~/.neo` |
| 环境变量 | `NEO_SESSIONS_DIR` / `NEO_MAILBOX_DIR` / `NEO_USER_WIKI_DIR` / `NEO_MEMORY_JOURNAL_DIR` / `NEO_MEMORY_DIR` 注入后必须在 afterAll 还原 |
| 真实 home | 测试里给 `cfg.memory.userLevelDir` 也指到沙箱（`migrate` 会写 `.migrated-v2`） |
| LLM | 不触网：通过 `AgentOptions.chatStream` / `CaptureDeps.streamFn` 注入 fake；禁止 `mock.module` 全局污染（bun test 单进程共享模块表） |
| 工具注册 | `registerTool` 会改全局注册表：测试必须拿返回的注销函数清理 |
| 子进程 | 跨进程锁用 `Bun.spawnSync` 真子进程验证，不用同进程 `Promise.all` 冒充 |

## §4 测试文件清单（27 个）

| 文件 | 覆盖 |
|---|---|
| `core.test.ts` | CLI 参数、工具集清单、权限模式、token 估算、会话持久化 |
| `skills.test.ts` | 技能发现/索引/软链/use_skill（A~J 组） |
| `skills-cli.test.ts` / `skills-command.test.ts` | `/skills` CLI 与只读诊断入口 |
| `skill-budget.test.ts` | 技能索引 token 预算与三处输出口径 |
| `symlink-traversal.test.ts` | 软链遍历、目录判定、全局技能库写守卫 |
| `gitignore-rules.test.ts` | `.gitignore` 规则与 raw 不可改 |
| `subagent.test.ts` | task 子代理、空正文重试、子代理排除表 |
| `compact-ctx.test.ts` | compact_ctx 工具与压缩安全切点 |
| `hotkeys.test.ts` / `paste.test.ts` / `select.test.ts` | 输入层：热键、粘贴折叠、行内选择器 |
| `resume.test.ts` / `tier-command.test.ts` | 会话恢复、档位命令 |
| `wiki-write.test.ts` / `wiki-ingest.test.ts` / `wiki-lint.test.ts` | wiki 校验/写入/编译/lint |
| `memory-core.test.ts` | 清理后核心面：配置、PII、`/init` 骨架、清理守卫 |
| `memory-layout.test.ts` | 双作用域布局、原子写、互斥锁（含真实子进程）、stale 自愈 |
| `memory-recall.test.ts` | 关键词抽取、两桶排序、预算、`-p` project-only |
| `memory-capture.test.ts` | 提炼校验、合并去重/冲突/推断分流、journal、锁占用、上限 |
| `memory-bridge.test.ts` | R0 画像注入、R1 召回、Agent 生命周期、跨会话 E2E、命令面、迁移 |
| `mailbox.test.ts` | 跨会话收发：按名字/片段/id 解析、限流/去重/队列上限、hold/release、`reply_to`/`exec`、watchdog 编排 |
| `mailbox-state.test.ts` | 状态机转移、effective state、stuck、receipts、委派台账、watchdog 纯判定矩阵、命名/改键/TTL |
| `mailbox-inbound.test.ts` | 入站三态 + 权限档判定、消息/通知框架、两个工具、prompt/config 接线 |
| `mailbox-agent.test.ts` | P1 注入点协议合法性（tool→user→budget 序列）、无工具 turn 不注入、轮询失败不击穿主循环、主代理运行时工具可见性 |
| `toolcall-display.test.ts` | 紧凑工具行格式化（点号循环/✓✗/CJK 宽度收敛）、`toolcall_info_details` 默认值与别名 |

### v0.2.3 新增（32 文件 / 569 例）

| 文件 | 覆盖 |
|---|---|
| `width.test.ts` | D2：`truncate` 按显示列截断（CJK/ANSI/混合宽度）、`Console` 宽度回落 80、失败摘要不挤掉工具名 |
| `stream-state.test.ts` | D1：`endStream(kind,newline)` 语义、流式状态复位、`●` 前缀可重复出现、幂等 |
| `toollog.test.ts` | D3：失败摘要（stderr/exit code）、时长格式、`/last` 格式化、缓存上限 20、失败详情的行数预算 |
| `transcript.test.ts` | D4：轮次切取、角色过滤、`maxLines` 截断提示、多行用户输入、markdown 渲染 |
| `flash-notice.test.ts` | D5：提示符重绘注入、不打印 `❯`、非 TTY 不写、无 restorer 退化 |

### v0.2.4 新增（37 文件 / 660 例）

| 文件 | 覆盖 |
|---|---|
| `completion.test.ts` | 触发识别（`@` 边界/email 误判/中文紧贴/命令）、模糊打分、top-k 排序、深路径命中回归、`applyMatch` 循环、候选提示 |
| `commands.test.ts` | `/` 命令表与 `handleCommand` switch 的**双向漂移守卫**（正则提取顶层 case） |
| `file-index.test.ts` | git 优先 + FS 回退 + 异步后台刷新 + TTL + limit + 软链目录 + 真实 git 仓库 `.gitignore` 集成 |
| `references.test.ts` | `@path` 解析（尾随标点/email）、`cfg.cwd` 解析、预算截断、绝对/相对去重、二进制/缺失 |
| `multiline.test.ts` | continuation 状态机、换行字节队列（Ctrl+J vs Enter、CRLF 只算 Enter、一块多事件） |


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
