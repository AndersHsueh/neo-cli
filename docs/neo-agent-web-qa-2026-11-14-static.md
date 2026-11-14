# neo-agent Web 成果 · 静态事实与结构核查报告（阶段 1）

> 报告路径：`docs/neo-agent-web-qa-2026-11-14-static.md`
> QA：严过关（software-qa-engineer-2）｜日期：2026-11-14
> 阶段性质：**仅静态核查**。按主理人本阶段指令，严禁启动浏览器、CDP、截图、Lighthouse、远程 URL 批量访问与项目代码测试。
> 验收对象：`web/neo-agent-version-evolution.html`、`web/portal/index.html|styles.css|script.js|favicon.svg`
> 基准：`docs/neo-agent-iteration-2026-11-14-prd.md` §5 / §6、`docs/neo-agent-web-design-system.md`（下称「设计系统」）
> 结论标记：`STATIC_ONLY`（**不给出最终 `IS_PASS`**）

---

## 1. 实际读过的文件与执行过的命令

### 1.1 逐行读过的文件

| 文件 | 规模 | 用途 |
| --- | --- | --- |
| `web/neo-agent-version-evolution.html` | 1185 行 / 56,426 B | 版本演进页（单一 HTML，CSS 内联） |
| `web/portal/index.html` | 486 行 / 29,501 B | 宣传门户结构 |
| `web/portal/styles.css` | 1381 行 / 25,302 B | 门户样式与 tokens |
| `web/portal/script.js` | 183 行 / 6,018 B | 复制增强与字符雨 |
| `web/portal/favicon.svg` | 6 行 / 389 B | 本地图标 |
| `docs/neo-agent-iteration-2026-11-14-prd.md` | 367 行 | §5 两个 Web 成果需求、§5.4 事实表/内容禁区、§5.5 质量清单、§6 品牌口径 |
| `docs/neo-agent-web-design-system.md` | 706 行 | §0 交付契约、§2 tokens、§3 组件契约、§4/§5 页面结构、§6 响应式、§7 动效、§9 可访问性/打印、§10 元信息、§12/§13 检查清单 |

只读佐证（用于回溯事实，未修改）：`docs/release-notes/v0.4.84.md`、`docs/release-notes/v0.4.80.md`、`README.md`；`settings.example.json` 经 Glob 确认存在。

### 1.2 实际执行过的静态命令 / 工具

| # | 命令 / 工具 | 目的与结果 |
| --- | --- | --- |
| 1 | `wc -l` + `ls -la`（5 个 web 文件） | 确认文件规模与存在性 |
| 2 | `Grep href="[^"]*"`（两页 HTML） | 提取全部链接，逐项分类 |
| 3 | `Grep id="[^"]*"`（两页 HTML） | 提取全部锚点 id，供闭环比对 |
| 4 | `Grep` 内容禁区词（web 全目录） | 扫描 npm/下载/登录/绝对可靠/许可证/密钥/本地证据等 |
| 5 | `Grep` README 命令关键词 | 核对 `-y`/`--name`/`--worktree`/`settings.example.json`/`--max`/`--drive` |
| 6 | `Grep` v0.4.80 release note 验证数字 | 核对 1704 pass / PTY 24/24 |
| 7 | Python 静态脚本：锚点闭环 + 本地资源存在性 | 断链 0、缺失本地文件 0、空 href / `javascript:` 0 |
| 8 | Python 静态脚本：外部资源加载 / `<script>` / H1 / 徽章 / 断点扫描 | 外部运行依赖 0、各页 H1=1、无 `target="_blank"`、无 canonical/og:url/og:image |
| 9 | Python 静态脚本：三方 design tokens 比对（设计系统 §2 / 版本页 / 门户 CSS） | 60 项 token，空白归一化后**值漂移 0** |
| 10 | Python 静态脚本：issue 链接所在 `<li>` 文案精确核对 | #52/#59/#37 全部标注「本轮规划」 |
| 11 | `node --check web/portal/script.js` | **只执行一次**，输出 `SYNTAX OK`（退出码 0） |

> 说明：本阶段**未**执行浏览器、CDP、截图、Lighthouse、远程 URL 批量访问或项目代码测试；本会话早前的探测性尝试因 RPC/网络超时未形成可交付结论，本报告结论**不引用任何动态结果**，仅基于上述静态核查。

---

## 2. 通过项（静态）

### 2.1 事实状态与历史口径

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 当前已发布四件套 | 版本页 L831-856（`v0.4.84` / 2026-11-10 / `a2858ae` / 已发布徽章 + release note、tag、commit、README 链接）；门户 L54-55、L333-345 | ✅ 与 PRD §5.2(1)、设计系统 §4.2(3) 一致 |
| #52 / #59 / #37 仍为「本轮规划」 | 版本页 L1027-1068（三张 `.card--planned`）、L1033 规划说明；门户 L164-187（4 个子项分别标注）、L436-438 来源区文案 | ✅ 无一处标「已发布」或「已实现，未发布」；符合 PRD §5.1、§7.2 |
| 规划/现有能力不混写 | 版本页 L1052、L1096；门户 L129 明确 `fallback_allowed` 是档位降级、不是 #59 有序备用链；门户 L221「尚无 stream-json」；L406/L1096 明确退出码未按来源拆分、#52 仍是规划 | ✅ 符合 PRD §5.4 内容禁区、§9.3 历史文档冲突说明 |
| v0.4.84 历史验证记录口径 | 版本页 L871-882、门户 L347-350：标题「v0.4.84 发布时验证记录」，正文明确「该版本发布记录 / 历史发布证据，不是当前工作区复测结果」；数字 `1995 pass / 0 fail / 0 skip（115 文件）`、`PTY 32/32`、`ALL GREEN` | ✅ 逐字对照 `docs/release-notes/v0.4.84.md`「验证」段一致；未冒充本次复测，符合 PRD §5.2(4)、设计系统 §3.8 |
| v0.4.80 验证数字 | 版本页 L970「该版本发布记录：1704 pass / 0 fail / 0 skip · PTY 24/24 · ALL GREEN」 | ✅ 与 `docs/release-notes/v0.4.80.md` L68-69 一致 |
| 附加数字 `bun x tsc --noEmit` 零错误 | 版本页 L881 标注来源为 v0.4.84 release note「验证」段 | ✅ release note L56 确有此条，非编造 |
| 时间线 | 版本页 `<ol class="timeline">` L897-975，按 v0.4.84 → v0.4.80 最新到最早，每节点含 H3 / 已发布徽章 / `<time datetime>` / 摘要 / 来源 | ✅ 摘要逐项对照 PRD §2.2；日期 11-10/11-10/11-10/11-09/11-08 一致 |

### 2.2 内容禁区

- 禁区词全目录扫描（`npm install`、`立即下载`、`在线体验`、`免费试用`、`登录`、`零故障`、`绝对可靠`、`全自动`、`保证测试通过`、`适用于所有`、`官方授权`、`官方 Matrix`、`电影联名`、`开源协议`、`LICENSE`、`lorem`、`javascript:`、`href=""`、`href="#"`、`Authorization`、`.workbuddy`、`docs/evidence`、`星标`、`用户数`、`合作伙伴`、`benchmark`、`客户评价`、`价格`）：**唯一命中**为版本页 L1100「#29 OAuth 浏览器登录同样暂停」——描述暂停项，非 CTA、非能力宣称，不构成违规。
- 明确写出 `package` 为 private、无公开 npm 包（版本页 L857-858；门户 L278「没有公开 npm 包或托管服务」）；无编造用户数/星标/benchmark/客户/价格/截图/许可证；无真实 API key、私有网关、个人配置、本地证据内容；Matrix 仅作视觉风格描述，无权利方背书。
- 边界完整：Windows 11 实验性未实机验证、worktree/hooks 非沙箱、模型判断不等于验证、#28 PTY/attach 与 #29 OAuth 暂停、需自备 Bun>=1.1 / 兼容网关 / API key（版本页 L1070-1103；门户 L390-420）。

### 2.3 互链、锚点、本地资源

- 两页互链符合设计系统 §0.5：版本页 → `portal/index.html`（L798、L1176）；门户 → `../neo-agent-version-evolution.html`（L66、L378、L457、L475）。
- 公共锚点：门户齐备 `#main-content`(L42)、`#quick-start`(L274)、`#workflows`(L193)、`#versions`(L328)、`#boundaries`(L383)、`#sources`(L425)；版本页保留 `#main-content`/`#boundaries`/`#sources`，**未保留** quick-start/workflows/versions 空锚点，符合 §0.5「版本页没有真实工作流区时，不保留空锚点」。
- 锚点闭环（Python 脚本）：版本页 25 个 id / 8 个片段链接，断链 0；门户 24 个 id / 7 个片段链接，断链 0；无空 `href`、无 `href="#"`、无 `javascript:`。
- 本地资源：门户 `styles.css` / `script.js` / `favicon.svg` / `index.html` 均为相对路径且文件存在；版本页 CSS 与 favicon（data SVG）内联。两页本地引用合计 12 处，缺失 0。
- 外链 URL **结构**静态核对：17 个唯一 URL 均为 `github.com/AndersHsueh/neo-cli` 下的仓库根、`commit/a2858ae`、`releases/tag/v0.4.8X`、`blob/<tag>/docs/release-notes/vX.md`、`blob/v0.4.84/README.md`、`blob/v0.4.84/package.json`、`issues/52|59|37`；历史节点使用对应 tag 快照而非 `main`，符合设计系统 §4.4。**HTTP 可达性本阶段未实测**（见 §5）。

### 2.4 无外部运行依赖、脚本与降级（静态）

- 两页 HTML/CSS/JS 中 `<script|link|img|iframe|source>` 指向 `https://` 的资源加载数 = 0；CSS `url(http` = 0；`@import` = 0；JS 网络 API（fetch / XHR / serviceWorker / sendBeacon）= 0。
- 版本页 `<script>` 标签 = 0（无 JS 依赖，打印/禁用 JS 时核心文字天然可读）；门户仅 1 个本地 `script.js`（`defer`）。
- 复制按钮：门户 7 处 `<button type="button" data-copy-target=… hidden>` 初始隐藏；`script.js` L33-63 仅在找到目标 `code` 后 `button.hidden = false`，L177 在两个初始化均成功后才添加 `.js` 类；L15-31 Clipboard API 不可用时回退 `execCommand`，catch 中手动选中并提示「复制失败，请手动选择」；`aria-live="polite"` 反馈 2.5s 清除。
- 字符雨：canvas `aria-hidden="true"`，`styles.css` L337-341 默认 `display:none`、`opacity:0.08`（≤0.10），仅 L1225-1229 `.js .matrix-rain[data-ready="true"]` + `no-preference` 才显示；`script.js` L68/L145/L167 用 `matchMedia` 判断、监听偏好变化、reduce 时不启动 rAF；L155-171 有 IntersectionObserver / visibility / pagehide / resize 节流；`getContext`/`requestAnimationFrame`/`IntersectionObserver` 缺失时安全 return。

### 2.5 元数据与语义骨架

- 两页均含 `lang="zh-CN"`、`charset`、`viewport`、`color-scheme`、`theme-color=#07110d`、description、`og:type/locale/site_name/title/description`、`twitter:card=summary`；title 与设计系统 §10.2 逐字一致（版本页「版本演进｜neo-agent」、门户「neo-agent｜Matrix 风格的终端编程助手」），OG 文案与 title/description 同步；**无** canonical / og:url / og:image（本地成果不虚构公开 URL）。
- favicon：版本页内联 data SVG、门户本地 `favicon.svg`（深底 + 绿框 + `neo` + `<title>neo-agent</title>`），无影视标志、无外部引用。
- 语义：每页 H1 = 1；`skip-link` → `header.site-header` → `nav[aria-label="主导航"]` → `main#main-content[tabindex="-1"]` → `footer.site-footer`；`pre[tabindex="0"]` + aria-label；状态徽章 SVG `aria-hidden="true" focusable="false"` + 完整文字；导航项与设计系统 §3.2 逐项一致（版本页 5 项、门户 5 项）；正文链接保留下划线；无 `target="_blank"`（外链默认同页打开，符合 §3.4）。

### 2.6 状态徽章、tokens、视觉一致性、响应式与打印（静态）

- 状态徽章可见文字逐字为 `已发布` / `已实现，未发布` / `本轮规划`；三种 class 齐全；徽章含 SVG + 文字 + 颜色三重表达；门户第三卖点未整卡挂「已发布」，拆成 4 个 `.capability-subitem` 分别标注（L156-187），符合设计系统 §3.3。
- **tokens**：设计系统 §2 共 60 个自定义属性，与版本页内联 `:root`、门户 `styles.css :root` 三方比对，空白归一化后**值漂移 0**（仅 `--font-sans` / `--font-mono` 存在换行缩进差异，值本身逐字相同）。共享契约类名（`.status-badge`、`.button`、`.card--current`、`.evidence-note`、`.code-block`、`.skip-link`、`.container`、`.site-footer`、`.footer-links`、`.eyebrow`）两页一致。
- 两页统一但不雷同：版本页档案式 760px 阅读列 + 单列时间线；门户 Hero + 卖点/工作流网格 + 版本摘要；H1 封顶 48px（版本页）/ 64px（门户），符合设计系统 §2.2 / §5.4。
- 响应式 CSS 静态：两页均有 48/64/80rem 主断点；360px 16px gutter、768px 32px、1280/1440px 48px，容器封顶 75rem（1200px）居中；`minmax(0,1fr)` / `min-width:0` 防撑破；`pre { overflow-x:auto; overscroll-behavior-inline: contain }`；长文本 `overflow-wrap:anywhere`；`:where(section,h1,h2,h3)[id] { scroll-margin-top:6rem }`；header 非 sticky，不遮挡锚点；44px 点击目标（`.button`、`.nav-list a`、`.footer-links a`、`.button--copy`、`.brand` 均设 `min-height:2.75rem`）；`:where(a,button,[tabindex]):focus-visible` 3px 焦点环两页一致。
- reduced motion / 打印静态：两页均含 `@media (prefers-reduced-motion: reduce)`（关闭 animation/transition、`scroll-behavior:auto`、canvas `display:none !important`）与 `@media print`（浅色 tokens、隐藏 header/skip-link/装饰/复制按钮、网格折叠单列、`break-inside:avoid`、`pre-wrap`）；`node --check` 语法通过。

### 2.7 命令与事实可回溯

- 门户 7 条命令与 `README.md` 逐字一致：`cp settings.example.json settings.json`（L13）、`bun run src/index.ts`（L14）、`-p "用 glob 找出所有 .ts 文件"`（L15）、`-p "修到测试全绿" --drive "bun test" --max 5 --max-minutes 30 -y`（L16）、`neo --name lead` / `neo --name worker-a --worktree feat-a` / `neo --name worker-b --worktree feat-b`（L795-798）；`settings.example.json` 存在（Glob 确认）。未实现的 `stream-json`、有序备用链参数未出现在命令中。
- 平台表述「其它 POSIX shell 有解析器支持」「Windows 11 实验性，尚未实机验证」与 README L32-33 一致；首次介绍使用 neo-agent / neo-cli / `neo` 三层口径与主口号，符合 PRD §6.1、设计系统 §1.1。

---

## 3. 问题清单（静态）

| # | 严重度 | 文件:行号 | 期望 | 实际 | 建议修复角色 |
| --- | --- | --- | --- | --- | --- |
| 1 | 中 / P2（条件性） | `web/neo-agent-version-evolution.html:1136` | 设计系统 §0.5 只规定两页固定互链；§9.3 / §5.2 要求 `file://` 与静态托管均可用；§3.8 要求来源只引用公开仓库可访问的 release note。来源区应为公开、稳定的资源，不依赖部署目录之外的本地文件。 | 来源区使用 `<a href="../docs/neo-agent-iteration-2026-11-14-prd.md">本轮迭代盘点与增量 PRD（本地文档）</a>`。`file://` 从 `web/` 打开时文件存在且可读（静态脚本确认缺失 0）；但**若以 `web/` 为静态站点根部署，`../docs/` 跳出根将 404**。且链接目标是本轮规划态本地 PRD（PRD §2.4「本次新增…仅规划与盘点」），不宜作为公开可点击来源。 | **version-manager**（主）+ **operations-expert**（协）：改为纯文本说明，或指向公开 GitHub 的 issue / 仓库文档入口；部署前复核。 |
| 2 | 低 / P3（语义） | `web/neo-agent-version-evolution.html:792` | 设计系统 §3.2：「当前页链接使用 `aria-current="page"`；页内当前位置可用 `aria-current="location"`」。`aria-current="page"` 应指向当前页面 URL。 | `<a class="brand" href="#main-content" aria-current="page" …>` 指向**页内片段** `#main-content`，与门户 `href="index.html" aria-current="page"`（L25）语义不一致。 | **version-manager**：移除该属性，或改为 `aria-current="location"` / 非链接品牌标识。 |

> 两项均为非阻断问题：不影响事实状态、内容禁区、离线可读性与静态结构完整性。

### 3.1 观察项（非缺陷，不需修复）

- **A（打印细节差异）**：版本页 `@media print` 含 `@page { size:A4; margin:16mm }` 与 `a[href^="http"]::after` 附加 URL；门户无这两项。设计系统 §9.2 中二者为「可」选，均不违反；但 A4 打印预览仍须在下一阶段实测。
- **B（实现类名差异）**：版本页 `.brand__mark` / `.site-nav` 与门户 `.brand-mark` / `.nav-list` 命名不同；共享契约类名、tokens 与视觉结果一致，属实现自由度。
- **C（导航覆盖范围）**：门户主导航未含 `#sources`（页脚含）、版本页主导航未含 `#capabilities` / `#planned` / `#sources`（页脚含 `#sources`）；与设计系统 §3.2 规定的导航内容逐项一致。

---

## 4. 限制

1. **浏览器与可访问性实测尚未执行**：本阶段按主理人指令限定为静态核查，未打开 `file://`、未启静态服务器、未做 CDP 视口模拟、未截图、未跑 Lighthouse。
2. 因此以下项目**均未执行，不得计为通过**：360/768/1280/1440px 实际横向溢出/遮挡/截断测量、控制台错误与未处理拒绝捕获、键盘 Tab 顺序与焦点可见性实操、WCAG 对比度工具实测（正文 4.5:1 / 大字 3:1 / 非文字边界 3:1）、reduced motion 实际偏好切换、禁用 JS 实际打开、A4 打印预览、200% 文本缩放与 400% 页面缩放、外链 HTTP 可达性实测、两页像素级视觉一致性比对、Lighthouse 四项分数。
3. 外链仅做 **URL 结构**静态核对（17 个唯一 URL，tag 快照路径正确）；**HTTP 状态本阶段未复核**（按指令禁止远程批量访问）。
4. 对比度结论仅引用设计系统 §2.1 的调色板计算基线与 tokens 一致性，按设计系统 §0.7 明确「不替代成品页面、实际状态和打印模式的复测」。
5. 本会话早前的探测性动态尝试因 RPC/网络超时未形成可交付结论，本报告**不引用**其结果。
6. 未运行项目代码测试、未修改任何被验收文件、未提交、未推送。报告本身是唯一新增文件。

---

## 5. 结论

```
STATIC_ONLY: PASS
```

静态事实与结构核查通过：事实状态、#52/#59/#37「本轮规划」、v0.4.84 历史验证记录口径、内容禁区、两页互链与锚点闭环、本地资源、元数据与 favicon、无外部运行依赖、tokens 一致性、状态徽章措辞、语义骨架、CSS 响应式/reduced motion/打印契约、命令与来源回溯，以及 `node --check` 语法，均符合 PRD §5/§6 与设计系统。

含 **2 项待修复问题**（1 中 1 低，均非阻断）与 **3 项观察**。

**本阶段不给出最终 `IS_PASS`**：最终验收必须在下一阶段完成浏览器与可访问性实测后判定（PRD §5.5 / §7.2、设计系统 §13）。

---

## 6. 下一步建议

1. **先修复**：由 version-manager 处理问题 1（来源区本地 PRD 链接）与问题 2（brand 的 `aria-current`）；operations-expert 同步复核门户侧是否有同类本地链接。
2. **再实测**：主理人另开一个独立、稳定的短阶段，仅执行浏览器实测并单独成文，覆盖：4 档视口（用 CDP `Emulation.setDeviceMetricsOverride` 精确设宽，避免 `--window-size` 被最小窗口宽度钳制）、控制台错误、键盘 Tab 与焦点、对比度工具、reduced motion、禁用 JS、A4 打印预览、外链 HTTP 可达性、Lighthouse（记录环境/目标分数，未运行则明确记未执行）。
3. **最终复核**：修复与实测后，由产品/QA 共同对照来源复核状态词、日期与验证数字，再给出最终 `IS_PASS`；核心 Issue 合入/发版状态变化时按设计系统 §11 同步两页，不猜版本号。
