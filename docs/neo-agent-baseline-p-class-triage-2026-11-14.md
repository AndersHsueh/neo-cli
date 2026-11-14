# neo-agent Windows 基线 P 类 12 条源码级根因判定（2026-11-14）

> **本文档性质**：单一只读判定阶段，**不是验收报告，不含任何「通过」结论，不写 ALL GREEN**。
> 范围：上一份 `docs/neo-agent-windows-baseline-diagnosis-2026-11-14.md` §4.2 列出的 12 条「可能与产品代码相关」用例。
> 目的：在最终「同环境前后对比」之前，先定清这 12 条是真实产品缺陷、还是 Windows 测试夹具假设，避免验收时含糊归为环境问题。
> **本阶段未重跑 `bun test` / `verify.sh`，未修改任何现有文件**（`src/`、`tests/`、配置、`web/`、其它 `docs/`、`docs/evidence/` 均未改动），仅新建本文档；未提交 git、未推送。

---

## 0. 判定前提：源码版本与基线一致

| 项 | 值 |
| --- | --- |
| 主仓 HEAD | `a2858ae chore: v0.4.84 发版（#50 模型判断完成条件 + #51 -p 无人值守长跑）`，分支 `[main]` |
| 基线证据采集对象 | main `a2858ae`，未含本轮 #52 / #59 / #37 改动 |
| 基线证据内的工作目录 | `D:\projects\neo-cli\.neo\worktrees\issue-52\tests\...`（堆栈路径） |
| 当前 worktree 列表 | 主仓 `a2858ae [main]`；`issue-37 8691c52`、`issue-52 879dee2`、`issue-59 0b128ce` |
| 结论 | 基线是 `issue-52` worktree 仍停在 `a2858ae` 时跑的（当时的 `git worktree list` 输出见基线诊断 §1.2），**主仓当前源码与基线被测源码同 commit**。因此直接读主仓 `src/` 与 `tests/` 做源码级判定成立，不存在「读到了改动后代码」的偏差。 |

本阶段实际执行的命令（全部只读，不含任何测试）：
`git log -1` / `git status --short` / `git worktree list` / `git rev-parse --show-toplevel` / `git config --list --show-origin` / `git show HEAD:.gitignore` / `git check-ignore -v|-q|--no-index`（纯查询）/ `git ls-files --others --ignored`；以及读取源码、测试文件、`.gitignore`、`.git/info/exclude`、`~/.config/git/ignore`。

判定口径（每条恰好一个，不含糊）：`真实产品缺陷` / `测试夹具的 Windows 路径或 POSIX 假设` / `必须实跑才能定性`。

---

## 1. 逐条判定表

| # | 用例（组 > 名） | 判定 | 根因位置 | 一句话证据 |
| --- | --- | --- | --- | --- |
| 2 | issue #18-1/3 诊断只写日志 > TUI 通道不含前置探测提示 | 测试夹具的 Windows 路径或 POSIX 假设 | `tests/boot-noise.test.ts:152` | `bootLogFile(...).split("/").pop()` 切不开反斜杠，绝对路径被二次拼进 `join` |
| 6 | K. .gitignore 约束 > K3 决策 4：项目私有技能目录未被忽略 | 必须实跑才能定性 | `tests/gitignore-rules.test.ts:145,150` + 仓库 git 配置 | `.gitignore` 无裸 `skills/`、K4 基线为 `(pass)`；但 `git check-ignore -q skills/` 返回 0 且规则来源 `.gitignore:61` 对应该文件空行，来源无法静态定位 |
| 39 | B merge 落页规则 > B7 页面超限转续页 | **真实产品缺陷** | `src/memory/merge.ts:309,312,320` | `target.split("/").pop()` 在 Windows 返回整个绝对路径，续页写入抛错被 `catch` 静默丢弃 |
| 44 | C1 配置解析 > loadConfig 把两种写法都解析到 provider.outputProbe | 测试夹具的 Windows 路径或 POSIX 假设 | `tests/output-probe.test.ts:205` | `path.lastIndexOf("/")` = -1 → `slice(0,-1)` 把 `settings.json` 截成 `settings.jso` |
| 45 | C3b 展开 > 内容附在原文之后 | 测试夹具的 Windows 路径或 POSIX 假设 | `tests/references.test.ts:15-27` | 桩键 `/repo/a.ts` 与 Windows `join("/repo","a.ts")` = `\repo\a.ts` 精确匹配失配 |
| 46 | C3b 展开 > 重复引用只展开一次 | 测试夹具的 Windows 路径或 POSIX 假设 | 同 #45 | 同上，`refs.length` 0 |
| 47 | C3b 展开 > 二进制文件跳过并报错 | 测试夹具的 Windows 路径或 POSIX 假设 | 同 #45 | 同上，先撞「不存在，按原文保留」分支 |
| 48 | C3b 展开 > 单文件超行数上限 | 测试夹具的 Windows 路径或 POSIX 假设 | 同 #45 | 同上，`r.refs[0]` undefined → `TypeError` |
| 49 | C3b 展开 > 最多 5 个文件 | 测试夹具的 Windows 路径或 POSIX 假设 | `tests/references.test.ts:119-132` | 桩键 `/repo/fN.ts` 同样失配 |
| 50 | C3b 展开 > 超预算按剩余预算截断 | 测试夹具的 Windows 路径或 POSIX 假设 | 同 #45 | 同上 |
| 51 | C3b 展开 > 预算耗尽后报错跳过 | 测试夹具的 Windows 路径或 POSIX 假设 | 同 #45 | 同上 |
| 53 | S2 tryLoadSkillForSlash > S2.1 命中技能 | 测试夹具的 Windows 路径或 POSIX 假设 | `tests/skill-slash.test.ts:172,174` | `f.endsWith("references/detail.md")` / `f.startsWith("/")` 是 POSIX 假设，实际附件为 `C:\...\references\detail.md` |

---

## 2. 逐条证据与契约分析

### #2 boot-noise：测试夹具的 POSIX 分隔符假设

**产品契约**：`src/bootDiagnostics.ts:49-50`
```ts
export function bootLogFile(now: Date = new Date(), root = bootLogRoot()): string {
  return join(root, "boot", `${dayKey(now)}.jsonl`);
}
```
`:62` `const file = bootLogFile(now, root);` 直接拿它写文件。契约明确：**返回日志文件的完整绝对路径**（不是文件名）。Windows 上该路径含反斜杠。

**测试假设**：`tests/boot-noise.test.ts:152`
```ts
const logged = readFileSync(join(root, "boot", `${bootLogFile(new Date(), root).split("/").pop()}`), "utf8");
```
`.split("/").pop()` 想取文件名，但 Windows 路径无 `/`，返回**整条绝对路径**；`join(root,"boot", <绝对路径>)` 得到 `...\boot\C:\...\boot\2026-11-14.jsonl`，正是证据第 154 行的 `ENOENT`。测试连被测行为都还没断言就崩在读取日志这一步。

**判定**：产品函数无缺陷，是测试的 POSIX 分隔符假设。
**应改哪一行**：`:152` 用 `basename(bootLogFile(new Date(), root))`（从 `node:path` 导入 `basename`），或直接 `readFileSync(bootLogFile(...), "utf8")`。
**为什么不算掩盖红灯**：被测契约是「TUI 通道不含前置探测提示与『未探测到』、只有日志通道有」（测试 `:147-150` 断言），改的是**测试自己读取日志文件的路径构造**，被测行为一条没删；改完仍会真实读取日志并断言。

### #6 gitignore K3：必须实跑才能定性

**产品侧证据（排除 .gitignore 写错）**：
- `.gitignore` 全文仅 3 行含 `skills`（`:22`、`:23` 为注释，`:24` 为规则），规则行只有 `.neo/skills/`；**没有裸 `skills/`**，也没有 `skills/**` 之类变体。
- `:21-23` 注释明确写出决策 4 的理由：「gitignore 无法区分 symlink 与真目录，写 `skills/` 会连项目私有技能一起 ignore」——产品配置与 PRD §6.5 决策 4 一致。
- `tests/gitignore-rules.test.ts:154-161`（K4）直接用文本断言 `.gitignore` 不含裸 `skills/`，该用例在基线中**未出现在失败清单**，即基线里记为 `(pass)`。
- 测试 `:62-63` `isIgnored(p)` = `git check-ignore -q p` 的退出码；K3（`:142-151`）对 `["skills/","skills/pdf/","skills/project-private/SKILL.md","skills/team-skill/references/detail.md"]` 断言 `=false`，证据显示第一条即 `Expected: "skills/=false" / Received: "skills/=true"`。

**本阶段只读实测（git 2.55.0.windows.3）**：

| 命令（cwd = 主仓 / issue-52 worktree 均试过） | 结果 |
| --- | --- |
| `git check-ignore -v "skills"` | exit 1，**未被忽略** |
| `git check-ignore -v "skills/"` | exit 0，输出 `.gitignore:61:` + TAB + `skills/`（**pattern 为空**） |
| `git check-ignore -v "skills/pdf/SKILL.md"` | 无输出，**未被忽略** |
| `git -c core.ignorecase=false check-ignore -v "skills/"`、`--no-index` 变体 | 同上，仍 exit 0 |
| `git config --show-origin --get core.excludesfile` | unset；唯一 ignore 相关配置为 `core.ignorecase=true` |
| `~/.config/git/ignore` | 仅 `**/.claude\settings.local.json` |
| `.git/info/exclude` | 全为注释 |
| `.gitignore` 第 61 行（工作树与 `git show HEAD:.gitignore` 一致） | **空行**；`git status --porcelain -- .gitignore` 为空（未修改） |
| 磁盘上 `skills/` 目录 | 不存在 |

**为何不能当场定性**：`check-ignore` 报「被忽略」，却指向一个空行、pattern 为空，且同一目录下子文件 `skills/pdf/SKILL.md` 未被忽略、去掉尾斜杠的 `skills` 也未被忽略 —— 规则来源自相矛盾，无法从静态证据定位这究竟是 Git for Windows 对「尾斜杠 + 不存在目录」pathspec 的假阳性，还是某个尚未定位的忽略来源。已知「产品 `.gitignore` 写错」被排除，但「PRD 决策 4 在最终验收环境是否真的成立」仍未闭环。

**最小复现命令与观察点**（在最终验收**同机同 cwd** 下执行，不跑测试）：
```bash
cd D:/projects/neo-cli/.neo/worktrees/issue-52      # 必须与基线同一工作目录
git --version
git status --porcelain -- .gitignore                 # 须为空
git check-ignore -v -q "skills/";        echo "skills/ exit=$?"
git check-ignore -v -q "skills";         echo "skills  exit=$?"
git check-ignore -v "skills/project-private/SKILL.md"
git check-ignore -v --no-index "skills/"
git -c core.ignorecase=false check-ignore -v "skills/"
git config --show-origin --get core.excludesfile
```
- 观察点 A：若仅 `skills/`（尾斜杠）为 0、`skills` 与子文件均为 1，且 `-v` 仍指向 `.gitignore:61` 空 pattern → 判定为 **Git for Windows 尾斜杠假阳性（夹具）**，K3 应把 pathspec 改为不带尾斜杠的形式，且必须保留 K4 的文本守卫。
- 观察点 B：若 `skills` 或 `skills/project-private/SKILL.md` 也为 0，或 `-v` 指向一条真实存在的规则 → 判定为**产品配置缺陷**，必须修 `.gitignore` 并重新评估 PRD §6.5 决策 4。
- 观察点 C：与 POSIX（Linux/macOS）同 commit 的 `git check-ignore -v "skills/"` 结果对比，可区分「Git for Windows 行为差异」与「仓库规则」。

**判定**：`必须实跑才能定性`。**在此之前不得把 K3 写成「已修复」，也不得仅改测试断言了事** —— K3 是决策 4 的行为守卫，`.gitignore:61` 空 pattern 的异常来源必须查清并写进最终报告。

### #39 memory B7：**真实产品缺陷**（12 条中唯一一条）

**产品契约**：`src/memory/merge.ts:9` 「单页 16KB 后转 `-续N` 页」；`:37` `DEFAULT_MAX_PAGE_BYTES = 16*1024`；`:233` `status: "created" | "appended" | "deduped" | "split"`。即页面超限时 `applyOps` 必须返回 `status: "split"` 并写出 `决策-大页-续1.md`。

**根因链路（完整闭环，与证据 `Expected: "split" / Received: undefined` 吻合）**：
1. `src/memory/merge.ts:294` 判定 `Buffer.byteLength(pageText,"utf8") > maxPageBytes` 成立（B7 测试 `tests/memory-capture.test.ts:368` 写 `"填充内容".repeat(2000)` = 24000 字节 > 16384）。
2. `:295-301` 算出 `cont = continuationName(layout, op.page)`（`:206-212` 返回**纯文件名**如 `决策-大页-续1.md`），`target = join(layout.pagesDir, cont)`，**`target` 是 Windows 绝对反斜杠路径**，`split = true`。
3. **缺陷点** `:309`、`:312`、`:320` 三处用 `target.split("/").pop()` 取文件名：
   ```ts
   page: split ? target.split("/").pop() ?? op.page : op.page,          // :309 传给 writeBack
   logTitle: `自动记忆：.../${split ? target.split("/").pop() : op.page}（create）`, // :312
   page: split ? target.split("/").pop() ?? op.page : op.page,          // :320 写入 applied[]
   ```
   Windows 路径无 `/`，`split("/")` 返回**整个 `C:\...\决策-大页-续1.md`**，于是传给 `writeBack` 的 `page` 变成绝对路径。
4. `src/wiki/write.ts:403-407` `writeBack`：`validatePageName(name)`（`:47-66`）只检查 `.md` 结尾、空名、保留名、盘点页格式，`:64-65` 对「无前缀普通主题页」直接 `return null` —— **放行了含盘符与反斜杠的绝对路径**；随后 `:407` `join(layout.pagesDir, name)` 拼出含 `C:` 的非法路径，写入抛错。
5. `src/memory/merge.ts:349-351` `catch (e) { dropped.push(...) }` **静默吞掉异常**，该 op 既不进 `applied` 也不报错给调用方。
6. 结果：`applyOps` 返回 `applied = []`，`tests/memory-capture.test.ts:378` `r.applied[0]?.status` 为 `undefined`；`:379` 断言的续页文件也不会生成。

**根因函数**：`applyOps()` 中三处 `target.split("/").pop()`（次要健壮性问题：`validatePageName` 未拒绝路径分隔符）。
**最小修法**：`src/memory/merge.ts:13` 改为 `import { basename, join } from "node:path"`，把 `:309`、`:312`、`:320` 的 `target.split("/").pop()` 全部换成 `basename(target)`（或把 `:295` 的 `cont` 提升到外层作用域，直接复用 `page: split ? cont : op.page`，零额外依赖）。建议同时让 `:349` 的 `dropped` 至少带 op 标识与 stack，避免同类缺陷再次静默。
**影响面**：
- 触发条件仅在 Windows（POSIX 上 `target` 用 `/`，`split("/").pop()` 正常返回文件名），**非 Windows 平台不受影响**；但 `split("/")` 本身是跨平台写法错误。
- 功能后果不只是测试红灯：Windows 上「单页超 16KB 自动转续页」整条链路失效，**自动记忆内容被静默丢弃**（`dropped` 且无告警），续页文件也不产出。属需要修的产品缺陷，不能归为环境限制。

### #44 output-probe C1：测试夹具的 POSIX 分隔符假设

**产品契约**：`tests/output-probe.test.ts:202` 注释自述「`loadConfig` 只从 cwd / 包根 / `~/.neo` 搜 settings.json，所以用临时 cwd」。`src/config.ts` 的 `loadConfig` 本阶段未被调用到（测试在 `chdir` 就崩）。

**测试假设**：`tests/output-probe.test.ts:203-213`
```ts
const path = writeSettings([entry]);
const dir = path.slice(0, path.lastIndexOf("/"));   // :205
process.chdir(dir);                                  // :208
```
Windows 上 `path` 是 `C:\...\case-1\settings.json`（反斜杠），`lastIndexOf("/")` 返回 **-1**，`slice(0,-1)` 去掉最后一个字符 → `C:\...\case-1\settings.jso`。证据 `ENOENT: ... chdir '...\issue-52\' -> 'C:\...\case-1\settings.jso'` 与此**逐字吻合**（那个看似诡异的 `.jso` 正是 `slice(0,-1)` 的产物）。

**判定**：产品 `loadConfig` 无缺陷，是测试的 POSIX 分隔符假设。
**应改哪一行**：`:205` 改为 `const dir = dirname(path);`（从 `node:path` 导入 `dirname`），或 `path.slice(0, path.lastIndexOf(sep))`。
**为什么不算掩盖红灯**：`loadConfig` 的两种写法解析、`outputProbe` 默认值、非法形状回落（`:214-219`）全部仍在真实临时目录下被逐条验证；改的只是测试推导「settings.json 所在目录」的方式，反而让 `chdir` 真正指向存在的目录，断言强度不降反升。

### #45–#51（7 条）references C3b：测试夹具的 POSIX 路径字符串假设 —— **产品路径解析并未失效**

> 这是 12 条里最像真缺陷的一组，结论**反直觉**：`expandReferences` 的 Windows 路径解析是正确的，失效的是测试注入桩。

**产品契约**：`src/input/references.ts:139-141`
```ts
// 相对路径一律相对 `opts.cwd`（cfg.cwd）解析：neo 可以用 -C 切工作目录，
// 但 process.cwd() 仍是启动目录，直接用相对路径会「明明有文件却报不存在」。
const absOf = (p: string): string => (isAbsolute(p) ? p : join(opts.cwd, p));
```
`:24-33` `ExpandOptions` 允许注入 `exists` / `readFile` / `statSize` / `readSlice`，注释写明「路径是否存在（相对 cwd 或绝对路径）」。`tests/references.test.ts:14` 也自述「注入的 IO 收到的是**绝对路径**（相对 opts.cwd 解析后的结果）」。真实运行时 `cwd` 是 Windows 原生路径，`join` 产出反斜杠路径，`existsSync` 用同一口径，工作正常。

**测试假设**：`tests/references.test.ts:15-27`
```ts
const files: Record<string, string> = {
  "/repo/a.ts": "const a = 1;\n",
  "/repo/src/b.ts": ..., "/repo/bin.dat": ..., "/repo/big.txt": ...,
};
const deps = {
  cwd: "/repo",
  exists: (p: string): boolean => p in files,   // 精确字符串匹配
  readFile: (p) => files[p]!,
  statSize: (p) => Buffer.byteLength(files[p] ?? "", "utf8"),
};
```
桩键是**硬编码 POSIX 字符串** `/repo/a.ts`。Windows 上 `join("/repo","a.ts")` 返回 `\repo\a.ts`（反斜杠），`p in files` 为 false → `src/input/references.ts:166-168` 走「`${r.token} 不存在，按原文保留`」分支 → `refs=[]`、`errors` 只有「不存在」。

**与全部证据逐条对应**：
| 用例 | 证据文本 | 由上述失配解释 |
| --- | --- | --- |
| #45 | `Received: "看 @a.ts"`（无展开块） | `refs=[]` → `:210` 原样返回 |
| #46 | `refs.length` `Expected: 1 / Received: 0` | 同上 |
| #47 | `Received: "@bin.dat 不存在，按原文保留"` | `:167` 的报错分支抢在二进制判断 `:192` 之前 |
| #48 | `TypeError: undefined is not an object (evaluating 'r.refs[0].truncated')` | `refs[0]` 不存在 |
| #49 | `Expected: 5 / Received: 0`（`:119-132` 桩键 `/repo/fN.ts`） | 同样的精确匹配失配 |
| #50 / #51 | `Expected: 1 / Received: 0` | 同上 |

**三条交叉印证（关键）**：
1. C3a 解析组（`:29-79`）5 条在基线中均为 `(pass)` —— 它们只测 `parseReferences`，**不碰文件路径**，所以不受 `join` 影响。
2. C3c（`:162-200`）中「绝对路径原样使用」「绝对/相对指向同一文件」等纯绝对路径用例在基线中**未出现在失败清单** —— `isAbsolute("/repo/a.ts")` 为 true，产品直接用 `/repo/a.ts`，与桩键匹配，所以 pass。
3. **#52 的直接证据**：`C3c 相对路径按 opts.cwd 解析` 报 `Expected: "/work/proj/a.ts" / Received: "\work\proj\a.ts"`（`:163-179` 断言 `seen[0]`）。这正是 `join("/work/proj","a.ts")` 在 Windows 上的**正确输出**，等于把产品行为原样打印出来 —— 证明 `join` 生效、产品没有「路径解析失效」。

**判定**：7 条（连同上一份报告里归为 R 的 **#52** 一并可定性）均为**测试夹具的 POSIX 路径字符串假设**，不是产品缺陷。`expandReferences` 在 Windows 下路径解析正常。
**应改哪一行**：`tests/references.test.ts:15-27` 的桩改为用 `node:path` 生成键（例如 `const REPO = join(tmpdir(), "repo-fixture")`、键用 `join(REPO,"a.ts")`、`cwd: REPO`），或让 `exists`/`readFile`/`statSize` 对入参做 `resolve`/`normalize` 后再比较；`#52` 的 `:169`、`:173`、`:177` 断言改用 `join("/work/proj","a.ts")` 之类平台无关写法，而不是硬编码 `"/work/proj/a.ts"`。
**为什么不算掩盖红灯**：改的是「假文件系统」的路径表示，被测逻辑（预算截断、二进制跳过、5 文件上限、去重、字节预算、起止标记、行数统计）一条不断言删减，反而让 C3b 在 Windows 上**第一次真正跑到**这些分支。当前这 7 条红灯的本质是「测试根本没测到产品逻辑」，与 symlink/EPERM 类一样属于**验证盲区**，不是可豁免的绿灯。

### #53 skill-slash S2.1：测试夹具的 POSIX 路径假设

**产品契约**：`src/skills.ts:619-648` `tryLoadSkillForSlash`
```ts
const files = listSkillFiles(r.meta.absPath)
  .filter((f) => f !== "SKILL.md")
  .map((f) => join(r.meta.absPath, f));
```
`:642` 注释明确：「附件给绝对路径：slash 路径不建软链，相对路径在项目区可能不可达」。契约是**平台原生绝对路径**，Windows 上即 `C:\...\references\detail.md`。

**测试假设**：`tests/skill-slash.test.ts:166-175`
```ts
expect(r.files.some((f) => f.endsWith("references/detail.md"))).toBe(true);  // :172 ← 证据指向的行
expect(r.files.every((f) => f.startsWith("/"))).toBe(true);                   // :174
```
`makeCfg()`（`:37-74`）用 `realpathSync(mkdtempSync(join(tmpdir(), ...)))` 造 Windows 临时目录，`:53-54` 写 `store/demo/references/detail.md`。因此 `r.files` 实际为 `C:\...\references\detail.md`：`endsWith("references/detail.md")` 因反斜杠失配 → 证据 `Expected: true / Received: false`（`skill-slash.test.ts:172:69`）；`startsWith("/")` 也必然失配。**该用例与 symlink/EPERM 无关**（S2 走 `createLink:false`，不建软链），不是被 skills 软链失败波及。

**判定**：测试夹具的 POSIX 路径假设，产品无缺陷。
**应改哪一行**：`:172` 改为 `f.endsWith(join("references","detail.md"))` 或 `basename(f) === "detail.md"`；`:174` 改为 `isAbsolute(f)`（从 `node:path` 导入）。
**为什么不算掩盖红灯**：被测契约「返回技能正文 + 平台原生绝对路径附件、不建软链」仍被完整验证，且 `isAbsolute` 比 `startsWith("/")` 是更强的断言。

---

## 3. 汇总

### 3.1 按判定三分类

| 判定 | 条数 | 用例编号 |
| --- | --- | --- |
| **真实产品缺陷** | **1** | `#39` |
| **测试夹具的 Windows 路径或 POSIX 假设** | **10** | `#2`、`#44`、`#45`、`#46`、`#47`、`#48`、`#49`、`#50`、`#51`、`#53` |
| **必须实跑才能定性** | **1** | `#6` |
| 合计 | **12** | — |

（附带收益：上一份报告中列为 R 的 `#52` 现已可明确定性为「测试夹具的 POSIX 路径假设」，见 §2 #45–#51 第 3 条交叉印证；它不计入本阶段 12 条。）

### 3.2 按根因模式聚合

| 根因模式 | 条数 | 涉及用例 |
| --- | --- | --- |
| 测试侧 `split("/")` / `lastIndexOf("/")` 取路径分量 | 2 | `#2`、`#44` |
| 测试侧 `startsWith("/")` / `endsWith("posix/path")` 断言 | 1 | `#53` |
| 测试桩硬编码 POSIX 路径字符串 + 精确字符串匹配 | 7 | `#45–#51` |
| Git for Windows `check-ignore` 规则来源异常，待实跑 | 1 | `#6` |
| **产品代码 `split("/")` 取文件名（真实缺陷）** | **1** | `#39` |

值得注意：`split("/")` 这一个写法在 12 条里出现了 **3 次**（`#2`、`#39`、`#44`），前两次在测试、后一次在产品 —— 只有产品侧那次是真缺陷。这说明「同样的红灯文本」必须逐条追到代码位置，不能按错误文本归类。

---

## 4. 必须在最终验收前修复 / 复核的清单

### 4.1 必须修复（真实产品缺陷）

| 优先级 | 用例 | 必修内容 | 验收方式 |
| --- | --- | --- | --- |
| **P0** | `#39` | `src/memory/merge.ts:309/312/320` 三处 `target.split("/").pop()` → `basename(target)`（或复用 `cont`）；建议同时给 `:349` 的 `dropped` 补 op 标识/stack，避免静默吞异常 | 在 Windows 上验证 `B7 页面超限转续页` 的 `status === "split"` 且 `决策-大页-续1.md` 真实生成；并确认 B1–B6 / B8 / B9 不回归。非 Windows 平台应无行为变化。 |

> **不修的后果**：Windows 上「单页超 16KB 转续页」功能完全失效且**自动记忆内容静默丢失**，这不是测试红灯而是用户可见的数据丢失。不得因「只在 Windows 触发」而降级为环境问题。

### 4.2 必须复核（未定性，不得声称已修复）

| 优先级 | 用例 | 复核内容 |
| --- | --- | --- |
| **P0** | `#6` | 按 §2 #6 的最小复现命令，在**最终验收同机、同 cwd** 下定位 `.gitignore:61` 空 pattern 的来源。若观察点 B 成立，升级为产品配置缺陷并修 `.gitignore`；若观察点 A 成立，才可把 K3 的 pathspec 改为不带尾斜杠的形式，且**必须保留 K4 的文本守卫**、并在最终报告写明 Git for Windows 2.55.0 的该行为。 |

### 4.3 建议修复（测试夹具，但**不得当作「BUG 已修复」计入**）

`#2`、`#44`、`#45–#51`、`#53` 共 10 条，按 §2 各自给出的行号改断言/桩。三点约束：

1. 改的是**测试**，不是产品代码；在最终报告中必须单独成节说明「修复了测试夹具的跨平台假设」，**不能与「修复产品 BUG」混为一谈**。
2. 这 10 条在基线里仍是 `(fail)`。前后对比时，若本轮**没有**实际改动这些测试文件，它们应落在 `Base ∩ After`（既存失败），**不得写成「已修复」或「通过」**；若改了测试文件而转绿，必须逐条说明改动行与「为何不算掩盖红灯」。
3. 尤其是 `#45–#51`：当前状态是「C3b 展开逻辑在 Windows 上**从未被真正执行到**」，属于验证盲区。改完桩后这 7 条才会第一次真实覆盖预算截断 / 二进制 / 5 文件上限等分支，**需要重新观察结果** —— 不排除届时暴露出此前被掩盖的产品缺陷。

### 4.4 对上一份诊断的修正

- 上一份 §4.2 把 12 条统一列为「可能与产品代码相关」。本阶段细化后：**仅 1 条是真缺陷（`#39`），10 条是测试夹具，1 条待实跑**。
- 上一份 §4.4 写「38 条 P+R 若被整体归为环境问题，则『已知及新发现的 BUG 都已修复』无法被诚实支撑」—— 该结论**依然成立**，且现在更具体：至少 `#39` 是真缺陷、`#6` 未定性，二者都不允许用「Windows 环境问题」带过。
- 但不能走向另一个极端：这 11 条（10 夹具 + 1 待实跑）**也不是可豁免的绿灯**。它们仍是 106 条基线红灯的组成部分，最终前后对比必须逐条核对。

---

## 5. 约束遵守声明

- 未重跑 `bun test` / `verify.sh`，未执行任何测试用例（仅执行只读 `git` 查询与文件读取），避免干扰 `.neo/worktrees/issue-37` 的并行工程师工作。
- 未修改 `src/`、`tests/`、任何配置、`web/`、其它 `docs/`、`docs/evidence/`；仅新建本文档。
- 未做修复、未出具通过结论、未写 ALL GREEN、未隐藏任何一条红灯（12 条逐条列出，含唯一真缺陷与 1 条未定性项）。
- 未提交 git、未推送。
