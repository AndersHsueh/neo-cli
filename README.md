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

## 配置

`settings.json`（已在 `.gitignore` 中，不会误提交）：

| 字段 | 说明 |
| --- | --- |
| `api-key` | LLM 网关密钥 |
| `OpenAI` | OpenAI 兼容端点，形如 `https://host/v1` |
| `model_name` | 模型 ID |
| `max_tokens` | 单次响应上限，默认 8192 |
| `temperature` | 采样温度，默认 0.6 |
| `context_window` | 上下文窗口，用于计算压缩阈值 |
| `compact_threshold` | 使用率超过该比例触发自动压缩 |
| `max_tool_iterations` | 单轮内最多工具调用轮数 |
| `tool_output_limit` | 单个工具结果的最大字符数，超出则中段省略 |
| `show_reasoning` | 是否显示模型思维链 |

环境变量 `NEO_API_KEY` / `NEO_BASE_URL` / `NEO_MODEL` 优先级高于配置文件。

加载顺序：当前目录 `settings.json` → 项目根 `settings.json` → `~/.neo/settings.json`。

## 命令行

| 选项 | 说明 |
| --- | --- |
| `-p, --print <text>` | 单次执行一轮后退出 |
| `-m, --model <id>` | 覆盖模型 |
| `-C, --cwd <dir>` | 切换工作目录 |
| `-y, --yes` | 自动批准全部操作 |
| `--edit` | 自动批准写文件，执行命令仍需批准 |
| `--plan` | 只读，禁止一切写操作 |
| `-c, --continue` | 继续上一次会话 |
| `--resume [id]` | 恢复指定会话，默认最近一次 |
| `--sessions` | 列出历史会话 |
| `--no-reasoning` | 不显示思维链 |

## 交互命令

```
/help      帮助            /clear     清空上下文
/compact   压缩上下文      /cost      token 统计
/model     查看/切模型     /tools     工具列表
/mode      权限模式        /init      生成 AGENTS.md
/history   历史统计        /save      导出会话
/sessions  历史会话        /exit      退出
!<cmd>     直接执行 shell
```

## 工具

| 工具 | 敏感 | 说明 |
| --- | --- | --- |
| `read_file` | 否 | 读文件，带行号，支持 `offset`/`limit` 分页 |
| `write_file` | 是 | 写文件（覆盖），自动建父目录 |
| `edit_file` | 是 | 精确字符串替换，`old_string` 须唯一 |
| `list_dir` | 否 | 列目录，含大小与修改时间 |
| `glob` | 否 | glob 找文件 |
| `grep` | 否 | 正则搜内容，`path` 可传目录或单文件 |
| `shell` | 是 | 执行命令，带超时与退出码 |
| `web_fetch` | 否 | 抓网页转纯文本 |

## 权限模式

- `ask`（默认）：写文件、执行命令都要批准
- `auto-edit`：自动批准写文件，命令仍需批准
- `auto-all`：全部自动批准
- `plan`：只读，一切写操作被拒绝

非交互环境（管道、CI、`-p` 重定向）下无法征求批准，一律拒绝并提示改用 `-y`。

## 设计要点

**推理模型双流。** `glm-5.3-flash` 把思维链放在 `reasoning_content` 字段，与正文 `content` 分开流式下发。neo 两者分别渲染：思维链以暗绿 `┌ think` 框显示，正文以亮绿 `●` 开头。思维链不写入对话历史，避免污染后续轮次。

**行级流式渲染。** 跨 chunk 的 `**粗体**` 若逐片段着色会被截成乱码。`StreamFormatter` 按完整行着色，代码围栏检测也必须在行级做 —— 因为 ```` ``` ```` 和它的语言标注可能分处两个 chunk。

**上下文压缩。** 每轮前估算 token（ASCII 按 4 字符/token，CJK 按 1.5），超过 `compact_threshold` 自动把历史压成一条结构化摘要。`/compact` 可手动触发。

**审批走 readline。** 问句用 `rl.question()` 而非另开 raw-mode stdin 监听，否则两者同时消费输入会导致回显两遍。

## 项目结构

```
neo/
├── settings.json           # 本地配置（含密钥，已 gitignore）
├── settings.example.json   # 配置模板
└── src/
    ├── index.ts            # CLI 入口、斜杠命令、交互循环
    ├── agent.ts            # agent 循环、上下文管理
    ├── llm.ts              # OpenAI 兼容客户端（SSE 流式 + tool_calls 拼接）
    ├── config.ts           # 配置加载与覆盖优先级
    ├── system-prompt.ts    # 系统提示词与 /init 记忆文件
    ├── session.ts          # 会话持久化（~/.neo/sessions）
    ├── tools/index.ts      # 工具实现与调度
    └── ui/
        ├── theme.ts        # Matrix 调色板、数字雨、横幅
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
