# 修复-1107-sanitizeOutput 漏 OSC/DCS 剥离

> 最后更新:2026-11-07

## 摘要

2026-11-07（v0.4.46）。`sanitizeOutput`（`src/ui/toolLog.ts`）只写了 `\x1b[@-_]` 一条通用转义，它只吃掉「ESC + 一个字符」。OSC（`\x1b]0;title\x07`）与 DCS/SOS/PM/APC（`\x1bP...\x1b\\`）是「ESC + 引导符 + 正文 + 终止符」的**多字符**序列，于是引导符被吃掉、**正文残留**：`a\x1b]0;窗口标题\x07b → "a0;窗口标题b"`、`a\x1bP1;2|data\x1b\\b → "a1;2|datab"`。带颜色的工具会发 OSC 8 超链接，终端标题同理，`/last` 回看时就会看到这些垃圾串，既污染可读性也把宽度算错。

修法：补 OSC（`/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g`，比 `stripAnsi` 多一个 `|$` 分支以吃掉未终止的 OSC）与 DCS/SOS/PM/APC（`/\x1b[P^_X][^\x1b]*(?:\x1b\\|$)/g`）两条规则，末尾补 `/\x1b/g` 剥裸 ESC。`bun test` 1156 pass / 0 fail，`tsc` exit 0。

## 推理与依据

### 为什么这是「纪律没共享」而不是「实现写错」

OSC 的正确剥法在项目里**已经写对过两遍**：`src/tui/ansi.ts:225`（`stripAnsi`）和 `src/ui/theme.ts:194`，模式完全一致。`sanitizeOutput` 是第三处，漏了。这与 v0.4.16 抽出 `ui/format.ts` 的动机同构：纪律只写在注释里、各处各写一遍，就必然有地方漏。

本轮**没有**顺手把三处合并成共享实现。理由：`stripAnsi` 与 `sanitizeOutput` 职责不同 —— 前者不保留换行、不展开 tab、不剥 C0；合并需要先抽参数化，属于重构而非「小而明确的缺陷」。留作候选。

### 为什么比 stripAnsi 多一个 `|$`

`stripAnsi` 的 OSC 正则要求必须有终止符（BEL 或 ST）。但工具输出是**可能被截断的**（`maxLines` 截断、管道断开），未终止的 OSC 会整段残留。`sanitizeOutput` 的职责是「外部数据清洗」，宁可多剥不可漏剥，所以加 `|$` 吃到结尾。这是两处**有意**的口径差异，不是抄漏。

### 探针先于改动

改前跑探针确认了 14 条输入的实际输出（不是读代码推断），红测 2 条 fail（OSC 与 DCS），改完转绿，再跑全量。红测里有一条（C1 控制字符 `\x9b`）探针后发现是我断言写错 —— C1（0x80–0x9f）本就不在 C0 剥除范围 `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]` 内，属已知未修，遂改为只断言裸 ESC，不扩大改动范围。

### 验证

- `bun test`：1156 pass / 0 fail / 71 files（较 v0.4.45 的 1153 多 3 条，即本轮新增）
- `bunx tsc --noEmit`：exit 0
- 证据：`docs/evidence/v0.4.46-red.txt`、`docs/evidence/v0.4.46-tests.txt`
- 改动文件：`src/ui/toolLog.ts`、`tests/toollog.test.ts`、`docs/release-notes/v0.4.46.md`

### 本轮排除的候选（探针后判定不动）

- **`formatBytes` 末档 P**：探针实测 `1024**6 → "1024P"`、`1e21 → "888178P"`。但 1024 进制下 P 档档宽就是 1024，`1024P` 是**档内合法值**（与 `1000M` 同理，注释 L22 已明确「不强行升档」），注释写的「有意保留」成立 —— **不是缺陷**。真缺陷是 `1e300 → "8.881784197001253e+284P"`（300+ 字符），属末档封顶口径，与 `formatTokens` P 档一起定。
- **`formatDuration` 秒档边界**：探针 59949/59950/59999/3599950 全部正确，无缺陷。
- **`progressBar`**：探针 -1/2/NaN/Infinity 全部正确 clamp，无缺陷。
