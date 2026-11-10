# 仓库地图（Repo Map）PRD（issue #15）

> 状态：实现中（待审查）
> 关联：GitHub #15；引用图排序见 #49。参考 Aider 的 repomap 思路，**不引 tree-sitter**：用行首正则抽符号 + 纯文本解析 import。

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
9. **按引用度排序（#49）**：解析 ts/js/py/go/rs 的 import/require 构建「文件 → 被多少个文件引用」图，
   被引用多的文件优先出现（预算不够时先保住入口文件）；引用度**只用于排序，不进提示词正文**。

## 3 验收

1. 交互与 `-p` 会话都能注入受预算限制的地图；会话语境下无额外 TUI 输出；
2. 常见语言的关键类型/函数可见；超大仓截断且不拖慢启动（扫描/缓存有上限）；
3. 文档写明生成时机（每次系统提示词渲染，20s 缓存）、关闭方式（`repo_map.enabled=false`）；
4. 与目录树并存不灌爆上下文；`/context` 能看到状态；
5. `bun x tsc --noEmit` 零错误、`bun test` 全绿、`bash scripts/verify.sh` 为 `ALL GREEN`。

## 4 非目标

- 不引 tree-sitter / LSP 做精确符号解析（#49 已定：引用图走**纯文本解析**，不引依赖）；
- 不做增量刷新/文件监听（缓存 20s + 目录状态失效已够）；
- 不替代 grep：地图只给「入口线索」，细节仍靠工具读。

## 5 #49 追加：引用图排序与缓存失效（2026-11-10）

原 §4 非目标写「引用图排序留待 #23 LSP 线」，维护者已改口径：**不引 tree-sitter / LSP，走纯文本解析**。

- **import 解析**（`extractImports`）：先剥注释（`//`、块注释、py 的 `#`），再按语言取模块串 ——
  ts/js 认 `import ... from` / `export ... from` / 裸 `import "x"` / `require("x")` / `import("x")`；
  py 认 `import a.b as c` 与 `from .mod import x`；go 认单行与分组 import；rust 认 `use` 与 `mod`。
- **路径归一**（`resolveImportTarget`）：ts/js 相对路径补扩展名与 `/index.*`；py 点号按包目录
  （`.` → 当前包 `__init__.py`，`..` → 上一级）；go 按包路径尾段匹配目录；rust `crate::a::b` → `src/a/b.rs`。
  解析不到（外部包）返回 null 并忽略。
- **引用图**（`buildRefGraph`）：统计「被多少个文件引用」；自引用不计，同文件多次 import 同一目标只算一次，
  循环 import 天然安全（单遍遍历，不递归展开）。
- **排序**（`sortSourcesByRefs`）：按被引用次数降序，同引用数保持字典序（稳定排序）。
  引用度**只用于排序**，正文仍只有 `路径: 符号列表`。
- **缓存**（`dirStamp`）：key 增加「cwd 与第一层目录的 mtime + 文件数」指纹，目录状态一变立即失效，
  不必等满 20s；`resetRepoMapCache()` 保留为写入后主动失效的入口。
- 测试：`tests/repo-map-refs.test.ts` E1–E7（解析与归一）、F1–F4（图与排序）、G1–G3（循环/自引用/外部包）、
  H1–H3（缓存失效）。不加 PTY。
