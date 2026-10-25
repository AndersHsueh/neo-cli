# TUI状态栏-输入框-v0.3.0

> 最后更新:2026-10-25

## 摘要

v0.3.0 把 neo 的底部从「readline 单行提示符」换成一块**可重画的 live 帧**：常驻状态条（model / tier / 权限模式 / git 分支 / ctx 百分比 + 进度条 / 本轮已跑时长 / 累计 tok）+ Claude Code 式自绘输入框（上下横线、无左右边框、多行、历史、补全、粘贴 chip、审批、选择菜单、双 Ctrl+C）。渲染模型没换：仍是 inline + append-only，历史只追加、`Cmd+F`/tmux copy mode 可用，不引入 alt-screen。M0 探针（`scripts/tui-probe.ts`）先证明 bun 1.3.13 真 PTY 下 raw mode / 按键形态 / 帧擦除重画 / 异步交错 / 终端恢复全部可行，再动手。交付时 `bun test` 660→812（43 文件）、PTY 10→17 场景、verify.sh ALL GREEN；红态用 v0.2.4 树跑新场景 0/7。

## 为什么是 live 帧，而不是「每 10s 打一行进度」

- v0.2.3/v0.2.4 已经把「输出不丢、输入能补」补齐，剩下的硬伤是「长 turn 无反馈」和「输入区不像 2026 年的产品」。
- 调研（qwen-code v0.15.6 / Claude Code classic）确认：它们同样**不用 alt-screen**，历史进 scrollback，只有底部 live 区参与重绘。
- 关键设计是 qwen 的**上下横线、左右不画边框**：左右边框会让「行宽恰好等于终端宽」时自动折行错位，宽度守恒问题消失。
- 关键风险是「帧与异步输出抢行」：M0 P2/P3 先验证了「上移 N 行 + `\x1b[0J` + 整帧重写」在输入/提交/多行/滚动/交错下都稳定。

## 结构（7 个新模块）

| 模块 | 职责 |
|---|---|
| `src/tui/ansi.ts` | 显示列折行/截断/剥 ANSI（SGR 安全） |
| `src/tui/buffer.ts` | 码点文本缓冲、按显示列折行与光标映射、历史导航 |
| `src/tui/keys.ts` | raw keypress → 语义动作（Ctrl+J 看 `sequence`、UTF-8 看 `ch`）；PasteMachine |
| `src/tui/status.ts` | 状态行字段拼装 + priority 宽度降级 + ctx 进度条 |
| `src/tui/frame.ts` | live 帧：擦除/提交行/整帧重画/光标定位；DEC 2026 原子帧（tmux/SSH 关） |
| `src/tui/dock.ts` | 把 Console 的写语义翻译成「行缓冲 / 活动行 / 提交行」 |
| `src/tui/composer.ts` | 输入区编排：编辑/多行/历史/Tab/粘贴/审批/选择/双 Ctrl+C |

接线：`src/ui/console.ts` 新增 `dock` 分支；`src/ui/select.ts` 新增 `present` 注入；
`src/index.ts` **TTY 走 composer、非 TTY 原样保留 v0.2.4 readline 路径**。

## M0 探针结论（bun 1.3.13，真 PTY）

| # | 结论 |
|---|---|
| P1 | raw mode + `emitKeypressEvents` 可用；Ctrl+O=`{name:"o",ctrl:true}`；**Ctrl+J 的 `sequence="\n"`、Enter 是 `"\r"`**；UTF-8 汉字是单个 keypress 且 `name=undefined`（按 name 过滤会漏中文）；bracketed paste 有 `paste-start/end` |
| P2 | live 帧「上移 + `\x1b[0J` + 整帧重写」稳定：输入/提交/多行/帧高变化/连提 30 行/光标坐标全对 |
| P3 | 异步提交 12 行期间持续输入，内容不丢、状态行不丢 |
| P4 | 退出后 `stty -a` 显示 `icanon` 恢复，退出码 0 |
| 未测出 | 真实 IME 候选窗位置（PTY 无法模拟）；tmux/SSH/Windows ConPTY；启动瞬间按键捕获 |

证据：`docs/evidence/v0.3-tui-probe.txt`；原始脚本 `scripts/tui-probe.ts`。

## 踩过的坑（已固化进代码/测试）

1. **提交行后必须把「帧内光标行号」归零**：否则下一次擦除会把刚写进 scrollback 的行擦掉（M0 第一次实现就踩到，P2 场景固化）。
2. **resize 只 invalidate 不擦旧帧会留残影**：S15 一开始偶发「旧 100 列顶线留在历史里」；`onResize` 改成先 `frame.erase()`（按旧坐标尽力擦）再 invalidate 重画后才稳定。
3. **状态行时长不能用 `draining` 判断**：斜杠命令/选择菜单期间 drain 也是 true，会显示 `now - 0` 的天文数字；新增 `turnActive` 只在 agent turn 期间为真。
4. **paste-end 丢包必须 idle 兜底**：否则之后所有按键被静默吞掉；qwen 用注释标出的坑，我们用 1s idle 收尾 + 单测锁定。
5. **用户消息要在提交时写进 scrollback**：输入框清空后若只清 buffer，历史和屏幕上都会「查无此消息」；`commitUserInput` 负责首行 `❯ `、续行两空格。
6. **审批态不能卸载输入框**（qwen 的 residual 类问题）：问题显示在框上方、顶线变「确认」，输入框继续可见。
7. **PTY 断言不能抓「流式字节的中间态」**：一次帧写入可能被 PTY 分块，断言前要等「顶线 + 状态行都在」的稳定帧（S15 偶发失败的原因）。
8. **`process.stdout.columns` 在 SIGWINCH 后会更新**（Bun 1.3.13），但后台 `stty` 必须 `< /dev/tty`，否则报 `stdin isn't a terminal`（wrapper 里没有 tty 时）。

## 验证

- tsc 零错误；`bun test` **812 pass / 0 fail（43 文件）**；`scripts/verify.sh` ALL GREEN，PTY **17/17**。
- 新 PTY：S11 状态条/忙碌/排队/分支、S12 输入框/中文/emoji/退格整字、S13 多行滚动、S14 审批、S15 resize、S16 选择菜单、S17 双 Ctrl+C。
- 红态：`git archive HEAD`(v0.2.4) + `NEO_ENTRY` 跑 S11~S17 = 0 passed / 7 failed
  （`docs/evidence/v0.3.0-pty-red.txt`）。
- 旧 S1~S10 断言语义保留（适配新 UI，不锁旧像素）。

## 明确不做（本版）

`Ctrl+O` transcript 视图（v0.3.1）、轮次 diff（v0.3.2）、alt-screen、鼠标捕获、
四边框输入框、Vim 模式/选区/撤销栈、输入区语法高亮、shell+JSON 自定义状态条。

## 关联主题

- [[TUI进化路线-2026Q4]] —— 本页是路线第二段（常驻状态）的交付记录
- [[TUI补漏-v0.2.3]] —— live 帧的前置：动画行所有权 / 宽度数学 / PTY 三件套
- [[输入层-v0.2.4]] —— 输入框复用的 `@`/`/` 补全与多行语义
- [[neo-开发踩坑]] —— 2026-10-25 v0.3.0 条（帧/resize/状态/粘贴/审批/PTY 中间态）
