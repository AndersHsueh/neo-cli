# wiki_write 链接目标校验（issue #22）

> 状态：已实现（v0.4.77）
> 关联 issue：AndersHsueh/neo-cli#22

## 背景

2026-11-08 跨会话记忆实验中，新建页面写了互链 `[[环境-技能与工具路径]]` —— 该页真实存在于用户级库 `~/.neo/wiki/`，项目级库没有，于是在项目级成了断链。当时 `wiki_write` 只校验页面名后缀（`src/wiki/write.ts:47`）与摘要/日期戳（`:68`），没有校验正文链接；断链直到人工逐链核对才被发现。

根因不是模型凭空编名字，而是用户级/项目级两层记忆「串层」：同名页面在另一层存在时，写入路径没有任何机制提示。工程原则是机械正确性由 harness 保证，不依赖模型自觉。

## 现状（实现前）

- 写入唯一合法路径 `src/wiki/write.ts`：`validatePageName` 只查后缀/保留名/前缀；`validatePageContent` 只查摘要+日期戳。均不校验正文链接。
- 离线体检 `src/wiki/lint.ts` 已有全部底层件：`normalizeLinkTarget`、`pageNames` 集合、断链检测；但 lint 只在人工触发 `/wiki-lint` 时运行，不在写入时运行。
- 用户级库路径可解析：`src/config.ts` 的 `userWikiDir`（默认 `~/.neo/wiki`），经 `resolveUserWikiLayout` / `resolveScopeLayout("user", …)` 可得 user 层 pagesDir。

## 期望

1. 写入时对正文每个 `[[X]]` 检查目标页是否存在，不存在就报错或警告；
2. 若目标在另一层（用户级/项目级）存在，给出明确提示，指名层名；
3. 机械正确性由 harness 保证，不依赖模型自觉。

## 方案

### 共享链接口径（新增 `src/wiki/links.ts`）

链接提取与归一化从 `src/wiki/lint.ts` 抽到 `src/wiki/links.ts`，成为唯一真源：

- `normalizeLinkTarget(raw)`：`[[目标|别名]]` / `[[目标#锚点]]` / `[[目标.md]]` → 纯页名；含 `/` 的路径式目标归一为空串（按 lint 口径跳过）。
- `extractLinks(fileName, text)`：代码块（``` 围栏）与行内反引号内的链接不计。
- `extractLinkTargets(text)`：去重并保留首次出现顺序的目标列表。

`src/wiki/lint.ts` 改为 re-export 共享模块，既有 import 方（`tests/wiki-lint.test.ts`）不受影响。**write 不依赖 lint，也不复制逻辑** —— 两处口径漂移正是 issue 要消灭的那类不一致。

### 写入前校验（`src/wiki/write.ts`）

新增 `checkLinkTargets(content, { layout, selfPage?, otherLayout? })`：

- 本层页名集合 = `pagesDir` 下的 `.md` 文件名（去后缀）；
- 固定页名 `INDEX` / `index` / `log` / `AGENTS` 不算断链（与 lint 的 `ALWAYS_ALLOWED` 一致）；
- 自链（`[[本页]]`）在本层成立，不算断链；
- 本层缺失但另一层存在 → `kind="cross-layer"`，文案指名层名（如「X 在用户级 wiki，项目级 wiki 没有 —— 请改链到本层，或把该页复制到本层」）；
- 两层都无 → `kind="missing"`（如「X 在项目级 wiki 不存在（另一层也没有）—— 写入后会成断链」）；
- 另一层未创建（用户级库尚未建立）→ 按「两层都无」处理。

`writeBack()` 新增两个可选参数：`otherLayout`（跨层判定用）与 `linkCheck`（口径开关）。结果对象新增 `linkIssues: LinkIssue[]`。

### 行为口径：警告不阻断（默认）

`LinkCheckMode = "off" | "warn" | "strict"`，默认 `warn`（`DEFAULT_LINK_CHECK_MODE`）。

- `warn`：写入照常发生，问题以 `⚠️ 链接目标缺失：…` 形式出现在 `wiki_write` 的工具输出里，指名缺失目标与所在层，由模型自行决定是否改链。**append 场景多为追加审计行，硬报错会挡死整次回填；跨层链接有时正是作者有意引用另一层。**
- `strict`：缺失/跨层直接抛 `WikiWriteError`，不落盘。
- `off`：完全跳过校验。

`create` 场景是否默认走严格模式**留待维护者拍板**（见下方「待决」）。

### 另一层布局的解析

`src/tools/wiki.ts` 在执行时解析另一层：写项目级时查用户级（`resolveUserWikiLayout(cfg.memory.userWikiDir)`），写用户级时查项目级（`resolveWikiLayout(cfg.cwd)`）；另一层未创建 → `null` → 按「两层都无」处理。

`src/memory/merge.ts`（自动沉淀路径）同样传入另一层布局（`ctx.project` / `ctx.user`），使自动归纳的正文里若含跨层引用也能被正确识别，而不是误报为「两层都无」。

## 验收标准

1. 向项目级写入含 `[[不存在页]]` 的内容时，工具返回错误或警告，并指名缺失目标；✅
2. 目标仅存在于用户级库时，提示明确说出「在用户级 wiki」与层名（反向写入用户级时同理）；✅
3. 目标在本层存在时不产生任何新告警（零误报）；✅
4. `[[目标|别名]]` / `[[目标#锚点]]` / `[[目标.md]]` 三种语法都能被正确归一后校验，口径与 lint.ts 一致；✅
5. 全量测试 + tsc + verify.sh 通过，新增用例覆盖上述 1–4。✅（worktree.test.ts 的 16 个既有失败与本次改动无关，见下）

## 验证

- 新增用例：`tests/wiki-write.test.ts` 的「链接目标校验（issue #22）」组（13 个用例），覆盖验收 1–4、跨层正反两向、路径式目标跳过、代码块/反引号不计、warn/strict/off 三种口径、自链、工具层输出。
- 测试隔离：双层沙箱建在 `tmpdir()` 下，不依赖开发机 `settings.json`、不写死开发者路径。
- `bun x tsc --noEmit`：exit 0
- `bun test`：新增用例全绿；全量里的 `tests/worktree.test.ts` 16 个失败为既有问题（基线提交 31880e0 复跑同结果：24 pass / 16 fail，根因是 macOS `/var` → `/private/var` 软链导致 `listManaged` 的路径比较失败，与本次改动无关，按 Keymaker 要求未触碰该文件）。

## 待决（留给维护者）

- `create` 场景是否默认走 `strict`？当前默认全局 `warn`。若 Anders 决定 create 走严格模式，只需在 `src/tools/wiki.ts` 按 `action` 传 `linkCheck: "strict"`，无需改校验逻辑。
- `strict` 模式下跨层链接是否也应阻断？当前是（跨层与缺失同样报错）。若认为「有意引用另一层」应当放行，可在 `checkLinkTargets` 中按 `kind` 区分处理。

## 关联

- [[wiki_write链接目标校验]] —— 项目内镜像页（issue 背景与验收标准）
- [[跨会话记忆实验-1108]] —— 断链现场与发现过程
- [[记忆激活-v0.1.11]] —— 双层库布局与 wiki_write 工具的来源
- [[重构-1116-档位纪律共享工具]] —— 「共享工具而非复制逻辑」的先例
