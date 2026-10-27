# neo

Matrix 风格的终端编程助手。用 Bun 写的 CLI harness，对接 OpenAI 兼容的 LLM 网关。

```
  ﾐﾋﾉﾘﾔｶﾍ  Ｎ Ｅ Ｏ    wake up, neo... the matrix has you.
```

## 快速开始

```bash
cd neo
cp settings.example.json settings.json   # 填入 api-key / OpenAI / model_name
bun run src/index.ts                     # 交互模式
bun run src/index.ts -p "用 glob 找出所有 .ts 文件"   # 单次模式
```

## 平台支持

| 平台 | shell | 状态 |
| --- | --- | --- |
| macOS | `$SHELL`（默认 zsh） | ✅ 实测（tsc / 1039 测试 / PTY 20/20） |
| Ubuntu / Debian | `$SHELL`（默认 bash） | ✅ 实测（sp7, Ubuntu 24.04.4 LTS） |
| 其它 POSIX（dash/ksh/fish） | 自动探测 | ✅ 解析器支持；fish 不吃登录 PATH preamble |
| Windows 11 | `pwsh` → `powershell` → `cmd` | 🟡 **实验性，未实机验证**（见 PD-1） |

Windows 启动用 `neo.cmd`（需要 Bun 在 PATH）；Linux/macOS 用 `neo.sh` 或 `bun run src/index.ts`。

### v0.4.1 实战可靠性

- 轮次诊断日志 `~/.neo/logs/turns/`；空响应/失败不再静默 `ok`，resume 会告警。
- 上下文窗口自动探测（`/models` + 溢出学习，落 `~/.neo/env/`），`/context` 看来源/用量；超限自动压缩重试一次。
- `ask_user`：模型可在关键分叉/破坏性操作前向用户提问（单选/多选/自由输入，Esc 取消；仅交互 TUI）。
- `web_search`（Bing RSS，无需 key）、`shell.cwd`、超长输出落盘 `~/.neo/tmp/`、`/export [id]`。
- `remember` 同步回执；技能支持 `skills_extra_paths` / `NEO_SKILLS_PATHS`。
- **v0.4.2**：tier 视觉语义（深思亮红 / 平衡绿 / 快速亮蓝 / 默认冰绿），状态条、spinner `⚡`、工具行、回答 `●` 随档位着色；分类切档在首次 LLM 请求前即时提示；`/tier deep|balanced|fast` 支持简写（内部仍规范名）。

shell 探测顺序：`settings.shell.path` → `NEO_SHELL` → `$SHELL` → 平台默认 → `which` → `/bin/sh`；
启动横幅后会显示实际使用的 shell。环境探测（`/env`）不需要模型，纯脚本采集，约 10ms。

## 配置

`settings.json`（已在 `.gitignore` 中，不会误提交）：

```json
{
  "default_provider": "ipsa",
  "default_model_tier": "default",

  "classifier_provider": "ipsa",
  "classifier_model_name": "glm-5.3-flash",

  "providers": [
    {
      "provider_name": "ipsa",
      "provider_type": "openai",
      "base_url": "https://ipsapro.isoftstone.com/thor/v1",
      "api_key": "sk-…",

      "default_model_name": "glm-5.3-flash",
      "deep_reasoning_model_name": "glm-5.3-flash",
      "balanced_model_name": "glm-5.3-flash",
      "fast_model_name": "glm-5.3-flash",

      "max_tokens": 16384,
      "temperature": 0.6,
      "context_window": 200000
    }
  ],

  "model_routes": {
    "default":        { "provider": "ipsa",    "model": "glm-5.3-flash" },
    "balanced":       { "provider": "ipsa",    "model": "glm-5.3-flash" },
    "fast":           { "provider": "ipsa",    "model": "l-deepseek-v4-flash" },
    "deep_reasoning": { "provider": "minimax", "model": "MiniMax-M3",
                        "fallback_allowed": true }
  },

  "compact_threshold": 0.75,
  "theme": "matrix",
  "show_reasoning": true
}
```

### 顶层字段

| 字段 | 说明 |
| --- | --- |
| `default_provider` | 启动用哪个 provider |
| `default_model_tier` | 启动用哪个档位 |
| `classifier_provider` | 分类器固定用哪个 provider |
| `classifier_model_name` | 分类器固定用哪个模型 |
| `model_routes` | 档位 → `{provider, model}` 绑定，见下 |
| `compact_threshold` | 上下文使用率超过该比例触发自动压缩 |
| `max_tool_iterations` | 单轮内最多工具调用轮数 |
| `tool_output_limit` | 单个工具结果的最大字符数 |
| `show_reasoning` | 是否显示模型思维链 |
| `toolcall_info_details` | 工具调用详情：`false`（默认）紧凑单行 + 动画；`true` 旧版 header + 缩进结果块（非 TTY 环境始终显示详情） |
| `theme` | 配色主题 |
| `shell` | 跨平台 shell 覆盖（`path` / `login` / `args`），见下 |
| `env` | 环境探测与注入（`enabled` / `probe_ttl_hours` / `prompt` / `wiki_page`），见下 |

### shell / env —— 平台适配层（v0.4.0）

```json
"shell": { "path": null, "login": true, "args": null },
"env":   { "enabled": true, "probe_ttl_hours": 12, "prompt": true, "wiki_page": true }
```

- `shell.path`：绝对路径覆盖（不填=自动探测）；`shell.login`：是否登录 shell（默认 true，
  登录模式会前置父进程 PATH，保证 neo 能用的命令在 shell 工具里也能用）；
  `shell.args`：整体覆盖参数前缀（逃生口）。
- `env`：环境探测。静态快照写 `~/.neo/env/<machineKey>.json`（TTL 默认 12h）；
  `prompt` 控制是否注入系统提示词；`wiki_page` 控制是否渲染 `~/.neo/wiki/wiki/环境.md`。
  `-p`/非交互模式**只注入不落盘**。环境变量：`NEO_SHELL`、`NEO_ENV_DISABLE=1`。
- 环境块示例（模型在每轮对话里能看到的真实平台信息）：

```
- 平台：Ubuntu 24.04.4 LTS · x64（linux 6.17.0-23-generic）
- shell：/bin/bash（bash，登录 shell；命令必须兼容 bash，不要使用其它 shell 专有语法）
- 资源：4 核 · 内存 3.4G
- 工具：bun 1.4.4 · node 26.9.0 · git 2.43.0 · python3 3.12.3（未列出的工具不要假设已安装）
- 约束：远程 SSH 会话 · 无 GUI（不要建议打开浏览器/编辑器） · 非 root（需要提权时先说明）
```

### model_routes —— 档位与 provider 是两个正交轴

provider 里的 `*_model_name` 表示「**这个 provider** 在各档位上用什么模型」。
`model_routes` 表示「**这个档位** 该打到哪里」。两者正交：档位可以指向任意 provider 的任意模型。

```json
"model_routes": {
  "fast":           { "provider": "ipsa", "model": "l-deepseek-v4-flash" },
  "deep_reasoning": { "provider": "minimax", "model": "MiniMax-M3", "fallback_allowed": true }
}
```

可写简写形式 `"fast": "ipsa"`，等价于 `{provider:"ipsa", model:null}`（model 取该 provider 的同名档位）。

`fallback_allowed: true`（默认）表示目标不可用时自动降级到 `default` 档并告知。

### 关于 classifier_provider

分类器**固定绑在外部指定的 provider 上**，不用自己的分类结果决定自己跑在哪 —— 那是循环依赖。必须绑 ipsa：成本为零、永远能调通、智力足够（分类是分类问题不是推理问题）。

### provider 字段

| 字段 | 说明 |
| --- | --- |
| `provider_name` | provider 标识，`default_provider` 引用它 |
| `provider_type` | 协议类型。目前仅实现 `openai` |
| `base_url` | OpenAI 兼容端点，形如 `https://host/v1` |
| `api_key` | 密钥 |
| `default_model_name` | 默认档位模型 |
| `deep_reasoning_model_name` | 深度推理档位 |
| `balanced_model_name` | 均衡档位 |
| `fast_model_name` | 低延迟档位 |
| `max_tokens` `temperature` `context_window` | 该 provider 的运行时参数，可覆盖顶层同名项 |

四个模型档位只需填 `default_model_name`，其余三档会回落到它的值。

### 关于 `provider_type`

目前只实现了 `openai`。填 `anthropic` 不会让 neo 死 —— 该 provider 会显示为 `[未接入]`，切到它时明确报错且**不污染当前配置**，启动时若 `default_provider` 指向它则退出码 2。

这样处理是因为两者的不兼容点有两处硬伤：鉴权头（`x-api-key` vs `Authorization: Bearer`）和响应结构（content 块数组 vs 字符串）。走错协议会得到极难排查的错误。已实测 MiniMax 的 Anthropic 端点可用且支持 `tool_use`，接入时需要处理 `usage` 字段名差异（`input_tokens` vs `prompt_tokens`）。

### 覆盖优先级

环境变量优先级高于配置文件：

`NEO_PROVIDER` / `NEO_TIER` / `NEO_MODEL` / `NEO_BASE_URL` / `NEO_API_KEY`

配置文件搜索顺序：当前目录 `settings.json` → 项目根 `settings.json` → `~/.neo/settings.json`。

旧版扁平格式（顶层 `api-key` / `OpenAI` / `model_name`）仍能读取，会自动折算成一个名为 `legacy` 的 provider 并给出提示。

## 命令行

| 选项 | 说明 |
| --- | --- |
| `-p, --print <text>` | 单次执行一轮后退出 |
| `-m, --model <id>` | 直接指定模型 ID，绕过档位 |
| `-P, --provider <name>` | 切换 provider |
| `-t, --tier <name>` | 模型档位：`fast` / `balanced` / `default` / `deep_reasoning` |
| `--auto <name>` | 分类器：`off` / `rule`（默认）/ `llm` |
| `-C, --cwd <dir>` | 切换工作目录 |
| `-y, --yes` | 自动批准全部操作 |
| `--edit` | 自动批准写文件，执行命令仍需批准 |
| `--plan` | 只读，禁止一切写操作 |
| `-c, --continue` | 继续上一次会话 |
| `--resume [id]` | 恢复指定会话，默认最近一次 |
| `--sessions` | 列出历史会话 |
| `--no-reasoning` | 不显示思维链 |
| `--name <n>` | 设置本会话名字（跨会话寻址用） |

## 交互命令

```
/help      帮助            /clear     清空上下文
/compact   压缩上下文      /cost      token 与 provider 统计
/auto      切换分类器      /why       上次分类判定与理由
/provider  切换 provider   /tier      切换档位（显示生效路由）
/model     查看/切模型     /tools     工具列表
/env [refresh] 环境快照（平台/shell/资源/工具链）；refresh 重采并写 wiki 页
/mode      权限模式        /init      生成 AGENTS.md
/peers [name]  跨会话状态：列出存活会话 / 查单个
/inbox     查看 held 消息；/inbox release <id> 放行一条
/rename <name> 设置本会话名字（跨会话寻址；撞名自动加后缀）
/history   历史统计        /save      导出会话
/sessions  历史会话        /resume    恢复会话（无参进入选择）
/skills    技能列表与详情  /ingest    编译 raw → wiki
/wiki-lint wiki 体检        /memory    记忆子命令族
/remember  显式记忆         /exit      退出
/last [n]  回看最近 n 次工具调用（默认 1；紧凑模式的信息找回入口）
/fast /balanced /deep /deep_reasoning /default   档位快捷方式（等价 /tier）
!<cmd>     直接执行 shell（受权限模式约束，plan 模式下拒绝）
```

### TUI：底部常驻状态条 + 输入框（v0.3.0）

```
────────────────────────────── Agent: Trinity ──
❯ 你的消息…（多行 / 补全 / 中文 / 光标可编辑）
────────────────────────────────────────────
deepseek-flash · balanced · ask · ⎇ main · ctx ▓▓░░░ 42% · 0:42 · 12.3k tok
```

- 状态条每 250ms 刷新：model / tier / 权限模式 / git 分支 / ctx 百分比 + 进度条 /
  本轮已跑时长 / 累计 tok；忙碌时顶线标题带「运行中」，排队有提示。宽度不足按优先级降级，不折行。
- 输入框：上下横线、无左右边框；`Enter` 提交，`Ctrl+J` / `Shift+Enter` / `Alt+Enter` /
  `Ctrl+Enter` 换行；超过 8 行滚动窗口；退格按码点（中文一次一个字）。
- 历史 ↑↓（前缀搜索）、`Tab` 补全、`Ctrl+V` 贴图、大段粘贴折叠 chip；
  审批问题显示在框上方、输入框不卸载；选择菜单在 live 帧内渲染。
- **不换渲染模型**：不 alt-screen，历史留在 scrollback；非 TTY（`-p` / 管道 / CI）走原 readline 路径。
- **会话代号（v0.3.1）**：交互启动从 12 个《黑客帝国》角色池随机取一个未被存活会话占用的名字
  （`--name` 与 resume 旧名优先；池全占才加后缀）；顶线显示 `Agent: <代号>`，`/rename` 即时同步。
  代号为 `neo` 时，标题每 10–20 秒在 `Mr.Anderson`（dim）与 `N E O`（Matrix 绿）之间切换，
  切换前 3 帧 ×80ms 字符雨；`neo` 本身仍是普通可寻址名字。
- `--resume`（v0.3.1 起）真续接同一 session-id/文件/信箱身份；运行中的会话不列出、不允许恢复。
- v0.3.2/0.3.3 hotfix：并发 `--resume` 抢锁失败不再覆盖存活会话 profile（`.alive/owner.json` + 先抢锁后写 profile）；resume 身份失败直接 exit 2；owner 新鲜保护启动窗口。
- `Ctrl+O` transcript 视图与轮次 diff 留 v0.3.2 / v0.3.3。

> M0 探针（raw mode / 按键 / live 帧 / 交错 / 终端恢复）见
> `scripts/tui-probe.ts` 与 `docs/v0.3.0-tui-prd[done].md` §2；PTY 场景 S11~S19 覆盖状态条、
> 输入框、多行、审批、resize、选择菜单、双 Ctrl+C、resume 真续接、代号/标题。

### 输入补全与引用（v0.2.4）

| 能力 | 用法 |
|---|---|
| 文件补全 | `@` + 路径前缀 + `Tab`：模糊匹配当前工作目录（走 `git ls-files`，尊重 `.gitignore`），多个候选连按 `Tab` 在同一批候选里循环，并打印候选提示行 |
| 命令补全 | `/` + 前缀 + `Tab`：列出并插入斜杠命令（命令候选不设 20 上限，33 条都能搜到） |
| 文件引用 | `@src/ui/console.ts`：提交时把文件内容附在消息末尾（≤5 个文件、单文件 ≤400 行、总 ≤60KB），失败只警告不阻断 |
| 多行输入 | v0.3.0 起由输入框原生多行承载：`Ctrl+J` / `Shift+Enter` / `Alt+Enter` 换行，`Enter` 提交为一条含换行的消息；行尾 `\` 等价 |
| 工具回看 | `/last [n]`：回看最近 n 次工具调用的完整输出 |

> 为什么 Tab 由自己接管：bun 1.3.13 的原生 `completer` **可用**（M0 探针 P1/P3 实证），
> 但它只拿到整行、不给光标位置，候选排序与样式也不可控；而 `@` 需要「光标前 token 精确替换」。
> 所以注册一个返回空候选的 no-op completer（否则裸 Tab 会被当字面量 `\t` 插进缓冲），
> Tab 的语义统一交给 `HotkeyRouter`。探针与原始证据见 `docs/v0.2.4-m0-probes[done].md`。

`!cmd` 与模型工具调用走**同一套权限判定**：`--plan` 下两者都会被拒绝，
`auto-all` 下两者都直接放行，`ask` / `auto-edit` 下都要审批。

## 开发

```bash
bun run check   # tsc --noEmit，strict + noUncheckedIndexedAccess（含 scripts/）
bun test        # 单元测试，812 pass（43 个测试文件）
bun run e2e     # 真 PTY 端到端（19 场景；渲染类改动必跑；不需要真实网络/LLM）
bun run verify  # 全量闸门：tsc → test → pty（19 个 PTY 场景），证据落 docs/evidence/
```

> 终端渲染类改动（动画行、宽度、覆盖语义）**只有真 PTY 能验证**。
> 可复用脚本见 `scripts/`：`fake-llm.ts`（无状态假 SSE）、`pty-e2e.ts`（屏幕断言）、
> `verify.sh`（闸门）。约定见 `tests/README.md` §1。

## 分类器

分类器是一个接口（`src/classifier/types.ts` 的 `TierClassifier`），有两个实现：

| 实现 | 延迟 | 成本 | 可解释性 | 何时用 |
|---|---|---|---|---|
| `RuleClassifier` | 0 | 0 | 每条规则都有文字理由 | 默认 |
| `LlmClassifier` | 1~3s | 一次调用 | 无法追溯 | 规则判不准时 |

新增实现只需在 `src/classifier/index.ts` 的 `build()` 里加一个 `case`。

### 规则版的行为

按优先级从高到低，第一个命中即返回：

| 规则 | 触发条件 | 结果 |
|---|---|---|
| `override` | `/fast` `/deep` 等显式指令 | 指定档位 |
| `tool_failure` | 工具连续失败 ≥2 次 | 升 1~2 档（失败越多升越多） |
| `context_pressure` | 上下文占用 >50% | 升到 `balanced` 或 `deep_reasoning` |
| `deep_strong` | 命中架构/设计/根因类词 | `deep_reasoning` |
| `deep_weak` | 命中为什么/分析类词 | `balanced` |
| `fast_signal` | 命中列一下/读一下/grep 类词 | `fast` |
| `long_input` | 输入 >500 字 | `balanced` |
| — | 都没命中 | 维持当前档位 |

**升档意图被拒绝时只能向上回落，绝不向下。** 高难度任务掉到更笨的模型上比留在原地更糟。

### 分类时机

只在**轮次开始**时分类，不在工具循环内部切。原因：跨 provider 的对话历史需要格式转换，一个轮次里反复切换会让转换次数和出错概率都上升。代价是「工具报错立刻升档」做不到，改为记录失败数、下一轮生效。

### 为什么规则版是默认

不是 LLM 不好，是这三件事对**每轮都要跑的**分类不利：网络延迟、付费模型的鉴定费、以及判错时无法追溯。规则版判错时 `/why` 能直接告诉你哪条规则错了 —— 这是调试期最需要的东西。

### 为什么 LLM 分类器也一并写了

两个原因：一是规则判不准时（「分析这段代码为什么慢」不含任何关键词但确实需要智力）可以切过去；二是它验证了接口抽象是干净的 —— 两个独立实现在同一批用例上给出相同判定，说明 `TierClassifier` 确实容纳得住不同实现。

## 工具

| 工具 | 敏感 | 说明 |
| --- | --- | --- |
| `read_file` | 否 | 读文件，带行号，支持 `offset`/`limit` 分页 |
| `write_file` | 是 | 写文件（覆盖），自动建父目录 |
| `edit_file` | 是 | 精确字符串替换，`old_string` 须唯一 |
| `list_dir` | 否 | 列目录，含大小与修改时间 |
| `glob` | 否 | glob 找文件 |
| `grep` | 否 | 正则搜内容，`path` 可传目录或单文件 |
| `shell` | 是 | 执行命令，带超时与退出码；shell 按平台自动选择（macOS/Linux/Windows） |
| `web_fetch` | 否 | 抓网页转纯文本 |
| `use_skill` | 否 | 按需加载技能正文（三层渐进披露） |
| `task` | 否 | 派生子代理跑隔离子任务（深度结构性 ≤1） |
| `wiki_search` | 否 | 检索记忆 wiki；`scope=auto` 先项目级、后用户级 |
| `wiki_write` | 否 | 回填记忆 wiki 的唯一合法路径（强制摘要/日期戳/INDEX/log） |
| `remember` | 否 | 显式写入长期记忆（异步提炼落页，子代理不可见） |
| `compact_ctx` | 否 | 模型主动请求压缩上下文（工具批次结束后执行） |
| `send_message` | 否 | 给另一个存活会话投递纯文本消息（可选 `reply_to`=任务号）；子代理不可见 |
| `list_peers` | 否 | 列出存活会话的状态机摘要；带 `target` 查单个；子代理不可见 |

## 权限模式

- `ask`（默认）：写文件、执行命令都要批准
- `auto-edit`：自动批准写文件，命令仍需批准
- `auto-all`：全部自动批准
- `plan`：只读，一切写操作被拒绝

非交互环境（管道、CI、`-p` 重定向）下无法征求批准，一律拒绝并提示改用 `-y`。

## 跨会话消息

neo 支持多个**前台交互式**会话互相发纯文本消息，用于「一个会话编排、多个会话执行」的多终端协作。**没有固定 leader**：任何会话都能发任务、接任务、多跳协作；`leader` 只是人给终端起的名字。

- **启用**：交互式 `neo` 启动即启用（`-p` / 非交互不参与）。每个终端 `/rename <name>` 起名，或启动加 `--name <n>`；名字撞名自动加 `-2` 后缀。
- **工具**：模型可用 `send_message(target, body, reply_to?)` 与 `list_peers(target?)`；人可直接用 `/peers [name]`、`/inbox`、`/rename <name>`。
- **投递**：发送方写入 `~/.neo/mailbox/<session-id>/inbox/`；接收方在工具间隙（P1）或空闲 tick（P2）收到并自动开 turn。进程退出即不可达，v1 不排队、不离线补投。
- **状态机**：每个会话维护 `state.json`（idle/working/waiting_input/exiting + 心跳 + `outstanding` 委派 + 最近 in/outbound）。发起方每 120s 检查接活方，发现死亡 / 停滞 / 跑完不回信时注入 `<跨会话状态通知>`；B 在等 C 时不会被误报。
- **人工接管**：任意终端可随时 ESC 叫停、补话、继续；自动 turn 被 ESC 中止时不回滚历史，人类自己输入的 turn 保留回滚。
- **权限与信任**：消息永远不是用户的同意。默认信任档：`auto-all` 接收方默认 hold 来自非 auto-all 的消息；提示类接收方默认 accept。承接方建议用 `--edit`（自动批文件写、shell 仍审批），或显式在 settings 配 `cross_session_inbound: "accept"`。
- **配置**（settings.json 顶层，snake_case）：`cross_session_inbound` / `cross_session_auto_turn_limit` / `cross_session_heartbeat_ms` / `cross_session_dead_after_ms` / `cross_session_progress_timeout_ms` / `cross_session_watchdog_interval_s`。
- **边界**：不做 supervisor / 后台会话 / attach / agent view / 跨机（v0.3）；投递 at-most-once，进程崩溃可能丢一条消息（接受）；多跳环由每会话自动 turn 上限 20 + 限流 + 去重兜底。
- **规格**：`docs/cross-session-messaging-prd[done].md`。

## 设计要点

**推理模型双流。** `glm-5.3-flash` 把思维链放在 `reasoning_content` 字段，与正文 `content` 分开流式下发。neo 两者分别渲染：思维链以暗绿 `┌ think` 框显示，正文以亮绿 `●` 开头。思维链不写入对话历史，避免污染后续轮次。

**provider 与档位是两个正交轴。** provider 的 `*_model_name` 是「这个 provider 在各档用什么模型」，`model_routes` 是「这个档位打到哪里」。所以切档位会连带换供应商，切 provider 会连带换模型。`switchTier`（只换 model 不换 base_url）按跨供应商调度必然失败 —— 这是早期版本的真实 bug。

**分类器做成接口而非 if/else。** `TierClassifier` 有两个独立实现（规则、LLM），`off` 状态也实现接口（是个「维持当前档」的分类器），这样调用方不必为它写特例分支。加新实现在 `build()` 里加一个 `case` 即可。

**升档失败只能向上回落。** 目标档不可用时，`firstAvailableAtOrAbove` 从目标档往上找可用档，不往下。往下降会让高难度任务掉到更笨的模型上，比不升更糟 —— 这是实测发现的：`deep` 不可用时，「排查内存泄漏根因」曾被判成 `fast`。

**推理模型的小预算陷阱。** LLM 分类器一开始设 `maxTokens: 16`，结果 content 全空 —— 因为思维链本身就要几十 token，预算全被吃掉了。给到 512 才正常。**任何调用推理模型的地方都不能把 max_tokens 设太小。**

**参数校验要早于 `--help`/`--version`。** 否则 `--auto bogus --version` 会打印版本后返回 0，把拼写错误静默放过，下次真跑起来才报错。

**配置加载顺序有陷阱。** `providers` 是数组，不能像对象那样 `{...a, ...b}` 浅合并，必须逐级判定。关键一条：**本地 settings.json 的旧版字段优先于模板的 providers** —— 否则拿旧配置的用户会静默套用 `settings.example.json` 里的示例密钥和地址，不报错但请求全打到别人的网关上。

**模型切换要同步系统提示词。** 提示词里写死了启动时的模型名和「这是推理模型」的说明，中途换模型而不改提示词，模型会按旧认知行事。所以 provider/tier/model 三种切换都会调 `Agent.noteModelChange()` 重写那一行。

**行级流式渲染。** 跨 chunk 的 `**粗体**` 若逐片段着色会被截成乱码。`StreamFormatter` 按完整行着色，代码围栏检测也必须在行级做 —— 因为 ```` ``` ```` 和它的语言标注可能分处两个 chunk。

**工具调用默认只占一行。** 连续工具调用不再逐条打印 header + 结果块（7 次 `list_dir` 会冲散关键信息）。默认在 TTY 下用一行 `⚡ name args .` 原地更新，`.`/`..`/`...` 每 350ms 循环表示运行中；下一个工具调用覆盖同一行；完成后尾标变 `✓`/`✗`。原始结果仍完整交给模型，只是不占屏幕。想恢复旧版详情：settings.json 设 `"toolcall_info_details": true`。非 TTY（`-p` / 管道 / CI）保留逐行详情，避免动画控制符污染日志。

**上下文压缩。** 每轮前估算 token（ASCII 按 4 字符/token，CJK 按 1.5），超过 `compact_threshold` 自动把历史压成一条结构化摘要。`/compact` 可手动触发。

**审批走 readline。** 问句用 `rl.question()` 而非另开 raw-mode stdin 监听，否则两者同时消费输入会导致回显两遍。

**记忆是双作用域 + 编译产物。** 项目级记忆跟仓库走（`.neo/wiki/`），用户级记忆跨项目共享（`~/.neo/wiki/`），两者同构复用 wiki 校验。一轮问答结束后由 fast 档提炼器归纳成「决策/踩坑/偏好」等页面；下一轮开始前**先查项目级、再查用户级**注入。原始对话只进 `~/.neo/memory/journal/`（运行日志），不进 wiki —— wiki 永远只是当前最优综述。推断出的用户画像必须带 `[推断]` 标记，召回时只作背景。

**`-p` 单次模式只用项目级记忆。** 该模式多用于服务器脚本，混入操作员个人记忆会造成混乱；因此系统提示、召回、工具三处同时降级为 project-only。

**记忆写入绝不阻塞主流程。** 先落 journal 再调 LLM 提炼；失败只降级、不抛错；会话退出前 flush 有超时，未完成的记录下次启动自动恢复。完整规格见 `docs/001-memory-system-design[done].md` §7。

## 项目结构

```
neo/
├── settings.json           # 本地配置（含密钥，已 gitignore）
├── settings.example.json   # 配置模板
└── src/
    ├── index.ts            # CLI 入口、斜杠命令、交互循环
    ├── agent.ts            # agent 循环、上下文管理、轮次分类
    ├── llm.ts              # OpenAI 兼容客户端（SSE 流式 + tool_calls 拼接）
    ├── config.ts           # provider 解析、档位路由、降级、旧格式迁移
    ├── system-prompt.ts    # 系统提示词与 /init 记忆文件
    ├── session.ts          # 会话持久化（~/.neo/sessions）
    ├── skills.ts           # 技能发现/索引/软链（三层渐进披露）
    ├── paste.ts            # 长文本粘贴折叠
    ├── attachments.ts      # 粘贴附件（文本/图片）chip 绑定与还原
    ├── clipboard.ts        # macOS 剪贴板图片读取（JXA）
    ├── hotkeys.ts          # 按键路由（ESC/Ctrl+C/粘贴边界）
    ├── memory/             # 记忆：双作用域布局/召回/提炼/合并/捕获/桥
    ├── mailbox/            # 跨会话消息：类型/状态机/身份/文件信箱/入站框架
    ├── wiki/               # wiki 知识库：回填校验/lint/检索/ingest
    ├── classifier/         # 档位分类器
    │   ├── types.ts        # TierClassifier 接口
    │   ├── rules.ts        # 规则实现（默认）
    │   ├── llm.ts          # LLM 实现（可选）
    │   └── index.ts        # 注册表与选择
    ├── tools/
    │   ├── index.ts        # 工具实现与调度
    │   └── mailbox.ts      # 跨会话工具 send_message / list_peers
    └── ui/
        ├── theme.ts        # Matrix 调色板、数字雨、横幅
        ├── toolLine.ts     # 紧凑工具调用行格式化（单行 / 点号动画 / ✓✗）
        ├── console.ts      # 输出、spinner、审批、状态栏
        ├── stream.ts       # 流式 Markdown 渲染
        └── render.ts       # 块级 Markdown 渲染
```

## 开发

```bash
bun run check    # tsc --noEmit
```

## 环境

Bun >= 1.1（实测 1.3.13）。运行时零第三方依赖，`typescript` 与 `@types/bun` 仅用于类型检查。
