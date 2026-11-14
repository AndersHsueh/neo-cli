# Notification hook（issue #56）

> 状态：已实现，待发版。基线 commit 见合入后的 main。
> 关联：issue #56；前置 issue #3（生命周期 hooks）。

## 要做什么

在「主代理正在等你点确认」和「这一轮跑完了」两个时刻，让用户自己配的脚本跑一次，
用来发系统通知（`osascript` / `notify-send` / 终端 OSC 都行）。

做完之后能干什么：切到别的窗口跑长任务时，不用一直盯着终端 —— 需要你拍板了、或者跑完了，
通知会自己来。

## 为什么需要它

neo 的 hooks（#3）只有 `PreToolUse` / `PostToolUse` / `TurnEnd`：

- 审批发生在 `PreToolUse` **之前**，所以现有事件**无法**在「正在等你点确认」时通知人；
- `TurnEnd` 每轮都火，不区分「等审批」与「普通跑完」，直接当通知信号会天天误报。

竞品对照：Claude Code 提供 `Notification` hook（`permission_prompt` 等 matcher），
Cursor CLI 内置桌面通知。neo 先补 hook 事件，内置 OS 通知列为非目标。

## 功能契约

### 事件

新增第四个事件 `Notification`（`src/hooks/types.ts` 的 `HOOK_EVENTS` / `HookEvent` /
`HookPayload`）。两个触发原因：

| `reason` | 时机 | 额外字段 |
| --- | --- | --- |
| `permission_prompt` | 主代理**即将弹出审批确认框之前**（`ui.confirm` 之前） | `tool_name`、`tool_input` |
| `turn_end` | 一轮结束（只在主代理回合结束触发，与 TurnEnd 同口径） | — |

**顺序是硬约束**：`PreToolUse` 在审批**通过之后**才触发，所以通知不能挂在 hook 链上，
必须挂在 `approve` 分支、`ui.confirm` **之前**（`src/agent/loop.ts` 的 `makeCtx`）。
否则用户已经在点确认了通知才来，没有意义。

`turn_end` 与 `TurnEnd` 事件**并存且独立**：TurnEnd 面向模型/统计（可 `onFailure: "block"`），
Notification 面向「人」（恒不阻断）。两者都配时同一时刻各跑各的；通知先发，
不让 TurnEnd hook 的失败拖住它。

### matcher 语义

现有 `matchTool(matcher, tool)` 匹配工具名。Notification 的 matcher 匹配**触发原因**，
缺省 = 全部原因。为此**新写** `matchReason(matcher, reason)`，不复用 `matchTool`：

- 两者**匹配对象不同**（工具名 vs 触发原因），共用一个名字会让 `/hooks` 的 matcher 一栏、
  诊断文案、以及后来读代码的人都分不清「这条 Notification 到底在过滤什么」；
- 语法刻意保持一致（精确 / 末尾通配 / 正则 / 缺省=全部），所以底层共用私有 `matchPattern`，
  语义各自命名。

### 载荷与环境变量

stdin JSON 沿用现有 `HookPayload` 风格，至少含 `event` / `session_id` / `cwd` / `reason` / `mode`。
环境变量沿用 `NEO_HOOK_EVENT` 那一套，另加 `NEO_HOOK_REASON`（仅 Notification）。

`tool_input` 是**审批框上那句人话描述**（如 `write_file — /path/x.ts`），不是原始参数 JSON：
通知文案要的是「在等你批什么」，原始 JSON 又长又可能带密钥。

### 退出码与失败隔离

Notification **不阻断**任何东西（没有模型要喂回原因）：

- `0` = 成功；
- 非 0 / 超时 / 命令不存在 = 按现有 `onFailure` 语义给可读诊断（默认 continue），
  但**永远不会**把 `blocked` 置真 —— 退出码 `2` 与 `onFailure: "block"` 在这里都不生效；
- 超时/崩溃照样隔离（进程组 SIGKILL），绝不拖垮主循环。

### 非目标

- **不做内置 OS / 终端通知**。issue 明确「先补 Notification hook 事件，再选做内置通知」。
  用户自己接 `osascript` / `notify-send`。
- 不新增其它事件（不把 hook 扩充成一大堆新事件）。

## 验收（每条对应测试）

测试文件：`tests/hooks-notification.test.ts`（22 条，N1–N8）。

1. settings.json 可配 Notification，事件 JSON 走 stdin，与现有事件口径一致 —— N1a/N1b/N1c、N8a。
2. 等审批时触发 `permission_prompt`；轮次结束触发 `turn_end` —— N3a/N3b、N4a。
3. matcher 按原因过滤：只配 `turn_end` 时，`permission_prompt` 不触发 —— N5a/N5b、N2a。
4. 失败隔离：命令不存在 / 非 0 退出 / 超时都不影响主会话继续跑，且有可读诊断 —— N6a–N6e。
5. 未配置时行为与现在完全一致（零额外开销、零行为变化）—— N7a/N7b。
6. `/hooks` 能列出 Notification，matcher 一栏显示原因 —— N8b。

## 实现要点

| 文件 | 改动 |
| --- | --- |
| `src/hooks/types.ts` | `Notification` 事件、`NotificationReason`、`NotificationPayload`、`matchReason` |
| `src/hooks/runner.ts` | `hookMatches`/`hooksFor`/`dispatchHooks` 增加 `reason`；Notification 恒不阻断；`NEO_HOOK_REASON` |
| `src/agent/loop.ts` | `approve` 在 `ui.confirm` 前发 `permission_prompt`；`emitTurnEndHooks` 先发 `turn_end` |
| `src/cli/commands.ts` | `/hooks` 的 total 改用 `HOOK_EVENTS.reduce`；Notification 显示 `reason=` |

## 已知取舍

- **plan 模式下 Notification 也跳过**（沿用 `runHooks` 的 plan 早退）。plan 是只读承诺，
  hook 是用户脚本；且 plan 下工具被直接拒绝、根本不会弹审批框，`permission_prompt` 天然不触发。
- **`turn_end` 通知先于 TurnEnd 发**：通知是给人看的，不该被 TurnEnd hook 的失败拖住。
