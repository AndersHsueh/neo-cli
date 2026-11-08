# wiki_write 链接目标校验（issue，待实现）

> 最后更新:2026-11-08

## 摘要

issue（2026-11-08 由 Anders 经跨会话消息下达，约定隔天由本会话自行巡检发现并修复；当天只记不改代码）：`wiki_write` 写入时应检查正文里每个 `[[X]]` 链接目标是否存在；目标不存在但存在于另一层（用户级/项目级）时，给出明确跨层提示。机械正确性由 harness 保证，不依赖模型自觉。

## 背景

2026-11-08 跨会话记忆实验（[[跨会话记忆实验-1108]]）中，新建页面写了互链 `[[环境-技能与工具路径]]`——该页真实存在于用户级库 `~/.neo/wiki/`，但项目级库没有，于是在项目级成了断链。当时 `wiki_write` 只校验了页面名后缀，没有校验链接目标；断链直到第三步人工逐链核对才被发现。根因不是模型凭空编名字，而是用户级/项目级两层记忆「串层」：同名页面在另一层存在时，写入路径没有任何机制提示。

## 现状（已核实的代码事实）

- 写入唯一合法路径 `src/wiki/write.ts`：`validatePageName`（`src/wiki/write.ts:47`）只查后缀/保留名/前缀；`validatePageContent`（`src/wiki/write.ts:68`）只查摘要+日期戳。均不校验正文链接。
- 离线体检 `src/wiki/lint.ts` 已有全部底层件：`normalizeLinkTarget`（`src/wiki/lint.ts:137-142`，剥别名/锚点/.md 后缀）、`pageNames` 集合（`src/wiki/lint.ts:169`）、断链检测；但 lint 只在人工触发 `/wiki-lint` 时运行，不在写入时运行。
- 用户级库路径可解析：`src/config.ts:1023-1024` 的 `userWikiDir`（默认 `~/.neo/wiki`），经 `resolveScopeLayout("user", …)`（用法见 `src/memory/bridge.ts:88`）可得 user 层 pagesDir。

## 期望

1. 写入时对正文每个 `[[X]]` 检查目标页是否存在，不存在就报错或警告；
2. 若目标在另一层（用户级/项目级）存在，给出明确提示，例如『X 在用户级 wiki，项目级没有，请改链或复制』；
3. 机械正确性由 harness 保证，不依赖模型自觉。

## 验收标准

1. 向项目级写入含 `[[不存在页]]` 的内容时，工具返回错误或警告，并指名缺失目标；
2. 目标仅存在于用户级库时，提示明确说出「在用户级 wiki」与层名（反向写入用户级时同理）；
3. 目标在本层存在时不产生任何新告警（零误报）；
4. `[[目标|别名]]` / `[[目标#锚点]]` / `[[目标.md]]` 三种语法都能被正确归一后校验，口径与 `lint.ts` 一致；
5. 全量测试 + tsc + verify.sh 全绿，新增用例覆盖上述 1–4。

## 初步思路

- 复用 `lint.ts` 的 `normalizeLinkTarget`；建议把归一化抽到共享模块，避免 write 依赖 lint 或复制逻辑（先例：[[重构-1116-档位纪律共享工具]]）；
- 在 `write.ts` 落盘前对 content 做链接提取+归一，对照本层 pagesDir 的 pageNames；缺失项再查另一层 layout（取 `wiki_write` scope 参数的反层；user 层可能未创建，未创建按「两层都无」处理）；
- 报错还是警告：倾向**警告不阻断**——append 场景多为追加审计行，硬报错会挡死整次回填；跨层链接有时是作者有意引用另一层。create 场景可考虑严格模式。最终由 Anders 拍板；
- 归一化后为空串的目标（路径式）按 lint 现口径跳过。

## 关联

- [[跨会话记忆实验-1108]] —— 断链现场与发现过程
- [[记忆激活-v0.1.11]] —— 双层库布局与 wiki_write 工具的来源
- [[跨会话消息-v0.2.0]] —— 任务下达通道

## 推理与依据

- 2026-11-08（session 20261108-021617-xj8cnu）：本次仅按 Anders 要求新建 issue，未修改代码。issue 已落到项目 wiki 主题页 `neo/.neo/wiki/wiki/wiki_write链接目标校验.md`，并由 `wiki_write` 同步更新 `INDEX.md` 与 `log.md`，日志条目类型为 `todo`。项目内没有 `issues/` 目录或 `.github/` 模板，现有“待办/待实现”惯例是 wiki 待办页加 `log.md` 的 `todo` 条目，因此未直接创建 GitHub issue。

后续巡检时需从 wiki 的 INDEX/log 发现该页并实现：写入正文时逐个检查 `[[X]]` 目标；目标不存在时明确报错或警告；目标存在于用户级 `~/.neo/wiki/` 而非项目级时，明确提示跨层位置；本层存在时不得误报；链接语法归一化应与现有 `/wiki-lint` 口径一致；最终通过全量测试、`tsc` 和 verify。现有 `src/wiki/write.ts:47` 只校验页面名的 `.md` 后缀，而 `src/wiki/lint.ts:137-142` 已有链接归一化与断链检测，但仅在人工执行 `/wiki-lint` 时运行；用户级路径可通过 `src/config.ts:1023` 与 `resolveScopeLayout("user",…)` 解析。初步实现倾向是抽取共享归一化模块，缺失目标采用警告而非阻断，以避免 append 审计场景因单条问题阻断整次回填；最终行为仍需 Anders 拍板。

- 2026-11-08（session 20261108-021617-xj8cnu）：口径修正（Anders 指正）：本 issue 应落到 GitHub 远端而非仅 wiki 页。已在 `AndersHsueh/neo-cli` 创建 issue #22（https://github.com/AndersHsueh/neo-cli/issues/22），标题与本页一致，正文含背景/现状/期望/验收标准/初步思路，并在文末注明项目内同步记录为本页。本页保留作为项目内镜像与隔天巡检入口。过程备注：`gh auth status` 曾报 keyring token 失效，但 `gh issue create` 实际成功（凭据可能来自其他来源），后续如遇 401 需 `gh auth refresh`。当天仍未改任何代码。

- 2026-11-08（session 20261108-021617-xj8cnu）：2026-11-08 已创建 GitHub issue `AndersHsueh/neo-cli#22`，标题与本页一致，正文包含背景、代码现状、3 条期望与 5 条验收标准及初步思路；同时在本页追加 issue 编号及口径修正缘由，并同步登记 `log.md`，使隔天巡检可从两个入口发现该任务。任务约束保持为只记 issue、不改代码。另记录 GitHub CLI 认证异常的处理方式：`gh auth status` 可能报告 keyring token 失效，但 `gh issue create` 仍可能成功；若实际遇到 401，执行 `gh auth refresh -h github.com` 刷新凭据。

- 2026-11-08（session 20261108-021617-xj8cnu）：跨会话考试中，Claude 抓到了本会话把用户级页面名误当项目级链接目标的真实 bug。该缺口随后形成 issue #22，并交由 harness 层兜底：wiki 写入时检查正文中的 `[[X]]` 目标是否存在；若目标位于另一层，则给出明确跨层提示。这里的工程原则是机械正确性由机制保证，不依赖模型自觉，也不以“下次小心点”代替修复。

- 2026-11-08（session 20261108-180540-w6ssty）：Issue #22 的实现入口已定位：`src/wiki/write.ts:47` 的 `validatePageName` 当前只校验页名后缀，不校验正文中的 `[[X]]` 链接目标。`src/wiki/lint.ts` 已有可复用能力，包括 `normalizeLinkTarget`、`pageNames` 集合和断链检测。实施时需把目标存在性校验接入 `wiki_write` 写入路径；若目标仅存在于另一层（用户级或项目级），应返回明确的跨层提示，而不能只报普通断链。该任务范围小、方案明确，是当前优先级最高的收尾项。

- 2026-11-08（session 20261108-181934-g0zw27）：2026-11-08 已开始实现 issue #22：`wiki_write` 落盘前检查正文中的每个 `[[X]]` 链接目标，并在目标位于其他层级时给出明确跨层提示。实现必须先建立独立 worktree 与分支 `feat/wiki-write-link-check`，主工作树存在其他会话的在途改动，不得直接修改。初步核查范围包括 `src/wiki/write.ts`、`src/wiki/lint.ts`、`src/tools/wiki.ts`、`src/wiki/paths.ts`、配置中的 scope layout 解析，以及 `tests/wiki-write.test.ts` 的既有断言形态；新增返回字段前需确认不会破坏现有 writeBack 测试契约。

- 2026-11-08（session 20261108-181934-g0zw27）：2026-11-08，issue #22 在分支 `feat/wiki-write-link-check` 实现并提交为 `69b9d3c`。链接解析口径统一收敛到 `src/wiki/links.ts` 的 `normalizeLinkTarget` / `extractLinks`，`src/wiki/lint.ts` 改为 re-export；`src/wiki/write.ts` 新增 `checkLinkTargets()`，在 `writeBack()` 落盘前区分本层缺失、目标仅存在于另一层、本层正常三种情况。跨层提示会明确目标所在层级。

新增 `LinkCheckMode = "off" | "warn" | "strict"`，默认 `warn`：警告不阻断落盘，并将问题写入 `wiki_write` 工具输出；`strict` 抛错且不落盘。调用入口是 `writeBack()` 的 `linkCheck` 参数。测试新增 13 个双层沙箱用例，`tests/wiki-write.test.ts` 为 34 pass / 0 fail，`bun x tsc --noEmit` exit 0，PTY 24/24 通过。全量 `bun test` 的 16 个失败均集中于既有 `tests/worktree.test.ts` 基线问题，与本改动无关。

仍待 Anders 拍板：① `create` 是否默认使用 `strict`；② `strict` 下跨层链接是否也应阻断。当前实现全局默认 `warn`，且 `strict` 会阻断跨层链接。未 push、未 merge、未修改 GitHub issue #22、未写 `.neo/wiki`。

- 2026-11-08（session 20261108-181405-ecu9hf）：2026-11-08 对项目级 `.neo/wiki/` 完成只读断链体检。仓库 `lintWiki` 扫描 51 个页面（主题页 49 个），结果为 `broken=0、orphans=0、lowlinks=20、nosummary=0、nostamp=0`；另用 `/tmp/wiki-link-audit.ts` 对 265 条 `[[目标]]` 做不跳过代码块/反引号的原始归一扫描，同样确认零断链。现场提到的 `[[环境-技能与工具路径]]` 位于 `wiki_write链接目标校验.md:11` 的行内反引号内，是对历史 bug 的叙述性引用，按 lint 口径不计为链接；`跨会话记忆实验-1108.md` 已在第三步将跨层互链修正为 `[[记忆激活-v0.1.11]]`。issue #22 对应 v0.4.77（commit `69b9d3c`）已合入 main 并提供写入时目标校验。审计全程只读，未修改 wiki、源码或 git 状态；20 条 LOWLINKS 不在本次范围。另一个产品事实是跨层链接目前没有解析机制：`wiki_search` 的 `scope=auto` 仅代表检索顺序，不等于 `[[链接]]` 会跨层解析；项目层若需指向用户层，目前只能明确标注层级路径，或另行实现跨层解析。

## 推理与依据

- 2026-11-08（session 20261108-180540-w6ssty）：**设计点拍板（Anders 决定）** —— `wiki_write` 的链接校验**保持现状：全局 warn，跨层链接也只警告不阻断**。两个悬置问题一并定下：① create 新建场景**不**走 strict；② strict 模式下跨层链接**不**单独阻断。理由：跨层链接有时是作者有意引用另一层（如项目级页面引用用户级的通用经验页），硬阻断会挡住正常回填；机械正确性由「明确提示缺失目标与所在层」保证即可，不靠阻断兜底。当前实现默认即为 `DEFAULT_LINK_CHECK_MODE = "warn"`，**无需代码改动**；`off` / `strict` 两档保留在代码里备用（`src/wiki/write.ts` 的 `LinkCheckMode`），日后若要收紧，只需在 `src/tools/wiki.ts` 按 action 传 `linkCheck`，校验逻辑不动。

- 2026-11-08（session 20261108-180540-w6santy）：**存量断链体检结论 —— 项目层断链为 0，#22 的现场断链当时已人工修正**。派活时的前提（「存量断链还在，需要一次体检清理」）经复核**不成立**，此处更正以免后续会话误以为仍有清理任务：
  - 用仓库自己的 `lintWiki`（`src/wiki/lint.ts`，与 `/wiki-lint` 同一入口）跑项目层：`SUMMARY: {broken:0, orphans:0, lowlinks:0, nosummary:0, nostamp:0}`（51 页面 / 49 主题页）。
  - 另用独立脚本做原始扫描（不做代码块/反引号跳过）交叉验证：项目层 265 条链接逐个归一后全部命中本层 pagesDir。
  - 原因：`跨会话记忆实验-1108.md` 初版写的跨层互链 `[[环境-技能与工具路径]]`（该页只在用户级 `~/.neo/wiki/`）在**第三步已修正**为 `[[记忆激活-v0.1.11]]`，页面 line 67/69 留有「初版误链→已修正」的记录。
  - 唯一「跨层页名出现」的位置是 `wiki_write链接目标校验.md:11`，但写在**行内反引号内**，是对历史 bug 的叙述性引用 —— 按 lint 口径（反引号/代码块内不计）既非断链也不该算。
  - 两层同名页只有 `INDEX.md` 与 `log.md`（各自独立库的索引/日志，且在 EXEMPT_FILES 名单内），**不构成 #22 的「该引用哪一层」歧义风险**。另注：用户层 3 个主题页（环境 / 环境-技能与工具路径 / 偏好-提示词写法）项目层均无，且反向扫描确认用户层没有引用项目层页名。
  - 遗留的产品口径问题（尚未拍板）：**跨层互链机制上是否应支持**。当前 `wiki_search` 的 scope=auto 是「先项目后用户」，与链接解析不是一回事；跨层 pagesDir 链接无法解析。若日后项目级页面要真正指向用户级页面，可行口径是写成反引号包裹的「提及」并标注层级与完整路径，或另行设计跨层链接解析。**此项本次未定，留待后续拍板。**
