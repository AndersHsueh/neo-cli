# neo-agent 本轮最终验证报告 · 同环境全量前后对比（2026-11-14）

> 目的：回答「全部需求是否实现、已知与新发现的 BUG 是否修复、验证是否通过、是否有遗留缺陷」。
> 口径：**同一台 Windows 机器、同一 Bun 版本、同一条 `bun test` 命令**；逐条差集，不隐藏、不放宽断言、不把环境性失败写成绿灯。
> **本轮未执行任何 `*.sh` 脚本**（用户明确要求）；`bun run verify` / `scripts/verify.sh` 未执行。所有关卡走 `bun run check`、`bun test`、`bun -e`、`git` 与文件读写。

---

## 0. 结论（先看这一段）

| 判定项 | 结果 |
| --- | --- |
| 本轮三项需求 #52 / #59 / #37 | **已实现**，定向验收全绿（见 §5） |
| 已知真实产品缺陷 #39 | **已修复**（记忆续页 Windows 失效并静默丢失内容），B7 由 fail 转 pass |
| 本轮实现过程中新发现的回归 | **已修复**：`repo-map-refs` 5 条（#52 默认关闭漏改夹具），修复后 `new=0` |
| 全量同环境前后差集 | **`new = 0`、`fixed = 15`、`still = 91`** —— 零新增回归 |
| `bun run check` | **Exit 0**（多次独立复验） |
| 全量 `bun test` 是否 `ALL GREEN` | **否**。`1951 pass / 5 skip / 91 fail / 3 errors` |
| 是否可宣称「无遗留 BUG / 全部验证通过」 | **不能**。91 条残余失败为 Windows OS 级限制导致的验证盲区，详见 §6；它们是**未验证**，不是**已通过** |
| 运行时间歇异常 | Bun 1.3.6 主线程段错误 1 次（3 次全量运行中 1 次），已用完整复跑取得有效证据 |

---

## 1. 环境与方法

| 项 | 值 |
| --- | --- |
| OS | Windows 11 x64 |
| 运行时 | Bun 1.3.6 (`d530ed99`) Windows x64 |
| Git | 2.55.0.windows.3 |
| 基线 commit | `a2858ae`（tag `v0.4.84`） |
| 最终 commit | `22fbd4b`（本地 `main`，领先 `origin/main` 9 个提交，未推送） |
| 基线证据 | `docs/evidence/baseline-windows-2026-11-14-tests.txt`（3715 行） |
| 最终证据 | `docs/evidence/integration-windows-2026-11-14-tests-final.txt`（3570 行） |
| 差集方法 | 对两份证据的 `(fail)` 行去掉耗时后缀后 `sort -u`（执行区与汇总区重复行自动去重），再 `comm` 求新增 / 修复 / 仍存 |

> 全量 `bun test` 不加过滤参数，覆盖 `119 files / 2047 tests`；不使用 `test.skip`、不改断言、不排除任何测试文件。

---

## 2. 三次全量运行记录（如实保留失败过程）

| 次序 | 证据文件 | 结果 |
| --- | --- | --- |
| 第 1 次 | `docs/evidence/integration-windows-2026-11-14-tests.txt` | `TEST_EXIT=3`；108.6s 后 `panic(main thread): Segmentation fault at address 0xFFFFFFFFFFFFFFFF`（Bun 1.3.6 Windows 运行时崩溃，`KERNEL32.DLL`/`ntdll.dll`），仅 1291 行输出、跑到 `tests/mcp.test.ts` 即中断。**无有效全量结论，未据此声明完成** |
| 第 2 次 | `docs/evidence/integration-windows-2026-11-14-tests-2nd.txt` | 完整跑完：`1946 pass / 5 skip / 96 fail / 3 errors / 7716 expect / 2047 tests / 119 files / 315.63s`。差集发现 **`new=5`** 条回归，全部为 `tests/repo-map-refs.test.ts` F3/G1/H1/H2/H3 |
| 第 3 次（最终） | `docs/evidence/integration-windows-2026-11-14-tests-final.txt` | 修复回归后完整跑完：`1951 pass / 5 skip / 91 fail / 3 errors / 7721 expect() calls / 2047 tests / 119 files / 264.78s`，`TEST_EXIT=1` |

第 1 次崩溃是**间歇性运行时故障**，不是稳定可复现的产品错误：第 2、3 次均完整跑完且无段错误。已如实记录，不删除证据。

---

## 3. 同环境前后对比

| 指标 | 基线 `a2858ae` | 最终 `22fbd4b` | 变化 |
| --- | ---: | ---: | ---: |
| pass | 1879 | **1951** | **+72** |
| skip | 5 | 5 | 0 |
| fail | 106 | **91** | **−15** |
| errors | 5 | **3** | **−2** |
| `expect()` calls | 6258 | 7721 | +1463 |
| tests | 1990 | 2047 | +57 |
| files | 115 | 119 | +4 |
| 耗时 | 234.69s | 264.78s | +30.09s |

### 3.1 逐条差集（关键）

```
baseline_unique = 106
final_unique    = 91
new   = 0      ← 零新增回归
fixed = 15
still = 91
```

**`new = 0`（空集）**：最终失败用例集合中，不存在任何基线中没有的用例。

**`fixed = 15`**（基线 fail → 最终消失），逐条列出：

1. `B merge 落页规则 > B7 页面超限转续页` —— **#39 真实产品缺陷修复**
2. `C1 配置解析 > loadConfig 把两种写法都解析到 provider.outputProbe`
3. `C3b 展开 > 二进制文件跳过并报错`
4. `C3b 展开 > 内容附在原文之后，带起止标记与行数`
5. `C3b 展开 > 单文件超行数上限：截断并标注`
6. `C3b 展开 > 最多 5 个文件：多余的报「未展开」`
7. `C3b 展开 > 超预算的文件按剩余预算截断`
8. `C3b 展开 > 重复引用只展开一次`
9. `C3b 展开 > 预算耗尽后剩下的引用报错跳过`
10. `C3c 路径解析相对 cfg.cwd（-C 场景） > 相对路径按 opts.cwd 解析`
11. `K. .gitignore 约束 > K1 环境自检：worktree 完好且 git 可用`
12. `K. .gitignore 约束 > K3 决策 4：项目私有技能目录未被忽略`
13. `S2 tryLoadSkillForSlash > S2.1 命中技能：返回正文与绝对路径附件`
14. `issue #18-1/3 诊断只写日志 > TUI 通道不含前置探测提示与「未探测到」`
15. `l 连续失败计数对没执行保持中性 > 三种 notExecuted 来源都中性`

其中第 2–15 项为 **13 条测试夹具跨平台路径假设修正**（`basename()` / `dirname()` / `join()` / `isAbsolute()` / 去尾斜杠 pathspec），**不计入产品 BUG 修复**；第 1 项为唯一真实产品缺陷。

---

## 4. 回归发现 → 修复 → 复验闭环

第 2 次全量差集暴露 `new=5`，定位过程与修复：

- 现象：`tests/repo-map-refs.test.ts` 的 `F3 / G1 / H1 / H2 / H3` 五项 `buildRepoMap(cfgFor(cwd))` 返回 `map.text === ""`。
- 根因：#52 把 `DEFAULT_REPO_MAP.enabled` 改为 `false`，#52 提交更新了 `tests/repo-map.test.ts` 的 `cfgFor` 默认（`{ ...DEFAULT_REPO_MAP, enabled: true }`），**漏改同目录的 `tests/repo-map-refs.test.ts`**，其 `cfgFor` 仍为 `{ ...DEFAULT_REPO_MAP }`，于是继承了新的关闭默认值。属本轮引入的真实回归，不是既有环境问题。
- 修复：在 owning 分支 `neo/52-defaults-drive-exit` 补 `0a1a7d3`，`repo-map-refs.test.ts:47` 改为 `{ ...DEFAULT_REPO_MAP, enabled: true }` 并加 2 行注释说明；未改产品代码、未放宽任何断言。
- 复验：`bun run check` Exit 0；`tests/repo-map-refs.test.ts + tests/repo-map.test.ts` = `27 pass / 0 fail / 72 expect`；cherry-pick 到集成分枝后单文件 `17 pass / 0 fail / 33 expect`。
- 结果：第 3 次全量差集 `new=0`，5 条回归全部消失，`fail` 由 96 降至 91、`pass` 由 1946 升至 1951。

---

## 5. 定向验收矩阵（均本机实测）

| 关卡 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `bun run check` | **Exit 0**（#52 / #59 / #37 / 集成分枝多次） |
| #59 有序备用链 | `bun test tests/model-fallback.test.ts` | `21 pass / 0 fail` |
| #37 writer | `bun test tests/stream-json.test.ts` | `12 pass / 0 fail / 315 expect` |
| #37 端到端 + 单元 + Agent 事件 | `bun test tests/cli-stream-json.test.ts tests/stream-json.test.ts tests/agent-stream-events.test.ts` | **`31 pass / 0 fail / 1287 expect`** |
| #52 repo-map（回归修复后） | `bun test tests/repo-map-refs.test.ts tests/repo-map.test.ts` | `27 pass / 0 fail / 72 expect` |
| #39 记忆续页 | `bun test tests/memory-capture.test.ts` | `39 pass / 0 fail / 118 expect`，B7 转 pass |
| 夹具 6 文件（含 #39） | 5 个夹具文件 + `memory-capture.test.ts` | `145 pass / 1 fail / 440 expect`（唯一 K4.1 软链 EPERM） |
| 集成基线定向（8691c52，7 文件） | #52/#59/#37 writer 相关 7 文件 | `110 pass / 14 fail / 1 error / 775 expect`；14 条失败与基线逐字一致，该阶段零新增回归 |
| Web 交付 | 四阶段浏览器/静态实测 + 更新后静态复核 | `FINAL_WEB_QA: IS_PASS: YES`（带限定范围），见 `docs/neo-agent-web-qa-2026-11-14.md` |

---

## 6. 残余 91 条失败：分类、证据与所需环境

**这 91 条是验证盲区，不是绿灯，也不是本轮遗留的产品缺陷。** 逐类说明：

| 类别 | 证据（最终证据文件中的字面量计数） | 性质 | 关闭所需条件 |
| --- | --- | --- | --- |
| 软链创建特权 | `EPERM: operation not permitted, symlink` **47** 处；失败用例名集中在 `h. 软链路径下的托管清单`(9)、`G. 写工具软链守卫`(7)、`F. symlink 遍历修复`(7)、`C. resolveSkill`(5)、`O 组 isRealDir 的软链判定`(4) 等 | Windows 创建符号链接需 `SeCreateSymbolicLinkPrivilege` / 开发者模式 / 管理员权限；当前会话无该特权，产品逻辑根本未执行到 | 在启用开发者模式或具备软链特权的 Windows 会话，或 Linux/macOS 环境重跑 |
| 临时目录文件锁 | `EBUSY: resource busy or locked, rm 'C:\...\neo-lsp-*'` **12** 处；对应 `issue #43 LSP 扩展`(9) 与 `issue #23 LSP`(3) | Windows 上 LSP 假 server 子进程仍持有临时目录句柄，`rmSync` 清理被系统拒绝 | POSIX 环境，或在 Windows 上让假 server 完全退出后再清理 |
| 子进程 / 信号 / 超时 | `timed out after` 4 处、`Expected: 130` 1 处、`D 集成（issue #51） D2/D3`(2)、`B -p 退出后不留孤儿`(2) 等 | Windows 进程树回收、`SIGINT` 传递到 `Bun.spawn` 启动器与真实子进程不一致；60s 超时与 `143 SIGTERM`。基线诊断归为 C/R 类 | 具备 POSIX 信号语义的环境；此前 A/B 实证已排除 #17a 回归 |
| 其它断言差异 | `expect(received).toBe/toContain/toThrow/toMatch/toEqual/toBeNull` 合计约 25 处 | 多为上述环境根因连带的断言差（软链/PTY/子进程），基线同样存在 | 同上 |

基线同类计数对照：`EPERM symlink` 47、`EBUSY` 12、`Expected 130` 1、60s 超时 2 —— 与最终残余高度一致，进一步佐证**这些不是本轮引入**。

### 6.1 仍明确未通过的单项

- `K4.1 决策 4 的技术边界：git 对穿过软链的 pathspec 直接 fatal` —— `EPERM symlink`，产品逻辑未执行到；如实记为**未通过**，未 skip、未放宽、未绕过。

---

## 7. 未执行 / 已知限制（不得包装成通过）

1. **`bun run verify` / `scripts/verify.sh` 未执行**：用户明确要求 Windows 下不使用 `*.sh` 脚本；因此 `ALL GREEN` 这一由该脚本打印的字面结论本轮**不产生、不引用**。
2. `bun run e2e`（`scripts/pty-e2e.ts`，非 sh）本轮未纳入最终闸门；PTY 端到端在本 Windows 环境的表现未单独取证。
3. **Lighthouse 未执行**：PATH / npm global / node module / npx 均不具备；PRD §5.5 移动端四项 ≥90 门槛**未验证**；未联网安装、未编造分数或截图。
4. Web 观察项 **O5**（≤192px 极端宽度横向滚动）未修复，低优先级、非阻断；状态更新后未重新跑 BROWSER_A / B1 / B2 动态实测，只做了 §8 纯静态复核。
5. **物理 EPIPE 在本环境不可复现**：Bun 静默吸收对已关闭管道的写入、不上抛 error 事件；#37 用 `--preload` 注入 `code="EPIPE"` 覆盖同一 `JsonlWriter.closeWithError` 路径，另有真实下游提前关闭的不挂死断言。不宣称物理 EPIPE 已实测。
6. Bun 1.3.6 全量测试段错误 1 次（见 §2），属运行时间歇故障。
7. 无真实第三方 LLM 网关测试；跨 provider/protocol 证据均来自本地 fake 流。
8. 未推送、未打 tag、未发布 release note、未关闭 Issue、未部署 Web 页面。

---

## 8. 交付判定与后续路径

**已完成**：三项需求实现并定向验收；唯一真实产品缺陷 #39 修复；13 条夹具跨平台假设修正；#52 引入的 5 条回归发现并修复；文档/配置示例同步；两页 Web 状态同步与静态复核；本地 `main` 快进合入（9 个独立提交，未 squash）；全量同环境前后对比 **`new=0 / fixed=15 / still=91`**；类型检查 Exit 0。

**未完成（环境受限，非代码缺陷）**：全量 `bun test` 仍 91 fail / 3 errors；K4.1 未通过；Lighthouse 与 PTY 端到端未取证。因此本报告**不给出 `ALL GREEN`，也不宣称「无遗留 BUG」**。

**若要拿到字面意义的全绿**，需要在具备以下条件的环境重跑同一条 `bun test`：Windows 启用开发者模式/软链特权（或改用 Linux/macOS / WSL），让 LSP 假 server 临时目录可正常删除，并具备 POSIX 信号与进程树语义。届时再把 `still=91` 逐条复核，确认无产品缺陷后才可给出全量绿灯结论。

---

## 9. 证据索引

| 文件 | 内容 |
| --- | --- |
| `docs/evidence/baseline-windows-2026-11-14-tests.txt` | 基线 `a2858ae` 全量输出（3715 行） |
| `docs/evidence/integration-windows-2026-11-14-tests.txt` | 第 1 次全量（Bun 段错误） |
| `docs/evidence/integration-windows-2026-11-14-tests-2nd.txt` | 第 2 次全量（发现 5 条回归） |
| `docs/evidence/integration-windows-2026-11-14-tests-final.txt` | 第 3 次全量（最终，3570 行） |
| `docs/neo-agent-windows-baseline-diagnosis-2026-11-14.md` | 106 条基线失败的机读分类（E 68 / P 12 / R 26） |
| `docs/neo-agent-baseline-p-class-triage-2026-11-14.md` | 12 条 P 类源码级根因（1 真缺陷 / 10 夹具 / 1 实跑） |
| `docs/neo-agent-baseline-k3-gitignore-verdict-2026-11-14.md` | #6 K3 实跑定性（Git for Windows 尾斜杠假阳性） |
| `docs/neo-agent-iteration-2026-11-14-implementation.md` | 本轮实现报告 |
| `docs/neo-agent-web-qa-2026-11-14.md` | 最终 Web QA 报告（带限定范围） |
| `docs/neo-agent-github-delivery-2026-11-14.md` | GitHub 推送 / Issue 关闭交付记录 |

---

## 10. 后续状态更新（GitHub 交付，2026-11-14）

> 本节是交付后的追加记录。上文 §1–§9 是当时的验证快照，其中「未推送 / 未关闭 Issue」等表述描述的是**该时点状态**，不代表当前状态；此处不做历史改写。

- **代码已推送**：`a2858ae..22fbd4b  main -> main`，9 个独立提交原样落在远端，未 squash、未打 tag、未发布 release。远端 HEAD 经 SSH `ls-remote` 与 `gh api` 双重确认均为 `22fbd4b90b774312b67e58df381e2a7581a9494f`；本地 `origin/main` 已同步。
- **推送通道**：`https://github.com/AndersHsueh/neo-cli.git` 的 git smart HTTP 在本环境不可达（`curl 56 Connection was reset` / 连接超时），而 `api.github.com` 可用；本机 SSH 公钥未注册到账号，故通过仓库级可写 deploy key（`id=169865240`，`read_only=false`）走 SSH 完成推送。`remote.origin.url` 未改动，仍为 HTTPS。
- **Issue 已跟贴并关闭**：#52 / #59 / #37 各 1 条说明评论（实现方式 + 真实测试结果 + 未发版状态），随后关闭；开放 Issue 数由 18 降至 15。
- **推送后实时复核**：`bun run check` Exit 0（补齐主工作区 `node_modules` 后）；8 个定向文件 `126 pass / 2 fail / 1626 expect()`，2 条失败为基线既存的 `issue #51` D2/D3 Windows 子进程/PTY 限制，非本轮回归；全量 `bun test` 结论不变（`1951 pass / 5 skip / 91 fail / 3 errors`，`new=0 / fixed=15 / still=91`）。
- **仍不成立的表述**：全量 `ALL GREEN`、「无遗留 BUG」、Lighthouse 移动端 ≥90 门槛验证、PTY 端到端取证、物理 EPIPE 实测、O5 极端宽度横向滚动修复 —— 以上均未改变。
- **当前口径**：「已实现、已推送、未发版」。两页 Web 与 `README.md` 已同步。
