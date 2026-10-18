# 选择器组件 select

> 最后更新:2026-10-18

## 摘要

v0.1.5 之后规划的输入层组件:行内选择器 `select<T>`(↑↓ 移动/回车确认/esc 取消),用于替换 `/resume` 的数字问答并补齐 `/model` 只列不选的缺口。核心立场:有界行内重绘不违反 append-only;纯状态机提供文本 oracle,neo 可自测自维护。PRD 在 `docs/select-component-prd.md`。

## 决策与依据

- 起源:2026-10-20 macOS 终端崩溃,resume 零丢失验证了每轮 writeFileSync 落盘设计(session.ts),同时暴露 `/resume` 四步操作的摩擦点。
- 设计原则:从最不爽的地方改起;任何 UI 改动先问「文本 oracle 是什么」——全屏 TUI 因此被否,选择器因状态机可测而被放行。
- 关键坑:数字/字母键会被 readline 行缓冲消费,选择结束污染提示符 → v1 只绑非打印键,数字直选延后,清理手段由探针 P1 在 bun 下实证。
- 组件唯一性:console.ts 的 choose() 迁移后删除或委托,不得两套并存。

## 状态

PRD 已完成(2026-10-20),待 neo 按 M0 探针 → M1 组件+/resume → M2 /model+守卫 实施。

## 关联主题

- [[热键系统-v0.1.2+]] —— HotkeyRouter 已就绪 up/down/enter/escape,本组件零改动消费
- [[neo-开发踩坑]] —— readline 行缓冲污染是新增条目候选

## 来源

- docs/select-component-prd.md
- 2026-10-20 会话:终端崩溃事故 + /resume 体验讨论

## 推理与依据

## 2026-10-18 M2 完成：/model 可选、C9 SIGINT 协调、choose() 删除——feature 代码面收尾

- D8 `/model` 无参分支：TTY 且列表非空 → select 可选（当前模型 hint「当前」+ initial 定位），选中与显式 `/model <id>` 同一收尾（cfg.model + noteModelChange）；listModels 失败维持错误输出；非 TTY/空列表维持纯列表（C8）。
- C9：onActiveChange(active, cancel?) 携带取消函数，index.ts 的 onSigint 顶部路由——select 期间 Ctrl+C = 取消选择，不武装双击退出。测试覆盖 cancel resolve null + 引用清理。
- C14：console.ts 的 choose() 删除（grep 确认 src 零调用方、tests 零引用），组件唯一性达成，两套并存未发生。
- C13 resize 重画 M1 已提前做；C10 ESC 守卫静态成立 + hotkeys 修复后动态生效。
- 全量测试 364 pass / 1 skip / 2 fail（K6/K9 为 gitignore 存量问题，与本 feature 无关）；tsc 零错误。
- 待人工验收：/model 长列表滚动、select 期间 Ctrl+C、拖拽窗口不破版、/why 显示新模型。发布说明 docs/release-notes/v0.1.7.md。

## 2026-10-18 M0+M1 完成：探针结论、hotkeys 存量 bug 修复、bun 事件顺序分歧

- M0 探针结论全文落 `docs/select-component-m0-probes.md`（PRD §6/§7 已挂指针）：P1 污染证实、C5 定案手段B（rl.line 赋空 + _refreshLine）、P2 非 TTY 下 readline 不跑编辑器、P4 渲染/resize 可行。
- **存量 bug 修复**（M0 意外收获）：bun 与 node 都把 keypress 发在 stdin 而非 readline 实例上，hotkeys.ts attach 原来挂错对象——生产 ESC 取消从未生效；且回车键名是 "return" 不是 "enter"。已修：attach 监听 input、mapKey 认 return 别名、测试 fake 对齐真实事件路径。
- **bun 事件顺序分歧**（M1 手工测试暴露）：同一毫秒内 bun 派发顺序是 line → 残留 enter keypress（node 反序），导致 select 打开即被「提交命令的那次回车」自动确认第一条。修复：select 打开后 50ms 宽限窗（graceMs 可注入），窗内按键视为残留忽略。教训：**测试 fake 同 tick 发键测不出事件顺序类 bug，真实按键时序必须在 pty/真终端验证**。
- M1 交付：src/ui/select.ts（reduce 状态机 + select 组件）、tests/select.test.ts（22 条全绿）、/resume 接入（D7）、C11 line 丢弃守卫、非 TTY 回退。手工验收通过（↑↓ 选择会话成功）。
- 待办 M2：/model 接入（D8）、SIGINT 协调（C9）、choose() 迁移收尾（C14）、resize 必做项复核。
