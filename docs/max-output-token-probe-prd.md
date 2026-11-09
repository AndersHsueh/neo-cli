# max_tokens 边界探测 PRD（issue #8）

> 状态：实现中（待审查）
> 关联：GitHub #8（后续增强）、#5/#6/#7（能力探测与撞墙写回）、#21（不透明 400 安全降级）
> 维护流程：`docs/maintenance.md` §2 先红后绿、§5 全量闸门、§6 审查前不合入

## 1 背景与目标

neo 的定位是对接**任意** OpenAI/Anthropic 兼容模型并尽量发挥它。`max_tokens` 是每次请求的输出预算，而
「模型单次输出上限」（settings 里的 `max_output_tokens`）是模型能力事实 —— 两者不是同一个字段。

现状的问题：

- `/models` 元数据能直接给上限时最好（#5 已实现）。但瘦网关（如 ipsa-thor）只回
  `id/object/created/owned_by`，上限永远「未探测到」，撞墙写回只能提示用户手写（#6）。
- v0.4.75 起能从**可解析**的 400/422 文案里学到精确上限，但只在内存里夹紧本次请求
  （`learnedMaxTokens`），**不落盘**，下次启动又从零开始。
- 文案完全不透明时（#21）只能经验性降到 8192，那是保底而不是事实。

目标：把「模型单次输出上限」变成**可发现、可落盘、可复核**的事实。分两条互不依赖的路径：

- **A 免费证据入账**：请求本来就撞出来的报错里能解析出的上限，直接入账，零额外请求。
- **B 受控主动探测**：网关什么都不说时，用尽量少的请求去试边界，默认关闭、显式开启。

## 2 需求

### 2.1 A：免费证据入账（默认开，零额外请求）

当 `parseMaxTokensLimit` 从 400/422 文案解析出精确上限 N（既有逻辑，v0.4.75）：

- 本次请求仍按既有方式夹紧重发（行为不变）；
- **新增**：经注册的监听器把 N 入账 ——
  - 该 provider 的 `max_output_tokens` 为空时写进 settings.json（复用 `writeBackCapabilities` 的铁律：
    只填空字段、手写值（含 `false`）绝不覆盖、不动 `max_tokens`）；
  - env 事实记 `maxOutputTokens = N`、`source: "error_evidence"`、`evidence` 里保留文案片段。

### 2.2 B：受控主动探测（默认关，opt-in）

provider 级配置，两种写法等价：

```json
"probe_max_output_tokens": true
```

```json
"probe_max_output_tokens": { "enabled": true, "max_attempts": 3, "start": 8192, "cap": 131072 }
```

字段缺省：`enabled=false`、`max_attempts=3`、`start=8192`、`cap=131072`。
`max_attempts` 夹到 1–8；`start` 夹到 ≥256；`cap < start` 时以 `start` 为准。
配置写成非法形状时**忽略**（回落到默认关闭），不抛错 —— 一个拼错的开关不该让 CLI 起不来。

**触发条件（全部满足才跑）**：

1. 交互 TTY（`-p` / 脚本模式不探测，避免后台悄悄花配额）；
2. 该 provider `probe_max_output_tokens` 开启；
3. 该 provider 的 `max_output_tokens` 仍为空（手写优先）；
4. `/models` 结果没有给出上限（首轮能力探测已经跑完且仍缺）；
5. env 事实里没有 7 天内的探测结论（防每次启动都重试）。

**阶梯**：从 `start` 起每次翻倍，最多 `max_attempts` 个候选，且不超过 `cap`。
例：`start=8192, cap=131072, max_attempts=3` → `8192, 16384, 32768`。

**单次探测请求**：非流式、单端点、不带工具、`messages=[{role:"user",content:"ok"}]`、
`temperature=0`、`max_tokens=候选值`；**不重试、不降级、不夹紧、不写 `learnedMaxTokens`**。

**判定规则**（只认事实，不猜）：

| 结果 | 判定 | 写配置 | env 结论 |
|---|---|---|---|
| 请求成功 | 网关接受该预算（下界） | ❌ | 继续下一档 |
| 400/422 且解析出精确上限 N（N < 候选） | `found` | ✅ 只填空字段 | `found` + `atLeast` |
| 400/422 有 max tokens 语义但无数 | `inconclusive(opaque)` | ❌ | `inconclusive` |
| 阶梯顶全部成功 | `lower_bound` | ❌ | `lower_bound` + `atLeast` |
| 上下文超长 / 鉴权 / 5xx / 网络 | `inconclusive(原因)` | ❌ | `inconclusive` |

铁律（与 #6/#21 一致）：

- `finish_reason === "length"`、单次 `usage.completion_tokens`、请求预算 `max_tokens` **一律不得**当作能力上限；
- 不透明 400 是单次观察，**不固化成事实**（#21 已定：只降不记）；
- 只写空字段；写盘失败吞掉（能力补全是增强项，不得影响会话）。

**成本上限**：最多 `max_attempts` 次请求（默认 3），每次 prompt ≈ 10 tokens、completion ≈ 1–2 tokens；
受 provider 既有超时约束；探测失败不重试。阶梯 `cap` 默认 131072，避免「为探 512k 多花好几轮」。

### 2.3 C 可观测

- 写回时走既有 `formatWritebackNotice`（TUI 只留「改了什么」，与 #18 口径一致）；诊断只进 boot 日志。
- env 事实新增 `outputProbe: { at, outcome, atLeast?, reason? }` 作为 7 天 memo，`/env` 可见。
- `/context`、`/env` 的既有展示不变；`maxOutputTokens` 的语义仍是「模型能给多少」，不是预算。

## 3 验收清单

1. 默认配置（`probe_max_output_tokens` 不写）下**零请求、零写盘**，与今天行为完全一致。
2. 可解析 400 → `max_output_tokens` 精确写回且只写空字段；已手写（含 `false`/已有值）不覆盖。
3. 不透明 400 / 上下文超长 / 鉴权 / 5xx → 不写配置，只记 `inconclusive`。
4. 阶梯顶全部成功 → 不写配置，只记 `lower_bound`。
5. 7 天内不重复探测；`-p` 不探测；`max_attempts` 严格生效。
6. 免费证据入账：请求中解析到上限 → 空字段写回（无需开关）；`max_tokens` 永不被改。
7. `bun x tsc --noEmit` 零错误、`bun test` 全绿、`bash scripts/verify.sh` 为 `ALL GREEN`。

## 4 非目标

- **不自动抬高**用户配置的 `max_tokens`：探测只写「能力上限」，不写「请求预算」。
- 不做上下文窗口探测（已有 `/models` + 溢出校正两条路径）。
- 不推动网关补 `/models` 字段（issue #8 第 2 项，属网关侧协调，非本仓代码）。
- 不做沙箱（项目立场：worktree 是文件隔离，不是安全边界）。
