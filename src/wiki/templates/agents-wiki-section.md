<!-- neo:wiki-workflow:start （本区块由 neo /init 拥有：重跑 /init 只重写本区块，区块外的手写内容不会被触碰） -->
## 工作流

本项目带 neo 记忆 wiki（`<cwd>/.neo/wiki/`）。定位：项目内可回忆之前动作的记录，不是审计系统。

### 目录约定

- `raw/` — 原始素材。**可创建、可删除、删除后可重建同名；唯独不可修改已存在文件的内容**。发现源有问题，在对应 wiki 主题页加 `> 待澄清:` 注记
- `wiki/` — 主题页（当前最优综述，该改就改）+ `INDEX.md` 索引 + `log.md` 日志
- `outputs/` — 正式产出物

### 页面必备

- `## 摘要`（或 `## Summary`）+ 日期戳 `> 最后更新:YYYY-MM-DD`（或 `> Last updated:`，中英等价）
- 命名前缀只从登记表取：`待澄清-<主题>` / `盘点-<YYYY-MM-DD>-<主题>` / `对比-<A>-与-<B>` / `汇总-<维度>` / `<事件类型>-<MMDD>`，或无前缀中文短语

### log 纪律

- `wiki/log.md` 全库唯一 append-only；条目格式 `## [YYYY-MM-DD] type | 一句话`
- type 只取：ingest / query / wiki / lint / deliverable / milestone / todo

### 工具入口（机制保证，不靠自觉）

- **写回**：只走 `wiki_write` 工具——命名校验、摘要/日期戳强制、INDEX 与 log 同步都在工具内自动完成
- **查询**：`wiki_search` 工具；会话开始时 INDEX 主题清单已注入上下文
- **体检**：`/wiki-lint` 命令；**编译**：`/ingest` 命令（由用户手动触发）
<!-- neo:wiki-workflow:end -->
