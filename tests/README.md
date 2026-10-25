# neo 测试约定

> **最后更新:2026-10-26**（v0.3.5 P0 可靠性加固 + 独立复验修复；v0.3.4 banner；v0.3.1 会话代号 + resume；v0.3.0 TUI）

## §1 当前基线

```bash
bunx tsc --noEmit     # exit 0（strict + noUncheckedIndexedAccess）
bun test              # 873 pass / 0 fail（52 个测试文件，约 6s）
bash scripts/verify.sh # 全量闸门：上两条 + 真 PTY E2E（19 场景），输出落 docs/evidence/
```

v0.3.5 后的基线：**925 pass / 0 fail / 57 文件**（v0.3.4 为 881/53，v0.3.0 为 839/46，v0.2.4 为 660/37，v0.2.3 为 569/32）。
改功能前先在干净树上跑一遍，数字对位后再动手。

### TTY-only 行为的验证方式（v0.2.3 起）

终端渲染类改动（动画行覆盖、`●` 前缀、宽度、`/last`、`--resume` 回放/拒绝、Agent 标题、代号列表隐藏）**只有真 PTY 能验证**，
bun test 里的 fake IO 测不出事件顺序与覆盖语义。可复用脚本：

| 脚本 | 用途 |
|---|---|
| `scripts/fake-llm.ts` | 无状态假 OpenAI SSE 端点（按 `messages` 有无 tool 消息决定下一帧，可反复跑），`SCENARIO` 选场景 |
| `scripts/pty-e2e.ts` | 用系统 `script(1)` 起真 PTY 跑 neo，喂脚本化输入 + 最小屏幕缓冲断言屏幕文本 |
| `scripts/verify.sh` | 全量闸门：tsc → bun test → pty-e2e，各阶段输出写 `docs/evidence/v0.2.4-<stage>.txt` |
| `scripts/readline-probe.ts` | bun readline 行为探针（completer / Tab / Ctrl+J / rl.line 多行），改输入层前先跑它 |
| `scripts/tui-probe.ts` | v0.3.0 TUI 探针（raw mode / 按键形态 / 底部 live 帧 / 异步交错 / 终端恢复），改渲染前先跑它 |

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

## §4 测试文件清单（46 个）

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

### v0.3.5 新增（57 文件 / 925 例，+44）

| 文件 | 覆盖 |
|---|---|
| `llm-retry.test.ts` | P0-1：5xx/4xx/429 Retry-After/连接超时/空闲超时/中途断流/用户 abort/退避 abort/预置 abort（本地 Bun.serve） |
| `search-ignore.test.ts` | P0-5：gitignore/git 清单/隐藏文件/node_modules/非 git 方言（`[!a]`、`\#`、前导空格）/JS 正则语义 |
| `checkpoint.test.ts` | P0-4：快照还原/新建删除/逆序/裁剪/坏行/越界/超大文件/目录/软链外路径 |
| `cli-json.test.ts` | P0-6：json stdout 纯净/退出码/等号形式/--resume 失败 answer/SIGINT 130/text 回归 |
| `core.test.ts`（扩展） | P0-3：`$& $1 $$ $\` $'` 按字面写入 + replace_all |
| `compact-ctx.test.ts`（扩展） | P0-2：保留近期原文/不拆 tool 配对/长输入/usage/短历史最后 user |

### v0.3.1/0.3.2/0.3.3 新增（53 文件 / 881 例）

| 文件 | 覆盖 |
|---|---|
| `session-name.test.ts` | 角色池选择：显式名/resume 旧名/固定 rng 候选序/撞名换候选/池耗尽 fallback/空池 |
| `title.test.ts` | Neo 标题状态机：fake timer 的 10–20s 边界、Mr.Anderson ↔ N E O、3 帧×80ms、每帧宽度、stop 清理、rename |
| `session-adopt.test.ts` | `--resume` 真续接：adoptSession 沿用 id/path、续写同一文件不 fork |
| `session-liveness.test.ts` | running 判定（pid/心跳）、pid 死/心跳超时→dead、残留锁回收、同 id 保留 name、**抢锁失败不覆盖 live profile（R2h）** |
| `mailbox-adopt.test.ts` | 交互 `/resume`：接管目标 name/inbox、退役当前身份、运行中目标拒绝 |
| `mailbox-name-resolve.test.ts` | dead+alive 同名 → 优先 running；多 running 仍 ambiguous；takenAliveNames |
| `tui-composer.test.ts`（扩展） | TitleView 普通名/busy 后缀/N E O 绿色 ANSI/窄终端不超宽 |
| `theme-banner.test.ts` | 启动 banner：M.A.T.R.I.X 标题、仅保留一条横线、底部空行 |

### v0.3.0 新增（46 文件 / 839 例）

| 文件 | 覆盖 |
|---|---|
| `tui-frame.test.ts` | live 帧：擦除/提交/重画/光标归位/长高缩短无残影/DEC 2026 开关；含最小屏幕缓冲 |
| `tui-dock.test.ts` | 流式行缓冲、transient 提交/丢弃、失败详情批量、resize 重排、240 字符软断 |
| `tui-composer.test.ts` | 输入/多行/历史/补全/粘贴 chip/审批/选择 initial/双 Ctrl+C/粘贴 idle 兜底 |
| `tui-buffer.test.ts` | 按显示列折行、光标映射、码点编辑、显示列 preferred column、历史前缀搜索 |
| `tui-keys.test.ts` | Ctrl+J/Enter 与修饰键组合、UTF-8 name=undefined、Tab、PasteMachine |
| `tui-status.test.ts` | 状态行字段/优先级降级/进度条/60 列不折行 |
| `tui-console-dock.test.ts` | Console dock 接线（流式/工具行/详情批量/spinner 不泄漏/`● ` 前缀回归） |
| `git.test.ts` | git 分支读取 + 缓存 + 非仓库/detached |
| `tui-width.test.ts` | Unicode 宽度真值（emoji=2、ZWJ 家庭=2、VS16、国旗、组合字符、truncate 不切坏 grapheme） |

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
