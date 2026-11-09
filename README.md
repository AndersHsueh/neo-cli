# neo

Matrix 风格的终端编程助手。用 Bun 写的 CLI harness，对接 OpenAI 兼容与 Anthropic Messages 两种协议的 LLM 网关。

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
| macOS | `$SHELL`（默认 zsh） | ✅ 实测（tsc / 1704 测试 / PTY 24/24） |
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
- **v0.4.77**：写入 wiki 时校验正文里的 `[[链接]]` 目标 —— 本层没有会提示「缺失」，只在用户级/项目级另一层有会提示「在哪一层」（不阻断写入）。
- **v0.4.78**：托管 worktree 的路径比对统一走 canonical 口径 —— 仓库路径含软链时（macOS 的 `/var`、`/tmp`）清单不再恒空。
- **v0.4.79**：`max_tokens` 安全防护 —— 启动时体检并告警不合理配置；网关回**不透明 400** 时自动降级到安全值重发一次（只降不升、每次请求一次、不改你的配置）。

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
      "api_type": "openai",
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
| `mcpServers` | 外部 MCP server（stdio），工具动态注册为 `mcp__<server>__<tool>`，见下 |
| `hooks` | 生命周期 hooks（PreToolUse / PostToolUse / TurnEnd），见下 |

### hooks —— 生命周期脚本（issue #3）

**先说定位：hooks 不是权限系统。** 它不定义 allow/deny 规则、不做命令策略表、不提供沙箱。
它只是「在三个固定时机，跑你自己写的脚本」。权限判定（`ask` / `auto-edit` / `auto-all` / `plan`）
完全不变：hook **只能阻断**（或放行到既有审批流程），**永远不能把调用升级为免审批**，
也不能绕过 plan 拒绝。

配置写在 `settings.json` **顶层**的 `hooks` 段（与 `mcpServers` 同级）：

```json
"hooks": {
  "enabled": true,
  "verbose": true,
  "PreToolUse":  [ { "command": "sh .neo/hooks/guard.sh",  "matcher": "shell", "timeout": 10 } ],
  "PostToolUse": [ { "command": "sh .neo/hooks/format.sh", "matcher": "/^(write_file|edit_file)$/",
                     "timeout": 30, "onFailure": "continue" } ],
  "TurnEnd":     [ { "command": "sh .neo/hooks/turn-end.sh", "timeout": 10, "onFailure": "continue" } ]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `enabled` | 否 | 缺省 `false` —— 不配就是零开销，也不会有人被意外阻断 |
| `verbose` | 否 | 缺省 `true`：阻断/失败/超时都打到 UI；`false` 只保留阻断提示 |
| `PreToolUse` / `PostToolUse` / `TurnEnd` | — | 每个事件一个数组，按配置顺序执行 |
| `command` | 是 | shell 命令，经与 `shell` 工具同一套平台解析执行（`shell` 段配置同样生效） |
| `matcher` | 否 | 工具名匹配，见下。缺省 = 全部工具（`TurnEnd` 无工具名，恒匹配） |
| `timeout` | 否 | 秒，缺省 30，上限 600（超上限截断并 warning） |
| `onFailure` | 否 | `continue`（缺省）/ `block`，仅 PostToolUse / TurnEnd 有意义 |

`matcher` 三种写法：精确名（`shell`、`write_file`）、末尾通配（`mcp__*`、`mcp__fs__*`）、
正则（`/^mcp__/`）。注意**不支持** `write_file|edit_file` 这种竖线写法 —— 那是正则语法的一部分，
要写就写成 `/^(write_file|edit_file)$/`。

**配置写错不会让 CLI 起不来**：单条写错（缺 `command`、`timeout` 非正数、`matcher` 正则非法、
事件名拼错）只丢弃该条并给一条可读 warning，其余照常加载。启动时打印告警，`/hooks` 可随时复查。

#### 事件与时机

| 事件 | 时机 | 能否阻断 |
| --- | --- | --- |
| `PreToolUse` | 工具执行前，**审批通过之后** | 能（退出码 2） |
| `PostToolUse` | 工具执行完成后（成功与失败都触发） | 不能撤销，只能把失败原因交给模型 |
| `TurnEnd` | 一轮 agent 回合结束（模型给出最终答复，含 `-p` 单次模式） | 能让该轮以出错结束 |

**为什么 PreToolUse 在审批之后**：如果 hook 跑在审批之前，用户点「拒绝」时 hook 已经执行过
（副作用不可撤回），而且 hook 的「放行」会变成权限旁路。所以顺序被固化成
`审批 → PreToolUse → 执行`：被用户拒绝、被 plan 拒绝的调用**根本走不到 hook**。
hook 说放行，也只是「回到原本该有的审批流程」，不会让 `ask` 模式下的写操作免确认。

#### 输入输出协议

hook 从 **stdin** 收一行 JSON，字段：

```json
{
  "event": "PreToolUse",
  "session_id": "20261107-151309-fwu920",
  "cwd": "/home/me/proj",
  "mode": "ask",
  "subagent": false,
  "turn": 3,
  "tool_name": "shell",
  "tool_input": { "command": "rm -rf build" }
}
```

- `PostToolUse` 额外带 `ok`（bool）、`result`（结果摘要，截断到 2000 字符）、`truncated`；
- `TurnEnd` 带 `turn_stats`：`finish_reason` / `tool_calls` / `iterations` / `aborted` /
  `had_error` / `error_message`；
- `mode` 是当前生效权限模式（`ask` / `auto-edit` / `auto-all` / `plan`）；
- `subagent` 标明这次调用是否来自 `task` 子代理。

环境变量（可选，便于脚本直接取）：`NEO_HOOK_EVENT`、`NEO_HOOK_SESSION`、`NEO_HOOK_MODE`、
`NEO_HOOK_TOOL`（TurnEnd 无）。cwd 是 neo 的工作目录。

**退出码约定**：

| 退出码 | 含义 |
| --- | --- |
| `0` | 放行 / 通过 |
| `2` | 阻断。原因取 stdout（纯文本，或 `{"reason":"..."}` / `{"message":"..."}` JSON），取不到则用 stderr |
| 其它非 0 | hook 自身出错（崩溃、脚本 bug、命令不存在），按 `onFailure` 处理 |

阻断原因会以 `已被 PreToolUse hook 阻断：<reason>` 的形式回给模型，模型能看到并改策略。

#### 失败处理：continue vs block

PostToolUse / TurnEnd 的 hook 失败（超时、崩溃、非 0 非 2）默认**不静默**：

- `onFailure: "continue"`（缺省）：给用户一条可读诊断（`PostToolUse hook（settings.hooks.PostToolUse[0]）失败：…`），
  工具结果原样保留，本轮不算出错；
- `onFailure: "block"`：**工具已经执行完、无法撤销**，所以「阻断」的定义是——
  - PostToolUse：把 `[hook PostToolUse failed: <原因>]` 追加到回给模型的工具结果末尾，
    并把该工具结果标记为出错，让模型看到并据此处理；
  - TurnEnd：把 `[hook TurnEnd failed: <原因>]` 并进本轮 `errorMessage` 并标记该轮出错，
    `-p` 模式因此以非 0 退出码结束（`1`）。

另外，退出码 `2` 在 PostToolUse / TurnEnd 上同样视为「明确要求阻断」，与 `onFailure` 无关。

#### 超时与失败隔离

每条 hook 独立起进程，超时用 `SIGKILL` 打**整个进程组**（`detached` 起的 shell 是组长），
`sleep 100 &` 这类子进程不会变成孤儿。超时、崩溃、命令不存在都转成可读诊断，
**不拖垮主循环、不挂死会话**。Ctrl+C 会连正在跑的 hook 一起杀掉。

#### plan / 只读语义

**plan 生效时（`/mode plan`、`--plan`、交互 `/plan` 规划态、`/review` 的临时只读），hook 一律不执行。**

理由：hook 是用户脚本，neo 无法保证它不写盘，而 plan 是对用户的只读承诺。
宁可少跑一次 hook，也不能让「只读审查」留下副作用。连带效果：

- plan 下被拒绝的工具调用不会触发 `PostToolUse`（它压根没执行）；
- `TurnEnd` 在 plan 下也不跑，因此也不会因为 hook 失败把一轮只读问答标成出错。

#### 子代理语义

`task` 子代理的工具调用**同样触发** `PreToolUse` / `PostToolUse`（载荷里 `subagent: true`）——
子代理是「同一次用户请求里的工具执行」，绕过 hook 等于给 hook 留了一条结构性旁路
（危险命令派给子代理跑就躲过了拦截）。

`TurnEnd` **只在主代理回合结束触发**：子代理的回合不是用户眼里的回合，一次请求触发 N+1 次没有意义。

#### 生效时机

hooks 配置在**会话启动时加载一次**（与 `mcpServers` 同口径）。改了 `settings.json` 的 `hooks` 段
需要重启 neo 才生效。`/hooks` 列出当前已加载的条目与配置告警。

只认本地 `settings.json`：`settings.example.json` 里的示例 hook 不会在用户机器上被执行。

#### 示例一：拦截危险 shell 命令

`.neo/hooks/guard.sh`：

```sh
#!/bin/sh
# PreToolUse：从 stdin 读事件 JSON，命中危险模式就以退出码 2 阻断。
payload=$(cat)
cmd=$(printf '%s' "$payload" | sed -n 's/.*"command":"\([^"]*\)".*/\1/p')

case "$cmd" in
  *"rm -rf /"*|*"rm -rf ~"*|*"git push --force"*|*"git reset --hard"*)
    echo "危险命令被拦截：$cmd。请改用更保守的做法，或先向用户确认。" >&2
    exit 2
    ;;
esac
exit 0
```

```json
"hooks": {
  "enabled": true,
  "PreToolUse": [{ "command": "sh .neo/hooks/guard.sh", "matcher": "shell", "timeout": 10 }]
}
```

被拦时模型收到的工具结果是 `已被 PreToolUse hook 阻断：危险命令被拦截：rm -rf / …`，
它会换个做法继续，而不是卡住。

#### 示例二：编辑后自动 format

`.neo/hooks/format.sh`：

```sh
#!/bin/sh
# PostToolUse：工具写盘后跑格式化。只处理 .ts/.tsx，其它文件直接通过。
payload=$(cat)
path=$(printf '%s' "$payload" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')

case "$path" in
  *.ts|*.tsx) bunx prettier --write "$path" >/dev/null 2>&1 || exit 0 ;;
esac
exit 0
```

```json
"hooks": {
  "enabled": true,
  "PostToolUse": [{
    "command": "sh .neo/hooks/format.sh",
    "matcher": "/^(write_file|edit_file)$/",
    "timeout": 60,
    "onFailure": "continue"
  }]
}
```

格式化失败（没装 prettier、语法错）只给一条诊断，不会让工具结果变成错误 ——
`onFailure: "continue"` 就是为这种「锦上添花」的 hook 准备的。

### lsp —— 代码智能（编辑后诊断 + 只读导航，issue #23）

按配置启动**你本机已安装**的语言服务器（neo 不捆绑、不做沙箱；没配就是零开销）：

```json
"lsp": {
  "enabled": true,
  "diagnostics_timeout_ms": 1500,
  "servers": [
    { "command": "typescript-language-server", "args": ["--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"] }
  ]
}
```

- 安装示例：`bun add -g typescript-language-server typescript`（或你惯用的包管理器）。
- **编辑后诊断**：`write_file` / `edit_file` 落在被 server 处理的后缀上时，把该文件的新诊断摘要
  （前 10 条，`文件:行:列 [severity] 消息`）附在工具结果里；无 server / 无诊断时结果不变。
- **只读工具 `lsp`**：`operation = definition | references | hover`，参数 `file`、`line`（1 起）、`character`（1 起）；
  未配置/未连接会返回可读错误。`extensions` 省略时按 server 名/命令推断（typescript / pyright / gopls / rust-analyzer）。
- 启动失败的 server 只记 error 状态不拖垮会话；会话退出会关掉子进程。

### repo_map —— 仓库地图（issue #15）

系统提示词会带一份**符号级仓库地图**：每个源码文件后跟其主要导出/定义（TS/JS/Python/Go/Rust），
让模型在大仓里先看见结构、少做几轮盲扫。默认开启，预算保守：

```json
"repo_map": { "enabled": true, "budget_tokens": 800, "max_files": 1200 }
```

- 生成时机：每次渲染系统提示词时生成，结果**缓存 20 秒**；改文件后最迟一次渲染生效。
- 预算：`budget_tokens`（按 4 字符≈1 token 折算字符上限）到顶就截断并标注；单文件最多 10 个符号、>300KB 跳过。
- 扫描：最多 `max_files` 个源文件，跳过 `node_modules/.git/dist/build/venv/target/vendor/.cache/.neo` 等目录。
- 关闭：`"repo_map": { "enabled": false }`；`/context` 的 `repo map` 行能看到文件数/符号数/估算 tokens/是否截断。
- 与「工作目录结构（最多两层）」并存：树说有什么文件，地图说哪个文件定义了什么，不重复灌同一信息。

### mcpServers —— 接入外部 MCP 工具（issue #2）

neo 可以连接 [MCP](https://modelcontextprotocol.io) server，把它们的工具动态注册进工具清单。
配置写在 `settings.json` **顶层**，形状对齐 Claude Desktop / Cursor，不用另学一套：

```json
"mcpServers": {
  "fs": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/notes"],
    "env": {},
    "cwd": null,
    "enabled": true
  }
}
```

最小示例（filesystem MCP，只放开一个目录）：

```json
{
  "mcpServers": {
    "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
  }
}
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `command` | 是 | 可执行文件（`npx` / `bunx` / `node` / 绝对路径） |
| `args` | 否 | 参数数组 |
| `env` | 否 | 追加/覆盖子进程环境变量（在 `process.env` 之上） |
| `cwd` | 否 | 子进程工作目录，缺省 = neo 的 cwd |
| `transport` / `type` | 否 | `stdio`（缺省）或 `http`（issue #29 远程端点）；`sse` 暂不支持，会 warning 跳过 |
| `enabled` | 否 | `false` = 保留配置但不启动（缺省 `true`） |

**远程 HTTP（issue #29）**：改用 `url` + 静态 `headers`，不写 `command`：

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ghp_xxx" }
    }
  }
}
```

- 传输实现是 **streamable HTTP**：POST 到 `url`，响应支持 `application/json` 与 `text/event-stream` 两种形态，
  并把响应头 `Mcp-Session-Id` 回带到后续请求；`Authorization` 等静态 header 原样透传。
- 工具命名、审批、plan 拒绝、`/mcp` 面板与 stdio **完全一致**（不新增旁路）；OAuth 浏览器登录分期，首期用静态 token。
- 连接失败/401 只让该 server 进 error（错误带 URL 与状态码），其余 server 照常连接。

也接受数组形态（与 `providers` 风格一致）：`"mcpServers": [{ "name": "fs", "command": "npx", ... }]`。

行为约定：

- **启动时连接**：对每个已启用的 server 执行 `initialize` + `tools/list`，工具以
  `mcp__<server>__<tool>` 注册（如 `mcp__fs__read_file`），远端 `inputSchema` 原样透传给模型。
- **单个 server 失败不拖垮启动**：失败只记一条可读错误（含 server 名、命令与 stderr 尾巴），
  其余 server 照常连接，主循环不受影响。`/mcp` 可随时查看每个 server 的连接状态、工具数与错误。
- **审批与内置工具同一条路径**：MCP 工具一律视为非只读（`sensitive`），走 `approve` /
  `decidePermission`。具体口径：
  - `ask`：逐个确认；
  - `auto-edit`：**仍需确认**（与 `shell` 同口径）—— auto-edit 放行的只是「本仓库的写盘」，
    而 MCP 工具的副作用我们完全不知道（可能写盘、可能发网络请求、可能删远端资源）；
  - `auto-all`：放行，不弹确认；
  - `/mode plan`、`--plan`、`/review`：工具**可见但调用被拒绝**；
  - 交互式 `/plan` 规划态：工具**对模型不可见**（从工具清单里摘掉）。
  非交互环境（`-p`）同样需要 `-y`。
- **退出清理**：正常退出、Ctrl+C、崩溃路径都会收掉子进程，不留孤儿 `node`。
- 只认本地 `settings.json`：`settings.example.json` 里的示例 server 不会在用户机器上被启动。



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
| `api_type` | 协议：`"openai"`、`"anthropic"`，或两者的数组（见下）。旧字段 `provider_type` 仍识别 |
| `base_url` | 端点。openai 形如 `https://host/v1`；anthropic 写到 `https://host/anthropic` 即可（自动补 `/v1/messages`） |
| `anthropic_base_url` `openai_base_url` | 双协议时各自的端点，未写的回落到 `base_url` |
| `api_key` | 密钥 |
| `default_model_name` | 默认档位模型 |
| `deep_reasoning_model_name` | 深度推理档位 |
| `balanced_model_name` | 均衡档位 |
| `fast_model_name` | 低延迟档位 |
| `max_tokens` `temperature` `context_window` | 该 provider 的运行时参数，可覆盖顶层同名项 |

四个模型档位只需填 `default_model_name`，其余三档会回落到它的值。

### 关于 `api_type`

两种协议都已接入：`openai`（`/chat/completions`，Bearer 鉴权）与 `anthropic`（`/v1/messages`，`x-api-key` + `anthropic-version`；同时带 Bearer 以兼容只认它的网关）。内部消息模型仍是 OpenAI 形态，Anthropic 只在请求边界转换（`src/anthropicWire.ts`），所以会话历史、压缩、子代理在两种协议间通用。

同一网关两种协议都能用时，两个都填：

```json
{ "provider_name": "minimax", "api_type": ["anthropic", "openai"],
  "anthropic_base_url": "https://api.minimaxi.com/anthropic",
  "openai_base_url": "https://api.minimaxi.com/v1", "api_key": "…" }
```

- **优先 anthropic**，与数组里的书写顺序无关；
- 只有「anthropic 端点不存在（HTTP 404/405/501）」才回退 openai，回退不占重试预算，并记住结果（本进程内后续请求直接走可用的那个）；
- 鉴权失败（401/403）、参数错误（400）、限流、5xx **不回退** —— 换协议只会掩盖配置错误；
- 设了 `NEO_BASE_URL` 覆盖地址时，只按 `provider` 的首选协议走单一协议。

Anthropic 路径的差异处理：`system` 提到顶层字段，连续 `tool` 消息合并成同一条 user 的 `tool_result` 块，`parallel_tool_calls` 换成 `disable_parallel_tool_use`，`stop_reason` 映射回 `finish_reason`，`usage` 的输入 token 含缓存读写。多轮工具对话里的 `thinking` 块（含签名）会原样保存并回带，OpenAI 请求体里则剥掉该字段；会话落盘/恢复保留它。

**`max_tokens` 与模型上限。** Anthropic 协议里 `max_tokens` 必填，且服务端不会静默夹紧。上限因模型而异（MiniMax 实测：M3 / M3.1-Flash 为 524,288，M2.7 系为 196,608），而 provider 级的 `max_tokens` 四个档位共用。neo 会在收到「超过该模型上限」的 400 后解析出上限，夹紧并同轮重发一次（按 `provider|base_url|model` 记在进程内，不改写你的配置，并给出提示）。

**学到的上限会入账（issue #8）。** 上面那次「解析出上限」不再只活在内存里：若该 provider 的 `max_output_tokens` 是空的，neo 会把这个精确上限写进 `settings.json`（只填空字段，手写值优先，`max_tokens` 永不被改），并把证据记进 env 事实（`~/.neo/env/<machineKey>.json`）。零额外请求，属于「本来就要撞的墙，顺手把结论记下来」。

**网关什么都不说时，可以显式让它去试边界（默认关）。** 瘦网关的 `/models` 常常只回 `id/object/created/owned_by`，这时可以给 provider 加：

```json
"probe_max_output_tokens": { "enabled": true, "max_attempts": 3, "start": 8192, "cap": 131072 }
```

也接受布尔简写 `"probe_max_output_tokens": true`（其余取默认值）。开启后，**只在**「交互启动 + `max_output_tokens` 仍为空 + `/models` 没给 + 7 天内没探过」时才会真的发请求：从 `start` 起翻倍发最多 `max_attempts` 个极小请求（正文只有 `ok`），**只有服务端明确给出精确上限**才写回；不透明 400 / 上下文超长 / 鉴权失败 / 5xx 一律**不归因、不写配置**（单次观察不是事实）；阶梯顶全部成功也只记「已验证 ≥ X」，不改配置。`-p` 模式不探测，成本可控（默认最多 3 个请求）。

**但有些网关不告诉你上限**，只回一句不透明的 400（如 `request was rejected by an internal MaaS component`）。这种情况解析不出数字，neo 会在**本次请求内**把 `max_tokens` 夹到 8192 重发一次（只降不升、每请求一次、不写进记忆、不改你的配置），并给出提示；降级后仍失败则透传原始报错。所以「配大了 → 会话整个发不出请求」这个坑现在有兜底了。但兜底不是许可：**`max_tokens` 是输出预算，请按需要写（如 `32768`），不要写成接近 `context_window`** —— agent 的预压缩条件是「估算 + `max_tokens` > 窗口 × 0.98」，写得太大会让每一轮都先压缩一次。启动时 neo 也会体检：`max_tokens ≥ context_window` 或超过已声明的 `max_output_tokens` 时直接告警（只告警，不替你改配置）。

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
| `-w, --worktree <name>` | 在托管 worktree 里开会话：`<仓库>/.neo/worktrees/<name>`，分支 `neo/<name>`（已存在则复用） |
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
/mcp       MCP server 状态（连接/工具数/错误）
/hooks     生命周期 hooks 列表与配置告警（不是权限系统）
/mode      权限模式        /init      生成 AGENTS.md
/peers [name]  跨会话状态：列出存活会话 / 查单个
/worktree list          列出 neo 托管的 worktree（名/路径/分支/脏/当前）
/worktree remove <name> 清理托管 worktree（脏则拒绝；--force 需再确认一次）
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
/loop      定时 / 自节奏循环提示：/loop 2m <提示> · /loop self <提示> · /loop（状态）· /loop stop
```

**`/loop` 是什么**（issue #25）：在同一个交互会话里按**时钟**（`/loop 2m 看下 CI`）或**上一轮结束后**
（`/loop self 看下日志`）自动再注入同一条提示，适合盯日志/等 CI。启动即跑第一拍；忙碌或队列非空时
该拍**丢弃**（不排队、不叠加），计入「跳过」次数；`/loop` 无参见模式/已跑/跳过/下次唤醒/提示摘要；
`/loop stop` 停止。默认关闭，`-p` 单次模式不可用。与 `/goal`（条件驱动的目标锚）分工：一个看时钟，一个看条件。

输入框还有一个 **`!` shell 模式**（issue #30）：在空输入框里单独键入 `!`，前缀变成 `! `、正文换色、占位改为
「shell 命令」，回车即执行（命令原文交给 shell，不需要再写 `!`），执行完自动回到普通输入态。空回车不执行；
Backspace 删空或 Esc 退出；旧的一行式 `!<cmd>` 语法保留不变。

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
| 命令菜单 | 行首 `/` **自动**打开纵向菜单（左命令名 / 右短说明，最多 8 行并提示剩余）：继续打字实时过滤，无匹配有明确空态；`↑↓`（`PageUp/PageDown` 一次 5 项）移动高亮；**`Tab` 接受高亮项写入输入框（不执行）**，**`Enter` 接受并立即执行**，`Esc` 关闭菜单并保留已输入文本。旧的「N 个命令候选…（继续按 Tab 循环）」单行 hint 在 TUI 里已移除（只保留给没有输入框的 readline 降级模式） |
| 文件引用 | `@src/ui/console.ts`：提交时把文件内容附在消息末尾（≤5 个文件、单文件 ≤400 行、总 ≤60KB），失败只警告不阻断 |
| 多行输入 | v0.3.0 起由输入框原生多行承载：`Ctrl+J` / `Shift+Enter` / `Alt+Enter` 换行，`Enter` 提交为一条含换行的消息；行尾 `\` 等价 |
| 工具回看 | `/last [n]`：回看最近 n 次工具调用的完整输出 |
| 目标驱动续跑 | `/drive <检查命令> -- <提示>`：每轮结束跑检查命令（exit 0 = 达成），未通过自动再排一轮（默认最多 5 轮，`--max N` 可调）；`/drive` 看状态、`/drive stop` 停。**与 `/goal`（目标锚）是两件事**：`/drive` 只认可验证信号，模型自述「做完了」不算；连续 2 轮无工具调用会暂停防空转。检查命令是用户显式配置的，**不经审批、按配置自动跑**（与 hooks 同口径） |
| 按轮次回滚 | `/rewind` 列出本次会话的用户轮次；`/rewind <n\|last> [code\|conversation\|both]` 回到该轮之前（默认 both = 代码+对话）。只覆盖 `write_file`/`edit_file` 写过的文件（shell 改的不跟踪），轮次表随会话保存，`--resume` 后仍可回滚；单文件 `/undo` 仍在 |

> 为什么 Tab 由自己接管：bun 1.3.13 的原生 `completer` **可用**（M0 探针 P1/P3 实证），
> 但它只拿到整行、不给光标位置，候选排序与样式也不可控；而 `@` 需要「光标前 token 精确替换」。
> 所以注册一个返回空候选的 no-op completer（否则裸 Tab 会被当字面量 `\t` 插进缓冲），
> Tab 的语义统一交给 `HotkeyRouter`。探针与原始证据见 `docs/v0.2.4-m0-probes[done].md`。

`!cmd` 与模型工具调用走**同一套权限判定**：`--plan` 下两者都会被拒绝，
`auto-all` 下两者都直接放行，`ask` / `auto-edit` 下都要审批。

## 路径作用域项目规则（issue #17）

`AGENTS.md` 是「总是-on」的项目指令。monorepo / 前后端同仓时，目录专属约定（比如「改 `src/api/**` 才需要的接口约定」）
不必再塞进 AGENTS.md 每轮付 token：放进规则目录，只在**本轮触达匹配文件**时加载。

```
<project>/.neo/rules/api.md        # 主流位置（递归收集 *.md）
<project>/.claude/rules/*.md       # 兼容 Claude Code 的规则目录
```

```md
---
paths:
  - "src/api/**"
  - "src/server/**"
---
改接口时必须同步更新 openapi.yaml；不要直接改生成的 client。
```

- **有 `paths`**：只在「本轮已触达匹配路径」时以临时 system 消息注入，轮末从历史摘除、不落盘；
  触达来源是 `read_file` / `write_file` / `edit_file` / `list_dir` / `glob` / `grep` 的参数路径，以及用户 `@` 引用
  （**不猜** `shell` 命令文本里的路径——猜错会把规则误加载）。
- **无 `paths`**：按每会话加载，等价于追加进项目记忆段（独立小节，便于区分）。
- glob 支持 `**`（跨层）、`*`、`?`、`{a,b}`、尾部 `/`；不含 `/` 的模式按 basename 匹配任意层级。
- 预算：单条正文最多 4000 字符，每会话合计 16000、单轮 scoped 合计 12000，超出截断并标注。
- `/context` 里看得到「每会话几条 / 本轮命中几条 / 因何命中」；没有规则目录时行为与以前完全一致（零额外上下文）。

## 开发

维护者入口：[docs/maintenance.md](docs/maintenance.md)（改代码前先读）。

```bash
bun run check   # tsc --noEmit，strict + noUncheckedIndexedAccess（含 scripts/）
bun test        # 单元测试（数字以 bun test 输出为准）
bun run e2e     # 真 PTY 端到端（渲染类改动必跑；不需要真实网络/LLM）
bun run verify  # 全量闸门：tsc → test → pty，证据落 docs/evidence/（已 gitignore）
```

> 终端渲染类改动（动画行、宽度、覆盖语义）**只有真 PTY 能验证**。
> 可复用脚本见 `scripts/`：`fake-llm.ts`（无状态假 SSE）、`pty-e2e.ts`（屏幕断言）、
> `verify.sh`（闸门）。约定见 `tests/README.md` §1。
>
> **闸门对 skip 是敏感的**：`bun test` 有 skip 时退出码仍是 0，光看退出码会误判成「全绿」。`verify.sh` 因此会解析 skip 数并告警（列出跳过的文件）；要强制零跳过，用 `NEO_STRICT_SKIPS=1` 让它直接失败。**静默跳过会随版本悄悄累积**，所以豁免要么是显式 `skipIf`（报告里看得见），要么在注释里写清为什么跳过、什么条件下恢复。

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
| `shell` | 是 | 执行命令，带超时与退出码；shell 按平台自动选择（macOS/Linux/Windows）。`background: true` = 后台跑（dev server/watch/长测试），立刻返回 `sh-N`，不阻塞会话；**前台超时也会转后台而不是被杀** |
| `shell_output` | 否 | 按 id（`sh-N`）读后台命令的状态/退出码/输出尾部；用户用 `/ps` 列表、`/ps kill` 停止 |
| `web_fetch` | 否 | 抓网页转纯文本 |
| `use_skill` | 否 | 按需加载技能正文（三层渐进披露） |
| `task` | 否 | 派生子代理跑隔离子任务（深度结构性 ≤1）；`background: true` = 后台跑，立刻返回任务 id，完成后结果自动注入本会话（并发上限 3，`/tasks` 查看 / `/tasks cancel` 取消） |
| `wiki_search` | 否 | 检索记忆 wiki；`scope=auto` 先项目级、后用户级 |
| `wiki_write` | 否 | 回填记忆 wiki 的唯一合法路径（强制摘要/日期戳/INDEX/log） |
| `remember` | 否 | 显式写入长期记忆（异步提炼落页，子代理不可见） |
| `compact_ctx` | 否 | 模型主动请求压缩上下文（工具批次结束后执行） |
| `send_message` | 否 | 给另一个存活会话投递纯文本消息（可选 `reply_to`=任务号）；子代理不可见 |
| `list_peers` | 否 | 列出存活会话的状态机摘要；带 `target` 查单个；子代理不可见 |
| `mcp__<server>__<tool>` | 是 | 外部 MCP server 提供的工具（动态注册，`inputSchema` 透传）；未配置 `mcpServers` 时不存在 |

MCP 工具与内置工具走**同一条**审批路径。两种「plan」要分开看：

- **交互式 `/plan` 规划态**：MCP 工具**从工具清单里摘掉**，模型看不见，也就不会去调。
- **`/mode plan`、`--plan`、`/review`**：工具**仍在清单里可见**，但调用一律被拒绝
  （`/review` 是临时借用只读闸门，结束后恢复原模式）。

`auto-edit` 下 MCP 工具**仍需确认**（与 `shell` 同口径）；`auto-all` 放行。
`/mcp` 查看已接入的 server、连接状态、工具数与失败原因。

## 权限模式

- `ask`（默认）：写文件、执行命令都要批准
- `auto-edit`：自动批准写文件，命令仍需批准
- `auto-all`：全部自动批准
- `plan`：只读，一切写操作被拒绝

非交互环境（管道、CI、`-p` 重定向）下无法征求批准，一律拒绝并提示改用 `-y`。

生命周期 hooks（`settings.json` 的 `hooks` 段）不改变上面任何一条：它只能**阻断**，
不能把调用升级为免审批，plan 下也一律不执行。详见 [hooks 章节](#hooks--生命周期脚本issue-3)。

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

## 托管 worktree：整会话进隔离检出

`--worktree <name>` 把一个**完整会话**放进独立的 git 检出里跑，用于并行开发时互不踩工作区。

```bash
neo --worktree feat-a        # 在 .neo/worktrees/feat-a 里开会话（分支 neo/feat-a）
neo -w fix-9 -p "跑一下测试"  # 与 -p / --resume / -C 等入口兼容
```

- **默认路径**：`<仓库根>/.neo/worktrees/<name>`；**分支**：`neo/<name>`。同名已存在则**复用**（不重建、不覆盖已有改动）；分支已存在但没登记则挂上去，不丢提交。
- **建议加 `.gitignore`**：`.neo/worktrees/` 每个都是独立检出，绝不能进版本控制。本仓库已在 `.gitignore` 里加了这一条，你自己的项目也应加上 `.neo/`。
- **失败即退出**：非 git 目录、名字非法（只允许 `[A-Za-z0-9._-]`，不以 `.`/`-` 开头）、路径被非托管目录占用、`git worktree add` 失败 → 可读错误 + 非 0 退出，且**不留半成品目录/分支**（失败会回滚）。
- **清理**：`/worktree list` 列出 neo 托管的那几个（名/路径/分支/是否脏/是否当前）；`/worktree remove <name>` 删除并 `prune`。
  - **有未提交改动或未跟踪文件时拒绝删除**；确认要丢弃才加 `--force`，且仍会弹一次确认。
  - **不能删除当前会话所在的 worktree**（删掉自己脚下的目录，进程会立刻失去 cwd）；cwd 在该 worktree 的**任意深度子目录**里也算「当前」，`--force` 同样不放行。
  - 被 `.gitignore` 忽略的文件不计入「脏」，干净删除时它们会随目录一起消失 —— 与 `git worktree remove` 语义一致。
  - 只认 `.neo/worktrees/<name>` + 分支 `neo/<name>` 双条件 —— 你自己的其它 worktree 不列、不删。
- **与 `/peers` 的推荐用法**：worktree 管**文件隔离**，`/peers` 管**会话协作**，两者正交、正好互补。
  ```bash
  # 终端 1：编排者，留在主仓库
  neo --name lead
  # 终端 2、3：各占一份检出并行干活
  neo --name worker-a --worktree feat-a
  neo --name worker-b --worktree feat-b
  ```
  在 `lead` 里 `send_message("worker-a", "改一下 X")`，两个 worker 各在自己的 worktree 里改文件，不会互相覆盖；`/peers` 看谁在忙、谁卡住了。收工后回主仓库 `/worktree list` 看哪份还脏，提交完再 `remove`。
- **边界**：worktree 是**文件级隔离**，**不是**安全沙箱、不是权限边界 —— 权限仍由 `/mode` 与审批闸门负责。本片不含子代理自动 isolation、`.worktreeinclude`、allow/deny 设计。

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

**MCP 工具按前缀统一治理。** 外部工具名一律 `mcp__<server>__<tool>`，权限、展示、规划态过滤都按前缀识别，不必维护白名单。所有 MCP 工具都标 `sensitive` —— 远端做什么我们不知道，宁可多问一次；`auto-edit` 下与 `shell` 同口径仍需确认，`auto-all` 才放行。注册名由整批工具集合纯函数算出（`computeMcpNames`），与连接顺序无关：同一 (server, tool) 永远得到同一个名字，合法化有信息损失时（非 ASCII、`a.b` vs `a_b`、`__` 分界、超长截断）追加 `__<8 位哈希>` 保证不同原名不落成同名。单个 server 连接失败只记状态（`/mcp` 可查）不抛错：一个写错的配置不该让整个 CLI 起不来。

**记忆是双作用域 + 编译产物。** 项目级记忆跟仓库走（`.neo/wiki/`），用户级记忆跨项目共享（`~/.neo/wiki/`），两者同构复用 wiki 校验。一轮问答结束后由 fast 档提炼器归纳成「决策/踩坑/偏好」等页面；下一轮开始前**先查项目级、再查用户级**注入。原始对话只进 `~/.neo/memory/journal/`（运行日志），不进 wiki —— wiki 永远只是当前最优综述。推断出的用户画像必须带 `[推断]` 标记，召回时只作背景。

**`-p` 单次模式只用项目级记忆。** 该模式多用于服务器脚本，混入操作员个人记忆会造成混乱；因此系统提示、召回、工具三处同时降级为 project-only。

**记忆写入绝不阻塞主流程。** 先落 journal 再调 LLM 提炼；失败只降级、不抛错；会话退出前 flush 有超时，未完成的记录下次启动自动恢复。完整规格见 `docs/001-memory-system-design[done].md` §7。

## 项目结构

```
neo/
├── settings.json           # 本地配置（含密钥，已 gitignore）
├── settings.example.json   # 配置模板
└── src/
    ├── index.ts            # 组合根：参数、会话装配、REPL（不含命令实现）
    ├── agent.ts            # 兼容入口，再导出 agent/loop.ts
    ├── agent/              # 循环、权限策略、预算提示、压缩切点
    │   ├── loop.ts         # user → LLM → tool → 回填
    │   ├── policy.ts       # ask / auto-edit / auto-all / plan
    │   ├── steer.ts        # 工具预算与目标锚提示
    │   ├── compact.ts      # 安全切点与摘要替换
    │   └── types.ts        # AgentOptions / AgentIO（宿主能力走回调）
    ├── cli/                # 斜杠命令、帮助、shell 直通、会话落盘、版本
    │   ├── commands.ts     # 命令实现；名字自动登记到注册表
    │   ├── command-registry.ts
    │   ├── help.ts
    │   ├── shell.ts        # !cmd，与工具审批共用 policy.ts
    │   ├── sessions.ts
    │   └── version.ts      # 只读 package.json，不再手写第二份版本号
    ├── llm.ts              # 客户端：协议选择/回退、OpenAI SSE 流式、max_tokens 上限学习
    ├── anthropicWire.ts    # Anthropic Messages 转换层（消息/工具/SSE/usage/thinking 块）
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
    ├── mcp/                # MCP 客户端：JSON-RPC stdio / 连接管理 / 工具适配
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
