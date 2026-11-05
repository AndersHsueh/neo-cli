# 修复-1104-trimPending颜色上下文丢失

## 摘要

v0.4.38 后修 trimPending 切分丢 SGR：切分后算 head 末尾 active SGR 前置到 pending 剩余部分

> 最后更新:2026-11-04
> 来源:session 20261104-175643-uc655t · 2026-11-04 · 自动归纳

## 正文

v0.4.38 之后修复 `src/tui/dock.ts` 的 `trimPending` 颜色上下文丢失缺陷。

现象：流式输出超过 `MAX_PENDING`（240）字符时，`trimPending` 把 head 切走提交，剩余 pending 从原串中间开始，丢掉了 head 里累积的 SGR（如开头的 `\x1b[31m`），导致第 241 字符之后以及后续追加的文本全部掉色。

根因：`wrapAnsi` 只给它自己的输出补行首 active SGR，管不到 pending 的剩余部分。

修复：切分后遍历 head 的 token 算出末尾 active SGR（复用 `src/tui/ansi.ts` 的 `nextActive`，已从私有改为导出），前置到 pending 剩余部分。

测试：新增 F2i2 / F2i3 覆盖。`bun test` 1136 pass / 0 fail，`tsc` exit 0。
