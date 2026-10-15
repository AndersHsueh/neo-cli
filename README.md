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
| `theme` | 配色主题 |

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

## 交互命令

```
/help      帮助            /clear     清空上下文
/compact   压缩上下文      /cost      token 与 provider 统计
/auto      切换分类器      /why       上次分类判定与理由
/provider  切换 provider   /tier      切换档位（显示生效路由）
/model     查看/切模型     /tools     工具列表
/mode      权限模式        /init      生成 AGENTS.md
/history   历史统计        /save      导出会话
/sessions  历史会话        /exit      退出
/fast /balanced /deep /deep_reasoning /default   档位快捷方式（等价 /tier）
!<cmd>     直接执行 shell（受权限模式约束，plan 模式下拒绝）
```

`!cmd` 与模型工具调用走**同一套权限判定**：`--plan` 下两者都会被拒绝，
`auto-all` 下两者都直接放行，`ask` / `auto-edit` 下都要审批。

## 开发

```bash
bun run check   # tsc --noEmit，strict + noUncheckedIndexedAccess
bun test        # 单元测试，46 个用例
```

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

**provider 与档位是两个正交轴。** provider 的 `*_model_name` 是「这个 provider 在各档用什么模型」，`model_routes` 是「这个档位打到哪里」。所以切档位会连带换供应商，切 provider 会连带换模型。`switchTier`（只换 model 不换 base_url）按跨供应商调度必然失败 —— 这是早期版本的真实 bug。

**分类器做成接口而非 if/else。** `TierClassifier` 有两个独立实现（规则、LLM），`off` 状态也实现接口（是个「维持当前档」的分类器），这样调用方不必为它写特例分支。加新实现在 `build()` 里加一个 `case` 即可。

**升档失败只能向上回落。** 目标档不可用时，`firstAvailableAtOrAbove` 从目标档往上找可用档，不往下。往下降会让高难度任务掉到更笨的模型上，比不升更糟 —— 这是实测发现的：`deep` 不可用时，「排查内存泄漏根因」曾被判成 `fast`。

**推理模型的小预算陷阱。** LLM 分类器一开始设 `maxTokens: 16`，结果 content 全空 —— 因为思维链本身就要几十 token，预算全被吃掉了。给到 512 才正常。**任何调用推理模型的地方都不能把 max_tokens 设太小。**

**参数校验要早于 `--help`/`--version`。** 否则 `--auto bogus --version` 会打印版本后返回 0，把拼写错误静默放过，下次真跑起来才报错。

**配置加载顺序有陷阱。** `providers` 是数组，不能像对象那样 `{...a, ...b}` 浅合并，必须逐级判定。关键一条：**本地 settings.json 的旧版字段优先于模板的 providers** —— 否则拿旧配置的用户会静默套用 `settings.example.json` 里的示例密钥和地址，不报错但请求全打到别人的网关上。

**模型切换要同步系统提示词。** 提示词里写死了启动时的模型名和「这是推理模型」的说明，中途换模型而不改提示词，模型会按旧认知行事。所以 provider/tier/model 三种切换都会调 `Agent.noteModelChange()` 重写那一行。

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
    ├── agent.ts            # agent 循环、上下文管理、轮次分类
    ├── llm.ts              # OpenAI 兼容客户端（SSE 流式 + tool_calls 拼接）
    ├── config.ts           # provider 解析、档位路由、降级、旧格式迁移
    ├── system-prompt.ts    # 系统提示词与 /init 记忆文件
    ├── session.ts          # 会话持久化（~/.neo/sessions）
    ├── classifier/         # 档位分类器
    │   ├── types.ts        # TierClassifier 接口
    │   ├── rules.ts        # 规则实现（默认）
    │   ├── llm.ts          # LLM 实现（可选）
    │   └── index.ts        # 注册表与选择
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
