# neo-agent Web 交付 · 最终 QA 报告（2026-11-14）

> 报告路径：`docs/neo-agent-web-qa-2026-11-14.md`
> 汇总：web-qa-final（最终 QA 汇总员）｜日期：2026-11-14
> 性质：**只读收敛**。本报告把已完成的四阶段实测报告、静态修复记录、门户同类链接复核、设计系统与两页源码收敛为一份可供正式展示引用的最终结论，并附本轮状态更新后的静态复核（§8）；本汇总不新增浏览器实测、不修改 `web/` 下任何文件、不改代码、不提交 / 推送 / 部署 git。
> 事实基线：2026-11-14；**当前已发布仍为 `v0.4.84` / 2026-11-10 / `a2858ae`**（未新增 tag、release note 或发布日期）；#52 / #59 / #37 **本轮已实现、未发布**。
> 基准：`docs/neo-agent-iteration-2026-11-14-prd.md` §5 / §5.4 / §5.5 / §6 / §7.2、`docs/neo-agent-web-design-system.md` v1.0（下称「设计系统」）。
> 验收对象（**仅两个 Web 页面**）：`web/neo-agent-version-evolution.html`（版本演进页）、`web/portal/index.html`（宣传门户，含本地 `styles.css` / `script.js` / `favicon.svg` 作为页面组成部分）。
> 收敛输入（全部已存在、已逐份读取核对）：
>   1. `docs/neo-agent-web-design-system.md`
>   2. `docs/neo-agent-web-qa-2026-11-14-static.md`
>   3. `docs/neo-agent-web-static-fixes-2026-11-14.md`
>   4. `docs/neo-agent-portal-link-review-2026-11-14.md`
>   5. `docs/neo-agent-web-qa-2026-11-14-browser-a.md`
>   6. `docs/neo-agent-web-qa-2026-11-14-browser-b1.md`
>   7. `docs/neo-agent-web-qa-2026-11-14-browser-b2.md`
>   8. `web/neo-agent-version-evolution.html`
>   9. `web/portal/index.html`

---

## 0. FINAL_WEB_QA 判定（结论区）

```
FINAL_WEB_QA: IS_PASS: YES
```

**判定依据（四阶段 + 两项闭环）**

| 证据项 | 结论标记 / 结果 |
| --- | --- |
| 阶段 1 静态事实与结构核查 | `STATIC_ONLY: PASS` |
| 阶段 2 浏览器动态实测 A | `BROWSER_A: PASS` |
| 阶段 3 浏览器动态实测 B1 | `BROWSER_B1: PASS` |
| 阶段 4 浏览器动态实测 B2 | `BROWSER_B2: PASS` |
| 版本页静态问题修复 | `STATIC_FIX: 2/2 已修复，静态复检通过` |
| 门户同类链接复核 | **无问题，未修改任何文件** |

四阶段均为 PASS、静态修复 2/2 闭环、门户同类链接复核无问题，因此最终给出 `IS_PASS: YES`。**该判定必须与其后紧随的「0.1 限定范围」同时引用**；单独摘取 `IS_PASS: YES` 而不带限定范围，会构成对未验证项的错误陈述。本轮状态更新后的静态复核（§8，`STATIC_RECHECK_AFTER_STATUS_UPDATE: PASS`，仅静态）已完成，**不改变本判定与其限定范围**；Lighthouse 仍未执行、PRD §5.5 ≥90 仍未验证、O5 仍未修复。

### 0.1 限定范围（与判定绑定，不可省略）

1. **Lighthouse 在本环境未执行**：B2 阶段环境检测显示本机 PATH 无 `lighthouse` CLI、npm 全局未安装、`require.resolve('lighthouse')` 失败、`npx --no-install` 无有效输出；按指令不联网安装、不给分数、不编造结果。**PRD §5.5 移动端四项（Performance / Accessibility / Best Practices / SEO）≥90 门槛未验证**，不得据此声称性能 / 可访问性 / 最佳实践 / SEO 达标，也不得编造任何分数或截图。
2. **≤192px 极端宽度横向滚动为已记录观察项 O5**：等效 CSS 视口宽度 75–192px 的极端缩放组合出现页面级横向滚动（成因是 `white-space:nowrap` 的 mono 版本号 / commit / 状态徽章与 44px 最小点击目标不换行）。该宽度远低于 WCAG 1.4.10 的 320 CSS px 测试点；内容完整、无空区 / 截断、导航与互链仍可达，登记为低优先级观察、**未修复、非阻断**。此项为已记录的观察项，不得写成「已通过」。
3. 上述两项以及第 4 节列出的其余条目，均为**已知限制**：不得包装成通过、不得替换为设计规范或人工印象、不得编造运行分数或截图。
4. 本报告结论仅对当前交付的两个页面与当前 `v0.4.84` 事实基线成立；#52 / #59 / #37 已由「本轮规划」更新为「已实现，未发布」，按设计系统 §11 同步两页状态词与证据后，**已于本轮状态更新后完成静态复核**（§8，纯静态、未启动浏览器）。该复核不改变上述三项限定；后续若实际发版或状态再变化，仍须按 §11 重新复核，不猜下一版本号与未来日期。

---

## 1. 逐阶段证据表

> 表中「关键实测数字」为各阶段报告中的原始观测值汇总；本次汇总已逐份读取报告原文并直接核对两页源码中的互链、修复点与资源加载。动态测量数字来自四阶段报告，非本次汇总重新跑测。

| 阶段 | 报告文件 | 实测项 | 关键实测数字 |
| --- | --- | --- | --- |
| STATIC_ONLY | `neo-agent-web-qa-2026-11-14-static.md` | 交付文件规模 | 版本页 1185 行 / 56,426 B；门户 `index.html` 486 行 / 29,501 B、`styles.css` 1381 行 / 25,302 B、`script.js` 183 行 / 6,018 B、`favicon.svg` 6 行 / 389 B |
| STATIC_ONLY | 同上 | design tokens 一致性 | 60 项自定义属性三方比对（设计系统 §2 / 版本页 `:root` / 门户 `styles.css :root`），空白归一化后**值漂移 0** |
| STATIC_ONLY | 同上 | 锚点与链接闭环 | 版本页 25 个 id / 8 个片段链接、门户 24 个 id / 7 个片段链接，**断链 0**；空 `href` / `href="#"` / `javascript:` / 断链均 0；本地资源引用合计 12 处、缺失 0 |
| STATIC_ONLY | 同上 | 外链 URL 结构 | 17 个唯一 URL，均为 `github.com/AndersHsueh/neo-cli` 下仓库根 / `commit/a2858ae` / `releases/tag/v0.4.8X` / `blob/<tag>/...` / `issues/52·59·37`，历史节点用对应 tag 快照而非 `main`（**本阶段仅结构核对，HTTP 状态留 B2**） |
| STATIC_ONLY | 同上 | 无外部运行依赖 | 指向 `https://` 的资源加载 0、CSS `url(http` 0、`@import` 0、JS 网络 API（fetch / XHR / serviceWorker / sendBeacon）0；版本页 `<script>` 0、门户仅 1 个本地 `script.js`(`defer`) |
| STATIC_ONLY | 同上 | 复制按钮初始态 | 门户 7 处 `<button type="button" data-copy-target … hidden>` 初始隐藏，JS 成功初始化后才显示 |
| STATIC_ONLY | 同上 | 脚本语法 | `node --check web/portal/script.js` → `SYNTAX OK`（退出码 0，仅执行一次） |
| STATIC_ONLY | 同上 | 语义 / 元数据 | 各页 H1=1、`lang="zh-CN"`、title 与 OG / Twitter 文案设计系统 §10.2 逐字一致；无 canonical / `og:url` / `og:image` |
| STATIC_ONLY | 同上 | 历史验证记录口径 | `v0.4.84` 发布时验证记录 1995 pass / 0 fail / 0 skip（115 文件）、PTY 32/32、以及该版本发布记录中的绿色结论表述；`v0.4.80`：1704 pass / 0 fail / 0 skip · PTY 24/24 —— 均明确标注为「该版本发布记录」，非本次复测 |
| STATIC_ONLY | 同上 | 待修复 | 2 项（1 中 P2、1 低 P3，均非阻断）+ 3 项观察；结论 `STATIC_ONLY: PASS`，**不给最终 IS_PASS** |
| BROWSER_A | `neo-agent-web-qa-2026-11-14-browser-a.md` | 静态站点根 | `python3 -m http.server 4173 --bind 127.0.0.1 --directory web`，就绪探测 `static_server_root_http=200` |
| BROWSER_A | 同上 | 四档视口几何 | **8 组**（2 页 × 360 / 768 / 1280 / 1440px）全部 `scrollWidth === clientWidth`，**页面级横向溢出 0**；`clientWidth` 345 / 753 / 1265 / 1425（设定值减 15px 滚动条）；越界元素 0、卡片截断 0、单行溢出 0 |
| BROWSER_A | 同上 | 内容完整性 | 正文长度版本页 5071 / 门户 4408，四档视口恒定，无响应式隐藏或丢失 |
| BROWSER_A | 同上 | JS 增强态 | 版本页 `.js=false` / 复制按钮 0/0 / 字符雨 n/a；门户 `.js=true` / 复制按钮 **7/7 可见** / 字符雨 `display:block`（no-preference 下预期渐进增强） |
| BROWSER_A | 同上 | 控制台 / 资源 | 8 次加载：`Runtime.exceptionThrown []`、console error / Log error `[]`、`window.error` / `unhandledrejection` `[]`、HTTP ≥400 `[]`、`Network.loadingFailed []` |
| BROWSER_A | 同上 | 两页固定互链 | 版本页→门户 HTTP 200、门户→版本页 HTTP 200；URL 规范化后不含 `..`、不跳出 `web/` 根；浏览器内真实点击 `location.href` 正确 |
| BROWSER_A | 同上 | 截图观察 | 4 张关键截图（`version-360` / `portal-360` / `version-1280` / `portal-1280`）目视正常，无溢出 / 截断 / 重叠 |
| BROWSER_B1 | `neo-agent-web-qa-2026-11-14-browser-b1.md` | 打印 / A4 | 版本页 A4 PDF **519,557 B**、`%PDF-1.4`、**12 个** `/Type /Page` 页对象；门户 **478,346 B**、**10 个**；print 可见链接 50 / 25，screen 对照 57 / 32；print 下 `body` 背景 `rgb(255,255,255)`、文字 `rgb(17,20,17)` |
| BROWSER_B1 | 同上 | reduced motion | 门户 `no-preference` 对照 `rafCount=57` → 两页 `reduce` **均为 0**；canvas `display:none`、`scroll-behavior:auto`、transition `0s`、animation `none`；内容长度与正常模式一致 |
| BROWSER_B1 | 同上 | 禁用 JS | 门户复制按钮 **7/7 保持 `hidden` / `display:none`**、字符雨 `none`；命令可手动选中 44 字符、`userSelect:auto`；正文 5071 / 4373（差 35 = 7 个隐藏复制按钮文案）；零控制台错误、零空区块 |
| BROWSER_B1 | 同上 | 键盘路径 | **8/8 步焦点环** `3px solid rgb(255,209,102)`（=`--color-focus #ffd166`）；skip-link 初始 `top` -128 / -98、聚焦回左上；两条互链分别在第 3 / 第 10 步 Tab 命中并 Enter 跳转正确 |
| BROWSER_B1 | 同上 | 实际对比度 | 抽样 18 / 29 项，**两页最小对比度 8.8:1**，正文代表样本 14.21–18.53:1；**`fails=[]`（两页）**；三状态徽章 12.59:1（已发布）/ 12.4:1（已实现，未发布，版本页状态定义区）/ 9.68:1（本轮规划），均含完整文字 + `aria-hidden` SVG 图形 + 颜色 |
| BROWSER_B2 | `neo-agent-web-qa-2026-11-14-browser-b2.md` | 200% / 400% 缩放 | **12 组**真实数值（基准 360 / 768 / 1280 × 200% / 400% × 两页）；WCAG 1.4.10 的 320 CSS px 测试点（1280@400%）两页 `clientW=305` / `scrollW=305` / `overflow=false`；正文长度恒定、`emptySections=[]`、`clipped=0`、导航 5/5、互链 2/2 与 4/4、门户 `<pre>` **7/7 可内部横滚** |
| BROWSER_B2 | 同上 | 17 个外链 HTTP | **17/17 HTTP 200**，`success2xx=17`、`failed_non2xx=0`、`blocked=0`、`BAD=[]`、`BLOCKED=[]`、**0 重定向**，耗时 0.694–2.175s；门户 12 个外链全部落在并集内，`portal_only_urls=[]` |
| BROWSER_B2 | 同上 | 全页截图逐张目视 | 4 张：`version-768.png` 712,692 B / `version-1440.png` 777,974 B / `portal-768.png` 763,484 B / `portal-1440.png` 817,459 B；均无明显错位 / 截断 / 空区域 / 风格漂移 |
| BROWSER_B2 | 同上 | Lighthouse | 环境检测**不具备**，明确记「未执行」（详见 §4 / §5），不给分数 |
| BROWSER_B2 | 同上 | 观察项处置 | B1 的 O1–O4 均建议「不需要修复」；新增 O5（低，极端宽度横向滚动）、O6（信息，Lighthouse 环境）各 1 项；无阻断缺陷 |

---

## 2. 两页交付清单与核验摘要

### 2.1 交付清单

| 页面 / 文件 | 规模 | 形态 | 说明 |
| --- | --- | --- | --- |
| `web/neo-agent-version-evolution.html` | 1185 行 / 56,426 B | 单一 HTML，CSS 与必要 JS 内联，favicon 为内联 data SVG | 版本演进页：档案式 760px 阅读列 + 单列时间线，当前版本卡优先；`<script>` 数为 0，`file://` 直接可读 |
| `web/portal/index.html` | 486 行 / 29,501 B | 结构 HTML | 宣传门户：Hero + 卖点 / 工作流网格 + 版本摘要 + 边界 |
| `web/portal/styles.css` | 1381 行 / 25,302 B | 本地相对样式表 | tokens 与设计系统 §2 值漂移 0；含响应式断点、reduced motion、`@media print` |
| `web/portal/script.js` | 183 行 / 6,018 B | 本地 `defer` 脚本 | 仅复制增强 + Hero 字符雨；`node --check` 语法通过 |
| `web/portal/favicon.svg` | 6 行 / 389 B | 本地 SVG | 深底 + 绿框 + `neo`，无影视标志 |

> 注：上表为状态更新前（静态阶段）快照；状态更新后的当前规模与行号基线见 §8.6。

### 2.2 互链核验

| 方向 | 固定相对地址 | 出处（源码行号） | 静态根解析 / HTTP | 键盘激活 |
| --- | --- | --- | --- | --- |
| 版本页 → 门户 | `portal/index.html` | `neo-agent-version-evolution.html` L798（导航）、L1176（页脚） | 解析到 `http://127.0.0.1:4173/portal/index.html`，不跳出 `web/` 根，HTTP 200，真实点击跳转正确 | 第 3 步 Tab 命中 + Enter 跳转正确 |
| 门户 → 版本页 | `../neo-agent-version-evolution.html` | `portal/index.html` L66、L378、L457、L475（共 4 处） | 从 `web/portal/` 解析到 `web/neo-agent-version-evolution.html`，仍在 `web/` 根内，URL 规范化无 `..`，HTTP 200，真实点击跳转正确 | 第 10 步 Tab 命中 + Enter 跳转正确 |

两页互链符合设计系统 §0.5 固定相对地址；版本页来源区原有的 `../docs/...prd.md` 跳出根链接已在静态修复中改为非链接 `<span>`（见 §3）。

### 2.3 无障碍核验摘要

- 语义骨架：`lang="zh-CN"`、每页 H1=1、`skip-link` → `header.site-header` → `nav[aria-label="主导航"]` → `main#main-content[tabindex="-1"]` → `footer.site-footer`；`pre[tabindex="0"]` + aria-label。
- 焦点：8/8 步焦点环为 3px solid `rgb(255,209,102)`，未被移除；skip-link 默认移出视口、聚焦回左上；Tab 顺序与 DOM 一致，无键盘陷阱。
- 状态非颜色可识别：三种状态徽章均为「完整文字 + `aria-hidden="true"` SVG 图形 + 颜色」，文字对比度 9.68–12.59:1。
- 对比度（B1 抽样，WCAG 相对亮度公式）：两页最小 8.8:1，`fails=[]`，高于正文 4.5:1 / 大字 3:1 门槛。
- reduced motion：对照 `rafCount 57 → reduce 0`，动画 / 过渡 / scroll-behavior 均关闭，核心内容不丢失。
- 禁用 JS：复制按钮 7/7 降级隐藏、字符雨默认隐藏、正文 / 时间线 / 命令 / 来源 / 互链完整，命令可手动选中，零控制台错误。
- 打印：`@media print` 浅色 tokens 生效、装饰与复制按钮隐藏、链接下划线，两页 A4 PDF 成功生成。
- 点击目标：`.button` / 导航 / 页脚链接 / 复制按钮 / 品牌均设 `min-height:2.75rem`（44px）。

### 2.4 响应式核验摘要

- 正式验收视口 360 / 768 / 1280 / 1440px：8 组 `scrollWidth === clientWidth`，页面级横向溢出 0、越界 0、截断 0、单行溢出 0。
- 200% / 400% 缩放：12 组等效视口数值；WCAG 1.4.10 的 320 CSS px 测试点两页无溢出；内容不丢失 / 不重叠、导航与互链全部可见可达、门户代码块 7/7 可内部横滚。
- 768 / 1440px 全页长截图逐张目视；断点 48 / 64 / 80rem 与容器封顶 75rem（1200px）居中、16 / 32 / 48px gutter 均按设计系统 §6。
- 已知极端宽度观察项 O5 见 §0.1(2) 与 §4，不计入上述通过项。

### 2.5 无外部运行依赖核验摘要

- 首次加载只请求当前 HTML 及明确存在的本地资源：版本页内联 CSS / data SVG favicon；门户本地 `styles.css` / `script.js` / `favicon.svg`（相对路径）。
- 指向 `https://` 的资源加载 0、CSS `url(http` 0、`@import` 0、`fetch` / XHR / serviceWorker / sendBeacon 0；版本页 `<script>` 0、门户 1 个本地 `defer`。
- 17 个外链为 GitHub 公开链接，**仅点击时才进入网络**；B2 用真实 HTTP HEAD 请求验证 17/17 为 200、0 失败、0 被阻止、0 重定向。
- 无 CDN、在线字体、远程图片、追踪脚本、第三方埋点；`file://` 与以 `web/` 为根的静态服务器均可读（BROWSER_A 已实测静态服务器场景）。

---

## 3. 已发现问题与修复闭环

### 3.1 版本页两项静态问题（STATIC_ONLY §3）与修复（STATIC_FIX 2/2）

| # | 严重度 | 位置 | 修复前（实际） | 期望 | 修复后（本次汇总已直接读源码核对） | 静态复检证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 中 / P2（条件性） | `web/neo-agent-version-evolution.html:1136` | 来源区 `<a href="../docs/neo-agent-iteration-2026-11-14-prd.md">本轮迭代盘点与增量 PRD（本地文档）</a>`；以 `web/` 为静态根部署时 `../docs/` 跳出根将 404，且目标是本轮规划态本地 PRD，不宜作公开可点击来源 | 来源区只引用公开、稳定、可回溯的资源（设计系统 §0.5 / §3.8 / §9.3） | 改为非链接：`<li><span>本轮迭代盘点与增量 PRD（本地规划文档，不随静态站点发布）</span>：状态纪律、#52 / #59 / #37 范围与 Web 禁区</li>`（L1136 已核对） | `Grep \.\./docs/\|aria-current="page"\|href=""` 版本页 **0 命中**；Issue #52 / #59 / #37 的 GitHub 链接 4 处（L1038 / L1048 / L1058 / L1137）未改；未新增任何虚构公开 URL |
| 2 | 低 / P3（语义） | `web/neo-agent-version-evolution.html:792` | `<a class="brand" href="#main-content" aria-current="page" …>`，`aria-current="page"` 指向页内片段而非当前页 URL | `aria-current="page"` 应指向当前页面 URL（设计系统 §3.2） | 直接移除该属性：`<a class="brand" href="#main-content" aria-label="neo-agent 版本演进页首">`（L792 已核对）；`href` / `aria-label` / 其余结构不变 | `Grep aria-current` 版本页 **0 命中** |

> 注：表内行号为状态更新前快照；状态更新后版本页行号整体 +1（brand L793、来源区 span L1137、导航互链 L799、页脚互链 L1177），现值见 §8.6。

两处修复均为最小变更、纯静态、可回溯；未触碰事实状态、内容禁区、tokens、锚点闭环、本地资源与元数据；未改其它文件；未执行任何动态实测与项目代码测试。关于 git：修复阶段 `git status --short` 显示 `web/` / `docs/` 为未跟踪新文件（`?? web/`），`git diff` 为空是「尚未纳入 git 跟踪」所致，不代表改动未生效；两行变化已由 Edit 成功返回与 Read 复核确认。

### 3.2 门户同类链接复核（`neo-agent-portal-link-review-2026-11-14.md`）

- **结论：无问题，未修改任何文件**（纯静态文本核查）。
- 无 `../docs/`、无本地 `.md` 链接、无指向未公开本地规划文档的链接；含 `.md` 的链接全部是 `https://github.com/AndersHsueh/neo-cli/blob/<tag>/...` 公开 GitHub 链接（本次汇总 Grep 复核一致）。
- 全目录仅 1 处 `aria-current="page"`（`portal/index.html` L25，`href="index.html"` 指向当前页自身），为正确用法，与版本页原问题不是同类（本次汇总 Grep 复核一致）。
- 无 `href=""` / `href="#"` / `javascript:` / `about:blank` / `onclick=` / 占位 CTA；所有 button CTA 均指向真实目标。
- 残余风险（来自复核报告）：4 处 `../` 互链依赖部署根为 `web/`；若日后单独以 `web/portal/` 为站点根部署，这些互链会跳出根 404，属部署口径约束、非当前缺陷；版本页改名 / 移动需回头复核门户这 4 处互链。该风险已在 §4 列为已知限制。

### 3.3 观察项汇总（均非阻断、未计入通过项）

| 编号 | 来源 | 内容 | 处置 |
| --- | --- | --- | --- |
| O1 | BROWSER_A | 360px 版本页导航 5 项挤一行（门户同宽自然换两行）；DOM 无溢出、截图可读，设计系统 §3.2 允许换行 | 非缺陷，不修复 |
| O2 | BROWSER_A / B1 | 门户 `no-preference` 下字符雨 `display:block`（≤0.10 低对比）；版本页 print 下 `.button` 链接无 underline | 非缺陷 / 可选优化，不修复 |
| O3 | B1 | 门户 print 无 `a[href^="http"]::after` 附 URL（设计系统 §9.2 为「可」选项） | 可选，不修复 |
| O4 | B1 | 版本页无 `<pre><code>`，「命令手动选中」不适用；门户已实证选中 44 字符 | 不适用，无需处理 |
| O5 | BROWSER_B2 | 等效 CSS 宽度 ≤192px 极端缩放组合出现页面级横向滚动（详见 §0.1 / §4） | **低优先级已记录观察项，未修复** |
| O6 | BROWSER_B2 | 本机 Lighthouse 环境不具备 | **信息级，明确记「未执行」**，见 §4 |

B2 对 B1 的 O1–O4 逐条给出「不需要修复」建议；四阶段均无阻断缺陷。

---

## 4. 未执行 / 已知限制（逐条列明原因与影响）

| # | 未执行 / 限制项 | 原因（逐条写实） | 影响与处置 |
| --- | --- | --- | --- |
| L1 | **Lighthouse 移动端四项跑分未执行** | B2 环境检测输出：`PATH: lighthouse NOT FOUND`、`npm global: lighthouse not installed`、`node module: NOT INSTALLED`、`npx --no-install lighthouse --version : 无有效输出`；按主理人指令不联网安装、不给分数、不编造结果 | **PRD §5.5 建议的移动端 Performance / Accessibility / Best Practices / SEO 四项 ≥90 门槛未验证**；不得声称性能 / SEO 达标、不得编造分数或截图。须在具备 CLI / 环境的机器单独补测并记录环境、运行方式与实际分数，或由主理人接受为已知限制。登记为 B2 观察 O6 |
| L2 | **≤192px 极端宽度横向滚动（O5）** | `white-space:nowrap` 的 mono 版本号 / commit / 状态徽章与 44px 最小点击目标在极窄等效视口不换行；出现于版本页 360@200%(180px) / 360@400%(90px) / 768@400%(192px)、门户 360@200%(180px) / 360@400%(90px) | 仅出现在等效 CSS 宽度 75–192px，远低于 WCAG 1.4.10 的 320 CSS px 门槛；该测试点（1280@400%）两页实测无溢出。极端组合下内容完整（`textLen` 恒定）、`emptySections=[]`、无截断，导航 5/5 与互链 2/2·4/4 仍可见、门户 7/7 代码块可内部横滚。**登记为低优先级观察项，未修复、非阻断，不得写成已通过**；如需覆盖，可选对 ≤320px 的 nowrap 版本号 / commit 加 `overflow-wrap:anywhere` |
| L3 | 对比度为**抽样计算**，非 axe / Lighthouse 全量扫描 | B1 在页面内按 WCAG 相对亮度公式对 computed 颜色抽样：版本页 18 项 / 门户 29 项；有效背景沿父链取首个 `alpha≥0.95` 背景 | 结论为「抽样文字 ≥8.8:1、`fails=[]`」，不是全量自动化可访问性扫描结论；未处理半透明叠加与图片背景（两页均为纯色 / CSS 渐变背景，设计系统 §2.1 另给调色板计算基线）。不替代成品页面所有状态的穷举复测 |
| L4 | 缩放采用「等效 CSS 视口宽度」法 | 按 WCAG 1.4.10 惯例用 CDP `Emulation.setDeviceMetricsOverride` 精确设 `等效宽度=floor(基准/倍数)`，未用 `style.zoom`、未操作真实浏览器缩放按钮 | 在极端宽度下可视为等价的 Reflow 压力测试，但**未做真实浏览器缩放按钮操作**；12 组数值与 320 CSS px 测试点结论仍成立 |
| L5 | 键盘路径为 CDP 模拟 | 用 `Input.dispatchKeyEvent` 模拟 Tab / Enter，焦点环以 computed `outline*` 判定 | **非真实物理键盘、未做像素级焦点环截图比对**；Tab 顺序、8/8 焦点环与两条互链 Enter 跳转的 DOM 观测结论成立 |
| L6 | 打印为 CDP print 媒体模拟 + A4 PDF 导出 | `Emulation.setEmulatedMedia({media:'print'})`（视口仍 1280×900）+ `Page.printToPDF({format:'A4'})`；PDF 内文本未逐字提取；页对象数为 PDF 原始字节中 `/Type /Page` 计数 | 正文完整性由 print 媒体下 DOM 可见性、`innerText.length`（5001 / 4318）与空 section 检查佐证；**页对象数是粗略页数指标，非逐页视觉审阅**；未做 A4 纸质打印 |
| L7 | 外链为 HEAD 请求 | `curl -sS -o /dev/null -L -I`（跟随重定向），17 个 URL、6 并发 | 验证的是 **URL 可达性与重定向**，**未校验返回正文内容**；GitHub 对不存在路径会返回 404，本次 17/17 为 200 |
| L8 | 整页长截图细小文字无法逐字辨认 | B2 用 `Page.captureScreenshot{captureBeyondViewport:true}` 生成整页长截图，缩放显示后逐张目视 | 目视结论聚焦**版式结构、区块完整性、状态徽章、代码块、页脚与互链**；文字内容正确性由静态核查与 B1 的 DOM 观测佐证，不由截图逐字判定 |
| L9 | 门户 4 处 `../` 互链依赖部署根为 `web/` | 来自门户同类链接复核残余风险；本次交付未做实际部署 | 若日后单独以 `web/portal/` 为站点根部署，4 处互链会跳出根 404；属**部署口径约束、非当前缺陷**。本汇总未做任何部署验证，也不给出部署相关的通过结论 |
| L10 | 未运行项目代码测试 / 未改代码 / 未提交推送 | 四阶段与本汇总均按只读 / 最小变更约束执行 | 未运行 `bun test` / `verify.sh`，未修改 `web/` 下任何文件、未改其它 `docs/`、未提交 / 推送 / 部署；本报告不作上述任何声称 |
| L11 | 状态词 / 日期 / 验证记录的事实复核范围 | 结论依据 PRD §5.4 / §6 与设计系统 §11，对当前 `v0.4.84` 基线成立 | #52 / #59 / #37 本轮已更新为「已实现，未发布」并完成状态更新后的静态复核（§8）；该复核仅静态、未新增浏览器实测。若后续实际发版或状态再变化，仍需按 §11 重新复核，不猜下一版本号与未来日期 |

---

## 5. 复现命令

> 工作目录统一为 `D:/projects/neo-cli`；以下命令均为只读或本地临时进程，不修改仓库。

**5.1 本地静态服务器（四阶段动态实测的统一站点根）**

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory web
# 就绪探测（另开终端）
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/     # 期望 200
# 结束后停止服务器进程（trap + kill + wait）
```

**5.2 脚本语法（静态阶段执行过一次，输出 SYNTAX OK / 退出码 0）**

```bash
node --check web/portal/script.js
```

**5.3 静态修复与同类链接复检（Grep）**

```bash
# 版本页两项修复是否残留（期望 0 命中）
grep -nE '\.\./docs/|aria-current="page"|href=""' web/neo-agent-version-evolution.html
grep -n 'aria-current' web/neo-agent-version-evolution.html          # 期望 0 命中
# Issue 链接未被改动（期望 4 处）
grep -nE 'issues/52|issues/59|issues/37' web/neo-agent-version-evolution.html
# 两页固定互链
grep -n 'portal/index.html' web/neo-agent-version-evolution.html
grep -n '\.\./neo-agent-version-evolution.html' web/portal/index.html
```

**5.4 CDP 精确视口 / 打印 / reduced motion / 禁用 JS / 键盘 / 全页截图**

```bash
# Edge headless（随机 CDP 端口由 DevToolsActivePort 读取）
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check --remote-debugging-port=0 \
  --user-data-dir=<temp>
```

CDP 方法（Node 22 + WebSocket 自写客户端，探针为纯 `Runtime.evaluate` 返回对象，**不向页面 DOM 注入任何元素**）：

| 目的 | CDP 方法 |
| --- | --- |
| 精确设宽（不用 `--window-size`，Edge 最小窗口宽度会把 360px 钳到 481px） | `Emulation.setDeviceMetricsOverride {width,height:900,deviceScaleFactor:1,mobile:false}` |
| 打印媒体 / A4 PDF | `Emulation.setEmulatedMedia {media:'print'}` + `Page.printToPDF {format:'A4',printBackground:true}` |
| reduced motion | `Emulation.setEmulatedMedia {media:'',features:[{name:'prefers-reduced-motion',value:'reduce'}]}` |
| 禁用 JS | `Emulation.setScriptExecutionDisabled {value:true}` |
| 键盘 | `Input.dispatchKeyEvent`（Tab / Enter） |
| 全页截图 | `Page.captureScreenshot {captureBeyondViewport:true}` |
| 错误 / 资源订阅 | `Page.enable` / `Runtime.enable` / `Network.enable` / `Log.enable` + `Page.addScriptToEvaluateOnNewDocument` 注入 `window.onerror` / `unhandledrejection` 兜底 |

**5.5 外链 HTTP 可达性（B2 项 2）**

```bash
curl -sS -o /dev/null -L -I --max-time 15 \
  -w "%{http_code}|%{num_redirects}|%{redirect_url}|%{time_total}" <URL>
# 从两页 HTML 用 href="(https?://[^"]+)" 提取去重外链，6 并发逐项请求
```

**5.6 Lighthouse 环境检测（B2 项 4 —— 检测结果均为不具备，故未跑分）**

```bash
command -v lighthouse
lighthouse --version
npm ls -g --depth=0
node -e "require.resolve('lighthouse')"
timeout 25 npx --no-install lighthouse --version
```

---

## 6. 收敛溯源：输入文件与本报告的关系

| 输入文件 | 阶段 / 角色 | 本报告引用位置 |
| --- | --- | --- |
| `docs/neo-agent-web-design-system.md` | 设计系统 v1.0，交付契约与验收基准 | §0 基线、§2、§3、§4 |
| `docs/neo-agent-web-qa-2026-11-14-static.md` | 阶段 1 `STATIC_ONLY: PASS`，提出 2 项静态问题 | §1、§3.1 |
| `docs/neo-agent-web-static-fixes-2026-11-14.md` | 静态修复 `STATIC_FIX: 2/2` | §0 判定依据、§3.1 |
| `docs/neo-agent-portal-link-review-2026-11-14.md` | 门户同类链接复核：无问题、未改文件 | §0、§3.2、§4(L9) |
| `docs/neo-agent-web-qa-2026-11-14-browser-a.md` | 阶段 2 `BROWSER_A: PASS`（视口 / 控制台 / 互链 / 截图） | §1、§2 |
| `docs/neo-agent-web-qa-2026-11-14-browser-b1.md` | 阶段 3 `BROWSER_B1: PASS`（打印 / reduce / 无 JS / 键盘 / 对比度） | §1、§2、§3.3 |
| `docs/neo-agent-web-qa-2026-11-14-browser-b2.md` | 阶段 4 `BROWSER_B2: PASS`（缩放 / 外链 / 截图 / Lighthouse 未执行） | §1、§2、§3.3、§4、§5 |
| `web/neo-agent-version-evolution.html` | 交付页 A（本次汇总直接核对 L792 / L1136 / L798 / L1176） | §2、§3.1 |
| `web/portal/index.html` | 交付页 B（本次汇总直接核对 L25 / L66 / L378 / L457 / L475 / 资源加载） | §2、§3.2 |
| 本轮状态更新（主理人指令，2026-11-14） | #52 / #59 / #37 → 「已实现，未发布」；两页状态词 / 徽章 / 边界 / 来源 / 页脚同步 | §0.1(4)、§8 |
| `docs/evidence/integration-windows-2026-11-14-tests.txt` | 只读存在性与文本标记核对（**非测试执行**） | §8.4 |

> 注：本表及 §2.1 / §2.2 / §3.1 中的 `web/` 文件规模与源码行号均为本轮状态更新前（静态阶段）快照；当前值见 §8.6。

---

## 7. 范围声明（明确边界）

**本报告只覆盖 `web/neo-agent-version-evolution.html` 与 `web/portal/index.html` 两个 Web 页面**（含门户本地 `styles.css` / `script.js` / `favicon.svg` 作为页面组成部分），**不代表 neo-cli 产品代码的全量测试结论**。本报告不覆盖：产品功能测试、CLI / 运行时行为、构建与 CI、单元 / 集成测试套件、线上性能表现、真实部署可用性；不对产品代码质量、发布状态、提交 / 推送 / 部署作任何声称；不涵盖产品代码在 Windows / macOS / Linux 上的实机行为验证。§0 的 `IS_PASS: YES` 仅对上述两个 Web 页面在四阶段实测覆盖范围与 §0.1 / §4 限定范围内成立；本轮状态更新后的静态复核（§8）亦不改变该边界。

**产品代码全量 `bun test` 遇到 Bun 1.3.6 主线程段错误（第一次在 108s 中断、TEST_EXIT=3，证据 `docs/evidence/integration-windows-2026-11-14-tests.txt`；第二次复跑结果待定），不属于本报告通过范围**；不得把该结果写成产品级测试已达标，也不得给出任何形式的全绿判定；相关数字仅由主理人指令提供，本次复核未运行、未独立复现。详见 §8.4。

---

## 8. 状态更新后的静态复核（2026-11-14）

> 复核：web-qa-final｜性质：**纯静态、只读**。按主理人指令，本阶段不启动浏览器 / CDP / 截图 / Lighthouse、不运行项目代码测试、不提交 / 推送 / 部署；**唯一写入文件为 `docs/neo-agent-web-qa-2026-11-14.md`**，未修改 `web/` 下任何文件。
> 触发：#52 / #59 / #37 由「本轮规划」更新为「已实现，未发布」后的页面状态同步。
> 依据：主理人指令三项输入、设计系统 §3.3 / §9.3 / §11、PRD §5.4 / §7.2。§1 四阶段动态实测数据仍为状态更新前的原始观测值；本节**不新增任何浏览器观测值、不补造分数或截图**。

### 8.1 本轮状态更新口径（指令内容逐项与源码比对）

| 项 | 指令口径 | 源码核对结果 |
| --- | --- | --- |
| 状态词 | #52 / #59 / #37 两页改「已实现，未发布」 | ✅ 版本页 04 节 3 张卡、门户 3 个 capability subitem 均改（见 §8.2） |
| 版本页 04 节 | 标题「本轮实现（已实现，未发布）」、kicker `04 / IMPLEMENTED, NOT RELEASED` | ✅ L1031 kicker、L1032 `<h2 id="planned-title">`；`id="planned"` / `planned-title` 未改，锚点仍闭合 |
| 当前已发布版本 | 仍 `v0.4.84` / 2026-11-10 / `a2858ae`；**未新增 tag / release note / 发布日期** | ✅ 版本页 L1172、门户 L480 页脚均写明；页面内 `v0.4.84` / `a2858ae` / `commit/a2858ae` 仍为唯一发布基线 |
| 事实盘点日期 | 2026-11-14 | ✅ 两页页脚与版本页 `<time datetime="2026-11-14">` 一致 |
| 本地提交 | #52 `879dee2`、#59 `0b128ce`、#37 `8691c52` + `b3f29c2`，**只作纯文本 `<code>`、未新增任何 GitHub commit 链接** | ✅ 4 个哈希仅出现在版本页 L1045 / L1055 / L1065 的 `<code>` 中；全站 `commit/` 链接仍只有 `commit/a2858ae`（3 处：门户 L343、版本页 L846 / L1121）；`56ef369` 未出现在 `web/` 任何文件 |
| 页脚 | 两页各加「本轮三项已实现，未发布」 | ✅ 版本页 L1172、门户 L480 |
| 边界 / 来源 / 口径 | 版本页「模型判断不等于验证」、状态定义说明、事实来源「规划与边界」一条；门户能力区导语、2 张边界卡、事实来源 3 条、发布状态口径 | ✅ 门户 L406「模型判断不等于验证」、L418「本轮实现尚未发版」、L436–438 三条 Issue 来源、L442 发布状态口径；版本页 L1035 状态边界说明、L1137–1139 来源区、L1144–1157 状态定义图例、L1159–1162 更新政策均已同步 |
| 未改文件 | `web/portal/script.js`、`web/portal/favicon.svg` | ✅ 183 行 / 6,018 B 与 6 行 / 389 B，与静态阶段字节完全一致 |

### 8.2 逐项静态复核结果（本次实际执行，只读）

| 复核项 | 命令 / 方法 | 实测结果 |
| --- | --- | --- |
| 状态词与徽章 | Grep + Python 计数 / 逐行 Read | 版本页 `status-badge--unreleased` DOM 实例 **4 处**（3 张 `.card--unreleased` + 1 处状态定义图例），门户 **3 处**（3 个 `.capability-subitem--unreleased`）；每枚徽章均含菱形 SVG（`aria-hidden="true" focusable="false"`）+ 完整文字「已实现，未发布」+ `--color-unreleased` 黄色，满足「文字 + 图形 + 颜色」非颜色可识别。文本计数：版本页「已实现，未发布」8 次 / 门户 5 次（含正文与图例）；版本页 `.card--planned` DOM 实例 **0**（仅保留 CSS 定义） |
| 徽章样式 / tokens | Grep CSS 定义 | 版本页 L346 `.card--unreleased { border-left: 4px solid var(--color-unreleased) }`、L432 `.status-badge--unreleased { color: var(--color-unreleased) }`、L606 `.planning-note strong { color: var(--color-unreleased) }`；门户 `styles.css` L630 `.status-badge--unreleased`、L738 `.capability-subitem--unreleased { border-left-color: var(--color-unreleased) }`。`--color-unreleased: #ffd166` 两页 `:root` 一致（版本页 L35 / 门户 L18），打印态 `#111411` 亦两页一致（版本页 L745 / 门户 L1267）；**无 token 漂移** |
| 两页互链 | Grep 固定相对地址 | 版本页 → `portal/index.html` **2 处**（L799 导航、L1177 页脚）；门户 → `../neo-agent-version-evolution.html` **4 处**（L66 / L378 / L457 / L475）；与更新前一致，均不跳出 `web/` 根 |
| 锚点闭环 | Python 静态脚本（`id` ↔ `href="#…"`） | 版本页 25 个 id / 8 个片段链接、门户 24 个 id / 7 个片段链接，**断链 `[]`**；空 `href` `[]`、`href="#"` `[]`、`javascript:` `[]`；`../docs/` 与本地 `.md` 链接 `[]` |
| 本地资源 | Grep + 文件存在性 | 门户 `favicon.svg`（L16）/ `styles.css`（L17）/ `script.js`（L18，`defer`）3 个相对引用，文件均存在；版本页 L16 仍为内联 data SVG favicon，无外部引用 |
| 无新增外链 | Python 提取 `href="https://…"` 去重 | 版本页 17 个唯一 URL、门户 12 个、**并集 17 个**，与 B2 阶段 17 个完全一致；**无新增 GitHub commit / tag / release note 链接**，无新增公开 URL |
| 无新增 https 资源加载 | Grep 外部资源标签（script / link / img / iframe / source 的 https 引用）+ CSS/JS 扫描 | 两页 `https_RESOURCE_LOADS=[]`；`css_url(http)=0`、`@import=0`、JS 网络 API（fetch / XHR / serviceWorker / sendBeacon）`0`（两页 HTML 与 `styles.css` / `script.js` 均为 0）；版本页 `<script>` 0、门户 1 个本地 `defer`。**首次加载仍只请求当前 HTML 与本地资源** |
| 状态定义图例一致性 | 逐行 Read | 版本页 L1144–1157 三态图例（已发布 / 已实现，未发布 / 本轮规划）与门户 L442 文字口径、L157–186 徽章实例一致。残存「本轮规划」字样共 **3 处，均合法**：版本页 L1035 历史表述「已从『本轮规划』推进为…」、L1154 状态定义图例、门户 L442 发布状态口径——均非功能项状态标注 |
| `node --check` | `node --check web/portal/script.js` | **退出码 0、无错误输出（语法通过）**；`script.js` 未改动，与静态阶段 `SYNTAX OK` 结论一致 |
| 静态修复残留 / `aria-current` | Grep | 全 `web/` 仍仅 1 处 `aria-current="page"`（门户 L25 `href="index.html"`，正确用法）；版本页 0 处；§3.1 两项静态修复未被回退 |

### 8.3 复检结论（原文）

```
STATIC_RECHECK_AFTER_STATUS_UPDATE: PASS（仅静态，限定范围不变）
```

本结论仅表示：状态更新后的两页源码在**状态词 / 徽章样式 / 互链 / 锚点闭环 / 本地资源 / 无新增外链 / 无新增 https 资源加载 / 状态定义图例一致性 / `node --check`** 九项静态复核上与指令口径一致，未发现需退回修复的静态问题。

- **`FINAL_WEB_QA: IS_PASS: YES` 的限定范围不变**：Lighthouse 在本环境**仍未执行**（PATH / npm global / node module / npx 均不具备），PRD §5.5 移动端四项 ≥90 门槛**仍未验证**，观察项 O5（≤192px 极端宽度横向滚动）**仍未修复**、仍为低优先级已知限制。本节不新增任何浏览器实测、不补造分数或截图，也不改判 §0 结论。
- 本轮状态更新**未重新执行** BROWSER_A / B1 / B2 动态实测（按指令禁止启动浏览器）。§1 中的 8 组 `scrollWidth===clientWidth`、17/17 外链 2xx、A4 PDF 页数与字节数、rafCount 57→0、7/7 复制按钮、8/8 焦点环、最小对比度 8.8:1、`fails=[]` 等均为**状态更新前四阶段的原始观测值**，不作为更新后页面的新增动态证据。

### 8.4 产品代码验证（不在本报告通过范围）

主理人指令提供的本机实测证据数字如下，**本次静态复核未运行任何项目代码测试、未独立复现、未读取产品源码，仅用于界定范围**：

| 项 | 指令给出的数字 |
| --- | --- |
| `bun run check` | Exit 0 |
| #37 E2E + 单元 | 31 pass / 0 fail / 1287 expect |
| #59 定向 | 21 pass / 0 fail |
| 夹具 6 文件 | 145 pass / 1 fail（唯一 K4.1 软链 EPERM） |
| 全量 `bun test` | 第一次在 108s 被 Bun 1.3.6 主线程段错误中断（TEST_EXIT=3）；第二次完整跑完 `1946 pass / 5 skip / 96 fail / 3 errors`，差集发现并随后修复了 5 条 `repo-map-refs` 回归；第三次（最终）`1951 pass / 5 skip / 91 fail / 3 errors`，差集 `new=0 / fixed=15 / still=91`。详见 `docs/neo-agent-final-verification-2026-11-14.md`。**全量未绿灯，不属于本报告通过范围** |

只读佐证：`docs/evidence/integration-windows-2026-11-14-tests.txt` 存在（93,659 B），其第 1284 行含 `panic(main thread): Segmentation fault at address 0xFFFFFFFFFFFFFFFF`，另有 EPERM symlink 记录（第 206 / 563 行）；本次仅核对文件存在与文本标记，**未运行测试、未复现 TEST_EXIT**。指令中的事实来源 `docs/neo-agent-iteration-2026-11-14-architecture.md` §3.6–3.9、`src/streamJson.ts`、`docs/evidence/` 属产品代码与文档范围，本次未核查。

> **明确声明**：本报告只覆盖两个 Web 页面；产品代码全量 `bun test` 遇到 Bun 运行时段错误，**不属于本报告通过范围**，不得把该结果写成产品级测试已达标，也不得给出任何形式的全绿判定。上述数字不进入 §0 判定依据、不改变 `IS_PASS: YES` 的限定范围。

### 8.5 本阶段合规

- 未启动浏览器 / CDP / 截图 / Lighthouse；未运行 `bun test` 等项目代码测试，按用户约束也未执行任何 `*.sh` 脚本；未提交 / 推送 / 部署 / 打 tag / 发版 / 关 Issue。
- 未修改 `web/` 下任何文件；`web/portal/script.js` 与 `web/portal/favicon.svg` 与静态阶段字节一致。
- 唯一写入文件为 `docs/neo-agent-web-qa-2026-11-14.md`（本节）；仓库根 `README.md` 与 `settings.example.json` 的改动不在 `web/` 范围内，按指令未核查。

### 8.6 规模与行号基线更新

§2.1 文件规模与 §2.2 / §3.1 / §6 的源码行号均为**本轮状态更新前（静态阶段）快照**；本次复核读到的当前值如下，凡引用上述位置者以本表为准：

| 文件 | 更新前（§2.1 快照） | 当前（本次 `wc`） | 变化 |
| --- | --- | --- | --- |
| `web/neo-agent-version-evolution.html` | 1185 行 / 56,426 B | **1186 行 / 57,709 B** | +1 行 / +1,283 B |
| `web/portal/index.html` | 486 行 / 29,501 B | **486 行 / 30,088 B** | 行数不变 / +587 B |
| `web/portal/styles.css` | 1381 行 / 25,302 B | **1385 行 / 25,385 B** | +4 行 / +83 B |
| `web/portal/script.js` | 183 行 / 6,018 B | 183 行 / 6,018 B | 未改 |
| `web/portal/favicon.svg` | 6 行 / 389 B | 6 行 / 389 B | 未改 |

版本页行号整体 +1（04 节扩写所致），关键位置现值：brand `L793`、导航互链 `L799`、页脚互链 `L1177`、来源区 span `L1137`、04 节 kicker `L1031` / H2 `L1032`、事实基线 `L1172`；门户行号未变：`L25` / `L66` / `L378` / `L457` / `L475` / `L480`。

---

> 汇总完毕（含 §8 状态更新后的静态复核）。本报告为唯一写入文档；四阶段实测数据均逐项引用原始报告观测值，§8 仅新增只读静态核查结果，未以设计规范或人工印象替代实测，未补造任何浏览器实测、Lighthouse 分数、外链正文内容或截图结论；产品代码全量测试不在本报告通过范围。
