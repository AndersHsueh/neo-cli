# 平台适配层 PRD（v0.4.0）

> 2026-10-26 · 目标版本 v0.4.0 · **状态：已实现（2026-10-26，tag `v0.4.0`）**
> 关联：`docs/architecture.md`（§1 仓库拓扑）、`docs/001-memory-system-design[done].md`（§7.5 双作用域记忆）
> 决策人：用户（2026-10-26 两轮讨论拍板，见 §9）

## 摘要

neo 当前把 shell 写死为 `/bin/zsh -lc`（macOS 默认）。在 Ubuntu 24.04 上 zsh 未安装，
`Bun.spawn` 直接抛 `ENOENT`，导致 `shell` 工具与 `!cmd` 两条执行路径**全部失效**——
不是个别命令失败，而是「无法执行任何命令」。

本版本把「平台」抽象成一层基础设施：

1. **跨平台 shell 解析**：按配置 → `NEO_SHELL` → `$SHELL` → 平台默认 → `which` 顺序探测，
   统一 argv 构造与 PATH 保真，Windows 给出 `pwsh`/`cmd` 分支（实验性，未实机验证）。
2. **纯脚本环境探测**：不经过模型，~10ms 采集 OS/shell/CPU/内存/磁盘/工具链/容器，
   写入 `~/.neo/env/<machineKey>.json` 作为唯一事实源。
3. **双层注入**：主代理系统提示词「## 环境」+ 子代理提示词，让模型看见**真实**平台与 shell。
4. **wiki 派生记录**：渲染 `~/.neo/wiki/wiki/环境.md`（生成块所有权），供回溯与 `wiki_search`。

## 1 背景与问题

### 1.1 硬编码点（v0.3.5 HEAD `58783cc`）

| 位置 | 代码 | 影响 |
| --- | --- | --- |
| `src/tools/index.ts:580` | `Bun.spawn(["/bin/zsh", "-lc", command], …)` | 模型调用 `shell` 工具全失败 |
| `src/index.ts:2679` | `Bun.spawn(["/bin/zsh", "-lc", cmd], …)` | 用户 `!cmd` 直通全失败 |

### 1.2 sp7 复现证据（2026-10-26，Ubuntu 24.04.4 LTS）

见 `docs/evidence/v0.4.0-sp7-repro.txt`：

```
THROW: Error: ENOENT: no such file or directory, posix_spawn '/bin/zsh'
dispatch("shell","echo hi") => {"ok":false,"output":"工具执行失败: ENOENT: … '/bin/zsh'"}
```

同机对照：`bash -lc 'echo bash-ok'` 正常。`/etc/shells` 只有 bash/sh/dash，无 zsh。

### 1.3 第二个坑：`-l` 与显式 env 的 PATH 契约

`src/tools/index.ts` 显式传 `env: { ...process.env }`，但登录 shell 会重新初始化 PATH。
macOS 实测 `zsh -lc` 的 PATH 与父进程不同（`/etc/zprofile` path_helper 重排）；
Ubuntu 上 `bash -lc` 会加载 `~/.profile`（sp7 实测会把 `~/.local/bin` 加进来，从而找到 bun）。
即：**当前登录 shell 覆盖了显式传入的 PATH**，命令能否找到取决于用户 rc 文件。

### 1.4 模型不知道自己在哪

`src/system-prompt.ts` 的「## 环境」只有工作目录与模型行；子代理提示词
（`src/tools/task.ts:25`）只有 4 行通用说明。模型只能靠训练偏见猜平台，会写
`brew` / `open` / `sed -i ''` 这类 macOS 专有命令。

### 1.5 其他平台假设（审计结论）

| 位置 | 现状 | 处置 |
| --- | --- | --- |
| `src/clipboard.ts:54` osascript | macOS 专有 | 按平台分支：darwin 保留；Windows 新增 pwsh（实验性）；Linux 降级提示 |
| `src/config.ts:420` `new URL(import.meta.url).pathname` | Windows 上盘符路径错误 | 改 `fileURLToPath` |
| `src/skills.ts:392` `symlinkSync` | Windows 需开发者模式 | 已有 try/catch 降级，不改 |
| `src/git.ts` / `src/input/fileIndex.ts` | 按 PATH 调 git | 跨平台，不改 |
| `scripts/*` 探针 | 已有 darwin/linux 分支 | 仅开发用，不改（Windows 下不保证） |
| TUI / readline / ANSI | 无 shell 调用 | 假设 Windows Terminal 可用，实机验证记 PD-1 |

## 2 目标与非目标

### 目标

- macOS（darwin/zsh）与 Ubuntu（linux/bash）**实测全绿**：`shell` 工具、`!cmd`、`bun test`、`tsc`。
- Windows：shell 解析/执行、环境探测、启动器、剪贴板分支**代码就绪**，标记「实验性，未实机验证」。
- 环境探测完全脚本化（零 LLM token），事实源 = `~/.neo/env/<machineKey>.json`。
- 主代理 + 子代理都能看到真实平台/shell/资源/工具存在性 + 派生行为约束。
- `~/.neo/wiki/wiki/环境.md` 自动生成（生成块 + 人工补充区），`-p` 模式不落盘。
- 新增 `/env`（查看）/ `/env refresh`（重采并落盘）命令。

### 非目标

- `~/.neo-team` 多机同步/团队共享（schema 预留 `machineKey`，见 PD-3）。
- Linux 剪贴板贴图实现（`wl-paste`/`xclip`，PD-2）——本期只做清晰降级。
- Windows 实机验收与 ConPTY/TUI 完整适配（PD-1）。
- 让模型「感知」环境：模型只消费事实，不参与采集。
- 持久 shell 会话（`cd` 跨命令保留）、SSH 远程包装。

## 3 设计

### 3.1 shell 解析器 `src/shell.ts`

```ts
export type ShellKind = "zsh"|"bash"|"sh"|"dash"|"ksh"|"fish"|"pwsh"|"powershell"|"cmd"|"unknown";

export interface ShellSpec {
  path: string;          // /bin/bash 或 C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  args: string[];        // 不含 command；例 ["-l","-c"] / ["-NoProfile","-Logo"...]
  kind: ShellKind;
  login: boolean;
  source: "config"|"env:NEO_SHELL"|"env:SHELL"|"platform"|"which"|"fallback";
}
export interface ShellConfig { path?: string; login?: boolean; args?: string[] }
```

**POSIX 探测顺序**（每步校验存在且可执行，失败降级并记录 `source`）：

1. `settings.shell.path`（显式配置）
2. `NEO_SHELL`
3. `$SHELL`（校验绝对路径、存在、basename 在 POSIX 白名单）
4. 平台默认：darwin `/bin/zsh`，linux `/bin/bash`，其它 `/bin/sh`
5. `Bun.which("zsh")` → `which("bash")` → `which("sh")`
6. `/bin/sh` 兜底；全失败返回结构化错误

**Windows 探测顺序**：`settings.shell.path` → `NEO_SHELL` → `which("pwsh")` → `which("powershell")` →
`ComSpec`/`cmd.exe`。`pwsh` 参数 `["-NoProfile","-NoLogo","-Command"]`；`cmd` 参数 `["/d","/s","/c"]`。

**参数生成**：POSIX 登录 `["-l","-c"]`、非登录 `["-c"]`（分开传，避免非 POSIX shell 对合并短选项的差异）；
`shell.args` 若配置则整体覆盖。

**PATH 保真**（本轮修掉的隐性 bug）：登录 shell 下 spawn 时注入
`NEO_INHERITED_PATH=process.env.PATH`，命令前拼：

```sh
if [ -n "${NEO_INHERITED_PATH-}" ]; then PATH="$NEO_INHERITED_PATH:$PATH"; export PATH; fi; unset NEO_INHERITED_PATH;
```

非登录 shell 直接继承 env（无需 preamble）。Windows 不注入，依赖环境继承。

**默认 `login=true`**（保持 macOS 现有行为；sp7 实测 `bash -lc` 32ms 正常，且能找到 `~/.local/bin/bun`）。
配置 `shell.login:false` 为可确定 PATH 的逃生口。

### 3.2 环境探测 `src/env/probe.ts`

**采集项**（纯 Node/Bun API；不跑 sudo、不 dump 全量 env、不联网）：

| 分类 | 字段 | API |
| --- | --- | --- |
| 机器 | platform / arch / release / version / hostname / machineKey | `process.platform`、`os.*`、sha256 |
| shell | path / kind / login / version / source | shell.ts + 可选 `--version` |
| CPU | cores / model | `os.cpus()` |
| 内存 | total / free | `os.totalmem()/freemem()` |
| 磁盘 | cwd 所在盘 free/total | `fs.statfsSync`（失败 → null） |
| 工具链 | bun/node/git/python3/docker/rg 等是否存在 + 版本 | `Bun.which` + `Bun.spawnSync(...,{timeout:800})` |
| 容器/终端 | docker / wsl / ssh；TERM/TERM_PROGRAM | 环境变量 + `/.dockerenv` |
| 区域 | LANG / 时区 | env + `Intl.DateTimeFormat()` |
| 权限 | uid / root / sudo 存在性 | `process.getuid?.()` + which |

**静态/动态分层**：
- 静态（OS、shell、CPU 型号、工具链版本）→ 快照 JSON，TTL 默认 12h；
- 动态（可用内存、磁盘可用）→ 每次会话现算，不进 prompt（避免会话中途过期）。

**存储**：`~/.neo/env/<machineKey>.json`，原子写（tmp+rename），`{version:1, collectedAt, ...}`。
`machineKey = sanitize(hostname)-<platform>-<arch>-<sha256(hostname|platform|arch).slice(0,8)>`。

### 3.3 注入（主代理 + 子代理）

`system-prompt.ts` 的「## 环境」在上，追加：

```
- 平台：linux 6.17 x86_64（Ubuntu 24.04.4 LTS）
- shell：/bin/bash（bash，登录 shell；命令必须兼容 bash，不要使用仅 zsh 支持的语法）
- 资源：4 核 · 内存 3.4G
- 工具：bun 1.4.4 · node 24.15.0 · git 2.43.0 · python3 3.12.3
- 约束：容器内（Docker）· 无 GUI（不要建议打开浏览器/编辑器）· 非 root
```

- 约 100–200 token；缺失项跳过；约束行由规则生成（来自事实，不靠模型自省）。
- 子代理：`subSystemPrompt(prompt, envText)` 注入 2–3 行精简版。
- `noteModelChange` 只改「- 模型：」行，新增行互不影响（保持现有正则约束）。

### 3.4 wiki 派生记录 `~/.neo/wiki/wiki/环境.md`

- 脚本拥有生成块：

```md
## 摘要

本机环境快照（自动生成）。

> 最后更新:2026-10-26

<!-- neo:env:start -->
（机器/OS/shell/CPU/内存/磁盘/工具链/容器/权限/采集时间 表格）
<!-- neo:env:end -->

## 人工补充

（此段由人或 remember 维护，脚本永不改）
```

- 重写只替换块内；块外内容原样保留。
- INDEX 同步一句话摘要；`log.md` 只在**首次创建**或「机器/shell/OS 变化」时记一条（type=wiki）。
- 触发点：交互式启动且用户级记忆可用（`scopeMode !== "project"`）+ `env.wiki_page !== false`；
  以及 `/env refresh`。`-p`/非交互**不落盘**。
- 页面缺失必备结构时按 `src/wiki/write.ts` 的校验补齐（摘要 + 日期戳）。

### 3.5 配置与命令

`settings.json`（均可选；模板同步到 `settings.example.json`）：

```json
{
  "shell": { "path": null, "login": true, "args": null },
  "env": { "enabled": true, "probe_ttl_hours": 12, "prompt": true, "wiki_page": true }
}
```

环境变量：`NEO_SHELL`（shell 覆盖）、`NEO_ENV_DISABLE=1`（关闭探测/注入）。

命令：`/env` 查看当前快照与来源；`/env refresh` 强制重采并写快照+wiki 页。
`/env` 需在 `src/input/commands.ts` 登记，`tests/commands.test.ts` 漂移守卫会检查。

### 3.6 Windows 兼容（实验性）

- shell：`pwsh`/`cmd` 分支（见 3.1）。
- `src/config.ts`：`new URL(...).pathname` → `fileURLToPath`。
- 剪贴板：`process.platform === "win32"` → `powershell -NoProfile -Command` +
  `Get-Clipboard -Format Image`，PNG 落临时文件（协议同 macOS：文件存在即成功）；失败降级一行提示。
- 启动器：新增 `neo.cmd`（`bun run "%~dp0src\index.ts" %*`）；`neo.sh` 保持 bash。
- 已知限制（文档明示）：Windows 实机未验证；TUI 假设 Windows Terminal（VT 序列）；
  Windows 文件锁/信号语义差异未逐项验证。
- **PD-1**：Windows 实机验收（PowerShell 执行、编码、ConPTY、@ 补全、剪贴板）。

## 4 平台矩阵

| 平台 | shell 执行 | 环境探测 | prompt 注入 | 剪贴板贴图 | 状态 |
| --- | --- | --- | --- | --- | --- |
| macOS (zsh) | ✅ 现有 | ✅ | ✅ | ✅ 现有 | 实测验收 |
| Ubuntu 24.04 (bash) | ✅ 本轮修复 | ✅ | ✅ | ⛔ 降级提示（PD-2） | 实测验收 |
| Windows 11 | 🟡 pwsh/cmd 分支 | ✅ | ✅ | 🟡 pwsh 分支 | 实验性（PD-1） |

## 5 里程碑

| # | 内容 | 估时 | 验收 |
| --- | --- | --- | --- |
| M0 | 探针脚本 + sp7/macOS 取证 + 本文档 | 0.5d | `docs/evidence/v0.4.0-*` 落库 |
| M1 | `src/shell.ts` + 两处接线 + `shell` 配置 | 1d | Ubuntu 上 `echo`/`git`/`bun test`/`!cmd` 全通 |
| M2 | `src/env/probe.ts` + 快照 + TTL + 单测 | 1d | 探测矩阵单测全绿 |
| M3 | 主/子代理注入 + `环境.md` + `/env` + 剪贴板分支 + Windows 兼容点 | 1d | 主/子代理都能看见真 shell；`-p` 不落盘 |
| M4 | 双平台全量验证 + 版本 bump + release note + AGENTS.md | 0.5–1d | macOS + sp7 双绿；证据入库 |

## 6 验收标准

**通用**：`bunx tsc --noEmit` 零错误；`bun test` 全绿（macOS 基线 925+，本版新增 ≥25）；
`bash scripts/verify.sh` ALL GREEN（macOS）。新增/修改代码不引入对 `/bin/zsh` 的字面依赖。

**Ubuntu（sp7）**：
1. `dispatch("shell", {"command":"echo hi"})` → `[exit 0]` 且含 `hi`；
2. `dispatch("shell", {"command":"bun --version"})` → 非 ENOENT；
3. `bun test` 与 `tsc` 全绿；
4. `-p` 模式一次真实 LLM turn 里模型能执行命令并拿到结果；
5. `~/.neo/env/<machineKey>.json` 生成；交互式（或模拟）下 `环境.md` 生成且块外内容保留。

**macOS**：现有 881/925 基线与 PTY 19/19 不回退；`环境.md` 生成且 `## 环境` 段含 darwin/zsh。

**Windows**：代码路径存在、单测覆盖解析分支；实机验收转 PD-1。

## 7 测试计划

- `tests/shell.test.ts`（新增）：resolver 矩阵（darwin 默认 zsh / linux 无 zsh→bash / `$SHELL` 失效回退 /
  settings 覆盖 / 未知 shell 只给 `-c` / 全不存在结构化错误 / Windows pwsh/cmd 分支）、argv 构造、
  PATH preamble 生成、`login` 开关。
- `tests/env.test.ts`（新增）：注入 platform/os/fs/which/now 的探测矩阵；machineKey 稳定性；
  快照 TTL 与原子读写（临时目录）；`renderEnvPrompt` 预算与缺失项；`renderEnvPage` 生成块
  **改写不碰块外内容**；`-p` 不落盘逻辑。
- `tests/core.test.ts`：现有 shell 用例继续双平台跑（`echo hi`/`exit 3`/审批拒绝）。
- 防漂移守卫：`src/` 中除 `src/shell.ts` 外不得出现 `/bin/zsh` 字面量。
- sp7：`bun test` / `bunx tsc` / dispatch 冒烟 / 一次 `-p` 真实 turn。
- macOS：`bun test` / `tsc` / `scripts/verify.sh`。

## 8 风险与对策

| 风险 | 对策 |
| --- | --- |
| 登录 shell 重置 PATH / 加载慢 | PATH preamble 前置父进程 PATH；`shell.login:false` 逃生口；sp7 实测 32ms |
| 用户 rc 里交互式才生效的 PATH（nvm/bun 写 `.bashrc`） | 登录 shell 会 source `.profile`→`.bashrc`（sp7 实测可找到 bun）；文档写明 |
| Windows 代码不可实机验证 | 隔离在 resolver/clipboard 分支；POSIX 路径零行为变化；PD-1 跟踪 |
| 模型仍写平台专有命令 | 注入真实平台/shell + 约束行；错误信息带候选 shell |
| 记忆里的旧环境与实时探测冲突 | prompt 段为权威并注明；记忆 wiki 只是记录 |
| 快照过期 | 静态 TTL 12h；动态值每次现算；`/env refresh` |
| wiki 页面重写误伤人工内容 | 生成块 start/end 标记；块外永不改写 |
| 环境信息隐私 | 白名单字段；不 dump env；本地文件 0600；项目 wiki 永不写 |

## 9 决策记录（2026-10-26）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 环境感知是否需要模型 | 不需要；脚本采集（~10ms），模型只消费 |
| 2 | 事实源 | `~/.neo/env/<machineKey>.json` 为源，wiki 做渲染 |
| 3 | wiki 落点 | 单页 `环境.md` + 生成块所有权 |
| 4 | 多机同步 | 本期不做；schema 预留 `machineKey`，为未来 `~/.neo-team` 铺路 |
| 5 | `-p`/服务器模式 | 只注入 prompt，不落盘 |
| 6 | prompt 粒度 | 静态事实 + 工具存在性 + 派生约束，约 100–200 token；动态值只进 `/env` 与 wiki |
| 7 | Windows | 本期代码就绪、标记实验性；PowerShell 执行实机验收 = PD-1 |
| 8 | 范围 | shell 兼容 + 环境探测合并为「平台适配层」里程碑，一次性 v0.4.0 |
| 9 | 登录 shell | 默认 `login:true` + PATH 保真；可配置关闭 |
| 10 | 覆盖入口 | `settings.shell` + `NEO_SHELL`（不加 CLI 参数） |
| 11 | Linux 剪贴板 | 本期降级（PD-2） |
| 12 | `../neo-memory` 僵尸 worktree | 不动 |

## 10 待办（backlog）

- **PD-1 Windows 实机验收**：PowerShell 执行细节（编码/`-NoProfile`/转义）、ConPTY、`@` 补全、剪贴板 Get-Clipboard。
- **PD-2 Linux 剪贴板**：`wl-paste`（Wayland）/ `xclip`（X11），不可用则明确提示。
- **PD-3 `~/.neo-team`**：多机同步 + 团队共享知识库；本版 `machineKey` 与快照 schema 为它预留。
- **PD-4 容器精度**：cgroup v2 内存/磁盘限额（`os.totalmem` 在容器内报宿主机值）。
- **PD-5 文档与卫生**：AGENTS.md「当前状态」版本号过期（v0.3.4→v0.4.0）；scripts/* 的 `URL.pathname` 改为 `fileURLToPath`（仅开发脚本）。

## 11 实施结果（2026-10-26）

### 11.1 验收结论

| 项 | 结果 |
| --- | --- |
| macOS M4P（darwin 27 / zsh 5.9） | `bash scripts/verify.sh` **ALL GREEN**：tsc 0 / 974 pass / PTY 19/19 |
| sp7（Ubuntu 24.04.4 / bash 5.2.21） | `bash scripts/verify.sh` **ALL GREEN**：tsc 0 / 974 pass / PTY 19/19 |
| sp7 命令执行 | `dispatch("shell", "echo hi")` → `hi [exit 0]`；`bun --version` / `git --version` 正常 |
| sp7 真实 LLM turn（`-p`） | 模型调用 shell 执行 `echo sp7-shell-ok && uname -s`，返回 `sp7-shell-ok / Linux` |
| sp7 环境落盘 | `~/.neo/env/anders-surface-pro-7-linux-x64-09f66d85.json`；`~/.neo/wiki/wiki/环境.md` 创建，重采后人工区保留、生成块仅 1 份、INDEX 已同步 |
| `-p` 不落盘 | `loadEnv({persist:false})` 单测断言不创建 `~/.neo/env/` |

### 11.2 与计划的偏差 / 实施中的额外发现

1. **登录 shell 默认值按 sp7 实测确认为 `true`**：sp7 上 `bash -lc` 仅 32ms，
   且登录 PATH 才能看到 `~/.local/bin/bun`；配合 PATH 保真 preamble 后注册双保险。
2. **Ubuntu 验收又发现 3 个跨平台测试缺陷**（见 release note「顺带修掉」）：
   D5 写死 `/Users/...`、K4.1 依赖英文 git 报错、PTY S16 依赖开发机 `settings.json`。
   均已修复并纳入双平台闸门。
3. **`scripts/verify.sh` 的 tsc 阶段 `bunx` → `bun x`**：sp7 的 bun 安装只有 `bun` 单入口。
4. **Windows 范围**：按「代码就绪、标记实验性」落地（含 shell 分支、`neo.cmd`、`fileURLToPath`、
   PowerShell 剪贴板分支）；实机验收仍为 PD-1，未虚报为已验证。
5. **`环境.md` 写入时机**：交互式启动自动同步 + `/env refresh` 手动；`-p`/非交互不写。
6. **PRD 文件按仓库体例加 `[done]` 后缀**。

### 11.3 变更文件

| 文件 | 类型 |
| --- | --- |
| `src/shell.ts` | 新增：跨平台 shell 解析/argv/PATH 保真/错误提示 |
| `src/env/types.ts`、`probe.ts`、`render.ts`、`wiki.ts` | 新增：环境探测、渲染、wiki 派生页 |
| `src/tools/index.ts` | shell 工具接入解析器（原写死 `/bin/zsh`） |
| `src/index.ts` | `!cmd` 接入解析器；启动环境快照+wiki 同步；`/env` 命令；banner shell 行；剪贴板平台守卫 |
| `src/system-prompt.ts` | `## 环境` 注入真实平台/shell/资源/工具/约束 |
| `src/tools/task.ts` | 子代理提示词注入紧凑环境块 |
| `src/config.ts` | `shell`/`env` 配置段；`fileURLToPath` 修 Windows 路径 |
| `src/clipboard.ts` | 平台分支（macOS JXA / Windows PowerShell 实验性 / Linux 降级） |
| `src/input/commands.ts`、`src/index.ts` HELP | 登记 `/env` |
| `scripts/env-probe.ts` | 新增：平台探针（M0 取证/现场诊断） |
| `scripts/pty-e2e.ts` | PTY 场景写确定性 settings.json（去开发机依赖） |
| `scripts/verify.sh` | 证据前缀 v0.4.0；tsc 用 `bun x` |
| `tests/shell.test.ts`、`tests/env.test.ts` | 新增 49 例 |
| `tests/memory-layout.test.ts`、`tests/gitignore-rules.test.ts` | 跨平台修正 |
| `neo.cmd` | 新增：Windows 启动器（实验性） |
| `settings.example.json`、`README.md`、`AGENTS.md`、`tests/README.md` | 配置/文档/项目记忆 |

## 12 验收证据清单

- `docs/evidence/v0.4.0-sp7-env.txt` — sp7 平台事实（OS/shell/PATH/login vs non-login/runtimes）
- `docs/evidence/v0.4.0-sp7-repro.txt` — 修复前失败复现
- `docs/evidence/v0.4.0-sp7-tests.txt` — 修复后 tsc/test/dispatch/`-p` 验收
- `docs/evidence/v0.4.0-macos-tests.txt` — macOS tsc/test/verify.sh
- `docs/evidence/v0.4.0-env-prompt.txt` — 修复后 prompt 注入样例（双平台）
- `docs/evidence/v0.4.0-macos-env.txt` — macOS 平台事实
- `docs/evidence/v0.4.0-sp7-{tsc,tests,pty}.txt` — sp7 闸门输出
- `docs/release-notes/v0.4.0.md` — 发布说明
