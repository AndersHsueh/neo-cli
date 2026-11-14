# neo-agent 本轮实现报告（2026-11-14）

> 性质：架构文档 `docs/neo-agent-iteration-2026-11-14-architecture.md` T05 要求的最终实现报告。
> 口径：只记录真实落盘、真实跑过的命令与数字；不把阶段结论写成全量通过，不掩盖红灯。
> 平台：Windows 11 / Bun 1.3.6 / Git 2.55.0.windows.3。**本轮未执行任何 `*.sh` 脚本**；质量关卡全部走 `bun run check`、`bun test`、`bun -e` 与 git 命令。

---

## 1. 基线与范围

| 项 | 值 |
| --- | --- |
| 仓库 / 产品 | `AndersHsueh/neo-cli` / 产品称 `neo-agent`，CLI 命令与 package 名为 `neo` |
| 起始基线 | `main` = `a2858ae`，tag `v0.4.84`，发布日期 2026-11-10 |
| 开放 Issue | 18 条（全部 `enhancement`、全部未分配）；本轮只做 **#52 / #59 / #37**，其余 15 条明确延后 |
| 本轮附加交付 | 版本演进 HTML、宣传推广门户、统一 Web 设计系统、Web QA、Windows 基线治理 |
| 发布状态 | **已实现、未发布**：代码在本地 `main`，未推送、未打 tag、未发布 release note、未关 Issue |

---

## 2. 交付提交链（本地 main，快进合入）

按 `a2858ae` 之后的顺序：

| 提交 | 内容 | 归属 |
| --- | --- | --- |
| `879dee2` | `DEFAULT_LSP.enabled=false` / `DEFAULT_REPO_MAP.enabled=false`；`driveExitCode()` done+verified=0、done+model=3；总优先级 `abort=130 > hadError=1 > drive` | #52 |
| `0b128ce` | `ModelFallbackController`、顶层 `model_fallback`、`--fallback` / `--no-fallback`、用量分桶 | #59 |
| `8691c52` | `src/streamJson.ts` v1 `JsonlWriter`：统一信封、9 类事件、4000 code point 截断、递归脱敏、result 单出口、EPIPE 守卫、有界 flush | #37 基础 |
| `5e10397` | `src/memory/merge.ts` 用 `basename(target)` 替换三处 `split("/").pop()`，并给 `MergeDropped` 补 `page/scope` 上下文 | #39 真实产品缺陷 |
| `58c48d0` | 12 条 Windows 测试夹具跨平台路径假设修正 | 夹具（非 BUG） |
| `73d9dab` | K1 环境自检 `basename(ROOT)` 修正 | 夹具（非 BUG） |
| `236a4f2` | #37 CLI 组合接线 + `tests/cli-stream-json.test.ts` 端到端验收（37-A…E） | #37 收口 |
| `56ef369` | `README.md` / `settings.example.json` 同步三项能力契约与真实 JSONL 示例 | 文档 |
| `22fbd4b` | `tests/repo-map-refs.test.ts` 夹具显式开启 `repo_map`，修复 #52 默认关闭引入的 5 条回归 | #52 回归修复 |

> 说明：`fix-39`、`fixtures`、`#37` 收口等原提交分别位于 `neo/fix-39-memory-basename`（`08fb954`）、`neo/baseline-windows-fixture-fixes`（`d082da5` / `b85d45e`）、`neo/37-stream-json`（`b3f29c2`）、`neo/52-defaults-drive-exit`（`0a1a7d3`）。集成分枝通过 cherry-pick 保留各自独立提交语义，未创建混合三 Issue 的大提交。主理人按架构 §10.6 授权一次**本地 `--ff-only` 合入**，未推送。

---

## 3. #52 默认能力收口与 drive 退出码

- `src/config.ts` 默认值改为关闭；显式布尔值优先。
- `src/tools/index.ts` / `src/system-prompt.ts` / `src/prompt/manager.ts` / `src/prompt/visibility.ts` 保证关闭时不扫描、不注入 map、不出现 lsp schema/名称/说明。
- `src/oneshotDrive.ts` 的 `driveExitCode()`：`done+verified → 0`、`done+model → 3`、其余（exhausted / idle-stop / timeout）`→ 1`；`src/index.ts` 固化 `abort > hadError > drive`。stderr `[drive]` 摘要逐字段格式不变。
- 验收：`tests/oneshot-drive.test.ts` B 组、`tests/repo-map.test.ts` 52-A/52-B、`tests/lsp.test.ts`、`tests/prompt-visibility.test.ts` 均通过；`tests/repo-map-refs.test.ts` 在回归修复后 `17 pass / 0 fail`。

## 4. #59 有序模型备用链

- `src/config.ts`：顶层 `model_fallback: [{provider, model}]`，严格校验数组形状、未知 provider、空字段、重复项、最多 8 项；解析失败在模型请求前报错。
- `src/modelFallback.ts`（345 行）：`ModelFallbackController` 只包主 Agent 请求；同模型重试耗尽后有界推进游标；任何已发流式增量后禁止切换；失败候选不污染共享 cfg；只有完整成功才 `applyModelTarget()` 提交；会话内保持、不自动回切、不写 settings；`attributeFailure()` 分类错误、脱敏提示；usage 按实际 provider/model 分桶。
- CLI：`--fallback <provider>:<model>` 可重复、出现即整体替换配置链；`--no-fallback` 本次禁用且互斥。
- 验收：`tests/model-fallback.test.ts` 覆盖 59-A…F，**21 pass / 0 fail**。

## 5. #37 stream-json v1

- `src/streamJson.ts`（940 行）：`schema_version: "1.0"` 字符串；信封六字段 `type / session_id / seq / timestamp / data` + `schema_version`；`seq` 单 writer 从 1 严格 +1；9 类事件；工具参数/输出按 4000 Unicode code point 截断；敏感键递归打码（深度溢出整体 `[REDACTED]`）；`result` 后拒绝后续事件；EPIPE/写失败立即 closed、触发 `agent.cancel()`、不再写 stdout、stderr 恰一条 `[stream-json] stdout closed; aborting`；有界 flush。
- `src/agent/types.ts` / `src/agent/loop.ts`：新增 `assistant_message` 事件与 `call_id / paths / output / status / truncated` 字段；并行段保持「原序发全部 start → 并发执行 → 原序发全部 end」。
- `src/index.ts`：`structuredMode = jsonMode || streamJsonMode`；Console/诊断/fallback 人类提示/drive 摘要/警告在结构化模式写 stderr；stdout 只归 `JsonlWriter`；用法错误输出 `error` + 一条 `result`（`exit_code=2`、`session_id=null`）；`result.exit_code` 直接复用 `:1697` 算好的 `exitCode`，writer 不重算；EPIPE 强制 `exit 1` 并跳过 result。
- 端到端验收 `tests/cli-stream-json.test.ts`（14 条真实 CLI 子进程 + 本地 fake SSE）：37-A 普通成功/等号形式、37-B 工具事件 call_id 配对与脱敏、37-C 用法错误与 text/单行 json 回归、37-D drive verified/model/未达成三种终态、37-E 注入式 EPIPE 与真实下游提前关闭。
- 定向实测：`bun run check` Exit 0；`tests/cli-stream-json.test.ts + tests/stream-json.test.ts + tests/agent-stream-events.test.ts` = **31 pass / 0 fail / 1287 expect**。

### 5.1 本轮修正的测试侧契约偏差（非产品缺陷）

1. `StreamAssistantMessageData`（`src/streamJson.ts:95-104`）含 `turn: number`，端到端测试的白名单漏写该字段 → 按契约补齐并新增 `turn===1` 断言。
2. `result.data.usage.reasoning` 是冻结契约的合法用量字段，测试误用整段 stdout `includes("reasoning")` 判泄漏 → 改为逐信封精确判定（result 剔除 `usage` 后检查），并钉住事件 type 必须是 9 类公开事件之一。
3. 两处 `unknown` 直接传给 `toContain` 的 TypeScript 错误 → 先判 `typeof === "string"` 再 `String()` 比较，断言强度不降低。

---

## 6. 真实产品缺陷 #39（唯一一条）

- 根因：`src/memory/merge.ts` 三处 `target.split("/").pop()` 在 Windows 反斜杠绝对路径下取不到续页名，`writeBack` 抛错被 `applyOps` 的 `dropped` 静默吞掉，`applied=[]`，**记忆续页整条功能失效且自动记忆内容静默丢失**。
- 修复：`import { basename, join } from "node:path"` + `basename(target)`；`MergeDropped` 增加可选 `page? / scope?`，`dropped` 补上下文便于审计。
- 验收：`tests/memory-capture.test.ts` **39 pass / 0 fail / 118 expect**，`B7 页面超限转续页` 由 fail 转 pass，续页文件真实生成；在集成分枝 6 文件实测中 B7 已不再出现在失败集合。

## 7. Windows 基线治理（不是 BUG 修复）

- 干净基线 `a2858ae` 全量：`1879 pass / 5 skip / 106 fail / 5 errors / 6258 expect / 1990 tests / 115 files / 234.69s`，证据 `docs/evidence/baseline-windows-2026-11-14-tests.txt`（3715 行）。`(fail)` 字面 212 行 = 执行区 106 + 汇总区 106，去重唯一失败 106 条。
- 诊断：E 纯环境性 68 / P 疑似产品缺陷 12 / R 需复现 26；P 类细化为 **1 真缺陷 / 10 夹具 / 1 需实跑**；#6 gitignore K3 实跑定性为 Git for Windows 尾斜杠目录 pathspec 假阳性，不改 `.gitignore`、保留 K4 文本守卫。
- 夹具修复共 **13 条 fail→pass**（12 + K1），全部是跨平台路径假设（`basename()` / `dirname()` / `join()` / `isAbsolute()` / 去尾斜杠 pathspec），**不计入产品 BUG 修复**。
- 6 文件定向实测（集成分枝，含 #39 修复）：**145 pass / 1 fail / 440 expect**，唯一红灯 `K4.1` 为 Windows 软链 `EPERM`，需 `SeCreateSymbolicLinkPrivilege` / 开发者模式，如实保留。

---

## 8. 文档同步

- `settings.example.json`：新增顶层 `model_fallback` 示例（引用已存在的 `example` provider）与 `_model_fallback_note`，保持合法 JSON，`bun -e` 解析通过。
- `README.md`：新增「本轮实现（已实现，尚未发版）」小节，写 #52 退出码、#59 配置/CLI 与语义、#37 九类事件、真实 JSONL 信封示例（`schema_version` / `type` / `session_id` / `seq` / `timestamp` / `data` 六字段，`init.data` 五字段逐字段对齐 `StreamInitData`）、result 单出口与 EPIPE 例外、stdout/stderr 分工；CLI 表补 3 行。显式声明当前已发布仍 v0.4.84、不改旧 release note。

## 9. Web 成果

- `web/neo-agent-version-evolution.html`、`web/portal/index.html` + `styles.css` / `script.js` / `favicon.svg`；统一设计系统 `docs/neo-agent-web-design-system.md`。
- 四阶段 QA：静态 / 浏览器 A / B1 / B2 均 PASS，最终 `FINAL_WEB_QA: IS_PASS: YES` **带限定范围**（Lighthouse 未执行、PRD §5.5 移动端四项 ≥90 未验证、O5 ≤192px 极端宽度横向滚动未修复），报告 `docs/neo-agent-web-qa-2026-11-14.md`。
- 本轮实现完成后，两页 #52/#59/#37 状态由「本轮规划」同步为「已实现，未发布」，补本地提交（`879dee2` / `0b128ce` / `8691c52` + `b3f29c2`）、状态边界与页脚说明；未新增任何外部链接或远程 commit 链接，避免链接到本地未推送的哈希。当前已发布版本、日期、`a2858ae` 保持不变。

---

## 10. 验证结果矩阵（均为本机实测）

| 关卡 | 结果 |
| --- | --- |
| `bun run check`（= `bun x tsc --noEmit`） | Exit 0（在 #52 / #59 / #37 / 集成分枝多次复验） |
| #59 定向 | `21 pass / 0 fail` |
| #37 writer 单测 | `12 pass / 0 fail / 315 expect` |
| #37 端到端 + 单元 + Agent 事件 | `31 pass / 0 fail / 1287 expect` |
| #52 repo-map 两文件（回归修复后） | `27 pass / 0 fail / 72 expect` |
| 夹具 6 文件（含 #39） | `145 pass / 1 fail / 440 expect`（唯一 K4.1 软链 EPERM） |
| 集成基线定向（8691c52，7 文件） | `110 pass / 14 fail / 1 error / 775 expect`；14 条与基线逐字一致，**该阶段零新增回归** |
| 全量基线 `a2858ae` | `1879 pass / 5 skip / 106 fail / 5 errors` |
| 全量集成第 1 次 | `TEST_EXIT=3`，Bun 1.3.6 主线程 `Segmentation fault`（108s / 1291 行），运行时间歇崩溃，无有效全量结论 |
| 全量集成第 2 次（回归修复前） | `1946 pass / 5 skip / 96 fail / 3 errors / 7716 expect / 2047 tests / 119 files / 315.63s`；差集 `new=5 / fixed=15 / still=91` |
| 全量集成第 3 次（回归修复后，最终） | `1951 pass / 5 skip / 91 fail / 3 errors / 7721 expect / 2047 tests / 119 files / 264.78s`；逐条差集 **`new=0 / fixed=15 / still=91`**，见 `docs/neo-agent-final-verification-2026-11-14.md` |

> 第 2 次差集中的 `new=5` 全部是 `tests/repo-map-refs.test.ts` 的 F3/G1/H1/H2/H3，已在 #52 owning 分支以 `0a1a7d3` 修复并合入；第 3 次复验后新增红灯归零。`fixed=15` 为 B7（#39）+ 13 条夹具 + K3 等。

---

## 11. 已知限制与诚实边界

1. **全量 `bun test` 在本机不能达成 `ALL GREEN`**：残余失败以 Windows OS 级限制为主——`EPERM: operation not permitted, symlink`（基线 47 处）、`EBUSY` 临时目录文件锁（12 处）、SIGINT 信号传递、PTY/子进程回收、60s 超时等。这些是**验证盲区，不是绿灯**，不得包装为通过。
2. `K4.1` 软链技术边界用例需 Windows 软链特权环境才能验证，本轮如实记为未通过。
3. **物理 EPIPE 在本环境不可复现**：Bun 静默吸收对已关闭管道的写入、不上抛 error 事件；E2E 用 `--preload` 注入 `code="EPIPE"` 覆盖同一 `JsonlWriter.closeWithError` 路径，另有真实下游提前关闭的不挂死断言。此为标准限制，不宣称物理 EPIPE 已实测。
4. Bun 1.3.6 在本机出现过 1 次全量测试段错误（3 次运行中 1 次），属运行时间歇崩溃，已用完整复跑取得有效证据。
5. Lighthouse 未执行；PRD §5.5 移动端四项 ≥90 未验证；O5 极端宽度横向滚动未修复。
6. 无真实第三方网关测试；跨 provider/protocol 证据均来自本地 fake 流。
7. `bun run verify` / `scripts/verify.sh` **按用户要求未执行**；PTY 端到端（`bun run e2e`，`scripts/pty-e2e.ts`）本轮未纳入最终闸门。
8. 未推送、未打 tag、未发布 release note、未关闭 Issue、未部署 Web 页面。

---

## 12. 交付状态

- 本地 `main` 已包含全部 9 个本轮提交；各 Issue 分支、集成分枝、`fix-39` / `fixtures` 分支仍保留，便于独立复核。
- 主工作区的 `docs/` 分析报告与 `web/` 成果为未跟踪文件，按架构 §10 未被任何核心代码提交混入。
- **结论口径**：三项需求已实现、已知真实产品缺陷 #39 已修复、本轮引入的回归已修复并复验；但受 Windows 环境限制，全量测试仍存在环境性红灯与本报告第 11 节列出的限制，因此**不宣称 `ALL GREEN` 或「无遗留 BUG」**。
