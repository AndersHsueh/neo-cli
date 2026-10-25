# neo P0 加固计划（2026-10-26）

> 目标：修掉 `docs/neo-vs-claude-code-20261026.md` 中列出的 6 个 P0 缺陷。
> 原则：**只修 P0，不顺手扩展 P1 能力**；每项独立 commit、独立测试、独立验收；全程 `tsc` 零错误、`bun test` 全绿。
> 基线：v0.3.4（HEAD ca93568），881 pass / 0 fail（53 文件），PTY e2e 19/19。

---

## 0. 总览

| 序 | 项目 | 类型 | 工作量 | 主要文件 | commit |
|---|---|---|---|---|---|
| 1 | `edit_file` 的 `$&` 静默写坏 | correctness | S（30min） | `src/tools/index.ts` | `fix(p0-edit): ...` |
| 2 | LLM 零重试 / 零超时 | reliability | M（3–4h） | `src/llm.ts`、`src/config.ts` | `fix(p0-retry): ...` |
| 3 | 压缩丢信息 / 不保留近期原文 | context | M（2–3h） | `src/agent.ts` | `fix(p0-compact): ...` |
| 4 | grep/glob 不守 `.gitignore`、漏隐藏文件 | tooling | M–L（4–6h） | `src/tools/index.ts`、新增 `src/tools/gitignore.ts` | `fix(p0-search): ...` |
| 5 | 无检查点 / 撤销 | safety | M–L（4–5h） | 新增 `src/checkpoint.ts`、`src/tools/index.ts`、`src/index.ts` | `feat(p0-undo): ...` |
| 6 | `-p` 不可自动化（无 JSON、失败 exit 0） | automation | M（3–4h） | `src/index.ts`、`src/agent.ts`、`src/llm.ts` | `feat(p0-print): ...` |

顺序按「正确性 → 可靠性 → 上下文 → 检索 → 安全 → 自动化」；每项完成后立即跑全量回归，避免问题堆到最后。
**非目标**：MCP / hooks / 沙箱 / 权限规则 / 并行工具 / prompt caching / TodoWrite——这些是 P1，等 P0 收口后再评估。

---

## 1. P0-3：修 `edit_file` 的 `$&` 静默写坏（先做，最小改动）

**现状**：`src/tools/index.ts:224` 单次替换用 `src.replace(oldS, newS)`。JS 会把 `newS` 里的 `$&`、`$1`、`$$`、`` $` ``、`$'` 当替换模式展开。实测：想写入 `s.replace(/a/g, "$&")`，实际写成 `s.replace(/a/g, "normal")`，工具还返回「已修改 1 处」。

**方案**：单次与全量都改成 `src.split(oldS).join(newS)`（全量分支本来就是它，行为一致；count 已确认，语义不变）。顺带在返回值里区分「替换 1 处 / N 处」。

**测试**：`tests/tools-edit.test.ts`（新建）或并入 `tests/core.test.ts`：
- `new_string` 含 `$&`、`$1`、`$$`、`` $` ``、`$'`，断言文件字节等于预期；
- `replace_all=true` 同样安全；
- 不唯一时报错行为保持不变。

**验收**：新增用例通过；原有 edit 相关测试不改语义；`bun test` 全绿。

---

## 2. P0-1：LLM 请求重试 + 超时（收益最大）

**现状**：`src/llm.ts:196-201` 直接 `fetch`，只有调用方 signal；无重试、无 deadline。429/5xx/连接中断/网关挂起直接废掉整轮（且无检查点）。

**方案**：
1. 在 `chatStream` 外层加重试封装，**只重试「尚未收到任何增量」的失败**：
   - 可重试：网络错误（TypeError/fetch failed）、408、409、425、429、5xx；
   - 不可重试：4xx（除上述）、用户 abort、已开始输出后的中途断开（避免重复正文/重复工具调用）。
2. 退避：`base * 2^(n-1)` + 抖动，单次上限 8s，最多 3 次尝试；429 优先读 `Retry-After`（秒数或 HTTP 日期，上限 30s）。
3. 超时：
   - 连接 + 首字节 30s（`AbortSignal.timeout` 或手动计时器）；
   - 流式空闲 120s（每收到 chunk 重置），触发后按「可重试」处理（仅在尚无内容时）；
   - 用户 abort 与超时必须可区分（错误类型/`reason`），前者不重试。
4. 错误信息带 `attempts / 最后状态码 / 是否超时`；重试过程写 `onNotice`，交互模式可见（不刷屏，仅一次汇总）。
5. 配置：新增可选 `retry`（`max_attempts`、`base_delay_ms`、`connect_timeout_ms`、`stream_idle_timeout_ms`），settings.json 可覆盖，默认值如上；环境变量 `NEO_LLM_*` 可选。老配置零迁移。

**测试**：`tests/llm-retry.test.ts`（Bun.serve 本地假服务，不碰外网）：
- 500→500→200 成功，断言请求次数=3；
- 400 不重试，一次失败；
- 429 + `Retry-After: 0` 后成功；
- 服务端挂起超过 connect timeout → 有界失败（总耗时有上限、错误文案含 timeout）；
- 中途断流（已发部分 SSE 后关闭）→ 不重试、报错含「部分内容」；
- abort 在退避等待中 → 立即返回，不重试。

**风险**：重试放大 token 成本 → 仅在前 3 次、且无内容时重试；`tools` 请求是幂等的（无状态）。
**验收**：以上用例全绿；现有 fake-llm / PTY 场景不受影响；429 注入脚本一次通过。

---

## 3. P0-2：压缩保留近期原文 + 提高摘要输入保真度

**现状**：`src/agent.ts:261-319`。
- 摘要器输入每条消息经 `truncateArgs(max=160)`，路径/命令/错误栈被砍；
- 压缩后历史只剩 `[system, <对话摘要>]`，最近任务细节全部依赖摘要；
- 压缩调用自身 token 不计入统计。

**方案**：
1. **切分**：找到最后一个「安全边界」（`role=user` 的消息之前）作为切点；**保留最近 ≥6 条消息原文 + 摘要**。切点必须保证不拆散 `assistant(tool_calls)` 与后续 `tool` 结果。
2. **摘要输入保真**：单条消息上限提到 2,000–4,000 字符（工具调用保留 `name(args)` 摘要与结果前 N 行），总输入上限 60k 字符，超出再截断；提示词明确要求保留「文件路径、命令、错误、未决问题」。
3. **结果结构**：`[system?, user:<对话摘要（含"以下为压缩前历史"）>, ...保留的近期原文]`；摘要中记录被压缩的消息条数。
4. 压缩调用的 usage 计入 `cumulative`（顺带修复统计缺口）。
5. 保持既有契约：`compactNow` 太短抛错、`compact` 失败返回 false、安全切点调用约束不变。

**测试**：改 `tests/compact-ctx.test.ts`（现有断言会变，属预期）：
- 压缩后 `messages.length` 明显小于压缩前，但**最后 6 条逐字保留**；
- 保留段首条不是 `tool`（配对完整，fakeStream 能消费）；
- 摘要器 prompt 里能看到一条 >160 字符的关键命令/路径（证明不再 160 截断）；
- 压缩调用 usage 进入累计统计；
- 端到端：compact_ctx → 下一轮请求消息序列合法。

**风险**：压缩阈值附近行为变化（保留 6 条可能让压缩后仍接近阈值）→ 在摘要里明确标注，并在测试里断言下一次自动压缩不会立即触发。
**验收**：`bun test tests/compact-ctx.test.ts` + 全量回归 + PTY e2e。

---

## 4. P0-5：grep/glob 尊重 `.gitignore`、包含隐藏文件、避免全盘扫

**现状**：`src/tools/index.ts:474-525`（grep）、`:335-363`（glob）：手写 `readdirSync` 递归；只跳过以 `.` 开头的项与字面量 `node_modules`/`.git`；不解析 `.gitignore`；深度上限 12/14；单文件 3MB 上限；纯 JS 匹配。
本机**未安装 `rg`**（`which rg` 为空，只有 git 2.50.1），所以不能把方案押在 ripgrep 上。

**方案（三档后端，按可用性选择）**：
1. **有 `rg`**：优先 `rg --json`/`--line-number --no-heading`（只读检索），天然守 ignore、含隐藏文件、速度快；解析其输出。
2. **在 git 工作区内**：用 git 做「文件枚举」——`git ls-files -co --exclude-standard`（tracked + untracked、排除 ignored），再：
   - grep：对枚举出的文件跑现有 JS 正则匹配（**保持 JS 正则语义不变**，避免 git grep 的 POSIX ERE 方言差异）；
   - glob：对枚举结果做现有 `globToRegExp` 匹配 + mtime 排序。
   这样 ignore 语义、隐藏文件、性能三件事一次解决，且正则行为零变化。
3. **非 git 目录**：保留 JS 递归，但接入最小 `.gitignore` 匹配器（新模块 `src/tools/gitignore.ts`）：支持注释、`!` 反选、尾 `/` 目录、前导 `/` 锚定、`**`；逐级读取 `.gitignore`；默认跳过 `.git`，不再跳过隐藏文件。
4. 参数保持兼容：`pattern/path/glob/ignore_case/limit`；输出格式不变；`node_modules` 只有在被 ignore 时才排除（git 项目默认如此）。

**测试**：`tests/search-ignore.test.ts`：
- 临时 git 仓库：`.gitignore` 忽略 `ignored/`，其中放 `SECRET_MARKER` → grep/glob 均不命中；
- 隐藏目录 `.github/w.yml` → 能被 grep/glob 找到；
- `dist/`、`node_modules/` 被忽略时不扫；
- 非 git 目录（mkdtemp 不 init）：`.gitignore` 仍生效（fallback 分支）；
- 正则语义回归：`\d`、`(?=...)` 等 JS 特性仍工作（证明没换方言）；
- 本仓库自扫对照：命中文件数变化只应来自「被 ignore 的目录不再扫」。

**风险**：git 枚举在子目录调用时路径前缀处理；工作区很大时 `ls-files` 输出量 → 直接流式读取、按 limit 早停。
**验收**：以上用例 + 大仓库冒烟（在 node_modules 重的目录跑一次，记录前后耗时）。

---

## 5. P0-4：最小检查点 + `/undo`（写文件可恢复）

**现状**：`write_file`/`edit_file` 直接 `writeFileSync`（`tools/index.ts:169,225`），无备份、无 diff、abort 只回滚消息；shell 改文件完全不可追。

**方案（明确边界：只覆盖 neo 自己的写工具，不覆盖 shell）**：
1. 新增 `src/checkpoint.ts`：`CheckpointStore`
   - 目录：`<cwd>/.neo/backups/<sessionId>/`；
   - `beforeWrite(absPath)`：文件已存在则复制快照为 `<seq>-<basename>`；新文件记 `existed=false`；追加 manifest（JSONL：seq/path/rel/op/existed/at/size）；
   - 保留最近 100 条，超出删最老（含快照文件）；
   - 崩溃安全：manifest 逐行追加，读到坏行跳过。
2. 接入：`write_file` / `edit_file` 在**审批通过后、写盘前**调用 `ctx.checkpoint?.beforeWrite(path)`；`ToolCtx` 增加可选 `checkpoint`（测试裸 ctx 不传 → 行为不变）。
3. 命令：`/undo [n]`（默认 1，恢复最近 n 次写操作：还原内容或删除新建文件）、`/checkpoints [n]`（列出最近记录）。更新 HELP。
4. `.gitignore` 增加 `.neo/backups/`。
5. 明示限制（HELP + 文档）：shell 修改、外部进程修改不在恢复范围；不做目录级 rewind。

**测试**：`tests/checkpoint.test.ts`：
- 修改已有文件 → `/undo` 后字节级还原；
- 新建文件 → `/undo` 删除；
- 两次操作 → `/undo 2` 按逆序还原；
- 审批被拒 → 不产生快照；
- 101 次操作 → 只保留 100，最老快照被清理；
- manifest 被截断/写坏一行 → 仍能读出其余记录。

**风险**：磁盘占用（100 × 文件大小）→ 单文件 >2MB 时只记 manifest 不复制（提示「过大未快照」），或按总配额 50MB 裁剪；计划里先做条目上限，配额作为验收项观察。

---

## 6. P0-6：`-p` 结构化输出 + 正确退出码

**现状**：`src/index.ts:727-750` 单次模式只输出文本；无 `--output-format`；LLM 失败 `hadError` 被 `void` 掉，函数仍 `return 0`；非 TTY 下审批一律拒绝（不 `-y` 只能读）。

**方案**：
1. `--output-format text|json`（默认 text；仅 `-p` 有效）。json 模式：
   - **stdout 只输出一行 JSON**；所有 UI/工具/流式输出重定向到 stderr（复用 `ConsoleDeps.write` + `stdoutIsTTY=false`）；
   - 错误也只进 stderr，stdout 保持可解析。
2. JSON schema（v1，稳定）：
   ```json
   {"v":1,"ok":true,"exit_code":0,"answer":"...","error":null,
    "finish_reason":"stop","aborted":false,"duration_ms":1234,
    "usage":{"prompt":0,"completion":0,"reasoning":0},
    "tool_calls":3,"iterations":5,"model":"...","provider":"...","session_id":"..."}
   ```
   失败时 `ok=false`、`error` 为人类可读原因、`answer` 可为部分文本。
3. 退出码：成功 0；LLM/agent 失败 1；配置/用法错误 2；用户 abort 130。`TurnStats` 增加 `hadError/error` 字段（agent 里当前 `void hadError` 改为写入统计）。
4. 非 TTY 审批行为不变（拒绝 + 提示用 `-y`），但在 HELP 里写明自动化场景的推荐组合：`-p --output-format json -y`。
5. 更新 `--help` 与 docs。

**测试**：`tests/cli-json.test.ts`：
- 用 `scripts/fake-llm.ts` 起本地假服务，spawn `bun src/index.ts -p ... --output-format json`：stdout 单行可 parse、字段齐全、exit 0；
- 服务端 400/500（重试耗尽）→ exit 1、`ok=false`、stderr 有原因；
- `-p` 缺参 → exit 2；
- text 模式输出与现在一致（回归）；
- abort（发送 SIGINT / 让 fake 服务挂起）→ 130 且 stdout 仍可解析。

**风险**：`-p` 输出被现有 PTY/测试依赖 → 先 `grep` 全仓 `-p` 用例，逐条确认 text 模式不变。
**验收**：以上用例 + `bash scripts/verify.sh` 全绿。

---

## 7. 统一验收与交付

每个 P0 完成后：
1. `bunx tsc --noEmit` → 0 错误；
2. `bun test` → 全绿（新增用例计入总数，预计 881 → 920+）；
3. 该 P0 的专项验收脚本/用例通过；
4. 独立 commit（中文 conventional message，如 `fix(p0-search): grep/glob 尊重 .gitignore 并纳入隐藏文件`）。

全部完成后：
5. `bash scripts/verify.sh`（tsc + 全量 + PTY 19 场景）ALL GREEN；
6. 用**独立审计子代理**复验 6 项（每项给一个反例探针），防止「自己改自己验」的盲区；
7. 在 `docs/neo-vs-claude-code-20261026.md` 追加「修复状态」一节，逐项标注文件/测试/commit；
8. 汇总一条 release note 草稿（v0.3.5: P0 加固），不自动改版本号/不 push（等你确认）。

## 8. 需要你拍板的 3 件事（默认值已在方案里）

1. **P0-5 后端**：本机没有 `rg`。默认「有 rg 用 rg，否则 git 枚举 + JS 正则，非 git 目录用内置 .gitignore 匹配器」，不新增运行时依赖。若你愿意 `brew install ripgrep`，性能会更好，但非必需。
2. **P0-4 范围**：默认只覆盖 neo 的 `write_file`/`edit_file`（shell 改动不追），保留最近 100 条（单文件 >2MB 不复制、只记录）。是否要扩大到「shell 前 git stash」？（不推荐：侵入大、误伤多。）
3. **提交方式**：默认每个 P0 独立本地 commit，最后不 push、不改 package.json 版本；需要我直接推/发版再说。

---

## 9. 执行结果（2026-10-26，已全部完成）

| 项 | 状态 | commit | 验收 |
|---|---|---|---|
| P0-3 `edit_file` 的 `$&` | ✅ 完成 | `c0d8443` | 5 种替换模式 + replace_all 用例；全量通过 |
| P0-1 LLM 重试/超时 | ✅ 完成 | `0c90a2e` | `tests/llm-retry.test.ts` 9 场景（5xx/4xx/429/连接超时/空闲超时/中途断流/用户 abort/退避 abort）|
| P0-2 压缩保留近期原文 | ✅ 完成 | `46faaa0` | 保留 ≥6 条、不拆 tool 配对、长输入、usage 入账；compact-ctx 全绿 |
| P0-5 grep/glob 守 .gitignore | ✅ 完成 | `cf324b9` | git/非 git 双后端、隐藏文件、JS 正则语义、软链遍历回归 |
| P0-4 checkpoint/undo | ✅ 完成 | `6c10784` | 还原/删除/逆序/裁剪/坏行/越界/超大文件 8 场景；`/undo`、`/checkpoints` 已登记 |
| P0-6 `-p` JSON + 退出码 | ✅ 完成 | `795fe31` | 真 CLI spawn：成功 0 / 失败 1 / 用法 2；stdout 单行无 ANSI；text 回归 |

**最终验证**：`bash scripts/verify.sh` → `ALL GREEN`（tsc 0 错误；`bun test` **925 pass / 0 fail**，57 文件；PTY e2e **19/19**）。基线 881 → 925（+44 个用例）。

**独立复验**：审计子代理跑对抗探针后报告 2 个回归（压缩短历史、grep 依赖树）+ 5 个边界问题；已在 `7f15747` 修复并复跑探针（P0-1 36/36、P0-2 13/13、P0-5 23/23、P0-6 18/18）。

**与计划的偏差**：
- P0-5 未安装 ripgrep（本机原本没有），按默认方案用 git 枚举 + 内置匹配器；有 rg 时未做加速分支（避免引入未在本机验证的代码路径）。
- P0-4 未扩大 shell 覆盖（按拍板默认值）。
- 未改 `package.json` 版本、未 push；release note 草稿见 `docs/release-notes/v0.3.5.md`。
- 独立审计子代理的复验报告在 `/tmp/p0-verify/report.md`；其指出的预存在 bug「真 TTY 下 `-p` 零输出」也已顺带修复（非本次 6 项范围，单独说明）。
