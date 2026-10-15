# neo 技能管理 — 需求规格说明书（PRD）

> 版本：v0.1.0 - feature/技能管理
> 文档类型：需求规格说明书（Product Requirements Document）
> 编写依据：`neo/` 目录全部源码（6866 行，含 `tests/core.test.ts`）+ 5 组symlink 实测探针 + Anthropic Agent Skills Spec 官方格式核实
> 适用范围：给**开发 Agent**（按 §6 逐条实现）与**测试 Agent**（按 §7 编写用例）执行
> 基线状态：`bunx tsc --noEmit` 零错误；`bun test` 46 pass / 0 fail
> 日期：2026-10-15
>
> **v0.1.0 变更**：§10.1 原为「待决策项」，经mock LLM 端到端实测（`-p` + `--resume` 全流程）后关闭，
> 结论为 **v0.1.0 不做会话内索引刷新**。§10 风险表与§13 未验证项已同步更新。

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 一句话 | 让 neo 支持「技能（Skill）」——模型按需加载的说明书文件夹，采用渐进式披露控制上下文 |
| 核心机制 | 三层披露：索引常驻 → 正文按需 → 附件再按需 |
| 查找顺序 | 项目 `./skills/`（含软链）→ 全局 `~/.neo/skills/` |
| 新增工具 | `use_skill(name)` —— 唯一一个新增工具 |
| 前置必修 | **4 处 `e.isDirectory()` 必须加`|| e.isSymbolicLink()`**，否则 glob/grep 扫不到软链（§5） |
| 已知破坏 | `tests/core.test.ts:62` 的「恰好 8 个工具」断言必然失败，必须同步改（§8） |
| 净增token | 工具 spec +79（875→954，+9.0%）；技能索引 12~18 tokens/技能（实测） |

---

## 1. 背景与问题

### 1.1 要解决什么

neo 目前把全部能力固化为 8 个工具（`src/tools/index.ts:651`），每个工具的行为写死在 system prompt 里（`src/system-prompt.ts:76-85`）。问题：

- **能力写死在代码里**。要新增「生成 PPT」「做Excel」这类领域能力，只能改 TypeScript 源码并重新编译。
- **领域知识与代码耦合**。「怎么写一份合规的报价单」这类流程性知识，不该躺在 `src/` 里。
- **无按需加载**。所有工具描述每轮都进上下文，无轻重之分。

### 1.2 引入技能的代价（已实测）

当前 8 个工具 spec = **875 tokens**，每轮请求都付。加 `use_skill` 后 = **954 tokens**，边际 **+79（+9.0%）**。

对比收益：技能索引20 条 = **230 tokens（中文）/ 355 tokens（英文）**，单份 SKILL.md 正文（1200 字）= **368 tokens**。

**结论：在 200k 上下文窗口下，技能子系统的开销是噪声级。** 渐进式披露的收益（能力可插拔 + 领域知识外置）远大于成本。

> 实测方法：用 `src/llm.ts:302` 的 `estimateTokens` 算法（ASCII 4 字符/token，CJK 1.5 字符/token）计算。

---

## 2. 核心概念与术语

| 术语 | 定义 | 落地形态 |
|---|---|---|
| **技能（Skill）** | 一个文件夹，含 `SKILL.md`（必需）+ 可选附件 | `~/.neo/skills/pdf/SKILL.md` |
| **技能库（Store）** | 全局技能仓库，所有机器共享的技能来源 | `~/.neo/skills/` |
| **项目技能区** | 当前工作目录下的技能落地位置 | `<cwd>/skills/` |
| **索引（Index）** | 全部技能的 `name: description` 清单，注入 system prompt | 启动时生成 |
| **软链（Symlink）** | 项目技能区指向全局技能库的链接 | `skills/pdf -> ~/.neo/skills/pdf` |
| **渐进式披露** | 三层加载：索引常驻 → 正文按需 → 附件再按需 | 见 §4 |

---

## 3. 目录布局与查找规则

### 3.1 目录布局

```
~/.neo/skills/                  # 全局技能库（唯一真实来源）
  pdf/
    SKILL.md                    # 必需
    references/detail.md        # 可选：详细参考
    scripts/extract.py          # 可选：可执行脚本
  docx/
    SKILL.md
  # ... 更多技能

<cwd>/skills/                   # 项目技能区（自动软链 + 可放项目私有技能）
  pdf -> ~/.neo/skills/pdf      # 软链：懒加载产物，gitignore
  project-specific/             # 真实目录：项目私有技能，进 git
    SKILL.md
```

### 3.2 查找规则（决策 1：B 方案 —— 用时才软链）

**关键约束：`./skills/` 初始为空，软链在模型调用 `use_skill` 时才创建。**

理由：启动时全链会导致「只加载 `./skills` 里的技能」退化为「加载所有技能」，违背省上下文目标。懒加载保证工作目录干净，且全局技能库的存在对模型透明。

查找优先级：

```
resolveSkill(name):
  1. <cwd>/skills/<name>/ 存在（真实目录或软链）→ 直接用，不动全局库
  2. 否则查 ~/.neo/skills/<name>/ 存在 → 创建软链 <cwd>/skills/<name> → 返回
  3. 否则 → 抛错，列出所有可用技能名
```

**索引来源与正文来源分离**（这是B 方案能成立的关键）：

| 数据 | 来源 | 时机 | 成本 |
|---|---|---|---|
| 索引（name+description） | **两处都扫**：`<cwd>/skills/` + `~/.neo/skills/` | 启动时 | 12~18 tokens/技能 |
| SKILL.md 正文 | `resolveSkill()` 解析后的路径 | `use_skill` 调用时 | ~368 tokens/次 |

### 3.3 项目私有技能 vs 软链（决策 4）

| 类型 | 位置 | git | 说明 |
|---|---|---|---|
| 软链 | `<cwd>/skills/<name>` | **必须忽略** | 指向绝对路径，别的机器上必然断链 |
| 真实目录 | `<cwd>/skills/<name>/` | **应提交** | 项目专用技能，随仓库共享 |

**决策 4 补充说明（社长已拍板）**：社长原话是「`~/.neo/skills`、sessions 都要放进 .gitignore」。核实后：`~/.neo/skills` 在 home 目录下，本就不在任何 git 仓库里，加 gitignore 是「预防性声明」；真正需要忽略的是项目里的软链。`.gitignore` 规则见 §6.5。

---

## 4. 渐进式披露设计

### 4.1 三层结构

```
第1 层｜索引（常驻 system prompt）
  技能名 + 一句 description。模型据此判断「要不要用」。
  成本：12~18 tokens/技能
        ↓ 命中才继续
第 2 层｜SKILL.md 正文（use_skill 返回，进 messages 历史）
  完整的操作步骤、约束、示例。
  成本：~368 tokens/次，且只在调用时付
        ↓ 正文里引用了才继续
第 3 层｜附件（references/ scripts/）
  模型自己用 read_file / shell 读。系统不预加载、不预索引。
  成本：完全按需
```

### 4.2 为什么这样够

第 1 层的存在意义是**让模型知道有什么可用**——这是选择的必要条件。没有它，模型无法主动调用 `use_skill`。

第 2 层放在 `use_skill` 的返回值里而非 system prompt，有两个好处：
- 不污染 system prompt，`noteModelChange()` 的正则改写不会误伤
- 计入对话历史，`compact()` 压缩时会被自然处理

第 3 层不索引，因为**模型读了第 2 层就知道该找什么**，索引附件是浪费。

### 4.3 语言选择（实测反直觉结论）

中文索引比英文**更省**：20 技能中文索引 230 tokens，英文 355 tokens。

原因：`estimateTokens` 对 CJK 按 1.5 字符/token、ASCII 按 4 字符/token，中文信息密度更高。**索引用中文写无成本劣势。**

---

## 5. 【前置必修】symlink 遍历缺陷

### 5.1 缺陷描述（已实测，非推断）

用真实 symlink 布局复刻 neo 的遍历代码，结果如下：

| 调用 | 走软链 | 实测结果 |
|---|---|---|
| `list_dir skills` | 部分 | 显示 `foo (128B, 05:13)` —— **被当成文件**，不是目录 |
| `glob "skills/**/*.md"`（从 cwd） | ❌ | **返回 `[]`** |
| `grep pattern=x`（从 cwd 递归） | ❌ | **`filesScanned: 0`**，静默扫不到任何内容 |
| `read_file skills/foo/SKILL.md` | ✅ | 正常读到 |
| `grep path=skills/foo`（显式指定） | ✅ | 正常递归 |
| `write_file skills/foo/new.md` | ⚠️ | **穿透写入全局库** `~/.neo/skills/foo/` |

**根因**：`readdirSync(dir, { withFileTypes: true })` 对 symlink 返回 `isDirectory()=false`、`isSymbolicLink()=true`。以下 4 处全部依赖 `e.isDirectory()` 决定是否递归：

| 位置 | 函数 | 行号 |
|---|---|---|
| `src/tools/index.ts` | `globTool.execute` 的 walk | **326** |
| `src/tools/index.ts` | `listDir.execute` 的呈现分支 | **258** |
| `src/tools/index.ts` | `grepTool.execute` 的 walk | **469** |
| `src/system-prompt.ts` | `listFiles` 的 walk | **40** |

注：`statSync()` 会跟随软链，但代码用的是 `Dirent` 而非 `statSync`，所以没有跟随。

### 5.2 修法

四处统一改为：

```typescript
if (e.isDirectory() || e.isSymbolicLink()) { /* 递归或按目录呈现 */ }
```

**这是本特性的地基。不修，glob/grep 全部失效。**

### 5.3 验收标准

- [ ] `glob "skills/**/*.md"` 能列出软链内的 `SKILL.md`
- [ ] `grep pattern=xxx` 从 cwd 递归能命中软链内的文件
- [ ] `list_dir skills` 把软链显示为 `foo/`（带尾斜杠），并能递归列出其内容
- [ ] system prompt 的工作目录树把 `skills/foo` 显示为目录

---

## 6. 实现规格（开发 Agent 执行）

### 6.1 新建 `src/skills.ts`

**职责**：技能发现、索引生成、两级查找、软链创建。只读扫描 + 一处写操作（建软链）。

#### 接口签名

```typescript
import type { Config } from "./config.ts";

/** 技能的来源标记。 */
export type SkillSource = "project" | "global";

/** 一个技能的索引条目。 */
export interface SkillMeta {
  /** 目录名，即调用 use_skill 时传入的名字 */
  name: string;
  /** SKILL.md frontmatter 里的 description；缺失时回退为 SKILL.md 首行标题 */
  description: string;
  /** 真实目录的绝对路径（已解析软链） */
  absPath: string;
  /** 原始路径（可能是软链本身） */
  linkPath: string;
  source: SkillSource;
  /** 是否来自软链。用于 use_skill 的输出提示与 /skills 展示 */
  linked: boolean;
}

/** 解析结果：成功返回绝对路径，或失败返回原因。 */
export type ResolveResult =
  | { ok: true; meta: SkillMeta; createdLink: boolean }
  | { ok: false; reason: "not_found" | "malformed"; message: string; available: string[] };

/** 扫描两处技能区，生成索引。项目技能优先（同名以项目为准）。 */
export function discoverSkills(cfg: Config): SkillMeta[];

/** 读取并解析 SKILL.md 的 YAML frontmatter。不引入 yaml 依赖，手写最小解析器。 */
export function parseFrontmatter(content: string): Record<string, string>;

/** 生成注入 system prompt 的索引文本。无技能时返回空字符串。 */
export function buildSkillIndex(skills: SkillMeta[]): string;

/** 按 §3.2 的两级规则解析技能名，miss 时创建软链。 */
export function resolveSkill(cfg: Config, name: string): ResolveResult;

/** 列出某个技能目录下的附件（references/ scripts/ 等），供 use_skill 输出末尾提示。 */
export function listSkillFiles(absPath: string): string[];
```

#### 关键实现约束

**约束 1 —— frontmatter 最小解析器**

`src/skills.ts` **不得引入任何第三方依赖**（`package.json` 当前只有 devDependencies）。只需识别形如：

```yaml
---
name: pdf
description: 做什么 + 何时用
version: 1.0.0
---
```

的定界块。解析规则：
- 以文件开头的 `---` 行开始
- 找到下一个 `---` 行结束
- 每行按第一个 `: ` 分割键值对
- 无 `description` 时回退：取正文第一行 `# xxx` 作为 description
- 整个块解析失败**不抛异常**，回退到目录名 + 首行标题

**约束 2 —— 名称白名单校验**

`resolveSkill()` 的 `name` 参数来自模型，必须校验，防止路径穿越：

```typescript
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  return { ok: false, reason: "malformed", message: `技能名非法: ${name}`, available: [] };
}
```

正则依据：Anthropic Spec 要求 name 为小写字母/数字/连字符。

**约束 3 —— 软链创建必须幂等**

```typescript
// 命中顺序
// 1. existsSync(join(cwd, "skills", name)) → 已是软链或真目录，直接返回（createdLink: false）
// 2. 否则若全局库存在该技能 → symlinkSync(globalAbs, localLink)
// 3. 否则 → not_found
```

**软链用相对还是绝对路径**：用**绝对路径**。理由：项目可能整体移动，相对路径会失效。

**约束 4 —— 项目技能优先**

若 `<cwd>/skills/<name>` 与 `~/.neo/skills/<name>` 同时存在，**以项目为准，且不去碰全局库**（不建软链、不覆盖）。

**约束 5 —— 索引排序稳定**

`discoverSkills()` 返回结果按 `name` 字典序排序。理由：索引进 system prompt，顺序抖动会导致同任务不同会话的 prompt 不一致，影响可复现性。

### 6.2 新增 `use_skill` 工具

**位置**：加进 `src/tools/index.ts` 的 `TOOLS` 数组（第 651 行），并在 `toolSpecs()`（第 664 行）与 `toolNames()` 自动生效——无需改注册表。

```typescript
const useSkill: ToolImpl = {
  sensitive: false,          // 只读，不改任何文件（建软链不算破坏性操作）
  spec: {
    type: "function",
    function: {
      name: "use_skill",
      description:
        "加载指定技能的完整操作说明（SKILL.md 正文）。仅当系统提示的技能索引中某技能与当前任务相关时调用。不相关就不要调用——技能正文会占用上下文。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名，取自技能索引" },
        },
        required: ["name"],
      },
    },
  },
  async execute(args, ctx) {
    const r = resolveSkill(ctx.cfg, String(args["name"] ?? ""));
    if (!r.ok) {
      // not_found 时列出可用技能，帮模型纠正
      return r.available.length > 0
        ? `${r.message}\n可用技能：${r.available.join(", ")}`
        : r.message;
    }
    const md = readFileSync(join(r.meta.absPath, "SKILL.md"), "utf8");
    // 输出 = SKILL.md 正文 + 附件清单 + 来源说明
  },
};
```

**输出格式规范**（开发 Agent 必须严格遵守，这决定模型能否正确使用技能）：

```
<SKILL.md 全文，不加额外头部>

---

附件（按需自行 read_file 或执行）：
- references/detail.md
- scripts/extract.py

来源：全局技能库 ~/.neo/skills/pdf（已软链到 ./skills/pdf）
```

**约束 6 —— 正文不做裁剪**

`dispatch()` 已在 `tools/index.ts:710` 用 `cfg.toolOutputLimit`（默认 30000 字符）统一截断。`use_skill` **不要自己实现截剪**，避免两套逻辑。约 370tokens 的 SKILL.md 远低于上限。

**约束 7 —— 建软链的告知义务**

软链是写文件系统操作，**必须在输出里明说**（上方「来源」行）。理由：项目目录被修改了，用户必须知道，且这符合项目一贯的「静默操作比显式错误贵」的价值观（见 `config.ts:264-267` 的既有教训）。

**约束 8 —— SKILL.md 缺失时的行为**

若技能目录存在但 `SKILL.md` 不存在，返回 `ok: false`，message 说明「该技能目录缺少 SKILL.md，不是有效的技能」。**不视为成功**。

### 6.3 注入技能索引到 system prompt

**位置**：`src/system-prompt.ts` 的 `buildSystemPrompt()`，在「## 工具」段之后、「## 思考方式」之前插入。

```typescript
const skills = discoverSkills(cfg);
const skillText = skills.length > 0 ? buildSkillIndex(skills) : "";
```

索引文本格式（**每个技能严格一行**，便于模型扫描与将来 lint）：

```
## 技能

可用技能（仅在相关时用 use_skill 加载正文，不相关不要加载——正文占用上下文）：

- pdf：提取与转换 PDF 文本、表格。适用于读 PDF、填表格。
- docx：生成与美化 Word 文档。适用于写报告、合同。

技能说明位于 ./skills/<技能名>/SKILL.md 及同目录附件。
```

**约束 9 —— 注入位置必须在「## 环境」之前**

`src/system-prompt.ts` 末尾的「## 环境」段落含 `- 模型：${cfg.model}`，而 `agent.ts:113` 的 `noteModelChange()` 用正则 `/- 模型：[^\n]*/` 改写它。技能索引插在「## 环境」之前，两者不会互相干扰。

**约束 10 —— 无技能时静默跳过**

`skills.length === 0` 时**不输出任何技能段落**，不留空标题。这与 `system-prompt.ts:54-57` 对空目录树的处理方式一致。

### 6.4 写工具拦截软链（决策 3）

**位置**：`src/tools/index.ts` 的 `writeFileTool.execute`（第 142 行）与 `editFile.execute`（第 180 行），在调用 `ctx.approve()` **之前**插入守卫。

```typescript
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

const GLOBAL_SKILLS = join(homedir(), ".neo", "skills");

/** 路径是否落在全局技能库内（含经软链穿透的情况）。 */
function insideGlobalSkills(p: string): boolean {
  let real: string;
  try {
    real = realpathSync(p);      // 关键：必须解析软链，字符串比较会失效
  } catch {
    return false;                // 路径不存在，写入的是新文件，用父目录判断
  }
  const r = relative(GLOBAL_SKILLS, real);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep + ".."));
}
```

**约束 11 —— 必须用 `realpathSync`**

软链路径 `skills/pdf/SKILL.md` 与真实路径 `/Users/xueyuheng/.neo/skills/pdf/SKILL.md` **字符串不相等**。用 `realpathSync` 解析后再比 `relative()`，这是复用 `tools/index.ts:47` `insideCwd()` 已有的模式（该函数目前已导出但**从未被调用**，本次是它的首次实际使用）。

**约束 12 —— 守卫必须在 approve 之前**

放`approve()` 之后会先弹审批框再拒绝，用户白点一次。放之前则直接抛错：

```typescript
if (insideGlobalSkills(path)) {
  throw new ToolError(
    `禁止写入全局技能库 ${GLOBAL_SKILLS}。技能是只读资源。` +
    `如需修改，请直接编辑该目录下的 SKILL.md。`
  );
}
```

抛 `ToolError` 而非返回字符串——`dispatch()` 会把它转成 `ok: false` 并计入 `consecutiveFailures`，语义正确。

**约束 13 —— 路径不存在时的兜底**

写入新文件时 `realpathSync` 会抛 ENOENT。此时应对**父目录**做 realpath 判断（父目录存在才可能穿透软链）。实现要求：若父目录 realpath 落在全局库内，同样拒绝。

### 6.5 `.gitignore` 规则

**位置**：`neo/.gitignore`（当前 13 行）。

```gitignore
node_modules/
settings.json
*.log
.DS_Store
.neo-session/

# 技能：软链指向绝对路径，别的机器上必然断链，任何情况下都不提交
.neo/skills/

# neo 会话导出
neo-session.json

# wiki 派生物：能从 wiki 重新生成，不进版本控制
.neo/.wiki/outputs/

# 构建产物
dist/
build/
out/
*.tsbuildinfo
.cache/
```

**约束 14 —— `.neo/skills/` 一条即可**

Git 的语义是「目录被忽略后无法被负向规则重新包含」。写 `.neo/skills/` 会让该目录**连带全部内容**一起忽略，无需逐条加 `!`。项目私有技能请放项目根的 `skills/`（不进此规则，进 git）。

**约束 15 —— raw 与 wiki 不加规则**

按社长决策，`.neo/.wiki/raw/` 与 `.neo/.wiki/`（wiki 主体）**不进** `.gitignore`。

> 依据：`raw/` 是「一切事实的最终出处」（wiki 模板原文），`wiki/` 是编译后的知识图谱。两者进 git 才能实现「换人接手时前因后果完整交接」——git log 追踪变更与责任，wiki 交接决策与因果，两者互为对照。
>
> `outputs/` 排除的依据：wiki 模板原文「删掉整个 outputs/ 不应该损失任何知识」。

### 6.6 新增 `/skills` 斜杠命令

**位置**：`src/index.ts` 的 `handleCommand()` switch（约第 535-807 行）。

`/skills`（无参数）：列出全部可用技能，标注来源与是否软链。

```
可用技能（3）

  ● pdf      全局 · 软链      提取与转换 PDF 文本、表格
  ● docx     项目             生成与美化 Word 文档
  ○ xlsx     全局             生成与编辑 Excel 表格

用 /skills <名称> 查看详情，或让模型按需 use_skill。
```

`/skills <名称>`：解析该技能并打印其索引信息 + SKILL.md 首行（**不打印全文**，全文由 `use_skill` 提供）。

**约束 16 —— `/skills` 不加载全文**

这个命令是给**人**看的诊断入口。打印全文会让人误以为这是加载路径，实际加载只有 `use_skill` 一条路。保持职责单一。

### 6.7 交互命令文档同步

**位置**：`src/index.ts` 的 `HELP` 常量（第 148-192 行），在「交互命令」段落加一行：

```
  /skills          列出可用技能
```

---

## 7. 测试规格（测试 Agent 执行）

**文件**：`tests/skills.test.ts`（新建）。运行：`bun test`。

**必须沿用 `tests/core.test.ts` 的脚手架模式**：

```typescript
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, parseFrontmatter, resolveSkill, buildSkillIndex } from "../src/skills.ts";
import { TOOLS, toolNames, dispatch, globTool, grepTool } from "../src/tools/index.ts";
import type { Config } from "../src/config.ts";
import type { ToolCtx } from "../src/tools/index.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "neo-skill-test-"));
function makeCtx(over: Partial<ToolCtx> = {}): ToolCtx {
  return { cfg: { cwd: SANDBOX, toolOutputLimit: 30_000 } as Config, approve: async () => true, ...over };
}
function cleanup(): void { rmSync(SANDBOX, { recursive: true, force: true }); }
```

**全局注意**：`~/.neo/skills` 是真实的全局目录。测试**绝不能读写它**。所有涉及全局库的用例必须通过 `Config` 注入可覆盖的 store 路径——见 §7.4。

### 7.1 必测用例清单

#### A. frontmatter 解析（`parseFrontmatter`）

| # | 用例 | 期望 |
|---|---|---|
| A1 | 标准三字段 frontmatter | 正确解析 name/description/version |
| A2 | description 含中文与冒号 | 按**第一个** `: ` 分割，其余进值 |
| A3 | 无 frontmatter | 返回空对象，不抛异常 |
| A4 | frontmatter 未闭合 | 返回空对象，不抛异常 |
| A5 | 多行 YAML（如 `allowed-tools: [A, B]`） | 只取首行，**不**解析嵌套 |
| A6 | 空文件 | 返回空对象 |

#### B. 技能发现（`discoverSkills`）

| # | 用例 | 期望 |
|---|---|---|
| B1 | store 中 3 个技能，项目为空 | 返回 3 条，全部 `source:"global"`、`linked:false` |
| B2 | 项目有真目录 + store 有同名 | **两条都返回**，项目那条 `source:"project"` |
| B3 | 项目有真目录 + store 无同名 | 返回 1 条 `source:"project"` |
| B4 | 目录缺 SKILL.md | 跳过该目录，不产生条目 |
| B5 | store 目录不存在 | 返回 `[]`，**不抛异常** |
| B6 | 两个 store 技能名 a、b、c | 返回顺序为 a,b,c（字典序稳定） |
| B7 | 技能目录名非法（含大写/下划线） | 跳过 |

#### C. 名称校验与解析（`resolveSkill`）

| # | 用例 | 期望 |
|---|---|---|
| C1 | 合法名，项目已有软链 | `ok:true`，`createdLink:false` |
| C2 | 合法名，仅 store 有 | `ok:true`，`createdLink:false`（已是软链） |
| C3 | 合法名，仅 store 有，**首次调用** | `ok:true`，`createdLink:true`，且 `existsSync(join(cwd,"skills",name))` 为真 |
| C4 | 重复调用 C3 | `createdLink:false`（幂等），不报错 |
| C5 | 不存在的名 | `ok:false`，`reason:"not_found"`，`available` 含已有技能名 |
| C6 | 路径穿越 `../../etc/passwd` | `ok:false`，`reason:"malformed"` |
| C7 | 绝对路径 `/etc/passwd` | `ok:false`，`reason:"malformed"` |
| C8 | 含下划线 `my_skill` | `ok:false`，`reason:"malformed"` |
| C9 | 空字符串 | `ok:false`，`reason:"malformed"` |
| C10 | 项目与 store 同名 | 用项目的，`createdLink:false`，**全局库未被修改** |

#### D. 索引生成（`buildSkillIndex`）

| # | 用例 | 期望 |
|---|---|---|
| D1 | 2 个技能 | 输出含 2 行，每行以 `- 名称：` 开头 |
| D2 | 空数组 | 返回 `""` |
| D3 | description 含换行 | 被压成单行（**不能破坏「一行一技能」**） |
| D4 | description 缺失 | 回退为目录名，**不为空** |

#### E. `use_skill` 工具（经 `dispatch`）

| # | 用例 | 期望 |
|---|---|---|
| E1 | 工具已注册 | `toolNames()` 含 `use_skill`，共 9 个 |
| E2 | 标记为非敏感 | `TOOLS` 中 `use_skill.sensitive === false` |
| E3 | spec 结构合法 | `type==="function"`，`parameters.required` 含 `name` |
| E4 | 成功加载 | `r.ok===true`，输出含 SKILL.md 正文特征串 |
| E5 | 输出含附件清单 | 含 `references/` 下的文件名 |
| E6 | 输出含来源说明 | 含 `~/.neo/skills` 或 `来源` |
| E7 | 首次调用后软链被创建 | `lstatSync(localLink).isSymbolicLink() === true` |
| E8 | 技能不存在 | `r.ok===false`，输出含 `可用技能：` |
| E9 | 非法名 | `r.ok===false`，输出含 `技能名非法` |
| E10 | 目录存在但无 SKILL.md | `r.ok===false`，含 `缺少 SKILL.md` |
| E11 | 输出长度 | **不超过** `toolOutputLimit` |
| E12 | 非法 JSON 参数 | `r.ok===false`，含 `不是合法 JSON`（复用 `dispatch` 既有行为） |

#### F. symlink 遍历修复（§5 回归，这是地基）

| # | 用例 | 期望 |
|---|---|---|
| F1 | `glob "skills/**/*.md"`（从 cwd） | 能列出软链内的 `SKILL.md`——**修复前返回 `[]`** |
| F2 | `grep pattern=NEEDLE`（从 cwd 递归） | 能命中软链内文件，输出含 `SKILL.md:行号:` |
| F3 | `list_dir skills` | 软链显示为 `foo/`（**带尾斜杠**） |
| F4 | `list_dir skills` recursive | 能列出软链内文件 |
| F5 | 修复**不破坏**真实目录遍历 | F1~F4 对真目录（非软链）同样通过 |

#### G. 写工具守卫（决策 3）

| # | 用例 | 期望 |
|---|---|---|
| G1 | `write_file` 写向软链内 | `r.ok===false`，含 `禁止写入全局技能库` |
| G2 | `edit_file` 改软链内文件 | `r.ok===false`，同上 |
| G3 | 守卫触发时**不调用 approve** | 用计数 spy 断言 `approve` 调用次数为 0 |
| G4 | 正常写项目文件 | `r.ok===true`（守卫不误伤） |
| G5 | 写 `.neo/skills/` 外的相对路径 | 正常放行 |
| G6 | 守卫抛 `ToolError` 而非字符串 | 使 `consecutiveFailures` 计入（间接：`r.ok===false`） |

#### H. system prompt 注入

| # | 用例 | 期望 |
|---|---|---|
| H1 | 有技能时 | `buildSystemPrompt(cfg)` 含 `## 技能` 与 `use_skill` |
| H2 | 无技能时 | **不含** `## 技能`，且无空标题残留 |
| H3 | 索引位置 | `## 技能` 出现在 `## 环境`**之前** |
| H4 | 不破坏模型行 | `noteModelChange` 的正则 `/- 模型：[^\n]*/` 仍能匹配到唯一一处 |

#### I. 端到端集成

| # | 用例 | 期望 |
|---|---|---|
| I1 | 完整流程 | 建 store 技能 → `discoverSkills` 发现 → 索引进 prompt → `dispatch("use_skill")` 加载 → 文件真实变更 |
| I2 | 二次加载同技能 | 第二次 `createdLink:false`，内容一致，**不重复建链** |
| I3 | 多技能共存 | 3 个技能索引全在，各自 `use_skill` 拿到正确正文，**不串内容** |

### 7.2 关键回归断言（必须写）

```
// §8：现有测试必然失败，此处为改后断言
expect(toolNames()).toEqual([...8 个原工具..., "use_skill"]);   // 9 个
expect(new Set(toolNames()).size).toBe(9);
```

```
// F1 的核心断言（修复前的失败态）
const r = await dispatch("glob", JSON.stringify({ pattern: "skills/**/*.md", path: cwd }), ctx);
expect(r.ok).toBe(true);
expect(r.output).toContain("SKILL.md");      // 修复前此处必失败
```

### 7.3 测试脚手架隔离要求（强制）

| 要求 | 理由 |
|---|---|
| 全部路径基于 `mkdtempSync` 沙箱 | 不污染真实工作区 |
| **不读写真实 `~/.neo/skills/`** | 全局库是社长真实资产，测试不得污染 |
| store 路径可注入 | `discoverSkills`/`resolveSkill` 必须支持从 `Config` 读取 store 路径（见 §6.1 的实现要求），否则无法测试 |
| 末尾调用 `cleanup()` | 与现有 `core.test.ts:450` 一致 |

> **给开发 Agent 的强制要求**：`discoverSkills(cfg)` 与 `resolveSkill(cfg, name)` 必须从 `cfg` 读取 store 路径（建议新增 `Config.skillsStore` 字段，默认 `join(homedir(), ".neo", "skills")`），**不得在 `skills.ts` 内部硬编码 homedir()**。否则测试无法隔离。

### 7.4 测试 Agent 需要自己补的两处

1. **`Config` 新字段**：若 §6.1 未实现 store 路径注入，测试 Agent 无法写隔离用例。**这属于实现缺失，应反馈给开发 Agent，不要在测试里 mock 全局 fs**。
2. **§6.4 的 store 路径**：守卫测试 G1/G2 若不便注入，可退而验证「软链穿透时守卫生效」——在沙箱内自建 store 结构的软链，通过 `Config` 指向沙箱内的假 store。**不要跳过 G1/G2**。

---

## 8. 【已知破坏】现有测试必须同步修改

`tests/core.test.ts:62-64`：

```typescript
test("恰好 8 个工具，名称与顺序符合 PRD 2.1", () => {
  expect(toolNames()).toEqual(EXPECTED.map(([n]) => n));   // ← 加 use_skill 后必失败
});
```

**必须改为 9 个**，并把 `use_skill` 加入 `EXPECTED` 常量（`core.test.ts:52-60`）：

```typescript
const EXPECTED = [
  ["read_file", false], ["write_file", true], ["edit_file", true],
  ["list_dir", false], ["glob", false], ["grep", false],
  ["shell", true], ["web_fetch", false],
  ["use_skill", false],        // 新增
] as const;
```

顺序：`use_skill` 放在 `web_fetch` 之后（即 `TOOLS` 数组末尾），与 §6.2 要求一致。

> **给开发 Agent**：这是本特性唯一会打破现有测试的地方。改完必须跑 `bun test` 与 `bunx tsc --noEmit`，两者都要绿。

---

## 9. 验收标准（Definition of Done）

实现完成需**同时**满足：

### 9.1 功能

- [ ] `~/.neo/skills/<name>/SKILL.md` 可被发现并进入 system prompt 索引
- [ ] `use_skill("<name>")` 返回完整 SKILL.md 正文 + 附件清单 + 来源说明
- [ ] 全局技能首次加载时自动软链到 `<cwd>/skills/`，二次加载幂等
- [ ] 项目私有技能（真目录）优先于同名全局技能，且不修改全局库
- [ ] 无效技能名（路径穿越、大写、下划线）被拒绝
- [ ] `write_file` / `edit_file` 无法穿透软链修改全局库
- [ ] `/skills` 与 `/help` 可用

### 9.2 地基修复

- [ ] 4 处 `e.isDirectory() || e.isSymbolicLink()` 已改
- [ ] `glob` / `grep` / `list_dir` / 工作目录树均能正确遍历软链

### 9.3 质量门槛

- [ ] `bunx tsc --noEmit` 零错误（基线已是零错误，不得引入新错误）
- [ ] `bun test` 全绿：现有 46 个 + `core.test.ts` 改后 + `tests/skills.test.ts` 新增
- [ ] `src/skills.ts` **零第三方依赖**（不新增 `package.json` 依赖项）
- [ ] 不读取真实 `~/.neo/skills/`（测试隔离）

### 9.4 上下文预算（实测验收）

- [ ] 工具 spec 总数：875 → 954 tokens（+9.0%）
- [ ] 技能索引：≤ 18 tokens/技能（中文）
- [ ] 无技能时不产生任何额外段落

---

## 10. 风险与边界

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| 忘记修 symlink 遍历 | **高** | glob/grep 全废，功能看似能用实则残废 | §5 独立列为前置必修，验收 9.2 单独勾选 |
| 忘记改 8 工具断言 | 中 | `bun test` 失败 | §8 明确指定改法 |
| 索引行数过多 | 低 | 50 技能 = 600 tokens，占 200k 的 0.3% | 无需处理；真到量级再考虑分层 |
| `noteModelChange` 正则冲突 | 低 | 会误改 model 行 | 约束 9：索引插在「## 环境」之前，实测验证 |
| 会话恢复后索引丢失 | **已排除** | **实测确认无此问题**，见 §10.1 | 无需处理 |
| 软链造成项目目录污染 | 低 | 用户困惑 | 输出中明示来源（约束 7）+ gitignore（§6.5） |

### 10.1 `--resume` 与技能索引（已实测，社长 2026-10-15 拍板：不做 reload）

**结论：v0.1.0 不做会话内索引刷新。索引仅在启动时生成，架构上已天然正确。**

#### 实测结论（原「待确认」项已关闭）

用 mock LLM（`Bun.serve`返 SSE）+ 真实 `-p` / `--resume` 流程端到端验证，四个事实：

| # | 验证项 | 实测结果 |
|---|---|---|
| 1 | `persist()` 是否把 system 消息落盘 | **否**。落盘消息序列 = `user → assistant`，`含 system: false` |
| 2 | 恢复后 system 消息有几条 | **恰好 1 条**，即本次启动新生成的 |
| 3 | 恢复后 `messages[0]` 是否含上次会话内容 | **否**（`includes("MOCK") === false`），是干净的新 prompt |
| 4 | `compact()` 是否保留 `messages[0]` | **保留**。`agent.ts:162-166` 显式取 `sys = this.messages[0]` 并放回新数组首位 |

**因此「索引重复」不可能发生**，原因是双重保险：

```
persist()             → 过滤掉所有 role==="system"，system 永不落盘（index.ts:480）
resume 恢复           → restored.filter(m => m.role !== "system") 再过滤一次（index.ts:323）
                      → 无论落盘策略如何，恢复出的历史都不含 system
Agent 构造            → messages[0] = 本次 buildSystemPrompt(cfg) 的全新结果（agent.ts:73）
```

**推论**：索引随 `buildSystemPrompt()` 每次启动重新生成，**恢复会话天然拿到最新索引**。这正是想要的行为，无需额外代码。

#### 剩下的真实限制

| 场景 | 行为 | 是否可接受 |
|---|---|---|
| `--resume` 恢复会话 | 索引自动是最新 ✅ | 符合预期 |
| `compact()` 压缩 | 索引保留在 `messages[0]` ✅ | 符合预期 |
| **会话进行中**新`cp` 一个技能进全局库 | 索引不刷新，模型看不到新技能 | **v0.1.0 接受** |
| 会话进行中删除技能 | 索引仍列它，但 `use_skill` 会报 not_found 并附可用清单 | 优雅降级 ✅ |

#### 为什么不做 `/skills reload`

| 理由 | 说明 |
|---|---|
| **收益场景极窄** | 「会话中途新增技能」在本工作流里几乎不发生。技能库是**启动前配置**的东西，不是在干活过程中长出来的 |
| **要动system prompt** | reload 必须重写 `messages[0]` 的 `## 技能` 段。这与 `noteModelChange()`（`agent.ts:113`用正则 `/- 模型：[^\n]*/` 改同一段字符串）是同类操作 —— 项目已有教训（`docs/memory-design.md` §1.1）：**两处都改同一段字符串，顺序错了会互相吃掉内容** |
| **有更简单的替代** | `/skills`（无参数）已能列出当前索引。新增技能后用户 `/skills` 看一眼就知道，重启会话即可生效 —— 零风险 |
| **与记忆系统的路线冲突** | `docs/memory-design.md` 已定的方向是「模型用工具按需查询」而非「反复重写 system prompt」。reload 是往反方向走 |

#### 若未来必须做，路径已经留好

不是「重新设计」，是三件事：

1. 把索引段用**唯一哨兵**包裹（如 `<!-- skills:begin -->` / `<!-- skills:end -->`），使重写不依赖脆弱正则
2. 新增 `Agent.refreshSkills(text: string)`，**只替换哨兵之间的内容**，不碰 `## 环境` 段
3. `/skills reload` 调`discoverSkills()` + `refreshSkills()`，并 `noteModelChange()` 不受影响

**v0.1.0 不实现，但开发 Agent 不要把索引写成无法定位的一段裸文本** —— 约束 9的插入位置（`## 工具` 之后、`## 环境` 之前）已保证后续可平滑加哨兵。

### 10.2 明确不做（v0.1.0）

| 不做 | 理由 |
|---|---|
| 技能热加载 / 会话内刷新 | §10.1 已实测并拍板：v0.1.0 不做，重启会话即生效 |
| `allowed-tools` 白名单（Anthropic Spec 的可选字段） | neo 的权限模式是全局的（`agent.ts:459-476`），按技能细分权限是独立特性 |
| 技能依赖声明（`dependencies`） | 无技能间依赖的实际需求 |
| 从网上安装技能 | 引入供应链安全面（提示词注入），需独立设计审核机制 |
| 技能版本管理 | 无实际需求 |
| 把全局库纳入 git | 在 home 目录，不在任何仓库内 |

---

## 11. 附录 A：技能目录格式规范

**依据**：Anthropic Agent Skills Spec（已核实，非记忆）。

### 11.1 最小形态

```
~/.neo/skills/pdf/
  SKILL.md            # 唯一必需文件
```

### 11.2 完整形态

```
~/.neo/skills/pdf/
  SKILL.md# 必需
  references/
    detail.md         # 详细参考，第 3 层按需读
  scripts/
    extract.py        # 可执行脚本
```

### 11.3 SKILL.md 格式

```markdown
---
name: pdf                    # 必填，小写字母/数字/连字符，须与目录名一致
description: 提取 PDF 文本与表格。适用于读 PDF 内容、填表格。   # 必填，这是模型唯一的选择依据
version: 1.0.0               # 必填（Spec 1.1 起）
allowed-tools: Read, Grep    # 可选，neo v0.1.0 不实现，见 §10.2
---

# PDF 处理

## 步骤
1. ...

## 附件
详细表格识别规则见 references/detail.md。
```

**字段说明**：

| 字段 | 必填 | neo 的用途 |
|---|---|---|
| `name` | 是 | 调用 `use_skill` 的参数；须与目录名一致 |
| `description` | 是 | **进索引的唯一字段**，直接决定模型选不选它 |
| `version` | 是 | v0.1.0 不消费，仅规范对齐 |
| `allowed-tools` | 否 | v0.1.0 不实现（§10.2） |

**description 的写法要求**：必须同时说清「**做什么**」和「**何时用**」。这是模型唯一的判断依据——索引里只有这一句话。

---

## 12. 附录 B：源码改动点索引

| 文件 | 位置 | 改动 | 侵入性 |
|---|---|---|---|
| `src/tools/index.ts` | **326** | glob walk 加 `\|\| e.isSymbolicLink()` | 1 行 |
| `src/tools/index.ts` | **469** | grep walk 加 `\|\| e.isSymbolicLink()` | 1 行 |
| `src/tools/index.ts` | **258** | list_dir 呈现分支同上 | 1 行 |
| `src/tools/index.ts` | 顶部 import | 加 `realpathSync`（from `node:fs`）、`homedir`（from `node:os`） | 2 行 |
| `src/tools/index.ts` | 新增函数 | `insideGlobalSkills()` | ~10 行 |
| `src/tools/index.ts` | **142** | `writeFileTool.execute` 加守卫（approve 之前） | 3 行 |
| `src/tools/index.ts` | **180** | `editFile.execute` 加守卫（approve 之前） | 3 行 |
| `src/tools/index.ts` | 新增 `useSkill` | 工具实现 | ~40 行 |
| `src/tools/index.ts` | **651** | `TOOLS` 数组加 `useSkill` | 1 行 |
| `src/system-prompt.ts` | **40** | `listFiles` 加 `\|\| e.isSymbolicLink()` | 1 行 |
| `src/system-prompt.ts` | **52** | `buildSystemPrompt` 调用 `discoverSkills` 并插入索引段 | ~8 行 |
| `src/config.ts` | `Config` 接口 + `loadConfig` | 新增 `skillsStore` 字段（默认 `~/.neo/skills`） | ~4 行 |
| `src/skills.ts` | **新建** | 全部技能逻辑 | ~150 行 |
| `src/index.ts` | `HELP`（148） | 加 `/skills` 一行 | 1 行 |
| `src/index.ts` | `handleCommand`（535） | 加 `case "skills"` | ~25 行 |
| `.gitignore` | — | 加 3 条规则 | 3 行 |
| `tests/core.test.ts` | **52-64** | 8 → 9 个工具 | 2 行 |
| `tests/skills.test.ts` | **新建** | 全部用例 | ~400 行 |

**预估改动量**：约 15 个文件，其中 2 个新建、1 个新建测试。核心逻辑集中在 `src/skills.ts`。

---

## 13. 未验证事项（诚实标注）

| 项 | 状态 | 说明 |
|---|---|---|
| `use_skill` 被模型实际调用的成功率 | **未验证** | 依赖模型行为，无法离线测试。索引 description 的写法质量决定成功率 |
| 索引用中文 vs 英文的**模型识别率**差异 | **未验证** | 仅验证了 token 成本（中文更省），**未验证**模型对中文 description 的判断准确率 |
| `--resume` 恢复后索引行为 | **已实测** | §10.1。落盘不含 system + 恢复二次过滤 → 索引天然最新 |
| 会话内技能切换的注意力衰减 | **未验证** | 加载 5 个以上技能后模型是否仍记得先前技能内容，无数据 |
| 大仓库下 `listFiles` 加 symlink 分支的性能 | 低风险 | 仅多一次布尔判断，无 I/O |

---

## 14. 一页总结

1. **做什么**：三层渐进式披露的技能系统——索引常驻、正文按需、附件再按需。
2. **怎么找到**：`<cwd>/skills/` 优先，miss 则查 `~/.neo/skills/` 并**软链**（决策 1：B 方案）。
3. **怎么加载**：新增 `use_skill(name)` 工具（决策 2：A 方案），边际 +79 tokens。
4. **怎么保护**：写工具用 `realpathSync` 拦截软链（决策 3），全局库只读。
5. **怎么共享**：`raw/`+`wiki/` 进 git 交接因果，`outputs/` 不进 git（决策 4），依据 wiki 模板原文判据。
6. **地基**：4 处 `e.isDirectory()` 必须加 symlink 判断，否则 glob/grep 全废。
7. **陷阱**：`tests/core.test.ts` 的「恰好 8 个工具」断言必然失败，须同步改。
8. **诚实**：§13 五项未验证，尤其「模型实际调用成功率」只能靠真实会话观察。

---

> 编写依据声明：本文档所有「已实测」数据均来自对真实 symlink 布局复刻 neo 遍历代码的探针实验，以及 `bunx tsc --noEmit`（零错误）与 `bun test`（46 pass）的基线运行。SKILL.md 格式规范经 Anthropic Agent Skills Spec 官方文档核实。所有推断均已在 §13 标注。