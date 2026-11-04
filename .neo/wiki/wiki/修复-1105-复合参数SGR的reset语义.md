# 修复-1105-复合参数 SGR 的 reset 语义

> 最后更新: 2026-11-05

## 摘要

`src/tui/ansi.ts` 的 `nextActive()` 处理 SGR 复合参数（`\x1b[31;0m`、`\x1b[0;31m`）时语义错误，导致折行后**下一行被错误染色**。根因是把 `params` 整串与 `"0"` 比较，只认「纯 reset」。修复为按分号拆参数、逐个走：`0`（含空参数）清空累积，其余继续累积。

`bun test` 1132 pass / 0 fail，`tsc --noEmit` 干净。

## 缺陷实证（探针）

| 场景 | 输入 | 修复前 | 修复后 |
|---|---|---|---|
| A 颜色残留 | `\x1b[31mAAA\x1b[31;0mBBB` 宽 3 | 第二行 `\x1b[31m\x1b[31;0mBBB\x1b[0m`（**被染红**） | `BBB`（无色，正确） |
| B 冗余 | `\x1b[31mAAA\x1b[0;31mBBB` | 前缀 `\x1b[31m\x1b[0;31m` | `\x1b[31mBBB\x1b[0m`（冗余消除） |
| C 多补 RESET | `\x1b[31mAAA\x1b[0;0mBBB` truncate | 末尾多一个 `\x1b[0m` | 无多余 RESET |

A 是真正的可见 bug：`\x1b[31;0m` 语义是「先红再 reset」，净效果无色，旧实现把它当普通上色追加进 `active`，于是下一行行首被加上红色前缀。

## 修复过程中的关键教训

**第一版修法（错误）**：`params.some(p => p === "0") → return ""`。

这个修法把 A 和 C 都修好了，但**引入了更严重的回归**：`\x1b[0;31m` 语义是「先 reset 再红」，净效果是红色；整体清空会把后面的 `31` 一起丢掉，导致下一行**丢色**。测试 A1k 的第三条断言当场抓住：

```
Expected: "\x1b[31mBBB\x1b[0m"
Received: "BBB"
```

**正确修法**：按参数列表顺序累积，`0` 只清空**已累积**的部分，其后的参数继续累积：

```ts
for (const p of params) {
  if (p === "" || p === "0") { flushPending(); acc = ""; continue; }
  pending.push(p);
}
flushPending();
```

这样 `\x1b[31;0m` → 空，`\x1b[0;31m` → `\x1b[31m`，`\x1b[1;31m` → 原样累积，三种语义都对。

## 测试

`tests/tui-frame.test.ts` 新增 `A1k 复合参数 SGR 里的 0 参数按 reset 处理`，覆盖四个分支：reset 结尾、纯 reset 复合、reset 开头、非 0 复合参数。

## 未做（候选）

- `nextActive` 对**重复同一 SGR** 仍然线性累积。探针 D（40 个 `a` 折成 4 行，每行前缀 19 字节）显示实际不随行数膨胀——每行重算 active，属于「冗余但颜色正确」。真正会膨胀的是同一行内反复出现同一 SGR 的情形，本轮按禁区约定不碰精确化。

## 相关

- [[修复-1105-裸ESC残留]]：同一文件、同一轮系列修复（v0.4.34）
- 禁区（本轮不碰）：`&nbsp;`/trim、CDATA、web 实体、gitignore、grapheme、formatTokens、insideRawDir、OSC、裸 ESC、wrapAnsi RESET 精确化
