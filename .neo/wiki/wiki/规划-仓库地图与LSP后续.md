# 规划-仓库地图与LSP后续

## 摘要

v0.4.81 后仓库地图与 LSP 扩展的现状、工作量、风险及优先级判断

> 最后更新:2026-11-10
> 来源:session 20261110-095424-5e66zj · 2026-11-10 · 自动归纳

## 正文

GitHub issue #35 的两项后续已做只读源码审计，未修改代码。

1. 仓库地图：`src/prompt/repoMap.ts` 当前仅用正则抽取符号并按路径字典序排列，没有引用关系图；这与 `docs/repo-map-prd[done].md` 的非目标一致。纯文本 import 图需支持 4 种语言，再增加中心度排序与缓存改造，预计 3.5–4.5 人日；若采用 tree-sitter 或 LSP，预计 3–5 人日并需额外处理依赖治理。tree-sitter 原生二进制与三平台可移植性约定冲突，WASM 路线则存在约 5–10MB grammar 和 Bun 加载路径验证问题。当前缓存 key 不包含文件状态，20 秒 TTL 内修改文件不会刷新地图，且该行为已有测试固定。纯文本路线难度中、影响中、把握高，建议第三批。

2. LSP 扩展：`LspClient.request()` 已能发送任意 method，但工具 enum、`navigate()` 的 method 分支和 `formatNavigation()` 仍硬编码现有三种操作。workspace symbol（S）、completion（S–M）、call hierarchy（M）、capabilities、工具 schema 与 fixture 合计约 3–4.5 人日。`onMessage` 当前只处理响应和 diagnostics，无法回应 server 发来的 request，例如 pyright 的 `workspace/configuration`；现有三个 method 尚未触发该问题。整体难度低–中、影响中、把握高，建议第二批。

合并建议：两项不合并，只共享 `LspClient` 请求层；仓库地图若走 LSP，需要新建全仓符号索引，属于新工程。建议先扩展 LSP 并探明真实 server 的 workspace 级行为，再决定仓库地图是否采用 LSP。

## 推理与依据

- 2026-11-10（session 20261110-095424-5e66zj）：2026-11-10 完成 issue #43，提交 `0dc0d8f`（分支 `neo/feat-lsp-ext`，基于 `e99e9d9`），worktree 位于 `.neo/worktrees/feat-lsp-ext`。本次扩展补齐 `completion`、`callHierarchy`、`workspace.symbol` 三类导航能力：客户端 capabilities 已声明；`navigate()` 支持三种 operation，call hierarchy 采用两段式并原样回传 item；工具 schema 扩至 6 个 enum，`line` 不再必填，并新增 `query`/`direction`。

关键根因是 client 此前会把 server→client 请求误当作响应去 pending 表查找后丢弃，导致 server 永远收不到应答。新增 `answerServerRequest()`：`workspace/configuration` 返回等长 `null` 数组，`workspace/workspaceFolders` 返回 cwd，其余返回 `null`。输出统一由“N 处”改为“N 条”，并统一截断为 20 条、标注总数。`workspaceSymbol` 因缺少文件后缀信息，当前取第一个 connected server，多 server 仲裁留待 PRD 后续处理。

验证基线为 `bun test` 1863→1874 pass、0 fail、0 skip（107 文件），`verify.sh` ALL GREEN、PTY 31/31；测试均使用 fake fixture。尚未改版本号、打 tag、push、合并 main 或关闭 issue。当前遗留项是合入后用真实 pyright/tsserver 手测时序，因为本机未安装真实语言服务器。

- 2026-11-10（session 20261110-095424-5e66zj）：2026-11-10，issue #49 在独立 worktree `.neo/worktrees/feat-repo-map-refs` 完成，提交 `bf726f5`，分支 `neo/feat-repo-map-refs`，基于 `31c440b`；未 push、未合 main、未打 tag、未关 issue。仓库地图新增：
- `extractImports`：纯文本解析 TS/JS/Python/Go/Rust 的 import/require，先剥离 `//`、块注释及 Python `#` 注释；支持 TS/JS 的 import/export、require、动态 import，并按源码位置保持顺序。
- `resolveImportTarget`：归一化 TS/JS 扩展名与 `/index.*`、Python 点号包路径、Go 包路径尾段、Rust `crate::a::b` 到 `src/a/b.rs`；外部包返回 `null` 并忽略。
- `buildRefGraph` / `sortSourcesByRefs`：统计被引用次数后降序排序，同次数按字典序；排除自引用，import 去重，循环引用只单遍遍历、不递归。
- `dirStamp`：缓存键加入 cwd、第一层目录 mtime 与文件数指纹，使目录变化无需等待 20 秒 TTL 即可失效。

验证结果：`bun test` 1926 pass / 0 fail / 0 skip（112 文件），`scripts/verify.sh` ALL GREEN（PTY 31/31）；新增测试文件 `tests/repo-map-refs.test.ts`，实现位于 `src/prompt/repoMap.ts`，PRD 已改为 `docs/repo-map-prd[done].md`。需注意两点：改前基线曾偶发出现 1908 pass / 1 fail，连续重跑 3 次均绿，但未定位具体失败用例；`dirStamp` 仅统计两层目录，深层文件变更可能不会立即触发失效，仍依赖 20 秒 TTL，可提高 `visit(cwd, "", 2)` 深度，但会增加渲染时 stat 成本。
