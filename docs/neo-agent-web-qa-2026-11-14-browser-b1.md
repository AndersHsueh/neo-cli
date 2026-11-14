# neo-agent Web 成果 · 浏览器动态实测 B1 阶段报告（可访问性与静态降级）

> 报告路径：`docs/neo-agent-web-qa-2026-11-14-browser-b1.md`
> QA：严过关（software-qa-engineer-2）｜日期：2026-11-14
> 阶段性质：**B1 —— 打印/A4、reduced motion、禁用 JS、键盘路径、实际对比度**。按主理人指令，使用**单次 Edge headless + 单一 CDP 会话**连续完成 5 项，每项本次真实观测，不复用 A 阶段结论。
> 站点根：`D:/projects/neo-cli/web`（本地静态服务器 `http://127.0.0.1:4173`）；两页 `/neo-agent-version-evolution.html`、`/portal/index.html`
> 前序：`docs/neo-agent-web-qa-2026-11-14-static.md`（`STATIC_ONLY: PASS`）、`docs/neo-agent-web-qa-2026-11-14-browser-a.md`（`BROWSER_A: PASS`）
> 基准：PRD §5.5 / §7.2、设计系统 §3.1 / §3.3 / §7.3 / §9.1 / §9.2 / §9.3 / §13
> 结论标记：`BROWSER_B1`（**不给出最终 `IS_PASS`**）

---

## 1. 本阶段边界

**已执行**：5 项（见 §3–§7）。

**明确未执行（B2，按指令禁止，逐条列明）**：
1. 200% 文本缩放 / 400% 页面缩放。
2. 17 个外链（GitHub）HTTP 批量可达性。
3. 768 / 1440px 截图逐张视觉观察。
4. Lighthouse（Performance / Accessibility / Best Practices / SEO）。

**合规**：未修改 `web/` 下任何文件、未改其它 `docs/` 文档、未运行项目 `bun test` / `verify.sh`、未提交 / 推送；未访问任何外部互联网 URL（仅 `127.0.0.1:4173`）。唯一新增文件为本报告；测试脚本与产物均在系统 temp 目录。

---

## 2. 实际工具 / 命令 / 方法

| # | 工具 / 命令 | 说明 |
| --- | --- | --- |
| 1 | `python3 -m http.server 4173 --bind 127.0.0.1 --directory web`（cwd=`D:/projects/neo-cli`） | 以 `web/` 为文档根；就绪探测返回 `static_server_root_http=200`；命令结束 `trap`+`kill`+`wait` 停止 |
| 2 | Edge headless（`"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --remote-debugging-port=0 --user-data-dir=<temp>`） | **只启动一次**，随机 CDP 端口由 `DevToolsActivePort` 读取 |
| 3 | Node 22（`WebSocket` / `fetch` 全局）+ 自写 CDP 客户端 `C:/Users/Anders/AppData/Local/Temp/neo-qa-browser-b1.js` | 单一 CDP 会话内连续跑 5 项；`Page/Runtime/Network/Log.enable`；`Page.addScriptToEvaluateOnNewDocument` 注入 `window.__qaErrs`（error / unhandledrejection）与 `requestAnimationFrame` 计数器 `__qaRafCount`（用于实证字符雨是否启动） |
| 4 | `Emulation.setEmulatedMedia` / `setScriptExecutionDisabled` / `setDeviceMetricsOverride` / `Runtime.evaluate{returnByValue:true}` / `Page.printToPDF` / `Input.dispatchKeyEvent` | 5 项对应的 CDP 方法 |
| 5 | 补充观测脚本 `C:/Users/Anders/AppData/Local/Temp/neo-qa-b1-printfix.js` | 修正 B1-1 探针选择器偏差（详见 §3.1），单次极短会话，仅测 print/screen 下可见链接的下划线、颜色与 `::after` |

> **方法学**：全部探针为纯 `Runtime.evaluate` 返回对象，**不向页面 DOM 注入任何元素**（避免 A 阶段之前出现过的探针自身撑宽页面假溢出）。每次场景切换重新 `Page.navigate`，确保观测为本次真实加载结果。

---

## 3. 项 1 — 打印媒体 / A4

**方法**：`Emulation.setEmulatedMedia({media:'print'})` + 1280×900 视口，逐页加载后读 computed styles 与 DOM 可见性；再用 `Page.printToPDF({format:'A4',printBackground:true,landscape:false})` 导出 PDF 并检查文件头、字节数与页对象数。

### 3.1 原始观测值（print 媒体）

| 观测值 | 版本页 | 门户 |
| --- | --- | --- |
| `matchMedia('print').matches` | `true` | `true` |
| `body` background / color | `rgb(255,255,255)` / `rgb(17,20,17)` | `rgb(255,255,255)` / `rgb(17,20,17)` |
| `.site-header` display | `none` | `none` |
| `.skip-link` display | `none` | `none` |
| `.matrix-atmosphere` display | `none` | `none` |
| `.matrix-rain` display | `n/a`（版本页无字符雨） | `none` |
| `.button--copy` display | `n/a`（版本页无复制按钮） | `none` |
| `.status-badge` display | `flex`（保留） | `flex`（保留） |
| `pre` white-space | `n/a`（版本页无 `<pre>`） | `pre-wrap` |
| `clientWidth` / `scrollWidth` / 横向溢出 | `1265 / 1265 / false` | `1265 / 1265 / false` |
| `body.innerText.length` | `5001` | `4318` |
| H1 数量 | `1` | `1` |
| 空 section（`innerText` 为空或高度 0） | `[]` | `[]` |
| 固定互链可见文本 | 2 处 `产品门户`：1 处随 header 隐藏、1 处（页脚）`visible:true` | 4 处全部 `visible:true`（`查看版本演进与事实来源` / `查看完整版本演进` / `查看版本演进` / `版本演进页`） |
| 网格 computed | `.footer-grid` 2 列、`.capability-grid` 3 列、`.fact-list` 2 列、`.evidence-grid` 5 列、`.boundary-list` 单列 | 全部折叠为单列 `1265px`（`.hero-layout` / `.card-grid` / `.pair-grid` / `.footer-grid` / `.capability-grid` / `.workflow-grid` / `.boundary-list`） |
| 控制台错误 | `[]` | `[]` |
| A4 PDF | `519557` B，`%PDF-1.4`，12 个 `/Type /Page` 对象 | `478346` B，`%PDF-1.4`，10 个 `/Type /Page` 对象 |

**可见链接下划线（补充观测，修正探针偏差）**：首版探针取 `document.querySelector('a')`，命中的是 print 下已隐藏且自带 `text-decoration:none` 的 skip-link，得到 `linkDecoration:none`，不能代表正文链接。补充观测改为遍历「display≠none 且宽度>0」的可见链接：

- 版本页 print：可见链接 `50` 个；普通链接 `v0.4.84`(#current-version)、`a2858ae`、`v0.4.84`(tag) 均 `decoration:"underline"`、`color:rgb(17,20,17)`；首个外链 `::after` content = `" (https://github.com/AndersHsueh/neo-cli)"`（打印稿附加 URL 生效）；`.button` 式链接「查看 v0.4.84 发布记录」「阅读该版本 README」为 `decoration:"none"`（见观察 O2）。
- 门户 print：可见链接 `25` 个；前 5 个（含「查看 GitHub 仓库」「阅读快速开始」按钮、互链「查看版本演进与事实来源」）全部 `decoration:"underline"`、`color:rgb(17,20,17)`；无 `::after` 附 URL（见观察 O3）。
- screen 对照：`printMatch:false`、可见链接 `57 / 32`、颜色 `rgb(240,247,242)`（text 色）、导航/按钮链接 `decoration:none` → 证明 print 媒体确实切换了配色与下划线，打印样式生效。

**判定：PASS**。正文未被截断（textLen 与正常模式 5071/4408 的差额仅为 header/skip 等被隐藏元素的文字，`sections=[]` 无空区）；互链文本可读；无横向溢出；浅色打印 tokens、隐藏装饰/复制按钮、`pre-wrap`、徽章保留、链接下划线与外链附 URL 均实测生效；两页 A4 PDF 成功生成且页对象数 > 0。

---

## 4. 项 2 — `prefers-reduced-motion: reduce` 实测

**方法**：`Emulation.setEmulatedMedia({media:'',features:[{name:'prefers-reduced-motion',value:'reduce'}]})`；先用 `no-preference` 载入门户作为**对照**，证明 JS 字符雨循环在正常模式下确实会启动（注入的 `__qaRafCount` 计数 `requestAnimationFrame` 调用）。

| 观测值 | 对照：门户 no-preference | 版本页 reduce | 门户 reduce |
| --- | --- | --- | --- |
| `matchMedia('(prefers-reduced-motion: reduce)').matches` | `false` | `true` | `true` |
| `.matrix-rain` computed display | `block` | `n/a`（无字符雨） | **`none`** |
| `.matrix-rain` `data-ready` | `"true"` | `n/a` | `"true"`（JS 仍初始化，但 CSS 强制隐藏且循环不启动） |
| `requestAnimationFrame` 调用数 `__qaRafCount` | **`57`** | **`0`** | **`0`** |
| `html` scroll-behavior | `smooth` | `auto` | `auto` |
| `.button` transition-duration | `0.12s, 0.12s, 0.12s` | `0s` | `0s` |
| `.button` / `html` animation-name | `none / none` | `none / none` | `none / none` |
| `.matrix-atmosphere` display | `block` | `block` | `block`（静态低对比纹理，非动画，允许保留） |
| `body.innerText.length` | `4408` | `5071` | `4408` |
| H1 / 时间线节点 / 能力轴卡 / 代码块 / 链接 | `1 / 0 / 3 / 7 / 32` | `1 / 5 / 6 / 0 / 57` | `1 / 0 / 3 / 7 / 32` |
| 页面 error / 控制台错误 | `[]` | `[]` | `[]` |

**判定：PASS**。对照 `rafCount=57` 证明默认模式字符雨循环会启动；reduce 下两页 `rafCount=0`（循环不启动）、门户 canvas `display:none !important`、`scroll-behavior:auto`、transition `0s`、animation `none`；核心内容（正文长度、时间线 5 节点、能力轴、7 个代码块、全部链接）与正常模式一致，无内容丢失、无控制台错误。

---

## 5. 项 3 — 禁用 JS 实测

**方法**：`Emulation.setScriptExecutionDisabled({value:true})` 后重新导航两页，读 computed/DOM；命令可手动选中性用 `document.createRange()` + `window.getSelection()` 实证。

| 观测值 | 版本页 | 门户 |
| --- | --- | --- |
| `documentElement.classList.contains('js')` | `false` | `false` |
| 复制按钮 总数 / 保持 `hidden` / computed display | `0 / 0 / n/a`（版本页无 JS 增强） | **`7 / 7 / none`** |
| `.matrix-rain` display / `data-ready` | `n/a` | **`none` / `null`**（JS 未执行，默认 CSS 隐藏） |
| `body.innerText.length` | `5071`（与正常模式一致） | `4373`（正常 4408，差 35 = 7 个隐藏复制按钮文案，核心正文未丢失） |
| H1 | `1` | `1` |
| 时间线节点 | `5` | `0`（门户本无时间线） |
| 卖点卡 / 工作流卡 | `6`（能力轴） | `3 / 4` |
| 代码块 `<pre>` / 来源区链接 | `0 / 14` | `7 / 6` |
| 固定互链可见 | 2 处 `产品门户`，均 `visible:true` | 4 处全部 `visible:true` |
| 空区块（`section[id]`/`main` 文本为空或高度 0） | `[]` | `[]` |
| 命令手动选中（Range+Selection） | `n/a`：版本页无 `<pre><code>`，不适用（O4） | **`len:44`、`sample:"bun run src/index.ts -p \"用 glob 找出所有 .ts 文件\""`、`userSelect:"auto"`** |
| 页面 error / 控制台错误 / HTTP≥400 | `[]` | `[]` |

**判定：PASS**。两页核心正文、版本节点、卖点、命令、事实来源、互链全部可读；`.js` 类未添加、复制按钮全部降级隐藏、字符雨默认隐藏；无空白区块、无依赖 JS 才可见的关键内容；门户命令文本可通过 Range+Selection 手动选中 44 字符，复制降级路径可用；零控制台错误。

---

## 6. 项 4 — 键盘路径

**方法**：正常模式 1280×900；`Input.dispatchKeyEvent` 发 Tab / Enter；读 `document.activeElement` 的 tag / 文本 / href / computed `outline*` / `transform`。

| 观测值 | 版本页 | 门户 |
| --- | --- | --- |
| skip-link 初始 `getBoundingClientRect().top` | `-128`（移出视口） | `-98` |
| skip-link 聚焦后 transform | `none`（回到左上） | `matrix(1, 0, 0, 1, 0, 0)`（translateY(0)） |
| 前 8 次 Tab 顺序 | 跳至正文 → brand(`#main-content`) → 产品门户(`portal/index.html`) → 当前版本 → 演进时间线 → 已知边界 → GitHub → v0.4.84 | 跳至正文 → brand(`index.html`) → 核心能力 → 真实工作流 → 版本演进 → 使用边界 → GitHub → 查看 GitHub 仓库 |
| 焦点环（8/8 步） | `outlineWidth:"3px"`, `outlineStyle:"solid"`, `outlineColor:"rgb(255, 209, 102)"` | 同左（= `--color-focus #ffd166`） |

**固定互链键盘激活**：

| 方向 | Tab 命中步数 | 聚焦元素 | 按 Enter 后 `location.href` |
| --- | ---: | --- | --- |
| 版本页 → `portal/index.html` | `3` | `A「产品门户」href="portal/index.html"`，3px 焦点环 | `http://127.0.0.1:4173/portal/index.html` ✅ |
| 门户 → `../neo-agent-version-evolution.html` | `10` | `A「查看版本演进与事实来源」href="../neo-agent-version-evolution.html"`，3px 焦点环 | `http://127.0.0.1:4173/neo-agent-version-evolution.html` ✅ |

**判定：PASS**。Tab 顺序与 DOM 一致且合理；skip link 默认移出视口、聚焦后回到左上并生效；所有焦点环 3px solid `rgb(255,209,102)` 清晰可见、未被移除；两条固定互链均可纯键盘（Tab + Enter）激活并跳转到正确目标。

---

## 7. 项 5 — 实际对比度（computed color / background，WCAG 相对亮度公式）

**方法**：页面内按 WCAG 2.x 相对亮度公式（`sRGB → linear`，`L=0.2126R+0.7152G+0.0722B`，`(L1+0.05)/(L2+0.05)`）计算；有效背景色沿父链向上取首个 `alpha≥0.95` 的背景；字号 ≥24px 或 ≥18.66px 且字重 ≥700 视为大字（门槛 3:1），否则 4.5:1。原始逐项结果同时落盘 `C:/Users/Anders/AppData/Local/Temp/neo-qa-browser-b1/contrast-raw.json`。

| 观测值 | 版本页 | 门户 |
| --- | --- | --- |
| 抽样数 | `18` | `29` |
| **最小对比度** | **`8.8:1`** | **`8.8:1`** |
| 不达标项 `fails` | **`[]`** | **`[]`** |
| 最低样本 | `.card__source` / `.timeline__date` / `.boundary-item p` = 8.8 | `.card-note` / `.terminal-note` / `.card--boundary p` / `.evidence-note p` / `.terminal-facts dt` / `.code-block__header` / `.status-explainer p` = 8.8 |
| 代表样本 | `p` 14.21、`.timeline__summary` 16.42、`.page-intro__lede` 9.93、`.button--primary` 13.41、`.button--secondary` 14.21、`.footer-links a` 14.21 | `.hero-intro` 18.53、`.hero-slogan` 16.42、`.code-block pre` 18.53、`.nav-list a` 17.62、`.button--primary` 13.41、`.button--ghost` 16.42、`a.text-link` 14.21 |

**三种状态徽章（重点检查：不能只靠颜色区分）**：

| 状态 | 版本页 | 门户 |
| --- | --- | --- |
| `已发布` | 文字「已发布」、`hasSvg:true`、`svgHidden:"true"`、对比度 **12.59:1**、`rgb(102,242,163)` | 同左，12.59:1 |
| `已实现，未发布` | 文字「已实现，未发布」、`hasSvg:true`、`svgHidden:"true"`、对比度 **12.4:1**、`rgb(255,209,102)`（出现在状态定义区样例） | `absent:true`（门户无该徽章实例，因 #52/#59/#37 仍为「本轮规划」；状态口径以 `.status-explainer` 文字说明，符合 PRD §5.1 / 设计系统 §11） |
| `本轮规划` | 文字「本轮规划」、`hasSvg:true`、`svgHidden:"true"`、对比度 **9.68:1**、`rgb(196,181,253)` | 同左，9.68:1 |

**判定：PASS**。两页所有抽样文字对比度 ≥8.8:1，远高于正文 4.5:1 / 大字 3:1 门槛；三种状态徽章均有完整文字 + `aria-hidden="true"` 的 SVG 图形标识（非仅颜色），且文字对比度 9.68–12.59:1 全部达标。

---

## 8. 缺陷清单与观察项

### 8.1 阻断缺陷
**无**。5 项全部通过，未发现需退回修复的功能性/可访问性缺陷。

### 8.2 观察项（低 / 信息级，非阻断，仅记录）

| # | 严重程度 | 文件 / 位置 | 期望 | 实际 | 建议角色 |
| --- | --- | --- | --- | --- | --- |
| O1 | 低（信息） | 版本演进页 `@media print` 网格 | 设计系统 §9.2 要求「门户打印时可折叠成单列」，未强制版本页 | 版本页 print 媒体下 `.capability-grid` 3 列、`.fact-list` 2 列、`.evidence-grid` 5 列、`.footer-grid` 2 列（门户已全部折叠单列）；实测内容完整（`sections=[]`）、`overflow=false`、A4 PDF 生成成功 | version-manager（可选优化，非必须） |
| O2 | 低 | 版本演进页 print 下 `.button` 链接 | 设计系统 §9.2 示例 `a { text-decoration: underline }` | 版本页 print 下「查看 v0.4.84 发布记录」「阅读该版本 README」computed `text-decoration:none`（被基础 `.button{text-decoration:none}` 覆盖）；但外链 `::after` 已附完整 URL、文字为 `rgb(17,20,17)` 可读；门户同类按钮在 print 下为 `underline` | version-manager（可选） |
| O3 | 低 | 门户 `@media print` | 设计系统 §9.2「对外链接**可**在打印稿中通过 `a[href^="http"]::after` 附加 URL」 | 门户 print 无 `::after` 附 URL（`firstAfterContent:"none"`），但所有可见链接均 `underline`；版本页有附 URL。属「可」选项差异 | operations-expert（可选） |
| O4 | 信息 | 版本演进页禁用 JS 场景 | 命令文本可手动选中 | 版本页无 `<pre><code>` 代码块，该项不适用；门户已实证选中 44 字符 | 无需处理 |

---

## 9. 限制

1. 打印验证使用 CDP print 媒体模拟（视口仍为 1280px）+ A4 PDF 导出；PDF 内文本未做逐字提取，正文完整性由 print 媒体下的 DOM 可见性、`innerText.length` 与空 section 检查佐证。
2. A4 PDF 的「页对象数」由 PDF 原始字节中 `/Type /Page` 计数得出，为粗略页数指标，非逐页视觉审阅（逐页审阅属 B2/人工）。
3. reduce 的「动画停止」以 `requestAnimationFrame` 调用计数（对照 57 / reduce 0）+ computed `transition-duration:0s`、`animation-name:none`、`scroll-behavior:auto` 佐证；未做逐帧视觉录制。
4. 键盘路径以 CDP `Input.dispatchKeyEvent` 模拟 Tab / Enter，非真实物理键盘；焦点环以 computed outline 判定，未做像素级截图比对。
5. 对比度为**抽样**（版本页 18 项 / 门户 29 项）computed 颜色按 WCAG 公式计算，非 axe / Lighthouse 全量扫描；有效背景色沿父链取首个不透明背景，未处理半透明叠加与图片背景（两页均为纯色/ CSS 渐变背景）。
6. 本阶段未执行 §1 所列 B2 项目；未运行项目代码测试、未修改 `web/` 文件、未改其它 `docs/`、未提交 / 推送。
7. 静态服务器与 Edge 进程在命令结束时均已停止；测试脚本、A4 PDF、原始对比度 JSON 均在系统 temp 目录，仓库内除本报告外无新增/修改。

---

## 10. 结论

```
BROWSER_B1: PASS
```

5 项均取得本次真实观测数据并通过：打印/A4 样式生效且正文完整、字符雨在 reduce 下不启动、禁用 JS 后全部核心内容可读且命令可手动选中、键盘路径（skip link / 焦点环 / 两条互链 Tab+Enter 跳转）正常、两页抽样文字最小对比度 8.8:1 且三种状态徽章文字与图形标识齐全。无阻断缺陷，4 项低/信息级观察。

**本阶段不给出最终 `IS_PASS`**：需 B2（200%/400% 缩放、17 个外链 HTTP 批量可达性、768/1440 截图逐张观察、Lighthouse）完成后，与 `STATIC_ONLY: PASS`、`BROWSER_A: PASS` 合并，由产品/QA 共同复核状态词与日期后给最终结论。

---

## 11. 下一步建议

1. 由主理人另开独立短阶段执行 B2；Lighthouse 若环境不具备须明确记「未执行」而非给分。
2. 观察 O1–O3 属可选优化，不阻断验收；若主理人决定统一两页打印表现，可由 version-manager / operations-expert 在后续批次处理（本阶段按指令未修改 `web/` 文件）。
3. 合并三份报告（static / browser-a / browser-b1）形成最终 `IS_PASS` 时，须逐项引用原始观测值，不以设计规范或人工印象替代实测。
