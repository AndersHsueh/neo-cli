# 跨平台不可移植 — shell 解释器写死 /bin/zsh

> 最后更新:2026-10-27

## 摘要

neo v0.3.4(HEAD `ca93568`)在 macOS 上 881/881 全绿,但**在 Ubuntu 24.04 + bash 上跑不全**:`bun test` 877 通过 / 4 失败,其中 1 条是**产品级硬伤** —— `shell` 工具与 `!` 直连命令把解释器写死成 `/bin/zsh`,Linux 没有这个路径,导致 **agent 在服务器上一条命令都执行不了**(读类工具正常)。Windows PowerShell **推定同样不可用**(未实测,同根因 + `osascript` 剪贴板 + 路径分隔符)。本页 = 2026-10-26 凌晨在 sp7 部署时发现的实证记录 + 根因 + 修复方向,作为下一个会话规划修复的输入。

## 一、结论先行

| 平台 | 现状 | 证据强度 |
|------|------|----------|
| macOS (zsh) | 全绿可用 | 实证:881/881,`scripts/verify.sh` ALL GREEN |
| Ubuntu 24.04 + bash | **部分可用**:LLM / read / glob / grep / web 正常;**`shell` 工具与 `!` 完全不可用** | 实证:sp7 上 877/881,4 fail(见 §二) |
| Windows PowerShell | **推定不可用** | 未实测(用户明确"不用试,肯定更不行");按同根因 + §三 其它平台假设推定 |

**一句话**:neo 目前是一个"macOS 专用 harness",而服务器端自进化计划(loop 1/2/3 全都要跑 `git` / `gitee` / `bun test`)恰好要求它在 Linux 上能执行命令 —— 这是当前唯一的硬阻塞。

## 二、实证:sp7(Ubuntu 24.04)部署与实测

**部署环境**:Surface Pro 7 笔记本当家庭服务器,Ubuntu 24.04.4 LTS,x86_64(i3-1005G1 / 3.4 GiB RAM / 可用 1.8 GiB / 磁盘剩 44 GB),uptime 148 天。

| 步骤 | 结果 |
|------|------|
| Bun 运行时 | 原机未装 `bun`;官方安装脚本装 **1.4.4** 到 `~/.bun/bin/bun`(GitHub release 下载 ~45 MB,约 4 分钟);另建 `~/.local/bin/bun` 软链 |
| 代码 | `git clone https://gitee.com/andershsueh/neo-agent.git ~/projects/neo-agent` → `ca93568`(v0.3.4),随后 `--unshallow` 补全历史。仓库公开可读,无需凭据 |
| 依赖 | `bun install --frozen-lockfile` → 7 packages / 2.72 s |
| 配置 | `~/.neo/settings.json`(600)单 provider `ipsa`(deepseek-flash / glm-5.3-flash),`show_reasoning=false`;sp7 到 `ipsapro.isoftstone.com` 直连可达(TLS 0.27 s,无需 VPN/公司网) |
| 启动器 | `~/.local/bin/neo`(部署侧包装 `export PATH=$HOME/.bun/bin:...; exec ~/projects/neo-agent/neo.sh "$@"`),`neo --version` → `neo v0.3.4` |
| 类型检查 | `tsc --noEmit` **零错误** |
| 单测 | `bun test` → **877 pass / 4 fail**,881 用例 / 53 文件 / 11.39 s(本机 macOS 基线 881/0) |

**能跑的(实测通过)**

- LLM 链路:`bun run src/index.ts -p "只回答四个字:链路已通"` → 输出 `链路已通`(sp7 → isoftstone 网关 → 模型,全程无 TTY)
- 工具循环:`-y -p "用 glob 统计 src/ 下 .ts 数量"` → `⚡ glob` 匹配 68 个文件 → 答 `68`;分类器自动降档 `default → fast (ipsa/deepseek-flash)` —— 说明 oneshot、工具注册、审批、分类器、非 TTY 输出都正常

**不能跑的(实测失败)**

- `shell` 工具:`工具执行失败: ENOENT: no such file or directory, posix_spawn '/bin/zsh'`
- `!<cmd>` 直连 shell:同一行代码,同根因

**4 条失败的完整归因**

| # | 用例 | 原因 | 性质 |
|---|------|------|------|
| 1 | `shell > 执行命令并返回退出码`(tests/core.test.ts) | `posix_spawn '/bin/zsh'` ENOENT | **产品 bug(Linux 致命)** |
| 2 | `shell > 非零退出码被如实报告`(同上) | 同上 | **产品 bug(Linux 致命)** |
| 3 | `D5 跨进程锁`(tests/memory-layout.test.ts:211) | 用例硬编码 `/Users/xueyuheng/research/000-alice-new/neo`,Linux 不存在 → 子进程 import 失败、stdout 为空 | 测试不可移植 |
| 4 | `K4.1 …git 对穿过软链的 pathspec 直接 fatal`(tests/gitignore-rules.test.ts:180) | 断言英文 `beyond a symbolic link`,但 sp7 的 git 输出中文 `fatal: 路径规格 '…' 位于符号链接中`(系统 locale) | 测试 locale 敏感 |

> 附:sp7 上也**没有装 zsh**(`command -v zsh` 为空),且 `sudo` 需要密码(非 NOPASSWD)。所以"装个 zsh 就绕过"在当前机器上需要 sudo 密码,不是零成本方案 —— 这恰好说明**该修的是代码,不是环境**。

## 三、根因清单(按严重度)

1. **致命:`/bin/zsh` 写死,两处**
   - `src/tools/index.ts` —— `shell` 工具:`Bun.spawn(["/bin/zsh", "-lc", command])`
   - `src/index.ts:2526` —— `!<cmd>` 直连:`Bun.spawn(["/bin/zsh", "-lc", cmd])`
   - 行号会随提交移动(`ca93568` 时是 585,`46faaa0` 时是 567),**用 grep `/bin/zsh` 定位,不要用行号**
   - 顺带:`-lc` 是 login shell,会读 `/etc/profile`、`~/.bash_profile`/`.zprofile` —— 除了"解释器不存在",还有"profile 污染输出/拖慢启动"的第二层平台差异
2. **高:剪贴板只认 macOS** —— `src/clipboard.ts` 走 `osascript`(JavaScript for Automation)。Linux 需 `wl-paste`/`xclip`,Windows 需 `powershell Get-Clipboard`;`Ctrl+V` 图片粘贴在非 macOS 上直接不可用
3. **中:测试套件只有一条平台真理** —— 硬编码 macOS 绝对路径(`/Users/xueyuheng/...`)、断言英文 git 文案、假定 home 布局;`bun test` 的"全绿"目前只对 macOS 成立
4. **中:TUI/PTY 未在 Linux 验证** —— `scripts/pty-e2e.ts` 等已有 `IS_DARWIN` 分支,但 19 场景 PTY 只在 macOS 上跑过;Linux 终端行为(尺寸、控制序列、raw 模式)未验证
5. **低但需拍板:Windows 是否在支持范围** —— 原生 Windows 的进程模型(POSIX spawn vs `cmd.exe /c` / `pwsh -Command`)、路径分隔符、缺 POSIX 工具链,与"锦上添花"相比更像一条独立战线。**待用户拍板:是否只承诺 WSL 即可**

## 四、影响:为什么这挡住服务器端自进化

用户目标(2026-10-26 提出)是让 neo-agent 自己常驻服务器,周期性做:扫 claude-code release notes → 写 issue;拉 issue 做聚类;修 bug + 发最小版。三条 loop 的共同前置是**agent 能执行 shell**(`git clone/pull/commit/push`、`bun test`、`gitee issue create`)。

当前状态:sp7 上的 v0.3.4 是**只读可用**(LLM + read/glob/grep/wiki/memory),`shell` 一调就 ENOENT → **不能作为自进化执行体**。

两条出路(下一会话二选一或都做):

- **A. 环境侧(临时解封)**:sp7 上 `apt install zsh`(需 sudo 密码)。零代码改动、5 分钟,但每台 Linux 机器都要补,且掩盖真 bug。
- **B. 代码侧(治本)**:解释器可移植 + 平台抽象。改动不大但要动 `src/`,需走正常 TDD + 回归,并同步更新测试基线口径。

## 五、修复方向(仅记录,不在此定稿)

1. **单点常量 + 平台解析**:抽 `resolveShell()` —— `darwin` → `/bin/zsh`;`linux` → `process.env.SHELL ?? "/bin/bash"`;`win32` → `pwsh`/`cmd.exe`。两处 spawn 都改调它,**两处不能各写一份**
2. **评估 `-lc` → `-c`**:login shell 的 profile 副作用在服务器上只会添乱;若确认无依赖,改 `-c` 更可预测
3. **platform 模块**:把"解释器/剪贴板/路径"这类平台差异集中到一个 `src/platform.ts`,避免下次在第三个地方又冒出 `/bin/zsh`
4. **测试可移植三件套**:①路径用 `import.meta.dir` 派生,不写 `/Users/...`;②git 相关断言前 `LC_ALL=C`(或断言语义而非文案);③补一条"shell 工具在 `SHELL` 指向 bash 时可用"的用例
5. **CI 矩阵(建议)**:目前"全绿"只在 macOS 单点成立。加 `ubuntu-latest` 即可把这类回归挡在合并前;Windows 视 §三.5 的拍板结论再定
6. **可选:settings 增加 shell 覆写项** —— 还是只认环境变量?待定(增加配置项 = 增加理解成本,倾向不加)

## 六、怎么算修好了(验收标准,建议)

- [ ] sp7(Ubuntu 24.04 + bash):`bun test` 全绿(条数以修复后基线为准),`tsc --noEmit` 零错误
- [ ] sp7 上 `neo -y -p "执行 git log -1 --oneline 并原样返回"` 能真实执行并返回退出码 0;非零退出码(如 `exit 3`)如实返回 `[exit 3]`
- [ ] `!<cmd>` 在 Linux 上同样可用
- [ ] macOS 基线不回归(881/881 或修复后新基线)
- [ ] CI `ubuntu-latest` 绿
- [ ] Windows:按拍板结论给出"支持 / 只支持 WSL / 不支持"的明确声明并写进 README

## 七、未决问题(给下一会话)

1. **Windows 支持范围**:原生 / 仅 WSL / 不支持?——影响工作量一个数量级,必须用户拍板
2. **服务器上现在这一份怎么办**:等代码修复(保持 v0.3.4 只读),还是先装 zsh 解封?
3. **是否引入 CI 矩阵**:仓库在 gitee,是否有可用的 CI(Gitee Go / 自建 runner / 只用本地脚本)?
4. **PTY/TUI 的 Linux 验证**是否本轮一起做,还是拆成独立议题?
5. **`settings.json` 是否暴露 shell 配置**:倾向不做,但需明确记录"为什么不做"

## 八、复现命令(照抄可用)

```bash
# 1) 环境(需要 bun)
ssh sp7 'curl -fsSL https://bun.sh/install | bash'      # 45 MB,网络慢则 3-5 分钟
ssh sp7 'git clone --depth=1 https://gitee.com/andershsueh/neo-agent.git ~/projects/neo-agent'

# 2) 依赖 + 基线
ssh sp7 'export PATH=$HOME/.bun/bin:$PATH; cd ~/projects/neo-agent && bun install --frozen-lockfile && ./node_modules/.bin/tsc --noEmit && bun test'

# 3) 现场复现"shell 不可用"
ssh sp7 'export PATH=$HOME/.bun/bin:$PATH; cd ~/projects/neo-agent && bun run src/index.ts -y -p "执行 shell 命令 echo hi 并返回输出"'
# 期望看到:工具执行失败: ENOENT: no such file or directory, posix_spawn '/bin/zsh'
```

## 相关页面

- [[neo-开发踩坑]] — 本页属于"平台假设"这一类,修复后应回填一条(教训:凡是路径/解释器/文案,先问"这在 Linux 上成立吗")
- [[盘点-2026-10-26-v0.3.1剧情层与hotfix]] — 同日工作盘点;本页是当日收尾时的新发现
- [[已实现功能盘点]] — 修复后需同步"功能 → 代码落点"的平台口径
- [[TUI进化路线-2026Q4]] — PTY/TUI 的 Linux 验证属其延伸议题

## 修订记录

> 已过时:2026-10-27 跨平台 shell 已由 **v0.4.0** 修复：`src/shell.ts` 成为唯一真源（settings → NEO_SHELL → $SHELL → 平台默认 → which → /bin/sh），shell 工具与 `!` 都走它；macOS 与 sp7（Ubuntu 24.04）双平台实测 974/59、PTY 19/19。v0.4.1 又补了 `shell.cwd`（只影响本次调用）。本页保留为「发现过程 + 失败归因」的历史记录，不再作为待办。

- 验收结果见 `docs/evidence/v0.4.0-*`、`docs/evidence/v0.4.0-sp7-*`。
- 后续平台议题：PD-1 Windows 实机、PD-2 Linux 剪贴板、PD-4 容器 cgroup。
