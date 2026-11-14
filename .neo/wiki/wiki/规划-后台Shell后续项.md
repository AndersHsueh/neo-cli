# 规划-后台Shell后续项

## 摘要

v0.4.81 后台 Shell 三项后续的现状、难度与排序

> 最后更新:2026-11-10
> 来源:session 20261110-095402-g4op80 · 2026-11-10 · 自动归纳

## 正文

v0.4.81（HEAD c1db9ee）已有后台进程基础：`src/tools/backgroundShell.ts:66-271` 的 `BackgroundShells` 支持 `adopt/start/wait/kill/killAll`；`src/tools/index.ts:679-722` 的 shell 前台、后台调用统一走该管理器；`src/cli/commands.ts:1062-1077` 提供 `/ps`。`docs/background-shell-prd[done].md:32-38` 的非目标与代码现状一致，因此 Ctrl+B 撤到后台、attach/切终端、跨会话后台进程不是 #28 实现漏项，而是被明确划出范围的后续能力。

建议排序：① Ctrl+B 撤到后台列入第 1 批，但先做 `!cmd` 那半条；② attach/切终端列入第 3 批并与 supervisor 合并；③ 跨会话后台进程列入第 3 批或直接并入 supervisor。三者分别涉及终端所有权模型、PTY/组件重构、进程生命周期，不宜合并成一个遗留缺陷处理，建议各自补 PRD。

关键约束：Ctrl+B 键位当前未被占用，但前台 shell 运行时 composer 处于 `suspend()`，按键直通子进程，父进程无法接收；实现 Ctrl+B 必须调整终端所有权模型，不能只加按键分支。attach 的完整形态需要 PTY：当前 `Bun.spawn` 使用 `stdout:"pipe"`，仓库内未发现 PTY 依赖；纯文本 attach 会丢失 dev server 的进度条和颜色，且现有 `Composer.suspend/resume` 只有全挂起粒度，还需处理动画行唯一持有者约束。跨会话后台进程与 v0.3 supervisor 的 `supervisor / 后台会话 / --bg / attach / agent view` 范围重复，单独实现可能返工。

待落地前核实：`package.json` 是否已有 PTY 依赖（本次未读），以及 `Bun.spawn` 在 `stdin:"pipe"` 下写 stdin 的实际行为（本次未实测）；“必须引入 PTY”应先做短探针确认。
