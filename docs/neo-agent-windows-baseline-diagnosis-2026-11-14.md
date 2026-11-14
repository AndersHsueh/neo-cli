# neo-agent Windows 基线测试失败诊断（2026-11-14）

> **本文档性质**：单一只读诊断基线，**不是验收报告，不包含任何「通过」结论**。
> 目的：为后续「同环境前后对比」建立可核对的失败分类基线，使用户要求的「已知及新发现的 BUG 都已修复、相关验证全部通过」能被诚实判定——必须能区分「改动前就存在的环境性失败」与「本轮改动新增的失败」。
> 本阶段**未重跑 `bun test`**、未修改任何 `src/`、`tests/`、配置、`web/` 或其它 `docs/` 文件，未提交 git。

---

## 1. 基线事实

| 项 | 值 |
| --- | --- |
| 唯一数据源 | `D:/projects/neo-cli/docs/evidence/baseline-windows-2026-11-14-tests.txt` |
| 采集命令 | `bun test`（证据第 1 行 `$ bun test`） |
| bun 版本 | `bun test v1.3.6 (d530ed99)`（证据第 2 行） |
| 文件行数 | 3715 行（`wc -l`；末行为文件结束换行，Read 显示至第 3716 行） |
| 执行结果 | `1879 pass` / `5 skip` / `106 fail` / `5 errors`（证据 3709–3712 行） |
| 其它统计 | `6258 expect() calls`；`Ran 1990 tests across 115 files. [234.69s]`（3713–3714 行） |
| 退出状态 | `error: script "test" exited with code 1`（3715 行） |
| **采集对象（任务给定）** | 干净基线 main `a2858ae`，**未含本轮 #52 / #59 / #37 改动** |
| 运行环境 | Windows（`C:\Users\Anders\AppData\Local\Temp\...` 临时目录、反斜杠路径、`tests\xxx.test.ts:` 文件头） |

### 1.1 证据文件结构（解析 106 条的关键）

文件把每一条失败输出了**两遍**，直接按 `(fail)` 计数会得到 212，必须去重：

| 区段 | 行号 | 内容 | `(fail)` 行数 |
| --- | --- | --- | --- |
| 执行过程区 | 1–3586 | 按测试文件逐条输出 `(pass)` / `(fail)` / `(skip)`，失败前后带源码行、`error:`、`Expected`/`Received`、堆栈 | **106** |
| skip 汇总 | 3588–3593 | `5 tests skipped:` 重列 5 条 skip | 0 |
| fail 汇总 | 3596–3707 | `106 tests failed:` 重列 106 条 fail，其中夹 5 行 `^ this test timed out after ...` | **106** |
| 总计 | 3709–3715 | pass / skip / fail / errors / expect calls / Ran / exit code | — |

程序化校验结果：`total=212 exec=106 summary=106`，执行区 `pass=1879`、`fail=106`，与末尾统计完全吻合。**去重后唯一失败用例 = 106**，无遗漏、无重复计入。

> 本文档第 2 节表格的「证据行号」一律指**执行过程区**行号（该处才有可引用的错误堆栈）。汇总区对应行见 3597–3707。

### 1.2 采集环境核对项（需主理人在最终前后对比前确认）

以下为证据文件内部可见信息，与任务描述并不矛盾，但会直接影响前后对比的可比性，故如实记录：

- 所有堆栈路径为 `D:\projects\neo-cli\.neo\worktrees\issue-52\tests\...`，即测试实际运行在 **`.neo\worktrees\issue-52` 这个 worktree 目录**下，而非仓库根目录。
- 第 5 条失败（K1 环境自检）打印的 `git worktree list` 为：
  `D:/projects/neo-cli a2858ae [main]` 与 `D:/projects/neo-cli/.neo/worktrees/issue-52 a2858ae [neo/52-defaults-drive-exit]`。
  两者 **commit 同为 `a2858ae`**，与「干净基线」一致；但运行目录与分支名不同。
- 证据中未见 bun 安装方式、Windows 开发者模式是否开启、是否以管理员权限运行；大量 `EPERM: ... symlink` 表明采集时**无创建符号链接的权限**。
- **结论要求**：最终重跑必须在同一台机器、同一工作目录（含 worktree 布局）、同一 bun 版本、同一命令下执行，否则第 4/5 类路径相关用例结果不可比。

### 1.3 其它客观事实（不得省略）

- 执行区出现 5 行 `timed out`（对应汇总区 3610 / 3617 / 3623 / 3638 / 3644），与末尾 `5 errors` 数量一致。
- 执行区多处出现 `killed 1 dangling process`（如 1237、1571 行）及 `# Unhandled error between tests`（1575 行，内容 `Expected: 1` / `Received: 143`）。说明存在**子进程残留与超时**，可能污染后续用例，属前后对比必须控制的抖动源。

---

## 2. 全部 106 条失败用例可机读清单

**列定义**：`编号 | 测试文件 | 测试组 | 用例名（已剥离尾部 [耗时ms]） | 执行区行号 | 根因分类码 | 定性码 | 判定依据（关键错误文本）`

**根因分类码**：
`A` = Windows 软链/symlink EPERM（含其连锁的 ENOENT/lstat 与 createdLink 断言）；`B` = hook / LSP / JSON-RPC；`C` = 子进程/spawn/孤儿回收；`D` = SIGINT/信号；`E1` = POSIX 权限位 0o600；`E2` = Windows 路径/分隔符/夹具路径假设；`E3` = git ignore 行为；`E4` = 功能断言/疑似产品缺陷。

**定性码**：`E` = 纯环境性；`P` = 可能与产品代码/配置缺陷相关；`R` = 需进一步复现才能定性。

| # | 测试文件 | 测试组 | 用例名 | 行号 | 类 | 定性 | 判定依据（关键错误文本） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | tests\b4-tools.test.ts | D1 超长输出落盘 | 截断时把完整输出写到 NEO_TMP_DIR 并给出路径（0600） | 83 | E1 | E | `Expected: 384`(0o600) / `Received: 438`(0o666)；Windows 无 POSIX mode bits |
| 2 | tests\boot-noise.test.ts | issue #18-1/3 诊断只写日志 | TUI 通道不含前置探测提示与「未探测到」（只有日志通道有） | 156 | E2 | P | `ENOENT ... boot\C:\...\boot\2026-11-14.jsonl`；绝对路径被二次拼接（测试 152 行 `bootLogFile(...).split("/").pop()` 切不开反斜杠），需核对 `bootLogFile()` 返回值契约 |
| 3 | tests\checkpoint.test.ts | CheckpointStore（P0-4） | 指向工作目录外的软链不快照（避免 /undo 写穿仓库） | 198 | A | E | `EPERM: operation not permitted, symlink` |
| 4 | tests\cli-json.test.ts | P0-6 -p --output-format json | SIGINT 中断：仍输出 JSON、aborted=true、exit 130 | 220 | D | E | `Expected: 130` / `Received: 1`；Windows 无 POSIX SIGINT→130 退出码语义 |
| 5 | tests\gitignore-rules.test.ts | K. .gitignore 约束（PRD §6.5） | K1 环境自检：worktree 完好且 git 可用（环境坏了直接 fail，不得跳过） | 536 | E2 | E | `Expected to contain: "D:\\projects\\...\\issue-52"` / `Received: "D:/projects/..."`；反斜杠 vs 正斜杠 |
| 6 | tests\gitignore-rules.test.ts | K. .gitignore 约束（PRD §6.5） | K3 决策 4：项目私有技能目录未被忽略（不能写裸 `skills/`） | 551 | E3 | P | `Expected: "skills/=false"` / `Received: "skills/=true"`；`git check-ignore` 结果与 PRD §6.5 决策 4 冲突 |
| 7 | tests\gitignore-rules.test.ts | K. .gitignore 约束（PRD §6.5） | K4.1 决策 4 的技术边界：git 对穿过软链的 pathspec 直接 fatal，不做忽略匹配 | 562 | A | E | `EPERM: operation not permitted, symlink` |
| 8 | tests\hooks.test.ts | c PreToolUse 阻断 | 退出码 2 + stdout 作为原因 | 590 | B | R | `Expected: "block"` / `Received: "ok"`；hook 为 `#!/bin/sh` 脚本（580 行 `script("block.sh", '#!/bin/sh...')`） |
| 9 | tests\hooks.test.ts | c PreToolUse 阻断 | 退出码 2 + JSON reason 优先于纯文本 | 604 | B | R | `Expected: "block"` / `Received: "ok"` |
| 10 | tests\hooks.test.ts | c PreToolUse 阻断 | hook 能从 stdin 读到事件 JSON | 620 | B | R | `Expected: "block"` / `Received: "ok"`；`ENOENT ... .tmp-hooks-...` |
| 11 | tests\hooks.test.ts | c PreToolUse 阻断 | dispatchHooks 遇阻断立刻停，后续 hook 不再执行 | 634 | B | R | `Expected: true` / `Received: false` |
| 12 | tests\hooks.test.ts | e PostToolUse | 成功与失败都触发，载荷带 ok / result | 652 | B | R | `Expected: true` / `Received: false` |
| 13 | tests\hooks.test.ts | e PostToolUse | onFailure=continue：失败只给诊断，不阻断（工具结果照常回填） | 653 | B | R | `Expected: true` / `Received: false`；`timed out after 5000ms`（5015ms） |
| 14 | tests\hooks.test.ts | e PostToolUse | onFailure=block：失败升级为阻断，原因回给模型 | 668 | B | R | `Expected to contain: "格式检查器崩了"` / `Received: "    1\thello"` |
| 15 | tests\hooks.test.ts | f TurnEnd | 主代理回合结束触发一次，载荷带 turn_stats | 693 | B | R | `ENOENT: no such file or directory, open ... turnend.log`（hook 未落盘） |
| 16 | tests\hooks.test.ts | f TurnEnd | -p 单次模式（nonInteractive）同样触发 | 707 | B | R | `Expected: true` / `Received: false` |
| 17 | tests\hooks.test.ts | g 失败隔离 | 超时被杀，且不留孤儿子进程 | 721 | B | R | `Expected: "timeout"` / `Received: "ok"` |
| 18 | tests\hooks.test.ts | g 失败隔离 | PreToolUse 的 hook 崩溃不阻断工具（默认 continue 语义） | 736 | B | R | `Expected to contain: "退出码 7"` / `Received: ""` |
| 19 | tests\hooks.test.ts | i 子代理 | 子代理的工具调用触发 Pre/PostToolUse，但 TurnEnd 不触发 | 740 | B | R | `Expected to contain: "退出码 7"` / `Received: ""`；`timed out after 5000ms`；`killed 1 dangling process` |
| 20 | tests\hooks.test.ts | k TurnEnd onFailure=block | block：失败原因并进 errorMessage 并标 hadError（-p 因此非 0 退出） | 793 | B | R | `Expected: true` / `Received: false` |
| 21 | tests\hooks.test.ts | k TurnEnd onFailure=block | continue（默认）：失败只给诊断，不改 hadError / 退出码 | 807 | B | R | `Expected to contain: "轮末检查失败"` / `Received: ""` |
| 22 | tests\hooks.test.ts | k TurnEnd onFailure=block | 退出码 2 在 TurnEnd 上同样视为明确要求阻断（与 onFailure 无关） | 821 | B | R | `Expected: true` / `Received: false` |
| 23 | tests\hooks.test.ts | l 连续失败计数对没执行保持中性 | 最小序列 3：失败 + Pre 阻断 → streak = 1 | 838 | B | R | `Expected to contain: "拦截"` / `Received: "$ touch ...\n[exit 0]"` |
| 24 | tests\hooks.test.ts | l 连续失败计数对没执行保持中性 | 三种 notExecuted 来源都中性：用户拒绝 / plan 拒绝 / Pre 阻断 | 840 | B | R | 同 #23；`timed out after 5000ms`；`killed 1 dangling process` |
| 25 | tests\hooks.test.ts | l 连续失败计数对没执行保持中性 | MCP 工具被拒绝 / 被阻断同样中性，且远端一次都没被调 | 860 | B | R | `toEqual`: Expected `[]` / Received `["called"]`（远端被调） |
| 26 | tests\lsp.test.ts | issue #23 LSP | configure：启动假 server，状态 connected | 924 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-IyS0ly'` |
| 27 | tests\lsp.test.ts | issue #23 LSP | 编辑后诊断：文件含 BROKEN → 注入 error 摘要；干净文件 → 空串 | 940 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-JVOCYN'` |
| 28 | tests\lsp.test.ts | issue #23 LSP | lsp 工具：definition / references / hover；未配置时明确报错 | 950 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-D9FDCl'` |
| 29 | tests\lsp.test.ts | issue #43 LSP 扩展 | E1 server→client 请求必须应答（workspace/configuration），否则真实 server 挂住 | 961 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-ORd4U7'` |
| 30 | tests\lsp.test.ts | issue #43 LSP 扩展 | E2 workspaceSymbol：不需要 line，query 透传，结果按位置列出 | 971 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-VwdPqa'` |
| 31 | tests\lsp.test.ts | issue #43 LSP 扩展 | E3 workspaceSymbol：结果超上限时截断并标注总数 | 981 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-xuoaUx'` |
| 32 | tests\lsp.test.ts | issue #43 LSP 扩展 | E4 callHierarchy：两段式（prepare + incomingCalls），item 原样回传 | 991 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-jifcgx'` |
| 33 | tests\lsp.test.ts | issue #43 LSP 扩展 | E5 callHierarchy：direction=outgoing 走 outgoingCalls | 1001 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-nrw5Le'` |
| 34 | tests\lsp.test.ts | issue #43 LSP 扩展 | E6 callHierarchy：direction 缺省 = incoming；非法值报可读错误 | 1011 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-UYsduM'` |
| 35 | tests\lsp.test.ts | issue #43 LSP 扩展 | E7 completion：返回候选并截断到上限，标注总数与 isIncomplete | 1021 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-ZQENVU'` |
| 36 | tests\lsp.test.ts | issue #43 LSP 扩展 | E8 line 改可选：workspaceSymbol 不需要 line；其余 operation 缺 line 仍报错 | 1031 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-ww6MtN'` |
| 37 | tests\lsp.test.ts | issue #43 LSP 扩展 | E9 未知 operation 的报错列出全部可用值 | 1041 | B | E | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-IGYdTb'` |
| 38 | tests\mcp.test.ts | f. JSON-RPC 客户端 | 服务端错误码转成 RpcError（带 code） | 1238 | B | R | `timed out after 5000ms`（5016ms）；`killed 1 dangling process`；无断言错误文本 |
| 39 | tests\memory-capture.test.ts | B merge 落页规则 | B7 页面超限转续页 | 1354 | E4 | P | `Expected: "split"` / `Received: undefined`；16ms 纯逻辑断言，未见环境特征 |
| 40 | tests\oneshot-cleanup.test.ts | B -p 退出后不留孤儿（issue #40） | B1 模型发起 shell background:true → -p 退出后子进程已死 | 1525 | C | R | `Expected: true` / `Received: false`（10219ms） |
| 41 | tests\oneshot-cleanup.test.ts | B -p 退出后不留孤儿（issue #40） | B2 非交互 args.rest 路径同样回收（不是只有 -p 走清理） | 1539 | C | R | `Expected: true` / `Received: false`（10078ms，`waitPidsAppear(marker)`） |
| 42 | tests\oneshot-drive.test.ts | D 集成（issue #51） | D2 两轮场景：第 1 轮检查失败 → 第 2 轮通过 → exit 0，摘要 source=verified | 1570 | C | R | `Expected: 0` / `Received: 1`（1750ms） |
| 43 | tests\oneshot-drive.test.ts | D 集成（issue #51） | D3 轮次耗尽 → exit 1，摘要 status=exhausted source=none | 1572 | C | R | `Expected: 1` / `Received: 143`(SIGTERM)；`timed out after 60000ms`；`# Unhandled error between tests` |
| 44 | tests\output-probe.test.ts | C1 配置解析：非法形状回落默认关闭，不抛错 | loadConfig 把两种写法都解析到 provider.outputProbe | 1617 | E2 | P | `ENOENT: ... chdir '...\issue-52\' -> 'C:\...\case-1\settings.jso'`；`process.chdir` 目标被当成配置文件路径 |
| 45 | tests\references.test.ts | C3b 展开 | 内容附在原文之后，带起止标记与行数 | 1867 | E4 | P | `Expected to contain: "——— a.ts（1 行）———"` / `Received: "看 @a.ts"`（展开未生效） |
| 46 | tests\references.test.ts | C3b 展开 | 重复引用只展开一次 | 1881 | E4 | P | `refs.length` `Expected: 1` / `Received: 0` |
| 47 | tests\references.test.ts | C3b 展开 | 二进制文件跳过并报错 | 1896 | E4 | P | `Expected to contain: "二进制"` / `Received: "@bin.dat 不存在，按原文保留"` |
| 48 | tests\references.test.ts | C3b 展开 | 单文件超行数上限：截断并标注 | 1906 | E4 | P | 同 #47；`TypeError: undefined is not an object (evaluating 'r.refs[0].truncated')` |
| 49 | tests\references.test.ts | C3b 展开 | 最多 5 个文件：多余的报「未展开」 | 1920 | E4 | P | `Expected: 5` / `Received: 0` |
| 50 | tests\references.test.ts | C3b 展开 | 超预算的文件按剩余预算截断（PRD C3：截断并标注，不是整份丢弃） | 1934 | E4 | P | `Expected: 1` / `Received: 0` |
| 51 | tests\references.test.ts | C3b 展开 | 预算耗尽后剩下的引用报错跳过 | 1948 | E4 | P | `Expected: 1` / `Received: 0` |
| 52 | tests\references.test.ts | C3c 路径解析相对 cfg.cwd（-C 场景） | 相对路径按 opts.cwd 解析，而不是 process.cwd() | 1963 | E2 | R | `Expected: "/work/proj/a.ts"` / `Received: "\work\proj\a.ts"`；路径分隔符差异，也需核对产品路径口径 |
| 53 | tests\skill-slash.test.ts | S2 tryLoadSkillForSlash | S2.1 命中技能：返回正文与绝对路径附件 | 2234 | E4 | P | `Expected: true` / `Received: false`；需复现确认是否受 skills 软链建立失败影响 |
| 54 | tests\skills-cli.test.ts | L 组/skills 斜杠命令（PRD §6.6） | L4 标注软链状态：项目区软链显示「软链」，真目录不显示 | 2263 | A | E | `EPERM: operation not permitted, symlink` |
| 55 | tests\skills-cli.test.ts | O 组 isRealDir 的软链判定 | O1 软链到目录必须被递归展开，而不是当成附件只列名字 | 2281 | A | E | `EPERM: operation not permitted, symlink` |
| 56 | tests\skills-cli.test.ts | O 组 isRealDir 的软链判定 | O2 软链到目录与真实目录产出等价的清单形态 | 2292 | A | E | `EPERM: operation not permitted, symlink` |
| 57 | tests\skills-cli.test.ts | O 组 isRealDir 的软链判定 | O3 四类条目齐备：真实目录/软链到目录/软链到文件/断链软链 | 2303 | A | E | `EPERM: operation not permitted, symlink` |
| 58 | tests\skills-cli.test.ts | O 组 isRealDir 的软链判定 | O4 statSync 不可用时（断链）不得抛异常，静默列为附件 | 2314 | A | E | `EPERM: operation not permitted, symlink` |
| 59 | tests\skills-command.test.ts | L1 /skills 列出全部技能 | L1.2 标注来源（全局/项目）与软链状态 | 2328 | A | E | `EPERM: operation not permitted, symlink` |
| 60 | tests\skills-command.test.ts | L2 约束 16 —— /skills 不加载 SKILL.md 全文 | L2.4 详情输出含 name/description/source/path 四要素 | 2349 | E2 | R | `toMatch(/路径\s+\S+\/pdf/)` 期望正斜杠；`Received` 为 `C:\Users\...` 反斜杠路径 |
| 61 | tests\skills.test.ts | B. discoverSkills | B9 项目区软链也能被发现：linked=true，absPath 已解析软链 | 2384 | A | E | `EPERM: operation not permitted, symlink` |
| 62 | tests\skills.test.ts | C. resolveSkill | C1 合法名，项目已有软链 → ok:true, createdLink:false | 2394 | A | E | `EPERM: operation not permitted, symlink` |
| 63 | tests\skills.test.ts | C. resolveSkill | C2 合法名，store 有、项目软链已由上次调用建立 → createdLink:false | 2408 | A | E | `Expected: true` / `Received: false`（前置 symlinkSync 未建成，连锁） |
| 64 | tests\skills.test.ts | C. resolveSkill | C3 合法名，仅 store 有，首次调用 → createdLink:true 且软链落地为绝对路径 | 2422 | A | E | `Expected: true` / `Received: false`（前置 symlinkSync 未建成，连锁） |
| 65 | tests\skills.test.ts | C. resolveSkill | C4 重复调用 → createdLink:false，不报错，软链不被重建 | 2432 | A | E | `ENOENT: ... lstat '...\skills\pdf'`（软链未建成） |
| 66 | tests\skills.test.ts | C. resolveSkill | C11 项目区无 skills 目录时自动创建并落地软链 | 2448 | A | E | `ENOENT: ... lstat '...\skills\auto'` |
| 67 | tests\skills.test.ts | E. use_skill 工具 | E7 首次调用后软链被创建（lstatSync.isSymbolicLink） | 2475 | A | E | `ENOENT: ... lstat '...\skills\auto'`（连锁） |
| 68 | tests\skills.test.ts | F. symlink 遍历修复 | F1 glob skills/**/*.md 能列出软链内的 SKILL.md（修复前为空） | 2498 | A | E | `EPERM: operation not permitted, symlink` |
| 69 | tests\skills.test.ts | F. symlink 遍历修复 | F2 grep 从 cwd 递归能命中软链内文件，输出含 SKILL.md:行号: | 2516 | A | E | `EPERM: operation not permitted, symlink` |
| 70 | tests\skills.test.ts | F. symlink 遍历修复 | F3 list_dir skills 把软链显示为 pdf/（带尾斜杠） | 2534 | A | E | `EPERM: operation not permitted, symlink` |
| 71 | tests\skills.test.ts | F. symlink 遍历修复 | F4 list_dir skills recursive 能列出软链内文件 | 2552 | A | E | `EPERM: operation not permitted, symlink` |
| 72 | tests\skills.test.ts | F. symlink 遍历修复 | F6 不破坏普通文件遍历：指向文件的软链仍能被 glob 匹配（P1 回归防护） | 2570 | A | E | `EPERM: operation not permitted, symlink` |
| 73 | tests\skills.test.ts | F. symlink 遍历修复 | F7 指向文件的软链仍能被 grep 命中（P1 回归防护） | 2587 | A | E | `EPERM: operation not permitted, symlink` |
| 74 | tests\skills.test.ts | F. symlink 遍历修复 | F8 system prompt 工作目录树把 skills/pdf 显示为目录（§5 第 4 处） | 2598 | A | E | `EPERM: operation not permitted, symlink` |
| 75 | tests\skills.test.ts | G. 写工具软链守卫 | G1 write_file 写向软链内 → ok:false，含「禁止写入全局技能库」 | 2616 | A | E | `EPERM: ... symlink`（setup 阶段建链失败） |
| 76 | tests\skills.test.ts | G. 写工具软链守卫 | G2 edit_file 改软链内文件 → ok:false，含「禁止写入全局技能库」 | 2634 | A | E | `EPERM: operation not permitted, symlink` |
| 77 | tests\skills.test.ts | G. 写工具软链守卫 | G3 守卫触发时不调用 approve（约束 12：守卫必须在 approve 之前） | 2652 | A | E | `EPERM: operation not permitted, symlink` |
| 78 | tests\skills.test.ts | G. 写工具软链守卫 | G4 正常写项目文件 → ok:true（守卫不误伤） | 2670 | A | E | `EPERM: operation not permitted, symlink` |
| 79 | tests\skills.test.ts | G. 写工具软链守卫 | G6 守卫抛 ToolError 而非字符串 → dispatch 转 ok:false | 2689 | A | E | `EPERM: operation not permitted, symlink` |
| 80 | tests\skills.test.ts | G. 写工具软链守卫 | G7 约束 13：新文件（父目录存在、文件不存在）同样被拒 | 2707 | A | E | `EPERM: operation not permitted, symlink` |
| 81 | tests\skills.test.ts | G. 写工具软链守卫 | G8 守卫必须用 realpath 而非字符串比较（P2：路径必须来自 cfg.skillsStore） | 2725 | A | E | `EPERM: operation not permitted, symlink` |
| 82 | tests\skills.test.ts | I. 端到端集成 | I1 完整流程：建 store 技能 → 发现 → 进 prompt → use_skill → 文件真实变更 | 2745 | A | E | `ENOENT: ... lstat '...\skills\pdf'`（前置软链未建成） |
| 83 | tests\skills.test.ts | I. 端到端集成 | I2 二次加载同一技能：createdLink:false，内容一致，不重复建链 | 2760 | A | E | `ENOENT: ... lstat '...\skills\pdf'` |
| 84 | tests\skills.test.ts | J. 测试隔离红线 | J3 软链指向目录时 statSync 可判定为目录（P1 修复依赖此行为） | 2773 | A | E | `EPERM: operation not permitted, symlink` |
| 85 | tests\symlink-traversal.test.ts | F1 glob 能穿过软链 | glob "skills/**/*.md" 从 cwd 能列出软链内的 SKILL.md | 2848 | A | E | `EPERM: operation not permitted, symlink` |
| 86 | tests\symlink-traversal.test.ts | F1 glob 能穿过软链 | glob 不因软链产生重复条目（同一文件只列一次） | 2866 | A | E | `EPERM: operation not permitted, symlink` |
| 87 | tests\symlink-traversal.test.ts | F2 grep 能穿过软链 | grep 从 cwd 递归能命中软链内文件并给出行号 | 2884 | A | E | `EPERM: operation not permitted, symlink` |
| 88 | tests\symlink-traversal.test.ts | F2 grep 能穿过软链 | grep 能扫到软链内的非 SKILL.md 附件 | 2902 | A | E | `EPERM: operation not permitted, symlink` |
| 89 | tests\symlink-traversal.test.ts | F3/F4 list_dir 把软链当目录 | F3 list_dir skills：软链显示为 foo/（带尾斜杠） | 2920 | A | E | `EPERM: operation not permitted, symlink` |
| 90 | tests\symlink-traversal.test.ts | F3/F4 list_dir 把软链当目录 | F4 list_dir skills recursive：能列出软链内文件 | 2938 | A | E | `EPERM: operation not permitted, symlink` |
| 91 | tests\symlink-traversal.test.ts | F5 真实目录遍历不被修复破坏 | glob "real/**/*.md" 对真目录同样有效 | 2956 | A | E | `EPERM: ... symlink`（公共 setup 建链失败，连真目录回归用例一并挂） |
| 92 | tests\symlink-traversal.test.ts | F5 真实目录遍历不被修复破坏 | grep 对真目录同样命中并给出行号 | 2974 | A | E | `EPERM: operation not permitted, symlink` |
| 93 | tests\symlink-traversal.test.ts | F5 真实目录遍历不被修复破坏 | list_dir 真目录仍按目录呈现并可递归 | 2992 | A | E | `EPERM: operation not permitted, symlink` |
| 94 | tests\symlink-traversal.test.ts | F6 system prompt 工作目录树把软链显示为目录 | 工作目录树含 skills/foo/ 且能递归到 skills/foo/SKILL.md | 3003 | A | E | `EPERM: operation not permitted, symlink` |
| 95 | tests\turn-reliability.test.ts | A1 状态归一与恢复告警 | appendTurnLog 在坏目录下返回 null 而不抛 | 3346 | E2 | R | `toBeNull()` / `Received: "\\proc\\definitely-not-writable\\turns\\2026-11-14.jsonl"`；夹具用 POSIX `/proc/...`，但产品返回路径而非 null，也需核对写入失败检测 |
| 96 | tests\worktree.test.ts | d. listManaged | 当前标记：cwd 经符号链接指向 worktree 内部时 current=true | 3456 | A | E | `EPERM: operation not permitted, symlink` |
| 97 | tests\worktree.test.ts | e. removeWorktree | cwd 经符号链接指向 worktree 子目录：同样拒绝删除 | 3473 | A | E | `EPERM: operation not permitted, symlink` |
| 98 | tests\worktree.test.ts | h. 软链路径下的托管清单 | listManaged：软链路径下也能列出托管 worktree | 3498 | A | E | `EPERM: ... symlink`（`makeLinkedRepo` 744 行 `symlinkSync`） |
| 99 | tests\worktree.test.ts | h. 软链路径下的托管清单 | ensureWorktree：软链路径下第二次是复用，不是「不是 neo 托管的」 | 3509 | A | E | `EPERM: operation not permitted, symlink` |
| 100 | tests\worktree.test.ts | h. 软链路径下的托管清单 | ensureWorktree：路径用软链写法、分支用真实路径写法，也能复用同一个 | 3520 | A | E | `EPERM: operation not permitted, symlink` |
| 101 | tests\worktree.test.ts | h. 软链路径下的托管清单 | removeWorktree：软链路径下能正常删除托管 worktree | 3531 | A | E | `EPERM: operation not permitted, symlink` |
| 102 | tests\worktree.test.ts | h. 软链路径下的托管清单 | orphanDirs：软链路径下不把真实托管目录误判成孤儿 | 3542 | A | E | `EPERM: operation not permitted, symlink` |
| 103 | tests\worktree.test.ts | h. 软链路径下的托管清单 | detectRepo：mainRoot 在软链路径下是 canonical 口径 | 3553 | A | E | `EPERM: operation not permitted, symlink` |
| 104 | tests\worktree.test.ts | h. 软链路径下的托管清单 | 安全断言：非托管目录即使路径归一后指向托管位置，也绝不覆盖 | 3564 | A | E | `EPERM: operation not permitted, symlink` |
| 105 | tests\worktree.test.ts | h. 软链路径下的托管清单 | 安全断言：软链路径下当前 worktree 仍不可删 | 3575 | A | E | `EPERM: operation not permitted, symlink` |
| 106 | tests\worktree.test.ts | h. 软链路径下的托管清单 | 安全断言：软链路径下脏工作区仍拒绝删除 | 3586 | A | E | `EPERM: operation not permitted, symlink` |

---

## 3. 分类汇总

### 3.1 按根因类型（主分类，互斥，合计 106）

| 分类码 | 类别 | 数量 | 占比 | 关键证据 / 说明 |
| --- | --- | --- | --- | --- |
| A | Windows 软链 / symlink EPERM（含连锁 ENOENT/lstat） | **53** | 50.00% | `EPERM: operation not permitted, symlink`；`symlinkSync` 被系统拒绝；连锁表现为 `ENOENT ... lstat` 与 `Expected: true / Received: false` |
| B | hook / LSP / JSON-RPC | **31** | 29.25% | hooks 18（`#!/bin/sh` 脚本、`Expected: "block" / Received: "ok"`、ENOENT log、超时）；LSP 12（`EBUSY: resource busy or locked, rm`）；mcp 1（5000ms 超时） |
| C | 子进程 / spawn / 孤儿回收 | **4** | 3.77% | `oneshot-cleanup` 2（约 10s 后 `waitPidsAppear` 为 false）、`oneshot-drive` 2（exit code 1 / 143 SIGTERM） |
| D | SIGINT / 信号 | **1** | 0.94% | `cli-json` `Expected: 130` / `Received: 1` |
| E1 | POSIX 权限位 0o600 | 1 | 0.94% | `Expected: 384` / `Received: 438` |
| E2 | Windows 路径 / 分隔符 / 夹具路径假设 | 6 | 5.66% | #2 #5 #44 #52 #60 #95；反斜杠 vs 正斜杠、绝对路径二次拼接、`/proc/...` 夹具 |
| E3 | git ignore 行为 | 1 | 0.94% | #6 `skills/=false` vs `skills/=true` |
| E4 | 功能断言 / 疑似产品缺陷 | 9 | 8.49% | #39 `#45–#51`（7 条 references 展开）`#53` |
| — | **其它小计（E1+E2+E3+E4）** | **17** | **16.04%** | — |
| — | **合计** | **106** | **100%** | — |

### 3.2 按定性三分（互斥，合计 106）

| 定性码 | 判定 | 数量 | 占比 |
| --- | --- | --- | --- |
| E | 纯环境性（Windows 权限 / 路径 / symlink 机制，证据可直接判定） | **68** | 64.15% |
| P | 可能与产品代码 / 配置缺陷相关（不得掩盖） | **12** | 11.32% |
| R | 需进一步复现才能定性 | **26** | 24.53% |

`E` 构成：A 类 53 + LSP EBUSY 12 + D 类 1 + E1 类 1 + E2 中 #5 共 1 = 68。
`P` 构成：#2、#6、#39、#44、#45–#51（7 条）、#53 = 12。
`R` 构成：hooks 18 + #38 + #40–#43（4 条）+ #52、#60、#95 = 26。

### 3.3 按测试文件（前 6 个文件占 84 条 = 79.2%）

| 测试文件 | 失败数 | 主要类别 |
| --- | --- | --- |
| tests\skills.test.ts | 24 | A（#61–#84） |
| tests\hooks.test.ts | 18 | B / R（#8–#25） |
| tests\lsp.test.ts | 12 | B / E（#26–#37） |
| tests\worktree.test.ts | 11 | A（#96–#106） |
| tests\symlink-traversal.test.ts | 10 | A（#85–#94） |
| tests\references.test.ts | 8 | E4 / E2（#45–#52） |
| tests\skills-cli.test.ts | 5 | A（#54–#58） |
| tests\gitignore-rules.test.ts | 3 | E2 / E3 / A（#5–#7） |
| tests\oneshot-cleanup.test.ts | 2 | C（#40–#41） |
| tests\oneshot-drive.test.ts | 2 | C（#42–#43） |
| tests\skills-command.test.ts | 2 | A / E2（#59–#60） |
| 其余 9 个文件各 1 条 | 9 | b4-tools / boot-noise / checkpoint / cli-json / mcp / memory-capture / output-probe / skill-slash / turn-reliability |
| **合计** | **106** | — |

### 3.4 「h. 软链路径下的托管清单」如实统计

- 证据文件中**不存在** `tests\worktree-managed.test.ts`；该组实际位于 **`tests\worktree.test.ts`**。
- `h. 软链路径下的托管清单` 组共 **9 条**（#98–#106，行 3498–3586），占 106 条的 **8.49%**。
- 连同同文件 `d. listManaged` / `e. removeWorktree` 各 1 条（#96、#97），`tests\worktree.test.ts` 共 **11 条（10.38%）**。
- 因此：**该组并非「占多数」**。真正占多数（53 条，50.00%）的是横跨 `checkpoint` / `gitignore-rules` / `skills-cli` / `skills-command` / `skills` / `symlink-traversal` / `worktree` **7 个文件**的 symlink/EPERM 类失败。
- 全部 9 条 h 组失败的错误文本均为 `EPERM: operation not permitted, symlink`，栈顶为 `makeLinkedRepo (worktree.test.ts:744:5)`，即测试夹具在准备阶段调用 `symlinkSync` 即被系统拒绝，**产品逻辑（软链路径下的托管清单/安全断言）根本没有被验证到**。

---

## 4. 结论

> 以下为**基于证据文本的初步判定**，不是最终定论；`P` 与 `R` 两类必须在受支持环境或 Windows 提权后复现，才能确认根因落在产品代码还是测试夹具。

### 4.1 纯环境性失败（68 条）——**不得笼统说成「无关紧要」**

可判为环境性的部分及依据：

1. **symlink/EPERM 53 条**：Windows 默认需要管理员权限或「开发者模式」才能创建符号链接；`symlinkSync` 在 setup 阶段即抛 `EPERM`，测试从未进入被测函数。7 条连锁失败（`ENOENT ... lstat`、`createdLink` 断言）同属此因。
2. **LSP 12 条**：`EBUSY: resource busy or locked, rm '<临时目录>'`，Windows 文件句柄未释放导致清理失败；同时也需确认假 server 子进程是否被正确关闭。
3. **SIGINT 1 条 / 0o600 1 条 / 路径分隔符 1 条**：Windows 无 POSIX 信号退出码语义、无 POSIX mode bits、`git worktree list` 用正斜杠而断言用反斜杠。

**但必须明确其风险，而不是把它们豁免掉**：

- 这 68 条红灯意味着相关功能（技能软链、软链遍历守卫、worktree 托管清单与**安全断言**、LSP、hook）在 Windows 上**完全没有被验证**，是**验证盲区**，不是「已通过」。
- 其中 `h. 软链路径下的托管清单` 的 3 条「安全断言」用例（#104–#106）验证的是「绝不覆盖 / 当前 worktree 不可删 / 脏工作区拒绝删除」等**安全边界**；它们在基线里是 fail 状态，不能因为「环境原因」就在验收叙事中被略过。
- 前后对比时，这 68 条**必须逐条核对**：一旦某条由 fail 变 pass、或由 pass 变 fail，都需要解释；不能整体上把它们从对比集合中剔除。

### 4.2 可能与产品代码 / 配置缺陷相关（12 条）——**不得掩盖成环境问题**

| # | 用例 | 为何不能归入纯环境性 |
| --- | --- | --- |
| 6 | K3 决策 4：`skills/` 未被忽略 | `git check-ignore` 返回 `skills/=true`，与 PRD §6.5「不能写裸 `skills/`」的决策直接冲突；指向 `.gitignore` 内容或忽略规则实现的配置/产品问题。 |
| 39 | B7 页面超限转续页 | `Expected: "split"` / `Received: undefined`，16ms 纯逻辑断言，无 EPERM/ENOENT/路径/信号等环境特征；疑似 merge 落页分支未返回预期状态。 |
| 2 | issue #18-1/3 诊断只写日志 | 绝对路径被二次拼进日志路径；测试侧 `split("/")` 无法切 Windows 反斜杠，但**同时需核对产品函数 `bootLogFile()` 的返回值契约**（应为文件名还是绝对路径）。属跨平台契约问题，不是纯权限问题。 |
| 44 | C1 配置解析 `loadConfig` | `process.chdir` 目标竟是 `...\case-1\settings.jso`（配置文件路径而非目录）；需确认是测试夹具构造错误还是配置加载路径处理缺陷。 |
| 45–51 | C3b 展开 7 条 | `expandReferences` 的解析组（C3a）5 条在基线中均为 `(pass)`，**展开组 7 条全部为 `(fail)`**：`refs.length=0`、`Received: "看 @a.ts"`、`@bin.dat 不存在，按原文保留`。这组失败与 symlink/权限无关，指向 @引用展开功能在 Windows 下整体失效；可能是测试依赖桩路径不兼容，也可能是产品代码的路径解析缺陷，**不得以「环境问题」结论带过**。 |
| 53 | S2.1 命中技能 | `Expected: true` / `Received: false`，无 EPERM 文本；需复现确认是技能加载缺陷还是受同期 skills 软链建立失败的连带影响。 |

**代表例子**：`#45「内容附在原文之后」`（`Expected to contain: "——— a.ts（1 行）———"` / `Received: "看 @a.ts"`）、`#39「B7 页面超限转续页」`（`Expected: "split"` / `Received: undefined`）、`#6「K3 决策 4」`（`skills/=false` vs `skills/=true`）。

### 4.3 需进一步复现才能定性（26 条）

| 组 | 数量 | 复现要点 |
| --- | --- | --- |
| hooks.test.ts（#8–#25） | 18 | 证据 580/594 行显示 hook 用 `#!/bin/sh ... exit 2` 脚本，Windows 无 POSIX shell 执行能力，`Expected: "block"` 变 `"ok"`、`turnend.log` ENOENT；**但**其中「超时被杀且不留孤儿」「hook 崩溃默认 continue」等用例本身就在验证产品进程管理，且伴随 3 次 `timed out` 与 `killed 1 dangling process`。需在受支持环境或改写为 `.cmd`/node 脚本后复现，才能区分「纯 POSIX 脚本依赖」与「`dispatchHooks` 在 Windows 的进程调用/超时处理缺陷」。 |
| mcp #38 | 1 | 5016ms 超时 + `killed 1 dangling process`，无断言文本；需确认是 JSON-RPC 假 server 未退出还是客户端未收敛错误码。 |
| oneshot-cleanup #40/#41、oneshot-drive #42/#43 | 4 | 4 条均为长耗时（1750ms / 10078ms / 10219ms / 60016ms），含 `waitPidsAppear` 失败、exit 143(SIGTERM)、`# Unhandled error between tests`；需在无残留子进程的干净环境复现，区分「Windows 进程树回收差异」与「产品 cleanup 逻辑缺陷」。 |
| #52 / #60 / #95 | 3 | 均为路径相关：#52 产品路径口径（`/` vs `\`）、#60 断言正则硬编码正斜杠、#95 夹具用 POSIX `/proc/...` 但产品 `appendTurnLog` 返回路径而非 null（可能暴露「未检测写入失败」）。需逐个复现定位根因在测试还是产品。 |

### 4.4 基线级风险声明

- 基线本身存在 **5 个 timed out / 5 errors / 多处 dangling process**，说明该轮运行带有 flaky 与子进程残留；**同一环境下重跑两次的结果也未必逐条一致**，前后对比必须允许并识别这类抖动，而不能把抖动误判为回归或修复。
- 12 条 `P` 类与 26 条 `R` 类合计 **38 条（35.85%）** 无法从证据文件直接定性。若最终验收把这些一律归为「Windows 环境问题」，则「已知及新发现的 BUG 都已修复」这一表述**无法被诚实支撑**。
- 本阶段**不做修复、不做验证、不出具通过结论**；106 个红灯全部保留。

---

## 5. 前后对比方法（同环境差集）

### 5.1 控制变量（必须全部一致，否则结果不可比）

| 变量 | 基线值 | 要求 |
| --- | --- | --- |
| 机器 / OS | Windows（本机 `Anders`） | 同一台物理机 |
| bun 版本 | `bun test v1.3.6 (d530ed99)` | 同一版本，不得升级 |
| 命令 | `bun test` | 同一命令、同一工作目录 |
| 工作目录 / worktree 布局 | 证据显示为 `D:\projects\neo-cli\.neo\worktrees\issue-52` | **必须与基线一致**；`git worktree list` 结果会影响 `gitignore-rules` K1 等用例 |
| symlink 权限 | 基线为无权限（EPERM） | 保持一致；若改用提权/开发者模式，须**单独标注为「环境变更」**，不得与本轮代码改动的效果混为一谈 |
| 临时目录 / 后台进程 | 基线存在 dangling process | 重跑前清理残留 `neo-*` 临时目录与遗留子进程，并记录清理动作 |
| 环境变量 | 证据可见 `NEO_SESSIONS_DIR`、`NEO_MEMORY_DISABLE`、`NEO_TMP_DIR`、`NEO_BOT_COMMENTS_DIR` | 保持一致 |

> 最终重跑由主理人统一安排；本阶段**未执行**任何 `bun test`。

### 5.2 解析步骤

1. 保存重跑的完整输出到新的证据文件（只读，勿改写 `docs/evidence/` 下已有文件）。
2. 用 `grep -n "^(fail)"` 提取失败行；**注意 bun 会把失败输出两遍**（执行区 + 末尾汇总区）。按行号定位 `106 tests failed:`（或新的 `N tests failed:`）行，仅取其之前的「执行区」作为唯一集合，或按「组 + 用例名」去重。
3. 对每条失败行：剥离前缀 `(fail) ` 与尾部 ` [耗时ms]`，以 ` > ` 拆分为 `测试组` 与 `用例名`；建议再关联最近的 `tests\xxx.test.ts:` 文件头，形成三元组键：
   **`key = 测试文件 | 测试组 | 用例名`**（避免不同文件重名组互相串号）。
4. 汇总区中夹的 `^ this test timed out after ...` 行不是用例，须过滤；`5 tests skipped:` 后的 `(skip)` 行同理。
5. 校验：执行区 `(fail)` 数 == 汇总区 `(fail)` 数 == 末尾 `N fail`；`pass + skip + fail` 与 `Ran N tests` 一致。不一致则先解释差异，再做差集。

### 5.3 差集定义与判定

令 `Base` = 本文档第 2 节的 106 条 key 集合，`After` = 重跑解析出的 fail key 集合：

| 集合 | 定义 | 判定要求 |
| --- | --- | --- |
| **新增失败** | `After − Base` | **最高优先级**：每一条都必须定位到本轮 #52 / #59 / #37 的具体改动；无法解释的一律视为**回归**，不得以「环境波动」结案。 |
| **消失的失败** | `Base − After` | 必须说明是「本轮修复生效」「环境抖动」「用例被删除/改名」还是「未执行到」；**用例改名会同时产生一假消失 + 一假新增**，须人工合并。 |
| **既存失败** | `Base ∩ After` | 本轮不负责，但**不得写成「已修复」或「通过」**；仍需在最终报告中如实列出数量与分类。 |
| **新增通过** | 重跑新增/改名的 pass 用例 | 仅作辅助信号；需与「消失的失败」配对核对，防止把「用例被删」当成「修复」。 |

辅助校验（**不能作为判据**）：重跑末尾的 `pass / skip / fail / errors / Ran N tests across M files` 计数应与基线逐项对齐并解释差异。

### 5.4 为什么不能用 pass 总数变化直接下结论

1. **聚合量会互相抵消**：新增 1 条 fail（回归）+ 既有 1 条 fail 转 pass（环境抖动/偶发），`pass` 总数可以完全不变，但回归已经引入。
2. **分母会变**：本轮改动可能新增、删除或重构用例，`1879 pass` 与 `1990 tests across 115 files` 这两个基数本身不可比；`pass` 上升可能只是用例变多。
3. **名称变化造成假信号**：改 `describe`/`test` 名会同时制造一条「消失的失败」和一条「新增的失败」，聚合数看不出来。
4. **flaky 与残留污染**：本基线有 5 个 timed out、5 errors、`killed 1 dangling process`、`# Unhandled error between tests`；两次运行间这些用例可能自然翻转，且残留子进程/共享临时目录会级联影响后续用例，聚合数无法区分。
5. **定位能力**：只有「测试文件 + 测试组 + 用例名」级别的差集才能把回归追溯到具体改动文件与函数；pass 总数只能给一个数字，无法回答「哪个 BUG 没修好」。
6. **验收语义**：用户要求的是「已知及新发现的 BUG 都已修复」，这是一个**逐条**命题，必须逐条核对 106 条红灯的状态迁移，而非一个总数是否上升。

---

## 附录：本阶段约束遵守声明

- 未重跑 `bun test`（避免干扰 `.neo/worktrees/issue-37` 的并行工程师工作）。
- 未修改 `src/`、`tests/`、测试配置、`package.json`、`scripts/`、`web/`、`docs/evidence/` 或其它 `docs/` 文档；仅新建本文档。
- 未隐藏、省略、美化任何一条红灯；106 条全部列出，未写「ALL GREEN」或任何通过结论。
- 未做修复、未做验证、未写最终验收报告；未提交 git、未推送。
