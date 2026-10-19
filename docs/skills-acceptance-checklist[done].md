# 实现前自检清单（产品专员产出）

> 依据：`docs/skills-prd[done].md` v0.1.0 全文 916 行 + worktree `feature/skills` 源码逐行核对
> 核对时间：2026-10-15
> 基线实测：`bun test` **46 pass / 0 fail**、`bunx tsc --noEmit` **0 error**（已亲自跑过，非引用 PRD）

---

## 零、给开发/测试 Agent 的 8 条必读红线

| # | 红线 | 依据 |
|---|---|---|
| R1 | **`src/skills.ts` 零第三方依赖**，不得改 `package.json` 的任何字段 | §6 约束 1、§9.3 |
| R2 | **`discoverSkills(cfg)` / `resolveSkill(cfg,name)` 必须从 `cfg.skillsStore` 读全局库路径**，禁止在 `skills.ts` 内部出现 `homedir()` | §7.3 强制要求 |
| R3 | **写工具守卫也必须读 `ctx.cfg.skillsStore`**，不得用模块级 `join(homedir(),...)` 常量 —— 否则 G1/G2 会写真实 `~/.neo/skills` | §6.4 示例代码有缺陷，见下方 P2 |
| R4 | 名称白名单 `/^[a-z0-9][a-z0-9-]*$/`，在 `resolveSkill` **第一行**校验 | §6 约束 2 |
| R5 | 守卫用 `realpathSync`（字符串比较对软链无效），且放在 `ctx.approve()` **之前** | §6 约束 11/12 |
| R6 | 软链用**绝对路径**（`symlinkSync(globalAbs, localLink)`） | §6 约束 3 |
| R7 | 索引段插在 `## 工具` 段之后（`system-prompt.ts:85` 之后）、`## 环境` 之前 | §6 约束 9 |
| R8 | 不得实现 §10.2 的六项「不做」：热加载 / `allowed-tools` / `dependencies` / 网上安装 / 版本管理 / 全局库入 git | §10.2 |

---

## 一、§5 前置必修 — symlink 遍历（地基，4 处）

行号已**逐行核对，全部准确**：

- [ ] `src/tools/index.ts:258` — `listDir` 的 walk：`if (e.isDirectory()) {`
- [ ] `src/tools/index.ts:326` — `globTool` 的 walk：`if (e.isDirectory()) {`
- [ ] `src/tools/index.ts:469` — `grepTool` 的 walk：`if (e.isDirectory()) {`
- [ ] `src/system-prompt.ts:40` — `listFiles` 的 walk：`if (e.isDirectory()) {`

**验收（§5.3）**
- [ ] `glob "skills/**/*.md"` 能列出软链内的 `SKILL.md`
- [ ] `grep` 从 cwd 递归能命中软链内文件
- [ ] `list_dir skills` 把软链显示为 `foo/`（带尾斜杠）
- [ ] system prompt 工作目录树把 `skills/foo` 显示为目录

**§5.1 探针表独立复现（已实测，非引用 PRD）**：
沙箱 `/tmp/neo-probe/cwd/skills/pdf -> /tmp/neo-probe/store/pdf`，实跑 `dispatch`：

| PRD 声称 | 实测输出 | 结论 |
|---|---|---|
| `list_dir skills` 部分走软链，被当文件 | `pdf  (96B, 2026-10-15 07:01)` | ✅ 复现 |
| `glob "skills/**/*.md"` 返回 `[]` | `无匹配文件: skills/**/*.md` | ✅ 复现 |
| `grep` 从 cwd 递归 `filesScanned: 0` | `无匹配。扫描 0 个文件，模式: NEEDLE_XYZ` | ✅ 复现 |
| `read_file skills/pdf/SKILL.md` 正常 | 完整读出 6 行带行号内容 | ✅ 复现 |
| `grep path=skills/pdf` 显式指定正常 | `SKILL.md:6: NEEDLE_XYZ` | ✅ 复现 |
| `write_file` 穿透写入全局库 | `已创建 /tmp/neo-probe/cwd/skills/pdf/new.md`（**穿透成功**） | ✅ 复现，且确认这是真实安全风险 |

**6/6 全部复现**，§5 的缺陷描述可信，无需再验。

**⚠ 偏离 PRD 的必要修正（见 P1）**：不能简单写成 `e.isDirectory() || e.isSymbolicLink()`，会引入回归。
**⚠ 补充要求（见 P10）**：约束 3 的软链创建必须先 `mkdirSync(<cwd>/skills)`，否则首次调用即ENOENT 崩溃。

---

## 二、§6 实现规格 — 16 条约束逐条验收

### 6.1 `src/skills.ts`（新建，约 150 行）

- [ ] 约束 1 frontmatter 最小解析器，无第三方依赖
- [ ] 约束 2 名称白名单 `/^[a-z0-9][a-z0-9-]*$/`，非法返回 `reason:"malformed"`、`message:"技能名非法: xxx"`、`available:[]`
- [ ] 约束 3 软链创建幂等（`existsSync` → 直接返回 `createdLink:false`）
- [ ] 约束 3 软链用**绝对路径**
- [ ] 约束 4 项目技能优先，同名不碰全局库
- [ ] 约束 5 `discoverSkills` 按 `name` 字典序排序（同名时项目条在全局条之前，保证稳定）
- [ ] 接口签名与 §6.1 完全一致：`SkillMeta` / `ResolveResult` / `discoverSkills` / `parseFrontmatter` / `buildSkillIndex` / `resolveSkill` / `listSkillFiles`
- [ ] `parseFrontmatter` 无 `description` 时回退正文首个 `# 标题`，再退目录名；解析失败**不抛异常**
- [ ] `listSkillFiles` 返回相对 `absPath` 的路径（如 `references/detail.md`）

### 6.2 `use_skill` 工具

- [ ] 加进 `src/tools/index.ts:651` 的 `TOOLS` 数组**末尾**（`webFetch` 之后）
- [ ] `sensitive: false`
- [ ] `spec.type === "function"`，`parameters.required` 含 `"name"`
- [ ] `execute` 走 `resolveSkill(ctx.cfg, ...)`，**不硬编码路径**
- [ ] 输出格式：SKILL.md 全文 → `---` → 附件清单 → `来源：…` 行
- [ ] 约束 6 不自己实现截断（交给 `dispatch()` 的 `limitOutput`，已核对在 `tools/index.ts:710`）
- [ ] 约束 7 建软链必须在输出里明说来源
- [ ] 约束 8 目录存在但缺 `SKILL.md` → 返回失败，message 含「缺少 SKILL.md」，**不视为成功**
- [ ] `not_found` 时输出含 `可用技能：a, b, c`

### 6.3 system prompt 注入

- [ ] `src/system-prompt.ts` `buildSystemPrompt()`（第 52 行）内调用 `discoverSkills(cfg)`
- [ ] 索引段插在 `## 工具` 段之后（第 85 行后）、`## 思考方式`（第 87 行）之前
- [ ] 约束 9 必须在 `## 环境`（第 105 行）之前 → `noteModelChange` 的 `/- 模型：[^\n]*/` 只匹配一处
- [ ] 约束 10 `skills.length === 0` 时**完全不输出**技能段落，无空标题残留
- [ ] 索引每技能严格一行 `- 名称：描述`

### 6.4 写工具守卫

- [ ] 新增 `insideGlobalSkills(ctx, p)`，store 路径来自 `ctx.cfg.skillsStore`
- [ ] 用 `realpathSync`（约束 11）
- [ ] 守卫在 `ctx.approve()` **之前**（`writeFileTool.execute` 第 147 行前、`editFile.execute` 第 198 行前）
- [ ] 抛 `ToolError`，message 含「禁止写入全局技能库」
- [ ] 约束 13 路径不存在时对**父目录**做 realpath 判断

### 6.5 `.gitignore`

- [ ] **增量追加** 3 条规则，**绝不整份覆盖**（现有 15 行，含 `.worktrees/`，覆盖会删掉它）
- [ ] `.neo/skills/`、`neo-session.json`、`.neo/.wiki/outputs/`
- [ ] 约束 14 不加 `!` 反向规则
- [ ] 约束 15 不给 `.neo/.wiki/raw/` 和 `.neo/.wiki/` 加规则

### 6.6 / 6.7 `/skills` 命令

- [ ] `src/index.ts` `handleCommand()`（函数在第 522 行，switch 在第 535 行）加 `case "skills"`
- [ ] `/skills` 列出全部技能，标注来源与是否软链
- [ ] `/skills <名称>` 只打印索引信息 + SKILL.md 首行，**不打印全文**（约束 16）
- [ ] `HELP`（第 148-192 行）「交互命令」段加 `/skills` 一行

---

## 三、§7 测试规格 — 57 个必测用例（PRD 实际列出数，非 team-lead 所说的 61）

| 组 | 用例 | 数量 | 备注 |
|---|---|---|---|
| A | A1-A6 frontmatter 解析 | 6 | |
| B | B1-B7 技能发现 | 7 | B6 原文「两个 store 技能名 a、b、c」是笔误，实为三个 |
| C | C1-C10 名称校验与解析 | 10 | C2 原文与 C3 场景描述重复，见 P4 |
| D | D1-D4 索引生成 | 4 | |
| E | E1-E12 `use_skill` | 12 | |
| F | F1-F5 symlink 回归 | 5 | |
| G | G1-G6 写工具守卫 | 6 | |
| H | H1-H4 prompt 注入 | 4 | |
| I | I1-I3 端到端 | 3 | |
| | **合计** | **57** | 加上 §7 未列但约束要求的补充用例，实际 test 数会更多 |

### 测试脚手架强制要求（§7.3）
- [ ] 全部路径基于 `mkdtempSync` 沙箱
- [ ] **每个用例独立子目录**（PRD 未要求，但 B/C/D/G 组互相污染，见 P5）
- [ ] **绝不读写真实 `~/.neo/skills/`**
- [ ] store 路径通过 `Config.skillsStore` 注入
- [ ] 末尾 `cleanup()`
- [ ] 断言中的路径比较必须两边都 `realpathSync`（macOS `/var` → `/private/var`，见 P6）
- [ ] **删掉脚手架里 `globTool` / `grepTool` 的 import**（未导出，见 P7）；F 组一律走 `dispatch("glob", ...)` / `dispatch("grep", ...)`
- [ ] C3 / I1 的沙箱**不预先创建 `skills/` 目录**（见 P10，否则测不出 ENOENT）
- [ ] 补 F6：软链到**文件**时 glob 仍能匹配（见 P1，否则测不出回归）
- [ ] 补 D5 / D6：索引含 `## 技能` 标题与结尾引导句（见 P11）
- [ ] 补 G6 修正：断言 `output` 以 `错误: ` 开头，而非 `r.ok===false`（见 P12）
- [ ] 补 J1~J3：`.gitignore` 与 `/skills` 约束覆盖（见 P13）

### §8 已知破坏
- [ ] `tests/core.test.ts:51-64` 的 `EXPECTED` 加 `["use_skill", false]`
- [ ] 测试名「恰好 8 个工具」改为「恰好 9 个工具」
- [ ] 断言 `toolNames()` 长度为 9
- [ ] `use_skill` 放在数组**末尾**（`web_fetch` 之后），与 §6.2「加进 TOOLS 数组末尾」一致

**已核对**：`EXPECTED` 实际在 51-60 行，`test("恰好 8 个工具…")` 在 62-64 行 —— PRD §8 说的「52-64」「52-60」是近似值，实际范围 51-64，不影响修改。

---

## 四、§9 Definition of Done

- [ ] 9.1 七项功能全部可验证
- [ ] 9.2 四处 symlink 修复 + glob/grep/list_dir/目录树均能遍历软链
- [ ] 9.3 `bunx tsc --noEmit` 0 error；`bun test` 全绿；`skills.ts` 零第三方依赖；不读真实 `~/.neo/skills`
- [ ] 9.4 上下文预算 —— **注意 PRD 数字有误，见 P3**，用相对增量验收

### §9.4 的修正验收口径（替代 PRD 原值）

| DoD 项 | PRD 原值 | **修正为** |
|---|---|---|
| 工具 spec 总数 | 875 → 954（+79，+9.0%） | 实测 901 → 997（**+96**）；按**净增 60~120 tokens** 区间验收，不卡绝对值 |
| 技能索引 | ≤ 18 tokens/技能 | **≤ 20** tokens/技能（实测 18.9） |
| 无技能时无额外段落 | ✅ | ✅ 保持（约束 10 + H2） |

### §9.1 七项功能逐项验证方式（补全，原文只给了 checkbox）

| # | 功能 | 怎么算验证通过 |
|---|---|---|
| 1 | 全局技能进索引 | 沙箱 store 建技能 → `buildSystemPrompt` 含 `## 技能` 与该技能名（H1） |
| 2 | `use_skill` 返回三项内容 | 输出同时含 SKILL.md 正文特征串 + 附件名 + 「来源」（E4/E5/E6） |
| 3 | 首次软链 + 二次幂等 | 首次 `createdLink:true` 且 `lstat.isSymbolicLink()`；二次 `false`（C3/C4/E7/I2） |
| 4 | 项目私有技能优先 | 同名时用项目条，且 store 目录 mtime/内容未变（C10） |
| 5 | 非法名被拒| 穿越/大写/下划线 → `reason:"malformed"`（C6/C7/C8）+ DoD 提到的大写（C8 只测下划线，**建议补大写用例**） |
| 6 | 写工具无法穿透 | `write_file`/`edit_file` 均 `ok:false` 且含「禁止写入全局技能库」（G1/G2） |
| 7 | `/skills` 与 `/help` 可用 | `/help` 含 `/skills` 行；`/skills` 列出全部（**§7 零覆盖，见 P13**） |

---

## 五、§10.2 明确不做（范围蔓延监控清单）

实现中若出现以下内容，视为越界：
1. 技能热加载 / 会话内刷新 / `/skills reload` / 哨兵注释包裹
2. `allowed-tools` 白名单解析
3. `dependencies` 依赖声明
4. 从网络安装技能
5. 技能版本管理
6. 把全局库纳入 git

---

## 六、PRD 与源码不符 / PRD 内部矛盾清单（共 9 项）

### P1 【中等·会导致回归】§5.2 的「四处统一改为 `|| e.isSymbolicLink()`」是错的
- **问题**：`readdirSync(withFileTypes)` 对**指向文件**的软链也返回 `isSymbolicLink()=true`。统一改成 `|| e.isSymbolicLink()` 后，`glob`/`grep` 会把「软链到文件」走进 `walk()` 分支，于是 `walk()` 里 `readdirSync` 抛错被 `catch` 吞掉 → 该软链文件**永远不会被当作文件匹配**，比修复前更差。
- **实测证据**（沙箱内同时放「软链到目录」`dirlink` 与「软链到文件」`filelink.md`，跑 `glob skills/**/*.md`）：

  | 修法 | glob 命中结果 |
  |---|---|
  | 修复前（只看 `isDirectory()`） | `skills/filelink.md` ← 只拿到文件软链，**漏掉目录软链内的 SKILL.md** |
  | **PRD  naive `\|\| isSymbolicLink()`** | `skills/dirlink/inside.md` ← **文件软链彻底消失** |
  | 建议修法（statSync 跟随判断） | `skills/dirlink/inside.md`, `skills/filelink.md` ✅ 两者都在 |

  naive 修法把「1 个命中且命中错的那个」变成「1 个命中但命中对的那个」——看起来 §5.3 验收能过，实则**换了一个 bug**，且旧 bug 复现。
- **修正**：改为「目标是目录才walk」，用 `statSync`（会跟随软链）判断：
  ```ts
  const isDir = e.isDirectory() || (e.isSymbolicLink() && isDirTarget(full));
  ```
  其中 `isDirTarget(p)` = `try { return statSync(p).isDirectory() } catch { return false }`。
- **影响**：完全满足 §5.3 与 F1~F5 全部验收，同时消除回归。
- **⚠️ 给测试 Agent**：F1~F5 只用「软链到目录」的场景，**测不出这个回归**。建议补 F6：软链到**文件**时 `glob` 仍能匹配到它。

### P2 【高·安全风险】§6.4 的守卫示例与 §7.3 强制隔离要求直接冲突
- **问题**：§6.4 示例代码写 `const GLOBAL_SKILLS = join(homedir(), ".neo", "skills")`（模块级常量）。若照此实现，G1/G2 测试无法注入沙箱 store，**测试会写真实 `~/.neo/skills`**（社长的真实资产）。
- **PRD 自证**：§7.4 第 2 条自己承认「守卫测试 G1/G2 若不便注入…通过 `Config` 指向沙箱内的假 store」。
- **修正**：守卫签名改为 `insideGlobalSkills(ctx: ToolCtx, p: string)`，内部读 `ctx.cfg.skillsStore`，默认值才回落 `homedir()`。**测试可隔离是硬要求，优先于示例代码的写法。**

### P3 【低·验收数字错】§9.4 的 token 数字与源码实测不符
- PRD 称：875 → 954（+79，+9.0%）
- **实测**（用 `src/llm.ts:302` 的 `estimateTokens`，与 §1.2 自述同一算法）：
  ```
  工具数: 8
  基线 tokens: 901
  加 use_skill 后: 997
  净增: 96
  ```
- **结论**：875/954/+79/+9.0% 四个数字全部偏低。§9.4 应按**相对增量**验收：净增 60~120 tokens 区间即合格，不卡绝对值。

#### P3 补充：§1.2 / §4.3 / §9.4 的索引与正文 token 也全部偏低

| PRD 位置 | PRD 声称 | 实测 | 偏差 |
|---|---|---|---|
| §1.2 | 20 条中文索引 = **230** tokens | **363** | +58% |
| §1.2 / §4.3 | 20 条英文索引 = **355** tokens | **452** | +27% |
| §1.2 | 单份 SKILL.md（1200 字）= **368** tokens | 650 汉字 = **368**；1200 汉字 = **676** | PRD 的 368 对应约 **650 字**，不是 1200 字 |
| §1.2 / §9.4 | 索引 **12~18** tokens/技能 | **18.9** tokens/技能 | 刚好卡在上限外沿 |
| §4.3 | 中文索引比英文**更省** | 中文 363 < 英文 452 ✅ | **结论成立**，仅绝对值错 |

- **注意 §4.3 的核心结论仍然成立**（中文确实更省），不要因为数字错就推翻语言选择的判断。
- §6.2 约束 6 说「约 370 tokens 的 SKILL.md 远低于上限（30000 字符）」—— 结论仍安全。
- **DoD 修正建议**：§9.4 第 2 条「≤ 18 tokens/技能」按实测应为 **≤ 20**，否则一个正常写法的中文技能就会卡线失败。

### P4 【低·用例描述错】§7.1 C2 与 C3 场景文字相同但期望相反
- C2「合法名，仅 store 有 → `createdLink:false`（已是软链）」与 C3「合法名，仅 store 有，**首次调用** → `createdLink:true`」描述的场景一样，期望相反。
- **裁决**：C2 = 项目区已存在指向 store 的软链（上一次调用留下的）→ `createdLink:false`；C3 = 首次调用 → `true`；C4 = 连续两次调用 → 第二次 `false`。三者不重复。

### P5 【中·测试串扰】§7 脚手架只有一个共享 SANDBOX，会互相污染
- B2 需要「项目区有真目录 + store 有同名」，若 C3 已在本区建过同名软链，B2 就不是真目录了。
- **修正**：每个用例 `mkdtempSync(join(ROOT, "<组>-<序号>-"))` 独立子目录。这不降低断言标准，是保证断言有效性的必要隔离。

### P6 【中·macOS 假失败】tmpdir 路径 realpath 不一致
- macOS 上 `tmpdir()` = `/var/folders/...`，而 `realpathSync` 结果是 `/private/var/folders/...`。
- **后果**：G 组断言「realpath 落在 store 内」若拿未 realpath 的期望路径比较，会**假失败**。
- **修正**：断言中所有路径比较两边都过 `realpathSync`。

### P7 【中·会导致 tsc 报错】§7 给的 import 列表引用了未导出的符号
- §7 脚手架写 `import { TOOLS, toolNames, dispatch, globTool, grepTool } from "../src/tools/index.ts";`
- **实际**：`src/tools/index.ts` 只导出 `TOOLS, toolSpecs, toolNames, globToRegExp, htmlToText, dispatch, ToolError, shortArgs, resolvePath, insideCwd`。**`globTool` 与 `grepTool` 未导出**，照抄会 tsc 报 TS2305，违反「只允许因 `src/skills.ts` 不存在而报错」。
- **修正**：F 组一律通过 `dispatch("glob", ...)` / `dispatch("grep", ...)` 调用（§7.1 F1/F2 原文本来也是这么写的，§7 脚手架那行 import 是多余的）。

### P8 【低·矛盾】B2「两条都返回」与 §6.1「同名以项目为准」冲突
- 若同名两条都进索引，会出现两行同名 `- pdf：…`，违反「一行一技能」与索引可扫描性。
- **裁决**：`discoverSkills` 按 B2 返回**两条**（测试照此断言）；`buildSkillIndex` 内部按 `name` 去重、同名取项目条。两者都满足。

### P9 【低·规则缺失】§3.3 说软链「必须忽略」，但 §6.5 的规则集里没有任何规则能忽略它
- §6.5 只忽略 `.neo/skills/`（全局库，在 home 下，本就不在仓库内），而**真正需要忽略的是项目里的 `skills/<name>` 软链**。
- **技术事实**：gitignore **无法**区分 symlink 与真目录，无法「只忽略软链、保留真目录」。
- **裁决**：不擅自加规则（加了会连项目私有技能一起 ignore，违反 §3.3 的另一半）。作为**已知残留风险**上报给 team-lead 裁决。软链是绝对路径，检出到别的机器会变成一个「装着路径字符串的普通文件」，不会破坏构建。

### 附：§7.1 D4 与 §6.1 约束 1 的回退策略描述不一致
- D4「description 缺失 → 回退为目录名」；约束 1「无 description 时回退：取正文第一行 `# xxx`」。
- **裁决**：D4 只断言「非空」（两种策略都满足，不断言具体值）；另加一个用例覆盖约束 1（有 `# 标题` 时用标题）。

### 附：§6.2 输出格式示例里的来源路径
- 示例写死「来源：全局技能库 ~/.neo/skills/pdf」，但测试注入的是沙箱路径。
- **裁决**：实现输出**实际** store 路径；E6 只断言含「来源」二字（PRD 原文用了「或」，兼容）。

### 附：§6.5 说「.gitignore 当前 13 行」，实际 15 行
- 现有第 7-8 行是 `# git worktree 工作区…` + `.worktrees/`，PRD 给的完整文件内容里**没有**这两行。整份覆盖会删掉 `.worktrees/` —— 而本 worktree 自己就在 `.worktrees/` 下。**必须增量追加。**

### P10 【高·实现即崩】约束 3 的软链创建漏了 `mkdirSync`，`<cwd>/skills` 不存在时直接抛 ENOENT
- §6.1 约束 3 只写「`symlinkSync(globalAbs, localLink)`」，**没说要先确保 `<cwd>/skills` 目录存在**。
- **实测**（`symlinkSync("/tmp", "./no-such-dir/foo")`）：
  ```
  抛错: ENOENT: no such file or directory, symlink '/tmp' -> './no-such-dir/foo'
  ```
  `mkdirSync` 后立刻成功；重复建链则抛 `EEXIST`（这条已被约束 3 的 `existsSync` 前置挡掉，无问题）。
- **触发条件极常见**：§3.2 明确「`./skills/` 初始为空」，而全新 clone 的仓库根本没有 `skills/` 目录。此时**第一次 `use_skill` 就会崩**。
- **修正**：`symlinkSync` 前必须 `mkdirSync(join(cwd, "skills"), { recursive: true })`。
- **测试要求**：I1（端到端）与 C3（首次调用）用例的沙箱**不得预先创建 `skills/` 目录**，否则测不出这个坑。

### P11 【中·测试会假绿】D 组与 §6.3 的索引格式无断言绑定
- §6.3 规定索引文本为 `## 技能` + 说明行 + `- 名称：描述` + 结尾「技能说明位于…」；§7.1 D 组只断言「每行以 `- 名称：` 开头」，**没有任何用例断言 `## 技能` 标题行与结尾说明行存在**。
- 后果：实现者只输出 `- pdf：…` 而漏掉标题与结尾，H1（只查含 `## 技能`）能过、D 组能过，但**模型不知道正文放在哪、附件怎么找** —— §6.2 的输出格式规范与 §6.3 的索引尾行是配套的，缺一不可。
- **修正**：D 组补 2 条 —— D5 断言含 `## 技能` 标题；D6 断言含「技能说明位于」或等价引导句。

### P12 【中·测不到声称的东西】G6 无法区分「抛 ToolError」与「返回错误字符串」
- G6 写「守卫抛 `ToolError` 而非字符串 → 使 `consecutiveFailures` 计入（间接：`r.ok===false`）」。
- **问题**：`dispatch()` 对**两种情况都返回 `ok:false`**（`tools/index.ts:712` 捕获 `ToolError` → `ok:false`；`715` 捕获普通 Error → 也是 `ok:false`）。所以 `r.ok===false` 这个断言**恒真**，测不出「抛 ToolError」这个语义要求。
- **修正**：G6 改为断言 `dispatch` 返回的 `output` 以 `错误: ` 开头（这是 `ToolError` 分支的专属前缀，见 `tools/index.ts:712`），或直接断言不出现 `工具执行失败:` 前缀。

### P13 【低·约束无用例】约束 14 / 15 / 16 三条约束在 §7 零覆盖
- 约束 14（`.neo/skills/` 一条即可）、约束 15（`raw/`+`wiki/` 不加规则）：已核对 §7 全部 57 条，**无任何用例涉及 .gitignore**。
- 约束 16（`/skills` 不加载全文）：**无任何用例调用 `/skills` 命令**（E 组只测 `use_skill` 工具）。整个 §6.6 的命令实现无测试保护。
- **修正**：至少补 3 条 —— J1 `.gitignore` 含 `.neo/skills/`；J2 `.gitignore` 不含 `.neo/.wiki/raw`；J3 `/skills <名称>` 输出**不含** SKILL.md 正文第二行（验证约束 16）。
- **风险等级低**（这三条都是「不要做某事」，违反不致命），但 J3 涉及一个 25 行的命令实现块，值得一条测试。

### P14 【低·描述歧义】§7.1 B6「两个 store 技能名 a、b、c」自相矛盾
- 原文：「**两个** store 技能名 **a、b、c**」——数量（2）与列举（3 个）冲突。
- **裁决**：按 3 个技能 a/b/c 实现与断言（列举的字母是硬信息）。

---

## 六之二、§7 与 §6/§9 的覆盖对账（任务 2 产出）

### 有约束但无测试

| 约束 | 内容 | 覆盖情况 |
|---|---|---|
| 约束 14 | `.gitignore` 一条规则即可 | ❌ 零覆盖 |
| 约束 15 | `raw/`+`wiki/` 不加规则 | ❌ 零覆盖 |
| 约束 16 | `/skills` 不加载全文 | ❌ 零覆盖（§6.6 整个命令无测试） |
| 约束 5 | 索引排序稳定 | ⚠️ B6 覆盖，但原文自相矛盾（P14） |

### 有测试但约束不明确（歧义源）

| 用例 | 歧义 | 裁决 |
|---|---|---|
| B2 | 「两条都返回」与 §6.1 注释「同名以项目为准」冲突 | 见 P8：discover 返回两条，索引去重 |
| C2 / C3 | 场景描述相同、期望相反 | 见 P4 |
| D4 | 与约束 1 的回退策略描述不一致 | 见文末附注：只断言非空 |
| E6 | 期望写「含 `~/.neo/skills` 或 `来源`」，但测试注入沙箱路径 | 只断言「来源」 |
| G6 | 断言测不出声称的语义 | 见 P12 |

### §10.2「明确不做」与 §6 实现步骤的冲突扫描

逐条比对**无实质冲突**，但有两处**易误做**：

| 不做项 | 易误做点 | 监控方式 |
|---|---|---|
| 会话内刷新 / `/skills reload` | §6.6 正在写 `/skills` 命令，很容易顺手加个 `reload` 参数 | §10.1 明确列了「未来路径」三件事（哨兵 / `refreshSkills` / reload），实现时**不得提前实现任何一件** |
| `allowed-tools` | 约束 1 的 frontmatter 解析器会**读到** `allowed-tools` 键 | 解析器允许识别该键但**不得据此改变任何行为**；A5 只取首行、不解析嵌套，天然覆盖 |

**结论：§10.2 与 §6 无直接矛盾。**唯一需要盯的是 `/skills reload` 的诱惑。

---

## 六之三、PRD 未覆盖的边界情况（任务 5 产出，实现时会撞上）

| # | 边界 | 会发生什么 | 建议 |
|---|---|---|---|
| B-1 | **软链指向不存在的目标（断链）** | 已实测：`existsSync` 返回 `false`（但 `lstat.isSymbolicLink()` 为 `true`）。于是约束 3 的第 1 步 `existsSync` 判定「不存在」→ 走到第 2 步试图 `symlinkSync` → 抛 `EEXIST`（因为路径确实被占了）→ **`use_skill` 整体崩** | 约束 3 应补第 0 步：`lstatSync` 成功但 `existsSync` 失败 ⇒ 认定断链 ⇒ `rmSync` 后重建 |
| B-2 | **`<cwd>/skills` 不存在** | 抛 ENOENT，第一次调用就崩 | 见 P10，必须 `mkdirSync` |
| B-3 | **技能目录内有子目录**（`references/`） | `listSkillFiles` 未说明是否递归。§11.2 的 `references/detail.md` 是嵌套的 | 应**递归**枚举相对路径；E5 只断言含文件名，嵌套与否都能过，属**欠测试** |
| B-4 | **多个技能同名**（项目 + store） | B2 要求返回两条 → 索引两行同名，违反「一行一技能」 | 见 P8：索引层去重 |
| B-5 | **description 超长** | 已实测：单条 description 重复 20 次 = **316 tokens**，是正常值的 17 倍，直接击穿 §9.4「≤ 18 tokens/技能」的 DoD | §6.1 `buildSkillIndex` 应截断 description（如 120 字符）；**§6.1 未要求任何截断，是规格缺口** |
| B-6 | **description 含换行** | 会破坏「一行一技能」 | ✅ D3 已覆盖 |
| B-7 | **`SKILL.md` 是软链** | 未提及。`readFileSync` 会跟随软链，能读到；但 `listSkillFiles` 里若用 `lstat` 判断就会漏 | 按 `existsSync` 判断即可，无实际风险 |
| B-8 | **store 目录本身是软链** | `discoverSkills` 用哪个 API 遍历未指定 | 应统一用 §5 修好后的模式 |

**B-1 与 B-5 是真正的规格缺口**，其余为实现细节。

---

## 七、行号核对总表（PRD 全部引用）

> 全部经`Read` / `sed -n` / `grep -n` 实测，无一条凭推断。

| PRD 引用 | 声称 | 实际 | 结论 |
|---|---|---|---|
| `tools/index.ts:258` | list_dir 分支 | `if (e.isDirectory()) {` | ✅ |
| `tools/index.ts:326` | glob walk | `if (e.isDirectory()) {` | ✅ |
| `tools/index.ts:469` | grep walk | `if (e.isDirectory()) {` | ✅ |
| `system-prompt.ts:40` | listFiles walk | `if (e.isDirectory()) {` | ✅ |
| `tools/index.ts:47` | insideCwd，已导出未调用 | 定义在 47，仅 731 行 export，**零调用点**（grep 全仓确认） | ✅ |
| `tools/index.ts:142` | writeFileTool.execute | `async execute(args, ctx) {` | ✅ |
| `tools/index.ts:147` | writeFile 的 approve 调用 | `const ok = await ctx.approve("write_file", detail);` | ✅ 守卫插这之前 |
| `tools/index.ts:180` | editFile.execute | `async execute(args, ctx) {` | ✅ |
| `tools/index.ts:198` | editFile 的 approve 调用 | `const ok = await ctx.approve(` | ✅ 守卫插这之前 |
| `tools/index.ts:651` | TOOLS 数组 | `export const TOOLS: ToolImpl[] = [` | ✅ |
| `tools/index.ts:664` | toolSpecs() | `export function toolSpecs()` | ✅ |
| `tools/index.ts:710` | dispatch 截断 | `return limitOutput(out, ctx.cfg.toolOutputLimit);` | ✅ |
| `tools/index.ts:719` | limitOutput 实现 | `function limitOutput(s, limit)` | ✅ 补充 |
| `system-prompt.ts:52` | buildSystemPrompt | `export function buildSystemPrompt(cfg: Config): string {` | ✅ |
| `system-prompt.ts:54-57` | 空目录树处理 | `treeText = tree.length > 0 ? ... : "工作目录为空。"` | ✅ |
| `system-prompt.ts:76-85` | `## 工具` 段 | `## 工具` 在 76，末行 web_fetch 在 85 | ✅ |
| `system-prompt.ts:105` | `## 环境` 段 | `## 环境` 在 105 | ✅ 约束 9 的锚点 |
| `agent.ts:113` | noteModelChange 正则 | 106 定义，113 `if (/- 模型：[^\n]*/.test(current))` | ✅ |
| `agent.ts:73` | messages[0] = systemPrompt | **实际 72 行** | ⚠️ 差 1 行 |
| `agent.ts:162-166` | compact 保留 messages[0] | 162 `const sys = this.messages[0];` → 163-166 放回首位 | ✅ |
| `agent.ts:459-476` | makeCtx 权限模式 | 459 `private makeCtx`，476 `}` | ✅ 完全吻合 |
| `index.ts:480` | persist 过滤 system | `const copy = messages.filter((m) => m.role !== "system");` | ✅ |
| `index.ts:323` | resume 二次过滤 | `[sys, ...restored.filter((m) => m.role !== "system")]` | ✅ |
| `index.ts:148-192` | HELP 常量 | 148 `const HELP = \``，192 `` `; `` | ✅ |
| `index.ts:535-807` | handleCommand switch | 函数 522，switch **535**，default 806，switch 收尾 807 | ✅ |
| `core.test.ts:52-64` | 8工具断言 | EXPECTED **51-60**，test **62-64** | ✅ 近似 |
| `core.test.ts:450` | cleanup() | `cleanup();` 在 450 | ✅ |
| `llm.ts:302` | estimateTokens | `export function estimateTokens(messages, tools = [])` | ✅ |
| `config.ts:264-267` | 「静默操作比显式错误贵」教训 | 注释在 264-267（providers 浅合并踩坑） | ✅ |
| `package.json` | 只有 devDependencies | 只有 `devDependencies`（`@types/bun`、`typescript`），无 `dependencies` | ✅ |
| `tsconfig.json` | 有 strict + noUncheckedIndexedAccess | `"strict": true`、`"noUncheckedIndexedAccess": true` | ✅ |
| `.gitignore` | 「当前 13 行」 | **实际 15 行** | ✗ 见文末附注 |
| `~/.neo/skills` | 不存在 | `ls` → **No such file or directory**（`~/.neo` 存在，仅含 `sessions/`） | ✅ |
| 源码总行数 | 「6866 行，含 tests/core.test.ts」 | src+tests = **5019** 行 | ✗ 偏差大，不影响实现 |
| §7 用例总数 | team-lead 转达称 61 |实际列出 **57** 条 | ⚠️ 见 §三表|

**结论**：
1. team-lead 转达的「§5 四处已修正为 258/326/469」**正确**。
2. §5 的 4 处行号 + `system-prompt.ts:40` **全部准确**。
3. §6 引用的 651/664/710/52/142/180/47/148/535 **全部准确**。
4. §13 引用的 `agent.ts:113` / `agent.ts:162-166` **准确**；`agent.ts:459-476`（§10.2）**完全吻合**。
5. **仅 2 处行号偏差**：`agent.ts:73` 实际 72（差 1 行）、`.gitignore` 13 行实际 15 行。均不影响实现。
6. 声称「已实测」的三组数据（§5.1 探针 6/6 复现✅、token 数字全部偏低❌、§10.1 resume 逻辑代码依据✅）——**结构性结论可信，具体数字需修正**。
