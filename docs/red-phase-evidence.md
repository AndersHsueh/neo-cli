# 阶段 A「全红」证据 — 技能管理

> 执行人：test-expert
> 工作区：`neo/.worktrees/feature-skills`（分支 `feature/skills`）
> 基线：`bun test` 46 pass / 0 fail，`bunx tsc --noEmit` 零错误

---

## ⚠️ 首要结论：阶段 A 未能按原计划完成 —— 被并发写入打断

**必须先读这一节。** 本文档记录的不是一次干净的全红验证，而是一次**被并发覆盖打断的验证**。

### 发生了什么

我按任务书写完 `tests/skills.test.ts` 与 `tests/symlink-traversal.test.ts`、跑出全红后，
另一个 agent 在同一工作区**重写了我负责的 `tests/skills.test.ts`**，并**直接开始写实现代码**
（新建 `src/skills.ts`、改 `src/config.ts`、改 `docs/skills-prd.md`、改 `.gitignore`）。

时间线（文件 mtime 可证）：

| 时刻 | 事件 |
|---|---|
| 15:02 | 我改完 `tests/core.test.ts`（8→9 工具） |
| 15:03 | 我写完 `tests/symlink-traversal.test.ts` |
| 15:04 | **`tests/skills.test.ts` 被另一 agent 覆盖**（我的版本丢失） |
| 15:06 | **`src/skills.ts` 出现** —— 实现已开始，阶段 A 的红态前提消失 |

### 后果

1. **「`src/skills.ts` 不存在导致全红」这条核心证据已无法复现** —— 模块现已存在。
2. 我原写的 `tests/skills.test.ts`（962 行）**已被覆盖，无法恢复**。
3. 当前 `tests/skills.test.ts` 是他人的 71 用例版本，**含一个致命缺陷导致 56 个假红**（见下）。

### 我实际交付的、仍然有效的成果

- `tests/symlink-traversal.test.ts` —— 我写的，10 个用例，**未被覆盖**，是当前唯一
  能独立证明 §5 symlink 地基缺陷的文件。
- `tests/core.test.ts` 的 8→9 工具断言 —— 已落地并被保留。
- **一个高价值缺陷发现**：他人 `tests/skills.test.ts` 的 `cleanup()` 时序 bug（见 §3）。

---

## 1. 我负责文件的红态证据（`tests/symlink-traversal.test.ts`）

这份文件**不 import `src/skills.ts`**，因此在模块缺失期也能运行——这正是它独立成文件的原因。

### 运行命令与输出（实现落地前）

```
$ ~/.bun/bin/bun test tests/symlink-traversal.test.ts
```

```
(fail) F1 glob 能穿过软链 > glob "skills/**/*.md" 从 cwd 能列出软链内的 SKILL.md
(fail) F1 glob 能穿过软链 > glob 不因软链产生重复条目（同一文件只列一次）
(fail) F2 grep 能穿过软链 > grep 从 cwd 递归能命中软链内文件并给出行号
(fail) F2 grep 能穿过软链 > grep 能扫到软链内的非 SKILL.md 附件
(fail) F3/F4 list_dir 把软链当目录 > F3 list_dir skills：软链显示为 foo/（带尾斜杠）
(fail) F3/F4 list_dir 把软链当目录 > F4 list_dir skills recursive：能列出软链内文件
(fail) F6 system prompt 工作目录树把软链显示为目录 > 工作目录树含 skills/foo/ 且能递归到 skills/foo/SKILL.md
(pass) F5 真实目录遍历不被修复破坏 > glob "real/**/*.md" 对真目录同样有效
(pass) F5 真实目录遍历不被修复破坏 > grep 对真目录同样命中并给出行号
(pass) F5 真实目录遍历不被修复破坏 > list_dir 真目录仍按目录呈现并可递归

 3 pass
 7 fail
 24 expect() calls
Ran 10 tests across 1 file.
```

### 失败断言的实际值 —— 与 PRD §5.1 预测逐条吻合

这是「失败根因是功能缺失而非测试缺陷」的最硬证据：实测输出与 PRD 实测探针记录的特征串**完全一致**。

| 用例 | 期望 | 实测 received | 对应 PRD §5.1 |
|---|---|---|---|
| F1 glob | 含 `skills/foo/SKILL.md` | `无匹配文件: skills/**/*.md` | 「glob 返回 `[]`」 |
| F2 grep | 含 `skills/foo/SKILL.md:8:` | `1 处匹配（扫描 1 文件）:\nreal/pdf/SKILL.md:8:` | 「`filesScanned: 0`，静默扫不到」 |
| F2 grep 附件 | 含 `skills/foo/inner.md` | 同上（只扫到真目录） | 同上 |
| F3 list_dir | 含 `foo/` | `foo  (128B, 2026-10-15 07:03)` | 「被当成文件，不是目录」 |
| F4 list_dir rec | 含 `SKILL.md` | 同上，无递归 | 同上 |
| F6 prompt 树 | 含 `skills/foo/` | 树中为 `skills/foo`（无尾斜杠） | §5 第 4 处未修 |

**F5 全绿是正确的**，不是漏测：它断言「修复不破坏真实目录遍历」，修复前真目录本来就正常。
它是**回归护栏**——若实现改坏了真目录，这 3 个用例会立刻变红。

### 过程中我自己抓到并修掉的一个测试缺陷

首轮运行时 F5 的 grep 用例红了。排查发现是**我的 fixture 缺陷**，不是源码问题：

- 我把 `NEEDLE` 写在 SKILL.md 第 8 行，却断言 `SKILL.md:2:`
- 实测 received 为 `real/pdf/SKILL.md:8: SYMNEEDLE-7f3a` —— 源码完全正确，是我的期望值写错

修法不是把数字改成 8（治标），而是**从 fixture 内容推导行号**：

```typescript
const NEEDLE_LINE = SKILL_MD_FOO.split("\n").findIndex((l) => l.includes(NEEDLE)) + 1;
```

这样以后 fixture 一改，断言自动跟随，杜绝此类漂移导致的假红。修完 F5 转绿。

---

## 2. `bunx tsc --noEmit`

实现落地前（`src/skills.ts` 不存在时）的输出，**仅 2 条错误，均为模块缺失**：

```
tests/skills.test.ts(32,81): error TS2307: Cannot find module '../src/skills.ts' or its corresponding type declarations.
tests/skills.test.ts(33,32): error TS2307: Cannot find module '../src/skills.ts' or its corresponding type declarations.
```

✅ 测试代码本身零类型错误。TS7006 / TS2352 / TS2773 等噪音全部是 TS2307 的**级联**
（模块无类型 → 导入符号为 `any` → 回调参数隐式 any）。

当前（实现已落地）：`tsc_exit=0`，零错误。

---

## 3. 【缺陷发现】他人 `tests/skills.test.ts` 的 `cleanup()` 时序 bug —— 56 个假红

这是本次最有价值的产出。**它会让阶段 B 的验收结论完全失效。**

### 症状

`bun test` 报 57 failed，但失败耗时全是 **0.02~0.05ms**（正常断言失败应是毫秒级），
根因是同一个：

```
error: ENOENT: no such file or directory,
  mkdtemp '/var/folders/.../neo-skill-test-vGHb2e/b2-erM3SB'
    at sandbox (tests/skills.test.ts:49:28)
```

同一文件里 A 组（`parseFrontmatter`）与 D 组（`buildSkillIndex`）**全绿**——
因为它们是纯函数，不碰文件系统。所有需要沙箱的 B/C/E/F/G/H/I/J 组**全军覆没**。

### 根因（已用最小复现验证）

文件末尾第 962 行：

```typescript
cleanup();      // ← 在模块顶层同步执行
```

`cleanup()` 执行 `rmSync(ROOT, { recursive: true, force: true })`。
**bun test 的模块顶层代码在测试函数体之前跑完**，所以 `ROOT` 在任何用例开始前已被删除；
用例内 `sandbox()` 再 `mkdtempSync(join(ROOT, ...))` 必然 ENOENT。

最小复现（我实测）：

```typescript
const ROOT = mkdtempSync(join(tmpdir(), "probe-"));
function cleanup() { rmSync(ROOT, { recursive: true, force: true }); }
test("ROOT 还存在吗？", () => { expect(existsSync(ROOT)).toBe(true); });
cleanup();
// → (fail) Expected: true  Received: false
```

⚠️ **注意**：`tests/core.test.ts:450` 有**完全相同**的写法。它当前全绿纯属侥幸——
它的用例都在 `SANDBOX` 下**自建**目录（`mkdirSync(..., {recursive:true})`），
删了也能重建，所以掩盖了这个反模式。**这是同一个陷阱，谁碰谁炸。**

### 修复（已验证有效）

把顶层调用改为 `afterAll`：

```diff
-import { describe, expect, test } from "bun:test";
+import { describe, expect, test, afterAll } from "bun:test";
 ...
-cleanup();
+afterAll(cleanup);
```

实测结果（我用副本验证，未改动他人文件）：

| | pass | fail |
|---|---|---|
| 修复前 | 14 | **57** |
| 修复后 | **65** | **6** |

**57 → 6。51 个用例是假红。**

---

## 4. 当前状态快照（实现已落地，非阶段 A 成果）

```
$ ~/.bun/bin/bun test
 70 pass
 57 fail
Ran 127 tests across 3 files.

$ ~/.bun/bin/bunx tsc --noEmit
（零错误，exit 0）
```

拆解：

| 文件 | 归属 | pass | fail | 说明 |
|---|---|---|---|---|
| `tests/core.test.ts` | 我改的 | 46 | 0 | 9 工具断言已生效 ✅ |
| `tests/symlink-traversal.test.ts` | 我写的 | 10 | 0 | **symlink 地基已修好** ✅ |
| `tests/skills.test.ts` | 他人重写 | 14 | 57 | **其中 51 个是 §3 的假红** |

扣掉假红，真实剩余失败 **6 个**：

```
B9  项目区软链也能被发现：linked=true，absPath 已解析软链
C12 目录存在但缺 SKILL.md → ok:false，message 含「缺少 SKILL.md」（约束 8）
E8  技能不存在 → ok:false，输出含「可用技能：」
E9  非法名 → ok:false，输出含「技能名非法」
E10 目录存在但无 SKILL.md → ok:false，含「缺少 SKILL.md」
I2  二次加载同一技能：createdLink:false，内容一致，不重复建链
```

这 6 条交由阶段 B 判定真假——**在 `cleanup()` bug 修复前，任何「全绿/全红」结论都不可信。**

---

## 5. PRD 与源码的实测不符（任务书要求上报项）

### 5.1 【P1，PRD 已被另一 agent 修正】`|| e.isSymbolicLink()` 是错的

PRD §5.2 初稿写「四处统一改为 `e.isDirectory() || e.isSymbolicLink()`」。

**这是错的。** `readdirSync` 对**指向文件**的软链同样返回 `isSymbolicLink()=true`。
统一改后 glob/grep 会把「软链到文件」当目录走进 walk，`readdirSync` 抛 ENOENT 被 catch 吞掉
→ 该软链文件**永远不会被当作文件匹配，比修之前更差**。

正确改法（PRD 已由另一 agent 修正并写入 `§6.1b`）：

```typescript
function isRealDir(full: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (e.isSymbolicLink()) {
    try { return statSync(full).isDirectory(); } catch { return false; }
  }
  return false;
}
```

我在 `tests/skills.test.ts`（被覆盖前的版本）**没有**为这个场景写用例——
若我的文件存活，会是缺口。他人版本补了 F6/F7 两个回归防护用例，方向正确。

### 5.2 【接口假设】守卫必须从 `ctx.cfg.skillsStore` 取库路径

PRD §6.4 示意代码是模块级常量 `GLOBAL_SKILLS = join(homedir(), ".neo", "skills")`。
**这样 G 组用例无法隔离**，会拿社长真实 `~/.neo/skills` 做判定。
§7.4 已授权退路（「通过 Config 指向沙箱内的假 store」），PRD 也已修正为
`insideGlobalSkills(ctx, p)`。此项已被采纳 ✅。

### 5.3 【易踩坑】macOS realpath 不对称

`tmpdir()` 返回 `/var/folders/...`（本身是软链），`realpathSync` 返回 `/private/var/folders/...`。
守卫若只对被写入路径 realpath 而不对 store 根 realpath，`relative()` 会以 `..` 开头 → 守卫静默失效。
我的两个文件均已用 `realpathSync()` 归一沙箱根。

### 5.4 【PRD 内部冲突】B2「两条都返回」与「同名以项目为准」矛盾

- §7.1 B2：项目与 store 同名 → 「**两条都返回**」
- §6.1 函数签名注释：「项目技能优先（**同名以项目为准**）」
- §6.1 约束 4：以项目为准，「**不去碰全局库**」
- §7.1 C10：「用项目的」

三处一致要求去重，仅 B2 一处说返回两条。且 D1 要求索引「一行一技能」，重名会直接破坏索引。
**我原按「去重 + 项目优先」断言**（并在代码注释标注该冲突）。他人版本按 B2 字面写了「两条都返回」
——两种理解都自洽，但**必须由产品侧拍板**，否则实现方会照着错的那份写。

---

## 6. 结论与建议

1. **阶段 A 的核心交付（`src/skills.ts` 缺失导致的全红）未能留存**，被并发实现覆盖。
   我的 `tests/symlink-traversal.test.ts` 与 `core.test.ts` 改动仍在，且已被实现验证通过。
2. **最高优先级**：修 `tests/skills.test.ts:962` 的 `cleanup()` → `afterAll(cleanup)`，
   否则 51 个假红会污染阶段 B 验收。同一反模式在 `core.test.ts:450`，建议一并排查。
3. **需产品拍板**：§5.4 的 B2 语义冲突。
4. **流程建议**：同一工作区内的并发 agent 应串行，或各自独占文件；
   本次三个角色同时写 `tests/skills.test.ts` 导致返工与证据丢失。
---

# 追加：阶段 B 假绿排查（变异测试）

> 前提：阶段 A 结束后实现已落地，`bun test` 127 pass / 0 fail，`tsc` 零错误。
> 「全绿」本身不证明测试有效—— 必须验证**实现改错时测试会红**。
> 方法：对实现打变异（故意改坏），看测试是否捕获；每次变异后立即还原并复验。

## B.1 【已修复】F7 是假绿 —— P1 缺陷仍可能逃逸

team-lead 裁决 1 与 product-owner 第 8 条都指出：`|| e.isSymbolicLink()` 这个错误改法会让
「软链到文件」彻底消失。补了 F6（glob）+ F7（grep）两个回归用例。

**但变异测试证明 F7 是假绿。** 把 `isRealDir` 改回错误改法后：

```
(fail) F6 ... 指向文件的软链仍能被 glob 匹配   ← 捕获了 ✅
       F7 ... 指向文件的软链仍能被 grep 命中   ← 没红 ❌
```

根因：F7 把目标文件放在 **cwd 内**的 `assets/note.md`，然后 `grep path=cwd` 递归。
即使软链被丢掉，grep 仍会扫到那个真实文件并命中同样的 `NEEDLE_FILE_LINK`：

```
1 处匹配（扫描 1 文件）:
assets/note.md:1: NEEDLE_FILE_LINK     ← 匹配的是真实文件，不是 alias.md
```

即 F7 断言的是「内容出现」，而非「软链被匹配」。真实文件一直都在，断言恒真。

**修法**：把目标文件放到 **cwd 之外**（tmpdir 根部独立目录），
使 cwd 递归扫描**只能经由 `skills/alias.md` 命中**；并把断言从「含 needle」收紧为
「含 `alias.md`」。

```diff
-const target = writeFileDeep(join(cwd, "assets", "note.md"), "NEEDLE_FILE_LINK\n");
+const outside = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "f7-target-")));
+const target = writeFileDeep(join(outside, "note.md"), "NEEDLE_FILE_LINK\n");
 symlinkSync(target, join(cwd, "skills", "alias.md"));
-expect(r.output).toContain("NEEDLE_FILE_LINK");
+expect(r.output).toContain("alias.md");   // 必须命中软链本身
```

修完复验，同一变异下 F6 与 F7 **双双变红**：

```
(fail) F6 ... glob 匹配   (fail) F7 ... grep 命中
124 pass / 3 fail
```

## B.2 写工具守卫：6 个用例可靠（非假绿）

守卫是本特性唯一的**数据保护**机制（防穿透写坏社长的全局技能库），
单独做「守卫完全失效」变异：

```diff
-  if (!insideGlobalSkills(ctx.cfg, path)) return;
+  return; // MUTANT: guard disabled
```

结果 **6 个用例同时变红**，覆盖 write_file / edit_file / 审批次数 / ToolError 语义 /
新文件父目录上溯 / realpath vs 字符串比较：

```
(fail) G1 write_file 写向软链内          (fail) G2 edit_file 改软链内文件
(fail) G3 守卫触发时不调用 approve       (fail) G6 守卫抛 ToolError 而非字符串
(fail) G7 新文件（父目录存在）同样被拒   (fail) G8 必须用 realpath 而非字符串比较
121 pass / 6 fail
```

**这组无需修补**，是本次排查中最可信的部分。

## B.3 排查中发现并已解决的实现侧冲突：B9 与去重语义

排查期间 `src/skills.ts` 被实现方更新（15:11），`discoverSkills` 增加了
**按 `absPath` 去重**（项目区软链指回全局库时是同一技能，不能算两个）。
这与我阶段 A 上报的 §5.4「B2 两条 vs 同名以项目为准」冲突是同一处。

B9 一度变红（`Expected length: 2, Received length: 1`），
随后随实现方调整转绿。**这属于规格裁决范畴，已由实现方按「同一技能去重」收敛。**

## B.4 收尾状态

所有变异均已还原，`src/` 只含预期改动：

```
$ ~/.bun/bin/bun test
 127 pass
 0 fail

$ ~/.bun/bin/bunx tsc --noEmit
（零错误，exit 0）
```

**当前无已知假绿。** 变异测试只能证明「已写的用例有效」，不能证明「该写的用例都写了」——
后者仍需人工对照 PRD §7 清单核对。

---

# 追加二：`tests/symlink-traversal.test.ts` 顶层 `cleanup()` 修复（潜伏 bug）

## 事实澄清

dev-expert 报告我的 `tests/symlink-traversal.test.ts:251` 有顶层 `cleanup()` bug —— **指控成立**。
但「该文件当前是假绿」的说法**不成立**。实测区分如下。

### 为什么它当时没炸

| 文件 | 沙箱创建方式 | 顶层 cleanup 下 |
|---|---|---|
| `tests/skills.test.ts` | `mkdtempSync(join(ROOT, ...))` —— 要求父目录存在 | **57 个 ENOENT 假红** |
| `tests/symlink-traversal.test.ts` | `mkdirSync(cwd, {recursive:true})` —— 删了会自愈 | 全绿 |

即我的文件只是**侥幸**：被 `mkdirSync(recursive)` 掩盖，不是安全。
「掩盖」与「安全」的区别是：任何人日后把 `mkdirSync` 换成 `mkdtempSync`（更自然的写法），
全部用例会瞬间假红 —— 与 `skills.test.ts` 一模一样的坑。

## 修复

顶层调用改为 `afterAll`，并删除随之成为死代码的 `cleanup()` 函数，
在原处留下警告注释说明为何不能改回去。

## 修完后做了对照实验（唯一能证因果的证据）

探针：把 `layout()` 的沙箱改成 `mkdtempSync`（严格写法，会暴露父目录缺失）。
**只改cleanup 时机这一个变量**：

| 条件 | 结果 |
|---|---|
| 顶层 `cleanup()` + mkdtempSync 探针 | **0 pass / 10 fail**，10 条 ENOENT |
| `afterAll` + 同样的 mkdtempSync 探针 | **10 pass / 0 fail** |

同一份探针，仅cleanup 时机不同即从全红变全绿 —— 因果关系坐实，**这次是真修而非掩盖**。

## 中途我自己犯的一个错

第一次构造探针时写成 `cwd = mkdtempSync(...)`，但 `cwd` 是 `const`，
报 `This assignment will throw because "cwd" is a constant` —— 探针本身无效，
差点让我误判「afterAll 也没修好」。改成替换 `const cwd = join(...)` 那一行才拿到有效对照。
记下来：**探针本身要先验证有效，否则会得出反向的错误结论。**

## 最终状态

```
$ ~/.bun/bin/bun test          → 127 pass / 0 fail
$ ~/.bun/bin/bunx tsc --noEmit → 零错误
grep -rn MUTANT src/ tests/    → 无
```

`product-owner` 报告的 `src/skills.ts:369` MUTANT 残留与TS1005 语法错误，
在我核实前**已被实现方还原**，当前源码无残留、编译通过。

---

# 追加三：「唯一备用电源」主张被实测推翻（自我更正）

## 我曾两次主张的内容

> `symlink-traversal.test.ts` 刻意不 import `src/skills.ts`，因此始终可运行
> —— 它是整个测试树里唯一不依赖新模块的回归网。

product-owner 实测反驳，**他是对的**。我独立复现确认：

```
注入语法错误到 src/skills.ts 尾部（const BROKEN = = 1;）：
  tests/core.test.ts              → error: Unexpected =    0 pass
  tests/symlink-traversal.test.ts → error: Unexpected =    0 pass
  tests/skills.test.ts            → error: Unexpected =    0 pass
```

**三个全部 0 pass，无一幸存。**

## 错在哪：依赖是间接的，我只看了第一层

| 我的文件 | 实际 import |
|---|---|
| `tests/symlink-traversal.test.ts:37-38` | `tools/index.ts` + `system-prompt.ts` |
| `src/tools/index.ts:13` | `import { ... } from "../skills.ts"` |
| `src/system-prompt.ts:9` | `import { ... } from "./skills.ts"` |

我只验证了「本文件不直接 import skills.ts」，就宣称「不依赖」。
**这是把「直接依赖」偷换成「依赖」** —— 一个只查了第一层的结论。

## 但边界比「全线黑暗」更细（补充实测）

product-owner 的结论「skills.ts 一坏全线黑暗」需要限定条件。
我用**仅行为破坏、不产生语法错误**的变异再测一次：

```ts
export function discoverSkills(cfg: Config): SkillMeta[] {
  return []; // BROKEN
```

结果：

| 文件 | 结果 |
|---|---|
| `tests/core.test.ts` | **46 pass / 0 fail** |
| `tests/symlink-traversal.test.ts` | **10 pass / 0 fail** |

即两种破坏的影响面完全不同：

| 破坏类型 | 机制 | 影响面 |
|---|---|---|
| **加载期**（语法错误 / 缺失导出） | 静态 import 在模块求值时就失败 | **全部文件 0 pass** |
| **运行期**（逻辑缺陷） | 模块正常加载，仅函数行为错 | 只影响真正调用它的用例 |

**所以准确表述是**：`skills.ts` 是**加载期单点** —— 语法层面坏掉会让整个测试树归零；
逻辑层面有缺陷则只波及调用链。这比「一坏全线黑暗」精确，也说明
**语法错误类破坏是测试树最脆弱的失效模式**（而这恰恰是变异测试最容易手滑产生的）。

## 修正后的结论

1. 我撤回「唯一备用电源」的说法。**当前测试树不存在任何独立于 `skills.ts` 的回归网。**
2. 这不影响「不要合并两个测试文件」的结论 —— 理由要换成「避免重复覆盖」，
   而**不是**我之前说的「保留备用电源」（那个理由不成立）。
3. 真正的缓解手段只有一个：**`skills.ts` 尽早进版本控制**（现已 `A  src/skills.ts`）。
   架构上做依赖隔离（如动态 import）属于过度设计，不建议。
