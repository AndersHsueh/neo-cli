# 修复-1106 wrapAnsi 连续空格折行与 buffer 同口径

> 最后更新:2026-11-06

## 摘要

v0.4.38（HEAD `2a60c8d` 之后）修掉 `src/tui/ansi.ts` 的 `wrapAnsi` 在**连续空格**处折行与 `src/tui/buffer.ts` 的 `layoutBuffer` 分叉的缺陷。现象：`wrapAnsi("ab   cd", 3)` 给 `["ab ", " cd"]`（下一行以空格开头），而输入框 `layoutBuffer` 给 `["ab ", "cd"]`。根因是溢出分支里「空格是断点」的两条路径都只丢一个空格，没把断点后的连续空格一起当行首空白丢掉。修复后 9 个探针用例与 `layoutBuffer` 全对齐，`bun test` 1134 pass / 0 fail，`tsc --noEmit` exit 0。

日期：2026-11-06

## 根因

`wrapAnsi` 的溢出分支（`rowW + t.w > max && row.length > 0`）有两条处理空格的路：

1. **溢出 token 本身是空格**（`src/tui/ansi.ts:155` 附近）：`emitRow()` 后 `continue`，只丢这一个空格。若原文是 `"ab   cd"`，第二个空格溢出触发换行，第三个空格落到新行行首 → `["ab ", " cd"]`。
2. **词边界折行**（`spaceAt` 分支）：`rest = row.slice(spaceAt + 1)` 把断点后的空格原样带进下一行。

`layoutBuffer` 的 `wrapSegment`（`src/tui/buffer.ts:117-129`）用 `lineHadContent` 判据：断点前有非空白内容时，断点后的连续空格是「行首空白」，`while (i < to && chars[i] === " ") i += 1` 一并跳过。两者口径不一致，导致同一段文本在 dock/scrollback（走 `wrapAnsi`）和输入框（走 `layoutBuffer`）里折行结果不同。

## 修法与踩坑

第一版只改了词边界分支，探针**输出没变** —— 因为 `"ab   cd"` 宽 3 实际走的是路径 1（溢出 token 是空格），不是词边界分支。教训：改折行逻辑前先打印 token 流和每步状态，别凭代码结构猜路径。

第二版在路径 1 加了丢弃循环，立刻回归：`"    "` 宽 2 变成 `["  "]`，**丢了 2 个空格**。纯空白行里空格就是内容（对应 `tests/tui-buffer.test.ts` 的 B1i），不能丢。补 `rowHadContent` 判据后又出现空行 `["  ", "", "  "]` —— `emitRow()` 已清空 row，纯空白分支再 `continue` 会让溢出空格被吞。最终纯空白分支显式 `row.push(t); rowW = t.w;` 把空格放进新行。

## 测试期望更新

`tests/tui-frame.test.ts` 的 A1b 旧期望 `wrapAnsi("hello world foo", 8)` = `["hello","world","foo"]` 是**过时**的：`layoutBuffer` 对同一输入给 `["hello ", "world ", "foo"]`（断点空格留在上一行行尾，`buffer.ts` 文件头明确写了这条规则）。已更新期望并注明依据。新增 A1b2 固定连续空格 + 纯空白行两类行为。

## 已知遗留（本次未修，不在范围内）

`wrapAnsi("hello world foo", 11)` = `["hello world","foo"]`，`layoutBuffer` = `["hello ","world foo"]`。这是**改动前就存在**的既有分叉（已用 `git stash` 验证），源于 `wrapAnsi` 的「恰好塞满时遇到空格直接丢」规则与 `layoutBuffer` 的贪心回退策略不同。不是本次引入，未处理。

## 证据

- `docs/evidence/v0.4.38-tests.txt`：1134 pass / 0 fail
- `docs/evidence/v0.4.38-tsc.txt`：tsc exit=0
