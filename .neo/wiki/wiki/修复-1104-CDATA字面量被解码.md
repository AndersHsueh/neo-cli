# 修复-1104-CDATA 字面量被解码（v0.4.27）

> 最后更新:2026-11-04

## 摘要

2026-11-04，`src/tools/webSearch.ts` 的 `decodeXml` 有两个同源缺陷：**CDATA 段内的实体被解码**、**跨 CDATA 边界能拼出实体**。根因是「先脱 CDATA 壳、再整体解实体」的两趟处理。改为单趟扫描 + 私用区占位符后修复，`bun test` 1115 pass / 0 fail，`tsc --noEmit` 干净。未 commit（工作区改动：`src/tools/webSearch.ts`、`tests/b4-tools.test.ts`、`docs/evidence/v0.4.27-{tests,tsc}.txt`）。

## 缺陷与证据

修复前用临时探针实测（`tests/tmp-cdata-probe.test.ts`，验证后已删）：

| 输入 | 期望 | 旧行为 |
|---|---|---|
| `<![CDATA[a &amp; b]]>` | `a &amp; b` | `a & b` |
| `<![CDATA[&am]]>p;` | `&amp;` | `&;`（跨边界拼成 `&amp;`） |

第二条是真正的语义错误：两个本不相邻的片段被拼成一个实体，属于「凭空造出内容」。

## 修法

1. 把 CDATA 与实体放进**同一个正则** `XML_TOKEN`，CDATA 分支整体摘出，实体分支只可能从 CDATA 之外的原文匹配 —— 两个 bug 一起消失。
2. 摘出的 CDATA 段换成私用区占位符 `\uE000<序号>\uE000`，解码完再 `restoreCdata` 还原。**不能直接原样返回 CDATA 内容**：`stripTags` 随后还要过 `/<[^>]+>/g`，CDATA 里的字面量 `<b>` 会被当标签剥掉（与 v0.4.22 同一类错误）。
3. `stripTags` 同样先摘 CDATA 再剥标签，还原后不再剥。
4. 删掉已无引用的 `XML_ENTITY` 常量。

## 行为变更（测试断言随之调整）

`tests/b4-tools.test.ts` 里原断言 `r[0].snippet` 含 `"Vue 3.5 & 性能提升"`，其来源是 `<![CDATA[<b>Vue</b> 3.5 &amp; 性能提升]]>`。按 XML 语义，CDATA 内应原样保留，新断言为 `"<b>Vue</b> 3.5 &amp; 性能提升"`。

**这是一次可见的输出变化**：Bing RSS 若把 `<b>` 高亮标签包在 CDATA 里，搜索结果摘要现在会带字面量 `<b>`。若认为「剥掉高亮标签」更符合用户预期，需要的是「CDATA 内剥标签但不解实体」的折中策略 —— 那是产品口径问题，本轮按 XML 规范取严格语义，留作待澄清项。
