# neo-agent Windows 基线 #6（gitignore K3）实跑定性复核（2026-11-14）

> **本文档性质**：单一只读复核阶段，**不是验收报告，不含任何「通过」结论，不写 ALL GREEN**。
> 范围：`docs/neo-agent-baseline-p-class-triage-2026-11-14.md` §2 #6 中列为「必须实跑才能定性」的唯一条目。
> 前置约束（原判定文档原话）：**「在此之前不得把 K3 写成已修复，也不得仅改断言了事」** —— 本复核全程照此执行。
> **本阶段未修改任何文件**（`src/`、`tests/`、`.gitignore`、任何 git 配置、`web/`、其它 `docs/`、`.workbuddy/` 均未改动），仅新建本文档；未跑 `bun test` / `verify.sh`；未做修复；未提交 git、未推送。

---

## 0. 复核前提与执行边界

| 项 | 值 |
| --- | --- |
| 机器 / OS | 与基线同一台 Windows 机器 + Git Bash（**同机**，满足原判定文档的复现要求） |
| git 版本 | `git version 2.55.0.windows.3`（PortableGit） |
| bun 版本 | `bun test v1.3.6 (d530ed99)`（沿用基线，本阶段**未启动 bun**） |
| 主仓 HEAD | `a2858ae [main]`，与基线 commit 一致 |
| 本阶段执行 cwd | `D:/projects/neo-cli`（主仓根） |
| 基线证据采集 cwd | `D:\projects\neo-cli\.neo\worktrees\issue-52`（堆栈路径） |
| 两处一致性 | 上一阶段已只读验证：`git -C ".../issue-52" check-ignore -v "skills/"` 与主仓输出同为 `.gitignore:61:	skills/`（见 §1 P0） |
| 命令性质 | 全部为**只读 git 查询 + 文件读取**：`check-ignore -v/-q/--no-index`、`config --list --show-origin`、`ls-files`、`hash-object`、`rev-parse`、`cat -A`、`sed -n`、`awk`、`wc`。未创建/删除/修改任何文件，未 `git add` / `git stash` / `git checkout`。 |

判定口径（原判定文档 §2 #6）：
- **观察点 A（判夹具）**：只有带尾斜杠的 `skills/` 命中假阳性，`skills` 与 `skills/pdf/SKILL.md` 均不命中，且 `-v` 的 `.gitignore:61` 确实无有效 pattern。
- **观察点 B（判产品配置缺陷）**：无斜杠的 `skills` 或子文件也被忽略，或 `-v` 指向一条真实存在的忽略规则（含全局 excludesfile / info/exclude）。
- 若两者都不成立，须给出第三种明确结论。

---

## 1. 原始命令与输出摘录

> 以下为终端**原始输出**逐条摘录；`cat -A` 中的 `M-eM-^EM-(...)` 是 `cat -A` 对 UTF-8 中文的转义显示，`$` 表示行尾（LF），`^I` 表示 TAB。

### P0（上一阶段只读预检，基线 cwd 与主仓对照）

```
=== main repo ===
.gitignore:61:	skills/
exit=0
=== issue-52 worktree (baseline cwd) ===
.gitignore:61:	skills/
exit=0
```

### P1 `git --version`

```
git version 2.55.0.windows.3
```

### P2 `sed -n '55,66p' .gitignore | cat -A`

```
$
# M-eM-^EM-(M-iM-^GM-^OM-iM-^WM-8M-iM-^WM-(M-hM-/M-^AM-fM-^MM-.M-oM-<M-^Zverify.sh M-fM-/M-^OM-fM-,M-!M-hM-?M-^PM-hM-!M-^LM-hM-&M-^FM-gM-^[M-^VM-eM-^FM-^YM-eM-^EM-%M-oM-<M-^LM-dM-8M-^MM-hM-?M-^[M-gM-^IM-^HM-fM-^\M-,M-fM-^NM-'M-eM-^HM-6$
docs/evidence/$
$
# M-iM-!M-9M-gM-^[M-.M-fM- M-9 AGENTS.md:M-gM-^TM-1 /init M-gM-^TM-^_M-fM-^HM-^PM-gM-^ZM-^DM-fM-^\M-,M-eM-^\M-0M-hM-.M-0M-eM-?M-^F,M-dM-8M-^MM-eM-^EM-%M-eM-:M-^S(M-gM-^TM-(M-fM-^HM-7M-eM-^FM-3M-eM-.M-^Z 2026-10-16)$
/AGENTS.md$
$
# M-gM-^KM-,M-gM-+M-^KM-eM--M-^PM-iM-!M-9M-gM-^[M.:M-hM-^GM-*M-eM-8M-& .git,M-hM-?M-^\M-gM-(M-dM-8M-: gitee neo-agent-app,M-dM-8M-^MM-eM-9M-6M-eM-^EM-%M-fM-^\M-,M-dM-;M-^S(M-iM-^AM-?M-eM-^EM-^MM-hM-/M-/M-gM-^TM-^_M-fM-^HM-^P gitlink)$
neo-agent-app/$
```

（对应文件第 55–66 行；其中**第 61 行输出为单独的 `$`**，即纯空行。）

### P3 `sed -n '61p' .gitignore | cat -A`

```
$
```

**`.gitignore:61` 是一个纯空行**：无 CRLF（无 `^M`）、无空格、无制表符、无任何 pattern 文本。

### P4 `wc -l -c .gitignore`

```
  63 2080 D:/projects/neo-cli/.gitignore
```

（63 行 / 2080 字节。`file` 命令在本机 Git Bash 不存在，报 `/usr/bin/bash: line 10: file: command not found`，已用 `cat -A` 的 `$` 行尾证明为 LF，不影响判定。）

### P5 `git check-ignore -v --no-index -- "skills/" "skills" "skills/pdf/SKILL.md" ".neo/skills/"`

```
.gitignore:61:	skills/
.gitignore:24:.neo/skills/	.neo/skills/
EXIT=0
```

四条输入只有两条有输出：`skills/` 命中但 **pattern 为空**（`.gitignore:61:` 后直接 TAB）；`.neo/skills/` 命中且**格式正常**（`.gitignore:24:.neo/skills/` 带真实 pattern）。`skills` 与 `skills/pdf/SKILL.md` 无输出。

### P6 `git check-ignore -q --no-index -- <path>` 逐条

```
  skills/                      Q_EXIT=0
  skills                       Q_EXIT=1
  skills/pdf/SKILL.md          Q_EXIT=1
  .neo/skills/                 Q_EXIT=0
```

### P7 尾斜杠**控制组** `git check-ignore -v --no-index -- <path>`

```
  node_modules/              => .gitignore:1:node_modules/	node_modules/
  dist/                      => .gitignore:50:dist/	dist/
  build/                     => .gitignore:51:build/	build/
  web/                       => .gitignore:61:	web/
  docs/                      => .gitignore:61:	docs/
  foo/                       => .gitignore:61:	foo/
  nonexistent/               => .gitignore:61:	nonexistent/
  totally-made-up-dir/       => .gitignore:61:	totally-made-up-dir/
  zzz-nonexistent-xyz/       => .gitignore:61:	zzz-nonexistent-xyz/
  .neo/skills/               => .gitignore:24:.neo/skills/	.neo/skills/
  .neo/backups/              => .gitignore:27:.neo/backups/	.neo/backups/
```

有对应规则的（`node_modules/`、`dist/`、`build/`、`.neo/skills/`、`.neo/backups/`）正常报出规则行号与 pattern；**没有对应规则的任意尾斜杠路径**，一律报同一个 `.gitignore:61:` 空 pattern。

### P8 路径写法变体

```
  ./skills/                                  => .gitignore:61:	./skills/
  skills//                                   => .gitignore:61:	skills//
  skills/.                                   => .gitignore:61:	skills/.
  /skills/                                   => fatal: Invalid path 'C:/Users/Anders/AppData/Local/Programs/WorkBuddy/resources/vendor/PortableGit/skills': No such file or directory
  skills/foo/                                => .gitignore:61:	skills/foo/
  skills/project-private/SKILL.md            => <NO OUTPUT>
  skills/team-skill/references/detail.md     => <NO OUTPUT>
```

（`/skills/` 在 Git for Windows 上被解释为 PortableGit 安装根下的绝对路径，属另一现象，与 K3 无关；恰好说明该 git 对 `/` 开头路径的 Windows 化处理。）

### P9 `git config --list --show-origin | grep -i -E "ignorecase|excludesfile|attributesfile|ignore"`

```
file:.git/config	core.ignorecase=true
```

全仓唯一 ignore 相关配置；`core.excludesfile` 未设置。

### P10 `.git/info/exclude` 全文 `cat -A`

```
# git ls-files --others --exclude-from=.git/info/exclude$
# Lines that start with '#' are comments.$
# For a project mostly in C, the following would be a good set of$
# exclude patterns (uncomment them if you want to use them):$
# *.[oa]$
# *~$
```

全部为注释，无有效规则。

### P11 全局 ignore `C:/Users/Anders/.config/git/ignore` 全文 `cat -A`

```
**/.claude\settings.local.json$
```

唯一一条，与 `skills/` 无关。

### P12 `.gitignore` 一致性

```
100644 6e48ada6fe317818d4aa6469221549f3a133fc6b 0	.gitignore
  worktree blob: 6e48ada6fe317818d4aa6469221549f3a133fc6b
  HEAD blob    : 6e48ada6fe317818d4aa6469221549f3a133fc6b
```

（`git status --porcelain -- .gitignore` 无输出 → 未修改；index blob = 工作树 blob = HEAD blob，三者完全一致，排除「git 读到了另一个版本的 .gitignore」。）

### P13 `.gitignore` 全部有效规则（行号: 内容）

```
  1: [node_modules/]
  2: [settings.json]
  4: [settings.json.bak*]
  5: [settings.*.bak]
  6: [settings.local.json]
  8: [.env]
  9: [.env.*]
  10: [*.log]
  11: [.DS_Store]
  12: [.neo-session/]
  14: [.claude/]
  19: [bot-comments/]
  24: [.neo/skills/]
  27: [.neo/backups/]
  30: [.neo/tmp/]
  31: [.neo/exports/]
  34: [neo-session.json]
  37: [.neo/wiki/outputs/]
  40: [.neo/wiki/.locks/]
  43: [.worktrees/]
  47: [.neo/worktrees/]
  50: [dist/]
  51: [build/]
  52: [out/]
  53: [*.tsbuildinfo]
  54: [.cache/]
  57: [docs/evidence/]
  60: [/AGENTS.md]
  63: [neo-agent-app/]
```

共 29 条有效规则，**没有任何一条能匹配裸 `skills/` 或 `skills/pdf/`**；与 `skills` 字串相关的只有第 24 行 `.neo/skills/`。

### P14 `-q` 控制组

```
  node_modules/          Q_EXIT=0
  dist/                  Q_EXIT=0
  web/                   Q_EXIT=0
  docs/                  Q_EXIT=0
  src/                   Q_EXIT=0
  tests/                 Q_EXIT=0
  foo/                   Q_EXIT=0
  nonexistent/           Q_EXIT=0
  skills/                Q_EXIT=0
```

**所有**尾斜杠路径 `-q` 全部返回 0（被忽略），包括仓库里根本不存在的 `foo/`、真实存在的 `src/` / `tests/`。

### P15 真实存在目录的 `-v`

```
  src/       => .gitignore:61:	src/
  tests/     => .gitignore:61:	tests/
  web/       => .gitignore:61:	web/
  docs/      => .gitignore:61:	docs/
```

`src/`、`tests/`、`docs/`、`web/` 都是磁盘上真实存在的目录（`skills/` 反而不存在），仍报同一个空 pattern → **假阳性与「目录是否存在」无关**。

### P16 K3 去掉尾斜杠后的四条 pathspec（期望全部 `Q_EXIT=1`）

```
  skills                                       Q_EXIT=1
  skills/pdf                                   Q_EXIT=1
  skills/project-private/SKILL.md              Q_EXIT=1
  skills/team-skill/references/detail.md       Q_EXIT=1
```

### P17 K3 原始四条 pathspec（基线失败的依据）

```
  skills/                                      Q_EXIT=0
  skills/pdf/                                  Q_EXIT=0
  skills/project-private/SKILL.md              Q_EXIT=1
  skills/team-skill/references/detail.md       Q_EXIT=1
```

与基线证据 `K3 ... Expected: "skills/=false" / Received: "skills/=true"`（证据文件行 551）**逐条吻合**：测试在第一条 `skills/` 即断言失败，后三条未执行到；两条目录形态假阳性，两条文件形态正确。

### P18 磁盘状态与实际忽略行为

```
  skills/ does NOT exist on disk
  no ignored files under skills/
```

`git ls-files --others --ignored --exclude-standard` 中**没有任何 `skills/` 下的被忽略文件**。

---

## 2. 逐条观察

| 编号 | 观察 | 依据 |
| --- | --- | --- |
| O1 | `.gitignore:61` **不是一条规则**，是纯空行（无 CRLF、无空白、无 pattern） | P2 / P3 / P4 |
| O2 | `.gitignore` 的工作树、index、HEAD 三个 blob 完全一致，且 `status` 无修改，排除「git 读到另一版本」 | P12 |
| O3 | `.gitignore` 29 条有效规则里没有任何一条匹配裸 `skills/`；与 skills 相关的只有 `.neo/skills/`（第 24 行） | P13 |
| O4 | 全局 excludesfile 未设置、全局 ignore 仅 `**/.claude\settings.local.json`、`.git/info/exclude` 全注释、唯一配置为 `core.ignorecase=true`（且 `-c core.ignorecase=false` 不改变结果） | P9 / P10 / P11 + 上一阶段实测 |
| O5 | 假阳性**不是 `skills/` 独有**：任意带尾斜杠且未匹配到具体规则的路径（`web/`、`docs/`、`src/`、`tests/`、`foo/`、`nonexistent/`…）都报同一个 `.gitignore:61` 空 pattern，`-q` 全为 0 | **P7 / P14 / P15（决定性）** |
| O6 | 假阳性与目录是否存在无关（`src/`、`tests/`、`docs/`、`web/` 真实存在；`skills/`、`foo/` 不存在，表现一致） | P15 / P18 |
| O7 | 去掉尾斜杠后，`skills`、`skills/pdf` 与两条文件形态路径**全部未被忽略**（`Q_EXIT=1`）；原始 pathspec 只有带尾斜杠的两条假阳性 | P6 / P16 / P17 |
| O8 | **实际版本控制行为正确**：`git ls-files --others --ignored --exclude-standard` 中没有任何 `skills/` 下的被忽略文件，项目私有技能文件能进 git | P18 |
| O9 | 匹配到具体规则的尾斜杠路径（`.neo/skills/`、`node_modules/`、`dist/`）`-v` 输出格式正常，带真实 pattern，与空 pattern 假阳性可清晰区分 | P5 / P7 |

---

## 3. A / B 判定

### **判定：观察点 A 成立 —— 判「测试夹具 / Git for Windows 工具假阳性」，不是产品配置缺陷。**

且实测结果比观察点 A 的描述**更强**：假阳性并非 `skills/` 的特例，而是 Git for Windows 2.55.0 对「**任意带尾斜杠、且未匹配到具体 `.gitignore` 规则的目录 pathspec**」的通用行为。

| 观察点 A 的条件 | 实测 | 依据 |
| --- | --- | --- |
| 只有带尾斜杠的 `skills/` 命中假阳性 | 成立（且扩展到所有同类尾斜杠路径） | P5 / P7 / P17 |
| `skills`（无斜杠）不命中 | 成立，`Q_EXIT=1` | P6 / P16 |
| `skills/pdf/SKILL.md`（子文件）不命中 | 成立，`Q_EXIT=1`；另两条文件形态路径同样不命中 | P5 / P6 / P16 / P17 |
| `-v` 的 `.gitignore:61` 确实无有效 pattern | 成立，第 61 行为纯空行 | P2 / P3 / P13 |

| 观察点 B 的条件 | 实测 | 依据 |
| --- | --- | --- |
| 无斜杠的 `skills` 也被忽略 | **不成立**，`Q_EXIT=1` | P6 / P16 |
| 子文件也被忽略 | **不成立**，全部 `Q_EXIT=1`，且 `ls-files --ignored` 无 skills 条目 | P5 / P16 / P18 |
| `-v` 指向一条真实存在的忽略规则（含全局 / info/exclude） | **不成立**，指向空行；全局与 info/exclude 均已排除 | P3 / P9 / P10 / P11 / P12 |

**未采用第三类结论**：A 的四项条件全部满足、B 的三项条件全部不满足，无留白。

### 对 PRD §6.5 决策 4 的实质判定

- 产品侧**无缺陷**：`.gitignore` 不含裸 `skills/`，注释（`:21-23`）明确写出「写 `skills/` 会连项目私有技能一起 ignore」的理由；`tests/gitignore-rules.test.ts:154-161`（K4）的文本守卫在基线证据中未出现在失败清单。
- **实质行为未被破坏**：P18 显示实际没有任何 `skills/` 下文件被 git 忽略，项目私有技能文件能正常进版本控制。K3 的 `skills/=true` 是 `git check-ignore` 对目录形态 pathspec 的查询假阳性，不是 git 真的忽略了项目私有技能。
- 因此原判定文档里「PRD §6.5 决策 4 可能被违反」的担忧**可以排除**，但排除的理由是实证，不是推测。

---

## 4. 根因

**根因（可复现行为层面）**：`git 2.55.0.windows.3`（PortableGit）的 `git check-ignore` 对「带尾斜杠、且未匹配到任何具体 `.gitignore` 规则的目录路径」返回 exit 0，并在 `-v` 下输出一个**固定占位** `.gitignore:61:`（pattern 为空）。该 `61` 与被测路径无关（P7 中 `web/`、`docs/`、`foo/`、`nonexistent/` 全部为 61），且指向 `.gitignore` 中的一个纯空行，因此**不对应任何真实忽略规则**。

**触发条件**（P7/P8/P14/P15/P17 归纳）：pathspec 以 `/` 结尾 + 该路径没有匹配到具体 `.gitignore` 规则。与目录是否存在无关；去掉尾斜杠或改用文件形态路径即恢复正常（`Q_EXIT=1`）。

**机制说明的边界**：本复核只读查询，未阅读 git 源码、未做 POSIX 对照（本机为 Windows），因此**不臆断 git 内部为何输出 `61` 这个占位**（可能是解析后规则栈的内部索引、也可能是 Git for Windows 的已知行为）。文档只陈述可复现、可核对的外部行为，并把它作为「后续在 POSIX 环境对照」的可选项记录，不写成定论。

**为什么基线 K3 恰好第一条就红**：`tests/gitignore-rules.test.ts:144-150` 的 pathspec 数组把 `"skills/"`（目录形态）放在第一位，`isIgnored()`（`:62-63`）用 `git check-ignore -q` 的退出码判定，于是拿到 `true`，`expect("skills/=false").toBe("skills/=true")` 失败（证据文件行 551）。P17 精确复现了这一点。

---

## 5. 后续最小修法

> 本阶段**不做修复**。以下为给主理人指派执行时的明确清单。

| 项 | 内容 |
| --- | --- |
| **由谁** | 由主理人指派测试负责人 / 工程师（本 QA 不执行，避免与并行工作冲突） |
| **在哪个文件** | 仅 `tests/gitignore-rules.test.ts`；**不得改 `.gitignore`、不得改任何 `src/`、不得改 git 配置** |
| **改哪几行** | `:144-150` K3 的 pathspec 数组；可在 `:62-63` 的 `isIgnored()` 或 K3 上方补一句注释 |
| **最小改动** | 把 `"skills/"` → `"skills"`、`"skills/pdf/"` → `"skills/pdf"`（去掉尾斜杠），后两条文件形态路径保持不变；断言 `expect(\`${p}=${isIgnored(p)}\`).toBe(\`${p}=false\`)` 的**期望值与结构一律不动** |
| **改动依据** | P16 已只读验证这四条 pathspec 全部 `Q_EXIT=1`；期望值 `false` 不变、被测行为（项目私有技能不被忽略）不变 |
| **建议补充的注释** | 记录「git 2.55.0.windows.3 对带尾斜杠且未匹配规则的目录 pathspec 存在 `check-ignore` 假阳性，故 K3 使用不带尾斜杠的 pathspec；决策 4 由 K4 文本守卫独立钉住」，避免后人把尾斜杠加回去 |
| **必须保留 K4** | **是，且为硬性要求**。`tests/gitignore-rules.test.ts:154-161` 直接读 `.gitignore` 文本断言不含裸 `skills/`，是 PRD §6.5 决策 4 的真正守卫，且完全不依赖 `check-ignore` 的目录形态行为。**删除或放宽 K4 才叫掩盖红灯** |
| **验证方式** | 由主理人在最终「同环境、同 bun 版本、同命令」的统一安排下重跑 `tests/gitignore-rules.test.ts`（K1–K4 全组），确认 K3 与 K4 同时成立；本阶段未跑任何测试 |

### 「不得仅改断言了事」的具体含义

1. 改 K3 的 pathspec 是**修正测试调用 git 工具的方式**，不是放宽断言：期望值仍是 `=false`，四条 pathspec 仍覆盖「目录本身 / 软链位置 / 项目私有技能文件 / 嵌套附件」四类，PRD 实质不变。
2. 但**只改 K3 而不保留 K4、不记录该 git 行为**，会让后人误以为「决策 4 已被 K3 验证」，一旦有人把尾斜杠加回或升级 git，守卫就静默失效 —— 所以「改 pathspec + 保留 K4 + 记录 git 行为」必须**三件一起做**。
3. 又因为产品 `.gitignore` 与产品代码均无缺陷，**本次不得顺手改 `.gitignore`**（改了反而是引入产品侧变更，且会破坏「同环境前后对比」的控制变量）。
4. 改完仍需**实际重跑**才算闭环；本复核只是定性，不等于 K3 已转绿。

---

## 6. 状态约束（必须遵守，写进最终报告）

1. **复核前后，K3 的状态都不得被写成「已修复」**。本阶段没有修改任何测试文件，K3 在 106 条基线清单里仍是 `(fail)`（#6，证据文件行 551），状态一字未变。
2. 在最终「同环境前后对比」中，若本轮**未**实际改动 `tests/gitignore-rules.test.ts`，#6 应落在 `Base ∩ After`（既存失败），**不得写成「已修复」「通过」或「已排除」**；若改了测试文件而转绿，必须单独说明改动行、以及「为何不算掩盖红灯」。
3. 本次复核只把 #6 从「必须实跑才能定性」细化为「**测试夹具 / Git for Windows 工具假阳性**」，**不改变** `neo-agent-windows-baseline-diagnosis-2026-11-14.md` 中 106 条失败清单的任何一条，也不改变 `neo-agent-baseline-p-class-triage-2026-11-14.md` 中「12 条 P 类 = 1 真缺陷 / 10 夹具 / 1 待实跑」的历史记录（该记录描述的是**当时**的判定状态）；若要在汇总里更新，须注明「#6 已于本日实跑定性为夹具，非产品缺陷」。
4. 唯一真实产品缺陷仍是 **#39**（`src/memory/merge.ts` 的 `target.split("/").pop()`），已由独立工程师在独立 worktree 处理；本复核与 #39 无关，不得用来冲淡或抵消该必修项。
5. **本复核是只读诊断，不是验证通过**；未跑 `bun test` / `verify.sh`，未出具任何通过结论。

---

## 7. 禁止项遵守声明

- 未修改 `src/`、`tests/`、`.gitignore`、任何 git 配置、`web/`、其它 `docs/`、`.workbuddy/`；`git status --porcelain -- .gitignore` 无输出，`.gitignore` 的 worktree/index/HEAD blob 三者一致（P12）。
- 未跑 `bun test` / `verify.sh`，未执行任何测试用例；全部命令为只读 git 查询与文件读取。
- 未做修复、未出具通过结论、未写 ALL GREEN；K3 红灯状态如实保留。
- 未提交 git、未推送。
