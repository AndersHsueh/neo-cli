# TUI补漏-v0.2.3

> 最后更新:2026-10-25

## 摘要

v0.2.3 是一次**不换渲染模型**的界面补漏：修掉 5 个每天都在丢信息/吃输入的缺陷 —— ① 流式状态泄漏导致 `●` 正文前缀整个会话只出现一次；② 宽度数学错误（CJK 截断按 code unit、回落 100 而非 80、无 resize 处理）；③ 紧凑模式工具输出不可回看（新增 `/last` + 内存缓存 + 失败详情）；④ `--resume` 后屏幕空白（新增最近 3 轮回放）；⑤ Ctrl+C 提示用 `promptEcho("")` 收尾会吃掉用户没敲完的输入。同时把 TTY-only 行为的验证固化为**仓库内可复用脚本**（`scripts/fake-llm.ts` / `pty-e2e.ts` / `verify.sh`），不再靠手工敲一遍当证据。

## 关键决策与修正

- **不引入全屏 alt-screen**：2026 年 Claude Code classic / Codex 默认都是 inline + 终端 scrollback；全屏（OpenCode/Crush）丢 `Cmd+F`、tmux copy mode 与会话内搜索。neo 保持 append-only。
- **推翻了调研清单的第一条**：「工具批次之间的正文不上屏」经 PTY 实测**不成立**（`onContent → StreamFormatter.write` 实时上屏）。真正的 bug 是同一条链路上的**流式状态泄漏**：`agent.ts` 正常路径从不调 `endStream`，`streaming` 置 true 后再无复位，后续 `beginStream` 早退 —— `●` 前缀只在第一段出现。这条修正写进了 PRD §1，避免以后重复误判。
- **失败要占行**：成功仍是 1 行（v0.2.2 的「清爽」不回归），失败改成 1 行 + ≤3 行 stderr + `/last` 提示；失败罕见且信息量最大。
- **动画行只能有一个持有者**：`yieldAnimationLines()` 统一收尾 spinner/工具行/闪烁提示，避免 350ms 计时器把 readline 重绘的提示符擦掉（simplify 审查的 critical）。

## 实现落点

| 文件 | 内容 |
|---|---|
| `src/ui/console.ts` | 构造注入 `{stdoutIsTTY,stdinIsTTY,columns,write}`；`streamKind` 记录流式块；工具历史缓存；`/last` 失败详情；`handleResize`；`flashNotice` 交回 readline |
| `src/ui/toolLog.ts` | 失败摘要（stderr + `[exit N]`）、`sanitizeOutput`、`formatOutputLines`、`formatToolCall`、缓存上限 |
| `src/ui/transcript.ts` | 会话回放纯函数（轮次切取 + 单块 clamp + 行数上限） |
| `src/ui/toolLine.ts` | `oneLine` / `paintTail` / `toolLineText` 收敛单行拼装；失败摘要半宽上限 |
| `src/ui/theme.ts` | `charWidth` + 按显示列截断的 `truncate`（ANSI 安全） |
| `src/ui/stream.ts` | `StreamFormatter` 支持注入 `write`（正文也走 Console 通道） |
| `src/tools/shellMarks.ts` | shell 输出标记的唯一定义（生产/消费共享，防静默漂移） |
| `src/agent.ts` | 正文/推理收尾时复位流式状态；异常路径只关「当前块」 |
| `src/index.ts` | `/last [n]`、`--resume` 回放、SIGWINCH、提示符重绘注入、HELP 补 ESC/`/last` |

## 验证

- `bunx tsc --noEmit` 零错误（`scripts/**/*.ts` 已纳入 include）。
- `bun test` **580 pass / 0 fail（32 文件）**，v0.2.2 基线 530 → +50（新增 5 个测试文件 + `tests/helpers.ts`）。
- `bash scripts/verify.sh` **ALL GREEN**：tsc → tests → pty（4/4 场景）。
- 红态留证：用 `git archive HEAD` 临时树跑同一套 PTY 断言，S1/S2/S4 全红、S3 本就通过 —— `docs/evidence/v0.2.3-pty-red.txt`。

## 踩坑（已固化进脚本）

1. **PTY E2E 必须 `--auto off`**：规则分类器切档会经 `applyTier` 把 `baseUrl` 重置回 settings.json 的真实 provider，悄悄绕过 fake-llm 打真实网络。
2. **macOS `script(1)` 不接受 Bun 的 `stdin:"pipe"`**（socketpair → `tcgetattr: Operation not supported on socket`），须 `mkfifo` + `cat fifo | script`。
3. **`COLUMNS` 环境变量不改变 Bun 的 `process.stdout.columns`**，窄终端要在 PTY wrapper 里 `stty cols 60 rows 40`。
4. `bun test` 里测动画存活要真等 timer（350ms/90ms），不能 mock 时钟 —— 新增用例让全量从 3.6s 涨到 ~4.8s，属可接受成本。

## 已知边界（留给后续）

- 已输出的历史行无法重排（append-only 的本质），resize 只保证「不再吃掉当前输入行」。
- `--resume` 回放不重放工具输出（`toolHistory` 是内存态），提示里已明确说明。
- 全屏/底部常驻状态栏/轮次 diff/`@` 补全/多行输入均未做：见 [[TUI进化路线-2026Q4]]。

## 关联主题

- [[工具调用紧凑显示-v0.2.2]] —— 本次补的是它「信息一旦滚过就丢」的副作用
- [[neo-开发踩坑]] —— PTY 验证三条坑已并入
- [[neo-版本时间线]] —— v0.2.3 在版本链上的位置
- [[TUI进化路线-2026Q4]] —— 后续三段路线（v0.2.4 输入层 / v0.3 状态栏 / supervisor）
