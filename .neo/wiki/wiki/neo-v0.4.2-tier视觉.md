# neo v0.4.2 —— tier 视觉语义 + 切档即时反馈

> 最后更新: 2026-10-27

## 摘要

v0.4.2（2026-10-27，commit `a978cde` + 简写后续）解决两个「用户感受不到档位」的问题：分类切档的提示不再等整个 turn（含多轮工具调用与总结）结束才显示，而是在**首次 LLM 请求前**立即出现；三档模型在工作时用不同颜色/图标区分——深思亮红、平衡绿、快速亮蓝，默认档中性冰绿。

## 问题

2026-10-27 实测：`classifyTurn()` 其实在 `send()` 开头、首次请求前就 `applyTier` 切到了 fast，但 `tierSwitch` 只放进 `TurnStats`，由 `index` 在 `await agent.send()` 返回后才打印。所以视觉上像「总结完才切」，实际是提示晚了一整轮。同时状态条、spinner、工具行 `⚡`、回答 `●` 全是绿色，无法直观看出当前档位。

## 档位简写（后续补丁）

内部/配置仍用规范名 `deep_reasoning`；用户输入统一归一，不破坏旧 settings/session：

- `/tier deep`、`/tier d`、`/tier DEEP`、`/tier bal`、`/tier b`、`/tier f`、`/tier auto` 都可切；
- `/tier` 菜单/查询用短名展示，必要时括号带规范名 `deep (deep_reasoning)`；
- `--tier deep` 与 `task` 工具的 `tier=deep` 同样可用；
- 内部 `ModelTier` / `model_routes` / `*_model_name` 保持规范名。

## 行为契约

### 切档事件

- `AgentEvent` 新增 `tier_switch`；`classifyTurn()` 在 `applyTier` 成功后立即发出（早于首次 `stream`）。
- 交互 TUI 立即打印：
  `⇅ 档位 default → fast（provider/model）` + 理由 + 降级说明（如有），并触发 composer 重绘。
- 轮末不再重复打印；`-p --output-format json` 的最终 payload 仍保留 `tier_switch` 字段。

### tier 色板

| 档位 | 颜色 | 色值 |
|---|---|---|
| `deep_reasoning` | 亮红 | `#FF3B30` |
| `balanced` | 磷光绿 | `#00FF41` |
| `fast` | 亮蓝 | `#00C8FF` |
| `default` | 冰绿（中性） | `#B4FFBE` |

应用位置：

- 状态条 `tier` 字段：独立 `tier` role，painter 按档位着色；
- 工作 spinner：`⚡ + 动画字符 + 文本`，`⚡` 与字符按当前 tier；
- 紧凑工具行：`⚡` 与运行中 `.`/`..`/`...` 按 tier；工具名保持原亮色；
- 回答流式前缀 `●` 按 tier；详情模式工具标题 `⚡` 同步；
- `ConsoleDeps.getTier` 由组合根注入 `() => cfg.modelTier`，`/tier` 与分类切档即时生效；
- 未知档回退平衡绿；`NO_COLOR`/非 TTY 无颜色但保留 `⚡` 与 tier 文本。

## 测试与证据

- `tests/tier-visual.test.ts`：色板映射、状态条 role、回答 `●`、工具行 `⚡`、spinner `⚡`（FORCE_COLOR）。
- `tests/context-recovery.test.ts`：`tier_switch` 事件先于首次 stream，且第一次请求 `cfg.model` 已是 fast。
- 全量 **1039 pass / 0 fail / 67 文件**；PTY **20/20**；`verify.sh` ALL GREEN。
- 证据：`docs/evidence/v0.4.2-{tsc,tests,pty}.txt`；发布说明 `docs/release-notes/v0.4.2.md`。

## 已知边界

- PTY 屏幕解析器剥离 ANSI，颜色断言放在纯函数/Console 单测，不靠 PTY 截图。
- 深思红与错误红接近（`#FF3B30` vs `#FF5555`），靠 `⚡`/`✖` 形状区分；若观感混淆可改橙红。
- 真彩色终端效果最佳，256 色终端可能降级。

## 关联

- [[neo-v0.4.1-实战可靠性]] —— 上一版；分类器/模型档位沿用其窗口刷新逻辑。
- [[工具调用紧凑显示-v0.2.2]] —— 工具行 `⚡ name args` 的原始设计。
- [[TUI状态栏-输入框-v0.3.0]] —— 状态条/tier 字段的来源。
- [[会话代号与标题动画-v0.3.1]] —— `Agent:` 标题与 Matrix 视觉体系。
