# neo-agent Web 成果 · 浏览器动态实测 A 阶段报告

> 报告路径：`docs/neo-agent-web-qa-2026-11-14-browser-a.md`
> QA：严过关（software-qa-engineer-2）｜日期：2026-11-14
> 阶段性质：**浏览器动态实测 A 阶段**。按主理人指令，本阶段范围严格限定为：本地静态服务器 + 精确视口测量 + 控制台/资源错误 + 互链验证 + 截图观察。
> 验收对象：`web/neo-agent-version-evolution.html`、`web/portal/index.html|styles.css|script.js|favicon.svg`（基于静态修复后的当前文件）
> 基准：`docs/neo-agent-iteration-2026-11-14-prd.md` §5 / §6、`docs/neo-agent-web-design-system.md` §6 / §9.3 / §13
> 前序：`docs/neo-agent-web-qa-2026-11-14-static.md`（`STATIC_ONLY: PASS`；2 项静态问题已由 version-manager / operations-expert 修复并经主理人核验）
> 结论标记：`BROWSER_A`（**不给出最终 `IS_PASS`**）

---

## 1. 本阶段边界与禁止项

**已执行**：本地静态服务器（以 `web/` 为根）、CDP 精确视口 360/768/1280/1440px、页面级横向溢出与元素越界/重叠/截断测量、`Page.captureScreenshot` 截图与视觉观察、控制台错误/未处理 Promise rejection/本地资源 404 捕获、两页固定互链的静态根解析 + HTTP 状态 + 真实点击跳转。

**明确未执行（按指令留 B 阶段）**：外链 HTTP 批量访问（GitHub URL 可达性）、Lighthouse、打印（`@media print` / A4 预览）、键盘路径（Tab 顺序与焦点）、对比度工具实测、`prefers-reduced-motion` 实测、禁用 JS 实测、200%/400% 缩放。详见 §6。

**合规**：未修改任何被验收文件、未运行项目代码测试、未提交、未推送；未访问任何外部互联网 URL（仅访问 `127.0.0.1:4173` 本地静态服务器）。

---

## 2. 实际工具 / 命令

| # | 工具 / 命令 | 说明 |
| --- | --- | --- |
| 1 | `python3 -m http.server 4173 --bind 127.0.0.1 --directory web`（cwd `D:/projects/neo-cli`） | 以 `web/` 为文档根的本地静态服务器；`trap` + `kill` + `wait` 保证结束时停止 |
| 2 | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/` | 就绪探测，返回 `static_server_root_http=200` |
| 3 | Edge：`"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --remote-debugging-port=0 --user-data-dir=<temp>` | 无头浏览器，CDP 随机端口由 `DevToolsActivePort` 读取 |
| 4 | Node 22（`WebSocket` / `fetch` 全局）+ 自写 CDP 客户端：`C:/Users/Anders/AppData/Local/Temp/neo-qa-browser-a.js` | 通过 DevTools 协议驱动；脚本仅写入 temp 目录，不触碰仓库 |
| 5 | `Page.enable` / `Runtime.enable` / `Network.enable` / `Log.enable` + `Page.addScriptToEvaluateOnNewDocument` | 订阅异常、console error、Log error、HTTP ≥400、`loadingFailed`；注入 `window.onerror` / `unhandledrejection` 兜底 |
| 6 | `Emulation.setDeviceMetricsOverride {width,height:900,deviceScaleFactor:1,mobile:false}` | **精确设宽**，不使用 `--window-size`（Edge 最小窗口宽度会把 360px 钳制到 481px，不可用） |
| 7 | `Runtime.evaluate {returnByValue:true}` + `Page.captureScreenshot` | 测量与截图 |
| 8 | `ViewImage` ×4 | 视觉观察 `version-360.png`、`portal-360.png`、`version-1280.png`、`portal-1280.png` |

> **方法学修正（重要）**：上一轮探测曾向页面 DOM 注入 `<pre>` 探针结果，`white-space:pre` 的长字符串把 `scrollWidth` 撑到 2000+，产生假溢出。本阶段改为**纯 `Runtime.evaluate` 返回对象，不向页面 DOM 注入任何元素**，因此 `scrollWidth` 为页面真实值。全部 8 个「页 × 视口」组合中 `scrollWidth === clientWidth`，证明测量未被工具本身污染。

---

## 3. 四档视口实测结果

测量表达式（在每页每次加载后于页面内执行）：
`document.documentElement.clientWidth` / `scrollWidth`、遍历 `body *` 的 `getBoundingClientRect()` 找出 `right > vw+1 || left < -1` 且**未被 `overflow-x:auto/hidden/scroll` 祖先裁剪**的元素、卡片 `scrollHeight > clientHeight` 且 `overflow:hidden` 的截断数、标题/徽章/按钮的 `scrollWidth > clientWidth` 单行溢出数，以及 H1 数量、`lang`、title、正文长度、`.js` 类、复制按钮可见数、字符雨 display、页面 error 事件。

| 视口 | 页面 | clientWidth | scrollWidth | 页面级横向溢出 | 越界元素 | 卡片截断 | 单行溢出 | H1 | lang | title | 正文长度 | `.js` | 复制按钮 | 字符雨 | 页面 error |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | --- | --- | --- | --- |
| 360px | 版本页 | 345 | 345 | 无 | 0 | 0 | 0 | 1 | zh-CN | 版本演进｜neo-agent | 5071 | false | 0/0 | n/a | [] |
| 768px | 版本页 | 753 | 753 | 无 | 0 | 0 | 0 | 1 | zh-CN | 版本演进｜neo-agent | 5071 | false | 0/0 | n/a | [] |
| 1280px | 版本页 | 1265 | 1265 | 无 | 0 | 0 | 0 | 1 | zh-CN | 版本演进｜neo-agent | 5071 | false | 0/0 | n/a | [] |
| 1440px | 版本页 | 1425 | 1425 | 无 | 0 | 0 | 0 | 1 | zh-CN | 版本演进｜neo-agent | 5071 | false | 0/0 | n/a | [] |
| 360px | 门户 | 345 | 345 | 无 | 0 | 0 | 0 | 1 | zh-CN | neo-agent｜Matrix 风格的终端编程助手 | 4408 | true | 7/7 | block | [] |
| 768px | 门户 | 753 | 753 | 无 | 0 | 0 | 0 | 1 | zh-CN | neo-agent｜Matrix 风格的终端编程助手 | 4408 | true | 7/7 | block | [] |
| 1280px | 门户 | 1265 | 1265 | 无 | 0 | 0 | 0 | 1 | zh-CN | neo-agent｜Matrix 风格的终端编程助手 | 4408 | true | 7/7 | block | [] |
| 1440px | 门户 | 1425 | 1425 | 无 | 0 | 0 | 0 | 1 | zh-CN | neo-agent｜Matrix 风格的终端编程助手 | 4408 | true | 7/7 | block | [] |

**判读**：
- `clientWidth = 设定宽度 − 15px`（垂直滚动条），属正常；8 组全部 `scrollWidth === clientWidth`，**页面级横向溢出 0**。
- 越界元素 0（代码块内 `<code>` 的横向滚动由 `pre { overflow-x:auto }` 合法容纳，探针已排除被裁剪元素，未误报）；卡片截断 0；标题/徽章/按钮单行溢出 0。
- 版本页 `.js=false` / 复制按钮 0 / 字符雨 n/a，符合「单一 HTML、无 JS、静态档案页」；门户 `.js=true` / 复制按钮 7/7 可见，说明本地 `script.js` 加载并成功初始化（复制增强为 JS 门控，符合设计系统 §3.6）。
- 门户字符雨默认 `display:block` 是 `no-preference` 下的预期渐进增强；本阶段按指令**不做** reduced motion 实测，其关闭逻辑留 B 阶段验证。
- 两页正文长度在 4 档视口保持一致（5071 / 4408），无内容因响应式被隐藏或丢失。

---

## 4. 截图观察记录

截图目录：`C:/Users/Anders/AppData/Local/Temp/neo-qa-browser-a/`（8 张，360/768/1280/1440 × 两页）。已用 `ViewImage` 观察 4 张关键图：

| 截图 | 观察结论 |
| --- | --- |
| `version-360.png` | 品牌「neo」方块 + `neo-agent` + 「版本演进 / RELEASE LEDGER」按两行排布；导航 5 项（产品门户/当前版本/演进时间线/已知边界/GitHub）在一行内完整可读、未溢出；H1「neo-agent 版本演进」两行；导语与 FACT SNAPSHOT 事实基线完整；当前版本区标题与说明可读；卡片「v0.4.84 + 已发布」在首屏底部（900px 截图高度的自然边界，非布局截断）。未见横向溢出、文字截断、重叠或遮挡。 |
| `portal-360.png` | 品牌三行式（neo / neo-agent / 终端编程助手），导航「核心能力 真实工作流 版本演进 使用边界」一行 +「GitHub」自然换行到第二行，符合设计系统 §3.2；eyebrow、已发布徽章 + `v0.4.84 · 2026-11-10`、H1 两行、品牌介绍、主口号均完整可读；两个 CTA 按钮满宽、第三入口为正文链接；背景字符雨为低对比稀疏竖排字符，文字层在实色/不透明表面上，未干扰阅读。未见横向溢出、截断或重叠。 |
| `version-1280.png` | 档案式居中阅读列；导航左右分布；H1 单行；当前版本卡（`surface-raised` + 绿色左边框）内 `v0.4.84` + 已发布徽章 + 摘要 + 发布日期 / 基线 commit 两列定义列表，数据无重叠或截断；背景静态网格极淡，不干扰文字。未见横向溢出。 |
| `portal-1280.png` | Hero 为 `1.05fr / 0.95fr` 两列：左文案（eyebrow、状态徽章组、H1、品牌介绍、主口号、两个 CTA、版本页正文链接、运行事实 li），右终端面板（标题、SOURCE/CLI 标签、真实命令 `<pre><code>`、复制命令按钮、协议/模式/前提定义列表、静态命令说明）；代码块内命令未撑破列宽；复制按钮显示说明 JS 增强生效；字符雨仅作背景、不挡文字。未见横向溢出、重叠或截断。 |

> 其余 4 张（768/1440 两页）已生成并以 DOM 几何测量覆盖（§3），未逐张做视觉模型观察；如需可补看。

---

## 5. 控制台、资源与互链

### 5.1 控制台 / 资源错误（每页 4 次加载，共 8 次）

| 页面 | `Runtime.exceptionThrown` | console error / Log error | `window.error` / `unhandledrejection` | HTTP ≥ 400 | `Network.loadingFailed` |
| --- | --- | --- | --- | --- | --- |
| 版本页 | `[]` | `[]` | `[]` | `[]` | `[]` |
| 门户 | `[]` | `[]` | `[]` | `[]` | `[]` |

结论：从静态服务器根加载时，**无控制台错误、无未处理 Promise rejection、无本地资源 404、无加载失败**。门户的 `styles.css` / `script.js` / `favicon.svg`、版本页的内联 data SVG favicon 均正常加载。

### 5.2 两页固定互链（静态根解析 + HTTP 状态 + 真实点击）

| 方向 | 选择器 / href | 解析后绝对 URL | 不跳出根 | 路径已规范化（无 `..`） | HTTP 状态 | 真实点击后 `location.href` |
| --- | --- | --- | --- | --- | ---: | --- |
| 版本页 → 门户 | `a[href="portal/index.html"]` | `http://127.0.0.1:4173/portal/index.html` | ✅ | ✅ | 200 | `http://127.0.0.1:4173/portal/index.html` |
| 门户 → 版本页 | `a[href="../neo-agent-version-evolution.html"]` | `http://127.0.0.1:4173/neo-agent-version-evolution.html` | ✅ | ✅ | 200 | `http://127.0.0.1:4173/neo-agent-version-evolution.html` |

结论：两条固定互链在**以 `web/` 为静态站点根**的场景下均解析到根内、URL 规范化后不含 `..`、目标 HTTP 200，且浏览器内真实点击可正确跳转，符合设计系统 §0.5 / §9.3 与 PRD §5.2「`file://` 打开和静态托管均可用」。静态阶段问题 #1（版本页 L1136 本地 `../docs/...prd.md` 链接）已改为非链接 span，本阶段从静态根验证未再出现跳出根的链接。

---

## 6. 问题清单

| # | 严重度 | 文件:行号 | 期望 | 实际 | 建议修复角色 |
| --- | --- | --- | --- | --- | --- |
| — | — | — | 4 档视口无页面级横向溢出、无越界/重叠/截断；控制台零错误；本地资源零 404；互链不跳出根且可达 | 全部满足（§3 / §4 / §5） | **无需修复** |

**本阶段未发现阻断问题。**

### 6.1 非缺陷观察（不需修复）

- **O1**：360px 版本页导航 5 项挤在一行（`web/neo-agent-version-evolution.html` 导航区），门户同宽度下已自然换成两行。DOM 测量 `overCount=0`、截图可读，未溢出；设计系统 §3.2 为「链接可横向换行」（允许而非强制），两页均为可接受表现。若追求一致，可由 version-manager 自行决定是否让版本页导航在窄屏换行——**非缺陷**。
- **O2**：门户默认 `no-preference` 下字符雨 `display:block`（`script.js` 成功初始化 + CSS 门控生效），视觉上为 ≤0.10 低对比稀疏字符，未干扰阅读；其 `reduce` 关闭逻辑按指令留 B 阶段实测。

### 6.2 未执行项（明确记录，留 B 阶段）

1. 外链 HTTP 批量访问（17 个 GitHub URL 的实际状态码）——本阶段按指令禁止，仅静态核对过 URL 结构。
2. Lighthouse（移动端 Performance / Accessibility / Best Practices / SEO ≥90 门槛与运行环境记录）。
3. 打印：`@media print` 生效与 A4 打印预览的实际可读性。
4. 键盘路径：Tab 顺序、焦点可见性、跳至正文实际操作、44px 目标、200%/400% 缩放。
5. 对比度工具实测：正文 ≥4.5:1、大字 ≥3:1、非文字边界与焦点 ≥3:1（本阶段仅沿用设计系统 §2.1 计算基线，按 §0.7 不替代成品复测）。
6. `prefers-reduced-motion: reduce` 实际偏好切换（含动画停止、字符雨关闭、`scroll-behavior`）。
7. 禁用 JS 实际打开（复制按钮保持隐藏、核心文字/链接/命令/时间线完整、无控制台异常）。
8. 两页像素级视觉一致性与 768/1440 截图的视觉模型逐张观察（DOM 几何测量已覆盖）。

---

## 7. 限制

1. 本阶段是**动态实测 A 阶段**，结论仅覆盖 §1 已执行范围；不得据此声称 PRD §5.5 / 设计系统 §13 的全部实测已完成。
2. 截图为视口首屏（900px 高），长页面下方区块以 DOM 几何测量（全 `body *` 遍历）覆盖，未做整页长截图。
3. 视觉观察基于 4 张关键截图，非全部 8 张；未使用 axe / Lighthouse 等自动化可访问性工具。
4. 静态服务器在命令结束时已 `kill` + `wait` 停止；CDP 浏览器进程同样结束。临时文件仅位于系统 temp 目录，仓库内除本报告外无任何新增/修改。
5. 未运行项目代码测试、未修改被验收文件、未提交、未推送。

---

## 8. 结论

```
BROWSER_A: PASS
```

在 `web/` 为根的本地静态服务器上，两页于 360 / 768 / 1280 / 1440px 精确视口下均无页面级横向溢出、无元素越界/重叠/截断；8 次加载零控制台错误、零未处理拒绝、零本地资源 404；两条固定互链不跳出静态根、目标 200 且真实点击跳转正确；4 张关键截图视觉观察正常。

**本阶段不给出最终 `IS_PASS`**：需 B 阶段完成 §6.2 全部未执行项（尤其对比度工具、键盘、reduced motion、禁用 JS、打印预览、外链可达性、Lighthouse 环境记录）后，由产品/QA 共同复核状态词与日期，再给最终结论。

---

## 9. 下一步建议

1. 由主理人另开独立短阶段执行 B 阶段（工具链已就绪：同样的静态服务器 + CDP `Runtime.evaluate` 模式，可用 `Emulation.setEmulatedMedia` 测 print / reduced motion、`Emulation.setScriptExecutionDisabled` 测无 JS、`Input.dispatchKeyEvent` 测键盘、页面内 WCAG 公式算对比度）；外链 HTTP 状态单独用 `curl` 批量核对，Lighthouse 若环境不具备须明确记「未执行」而非给分。
2. B 阶段完成后，与 `docs/neo-agent-web-qa-2026-11-14-static.md`（`STATIC_ONLY: PASS`）合并形成最终 `IS_PASS` 报告。
3. 核心 Issue 合入/发版状态变化时，按设计系统 §11 同步两页状态词、日期与验证记录，不猜版本号。
