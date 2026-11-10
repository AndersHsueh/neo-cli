# `-p` 无人值守长跑（issue #51，来源 #24 非目标）

> 状态：施工中
> 口径：维护者 2026-11-10 同意做；但要求先厘清与已有上限的关系（见 §0）。

## 0 与已有上限的关系（先裁决，避免两套「轮次上限」打架）

现有两条上限是**不同轴**，`-p --drive` 会同时受它们约束，因此**不再新增「max turns/次数」参数**：

| 上限 | 位置 | 默认 | 管什么 |
|---|---|---|---|
| `max_tool_iterations` | `src/config.ts` / `src/agent/loop.ts` | **80** | **单轮内**模型连续调工具的迭代上限（防一轮里无限调） |
| `/drive --max N`（即本 PRD 的 `--max N`） | `src/drive.ts` | 5（夹紧 1–20） | **驱动轮次**上限（每轮 = 一次用户提示 + 模型若干工具迭代） |
| `--max-minutes M`（**本 PRD 新增**） | 本 PRD | 30（夹紧 1–240） | **墙钟时间**上限（无人值守最需要防「卡住/跑飞」，不是迭代数或轮次数能表达的） |

结论：不增加 `--max-turns`；无人值守 = `--max`（轮次）× `max_tool_iterations`（每轮工具迭代）× `--max-minutes`（墙钟）三层约束。

## 1 命令面

```bash
neo -p "<提示>" --drive "<检查命令>" [--judge "<完成标准>"] [--max N] [--max-minutes M] -y
neo -p "<提示>" --drive --judge "<完成标准>" [--max N] [--max-minutes M] -y   # 没有检查命令
```

- `--drive <检查命令>`：复用 `/drive` 的完成条件语义（exit 0 = **已验证**）。
- `--judge <标准>`：复用 #50 的模型判断（**模型判断**来源，绝不标已验证）。
- `--max N`：驱动轮次上限，默认 5，夹紧 1–20（与 `/drive --max` 完全同口径）。
- `--max-minutes M`：墙钟上限，默认 30，夹紧 1–240。
- **必须显式 `-y`（自动批准）**：无人值守没有人类点确认，缺 `-y` 直接用法错误（exit 2），提示「-p --drive 无人值守需要 -y」。
- 不带 `--drive` 的普通 `-p` 行为完全不变。

## 2 行为

1. 先 `agent.send(提示)` 跑一轮；轮末复用 `DriveManager.onTurnEnd`：
   - 有检查命令 → 跑命令；exit 0 → **已验证**，停，exit 0；
   - 未过（或没有检查命令）且有 `--judge` → 模型判断；达成 → **模型判断**，停，exit 0；
   - 未达成 → `continue`：再 `agent.send` 同一提示（与 `/drive` 的自动续跑语义一致）。
2. 停止条件：达成 / 轮次到 `--max`（`exhausted`）/ 连续空转（`idle-stop`）/ 墙钟到 `--max-minutes`（`timeout`）/ SIGINT。
   其中 `idle-stop` 在 `-p` 下同样生效（无人可问，直接停、exit 1）——不允许「模型原地打转还继续烧轮次」。
3. **退出码**（CI 可消费）：
   | 情况 | 退出码 |
   |---|---|
   | 达成（verified 或 模型判断） | 0 |
   | 未达成（exhausted / idle-stop / timeout） | 1 |
   | SIGINT / 用户中断 | 130 |
   | 用法错误（缺 `-y`、参数非法、`--judge` 与 `--drive` 都缺等） | 2 |
4. **输出**：stdout 保持现有 `-p` 一次性输出风格（不引 stream-json，属 #37）；结束时向 **stderr** 打一行结构化摘要：
   `[drive] status=done source=verified rounds=2 elapsed=184s`
5. **超时边界**：墙钟只在轮间检查；单轮本身可能超过 `--max-minutes`（受 80 次工具迭代与单轮 token 预算约束）。到点时若正处一轮中，等该轮结束再停（不做硬杀，PRD 写明）。
6. **资源清理**：无论正常/异常/中断退出，都走 `cleanupEphemeralResources()`（#40 已抽），不留后台 shell / LSP / MCP 孤儿。

## 3 实现要点

- 复用 `DriveManager` 纯逻辑（`runCheck` / `evaluate` / `enqueue` 依赖注入）。`-p` 分支不排交互队列，改为本地 `while` 循环消费 `onTurnEnd` 返回的 action。
- judge 的提示词/解析必须与交互路径**同一份实现**：把当前 `src/index.ts` 里的 evaluate 闭包抽成可复用工厂（如 `src/driveJudge.ts`），交互与 `-p` 共用，禁止复制第二份提示词。
- 参数解析加：`--drive <cmd>`、`--judge <标准>`、`--max N`、`--max-minutes M`；与 `/drive` 的用法错误文案保持同一套口径。
- 测试：
  - 单测：参数解析（组合/缺省/非法/缺 -y）、退出码映射、max-minutes 停止、done 后清理被调用；
  - 集成（fake-llm + 真 CLI，参考 `tests/oneshot-slash.test.ts` 的 spawn 写法）：两轮场景（第 1 轮检查失败 → 第 2 轮通过）→ exit 0；轮次耗尽 → exit 1；缺 `-y` → exit 2；
  - 不需要 PTY（非交互路径）。
- 文档：本 PRD；`src/cli/help.ts` + README 命令行段补用法；release note 发版时写。

## 4 非目标

- 不做 stream-json 事件流（#37 另开）、不做后台化/daemon、不做 `-p` 下的斜杠命令（#41 已拦）；
- 不做新的审批策略：无人值守就是 `-y` 全自动，不提供「部分自动」中间态；
- 不做 supervisor / 跨会话接管（#28 已全部暂停）。

## 5 风险

- `-y` 全自动在 CI 上可能执行危险命令：这是用户显式选择。启动时向 stderr 打一行警告 `无人值守：-y 会自动批准所有操作`。
- 单轮可能超过墙钟上限（见 §2.5）；如果需要硬杀，另开需求。
- 无人值守 + 模型判断（`--judge`）叠加时，来源标注仍在 stderr 摘要里区分 `source=verified|model`，不得混写。
