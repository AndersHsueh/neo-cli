# neo-agent Web 成果 · 浏览器动态实测 B2 阶段报告（缩放 / 外链 / 截图 / Lighthouse）

> 报告路径：`docs/neo-agent-web-qa-2026-11-14-browser-b2.md`
> QA：严过关（software-qa-engineer-2）｜日期：2026-11-14
> 阶段性质：**B2 —— 补齐 B1 报告 §1/§9 列明的 4 项未执行项**：200%/400% 缩放、17 个外链 HTTP 可达性、768/1440px 截图逐张观察、Lighthouse 可用性。
> 站点根：`D:/projects/neo-cli/web`（本地静态服务器 `http://127.0.0.1:4173`）；两页 `/neo-agent-version-evolution.html`、`/portal/index.html`
> 前序：`STATIC_ONLY: PASS`（static）、`BROWSER_A: PASS`（browser-a）、`BROWSER_B1: PASS`（browser-b1）
> 结论标记：`BROWSER_B2`（**不给出最终 `IS_PASS`**）

---

## 1. 本阶段边界与合规

**已执行**：项 1（缩放，12 组数值）、项 2（17 个外链真实 HTTP 请求）、项 3（4 张全页截图逐张目视）、项 4（Lighthouse 环境检测 → 不具备，明确记未执行）。另对 B1 的 O1–O4 给出修复建议（§7）。

**明确未执行**：Lighthouse 实际跑分（环境不具备，原因见 §5；按主理人指令不安装、不给分数、不编造结果）。

**合规**：未修改 `web/` 下任何文件、未改其它 `docs/` 文档、未运行项目 `bun test` / `verify.sh`、未提交 / 推送；除项 2 的 17 个 GitHub URL 外，未访问任何外部 URL（浏览器仅访问 `127.0.0.1:4173`）；静态服务器与 Edge 在命令结束时 `kill`+`wait` 停止；截图、脚本均在系统 temp 目录，未写入仓库。仓库内唯一新增文件为本报告。

---

## 2. 实际工具 / 命令 / 方法

| # | 工具 / 命令 | 说明 |
| --- | --- | --- |
| 1 | `python3 -m http.server 4173 --bind 127.0.0.1 --directory web`（cwd=`D:/projects/neo-cli`） | 以 `web/` 为根；就绪探测 `server=200`；结束时停止 |
| 2 | Edge headless（`--headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage --no-first-run --no-default-browser-check --remote-debugging-port=0 --user-data-dir=<temp>`） | **只启动一次**，随机 CDP 端口由 `DevToolsActivePort` 读取 |
| 3 | Node 22 自写 CDP 客户端 `C:/Users/Anders/AppData/Local/Temp/neo-qa-browser-b2.js` | 单一 CDP 会话内连续完成项 1 与项 3；`Page/Runtime/Network.enable`；`Page.addScriptToEvaluateOnNewDocument` 注入 `window.__qaErrs`（error / unhandledrejection） |
| 4 | `Emulation.setDeviceMetricsOverride` + `Runtime.evaluate{returnByValue:true}` + `Page.captureScreenshot{captureBeyondViewport:true}` + `ViewImage` ×4 | 缩放测量、全页截图、逐张目视 |
| 5 | `curl -sS -o /dev/null -L -I --max-time 15 -w "%{http_code}|%{num_redirects}|%{redirect_url}|%{time_total}"`（Python `ThreadPoolExecutor` 6 并发） | 项 2 外链真实 HTTP 探测，记录状态码 / 重定向数 / 重定向 URL / 耗时 |
| 6 | `command -v lighthouse`、`lighthouse --version`、`npm ls -g --depth=0`、`node -e "require.resolve('lighthouse')"`、`timeout 25 npx --no-install lighthouse --version` | 项 4 环境检测 |

> **方法学**：所有页面探针均为纯 `Runtime.evaluate` 返回对象，**不向页面 DOM 注入任何元素**、不修改页面样式；每个组合重新 `Page.navigate` 确保为本次真实加载结果。

---

## 3. 项 1 — 200% / 400% 缩放实测

**采用方法**：按 WCAG 1.4.10 Reflow 惯例，浏览器缩放 N% 等效于 CSS 视口宽度变为 `基准宽度 / N`；用 CDP `Emulation.setDeviceMetricsOverride` 精确设 `等效宽度 = floor(基准/倍数)`（不设 `style.zoom`，不触碰页面 DOM）。组合：基准 360 / 768 / 1280 × 200% / 400% × 两页 = **12 组**。

**探针返回**：`clientWidth`、`scrollWidth`、页面级横向溢出与溢出量、未被 `overflow-x` 容器裁剪的越界元素数与样本、卡片/徽章/按钮的 `scrollHeight>clientHeight` 截断数、空 section、导航链接可见数、两条固定互链可见数、`<pre>` 总数与可横滚数、正文长度、H1 / lang / title、页面 error 事件。

### 3.1 原始观测值表（12 组）

| 页面 | 基准 | 缩放 | 等效 W | clientW | scrollW | 页面横向溢出 | 溢出量 | 越界元素 | 截断 | 空区块 | 导航可见 | 互链可见 | pre 可横滚 | 正文长度 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- | ---: |
| version | 360 | 200% | 180 | 165 | 275 | **是** | +110 | 5 | 0 | `[]` | 5/5 | 2/2 | 0/0 | 5071 |
| version | 360 | 400% | 90 | 75 | 275 | **是** | +200 | 127 | 0 | `[]` | 5/5 | 2/2 | 0/0 | 5071 |
| version | 768 | 200% | 384 | 369 | 369 | 否 | 0 | 0 | 0 | `[]` | 5/5 | 2/2 | 0/0 | 5071 |
| version | 768 | 400% | 192 | 177 | 275 | **是** | +98 | 5 | 0 | `[]` | 5/5 | 2/2 | 0/0 | 5071 |
| version | 1280 | 200% | 640 | 625 | 625 | 否 | 0 | 0 | 0 | `[]` | 5/5 | 2/2 | 0/0 | 5071 |
| version | 1280 | 400% | 320 | 305 | 305 | 否 | 0 | 0 | 0 | `[]` | 5/5 | 2/2 | 0/0 | 5071 |
| portal | 360 | 200% | 180 | 165 | 175 | **是** | +10 | 1 | 0 | `[]` | 5/5 | 4/4 | 7/7 | 4408 |
| portal | 360 | 400% | 90 | 75 | 175 | **是** | +100 | 78 | 0 | `[]` | 5/5 | 4/4 | 7/7 | 4408 |
| portal | 768 | 200% | 384 | 369 | 369 | 否 | 0 | 0 | 0 | `[]` | 5/5 | 4/4 | 7/7 | 4408 |
| portal | 768 | 400% | 192 | 177 | 177 | 否 | 0 | 0 | 0 | `[]` | 5/5 | 4/4 | 7/7 | 4408 |
| portal | 1280 | 200% | 640 | 625 | 625 | 否 | 0 | 0 | 0 | `[]` | 5/5 | 4/4 | 7/7 | 4408 |
| portal | 1280 | 400% | 320 | 305 | 305 | 否 | 0 | 0 | 0 | `[]` | 5/5 | 4/4 | 7/7 | 4408 |

**12 组共同观测**：`h1=1`、`lang="zh-CN"`、title 正确（版本页「版本演进｜neo-agent」/ 门户「neo-agent｜Matrix 风格的终端编程助手」）、`pageErrors=[]`、`Runtime.exceptionThrown` 事件数 `0`、正文长度恒定（版本页 5071 / 门户 4408）、`clipped=0`、`emptySections=[]`、导航 5/5 可见、互链 2/2 或 4/4 可见、门户 7/7 `<pre>` 均可内部横滚。

**溢出样本（版本页 360@200%，clientW=165）**：`a@16..259`、`span@64..259`、`span@64..259`、`code@17..275`、`code@65..252` —— 均为 `white-space:nowrap` 的 mono 版本号 / commit / 状态徽章 / 按钮文字，以及 44px 最小点击目标，在极窄等效视口下不换行。门户 360@200% 仅 1 个 `code@60..175`（+10px，行内 mono 文本）。

### 3.2 判定：**PASS**（附低优先级观察 O5）

- **PRD §5.5 / 设计系统 §6 对缩放的要求是「内容不丢失、不重叠」**：12 组 `textLen` 恒定、`emptySections=[]`、`clipped=0`、零异常，导航与两条固定互链全部可见可达，门户代码块 7/7 可内部横滚 → 满足。
- **WCAG 1.4.10 Reflow 标准测试点 = 320 CSS px（即 1280@400%）**：两页实测 `clientW=305`、`scrollW=305`、`overflow=false` → **通过**；768@200%(384px)、1280@200%(640px)、门户 768@400%(192px) 亦无溢出。
- 等效宽度 ≤192px 的极端组合（对应 360 基准的 200%/400%、768 基准的 400%）出现页面级横向滚动，但这些宽度**远低于 WCAG 320px 门槛**（75–177px），且内容完整、无空区/遮挡、导航与互链仍可达。记为观察 O5（低），不判阻断缺陷。
- 四个正式验收视口（360/768/1280/1440）在 `BROWSER_A` 已实测无横向溢出，本阶段不重复充当证据。

---

## 4. 项 2 — 17 个外链 HTTP 可达性

**方法**：从两页 HTML 用正则 `href="(https?://[^"]+)"` 提取去重外链；版本页 17 个、门户 12 个、**并集 17 个**、`portal_only_urls=[]`（门户所有外链 CTA 均已被版本页 17 个覆盖并实测）。逐个 `curl -L -I`（HEAD，跟随重定向），记录状态码、重定向数、重定向 URL、耗时；6 并发。

### 4.1 逐个结果（全部 `HTTP 200`、`redirects=0`）

| # | URL | 状态 | 重定向 | 耗时(s) |
| ---: | --- | ---: | ---: | ---: |
| 1 | `https://github.com/AndersHsueh/neo-cli` | 200 | 0 | 1.064 |
| 2 | `…/blob/v0.4.80/docs/release-notes/v0.4.80.md` | 200 | 0 | 0.928 |
| 3 | `…/blob/v0.4.81/docs/release-notes/v0.4.81.md` | 200 | 0 | 1.866 |
| 4 | `…/blob/v0.4.82/docs/release-notes/v0.4.82.md` | 200 | 0 | 1.600 |
| 5 | `…/blob/v0.4.83/docs/release-notes/v0.4.83.md` | 200 | 0 | 1.069 |
| 6 | `…/blob/v0.4.84/README.md` | 200 | 0 | 1.637 |
| 7 | `…/blob/v0.4.84/docs/release-notes/v0.4.84.md` | 200 | 0 | 1.377 |
| 8 | `…/blob/v0.4.84/package.json` | 200 | 0 | 2.175 |
| 9 | `…/commit/a2858ae` | 200 | 0 | 1.247 |
| 10 | `…/issues/37` | 200 | 0 | 1.037 |
| 11 | `…/issues/52` | 200 | 0 | 1.160 |
| 12 | `…/issues/59` | 200 | 0 | 0.903 |
| 13 | `…/releases/tag/v0.4.80` | 200 | 0 | 0.776 |
| 14 | `…/releases/tag/v0.4.81` | 200 | 0 | 0.891 |
| 15 | `…/releases/tag/v0.4.82` | 200 | 0 | 0.782 |
| 16 | `…/releases/tag/v0.4.83` | 200 | 0 | 0.694 |
| 17 | `…/releases/tag/v0.4.84` | 200 | 0 | 0.722 |

（`…` = `https://github.com/AndersHsueh/neo-cli`）

### 4.2 统计与判定

```
total=17  success2xx=17  failed_non2xx=0  blocked=0
BAD=[]    BLOCKED=[]
```

耗时区间 0.694–2.175s；无重定向、无失败、无网络策略阻止。门户 12 个外链（含「查看 GitHub 仓库」「阅读 README」「查看完整版本演进」相关 CTA 与 Issue / release note 来源）全部落在并集内并已实测。

**判定：PASS**。本次为真实 HTTP 请求结果，非静态 URL 结构推断、非复用旧数据；若被网络策略阻止会如实记为 blocked，本次未发生。

---

## 5. 项 3 — 768 / 1440px 全页截图逐张观察

**方法**：`Emulation.setDeviceMetricsOverride` 设 768 / 1440 × 900，`Page.captureScreenshot{captureBeyondViewport:true}` 生成**整页长截图**（非仅首屏），保存到系统临时目录 `C:/Users/Anders/AppData/Local/Temp/neo-qa-browser-b2/`，用 `ViewImage` **逐张**目视；未写入仓库。

| 文件 | 字节数 |
| --- | ---: |
| `version-768.png` | 712,692 |
| `version-1440.png` | 777,974 |
| `portal-768.png` | 763,484 |
| `portal-1440.png` | 817,459 |

### 5.1 逐张观察结论

- **`version-768.png`（768px，单列档案式）**：导航与品牌、页首摘要 + FACT SNAPSHOT、当前版本卡（`v0.4.84` + 绿色「已发布」徽章 + 两列定义列表）、「v0.4.84 发布时验证记录」提示框（5 项数字）、近期演进时间线 `v0.4.84 → v0.4.80` 单列（每节点含版本、日期、绿色已发布徽章、摘要、来源链接）、六条能力轴（两列网格，每卡含来源）、本轮规划（3 张紫色「本轮规划」卡，#52/#59/#37）、已知边界、事实来源（绿色文档链接）、页脚。未见错位、文字截断/重叠、空白区域、徽章缺失或只剩颜色；绿色/紫色状态标识与文字并存。**无明显问题。**
- **`version-1440.png`（1440px，容器封顶居中）**：内容列居中、两侧留白明显、阅读列不过宽；当前版本卡数据行对齐；发布时验证记录 5 列数字；时间线**单列**未左右交错；能力轴最多三列且内容完整；本轮规划三卡状态一致；已知边界与来源区完整；页脚含互链。未见风格漂移、横向溢出、截断或空区域。**无明显问题。**
- **`portal-768.png`（768px）**：Hero 单列（品牌、eyebrow、H1、CTA、运行事实），终端面板紧随 CTA 之后；三大卖点两列且第三张「面向无人值守的可信执行」跨两行（内部 4 个子项分别带绿色「已发布」与紫色「本轮规划」徽章）；真实工作流两列（4 张编号卡，命令代码块在卡内）；快速开始与版本摘要单列；平台与使用边界单列清单（黄色警告图标 + 标题 + 说明）；最终 CTA；页脚三块。未见卡片空白、代码块撑破、字符雨干扰正文、徽章缺失。**无明显问题。**
- **`portal-1440.png`（1440px）**：Hero `1.05fr/0.95fr` 两列（左文案右终端面板，面板内命令与复制按钮、协议/模式/前提定义列表）；三大卖点三列；真实工作流 2×2；快速开始与版本摘要约 5:7 两列；边界单列；最终 CTA 两列；页脚三列；容器封顶 1200px 居中、外侧留白。字符雨仅 Hero 背景低对比、不挡文字。未见错位、截断、空白、风格漂移或横向溢出。**无明显问题。**

> 说明：整页长截图被缩放显示，细小文字无法逐字辨认；因此本项结论聚焦**版式结构、区块完整性、状态徽章、代码块、页脚与互链**，文字内容正确性由前序静态核查与 B1 DOM 观测佐证。

**判定：PASS**。4 张逐张观察均无明显错位/截断/空区域/风格漂移；状态徽章完整（文字 + 图形 + 颜色），代码块未撑破容器，页脚与互链可见。

---

## 6. 项 4 — Lighthouse（环境检测 → 未执行）

**方法**：先检测本机是否具备，具备才跑分。实际检测输出：

```
PATH: lighthouse NOT FOUND
/usr/bin/bash: line 35: lighthouse: command not found
npm global: lighthouse not installed
node module: NOT INSTALLED
npx --no-install lighthouse --version : 无有效输出
```

**判定：未执行（环境原因，不计为通过也不计为页面缺陷）**。本机 PATH 无 `lighthouse` CLI、npm 全局未安装、`require.resolve('lighthouse')` 失败、`npx --no-install` 无有效输出。按主理人指令**不联网安装、不给分数、不编造结果**；PRD §5.5 建议的移动端四项 ≥90 门槛因此**未验证**，须在具备 Lighthouse 的环境补测或由主理人接受此项为已知限制。

---

## 7. 对 B1 观察项 O1–O4 的「是否需要修复」建议（只给建议，未改 `web/`）

| 编号 | 建议 | 理由 |
| --- | --- | --- |
| **O1** 版本页 print 网格未折叠单列 | **不需要修复** | 设计系统 §9.2 仅要求「门户打印时可折叠成单列」，版本页定位为档案式阅读列；B1 实测 print 下内容完整（`sections=[]`、`innerText=5001`）、`overflow=false`、A4 PDF 成功生成（12 页对象）。为对齐而改 print CSS 反而可能引入打印回归，收益低。 |
| **O2** 版本页 print 下 `.button` 链接无 underline | **不需要修复（可选优化）** | 外链已通过 `a[href^="http"]::after` 附完整 URL（B1 补测 content=`" (https://github.com/AndersHsueh/neo-cli)"`），按钮文字为 `rgb(17,20,17)` 深色可读且语义明确；打印稿可识别。若未来统一两页打印表现，可在版本页 `@media print` 补 `.button{text-decoration:underline}`，但非阻断、不建议本轮改。 |
| **O3** 门户 print 无 `a[href^="http"]::after` URL 后缀 | **不需要修复** | 设计系统 §9.2 用「**可**」字（可选），且门户所有可见链接均有 `underline`（B1 补测 25 个可见链接）；§9.2 自身提醒「避免 URL 与正文挤成一团」，不附加反而更整洁。 |
| **O4** 版本页无 `<pre><code>`，命令手动选中不适用 | **不需要修复（不适用）** | 版本页定位「可核查的发布档案」，设计系统 §4.2 未要求版本页有代码块；「命令可手动选中」的降级要求由门户实证满足（B1 选中 44 字符、`userSelect:auto`）。无需为不适用项补代码块。 |

**统一结论：O1–O4 均不需要修复，仅登记为观察。** 本阶段未修改 `web/` 下任何文件。

---

## 8. 缺陷清单（新增）

### 8.1 阻断缺陷
**无**。

### 8.2 新增观察项（低 / 信息级，非阻断）

| # | 严重程度 | 位置 / 复现条件 | 期望 | 实际 | 建议角色 |
| --- | --- | --- | --- | --- | --- |
| **O5** | 低 | 等效 CSS 视口 ≤192px 的极端缩放组合：版本页 360@200%(180px)、360@400%(90px)、768@400%(192px)；门户 360@200%(180px)、360@400%(90px) | 无页面级横向溢出 | 出现横向滚动：版本页 `scrollWidth` 275 vs `clientWidth` 165/75/177（溢出 +110/+200/+98，越界元素 5/127/5）；门户 175 vs 165/75（+10/+100，越界 1/78）。成因为 `white-space:nowrap` 的 mono 版本号 / commit / 徽章与 44px 最小点击目标在极窄视口不换行。**但**内容完整（textLen 恒定）、无空区块/截断、导航 5/5 与互链 2/2·4/4 全可见、门户代码块 7/7 可内部横滚；WCAG 1.4.10 的 320 CSS px 测试点（1280@400%）两页均无溢出 | version-manager（**可选优化，非必须**）：如需覆盖极端宽度，可对 nowrap 的版本号/commit 在 ≤320px 加 `overflow-wrap:anywhere` 或允许换行 |
| **O6** | 信息 | 本机 Lighthouse 环境 | 具备则跑分 | 不具备（PATH/npm global/node module/npx 均未安装），按指令记「未执行」，不给分数 | 主理人：在具备环境时补测，或接受为已知限制 |

---

## 9. 限制

1. 缩放采用「等效 CSS 视口宽度」法（WCAG 1.4.10 惯例），非 `style.zoom` 真实缩放；两者在极端宽度下可视作等价的 Reflow 压力测试，但未做真实浏览器缩放按钮操作。
2. 整页长截图经缩放显示，细小文字无法逐字辨认；目视结论聚焦版式与结构，文字正确性由 static / B1 的 DOM 观测佐证。
3. 外链为 HEAD（`curl -I -L`）请求，验证的是 URL 可达性与重定向，未校验返回正文内容；GitHub 对不存在的路径会返回 404，本次 17/17 为 200。
4. Lighthouse 未执行（§6），PRD §5.5 建议的四项 ≥90 门槛未验证；不得据此声称性能/SEO 达标。
5. 未运行项目代码测试、未修改 `web/` 文件、未改其它 `docs/`、未提交 / 推送；静态服务器与 Edge 均已停止。

---

## 10. 结论

```
BROWSER_B2: PASS
```

- 项 1 缩放：12 组真实数值；WCAG 320 CSS px 测试点两页无溢出，内容不丢失/不重叠、导航与互链可达、无空区块 → 通过（极端宽度横向滚动记为低优先级观察 O5）。
- 项 2 外链：**17/17 HTTP 200，0 失败、0 被阻止、0 重定向**，门户 12 个外链 CTA 全部覆盖 → 通过。
- 项 3 截图：768/1440 两页共 4 张全页截图逐张目视，无明显错位/截断/空区域/风格漂移 → 通过。
- 项 4 Lighthouse：环境不具备，**明确记未执行**（不计通过、不计页面缺陷、不给分数）。
- 新增缺陷：无阻断；观察 O5（低）、O6（信息）各 1 项。O1–O4 均建议不修复。

**本阶段不给出最终 `IS_PASS`**：最终结论需合并 `static` / `browser-a` / `browser-b1` / `browser-b2` 四份报告，由产品与 QA 共同复核状态词、日期与验证记录后给出；Lighthouse 未执行项须在最终报告中作为已知限制列明。

---

## 11. 下一步建议

1. 由主理人组织产品 + QA 复核四份报告，逐项引用原始观测值，形成最终 `IS_PASS` 结论；明确把「Lighthouse 未执行」写入最终报告的限制章节，不以设计规范或人工印象替代。
2. 若需满足 PRD §5.5 的 Lighthouse ≥90 建议门槛，须在具备 CLI/环境的机器单独补测移动端两页并记录环境、运行方式与实际分数（当前环境不具备，本阶段未给分）。
3. O1–O5 均为可选优化或已知限制，不阻断验收；如主理人决定处理 O5，交 version-manager 在后续批次评估，本轮不改 `web/`。
4. 核心 Issue（#52/#59/#37）合入或发版状态变化时，按设计系统 §11 同步两页状态词、日期与验证记录，不猜版本号。
