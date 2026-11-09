# 仓库地图（Repo Map）PRD（issue #15）

> 状态：实现中（待审查）
> 关联：GitHub #15。参考 Aider 的 repomap 思路，做**最小可用版**：不引 tree-sitter，用行首正则抽符号。

## 1 背景

系统提示词已有「工作目录结构（最多两层）」树，但**没有符号级地图**。大仓里首轮探索常是盲扫：
模型不知道哪个文件定义了什么，只能 glob/grep/read 一路烧工具预算。

## 2 需求

1. **生成一份受预算限制的符号地图**注入系统提示词（`## 仓库地图（关键符号，预算内）`），
   形如 `src/agent/loop.ts: Agent, send, buildScopedRulesMessage`。
2. **语言覆盖**：TypeScript/JavaScript（`export` 的函数/类/接口/类型/常量/枚举，以及 `export { … }`）、
   Python（`def`/`class`）、Go（`func`/`type`）、Rust（`fn`/`struct`/`enum`/`trait`）。
3. **预算**：`budget_tokens`（默认 800，按 4 字符≈1 token 换算成字符上限），超了截断并标注；
   单文件最多 10 个符号；单文件 >300KB 跳过。
4. **扫描有界**：最多 `max_files`（默认 1200）个源文件；跳过 `node_modules/.git/dist/build/out/venv/target/vendor/.cache/.neo` 等目录；
   结果缓存 20 秒（每次提示词渲染都全盘扫一遍太贵）。
5. **配置**：settings.json 顶层 `repo_map: { enabled, budget_tokens, max_files }`；
   默认开启、保守预算；`enabled: false` 完全关闭。
6. **可观测**：`/context` 增 `repo map` 一行（文件数 / 符号数 / 估算 tokens / 预算 / 是否截断）；关闭时显示「已关闭」。
7. **不炸主循环**：任何 IO/解析异常 → 视为无地图（空串），不注入也不报错。
8. 与两层目录树**并存**：目录树回答「有什么文件」，地图回答「哪个文件定义了什么」，不重复灌同一信息；
   地图默认只占 ~800 tokens 量级。

## 3 验收

1. 交互与 `-p` 会话都能注入受预算限制的地图；会话语境下无额外 TUI 输出；
2. 常见语言的关键类型/函数可见；超大仓截断且不拖慢启动（扫描/缓存有上限）；
3. 文档写明生成时机（每次系统提示词渲染，20s 缓存）、关闭方式（`repo_map.enabled=false`）；
4. 与目录树并存不灌爆上下文；`/context` 能看到状态；
5. `bun x tsc --noEmit` 零错误、`bun test` 全绿、`bash scripts/verify.sh` 为 `ALL GREEN`。

## 4 非目标

- 不引 tree-sitter / LSP 做精确符号解析与引用图排序（引用图排序留待 #23 LSP 线）；
- 不做增量刷新/文件监听（缓存 20s 已够；改文件后最迟一次渲染生效）；
- 不替代 grep：地图只给「入口线索」，细节仍靠工具读。
